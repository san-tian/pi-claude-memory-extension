import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export const CLAUDE_MEMORY_SUBAGENT_ENV = "_PI_CLAUDE_MEMORY_SUBAGENT";

export function isClaudeMemorySubagentProcess(): boolean {
  return process.env[CLAUDE_MEMORY_SUBAGENT_ENV] === "1";
}

export function resolveModel(ctx: ExtensionContext) {
  // Keep recall/extract/dream on the user's active model instead of silently drifting to a fallback provider.
  return ctx.model;
}

export function formatSubagentModelSpec(model: { provider: string; id: string; reasoning?: boolean }): string {
  const base = `${model.provider}/${model.id}`;
  return model.reasoning ? `${base}:low` : base;
}

export function formatSubagentError(result: {
  stderr: string;
  errorMessage?: string;
  messages: Array<{ role?: string; content?: unknown }>;
  stopReason?: string;
}): string {
  if (result.errorMessage) {
    return result.errorMessage;
  }
  const lastAssistantText = getLastAssistantText(result.messages);
  if (lastAssistantText) {
    return lastAssistantText;
  }
  if (result.stderr.trim()) {
    return result.stderr.trim();
  }
  return result.stopReason ? `Subagent stopped: ${result.stopReason}` : "Subagent failed";
}

export function getLastAssistantText(messages: Array<{ role?: string; content?: unknown }>): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }
    const text = message.content
      .filter((part): part is { type: string; text?: string } => Boolean(part) && typeof part === "object")
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text ?? "")
      .join("\n")
      .trim();
    if (text) {
      return text;
    }
  }
  return "";
}
