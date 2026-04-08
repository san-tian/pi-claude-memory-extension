# pi-codex-remote-compaction

`pi` package for Codex-style remote compaction on the OpenAI Responses path without changing `pi` core.

## Install with `pi`
Recommended project-local install:

```bash
pi install -l git:https://github.com/san-tian/pi-codex-remote-compaction
```

Recommended global install:

```bash
pi install git:https://github.com/san-tian/pi-codex-remote-compaction
```

Update later with:

```bash
pi update
```

After install, `pi` loads the package automatically from settings.

## What this package does
- tries remote Codex-style compaction first
- stores remote compact results in compaction `details`
- rewrites the first post-compaction provider request
- if Claude-style session memory is present, uses it as the summary base and keeps only the recent unsummarized tail before calling remote compaction
- otherwise preserves the original remote-compaction behavior with no session-memory dependency
- warns and falls back to default `pi` compaction if remote compaction fails
- if `/responses/compact` is unavailable, disables remote compaction for the rest of the session after the first warning
- writes debug artifacts to `.tmp/codex-remote-compaction/`

## When it activates
The package is loaded after installation, but it only takes over compaction when the active model uses the OpenAI Responses path:
- model `api` is `openai-responses`
- model has a `baseUrl`
- backend supports `POST /responses/compact`

That means it works with:
- OpenAI-compatible backends
- OpenAI relay or proxy services
- OpenAI-compatible middleboxes that expose both `/responses` and `/responses/compact`

If the backend does not support that path, the package shows a warning, falls back to default `pi` compaction, and skips remote compaction attempts for the rest of the session.

## Session-memory integration

This package works on its own. Installing `pi-session-memory-extension` changes its behavior only when a valid session-memory summary is available for the current session.

- without `pi-session-memory-extension`: pure Codex/OpenAI remote compaction behavior
- with `pi-session-memory-extension` installed but no usable summary yet: pure Codex/OpenAI remote compaction behavior
- with `pi-session-memory-extension` installed and a usable summary present: memory-aware remote compaction

## Manual install fallback
If you do not want to use `pi install`, you can still install it as a project-local extension:

```bash
mkdir -p .pi/extensions
git clone https://github.com/san-tian/pi-codex-remote-compaction.git .pi/extensions/codex-remote-compaction
```

## Install for a `pi` agent
If a `pi` agent is reading this README to install the package for the current project, it should prefer the package flow:

```bash
pi install -l git:https://github.com/san-tian/pi-codex-remote-compaction
```

Then verify installation:

```bash
pi -C "$PWD" --no-session -p 'Reply with exactly: extension smoke ok'
```

Optional backend check inside `pi`:

```text
/codex-compact-probe
```

View the latest remote compaction summary or raw response without inserting a chat message:

```text
/codex-compact-show
/codex-compact-show-raw
```

## 给 pi agent 的中文安装指令
如果你是 `pi` agent，并且用户要求你为当前项目安装这个扩展，优先使用 `pi package` 安装方式：

```bash
pi install -l git:https://github.com/san-tian/pi-codex-remote-compaction
pi -C "$PWD" --no-session -p 'Reply with exactly: extension smoke ok'
```

如果 smoke test 返回 `extension smoke ok`，说明包已经被 `pi` 正常加载。

如果用户还要求确认后端是否支持远程 compaction，可以在 `pi` 里再执行：

```text
/codex-compact-probe
```

如果用户想查看最近一次远程 compaction 的摘要或原始返回，而不把结果写进对话历史，可以执行：

```text
/codex-compact-show
/codex-compact-show-raw
```

如果后端不支持 `/responses/compact`，扩展会给出 warning，然后自动回退到默认 `pi` compaction；这表示远程 compaction 没有生效，但对话仍然可以继续。

## Update and scope
- `pi install -l ...` writes the package to the current project's `.pi/settings.json`
- `pi install ...` writes the package to `~/.pi/agent/settings.json`
- `pi update` updates non-pinned package installs
- if you want to pin a version later, install from a ref such as `git:https://github.com/san-tian/pi-codex-remote-compaction@v0.1.0`

## Repository layout
- `index.ts`: extension entrypoint and hook wiring
- `src/types.ts`: compaction detail and cached-template types
- `src/state.ts`: session-scoped caches
- `src/wrapper.ts`: AGENTS or CLAUDE wrapper synthesis
- `src/codex-input.ts`: `pi` session history to Codex Responses input conversion
- `src/provider-request.ts`: request-template capture and post-compaction payload override
- `src/remote-client.ts`: `/responses/compact` transport
- `src/debug.ts`: debug artifact persistence
- `tools/proxy.py`: local request logger plus overflow injector
- `tools/verify_auto_compaction.mjs`: SDK harness for forced auto-compaction checks
- `tools/normalize-request.mjs`: request normalizer for parity checks
- `tools/compare_requests.mjs`: normalized diff for Codex vs `pi` request captures
- `fixtures/codex/post-compaction.request.json`: sanitized Codex reference request fixture
- `fixtures/pi/overflow-retry.request.json`: sanitized `pi` overflow retry fixture

## Verification commands
Compare the committed Codex fixture against the committed `pi` overflow fixture:

```bash
npm run compare
```

Exercise the SDK auto-compaction harness:

```bash
node tools/verify_auto_compaction.mjs --pi-root /path/to/pi-coding-agent --provider <provider-id> --model <model-id>
```

Run the local proxy logger or overflow injector:

```bash
UPSTREAM=https://api.example.com/openai/v1 python3 tools/proxy.py
```

## Fixture privacy
The committed fixtures are intentionally sanitized:
- no real authorization headers
- no local absolute host paths
- no private workspace prompts
- only the normalized request shape needed for parity regression checks

## Current guarantees
- manual post-compaction request parity is verified
- first overflow immediate retry request parity is verified after normalization
- request-shape regressions can be checked against committed fixtures
- remote compaction failures warn and then fall back to default `pi` compaction
- endpoint-unavailable failures stop retrying remote compaction for the rest of the session

## Requirements
- `pi` with package loading enabled
- a model on the `openai-responses` path
- a backend that supports `/responses` and `/responses/compact`
- Node.js for the maintenance scripts
- Python 3 for `tools/proxy.py`
