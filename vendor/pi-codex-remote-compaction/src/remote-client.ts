import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { COMPACTION_ERROR_PREFIX, RemoteCompactUnavailableError } from "./types.js";
import { isRecord } from "./utils.js";

const REMOTE_COMPACT_UNAVAILABLE_STATUSES = new Set([404, 405, 410, 501]);

function parseJsonBody(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function describeBody(json: unknown, text: string) {
  if (json !== undefined) return JSON.stringify(json).slice(0, 800);
  return text.trim().replace(/\s+/g, " ").slice(0, 800);
}

export async function callRemoteCompact(ctx: ExtensionContext, request: Record<string, unknown>, signal: AbortSignal) {
  const model = ctx.model;
  if (!model) throw new Error(`${COMPACTION_ERROR_PREFIX}: no active model selected`);
  if (model.api !== "openai-responses") {
    throw new Error(`${COMPACTION_ERROR_PREFIX}: current model api ${model.api} is not openai-responses`);
  }
  if (!model.baseUrl) {
    throw new Error(`${COMPACTION_ERROR_PREFIX}: current model has no baseUrl`);
  }
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(`${COMPACTION_ERROR_PREFIX}: auth resolution failed: ${auth.error}`);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(auth.headers ?? {}),
  };
  if (auth.apiKey && !headers.Authorization) headers.Authorization = `Bearer ${auth.apiKey}`;
  const url = `${model.baseUrl.replace(/\/$/, "")}/responses/compact`;
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(request),
    signal,
  });
  const text = await response.text();
  const json = parseJsonBody(text);
  if (!response.ok) {
    const body = describeBody(json, text);
    if (REMOTE_COMPACT_UNAVAILABLE_STATUSES.has(response.status)) {
      throw new RemoteCompactUnavailableError(
        `${COMPACTION_ERROR_PREFIX}: /responses/compact unavailable (HTTP ${response.status}${body ? ` ${body}` : ""})`,
      );
    }
    throw new Error(`${COMPACTION_ERROR_PREFIX}: HTTP ${response.status}${body ? ` ${body}` : ""}`);
  }
  if (json === undefined) {
    throw new Error(`${COMPACTION_ERROR_PREFIX}: remote response was not valid JSON`);
  }
  if (!isRecord(json) || !Array.isArray(json.output)) {
    throw new Error(`${COMPACTION_ERROR_PREFIX}: missing output array in remote response`);
  }
  return json;
}
