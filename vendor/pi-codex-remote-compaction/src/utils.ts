export const DEBUG_DIR = ".tmp/codex-remote-compaction";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

export function stripTransientFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripTransientFields);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    if (val === undefined) continue;
    if (["timestamp", "provider", "model", "api", "usage", "stopReason", "display", "details", "tokensBefore"].includes(key)) {
      continue;
    }
    out[key] = stripTransientFields(val);
  }
  return out;
}

export function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
