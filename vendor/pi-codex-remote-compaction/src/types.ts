export const DETAILS_VERSION = "codex-remote-v1" as const;
export const PLACEHOLDER_SUMMARY = "[Codex remote compaction entry; effective context is provided by extension]";
export const COMPACTION_ERROR_PREFIX = "Codex-compatible remote compaction failed";

export class RemoteCompactUnavailableError extends Error {
  readonly code = "remote-compact-unavailable" as const;

  constructor(message: string) {
    super(message);
    this.name = "RemoteCompactUnavailableError";
  }
}

export const isRemoteCompactUnavailableError = (error: unknown): error is RemoteCompactUnavailableError =>
  error instanceof RemoteCompactUnavailableError;

export type CodexRemoteCompactionDetails = {
  version: typeof DETAILS_VERSION;
  inputBase: unknown[];
  retryInput?: unknown[];
  source: {
    provider: string;
    modelId: string;
    baseUrl: string;
    createdAt: number;
    tokensBefore: number;
  };
  remoteRequest: unknown;
  remoteResult: unknown;
  sessionMemory?: {
    notesPath: string;
    lastSummarizedEntryId?: string;
    firstKeptEntryId: string;
  };
};

export type CachedTemplate = {
  tools?: unknown[];
  parallelToolCalls?: boolean;
  reasoning?: unknown;
  text?: unknown;
  remotePrefixInput?: unknown[];
};
