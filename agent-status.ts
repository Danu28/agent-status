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
 * Tuning: AGENT_STATUS_STUCK_MS (default 60000). Disable: AGENT_STATUS_ENABLED=0.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Clamp bad env values: NaN/0/negative fall back to the default; the watchdog
// can never be silently disabled by a malformed AGENT_STATUS_STUCK_MS.
const STUCK_MS = Math.max(1_000, Number(process.env.AGENT_STATUS_STUCK_MS) || 60_000);
const CHECK_INTERVAL_MS = 2_000;
const ENABLED = (process.env.AGENT_STATUS_ENABLED ?? "1") !== "0";
const KEY = "agent-status";

export default function (pi: ExtensionAPI) {
  if (!ENABLED) return;

  let ui: any;
  let phase: "thinking" | "streaming" | "tool" | "idle" = "idle";
  let toolName = "";
  let lastActivity = Date.now();
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
    }
    if (s !== lastRendered) {
      lastRendered = s;
      ui.setStatus(KEY, s);
    }
  };

  pi.on("agent_start", async (_e, ctx) => {
    ui = ctx.ui;
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

  // Stuck watchdog: re-render every few seconds so the warning appears when
  // activity stops while the agent is supposedly running.
  setInterval(render, CHECK_INTERVAL_MS);
}
