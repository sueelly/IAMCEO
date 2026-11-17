import { expect, test } from "bun:test";
import { fixture, until } from "./fixtures/harness-fixture.ts";
import { TaskContinuationCoordinator } from "../server/task-continuation.ts";

const id = (r: { text: string }, prefix = "tk") => r.text.match(new RegExp(`#(${prefix}_[\\w-]+)`))![1]!;
const OTHER = { kind: "other", goal: "인계 문서를 전달한다", acceptance: ["인계 문서에서 담당자와 남은 판단을 확인할 수 있다"], checks: [] };
const checked = { name: "인계 문서 검토", kind: "other", result: "pass", evidence: "인계 문서의 담당자 열과 미정 사항을 검토했다", criterion: 1 };

function queuedDelegation(proposed = false) {
  const f = fixture();
  const task = f.orch.saveTask(proposed ? f.worker : f.lead, { title: "대기 중인 인계 문서", ...(proposed ? { contract: { ...OTHER, kind: "other" as const } } : {}) }).task;
  // A pre-policy delegated instruction already waiting for an execution slot.
  const delivery = f.store.enqueue({ projectId: f.project.id, memberId: f.worker.id, taskId: task.id,
    kind: "instruction", text: "[총괄] 인계 문서의 담당자와 남은 판단을 정리하세요", wake: true });
  f.store.noteDelegation(f.lead.id, delivery, true);
  const coordinator = () => new TaskContinuationCoordinator(f.store, { intervalMs: 1000, sameLimit: 3 });
  return { ...f, task, delivery, coordinator };
}

for (const proposed of [false, true]) {
  test(`이미 대기 중인 위임의 ${proposed ? "직원 제안" : "누락 기준"}을 확정할 때까지 원 지시는 보존하고 총괄에게 한 번 연결한다`, async () => {
    const f = queuedDelegation(proposed), now = Date.now() + 10000;
    await f.orch.pump(f.worker.id);
    expect(f.runner.to(f.worker)).toHaveLength(0);
    expect(f.store.requireDelivery(f.delivery.id)).toEqual(f.delivery);
    expect(f.store.listDeliveryDispatches(f.delivery.id)).toHaveLength(0);
    const next = f.coordinator(), reminders = next.check(now, () => true);
    expect(reminders).toHaveLength(1);
    expect(reminders[0]).toMatchObject({ memberId: f.lead.id, taskId: f.task.id, kind: "system", wake: true });
    expect(reminders[0]!.text).toContain(f.delivery.id);
    expect(reminders[0]!.text).toContain("기준");
    expect(next.canDispatch(reminders[0]!)).toBe(true);
    expect(next.check(now + 10000, () => true)).toHaveLength(0);
    expect(f.coordinator().check(now + 20000, () => true)).toHaveLength(0);
    expect(f.store.listTaskDeliveries(f.task.id).filter(d => d.kind === "instruction")).toHaveLength(1);
    expect(f.store.requireDelivery(f.delivery.id)).toEqual(f.delivery);

    const confirmed = await f.tool(f.lead, "task", { task_id: f.task.id,
      ...(proposed ? { confirm_contract_rev: 1 } : { contract: OTHER }) });
    expect(confirmed.isError, confirmed.text).toBeUndefined();
    // Confirmation retires the now-obsolete reminder, never the original input.
    expect(next.canDispatch(reminders[0]!)).toBe(false);
    expect(f.store.requireDelivery(reminders[0]!.id).status).toBe("failed");
    await f.orch.pump(f.worker.id);
    expect(f.runner.to(f.worker)).toHaveLength(1);
    expect(f.runner.to(f.worker)[0]).toContain(f.delivery.text);
    await f.orch.pump(f.worker.id);
    expect(f.runner.to(f.worker)).toHaveLength(1);
    expect(f.store.requireDelivery(f.delivery.id)).toMatchObject({ status: "delivered", text: f.delivery.text });
    expect(f.store.listTaskDeliveries(f.task.id).filter(d => d.kind === "instruction")).toHaveLength(1);
  });
}

