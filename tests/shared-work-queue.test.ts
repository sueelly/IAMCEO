import { afterEach, expect, test } from "bun:test";
import { createQueueStatusFixture } from "./fixtures/queue-status-runtime.ts";
import { prepareReviewedRepair } from "../server/task-main-followup.ts";
import { Bus } from "../server/bus.ts";
import { openDb } from "../server/db.ts";
import { Store } from "../server/store.ts";
import { claimReadyBoardWork, sharedWorkAllowsDelivery } from "../server/shared-work-queue.ts";
import { TaskContinuationCoordinator } from "../server/task-continuation.ts";
import type { ContractInput } from "../server/harness.ts";
import type { WorkItem } from "../shared/types.ts";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.db.close(); });

function setup() {
  const store = new Store(openDb(":memory:"), new Bus());
  stores.push(store);
  const project = store.createProject({ name: "배정 검사", cwd: process.cwd() });
  const worker = (name: string, role = "", cli: "claude" | "codex" = "codex") => store.createMember({
    projectId: project.id, name, role, cli, handle: "w" + (store.listMembers(project.id).length + 1),
    kind: "worker", origin: "runner", status: "idle", sessionId: "session-" + name, paneId: "pane-" + name,
  });
  const card = (title: string, who = "", taskId?: string) => store.upsertWork({
    projectId: project.id, sec: "next", title, detail: title + " 상세", who, taskId,
  });
  const id = (item: WorkItem) => item.taskId ?? Store.workTaskId(item.id);
  const bind = (item: WorkItem, overrides: Partial<ContractInput> = {}, proposed = false) => store.saveTaskContract(id(item), {
    kind: "other", goal: item.title, inputs: ["기존 근거"], outputs: ["수정 보고"], scope: item.title,
    acceptance: ["수정 결과를 검증한다"], constraints: [], exclusions: ["추가 범위"], ...overrides,
  }, { author: proposed ? "작성자" : "총괄", authorMemberId: null, authorKind: proposed ? "worker" : "conductor" });
  const claim = (current = store) => claimReadyBoardWork(current, project.id, () => true);
  return { store, project, worker, card, id, bind, claim };
}

test("claims a legacy and a linked card on the project board once, by role and explicit recipient", () => {
  const f = setup();
  const camera = f.worker("영상 담당", "Camera playback");
  const reader = f.worker("독자 화면", "계정", "claude");
  const lead = f.store.createMember({ projectId: f.project.id, name: "총괄", handle: "lead", kind: "conductor" });
  const linked = f.store.ensureSourceTask({ projectId: f.project.id, origin: "owner", sourceRef: "request", title: "재생" }).task;
  const first = f.card("Repair camera playback", "", linked.id);
  const second = f.card("로그인 오류 재현", "@" + reader.handle);
  // Registration and historical conductor intake are not worker assignments.
  f.store.db.query("UPDATE tasks SET member_id = ? WHERE id = ?").run(reader.id, linked.id);
  const intake = f.store.enqueue({ projectId: f.project.id, memberId: lead.id, taskId: linked.id, kind: "user_message", text: "재생 수정" });
  f.store.markDelivered(intake.id);
  f.bind(first); f.bind(second);
  const receipts = f.claim();
  expect(receipts.map(d => [d.taskId, d.memberId]).sort()).toEqual([[linked.id, camera.id], [f.id(second), reader.id]].sort());
  for (const [work, assignee] of [[first, camera], [second, reader]] as const) {
    expect(f.store.getWork(work.id)).toMatchObject({ sec: "doing", who: assignee.name });
    const instruction = receipts.find(d => d.taskId === f.id(work))!;
    expect(instruction).toMatchObject({ attempts: 0, kind: "instruction", status: "queued" });
    expect(instruction.text).toContain(f.id(work));
    expect(f.store.getEffectiveContract(instruction.taskId!)?.exclusions).toContain("추가 범위");
    expect(f.store.getEffectiveContract(instruction.taskId!)?.acceptance).toContain("수정 결과를 검증한다");
    expect(f.store.listMessages(f.project.id).filter(m => m.taskId === f.id(work) && m.mine)).toEqual([]);
    f.store.markDelivered(instruction.id);
    f.store.upsertWork({ ...work, sec: "next" });
  }
  expect(f.claim(new Store(f.store.db, new Bus()))).toEqual([]);
  expect(f.store.listDeliveries(f.project.id)).toHaveLength(3);
});

