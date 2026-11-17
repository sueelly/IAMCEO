import { afterEach, expect, test } from "bun:test";
import { Bus } from "../server/bus.ts";
import { loadConfig } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import { ApiError, Store } from "../server/store.ts";
import type { Backend, Member } from "../shared/types.ts";
import type { Runner, RunnerEvent, RunnerMember, SendResult } from "../server/runner/types.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";

class FakeRunner implements Runner {
  constructor(readonly kind: Backend = "core") {}
  sent: { memberId: string; text: string }[] = [];
  busy = new Set<string>();
  sendResult: (m: RunnerMember) => Promise<SendResult> = async () => ({ ok: true, started: false, turn: 0 });
  callback: (event: RunnerEvent) => void = () => {};
  async available() { return { ok: true }; }
  async start(m: RunnerMember) { return { sessionId: m.sessionId ?? `session-${m.id}`, paneId: `pane-${m.id}` }; }
  async send(m: RunnerMember, text: string): Promise<SendResult> {
    this.sent.push({ memberId: m.id, text });
    this.busy.add(m.id);
    const result = await this.sendResult(m);
    if (!result.ok) this.busy.delete(m.id);
    return result;
  }
  isBusy(id: string) { return this.busy.has(id); }
  async compact(): Promise<SendResult> { return { ok: true }; }
  async setParallel(): Promise<SendResult> { return { ok: true }; }
  interrupts = 0;
  async interrupt() { this.interrupts++; }
  async stop(m: RunnerMember) { this.busy.delete(m.id); }
  async screen() { return ""; }
  on(callback: (event: RunnerEvent) => void) { this.callback = callback; }
  async shutdown() {}
  end(member: Member, turn = 1, errorText?: string) {
    this.busy.delete(member.id);
    this.callback({ type: "turn_end", memberId: member.id, terminalId: member.paneId, sessionGeneration: 0, turn, isError: !!errorText, finalText: "", ...(errorText ? { errorText } : {}) });
  }
}
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(5);
  expect(check()).toBe(true);
}
function fixture(maxConcurrentTurns = 2) {
  const isolated = createIsolatedRuntime();
  const config = loadConfig({ IAMCEO_HOME: isolated.paths.iamceoHome, IAMCEO_PORT: "0", IAMCEO_CORE_SOCKET: isolated.socketPath, IAMCEO_CORE_BIN: isolated.bins.coreBin, IAMCEO_CLAUDE_BIN: isolated.bins.claudeBin, IAMCEO_CODEX_BIN: isolated.bins.codexBin });
  const db = openDb(config.dbPath);
  const store = new Store(db, new Bus());
  store.patchSettings({ maxConcurrentTurns, boardTidyHours: 0 });
  const project = store.createProject({ name: "Workflow", cwd: isolated.paths.work });
  const runner = new FakeRunner();
  const headless = new FakeRunner("headless");
  const orchestrators: Orchestrator[] = [];
  function orchestrator(onlyHeadless = false) {
    const orch = new Orchestrator({ config, store, runners: new Map<Backend, Runner>(onlyHeadless ? [["headless", headless]] : [["core", runner], ["headless", headless]]), timings: { tickMs: 60_000, healthMs: 60_000, turnErrorRetryMs: 1000 } });
    orchestrators.push(orch);
    return orch;
  }
  const orch = orchestrator();
  let memberSequence = 0;
  function member(kind: Member["kind"] = "worker", origin: Member["origin"] = "runner", projectId = project.id, backend: Backend = "core") {
    const i = ++memberSequence;
    return store.createMember({ projectId, handle: kind === "conductor" ? "lead" : `worker${i}`, name: `Member ${i}`, kind, origin, backend, status: "idle", cwd: isolated.paths.work, paneId: `pane${i}`, sessionId: `session${i}` });
  }
  cleanups.push(async () => { for (const current of orchestrators) await current.shutdown(); db.close(); await isolated.stop(); });
  return { isolated, config, store, project, runner, headless, orch, orchestrator, member, db };
}

