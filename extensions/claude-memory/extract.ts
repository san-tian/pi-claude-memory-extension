import {
  buildSessionContext,
  convertToLlm,
  serializeConversation,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
} from "@mariozechner/pi-coding-agent";
import { runPiSubagent } from "pi-subagent-tool/extensions/subagent/runtime";
import {
  ensureMemoryStore,
  rebuildMemoryArtifacts,
  rebuildProjectMemoryArtifacts,
  rebuildUserMemoryArtifacts,
  renderTopicTemplate,
} from "./memory-store.js";
import { getProjectMemoryPaths, getUserMemoryPaths } from "./paths.js";
import { activeExtractions, getSessionKey, getState, setState } from "./state.js";
import {
  CLAUDE_MEMORY_SUBAGENT_ENV,
  formatSubagentError,
  formatSubagentModelSpec,
  isClaudeMemorySubagentProcess,
  resolveModel,
} from "./subagent.js";
import { DEFAULT_MEMORY_CONFIG, type ClaudeMemoryState, type MemoryTopicHeader } from "./types.js";

type ExtractionReason = "auto" | "manual";

export interface ExtractionDecision {
  shouldExtract: boolean;
  tokenCount: number;
  reason?: string;
}

export interface ExtractionResult {
  ok: boolean;
  skipped?: string;
  error?: string;
  tokenCount?: number;
  headers?: MemoryTopicHeader[];
  state?: ClaudeMemoryState;
}

export function getExtractionDecision(ctx: ExtensionContext): ExtractionDecision {
  const state = getState(ctx);
  const entries = ctx.sessionManager.getBranch();
  const context = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
  const conversationText = serializeConversation(convertToLlm(context.messages));
  const tokenCount = ctx.getContextUsage()?.tokens ?? roughTokenCount(conversationText);

  if (!state.initialized && tokenCount < DEFAULT_MEMORY_CONFIG.minimumMessageTokensToInit) {
    return { shouldExtract: false, tokenCount, reason: "below initial token threshold" };
  }

  if (tokenCount - state.tokensAtLastExtraction < DEFAULT_MEMORY_CONFIG.minimumTokensBetweenExtraction) {
    return { shouldExtract: false, tokenCount, reason: "below incremental token threshold" };
  }

  const toolCallsSince = countToolCallsSince(entries, state.lastTriggerEntryId);
  if (toolCallsSince < DEFAULT_MEMORY_CONFIG.toolCallsBetweenExtraction && hasToolCallsInLastAssistantTurn(entries)) {
    return { shouldExtract: false, tokenCount, reason: "waiting for more tool activity" };
  }

  return { shouldExtract: true, tokenCount };
}

