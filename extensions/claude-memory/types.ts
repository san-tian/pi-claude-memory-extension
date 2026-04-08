import type { ClaudeMemoryScope } from "./paths.js";

export const MEMORY_TOPIC_TYPES = ["user", "feedback", "project", "reference"] as const;

export type MemoryTopicType = (typeof MEMORY_TOPIC_TYPES)[number];

export interface ClaudeMemoryConfig {
  minimumMessageTokensToInit: number;
  minimumTokensBetweenExtraction: number;
  toolCallsBetweenExtraction: number;
  maxRelevantTopics: number;
  maxTopicHeadersToScan: number;
  dreamAfterExtractions: number;
}

export interface ClaudeMemoryState {
  initialized: boolean;
  extractionCount: number;
  extractionCountAtLastDream?: number;
  tokensAtLastExtraction: number;
  lastTriggerEntryId?: string;
  lastSummarizedEntryId?: string;
  lastDreamEntryId?: string;
  lastDreamAt?: string;
  lastRecallTopicIds?: string[];
  updatedAt?: string;
  memoryRoot?: string;
}

export interface MemoryTopicHeader {
  id: string;
  title: string;
  type: MemoryTopicType;
  summary: string;
  updatedAt?: string;
  keywords?: string[];
  path: string;
  scope: ClaudeMemoryScope;
  sourceProjectId?: string;
  sourceLabel: string;
}

export const DEFAULT_MEMORY_CONFIG: ClaudeMemoryConfig = {
  minimumMessageTokensToInit: 10000,
  minimumTokensBetweenExtraction: 5000,
  toolCallsBetweenExtraction: 3,
  maxRelevantTopics: 5,
  maxTopicHeadersToScan: 200,
  dreamAfterExtractions: 4,
};

export function defaultClaudeMemoryState(): ClaudeMemoryState {
  return {
    initialized: false,
    extractionCount: 0,
    tokensAtLastExtraction: 0,
    lastRecallTopicIds: [],
  };
}
