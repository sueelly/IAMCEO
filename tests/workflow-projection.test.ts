import { deriveProgress } from "../server/task-progress.ts";
import { expect, test } from "bun:test";
import { fixture } from "./fixtures/harness-fixture.ts";
import { buildWorkflow } from "../server/workflow.ts";
import { TaskContinuationCoordinator } from "../server/task-continuation.ts";
import type { TaskStage } from "../shared/types.ts";

type F = ReturnType<typeof fixture>;
const task = (f: F, title: string) => f.store.ensureSourceTask({ projectId: f.project.id, sourceRef: `projection:${title}`, title, origin: "owner" }).task;
const assign = (f: F, taskId: string) => f.store.enqueue({ projectId: f.project.id, memberId: f.worker.id, taskId, kind: "instruction", text: "승인된 지시", wake: true });

test.each([
  ["fix", "blocked"], ["confirm", "review"], ["check", "blocked"], ["hold", "blocked"],
  ["delivered", "review"], ["review", "review"], ["merge", "review"], ["merged", "review"], ["applied", "review"],
] as const)("an unfinished %s outcome stays visible without old sequence enrollment", (stage, state) => {
  const f = fixture(), t = task(f, stage);
  const d = assign(f, t.id); f.store.markDelivered(d.id);
  f.store.db.query("DELETE FROM task_sequence WHERE task_id = ?").run(t.id);
  const progress = { ...f.store.taskProgress(t.id), stage: stage as TaskStage, next: "총괄이 남은 확인을 이어갈 차례" };
  const node = f.store.projectWorkflow(f.project.id, [{ ...t, progress }]).nodes[0]!;
  expect(node).toMatchObject({ state, historical: false });
  expect(node.label).not.toBe("이전 업무");
  expect(node.reason).toContain("남은 확인");
  expect(f.store.listDeliveries()).toEqual([f.store.requireDelivery(d.id)]);
  expect(f.store.db.query("SELECT * FROM task_sequence WHERE task_id = ?").all(t.id)).toEqual([]);
});

test("a self report establishes participation even after a notice, without making the registrar or report recipient an assignee", () => {
  const f = fixture();
  const t = f.store.saveTask({ projectId: f.project.id, memberId: f.lead.id, who: f.lead.name, title: "직원이 직접 수행한 보완" }).task;
  f.store.createMessage({ projectId: f.project.id, taskId: t.id, memberId: f.worker.id, who: f.worker.name, kind: "진행", title: "회귀 확인 중", body: "남은 검사를 진행합니다" });
  f.store.createMessage({ projectId: f.project.id, taskId: t.id, memberId: f.worker.id, who: f.worker.name, kind: "알림", title: "기록 보관", body: "참조 알림" });
  f.store.enqueue({ projectId: f.project.id, taskId: t.id, memberId: f.lead.id, kind: "report", text: "회귀 확인 중", wake: true });
  const nodes = f.store.projectWorkflow(f.project.id).nodes;
  expect(nodes).toHaveLength(1);
  expect(nodes[0]).toMatchObject({ memberId: f.worker.id, assignmentSource: "report", historical: false });
  expect(nodes[0]!.lastActivity?.title).toBe("기록 보관");
  expect(f.store.taskSequenceBlocker(f.worker.id, "another-task")).toBeNull();
});

test("registrar and notification authors alone do not establish assignment", () => {
  const f = fixture();
  const t = f.store.saveTask({ projectId: f.project.id, memberId: f.worker.id, who: f.worker.name, title: "등록만 한 후보" }).task;
  f.store.createMessage({ projectId: f.project.id, taskId: t.id, memberId: f.lead.id, who: f.lead.name, kind: "알림", title: "참조", body: "미착수 후보" });
  expect(f.store.projectWorkflow(f.project.id).nodes[0]!.memberId).toBeNull();
});