test("original holds, terminal marks, other branches, pending decisions and unbound cards cannot be claimed", () => {
  const f = setup(), available = f.worker("일반 담당");
  const parent = f.store.ensureSourceTask({ projectId: f.project.id, origin: "owner", sourceRef: "hold", title: "원문 추출" }).task;
  const child = f.store.ensureSourceTask({ projectId: f.project.id, origin: "owner", sourceRef: "extract", title: "원문 처리", parentTaskId: parent.id }).task;
  const paused = f.card("원문 처리", "", child.id);
  new TaskContinuationCoordinator(f.store, { intervalMs: 30_000, sameLimit: 3 }).pause([parent.id], "stop", "원문 추출 중단");
  const old = f.card("이미 끝난 작업"), duplicate = f.card("다른 카드에서 완료"), held = f.card("다른 카드에서 보류"), waiting = f.card("대표 판단 필요");
  const local = f.card("별도 워크트리 업무"), proposal = f.card("제안만 있음"), incomplete = f.card("출력이 미정"), unknown = f.card("퇴직자에게 지정", "@former");
  for (const work of [paused, old, duplicate, held, waiting, local, unknown]) f.bind(work);
  f.bind(proposal, {}, true); f.bind(incomplete, { outputs: null });
  f.store.addStageMark({ projectId: f.project.id, taskId: f.id(old), stage: "done", who: "총괄", memberId: null, evidence: "검사 통과" });
  f.store.upsertWork({ projectId: f.project.id, taskId: f.id(duplicate), title: "완료 원본", sec: "done" });
  f.store.upsertWork({ projectId: f.project.id, taskId: f.id(held), title: "추출 중지", sec: "hold" });
  f.store.db.query("UPDATE tasks SET branch = ?, worktree = ? WHERE id = ?").run("another-project-branch", "/different/check-out", f.id(local));
  f.store.createDecision({ projectId: f.project.id, taskId: f.id(waiting), who: "총괄", title: "대표 확인" });
  const ready = f.card("별개의 확인된 업무"); f.bind(ready);
  expect(f.claim().map(d => [d.taskId, d.memberId])).toEqual([[f.id(ready), available.id]]);
  expect(f.store.doneMark(f.id(old))).toBeTruthy();
  expect(f.store.taskContinuationPauses(f.project.id).some(p => p.taskId === child.id)).toBe(true);
  expect(f.store.listDeliveries(f.project.id)).toHaveLength(1);
});

test("only an available Standard worker takes one ready card and a rollback preserves the queue", () => {
  const f = setup(), fast = f.worker("Fast"), active = f.worker("터미널 사용 중"), free = f.worker("실행 대기");
  f.store.patchMember(fast.id, { codexSpeed: "fast" });
  const reviewer = f.store.createMember({ projectId: f.project.id, name: "검수", handle: "reviewer", kind: "worker", finalReviewer: true, status: "idle", paneId: "r" });
  const a = f.card("첫 업무"), b = f.card("두 번째 업무"), restricted = f.card("검수 담당 지시", reviewer.name);
  for (const work of [a, b, restricted]) f.bind(work);
  const run = () => claimReadyBoardWork(f.store, f.project.id, m => m.id !== active.id && !f.store.listPending(m.id).some(d => d.wake));
  f.store.db.exec("CREATE TEMP TRIGGER reject_claim BEFORE UPDATE OF sec ON work WHEN NEW.sec = 'doing' BEGIN SELECT RAISE(ABORT,'rollback assignment'); END");
  expect(run).toThrow("rollback assignment");
  expect(f.store.listDeliveries(f.project.id)).toEqual([]);
  expect(f.store.listWork(f.project.id).every(w => w.sec === "next")).toBe(true);
  f.store.db.exec("DROP TRIGGER reject_claim");
  expect(run().map(d => [d.taskId, d.memberId])).toEqual([[f.id(a), free.id]]);
  expect(run()).toEqual([]);
  expect(f.store.getWork(b.id)?.sec).toBe("next");
});

