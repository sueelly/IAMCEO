import { expect, test } from "bun:test";
import { createQueueStatusFixture } from "./fixtures/queue-status-runtime.ts";
import { fixture as createReportFixture, until } from "./fixtures/harness-fixture.ts";

type Fixture = Awaited<ReturnType<typeof createQueueStatusFixture>>;

function stopRecovery(f: Fixture, deliveryId: string) {
  const recovery = f.store.getDeliveryRecovery(deliveryId)!;
  f.store.updateDeliveryRecovery(deliveryId, recovery.version, { phase: "stopped", reason: "restore_reconciliation_required" });
}

async function finishTurn(f: Fixture) {
  f.done();
  for (let i = 0; i < 100 && !f.store.listActivity(f.member.id).some(a => a.kind === "turn_end"); i++) await Bun.sleep(5);
  expect(f.store.listActivity(f.member.id).some(a => a.kind === "turn_end")).toBe(true);
  await Bun.sleep(30);
}

test.each(["queued", "held"] as const)("a stopped %s input does not block the next safe instruction", async status => {
  const f = await createQueueStatusFixture();
  try {
    const old = f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, kind: "instruction", text: "Stopped historical instruction", wake: true, status, ...(status === "held" ? { holdReason: "delivery_unknown" } : {}) });
    stopRecovery(f, old.id);
    const next = f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, kind: "instruction", text: "New safe instruction", wake: true });
    await f.orch.pump(f.member.id);
    expect(f.store.requireDelivery(old.id)).toEqual(old);
    expect(f.store.getDeliveryRecovery(old.id)?.phase).toBe("stopped");
    expect(f.store.requireDelivery(next.id).status).toBe("delivered");
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]!.text).not.toContain("Stopped historical instruction");
  } finally { await f.stop(); }
});

test.each([null, "not_received"])("a resolved input without a pre-write refusal stays protected (%s)", async reason => {
  const f = await createQueueStatusFixture();
  try {
    const oldTask = f.store.ensureSourceTask({ projectId: f.project.id, sourceRef: "probe:resolved-old", title: "Resolved historical task", origin: "owner" }).task;
    const nextTask = f.store.ensureSourceTask({ projectId: f.project.id, sourceRef: "probe:resolved-next", title: "Next safe task", origin: "owner" }).task;
    const old = f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, kind: "instruction", text: "Resolved historical instruction", wake: true, taskId: oldTask.id });
    const recovery = f.store.getDeliveryRecovery(old.id)!;
    f.store.updateDeliveryRecovery(old.id, recovery.version, { phase: "resolved", reason });
    const next = f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, kind: "instruction", text: "New safe instruction", wake: true, taskId: nextTask.id });
    expect(f.store.taskSequenceBlocker(f.member.id, nextTask.id)).toBeNull();
    await f.orch.pump(f.member.id);
    expect(f.store.requireDelivery(old.id)).toEqual(old);
    expect(f.store.getDeliveryRecovery(old.id)?.phase).toBe("resolved");
    expect(f.store.requireDelivery(next.id).status).toBe("delivered");
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]!.text).not.toContain("Resolved historical instruction");
  } finally { await f.stop(); }
});

test("a stopped urgent input does not poison a later safe urgent instruction", async () => {
  const f = await createQueueStatusFixture();
  try {
    f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, kind: "instruction", text: "Active instruction", wake: true });
    await f.orch.pump(f.member.id);
    const old = f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, kind: "instruction", text: "Stopped urgent instruction", wake: true, urgent: true });
    stopRecovery(f, old.id);
    const next = f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, kind: "instruction", text: "New urgent instruction", wake: true, urgent: true });
    await f.orch.pump(f.member.id);
    expect(f.store.requireDelivery(old.id)).toEqual(old);
    // Core refuses new input while the foreground turn is still active.
    // The safe urgent item reaches that guard; the stopped item never does.
    expect(f.store.requireDelivery(next.id)).toMatchObject({ status: "queued", attempts: 1 });
    await finishTurn(f);
    for (let i = 0; i < 100 && f.store.requireDelivery(next.id).status !== "delivered"; i++) await Bun.sleep(5);
    expect(f.store.requireDelivery(next.id).status).toBe("delivered");
    expect(f.writes).toHaveLength(2);
    expect(f.writes[1]!.text).not.toContain("Stopped urgent instruction");
  } finally { await f.stop(); }
});

