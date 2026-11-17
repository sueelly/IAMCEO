// Persisted unfinished work must enter the ordinary delivery pump. These tests
// use real Store/Orchestrator paths and an isolated fake core boundary.
import { afterEach, expect, test } from "bun:test";
import { Bus } from "../server/bus.ts";
import { loadConfig } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { Orchestrator, type OrchestratorTimings } from "../server/orchestrator.ts";
import { Store } from "../server/store.ts";
import type { Member } from "../shared/types.ts";
import type { RunnerMember } from "../server/runner/types.ts";
import { FakeRunner, until } from "./fixtures/harness-fixture.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";

class ContinuationRunner extends FakeRunner {
  turns = new Map<string, number>();
  interruptError: Error | null = null;
  interruptGate: Promise<void> | null = null;
  interrupts = 0;
  override async send(member: RunnerMember, text: string) {
    this.sent.push({ memberId: member.id, text });
    this.busy.add(member.id);
    return { ok: true as const, started: false, turn: this.turns.get(member.id) ?? 0 };
  }
  override async interrupt() {
    this.interrupts++;
    if (this.interruptGate) await this.interruptGate;
    if (this.interruptError) throw this.interruptError;
  }
  override end(member: Member) {
    const turn = (this.turns.get(member.id) ?? 0) + 1;
    this.turns.set(member.id, turn);
    super.end(member, turn);
  }
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function fixture(timings: Partial<OrchestratorTimings> = {}) {
  const isolated = createIsolatedRuntime();
  const config = loadConfig({ IAMCEO_HOME: isolated.paths.iamceoHome, IAMCEO_PORT: "0", IAMCEO_CORE_SOCKET: isolated.socketPath,
    IAMCEO_CORE_BIN: isolated.bins.coreBin, IAMCEO_CLAUDE_BIN: isolated.bins.claudeBin, IAMCEO_CODEX_BIN: isolated.bins.codexBin });
  const db = openDb(config.dbPath), store = new Store(db, new Bus()), runner = new ContinuationRunner();
  store.patchSettings({ maxConcurrentTurns: 2, boardTidyHours: 0 });
  const project = store.createProject({ name: "Continuation runtime", cwd: isolated.paths.work });
  const make = (handle: string, kind: "worker" | "conductor") => store.createMember({ projectId: project.id,
    handle, name: handle, kind, origin: "runner", backend: "core", status: "idle", cwd: isolated.paths.work,
    paneId: `pane-${handle}`, sessionId: `session-${handle}` });
  const lead = make("lead", "conductor"), worker = make("worker", "worker"), other = make("other", "worker");
  const instances: Orchestrator[] = [];
  const create = () => {
    const orch = new Orchestrator({ config, store, runners: new Map([["core", runner]]), providerHomes: isolated.providerHomes,
      timings: { tickMs: 60_000, healthMs: 60_000, ...timings } });
    instances.push(orch);
    return orch;
  };
  let orch = create();
  const pendingRun = (member: Member) => store.listPendingExecutions().find(run => run.memberId === member.id);
  const end = async (member: Member) => {
    const run = pendingRun(member);
    expect(run).toBeDefined();
    runner.end(store.requireMember(member.id));
    await until("execution ended", () => !!store.getExecutionJournal(run!.runId)?.endedAt && !runner.busy.has(member.id));
    await orch.pump(member.id);
  };
  const task = () => store.saveTask({ projectId: project.id, memberId: worker.id, who: worker.name,
    title: "Finish approved implementation", branch: "fixture/approved-work" }).task;
  const unfinished = async () => {
    const t = task();
    await orch.assign(project.id, worker.handle, { taskId: t.id, text: "Implement and verify the approved work" });
    const report = await orch.recordPost(store.requireMember(worker.id), { taskId: t.id, kind: "막힘", title: "Regression still fails",
      checks: [{ name: "regression", kind: "regression", result: "fail", evidence: "Isolated regression failure" }] });
    await end(worker);
    await until("conductor received report", () => !!pendingRun(lead));
    await orch.recordPost(store.requireMember(lead.id), { taskId: t.id, kind: "알림", title: "Reviewed the failure", aboutReportId: report.id });
    await end(lead);
    expect(store.taskProgress(t.id).stage).not.toBe("done");
    return t;
  };
  const check = (now: number) => orch.checkTaskContinuations(now);
  const restart = async () => {
    await orch.shutdown();
    orch = create();
    await orch.recover();
    return orch;
  };
  cleanups.push(async () => { for (const instance of instances) await instance.shutdown(); db.close(); await isolated.stop(); });
  return { isolated, config, store, runner, project, lead, worker, other, get orch() { return orch; }, pendingRun, end, task, unfinished, check, restart };
}

test("unfinished work wakes the conductor through one durable ordinary delivery after both turns end", async () => {
  const f = fixture(), task = await f.unfinished(), now = Date.now() + 120_000;
  const before = f.store.listDeliveries();
  const scheduled = f.check(now);
  expect(scheduled).toHaveLength(1);
  const [continuation] = scheduled;
  expect(continuation).toMatchObject({ memberId: f.lead.id, taskId: task.id, kind: "system", wake: true, urgent: false });
  expect(f.check(now)).toHaveLength(0);
  await f.orch.pump(f.lead.id);
  expect(f.store.requireDelivery(continuation!.id).status).toBe("delivered");
  expect(f.pendingRun(f.lead)?.deliveryIds).toContain(continuation!.id);
  expect(f.store.listDeliveries()).toHaveLength(before.length + 1);
  expect(f.store.doneMark(task.id)).toBeNull();
  expect(f.store.latestTaskChecks(task.id)[0]?.result).toBe("fail");
});

test("continuation turns do not create missing-report followups and respect persisted cooldown across restart", async () => {
  const f = fixture(), task = await f.unfinished(), now = Date.now() + 120_000;
  const [first] = f.check(now);
  expect(first).toBeDefined();
  await f.orch.pump(f.lead.id);
  await f.end(f.lead);
  expect(f.store.listDeliveries().filter(d => d.text.includes("보고 보완:"))).toHaveLength(0);
  expect(f.check(now + 1000)).toHaveLength(0);
  await f.restart();
  expect(f.check(now + 1000)).toHaveLength(0);
  const [second] = f.check(now + 60_000);
  expect(second).toMatchObject({ memberId: f.lead.id, taskId: task.id });
  expect(second!.id).not.toBe(first!.id);
  expect(f.store.requireDelivery(first!.id).status).toBe("delivered");
});

test("periodic continuation checks cannot be starved by a queued quiet notice", async () => {
  const f = fixture({ tickMs: 10, continuationMs: 80 }), task = await f.unfinished();
  const quiet = f.store.enqueue({ projectId: f.project.id, memberId: f.lead.id, kind: "system", text: "Quiet context for the next real turn", wake: false });
  await f.restart();
  await until("periodic continuation entered the ordinary pump", () => f.runner.to(f.lead).length === 2);
  const run = f.pendingRun(f.lead)!;
  expect(run.deliveryIds).toContain(quiet.id);
  expect(run.deliveryIds.map(id => f.store.requireDelivery(id))).toContainEqual(expect.objectContaining({ taskId: task.id, kind: "system", wake: true, status: "delivered" }));
  expect(f.store.doneMark(task.id)).toBeNull();
});

test("an ordinary assigned correction supersedes a queued reminder without replaying the original instruction", async () => {
  const f = fixture(), task = await f.unfinished();
  f.store.patchSettings({ maxConcurrentTurns: 1 });
  const unrelated = f.store.saveTask({ projectId: f.project.id, memberId: f.other.id, who: f.other.name, title: "Unrelated work" }).task;
  await f.orch.assign(f.project.id, f.other.handle, { taskId: unrelated.id, text: "Occupy the only automatic slot" });
  const [continuation] = f.check(Date.now() + 120_000);
  expect(continuation).toBeDefined();
  await f.orch.pump(f.lead.id);
  expect(f.store.requireDelivery(continuation!.id).status).toBe("queued");
  const correction = await f.orch.assign(f.project.id, f.worker.handle, { taskId: task.id, text: "Correct the failing regression using the reviewed approach" });
  await f.orch.pump(f.lead.id);
  expect(f.store.requireDelivery(continuation!.id).status).toBe("failed");
  expect(f.store.requireDelivery(correction.delivery.id)).toMatchObject({ status: "queued", attempts: 0 });
  expect(f.store.listDeliveries().filter(d => d.taskId === task.id && d.kind === "instruction" && d.status === "delivered")).toHaveLength(1);
  expect(f.runner.to(f.lead)).toHaveLength(1);
});

test("a continuation bundled with an ordinary instruction preserves the ordinary instruction's report duty", async () => {
  const f = fixture();
  await f.unfinished();
  f.store.patchSettings({ maxConcurrentTurns: 1 });
  const otherTask = f.store.saveTask({ projectId: f.project.id, memberId: f.other.id, who: f.other.name, title: "Separate task" }).task;
  await f.orch.assign(f.project.id, f.other.handle, { taskId: otherTask.id, text: "Occupy the automatic slot" });
  const [continuation] = f.check(Date.now() + 120_000);
  expect(continuation).toBeDefined();
  await f.orch.pump(f.lead.id);
  const ordinary = f.store.enqueue({ projectId: f.project.id, memberId: f.lead.id, taskId: otherTask.id,
    kind: "instruction", text: "Please report the independent task outcome", wake: true });
  await f.orch.stopMember(f.other.id, { by: `agent-${f.lead.id}` });
  await f.end(f.other);
  await until("mixed conductor turn", () => !!f.pendingRun(f.lead)?.deliveryIds.includes(ordinary.id));
  expect(f.pendingRun(f.lead)?.deliveryIds).toContain(continuation!.id);
  await f.end(f.lead);
  const followups = f.store.listDeliveries().filter(d => d.text.includes("보고 보완:"));
  expect(followups).toHaveLength(1);
  expect(followups[0]!.taskId).toBe(otherTask.id);
});

test.each(["approval", "manual-control", "unknown-write"] as const)("continuation scheduling respects the conductor's %s fence", async fence => {
  const f = fixture(), task = await f.unfinished();
  if (fence === "approval") f.store.patchMember(f.lead.id, { status: "blocked", blockedReason: "permission" });
  if (fence === "manual-control") f.store.saveLease({ memberId: f.lead.id, claimId: "manual-claim", leaseId: "manual-lease",
    identity: { terminalId: f.lead.paneId, sessionId: f.lead.sessionId, sessionGeneration: 0, process: null }, expiresAt: Date.now() + 180_000, lastInputSequence: 0 });
  let protectedId: string | null = null;
  if (fence === "unknown-write") {
    const d = f.store.enqueue({ projectId: f.project.id, memberId: f.lead.id, kind: "system", text: "Unknown physical write", wake: false, taskId: null });
    protectedId = d.id;
    const dispatch = f.orch.deliveryRecovery.prepareDispatch([d.id], { terminalId: f.lead.paneId, sessionId: f.lead.sessionId, sessionGeneration: 0, process: null },
      { serverEpoch: "continuation-runtime", turn: 0, inputEpoch: 0, logs: [], capturedAt: new Date().toISOString() });
    f.store.updateDispatch(dispatch.dispatchId, "prepared", "unknown");
  }
  const before = f.store.listDeliveries();
  expect(f.check(Date.now() + 120_000)).toHaveLength(0);
  await f.orch.pump(f.lead.id);
  expect(f.runner.to(f.lead)).toHaveLength(1);
  expect(f.store.doneMark(task.id)).toBeNull();
  if (protectedId) expect(f.store.listDeliveryDispatches(protectedId)).toHaveLength(1);
  expect(f.store.listDeliveries().map(d => d.id)).toEqual(before.map(d => d.id));
});

test("a user stop pauses unfinished work before interrupt settles and survives restart", async () => {
  const f = fixture(), task = await f.unfinished(), now = Date.now() + 120_000;
  const [continuation] = f.check(now);
  expect(continuation).toBeDefined();
  await f.orch.pump(f.lead.id);
  let release!: () => void;
  f.runner.interruptGate = new Promise<void>(resolve => { release = resolve; });
  const stopping = f.orch.stopMember(f.lead.id, { by: "user" });
  await until("interrupt reached", () => f.runner.interrupts === 1);
  // A restart can lose the in-memory stop request while the external interrupt
  // is still unresolved. The durable pause must already exist.
  await f.restart();
  f.runner.end(f.store.requireMember(f.lead.id));
  await until("interrupted turn observed", () => !f.pendingRun(f.lead));
  release();
  expect((await stopping).outcome).toBe("stopped");
  expect(f.check(now + 120_000)).toHaveLength(0);
  expect(f.store.requireDelivery(continuation!.id).status).toBe("delivered");
  expect(f.store.doneMark(task.id)).toBeNull();
});

test("stopping a multi-task report supplement persists the original task scopes across restart", async () => {
  const f = fixture(), first = f.task();
  const second = f.store.saveTask({ projectId: f.project.id, memberId: f.lead.id, who: f.lead.name,
    title: "Second approved implementation", branch: "fixture/second-approved-work" }).task;
  for (const task of [first, second]) f.store.enqueue({ projectId: f.project.id, memberId: f.lead.id,
    taskId: task.id, kind: "instruction", text: `Coordinate approved work ${task.id}`, wake: true });
  await f.orch.pump(f.lead.id);
  const original = f.pendingRun(f.lead)!;
  expect(original.deliveryIds).toHaveLength(2);
  f.runner.end(f.store.requireMember(f.lead.id));
  await until("multi-task report supplement started", () => !!f.pendingRun(f.lead) && f.pendingRun(f.lead)!.runId !== original.runId);
  const supplement = f.pendingRun(f.lead)!;
  const followup = f.store.getReportFollowup(original.runId)!;
  expect(supplement.deliveryIds).toEqual([followup.deliveryId]);
  expect(f.store.requireDelivery(followup.deliveryId).taskId).toBeNull();
  expect(f.store.requireMember(f.lead.id).executionState?.taskIds).toEqual([]);

  expect((await f.orch.stopMember(f.lead.id, { by: "user", expectRunId: supplement.runId })).outcome).toBe("stopped");
  const paused = f.store.db.query<{ task_id: string }, []>("SELECT task_id FROM task_continuations WHERE pause_token IS NOT NULL ORDER BY task_id").all();
  expect(paused.map(row => row.task_id)).toEqual([first.id, second.id].sort());
  await f.end(f.lead);
  expect(f.store.getExecutionJournal(supplement.runId)?.result).toBe("interrupted");
  await f.restart();
  expect(f.check(Date.now() + 120_000)).toHaveLength(0);
  expect(f.runner.to(f.lead)).toHaveLength(2);
  expect(f.store.doneMark(first.id)).toBeNull();
  expect(f.store.doneMark(second.id)).toBeNull();
});

test("stopping task A with a quiet task B note leaves B eligible for continuation", async () => {
  const f = fixture(), background = await f.unfinished();
  const active = f.store.saveTask({ projectId: f.project.id, memberId: f.lead.id, who: f.lead.name,
    title: "Active task A", branch: "fixture/task-a" }).task;
  const instruction = f.store.enqueue({ projectId: f.project.id, memberId: f.lead.id, taskId: active.id,
    kind: "instruction", text: "Work on task A now", wake: true });
  const note = f.store.enqueue({ projectId: f.project.id, memberId: f.lead.id, taskId: background.id,
    kind: "system", text: "Unrelated background about task B", wake: false });
  await f.orch.pump(f.lead.id);
  expect(f.pendingRun(f.lead)!.deliveryIds.sort()).toEqual([instruction.id, note.id].sort());
  expect(f.store.requireMember(f.lead.id).executionState!.taskIds!.sort()).toEqual([active.id, background.id].sort());
  expect((await f.orch.stopMember(f.lead.id, { by: "user" })).outcome).toBe("stopped");
  const paused = f.store.db.query<{ task_id: string }, []>("SELECT task_id FROM task_continuations WHERE pause_token IS NOT NULL ORDER BY task_id").all();
  expect(paused.map(row => row.task_id)).toEqual([active.id]);
  await f.end(f.lead);
  const [continuation] = f.check(Date.now() + 120_000);
  expect(continuation?.taskId).toBe(background.id);
  expect(f.store.requireDelivery(note.id).status).toBe("delivered");
});

test("stopping a report supplement excludes quiet task scopes from both the root and current runs", async () => {
  const f = fixture();
  const tasks = ["First obligation", "Second obligation", "Root context", "Supplement context"].map((title, i) =>
    f.store.saveTask({ projectId: f.project.id, memberId: f.lead.id, who: f.lead.name, title, branch: `fixture/mixed-${i}` }).task);
  for (const task of tasks.slice(0, 2)) f.store.enqueue({ projectId: f.project.id, memberId: f.lead.id,
    taskId: task.id, kind: "instruction", text: `Coordinate approved work ${task.id}`, wake: true });
  const originalNote = f.store.enqueue({ projectId: f.project.id, memberId: f.lead.id, taskId: tasks[2]!.id,
    kind: "system", text: "Quiet context in the original run", wake: false });
  await f.orch.pump(f.lead.id);
  const original = f.pendingRun(f.lead)!;
  expect(original.deliveryIds).toContain(originalNote.id);
  const currentNote = f.store.enqueue({ projectId: f.project.id, memberId: f.lead.id, taskId: tasks[3]!.id,
    kind: "system", text: "Quiet context in the supplement run", wake: false });
  f.runner.end(f.store.requireMember(f.lead.id));
  await until("mixed report supplement started", () => !!f.pendingRun(f.lead) && f.pendingRun(f.lead)!.runId !== original.runId);
  const supplement = f.pendingRun(f.lead)!, followup = f.store.getReportFollowup(original.runId)!;
  expect(supplement.deliveryIds.sort()).toEqual([followup.deliveryId, currentNote.id].sort());
  expect(f.store.requireDelivery(followup.deliveryId).taskId).toBeNull();
  expect(f.store.requireMember(f.lead.id).executionState?.taskIds).toEqual([tasks[3]!.id]);
  expect((await f.orch.stopMember(f.lead.id, { by: "user", expectRunId: supplement.runId })).outcome).toBe("stopped");
  const paused = f.store.db.query<{ task_id: string }, []>("SELECT task_id FROM task_continuations WHERE pause_token IS NOT NULL ORDER BY task_id").all();
  expect(paused.map(row => row.task_id)).toEqual(tasks.slice(0, 2).map(task => task.id).sort());
  await f.end(f.lead);
  await f.restart();
  expect(f.check(Date.now() + 120_000)).toHaveLength(0);
  expect(f.runner.to(f.lead)).toHaveLength(2);
});

test("a failed user stop releases its pause and allows continuation after the turn ends", async () => {
  const f = fixture(), task = await f.unfinished(), now = Date.now() + 120_000;
  const [continuation] = f.check(now);
  expect(continuation).toBeDefined();
  await f.orch.pump(f.lead.id);
  f.runner.interruptError = new Error("isolated interrupt refused");
  expect((await f.orch.stopMember(f.lead.id, { by: "user" })).outcome).toBe("failed");
  f.runner.interruptError = null;
  await f.end(f.lead);
  expect(f.check(now + 60_000)).toHaveLength(1);
  expect(f.store.doneMark(task.id)).toBeNull();
});

test("a user stop cancels an unsent reminder after a correction starts in another free slot", async () => {
  const f = fixture(), task = await f.unfinished();
  f.store.patchSettings({ maxConcurrentTurns: 1 });
  const unrelated = f.store.saveTask({ projectId: f.project.id, memberId: f.other.id, who: f.other.name, title: "Other occupied slot" }).task;
  await f.orch.assign(f.project.id, f.other.handle, { taskId: unrelated.id, text: "Keep the first slot busy" });
  const [continuation] = f.check(Date.now() + 120_000);
  expect(continuation).toBeDefined();
  await f.orch.pump(f.lead.id);
  expect(f.store.requireDelivery(continuation!.id).status).toBe("queued");
  // Change only the isolated fixture capacity and explicitly start the worker;
  // the waiting conductor has not received its queued reminder yet.
  f.store.patchSettings({ maxConcurrentTurns: 2 });
  const correction = await f.orch.assign(f.project.id, f.worker.handle, { taskId: task.id, text: "Apply the reviewed correction" });
  expect(f.store.requireDelivery(correction.delivery.id).status).toBe("delivered");
  expect((await f.orch.stopMember(f.worker.id, { by: "user" })).outcome).toBe("stopped");
  await f.end(f.worker);
  await f.orch.pump(f.lead.id);
  expect(f.store.requireDelivery(continuation!.id).status).toBe("failed");
  expect(f.runner.to(f.lead)).toHaveLength(1);
  expect(f.store.requireDelivery(correction.delivery.id).status).toBe("delivered");
  expect(f.store.doneMark(task.id)).toBeNull();
});

test("ordinary queued followup work is preserved while a done task cancels its unsent continuation", async () => {
  const f = fixture(), task = await f.unfinished();
  f.store.patchSettings({ maxConcurrentTurns: 1 });
  const unrelated = f.store.saveTask({ projectId: f.project.id, memberId: f.other.id, who: f.other.name, title: "Active slot" }).task;
  await f.orch.assign(f.project.id, f.other.handle, { taskId: unrelated.id, text: "Unrelated active turn" });
  const [continuation] = f.check(Date.now() + 120_000);
  expect(continuation).toBeDefined();
  await f.orch.pump(f.lead.id);
  const ordinary = f.store.enqueue({ projectId: f.project.id, memberId: f.lead.id, taskId: unrelated.id, kind: "system", text: "Ordinary later instruction", wake: true });
  // Fixture models a separately verified completion racing with the pump.
  f.store.addStageMark({ projectId: f.project.id, taskId: task.id, stage: "done", evidence: "Independent fixture completion", memberId: f.lead.id, who: f.lead.name });
  await f.orch.pump(f.lead.id);
  expect(f.store.requireDelivery(continuation!.id).status).toBe("failed");
  expect(f.store.requireDelivery(ordinary.id)).toMatchObject({ status: "queued", attempts: 0 });
  expect(f.runner.to(f.lead)).toHaveLength(1);
});
