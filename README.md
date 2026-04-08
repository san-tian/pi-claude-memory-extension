# Pi Claude Memory Extension

Claude-style persistent project memory for Pi, packaged as an installable Pi extension.

## What this package does

This package adds the long-term memory layer for a Pi project:

- stores durable project memory under `~/.pi/project/<project-id>/memory/`
- stores global user memory under `~/.pi/user-memory/`
- injects memory guidance at runtime instead of editing `AGENTS.md`
- reuses `pi-session-memory-extension` for session memory instead of reimplementing it
- extracts durable memories from longer conversations into topic files
- recalls relevant topics before a new agent turn
- periodically runs a consolidation pass (`autoDream`) to reduce duplication

## What this package does not do

Version `0.1.0` intentionally stays small:

- no `team memory`
- no `agent memory`
- no custom memory write/search/link/prune tools
- no `CLAUDE.md` compatibility layer

## Install

From GitHub after publishing:

```bash
pi install git:github.com/san-tian/pi-claude-memory-extension
```

From a local checkout:

```bash
pi install /absolute/path/to/pi-claude-memory-extension
```

For quick local development:

```bash
pi -e ./extensions/claude-memory/index.ts
```

This package automatically loads these installed package dependencies:

- `pi-session-memory-extension`
- `pi-codex-remote-compaction`

This package does not bundle or install `pi-subagent-tool` internally. Long-term memory extraction/recall/dream rely on the separately installed `pi-subagent-tool` package at runtime. If you want this extension to work fully, install:

```bash
pi install git:github.com/san-tian/pi-subagent-tool
```

That package provides the subagent runtime helper, while this package avoids registering the public `subagent` tool itself.

## Requirements

- Pi must have a working model/provider configuration for subagent runs.
- The extension uses Pi's native `AGENTS.md` behavior as-is; it does not modify that file.
- Project memory is project-scoped, so different git repos or non-git folders get different `~/.pi/project/<project-id>/memory/` directories.
- Global user memory is shared across projects at `~/.pi/user-memory/`.

## Runtime behavior

### 1. Prompt injection

On `before_agent_start`, the extension:

- appends a persistent-memory system prompt
- recalls relevant long-term topics for the current user prompt from three pools: current project, global user memory, and compact external-project candidates
- injects the recalled topic content as a hidden custom message
- falls back to a compact current-project `MEMORY.md` preview when nothing is recalled

### 2. Automatic extraction

On `turn_end`, the extension may run an extraction pass when the conversation is large enough.

Current conservative defaults:

- initialize after about `10000` tokens
- require about `5000` more tokens between extraction passes
- wait for at least `3` tool calls when the recent turn was tool-heavy

Extraction writes `type=user` memories to `~/.pi/user-memory/topics/` and all other memory types to the current project's `memory/topics/`. `MEMORY.md` and `state/manifest.json` are rebuilt afterward for both managed stores.

### 3. Relevant-memory recall

Recall scans topic headers, ranks candidates with a lightweight side-query subagent when a model is available, and falls back to keyword matching when it is not.

Recall always considers:

- current-project topic headers
- global user-memory topic headers
- compact manifest entries from other projects

Current limits:

- scan up to `200` topic headers
- inject up to `5` topics
- trim recalled topic content to a bounded character budget

External-project memories only participate during `relevant memories` retrieval; they are not otherwise injected into the session by default. External-project recall now uses a two-stage load: compact candidate selection first, then longer body expansion only for the most promising external hits. Debug output is written to the current project's `memory/state/last-recall.json`.

### 4. Automatic dream consolidation

After enough extraction passes, the extension runs a dream/consolidation pass that edits topic files in place to reduce duplication and strengthen durable summaries.

Current default:

- dream after `4` extraction passes

Dream runs behind both the current project's `memory/state/dream.lock` and the global user-memory `state/dream.lock`, and writes per-run logs under the current project's `memory/logs/dreams/`.

## File layout

```text
~/.pi/project/<project-id>/memory/
  MEMORY.md
  topics/
    <topic-id>.md
  state/
    manifest.json
    last-recall.json
    dream.lock
  logs/
    dreams/
      <timestamp>.json

~/.pi/user-memory/
  MEMORY.md
  topics/
    <topic-id>.md
  state/
    manifest.json
    dream.lock
```

Topic files use stable frontmatter plus Markdown body sections:

```md
---
id: example-topic-id
title: Example Topic Title
type: project
summary: One-sentence summary of the reusable memory.
updatedAt: 2026-04-04T00:00:00.000Z
keywords: keyword-a, keyword-b
---

# Example Topic Title

## Summary
One-sentence summary of the reusable memory.

## Details
...
```

## Commands

- `/memory-init` seeds a first-pass project memory structure from the current repository root
- `/memory-status` shows paths, topic counts, and in-session state
- `/memory-extract` forces one extraction pass
- `/memory-dream` forces one dream/consolidation pass
- `/memory-recall-debug` shows the latest recall debug payload

## Relationship to session memory

This package is only the long-term memory layer.

- short-lived conversational memory stays in `pi-session-memory-extension`
- instruction memory stays in Pi's normal `AGENTS.md` flow
- this package adds durable project memory plus a global user-memory layer on top

## Validation

Validated with:

```bash
cd /vePFS-Mindverse/user/intern/ccss/pi-mono/packages/pi-claude-memory-extension && npm run typecheck
```

Focused smoke tests also exercised:

- topic repair and artifact rebuild
- `/memory-init` project structure seeding
- heuristic relevant-memory recall plus debug file output
- cross-project relevant-memory recall (project + global user + external project)
- dream lock handling for consolidation re-entry protection
- real extraction routing of `user` memories into `~/.pi/user-memory/`

## Known limitations

- extraction, LLM-ranked recall, and successful dream consolidation still depend on a working provider/model at runtime
- recall currently injects a hidden custom message during `before_agent_start`; future refinement may move this to a lower-level per-request context hook if Pi runtime behavior requires tighter placement
- first version favors simple Markdown files and conservative triggers over aggressive automation
