import {
  buildSessionContext,
  getLatestCompactionEntry,
  type CompactionEntry,
  type SessionEntry,
} from "@mariozechner/pi-coding-agent";
import { COMPACTION_ERROR_PREFIX, DETAILS_VERSION, type CodexRemoteCompactionDetails } from "./types.js";
import { isRecord, stripTransientFields } from "./utils.js";

export function getLatestCodexCompaction(branchEntries: SessionEntry[]): CompactionEntry<CodexRemoteCompactionDetails> | undefined {
  const latest = getLatestCompactionEntry(branchEntries);
  if (!latest) return undefined;
  const details = latest.details;
  if (!isRecord(details) || details.version !== DETAILS_VERSION) return undefined;
  return latest as CompactionEntry<CodexRemoteCompactionDetails>;
}

export function entryToMessages(entries: SessionEntry[]) {
  const messages: Record<string, unknown>[] = [];
  for (const entry of entries) {
    if (entry.type === "message") {
      messages.push(entry.message as Record<string, unknown>);
      continue;
    }
    if (entry.type === "custom_message") {
      const content = typeof entry.content === "string" ? [{ type: "text", text: entry.content }] : entry.content;
      messages.push({
        role: "custom",
        customType: entry.customType,
        content,
        display: entry.display,
        details: entry.details,
        timestamp: new Date(entry.timestamp).getTime(),
      });
      continue;
    }
    if (entry.type === "branch_summary" && entry.summary) {
      messages.push({
        role: "branchSummary",
        summary: entry.summary,
        fromId: entry.fromId,
        timestamp: new Date(entry.timestamp).getTime(),
      });
    }
  }
  return messages;
}

export function getEntriesAfter(entries: SessionEntry[], entryId: string) {
  const index = entries.findIndex((entry) => entry.id === entryId);
  if (index === -1) return [] as SessionEntry[];
  return entries.slice(index + 1);
}

export function getLastUserInputFromBranch(entries: SessionEntry[]) {
  const messages = buildSessionContext(entries).messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as Record<string, unknown> | undefined;
    if (message?.role === "user") {
      return agentMessagesToCodexInput([message]);
    }
  }
  return [] as unknown[];
}

export function buildEffectiveContextInput(branchEntries: SessionEntry[]) {
  const latest = getLatestCodexCompaction(branchEntries);
  if (!latest) {
    return agentMessagesToCodexInput(buildSessionContext(branchEntries).messages as Record<string, unknown>[]);
  }
  const postEntries = getEntriesAfter(branchEntries, latest.id);
  const postMessages = entryToMessages(postEntries);
  return [...latest.details.inputBase, ...agentMessagesToCodexInput(postMessages)];
}

export function filterRemoteOutputForCodexParity(output: unknown) {
  if (!Array.isArray(output)) {
    throw new Error(`${COMPACTION_ERROR_PREFIX}: remote output is not an array`);
  }
  const kept: Record<string, unknown>[] = [];
  for (const item of output) {
    if (!isRecord(item)) {
      throw new Error(`${COMPACTION_ERROR_PREFIX}: unsupported compact output item shape`);
    }
    const type = typeof item.type === "string" ? item.type : "message";
    if (
      type === "message" ||
      type === "reasoning" ||
      type === "function_call" ||
      type === "function_call_output" ||
      type === "compaction_summary"
    ) {
      if (type === "compaction_summary") kept.push(item);
      continue;
    }
    throw new Error(`${COMPACTION_ERROR_PREFIX}: unsupported compact output item type "${type}" in strict mode`);
  }
  if (kept.length === 0) {
    throw new Error(`${COMPACTION_ERROR_PREFIX}: remote output did not contain a compaction_summary item`);
  }
  return kept;
}

export function extractRemoteSummaryText(output: unknown) {
  if (!Array.isArray(output)) return undefined;

  const parts = output
    .filter((item) => isRecord(item) && item.type === "compaction_summary")
    .flatMap((item) => collectSummaryParts(item))
    .map((part) => part.trim())
    .filter(Boolean);

  return parts.length > 0 ? parts.join("\n") : undefined;
}

