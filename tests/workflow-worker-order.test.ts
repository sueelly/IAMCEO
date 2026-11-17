import { expect, test } from "bun:test";
import { createQueueStatusFixture } from "./fixtures/queue-status-runtime.ts";

type Fixture = Awaited<ReturnType<typeof createQueueStatusFixture>>;

function task(f: Fixture, title: string, memberId = f.member.id, parentTaskId?: string) {
  const saved = f.store.saveTask({ projectId: f.project.id, memberId, who: "Fixture", title, branch: `fixture/${title}`, parentTaskId }).task;
  f.store.saveTaskContract(saved.id, { kind: "other", goal: `Finish ${title}`, acceptance: ["Assigned work is ready for integration"], checks: [] }, { author: "Fixture owner", authorMemberId: null, authorKind: "owner" });
  return saved;
}

function instruction(f: Fixture, taskId: string, text: string, memberId = f.member.id, urgent = false) {
  return f.store.enqueue({ projectId: f.project.id, memberId, kind: "instruction", text, wake: true, taskId, urgent });
}

function done(f: Fixture, taskId: string) {
  f.store.addStageMark({ projectId: f.project.id, taskId, stage: "done", evidence: "Isolated fixture verified completion", memberId: null, who: "Fixture" });
}

async function until(read: () => boolean) {
  for (let i = 0; i < 150 && !read(); i++) await Bun.sleep(5);
  expect(read()).toBe(true);
}

test("a worker starts independent work after verified delivery without marking the whole task done", async () => {
  const f = await createQueueStatusFixture();
  try {
    const a = task(f, "first"), b = task(f, "second");
    const first = instruction(f, a.id, "First work");
    const second = instruction(f, b.id, "Second work");
    await f.orch.pump(f.member.id);
    expect(f.store.requireDelivery(first.id).status).toBe("delivered");
    expect(f.store.requireDelivery(second.id)).toMatchObject({ status: "queued", attempts: 0 });
    expect(f.writes[0]!.text).not.toContain("Second work");
    await f.orch.recordPost(f.store.requireMember(f.member.id), { kind: "완료", taskId: a.id, title: "First branch ready for integration", contractRev: 1, checks: [{ kind: "other", name: "Branch readiness", result: "pass", evidence: "Assigned branch work verified before integration", criterion: 1 }] });
    f.done();
    await until(() => f.store.listActivity(f.member.id).some(a => a.kind === "turn_end"));
    await f.orch.pump(f.member.id);
    expect(f.store.taskProgress(a.id).stage).not.toBe("done");
    expect(f.store.requireDelivery(second.id).status).toBe("delivered");
    expect(f.writes).toHaveLength(2);
  } finally { await f.stop(); }
});

test("urgent input cannot start another task while the earlier task is unfinished", async () => {
  const f = await createQueueStatusFixture();
  try {
    const a = task(f, "first"), b = task(f, "second");
    instruction(f, a.id, "Active first task");
    await f.orch.pump(f.member.id);
    const second = instruction(f, b.id, "Urgent second task", f.member.id, true);
    await f.orch.pump(f.member.id);
    expect(f.store.requireDelivery(second.id)).toMatchObject({ status: "queued", attempts: 0 });
    expect(f.store.listDeliveryDispatches(second.id)).toHaveLength(0);
    expect(f.writes).toHaveLength(1);
  } finally { await f.stop(); }
});

test("a related child can continue unfinished work without admitting an independent later task", async () => {
  const f = await createQueueStatusFixture();
  try {
    const a = task(f, "parent"), b = task(f, "independent"), child = task(f, "child", f.member.id, a.id);
    instruction(f, a.id, "Parent work");
    await f.orch.pump(f.member.id);
    const later = instruction(f, b.id, "Independent work");
    const continuation = instruction(f, child.id, "Child continuation");
    await f.orch.recordPost(f.store.requireMember(f.member.id), { kind: "완료", taskId: a.id, title: "Parent branch needs child verification", contractRev: 1, checks: [{ kind: "other", name: "Parent readiness", result: "pass", evidence: "Parent branch work verified; child review remains", criterion: 1 }] });
    f.done();
    await until(() => f.store.requireDelivery(continuation.id).status === "delivered");
    expect(f.store.requireDelivery(later.id)).toMatchObject({ status: "queued", attempts: 0 });
    expect(f.writes[1]!.text).not.toContain("Independent work");
  } finally { await f.stop(); }
});