test("뒤에 대표 지시가 전달되어도 앞서 대기 중인 위임의 완료 기준을 확정하고 원 지시를 한 번 전달한다", async () => {
  const f = queuedDelegation(), now = Date.now() + 10000;
  const owner = f.store.createMessage({ projectId: f.project.id, mine: true, who: "나", kind: "나", taskId: f.task.id,
    body: "영희는 현재 담당자를 먼저 확인해주세요" });
  const later = f.store.enqueue({ projectId: f.project.id, memberId: f.worker2.id, taskId: f.task.id,
    kind: "user_message", refType: "message", refId: owner.id, text: owner.body, wake: true });
  f.store.markDelivered(later.id);
  await f.orch.pump(f.worker.id);
  expect(f.runner.to(f.worker)).toHaveLength(0);
  const next = f.coordinator(), reminders = next.check(now, () => true);
  expect(reminders).toHaveLength(1);
  expect(reminders[0]!.text).toContain(f.delivery.id);
  expect(reminders[0]!.text).toContain(owner.body);
  expect(next.canDispatch(reminders[0]!)).toBe(true);
  expect(f.coordinator().check(now + 10000, () => true)).toHaveLength(0);
  expect(f.store.requireDelivery(f.delivery.id)).toEqual(f.delivery);
  expect(f.store.requireDelivery(later.id).status).toBe("delivered");
  const confirmed = await f.tool(f.lead, "task", { task_id: f.task.id, contract: OTHER });
  expect(confirmed.isError, confirmed.text).toBeUndefined();
  expect(next.canDispatch(reminders[0]!)).toBe(false);
  await f.orch.pump(f.worker.id);
  await f.orch.pump(f.worker.id);
  expect(f.runner.to(f.worker)).toHaveLength(1);
  expect(f.runner.to(f.worker)[0]).toContain(f.delivery.text);
  expect(f.store.requireDelivery(f.delivery.id)).toMatchObject({ status: "delivered", text: f.delivery.text });
});

test("위임 증거가 없는 오래된 instruction은 대표 지시로 추정해 기준 요청을 만들지 않는다", async () => {
  const f = fixture(), task = f.orch.saveTask(f.lead, { title: "출처가 없는 과거 지시" }).task;
  const delivery = f.store.enqueue({ projectId: f.project.id, memberId: f.worker.id, taskId: task.id,
    kind: "instruction", text: "저장된 업무 메모를 확인하세요", wake: true });
  const next = new TaskContinuationCoordinator(f.store, { intervalMs: 1000, sameLimit: 3 });
  expect(next.check(Date.now() + 10000, () => true)).toHaveLength(0);
  await f.orch.pump(f.worker.id);
  expect(f.store.requireDelivery(delivery.id).status).toBe("delivered");
  expect(f.runner.to(f.worker)).toHaveLength(1);
});

for (const fence of ["stop", "receipt", "approval", "done"] as const) {
  test(`기준 없는 과거 위임을 총괄에게 연결할 때도 ${fence} 경계를 유지한다`, () => {
    const f = queuedDelegation(), next = f.coordinator();
    if (fence === "stop") next.pause([f.task.id], "owner-stop", "대표 중단");
    if (fence === "receipt") {
      const recovery = f.store.getDeliveryRecovery(f.delivery.id)!;
      f.store.updateDeliveryRecovery(f.delivery.id, recovery.version, { phase: "checking", reason: "receipt_pending" });
    }
    if (fence === "approval") f.store.createDecision({ projectId: f.project.id, taskId: f.task.id, memberId: f.lead.id, who: f.lead.name, title: "담당자 범위를 결정해 주세요" });
    if (fence === "done") f.store.addStageMark({ projectId: f.project.id, taskId: f.task.id, stage: "done", evidence: "과거에 처리한 업무", memberId: f.lead.id, who: f.lead.name });
    expect(next.check(Date.now() + 10000, () => true)).toHaveLength(0);
    expect(f.store.requireDelivery(f.delivery.id)).toEqual(f.delivery);
  });
}

test("옛 하네스 설정을 읽거나 다시 저장해도 모든 업무 필수 적용으로 알려 준다", async () => {
  const f = fixture();
  f.store.db.query("INSERT INTO settings(key,value) VALUES('harnessMode','\"label\"'),('harnessRequiredSince','\"2020-01-01T00:00:00.000Z\"')").run();
  expect(f.store.getSettings()).toMatchObject({ harnessMode: "required", harnessRequiredSince: null });
  const updated = f.store.patchSettings({ harnessMode: "label", harnessRequiredSince: "2026-11-18T00:00:00.000Z", maxConcurrentTurns: 9 });
  expect(updated).toMatchObject({ harnessMode: "required", harnessRequiredSince: null, maxConcurrentTurns: 9 });
  const status = JSON.parse((await f.tool(f.lead, "server_check", {})).text);
  expect(status.harness).toMatchObject({ mode: "required", requiredSince: null });
});

