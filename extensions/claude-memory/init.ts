import { runPiSubagent } from "./pi-subagent-runtime.js";
import { ensureMemoryStore, rebuildProjectMemoryArtifacts, scanProjectTopicHeaders } from "./memory-store.js";
import { getProjectMemoryPaths } from "./paths.js";
import { formatSubagentError, formatSubagentModelSpec, resolveModel, CLAUDE_MEMORY_SUBAGENT_ENV } from "./subagent.js";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { MemoryTopicHeader } from "./types.js";

export type InitResult = {
  ok: boolean;
  headers: MemoryTopicHeader[];
  files: string[];
  skipped?: string;
  error?: string;
};

export async function initializeProjectMemory(ctx: ExtensionContext): Promise<InitResult> {
  const model = resolveModel(ctx);
  if (!model) {
    return {
      ok: false,
      headers: [],
      files: [],
      error: "No model available for memory initialization",
    };
  }

  await ensureMemoryStore(ctx.cwd);
  const paths = getProjectMemoryPaths(ctx.cwd);
  const result = await runPiSubagent({
    cwd: ctx.cwd,
    prompt: buildMemoryInitPrompt(paths.topicsDir, paths.rootDir),
    model: formatSubagentModelSpec(model),
    tools: ["read", "grep", "find", "ls", "write", "edit"],
    signal: ctx.signal,
    env: {
      [CLAUDE_MEMORY_SUBAGENT_ENV]: "1",
    },
  });

  if (result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted") {
    return {
      ok: false,
      headers: [],
      files: [],
      error: formatSubagentError(result),
    };
  }

  const headers = await rebuildProjectMemoryArtifacts(ctx.cwd);
  return {
    ok: true,
    headers,
    files: headers.map((header) => header.path),
  };
}

function buildMemoryInitPrompt(topicsDir: string, memoryRoot: string): string {
  return [
    "IMPORTANT: These instructions are not part of the user conversation.",
    `Initialize the project's persistent memory topics under ${topicsDir}.`,
    `The project memory root is ${memoryRoot}. Only modify files inside ${topicsDir}.`,
    "",
    "Goal:",
    "Create an initial memory structure that matches this collaboration-oriented memory taxonomy:",
    "- Repository Overview",
    "- Feature topics (one topic per meaningful feature/capability area, determined by your reading of the repository rather than naive top-level directory splitting)",
    "- Flow: Development",
    "- Flow: Deployment",
    "- Flow: Sync",
    "- Flow: Testing",
    "- Work Records Structure",
    "- Session Records Structure",
    "",
    "How to decide feature topics:",
    "- Read the repository root and key files first.",
    "- Use README, package manifests, obvious entry files, and representative directories to infer the real feature boundaries.",
    "- Do not blindly treat every top-level folder as a feature.",
    "- Prefer a small number of meaningful feature topics over many shallow directory summaries.",
    "",
    "Rules:",
    "- Use only Read, Grep, Find, LS, Write, and Edit.",
    "- Only write topic files inside the topics directory.",
    "- Do not modify MEMORY.md or manifest.json directly.",
    "- Each topic file must use the existing frontmatter + Markdown structure used by the project memory system.",
    "- If a topic already exists, update it instead of creating a duplicate.",
    "- Keep summaries concise and structural. The point of initialization is to establish the right memory skeleton, not to capture every temporary detail.",
    "- Treat content as disposable, but treat the structure as important.",
    "",
    "Expected output shape:",
    "- repository-overview.md",
    "- one or more feature-*.md files",
    "- flow-development.md",
    "- flow-deployment.md",
    "- flow-sync.md",
    "- flow-testing.md",
    "- work-records-structure.md",
    "- session-records-structure.md",
    "",
    "Stop as soon as the initialization topics are created or refreshed.",
  ].join("\n");
}
