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
 *   ✖ error · tool: X  — tool failed (shown briefly after isError)
 *
 * Busy statuses append wall-clock duration (e.g. "● running · 2m10s") and,
 * when enabled, live usage ticker (e.g. "· ~18K · $0.01").
 *
 * "Activity" = any agent/turn/message/tool event. The watchdog re-checks every
 * 2s and flips to the stuck warning only while the agent is busy.
 *
 * "✓ idle" is set only on agent_settled; agent_end alone leaves badge busy,
 * because pi may auto-retry, compact, or process follow-up messages after it.
 *
 * Also registers the /agent-session-status command: prefers in-memory
 * session entries (ctx.sessionManager.getEntries()) for instant reports; falls
 * back to parsing the most recent session file (JSONL) for this project.
 * Shows compact summary as widget above editor — active model, calls, turns,
 * total tokens, cache hit/miss/write + ratio, cost + compactions (+ tool
 * stats / model timeline when present). Supports `clear` and `--json`.
 *
 * Tuning: AGENT_STATUS_STUCK_MS (default 60000), AGENT_STATUS_ELAPSED (1/0),
 * AGENT_STATUS_TICKER (1/0), AGENT_STATUS_ENABLED (1/0), AGENT_STATUS_SHORTCUT (default ctrl+shift+a).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseSessionEntries, type ExtensionAPI, type FileEntry, type SessionHeader } from "@earendil-works/pi-coding-agent";

// ── env helpers (lazy, clamped) ───────────────────────────────────────────
const getStuckMs = () => Math.max(1_000, Number(process.env.AGENT_STATUS_STUCK_MS) || 60_000);
const getShowElapsed = () => (process.env.AGENT_STATUS_ELAPSED ?? "1") !== "0";
const getShowTicker = () => (process.env.AGENT_STATUS_TICKER ?? "1") !== "0";
const isEnabled = () => (process.env.AGENT_STATUS_ENABLED ?? "1") !== "0";
const getShortcut = (): any => (process.env.AGENT_STATUS_SHORTCUT || "ctrl+shift+a").trim() || "ctrl+shift+a";

const CHECK_INTERVAL_MS = 2_000;
const KEY = "agent-status";
const SESSION_WIDGET_KEY = "agent-session-status";
const PICK_LIMIT = 20;

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

export type Phase = "thinking" | "streaming" | "tool" | "idle" | "error";
export interface StatusInput {
  phase: Phase;
  toolName: string;
  idleMs: number;
  stuckMs: number;
  runStart: number;
  now: number;
  showElapsed: boolean;
  ticker?: string;
}

/** Plain-text footer status for a given state (no theme color applied). */
export const formatStatus = (s: StatusInput): string => {
  if (s.phase === "idle") {
    if (s.ticker) return `✓ idle · ${s.ticker}`;
    return "✓ idle";
  }
  if (s.phase === "error") {
    let body = `✖ error · tool: ${s.toolName}`;
    if (s.showElapsed && s.runStart) body += ` · ${fmtDur(s.now - s.runStart)}`;
    if (s.ticker) body += ` · ${s.ticker}`;
    return body;
  }
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
  if (s.ticker) body += ` · ${s.ticker}`;
  return body;
};

interface SessionInfoLike {
  getSessionFile?(): string | undefined;
  getSessionDir?(): string;
  getEntries?(): FileEntry[];
  getHeader?(): SessionHeader | null;
}

/** Newest session file (this project, with ≥1 message), or undefined. Bounded to PICK_LIMIT. */
export const pickSessionFile = (sm: SessionInfoLike): string | undefined => {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const cur = sm.getSessionFile?.();
  if (typeof cur === "string" && cur) {
    candidates.push(cur);
    seen.add(cur);
  }
  const dir = sm.getSessionDir?.();
  if (dir) {
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      /* no session dir yet */
    }
    names.sort((a, b) => {
      try {
        return statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs;
      } catch {
        return 0;
      }
    });
    const limited = names.slice(0, PICK_LIMIT);
    for (const n of limited) {
      const p = join(dir, n);
      if (!seen.has(p)) {
        candidates.push(p);
        seen.add(p);
      }
    }
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
  total: number;
  cost: number;
}
const emptyUsage = (): UsageAgg => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
  cost: 0,
});
const fmt = (n: number) => n.toLocaleString("en-US");

