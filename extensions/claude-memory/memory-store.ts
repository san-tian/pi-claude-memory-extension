import fs from "node:fs/promises";
import path from "node:path";
import {
  getAllManagedMemoryPaths,
  getProjectMemoryPaths,
  getUserMemoryPaths,
  type ClaudeMemoryPaths,
} from "./paths.js";
import type { MemoryTopicHeader, MemoryTopicType } from "./types.js";

const TOPIC_FRONTMATTER_BOUNDARY = "---";
const TOPIC_TEMPLATE = [
  "---",
  "id: {{id}}",
  "title: {{title}}",
  "type: {{type}}",
  "summary: {{summary}}",
  "updatedAt: {{updatedAt}}",
  "keywords: {{keywords}}",
  "---",
  "",
  "# {{title}}",
  "",
  "## Summary",
  "{{summary}}",
  "",
  "## Details",
  "",
].join("\n");

export async function ensureMemoryStore(cwd: string): Promise<void> {
  await Promise.all(getAllManagedMemoryPaths(cwd).map((paths) => ensureScopedMemoryStore(paths)));
}

export async function ensureScopedMemoryStore(paths: ClaudeMemoryPaths): Promise<void> {
  await fs.mkdir(paths.topicsDir, { recursive: true });
  await fs.mkdir(paths.stateDir, { recursive: true });
  await fs.mkdir(paths.dreamLogDir, { recursive: true });

  try {
    await fs.access(paths.indexPath);
  } catch {
    await fs.writeFile(paths.indexPath, renderMemoryIndex([], paths), "utf8");
  }

  try {
    await fs.access(paths.manifestPath);
  } catch {
    await fs.writeFile(paths.manifestPath, JSON.stringify({ topics: [] }, null, 2), "utf8");
  }
}

export async function rebuildMemoryArtifacts(cwd: string): Promise<MemoryTopicHeader[]> {
  const [projectHeaders, userHeaders] = await Promise.all([
    rebuildProjectMemoryArtifacts(cwd),
    rebuildUserMemoryArtifacts(),
  ]);
  return [...projectHeaders, ...userHeaders];
}

export async function rebuildProjectMemoryArtifacts(cwd: string): Promise<MemoryTopicHeader[]> {
  const paths = getProjectMemoryPaths(cwd);
  return rebuildScopedMemoryArtifacts(paths);
}

export async function rebuildUserMemoryArtifacts(): Promise<MemoryTopicHeader[]> {
  return rebuildScopedMemoryArtifacts(getUserMemoryPaths());
}

export async function rebuildScopedMemoryArtifacts(paths: ClaudeMemoryPaths): Promise<MemoryTopicHeader[]> {
  await ensureScopedMemoryStore(paths);
  const headers = await scanTopicHeadersInStore(paths);
  await fs.writeFile(paths.manifestPath, JSON.stringify({ topics: headers }, null, 2), "utf8");
  await fs.writeFile(paths.indexPath, renderMemoryIndex(headers, paths), "utf8");
  return headers;
}

export async function scanTopicHeaders(cwd: string): Promise<MemoryTopicHeader[]> {
  const [projectHeaders, userHeaders] = await Promise.all([scanProjectTopicHeaders(cwd), scanUserTopicHeaders()]);
  return [...projectHeaders, ...userHeaders];
}

export async function scanProjectTopicHeaders(cwd: string): Promise<MemoryTopicHeader[]> {
  return scanTopicHeadersInStore(getProjectMemoryPaths(cwd));
}

export async function scanUserTopicHeaders(): Promise<MemoryTopicHeader[]> {
  return scanTopicHeadersInStore(getUserMemoryPaths());
}

export async function scanTopicHeadersInStore(paths: ClaudeMemoryPaths): Promise<MemoryTopicHeader[]> {
  const entries = await fs.readdir(paths.topicsDir, { withFileTypes: true }).catch(() => []);
  const topics: MemoryTopicHeader[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }
    const filePath = path.join(paths.topicsDir, entry.name);
    const content = await fs.readFile(filePath, "utf8");
    const repaired = repairTopicDocument(entry.name, content);
    if (repaired.content !== content) {
      await fs.writeFile(filePath, repaired.content, "utf8");
    }
    const parsed = parseTopicHeader(filePath, repaired.content, paths);
    if (parsed) {
      topics.push(parsed);
    }
  }

  return topics.sort((left, right) => {
    const leftTime = left.updatedAt ? Date.parse(left.updatedAt) : 0;
    const rightTime = right.updatedAt ? Date.parse(right.updatedAt) : 0;
    return rightTime - leftTime || left.title.localeCompare(right.title);
  });
}

export function renderMemoryIndex(headers: MemoryTopicHeader[], paths: ClaudeMemoryPaths): string {
  const topicLines =
    headers.length === 0
      ? ["- No long-term topics yet."]
      : headers.map((header) => {
          const suffix = header.updatedAt ? ` (updated ${header.updatedAt})` : "";
          return `- [${header.title}](topics/${header.id}.md) - ${header.type}: ${header.summary}${suffix}`;
        });

  const title = paths.scope === "user" ? "User Memory Index" : "Project Memory Index";
  const description =
    paths.scope === "user"
      ? "This file is the generated entry point for global user memory shared across projects."
      : "This file is the generated entry point for persistent project memory.";

  return [title ? `# ${title}` : "# Memory Index", "", description, "Topic files under `topics/` contain the detailed long-term memory bodies.", "", `Total topics: ${headers.length}`, "", "## Topic Files", ...topicLines, ""].join("\n").trimEnd() + "\n";
}

