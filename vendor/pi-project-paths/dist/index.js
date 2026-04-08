import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
const DEFAULT_CONFIG_DIR = ".pi";
const DEFAULT_PROJECTS_DIR = "projects";
const DEFAULT_SLUG_LENGTH = 40;
const DEFAULT_HASH_LENGTH = 12;
function isProjectPathOptions(value) {
    return typeof value === "object" && value !== null;
}
export function sanitizePathComponent(value) {
    return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "project";
}
export function canonicalizePath(inputPath) {
    const resolved = path.resolve(inputPath);
    try {
        return fs.realpathSync.native?.(resolved) ?? fs.realpathSync(resolved);
    }
    catch {
        return resolved;
    }
}
export function resolveProjectRoot(cwd) {
    const resolvedCwd = canonicalizePath(cwd);
    try {
        const gitRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
            cwd: resolvedCwd,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        if (gitRoot)
            return canonicalizePath(gitRoot);
    }
    catch {
        // Fall back to the current working directory outside git repos.
    }
    return resolvedCwd;
}
export function getProjectSlug(cwd, options = {}) {
    const slugLength = options.slugLength ?? DEFAULT_SLUG_LENGTH;
    const projectRoot = resolveProjectRoot(cwd);
    const baseName = path.basename(projectRoot) || projectRoot;
    return sanitizePathComponent(baseName).slice(0, slugLength) || "project";
}
export function getProjectHash(cwd, options = {}) {
    const hashLength = options.hashLength ?? DEFAULT_HASH_LENGTH;
    const projectRoot = resolveProjectRoot(cwd);
    return createHash("sha256").update(projectRoot).digest("hex").slice(0, hashLength);
}
export function getProjectId(cwd, options = {}) {
    return `${getProjectSlug(cwd, options)}-${getProjectHash(cwd, options)}`;
}
export function getPiProjectsDir(options = {}) {
    return path.join(options.homeDir ?? homedir(), options.configDirName ?? DEFAULT_CONFIG_DIR, options.projectsDirName ?? DEFAULT_PROJECTS_DIR);
}
export function getPiProjectDir(cwd, options = {}) {
    return path.join(getPiProjectsDir(options), getProjectId(cwd, options));
}
export function getPiProjectSubdir(cwd, ...rest) {
    const [first, ...remaining] = rest;
    const options = isProjectPathOptions(first) ? first : {};
    const segments = (isProjectPathOptions(first) ? remaining : rest);
    return path.join(getPiProjectDir(cwd, options), ...segments);
}
export function getPiProjectAgentsFile(cwd, options = {}) {
    return getPiProjectSubdir(cwd, options, "AGENTS.md");
}
export function getPiProjectMemoryDir(cwd, options = {}) {
    return getPiProjectSubdir(cwd, options, ".memory");
}
export function getPiProjectMemorySubdir(cwd, ...rest) {
    const [first, ...remaining] = rest;
    const options = isProjectPathOptions(first) ? first : {};
    const segments = (isProjectPathOptions(first) ? remaining : rest);
    return path.join(getPiProjectMemoryDir(cwd, options), ...segments);
}
