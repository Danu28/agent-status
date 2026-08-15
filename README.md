# agent-status

A [pi](https://github.com/earendil-works/pi) extension that shows the agent's live state in the footer.

Single-file, zero dependencies, no configuration required — drop it in and `/reload`.

## Statuses

| Indicator | Meaning |
|-----------|---------|
| **● running** | Agent started, model working (thinking) |
| **● streaming…** | Assistant response streaming |
| **● running · tool: X** | A tool is executing |
| **⚠ no activity Ns** | Busy but no event arrived for `AGENT_STATUS_STUCK_MS` (default 60s). During a tool phase this likely means a hung execution — `Esc` to abort. During thinking/streaming it may just be a long silent reasoning window — abort only if it never progresses. |
| **✓ idle** | Agent settled; pi is waiting for input |

"Activity" = any agent/turn/message/tool event. A watchdog re-checks every 2s and flips to the stuck warning only while the agent is busy.

## Install

### Option A — single file (recommended)

Copy [`agent-status.ts`](agent-status.ts) into pi's global auto-discovery folder:

```bash
# curl (or just drop the file in place)
curl -Lo ~/.pi/agent/extensions/agent-status.ts \
  https://raw.githubusercontent.com/Danu28/agent-status/main/agent-status.ts

# then reload extensions
/reload
```

On Windows, `~` maps to `%USERPROFILE%` → `%USERPROFILE%\.pi\agent\extensions\agent-status.ts`.
**Prefer a script?** Run `bash ./install.sh` — idempotent: clones/pulls the repo into `~/.pi/agent/.extension-src/` and copies the single file.

### Option B — whole repo

```bash
git clone https://github.com/Danu28/agent-status ~/.pi/agent/extensions/agent-status
cp ~/.pi/agent/extensions/agent-status/agent-status.ts ~/.pi/agent/extensions/
rm -rf ~/.pi/agent/extensions/agent-status   # optional cleanup
```

### Option C — quick test (per-session)

```bash
pi -e ./agent-status.ts
```

> **Note:** pi auto-discovers extensions from `~/.pi/agent/extensions/*.ts` (global) or `.pi/extensions/*.ts` (project-local). Extensions can be hot-reloaded with `/reload`; no restart needed. See the [extension docs](https://github.com/earendil-works/pi/blob/main/docs/extensions.md) for details.

## Configuration

Environment variables (optional):

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_STATUS_STUCK_MS` | `60000` | Milliseconds of silence before the stuck warning appears. `NaN`/`0` fall back to the default; negative values clamp to a 1s floor (`Math.max(1000, …)`) so the watchdog can never be silently disabled. |
| `AGENT_STATUS_ENABLED` | `1` | Set to `0` to disable the extension entirely. |

```bash
AGENT_STATUS_STUCK_MS=120000 pi          # quieter watchdog (120s)
AGENT_STATUS_ENABLED=0 pi                # disable
```

## How it works

The extension subscribes to pi's lifecycle events (`agent_start`, `turn_start`, `message_start/update/end`, `tool_execution_start`, `tool_result`, `agent_end`, `agent_settled`) and renders the status via `ctx.ui.setStatus()`. Because renders are cached (only re-renders on change), the 2s watchdog interval is harmless.

Design notes worth knowing:

- **"✓ idle"** is set only on `agent_settled` — `agent_end` alone leaves the badge busy, because pi may auto-retry, compact, or process follow-up messages after it.
- **`//reload` re-runs the factory**; each reload spawns an additional watchdog tick (harmless — renders are cached). A teardown hook isn't exposed by the extension API.
- **Malformed env values are clamped** — the watchdog can never be silently disabled by a bad `AGENT_STATUS_STUCK_MS`.

## Development

The repo includes TypeScript scaffolding so you can type-check locally:

```bash
npm install    # dev deps only: pi types, typescript, @types/node
npm run typecheck
```

## License

MIT — see [LICENSE](LICENSE).