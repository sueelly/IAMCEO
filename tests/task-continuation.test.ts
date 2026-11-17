import { afterEach, expect, test } from "bun:test";
import { openDb } from "../server/db.ts";
import { Store } from "../server/store.ts";
import { Bus } from "../server/bus.ts";
import { TaskContinuationCoordinator } from "../server/task-continuation.ts";
import type { Delivery, Task } from "../shared/types.ts";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.db.close(); });
function fixture() {
  const store = new Store(openDb(":memory:"), new Bus()); stores.push(store);
  const project = store.createProject({ name: "후속 실행", cwd: process.cwd() });
  const lead = store.createMember({ projectId: project.id, handle: "lead", name: "총괄", kind: "conductor", origin: "runner", backend: "core", status: "idle", cwd: process.cwd(), sessionId: "lead-session", paneId: "lead-terminal" });
  const worker = store.createMember({ projectId: project.id, handle: "worker", name: "작성자", kind: "worker", origin: "runner", backend: "core", status: "idle", cwd: process.cwd(), sessionId: "worker-session", paneId: "worker-terminal" });
  const coordinator = () => new TaskContinuationCoordinator(store, { intervalMs: 1000, sameLimit: 3 });
  const next = coordinator();
  const start = Date.now() + 10000;
  const task = (name = "업무", legacy = true, parentTaskId?: string) => {
    const t = store.ensureSourceTask({ projectId: project.id, sourceRef: "test:" + name, title: name, origin: "owner", parentTaskId }).task;
    const input = store.enqueue({ projectId: project.id, memberId: worker.id, kind: "instruction", text: "요청한 결과를 검증하고 실제 반영해 주세요", taskId: t.id });
    store.markDelivered(input.id);
    if (legacy) store.db.query("DELETE FROM task_sequence WHERE task_id=?").run(t.id);
    return t;
  };
  const blocked = (t: Task) => store.createMessage({ projectId: project.id, taskId: t.id, memberId: worker.id, who: worker.name, kind: "막힘", title: "검토 실패", body: "실제 반영 조건이 남았습니다" });
  const finish = (d: Delivery, at: number) => {
    store.markDelivered(d.id);
    const stamp = new Date(at).toISOString();
    const recipient = store.requireMember(d.memberId);
    store.saveExecutionJournal({ runId: "run:" + d.id, memberId: d.memberId, projectId: d.projectId,
      identity: { terminalId: recipient.paneId, sessionId: recipient.sessionId, sessionGeneration: store.memberRevisions(recipient.id).sessionGeneration, process: null },
      turn: 1, deliveryIds: [d.id], phase: "ended", inputReceivedAt: stamp, startedAt: stamp, lastProgressAt: stamp, endedAt: stamp,
      result: "success", reason: null, exitCode: 0, interruptionNotifiedAt: null, reportRequestedAt: null, createdAt: stamp, updatedAt: stamp });
  };
  return { store, project, lead, worker, next, coordinator, task, blocked, finish, start };
}

test("an accepted old instruction with a failed review produces a task-scoped coordinator continuation", () => {
  const f = fixture(), t = f.task(); f.blocked(t);
  const queued = f.next.check(f.start, () => true);
  expect(queued).toHaveLength(1);
  expect(queued[0]).toMatchObject({ memberId: f.lead.id, taskId: t.id, kind: "system", wake: true, urgent: false });
  expect(queued[0]!.text).toContain("검토");
  expect(queued[0]!.text).toContain(t.id);
  expect(f.next.isContinuation(queued[0]!.id)).toBe(true);
  expect(f.store.taskProgress(t.id).stage).not.toBe("done");
});

test("a queued continuation is claimed once across repeated scans and a restarted coordinator", () => {
  const f = fixture(), t = f.task(); f.blocked(t);
  const queued = f.next.check(f.start, () => true); expect(queued).toHaveLength(1);
  expect(f.next.check(f.start + 60000, () => true)).toHaveLength(0);
  expect(f.coordinator().check(f.start + 120000, () => true)).toHaveLength(0);
  expect(f.store.listPending(f.lead.id)).toHaveLength(1);
});

test("an acknowledged report with unfinished conditions continues after the consumed turn and cooldown", () => {
  const f = fixture(), t = f.task(); f.blocked(t);
  const first = f.next.check(f.start, () => true)[0]!; expect(first).toBeDefined();
  f.store.markDelivered(first.id);
  expect(f.next.check(f.start + 2000, () => true)).toHaveLength(0); // Receipt alone is not a finished turn.
  f.finish(first, f.start + 2000);
  expect(f.next.check(f.start + 2500, () => true)).toHaveLength(0);
  const second = f.coordinator().check(f.start + 4000, () => true);
  expect(second).toHaveLength(1);
  expect(second[0]!.id).not.toBe(first.id);
});

