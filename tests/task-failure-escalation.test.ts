import { expect, test } from "bun:test";
import { Store } from "../server/store.ts";
import { Bus } from "../server/bus.ts";
import type { Runner, RunnerMember } from "../server/runner/types.ts";
import { fixture } from "./fixtures/harness-fixture.ts";

const contract = { kind: "other", goal: "요청한 결과 제공", acceptance: ["저장한 결과를 다시 읽을 수 있다"], checks: [] };
type F = ReturnType<typeof fixture>;
async function task(f: F, parentTaskId?: string, title = "저장 결과") {
  const response = await f.tool(f.lead, "task", { title, contract, ...(parentTaskId ? { parent_task_id: parentTaskId } : {}) });
  expect(response.isError).toBeUndefined();
  return response.text.match(/#(tk_[\w-]+)/)![1]!;
}
async function fail(f: F, taskId: string, name = "저장 결과 다시 읽기", member = f.worker, correctsMessageId?: string) {
  const result = await f.tool(member, "post", { task_id: taskId, kind: "막힘", title: "결과 검증 실패", contract_rev: 1,
    ...(correctsMessageId ? { corrects_message_id: correctsMessageId, body: "이전 보고의 설명만 정정합니다. 다시 실행하지 않았습니다." } : {}),
    checks: [{ name, kind: "other", result: "fail", evidence: "저장 결과를 다시 읽으면 값이 비어 있습니다", criterion: 1 }] });
  expect(result.isError).toBeUndefined();
  return result.text.match(/#(msg_[\w-]+)/)![1]!;
}
const open = (f: F) => f.store.listDecisions(f.project.id).filter(d => d.status === "open");

test("the third identical worker failure creates one actionable decision and preserves it across restart", async () => {
  const f = fixture(), id = await task(f);
  await fail(f, id); await fail(f, id);
  expect(open(f)).toHaveLength(0);
  const third = await fail(f, id);
  expect(open(f)).toHaveLength(1);
  const decision = open(f)[0]!;
  expect(decision.taskId).toBe(id);
  expect(decision.memberId).toBe(f.lead.id);
  expect(decision.detail).toContain("3");
  expect(decision.detail).toContain("저장 결과 다시 읽기");
  expect(decision.detail).toContain(contract.acceptance[0]!);
  expect(decision.detail).toContain(third);
  expect(f.store.taskProgress(id).stage).toBe("owner");
  await fail(f, id);
  f.orch.checkTaskWatches(Date.now() + 12 * 60 * 60_000);
  expect(open(f).map(d => d.id)).toEqual([decision.id]);
  const restarted = new Store(f.store.db, new Bus());
  expect(restarted.pendingTaskFailureDecision(id)?.id).toBe(decision.id);
});

test("conductor summaries do not count as another failed implementation attempt", async () => {
  const f = fixture(), id = await task(f);
  await fail(f, id);
  await fail(f, id, "저장 결과 다시 읽기", f.lead);
  await fail(f, id, "저장 결과 다시 읽기", f.lead);
  expect(open(f)).toHaveLength(0);
  expect(f.store.getTaskWatch(id)?.same).toBe(1);
  await fail(f, id); await fail(f, id);
  expect(open(f)).toHaveLength(1);
});

test("a changed failure resets the identical-failure count", async () => {
  const f = fixture(), id = await task(f);
  await fail(f, id); await fail(f, id);
  await fail(f, id, "권한 거절");
  expect(open(f)).toHaveLength(0);
  expect(f.store.getTaskWatch(id)?.same).toBe(1);
  await fail(f, id, "권한 거절"); await fail(f, id, "권한 거절");
  expect(open(f)).toHaveLength(1);
});

test("a conductor cannot bypass the failure decision by reopen, reassignment, or an obsolete close", async () => {
  const f = fixture(), id = await task(f);
  for (let i = 0; i < 3; i++) await fail(f, id);
  expect(open(f)).toHaveLength(1);
  const decision = open(f)[0]!;
  const reopen = () => f.tool(f.lead, "task_stage", { task_id: id, stage: "reopen", evidence: "접근을 바꿉니다" });
  expect((await reopen()).isError).toBe(true);
  expect((await f.tool(f.lead, "team_assign", { member: f.worker.handle, task_id: id, text: "다시 확인" })).isError).toBe(true);
  const close = await f.tool(f.lead, "ask_close", { id: decision.id, kind: "obsolete", reason: "다시 하면 될 것 같습니다", follow_up: { kind: "none" } });
  expect(close.isError).toBe(true);
  expect(f.store.requireDecision(decision.id).status).toBe("open");
  expect((await reopen()).isError).toBe(true);
  // Even an old obsolete-close record cannot remove the owner gate.
  f.store.closeDecision(decision.id, { kind: "obsolete", reason: "old fixture record", by: "총괄" });
  expect((await reopen()).isError).toBe(true);
});

test("an explicit owner answer permits a new scoped attempt and another three failures create a new card", async () => {
  const f = fixture(), id = await task(f);
  for (let i = 0; i < 3; i++) await fail(f, id);
  expect(open(f)).toHaveLength(1);
  const first = open(f)[0]!;
  f.store.answerDecision(first.id, { note: "저장 경로를 확인한 뒤 같은 업무를 다시 시도하세요" });
  expect((await f.tool(f.lead, "task_stage", { task_id: id, stage: "reopen", evidence: "대표 답에 따라 저장 경로부터 확인" })).isError).toBeUndefined();
  expect(f.store.pendingTaskFailureDecision(id)).toBeNull();
  for (let i = 0; i < 3; i++) await fail(f, id);
  expect(open(f)).toHaveLength(1);
  expect(open(f)[0]!.id).not.toBe(first.id);
});

test("the owner gate also covers a derived task and an apparent pass cannot erase it", async () => {
  const f = fixture(), id = await task(f);
  for (let i = 0; i < 3; i++) await fail(f, id);
  const child = f.store.saveTask({ projectId: f.project.id, memberId: f.lead.id, who: f.lead.name, title: "같은 결과의 파생 업무", parentTaskId: id }).task;
  expect((await f.tool(f.lead, "team_assign", { member: f.worker.handle, task_id: child.id, text: "아래 업무로 계속" })).isError).toBe(true);
  expect((await f.tool(f.lead, "task_stage", { task_id: child.id, stage: "reopen", evidence: "새 업무로 재개" })).isError).toBe(true);
  const completed = await f.tool(f.worker, "post", { task_id: id, kind: "완료", title: "통과했다고 보고", contract_rev: 1,
    checks: [{ name: "다시 읽기", kind: "other", result: "pass", evidence: "값을 확인했습니다", criterion: 1 }] });
  expect(completed.isError).toBe(true);
  expect(open(f)).toHaveLength(1);
  expect(f.store.getTaskWatch(id)?.trippedAt).toBeTruthy();
});

for (const source of ["before_failure", "unrelated_task", "unscoped"] as const) {
  test(`a failure decision rejects an owner quote from ${source}`, async () => {
    const f = fixture(), id = await task(f), unrelated = await task(f, undefined, "다른 결과");
    const quote = "저장 경로를 확인한 뒤 다시 시도하세요";
    const ownerMessage = () => f.store.createMessage({ projectId: f.project.id, mine: true, who: "나", kind: "나", body: quote,
      taskId: source === "unrelated_task" ? unrelated : source === "unscoped" ? null : id });
    if (source === "before_failure") ownerMessage();
    for (let i = 0; i < 3; i++) await fail(f, id);
    if (source !== "before_failure") ownerMessage();
    const decision = open(f)[0]!;
    const close = await f.tool(f.lead, "ask_close", { id: decision.id, kind: "decided", reason: "대표가 정한 대로 재개", user_quote: quote, follow_up: { kind: "none" } });
    expect(close.isError).toBe(true);
    expect(f.store.requireDecision(decision.id).status).toBe("open");
    expect((await f.tool(f.lead, "task_stage", { task_id: id, stage: "reopen", evidence: "대표의 다른 지시를 적용" })).isError).toBe(true);
  });
}

test("a persisted decided-close without a new scoped owner source remains blocked after restart", async () => {
  const f = fixture(), id = await task(f), quote = "저장 경로를 확인한 뒤 다시 시도하세요";
  f.store.createMessage({ projectId: f.project.id, mine: true, who: "나", kind: "나", body: quote, taskId: id });
  for (let i = 0; i < 3; i++) await fail(f, id);
  const decision = open(f)[0]!;
  f.store.closeDecision(decision.id, { kind: "decided", reason: "old fixture record", by: "총괄", quote });
  const restarted = new Store(f.store.db, new Bus());
  expect(restarted.pendingTaskFailureDecision(id)?.id).toBe(decision.id);
  restarted.ensureTaskFailureDecision(id);
  expect(restarted.listDecisions(f.project.id)).toHaveLength(1);
});

test("a new scoped owner quote permits the close and its follow-up atomically, even in the same millisecond", async () => {
  const f = fixture(), parent = await task(f), id = await task(f, parent, "하위 저장 검사");
  const quote = "저장 경로를 확인한 뒤 다시 시도하세요";
  // An identical older quote must not hide the valid post-failure source.
  f.store.createMessage({ projectId: f.project.id, mine: true, who: "나", kind: "나", body: quote, taskId: id });
  let third = "";
  for (let i = 0; i < 3; i++) third = await fail(f, id);
  const decision = open(f)[0]!;
  const owner = f.store.createMessage({ projectId: f.project.id, mine: true, who: "나", kind: "나", body: quote,
    taskId: parent, at: f.store.requireMessage(third).at });
  const close = await f.tool(f.lead, "ask_close", { id: decision.id, kind: "decided", reason: "대표가 저장 경로 확인 후 재시도를 정함", user_quote: quote,
    follow_up: { kind: "instruction", member_id: f.worker.id, source_message_id: owner.id, text: "저장 경로를 확인한 뒤 다시 검사하세요" } });
  expect(close.isError).toBeUndefined();
  expect(f.store.requireDecision(decision.id).status).toBe("closed");
  const restarted = new Store(f.store.db, new Bus());
  expect(restarted.pendingTaskFailureDecision(id)).toBeNull();
  await f.orch.pump(f.worker.id);
  expect(f.runner.to(f.worker)).toHaveLength(1);
});

test("a failed descendant blocks parent reassignment and reopening while unrelated work remains available", async () => {
  const f = fixture(), parent = await task(f), child = await task(f, parent, "하위 저장 검사"), unrelated = await task(f, undefined, "별도 결과");
  for (let i = 0; i < 3; i++) await fail(f, child);
  const decision = open(f)[0]!;
  expect(f.store.pendingTaskFailureDecision(parent)?.id).toBe(decision.id);
  expect((await f.tool(f.lead, "team_assign", { member: f.worker.handle, task_id: parent, text: "하위 실패를 포함해 다시 수정하세요" })).isError).toBe(true);
  expect((await f.tool(f.lead, "task_stage", { task_id: parent, stage: "reopen", evidence: "상위 업무로 다시 시도" })).isError).toBe(true);
  expect(f.store.pendingTaskFailureDecision(unrelated)).toBeNull();
  expect((await f.tool(f.lead, "team_assign", { member: f.worker2.handle, task_id: unrelated, text: "별도 결과를 확인하세요" })).isError).toBeUndefined();
  expect(f.runner.to(f.worker)).toHaveLength(0);
  expect(f.runner.to(f.worker2)).toHaveLength(1);
});

test("correcting a failed report, including a correction chain, does not create new attempts", async () => {
  const f = fixture(), id = await task(f);
  const first = await fail(f, id);
  const correction = await fail(f, id, undefined, undefined, first);
  await fail(f, id, undefined, undefined, correction);
  expect(f.store.getTaskWatch(id)).toMatchObject({ attempts: 1, same: 1, trippedAt: null });
  expect(open(f)).toHaveLength(0);
  await fail(f, id);
  expect(open(f)).toHaveLength(0);
  await fail(f, id);
  expect(f.store.getTaskWatch(id)).toMatchObject({ attempts: 3, same: 3 });
  expect(open(f)).toHaveLength(1);
});

for (const queuedScope of ["same", "ancestor", "descendant"] as const) {
  test(`an already queued ${queuedScope} instruction is preserved until the failure decision is answered`, async () => {
    const f = fixture(), parent = await task(f), child = await task(f, parent, "하위 저장 검사");
    const failedId = queuedScope === "descendant" ? parent : child;
    const queuedId = queuedScope === "ancestor" ? parent : child;
    f.runner.busy.add(f.worker.id);
    f.store.patchMember(f.worker.id, { status: "working" });
    expect((await f.tool(f.lead, "team_assign", { member: f.worker.handle, task_id: queuedId, text: "저장 결과를 다시 확인하세요" })).isError).toBeUndefined();
    const queued = f.store.listPending(f.worker.id).find(d => d.kind === "instruction")!;
    expect(queued).toBeDefined();
    for (let i = 0; i < 3; i++) await fail(f, failedId);
    f.runner.busy.delete(f.worker.id);
    f.runner.callback({ type: "status", memberId: f.worker.id, status: "idle" });
    await f.orch.pump(f.worker.id);
    expect(f.runner.to(f.worker)).toHaveLength(0);
    expect(f.store.requireDelivery(queued.id)).toMatchObject({ status: "queued", attempts: 0, text: queued.text });
    f.store.answerDecision(open(f)[0]!.id, { note: "저장 경로를 확인하고 대기 중인 지시를 계속하세요" });
    await f.orch.pump(f.worker.id);
    expect(f.runner.to(f.worker)).toHaveLength(1);
    expect(f.store.requireDelivery(queued.id).status).toBe("delivered");
  });
}

test("reopening a parent resets resolved descendant episodes only after every related owner card is resolved", async () => {
  const f = fixture(), parent = await task(f), child = await task(f, parent, "첫 저장 검사"), sibling = await task(f, parent, "두 번째 저장 검사");
  const unrelated = await task(f, undefined, "별도 저장 검사");
  for (const id of [child, sibling, unrelated]) for (let i = 0; i < 3; i++) await fail(f, id);
  const first = f.store.pendingTaskFailureDecision(child)!, second = f.store.pendingTaskFailureDecision(sibling)!;
  f.store.answerDecision(first.id, { note: "첫 저장 경로를 바꾸어 다시 시도하세요" });
  expect((await f.tool(f.lead, "task_stage", { task_id: parent, stage: "reopen", evidence: "첫 검사 답을 받음" })).isError).toBe(true);
  expect(f.store.pendingTaskFailureDecision(parent)?.id).toBe(second.id);
  const quote = "두 번째 저장 검사도 경로를 확인한 뒤 다시 시도하세요";
  f.store.createMessage({ projectId: f.project.id, mine: true, who: "나", kind: "나", body: quote, taskId: sibling });
  expect((await f.tool(f.lead, "ask_close", { id: second.id, kind: "decided", reason: "대표가 두 번째 검사도 재시도하라고 정함", user_quote: quote, follow_up: { kind: "none" } })).isError).toBeUndefined();
  expect((await f.tool(f.lead, "task_stage", { task_id: parent, stage: "reopen", evidence: "두 하위 검사 모두 대표 판단을 받음" })).isError).toBeUndefined();
  expect(f.store.getTaskWatch(child)).toMatchObject({ same: 0, trippedAt: null });
  expect(f.store.getTaskWatch(sibling)).toMatchObject({ same: 0, trippedAt: null });
  expect(f.store.getTaskWatch(unrelated)).toMatchObject({ same: 3, trippedAt: expect.any(String) });
  await fail(f, child); await fail(f, child);
  expect(f.store.pendingTaskFailureDecision(child)).toBeNull();
  await fail(f, child);
  expect(f.store.pendingTaskFailureDecision(child)?.id).not.toBe(first.id);
  f.orch.checkTaskWatches();
  expect(open(f)).toHaveLength(2);
});

test("a pending failure decision also preserves queued manual inbox input", async () => {
  const f = fixture(), id = await task(f);
  const manual = f.store.createMember({ projectId: f.project.id, handle: "manual", name: "수동 직원", kind: "worker", origin: "manual", status: "idle" });
  const queued = f.store.enqueue({ projectId: f.project.id, memberId: manual.id, kind: "instruction", taskId: id, text: "이전부터 대기한 검사" });
  for (let i = 0; i < 3; i++) await fail(f, id);
  expect(await f.orch.manualInbox(manual.id, 0)).toBeNull();
  expect(await f.orch.waitInbox(manual, 0)).toBeNull();
  expect(f.store.requireDelivery(queued.id).status).toBe("queued");
  f.store.answerDecision(open(f)[0]!.id, { note: "대기 중인 검사를 다시 실행하세요" });
  const batch = await f.orch.manualInbox(manual.id, 0);
  expect(batch?.items.map(item => item.deliveryId)).toEqual([queued.id]);
});

test("recovery cannot resend an already prepared failed-task envelope before the owner answers", async () => {
  const f = fixture(), id = await task(f);
  const queued = f.store.enqueue({ projectId: f.project.id, memberId: f.worker.id, kind: "instruction", taskId: id, text: "복구 중인 이전 검사" });
  const dispatch = f.orch.deliveryRecovery.prepareDispatch([queued.id], { terminalId: f.worker.paneId, sessionId: f.worker.sessionId, sessionGeneration: 0, process: null },
    { serverEpoch: "test", turn: 0, inputEpoch: 0, logs: [], capturedAt: new Date().toISOString() });
  const runner: Runner = f.runner;
  let repairs = 0;
  runner.repairDelivery = async () => { repairs++; return { ok: true, started: false, turn: 0 }; };
  for (let i = 0; i < 3; i++) await fail(f, id);
  const request = { action: "resend" as const, dispatchId: dispatch.dispatchId, expectedRecoveryVersion: 1, expectedSessionGeneration: 0,
    expectedSessionId: f.worker.sessionId, expectedTerminalId: f.worker.paneId!, expectedInputEpoch: 0 };
  const member: RunnerMember = { ...f.worker, model: null, effort: null, subagentModel: null, permissionMode: "default", sessionGeneration: 0 };
  expect(await f.orch.recoveryRunner(f.worker)!.repairDelivery!(member, request)).toMatchObject({ ok: false, reason: "busy", deliveryEffect: "not_written" });
  expect(repairs).toBe(0);
  expect(f.store.requireDelivery(queued.id).text).toBe(queued.text);
  f.store.answerDecision(open(f)[0]!.id, { note: "기존 대기 입력을 다시 전달하세요" });
  expect((await f.orch.recoveryRunner(f.worker)!.repairDelivery!(member, request)).ok).toBe(true);
  expect(repairs).toBe(1);
});

for (const resolution of ["answer", "decided_close"] as const) {
  test(`a dispatched retry after ${resolution} starts a new failure episode without requiring an explicit reopen`, async () => {
    const f = fixture(), id = await task(f);
    f.runner.busy.add(f.worker.id);
    f.store.patchMember(f.worker.id, { status: "working" });
    expect((await f.tool(f.lead, "team_assign", { member: f.worker.handle, task_id: id, text: "저장 결과를 다시 검사하세요" })).isError).toBeUndefined();
    let third = "";
    for (let i = 0; i < 3; i++) third = await fail(f, id);
    const original = open(f)[0]!;
    const quote = "대기 중인 저장 검사를 새 경로에서 다시 실행하세요";
    if (resolution === "answer") f.store.answerDecision(original.id, { note: quote });
    else {
      f.store.createMessage({ projectId: f.project.id, mine: true, who: "나", kind: "나", body: quote, taskId: id });
      expect((await f.tool(f.lead, "ask_close", { id: original.id, kind: "decided", reason: "대표가 재시도를 정함", user_quote: quote, follow_up: { kind: "none" } })).isError).toBeUndefined();
    }
    const oldTrip = f.store.getTaskWatch(id)!.trippedAt;
    await fail(f, id, undefined, undefined, third);
    expect(f.store.getTaskWatch(id)).toMatchObject({ same: 3, trippedAt: oldTrip });
    // An old running turn's late failure is not proof that the retry started.
    await fail(f, id);
    expect(f.store.getTaskWatch(id)?.trippedAt).toBe(oldTrip);
    f.runner.busy.delete(f.worker.id);
    f.runner.callback({ type: "status", memberId: f.worker.id, status: "idle" });
    await f.orch.pump(f.worker.id);
    expect(f.runner.to(f.worker)).toHaveLength(1);
    await fail(f, id, undefined, undefined, third);
    expect(f.store.getTaskWatch(id)?.trippedAt).toBe(oldTrip);
    await fail(f, id);
    expect(f.store.getTaskWatch(id)).toMatchObject({ same: 1, trippedAt: null });
    await fail(f, id);
    expect(f.store.pendingTaskFailureDecision(id)).toBeNull();
    await fail(f, id);
    const next = f.store.pendingTaskFailureDecision(id)!;
    expect(next).not.toBeNull();
    expect(next.id).not.toBe(original.id);
    expect(open(f)).toHaveLength(1);
  });
}
