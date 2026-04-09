import fs from "node:fs/promises";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { runDream, shouldAutoDream } from "./dream.js";
import { runExtraction } from "./extract.js";
import { initializeProjectMemory } from "./init.js";
import { ensureMemoryStore, scanProjectTopicHeaders, scanTopicHeaders, scanUserTopicHeaders } from "./memory-store.js";
import { buildMemoryIndexSection, buildMemorySystemPrompt } from "./prompts.js";
import { getProjectMemoryPaths, getUserMemoryPaths } from "./paths.js";
import { clearRelevantMemoryPrefetch, getPrefetchedRelevantMemory, prefetchRelevantMemory } from "./recall.js";
import { REPORT_MESSAGE_TYPE, clearState, getSessionKey, getState, reconstructState } from "./state.js";
import { isClaudeMemorySubagentProcess } from "./subagent.js";
import { DEFAULT_MEMORY_CONFIG } from "./types.js";

const MAX_INDEX_SECTION_CHARS = 12000;

const memorySystemPromptCache = new Map<string, { version: string; prompt: string }>();

export default function claudeMemoryExtension(pi: ExtensionAPI) {
  const rebuild = async (ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1]) => {
    reconstructState(ctx);
    await ensureMemoryStore(ctx.cwd);
  };

  pi.on("session_start", async (_event, ctx) => rebuild(ctx));
  pi.on("session_tree", async (_event, ctx) => rebuild(ctx));
  pi.on("session_shutdown", async (_event, ctx) => {
    clearRelevantMemoryPrefetch(ctx);
    memorySystemPromptCache.delete(getSessionKey(ctx));
    clearState(ctx);
  });

  pi.on("input", async (event, ctx) => {
    if (isClaudeMemorySubagentProcess()) {
      return { action: "continue" };
    }

    if (isSlashCommandPrompt(event.text)) {
      clearRelevantMemoryPrefetch(ctx);
      return { action: "continue" };
    }

    prefetchRelevantMemory(pi, ctx, event.text);
    return { action: "continue" };
  });

  pi.on("context", async (event, ctx) => {
    if (isClaudeMemorySubagentProcess()) {
      return;
    }

    const prompt = getLatestUserPrompt(event.messages);
    if (!prompt || isSlashCommandPrompt(prompt) || hasRecallMessage(event.messages, prompt)) {
      return;
    }

    const prefetched = getPrefetchedRelevantMemory(ctx, prompt);
    if (prefetched?.status !== "ready" || !prefetched.result?.message) {
      return;
    }

    return {
      messages: [...event.messages, createRecallMessage(prefetched.result.message)] as typeof event.messages,
    };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (isClaudeMemorySubagentProcess()) {
      return;
    }

    const systemPrompt = `${event.systemPrompt}\n\n${await getCachedMemorySystemPrompt(ctx)}`;

    // Slash commands should stay lightweight and deterministic. Skip dynamic recall injection.
    if (isSlashCommandPrompt(event.prompt)) {
      return { systemPrompt };
    }

    prefetchRelevantMemory(pi, ctx, event.prompt);

    const recall = getPrefetchedRelevantMemory(ctx, event.prompt);
    if (recall?.status === "ready" && recall.result?.message) {
      return {
        systemPrompt,
        message: recall.result.message,
      };
    }

    if (recall?.status === "pending") {
      return { systemPrompt };
    }

    return { systemPrompt };
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (isClaudeMemorySubagentProcess()) {
      return;
    }
    const extraction = await runExtraction(pi, ctx, "auto");
    if (extraction.ok && ctx.hasUI) {
      ctx.ui.setStatus("claude-memory", `Memory extracted (${extraction.headers?.length ?? 0} topics)`);
    }

    if (!shouldAutoDream(ctx)) {
      return;
    }
    const dream = await runDream(pi, ctx, "auto");
    if (dream.ok && ctx.hasUI) {
      ctx.ui.setStatus("claude-memory", `Memory dreamed (${dream.headers?.length ?? 0} topics)`);
    }
  });

  pi.registerCommand("memory-init", {
    description: "Initialize project memory structure from the current repository root",
    handler: async (_args, ctx) => {
      const result = await initializeProjectMemory(ctx);
      const detailLines = [
        result.ok ? `- Status: ok` : `- Status: skipped`,
        `- Initialized topic files: ${result.files.length}`,
        `- Project topic count: ${result.headers.length}`,
        result.skipped ? `- Skipped: ${result.skipped}` : undefined,
        result.error ? `- Error: ${result.error}` : undefined,
        ...result.files.map((filePath) => `- ${filePath}`),
      ].filter(Boolean);

      pi.sendMessage(
        {
          customType: REPORT_MESSAGE_TYPE,
          content: `## Memory Init\n\n${detailLines.join("\n")}`,
          display: true,
          details: result,
        },
        { triggerTurn: false },
      );
    },
  });

  pi.registerCommand("memory-status", {
    description: "Show persistent memory paths and current Claude-memory state",
    handler: async (_args, ctx) => {
      await ensureMemoryStore(ctx.cwd);
      const projectPaths = getProjectMemoryPaths(ctx.cwd);
      const userPaths = getUserMemoryPaths();
      const state = getState(ctx);
      const [projectHeaders, userHeaders, headers] = await Promise.all([
        scanProjectTopicHeaders(ctx.cwd),
        scanUserTopicHeaders(),
        scanTopicHeaders(ctx.cwd),
      ]);
      const statusLines = [
        `- Project root: ${projectPaths.rootDir}`,
        `- Project index: ${projectPaths.indexPath}`,
        `- Project topics: ${projectPaths.topicsDir}`,
        `- Project manifest: ${projectPaths.manifestPath}`,
        `- Global user root: ${userPaths.rootDir}`,
        `- Global user index: ${userPaths.indexPath}`,
        `- Global user topics: ${userPaths.topicsDir}`,
        `- Recall debug: ${projectPaths.recallDebugPath}`,
        `- Dream log dir: ${projectPaths.dreamLogDir}`,
        `- Project topic count: ${projectHeaders.length}`,
        `- Global user topic count: ${userHeaders.length}`,
        `- Total managed topic count: ${headers.length}`,
        `- Initialized: ${state.initialized}`,
        `- Extraction count: ${state.extractionCount}`,
        `- Tokens at last extraction: ${state.tokensAtLastExtraction}`,
        `- Last trigger entry: ${state.lastTriggerEntryId ?? "(none)"}`,
        `- Last summarized entry: ${state.lastSummarizedEntryId ?? "(none)"}`,
        `- Last dream entry: ${state.lastDreamEntryId ?? "(none)"}`,
        `- Last dream at: ${state.lastDreamAt ?? "(never)"}`,
        `- Last recall topics: ${state.lastRecallTopicIds?.join(", ") || "(none)"}`,
      ];

      pi.sendMessage(
        {
          customType: REPORT_MESSAGE_TYPE,
          content: `## Memory Status\n\n${statusLines.join("\n")}`,
          display: true,
          details: {
            headers,
            projectPaths,
            userPaths,
            state,
          },
        },
        { triggerTurn: false },
      );
    },
  });

  pi.registerCommand("memory-extract", {
    description: "Force a persistent memory extraction pass",
    handler: async (_args, ctx) => {
      const result = await runExtraction(pi, ctx, "manual");
      const detailLines = [
        result.ok ? `- Status: ok` : `- Status: skipped`,
        `- Topics: ${result.headers?.length ?? 0}`,
        `- Tokens: ${result.tokenCount ?? 0}`,
        result.skipped ? `- Skipped: ${result.skipped}` : undefined,
        result.error ? `- Error: ${result.error}` : undefined,
      ].filter(Boolean);

      pi.sendMessage(
        {
          customType: REPORT_MESSAGE_TYPE,
          content: `## Memory Extract\n\n${detailLines.join("\n")}`,
          display: true,
          details: result,
        },
        { triggerTurn: false },
      );
    },
  });

  pi.registerCommand("memory-dream", {
    description: "Force a persistent memory dream consolidation pass",
    handler: async (_args, ctx) => {
      const result = await runDream(pi, ctx, "manual");
      const detailLines = [
        result.ok ? `- Status: ok` : `- Status: skipped`,
        `- Topics: ${result.headers?.length ?? 0}`,
        result.skipped ? `- Skipped: ${result.skipped}` : undefined,
        result.error ? `- Error: ${result.error}` : undefined,
      ].filter(Boolean);

      pi.sendMessage(
        {
          customType: REPORT_MESSAGE_TYPE,
          content: `## Memory Dream\n\n${detailLines.join("\n")}`,
          display: true,
          details: result,
        },
        { triggerTurn: false },
      );
    },
  });

  pi.registerCommand("memory-recall-debug", {
    description: "Show the latest relevant-memory recall debug payload",
    handler: async (_args, ctx) => {
      const paths = getProjectMemoryPaths(ctx.cwd);
      const content = await fs.readFile(paths.recallDebugPath, "utf8").catch(() => "");
      const fallback = { message: "No recall debug payload recorded yet." };
      const body = content || JSON.stringify(fallback, null, 2);
      let details: unknown = fallback;
      if (content) {
        try {
          details = JSON.parse(content);
        } catch {
          details = { raw: content };
        }
      }
      pi.sendMessage(
        {
          customType: REPORT_MESSAGE_TYPE,
          content: `## Memory Recall Debug\n\n\`\`\`json\n${body}\n\`\`\``,
          display: true,
          details,
        },
        { triggerTurn: false },
      );
    },
  });
}

