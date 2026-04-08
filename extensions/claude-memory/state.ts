import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import { defaultClaudeMemoryState, type ClaudeMemoryState } from "./types.js";

export const STATE_ENTRY_TYPE = "claude-memory-state";
export const REPORT_MESSAGE_TYPE = "claude-memory-report";

const states = new Map<string, ClaudeMemoryState>();
export const activeExtractions = new Set<string>();
export const activeDreams = new Set<string>();

export function getSessionKey(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionFile() ?? `ephemeral:${ctx.sessionManager.getSessionId()}`;
}

export function loadStateFromEntries(entries: SessionEntry[]): ClaudeMemoryState {
  let state = defaultClaudeMemoryState();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE || !entry.data) {
      continue;
    }
    if (typeof entry.data === "object" && entry.data !== null) {
      state = {
        ...state,
        ...(entry.data as Partial<ClaudeMemoryState>),
      };
    }
  }
  return state;
}

export function reconstructState(ctx: ExtensionContext): ClaudeMemoryState {
  const state = loadStateFromEntries(ctx.sessionManager.getEntries());
  states.set(getSessionKey(ctx), state);
  return state;
}

export function getState(ctx: ExtensionContext): ClaudeMemoryState {
  const key = getSessionKey(ctx);
  const current = states.get(key);
  if (current) {
    return current;
  }
  return reconstructState(ctx);
}

export function setState(pi: ExtensionAPI, ctx: ExtensionContext, next: ClaudeMemoryState): void {
  states.set(getSessionKey(ctx), next);
  pi.appendEntry(STATE_ENTRY_TYPE, next);
}

export function clearState(ctx: ExtensionContext): void {
  const key = getSessionKey(ctx);
  states.delete(key);
  activeExtractions.delete(key);
  activeDreams.delete(key);
}
