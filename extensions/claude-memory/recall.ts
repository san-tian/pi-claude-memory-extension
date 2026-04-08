import fs from "node:fs/promises";
import path from "node:path";
import { runPiSubagent } from "pi-subagent-tool/extensions/subagent/runtime";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { ensureMemoryStore, scanProjectTopicHeaders, scanUserTopicHeaders } from "./memory-store.js";
import { getCanonicalProjectsRoot, getProjectMemoryPaths } from "./paths.js";
import { getState, setState } from "./state.js";
import {
  CLAUDE_MEMORY_SUBAGENT_ENV,
  formatSubagentError,
  formatSubagentModelSpec,
  resolveModel,
} from "./subagent.js";
import { DEFAULT_MEMORY_CONFIG, type MemoryTopicHeader } from "./types.js";

const MAX_PROJECT_TOPIC_CHARS = 3200;
const MAX_USER_TOPIC_CHARS = 2200;
const MAX_EXTERNAL_COMPACT_CHARS = 320;
const MAX_EXTERNAL_EXPANDED_CHARS = 1400;
const MAX_TOTAL_CHARS = 12000;
const EXTERNAL_HEADER_BUDGET = 120;
const USER_HEADER_BUDGET = 40;
const MAX_EXTERNAL_EXPANSIONS = 2;

export interface RecallResult {
  headers: MemoryTopicHeader[];
  message?: {
    customType: string;
    content: string;
    display: boolean;
    details?: unknown;
  };
}

export async function buildRelevantMemoryMessage(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  prompt: string,
): Promise<RecallResult> {
  await ensureMemoryStore(ctx.cwd);
  if (!prompt.trim()) {
    await writeRecallDebug(ctx.cwd, { prompt, selectedTopicIds: [], reason: "empty-prompt" });
    return { headers: [] };
  }

  const [projectHeaders, userHeaders, externalHeaders] = await Promise.all([
    scanProjectTopicHeaders(ctx.cwd),
    scanUserTopicHeaders(),
    scanExternalProjectTopicHeaders(ctx.cwd),
  ]);

  const candidateHeaders = buildCandidateHeaders(projectHeaders, userHeaders, externalHeaders);
  if (candidateHeaders.length === 0) {
    await writeRecallDebug(ctx.cwd, { prompt, selectedTopicIds: [], reason: "no-topics" });
    return { headers: [] };
  }

  const selected = await rankRelevantHeaders(ctx, prompt, candidateHeaders);
  const selectedHeaders = selected.length > 0 ? selected : heuristicFallback(prompt, candidateHeaders);
  const expandedExternalKeys = await selectExpandedExternalRecallKeys(ctx, prompt, selectedHeaders);
  const currentState = getState(ctx);
  const selectedIds = selectedHeaders.map(getRecallKey);
  if ((currentState.lastRecallTopicIds ?? []).join("|") !== selectedIds.join("|")) {
    const nextState = {
      ...currentState,
      lastRecallTopicIds: selectedIds,
      updatedAt: new Date().toISOString(),
    };
    setState(pi, ctx, nextState);
  }

  await writeRecallDebug(ctx.cwd, {
    prompt,
    candidateCount: candidateHeaders.length,
    projectCandidateCount: projectHeaders.length,
    userCandidateCount: userHeaders.length,
    externalCandidateCount: externalHeaders.length,
    selectedTopicIds: selectedIds,
    expandedExternalTopicIds: [...expandedExternalKeys],
    selectedTopics: selectedHeaders,
  });

  if (selectedHeaders.length === 0) {
    return { headers: [] };
  }

  const content = await buildRecallContent(prompt, selectedHeaders, expandedExternalKeys);
  return {
    headers: selectedHeaders,
    message: {
      customType: "claude-memory-recall",
      content,
      display: false,
      details: {
        prompt,
        selectedTopicIds: selectedIds,
        expandedExternalTopicIds: [...expandedExternalKeys],
      },
    },
  };
}

