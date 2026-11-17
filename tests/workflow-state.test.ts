import { expect, test } from "bun:test";
import { fixture } from "./fixtures/harness-fixture.ts";
import { newerProgress } from "../shared/task-stage.ts";
import { MIGRATIONS } from "../server/db.ts";

type F = ReturnType<typeof fixture>;
const task = (f: F, title: string, parentTaskId?: string) => f.store.ensureSourceTask({ projectId: f.project.id, sourceRef: `flow:${title}`, title, origin: "owner", parentTaskId }).task;
const assign = (f: F, taskId: string, memberId = f.worker.id) => f.store.enqueue({ projectId: f.project.id, memberId, taskId, kind: "instruction", text: "지시 원문", wake: true });
const mark = (f: F, taskId: string, stage: "done" | "hold" | "reopen") => f.store.addStageMark({ projectId: f.project.id, taskId, stage, evidence: "격리 시험 근거", memberId: f.lead.id, who: f.lead.name });

test("unfinished historical work keeps its real blocker without enrolling or redelivering it", async () => {
  const f = fixture(), a = task(f, "과거 보완 업무");
  f.store.markDelivered(assign(f, a.id).id);
  f.store.db.query("DELETE FROM task_sequence WHERE task_id = ?").run(a.id);
  await f.orch.recordPost(f.worker, { kind: "막힘", title: "검토 반례가 남았습니다", body: "보완 후 재검증해야 합니다", taskId: a.id,
    checks: [{ kind: "behavior", name: "중단 보호", result: "fail", evidence: "중단 후 입력이 남았습니다" }] });
  const before = f.store.listDeliveries();
  const state = f.store.projectWorkflow(f.project.id).nodes.find(n => n.taskId === a.id)!;
  expect(state.historical).toBe(false); // The latest main marks current failed evidence as actionable, even before sequence enrollment.
  expect(state.state).toBe("blocked");
  expect(state.label).not.toBe("이전 업무");
  expect(f.store.db.query("SELECT * FROM task_sequence WHERE task_id = ?").all(a.id)).toHaveLength(0);
  expect(f.store.listDeliveries()).toEqual(before);
});

test("flow uses delivery recipients, keeps unassigned work and distinguishes derived edges from row order", () => {
  const f = fixture(), a = task(f, "대표 지시"), b = task(f, "다음 지시"), child = task(f, "파생 확인", a.id), unassigned = task(f, "아직 배정 전");
  assign(f, a.id); assign(f, b.id); assign(f, child.id, f.worker2.id);
  const flow = f.store.projectState(f.project.id, { compact: true }).workflow!;
  const aNode = flow.nodes.find(n => n.taskId === a.id)!;
  const bNode = flow.nodes.find(n => n.taskId === b.id)!;
  expect(aNode).toMatchObject({ memberId: f.worker.id, current: true, state: "queued" });
  expect(bNode).toMatchObject({ memberId: f.worker.id, current: false, state: "waiting" });
  expect(bNode.reason).toContain("대표 지시");
  expect(flow.nodes.find(n => n.taskId === unassigned.id)?.memberId).toBeNull();
  expect(flow.nodes.some(n => n.memberId === f.lead.id)).toBe(false);
  expect(flow.edges).toContainEqual(expect.objectContaining({ from: aNode.id, to: bNode.id, kind: "sequence" }));
  expect(flow.edges).toContainEqual(expect.objectContaining({ from: aNode.id, to: flow.nodes.find(n => n.taskId === child.id)!.id, kind: "derived" }));
});

test("ending a turn does not complete the left task; completing it releases the right task and a new instruction reopens it", () => {
  const f = fixture(), a = task(f, "먼저 끝낼 일"), b = task(f, "다음 일");
  const delivery = assign(f, a.id); f.store.markDelivered(delivery.id); assign(f, b.id);
  expect(f.store.taskSequenceBlocker(f.worker.id, b.id)?.taskId).toBe(a.id);
  expect(f.store.taskSequenceBlocker(f.lead.id, b.id)).toBeNull();
  f.store.patchMember(f.worker.id, { status: "idle", now: "끝냈다고 적은 오래된 상태" });
  expect(f.store.taskSequenceBlocker(f.worker.id, b.id)?.taskId).toBe(a.id);
  mark(f, a.id, "done");
  expect(f.store.taskSequenceBlocker(f.worker.id, b.id)).toBeNull();
  expect(f.store.projectWorkflow(f.project.id).nodes.find(n => n.taskId === a.id)?.state).toBe("done");
  assign(f, a.id);
  expect(f.store.taskProgress(a.id).stage).not.toBe("done");
  expect(f.store.taskSequenceBlocker(f.worker.id, b.id)?.taskId).toBe(a.id);
});

