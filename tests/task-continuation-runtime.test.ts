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
  const task = (title = "Finish approved implementation") => store.saveTask({ projectId: project.id, memberId: worker.id, who: worker.name,
    title, branch: "fixture/" + title.toLowerCase().replaceAll(" ", "-") }).task;
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

function approvedUnfinished(f: ReturnType<typeof fixture>, title?: string) {
  const task = f.task(title);
  const execution = { inputs: ["승인된 요청과 기존 결과"], outputs: ["검증한 결과"], scope: "승인된 업무의 남은 조건", constraints: [], exclusions: [] };
  f.store.saveTaskContract(task.id, { ...execution, kind: "other", goal: "승인된 결과를 완성한다", acceptance: ["남은 검증을 통과한다"], checks: [] },
    { author: f.lead.name, authorMemberId: f.lead.id, authorKind: "conductor" });
  const source = f.store.enqueue({ projectId: f.project.id, memberId: f.worker.id, taskId: task.id, kind: "instruction", text: "승인된 결과와 남은 검증을 완료하세요" });
  f.store.markDelivered(source.id);
  return task;
}

test("confirmed unfinished work reaches its worker through the real pump while the conductor reviews its report", async () => {
  const f = fixture(), task = approvedUnfinished(f);
  f.store.enqueue({ projectId: f.project.id, memberId: f.lead.id, taskId: task.id, kind: "report", text: "Review the partial outcome", wake: true });
  await f.orch.pump(f.lead.id);
  expect(f.pendingRun(f.lead)).toBeDefined();
  const scheduled = f.check(Date.now() + 120_000);
  expect(scheduled).toHaveLength(1);
  expect(scheduled[0]!.memberId).toBe(f.worker.id);
  await f.orch.pump(f.worker.id);
  expect(f.store.requireDelivery(scheduled[0]!.id).status).toBe("delivered");
  expect(f.pendingRun(f.worker)?.deliveryIds).toContain(scheduled[0]!.id);
  expect(f.pendingRun(f.lead)).toBeDefined();
  expect(f.check(Date.now() + 180_000)).toHaveLength(0);
});

async function startApprovedWork(f: ReturnType<typeof fixture>) {
  const task = approvedUnfinished(f);
  await f.orch.assign(f.project.id, f.worker.handle, { taskId: task.id, text: "Finish the remaining checks" });
  await until("worker received the assignment", () => !!f.pendingRun(f.worker));
  return task;
}

test("a worker records repair progress without a report-only turn and resumes the same task", async () => {
  const f = fixture(), task = await startApprovedWork(f);
  const interruptedRun = f.pendingRun(f.worker)!;
  await f.orch.recordPost(f.store.requireMember(f.worker.id), {
    taskId: task.id, kind: "진행", title: "Regression failure needs a local fix",
    body: "The owner of this assignment can repair the failing branch and rerun the check.",
    contractRev: 1, continueWork: true,
    checks: [{ name: "regression", kind: "regression", result: "fail", evidence: "Observed the regression failure" }],
  });
  expect(f.store.listMessages(f.project.id).filter(m => m.kind === "진행")).toHaveLength(0);
  expect(f.store.listDeliveries().filter(d => d.kind === "report")).toHaveLength(0);
  expect(f.store.latestTaskChecks(task.id)[0]?.evidence).toContain("regression failure");
  expect(f.pendingRun(f.worker)?.runId).toBe(interruptedRun.runId);
  await f.end(f.worker);
  expect(f.store.getReportFollowup(interruptedRun.runId)).toBeNull();
  expect(f.store.doneMark(task.id)).toBeNull();
  const [followup] = f.check(Date.now() + 120_000);
  expect(followup).toMatchObject({ memberId: f.worker.id, taskId: task.id });
  expect(followup!.text).toContain("Regression failure needs a local fix");
  expect(followup!.text).toContain("The owner of this assignment can repair the failing branch and rerun the check.");
  expect(followup!.text).toContain("Observed the regression failure");
  await f.orch.pump(f.worker.id);
  expect(f.pendingRun(f.worker)?.deliveryIds).toContain(followup!.id);
});