for (const mode of ["label", "required"] as const) {
  test(`${mode} 설정에서도 과거 업무와 새 업무의 계약 없는 완료를 거절한다`, async () => {
    const f = fixture();
    const old = id(await f.tool(f.lead, "task", { title: "기존 구현 업무" }));
    f.store.db.query("UPDATE tasks SET created_at=? WHERE id=?").run("2020-01-01T00:00:00.000Z", old);
    f.store.patchSettings({ harnessMode: mode });
    const current = id(await f.tool(f.lead, "task", { title: "새 조사 업무" }));
    for (const task of [old, current]) for (const member of [f.worker, f.lead]) {
      const result = await f.tool(member, "post", { task_id: task, kind: "완료", title: "완료 기준 없이 끝" });
      expect(result.isError, result.text).toBe(true);
    }
    expect(f.store.listMessages(f.project.id).filter(m => m.kind === "완료")).toHaveLength(0);
    expect(f.store.listTasks(f.project.id).some(t => t.progress?.stage === "done")).toBe(false);
    expect((await f.tool(f.worker, "post", { task_id: old, kind: "막힘", title: "완료 기준 확인 필요" })).isError).toBeUndefined();
  });
}

for (const kind of ["coding", "research", "other"] as const) {
  test(`${kind} 업무의 직원 제안은 확인 전 완료 근거가 되지 않는다`, async () => {
    const f = fixture();
    const task = id(await f.tool(f.worker, "task", { title: `${kind} 제안 업무`, contract: { ...OTHER, kind } }));
    const result = await f.tool(f.worker, "post", { task_id: task, kind: "완료", title: "제안대로 완료", contract_rev: 1, checks: [checked] });
    expect(result.isError, result.text).toBe(true);
    expect(f.store.getEffectiveContract(task)?.confirmedAt).toBeFalsy();
    expect(f.store.listMessages(f.project.id).filter(m => m.kind === "완료")).toHaveLength(0);
  });
}

test("총괄의 기준 없는 위임은 전송하지 않고, 같은 호출에서 확정한 기준은 지시에 붙인다", async () => {
  const f = fixture(), task = id(await f.tool(f.lead, "task", { title: "인계 문서" }));
  const refused = await f.tool(f.lead, "team_assign", { member: "w1", task_id: task, text: "인계 문서를 만드세요" });
  expect(refused.isError, refused.text).toBe(true);
  expect(f.store.listTaskDeliveries(task)).toHaveLength(0);
  expect(f.runner.to(f.worker)).toHaveLength(0);
  const accepted = await f.tool(f.lead, "team_assign", { member: "w1", task_id: task, text: "인계 문서를 만드세요", contract: OTHER });
  expect(accepted.isError, accepted.text).toBeUndefined();
  await until("확정 기준 지시", () => f.runner.to(f.worker).length === 1);
  expect(f.store.getEffectiveContract(task)).toMatchObject({ authorKind: "conductor", acceptance: OTHER.acceptance });
  expect(f.runner.to(f.worker)[0]).toContain("합격 기준 1: 인계 문서에서 담당자와 남은 판단을 확인할 수 있다");
});

test("직접 호출한 위임도 업무와 확정 기준 없이 전송하지 않는다", async () => {
  const f = fixture();
  await expect(f.orch.assign(f.project.id, f.worker.handle, { text: "인계 문서를 만드세요" }, f.lead)).rejects.toThrow();
  expect(f.runner.to(f.worker)).toHaveLength(0);
});

test("직원의 미확정 기준으로는 위임하지 않고 총괄 확인 뒤에는 위임한다", async () => {
  const f = fixture(), task = id(await f.tool(f.worker, "task", { title: "인계 기준 제안", contract: OTHER }));
  expect((await f.tool(f.lead, "team_assign", { member: "w1", task_id: task, text: "인계 문서를 만드세요" })).isError).toBe(true);
  expect(f.runner.to(f.worker)).toHaveLength(0);
  expect((await f.tool(f.lead, "task", { task_id: task, confirm_contract_rev: 1 })).isError).toBeUndefined();
  expect((await f.tool(f.lead, "team_assign", { member: "w1", task_id: task, text: "인계 문서를 만드세요" })).isError).toBeUndefined();
});