function isSlashCommandPrompt(prompt: string): boolean {
  return prompt.trimStart().startsWith("/");
}

function getLatestUserPrompt(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isUserMessage(message)) {
      continue;
    }
    const text = message.content
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("\n")
      .trim();
    if (text) {
      return text;
    }
  }
  return "";
}

function hasRecallMessage(messages: unknown[], prompt: string): boolean {
  return messages.some((message) => {
    if (!isRecallMessage(message)) {
      return false;
    }
    const details = typeof message.details === "object" && message.details !== null ? message.details : undefined;
    return !!details && "prompt" in details && details.prompt === prompt;
  });
}

function createRecallMessage(message: {
  customType: string;
  content: string;
  display: boolean;
  details?: unknown;
}): unknown {
  return {
    role: "custom",
    customType: message.customType,
    content: message.content,
    display: message.display,
    details: message.details,
    timestamp: Date.now(),
  };
}

function isUserMessage(message: unknown): message is { role: "user"; content: Array<{ text?: string }> } {
  return (
    typeof message === "object" &&
    message !== null &&
    "role" in message &&
    message.role === "user" &&
    "content" in message &&
    Array.isArray(message.content)
  );
}

function isRecallMessage(message: unknown): message is {
  role: "custom";
  customType: string;
  details?: unknown;
} {
  return (
    typeof message === "object" &&
    message !== null &&
    "role" in message &&
    message.role === "custom" &&
    "customType" in message &&
    message.customType === "claude-memory-recall"
  );
}