test("status carries repair evidence across turns without posting a report", async () => {
  const f = fixture(), task = await startApprovedWork(f);
  const worker = f.store.requireMember(f.worker.id);
  const changed = await f.orch.handleAgentTool(worker, "status", {
    now: "Rerunning the receipt check", next: "Verify the corrected field", task_id: task.id,
    continue_work: true, contract_rev: 1, checks: [{ kind: "regression", name: "receipt", result: "fail", evidence: "wrong receipt" }],
  });
  expect(changed.isError).toBeUndefined();
  const id = /#(cp_\w+)/.exec(changed.text)![1]!;
  expect(f.store.getMessage(id)).toBeNull();
  expect(f.store.requireMember(worker.id)).toMatchObject({ now: "Rerunning the receipt check", next: "Verify the corrected field" });
  const viaPost = await f.orch.handleAgentTool(worker, "post", { report_id: id });
  expect(JSON.parse(viaPost.text)).toMatchObject({ internal: true, continuesWork: true, checks: [{ name: "receipt" }] });
  expect(f.store.getTaskWatch(task.id)?.same).toBe(1);
  await f.end(worker);
  expect(f.check(Date.now() + 120_000)[0]).toMatchObject({ memberId: worker.id, taskId: task.id });
});

test("legacy progress can publish a real artifact while the same assignment continues", async () => {
  const f = fixture(), task = await startApprovedWork(f);
  const file = f.store.createFile({ projectId: f.project.id, taskId: task.id, title: "검토용 문서" });
  const receipt = await f.orch.recordPost(f.store.requireMember(f.worker.id), { taskId: task.id, kind: "진행",
    title: "검토용 문서 전달", body: "문서를 첨부하고 남은 검사를 이어 갑니다", fileIds: [file.id], contractRev: 1, continueWork: true });
  expect(f.store.requireMessage(receipt.id)).toMatchObject({ kind: "알림", taskId: task.id, fileId: file.id });
  expect(f.store.taskProgressFacts(task.projectId).get(task.id)?.reports.some(r => r.continuesWork)).toBe(true);
  expect(f.store.listMessages(task.projectId).some(m => m.kind === "진행")).toBe(false);
  await f.end(f.worker);
  expect(f.check(Date.now() + 120_000)[0]).toMatchObject({ taskId: task.id, memberId: f.worker.id });
});

test("a worker who returned without a result resumes authorized work before a report-only request", async () => {
  const f = fixture(), task = await startApprovedWork(f);
  const ended = f.pendingRun(f.worker)!;
  await f.end(f.worker);
  expect(f.store.getReportFollowup(ended.runId)).toBeNull();
  expect(f.check(Date.now() + 120_000)[0]).toMatchObject({ memberId: f.worker.id, taskId: task.id });
});

test("repair progress cannot claim a stale contract or another task from the same worker", async () => {
  const f = fixture(), active = await startApprovedWork(f);
  const outside = approvedUnfinished(f, "Different assigned work");
  expect(outside.id).not.toBe(active.id);
  const post = { kind: "진행" as const, title: "More work remains", contractRev: 1, continueWork: true };
  const worker = f.store.requireMember(f.worker.id);
  await expect(f.orch.recordPost(worker, { ...post, taskId: active.id, contractRev: 2 })).rejects.toThrow("확정 계약 판");
  await expect(f.orch.recordPost(worker, { ...post, taskId: outside.id })).rejects.toThrow("지금 받은 직원 업무");
  expect(f.store.listReportClosures(worker.id, "").filter(r => r.kind === "continuing")).toHaveLength(0);
});