test("a manual worker receives only the current task until it is completed", async () => {
  const f = await createQueueStatusFixture();
  try {
    const member = f.store.createMember({ projectId: f.project.id, name: "Manual worker", handle: "manual-worker", kind: "worker", origin: "manual", status: "idle" });
    const a = task(f, "first", member.id), b = task(f, "second", member.id);
    const first = instruction(f, a.id, "Manual first", member.id);
    const second = instruction(f, b.id, "Manual second", member.id);
    const batch = await f.orch.manualInbox(member.id, 0);
    expect(batch?.items.map(i => i.deliveryId)).toEqual([first.id]);
    expect(await f.orch.manualInbox(member.id, 0)).toEqual(batch);
    await f.orch.acknowledgeManualInbox(member.id, { batchId: batch!.id });
    expect(await f.orch.manualInbox(member.id, 0)).toBeNull();
    done(f, a.id);
    expect((await f.orch.manualInbox(member.id, 0))?.items.map(i => i.deliveryId)).toEqual([second.id]);
  } finally { await f.stop(); }
});

test("manual inbox preserves a stopped input while returning later safe work", async () => {
  const f = await createQueueStatusFixture();
  try {
    const member = f.store.createMember({ projectId: f.project.id, name: "Manual worker", handle: "manual-worker", kind: "worker", origin: "manual", status: "idle" });
    const old = f.store.enqueue({ projectId: f.project.id, memberId: member.id, kind: "instruction", text: "Protected old input" });
    f.store.updateDeliveryRecovery(old.id, f.store.getDeliveryRecovery(old.id)!.version, { phase: "stopped", reason: "restore_reconciliation_required" });
    const next = f.store.enqueue({ projectId: f.project.id, memberId: member.id, kind: "instruction", text: "Safe new input" });
    expect((await f.orch.manualInbox(member.id, 0))?.items.map(i => i.deliveryId)).toEqual([next.id]);
    expect(f.store.requireDelivery(old.id)).toEqual(old);
  } finally { await f.stop(); }
});

test("the conductor can coordinate several tasks in the same manual batch", async () => {
  const f = await createQueueStatusFixture();
  try {
    const member = f.store.createMember({ projectId: f.project.id, name: "Conductor", handle: "lead", kind: "conductor", origin: "manual", status: "idle" });
    const a = task(f, "first", member.id), b = task(f, "second", member.id);
    const first = instruction(f, a.id, "Coordinate first", member.id), second = instruction(f, b.id, "Coordinate second", member.id);
    expect((await f.orch.manualInbox(member.id, 0))?.items.map(i => i.deliveryId)).toEqual([first.id, second.id]);
  } finally { await f.stop(); }
});

test("a direct manual answer wait cannot bypass the worker's earlier unfinished task", async () => {
  const f = await createQueueStatusFixture();
  try {
    const member = f.store.createMember({ projectId: f.project.id, name: "Manual worker", handle: "manual-worker", kind: "worker", origin: "manual", status: "idle" });
    const a = task(f, "first", member.id), b = task(f, "second", member.id);
    const first = instruction(f, a.id, "Earlier work", member.id);
    f.store.markDelivered(first.id);
    instruction(f, b.id, "Later work", member.id);
    const decision = f.store.createDecision({ projectId: f.project.id, memberId: member.id, who: member.name, title: "Second task question", taskId: b.id });
    f.store.answerDecision(decision.id, { note: "Isolated answer" });
    expect(await f.orch.askWait(member, decision.id, 0)).toEqual({ done: false });
    expect(f.store.requireDecision(decision.id).status).toBe("answered");
    done(f, a.id);
    expect(await f.orch.askWait(member, decision.id, 0)).toMatchObject({ done: true });
    expect(f.store.requireDecision(decision.id).status).toBe("delivered");
  } finally { await f.stop(); }
});
