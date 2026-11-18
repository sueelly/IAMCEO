import { expect, test } from "bun:test";
import { TaskContinuationCoordinator } from "../server/task-continuation.ts";
import { createQueueStatusFixture } from "./fixtures/queue-status-runtime.ts";

test("an existing independent original reaches an idle worker once while another task awaits an owner decision", async () => {
  const f = await createQueueStatusFixture();
  try {
    const task = (title: string, parentTaskId?: string) => f.store.ensureSourceTask({
      projectId: f.project.id, title, sourceRef: title, origin: "owner", parentTaskId,
    }).task;
    const queue = (taskId: string, text: string) => f.store.enqueue({
      projectId: f.project.id, memberId: f.member.id, taskId, kind: "instruction", text,
    });
    const waiting = task("Design decision"), child = task("Implement pending design", waiting.id);
    const ready = task("Investigate unrelated scene rendering"), later = task("Another independent assignment");
    const old = queue(waiting.id, "Original design work");
    f.store.markDelivered(old.id);
    const decision = f.store.createDecision({ projectId: f.project.id, taskId: waiting.id,
      memberId: f.member.id, who: f.member.name, title: "Which design can proceed?" });
    const blocked = queue(child.id, "Wait for the design decision");
    await f.orch.pump(f.member.id);
    const input = queue(ready.id, "Inspect the existing scene rendering");
    const next = queue(later.id, "Do the other work on another turn");
    const oldDelivery = f.store.requireDelivery(old.id);

    const flow = f.store.projectWorkflow(f.project.id), node = flow.nodes.find(n => n.taskId === ready.id)!;
    expect(node.label).not.toBe("선행 업무 대기");
    expect(flow.edges.some(e => e.kind === "sequence" && e.to === node.id)).toBe(false);
    await f.orch.pump(f.member.id);
    await f.orch.pump(f.member.id);
    expect(f.store.requireDelivery(input.id)).toMatchObject({ status: "delivered", attempts: 1 });
    expect(f.store.listDeliveryDispatches(input.id)).toHaveLength(1);
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]!.text).toContain(input.text);
    for (const untouched of [blocked, next]) {
      expect(f.store.requireDelivery(untouched.id)).toMatchObject({ status: "queued", attempts: 0 });
      expect(f.writes[0]!.text).not.toContain(untouched.text);
    }
    expect(f.store.requireDecision(decision.id)).toEqual(decision);
    expect(f.store.requireDelivery(old.id)).toEqual(oldDelivery);
    expect(f.store.doneMark(waiting.id)).toBeNull();
  } finally { await f.stop(); }
});

test("an owner stop on the target's parent still prevents physical worker input", async () => {
  const f = await createQueueStatusFixture();
  try {
    const parent = f.store.ensureSourceTask({ projectId: f.project.id, sourceRef: "paused", title: "Paused work", origin: "owner" }).task;
    const child = f.store.ensureSourceTask({ projectId: f.project.id, sourceRef: "child", title: "Child scope", parentTaskId: parent.id, origin: "owner" }).task;
    const input = f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, taskId: child.id, kind: "instruction", text: "Child work" });
    new TaskContinuationCoordinator(f.store, { intervalMs: 30_000, sameLimit: 3 }).pause([parent.id], "stop", "Owner stopped this work");
    await f.orch.pump(f.member.id);
    expect(f.store.requireDelivery(input.id)).toMatchObject({ status: "queued", attempts: 0 });
    expect(f.store.listDeliveryDispatches(input.id)).toEqual([]);
    expect(f.writes).toEqual([]);
  } finally { await f.stop(); }
});