test("core reserves two slots synchronously before awaited sends and returns one per terminal end", async () => {
  const f = fixture(); const members = Array.from({ length: 5 }, () => f.member());
  const resolvers: Array<(result: SendResult) => void> = [];
  f.runner.sendResult = () => new Promise(resolve => resolvers.push(resolve));
  for (const member of members) f.store.enqueue({ projectId: f.project.id, memberId: member.id, kind: "instruction", text: "Do one task" });
  const pumping = members.map(member => f.orch.pump(member.id));
  expect(f.runner.sent).toHaveLength(2);
  for (const resolve of resolvers.splice(0)) resolve({ ok: true, started: false, turn: 0 });
  await Promise.all(pumping);
  f.runner.sendResult = async () => ({ ok: true, started: false, turn: 0 });
  f.runner.end(members[0], 1, "failed");
  await until(() => f.runner.sent.length === 3);
  f.runner.end(members[0], 1, "duplicate");
  await Bun.sleep(10);
  expect(f.runner.sent).toHaveLength(3);
  expect(f.store.listPendingExecutions()).toHaveLength(2);
  f.runner.end(members[1], 1, "failed");
  await until(() => f.runner.sent.length === 4);
  expect(f.store.listPendingExecutions()).toHaveLength(2);
});

test("retry admission reads only scheduled delays while preserving completed delivery backend scope", async () => {
  const f = fixture(); const target = f.member(), other = f.member();
  for (let i = 0; i < 80; i++) {
    const d = f.store.enqueue({ projectId: f.project.id, memberId: other.id, kind: "instruction", text: "settled history" });
    f.store.markDelivered(d.id);
  }
  const delayed = f.store.listDeliveries().at(-1)!;
  f.store.patchDeliveryRetry(delayed.id, { retryScope: "backend:core", nextAttemptAt: new Date(Date.now() + 120_000).toISOString() });
  f.store.enqueue({ projectId: f.project.id, memberId: target.id, kind: "instruction", text: "waiting work" });
  let reads = 0;
  const read = f.store.getDeliveryRetry.bind(f.store);
  f.store.getDeliveryRetry = id => { reads++; return read(id); };
  await f.orch.pump(target.id);
  expect(f.runner.sent).toHaveLength(0);
  expect(reads).toBeLessThan(10);
  f.store.patchDeliveryRetry(delayed.id, { nextAttemptAt: null });
  await f.orch.pump(target.id);
  expect(f.runner.sent.map(s => s.memberId)).toEqual([target.id]);
});

test("a definite pre-write failure releases admission while an ambiguous write retains its persistent slot", async () => {
  const f = fixture(1); const first = f.member(); const second = f.member(); const third = f.member();
  f.runner.sendResult = async m => m.id === first.id ? { ok: false, reason: "down", retryable: true, deliveryEffect: "not_written" } : m.id === second.id ? { ok: false, reason: "error", retryable: true, deliveryEffect: "unknown" } : { ok: true };
  for (const member of [first, second, third]) {
    f.store.enqueue({ projectId: f.project.id, memberId: member.id, kind: "instruction", text: "One instruction" });
    await f.orch.pump(member.id);
  }
  expect(f.runner.sent.map(s => s.memberId)).toEqual([first.id, second.id]);
  expect(f.store.listPendingExecutions()).toHaveLength(1);
  expect(f.store.listPendingExecutions()[0].phase).toBe("unknown");
});

test("restart rebuilds slots from received executions before admitting queued members", async () => {
  const f = fixture(1); const first = f.member(); const second = f.member();
  await f.orch.assign(f.project.id, first.handle, { text: "Running before restart" });
  f.store.enqueue({ projectId: f.project.id, memberId: second.id, kind: "instruction", text: "Wait" });
  await f.orch.shutdown();
  f.runner.busy.clear(); // journal alone must retain the received slot
  const next = f.orchestrator(); await next.recover();
  expect(f.runner.sent).toHaveLength(1);
  f.runner.end(first, 1, "ended after restart");
  await until(() => f.runner.sent.length === 2);
  expect(f.runner.sent[1].memberId).toBe(second.id);
});

test("lowering the limit keeps existing turns and increasing it resumes the waiting pump", async () => {
  const f = fixture(2); const members = Array.from({ length: 4 }, () => f.member());
  await Promise.all(members.map(member => f.orch.assign(f.project.id, member.handle, { text: "Task" })));
  expect(f.runner.sent).toHaveLength(2);
  await f.orch.updateSettings({ maxConcurrentTurns: 1 });
  expect(f.runner.busy.size).toBe(2);
  f.runner.end(members[0], 1, "ended");
  await Bun.sleep(10);
  expect(f.runner.sent).toHaveLength(2);
  await f.orch.updateSettingsV2({ maxConcurrentTurns: 3 }, { expectedRevision: f.store.settingsRevision() });
  await until(() => f.runner.sent.length === 4);
  expect(f.runner.busy.size).toBe(3);
});

