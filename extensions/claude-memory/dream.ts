import fs from "node:fs/promises";
import path from "node:path";
import { runPiSubagent } from "./pi-subagent-runtime.js";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  ensureMemoryStore,
  rebuildMemoryArtifacts,
  rebuildProjectMemoryArtifacts,
  rebuildUserMemoryArtifacts,
} from "./memory-store.js";
import { getProjectMemoryPaths, getUserMemoryPaths } from "./paths.js";
import { activeDreams, getSessionKey, getState, setState } from "./state.js";
import {
  CLAUDE_MEMORY_SUBAGENT_ENV,
  formatSubagentError,
  formatSubagentModelSpec,
  isClaudeMemorySubagentProcess,
  resolveModel,
} from "./subagent.js";
import { DEFAULT_MEMORY_CONFIG, type ClaudeMemoryState, type MemoryTopicHeader } from "./types.js";

type DreamReason = "auto" | "manual";

export interface DreamResult {
  ok: boolean;
  skipped?: string;
  error?: string;
  headers?: MemoryTopicHeader[];
  state?: ClaudeMemoryState;
}

export function shouldAutoDream(ctx: ExtensionContext): boolean {
  const state = getState(ctx);
  const extractionsSinceDream = state.extractionCount - (state.extractionCountAtLastDream ?? 0);
  return extractionsSinceDream >= DEFAULT_MEMORY_CONFIG.dreamAfterExtractions;
}

export async function runDream(pi: ExtensionAPI, ctx: ExtensionContext, reason: DreamReason): Promise<DreamResult> {
  if (isClaudeMemorySubagentProcess()) {
    return { ok: false, skipped: "Dream disabled inside the Claude-memory subagent" };
  }

  const state = getState(ctx);
  if (reason !== "manual" && !shouldAutoDream(ctx)) {
    return { ok: false, skipped: "Dream threshold not reached yet" };
  }

  const sessionKey = getSessionKey(ctx);
  if (activeDreams.has(sessionKey)) {
    return { ok: false, skipped: "Dream already running" };
  }

  activeDreams.add(sessionKey);
  const projectPaths = getProjectMemoryPaths(ctx.cwd);
  const userPaths = getUserMemoryPaths();
  const releaseProjectLock = await acquireDreamLock(projectPaths.lockPath);
  if (!releaseProjectLock) {
    activeDreams.delete(sessionKey);
    return { ok: false, skipped: "Project dream lock already held" };
  }

  const releaseUserLock = await acquireDreamLock(userPaths.lockPath);
  if (!releaseUserLock) {
    await releaseProjectLock();
    activeDreams.delete(sessionKey);
    return { ok: false, skipped: "User-memory dream lock already held" };
  }

  try {
    await ensureMemoryStore(ctx.cwd);
    const [projectHeaders, userHeaders] = await Promise.all([
      rebuildProjectMemoryArtifacts(ctx.cwd),
      rebuildUserMemoryArtifacts(),
    ]);
    const headers = [...projectHeaders, ...userHeaders];
    if (headers.length === 0) {
      return { ok: false, skipped: "No topic files to consolidate" };
    }

    const model = resolveModel(ctx);
    if (!model) {
      return { ok: false, error: "No model available for memory dream consolidation" };
    }

    const result = await runPiSubagent({
      cwd: ctx.cwd,
      prompt: buildDreamPrompt(projectPaths.topicsDir, userPaths.topicsDir, projectHeaders, userHeaders),
      model: formatSubagentModelSpec(model),
      tools: ["read", "write", "edit"],
      signal: ctx.signal,
      env: {
        [CLAUDE_MEMORY_SUBAGENT_ENV]: "1",
      },
    });

    if (result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted") {
      return { ok: false, error: formatSubagentError(result) };
    }

    const rebuiltHeaders = await rebuildMemoryArtifacts(ctx.cwd);
    const nextState: ClaudeMemoryState = {
      ...state,
      extractionCountAtLastDream: state.extractionCount,
      lastDreamAt: new Date().toISOString(),
      lastDreamEntryId: ctx.sessionManager.getLeafId() ?? state.lastDreamEntryId,
      updatedAt: new Date().toISOString(),
    };
    setState(pi, ctx, nextState);

    await writeDreamLog(projectPaths.dreamLogDir, {
      reason,
      projectTopicCountBefore: projectHeaders.length,
      userTopicCountBefore: userHeaders.length,
      topicCountAfter: rebuiltHeaders.length,
      messages: result.messages,
    });

    if (reason === "manual" && ctx.hasUI) {
      ctx.ui.notify(`Persistent memory dreamed (${rebuiltHeaders.length} topics)`, "info");
    }

    return {
      ok: true,
      headers: rebuiltHeaders,
      state: nextState,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await releaseUserLock();
    await releaseProjectLock();
    activeDreams.delete(sessionKey);
  }
}

function buildDreamPrompt(
  projectTopicsDir: string,
  userTopicsDir: string,
  projectHeaders: MemoryTopicHeader[],
  userHeaders: MemoryTopicHeader[],
): string {
  const projectTopicList = projectHeaders.length
    ? projectHeaders.map((header) => `- ${header.id} | ${header.type} | ${header.title} | ${header.summary}`).join("\n")
    : "- No project topics yet.";
  const userTopicList = userHeaders.length
    ? userHeaders.map((header) => `- ${header.id} | ${header.type} | ${header.title} | ${header.summary}`).join("\n")
    : "- No global user topics yet.";
  return [
    "IMPORTANT: These instructions are not part of the user conversation.",
    `Consolidate the current project's persistent memory under ${projectTopicsDir}.`,
    `Consolidate the global user memory under ${userTopicsDir}.`,
    "",
    "Goals:",
    "- Reduce duplication across topic files.",
    "- Strengthen durable summaries and keep topic bodies crisp.",
    "- Preserve stable facts, user preferences, and important project workflows.",
    "- Keep user-level memories global and project-specific memories local.",
    "- Remove stale, weak, or contradictory statements by editing the topic files in place.",
    "",
    "Rules:",
    "- Use only Read, Write, and Edit.",
    "- Only modify files inside the two topics directories named above.",
    "- Do not touch MEMORY.md or manifest.json directly.",
    "- Prefer editing existing files instead of creating many new ones.",
    "- Keep frontmatter valid and keep ids stable when possible.",
    "- Do not move non-user memories into the global user store.",
    "- Stop immediately once the consolidation edits are complete.",
    "",
    "Current project topics:",
    projectTopicList,
    "",
    "Current global user topics:",
    userTopicList,
  ].join("\n");
}

async function acquireDreamLock(lockPath: string): Promise<(() => Promise<void>) | null> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true }).catch(() => undefined);
  try {
    const handle = await fs.open(lockPath, "wx");
    await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`, "utf8");
    return async () => {
      await handle.close();
      await fs.rm(lockPath, { force: true });
    };
  } catch {
    return null;
  }
}

async function writeDreamLog(dir: string, details: Record<string, unknown>): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await fs.writeFile(
    `${dir}/${stamp}.json`,
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        ...details,
      },
      null,
      2,
    ),
    "utf8",
  );
}
