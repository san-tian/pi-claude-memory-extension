import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import { agentMessagesToCodexInput, entryToMessages, getEntriesAfter } from "./codex-input.js";
import type { CachedTemplate, CodexRemoteCompactionDetails } from "./types.js";
import { ensureUserWrapper, splitDeveloperAndUserContext } from "./wrapper.js";
import { isRecord } from "./utils.js";

export function captureTemplate(payload: Record<string, unknown>): CachedTemplate {
  let remotePrefixInput: unknown[] | undefined;
  if (Array.isArray(payload.input) && payload.input.length > 0) {
    const first = payload.input[0];
    if (isRecord(first) && first.role === "developer") {
      const split = splitDeveloperAndUserContext(first.content);
      const prefix: unknown[] = [];
      if (split.developerPrefix) prefix.push({ role: "developer", content: split.developerPrefix });
      if (split.userWrapper) prefix.push({ role: "user", content: [{ type: "input_text", text: split.userWrapper }] });
      if (prefix.length > 0) remotePrefixInput = prefix;
    }
  }
  return {
    tools: Array.isArray(payload.tools) ? structuredClone(payload.tools) : undefined,
    parallelToolCalls: typeof payload.parallel_tool_calls === "boolean" ? payload.parallel_tool_calls : undefined,
    reasoning: payload.reasoning ? structuredClone(payload.reasoning) : undefined,
    text: payload.text ? structuredClone(payload.text) : undefined,
    remotePrefixInput,
  };
}

export function buildOverriddenPayload(args: {
  payload: Record<string, unknown>;
  branch: SessionEntry[];
  latestId: string;
  details: CodexRemoteCompactionDetails;
  synthesizedWrapper: unknown[];
  cachedPrefix?: unknown[];
  pendingInput: unknown[];
}) {
  const fallbackPrefix = Array.isArray(args.payload.input)
    ? args.payload.input.filter((item) => isRecord(item) && item.role === "developer")
    : [];
  const prefixInput = ensureUserWrapper(args.cachedPrefix ?? fallbackPrefix, args.synthesizedWrapper);
  const postEntries = getEntriesAfter(args.branch, args.latestId);
  const postInput = agentMessagesToCodexInput(entryToMessages(postEntries));
  const hasPostUserInput = postInput.some((item) => isRecord(item) && item.role === "user");
  const mergedTail = hasPostUserInput
    ? JSON.stringify(postInput.slice(-args.pendingInput.length)) === JSON.stringify(args.pendingInput)
      ? postInput
      : [...postInput, ...args.pendingInput]
    : (args.details.retryInput ?? []);
  return {
    ...args.payload,
    input: [...prefixInput, ...args.details.inputBase, ...mergedTail],
  };
}