test("a derived continuation can run without treating its unfinished parent as a prerequisite", () => {
  const f = fixture(), a = task(f, "부모 업무"), child = task(f, "같은 업무 보완", a.id), next = task(f, "별개 업무");
  assign(f, a.id); assign(f, next.id); assign(f, child.id);
  expect(f.store.taskSequenceBlocker(f.worker.id, child.id)).toBeNull();
  expect(f.store.taskSequenceBlocker(f.worker.id, next.id)?.taskId).toBe(a.id);
  const nodes = f.store.projectWorkflow(f.project.id).nodes.filter(n => n.memberId === f.worker.id).sort((x, y) => x.order - y.order);
  expect(nodes.map(n => n.taskId)).toEqual([a.id, child.id, next.id]);
  expect(f.store.projectWorkflow(f.project.id).edges).not.toContainEqual(expect.objectContaining({ from: nodes.find(n => n.taskId === next.id)!.id, to: nodes.find(n => n.taskId === child.id)!.id, kind: "sequence" }));
});

test("derived siblings still obey their employee row order", () => {
  const f = fixture(), parent = task(f, "전체 변경"), first = task(f, "첫 번째 보완", parent.id), second = task(f, "두 번째 보완", parent.id);
  assign(f, parent.id); assign(f, first.id); assign(f, second.id);
  expect(f.store.taskSequenceBlocker(f.worker.id, first.id)).toBeNull();
  expect(f.store.taskSequenceBlocker(f.worker.id, second.id)?.taskId).toBe(first.id);
});

test("adoption enrolls pending and current work without making old delivered history a prerequisite", () => {
  const f = fixture(), history = task(f, "지난 작업"), pending = task(f, "현재 대기"), later = task(f, "후속 지시"), stopped = task(f, "재생 금지 과거 입력");
  f.store.markDelivered(assign(f, history.id).id);
  assign(f, pending.id); assign(f, later.id);
  const protectedInput = assign(f, stopped.id);
  f.store.db.query("UPDATE delivery_recovery SET phase = 'stopped' WHERE delivery_id = ?").run(protectedInput.id);
  const originals = f.store.listDeliveries();
  // Recreate exactly the additive v37 migration over the old metadata, without synthetic completion.
  f.store.db.exec("DROP TABLE task_sequence");
  f.store.db.exec(MIGRATIONS.find(sql => sql.includes("CREATE TABLE task_sequence"))!);
  expect(f.store.taskSequenceBlocker(f.worker.id, pending.id)).toBeNull();
  expect(f.store.taskSequenceBlocker(f.worker.id, later.id)?.taskId).toBe(pending.id);
  expect(f.store.doneMark(history.id)).toBeNull();
  const node = f.store.projectWorkflow(f.project.id).nodes.find(n => n.taskId === history.id)!;
  expect(node).toMatchObject({ historical: true, state: "review", current: false });
  expect(f.store.listDeliveries()).toEqual(originals);
  // Subsequent reads/restarts retain the same boundary.
  expect(f.store.taskSequenceBlocker(f.worker.id, later.id)?.taskId).toBe(pending.id);
});

test("not-run checks cannot become an automatic final completion", async () => {
  const f = fixture(), a = task(f, "검사가 남은 업무");
  f.store.saveTaskContract(a.id, { kind: "other", goal: "회귀 확인", acceptance: ["남은 회귀 검사가 통과한다"], checks: [] }, { author: f.lead.name, authorMemberId: f.lead.id, authorKind: "conductor" });
  const result = await f.tool(f.worker, "post", { task_id: a.id, kind: "완료", title: "아직 확인하지 못함", contract_rev: 1, checks: [{ kind: "regression", name: "남은 회귀", result: "not_run", evidence: "아직 실행하지 않음" }] });
  expect(result.isError).toBe(true);
  expect(f.store.taskProgress(a.id).stage).not.toBe("done");
});

