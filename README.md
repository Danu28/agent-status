# agent-status

A [pi](https://github.com/earendil-works/pi) extension that shows the agent's live state in the footer, plus a `/agent-session-status` command that renders a compact summary of the last session.

Single-file, zero dependencies, no configuration required — drop it in and `/reload`.

## Statuses

| Indicator | Meaning |
|-----------|---------|
| **● running** | Agent started, model working (thinking) |
| **● streaming…** | Assistant response streaming |
| **● running · tool: X** | A tool is executing |
| **✖ error · tool: X** | Tool failed (`isError`) — shown briefly, then reverts to thinking |
| **⚠ no activity Ns** | Busy but no event arrived for `AGENT_STATUS_STUCK_MS` (default 60s). During a tool phase this likely means a hung execution — `Esc` to abort. During thinking/streaming it may just be a long silent reasoning window — abort only if it never progresses. |
| **✓ idle** | Agent settled; pi is waiting for input |
| **… · 2m10s · ~18K · $0.0100** | Busy statuses append wall-clock duration and, when enabled, live usage ticker (`~tokens · $cost`) computed from in-memory session entries. |

"Activity" = any agent/turn/message/tool event. A watchdog re-checks every 2s and flips to the stuck warning only while the agent is busy.

## Session status report

`/agent-session-status` prefers in-memory entries (`ctx.sessionManager.getEntries()`) for instant reports; falls back to parsing the most recent session file (`~/.pi/agent/sessions/--<cwd>--/*.jsonl`):

```
myproj session
Active:    opencode-zen/deepseek-v4-flash-free
Calls:     69 · turns 4 · ~5.2M tokens
Cache:     hit 0 · miss 5,052,965 · write 0 · 0.0%
Cost:      $0.0000 · compacted 0
Models:    opencode-zen/deepseek-v4-flash-free (68), other/model (1)
Tools:     42 ok · 1 err
```

- **Active** — the most-called `provider/model`; `— (no calls yet)` before the first call
- **Calls** — LLM calls · user turns · total tokens
- **Cache** — hit (`cacheRead`), miss (`input`), write (`cacheWrite`) tokens and hit ratio
- **Cost** — total spend (`usage.cost.total`) · compaction count
- **Models** — timeline when multiple models used (sorted by calls)
- **Tools** — ok/err counts when tool results present
- **Switches/Branches** — shown when `model_change` / `branch_summary` entries exist

| Argument | Effect |
|----------|--------|
| *(none)* | Show newest session with content (in-memory first, then disk) |
| `clear` | Hide the panel |
| `--json` | Output machine-readable JSON (same data, `JSON.stringify`) |
| `json` | Alias for `--json` |

Re-run the command to refresh; widget auto-refreshes on `agent_settled` while visible. Shortcut `Ctrl+Shift+A` (configurable via `AGENT_STATUS_SHORTCUT`) toggles the widget. With no UI (print/json mode) the report falls back to a notification. Default was `Ctrl+Shift+S` until v1.0.1 — changed to avoid conflict with `pi-web-access` (`curate` shortcut).

## Install

### Option A — single file (recommended)

```bash
curl -Lo ~/.pi/agent/extensions/agent-status.ts \
  https://raw.githubusercontent.com/Danu28/agent-status/main/agent-status.ts
/reload
```

### Dev install — local changes, no push

```bash
./dev-install.sh              # copy local agent-status.ts once, then /reload
./dev-install.sh --watch      # poll every 1s; re-copy automatically on save
./dev-install.sh <path>       # copy a specific file instead of agent-status.ts
```

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

> pi auto-discovers extensions from `~/.pi/agent/extensions/*.ts` (global) or `.pi/extensions/*.ts` (project-local). Hot-reload with `/reload`.

## Configuration

Environment variables (optional, read lazily — works with `/reload`):

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_STATUS_STUCK_MS` | `60000` | Ms of silence before stuck warning. `NaN`/`0` fallback to default; clamped to 1s floor. |
| `AGENT_STATUS_ENABLED` | `1` | `0` disables extension entirely. |
| `AGENT_STATUS_ELAPSED` | `1` | `0` hides running-session duration. |
| `AGENT_STATUS_TICKER` | `1` | `0` hides live `~tokens · $cost` ticker. |
| `AGENT_STATUS_SHORTCUT` | `ctrl+shift+a` | Shortcut to toggle widget. Was `ctrl+shift+s` — changed to avoid conflict with `pi-web-access` (`ctrl+shift+s` curate). |

```bash
AGENT_STATUS_STUCK_MS=120000 pi   # quieter watchdog
AGENT_STATUS_ENABLED=0 pi         # disable
AGENT_STATUS_ELAPSED=0 pi         # hide timer
AGENT_STATUS_TICKER=0 pi          # hide ticker
```

## How it works

Subscribes to pi lifecycle events (`agent_start`, `turn_start`, `message_start/update/end`, `tool_execution_start/update/end`, `tool_result`, `agent_end`, `agent_settled`) and renders via `ctx.ui.setStatus()`. Renders are cached (only on change), so the 2s watchdog is harmless.

- **"✓ idle"** only on `agent_settled` — `agent_end` alone keeps badge busy (may auto-retry/compact).
- **`tool_execution_end` + `isError`** handled — error shows `✖ error · tool: X` for 3s.
- **In-memory first** — `getEntries()/getHeader()` makes `/agent-session-status` instant; disk scan is bounded to 20 newest files as fallback.
- **Singleton interval** — `globalThis.__agentStatusInterval` is cleared on `/reload`, so no leak.
- **Lazy env** — `process.env` re-read on each render; tuning works with `/reload`, not just restart.
- **Shortcut** — `Ctrl+Shift+A` (or `AGENT_STATUS_SHORTCUT`) toggles the widget.

## Development

```bash
npm install
npm run typecheck
node --test
```

## License

MIT — see [LICENSE](LICENSE).