test("a received execution can keep working, but its quiet context cannot authorize work", async () => {
  const f = fixture(), active = await startApprovedWork(f);
  const quiet = f.orch.saveTask(f.lead, { title: "Quiet context belongs to another task", contract: f.store.getEffectiveContract(active.id)! }).task;
  const delivery = f.store.enqueue({ projectId: f.project.id, memberId: f.worker.id, kind: "system",
    taskId: quiet.id, text: "Context only", wake: false });
  f.store.markDelivered(delivery.id);
  const run = f.pendingRun(f.worker)!;
  const at = new Date().toISOString();
  f.store.saveExecutionJournal({ ...run, phase: "running", inputReceivedAt: at, updatedAt: at, deliveryIds: [...run.deliveryIds, delivery.id] });
  const worker = f.store.requireMember(f.worker.id);
  await expect(f.orch.recordPost(worker, {
    taskId: quiet.id, kind: "진행", title: "Continue quiet context", contractRev: 1, continueWork: true,
  })).rejects.toThrow("지금 받은 직원 업무");
  await f.orch.recordPost(worker, {
    taskId: active.id, kind: "진행", title: "Continue the accepted assignment", contractRev: 1, continueWork: true,
  });
  expect(f.store.listReportClosures(worker.id, "").filter(closure => closure.kind === "continuing")).toHaveLength(1);
});

test("an input still awaiting receipt cannot authorize a repair report", async () => {
  const f = fixture(), task = await startApprovedWork(f);
  const [deliveryId] = f.pendingRun(f.worker)!.deliveryIds;
  f.store.db.query("UPDATE deliveries SET status='delivering', delivered_at=NULL WHERE id=?").run(deliveryId!);
  await expect(f.orch.recordPost(f.store.requireMember(f.worker.id), {
    taskId: task.id, kind: "진행", title: "Continue an unconfirmed assignment", contractRev: 1, continueWork: true,
  })).rejects.toThrow("지금 받은 직원 업무");
});

test("an external blocker after progress does not count the same execution twice", async () => {
  const f = fixture(), task = await startApprovedWork(f);
  const worker = f.store.requireMember(f.worker.id);
  const post = { taskId: task.id, title: "Regression failed", contractRev: 1,
    checks: [{ name: "regression", kind: "regression" as const, result: "fail" as const, evidence: "Assertion failed" }] };
  const early = await f.orch.recordPost(worker, { ...post, kind: "진행" });
  await f.orch.recordPost(worker, { ...post, kind: "진행", continueWork: true, correctsMessageId: early.id });
  expect(f.store.getTaskWatch(task.id)).toBeNull();
  await f.orch.recordPost(worker, { ...post, kind: "진행", continueWork: true });
  expect(f.store.getTaskWatch(task.id)?.same).toBe(1);
  await f.orch.recordPost(worker, { ...post, kind: "막힘", body: "Another owner must change the service." });
  expect(f.store.getTaskWatch(task.id)?.same).toBe(1);
  await until("conductor receives the blocker", () => !!f.pendingRun(f.lead));
});

test("progress following an authorized legacy retry resets the previous intervention", async () => {
  const f = fixture(), task = approvedUnfinished(f);
  const stoppedAt = "2026-01-01T00:00:00.000Z";
  const reason = "같은 실패 3번";
  f.store.saveTaskWatch(task.projectId, task.id, { startedAt: stoppedAt, lastProgressAt: stoppedAt, updatedAt: stoppedAt, trippedAt: stoppedAt,
    attempts: 3, same: 3, reason, fingerprint: "regression", history: [] });
  const decision = f.store.createDecision({ projectId: f.project.id, taskId: task.id, memberId: f.lead.id, who: f.lead.name, title: "Approve a different approach" });
  f.store.db.query("INSERT INTO task_failure_escalations(task_id, decision_id, tripped_at, created_at) VALUES(?,?,?,?)")
    .run(task.id, decision.id, stoppedAt, stoppedAt);
  f.store.answerDecision(decision.id, { note: "Retry within the same approved scope." });
  await f.orch.assign(f.project.id, f.worker.handle, { taskId: task.id, text: "Use the newly approved approach" });
  await until("worker received the agreed retry", () => !!f.pendingRun(f.worker));
  await f.orch.recordPost(f.store.requireMember(f.worker.id), {
    taskId: task.id, kind: "진행", title: "New approach in progress", contractRev: 1, continueWork: true,
  });
  expect(f.store.getTaskWatch(task.id)?.trippedAt).toBeNull();
  await f.end(f.worker);
  expect(f.check(Date.now() + 120_000)[0]).toMatchObject({ taskId: task.id, memberId: f.worker.id });
});