test("persisted due times survive restart and delay the whole member queue without delaying another member", async () => {
  const f = fixture(); const first = f.member(); const second = f.member();
  const delivery = f.store.enqueue({ projectId: f.project.id, memberId: first.id, kind: "instruction", text: "Delayed" });
  const due = new Date(Date.now() + 60_000).toISOString();
  f.store.patchDeliveryRetry(delivery.id, { nextAttemptAt: due, retryScope: `member:${first.id}`, retryReason: "control_retry" });
  f.store.enqueue({ projectId: f.project.id, memberId: first.id, kind: "instruction", text: "New instruction also waits" });
  await f.orch.shutdown(); const next = f.orchestrator(); await next.recover();
  await next.assign(f.project.id, second.handle, { text: "Independent" });
  expect(f.runner.sent.map(s => s.memberId)).toEqual([second.id]);
  expect(f.store.getDeliveryRetry(delivery.id).nextAttemptAt).toBe(due);
  f.store.patchDeliveryRetry(delivery.id, { nextAttemptAt: new Date(Date.now() - 1).toISOString() });
  await next.pump(first.id);
  expect(f.runner.sent).toHaveLength(2);
  expect(f.runner.sent[1].text).toContain("New instruction also waits");
});

test("quota processing failure preserves received input and delays only its proven member scope", async () => {
  const f = fixture(); const first = f.member(); const second = f.member();
  await f.orch.assign(f.project.id, first.handle, { text: "Received once" });
  const run = f.store.listPendingExecutions()[0];
  f.runner.end(first, 1, "quota limit reached");
  await until(() => f.store.getExecutionJournal(run.runId)?.result === "error");
  expect(f.store.requireDelivery(run.deliveryIds[0]).status).toBe("delivered");
  expect(f.store.getDeliveryRetry(run.deliveryIds[0])).toMatchObject({ retryScope: `member:${first.id}`, retryReason: "processing_quota", nextAttemptAt: expect.any(String) });
  await f.orch.assign(f.project.id, first.handle, { text: "New work waits" });
  await f.orch.assign(f.project.id, second.handle, { text: "Independent account is not guessed" });
  expect(f.runner.sent).toHaveLength(2);
  expect(f.runner.sent[1].memberId).toBe(second.id);
});

test("recovery writes use the same reserved capacity and persist their execution linkage", async () => {
  const f = fixture(1); const first = f.member(); const second = f.member();
  await f.orch.assign(f.project.id, first.handle, { text: "Already occupies the slot" });
  const delivery = f.store.enqueue({ projectId: f.project.id, memberId: second.id, kind: "instruction", text: "Recovery task" });
  const identity = { terminalId: second.paneId, sessionId: second.sessionId, sessionGeneration: 0, process: null };
  const dispatch = f.orch.deliveryRecovery.prepareDispatch([delivery.id], identity, { serverEpoch: "test", turn: 0, inputEpoch: 0, logs: [], capturedAt: new Date().toISOString() });
  let repairs = 0;
  const repairRunner: Runner = f.runner;
  repairRunner.repairDelivery = async () => {
    repairs++;
    f.runner.busy.add(second.id);
    return { ok: true, started: false, turn: 0, receipt: { dispatchId: dispatch.dispatchId, receivedAt: new Date().toISOString(), source: "transport" } };
  };
  const request = { action: "resend" as const, dispatchId: dispatch.dispatchId, expectedRecoveryVersion: 1, expectedSessionGeneration: 0, expectedSessionId: second.sessionId, expectedTerminalId: second.paneId!, expectedInputEpoch: 0 };
  const member: RunnerMember = { ...second, model: null, effort: null, subagentModel: null, permissionMode: "default", sessionGeneration: 0 };
  expect(await f.orch.recoveryRunner(second)!.repairDelivery!(member, request)).toMatchObject({ ok: false, reason: "busy" });
  expect(repairs).toBe(0);
  f.runner.end(first, 1, "finished");
  await until(() => f.store.listPendingExecutions().length === 0);
  expect((await f.orch.recoveryRunner(second)!.repairDelivery!(member, request)).ok).toBe(true);
  expect(repairs).toBe(1);
  expect(f.store.listPendingExecutions()).toHaveLength(1);
  expect(f.store.listPendingExecutions()[0]).toMatchObject({ runId: dispatch.dispatchId, deliveryIds: [delivery.id], phase: "received" });
});