async function rankRelevantHeaders(
  ctx: ExtensionContext,
  prompt: string,
  candidateHeaders: MemoryTopicHeader[],
): Promise<MemoryTopicHeader[]> {
  const model = resolveModel(ctx);
  if (!model) {
    return [];
  }

  const list = candidateHeaders.map((header) => renderCandidateLine(header)).join("\n");

  const result = await runPiSubagent({
    cwd: ctx.cwd,
    prompt: [
      "Select the most relevant long-term memory topic ids for the user request.",
      `Return only a JSON array of ids, with at most ${DEFAULT_MEMORY_CONFIG.maxRelevantTopics} items.`,
      "Prefer current-project memories first, global user memories next, and only choose external-project memories when the idea looks clearly reusable for the current request.",
      "External-project candidates are compact summaries from other projects. Select them only when they provide likely transferable experience.",
      "",
      `User request: ${prompt}`,
      "",
      "Candidate topics:",
      list,
    ].join("\n"),
    model: formatSubagentModelSpec(model),
    tools: [],
    signal: ctx.signal,
    env: {
      [CLAUDE_MEMORY_SUBAGENT_ENV]: "1",
    },
  });

  if (result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted") {
    await writeRecallDebug(ctx.cwd, {
      prompt,
      candidateCount: candidateHeaders.length,
      selectedTopicIds: [],
      rankingError: formatSubagentError(result),
    });
    return [];
  }

  const ids = parseIdArray(result.messages);
  if (ids.length === 0) {
    await writeRecallDebug(ctx.cwd, {
      prompt,
      candidateCount: candidateHeaders.length,
      selectedTopicIds: [],
      rankingRaw: result.messages,
      rankingError: "No ids parsed from ranking response",
    });
    return [];
  }

  const selectedById = new Map(candidateHeaders.map((header) => [getRecallKey(header), header]));
  return ids
    .map((id) => selectedById.get(id))
    .filter((header): header is MemoryTopicHeader => Boolean(header))
    .slice(0, DEFAULT_MEMORY_CONFIG.maxRelevantTopics);
}

async function selectExpandedExternalRecallKeys(
  ctx: ExtensionContext,
  prompt: string,
  headers: MemoryTopicHeader[],
): Promise<Set<string>> {
  const externalHeaders = headers.filter((header) => header.scope === "external-project");
  if (externalHeaders.length === 0) {
    return new Set<string>();
  }

  const previews = await Promise.all(
    externalHeaders.map(async (header) => ({
      header,
      preview: await readExcerpt(header.path, MAX_EXTERNAL_COMPACT_CHARS),
    })),
  );

  const model = resolveModel(ctx);
  if (!model) {
    return new Set(previews.slice(0, 1).map((item) => getRecallKey(item.header)));
  }

  const result = await runPiSubagent({
    cwd: ctx.cwd,
    prompt: [
      "Some external-project memories were selected during the first relevant-memory pass.",
      `Return only a JSON array of recall keys that should be expanded into longer body excerpts, with at most ${MAX_EXTERNAL_EXPANSIONS} items.`,
      "Expand only the external memories whose body text is likely to materially improve the next response. Leave others in compact-summary form.",
      "",
      `User request: ${prompt}`,
      "",
      "Selected external candidates:",
      ...previews.map(
        ({ header, preview }) =>
          `- ${getRecallKey(header)} | project=${header.sourceProjectId ?? "unknown"} | title=${header.title} | summary=${header.summary} | compactPreview=${JSON.stringify(preview)}`,
      ),
    ].join("\n"),
    model: formatSubagentModelSpec(model),
    tools: [],
    signal: ctx.signal,
    env: {
      [CLAUDE_MEMORY_SUBAGENT_ENV]: "1",
    },
  });

  if (result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted") {
    return new Set(previews.slice(0, 1).map((item) => getRecallKey(item.header)));
  }

  const ids = parseIdArray(result.messages);
  if (ids.length === 0) {
    return new Set(previews.slice(0, 1).map((item) => getRecallKey(item.header)));
  }

  return new Set(ids.slice(0, MAX_EXTERNAL_EXPANSIONS));
}