test("bare task candidates, old answered history and server notices never become execution instructions", () => {
  const f = fixture(); f.task("old delivered without unfinished evidence");
  f.store.ensureSourceTask({ projectId: f.project.id, sourceRef: "candidate", title: "검토할 후보", origin: "owner" });
  f.store.ensureSourceTask({ projectId: f.project.id, sourceRef: "session:notice", title: "세션 안내", origin: "server" });
  expect(f.next.check(f.start, () => true)).toHaveLength(0);
});

test.each(["done", "hold"] as const)("a %s mark retires queued generated followup without falsifying a receipt", stage => {
  const f = fixture(), t = f.task(); f.blocked(t);
  const own = f.next.check(f.start, () => true)[0]!; expect(own).toBeDefined();
  f.store.addStageMark({ projectId: f.project.id, taskId: t.id, stage, evidence: "확인한 근거", memberId: f.lead.id, who: f.lead.name });
  expect(f.next.canDispatch(own)).toBe(false);
  expect(f.store.requireDelivery(own.id).status).toBe("failed");
  expect(f.store.requireDelivery(own.id).deliveredAt).toBeNull();
  expect(f.next.check(f.start + 100000, () => true)).toHaveLength(0);
});

test("new ordinary input supersedes a queued generated continuation while preserving the real instruction", () => {
  const f = fixture(), t = f.task(); f.blocked(t);
  const own = f.next.check(f.start, () => true)[0]!; expect(own).toBeDefined();
  const ordinary = f.store.enqueue({ projectId: f.project.id, memberId: f.worker.id, kind: "instruction", text: "수정 재개", taskId: t.id });
  expect(f.next.canDispatch(own)).toBe(false);
  expect(f.store.requireDelivery(ordinary.id)).toEqual(ordinary);
  expect(f.next.canDispatch(ordinary)).toBe(true);
});

test.each(["instruction", "system", "report"] as const)("existing %s work including report followups prevents duplicate continuation", kind => {
  const f = fixture(), t = f.task(); f.blocked(t);
  f.store.enqueue({ projectId: f.project.id, memberId: kind === "report" ? f.lead.id : f.worker.id, kind, text: "기존 후속 전달", taskId: t.id });
  expect(f.next.check(f.start, () => true)).toHaveLength(0);
});

test("the owner decision gate pauses followthrough without marking the task complete", () => {
  const f = fixture(), t = f.task(); f.blocked(t);
  f.store.createDecision({ projectId: f.project.id, taskId: t.id, memberId: f.lead.id, who: f.lead.name, title: "실제 범위 결정" });
  expect(f.next.check(f.start, () => true)).toHaveLength(0);
  expect(f.store.taskProgress(t.id).stage).toBe("owner");
});

test("persistent user stop cancels only the generated continuation and survives restart", () => {
  const f = fixture(), t = f.task(); f.blocked(t);
  const own = f.next.check(f.start, () => true)[0]!; expect(own).toBeDefined();
  f.next.pause([t.id], "stop-1", "대표가 직접 중단했습니다");
  expect(f.coordinator().canDispatch(own)).toBe(false);
  expect(f.coordinator().check(f.start + 10000, () => true)).toHaveLength(0);
  f.next.pause([t.id], "stop-2", "더 최근 중단");
  f.next.clearPause([t.id], "stop-1");
  expect(f.next.check(f.start + 20000, () => true)).toHaveLength(0);
  f.next.clearPause([t.id], "stop-2");
  expect(f.next.check(f.start + 30000, () => true)).toHaveLength(1);
});

test("no-progress retries become an actionable unresolved decision instead of infinite duplicate work or completion", () => {
  const f = fixture(), t = f.task(); f.blocked(t);
  let now = f.start;
  for (let i = 0; i < 3; i++) {
    const d = f.next.check(now, () => true)[0]!; expect(d).toBeDefined();
    f.finish(d, now + 100);
    f.store.patchMember(f.worker.id, { now: "같은 자기 보고 " + i }); // heartbeat must not count as progress.
    now += 10000;
  }
  expect(f.next.check(now, () => true)).toHaveLength(0);
  expect(f.store.listDecisions(f.project.id).filter(d => d.status === "open")).toHaveLength(1);
  expect(f.store.taskProgress(t.id).stage).toBe("owner");
  expect(f.coordinator().check(now + 10000, () => true)).toHaveLength(0);
  expect(f.store.listDecisions(f.project.id).filter(d => d.status === "open")).toHaveLength(1);
});