test("rechecks the same claimed delivery after a board hold or contract change before terminal input", () => {
  const f = setup(), worker = f.worker("담당");
  const card = f.card("검수 재현"); f.bind(card, { acceptance: ["등록 당시의 판정 기준"] });
  const [receipt] = f.claim();
  expect(receipt).toBeDefined();
  const allows = () => sharedWorkAllowsDelivery(f.store, receipt!);
  expect(allows()).toBe(true);
  f.store.upsertWork({ ...card, sec: "hold" });
  expect(allows()).toBe(false);
  f.store.upsertWork({ ...card, sec: "next", who: worker.name });
  f.bind(card, { scope: null });
  expect(allows()).toBe(false);
  f.bind(card, { acceptance: ["변경된 현재 조건"] });
  expect(allows()).toBe(true);
  expect(f.store.requireDelivery(receipt!.id).text).not.toContain("등록 당시의 판정 기준");
  f.store.patchMember(worker.id, { codexSpeed: "fast" });
  expect(allows()).toBe(false);
  expect(f.store.listDeliveries(f.project.id).map(d => d.id)).toEqual([receipt!.id]);
});

test("a parent board hold imposed after the child claim stops its existing receipt until resumed", () => {
  const f = setup(); f.worker("담당");
  const parent = f.store.ensureSourceTask({ projectId: f.project.id, origin: "owner", sourceRef: "scene", title: "장면 분석" }).task;
  const child = f.store.ensureSourceTask({ projectId: f.project.id, origin: "owner", sourceRef: "lighting", title: "조명", parentTaskId: parent.id }).task;
  const work = f.card("조명 점검", "", child.id);
  f.bind(work);
  const [receipt] = f.claim();
  expect(receipt).toBeDefined();
  const hold = f.store.upsertWork({ projectId: f.project.id, taskId: parent.id, sec: "hold", title: parent.title });
  expect(sharedWorkAllowsDelivery(f.store, receipt!)).toBe(false);
  f.store.upsertWork({ ...hold, sec: "doing" });
  expect(sharedWorkAllowsDelivery(f.store, receipt!)).toBe(true);
});

test("an open card uses a free general worker when another ready card needs the first worker by name", () => {
  const f = setup(), named = f.worker("계정 담당"), alternate = f.worker("자료 담당");
  const general = f.card("기록 확인"), pinned = f.card("요청 확인", named.name);
  f.bind(general); f.bind(pinned);
  expect(f.claim().map(d => [d.taskId, d.memberId]).sort()).toEqual([[f.id(general), alternate.id], [f.id(pinned), named.id]].sort());
});

test("a live parent instruction keeps its child out of the shared queue without reserving unrelated workers", () => {
  const f = setup(), designer = f.worker("장면 설계"), renderer = f.worker("장면 구현");
  const parent = f.store.ensureSourceTask({ projectId: f.project.id, origin: "owner", sourceRef: "parent", title: "장면" }).task;
  const child = f.store.ensureSourceTask({ projectId: f.project.id, origin: "owner", sourceRef: "child", title: "조명", parentTaskId: parent.id }).task;
  const earlier = f.store.enqueue({ projectId: f.project.id, memberId: designer.id, taskId: parent.id, kind: "instruction", text: "장면 설계 처리" });
  const linked = f.card("조명 작업", renderer.name, child.id), independent = f.card("별개의 배경", renderer.name);
  f.bind(linked); f.bind(independent);
  expect(claimReadyBoardWork(f.store, f.project.id, m => m.id === renderer.id).map(d => d.taskId)).toEqual([f.id(independent)]);
  expect(f.store.requireDelivery(earlier.id)).toEqual(earlier);
  expect(f.store.getWork(linked.id)?.sec).toBe("next");
});

