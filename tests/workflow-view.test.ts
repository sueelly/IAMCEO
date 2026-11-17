import { expect, test } from "bun:test";
import type { ProjectWorkflow, WorkflowNode } from "../shared/workflow.ts";
import { workflowBucket, workflowFocus, workflowSummary } from "../shared/workflow-view.ts";

const node = (id: string, patch: Partial<WorkflowNode> = {}): WorkflowNode => ({ id, taskId: id, memberId: "worker", order: 0, state: "waiting", label: "선행 업무 대기", current: false, reason: null, action: null, assignedAt: "2026-11-18T00:00:00Z", observedAt: null, lastActivity: null, counts: { queued: 0, held: 0, notices: 0 }, ...patch });

test("unfinished history and review stay in now; only verified completion is past", () => {
  expect(workflowBucket(node("old", { historical: true, state: "review", label: "결과 확인 필요" }))).toBe("now");
  expect(workflowBucket(node("fix", { historical: true, state: "blocked" }))).toBe("now");
  expect(workflowBucket(node("review", { state: "review" }))).toBe("now");
  expect(workflowBucket(node("current", { current: true }))).toBe("now");
  expect(workflowBucket(node("next"))).toBe("next");
  expect(workflowBucket(node("done", { state: "done" }))).toBe("done");
  expect(workflowBucket(node("free", { memberId: null }))).toBe("unassigned");
});

test("counts are unique tasks and action takes precedence over a second running occurrence", () => {
  const counts = workflowSummary([node("a", { state: "running" }), node("b", { taskId: "a", state: "blocked" }), node("c", { state: "done" }), node("d"), node("e", { memberId: null })]);
  expect(counts).toEqual({ all: 4, action: 1, running: 0, next: 1, done: 1, unassigned: 1 });
});

test("focus includes same task occurrences and their direct links, not the entire employee history", () => {
  const flow: ProjectWorkflow = { nodes: [node("a"), node("a2", { taskId: "a" }), node("parent"), node("child"), node("next"), node("far")], edges: [
    { id: "1", from: "parent", to: "a", kind: "derived" }, { id: "2", from: "a2", to: "child", kind: "derived" },
    { id: "3", from: "a", to: "next", kind: "sequence" }, { id: "4", from: "next", to: "far", kind: "sequence" },
  ] };
  expect([...workflowFocus(flow, "a", "direct")].sort()).toEqual(["a", "a2", "child", "next", "parent"]);
  flow.edges.push({ id: "cycle", from: "child", to: "parent", kind: "derived" });
  expect([...workflowFocus(flow, "a", "family")].sort()).toEqual(["a", "a2", "child", "next", "parent"]);
  expect(workflowFocus(flow, "missing", "family").size).toBe(0);
});