interface ReportData {
  project: string;
  active: string | null;
  calls: number;
  turns: number;
  totalTokens: number;
  totalFmt: string;
  cacheRead: number;
  cacheWrite: number;
  cacheInput: number;
  hitRatio: number | null;
  cost: number;
  compactions: number;
  branchSummaries: number;
  modelChanges: number;
  models: { key: string; calls: number; input: number; output: number; cacheRead: number; cacheWrite: number; total: number; cost: number }[];
  toolOk: number;
  toolErr: number;
}

export const aggregateEntries = (entries: FileEntry[]): ReportData => {
  // ponytail: O(n) scan, single pass. Good enough for <10k entries; if sessions grow huge, cache by entries.length.
  const header = entries.find((e) => (e as any).type === "session" || (e as any).type === "header") as SessionHeader | undefined;
  const body = entries.filter((e) => (e as any).type !== "session" && (e as any).type !== "header");

  const usage: UsageAgg = emptyUsage();
  const models = new Map<string, UsageAgg & { calls: number; key: string }>();
  let user = 0;
  let assistants = 0;
  let compactions = 0;
  let branchSummaries = 0;
  let modelChanges = 0;
  let toolOk = 0;
  let toolErr = 0;

  for (const e of body) {
    const t = (e as any).type;
    if (t === "message") {
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
          agg.input += Number(u.input ?? 0);
          agg.output += Number(u.output ?? 0);
          agg.cacheRead += Number(u.cacheRead ?? 0);
          agg.cacheWrite += Number(u.cacheWrite ?? 0);
          agg.total += Number(u.totalTokens ?? 0);
          agg.cost += Number(u.cost?.total ?? 0);
        }
        // tool stats embedded in assistant message (toolCalls)
        if (Array.isArray(m?.toolCalls)) {
          for (const tc of m.toolCalls) {
            // count as pending; result counted via tool message
            void tc;
          }
        }
      } else if (role === "tool") {
        // tool result stored as tool-role message
        const isErr = (m as any)?.isError ?? (m as any)?.error ?? false;
        if (isErr) toolErr++;
        else toolOk++;
      }
    } else if (t === "compaction") {
      compactions++;
      const u: any = (e as any).usage;
      if (u) toolOk += 0; // no-op, keep structure
    } else if (t === "branch_summary") {
      branchSummaries++;
    } else if (t === "model_change") {
      modelChanges++;
    } else if (t === "tool_result" || t === "tool_call") {
      // some pi versions store tool events as custom entries
      const isErr = (e as any).isError ?? false;
      if (isErr) toolErr++;
      else toolOk++;
    }
  }

  for (const a of models.values()) {
    usage.input += a.input;
    usage.output += a.output;
    usage.cacheRead += a.cacheRead;
    usage.cacheWrite += a.cacheWrite;
    usage.total += a.total;
    usage.cost += a.cost;
  }

  const project = (header?.cwd?.split(/[\\/]/).filter(Boolean).pop() ?? "?") as string;
  const primary = [...models.values()].sort((a, b) => b.calls - a.calls)[0];
  const hitRatio = usage.cacheRead + usage.input > 0 ? (usage.cacheRead / (usage.cacheRead + usage.input)) * 100 : null;
  const totalTokens = usage.total > 0 ? usage.total : usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  const totalFmt = totalTokens >= 1_000_000 ? `${(totalTokens / 1_000_000).toFixed(1)}M` : `${(totalTokens / 1000).toFixed(1)}K`;

  return {
    project,
    active: assistants === 0 ? null : primary?.key ?? null,
    calls: assistants,
    turns: user,
    totalTokens,
    totalFmt,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    cacheInput: usage.input,
    hitRatio,
    cost: Number(usage.cost ?? 0),
    compactions,
    branchSummaries,
    modelChanges,
    models: [...models.values()].map((m) => ({ key: m.key, calls: m.calls, input: m.input, output: m.output, cacheRead: m.cacheRead, cacheWrite: m.cacheWrite, total: m.total, cost: Number(m.cost ?? 0) })),
    toolOk,
    toolErr,
  };
};