test("board ownership uses an exact unique member, preserves hold and does not parse compound or duplicate names", () => {
  const f = fixture();
  const single = f.store.upsertWork({ projectId: f.project.id, title: "담당이 정해진 예정", sec: "next", who: f.worker.name });
  const hold = f.store.upsertWork({ projectId: f.project.id, title: "보류한 계획", sec: "hold", who: f.worker2.name });
  const compound = f.store.upsertWork({ projectId: f.project.id, title: "여러 담당 후보", sec: "next", who: `${f.worker.name}·${f.worker2.name}` });
  const nodes = f.store.projectWorkflow(f.project.id).nodes;
  expect(nodes.find(n => n.taskId === `tk_${single.id}`)).toMatchObject({ memberId: f.worker.id, assignmentSource: "board", current: false });
  expect(nodes.find(n => n.taskId === `tk_${hold.id}`)).toMatchObject({ memberId: f.worker2.id, state: "blocked", label: "보류" });
  expect(nodes.find(n => n.taskId === `tk_${compound.id}`)!.memberId).toBeNull();
  const ambiguous = buildWorkflow(f.store.listTasks(f.project.id), [f.worker, { ...f.worker2, name: f.worker.name }], [], [], Date.now(), [], f.store.listWork(f.project.id));
  expect(ambiguous.nodes.find(n => n.taskId === `tk_${single.id}`)!.memberId).toBeNull();
  expect(f.store.db.query("SELECT * FROM task_sequence").all()).toEqual([]);
});

test("completed board-only records and server session notices are not an unassigned backlog", () => {
  const f = fixture();
  const board = f.store.upsertWork({ projectId: f.project.id, title: "옛 완료 기록", sec: "doing", who: "과거 담당" });
  f.store.upsertWork({ ...board, sec: "done" });
  const notice = f.store.ensureSourceTask({ projectId: f.project.id, sourceRef: "session-notice", title: "직원 세션 알림", origin: "server" }).task;
  f.store.createMessage({ projectId: f.project.id, taskId: notice.id, kind: "시스템", title: "세션 연결", body: "상태 알림" });
  expect(f.store.projectWorkflow(f.project.id).nodes).toEqual([]);
  expect(f.store.listTasks(f.project.id).map(t => t.id)).toContain(notice.id);
  expect(f.store.listWork(f.project.id)[0]!.sec).toBe("done");
});

