import fs from "node:fs/promises";
import path from "node:path";
import { getProjectId } from "@san-tian/pi-project-paths";
import {
  rebuildProjectMemoryArtifacts,
  renderTopicTemplate,
  scanProjectTopicHeaders,
} from "./memory-store.js";
import { getProjectMemoryPaths } from "./paths.js";
import type { MemoryTopicType, MemoryTopicHeader } from "./types.js";

type InitResult = {
  ok: boolean;
  headers: MemoryTopicHeader[];
  files: string[];
};

type ProjectSnapshot = {
  cwd: string;
  projectId: string;
  readmeTitle?: string;
  readmeSummary?: string;
  packageName?: string;
  packageManager?: string;
  topLevelDirs: string[];
  topLevelFiles: string[];
  keyFiles: string[];
  packageScripts: string[];
  ecosystems: string[];
};

type InitTopic = {
  id: string;
  title: string;
  type: MemoryTopicType;
  summary: string;
  keywords: string[];
  detailLines: Array<string | undefined>;
};

const RESERVED_INIT_TOPICS = [
  "repository-overview",
  "deployment-workflow",
  "sync-workflow",
  "testing-workflow",
] as const;

const FEATURE_DIR_BLOCKLIST = new Set([
  "node_modules",
  ".git",
  ".github",
  ".idea",
  ".vscode",
  "dist",
  "build",
  "coverage",
  "tmp",
  ".tmp",
  "logs",
]);

export async function initializeProjectMemory(cwd: string): Promise<InitResult> {
  const paths = getProjectMemoryPaths(cwd);
  await fs.mkdir(paths.topicsDir, { recursive: true });

  const snapshot = await collectProjectSnapshot(cwd);
  const now = new Date().toISOString();
  const topics = buildInitTopics(snapshot);
  const files: string[] = [];

  for (const topic of topics) {
    const filePath = path.join(paths.topicsDir, `${topic.id}.md`);
    const content = renderInitializedTopic(topic, now);
    await fs.writeFile(filePath, content, "utf8");
    files.push(filePath);
  }

  await rebuildProjectMemoryArtifacts(cwd);
  const headers = await scanProjectTopicHeaders(cwd);
  return { ok: true, headers, files };
}

async function collectProjectSnapshot(cwd: string): Promise<ProjectSnapshot> {
  const entries = await fs.readdir(cwd, { withFileTypes: true }).catch(() => []);
  const topLevelDirs = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
  const topLevelFiles = entries
    .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();

  const readmePath = topLevelFiles.find((name) => name.toLowerCase() === "readme.md")
    ? path.join(cwd, topLevelFiles.find((name) => name.toLowerCase() === "readme.md")!)
    : undefined;
  const packageJsonPath = topLevelFiles.includes("package.json") ? path.join(cwd, "package.json") : undefined;

  const [readme, packageJson] = await Promise.all([
    readmePath ? fs.readFile(readmePath, "utf8").catch(() => "") : Promise.resolve(""),
    packageJsonPath ? fs.readFile(packageJsonPath, "utf8").catch(() => "") : Promise.resolve(""),
  ]);

  const parsedReadme = parseReadme(readme);
  const parsedPackage = parsePackageJson(packageJson);
  const keyFiles = topLevelFiles.filter((name) =>
    [
      "README.md",
      "AGENTS.md",
      "package.json",
      "pnpm-workspace.yaml",
      "bun.lock",
      "bun.lockb",
      "tsconfig.json",
      "Cargo.toml",
      "go.mod",
      "pyproject.toml",
      "Makefile",
      "docker-compose.yml",
      "Dockerfile",
    ].includes(name),
  );

  return {
    cwd,
    projectId: getProjectId(cwd),
    readmeTitle: parsedReadme.title,
    readmeSummary: parsedReadme.summary,
    packageName: parsedPackage.name,
    packageManager: detectPackageManager(topLevelFiles),
    topLevelDirs,
    topLevelFiles,
    keyFiles,
    packageScripts: parsedPackage.scripts,
    ecosystems: detectEcosystems(topLevelFiles),
  };
}

