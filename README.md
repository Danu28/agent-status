# agent-status

A [pi](https://github.com/earendil-works/pi) extension that shows the agent's live state in the footer, plus a `/agent-session-status` command that renders a compact boxed summary of the last session file.

Single-file, zero dependencies, no configuration required — drop it in and `/reload`.

## Statuses

| Indicator | Meaning |
|-----------|---------|
| **● running** | Agent started, model working (thinking) |
| **● streaming…** | Assistant response streaming |
| **● running · tool: X** | A tool is executing |
| **⚠ no activity Ns** | Busy but no event arrived for `AGENT_STATUS_STUCK_MS` (default 60s). During a tool phase this likely means a hung execution — `Esc` to abort. During thinking/streaming it may just be a long silent reasoning window — abort only if it never progresses. |
| **✓ idle** | Agent settled; pi is waiting for input |
| **… · 2m10s** | Busy statuses also append the wall-clock duration of the current run, so you can see at a glance how long the agent has been working. |

"Activity" = any agent/turn/message/tool event. A watchdog re-checks every 2s and flips to the stuck warning only while the agent is busy.

## Session status report

`/agent-session-status` parses the most recent session file (`~/.pi/agent/sessions/--<cwd>--/*.jsonl`) for the current project and shows a boxed summary as a widget above the editor:

```
╔══════════════════════════════════════════════╗
║            agent-status Status               ║
╚══════════════════════════════════════════════╝

   Active:        ✅ Yes (opencode-zen/deepseek-v4-flash-free)
   Prefix hash:   --
   Prefix stable: ⏳ --
   Calls:         26 since last reset
   Truncations:   0

   📊 Cache
     Hit tokens:  0
     Miss tokens: 1,405,468
     Write tokens: 0
     Hit ratio:    0.0%

   🔧 Repairs
     Args repaired:      0
     Calls scavenged:    0
     Storms suppressed:  0

   💰 Cost Control
     Results compacted: 0
     Cap (tokens):      --
     Scavenge:          off

   🔄 Turns:  2
   📦 Tokens: ~1.5M total

[prior run] done · 28 calls · $0.0031
```

- **Active** — the most-called `provider/model`; `— (no calls yet)` before the first call
- **Calls / Turns / Tokens** — LLM calls, user turns, and total tokens in this session
- **Cache** — hit (`cacheRead`), miss (`input`), write (`cacheWrite`) tokens and hit ratio (`-- (no calls yet)` when there are no calls)
- **Truncations** — assistant messages stopped with `truncated` / `max_tokens`
- **Repairs** — reserved rows; not tracked by this extension (always `0`)
- **Cap / Scavenge** — not tracked by this extension (`--` / `off`)
- **Results compacted** — compaction count from the session file
- **[prior run]** — the previous session's calls and cost (`(none yet)` if there is no prior session)

| Argument | Effect |
|----------|--------|
| *(none)* | Show the newest session with content (normally the current one) |
| `prev` | Show the previous session instead |
| `clear` | Hide the panel |

Re-run the command to refresh the panel. Requires a persisted session (not `--no-session`); with no UI (print/json mode) the report falls back to a notification.

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

### Dev install — local changes, no push

`install.sh` only ever pulls from GitHub, so it's blind to uncommitted local edits. For active development use **`./dev-install.sh`**, which copies straight from your working tree:

```bash
./dev-install.sh              # copy local agent-status.ts once, then /reload
./dev-install.sh --watch      # poll every 1s; re-copy automatically on save
./dev-install.sh <path>       # copy a specific file instead of agent-status.ts
```

`--watch` compares a checksum each tick and only re-copies on an actual change, so saving the file immediately propagates it into `~/.pi/agent/extensions/agent-status.ts` (run `/reload` once to pick up the new module). Ctrl-C stops it.

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
| `AGENT_STATUS_ELAPSED` | `1` | Set to `0` to hide the running-session duration appended to busy statuses. |

```bash
AGENT_STATUS_STUCK_MS=120000 pi          # quieter watchdog (120s)
AGENT_STATUS_ENABLED=0 pi                # disable
AGENT_STATUS_ELAPSED=0 pi                # hide the running-session timer
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