test("직원 추가·깨우기·멈추고 이어서도 기준이 없으면 실행 상태를 바꾸지 않는다", async () => {
  const f = fixture(), task = id(await f.tool(f.lead, "task", { title: "추가 위임" }));
  const count = f.store.listMembers(f.project.id).length;
  const added = await f.tool(f.lead, "team_add", { name: "인계 정리", role: "문서 담당", task_id: task, first_instruction: "인계 문서를 만드세요" });
  expect(added.isError, added.text).toBe(true);
  expect(f.store.listMembers(f.project.id)).toHaveLength(count);
  f.store.patchMember(f.worker.id, { status: "asleep", paneId: null });
  const resumed = await f.tool(f.lead, "team_resume", { member: "w1", task_id: task, first_instruction: "인계 문서를 만드세요" });
  expect(resumed.isError, resumed.text).toBe(true);
  expect(f.store.requireMember(f.worker.id).status).toBe("asleep");
  expect(f.runner.to(f.worker)).toHaveLength(0);
  await f.orch.sendUserMessage(f.project.id, { targetMemberId: f.worker2.id, taskId: task, text: "현재 인계 내용을 확인해 주세요" });
  const run = f.store.listPendingExecutions().find(r => r.memberId === f.worker2.id)!;
  const stopped = await f.tool(f.lead, "team_stop", { member: "w2", expect_run_id: run.runId, task_id: task, then: "인계 문서도 만드세요" });
  expect(stopped.isError, stopped.text).toBe(true);
  expect(f.store.getExecutionJournal(run.runId)?.endedAt).toBeNull();
  expect(f.runner.to(f.worker2)).toHaveLength(1);
});

test("대표의 직접 지시는 원문 그대로 한 번 전달하고 기준 확정이 원문 재전송을 만들지 않는다", async () => {
  const f = fixture();
  const original = "인계 문서의 담당자를 확인해 주세요. 담당자가 없으면 미정이라고 남겨 주세요.";
  const message = await f.orch.sendUserMessage(f.project.id, { targetMemberId: f.worker.id, text: original });
  await until("대표 직접 지시", () => f.runner.to(f.worker).length === 1);
  expect(f.runner.to(f.worker)[0]).toContain(original);
  expect(f.store.getEffectiveContract(message.taskId!)).toBeNull();
  expect((await f.tool(f.lead, "task", { task_id: message.taskId, contract: OTHER })).isError).toBeUndefined();
  const duplicate = await f.tool(f.lead, "team_assign", { member: "w1", task_id: message.taskId, user_quote: original, text: original });
  expect(duplicate.isError, duplicate.text).toBe(true);
  expect(f.store.listTaskDeliveries(message.taskId!).filter(d => d.memberId === f.worker.id)).toHaveLength(1);
  expect(f.runner.to(f.worker)).toHaveLength(1);
});

test("후보 등록과 직원 기준 제안은 총괄이나 직원을 자동 실행하지 않는다", async () => {
  const f = fixture();
  const candidate = id(await f.tool(f.lead, "task", { title: "검토할 인계 방식 후보" }));
  const proposed = id(await f.tool(f.worker, "task", { title: "문서 방식 제안", contract: OTHER }));
  await Bun.sleep(10);
  expect(f.store.listTaskDeliveries(candidate)).toHaveLength(0);
  expect(f.store.listDeliveries().filter(d => d.taskId === proposed && d.wake)).toHaveLength(0);
  expect(f.runner.to(f.lead)).toHaveLength(0);
  expect(f.runner.to(f.worker)).toHaveLength(0);
});

test("기타 업무도 현재 기준별 증거를 확인한 뒤 총괄이 최종 완료한다", async () => {
  const f = fixture(), task = id(await f.tool(f.lead, "task", { title: "인계 확인", contract: OTHER }));
  const missingCriterion = await f.tool(f.worker, "post", { task_id: task, kind: "완료", title: "인계 확인", contract_rev: 1, checks: [{ ...checked, criterion: undefined }] });
  expect(missingCriterion.isError).toBe(true);
  const done = await f.tool(f.worker, "post", { task_id: task, kind: "완료", title: "인계 확인", contract_rev: 1, checks: [checked] });
  expect(done.isError, done.text).toBeUndefined();
  expect(f.store.taskProgress(task).stage).not.toBe("done");
  expect((await f.tool(f.lead, "task_stage", { task_id: task, stage: "done", evidence: "인계 보고의 담당자와 미정 항목을 확인했습니다" })).isError).toBeUndefined();
  expect(f.store.taskProgress(task).stage).toBe("done");
});