test("a newer unresolved report survives a board completion record", () => {
  const f = fixture();
  const board = f.store.upsertWork({ projectId: f.project.id, title: "완료 뒤 발견한 문제", sec: "doing", who: f.worker.name });
  f.store.upsertWork({ ...board, sec: "done" });
  f.store.db.query("UPDATE work SET done_at = '2000-01-01T00:00:00.000Z', updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(board.id);
  f.store.createMessage({ projectId: f.project.id, taskId: `tk_${board.id}`, memberId: f.worker.id, who: f.worker.name, kind: "막힘", title: "남은 확인", body: "검증이 끝나지 않았습니다" });
  expect(f.store.projectWorkflow(f.project.id).nodes[0]).toMatchObject({ memberId: f.worker.id, historical: false, state: "review", label: "미확인 항목" });
});

test("a manually completed linked board row cannot hide its unfinished modern task", () => {
  const f = fixture(), t = task(f, "완료 검증이 없는 연결 업무");
  f.store.upsertWork({ projectId: f.project.id, taskId: t.id, title: t.title, sec: "done", who: f.worker.name });
  expect(f.store.projectWorkflow(f.project.id).nodes.find(n => n.taskId === t.id)).toBeDefined();
  expect(f.store.taskProgress(t.id).stage).toBe("new");
});

test("explicitly stopping retries remains visible when its delivery is marked failed", async () => {
  const f = fixture(), t = task(f, "명시적으로 멈춘 입력");
  const d = assign(f, t.id);
  const recovery = f.store.getDeliveryRecovery(d.id)!;
  const pending = f.store.updateDeliveryRecovery(d.id, recovery.version, { phase: "needs_owner", reason: "session_lost" });
  await f.orch.deliveryRecovery.recover(d.id, { operationId: crypto.randomUUID(), expectedVersion: pending.version, action: "stop_retry" });
  expect(f.store.requireDelivery(d.id).status).toBe("failed");
  expect(f.store.projectWorkflow(f.project.id).nodes[0]).toMatchObject({ state: "blocked", label: "추가 전달 중지", inputBlock: { deliveryId: d.id, phase: "stopped" } });
});

test("a proven refusal with retry-limit hold offers delivery inspection instead of a closed-input explanation", () => {
  const f = fixture(), t = task(f, "입력 전 거절 한도");
  const d = f.store.enqueue({ projectId: f.project.id, taskId: t.id, memberId: f.worker.id, kind: "instruction", text: "입력 전 거절", status: "held", holdReason: "input_busy" });
  const dispatch = f.orch.deliveryRecovery.prepareDispatch([d.id], { terminalId: f.worker.paneId, sessionId: f.worker.sessionId, sessionGeneration: 0, process: null },
    { serverEpoch: "projection-test", turn: 0, inputEpoch: 0, logs: [], capturedAt: new Date().toISOString() });
  f.store.updateDispatch(dispatch.dispatchId, "prepared", "rejected");
  const recovery = f.store.getDeliveryRecovery(d.id)!;
  f.store.updateDeliveryRecovery(d.id, recovery.version, { phase: "resolved", reason: "not_received" });
  f.store.patchDeliveryRetry(d.id, { retryReason: "rejected_limit" });
  const node = f.store.projectWorkflow(f.project.id).nodes[0]!;
  expect(node.label).toBe("전달 재시도 한도");
  expect(node.reason).toContain("입력 전에");
  expect(node.action?.tab).toBe("team");
});

test.each([
  ["stopped", "restore_reconciliation_required", "복원 확인 필요", "복원"],
  ["stopped", null, "추가 전달 중지", "중지"],
  ["needs_owner", "session_lost", "수신 확인 필요", "세션"],
  ["checking", "inflight_unsettled", "수신 확인 중", "확인"],
] as const)("input protection explains %s/%s without changing delivery or recovery", (phase, reason, label, explanation) => {
  const f = fixture(), t = task(f, `${phase}:${reason}`);
  const d = f.store.enqueue({ projectId: f.project.id, memberId: f.worker.id, taskId: t.id, kind: "instruction", text: "원래 지시", status: "held", holdReason: "delivery_unknown" });
  const recovery = f.store.getDeliveryRecovery(d.id)!;
  f.store.updateDeliveryRecovery(d.id, recovery.version, { phase, reason });
  const before = f.store.getDeliveryRecovery(d.id);
  const node = f.store.projectWorkflow(f.project.id).nodes[0]!;
  expect(node.label).toBe(label);
  expect(node.reason).toContain(explanation);
  expect(node.inputBlock).toMatchObject({ deliveryId: d.id, phase, reason });
  expect(node.action?.tab).toBe(phase === "stopped" ? "thread" : "team");
  expect(f.store.getDeliveryRecovery(d.id)).toEqual(before);
  expect(f.store.requireDelivery(d.id).status).toBe("held");
});

test("an active stage without a matched employee is not reduced to assignment pending", () => {
  const f = fixture(), t = task(f, "담당 재확인이 필요한 막힘");
  const progress = { ...f.store.taskProgress(t.id), stage: "fix" as const, next: "기존 담당의 보완과 재검사가 남았습니다" };
  expect(buildWorkflow([{ ...t, progress }], [f.worker], [], []).nodes[0]).toMatchObject({ memberId: null, state: "blocked", label: "검사 실패", reason: progress.next });
});

test("a verified coordinator continuation appears on its actual recipient even without an earlier owner input to the coordinator", () => {
  const f = fixture();
  const t = f.store.saveTask({ projectId: f.project.id, memberId: f.worker.id, who: f.worker.name, title: "작성자 업무의 후속 조정" }).task;
  f.store.markDelivered(assign(f, t.id).id);
  f.store.createMessage({ projectId: f.project.id, taskId: t.id, memberId: f.worker.id, who: f.worker.name, kind: "막힘", title: "검토가 남음", body: "남은 조건을 확인해야 합니다" });
  const coordinator = new TaskContinuationCoordinator(f.store, { intervalMs: 1_000, sameLimit: 3 });
  const [d] = coordinator.check(Date.now() + 10_000, () => true);
  expect(d).toMatchObject({ memberId: f.lead.id, taskId: t.id, kind: "system" });
  f.store.markDelivered(d!.id);
  const at = new Date().toISOString();
  f.store.saveExecutionJournal({ runId: "projection-continuation", memberId: f.lead.id, projectId: f.project.id,
    identity: { terminalId: f.lead.paneId, sessionId: f.lead.sessionId, sessionGeneration: 0, process: null },
    turn: 1, deliveryIds: [d!.id], phase: "running", inputReceivedAt: at, startedAt: at, lastProgressAt: at,
    endedAt: null, result: null, reason: null, exitCode: null, interruptionNotifiedAt: null, reportRequestedAt: null, createdAt: at, updatedAt: at });
  f.store.patchMember(f.lead.id, { status: "working", statusObservation: { source: "core", observedAt: at, freshness: "fresh", ownership: "verified", consecutiveFailures: 0, error: null } });
  const node = f.store.projectWorkflow(f.project.id).nodes.find(n => n.taskId === t.id && n.memberId === f.lead.id);
  expect(node).toMatchObject({ memberId: f.lead.id, current: true, state: "running", historical: false, assignmentSource: "delivery" });
  expect(f.store.db.query("SELECT 1 FROM task_sequence WHERE task_id = ? AND member_id = ?").get(t.id, f.lead.id)).toBeNull();
});

test("only registered continuation input adds assignment evidence and it does not become a worker sequence prerequisite", () => {
  const f = fixture(), registered = task(f, "등록된 후속 입력"), unrelated = task(f, "일반 시스템 알림"), next = task(f, "작업자의 다음 업무");
  const d = f.store.enqueue({ projectId: f.project.id, memberId: f.worker.id, taskId: registered.id, kind: "system", text: "후속 확인", wake: true });
  f.store.db.query("INSERT INTO task_continuation_deliveries(delivery_id,task_id,round,created_at) VALUES(?,?,?,?)").run(d.id, registered.id, 1, d.createdAt);
  // Even unrelated sequence metadata must not promote system input into the instruction ordering policy.
  f.store.db.query("INSERT INTO task_sequence(member_id,task_id,entered_at) VALUES(?,?,?)").run(f.worker.id, registered.id, d.createdAt);
  f.store.enqueue({ projectId: f.project.id, memberId: f.worker.id, taskId: unrelated.id, kind: "system", text: "참조 알림", wake: true });
  assign(f, next.id);
  const nodes = f.store.projectWorkflow(f.project.id).nodes;
  expect(nodes.find(n => n.taskId === registered.id && n.memberId === f.worker.id)).toBeDefined();
  expect(nodes.find(n => n.taskId === unrelated.id)!.memberId).toBeNull();
  expect(f.store.taskSequenceBlocker(f.worker.id, next.id)).toBeNull();
  f.store.db.query("UPDATE task_continuation_deliveries SET retired_reason='새 지시가 우선함' WHERE delivery_id=?").run(d.id);
  f.store.markFailed(d.id, "취소된 후속 입력");
  expect(f.store.projectWorkflow(f.project.id).nodes.find(n => n.taskId === registered.id)!.memberId).toBeNull();
});

test.each(["막힘", "완료"] as const)("a later legacy board completion archives its earlier %s report without inventing a verified completion", kind => {
  const f = fixture();
  const board = f.store.upsertWork({ projectId: f.project.id, title: `예전 ${kind} 기록`, sec: "doing", who: "이전 직원" });
  f.store.createMessage({ projectId: f.project.id, taskId: `tk_${board.id}`, memberId: null, who: "이전 직원", kind, title: "당시 보고", body: "이전 결과", at: "2000-01-01T00:00:00.000Z" });
  f.store.upsertWork({ ...board, sec: "done" });
  expect(f.store.projectWorkflow(f.project.id).nodes.find(n => n.taskId === `tk_${board.id}`)).toBeUndefined();
  expect(f.store.doneMark(`tk_${board.id}`)).toBeNull();
  expect(f.store.listTasks(f.project.id).some(t => t.id === `tk_${board.id}`)).toBe(true);
});

test("a persisted owner pause remains visible through reports and other inputs until a same-task owner instruction or reopen", () => {
  const f = fixture(), t = task(f, "대표가 중단한 미완료 업무"), other = task(f, "별도 업무");
  f.store.markDelivered(assign(f, t.id).id);
  const coordinator = new TaskContinuationCoordinator(f.store, { intervalMs: 1_000, sameLimit: 3 });
  coordinator.pause([t.id], "projection-stop", "대표가 이 업무의 실행을 중단했습니다");
  f.store.createMessage({ projectId: f.project.id, taskId: t.id, memberId: f.worker.id, who: f.worker.name, kind: "진행", title: "늦게 온 보고", body: "중단 전 기록" });
  f.store.enqueue({ projectId: f.project.id, taskId: other.id, memberId: f.lead.id, kind: "user_message", text: "다른 업무 지시", wake: true });
  assign(f, t.id); // An employee instruction cannot override the owner's stop.
  const before = f.store.db.query("SELECT * FROM task_continuations WHERE task_id=?").get(t.id);
  const paused = f.store.projectWorkflow(f.project.id).nodes.find(n => n.taskId === t.id)!;
  expect(paused).toMatchObject({ state: "blocked", label: "대표가 중단", historical: false });
  expect(paused.reason).toContain("이 업무의 실행을 중단");
  expect(f.store.db.query("SELECT * FROM task_continuations WHERE task_id=?").get(t.id)).toEqual(before);
  f.store.enqueue({ projectId: f.project.id, taskId: t.id, memberId: f.worker.id, kind: "user_message", text: "이 업무를 다시 진행해 주세요", wake: true });
  expect(f.store.projectWorkflow(f.project.id).nodes.find(n => n.taskId === t.id)!.label).not.toBe("대표가 중단");
  coordinator.pause([t.id], "projection-stop-again", "대표가 다시 중단했습니다");
  f.store.addStageMark({ projectId: f.project.id, taskId: t.id, stage: "reopen", evidence: "대표의 재개 지시 확인", memberId: f.lead.id, who: f.lead.name });
  expect(f.store.projectWorkflow(f.project.id).nodes.find(n => n.taskId === t.id)!.label).not.toBe("대표가 중단");
});

test("an earlier worker task cannot overwrite the explicit owner stop on a later task", () => {
  const f = fixture(), first = task(f, "먼저 맡은 업무"), paused = task(f, "뒤에 맡았다 중단한 업무");
  assign(f, first.id); assign(f, paused.id);
  new TaskContinuationCoordinator(f.store, { intervalMs: 1_000, sameLimit: 3 }).pause([paused.id], "projection-later-stop", "대표가 후속 업무를 중단했습니다");
  expect(f.store.projectWorkflow(f.project.id).nodes.find(n => n.taskId === paused.id)).toMatchObject({ state: "blocked", label: "대표가 중단" });
});

test("an open owner request stays visible on its own task, including on a held board card", async () => {
  const f = fixture(), parent = task(f, "대표가 처리할 원 업무"), child = task(f, "선행 결정을 기다리는 업무");
  f.store.db.query("UPDATE tasks SET parent_task_id=? WHERE id=?").run(parent.id, child.id);
  assign(f, child.id);
  const todo = await f.tool(f.worker, "todo", { task_id: parent.id, title: "도메인 인증 기록 변경" });
  expect(todo.isError).toBeUndefined();
  f.store.addStageMark({ projectId: f.project.id, taskId: parent.id, stage: "hold", evidence: "별도 선행 결과 대기", memberId: f.lead.id, who: f.lead.name });
  const nodes = f.store.projectWorkflow(f.project.id).nodes;
  expect(nodes.find(n => n.taskId === parent.id)).toMatchObject({ ownerActionRequired: true, memberId: null, action: { tab: "home", sub: f.store.listTodos(f.project.id)[0]!.id } });
  expect(nodes.find(n => n.taskId === child.id)).toMatchObject({ ownerActionRequired: false });
  expect(f.store.taskProgress(parent.id).stage).toBe("hold");
});

test("one owner's delivery exception remains visible among ordinary, stopped and checking inputs on the same task", () => {
  const f = fixture(), t = task(f, "수신 근거 구분");
  const inputs = ["checking","stopped","needs_owner"].map(phase => {
    const d = assign(f, t.id);
    f.store.markHeld(d.id, "delivery_unknown");
    f.store.db.query("UPDATE delivery_recovery SET phase=? WHERE delivery_id=?").run(phase, d.id);
    return d;
  });
  const node = () => f.store.projectWorkflow(f.project.id).nodes.find(n => n.taskId === t.id);
  expect(node()).toMatchObject({ ownerActionRequired: true, inputBlock: { deliveryId: inputs[2]!.id }, action: { tab: "team" } });
  f.store.db.query("UPDATE delivery_recovery SET phase='stopped' WHERE delivery_id=?").run(inputs[2]!.id);
  expect(node()).toMatchObject({ ownerActionRequired: false });
  expect(inputs.map(d => f.store.requireDelivery(d.id).attempts)).toEqual([0, 0, 0]);
});

test("an old report and a worker review do not request an owner response", () => {
  const f = fixture(), t = task(f, "직원 검수"), old = task(f, "이전 지시");
  f.store.markDelivered(assign(f, old.id).id);
  f.store.db.query("DELETE FROM task_sequence WHERE task_id=?").run(old.id);
  const progress = { ...f.store.taskProgress(t.id), stage: "review" as const, next: "검수자가 확인합니다" };
  const nodes = f.store.projectWorkflow(f.project.id, [{ ...t, progress }, old]).nodes;
  expect(nodes.find(n => n.taskId === t.id)).toMatchObject({ state: "review", ownerActionRequired: false });
  expect(nodes.find(n => n.taskId === old.id)).toMatchObject({ historical: true, ownerActionRequired: false, label: "이전 지시" });
});

test("a task with both an owner todo and a protected delivery exposes both response destinations", async () => {
  const f = fixture(), t = task(f, "전달 확인과 대표 결정");
  const d = assign(f, t.id);
  f.store.markHeld(d.id, "delivery_unknown");
  f.store.db.query("UPDATE delivery_recovery SET phase='needs_owner' WHERE delivery_id=?").run(d.id);
  await f.tool(f.worker, "todo", { task_id: t.id, title: "담당 범위 확인" });
  const decision = f.store.createDecision({ projectId: f.project.id, memberId: f.worker.id, who: f.worker.name, title: "비용 결정", taskId: t.id });
  expect(f.store.projectWorkflow(f.project.id).nodes.find(n => n.taskId === t.id)).toMatchObject({
    ownerActionRequired: true, action: { tab: "inbox", sub: decision.id }, additionalOwnerActions: [
      { tab: "home", sub: f.store.listTodos(f.project.id)[0]!.id }, { tab: "team", sub: f.worker.id }
    ],
    inputBlock: { deliveryId: d.id }
  });
});

test("an explicit task hold does not ask the owner to retry an input already refused before writing", () => {
  const f = fixture(), t = task(f, "기존 자료 인계를 기다리는 범위");
  const d = assign(f, t.id);
  f.store.markHeld(d.id, "input_busy");
  f.store.db.query("UPDATE delivery_recovery SET phase='resolved', reason='not_received' WHERE delivery_id=?").run(d.id);
  f.store.patchDeliveryRetry(d.id, { retryReason: "rejected_limit" });
  f.store.addStageMark({ projectId: f.project.id, taskId: t.id, stage: "hold", evidence: "선행 검수까지 중단", memberId: f.lead.id, who: f.lead.name });
  const node = () => f.store.projectWorkflow(f.project.id).nodes.find(n => n.taskId === t.id);
  expect(node()).toMatchObject({ ownerActionRequired: false, state: "blocked", label: "보류" });
  f.store.addStageMark({ projectId: f.project.id, taskId: t.id, stage: "reopen", evidence: "선행 자료 인계", memberId: f.lead.id, who: f.lead.name });
  expect(node()).toMatchObject({ ownerActionRequired: true, label: "전달 재시도 한도" });
  expect(f.store.requireDelivery(d.id)).toMatchObject({ status: "held", attempts: 0 });
});

test("보류한 업무와 연결된 하위 업무에 실제 재개 조건이 표시된다", () => {
  const f = fixture(), parent = task(f, "인계할 자료 검증"), child = task(f, "검증 결과 반영");
  f.store.db.query("UPDATE tasks SET parent_task_id=? WHERE id=?").run(parent.id, child.id);
  assign(f, parent.id);
  assign(f, child.id);
  const evidence = "원 실행의 종료 영수증이 도착하면 인계를 재개합니다";
  f.store.addStageMark({ projectId: f.project.id, taskId: parent.id, stage: "hold", evidence, memberId: f.lead.id, who: f.lead.name });
  const nodes = f.store.projectWorkflow(f.project.id).nodes;
  const direct = nodes.find(n => n.taskId === parent.id)!, inherited = nodes.find(n => n.taskId === child.id)!;
  for (const node of [direct, inherited]) {
    expect(node).toMatchObject({ state: "blocked", label: "보류", ownerActionRequired: false });
    expect(node.reason).toContain(evidence);
  }
  expect(inherited.reason).toContain(parent.title);
});

test("진행판의 업무 보류는 종료된 과거 지시보다 먼저 실제 조건을 보여준다", () => {
  const f = fixture(), t = task(f, "외부 인계 대기");
  const input = assign(f, t.id);
  f.store.markDelivered(input.id);
  f.store.db.query("DELETE FROM task_sequence WHERE task_id=?").run(t.id);
  const detail = "기존 자료가 전달되면 작업을 재개합니다";
  f.store.upsertWork({ projectId: f.project.id, title: t.title, sec: "hold", taskId: t.id, who: f.worker.name, detail });
  expect(f.store.projectWorkflow(f.project.id).nodes.find(n => n.taskId === t.id)).toMatchObject({
    historical: false, state: "blocked", label: "보류", reason: detail, ownerActionRequired: false,
  });
});


test("반복 감시와 한 번의 막힘을 서로 다른 팀 처리로 표시한다", () => {
  const f = fixture(), t = task(f, "자동 처리 예외");
  for (const [stage, state, label] of [["check", "blocked", "진전 없음"], ["confirm", "review", "미확인 항목"]] as const) {
    const progress = { ...f.store.taskProgress(t.id), stage, next: "담당 팀에서 원인을 확인합니다" };
    expect(buildWorkflow([{ ...t, progress }], [], [], []).nodes[0]).toMatchObject({ state, label, ownerActionRequired: false });
  }
});

test("직원이 이어 고칠 검사와 외부 도움이 필요한 막힘을 구분한다", () => {
  const f = fixture(), t = task(f, "저장 검사 보완");
  assign(f, t.id);
  const base = f.store.taskProgressFacts(f.project.id).get(t.id)!;
  const report = { id: "msg_repair", seq: 1, at: t.createdAt, kind: "진행" as const, memberId: f.worker.id,
    who: f.worker.name, authorKind: "worker" as const, continuesWork: true, failed: ["저장 검사"], notRun: [], checks: 1, passed: false };
  for (const [outcome, state] of [[report, "waiting"], [{ ...report, kind: "막힘" as const, continuesWork: false }, "blocked"]] as const) {
    const progress = deriveProgress({ ...base, reports: [outcome] });
    const n = buildWorkflow([{ ...t, progress }], [f.worker], [], [{ taskId: t.id, memberId: f.worker.id, at: t.createdAt, kind: outcome.kind, title: "저장 검사" }]).nodes[0]!;
    expect(n).toMatchObject({ state, ownerActionRequired: false, reason: progress.next });
    if (outcome.continuesWork) expect(n.label).toBe("담당자 수정 예정");
  }
});
