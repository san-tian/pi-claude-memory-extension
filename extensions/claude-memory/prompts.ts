import type { ClaudeMemoryConfig } from "./types.js";

export function buildMemorySystemPrompt(
  projectMemoryRoot: string,
  userMemoryRoot: string,
  config: ClaudeMemoryConfig,
): string {
  return [
    "# Persistent Memory",
    "",
    `This session has access to project memory rooted at ${projectMemoryRoot}.`,
    `This session also has access to global user memory rooted at ${userMemoryRoot}.`,
    "Use persistent memory to preserve information that will be useful across future sessions, especially stable user preferences, successful workflows, important corrections, and durable project context.",
    "Store user-level memories in the global user memory root. Store project-specific feedback, project context, and reference memories in the current project's memory root.",
    "Do not treat memory as a source of truth over the codebase. When a recalled memory matters for a code change, verify it against the repository before taking irreversible actions.",
    "Do not write speculative, low-confidence, or one-off transient details into long-term memory.",
    `When relevant memories are available, prefer the most relevant ${config.maxRelevantTopics} topics rather than assuming every memory store is already in context.`,
    "Relevant memories may include compact candidates from other projects, but those are only retrieval hints and should never override the current repository state.",
    "Session memory remains separate and is handled by the bundled session-memory package.",
  ].join("\n");
}

export function buildMemoryIndexMessage(indexPath: string, preview: string): string {
  return [
    `Persistent memory index: ${indexPath}`,
    "",
    "Use this as a compact guide to existing long-term memory topics. Relevant topic bodies can be recalled separately.",
    "",
    preview.trim(),
  ].join("\n");
}