async function getCachedMemorySystemPrompt(ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1]): Promise<string> {
  await ensureMemoryStore(ctx.cwd);

  const sessionKey = getSessionKey(ctx);
  const version = await getMemorySystemPromptVersion(ctx.cwd);
  const cached = memorySystemPromptCache.get(sessionKey);
  if (cached?.version === version) {
    return cached.prompt;
  }

  const projectPaths = getProjectMemoryPaths(ctx.cwd);
  const userPaths = getUserMemoryPaths();
  const [projectIndex, userIndex] = await Promise.all([
    readIndexForPrompt(projectPaths.indexPath),
    readIndexForPrompt(userPaths.indexPath),
  ]);

  const prompt = [
    buildMemorySystemPrompt(projectPaths.rootDir, userPaths.rootDir, DEFAULT_MEMORY_CONFIG),
    buildMemoryIndexSection("Project MEMORY.md", projectPaths.indexPath, projectIndex),
    buildMemoryIndexSection("Global User MEMORY.md", userPaths.indexPath, userIndex),
  ].join("\n\n");

  memorySystemPromptCache.set(sessionKey, { version, prompt });
  return prompt;
}

async function getMemorySystemPromptVersion(cwd: string): Promise<string> {
  const projectPaths = getProjectMemoryPaths(cwd);
  const userPaths = getUserMemoryPaths();
  const [projectVersion, userVersion] = await Promise.all([
    readFileVersion(projectPaths.indexPath),
    readFileVersion(userPaths.indexPath),
  ]);
  return `${projectVersion}|${userVersion}`;
}

async function readFileVersion(filePath: string): Promise<string> {
  try {
    const stat = await fs.stat(filePath);
    return `${filePath}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return `${filePath}:missing`;
  }
}

async function readIndexForPrompt(filePath: string): Promise<string> {
  try {
    return truncateIndexForPrompt(await fs.readFile(filePath, "utf8"));
  } catch {
    return "";
  }
}

function truncateIndexForPrompt(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length <= MAX_INDEX_SECTION_CHARS) {
    return trimmed;
  }

  return [
    trimmed.slice(0, MAX_INDEX_SECTION_CHARS).trimEnd(),
    "",
    `> NOTE: This MEMORY.md section was truncated to ${MAX_INDEX_SECTION_CHARS} characters for prompt budget safety.`,
  ].join("\n");
}