test("후속 조정 결재와 총괄 입력은 업무·원문 요청·최근 보고·완료 기준을 자체적으로 설명한다", () => {
  const f = fixture(), task = f.task("로그인 재개 오류 조사");
  const source = f.store.enqueue({ projectId: f.project.id, memberId: f.worker.id, taskId: task.id, kind: "user_message", text: "IAMCEO 로그인 재개 실패의 전달 기록을 조사하고 실패한 원본 세션을 구분해 주세요. 운영 재시작은 하지 마세요." });
  f.store.markDelivered(source.id);
  f.store.saveTaskContract(task.id, { kind: "research", goal: "로그인 재개 실패의 원인을 확인한다", acceptance: ["실패한 전달과 세션의 관계를 확인한다", "확인하지 못한 기록과 그 이유를 적는다"] }, { author: f.lead.name, authorMemberId: f.lead.id, authorKind: "conductor" });
  const report = f.store.createMessage({ projectId: f.project.id, taskId: task.id, memberId: f.worker.id, who: f.worker.name, kind: "막힘", title: "로그인 재개 실패의 세션 기록을 찾지 못했습니다", body: "전달 ID dl_login001의 입력 수신은 확인했습니다. 원본 세션의 종료 기록에 접근하지 못해 재개 실패 원인은 아직 미확인입니다." });
  let now = f.start;
  for (let i = 0; i < 3; i++) {
    const delivery = f.next.check(now, () => true)[0]!;
    expect(delivery.text).toContain(report.title);
    expect(delivery.text).toContain(report.body);
    f.finish(delivery, now + 100); now += 10000;
  }
  f.next.check(now, () => true);
  const decision = f.store.listDecisions(f.project.id).find(d => d.status === "open")!;
  for (const part of [f.project.name, task.title, source.text, source.createdAt, report.title, report.body, report.at, "실패한 전달과 세션의 관계를 확인한다"]) expect(decision.detail).toContain(part);
  expect(decision.detail).toContain("조정 요청 3회");
  expect(decision.detail).toContain("구현이나 검사 횟수");
  expect(decision.detail).toContain("실패 원인은 아직 미확인");
  expect(f.store.requireMessage(report.id)).toEqual(report);
  expect(f.store.requireDelivery(source.id).text).toBe(source.text);
  expect(f.store.taskProgress(task.id).stage).toBe("owner");
});

test("직원이 제안한 완료 기준을 확정 기준으로 표시하지 않고 누락된 보고를 추측하지 않는다", () => {
  const f = fixture(), task = f.task("확인 기준 정의", false);
  f.store.saveTaskContract(task.id, { kind: "other", goal: "원인 조사", acceptance: ["세션 종료 기록 확인"] }, { author: f.worker.name, authorMemberId: f.worker.id, authorKind: "worker" });
  let now = f.start;
  for (let i = 0; i < 3; i++) {
    const d = f.next.check(now, () => true)[0]!; expect(d).toBeDefined();
    f.finish(d, now + 100); now += 10000;
  }
  f.next.check(now, () => true);
  const detail = f.store.listDecisions(f.project.id).find(d => d.status === "open")!.detail;
  expect(detail).toContain("직원 제안");
  expect(detail).toContain("미확정");
  expect(detail).toContain("이 업무에 연결된 보고가 없습니다");
  expect(detail).not.toContain("확정된 완료 기준");
});

test("new completion evidence resets no-progress accounting and final done stops the cycle", () => {
  const f = fixture(), t = f.task(); f.blocked(t);
  let d = f.next.check(f.start, () => true)[0]!; expect(d).toBeDefined(); f.finish(d, f.start + 100);
  for (const [i, stage] of (["review", "merged", "applied"] as const).entries()) {
    f.store.addStageMark({ projectId: f.project.id, taskId: t.id, stage, evidence: stage + " 근거", memberId: f.lead.id, who: f.lead.name });
    d = f.next.check(f.start + (i + 1) * 10000, () => true)[0]!; expect(d).toBeDefined(); f.finish(d, f.start + (i + 1) * 10000 + 100);
  }
  f.store.addStageMark({ projectId: f.project.id, taskId: t.id, stage: "done", evidence: "모든 조건 확인", memberId: f.lead.id, who: f.lead.name });
  expect(f.next.check(f.start + 60000, () => true)).toHaveLength(0);
  expect(f.store.listDecisions(f.project.id)).toHaveLength(0);
});