test("a derived repair keeps the finding's author and waits for a source stop or decision to clear before its one physical write", async () => {
  const f = await createQueueStatusFixture();
  try {
    const store = f.store, projectId = f.project.id, reviewer = store.ensureFinalReviewer(projectId)!;
    const source = store.ensureSourceTask({ projectId, title: "Scene source", sourceRef: "scene-source", origin: "owner" }).task;
    const contract = { kind: "other" as const, goal: "Check scene", scope: "Scene output", inputs: ["Scene"], outputs: ["Result"], constraints: [], exclusions: [], acceptance: ["Reproduced"] };
    store.saveTaskContract(source.id, contract, { author: "Owner", authorKind: "owner", authorMemberId: null });
    const report = store.createMessage({ projectId, taskId: source.id, mine: false, who: f.member.name, memberId: f.member.id, kind: "완료", title: "Original report" });
    const mark = store.addStageMark({ projectId, taskId: source.id, memberId: null, who: "Harness", stage: "done", evidence: "Original report checked" });
    const finding = store.createMessage({ projectId, taskId: source.id, mine: false, memberId: reviewer.id, who: reviewer.name,
      kind: "알림", aboutMessageId: report.id, title: "Missing output" });
    store.db.query(`INSERT INTO task_completion_reviews(task_id,report_id,contract_task_id,contract_rev,mark_id,status,completed_at,reviewer_id)
      VALUES(?,?,?,1,?,'changes_requested',?,?)`).run(source.id,report.id,source.id,mark.id,new Date().toISOString(),reviewer.id);
    store.addStageMark({ projectId, taskId: source.id, memberId: reviewer.id, who: reviewer.name, stage: "reopen", evidence: "Repair this finding" });
    const repair = store.ensureSourceTask({ projectId, title: "Reproduce missing output", origin: "auto", sourceRef: `main-repair:${source.id}:${finding.id}` }).task;
    const card = store.upsertWork({ projectId, taskId: repair.id, title: repair.title, detail: "Verify missing footage", sec: "next" });
    expect(prepareReviewedRepair(store, card)).toBe(f.member.id);
    const later = store.createMessage({ projectId, taskId: source.id, mine: false, who: f.member.name, memberId: f.member.id,
      kind: "완료", title: "Another output on the same contract" });
    store.db.query(`INSERT INTO task_completion_reviews(task_id,report_id,contract_task_id,contract_rev,mark_id,status,completed_at,reviewer_id)
      VALUES(?,?,?,1,?,'confirmed',?,?)`).run(source.id,later.id,source.id,mark.id,new Date().toISOString(),reviewer.id);
    const stop = new TaskContinuationCoordinator(store, { intervalMs: 30_000, sameLimit: 3 });
    const claim = () => claimReadyBoardWork(store, projectId, m => m.id === f.member.id);
    stop.pause([source.id], "stop", "Review the source first");
    expect(claim()).toEqual([]);
    stop.clearPause([source.id], "stop");
    const [receipt] = claim();
    expect(receipt?.memberId).toBe(f.member.id);
    const other = store.createMember({ projectId, name: "Other worker", handle: "workerb", kind: "worker", status: "idle", paneId: "b" });
    store.upsertWork({ ...card, sec: "next", who: other.name });
    expect(claimReadyBoardWork(store, projectId, () => true)).toEqual([]);
    expect(sharedWorkAllowsDelivery(store, receipt!)).toBe(false);
    store.upsertWork({ ...card, sec: "doing", who: f.member.name });
    const hold = store.upsertWork({ projectId, taskId: source.id, sec: "hold", title: source.title });
    expect(sharedWorkAllowsDelivery(store, receipt!)).toBe(false);
    store.upsertWork({ ...hold, sec: "doing" });
    stop.pause([source.id], "stop", "Pause before terminal write");
    await f.orch.pump(f.member.id);
    expect(f.writes).toHaveLength(0);
    stop.clearPause([source.id], "stop");
    const decision = store.createDecision({ projectId, taskId: source.id, who: "Lead", title: "Permit the missing footage?" });
    await f.orch.pump(f.member.id);
    expect(f.writes).toHaveLength(0);
    store.closeDecision(decision.id, { by: "Lead", kind: "obsolete", reason: "Source can proceed" });
    await f.orch.pump(f.member.id);
    await f.orch.pump(f.member.id);
    expect(f.writes).toHaveLength(1);
    expect(store.requireDelivery(receipt!.id)).toMatchObject({ status: "delivered", attempts: 1 });
  } finally { await f.stop(); }
});

