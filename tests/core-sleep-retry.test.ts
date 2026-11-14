import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreRunner, type CoreRunnerDeps } from "../server/runner/core.ts";
import type { CoreTerminal } from "../server/runner/core-client.ts";
import type { RunnerEvent, RunnerMember, StartOpts } from "../server/runner/types.ts";
import type { RunnerRecoveryStore, TerminalLease } from "../server/service-contracts.ts";
import { Bus } from "../server/bus.ts";
import { openDb } from "../server/db.ts";
import { Store } from "../server/store.ts";
import { DeliveryRecovery } from "../server/delivery-recovery.ts";

const sleepError = "API Error: Your computer went to sleep mid-response. The response above may be incomplete.";
const composer = (draft = "") => `prior output\n${"─".repeat(30)}\n❯ ${draft}\n${"─".repeat(30)}\n`;
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

async function fixture(overrides: Partial<RunnerMember> = {}) {
  // Deliberately retain fixture directories. No real CLI, core or database is used.
  const dir = mkdtempSync(join(tmpdir(), "iamceo-sleep-retry-"));
  const socketPath = join(dir, "mock.sock");
  const member: RunnerMember = { id: "fake-member", projectId: "fake-project", handle: "worker", name: "Fake", cli: "claude", cwd: dir,
    sessionId: "fake-existing-session", paneId: "fake-terminal", sessionGeneration: 1, model: null, effort: null, subagentModel: null, permissionMode: "default", kind: "worker", ...overrides };
  const terminal: CoreTerminal = { address: member.paneId!, argv: ["/fake/claude"], cwd: member.cwd, state: "live", pid: 12345, turn: 11,
    labels: { "iamceo.cli": "claude", "iamceo.project": member.projectId, "iamceo.member": member.id, "iamceo.generation": String(member.sessionGeneration), "iamceo.session": member.sessionId! },
    status: { state: "error", app: "claude-code", msg: sleepError } };
  const calls: { method: string; params: any }[] = [], events: RunnerEvent[] = [];
  const sockets = new Set<Socket>();
  let screen = composer(), hook = (_method: string, _socket: Socket) => false;
  let lease: TerminalLease | null = null, unresolved = false;
  const recoveryStore = { inputState: () => ({ lease, unresolvedDispatches: unresolved ? [{ transportState: "unknown" }] : [] }) } as unknown as RunnerRecoveryStore;
  const server = createServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.setEncoding("utf8"); let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n"), request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        calls.push({ method: request.method, params: request.params });
        if (hook(request.method, socket)) continue;
        let result: unknown;
        if (request.method === "hello") result = { generation: 1, version: "fake-gen1", features: [], methods: ["terminal.run", "terminal.list", "terminal.get", "terminal.read", "terminal.send", "terminal.interrupt", "terminal.kill"] };
        else if (request.method === "terminal.list") result = { terminals: [terminal] };
        else if (request.method === "terminal.get") result = terminal;
        else if (request.method === "terminal.read") result = { text: screen, complete: true };
        else if (request.method === "terminal.send") { result = { turn: 11, started: true }; terminal.status = { state: "working" }; }
        else throw new Error(`Unexpected mutating method: ${request.method}`);
        socket.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
      }
    });
  });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  const deps: CoreRunnerDeps = { pollMs: 100_000, rpcTimeoutMs: 150, sendTimeoutMs: 150, recoveryStore };
  const runner = new CoreRunner({ socketPath, claudeBin: "/fake/claude", claudeHome: join(dir, "no-real-transcripts") }, deps);
  runner.on(event => events.push(event));
  cleanup.push(async () => { await runner.shutdown(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); });
  expect((await runner.reattachOwned(member)).outcome).toBe("rejoined");
  const opts: StartOpts = { systemPromptFile: join(dir, "unused-rules"), mcpConfigFile: join(dir, "unused-mcp"), projectName: "Fake", resume: true };
  return { runner, member, terminal, calls, events, opts, deps, set screen(value: string) { screen = value; }, set hook(value: typeof hook) { hook = value; },
    set leased(value: boolean) { lease = value ? { expiresAt: Date.now() + 60_000 } as TerminalLease : null; }, set unresolved(value: boolean) { unresolved = value; },
    writes: () => calls.filter(call => ["terminal.send", "terminal.keys", "terminal.run", "terminal.kill", "terminal.interrupt"].includes(call.method)) };
}