function buildInitTopics(snapshot: ProjectSnapshot): InitTopic[] {
  const featureTopics = buildFeatureTopics(snapshot);

  return [
    {
      id: "repository-overview",
      title: "Repository Overview",
      type: "project",
      summary: buildOverviewSummary(snapshot),
      keywords: ["overview", ...snapshot.ecosystems.slice(0, 3)],
      detailLines: [
        `- Project id: ${snapshot.projectId}`,
        `- Working directory: ${snapshot.cwd}`,
        snapshot.readmeTitle ? `- README title: ${snapshot.readmeTitle}` : undefined,
        snapshot.readmeSummary ? `- README summary: ${snapshot.readmeSummary}` : undefined,
        snapshot.packageName ? `- Package name: ${snapshot.packageName}` : undefined,
        snapshot.packageManager ? `- Package manager signal: ${snapshot.packageManager}` : undefined,
        snapshot.ecosystems.length > 0 ? `- Detected ecosystems: ${snapshot.ecosystems.join(", ")}` : undefined,
        featureTopics.length > 0 ? `- Initialized feature topics: ${featureTopics.map((topic) => topic.title).join(", ")}` : undefined,
        "- This overview topic exists to connect the initialized Feature / Flow / Work Record / Session Record structure.",
      ],
    },
    ...featureTopics,
    buildDevelopmentTopic(snapshot),
    buildDeploymentTopic(snapshot),
    buildSyncTopic(snapshot),
    buildTestingTopic(snapshot),
    buildWorkRecordsTopic(snapshot),
    buildSessionRecordsTopic(snapshot),
  ];
}

function buildFeatureTopics(snapshot: ProjectSnapshot): InitTopic[] {
  const candidates = snapshot.topLevelDirs.filter((dir) => !FEATURE_DIR_BLOCKLIST.has(dir));
  const selected = candidates.slice(0, 6);

  if (selected.length === 0) {
    return [
      {
        id: "feature-root-surface",
        title: "Feature: Root Surface",
        type: "project",
        summary: "The repository does not expose obvious top-level feature directories yet, so the current feature surface is concentrated in root files.",
        keywords: ["feature", "root", "layout"],
        detailLines: [
          snapshot.topLevelFiles.length > 0 ? `- Top-level files: ${snapshot.topLevelFiles.join(", ")}` : undefined,
          "- This topic is the fallback Feature topic when the repository has not split into clear top-level capability directories yet.",
          "- Re-run `/memory-init` after the project grows clearer feature directories.",
        ],
      },
    ];
  }

  return selected.map((dir) => ({
    id: `feature-${toTopicId(dir)}`,
    title: `Feature: ${humanize(dir)}`,
    type: "project",
    summary: `Top-level feature surface currently includes the ${dir} directory; treat it as one of the main project capability areas until deeper memory extraction refines the model.`,
    keywords: ["feature", dir],
    detailLines: [
      `- Source directory: ${dir}`,
      snapshot.keyFiles.length > 0 ? `- Root key files nearby: ${snapshot.keyFiles.join(", ")}` : undefined,
      "- This topic is seeded from repository structure and should be enriched later with implementation-specific knowledge.",
    ],
  }));
}

function buildDevelopmentTopic(snapshot: ProjectSnapshot): InitTopic {
  const signals = [
    snapshot.packageManager ? `package manager: ${snapshot.packageManager}` : undefined,
    snapshot.packageScripts.length > 0 ? `package scripts: ${snapshot.packageScripts.join(", ")}` : undefined,
    snapshot.topLevelDirs.includes("src") ? "src/" : undefined,
    snapshot.topLevelDirs.includes("docs") ? "docs/" : undefined,
  ].filter(Boolean);

  return {
    id: "flow-development",
    title: "Flow: Development",
    type: "project",
    summary:
      signals.length > 0
        ? `Development flow signals currently include ${signals.join(", ")}.`
        : "Development flow has not been inferred yet; this topic reserves a stable place for day-to-day coding workflow guidance.",
    keywords: ["flow", "development", "coding"],
    detailLines: [
      signals.length > 0 ? `- Current development signals: ${signals.join(", ")}` : "- No explicit development-flow signals detected yet.",
      "- Use this topic for coding workflow, startup order, and day-to-day implementation habits.",
    ],
  };
}