test("a separately contracted integration issue with a worker problem report remains assignable", () => {
  const f = setup(), member = f.worker("Staff");
  const source = f.store.ensureSourceTask({ projectId:f.project.id, title:"Source", origin:"owner", sourceRef:"reported-source" }).task;
  const issue = f.store.createMessage({ projectId:f.project.id, taskId:source.id, memberId:member.id, mine:false, who:member.name, kind:"알림", aboutMessageId:"msg_thread_context", title:"Missing schema" });
  const task = f.store.ensureSourceTask({ projectId:f.project.id, title:"Restore schema", origin:"auto", sourceRef:`main-repair:${source.id}:${issue.id}` }).task;
  const card = f.card(task.title, member.name, task.id); f.bind(card);
  const [receipt] = f.claim();
  expect(receipt?.taskId).toBe(task.id);
  expect(sharedWorkAllowsDelivery(f.store, receipt!)).toBe(true);
});

test("changing the board to another named worker atomically moves an untouched claim once, even if that name matches the old role", () => {
  const f = setup(), first = f.worker("Original", "Rendering"), second = f.worker("Rendering");
  const work = f.card("Check the scene", "@" + first.handle); f.bind(work);
  const [old] = f.claim();
  f.store.upsertWork({ ...work, sec: "doing", who: second.name });
  expect(sharedWorkAllowsDelivery(f.store, old!)).toBe(false);
  const [moved] = f.claim();
  expect(moved).toMatchObject({ id: old!.id, memberId: second.id, attempts: 0, status: "queued" });
  expect(moved!.refId).not.toEqual(old!.refId);
  expect(f.store.requireMessage(old!.refId!).targetMemberId).toBe(first.id);
  expect(f.store.requireMessage(moved!.refId!).targetMemberId).toBe(second.id);
  expect(f.store.db.query("SELECT member_id FROM task_sequence WHERE task_id=?").all(f.id(work))).toEqual([{ member_id: second.id }]);
  expect(f.store.listPending(first.id)).toEqual([]);
  expect(f.store.listPending(second.id).map(d => d.id)).toEqual([old!.id]);
  expect(sharedWorkAllowsDelivery(f.store, old!)).toBe(false);
  expect(sharedWorkAllowsDelivery(f.store, moved!)).toBe(true);
  expect(f.claim()).toEqual([]);
});

test("a prior terminal attempt preserves the assigned receipt across a board recipient change", () => {
  const f = setup(), first = f.worker("First"), second = f.worker("Second");
  const work = f.card("Review the result", first.name); f.bind(work);
  const [old] = f.claim();
  f.store.setDeliveryStatus(old!.id, "queued", { attempt: true });
  f.store.upsertWork({ ...work, sec: "next", who: second.name });
  expect(f.claim()).toEqual([]);
  expect(f.store.requireDelivery(old!.id)).toMatchObject({ attempts: 1, memberId: first.id });
  expect(sharedWorkAllowsDelivery(f.store, old!)).toBe(false);
});


test("an unavailable transfer on a parent preserves its pending scope against a new child claim", () => {
  const f = setup(), first = f.worker("First"), second = f.worker("Second"), third = f.worker("Third");
  const parent = f.store.ensureSourceTask({ projectId:f.project.id, origin:"owner", sourceRef:"parent", title:"Project scene" }).task;
  const work = f.card(parent.title, first.name, parent.id); f.bind(work);
  expect(f.claim()).toHaveLength(1);
  f.store.upsertWork({ ...work, sec:"next", who:second.name });
  const child = f.store.ensureSourceTask({ projectId:f.project.id, origin:"owner", sourceRef:"child", title:"Lighting", parentTaskId:parent.id }).task;
  const lighting = f.card(child.title, third.name, child.id); f.bind(lighting);
  expect(claimReadyBoardWork(f.store, f.project.id, m => m.id === third.id)).toEqual([]);
});
