/**
 * agent-status — footer agent status indicator.
 *
 * Shows the agent's live state in the footer via `ctx.ui.setStatus()`:
 *   ● running          — agent started, model working (thinking)
 *   ● streaming…       — assistant response streaming
 *   ● running · tool: X — a tool is executing
 *   ⚠ no activity Ns   — busy but NO event arrived for AGENT_STATUS_STUCK_MS
 *                        (default 60s). During a tool phase this likely means
 *                        a hung execution — Esc to abort. During
 *                        thinking/streaming it may just be a long silent
 *                        reasoning window — abort only if it never progresses.
 *   ✓ idle             — agent settled; pi is waiting for input
 *
 * Busy statuses also show the wall-clock duration of the current run
 * (e.g. "● running · 2m10s", "● running · tool: X · 45s") so you can see at a
 * glance how long the agent has been working — handy alongside the stuck
 * watchdog when deciding whether to keep waiting or abort.
 *
 * "Activity" = any agent/turn/message/tool event. The watchdog re-checks every
 * 2s and flips to the stuck warning only while the agent is busy.
 *
 * "✓ idle" is set only on agent_settled (pi will not continue on its own);
 * agent_end alone leaves the badge busy, because pi may auto-retry, compact,
 * or process follow-up messages after it.
 *
 * Note: //reload re-runs this factory; each reload spawns an additional
 * watchdog tick (harmless — renders are cached) but unbounded. A teardown
 * hook is not exposed by the extension API.
 *
 * Also registers the /agent-session-status command: parses the last session
 * file (JSONL) for this project and shows a compact boxed summary as a widget
 * above the editor — active model, calls, truncations, turns, total tokens,
 * cache hit/miss/write + ratio, session cost + compactions, and the previous
 * run's calls/cost. Run it again to refresh; pass `clear` to hide the panel,
 * `prev` to show the previous session.
 *
 * Tuning: AGENT_STATUS_STUCK_MS (default 60000). Disable: AGENT_STATUS_ENABLED=0.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseSessionEntries, type ExtensionAPI, type FileEntry, type SessionHeader } from "@earendil-works/pi-coding-agent";

// Clamp bad env values: NaN/0/negative fall back to the default; the watchdog
// can never be silently disabled by a malformed AGENT_STATUS_STUCK_MS.
const STUCK_MS = Math.max(1_000, Number(process.env.AGENT_STATUS_STUCK_MS) || 60_000);
const CHECK_INTERVAL_MS = 2_000;
const ENABLED = (process.env.AGENT_STATUS_ENABLED ?? "1") !== "0";
const SHOW_ELAPSED = (process.env.AGENT_STATUS_ELAPSED ?? "1") !== "0";
const KEY = "agent-status";

// ── /agent-session-status ──────────────────────────────────────────────────
// Parses the last session JSONL for this project and aggregates the data
// actually shown in the report: LLM calls + usage/cost, truncations, turns,
// compaction count.
const SESSION_WIDGET_KEY = "agent-session-status";

interface UsageAgg {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  total: number;
  cost: number;
}
interface ModelAgg extends UsageAgg {
  calls: number;
  key: string;
}
const emptyUsage = (): UsageAgg => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  total: 0,
  cost: 0,
});

const fmt = (n: number) => n.toLocaleString("en-US");

/** Compact elapsed formatter: 45s, 2m10s, 1h03m20s. */
const fmtDur = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h${m.toString().padStart(2, "0")}m${s.toString().padStart(2, "0")}s`;
  if (m > 0) return `${m}m${s.toString().padStart(2, "0")}s`;
  return `${s}s`;
};

/** Session-info access we need from the command context. */
interface SessionInfoLike {
  getSessionFile?(): string | undefined;
  getSessionDir?(): string;
}

/**
 * Newest-first session files for this project: the live session first, then
 * the cwd session dir by mtime (deduped).
 */
function findSessionFiles(sm: SessionInfoLike): string[] {
  const candidates: string[] = [];
  const cur = sm.getSessionFile?.();
  if (typeof cur === "string" && cur) candidates.push(cur);
  const dir = sm.getSessionDir?.();
  if (dir) {
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      /* no session dir yet */
    }
    names.sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs);
    for (const n of names) candidates.push(join(dir, n));
  }
  const seen = new Set<string>();
  const files: string[] = [];
  for (const f of candidates) {
    if (!seen.has(f)) {
      seen.add(f);
      files.push(f);
    }
  }
  return files;
}

/** One-line footer for the previous session: `[prior run] done · N calls · $X`. */
function priorRunLine(file: string): string | undefined {
  try {
    const entries = parseSessionEntries(readFileSync(file, "utf8"));
    let calls = 0;
    let cost = 0;
    for (const e of entries) {
      if (e.type !== "message") continue;
      const m: any = (e as any).message;
      if (m?.role !== "assistant") continue;
      calls++;
      cost += m?.usage?.cost?.total ?? 0;
    }
    if (calls === 0) return undefined;
    return `[prior run] done · ${calls} call${calls === 1 ? "" : "s"} · $${cost.toFixed(4)}`;
  } catch {
    return undefined;
  }
}

/** Aggregate the session-file dataset and render it as a boxed summary. */
function renderReport(entries: FileEntry[], priorLine?: string): string {
  const header = entries[0] as SessionHeader | undefined;
  const body = entries.slice(1);

  const usage: UsageAgg = emptyUsage();
  const models = new Map<string, ModelAgg>();
  const stopReasons = new Map<string, number>();
  const compactions: number[] = [];
  let user = 0;
  let assistants = 0;

  for (const e of body) {
    if (e.type === "message") {
      const m: any = (e as any).message;
      const role = m?.role;
      if (role === "user") {
        user++;
      } else if (role === "assistant") {
        assistants++;
        const key = `${m?.provider ?? "?"}/${m?.model ?? "?"}`;
        let agg = models.get(key);
        if (!agg) {
          agg = { ...emptyUsage(), calls: 0, key };
          models.set(key, agg);
        }
        agg.calls++;
        const u: any = m?.usage;
        if (u) {
          agg.input += u.input ?? 0;
          agg.output += u.output ?? 0;
          agg.cacheRead += u.cacheRead ?? 0;
          agg.cacheWrite += u.cacheWrite ?? 0;
          agg.reasoning += u.reasoning ?? 0;
          agg.total += u.total ?? 0;
          agg.cost += u.cost?.total ?? 0;
        }
        const sr = m?.stopReason;
        if (sr) stopReasons.set(sr, (stopReasons.get(sr) ?? 0) + 1);
      }
    } else if (e.type === "compaction") {
      compactions.push((e as any).tokensBefore ?? 0);
    }
  }

  // Global usage = sum over per-model aggregates (single accumulation point).
  for (const a of models.values()) {
    usage.input += a.input;
    usage.output += a.output;
    usage.cacheRead += a.cacheRead;
    usage.cacheWrite += a.cacheWrite;
    usage.reasoning += a.reasoning;
    usage.total += a.total;
    usage.cost += a.cost;
  }

  // ── Boxed summary output ────────────────────────────────────────────────
  // pi renders extension widgets with a hard 10-line cap (MAX_WIDGET_LINES)
  // and appends "... (widget truncated)" beyond it — the report is 8 lines,
  // well under the cap, so every field is visible.
  const W = 46; // inner box width (matches the reference template)
  const project = (header?.cwd?.split(/[\\/]/).filter(Boolean).pop() ?? "?") as string;
  // Keep the title inside the box even for very long directory names.
  const title = `${project} Status`.slice(0, Math.max(1, W - 2));
  const bar = "═".repeat(W);
  const left = Math.max(0, Math.floor((W - title.length) / 2));
  const right = Math.max(0, W - title.length - left);
  const L: string[] = [
    `╔${bar}╗`,
    `║${' '.repeat(left)}${title}${' '.repeat(right)}║`,
    `╚${bar}╝`,
  ];
  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));
  const row = (label: string, value: string) => `   ${pad(label, 18)}${value}`; // value col 21

  const noCalls = assistants === 0;
  const primary = [...models.values()].sort((a, b) => b.calls - a.calls)[0];
  const truncations = (stopReasons.get("truncated") ?? 0) + (stopReasons.get("max_tokens") ?? 0);
  const hitRatio = usage.cacheRead + usage.input > 0 ? (usage.cacheRead / (usage.cacheRead + usage.input)) * 100 : null;
  // Session usage records don't always carry a `total` — sum the parts.
  const totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite + usage.reasoning;
  const totalFmt = totalTokens >= 1_000_000 ? `${(totalTokens / 1_000_000).toFixed(1)}M` : `${(totalTokens / 1000).toFixed(1)}K`;

  L.push(row("Active:", noCalls ? "— (no calls yet)" : primary.key));
  L.push(row("Calls:", `${assistants} · truncations ${truncations} · turns ${user} · 📦 ~${totalFmt} tokens`));
  L.push(row("📊 Cache:", `hit ${fmt(usage.cacheRead)} · miss ${fmt(usage.input)} · write ${fmt(usage.cacheWrite)} · ${hitRatio === null ? "--" : `${hitRatio.toFixed(1)}%`}`));
  L.push(row("💰 Cost:", `$${usage.cost.toFixed(4)} · compacted ${compactions.length}`));
  L.push(priorLine ?? "[prior run] (none yet)");
  return L.join("\n");
}

export default function (pi: ExtensionAPI) {
  if (!ENABLED) return;

  let ui: any;
  let phase: "thinking" | "streaming" | "tool" | "idle" = "idle";
  let toolName = "";
  let lastActivity = Date.now();
  let runStart = 0;
  let lastRendered = "";

  /** Mark activity; keeps the stuck watchdog from firing. */
  const touch = (p: typeof phase, tool?: string) => {
    phase = p;
    if (tool !== undefined) toolName = tool;
    lastActivity = Date.now();
  };

  const render = () => {
    if (!ui) return;
    const fg = (c: string, t: string) => ui.theme?.fg?.(c, t) ?? t;
    let s: string;
    if (phase === "idle") {
      s = fg("success", "✓") + " idle";
    } else {
      const idleMs = Date.now() - lastActivity;
      if (idleMs > STUCK_MS) {
        const stuck =
          phase === "tool"
            ? `⚠ stuck ${Math.round(idleMs / 1000)}s — Esc to abort`
            : `⚠ no activity ${Math.round(idleMs / 1000)}s (may be thinking) — Esc to abort if it never progresses`;
        s = fg("warning", stuck);
      } else if (phase === "tool") {
        s = fg("accent", "●") + ` running · tool: ${toolName}`;
      } else if (phase === "streaming") {
        s = fg("accent", "●") + " streaming…";
      } else {
        s = fg("accent", "●") + " running";
      }
      if (SHOW_ELAPSED && runStart) s += ` · ${fmtDur(Date.now() - runStart)}`;
    }
    if (s !== lastRendered) {
      lastRendered = s;
      ui.setStatus(KEY, s);
    }
  };

  pi.on("agent_start", async (_e, ctx) => {
    ui = ctx.ui;
    runStart = Date.now();
    touch("thinking");
    render();
  });
  pi.on("turn_start", async (_e, ctx) => {
    ui = ctx.ui;
    touch("thinking");
    render();
  });
  pi.on("message_start", async (e, ctx) => {
    ui = ctx.ui;
    // Only assistant messages stream; user/toolResult messages fire
    // message_start too and would flash "streaming…" before reverting.
    if ((e as any)?.message?.role !== "assistant") return;
    touch("streaming");
    render();
  });
  // Fires per streaming delta — just refresh the activity timestamp, render
  // happens on the next non-delta event / watchdog tick.
  pi.on("message_update", async (_e, ctx) => {
    ui = ctx.ui;
    touch("streaming");
  });
  pi.on("message_end", async (_e, ctx) => {
    ui = ctx.ui;
    touch("thinking");
    render();
  });
  pi.on("tool_execution_start", async (e, ctx) => {
    ui = ctx.ui;
    touch("tool", e?.toolName ?? "?");
    render();
  });
  pi.on("tool_result", async (_e, ctx) => {
    ui = ctx.ui;
    touch("thinking");
    render();
  });
  pi.on("turn_end", async (_e, ctx) => {
    ui = ctx.ui;
    touch("thinking");
  });
  pi.on("agent_end", async (_e, ctx) => {
    ui = ctx.ui;
    // The run ended, but pi may still auto-retry, compact+retry, or process
    // queued follow-ups — keep the badge busy until agent_settled. If
    // agent_settled were ever skipped on a path, the footer would stay
    // "running" (conservative, watchdog-covered) instead of lying "idle".
    touch("thinking");
    render();
  });
  pi.on("agent_settled", async (_e, ctx) => {
    ui = ctx.ui;
    touch("idle");
    render();
  });

  // ── /agent-session-status ────────────────────────────────────────────────
  // Show an aggregated report of the last session as a widget above the editor.
  // `clear` hides the panel; `prev` shows the previous session instead of the
  // most recent one.
  pi.registerCommand("agent-session-status", {
    description:
      "Show a boxed summary of the last agent session (active model, calls, cache, cost, compactions, prior-run calls/cost). Args: `clear` hides the panel, `prev` shows the previous session.",
    handler: async (args, ctx) => {
      const a = args.trim();
      if (a === "clear") {
        ctx.ui.setWidget(SESSION_WIDGET_KEY, undefined);
        return;
      }
      const files = findSessionFiles(ctx.sessionManager);
      // Prefer the newest session files that actually contain messages
      // (up to 3: current, previous, and the one before — the last two feed
      // the prior-run footer).
      const withContent: string[] = [];
      for (const f of files) {
        try {
          const entries = parseSessionEntries(readFileSync(f, "utf8"));
          if (entries.some((e) => e.type === "message")) withContent.push(f);
          if (withContent.length >= 3) break;
        } catch {
          /* skip unreadable files */
        }
      }
      const idx = a === "prev" ? 1 : 0;
      const target = withContent[idx];
      if (!target) {
        ctx.ui.notify("agent-session-status: no session file with messages found for this project", "warning");
        return;
      }
      const prior = withContent[idx + 1] ? priorRunLine(withContent[idx + 1]) : undefined;
      const report = renderReport(parseSessionEntries(readFileSync(target, "utf8")), prior);
      if (ctx.hasUI) ctx.ui.setWidget(SESSION_WIDGET_KEY, report.split("\n"));
      else ctx.ui.notify(report, "info");
    },
  });

  // Stuck watchdog: re-render every few seconds so the warning appears when
  // activity stops while the agent is supposedly running.
  setInterval(render, CHECK_INTERVAL_MS);
}
