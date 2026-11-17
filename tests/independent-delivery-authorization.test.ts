import { afterEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { Bus } from "../server/bus.ts";
import { openDb } from "../server/db.ts";
import { authorizeIndependentDelivery, independentDeliveryAuthorized } from "../server/independent-delivery.ts";
import { Store } from "../server/store.ts";
import type { IndependentDeliveryRequest } from "../shared/workflow.ts";

const databases: ReturnType<typeof openDb>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function setup() {
  const db = openDb(":memory:");
  databases.push(db);
  const store = new Store(db, new Bus());
  const project = store.createProject({ name: "독립 지시 확인", cwd: process.cwd() });
  const worker = store.createMember({ projectId: project.id, handle: "worker", name: "직원", kind: "worker", origin: "runner", backend: "core", status: "idle", sessionId: "isolated-session", paneId: "isolated-pane" });
  const otherWorker = store.createMember({ projectId: project.id, handle: "other", name: "다른 직원", kind: "worker" });
  const task = (title: string, parentTaskId?: string) => store.ensureSourceTask({ projectId: project.id, sourceRef: randomUUID(), title, origin: "owner", parentTaskId }).task;
  const oldTask = task("이전 업무"), nextTask = task("별개 업무");
  const old = store.enqueue({ projectId: project.id, memberId: worker.id, taskId: oldTask.id, kind: "instruction", text: "이전 업무 지시" });
  store.markDelivered(old.id);
  store.addStageMark({ projectId: project.id, taskId: oldTask.id, stage: "hold", evidence: "원래 보류를 유지합니다", who: "대표", memberId: null });
  const next = store.enqueue({ projectId: project.id, memberId: worker.id, taskId: nextTask.id, kind: "instruction", text: "독립된 새 지시" });
  const source = store.createMessage({ projectId: project.id, taskId: nextTask.id, mine: true, who: "대표", kind: "나", body: "이 지시를 이전 업무와 별개로 실행하세요", targetMemberId: worker.id, at: new Date(Date.parse(next.createdAt) + 1).toISOString() });
  const request: IndependentDeliveryRequest = { operationId: randomUUID(), sourceMessageId: source.id, expectedSessionGeneration: 0, expectedBlockerTaskId: oldTask.id };
  const authorize = (r: IndependentDeliveryRequest = request) => authorizeIndependentDelivery(store, project.id, next.id, r);
  return { db, store, project, worker, otherWorker, task, oldTask, nextTask, old, next, source, request, authorize };
}

test("explicit authorization records the existing instruction without changing protected work or creating input", () => {
  const f = setup(), deliveries = f.store.listDeliveries(), marks = f.store.listStageMarks(f.oldTask.id), source = f.store.requireMessage(f.source.id);
  expect(f.store.taskSequenceBlocker(f.worker.id, f.nextTask.id)?.taskId).toBe(f.oldTask.id);
  const result = f.authorize();
  expect(result).toMatchObject({ operationId: f.request.operationId, projectId: f.project.id, taskId: f.nextTask.id, memberId: f.worker.id, deliveryId: f.next.id });
  const receipt = f.store.workflowAssignmentReceipt(f.request.operationId)!;
  expect(receipt.request).toMatchObject({ kind: "independent_delivery", memberId: f.worker.id, independent: { sourceMessageId: f.source.id, sessionGeneration: 0, blockerTaskId: f.oldTask.id } });
  expect(independentDeliveryAuthorized(f.store, f.store.requireDelivery(f.next.id))).toBe(true);
  expect(f.store.listDeliveries()).toEqual(deliveries);
  expect(f.store.listStageMarks(f.oldTask.id)).toEqual(marks);
  expect(f.store.requireMessage(f.source.id)).toEqual(source);
  expect(f.store.listPendingExecutions()).toEqual([]);
});

test("a repeated operation survives Store recreation and cannot reauthorize changed state", () => {
  const f = setup(), result = f.authorize();
  f.store.markDelivered(f.next.id);
  f.store.db.query("UPDATE members SET session_generation = session_generation + 1 WHERE id = ?").run(f.worker.id);
  f.store.db.query("UPDATE messages SET body = ? WHERE id = ?").run("대표가 지시를 바꿨습니다", f.source.id);
  const reopened = new Store(f.db, new Bus());
  expect(authorizeIndependentDelivery(reopened, f.project.id, f.next.id, { ...f.request })).toEqual(result);
  expect(independentDeliveryAuthorized(reopened, reopened.requireDelivery(f.next.id))).toBe(false);
  expect(reopened.listDeliveries()).toHaveLength(2);
  expect(reopened.db.query("SELECT COUNT(*) AS n FROM workflow_assignment_receipts").get()).toEqual({ n: 1 });
});

test.each(["source", "generation", "blocker", "delivery", "project"])("operation reuse conflicts on a different %s", change => {
  const f = setup(); f.authorize();
  const other = f.store.createProject({ name: "다른 프로젝트", cwd: process.cwd() });
  const request = { ...f.request };
  if (change === "source") request.sourceMessageId = "different-source";
  if (change === "generation") request.expectedSessionGeneration++;
  if (change === "blocker") request.expectedBlockerTaskId = "different-task";
  expect(() => authorizeIndependentDelivery(f.store, change === "project" ? other.id : f.project.id, change === "delivery" ? f.old.id : f.next.id, request)).toThrow();
  expect(f.store.db.query("SELECT COUNT(*) AS n FROM workflow_assignment_receipts").get()).toEqual({ n: 1 });
});

test("an ordinary assignment receipt cannot be reused as independent authorization", () => {
  const f = setup();
  f.store.saveWorkflowAssignmentReceipt({ operationId: f.request.operationId, memberId: f.worker.id, revision: "ordinary-assignment" }, { operationId: f.request.operationId, projectId: f.project.id, taskId: f.nextTask.id, memberId: f.worker.id, deliveryId: f.next.id, createdAt: f.next.createdAt });
  expect(() => f.authorize()).toThrow();
  expect(independentDeliveryAuthorized(f.store, f.next)).toBe(false);
});

test("a terminal operation cannot be reused as independent authorization", () => {
  const f = setup();
  f.store.beginOperation({ operationId: f.request.operationId, kind: "terminal_control", projectId: f.project.id, memberId: f.worker.id, request: { action: "claim" } });
  expect(() => f.authorize()).toThrow();
  expect(f.store.workflowAssignmentReceipt(f.request.operationId)).toBeNull();
});

test.each(["staff", "untargeted", "other-worker", "other-project", "other-task", "older"])("a %s source cannot authorize the queued instruction", condition => {
  const f = setup();
  if (condition === "staff") f.store.db.query("UPDATE messages SET mine = 0 WHERE id = ?").run(f.source.id);
  if (condition === "untargeted") f.store.db.query("UPDATE messages SET target_member_id = NULL WHERE id = ?").run(f.source.id);
  if (condition === "other-worker") f.store.db.query("UPDATE messages SET target_member_id = ? WHERE id = ?").run(f.otherWorker.id, f.source.id);
  if (condition === "other-project") {
    const other = f.store.createProject({ name: "다른 프로젝트", cwd: process.cwd() });
    f.store.db.query("UPDATE messages SET project_id = ? WHERE id = ?").run(other.id, f.source.id);
  }
  if (condition === "other-task") f.store.db.query("UPDATE messages SET task_id = ? WHERE id = ?").run(f.task("다른 문맥").id, f.source.id);
  if (condition === "older") f.store.db.query("UPDATE messages SET at = ? WHERE id = ?").run(new Date(Date.parse(f.next.createdAt) - 1).toISOString(), f.source.id);
  const before = f.store.listDeliveries();
  expect(() => f.authorize()).toThrow();
  expect(f.store.workflowAssignmentReceipt(f.request.operationId)).toBeNull();
  expect(f.store.listDeliveries()).toEqual(before);
});

test("a source in the same millisecond as the queued instruction remains usable", () => {
  const f = setup();
  f.store.db.query("UPDATE messages SET at = ? WHERE id = ?").run(f.next.createdAt, f.source.id);
  f.authorize();
  expect(independentDeliveryAuthorized(f.store, f.next)).toBe(true);
});

test("a newer representative instruction in the predecessor context can authorize an independent delivery", () => {
  const f = setup();
  f.store.db.query("UPDATE messages SET task_id = ? WHERE id = ?").run(f.oldTask.id, f.source.id);
  f.authorize();
  expect(independentDeliveryAuthorized(f.store, f.next)).toBe(true);
});

test.each(["held", "attempted", "delivered", "quiet", "urgent", "user-message", "stopped", "checking", "retry-limit", "generation", "blocker", "runner-off", "archived", "conductor"])("%s cannot receive a new independent grant", condition => {
  const f = setup();
  if (condition === "held") f.store.setDeliveryStatus(f.next.id, "held", { holdReason: "input_busy" });
  if (condition === "attempted") f.store.setDeliveryStatus(f.next.id, "queued", { attempt: true });
  if (condition === "delivered") f.store.markDelivered(f.next.id);
  if (condition === "quiet") f.store.db.query("UPDATE deliveries SET wake = 0 WHERE id = ?").run(f.next.id);
  if (condition === "urgent") f.store.db.query("UPDATE deliveries SET urgent = 1 WHERE id = ?").run(f.next.id);
  if (condition === "user-message") f.store.db.query("UPDATE deliveries SET kind = 'user_message' WHERE id = ?").run(f.next.id);
  if (condition === "stopped" || condition === "checking") { const r = f.store.getDeliveryRecovery(f.next.id)!; f.store.updateDeliveryRecovery(f.next.id, r.version, { phase: condition }); }
  if (condition === "retry-limit") f.store.patchDeliveryRetry(f.next.id, { retryReason: "rejected_limit" });
  if (condition === "generation") f.request.expectedSessionGeneration++;
  if (condition === "blocker") f.request.expectedBlockerTaskId = f.nextTask.id;
  if (condition === "runner-off") f.store.patchProject(f.project.id, { runnerEnabled: false });
  if (condition === "archived") f.store.patchProject(f.project.id, { archived: true });
  if (condition === "conductor") f.store.db.query("UPDATE members SET kind = 'conductor' WHERE id = ?").run(f.worker.id);
  const before = f.store.listDeliveries();
  expect(() => f.authorize()).toThrow();
  expect(f.store.workflowAssignmentReceipt(f.request.operationId)).toBeNull();
  expect(f.store.listDeliveries()).toEqual(before);
});

test.each(["ancestor", "siblings"])("a %s dependency cannot be overridden", relation => {
  const f = setup();
  if (relation === "ancestor") f.store.db.query("UPDATE tasks SET parent_task_id = ? WHERE id = ?").run(f.oldTask.id, f.nextTask.id);
  else { const parent = f.task("공통 부모 업무"); f.store.db.query("UPDATE tasks SET parent_task_id = ? WHERE id IN (?, ?)").run(parent.id, f.oldTask.id, f.nextTask.id); }
  expect(() => f.authorize()).toThrow();
  expect(f.store.workflowAssignmentReceipt(f.request.operationId)).toBeNull();
});

test("an unrelated first blocker cannot conceal a later same-family prerequisite", () => {
  const f = setup(), parent = f.task("같은 계통");
  f.store.db.query("UPDATE tasks SET parent_task_id = ? WHERE id = ?").run(parent.id, f.nextTask.id);
  const sibling = f.task("먼저 맡긴 형제 업무", parent.id);
  const prior = f.store.enqueue({ projectId: f.project.id, memberId: f.worker.id, taskId: sibling.id, kind: "instruction", text: "같은 계통의 선행 입력" });
  f.store.markDelivered(prior.id);
  // Move only fixture row order so the sibling precedes the candidate, behind the unrelated first task.
  f.store.db.query("UPDATE deliveries SET rowid = rowid + 100 WHERE id = ?").run(f.next.id);
  expect(f.store.taskSequenceBlocker(f.worker.id, f.nextTask.id)?.taskId).toBe(f.oldTask.id);
  expect(() => f.authorize()).toThrow();
});

function stopTarget(f: ReturnType<typeof setup>, condition: string, taskId = f.nextTask.id) {
  if (condition === "hold" || condition === "done") f.store.addStageMark({ projectId: f.project.id, taskId, stage: condition, evidence: "대상 업무 보호", memberId: null, who: "대표" });
  if (condition === "decision") f.store.createDecision({ projectId: f.project.id, taskId, memberId: f.worker.id, who: "직원", title: "대상 업무 결재" });
  if (condition === "todo") f.store.createTodo({ projectId: f.project.id, taskId, memberId: f.worker.id, who: "직원", title: "대상 업무 대표 확인" });
  if (condition === "watch") { const at = new Date().toISOString(); f.store.saveTaskWatch(f.project.id, taskId, { startedAt: at, attempts: 3, same: 3, fingerprint: "repeat", lastProgressAt: at, trippedAt: at, reason: "반복 멈춤", history: [], updatedAt: at }); }
  if (condition === "owner-stop") f.store.db.query("INSERT INTO task_continuations(task_id,project_id,pause_token,pause_reason,pause_source_seq,pause_mark_seq,updated_at) VALUES(?,?,?,?,?,?,?)").run(taskId, f.project.id, "owner-stop", "대표 중단", 100000, 100000, new Date().toISOString());
}

test.each(["hold", "done", "decision", "todo", "watch", "owner-stop"])("target %s is protected at authorization and admission", condition => {
  const first = setup(); stopTarget(first, condition);
  expect(() => first.authorize()).toThrow();
  const later = setup(); later.authorize(); stopTarget(later, condition);
  const before = later.store.listDeliveries();
  expect(independentDeliveryAuthorized(later.store, later.store.requireDelivery(later.next.id))).toBe(false);
  expect(later.store.listDeliveries()).toEqual(before);
});

test.each(["hold", "decision", "todo", "watch", "owner-stop"])("ancestor %s remains a target dependency", condition => {
  const f = setup(), parent = f.task("대상 부모 업무");
  f.store.db.query("UPDATE tasks SET parent_task_id = ? WHERE id = ?").run(parent.id, f.nextTask.id);
  stopTarget(f, condition, parent.id);
  expect(() => f.authorize()).toThrow();
});

test.each(["source-body", "source-time", "source-target", "delivery-text", "urgent", "generation", "new-blocker", "lineage"])("a stored grant fails closed after %s changes", change => {
  const f = setup(); f.authorize();
  if (change === "source-body") f.store.db.query("UPDATE messages SET body = ? WHERE id = ?").run("바뀐 원문", f.source.id);
  if (change === "source-time") f.store.db.query("UPDATE messages SET at = ? WHERE id = ?").run(new Date(Date.parse(f.source.at) + 1).toISOString(), f.source.id);
  if (change === "source-target") f.store.db.query("UPDATE messages SET target_member_id = ? WHERE id = ?").run(f.otherWorker.id, f.source.id);
  if (change === "delivery-text") f.store.db.query("UPDATE deliveries SET text = ? WHERE id = ?").run("바뀐 지시", f.next.id);
  if (change === "urgent") f.store.db.query("UPDATE deliveries SET urgent = 1 WHERE id = ?").run(f.next.id);
  if (change === "generation") f.store.db.query("UPDATE members SET session_generation = session_generation + 1 WHERE id = ?").run(f.worker.id);
  if (change === "new-blocker") f.store.addStageMark({ projectId: f.project.id, taskId: f.oldTask.id, stage: "done", evidence: "선행 업무 변경", memberId: null, who: "대표" });
  if (change === "lineage") f.store.db.query("UPDATE tasks SET parent_task_id = ? WHERE id = ?").run(f.oldTask.id, f.nextTask.id);
  expect(independentDeliveryAuthorized(f.store, f.store.requireDelivery(f.next.id))).toBe(false);
});

test.each(["urgent", "text", "status"])("an old delivery object cannot conceal a current %s change", change => {
  const f = setup(); f.authorize();
  if (change === "urgent") f.store.db.query("UPDATE deliveries SET urgent = 1 WHERE id = ?").run(f.next.id);
  if (change === "text") f.store.db.query("UPDATE deliveries SET text = ? WHERE id = ?").run("새로 바뀐 지시", f.next.id);
  if (change === "status") f.store.markDelivered(f.next.id);
  expect(independentDeliveryAuthorized(f.store, f.next)).toBe(false);
});

function relatedScope(f: ReturnType<typeof setup>, scope: string): string {
  if (scope === "ancestor" || scope === "sibling") {
    const parent = f.task("대상의 부모 업무");
    f.store.db.query("UPDATE tasks SET parent_task_id = ? WHERE id = ?").run(parent.id, f.nextTask.id);
    return scope === "ancestor" ? parent.id : f.task("대상의 형제 업무", parent.id).id;
  }
  if (scope === "descendant") return f.task("대상의 자식 업무", f.nextTask.id).id;
  if (scope === "unrelated") return f.task("다른 계통 업무").id;
  return f.nextTask.id;
}

function occupyOtherWorker(f: ReturnType<typeof setup>, taskId: string, state: string) {
  const delivery = f.store.enqueue({ projectId: f.project.id, memberId: f.otherWorker.id, taskId, kind: "instruction", text: "다른 직원에게 이미 간 같은 계통 입력" });
  const at = new Date().toISOString();
  const identity = { terminalId: f.otherWorker.paneId, sessionId: f.otherWorker.sessionId, sessionGeneration: 0, process: null };
  if (state === "delivering") f.store.setDeliveryStatus(delivery.id, "delivering", { attempt: true });
  if (state === "unknown") {
    const wireText = "격리된 입력 봉투";
    f.store.saveDispatch({ dispatchId: randomUUID(), memberId: f.otherWorker.id, projectId: f.project.id, cli: f.otherWorker.cli, backend: "core", identity,
      baseline: { serverEpoch: "isolated", turn: 0, inputEpoch: 0, logs: [], capturedAt: at },
      markers: [{ deliveryId: delivery.id, marker: "#isolated_item" }], bundleMarker: "#isolated_bundle", wireText,
      wireSha256: createHash("sha256").update(wireText).digest("hex"), items: [{ deliveryId: delivery.id, ordinal: 0, sourceRevision: null }],
      transportState: "unknown", submitAttempts: 0, createdAt: at, updatedAt: at });
  }
  if (state === "received") {
    f.store.markDelivered(delivery.id);
    f.store.saveExecutionJournal({ runId: randomUUID(), memberId: f.otherWorker.id, projectId: f.project.id, identity, turn: 0, deliveryIds: [delivery.id], phase: "received",
      inputReceivedAt: at, startedAt: null, lastProgressAt: null, endedAt: null, result: null, reason: null, exitCode: null,
      interruptionNotifiedAt: null, reportRequestedAt: null, createdAt: at, updatedAt: at });
  }
  return delivery;
}

test.each(["target", "ancestor", "descendant", "sibling"])("another worker's uncertain or active %s scope blocks independent authorization", scope => {
  for (const state of ["delivering", "unknown", "received"]) {
    const f = setup(), taskId = relatedScope(f, scope);
    occupyOtherWorker(f, taskId, state);
    const before = f.store.listDeliveries();
    expect(() => f.authorize()).toThrow();
    expect(f.store.workflowAssignmentReceipt(f.request.operationId)).toBeNull();
    expect(f.store.listDeliveries()).toEqual(before);
  }
});

test.each(["target", "ancestor"])("another worker's new active %s input invalidates an existing grant without changing input", scope => {
  for (const state of ["delivering", "unknown", "received"]) {
    const f = setup(), taskId = relatedScope(f, scope);
    f.authorize();
    occupyOtherWorker(f, taskId, state);
    const before = f.store.listDeliveries();
    expect(independentDeliveryAuthorized(f.store, f.next)).toBe(false);
    expect(f.store.listDeliveries()).toEqual(before);
  }
});

test("unselected pristine same-task inputs remain separate from received or uncertain work", () => {
  const f = setup();
  const unselected = occupyOtherWorker(f, f.nextTask.id, "pristine");
  f.authorize();
  expect(independentDeliveryAuthorized(f.store, f.next)).toBe(true);
  expect(f.store.requireDelivery(unselected.id)).toEqual(unselected);
});

test.each(["delivering", "unknown", "received"])("another worker's %s input in an unrelated family does not block this grant", state => {
  const f = setup();
  occupyOtherWorker(f, relatedScope(f, "unrelated"), state);
  f.authorize();
  expect(independentDeliveryAuthorized(f.store, f.next)).toBe(true);
});

test.each(["target-parent", "blocker-parent", "effective-contract"])("a stored grant becomes stale after unrelated %s review drift", change => {
  const f = setup();
  if (change === "effective-contract") f.store.saveTaskContract(f.nextTask.id, { kind: "other", goal: "기존 범위", acceptance: ["기존 조건을 확인합니다"] }, { author: "대표", authorKind: "owner", authorMemberId: null });
  f.authorize();
  if (change === "target-parent" || change === "blocker-parent") {
    const parent = f.task("새로운 별개 부모 업무");
    f.store.db.query("UPDATE tasks SET parent_task_id = ? WHERE id = ?").run(parent.id, change === "target-parent" ? f.nextTask.id : f.oldTask.id);
  } else f.store.saveTaskContract(f.nextTask.id, { kind: "other", goal: "바뀐 범위", acceptance: ["새 조건을 확인합니다"] }, { author: "대표", authorKind: "owner", authorMemberId: null });
  expect(f.store.taskSequenceBlocker(f.worker.id, f.nextTask.id)?.taskId).toBe(f.oldTask.id);
  expect(independentDeliveryAuthorized(f.store, f.next)).toBe(false);
});