function buildDeploymentTopic(snapshot: ProjectSnapshot): InitTopic {
  const signals = [
    snapshot.topLevelFiles.includes("Dockerfile") ? "Dockerfile" : undefined,
    snapshot.topLevelFiles.includes("docker-compose.yml") ? "docker-compose.yml" : undefined,
    snapshot.packageScripts.find((name) => /deploy|release|start/.test(name)) ? `package script: ${snapshot.packageScripts.find((name) => /deploy|release|start/.test(name))}` : undefined,
  ].filter(Boolean);

  return {
    id: "flow-deployment",
    title: "Flow: Deployment",
    type: "project",
    summary:
      signals.length > 0
        ? `Deployment-related signals currently include ${signals.join(", ")}.`
        : "Deployment flow has not been inferred yet; this topic exists so deployment knowledge has a stable home from the start.",
    keywords: ["deployment", "release", ...(signals as string[]).map((signal) => toTopicId(signal))],
    detailLines: [
      signals.length > 0 ? `- Current deployment signals: ${signals.join(", ")}` : "- No explicit deployment files or scripts detected yet.",
      "- Use this topic for release, environment, and delivery workflow knowledge as it becomes clear.",
    ],
  };
}

function buildSyncTopic(snapshot: ProjectSnapshot): InitTopic {
  const signals = [
    snapshot.topLevelFiles.includes("AGENTS.md") ? "AGENTS.md" : undefined,
    snapshot.topLevelDirs.includes("docs") ? "docs/" : undefined,
    snapshot.readmeSummary ? "README.md" : undefined,
  ].filter(Boolean);

  return {
    id: "flow-sync",
    title: "Flow: Sync",
    type: "project",
    summary:
      signals.length > 0
        ? `Documentation and coordination sync signals currently include ${signals.join(", ")}.`
        : "Sync workflow has not been inferred yet; this topic reserves a stable place for documentation and coordination rules.",
    keywords: ["sync", "docs", "coordination"],
    detailLines: [
      signals.length > 0 ? `- Current sync signals: ${signals.join(", ")}` : "- No explicit sync/documentation signals detected yet.",
      "- Use this topic for doc updates, memory refresh, and coordination handoff rules.",
    ],
  };
}

function buildTestingTopic(snapshot: ProjectSnapshot): InitTopic {
  const testScripts = snapshot.packageScripts.filter((name) => /test|check|verify|lint/.test(name));
  const signals = [
    ...testScripts.map((name) => `package script: ${name}`),
    snapshot.topLevelDirs.includes("tests") ? "tests/" : undefined,
    snapshot.topLevelDirs.includes("test") ? "test/" : undefined,
  ].filter(Boolean);

  return {
    id: "flow-testing",
    title: "Flow: Testing",
    type: "project",
    summary:
      signals.length > 0
        ? `Testing-related signals currently include ${signals.join(", ")}.`
        : "Testing flow has not been inferred yet; this topic reserves a stable place for validation rules and test commands.",
    keywords: ["flow", "testing", "validation", ...testScripts.slice(0, 3)],
    detailLines: [
      signals.length > 0 ? `- Current testing signals: ${signals.join(", ")}` : "- No explicit test files or scripts detected yet.",
      "- Use this topic for canonical validation commands and testing expectations as they become known.",
    ],
  };
}

