import { expect, test } from "bun:test";
import { fixture } from "./fixtures/harness-fixture.ts";
import { TaskContinuationCoordinator } from "../server/task-continuation.ts";

function setup() {
  const f = fixture();
  const task = (title: string, parentTaskId?: string) => {
    const t = f.store.saveTask({ projectId: f.project.id, memberId: f.worker.id, who: f.worker.name, title, parentTaskId }).task;
    f.store.saveTaskContract(t.id, { kind: "other", goal: title, acceptance: ["Result verified"], checks: [] }, { author: f.lead.name, authorMemberId: f.lead.id, authorKind: "conductor" });
    return t;
  };
  const input = (taskId: string) => f.store.enqueue({ projectId: f.project.id, memberId: f.worker.id, kind: "instruction", text: "Carry out this task", taskId });
  const a = task("Earlier work"), b = task("Independent next work"), first = input(a.id), second = input(b.id);
  f.store.markDelivered(first.id);
  const mark = (stage: "hold" | "reopen") => f.store.addStageMark({ projectId: f.project.id, taskId: a.id, stage, who: f.lead.name, memberId: f.lead.id, evidence: "Scoped coordination decision" });
  const complete = async () => {
    await Bun.sleep(2);
    return f.orch.recordPost(f.store.requireMember(f.worker.id), { taskId: a.id, kind: "완료", title: "Verified delivery", contractRev: 1,
      checks: [{ name: "Result", kind: "other", result: "pass", evidence: "Verified before review", criterion: 1 }] });
  };
  return { ...f, task, input, a, b, first, second, mark, complete };
}

test("a scoped hold releases unrelated work without resuming the held task or its descendants", () => {
  const f = setup(), child = f.task("Child of held work", f.a.id); f.input(child.id); f.mark("hold");
  expect(f.store.taskSequenceBlocker(f.worker.id, f.b.id)).toBeNull();
  expect(f.store.taskSequenceBlocker(f.worker.id, f.a.id)?.taskId).toBe(f.a.id);
  expect(f.store.taskSequenceBlocker(f.worker.id, child.id)).not.toBeNull();
  const node = f.store.projectWorkflow(f.project.id).nodes.find(n => n.taskId === f.b.id && n.memberId === f.worker.id)!;
  expect(node.label).not.toBe("선행 업무 대기");
  expect(f.store.taskProgress(f.a.id).stage).toBe("hold");
  expect(f.store.requireDelivery(f.second.id)).toEqual(f.second);
});
test("an explicit owner stop is local to that task family and remains effective", () => {
  const f = setup();
  new TaskContinuationCoordinator(f.store, { intervalMs: 1000, sameLimit: 3 }).pause([f.a.id], "stop", "Owner stopped this task");
  expect(f.store.taskSequenceBlocker(f.worker.id, f.b.id)).toBeNull();
  expect(f.store.taskSequenceBlocker(f.worker.id, f.a.id)).not.toBeNull();
});
test("verified worker delivery releases independent work while final completion stays open", async () => {
  const f = setup(); await f.complete();
  expect(f.store.taskSequenceBlocker(f.worker.id, f.b.id)).toBeNull();
  expect(f.store.taskProgress(f.a.id).stage).toBe("delivered");
  expect(f.store.projectWorkflow(f.project.id).nodes.find(n => n.taskId === f.b.id && n.memberId === f.worker.id)?.label).not.toBe("선행 업무 대기");
});
test("a new correction instruction makes the earlier assignment block again", async () => {
  const f = setup(); await f.complete();
  f.input(f.a.id);
  expect(f.store.taskSequenceBlocker(f.worker.id, f.b.id)?.taskId).toBe(f.a.id);
});
test("a failed review keeps the writer responsible despite an earlier verified delivery", async () => {
  const f = setup(); await f.complete();
  await f.orch.recordPost(f.worker2, { taskId: f.a.id, kind: "막힘", title: "Review failed", contractRev: 1, checks: [{ kind: "other", name: "Result", result: "fail", evidence: "Correction needed", criterion: 1 }] });
  expect(f.store.taskSequenceBlocker(f.worker.id, f.b.id)?.taskId).toBe(f.a.id);
});
test("a bare completion claim or a turn ending does not release the assignment", () => {
  const f = setup();
  f.store.createMessage({ projectId: f.project.id, memberId: f.worker.id, who: f.worker.name, taskId: f.a.id, kind: "완료", title: "No verification" });
  expect(f.store.taskSequenceBlocker(f.worker.id, f.b.id)?.taskId).toBe(f.a.id);
});
test("reopening held work restores its place ahead of later assignments", () => {
  const f = setup(); f.mark("hold"); f.mark("reopen");
  expect(f.store.taskSequenceBlocker(f.worker.id, f.b.id)?.taskId).toBe(f.a.id);
});