test("permission clearance never leaves the browser on the older approval stage", () => {
  const f = fixture(), a = task(f, "승인 확인");
  f.store.markDelivered(assign(f, a.id).id);
  f.store.patchMember(f.worker.id, { status: "blocked", blockedReason: "permission" });
  const blocked = f.store.taskProgress(a.id);
  expect(blocked.stage).toBe("approval");
  f.store.patchMember(f.worker.id, { status: "idle", blockedReason: null });
  const cleared = f.store.taskProgress(a.id);
  expect(newerProgress(blocked, cleared)?.stage).not.toBe("approval");
  expect(cleared.rev >= blocked.rev).toBe(true);
});

test("an unknown terminal status is not presented as a permission request", () => {
  const f = fixture(), a = task(f, "상태 확인");
  f.store.markDelivered(assign(f, a.id).id);
  f.store.patchMember(f.worker.id, { status: "blocked", blockedReason: "status_unknown" });
  expect(f.store.taskProgress(a.id).stage).not.toBe("approval");
});

test("an already-running later task owns the employee position while earlier work stays queued", () => {
  const f = fixture(), a = task(f, "대기 중 지시"), b = task(f, "이미 실행 중인 지시");
  assign(f, a.id);
  const input = assign(f, b.id); f.store.markDelivered(input.id);
  const at = new Date().toISOString();
  f.store.saveExecutionJournal({ runId: "legacy-current", memberId: f.worker.id, projectId: f.project.id,
    identity: { terminalId: f.worker.paneId, sessionId: f.worker.sessionId, sessionGeneration: 0, process: null }, turn: 1, deliveryIds: [input.id],
    phase: "running", inputReceivedAt: at, startedAt: at, lastProgressAt: at, endedAt: null, result: null, reason: null, exitCode: null,
    interruptionNotifiedAt: null, reportRequestedAt: null, createdAt: at, updatedAt: at });
  f.store.patchMember(f.worker.id, { status: "working", statusObservation: { source: "core", observedAt: at, freshness: "fresh", ownership: "verified", consecutiveFailures: 0, error: null } });
  const nodes = f.store.projectWorkflow(f.project.id).nodes.filter(n => n.memberId === f.worker.id);
  expect(nodes.filter(n => n.current).map(n => n.taskId)).toEqual([b.id]);
  expect(nodes.find(n => n.taskId === b.id)?.state).toBe("running");
});

test("a completion post cannot hide a held original input", async () => {
  const f = fixture(), a = task(f, "보호 입력이 남은 업무");
  f.store.enqueue({ projectId: f.project.id, memberId: f.worker.id, taskId: a.id, kind: "instruction", text: "확인되지 않은 입력", wake: true, status: "held", holdReason: "delivery_unknown" });
  f.store.saveTaskContract(a.id, { kind: "other", goal: "처리 결과 확인", acceptance: ["전달된 범위의 처리 결과가 확인된다"], checks: [] }, { author: f.lead.name, authorMemberId: f.lead.id, authorKind: "conductor" });
  await f.orch.recordPost(f.worker, { kind: "완료", title: "일부만 완료", taskId: a.id, contractRev: 1, checks: [{ kind: "other", name: "처리 결과", result: "pass", evidence: "이미 전달된 범위만 확인함", criterion: 1 }] });
  expect(f.store.taskProgress(a.id).stage).not.toBe("done");
});

test("a hold mark cannot hide an open owner todo from the final completion gate", async () => {
  const f = fixture(), a = task(f, "남은 대표 확인");
  const todo = await f.tool(f.worker, "todo", { title: "결정할 내용", task_id: a.id });
  expect(todo.isError).toBeUndefined();
  mark(f, a.id, "hold");
  const done = await f.tool(f.lead, "task_stage", { task_id: a.id, stage: "done", evidence: "보류 상태를 완료로 바꿈" });
  expect(done.isError).toBe(true);
  expect(f.store.taskProgress(a.id).stage).not.toBe("done");
});

