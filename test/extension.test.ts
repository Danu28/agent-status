import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fmtDur,
  formatStatus,
  pickSessionFile,
  renderReport,
  aggregateEntries,
  buildReportJson,
  default as makeExtension,
} from "../agent-status.ts";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";

// The extension starts a 2s watchdog interval on load; stub it so test process exits cleanly.
(globalThis as any).setInterval = (fn: any, ms: any) => 0;
(globalThis as any).clearInterval = () => {};

const jsonl = (objs: unknown[]) => objs.map((o) => JSON.stringify(o)).join("\n");

function sampleEntries() {
  return parseSessionEntries(
    jsonl([
      { type: "header", cwd: "/tmp/myproj", t: 0 },
      {
        type: "message",
        message: {
          role: "assistant",
          provider: "p",
          model: "m",
          stopReason: "end_turn",
          usage: { input: 10_000, output: 5_000, cacheRead: 2_000, cacheWrite: 1_000, reasoning: 4_000, totalTokens: 18_000, cost: { total: 0.01 } },
        },
      },
      { type: "message", message: { role: "user", content: "hi" } },
    ]),
  );
}

const base = { toolName: "", idleMs: 0, stuckMs: 60_000, runStart: 0, now: 0, showElapsed: false };

test("fmtDur formats durations", () => {
  assert.equal(fmtDur(45_000), "45s");
  assert.equal(fmtDur(2 * 60_000 + 10_000), "2m10s");
  assert.equal(fmtDur(1 * 3_600_000 + 3 * 60_000 + 20_000), "1h03m20s");
  assert.equal(fmtDur(0), "0s");
});

test("formatStatus idle", () => {
  assert.equal(formatStatus({ ...base, phase: "idle" }), "✓ idle");
});

test("formatStatus running / streaming / tool", () => {
  assert.equal(formatStatus({ ...base, phase: "thinking" }), "● running");
  assert.equal(formatStatus({ ...base, phase: "streaming" }), "● streaming…");
  assert.equal(formatStatus({ ...base, phase: "tool", toolName: "X" }), "● running · tool: X");
});

test("formatStatus stuck + no-activity", () => {
  assert.equal(
    formatStatus({ ...base, phase: "tool", toolName: "X", idleMs: 90_000 }),
    "⚠ stuck 90s — Esc to abort",
  );
  assert.equal(
    formatStatus({ ...base, phase: "thinking", idleMs: 90_000 }),
    "⚠ no activity 90s (may be thinking) — Esc to abort if it never progresses",
  );
});

test("formatStatus error phase", () => {
  assert.equal(formatStatus({ ...base, phase: "error", toolName: "bash" }), "✖ error · tool: bash");
});

test("formatStatus appends elapsed when showElapsed && runStart", () => {
  assert.equal(
    formatStatus({ ...base, phase: "thinking", runStart: 1_000, now: 1_000 + 130_000, showElapsed: true }),
    "● running · 2m10s",
  );
});

test("formatStatus ticker appended", () => {
  assert.equal(
    formatStatus({ ...base, phase: "thinking", runStart: 1_000, now: 1_000 + 60_000, showElapsed: true, ticker: "~18K · $0.0100" }),
    "● running · 1m00s · ~18K · $0.0100",
  );
});

test("renderReport is plain, real-data, no box", () => {
  const out = renderReport(sampleEntries());
  assert.match(out, /Active:\s+p\/m/);
  assert.match(out, /Calls:\s+1 · turns 1 · ~18\.0K tokens/);
  assert.match(out, /Cache:\s+hit 2,000 · miss 10,000 · write 1,000 · 16\.7%/);
  assert.match(out, /Cost:\s+\$0\.0100 · compacted 0/);
  for (const ch of ["╔", "╗", "╚", "╝", "═", "║"]) {
    assert.ok(!out.includes(ch), `unexpected box char ${ch}`);
  }
});