test("project limit defaults to inheritance and persists independently of the global limit", () => {
  const f = fixture(9);
  expect(f.store.requireProject(f.project.id).maxConcurrentTurns).toBeNull();
  f.store.patchProject(f.project.id, { maxConcurrentTurns: 3 });
  const reopened = openDb(f.config.dbPath);
  try {
    const read = new Store(reopened, new Bus());
    expect(read.requireProject(f.project.id).maxConcurrentTurns).toBe(3);
    expect(read.projectSummaries().find(p => p.id === f.project.id)?.maxConcurrentTurns).toBe(3);
    expect(read.getSettings().maxConcurrentTurns).toBe(9);
  } finally { reopened.close(); }
  expect(f.store.patchProject(f.project.id, { maxConcurrentTurns: null }).maxConcurrentTurns).toBeNull();
});

test("project limits reject non-integers and values outside 1 through 64 before mutation", () => {
  const f = fixture();
  for (const value of [0, -1, 65, 1.5, NaN, Infinity, "2", true]) {
    expect(() => f.store.patchProject(f.project.id, { maxConcurrentTurns: value } as never)).toThrow(ApiError);
  }
  expect(f.store.requireProject(f.project.id).maxConcurrentTurns).toBeNull();
  expect(f.store.patchProject(f.project.id, { maxConcurrentTurns: 64 }).maxConcurrentTurns).toBe(64);
});

test("a capped project leaves global slots available to another project during concurrent sends", async () => {
  const f = fixture(3);
  f.store.patchProject(f.project.id, { maxConcurrentTurns: 1 });
  const other = f.store.createProject({ name: "Independent", cwd: f.isolated.paths.work });
  const [a, b, c] = [f.member(), f.member(), f.member()];
  const [d, e] = [f.member("worker", "runner", other.id), f.member("worker", "runner", other.id)];
  const resolves: Array<(result: SendResult) => void> = [];
  f.runner.sendResult = () => new Promise(resolve => resolves.push(resolve));
  for (const member of [a, b, c, d, e]) f.store.enqueue({ projectId: member.projectId, memberId: member.id, kind: "instruction", text: "Independent task" });
  const pumping = [a, b, c, d, e].map(member => f.orch.pump(member.id));
  const sent = f.runner.sent.map(value => value.memberId);
  for (const resolve of resolves.splice(0)) resolve({ ok: true, started: false, turn: 0 });
  await Promise.all(pumping);
  expect(sent).toEqual([a.id, d.id, e.id]);
  f.runner.sendResult = async () => ({ ok: true, started: false, turn: 0 });
  f.runner.end(d, 1, "finished");
  await Bun.sleep(20);
  expect(f.runner.sent).toHaveLength(3);
  f.runner.end(a, 1, "finished");
  await until(() => f.runner.sent.length === 4);
  expect(f.runner.sent[3].memberId).toBe(b.id);
});

test("the global limit still bounds a project configured above it and inherited projects", async () => {
  const f = fixture(2);
  f.store.patchProject(f.project.id, { maxConcurrentTurns: 64 });
  const other = f.store.createProject({ name: "Inherited", cwd: f.isolated.paths.work });
  const members = [f.member(), f.member("worker", "runner", other.id), f.member()];
  await Promise.all(members.map(member => f.orch.assign(member.projectId, member.handle, { text: "Task" })));
  expect(f.runner.sent.map(value => value.memberId)).toEqual(members.slice(0, 2).map(member => member.id));
});

test("lowering a project cap preserves current turns and raising or inheriting drains its queue", async () => {
  const f = fixture(4);
  const members = Array.from({ length: 4 }, () => f.member());
  await f.orch.patchProject(f.project.id, { maxConcurrentTurns: 2 });
  await Promise.all(members.map(member => f.orch.assign(f.project.id, member.handle, { text: "Task" })));
  expect(f.runner.sent).toHaveLength(2);
  await f.orch.patchProject(f.project.id, { maxConcurrentTurns: 1 });
  expect(f.runner.busy.size).toBe(2);
  expect(f.runner.interrupts).toBe(0);
  f.runner.end(members[0], 1, "finished");
  await Bun.sleep(20);
  expect(f.runner.sent).toHaveLength(2);
  await f.orch.patchProject(f.project.id, { maxConcurrentTurns: 2 });
  await until(() => f.runner.sent.length === 3);
  await f.orch.patchProject(f.project.id, { maxConcurrentTurns: null });
  await until(() => f.runner.sent.length === 4);
  expect(f.runner.interrupts).toBe(0);
});