test("a stopped instruction alone cannot wake a quiet notice", async () => {
  const f = await createQueueStatusFixture();
  try {
    const old = f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, kind: "instruction", text: "Stopped instruction", wake: true });
    stopRecovery(f, old.id);
    const notice = f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, kind: "system", text: "Quiet notice", wake: false });
    await f.orch.pump(f.member.id);
    expect(f.store.requireDelivery(old.id)).toEqual(old);
    expect(f.store.requireDelivery(notice.id)).toEqual(notice);
    expect(f.writes).toHaveLength(0);
  } finally { await f.stop(); }
});

test("an unresolved physical write still fences later work after recovery is stopped", async () => {
  const f = await createQueueStatusFixture();
  try {
    const old = f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, kind: "instruction", text: "Uncertain old instruction", wake: true });
    const observed = f.runner.observationState(f.member.id)!;
    const dispatch = f.orch.deliveryRecovery.prepareDispatch([old.id], observed.identity, { serverEpoch: "workflow-test", turn: observed.turn, inputEpoch: observed.inputEpoch, logs: [], capturedAt: new Date().toISOString() });
    f.store.updateDispatch(dispatch.dispatchId, "prepared", "unknown");
    stopRecovery(f, old.id);
    const next = f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, kind: "instruction", text: "Later instruction", wake: true });
    await f.orch.pump(f.member.id);
    expect(f.store.requireDelivery(next.id)).toEqual(next);
    expect(f.store.getDispatch(dispatch.dispatchId)?.transportState).toBe("unknown");
    expect(f.writes).toHaveLength(0);
  } finally { await f.stop(); }
});

test.each(["막힘", "완료", "질문"] as const)("a %s on another task leaves the received task's report duty open", async kind => {
  const f = await createQueueStatusFixture();
  try {
    const a = f.store.ensureSourceTask({ projectId: f.project.id, sourceRef: "probe:a", title: "Task A", origin: "owner" }).task;
    const b = f.store.ensureSourceTask({ projectId: f.project.id, sourceRef: "probe:b", title: "Task B", origin: "owner" }).task;
    f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, kind: "instruction", text: "Answer B", wake: true, taskId: b.id });
    await f.orch.pump(f.member.id);
    const member = f.store.requireMember(f.member.id);
    if (kind === "질문") await f.orch.registerAsk(member, { taskId: a.id, title: "Question about A" });
    else await f.orch.recordPost(member, { kind, title: "Only A answered", taskId: a.id });
    await finishTurn(f);
    const followups = f.store.listDeliveries().filter(d => d.text.includes("보고 보완:"));
    expect(followups).toHaveLength(1);
    expect(f.store.deliveryTaskId(followups[0]!.id)).toBe(b.id);
    expect(followups[0]!.text).not.toContain(a.id);
  } finally { await f.stop(); }
});

test("a completion on the received task closes its report duty", async () => {
  const f = await createQueueStatusFixture();
  try {
    const task = f.store.ensureSourceTask({ projectId: f.project.id, sourceRef: "probe:same", title: "Task", origin: "owner" }).task;
    f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, kind: "instruction", text: "Answer task", wake: true, taskId: task.id });
    await f.orch.pump(f.member.id);
    await f.orch.recordPost(f.store.requireMember(f.member.id), { kind: "완료", title: "Answered", taskId: task.id });
    await finishTurn(f);
    expect(f.store.listDeliveries().filter(d => d.text.includes("보고 보완:"))).toHaveLength(0);
  } finally { await f.stop(); }
});