test("stopping an uncertain original delivery cannot manufacture authority through sequence enrollment", () => {
  const f = fixture(), t = f.task("중단된 지시", false);
  const source = f.store.listDeliveries().find(d => d.taskId === t.id)!;
  f.store.markFailed(source.id, "추가 전달 중지");
  const recovery = f.store.getDeliveryRecovery(source.id)!;
  f.store.updateDeliveryRecovery(source.id, recovery.version, { phase: "stopped", reason: "session_lost" });
  f.blocked(t);
  expect(f.next.check(f.start, () => true)).toHaveLength(0);
});

test("an explicitly narrowed user resume supplies the latest scope instead of replaying the original broad instruction", () => {
  const f = fixture(), t = f.task(); f.blocked(t);
  f.next.pause([t.id], "stop", "대표 중단");
  const resume = f.store.enqueue({ projectId: f.project.id, memberId: f.lead.id, kind: "user_message", taskId: t.id,
    text: "지금은 원인 조사만 하세요. 구현과 배포는 하지 마세요." });
  f.store.markDelivered(resume.id);
  const own = f.next.check(f.start, () => true)[0]!;
  expect(own).toBeDefined();
  expect(own.text).toContain(resume.text);
  expect(own.text).not.toContain("원 지시 #undefined");
  expect(own.text).toContain("최신 대표 지시");
});

test("a long latest instruction keeps scope restrictions at the end in the continuation", () => {
  const f = fixture(), t = f.task(); f.blocked(t);
  const restriction = "마지막 범위 제한: 이번에는 조사만 하고 구현·배포하지 마세요.";
  const input = f.store.enqueue({ projectId: f.project.id, memberId: f.lead.id, kind: "user_message", taskId: t.id,
    text: "참고 자료입니다. ".repeat(1000) + restriction });
  f.store.markDelivered(input.id);
  const reminder = f.next.check(f.start, () => true)[0]!;
  expect(reminder).toBeDefined();
  expect(reminder.text).toContain(restriction);
});

test("missing criteria are assigned to the coordinator before delegating more implementation", () => {
  const f = fixture(), t = f.task(); f.blocked(t);
  expect(f.store.getEffectiveContract(t.id)).toBeNull();
  const reminder = f.next.check(f.start, () => true)[0]!;
  expect(reminder).toBeDefined();
  expect(reminder.text).toContain("완료 기준을 먼저 확정");
  expect(reminder.text).toContain("contract");
  expect(f.store.getEffectiveContract(t.id)).toBeNull(); // No invented criteria.
  expect(f.store.listPending(f.worker.id)).toHaveLength(0); // No replay.
});

test("a later owner decision narrowing scope is included with the original request", () => {
  const f = fixture(), t = f.task(); f.blocked(t);
  const decision = f.store.createDecision({ projectId: f.project.id, taskId: t.id, memberId: f.lead.id, who: "총괄", title: "남은 범위" });
  f.store.answerDecision(decision.id, { note: "지금은 조사 결과만 정리하고 구현과 배포는 하지 마세요." });
  const reminder = f.next.check(f.start, () => true)[0]!;
  expect(reminder).toBeDefined();
  expect(reminder.text).toContain(decision.id);
  expect(reminder.text).toContain("지금은 조사 결과만 정리하고 구현과 배포는 하지 마세요.");
});

test("a previously queued reminder with an uncertain physical send is never cancelled as if unsent", () => {
  const f = fixture(), t = f.task(); f.blocked(t);
  const own = f.next.check(f.start, () => true)[0]!; expect(own).toBeDefined();
  f.store.markHeld(own.id, "delivery_unknown");
  const recovery = f.store.getDeliveryRecovery(own.id)!;
  f.store.updateDeliveryRecovery(own.id, recovery.version, { phase: "checking", reason: "session_lost" });
  const before = f.store.requireDelivery(own.id);
  f.store.addStageMark({ projectId: f.project.id, taskId: t.id, stage: "done", evidence: "별도 경로에서 확인", memberId: f.lead.id, who: f.lead.name });
  expect(f.next.canDispatch(own)).toBe(false);
  expect(f.store.requireDelivery(own.id)).toEqual(before);
  expect(f.store.getDeliveryRecovery(own.id)?.phase).toBe("checking");
});