test("normal delegation delivers a contracted assignment while the worker's older delegated input lacks criteria", async () => {
  const f = await createQueueStatusFixture();
  try {
    const lead = f.store.createMember({ projectId: f.project.id, handle: "lead", name: "Lead", kind: "conductor" });
    const earlier = f.store.ensureSourceTask({ projectId: f.project.id, sourceRef: "old-delegation",
      title: "Clarify a previous feature", origin: "owner" }).task;
    const missing = f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, taskId: earlier.id,
      kind: "instruction", text: "Old work awaiting accepted criteria" });
    f.store.noteDelegation(lead.id, missing, true);
    const next = f.store.ensureSourceTask({ projectId: f.project.id, sourceRef: "ready-delegation",
      title: "Independent scene audit", origin: "owner" }).task;
    const assigned = await f.orch.assign(f.project.id, f.member.handle, {
      taskId: next.id, text: "Perform the scene audit",
      contract: { kind: "other", goal: "Audit the scene", scope: "The named scene", inputs: ["Scene record"],
        outputs: ["Audit result"], constraints: [], exclusions: [], acceptance: ["The scene is checked"] },
    }, lead);

    expect(assigned.delivery).toMatchObject({ taskId: next.id, status: "delivered", attempts: 1 });
    await f.orch.pump(f.member.id);
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]!.text).toContain("Perform the scene audit");
    expect(f.writes[0]!.text).not.toContain(missing.text);
    expect(f.store.requireDelivery(missing.id)).toEqual(missing);
    expect(f.store.listDeliveryDispatches(missing.id)).toEqual([]);
  } finally { await f.stop(); }
});

test("a pending terminal approval on another worker's parent task keeps its child's original queued", async () => {
  const f = await createQueueStatusFixture();
  try {
    const other = f.store.createMember({ projectId: f.project.id, name: "Design worker", handle: "design", kind: "worker" });
    const parent = f.store.ensureSourceTask({ projectId: f.project.id, sourceRef: "approval", title: "Design", origin: "owner" }).task;
    const child = f.store.ensureSourceTask({ projectId: f.project.id, sourceRef: "implementation", title: "Implement design", parentTaskId: parent.id, origin: "owner" }).task;
    const earlier = f.store.enqueue({ projectId: f.project.id, memberId: other.id, taskId: parent.id, kind: "instruction", text: "Establish design" });
    f.store.markDelivered(earlier.id);
    f.store.patchMember(other.id, { status: "blocked", blockedReason: "permission" });
    expect(f.store.taskProgress(parent.id).stage).toBe("approval");
    const input = f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, taskId: child.id, kind: "instruction", text: "Implement this design" });
    await f.orch.pump(f.member.id);
    expect(f.store.requireDelivery(input.id)).toMatchObject({ status: "queued", attempts: 0 });
    expect(f.writes).toEqual([]);
  } finally { await f.stop(); }
});

test("finishing the assigned turn starts the worker's next public card without a lead or a polling tick", async () => {
  const f = await createQueueStatusFixture();
  try {
    const terms = { kind: "other" as const, goal: "Inspect the rendering", scope: "The scene preview",
      inputs: ["Specified scene"], outputs: ["Inspection results"], constraints: [], exclusions: [],
      acceptance: ["The rendering is checked"] };
    const task = (title: string) => {
      const { task } = f.store.ensureSourceTask({ projectId: f.project.id, sourceRef: title, title, origin: "owner" });
      f.store.saveTaskContract(task.id, terms, { author: "Fixture owner", authorMemberId: null, authorKind: "owner" });
      return task;
    };
    const first = task("Inspect first scene");
    await f.orch.assign(f.project.id, f.member.handle, { taskId: first.id, text: first.title });
    expect(f.writes).toHaveLength(1);
    const next = task("Inspect remaining preview");
    const card = f.store.upsertWork({ projectId: f.project.id, taskId: next.id, sec: "next", who: f.member.name,
      title: next.title, detail: "Inspect the remaining scene in the preview" });
    await f.orch.recordPost(f.member, { taskId: first.id, kind: "완료", title: "First scene checked", contractRev: 1,
      checks: [{ name: "Rendered scene", criterion: 1, kind: "other", result: "pass", evidence: "Compared the preview to the specified scene" }] });
    f.done();
    for (let i = 0; i < 300 && f.writes.length < 2; i++) await Bun.sleep(10);
    expect(f.writes).toHaveLength(2);
    expect(f.writes[1]!.text).toContain(next.title);
    expect(f.writes[1]!.text).toContain(terms.acceptance[0]!);
    expect(f.store.doneMark(first.id)?.who).toBe("하네스");
    expect(f.store.listWork(f.project.id).find(w => w.id === card.id)?.sec).toBe("doing");
    expect(f.store.listTaskDeliveries(next.id).filter(d => d.kind === "instruction")).toHaveLength(1);
  } finally { await f.stop(); }
});