async function buildRecallContent(
  prompt: string,
  headers: MemoryTopicHeader[],
  expandedExternalKeys: Set<string>,
): Promise<string> {
  let remaining = MAX_TOTAL_CHARS;
  const sections: string[] = [];

  for (const header of headers) {
    if (remaining <= 0) {
      break;
    }

    const recallKey = getRecallKey(header);
    const excerptLimit =
      header.scope === "external-project"
        ? expandedExternalKeys.has(recallKey)
          ? MAX_EXTERNAL_EXPANDED_CHARS
          : MAX_EXTERNAL_COMPACT_CHARS
        : header.scope === "user"
          ? MAX_USER_TOPIC_CHARS
          : MAX_PROJECT_TOPIC_CHARS;
    const excerpt = await readExcerpt(header.path, Math.min(excerptLimit, remaining));
    remaining -= excerpt.length;

    sections.push(
      [
        `### ${header.title}`,
        `- recall-key: ${recallKey}`,
        `- scope: ${header.scope}`,
        header.sourceProjectId ? `- source-project: ${header.sourceProjectId}` : undefined,
        `- type: ${header.type}`,
        `- summary: ${header.summary}`,
        `- path: ${header.path}`,
        header.scope === "external-project"
          ? expandedExternalKeys.has(recallKey)
            ? "- recall-stage: external-stage-2-expanded"
            : "- recall-stage: external-stage-1-compact"
          : undefined,
        header.scope === "external-project"
          ? "- note: this comes from another project and should be treated as transferable context, not current-repo truth."
          : undefined,
        "",
        excerpt,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  return [
    `Relevant persistent memories for the current request: ${prompt}`,
    "Use these as recall hints, but verify any codebase-dependent claim before acting on it.",
    "Current-project memories are the default source of truth. Global user memories guide collaboration style. External-project memories are only transferable hints.",
    "External-project memories use a two-stage load: compact summary first, then longer body expansion only for the most promising hits.",
    "",
    ...sections,
  ].join("\n\n");
}

function buildCandidateHeaders(
  projectHeaders: MemoryTopicHeader[],
  userHeaders: MemoryTopicHeader[],
  externalHeaders: MemoryTopicHeader[],
): MemoryTopicHeader[] {
  const externalBudget = Math.max(
    20,
    Math.min(EXTERNAL_HEADER_BUDGET, DEFAULT_MEMORY_CONFIG.maxTopicHeadersToScan - projectHeaders.length - userHeaders.length),
  );
  const userBudget = Math.min(USER_HEADER_BUDGET, DEFAULT_MEMORY_CONFIG.maxTopicHeadersToScan);
  return [
    ...projectHeaders.slice(0, DEFAULT_MEMORY_CONFIG.maxTopicHeadersToScan),
    ...userHeaders.slice(0, userBudget),
    ...externalHeaders.slice(0, externalBudget),
  ].slice(0, DEFAULT_MEMORY_CONFIG.maxTopicHeadersToScan);
}

function renderCandidateLine(header: MemoryTopicHeader): string {
  const keywords = header.keywords?.join(", ") || "none";
  if (header.scope === "external-project") {
    return `- ${getRecallKey(header)} | scope=external-project | project=${header.sourceProjectId ?? "unknown"} | type=${header.type} | title=${header.title} | summary=${header.summary}`;
  }
  if (header.scope === "user") {
    return `- ${getRecallKey(header)} | scope=global-user | type=${header.type} | title=${header.title} | summary=${header.summary} | keywords=${keywords}`;
  }
  return `- ${getRecallKey(header)} | scope=current-project | type=${header.type} | title=${header.title} | summary=${header.summary} | keywords=${keywords}`;
}

function parseIdArray(messages: Array<{ role?: string; content?: unknown }>): string[] {
  const text = messages
    .filter((message) => message.role === "assistant" && Array.isArray(message.content))
    .flatMap((message) => message.content as Array<{ type?: string; text?: string }>)
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();

  if (!text) {
    return [];
  }

  const match = text.match(/\[[\s\S]*\]/);
  if (!match) {
    return [];
  }

  try {
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function heuristicFallback(prompt: string, headers: MemoryTopicHeader[]): MemoryTopicHeader[] {
  const terms = prompt
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length >= 3);
  if (terms.length === 0) {
    return [];
  }

  return headers
    .map((header) => {
      const haystack = `${header.title} ${header.summary} ${header.keywords?.join(" ") || ""}`.toLowerCase();
      const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
      const scopeBonus = header.scope === "project" ? 3 : header.scope === "user" ? 2 : 0;
      return { header, score: score + scopeBonus };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.header.title.localeCompare(right.header.title))
    .slice(0, DEFAULT_MEMORY_CONFIG.maxRelevantTopics)
    .map((item) => item.header);
}

function stripFrontmatter(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return normalized;
  }
  const endIndex = normalized.indexOf("\n---\n", 4);
  if (endIndex === -1) {
    return normalized;
  }
  return normalized.slice(endIndex + 5);
}

async function readExcerpt(filePath: string, limit: number): Promise<string> {
  const raw = await fs.readFile(filePath, "utf8").catch(() => "");
  const topicBody = stripFrontmatter(raw).trim();
  return topicBody.slice(0, limit).trim();
}

function getRecallKey(header: MemoryTopicHeader): string {
  return `${header.scope}:${header.sourceProjectId ?? "global"}:${header.id}`;
}

async function scanExternalProjectTopicHeaders(cwd: string): Promise<MemoryTopicHeader[]> {
  const currentProject = getProjectMemoryPaths(cwd).sourceProjectId;
  const projectsRoot = getCanonicalProjectsRoot();
  const entries = await fs.readdir(projectsRoot, { withFileTypes: true }).catch(() => []);
  const headers: MemoryTopicHeader[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === currentProject) {
      continue;
    }
    const manifestPath = path.join(projectsRoot, entry.name, "memory", "state", "manifest.json");
    const raw = await fs.readFile(manifestPath, "utf8").catch(() => "");
    if (!raw) {
      continue;
    }

    try {
      const parsed = JSON.parse(raw) as { topics?: Array<Partial<MemoryTopicHeader>> };
      for (const topic of parsed.topics ?? []) {
        if (!topic.id || !topic.title || !topic.summary || !topic.path) {
          continue;
        }
        headers.push({
          id: topic.id,
          title: topic.title,
          type: topic.type === "user" || topic.type === "feedback" || topic.type === "reference" ? topic.type : "project",
          summary: topic.summary,
          updatedAt: topic.updatedAt,
          keywords: Array.isArray(topic.keywords) ? topic.keywords.filter((item): item is string => typeof item === "string") : [],
          path: topic.path,
          scope: "external-project",
          sourceProjectId: entry.name,
          sourceLabel: `external-project:${entry.name}`,
        });
      }
    } catch {
      continue;
    }
  }

  return headers.sort((left, right) => {
    const leftTime = left.updatedAt ? Date.parse(left.updatedAt) : 0;
    const rightTime = right.updatedAt ? Date.parse(right.updatedAt) : 0;
    return rightTime - leftTime || left.title.localeCompare(right.title);
  });
}

async function writeRecallDebug(cwd: string, details: Record<string, unknown>): Promise<void> {
  const paths = getProjectMemoryPaths(cwd);
  await fs.mkdir(paths.stateDir, { recursive: true });
  await fs.writeFile(
    paths.recallDebugPath,
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        ...details,
      },
      null,
      2,
    ),
    "utf8",
  );
}