test("a newly reopened worker task cannot be manually closed using the previous pass", async () => {
  const f = fixture();
  const task = f.orch.saveTask(f.lead, { title: "Validate the current handoff", contract: {
    kind: "other", goal: "Verify the handoff", scope: "This handoff", inputs: ["Request"], outputs: ["Verified handoff"],
    constraints: [], exclusions: [], acceptance: ["The recipient is present"], checks: [],
  } }).task;
  await f.orch.assign(f.project.id, f.worker.handle, { taskId: task.id, text: "Verify the agreed handoff" });
  await until("worker received the handoff", () => !!f.pendingRun(f.worker));
  const witness = [{ name: "recipient", kind: "other" as const, result: "pass" as const, criterion: 1, evidence: "Verified recipient" }];
  const worker = f.store.requireMember(f.worker.id);
  const passed = { taskId: task.id, kind: "완료" as const, title: "Verified the handoff", contractRev: 1, checks: witness };
  await f.orch.recordPost(worker, passed);
  expect(f.store.taskProgress(task.id).finalReview?.status).toBe("pending");
  await f.orch.recordPost(worker, { taskId: task.id, kind: "진행", title: "Repair the recipient entry", contractRev: 1, continueWork: true });
  expect(f.store.doneMark(task.id)).toBeNull();
  await expect(f.orch.recordPost(f.lead, { taskId: task.id, kind: "완료", title: "Use previous evidence" })).rejects.toThrow("원 담당자");
  expect(() => f.orch.markTaskStage(f.lead, { taskId: task.id, stage: "done", evidence: "Previous pass" })).toThrow("원 담당자");
  await f.orch.recordPost(worker, { ...passed, title: "Verified the corrected handoff" });
  expect(f.store.taskProgress(task.id).finalReview?.status).toBe("pending");
});

test("one repairable failure per execution counts and the third execution escalates to the conductor", async () => {
  const f = fixture(), task = await startApprovedWork(f);
  const postFailure = (title: string) => f.orch.recordPost(f.store.requireMember(f.worker.id), {
    taskId: task.id, kind: "진행", title, body: "The assigned regression failed and remains within scope.",
    contractRev: 1, continueWork: true,
    checks: [{ name: "regression", kind: "regression", result: "fail", evidence: "The assigned assertion still fails" }],
  });
  for (let attempt = 1; attempt <= 3; attempt++) {
    await postFailure("The repair still has a failing regression");
    if (attempt === 1) await postFailure("Updated evidence for the same execution");
    expect(f.store.getTaskWatch(task.id)?.same).toBe(attempt);
    await f.end(f.worker);
    if (attempt === 3) break;
    const [followup] = f.check(Date.now() + attempt * 120_000);
    expect(followup).toMatchObject({ memberId: f.worker.id, taskId: task.id });
    await f.orch.pump(f.worker.id);
  }
  expect(f.store.getTaskWatch(task.id)?.reason).toContain("같은 실패 3번");
  expect(f.store.listDeliveries().filter(d => d.memberId === f.lead.id && d.text.includes("반복 감시:"))).toHaveLength(1);
  expect(f.check(Date.now() + 600_000)).toHaveLength(0);
});