/** Aggregate the session dataset and render a plain multi-line summary. */
export const renderReport = (entries: FileEntry[]): string => {
  const d = aggregateEntries(entries);
  const noCalls = d.calls === 0;
  const L: string[] = [];
  L.push(`${d.project} session`);
  L.push(`Active:    ${noCalls ? "— (no calls yet)" : d.active}`);
  L.push(`Calls:     ${d.calls} · turns ${d.turns} · ~${d.totalFmt} tokens`);
  L.push(`Cache:     hit ${fmt(d.cacheRead)} · miss ${fmt(d.cacheInput)} · write ${fmt(d.cacheWrite)} · ${d.hitRatio === null ? "--" : `${d.hitRatio.toFixed(1)}%`}`);
  const costStr = Number.isFinite(d.cost) ? d.cost.toFixed(4) : "0.0000";
  L.push(`Cost:      $${costStr} · compacted ${d.compactions}`);
  if (d.models.length > 1) {
    const timeline = d.models
      .sort((a, b) => b.calls - a.calls)
      .map((m) => `${m.key} (${m.calls})`)
      .join(", ");
    L.push(`Models:    ${timeline}`);
  }
  if (d.modelChanges > 0) L.push(`Switches:  ${d.modelChanges} model change(s)`);
  if (d.branchSummaries > 0) L.push(`Branches:  ${d.branchSummaries} branch summar${d.branchSummaries === 1 ? "y" : "ies"}`);
  if (d.toolOk + d.toolErr > 0) L.push(`Tools:     ${d.toolOk} ok · ${d.toolErr} err`);
  return L.join("\n");
};

export const buildReportJson = (entries: FileEntry[]): Record<string, unknown> => {
  const d = aggregateEntries(entries);
  return {
    project: d.project,
    activeModel: d.active,
    calls: d.calls,
    turns: d.turns,
    totalTokens: d.totalTokens,
    totalFmt: d.totalFmt,
    cache: { hit: d.cacheRead, miss: d.cacheInput, write: d.cacheWrite, hitRatio: d.hitRatio },
    cost: d.cost,
    compactions: d.compactions,
    branchSummaries: d.branchSummaries,
    modelChanges: d.modelChanges,
    tools: { ok: d.toolOk, err: d.toolErr },
    models: d.models,
  };
};

const getLiveEntries = (sm: SessionInfoLike | undefined): FileEntry[] | null => {
  try {
    const anySm = sm as any;
    if (anySm?.getEntries && anySm?.getHeader) {
      const h = anySm.getHeader();
      const ents: FileEntry[] = anySm.getEntries();
      if (!ents || ents.length === 0) return null;
      const out: FileEntry[] = [];
      if (h) out.push(h);
      out.push(...ents);
      // require at least one message to be considered valid
      if (out.some((e) => (e as any).type === "message")) return out;
    }
  } catch {
    /* ignore */
  }
  return null;
};