test.each(["input", "owner", "failure"])("parent completion cannot hide an active derived task's %s blocker", async cause => {
  const f = fixture();
  const created = await f.tool(f.lead, "task", { title: `상위 완료 ${cause}`, contract: { kind: "coding", goal: "검토까지 완료", acceptance: ["동작 확인"], checks: ["behavior"] } });
  const parent = created.text.match(/#(tk_[\w-]+)/)![1]!;
  const derived = await f.tool(f.worker, "task", { title: `파생 확인 ${cause}`, parent_task_id: parent });
  const child = derived.text.match(/#(tk_[\w-]+)/)![1]!;
  f.store.markDelivered(assign(f, child).id);
  f.ran(f.worker, "bun test behavior");
  const delivered = await f.tool(f.worker, "post", { task_id: child, kind: "완료", title: "작성자 납품", contract_rev: 1, checks: [{ name: "동작", kind: "behavior", result: "pass", criterion: 1, evidence: "1 pass", command: "bun test behavior" }] });
  expect(delivered.isError).toBeUndefined();
  expect((await f.tool(f.lead, "post", { task_id: parent, kind: "완료", title: "납품 이어받음" })).isError).toBeUndefined();
  f.store.addStageMark({ projectId: f.project.id, taskId: parent, stage: "merged", evidence: "통합 0123abcd", memberId: f.lead.id, who: f.lead.name });
  if (cause === "input") f.store.enqueue({ projectId: f.project.id, memberId: f.worker.id, taskId: child, kind: "instruction", text: "확인되지 않은 보완", status: "held", holdReason: "delivery_unknown" });
  else if (cause === "owner") await f.tool(f.worker, "todo", { task_id: child, title: "대표 최종 확인" });
  else await f.tool(f.worker, "post", { task_id: child, kind: "막힘", title: "파생 회귀 실패", contract_rev: 1, checks: [{ name: "동작", kind: "behavior", result: "fail", criterion: 1, evidence: "1 fail" }] });
  const done = await f.tool(f.lead, "task_stage", { task_id: parent, stage: "done", evidence: "파생 확인을 빠뜨린 완료" });
  expect(done.isError).toBe(true);
  expect(f.store.taskProgress(parent).stage).not.toBe("done");
});

test("workflow distinguishes capacity and provider limits without hiding protected inputs or prior work", () => {
  const f = fixture(), current = task(f, "실행 자리를 기다리는 지시"), later = task(f, "후속 지시");
  const delivery = assign(f, current.id); assign(f, later.id);
  f.store.patchMember(f.worker.id, { status: "idle" });
  f.store.setDeliveryWait(f.worker.id, { kind: "capacity", active: 20, limit: 20 });
  const node = () => f.store.projectWorkflow(f.project.id).nodes.find(n => n.taskId === current.id)!;
  expect(node()).toMatchObject({ state: "queued", label: "실행 자리 대기" });
  expect(node().reason).toContain("20/20");
  expect(f.store.projectWorkflow(f.project.id).nodes.find(n => n.taskId === later.id)?.label).toBe("선행 업무 대기");
  f.store.patchMember(f.worker.id, { status: "error", executionIssue: { kind: "usage_limit", detail: "You've hit your weekly limit", at: new Date().toISOString(), sessionGeneration: 1, terminalId: null, exitCode: null } });
  expect(node()).toMatchObject({ state: "blocked", label: "사용량 한도" });
  f.store.db.query("UPDATE delivery_recovery SET phase = 'stopped' WHERE delivery_id = ?").run(delivery.id);
  expect(node().label).toBe("추가 전달 중지");
});

test.each([
  ["permission", "승인 응답 대기"], ["selection", "선택 응답 대기"], ["setup", "초기 설정 대기"],
] as const)("ordinary blocked holds retain the specific %s wait reason", (kind, label) => {
  const f = fixture(), current = task(f, "창에서 응답을 기다리는 지시");
  const delivery = assign(f, current.id);
  f.store.markHeld(delivery.id, "blocked");
  f.store.setDeliveryWait(f.worker.id, { kind });
  expect(f.store.projectWorkflow(f.project.id).nodes.find(n => n.taskId === current.id)?.label).toBe(label);
  f.store.db.query("UPDATE delivery_recovery SET phase = 'stopped' WHERE delivery_id = ?").run(delivery.id);
  expect(f.store.projectWorkflow(f.project.id).nodes.find(n => n.taskId === current.id)?.label).toBe("추가 전달 중지");
});
