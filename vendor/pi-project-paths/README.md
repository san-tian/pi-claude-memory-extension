# pi-project-paths

Shared helpers for stable Pi project storage paths.

## What it does

Given a working directory, this package computes a stable project directory under:

`~/.pi/projects/<project-id>/`

If your local convention prefers `~/.pi/project/<project-id>/`, pass `{ projectsDirName: "project" }`.

The default `project-id` format is:

`<sanitized-basename>-<short-sha256>`

Examples:

- `~/work/pi-ralph-wiggum-compact-session` -> `pi-ralph-wiggum-compact-session-a1b2c3d4e5f6`
- `/tmp/scratch` -> `scratch-1a2b3c4d5e6f`

## Rules

- Prefer the git repository root when available
- Fall back to the provided `cwd` when outside a git repo
- Canonicalize paths with `realpath` before hashing
- Keep the slug readable and the hash collision-resistant

## API

```ts
import {
  getPiProjectDir,
  getPiProjectSubdir,
  getPiProjectAgentsFile,
  getPiProjectMemoryDir,
  getPiProjectMemorySubdir,
  getProjectId,
  resolveProjectRoot,
} from "@san-tian/pi-project-paths";

const projectDir = getPiProjectDir(process.cwd());
const ralphDir = getPiProjectSubdir(process.cwd(), "ralph");
const agentsFile = getPiProjectAgentsFile(process.cwd());
const memoryDir = getPiProjectMemoryDir(process.cwd());
const featureDoc = getPiProjectMemorySubdir(process.cwd(), "docs", "features", "paths.md");

const singularProjectDir = getPiProjectDir(process.cwd(), { projectsDirName: "project" });
const singularAgentsFile = getPiProjectAgentsFile(process.cwd(), { projectsDirName: "project" });
```

## External project memory for pi

This package is a path helper, not a pi package by itself.

If you want project-specific AGENTS/docs outside the repository, use the computed project directory as the canonical memory root:

- `AGENTS.md` -> `~/.pi/projects/<project-id>/AGENTS.md`
- project memory/docs -> `~/.pi/projects/<project-id>/.memory/...`

If you prefer a singular root, the same layout also works with `{ projectsDirName: "project" }`.

For the current repository, that path looks like:

`/root/.pi/projects/pi-project-paths-b87c0d92e463`

Typical layout:

```text
~/.pi/projects/<project-id>/
  AGENTS.md
  .memory/
    docs/
      features/
      flows/
      records/
        sessions/
```

## How to make pi read external AGENTS.md

Pi loads `AGENTS.md` from the current directory tree by default, not from `~/.pi/projects/<project-id>/` or `~/.pi/project/<project-id>/`.

To use this package for external project memory, pick one of these patterns:

1. Keep the canonical docs in `~/.pi/projects/<project-id>/` and have your workflow/tooling read and update them explicitly.
2. Add a small pi extension or SDK `DefaultResourceLoader` override that injects `getPiProjectAgentsFile(process.cwd())` into `agentsFiles`.
3. If you only need compatibility with tools that insist on a repo-local `AGENTS.md`, create a symlink from the repo to the canonical file in `~/.pi/projects/<project-id>/`.

Minimal SDK example:

```ts
import { readFileSync, existsSync } from "node:fs";
import { createAgentSession, DefaultResourceLoader } from "@mariozechner/pi-coding-agent";
import { getPiProjectAgentsFile } from "@san-tian/pi-project-paths";

const loader = new DefaultResourceLoader({
  agentsFilesOverride: (current) => {
    const agentsFile = getPiProjectAgentsFile(process.cwd());
    if (!existsSync(agentsFile)) return current;

    return {
      agentsFiles: [
        ...current.agentsFiles,
        { path: agentsFile, content: readFileSync(agentsFile, "utf8") },
      ],
    };
  },
});

await loader.reload();
await createAgentSession({ resourceLoader: loader });
```

## Prompt adaptation

If you already use a bootstrap prompt that writes `AGENTS.md` and `.memory/docs` into the repository, the main change is:

- replace repo-local paths with `getPiProjectDir(process.cwd())`
- treat `~/.pi/projects/<project-id>/AGENTS.md` as canonical
- treat `~/.pi/projects/<project-id>/.memory/docs/...` as canonical
- only use repo-local files when pi itself needs a shim such as a symlink or a loader override

If your house style is singular, use `getPiProjectDir(process.cwd(), { projectsDirName: "project" })` and the same rule applies.

## Development

```bash
npm install
npm run typecheck
```