for (const scope of ["project", "global"] as const) test(`a ${scope} cap lowered while parallel setup awaits is rechecked before writing input`, async () => {
  const f = fixture(2);
  const first = f.member(), second = f.member();
  await f.orch.assign(f.project.id, first.handle, { text: "Already running" });
  let release!: () => void;
  let entered = false;
  f.runner.setParallel = async () => { entered = true; await new Promise<void>(resolve => { release = resolve; }); return { ok: true }; };
  const pumping = f.orch.assign(f.project.id, second.handle, { text: "Must remain queued", parallel: true });
  await until(() => entered);
  if (scope === "project") await f.orch.patchProject(f.project.id, { maxConcurrentTurns: 1 });
  else await f.orch.updateSettings({ maxConcurrentTurns: 1 });
  release(); await pumping;
  expect(f.runner.sent.map(value => value.memberId)).toEqual([first.id]);
  const pending = f.store.listPending(second.id);
  expect(pending).toHaveLength(1);
  expect(pending[0].attempts).toBe(0);
  expect(pending[0].status).toBe("queued");
  f.runner.end(first, 1, "finished");
  await until(() => f.runner.sent.length === 2);
});

test("project admission deduplicates journal, reservation and physical core occupancy by member", async () => {
  const f = fixture(8);
  f.store.patchProject(f.project.id, { maxConcurrentTurns: 2 });
  const a = f.member(), b = f.member(), c = f.member();
  await f.orch.assign(f.project.id, a.handle, { text: "One slot in three sources" });
  await f.orch.assign(f.project.id, b.handle, { text: "Second slot" });
  await f.orch.assign(f.project.id, c.handle, { text: "Wait" });
  expect(f.runner.sent.map(value => value.memberId)).toEqual([a.id, b.id]);
});

test("physical core turns without a journal and restored headless executions both consume project slots", async () => {
  const f = fixture(5);
  f.store.patchProject(f.project.id, { maxConcurrentTurns: 1 });
  const physical = f.member(), waiting = f.member();
  f.runner.busy.add(physical.id);
  await f.orch.assign(f.project.id, waiting.handle, { text: "Physical turn holds project" });
  expect(f.runner.sent).toHaveLength(0);
  f.runner.busy.delete(physical.id);
  const headless = f.member("worker", "runner", f.project.id, "headless");
  const headlessOrch = f.orchestrator(true);
  await headlessOrch.assign(f.project.id, headless.handle, { text: "Headless execution" });
  expect(f.headless.sent).toHaveLength(1);
  await headlessOrch.shutdown();
  await f.orch.shutdown();
  f.headless.busy.clear();
  const next = f.orchestrator();
  await next.recover();
  await next.pump(waiting.id);
  expect(f.runner.sent).toHaveLength(0);
});

test("recovery cannot use a globally free slot when its own project is capped", async () => {
  const f = fixture(4);
  f.store.patchProject(f.project.id, { maxConcurrentTurns: 1 });
  const first = f.member(), second = f.member();
  await f.orch.assign(f.project.id, first.handle, { text: "Project occupied" });
  const delivery = f.store.enqueue({ projectId: f.project.id, memberId: second.id, kind: "instruction", text: "Recovery waits" });
  const identity = { terminalId: second.paneId, sessionId: second.sessionId, sessionGeneration: 0, process: null };
  const dispatch = f.orch.deliveryRecovery.prepareDispatch([delivery.id], identity, { serverEpoch: "test", turn: 0, inputEpoch: 0, logs: [], capturedAt: new Date().toISOString() });
  let repairs = 0;
  const runner: Runner = f.runner;
  runner.repairDelivery = async () => { repairs++; return { ok: true, started: false, turn: 0 }; };
  const request = { action: "resend" as const, dispatchId: dispatch.dispatchId, expectedRecoveryVersion: 1, expectedSessionGeneration: 0, expectedSessionId: second.sessionId, expectedTerminalId: second.paneId!, expectedInputEpoch: 0 };
  const member: RunnerMember = { ...second, model: null, effort: null, subagentModel: null, permissionMode: "default", sessionGeneration: 0 };
  expect(await f.orch.recoveryRunner(second)!.repairDelivery!(member, request)).toMatchObject({ ok: false, reason: "busy", deliveryEffect: "not_written" });
  expect(repairs).toBe(0);
});