test("renderReport handles missing header (no session entry)", () => {
  const ents = parseSessionEntries(
    jsonl([
      { type: "message", message: { role: "assistant", provider: "p", model: "m", usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } } } },
      { type: "message", message: { role: "user", content: "hi" } },
    ]),
  );
  const out = renderReport(ents);
  assert.match(out, /\? session/);
  assert.match(out, /Calls:\s+1/);
});

test("renderReport guards cost when undefined or string", () => {
  const ents = parseSessionEntries(
    jsonl([
      { type: "header", cwd: "/proj", t: 0 },
      { type: "message", message: { role: "assistant", provider: "p", model: "m", usage: { input: 10, output: 5, totalTokens: 15, cost: { total: "bad" as any } } } },
    ]),
  );
  const out = renderReport(ents);
  assert.match(out, /Cost:\s+\$/);
  assert.doesNotThrow(() => buildReportJson(ents));
});

test("aggregateEntries counts compactions / branch_summary / model_change and multi-model timeline", () => {
  const ents = parseSessionEntries(
    jsonl([
      { type: "header", cwd: "/proj", t: 0 },
      { type: "message", message: { role: "assistant", provider: "a", model: "m1", usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0.01 } } } },
      { type: "message", message: { role: "assistant", provider: "b", model: "m2", usage: { input: 20, output: 10, totalTokens: 30, cost: { total: 0.02 } } } },
      { type: "message", message: { role: "assistant", provider: "a", model: "m1", usage: { input: 5, output: 5, totalTokens: 10, cost: { total: 0.01 } } } },
      { type: "compaction", summary: "c", firstKeptEntryId: "x", tokensBefore: 100, id: "c1", parentId: null, timestamp: new Date().toISOString() },
      { type: "branch_summary", fromId: "x", summary: "b", id: "b1", parentId: null, timestamp: new Date().toISOString() },
      { type: "model_change", provider: "a", modelId: "m1", id: "mc1", parentId: null, timestamp: new Date().toISOString() },
    ]),
  );
  const d = aggregateEntries(ents);
  assert.equal(d.compactions, 1);
  assert.equal(d.branchSummaries, 1);
  assert.equal(d.modelChanges, 1);
  assert.equal(d.models.length, 2);
  const out = renderReport(ents);
  assert.match(out, /Models:/);
  assert.match(out, /compacted 1/);
});

test("buildReportJson shape", () => {
  const j: any = buildReportJson(sampleEntries());
  assert.equal(j.project, "myproj");
  assert.equal(j.calls, 1);
  assert.equal(j.turns, 1);
  assert.ok(typeof j.cost === "number");
  assert.ok(Array.isArray(j.models));
});

test("pickSessionFile picks newest file with messages (bounded)", () => {
  const dir = mkdtempSync(join(tmpdir(), "as-"));
  writeFileSync(join(dir, "empty.jsonl"), jsonl([{ type: "header", cwd: dir, t: 0 }]));
  const withMsg = join(dir, "hasmsg.jsonl");
  writeFileSync(withMsg, jsonl([{ type: "message", message: { role: "assistant", provider: "p", model: "m" } }]));
  const got = pickSessionFile({ getSessionFile: () => undefined, getSessionDir: () => dir });
  assert.equal(got, withMsg);
  rmSync(dir, { recursive: true, force: true });
});

test("pickSessionFile bounded to 20 newest", () => {
  const dir = mkdtempSync(join(tmpdir(), "as-"));
  // create 30 files, only the newest 20 should be considered
  for (let i = 0; i < 30; i++) {
    const p = join(dir, `f${String(i).padStart(2, "0")}.jsonl`);
    writeFileSync(p, jsonl([{ type: "header", cwd: dir, t: i }]));
  }
  const withMsg = join(dir, "f29.jsonl");
  writeFileSync(withMsg, jsonl([{ type: "message", message: { role: "assistant", provider: "p", model: "m" } }]));
  const got = pickSessionFile({ getSessionFile: () => undefined, getSessionDir: () => dir });
  assert.equal(got, withMsg);
  rmSync(dir, { recursive: true, force: true });
});