function collectSummaryParts(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => collectSummaryParts(item));
  if (!isRecord(value)) return [];

  const parts: string[] = [];
  for (const key of ["summary_text", "text"]) {
    if (typeof value[key] === "string") parts.push(value[key]);
  }

  if (Array.isArray(value.summary)) parts.push(...collectSummaryParts(value.summary));
  if (Array.isArray(value.content)) parts.push(...collectSummaryParts(value.content));
  if (isRecord(value.text) && typeof value.text.value === "string") parts.push(value.text.value);

  return parts;
}

function assistantTextBlockToOutputText(block: Record<string, unknown>) {
  return { type: "output_text", text: typeof block.text === "string" ? block.text : "", annotations: [] };
}

function userTextBlockToInputText(block: Record<string, unknown>) {
  return { type: "input_text", text: typeof block.text === "string" ? block.text : "" };
}

function splitToolCallId(value: unknown) {
  const raw = typeof value === "string" ? value : "";
  if (!raw) return { callId: `call-${Date.now()}`, itemId: undefined as string | undefined };
  const [callId, itemId] = raw.split("|", 2);
  return {
    callId: callId || raw,
    itemId: itemId || undefined,
  };
}

function tryParseJsonObject(text: unknown) {
  if (typeof text !== "string" || !text) return undefined;
  const parsed = JSON.parse(text);
  return isRecord(parsed) ? parsed : undefined;
}

export function agentMessagesToCodexInput(messages: Record<string, unknown>[]) {
  const items: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (!isRecord(message) || typeof message.role !== "string") continue;
    if (message.role === "user") {
      const content = Array.isArray(message.content)
        ? message.content.flatMap((block) => {
            if (!isRecord(block) || typeof block.type !== "string") return [];
            if (block.type === "text") return [userTextBlockToInputText(block)];
            if (block.type === "image") {
              const source = isRecord(block.source) ? stripTransientFields(block.source) : undefined;
              return source ? [{ type: "input_image", image_url: source }] : [];
            }
            return [];
          })
        : [];
      items.push({ role: "user", content });
      continue;
    }
    if (message.role === "assistant") {
      const contentBlocks = Array.isArray(message.content) ? message.content : [];
      const textBlocks = contentBlocks
        .filter((block) => isRecord(block) && block.type === "text")
        .map((block) => assistantTextBlockToOutputText(block as Record<string, unknown>));
      if (textBlocks.length > 0) {
        const sig = contentBlocks
          .filter((block) => isRecord(block) && block.type === "text")
          .map((block) => tryParseJsonObject((block as Record<string, unknown>).textSignature))
          .find(Boolean);
        items.push({
          type: "message",
          role: "assistant",
          content: textBlocks,
          status: "completed",
          ...(sig?.id ? { id: sig.id } : {}),
          ...(sig?.phase ? { phase: sig.phase } : {}),
        });
      }
      for (const block of contentBlocks) {
        if (!isRecord(block) || typeof block.type !== "string") continue;
        if (block.type === "thinking") {
          const sig = tryParseJsonObject(block.thinkingSignature);
          if (!sig?.encrypted_content && !Array.isArray(sig?.summary)) continue;
          items.push({
            type: "reasoning",
            ...(sig.id ? { id: sig.id } : {}),
            ...(sig.encrypted_content ? { encrypted_content: sig.encrypted_content } : {}),
            ...(Array.isArray(sig.summary) ? { summary: sig.summary } : { summary: [] }),
          });
          continue;
        }
        if (block.type === "toolCall") {
          const ids = splitToolCallId(block.id);
          items.push({
            type: "function_call",
            ...(ids.itemId ? { id: ids.itemId } : {}),
            call_id: ids.callId,
            name: typeof block.name === "string" ? block.name : "unknown",
            arguments: JSON.stringify(isRecord(block.arguments) ? block.arguments : {}),
          });
        }
      }
      continue;
    }
    if (message.role === "toolResult") {
      const content = Array.isArray(message.content) ? message.content : [];
      const text = content
        .filter((block) => isRecord(block) && block.type === "text")
        .map((block) => String((block as Record<string, unknown>).text ?? ""))
        .join("\n");
      const ids = splitToolCallId(message.toolCallId);
      items.push({
        type: "function_call_output",
        call_id: ids.callId,
        output: text,
      });
    }
  }
  return items;
}