export function renderTopicTemplate(input: {
  id: string;
  title: string;
  type: MemoryTopicType;
  summary: string;
  updatedAt: string;
  keywords: string[];
}): string {
  return TOPIC_TEMPLATE.replace(/\{\{id\}\}/g, input.id)
    .replace(/\{\{title\}\}/g, input.title)
    .replace(/\{\{type\}\}/g, input.type)
    .replace(/\{\{summary\}\}/g, input.summary)
    .replace(/\{\{updatedAt\}\}/g, input.updatedAt)
    .replace(/\{\{keywords\}\}/g, input.keywords.join(", "));
}

export function parseTopicHeader(
  filePath: string,
  content: string,
  paths?: Pick<ClaudeMemoryPaths, "scope" | "sourceProjectId" | "sourceLabel">,
): MemoryTopicHeader | null {
  const normalized = content.replace(/\r\n/g, "\n");
  const frontmatter = parseFrontmatter(normalized);
  if (!frontmatter) {
    return null;
  }

  const id = frontmatter.id || path.basename(filePath, ".md");
  const title = frontmatter.title || firstHeading(normalized) || id;
  const type = normalizeTopicType(frontmatter.type);
  const summary = frontmatter.summary || "Long-term project memory topic";
  const keywords = frontmatter.keywords
    ? frontmatter.keywords
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];

  return {
    id,
    title,
    type,
    summary,
    updatedAt: frontmatter.updatedAt,
    keywords,
    path: filePath,
    scope: paths?.scope ?? "project",
    sourceProjectId: paths?.sourceProjectId,
    sourceLabel: paths?.sourceLabel ?? "project:current",
  };
}

export function repairTopicDocument(fileName: string, content: string): { content: string; repaired: boolean } {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  const fallbackId = path.basename(fileName, ".md");
  const fallbackTitle = firstHeading(normalized) || humanizeTopicId(fallbackId);
  const existingFrontmatter = parseFrontmatter(normalized);
  const body = stripFrontmatter(normalized);
  const lines = body.trim() ? body.trimEnd().split("\n") : [`# ${fallbackTitle}`, "", "## Summary", "", "## Details", ""];

  const metadata = {
    id: existingFrontmatter?.id || fallbackId,
    title: existingFrontmatter?.title || fallbackTitle,
    type: normalizeTopicType(existingFrontmatter?.type),
    summary: existingFrontmatter?.summary || inferSummary(lines) || "Long-term project memory topic",
    updatedAt: existingFrontmatter?.updatedAt || new Date().toISOString(),
    keywords: existingFrontmatter?.keywords || "",
  };

  const repairedContent = [
    TOPIC_FRONTMATTER_BOUNDARY,
    `id: ${metadata.id}`,
    `title: ${metadata.title}`,
    `type: ${metadata.type}`,
    `summary: ${metadata.summary}`,
    `updatedAt: ${metadata.updatedAt}`,
    `keywords: ${metadata.keywords}`,
    TOPIC_FRONTMATTER_BOUNDARY,
    "",
    ...lines,
    "",
  ].join("\n");

  return {
    content: repairedContent,
    repaired: repairedContent !== `${normalized}\n`,
  };
}

function parseFrontmatter(content: string): Record<string, string> | null {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== TOPIC_FRONTMATTER_BOUNDARY) {
    return null;
  }

  const endIndex = lines.indexOf(TOPIC_FRONTMATTER_BOUNDARY, 1);
  if (endIndex === -1) {
    return null;
  }

  const fields: Record<string, string> = {};
  for (const line of lines.slice(1, endIndex)) {
    const separator = line.indexOf(":");
    if (separator === -1) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key) {
      fields[key] = value;
    }
  }
  return fields;
}

function stripFrontmatter(content: string): string {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== TOPIC_FRONTMATTER_BOUNDARY) {
    return content;
  }
  const endIndex = lines.indexOf(TOPIC_FRONTMATTER_BOUNDARY, 1);
  if (endIndex === -1) {
    return content;
  }
  return lines.slice(endIndex + 1).join("\n").trimStart();
}

function firstHeading(content: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() ?? "";
}

function inferSummary(lines: string[]): string {
  const summaryIndex = lines.findIndex((line) => line.trim().toLowerCase() === "## summary");
  if (summaryIndex === -1) {
    return "";
  }
  for (const line of lines.slice(summaryIndex + 1)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed.startsWith("## ")) {
      break;
    }
    return trimmed;
  }
  return "";
}

function humanizeTopicId(value: string): string {
  return value
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizeTopicType(value: string | undefined): MemoryTopicType {
  return value === "user" || value === "feedback" || value === "reference" ? value : "project";
}
