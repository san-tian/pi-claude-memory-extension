import { homedir } from "node:os";
import path from "node:path";
import { getPiProjectDir, getPiProjectsDir, getProjectId } from "@san-tian/pi-project-paths";

export type ClaudeMemoryScope = "project" | "user" | "external-project";

export interface ClaudeMemoryPaths {
  scope: ClaudeMemoryScope;
  rootDir: string;
  indexPath: string;
  topicsDir: string;
  stateDir: string;
  manifestPath: string;
  recallDebugPath: string;
  dreamLogDir: string;
  lockPath: string;
  sourceProjectId?: string;
  sourceLabel: string;
}

const PROJECTS_DIR_NAME = "project";

function buildMemoryPaths(rootDir: string, scope: ClaudeMemoryScope, sourceProjectId?: string): ClaudeMemoryPaths {
  const stateDir = path.join(rootDir, "state");
  const sourceLabel =
    scope === "user"
      ? "global-user"
      : scope === "external-project"
        ? `external-project:${sourceProjectId ?? "unknown"}`
        : `project:${sourceProjectId ?? "current"}`;

  return {
    scope,
    rootDir,
    indexPath: path.join(rootDir, "MEMORY.md"),
    topicsDir: path.join(rootDir, "topics"),
    stateDir,
    manifestPath: path.join(stateDir, "manifest.json"),
    recallDebugPath: path.join(stateDir, "last-recall.json"),
    dreamLogDir: path.join(rootDir, "logs", "dreams"),
    lockPath: path.join(stateDir, "dream.lock"),
    sourceProjectId,
    sourceLabel,
  };
}

export function getCanonicalProjectRoot(cwd: string): string {
  return getPiProjectDir(cwd, { projectsDirName: PROJECTS_DIR_NAME });
}

export function getCanonicalProjectsRoot(): string {
  return getPiProjectsDir({ projectsDirName: PROJECTS_DIR_NAME });
}

export function getProjectMemoryRoot(cwd: string): string {
  return path.join(getCanonicalProjectRoot(cwd), "memory");
}

export function getUserMemoryRoot(): string {
  return path.join(homedir(), ".pi", "user-memory");
}

export function getProjectMemoryPaths(cwd: string): ClaudeMemoryPaths {
  return buildMemoryPaths(
    getProjectMemoryRoot(cwd),
    "project",
    getProjectId(cwd, { projectsDirName: PROJECTS_DIR_NAME }),
  );
}

export function getUserMemoryPaths(): ClaudeMemoryPaths {
  return buildMemoryPaths(getUserMemoryRoot(), "user");
}

export function getExternalProjectMemoryPaths(projectId: string): ClaudeMemoryPaths {
  return buildMemoryPaths(path.join(getCanonicalProjectsRoot(), projectId, "memory"), "external-project", projectId);
}

export function getAllManagedMemoryPaths(cwd: string): ClaudeMemoryPaths[] {
  return [getProjectMemoryPaths(cwd), getUserMemoryPaths()];
}

export function getClaudeMemoryRoot(cwd: string): string {
  return getProjectMemoryRoot(cwd);
}

export function getClaudeMemoryPaths(cwd: string): ClaudeMemoryPaths {
  return getProjectMemoryPaths(cwd);
}

export function getTopicPath(cwd: string, topicId: string, scope: Exclude<ClaudeMemoryScope, "external-project"> = "project"): string {
  const paths = scope === "user" ? getUserMemoryPaths() : getProjectMemoryPaths(cwd);
  return path.join(paths.topicsDir, `${topicId}.md`);
}