test("an unrelated completion does not turn an interrupted task into a successful execution", async () => {
  const f = await createQueueStatusFixture();
  try {
    const a = f.store.ensureSourceTask({ projectId: f.project.id, sourceRef: "probe:exit-a", title: "Other task", origin: "owner" }).task;
    const b = f.store.ensureSourceTask({ projectId: f.project.id, sourceRef: "probe:exit-b", title: "Interrupted task", origin: "owner" }).task;
    f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, kind: "instruction", text: "Unfinished task", wake: true, taskId: b.id });
    await f.orch.pump(f.member.id);
    const run = f.store.listPendingExecutions().find(r => r.memberId === f.member.id)!;
    await f.orch.recordPost(f.store.requireMember(f.member.id), { kind: "완료", title: "Other task answered", taskId: a.id });
    const terminal = f.terminals.get(f.member.paneId!)!;
    terminal.state = "finished";
    terminal.reason = "isolated unexpected exit";
    for (let i = 0; i < 100 && !f.store.getExecutionJournal(run.runId)?.endedAt; i++) await Bun.sleep(5);
    expect(f.store.getExecutionJournal(run.runId)).toMatchObject({ phase: "interrupted", result: "interrupted" });
  } finally { await f.stop(); }
});

test("a matching completion also settles a report-followup run after terminal exit", async () => {
  const f = await createQueueStatusFixture();
  try {
    const task = f.store.ensureSourceTask({ projectId: f.project.id, sourceRef: "probe:followup", title: "Followup task", origin: "owner" }).task;
    f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, kind: "instruction", text: "Work needing report", wake: true, taskId: task.id });
    await f.orch.pump(f.member.id);
    const first = f.store.listPendingExecutions().find(r => r.memberId === f.member.id)!;
    await finishTurn(f);
    const followup = f.store.listPendingExecutions().find(r => r.memberId === f.member.id && r.runId !== first.runId)!;
    expect(followup).toBeDefined();
    await f.orch.recordPost(f.store.requireMember(f.member.id), { kind: "완료", title: "Task completed", taskId: task.id });
    const terminal = f.terminals.get(f.member.paneId!)!;
    terminal.state = "finished";
    terminal.reason = "isolated exit after completion";
    for (let i = 0; i < 100 && !f.store.getExecutionJournal(followup.runId)?.endedAt; i++) await Bun.sleep(5);
    expect(f.store.getExecutionJournal(followup.runId)).toMatchObject({ phase: "ended", result: "success" });
  } finally { await f.stop(); }
});

test.each([false, true])("delegation closes only its own task's report duty (same task: %s)", async sameTask => {
  const f = createReportFixture();
  const a = f.store.saveTask({ projectId: f.project.id, memberId: f.lead.id, who: f.lead.name, title: "Delegated task" }).task;
  const b = sameTask ? a : f.store.saveTask({ projectId: f.project.id, memberId: f.lead.id, who: f.lead.name, title: "Unanswered task" }).task;
  await f.orch.sendUserMessage(f.project.id, { text: "Please handle the received task", taskId: b.id });
  await until("received instruction", () => f.store.listPendingExecutions().some(r => r.memberId === f.lead.id));
  expect((await f.tool(f.lead, "team_assign", { member: f.worker.handle, text: "Handle delegated task", task_id: a.id })).isError).toBeUndefined();
  f.runner.end(f.lead);
  await Bun.sleep(30);
  const supplements = f.store.listDeliveries().filter(d => d.memberId === f.lead.id && d.text.includes("보고 보완:"));
  expect(supplements).toHaveLength(sameTask ? 0 : 1);
  if (!sameTask) expect(f.store.deliveryTaskId(supplements[0]!.id)).toBe(b.id);
});