test("옛 계약 없는 완료 기록은 새 최종 완료 근거가 되지 않는다", async () => {
  const f = fixture(), task = id(await f.tool(f.lead, "task", { title: "과거 완료 주장" }));
  f.store.createMessage({ projectId: f.project.id, taskId: task, memberId: f.worker.id, who: f.worker.name, kind: "완료", title: "옛 완료 보고" });
  const result = await f.tool(f.lead, "task_stage", { task_id: task, stage: "done", evidence: "옛 보고가 있습니다" });
  expect(result.isError, result.text).toBe(true);
  expect(f.store.taskProgress(task).stage).not.toBe("done");
});

test("파생 실행 업무의 별도 계약도 현재 판의 검사 근거가 있어야 상위 업무를 완료한다", async () => {
  const f = fixture(), task = id(await f.tool(f.lead, "task", { title: "전체 인계", contract: OTHER }));
  await f.tool(f.worker, "post", { task_id: task, kind: "완료", title: "전체 문서 확인", contract_rev: 1, checks: [checked] });
  const child = id(await f.tool(f.lead, "task", { title: "담당자 후속 확인", parent_task_id: task, contract: { ...OTHER, acceptance: ["대체 담당자의 수락 여부를 확인한다"] } }));
  const legacy = f.store.enqueue({ projectId: f.project.id, memberId: f.worker2.id, taskId: child, kind: "instruction", text: "대체 담당자의 수락 여부를 확인하세요" });
  f.store.markDelivered(legacy.id);
  f.store.createMessage({ projectId: f.project.id, taskId: child, memberId: f.worker2.id, who: f.worker2.name, kind: "완료", title: "검사 없는 과거 완료 주장" });
  const refused = await f.tool(f.lead, "task_stage", { task_id: task, stage: "done", evidence: "상위 문서를 확인했습니다" });
  expect(refused.isError, refused.text).toBe(true);
  expect(f.store.taskProgress(task).stage).not.toBe("done");
});

test("결재를 닫는 후속 위임도 완료 기준 없이는 결재와 지시를 바꾸지 않는다", async () => {
  const f = fixture(), task = id(await f.tool(f.lead, "task", { title: "인계 위임 확인" }));
  const source = f.store.createMessage({ projectId: f.project.id, taskId: task, mine: true, who: "나", kind: "나", body: "인계 문서를 직원에게 맡기고, 누락된 담당자는 확인해 주세요" });
  const decision = f.store.createDecision({ projectId: f.project.id, taskId: task, memberId: f.lead.id, who: f.lead.name, title: "인계 문서를 맡길까요?" });
  await expect(f.orch.closeAsk(f.lead, { id: decision.id, kind: "decided", reason: "대표가 인계 문서 위임을 지시했습니다", userQuote: source.body,
    followUp: { kind: "instruction", memberId: f.worker.id, sourceMessageId: source.id, text: "인계 문서를 정리하세요" } })).rejects.toThrow();
  expect(f.store.getDecision(decision.id)?.status).toBe("open");
  expect(f.store.listTaskDeliveries(task)).toHaveLength(0);
});

test("총괄이 직원 결과를 승계할 때도 명시한 옛 계약 판은 거절한다", async () => {
  const f = fixture(), task = id(await f.tool(f.lead, "task", { title: "현재 판 승계", contract: OTHER }));
  await f.tool(f.lead, "task", { task_id: task, contract: { ...OTHER, goal: "갱신한 인계 문서를 전달한다" } });
  expect((await f.tool(f.worker, "post", { task_id: task, kind: "완료", title: "새 문서 확인", contract_rev: 2, checks: [checked] })).isError).toBeUndefined();
  const stale = await f.tool(f.lead, "post", { task_id: task, kind: "완료", title: "옛 판으로 승계", contract_rev: 1 });
  expect(stale.isError, stale.text).toBe(true);
  expect((await f.tool(f.lead, "post", { task_id: task, kind: "완료", title: "현재 판 확인", contract_rev: 2 })).isError).toBeUndefined();
});

test("본사의 업무 없는 짧은 답은 유지하고 명시한 실행 업무는 기준을 요구한다", async () => {
  const f = fixture();
  const root = f.store.createMember({ projectId: "hq", kind: "root", name: "본사", handle: "root", role: "본사", cwd: f.project.cwd, origin: "manual" });
  const chat = await f.orch.recordPost(root, { kind: "완료", title: "현재 진행 상황을 확인했습니다" });
  expect(chat.taskId).toBeNull();
  const task = f.orch.saveTask(root, { title: "본사 문서 제작" }).task;
  await expect(f.orch.recordPost(root, { taskId: task.id, kind: "완료", title: "문서 완료" })).rejects.toThrow();
});