export default function (pi: ExtensionAPI) {
  if (!isEnabled()) return;

  let ui: any;
  let lastSM: SessionInfoLike | undefined;
  let phase: Phase = "idle";
  let toolName = "";
  let lastActivity = Date.now();
  let runStart = 0;
  let lastRendered = "";
  let widgetVisible = false;
  let errorTimer: ReturnType<typeof setTimeout> | undefined;
  let runBaseline: ReportData | null = null;
  let lastRun: { calls: number; totalTokens: number; totalFmt: string; cost: number; costStr: string; durMs: number } | null = null;

  const touch = (p: Phase, tool?: string) => {
    phase = p;
    if (tool !== undefined) toolName = tool;
    lastActivity = Date.now();
  };

  const fmtTokensLocal = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${(n / 1000).toFixed(1)}K`);
  const snapshotBaseline = (sm: SessionInfoLike | undefined): ReportData | null => {
    const live = getLiveEntries(sm);
    if (!live) return null;
    try {
      return aggregateEntries(live);
    } catch {
      return null;
    }
  };
  const getRunningTicker = (): string | undefined => {
    if (!getShowTicker() || phase === "idle" || !lastSM) return undefined;
    try {
      const live = getLiveEntries(lastSM);
      if (!live) return undefined;
      const cur = aggregateEntries(live);
      if (!runBaseline) {
        if (cur.calls === 0) return undefined;
        return `${cur.calls} calls · ~${cur.totalFmt} · $${cur.cost.toFixed(4)}`;
      }
      const calls = cur.calls - runBaseline.calls;
      const tokens = Math.max(0, cur.totalTokens - runBaseline.totalTokens);
      const cost = Math.max(0, cur.cost - runBaseline.cost);
      if (calls <= 0 && tokens <= 0 && cost <= 0) return `0 calls · ~0.0K · $0.0000`;
      return `${Math.max(0, calls)} calls · ~${fmtTokensLocal(tokens)} · $${cost.toFixed(4)}`;
    } catch {
      return undefined;
    }
  };
  const getIdleTicker = (): string | undefined => {
    if (!getShowTicker() || phase !== "idle" || !lastRun) return undefined;
    const base = `${lastRun.calls} calls · ~${lastRun.totalFmt} · $${lastRun.costStr}`;
    return getShowElapsed() && lastRun.durMs ? `${base} · ${fmtDur(lastRun.durMs)}` : base;
  };

  const render = () => {
    if (!ui) return;
    const fg = (c: string, t: string) => ui.theme?.fg?.(c, t) ?? t;
    const s = formatStatus({
      phase,
      toolName,
      idleMs: Date.now() - lastActivity,
      stuckMs: getStuckMs(),
      runStart,
      now: Date.now(),
      showElapsed: getShowElapsed(),
      ticker: phase === "idle" ? getIdleTicker() : getRunningTicker(),
    });
    const colored = s.startsWith("✓") ? fg("success", s) : s.startsWith("⚠") || s.startsWith("✖") ? fg("warning", s) : fg("accent", s);
    if (colored !== lastRendered) {
      lastRendered = colored;
      ui.setStatus(KEY, colored);
    }
  };

  const refreshWidget = async (ctx: any) => {
    if (!widgetVisible) return;
    // prefer live entries
    const live = getLiveEntries(ctx.sessionManager ?? lastSM);
    if (live) {
      const report = renderReport(live);
      if (ctx.hasUI) ctx.ui.setWidget(SESSION_WIDGET_KEY, report.split("\n"));
      else ctx.ui.notify(report, "info");
      return;
    }
    const file = pickSessionFile(ctx.sessionManager ?? ({} as any));
    if (!file) return;
    try {
      const report = renderReport(parseSessionEntries(readFileSync(file, "utf8")));
      if (ctx.hasUI) ctx.ui.setWidget(SESSION_WIDGET_KEY, report.split("\n"));
      else ctx.ui.notify(report, "info");
    } catch {
      /* ignore */
    }
  };

  pi.on("agent_start", async (_e, ctx) => {
    ui = ctx.ui;
    lastSM = ctx.sessionManager as any;
    runStart = Date.now();
    runBaseline = snapshotBaseline(lastSM);
    touch("thinking");
    render();
  });
  pi.on("turn_start", async (_e, ctx) => {
    ui = ctx.ui;
    lastSM = ctx.sessionManager as any;
    touch("thinking");
    render();
  });
  pi.on("message_start", async (e, ctx) => {
    ui = ctx.ui;
    lastSM = (ctx as any).sessionManager as any;
    if ((e as any)?.message?.role !== "assistant") return;
    touch("streaming");
    render();
  });
  pi.on("message_update", async (_e, ctx) => {
    ui = ctx.ui;
    lastSM = (ctx as any).sessionManager as any;
    touch("streaming");
  });
  pi.on("message_end", async (_e, ctx) => {
    ui = ctx.ui;
    lastSM = (ctx as any).sessionManager as any;
    touch("thinking");
    render();
  });
  pi.on("tool_execution_start", async (e, ctx) => {
    ui = ctx.ui;
    lastSM = (ctx as any).sessionManager as any;
    touch("tool", (e as any)?.toolName ?? "?");
    render();
  });
  pi.on("tool_execution_update", async (e, ctx) => {
    ui = ctx.ui;
    lastSM = (ctx as any).sessionManager as any;
    touch("tool", (e as any)?.toolName ?? "?");
  });
  pi.on("tool_result", async (_e, ctx) => {
    ui = ctx.ui;
    lastSM = (ctx as any).sessionManager as any;
    if (phase === "error") return; // keep error visible briefly
    touch("thinking");
    render();
  });
  pi.on("tool_execution_end", async (e, ctx) => {
    ui = ctx.ui;
    lastSM = (ctx as any).sessionManager as any;
    const isErr = !!(e as any)?.isError;
    const name = (e as any)?.toolName ?? "?";
    if (isErr) {
      touch("error", name);
      render();
      if (errorTimer) clearTimeout(errorTimer);
      errorTimer = setTimeout(() => {
        if (phase === "error") {
          touch("thinking");
          render();
        }
      }, 3000);
    } else {
      if (phase === "error") return;
      touch("thinking");
      render();
    }
  });
  pi.on("turn_end", async (_e, ctx) => {
    ui = ctx.ui;
    lastSM = (ctx as any).sessionManager as any;
    touch("thinking");
  });
  pi.on("agent_end", async (_e, ctx) => {
    ui = ctx.ui;
    lastSM = (ctx as any).sessionManager as any;
    if (phase === "error") return;
    touch("thinking");
    render();
  });
  pi.on("agent_settled", async (_e, ctx) => {
    ui = ctx.ui;
    lastSM = (ctx as any).sessionManager as any;
    try {
      const live = getLiveEntries(lastSM);
      const cur = live ? aggregateEntries(live) : null;
      if (cur) {
        const durMs = runStart ? Date.now() - runStart : 0;
        if (runBaseline) {
          const calls = cur.calls - runBaseline.calls;
          const tokens = Math.max(0, cur.totalTokens - runBaseline.totalTokens);
          const cost = Math.max(0, cur.cost - runBaseline.cost);
          if (calls > 0 || tokens > 0 || cost > 0) {
            lastRun = { calls: Math.max(0, calls), totalTokens: tokens, totalFmt: fmtTokensLocal(tokens), cost, costStr: cost.toFixed(4), durMs };
          }
        } else if (cur.calls > 0) {
          lastRun = { calls: cur.calls, totalTokens: cur.totalTokens, totalFmt: cur.totalFmt, cost: cur.cost, costStr: cur.cost.toFixed(4), durMs };
        }
      }
    } catch {}
    touch("idle");
    render();
    if (widgetVisible) refreshWidget(ctx);
  });

  // ── /agent-session-status ────────────────────────────────────────────────
  pi.registerCommand("agent-session-status", {
    description:
      "Show a compact summary of the last agent session (active model, calls, cache, cost, compactions). Args: `clear` hides the panel, `--json` outputs JSON.",
    handler: async (args, ctx) => {
      const a = args.trim();
      if (a === "clear") {
        ctx.ui.setWidget(SESSION_WIDGET_KEY, undefined);
        widgetVisible = false;
        return;
      }
      const isJson = a === "--json" || a === "json" || a.includes("--json");
      // prefer in-memory live entries (instant, no FS)
      let entries: FileEntry[] | null = getLiveEntries(ctx.sessionManager as any);
      if (!entries) {
        const file = pickSessionFile(ctx.sessionManager);
        if (!file) {
          ctx.ui.notify("agent-session-status: no session file with messages found for this project", "warning");
          return;
        }
        try {
          entries = parseSessionEntries(readFileSync(file, "utf8"));
        } catch {
          ctx.ui.notify("agent-session-status: failed to read session file", "warning");
          return;
        }
      }
      if (isJson) {
        const j = buildReportJson(entries);
        const pretty = JSON.stringify(j, null, 2);
        if (ctx.hasUI) {
          ctx.ui.setWidget(SESSION_WIDGET_KEY, pretty.split("\n"));
          widgetVisible = true;
        } else ctx.ui.notify(pretty, "info");
        return;
      }
      const report = renderReport(entries);
      if (ctx.hasUI) {
        ctx.ui.setWidget(SESSION_WIDGET_KEY, report.split("\n"));
        widgetVisible = true;
      } else ctx.ui.notify(report, "info");
    },
  });

  // keyboard shortcut to toggle widget (default ctrl+shift+a; override via AGENT_STATUS_SHORTCUT; was ctrl+shift+s which conflicts with pi-web-access curate shortcut)
  try {
    pi.registerShortcut(getShortcut(), {
      description: "Toggle agent session status widget",
      handler: async (ctx: any) => {
        if (widgetVisible) {
          ctx.ui.setWidget(SESSION_WIDGET_KEY, undefined);
          widgetVisible = false;
        } else {
          let entries: FileEntry[] | null = getLiveEntries(ctx.sessionManager as any ?? lastSM);
          if (!entries) {
            const file = pickSessionFile((ctx.sessionManager as any) ?? lastSM ?? ({} as any));
            if (!file) {
              ctx.ui.notify("agent-session-status: no session found", "warning");
              return;
            }
            entries = parseSessionEntries(readFileSync(file, "utf8"));
          }
          const report = renderReport(entries);
          ctx.ui.setWidget(SESSION_WIDGET_KEY, report.split("\n"));
          widgetVisible = true;
        }
      },
    });
  } catch {
    /* shortcut not supported on this pi version */
  }

  // Stuck watchdog: singleton so /reload doesn't leak intervals
  const g = globalThis as any;
  if (g.__agentStatusInterval) clearInterval(g.__agentStatusInterval);
  g.__agentStatusInterval = setInterval(render, CHECK_INTERVAL_MS);
}