test("newly passed criteria are progress across multiple worker executions", async () => {
  const f = fixture(), task = approvedUnfinished(f);
  const first = f.store.getEffectiveContract(task.id)!;
  const acceptance = ["Check input", "Check edges", "Check UI", "Check history", "Verify the handoff"];
  f.store.saveTaskContract(task.id, { ...first, acceptance }, { author: f.lead.name, authorMemberId: f.lead.id, authorKind: "conductor" });
  await f.orch.assign(f.project.id, f.worker.handle, { taskId: task.id, text: "Verify each agreed criterion" });
  await until("worker received the assignment", () => !!f.pendingRun(f.worker));
  for (let count = 1; count <= 4; count++) {
    await f.orch.recordPost(f.store.requireMember(f.worker.id), { kind: "진행", taskId: task.id, title: "New criterion passed",
      continueWork: true, contractRev: 2, checks: acceptance.slice(0, count).map((name, i) => ({
        name, kind: "other", result: "pass", criterion: i + 1, evidence: "Checked in this worktree",
      })),
    });
    await f.end(f.worker);
    const [followup] = f.check(Date.now() + count * 120_000);
    expect(followup).toMatchObject({ taskId: task.id, memberId: f.worker.id });
    await f.orch.pump(f.worker.id);
  }
  expect(f.store.getTaskWatch(task.id)).toBeNull();
});

test("an external blocker with failed checks still wakes the conductor immediately", async () => {
  const f = fixture(), task = await startApprovedWork(f);
  await f.orch.recordPost(f.store.requireMember(f.worker.id), {
    taskId: task.id, kind: "막힘", title: "An external owner must change the service",
    body: "Handoff to the contract owner is required.", contractRev: 1,
    checks: [{ name: "regression", kind: "regression", result: "fail", evidence: "The required service contract is unavailable" }],
  });
  await f.end(f.worker);
  await until("conductor receives the blocker", () => !!f.pendingRun(f.lead));
  expect(f.check(Date.now() + 120_000)).toHaveLength(0);
  expect(f.runner.to(f.worker)).toHaveLength(1);
});

test.each(["approval", "manual-control", "unknown-write", "usage-limit"] as const)("worker continuation respects its recipient's %s fence", async fence => {
  const f = fixture(), task = approvedUnfinished(f);
  if (fence === "approval") f.store.patchMember(f.worker.id, { status: "blocked", blockedReason: "permission" });
  if (fence === "manual-control") f.store.saveLease({ memberId: f.worker.id, claimId: "manual-claim", leaseId: "manual-lease",
    identity: { terminalId: f.worker.paneId, sessionId: f.worker.sessionId, sessionGeneration: 0, process: null }, expiresAt: Date.now() + 180_000, lastInputSequence: 0 });
  if (fence === "unknown-write") {
    const input = f.store.enqueue({ projectId: f.project.id, memberId: f.worker.id, kind: "system", text: "Unknown physical write", wake: false });
    const dispatch = f.orch.deliveryRecovery.prepareDispatch([input.id], { terminalId: f.worker.paneId, sessionId: f.worker.sessionId, sessionGeneration: 0, process: null },
      { serverEpoch: "worker-continuation", turn: 0, inputEpoch: 0, logs: [], capturedAt: new Date().toISOString() });
    f.store.updateDispatch(dispatch.dispatchId, "prepared", "unknown");
  }
  if (fence === "usage-limit") f.store.patchMember(f.worker.id, { lastError: "weekly usage limit reached" });
  const scheduled = f.check(Date.now() + 120_000);
  await f.orch.pump(f.worker.id);
  expect(f.runner.to(f.worker)).toHaveLength(0);
  expect(f.store.doneMark(task.id)).toBeNull();
  if (fence !== "usage-limit") expect(scheduled).toHaveLength(0);
});

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
