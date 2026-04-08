import { promises as fs } from "node:fs";
import path from "node:path";
import { getPiProjectSubdir } from "@san-tian/pi-project-paths";
import type { ExtensionContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import { entryToMessages, agentMessagesToCodexInput } from "./codex-input.js";

const STATE_ENTRY_TYPE = "session-memory-state";
const COMPACT_CONFIG = {
  minTokens: 10000,
  minTextEntries: 5,
  maxTokens: 40000,
};

const DEFAULT_SESSION_MEMORY_TEMPLATE = `
# Session Title
_A short and distinctive 5-10 word descriptive title for the session. Super info dense, no filler_

# Current State
_What is actively being worked on right now? Pending tasks not yet completed. Immediate next steps._

# Task specification
_What did the user ask to build? Any design decisions or other explanatory context_

# Files and Functions
_What are the important files? In short, what do they contain and why are they relevant?_

# Workflow
_What bash commands are usually run and in what order? How to interpret their output if not obvious?_

# Errors & Corrections
_Errors encountered and how they were fixed. What did the user correct? What approaches failed and should not be tried again?_

# Codebase and System Documentation
_What are the important system components? How do they work/fit together?_

# Learnings
_What has worked well? What has not? What to avoid? Do not duplicate items from other sections_

# Key results
_If the user asked a specific output such as an answer to a question, a table, or other document, repeat the exact result here_

# Worklog
_Step by step, what was attempted, done? Very terse summary for each step_
`;

type SessionMemoryState = {
  lastSummarizedEntryId?: string;
};

export type SessionMemoryCompactInput = {
  input: unknown[];
  firstKeptEntryId: string;
  notesPath: string;
  summaryText: string;
  lastSummarizedEntryId?: string;
};

export async function buildSessionMemoryCompactInput(
  ctx: ExtensionContext,
  branchEntries: SessionEntry[],
  defaultFirstKeptEntryId: string,
): Promise<SessionMemoryCompactInput | null> {
  const notesPath = getSessionMemoryPath(ctx);
  const summaryText = await readSessionMemorySummary(notesPath);
  if (!summaryText) {
    return null;
  }

  const state = getSessionMemoryState(branchEntries);
  const firstKeptEntryId = deriveFirstKeptEntryId(branchEntries, defaultFirstKeptEntryId, state.lastSummarizedEntryId);
  const tailEntries = getEntriesFrom(branchEntries, firstKeptEntryId);
  const tailInput = agentMessagesToCodexInput(entryToMessages(tailEntries));
  const input = [{ type: "compaction_summary", summary_text: summaryText }, ...tailInput];

  return {
    input,
    firstKeptEntryId,
    notesPath,
    summaryText,
    lastSummarizedEntryId: state.lastSummarizedEntryId,
  };
}

function getSessionMemoryState(entries: SessionEntry[]): SessionMemoryState {
  let state: SessionMemoryState = {};
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE || !entry.data) {
      continue;
    }
    if (typeof entry.data === "object" && entry.data !== null) {
      state = { ...state, ...(entry.data as SessionMemoryState) };
    }
  }
  return state;
}

function getSessionMemoryPath(ctx: ExtensionContext): string {
  return path.join(
    getPiProjectSubdir(ctx.sessionManager.getCwd(), ctx.sessionManager.getSessionId(), "session-memory"),
    "summary.md",
  );
}

async function readSessionMemorySummary(filePath: string): Promise<string | null> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    const normalized = content.trim();
    if (!normalized || normalized === DEFAULT_SESSION_MEMORY_TEMPLATE.trim()) {
      return null;
    }
    return normalized;
  } catch {
    return null;
  }
}

function getEntriesFrom(entries: SessionEntry[], entryId: string) {
  const index = entries.findIndex((entry) => entry.id === entryId);
  if (index === -1) return [] as SessionEntry[];
  return entries.slice(index);
}

function deriveFirstKeptEntryId(entries: SessionEntry[], defaultEntryId: string, lastSummarizedEntryId?: string): string {
  const defaultIndex = entries.findIndex((entry) => entry.id === defaultEntryId);
  if (defaultIndex === -1) {
    return defaultEntryId;
  }

  let startIndex = entries.length;
  if (lastSummarizedEntryId) {
    const summarizedIndex = entries.findIndex((entry) => entry.id === lastSummarizedEntryId);
    if (summarizedIndex !== -1) {
      startIndex = Math.min(entries.length, summarizedIndex + 1);
    }
  }

  startIndex = expandStartIndexForRecentContext(entries, startIndex, defaultIndex);
  startIndex = adjustStartIndexToPreserveToolGroups(entries, startIndex, defaultIndex);

  return entries[startIndex]?.id ?? defaultEntryId;
}