describe("Claude sleep retry stays fail closed on generation 1", () => {
  test("stable known sleep and an empty composer is only a provisional protocol candidate", async () => {
    const f = await fixture();
    const inspection = await f.runner.inspectSleepRetry(f.member);
    expect(inspection).toMatchObject({ outcome: "requires_protocol", reason: "atomic_retry_unavailable", automaticSend: false,
      identity: { terminalId: "fake-terminal", sessionId: "fake-existing-session", sessionGeneration: 1, process: { pid: 12345 } }, turn: 11 });
    expect(f.calls.filter(call => call.method === "terminal.read").length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(inspection)).not.toContain("prior output");
    expect(f.writes()).toHaveLength(0);
    expect(await f.runner.send(f.member, "existing queued follow-up", f.opts)).toMatchObject({ ok: false, retryable: false, deliveryEffect: "not_written", detail: expect.stringContaining("atomic_retry_unavailable") });
    expect(f.writes()).toHaveLength(0);
    expect(f.runner.observationState(f.member.id)?.lastError).toBe(sleepError);
    expect(f.events.filter(event => event.type === "turn_end")).toMatchObject([{ isError: true, errorText: sleepError }]);
  });

  test("general API, authentication, quota and approximate sleep errors are refused", async () => {
    const f = await fixture();
    for (const msg of ["API Error: unavailable", "Authentication failed", "Quota exhausted", sleepError + " extra", sleepError.toLowerCase()]) {
      f.terminal.status = { state: "error", app: "claude-code", msg };
      expect(await f.runner.inspectSleepRetry(f.member)).toMatchObject({ outcome: "refused", reason: "not_sleep_error", automaticSend: false });
      expect(await f.runner.send(f.member, "existing follow-up", f.opts)).toMatchObject({ ok: false, deliveryEffect: "not_written" });
    }
    f.terminal.status = { state: "error", app: "other-program", msg: sleepError };
    expect(await f.runner.inspectSleepRetry(f.member)).toMatchObject({ outcome: "refused", reason: "not_sleep_error" });
    expect(f.writes()).toHaveLength(0);
  });

  test("working, dialog, unknown and gone states never qualify", async () => {
    const f = await fixture();
    for (const state of ["working", "blocked", "idle", "done"]) {
      f.terminal.status = { state, app: "claude-code", msg: sleepError };
      expect(await f.runner.inspectSleepRetry(f.member)).toMatchObject({ outcome: "refused", automaticSend: false });
    }
    f.terminal.status = null;
    expect(await f.runner.inspectSleepRetry(f.member)).toMatchObject({ outcome: "refused" });
    f.terminal.state = "finished";
    expect(await f.runner.inspectSleepRetry(f.member)).toMatchObject({ outcome: "refused" });
    expect(f.writes()).toHaveLength(0);
  });

  test("drafts, whitespace, placeholders, dialogs and ANSI composers are not empty evidence", async () => {
    const f = await fixture();
    for (const screen of [composer("draft"), composer(" "), composer('Try "something"'), composer("[Pasted text #1]"), "Approve?\n❯ 1. Yes\n2. No", "\x1b[2m" + composer()]) {
      f.screen = screen;
      expect(await f.runner.inspectSleepRetry(f.member)).toMatchObject({ outcome: "refused", automaticSend: false });
    }
    expect(f.writes()).toHaveLength(0);
  });

  test("missing PID, native session or generation cannot establish a candidate", async () => {
    for (const change of [(f: Awaited<ReturnType<typeof fixture>>) => { f.terminal.pid = null; },
      (f: Awaited<ReturnType<typeof fixture>>) => { delete f.terminal.labels["iamceo.session"]; },
      (f: Awaited<ReturnType<typeof fixture>>) => { f.member.sessionGeneration = undefined; }]) {
      const f = await fixture(); change(f);
      expect(await f.runner.inspectSleepRetry(f.member)).toMatchObject({ outcome: "refused", automaticSend: false });
      expect(f.writes()).toHaveLength(0);
    }
  });

  test("a different requested session or generation is refused", async () => {
    const f = await fixture();
    for (const member of [{ ...f.member, sessionGeneration: 2 }, { ...f.member, sessionId: "other-session" }]) {
      expect(await f.runner.inspectSleepRetry(member)).toMatchObject({ outcome: "refused", reason: "identity_changed" });
    }
    expect(f.writes()).toHaveLength(0);
  });

  test("direct control and unresolved external delivery are refused", async () => {
    const f = await fixture();
    f.leased = true;
    expect(await f.runner.inspectSleepRetry(f.member)).toMatchObject({ outcome: "refused", reason: "manual_control" });
    f.leased = false; f.unresolved = true;
    expect(await f.runner.inspectSleepRetry(f.member)).toMatchObject({ outcome: "refused", reason: "input_unsettled" });
    expect(f.writes()).toHaveLength(0);
  });

  test("configuration and unfinished compact operations remain fenced", async () => {
    const f = await fixture();
    const internals = f.runner as any;
    internals.configuring.add(f.member.id);
    expect(await f.runner.inspectSleepRetry(f.member)).toMatchObject({ outcome: "refused", reason: "input_unsettled" });
    internals.configuring.clear();
    const track = internals.tracks.get(f.member.id);
    for (const field of ["pending", "uncertain", "completing"]) {
      track[field] = true;
      expect(await f.runner.inspectSleepRetry(f.member)).toMatchObject({ outcome: "refused", reason: "input_unsettled" });
      track[field] = false;
    }
    track.compact = { phase: "uncertain" };
    expect(await f.runner.inspectSleepRetry(f.member)).toMatchObject({ outcome: "refused", reason: "input_unsettled" });
    track.compact = null;
    expect(f.writes()).toHaveLength(0);
  });

  test("status, PID, session, generation, turn, lease or delivery changes during reads refuse", async () => {
    const mutations: Array<(f: Awaited<ReturnType<typeof fixture>>) => void> = [
      f => { f.terminal.status = { state: "idle" }; },
      f => { f.terminal.status = { state: "blocked", kind: "permission" }; },
      f => { f.terminal.pid = 99999; },
      f => { f.terminal.labels["iamceo.session"] = "other-session"; },
      f => { f.terminal.labels["iamceo.generation"] = "2"; },
      f => { f.terminal.turn = 12; },
      f => { f.leased = true; },
      f => { f.unresolved = true; },
    ];
    for (const mutate of mutations) {
      const f = await fixture(); let changed = false;
      f.hook = method => { if (method === "terminal.read" && !changed) { changed = true; mutate(f); } return false; };
      expect(await f.runner.inspectSleepRetry(f.member)).toMatchObject({ outcome: "refused", automaticSend: false });
      expect(f.writes()).toHaveLength(0);
      expect(f.events.some(event => event.type === "turn_end" && !event.isError)).toBe(false);
    }
  });

  test("a composer changed after its first read is refused", async () => {
    const f = await fixture(); let reads = 0;
    f.hook = method => { if (method === "terminal.read" && ++reads === 2) f.screen = composer("new draft"); return false; };
    expect(await f.runner.inspectSleepRetry(f.member)).toMatchObject({ outcome: "refused", automaticSend: false });
    expect(f.writes()).toHaveLength(0);
  });

  test("concurrent inspections, concurrent send and repeated retries never type from error", async () => {
    const f = await fixture();
    const results = await Promise.all([f.runner.inspectSleepRetry(f.member), f.runner.inspectSleepRetry(f.member)]);
    expect(results.some(result => result.outcome === "requires_protocol")).toBe(true);
    expect(results.some(result => result.outcome === "refused")).toBe(true);
    await Promise.all([f.runner.send(f.member, "existing follow-up", f.opts), f.runner.inspectSleepRetry(f.member)]);
    await f.runner.send(f.member, "existing follow-up", f.opts);
    expect(f.writes()).toHaveLength(0);
  });

  test("read response loss refuses and cannot enable a replay", async () => {
    const f = await fixture();
    f.hook = (method, socket) => { if (method !== "terminal.read") return false; socket.destroy(); return true; };
    expect(await f.runner.inspectSleepRetry(f.member)).toMatchObject({ outcome: "refused", reason: "observation_unavailable", automaticSend: false });
    await f.runner.send(f.member, "existing follow-up", f.opts);
    expect(f.writes()).toHaveLength(0);
  });

  test("original seven conditions retain their write behavior", async () => {
    const f = await fixture();
    await f.runner.send(f.member, "follow-up", f.opts); await f.runner.send(f.member, "follow-up", f.opts);
    expect(f.writes()).toHaveLength(0);
    for (const state of ["working", "blocked", "unknown"]) {
      f.terminal.status = state === "unknown" ? null : { state };
      expect((await f.runner.send(f.member, "follow-up", f.opts)).ok).toBe(false);
    }
    f.terminal.status = { state: "idle" }; f.screen = composer("existing draft");
    expect(await f.runner.send(f.member, "follow-up", f.opts)).toMatchObject({ ok: false, reason: "input_busy" });
    expect(f.writes()).toHaveLength(0);
    for (const state of ["idle", "done"]) {
      const positive = await fixture(); positive.terminal.status = { state };
      expect((await positive.runner.send(positive.member, "follow-up", positive.opts)).ok).toBe(true);
      expect(positive.writes()).toHaveLength(1);
      expect(positive.writes()[0].params.force).toBe(false);
    }
  });

  test("an ambiguous accepted input remains fenced even after the CLI becomes idle", async () => {
    const f = await fixture(); f.terminal.status = { state: "idle" };
    f.hook = (method, socket) => { if (method !== "terminal.send") return false; socket.destroy(); return true; };
    expect(await f.runner.send(f.member, "follow-up", f.opts)).toMatchObject({ ok: false, deliveryEffect: "unknown" });
    f.terminal.status = { state: "error", app: "claude-code", msg: sleepError };
    expect(await f.runner.inspectSleepRetry(f.member)).toMatchObject({ outcome: "refused", reason: "input_unsettled" });
    f.terminal.status = { state: "idle" };
    expect((await f.runner.send(f.member, "follow-up", f.opts)).ok).toBe(false);
    expect(f.writes()).toHaveLength(1);
  });

  test("real in-memory queue records retain the same follow-up and never invent a receipt", async () => {
    const store = new Store(openDb(":memory:"), new Bus());
    const project = store.createProject({ name: "Isolated queue", cwd: "/fake-project" });
    const member = store.createMember({ projectId: project.id, handle: "worker", name: "Fake", kind: "worker", sessionId: "fake-existing-session", paneId: "fake-terminal" });
    const f = await fixture({ id: member.id, projectId: project.id, cwd: project.cwd, sessionGeneration: store.memberRevisions(member.id).sessionGeneration });
    const recovery = new DeliveryRecovery({ store, runner: () => f.runner });
    const delivery = store.enqueue({ projectId: project.id, memberId: member.id, kind: "instruction", text: "Existing real follow-up in the fake queue" });
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const observation = f.runner.observationState(member.id)!;
        const dispatch = recovery.prepareDispatch([delivery.id], observation.identity, { serverEpoch: "fake-epoch", turn: observation.turn,
          inputEpoch: observation.inputEpoch, logs: [], capturedAt: new Date().toISOString() });
        const result = await f.runner.send(f.member, dispatch.wireText, f.opts);
        recovery.recordResult(dispatch.dispatchId, result);
        expect(result).toMatchObject({ ok: false, deliveryEffect: "not_written" });
        expect(store.requireDelivery(delivery.id)).toMatchObject({ id: delivery.id, text: delivery.text });
        expect(store.requireDelivery(delivery.id).status).not.toBe("delivered");
        expect(store.getDispatch(dispatch.dispatchId)?.transportState).toBe("rejected");
        expect(store.requireMember(member.id).sessionId).toBe(member.sessionId);
      }
      expect(f.writes()).toHaveLength(0);
      expect(f.events.filter(event => event.type === "turn_end")).toMatchObject([{ isError: true }]);
    } finally { await recovery.shutdown(); store.db.close(); }
  });
});