export async function runExtraction(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  reason: ExtractionReason,
): Promise<ExtractionResult> {
  if (isClaudeMemorySubagentProcess()) {
    return { ok: false, skipped: "Extraction disabled inside the Claude-memory subagent" };
  }

  const sessionKey = getSessionKey(ctx);
  if (activeExtractions.has(sessionKey)) {
    return { ok: false, skipped: "Extraction already running" };
  }

  const decision = getExtractionDecision(ctx);
  if (!decision.shouldExtract && reason !== "manual") {
    return { ok: false, skipped: decision.reason, tokenCount: decision.tokenCount };
  }

  activeExtractions.add(sessionKey);
  try {
    const projectPaths = getProjectMemoryPaths(ctx.cwd);
    const userPaths = getUserMemoryPaths();
    await ensureMemoryStore(ctx.cwd);
    const context = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
    if (context.messages.length === 0) {
      return { ok: false, skipped: "No conversation to summarize" };
    }

    const conversationText = serializeConversation(convertToLlm(context.messages));
    const prompt = await buildExtractionPrompt(ctx.cwd);
    const model = resolveModel(ctx);
    if (!model) {
      return { ok: false, error: "No model available for long-term memory extraction" };
    }

    const result = await runPiSubagent({
      cwd: ctx.cwd,
      prompt,
      model: formatSubagentModelSpec(model),
      tools: ["read", "write", "edit"],
      signal: ctx.signal,
      hiddenContext: conversationText,
      hiddenContextType: "claude-memory-extraction-context",
      env: {
        [CLAUDE_MEMORY_SUBAGENT_ENV]: "1",
      },
    });

    if (result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted") {
      return {
        ok: false,
        error: formatSubagentError(result),
      };
    }

    const headers = await rebuildMemoryArtifacts(ctx.cwd);
    const state = getState(ctx);
    const nextState: ClaudeMemoryState = {
      ...state,
      initialized: true,
      extractionCount: state.extractionCount + 1,
      tokensAtLastExtraction: decision.tokenCount,
      lastTriggerEntryId: ctx.sessionManager.getLeafId() ?? state.lastTriggerEntryId,
      lastSummarizedEntryId: ctx.sessionManager.getLeafId() ?? state.lastSummarizedEntryId,
      updatedAt: new Date().toISOString(),
      memoryRoot: projectPaths.rootDir,
    };
    setState(pi, ctx, nextState);

    if (reason === "manual" && ctx.hasUI) {
      ctx.ui.notify(`Persistent memory extracted (${headers.length} topics)`, "info");
    }

    return {
      ok: true,
      tokenCount: decision.tokenCount,
      headers,
      state: nextState,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    activeExtractions.delete(sessionKey);
  }
}

async function buildExtractionPrompt(cwd: string): Promise<string> {
  const projectPaths = getProjectMemoryPaths(cwd);
  const userPaths = getUserMemoryPaths();
  await ensureMemoryStore(cwd);
  const [projectHeaders, userHeaders] = await Promise.all([
    rebuildProjectMemoryArtifacts(cwd),
    rebuildUserMemoryArtifacts(),
  ]);

  const projectTopicLines = projectHeaders.length
    ? projectHeaders.map((header) => `- ${header.id} | ${header.type} | ${header.title} | ${header.summary}`).join("\n")
    : "- No project topic files exist yet.";
  const userTopicLines = userHeaders.length
    ? userHeaders.map((header) => `- ${header.id} | ${header.type} | ${header.title} | ${header.summary}`).join("\n")
    : "- No global user topic files exist yet.";
  const templatePreview = renderTopicTemplate({
    id: "example-topic-id",
    title: "Example Topic Title",
    type: "project",
    summary: "One-sentence summary of the reusable memory.",
    updatedAt: new Date().toISOString(),
    keywords: ["keyword-a", "keyword-b"],
  });

  return [
    "IMPORTANT: These instructions are not part of the user conversation. Do not mention long-term memory extraction in any written memory content.",
    "",
    `Update persistent memory in two stores: project memory under ${projectPaths.rootDir} and global user memory under ${userPaths.rootDir}.`,
    `Only work inside ${projectPaths.topicsDir} and ${userPaths.topicsDir}. Never touch files outside those directories.`,
    "",
    "Routing rules:",
    `- Memories with type \"user\" belong under ${userPaths.topicsDir}.`,
    `- Memories with type \"feedback\", \"project\", and \"reference\" belong under ${projectPaths.topicsDir}.`,
    "- Do not write cross-project summaries into the current project store unless they are directly about this repository.",
    "",
    "Your task:",
    "1. Read current topic files when needed.",
    "2. Create or update only the topic files that capture durable, reusable memory from the hidden conversation context.",
    "3. Preserve stable user preferences, successful workflows, important corrections, and durable project context.",
    "4. Skip one-off transient details, speculative guesses, and anything that belongs only in session memory.",
    "",
    "Rules:",
    "- Use only the Read, Write, and Edit tools.",
    "- Topic files must keep the exact frontmatter shape shown in the template.",
    "- Prefer updating existing topics over creating duplicates.",
    "- Keep summaries concise and high-signal. Put detailed durable knowledge in the body.",
    "- Never modify MEMORY.md or manifest.json directly; only topic files.",
    "- Stop immediately after finishing the required file edits.",
    "",
    "Existing project topics:",
    projectTopicLines,
    "",
    "Existing global user topics:",
    userTopicLines,
    "",
    "Topic file template example:",
    templatePreview,
  ].join("\n");
}

function countToolCallsSince(entries: SessionEntry[], sinceEntryId?: string): number {
  let shouldCount = !sinceEntryId;
  let total = 0;

  for (const entry of entries) {
    if (!shouldCount) {
      if (entry.id === sinceEntryId) {
        shouldCount = true;
      }
      continue;
    }

    if (entry.type !== "message" || entry.message.role !== "assistant" || !Array.isArray(entry.message.content)) {
      continue;
    }

    for (const part of entry.message.content) {
      if (!part || typeof part !== "object") {
        continue;
      }
      const block = part as { type?: string };
      if (block.type === "toolCall" || block.type === "tool_use") {
        total += 1;
      }
    }
  }

  return total;
}

function hasToolCallsInLastAssistantTurn(entries: SessionEntry[]): boolean {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || entry.type !== "message") {
      continue;
    }
    if (entry.message.role !== "assistant" || !Array.isArray(entry.message.content)) {
      continue;
    }
    return entry.message.content.some((part) => {
      if (!part || typeof part !== "object") {
        return false;
      }
      const block = part as { type?: string };
      return block.type === "toolCall" || block.type === "tool_use";
    });
  }
  return false;
}

function roughTokenCount(content: string): number {
  return Math.ceil(content.length / 4);
}