function expandStartIndexForRecentContext(entries: SessionEntry[], startIndex: number, floorIndex: number): number {
  if (entries.length === 0) {
    return 0;
  }

  let nextStart = Math.max(Math.min(startIndex, entries.length), floorIndex);
  let totalTokens = 0;
  let textEntryCount = 0;

  for (let index = nextStart; index < entries.length; index += 1) {
    totalTokens += estimateEntryTokens(entries[index]);
    if (entryHasText(entries[index])) {
      textEntryCount += 1;
    }
  }

  if (totalTokens >= COMPACT_CONFIG.maxTokens) {
    return nextStart;
  }

  if (totalTokens >= COMPACT_CONFIG.minTokens && textEntryCount >= COMPACT_CONFIG.minTextEntries) {
    return nextStart;
  }

  for (let index = nextStart - 1; index >= floorIndex; index -= 1) {
    totalTokens += estimateEntryTokens(entries[index]);
    if (entryHasText(entries[index])) {
      textEntryCount += 1;
    }
    nextStart = index;

    if (totalTokens >= COMPACT_CONFIG.maxTokens) {
      break;
    }

    if (totalTokens >= COMPACT_CONFIG.minTokens && textEntryCount >= COMPACT_CONFIG.minTextEntries) {
      break;
    }
  }

  return nextStart;
}

function adjustStartIndexToPreserveToolGroups(entries: SessionEntry[], startIndex: number, floorIndex: number): number {
  let nextStart = startIndex;
  while (nextStart > floorIndex && isToolResultEntry(entries[nextStart])) {
    nextStart -= 1;
  }

  if (nextStart > floorIndex && isAssistantToolCallEntry(entries[nextStart - 1]) && isToolResultEntry(entries[nextStart])) {
    nextStart -= 1;
  }

  return nextStart;
}

function estimateEntryTokens(entry: SessionEntry | undefined): number {
  if (!entry) return 0;
  if (entry.type === "message") return roughTokenCount(extractMessageText(entry.message));
  if (entry.type === "custom_message") return roughTokenCount(extractContentText(entry.content));
  if (entry.type === "compaction" || entry.type === "branch_summary") return roughTokenCount(entry.summary);
  return 0;
}

function entryHasText(entry: SessionEntry | undefined): boolean {
  if (!entry) return false;
  if (entry.type === "message") {
    if (entry.message.role !== "assistant" && entry.message.role !== "user") return false;
    return extractMessageText(entry.message).trim().length > 0;
  }
  if (entry.type === "custom_message") {
    return extractContentText(entry.content).trim().length > 0;
  }
  return false;
}

function extractMessageText(message: { content?: unknown }): string {
  return extractContentText(message.content);
}

function extractContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const block = part as { type?: string; text?: string; name?: string; arguments?: unknown; content?: unknown };
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
      continue;
    }
    if ((block.type === "toolCall" || block.type === "tool_use") && typeof block.name === "string") {
      parts.push(`tool:${block.name} ${JSON.stringify(block.arguments ?? {})}`);
      continue;
    }
    if ((block.type === "tool_result" || block.type === "toolResult") && block.content !== undefined) {
      parts.push(extractContentText(block.content));
    }
  }
  return parts.join("\n");
}

function isToolResultEntry(entry: SessionEntry | undefined): boolean {
  return Boolean(entry && entry.type === "message" && entry.message.role === "toolResult");
}

function isAssistantToolCallEntry(entry: SessionEntry | undefined): boolean {
  if (!entry || entry.type !== "message" || entry.message.role !== "assistant" || !Array.isArray(entry.message.content)) {
    return false;
  }
  return entry.message.content.some((part) => {
    if (!part || typeof part !== "object") return false;
    const block = part as { type?: string };
    return block.type === "toolCall" || block.type === "tool_use";
  });
}

function roughTokenCount(content: string): number {
  return Math.ceil(content.length / 4);
}