test("a stale queued object cannot retire a generated write that is now delivering", () => {
  const f = fixture(), t = f.task(); f.blocked(t);
  const stale = f.next.check(f.start, () => true)[0]!; expect(stale).toBeDefined();
  f.store.setDeliveryStatus(stale.id, "delivering");
  const before = f.store.requireDelivery(stale.id);
  f.next.pause([t.id], "stop", "대표 중단");
  expect(f.next.canDispatch(stale)).toBe(false);
  expect(f.store.requireDelivery(stale.id)).toEqual(before);
});

test("unrelated restored input that cannot be dispatched does not starve the project coordinator", () => {
  const f = fixture(), t = f.task(); f.blocked(t);
  const restored = f.store.enqueue({ projectId: f.project.id, memberId: f.lead.id, kind: "system", text: "복원 당시 이전 입력", status: "held", holdReason: "delivery_unknown" });
  const r = f.store.getDeliveryRecovery(restored.id)!;
  f.store.updateDeliveryRecovery(restored.id, r.version, { phase: "stopped", reason: "restore_reconciliation_required" });
  const queued = f.next.check(f.start, () => true);
  expect(queued).toHaveLength(1);
  expect(queued[0]!.taskId).toBe(t.id);
  expect(f.store.requireDelivery(restored.id)).toEqual(restored);
});

test.each(["done", "hold", "owner"] as const)("an ancestor's %s gate prevents resuming its already covered child", gate => {
  const f = fixture(), parent = f.task("parent"), child = f.task("child", false, parent.id);
  f.blocked(child);
  if (gate === "owner") f.store.createDecision({ projectId: f.project.id, taskId: parent.id, who: "총괄", title: "상위 범위 확인" });
  else f.store.addStageMark({ projectId: f.project.id, taskId: parent.id, stage: gate, evidence: "상위 업무의 확인 근거", memberId: f.lead.id, who: f.lead.name });
  expect(f.next.check(f.start, () => true)).toHaveLength(0);
});

test("a new explicit child request after ancestor completion can continue without replaying old child work", () => {
  const f = fixture(), parent = f.task("parent"), child = f.task("child", false, parent.id);
  f.blocked(child);
  f.store.addStageMark({ projectId: f.project.id, taskId: parent.id, stage: "done", evidence: "기존 범위 확인", memberId: f.lead.id, who: f.lead.name });
  expect(f.next.check(f.start, () => true)).toHaveLength(0);
  const newInput = f.store.enqueue({ projectId: f.project.id, memberId: f.worker.id, kind: "user_message", taskId: child.id, text: "자식 업무에서 새로 확인할 범위입니다" });
  f.store.markDelivered(newInput.id);
  const next = f.next.check(f.start + 2000, () => true);
  expect(next).toHaveLength(1);
  expect(next[0]!.taskId).toBe(child.id);
});

test.each(["queued", "running"] as const)("a multi-task report supplement with no task_id remains occupied while %s", phase => {
  const f = fixture(), parent = f.task("parent"), child = f.task("child", false, parent.id);
  f.blocked(parent); f.blocked(child);
  const inputs = f.store.listDeliveries().filter(d => d.kind === "instruction");
  f.finish(inputs[0]!, f.start - 5000);
  const template = f.store.getExecutionJournal("run:" + inputs[0]!.id)!;
  const run = { ...template, runId: "multi:" + template.runId, deliveryIds: inputs.map(d => d.id) };
  f.store.saveExecutionJournal(run);
  const supplement = f.store.enqueue({ projectId: f.project.id, memberId: f.worker.id, kind: "system", taskId: null, text: "두 업무의 결과만 보고하세요" });
  f.store.recordReportFollowup(run.runId, f.worker.id, f.project.id, supplement.id);
  if (phase === "running") {
    f.store.markDelivered(supplement.id);
    f.store.saveExecutionJournal({ ...template, runId: "supplement:" + supplement.id, deliveryIds: [supplement.id], phase: "running", endedAt: null, result: null });
  }
  expect(f.next.check(f.start, () => true)).toHaveLength(0);
});

