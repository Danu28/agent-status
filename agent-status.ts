/**
 * agent-status — footer agent status indicator + /agent-session-status summary.
 *
 * Footer statuses (via ctx.ui.setStatus):
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
 * Busy statuses also append the wall-clock duration of the current run
 * (e.g. "● running · 2m10s") so you can see at a glance how long the agent has
 * been working — handy alongside the stuck watchdog.
 *
 * "Activity" = any agent/turn/message/tool event. The watchdog re-checks every
 * 2s and flips to the stuck warning only while the agent is busy.
 *
 * "✓ idle" is set only on agent_settled (pi will not continue on its own);
 * agent_end alone leaves the badge busy, because pi may auto-retry, compact,
 * or process follow-up messages after it.
 *
 * Also registers the /agent-session-status command: parses the last session
 * file (JSONL) for this project and shows a compact summary as a widget above
 * the editor — active model, calls, turns, total tokens, cache hit/miss/write
 * + ratio, session cost + compactions. Run it again to refresh; `clear` hides
 * the panel.
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
const SESSION_WIDGET_KEY = "agent-session-status";

// ── pure helpers ──────────────────────────────────────────────────────────

/** Compact elapsed formatter: 45s, 2m10s, 1h03m20s. */
export const fmtDur = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h${m.toString().padStart(2, "0")}m${s.toString().padStart(2, "0")}s`;
  if (m > 0) return `${m}m${s.toString().padStart(2, "0")}s`;
  return `${s}s`;
};

export type Phase = "thinking" | "streaming" | "tool" | "idle";
export interface StatusInput {
  phase: Phase;
  toolName: string;
  idleMs: number;
  stuckMs: number;
  runStart: number;
  now: number;
  showElapsed: boolean;
}

/** Plain-text footer status for a given state (no theme color applied). */
export const formatStatus = (s: StatusInput): string => {
  if (s.phase === "idle") return "✓ idle";
  let body: string;
  if (s.idleMs > s.stuckMs) {
    body =
      s.phase === "tool"
        ? `⚠ stuck ${Math.round(s.idleMs / 1000)}s — Esc to abort`
        : `⚠ no activity ${Math.round(s.idleMs / 1000)}s (may be thinking) — Esc to abort if it never progresses`;
  } else if (s.phase === "tool") {
    body = `● running · tool: ${s.toolName}`;
  } else if (s.phase === "streaming") {
    body = "● streaming…";
  } else {
    body = "● running";
  }
  if (s.showElapsed && s.runStart) body += ` · ${fmtDur(s.now - s.runStart)}`;
  return body;
};

interface SessionInfoLike {
  getSessionFile?(): string | undefined;
  getSessionDir?(): string;
}

/** Newest session file (this project, with ≥1 message), or undefined. */
export const pickSessionFile = (sm: SessionInfoLike): string | undefined => {
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
  for (const f of candidates) {
    try {
      if (parseSessionEntries(readFileSync(f, "utf8")).some((e) => e.type === "message")) return f;
    } catch {
      /* skip unreadable files */
    }
  }
  return undefined;
};

interface UsageAgg {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  total: number;
  cost: number;
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

/** Aggregate the session dataset and render a plain multi-line summary. */
export const renderReport = (entries: FileEntry[]): string => {
  const header = entries[0] as SessionHeader | undefined;
  const body = entries.slice(1);

  const usage: UsageAgg = emptyUsage();
  const models = new Map<string, UsageAgg & { calls: number; key: string }>();
  let user = 0;
  let assistants = 0;
  let compactions = 0;

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
      }
    } else if (e.type === "compaction") {
      compactions++;
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

  const project = (header?.cwd?.split(/[\\/]/).filter(Boolean).pop() ?? "?") as string;
  const noCalls = assistants === 0;
  const primary = [...models.values()].sort((a, b) => b.calls - a.calls)[0];
  const hitRatio = usage.cacheRead + usage.input > 0 ? (usage.cacheRead / (usage.cacheRead + usage.input)) * 100 : null;
  // Session usage records don't always carry a `total` — sum the parts.
  const totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite + usage.reasoning;
  const totalFmt = totalTokens >= 1_000_000 ? `${(totalTokens / 1_000_000).toFixed(1)}M` : `${(totalTokens / 1000).toFixed(1)}K`;

  const L: string[] = [];
  L.push(`${project} session`);
  L.push(`Active:    ${noCalls ? "— (no calls yet)" : primary.key}`);
  L.push(`Calls:     ${assistants} · turns ${user} · ~${totalFmt} tokens`);
  L.push(`Cache:     hit ${fmt(usage.cacheRead)} · miss ${fmt(usage.input)} · write ${fmt(usage.cacheWrite)} · ${hitRatio === null ? "--" : `${hitRatio.toFixed(1)}%`}`);
  L.push(`Cost:      $${usage.cost.toFixed(4)} · compacted ${compactions}`);
  return L.join("\n");
};

export default function (pi: ExtensionAPI) {
  if (!ENABLED) return;

  let ui: any;
  let phase: Phase = "idle";
  let toolName = "";
  let lastActivity = Date.now();
  let runStart = 0;
  let lastRendered = "";

  /** Mark activity; keeps the stuck watchdog from firing. */
  const touch = (p: Phase, tool?: string) => {
    phase = p;
    if (tool !== undefined) toolName = tool;
    lastActivity = Date.now();
  };

  const render = () => {
    if (!ui) return;
    const fg = (c: string, t: string) => ui.theme?.fg?.(c, t) ?? t;
    const s = formatStatus({
      phase,
      toolName,
      idleMs: Date.now() - lastActivity,
      stuckMs: STUCK_MS,
      runStart,
      now: Date.now(),
      showElapsed: SHOW_ELAPSED,
    });
    const colored = s.startsWith("✓") ? fg("success", s) : s.startsWith("⚠") ? fg("warning", s) : fg("accent", s);
    if (colored !== lastRendered) {
      lastRendered = colored;
      ui.setStatus(KEY, colored);
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
  // Show a compact summary of the last session as a widget above the editor.
  // `clear` hides the panel.
  pi.registerCommand("agent-session-status", {
    description:
      "Show a compact summary of the last agent session (active model, calls, cache, cost, compactions). Arg: `clear` hides the panel.",
    handler: async (args, ctx) => {
      const a = args.trim();
      if (a === "clear") {
        ctx.ui.setWidget(SESSION_WIDGET_KEY, undefined);
        return;
      }
      const file = pickSessionFile(ctx.sessionManager);
      if (!file) {
        ctx.ui.notify("agent-session-status: no session file with messages found for this project", "warning");
        return;
      }
      const report = renderReport(parseSessionEntries(readFileSync(file, "utf8")));
      if (ctx.hasUI) ctx.ui.setWidget(SESSION_WIDGET_KEY, report.split("\n"));
      else ctx.ui.notify(report, "info");
    },
  });

  // Stuck watchdog: re-render every few seconds so the warning appears when
  // activity stops while the agent is supposedly running.
  setInterval(render, CHECK_INTERVAL_MS);
}