function buildWorkRecordsTopic(snapshot: ProjectSnapshot): InitTopic {
  return {
    id: "work-records-structure",
    title: "Work Records Structure",
    type: "project",
    summary: "Work-record memory should track the current focus, open threads, and durable decisions that matter for future collaboration.",
    keywords: ["work-records", "coordination", "handoff"],
    detailLines: [
      `- Current project id: ${snapshot.projectId}`,
      "- Use this topic to hold the evolving shape of current focus, open items, and durable decisions.",
      "- The goal is not to preserve every temporary detail, but to preserve the structure needed for future work to restart cleanly.",
    ],
  };
}

function buildSessionRecordsTopic(snapshot: ProjectSnapshot): InitTopic {
  return {
    id: "session-records-structure",
    title: "Session Records Structure",
    type: "project",
    summary: "Session-record memory should preserve restartable handoff structure between work sessions without depending on old temporary transcripts.",
    keywords: ["session-records", "handoff", "restart"],
    detailLines: [
      `- Current project id: ${snapshot.projectId}`,
      "- Use this topic to preserve how a session should hand off to the next session or agent.",
      "- Prefer stable handoff structure over temporary per-turn detail.",
    ],
  };
}

function renderInitializedTopic(topic: InitTopic, updatedAt: string): string {
  const base = renderTopicTemplate({
    id: topic.id,
    title: topic.title,
    type: topic.type,
    summary: topic.summary,
    updatedAt,
    keywords: topic.keywords.filter(Boolean),
  });
  const details = topic.detailLines.filter(Boolean).join("\n");
  return `${base}${details ? `${details}\n` : ""}`;
}

function buildOverviewSummary(snapshot: ProjectSnapshot): string {
  if (snapshot.readmeSummary) {
    return snapshot.readmeSummary.slice(0, 180);
  }
  const name = snapshot.readmeTitle ?? snapshot.packageName ?? path.basename(snapshot.cwd);
  const ecosystem = snapshot.ecosystems.length > 0 ? snapshot.ecosystems.join("/") : "project";
  return `${name} is a ${ecosystem} repository that should be initialized from the current root structure before deeper memory extraction begins.`;
}

function parseReadme(content: string): { title?: string; summary?: string } {
  if (!content.trim()) {
    return {};
  }
  const normalized = content.replace(/\r\n/g, "\n");
  const title = normalized.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const paragraphs = normalized
    .split(/\n\s*\n/)
    .map((part) => part.replace(/^#+\s+.*$/gm, "").trim())
    .filter(Boolean);
  return {
    title,
    summary: paragraphs[0]?.slice(0, 240),
  };
}

function parsePackageJson(content: string): { name?: string; scripts: string[] } {
  if (!content.trim()) {
    return { scripts: [] };
  }
  try {
    const parsed = JSON.parse(content) as { name?: string; scripts?: Record<string, string> };
    return {
      name: parsed.name,
      scripts: Object.keys(parsed.scripts ?? {}).sort(),
    };
  } catch {
    return { scripts: [] };
  }
}

function detectPackageManager(topLevelFiles: string[]): string | undefined {
  if (topLevelFiles.includes("pnpm-lock.yaml") || topLevelFiles.includes("pnpm-workspace.yaml")) {
    return "pnpm";
  }
  if (topLevelFiles.includes("bun.lock") || topLevelFiles.includes("bun.lockb")) {
    return "bun";
  }
  if (topLevelFiles.includes("package-lock.json")) {
    return "npm";
  }
  if (topLevelFiles.includes("yarn.lock")) {
    return "yarn";
  }
  return undefined;
}

function detectEcosystems(topLevelFiles: string[]): string[] {
  const ecosystems: string[] = [];
  if (topLevelFiles.includes("package.json")) {
    ecosystems.push("node");
  }
  if (topLevelFiles.includes("Cargo.toml")) {
    ecosystems.push("rust");
  }
  if (topLevelFiles.includes("go.mod")) {
    ecosystems.push("go");
  }
  if (topLevelFiles.includes("pyproject.toml")) {
    ecosystems.push("python");
  }
  return ecosystems;
}

function toTopicId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "topic";
}

function humanize(value: string): string {
  return value
    .split(/[-_./]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}