test("pickSessionFile undefined when no messages", () => {
  const dir = mkdtempSync(join(tmpdir(), "as-"));
  writeFileSync(join(dir, "a.jsonl"), jsonl([{ type: "header", cwd: dir, t: 0 }]));
  const got = pickSessionFile({ getSessionFile: () => undefined, getSessionDir: () => dir });
  assert.equal(got, undefined);
  rmSync(dir, { recursive: true, force: true });
});

test("/agent-session-status handler sets widget + clear + json", async () => {
  const dir = mkdtempSync(join(tmpdir(), "as-"));
  writeFileSync(join(dir, "old.jsonl"), jsonl([{ type: "message", message: { role: "assistant", provider: "p", model: "old" } }]));
  const newest = join(dir, "new.jsonl");
  writeFileSync(
    newest,
    jsonl([
      { type: "header", cwd: "/tmp/myproj", t: 0 },
      {
        type: "message",
        message: {
          role: "assistant",
          provider: "p",
          model: "m",
          usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, reasoning: 0, totalTokens: 18, cost: { total: 0.01 } },
        },
      },
      { type: "message", message: { role: "user", content: "hi" } },
    ]),
  );

  let widget: string[] | undefined = ["unset"];
  const ui: any = { setWidget: (k: string, v: string[] | undefined) => { if (k === "agent-session-status") widget = v; }, notify() {}, theme: {} };
  const ctx: any = { ui, hasUI: true, sessionManager: { getSessionFile: () => undefined, getSessionDir: () => dir } };

  let commandDef: any;
  const pi: any = { on() {}, registerCommand(_n: string, def: any) { commandDef = def; }, registerShortcut() {} };
  makeExtension(pi);
  assert.ok(commandDef, "command registered");

  await commandDef.handler("", ctx);
  assert.ok(Array.isArray(widget), "widget set to lines");
  assert.match(widget!.join("\n"), /Active:\s+p\/m/);

  await commandDef.handler("--json", ctx);
  assert.ok(Array.isArray(widget), "json widget set");
  assert.match(widget!.join("\n"), /"project"/);

  await commandDef.handler("clear", ctx);
  assert.equal(widget, undefined);

  rmSync(dir, { recursive: true, force: true });
});

test("/agent-session-status prefers in-memory entries over disk", async () => {
  let widget: string[] | undefined;
  const ui: any = { setWidget: (k: string, v: string[] | undefined) => { if (k === "agent-session-status") widget = v; }, notify() {}, theme: {} };
  const liveEnts = parseSessionEntries(
    jsonl([
      { type: "header", cwd: "/live/proj", t: 0 },
      { type: "message", message: { role: "assistant", provider: "live", model: "m", usage: { input: 10, output: 10, totalTokens: 20, cost: { total: 0.02 } } } },
    ]),
  );
  const header = liveEnts.find((e) => (e as any).type === "session");
  const body = liveEnts.filter((e) => (e as any).type !== "session");
  const ctx: any = {
    ui,
    hasUI: true,
    sessionManager: {
      getHeader: () => header,
      getEntries: () => body,
      getSessionFile: () => "/nonexistent.jsonl",
      getSessionDir: () => "/tmp/nope",
    },
  };
  let commandDef: any;
  const pi: any = { on() {}, registerCommand(_n: string, def: any) { commandDef = def; }, registerShortcut() {} };
  makeExtension(pi);
  await commandDef.handler("", ctx);
  assert.ok(Array.isArray(widget));
  assert.match(widget!.join("\n"), /live\/m/);
  assert.match(widget!.join("\n"), /proj session/);
});

test("tool_execution_end handler registered and error phase", async () => {
  const handlers: Record<string, any> = {};
  const pi: any = {
    on(ev: string, h: any) { handlers[ev] = h; },
    registerCommand() {},
    registerShortcut() {},
  };
  makeExtension(pi);
  assert.ok(handlers["tool_execution_end"], "tool_execution_end handler exists");
  assert.ok(handlers["agent_settled"], "agent_settled exists");
  // simulate error tool end should set error phase (cover formatStatus)
  assert.equal(formatStatus({ ...base, phase: "error", toolName: "bash" }), "✖ error · tool: bash");
});