test("reassigning identical downstream instructions does not reset the no-progress limit", () => {
  const f = fixture(), t = f.task(); f.blocked(t);
  const original = f.store.listDeliveries().find(d => d.taskId === t.id)!;
  let now = f.start;
  for (let i = 0; i < 3; i++) {
    const d = f.next.check(now, () => true)[0]!; expect(d).toBeDefined();
    f.finish(d, now + 100);
    const same = f.store.enqueue({ projectId: f.project.id, memberId: f.worker.id, kind: "instruction", text: original.text, taskId: t.id });
    f.store.markDelivered(same.id); now += 10000;
  }
  expect(f.next.check(now, () => true)).toHaveLength(0);
  expect(f.store.listDecisions(f.project.id).filter(d => d.status === "open")).toHaveLength(1);
});

test("an unrelated input at its rejection limit does not starve followthrough", () => {
  const f = fixture(), t = f.task(); f.blocked(t);
  const old = f.store.enqueue({ projectId: f.project.id, memberId: f.lead.id, kind: "system", text: "이전 지시", status: "held", holdReason: "input_busy" });
  f.store.patchDeliveryRetry(old.id, { retryReason: "rejected_limit" });
  expect(f.next.check(f.start, () => true)).toHaveLength(1);
  expect(f.store.requireDelivery(old.id)).toEqual(old);
});

test.each(["user_message", "reopen"] as const)("resuming an ancestor through %s releases inherited pauses without clearing independent child stops", resume => {
  const f = fixture(), parent = f.task("parent"), child = f.task("child", false, parent.id);
  f.blocked(parent); f.blocked(child);
  f.next.pause([parent.id], "parent-stop", "상위 업무 중단");
  if (resume === "user_message") {
    const d = f.store.enqueue({ projectId: f.project.id, memberId: f.lead.id, taskId: parent.id, kind: "user_message", text: "같은 범위에서 다시 이어가세요" }); f.store.markDelivered(d.id);
  } else f.store.addStageMark({ projectId: f.project.id, taskId: parent.id, stage: "reopen", evidence: "다시 진행할 근거", memberId: f.lead.id, who: f.lead.name });
  expect(f.store.taskContinuationPauses(f.project.id)).toHaveLength(0);
  f.next.pause([child.id], "child-stop", "이 하위 업무만 중단");
  f.store.addStageMark({ projectId: f.project.id, taskId: parent.id, stage: "reopen", evidence: "상위 재개", memberId: f.lead.id, who: f.lead.name });
  expect(f.store.taskContinuationPauses(f.project.id).map(p => p.taskId)).toEqual([child.id]);
});

test.each(["error", "interrupted"] as const)("a report supplement ended with %s does not occupy the task forever", result => {
  const f = fixture(), t = f.task(); f.blocked(t);
  const source = f.store.listDeliveries().find(d => d.taskId === t.id)!;
  f.finish(source, f.start - 5000);
  const root = f.store.getExecutionJournal("run:" + source.id)!;
  const supplement = f.store.enqueue({ projectId: f.project.id, memberId: f.worker.id, kind: "system", taskId: null, text: "결과만 보완" });
  f.store.recordReportFollowup(root.runId, f.worker.id, f.project.id, supplement.id);
  f.store.markDelivered(supplement.id);
  f.store.saveExecutionJournal({ ...root, runId: "supplement:" + supplement.id, deliveryIds: [supplement.id], phase: result === "error" ? "ended" : "interrupted", result });
  expect(f.next.check(f.start, () => true)).toHaveLength(1);
  expect(f.store.getReportFollowup(root.runId)?.settledAt).toBeNull(); // No fabricated successful report.
});

test.each(["pause", "done"] as const)("new owner input survives delivery deletion and reused SQLite rowids after %s", gate => {
  const f = fixture(), parent = f.task("parent"), child = f.task("child", false, parent.id); f.blocked(child);
  const temporary = f.store.createMember({ projectId: f.project.id, handle: "temp", name: "임시", kind: "worker", origin: "runner", backend: "core", status: "idle" });
  f.store.enqueue({ projectId: f.project.id, memberId: temporary.id, kind: "system", text: "삭제할 입력" });
  if (gate === "pause") f.next.pause([child.id], "stop", "직접 중단");
  else f.store.addStageMark({ projectId: f.project.id, taskId: parent.id, stage: "done", evidence: "기존 범위 확인", memberId: f.lead.id, who: f.lead.name });
  f.store.removeMember(temporary.id);
  const resume = f.store.enqueue({ projectId: f.project.id, memberId: f.worker.id, taskId: child.id, kind: "user_message", text: "새로 확인할 범위를 진행하세요" });
  f.store.markDelivered(resume.id);
  expect(f.next.check(f.start, () => true)).toHaveLength(1);
});
