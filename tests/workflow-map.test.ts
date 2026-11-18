import { expect, test } from "bun:test";
import type { Task } from "../shared/types";
import type { ProjectWorkflow, WorkflowNode } from "../shared/workflow";
import { resolveWorkflowMapScope, workflowMap, workflowTaskNodes } from "../shared/workflow-map";
const task = (id: string, parentTaskId: string | null = null): Task => ({
  id,
  title: id,
  projectId: "p",
  memberId: null,
  who: "대표",
  branch: null,
  worktree: null,
  createdAt: "2026-11-18T00:00:00Z",
  updatedAt: "2026-11-18T00:00:00Z",
  parentTaskId,
});
const node = (
  id: string,
  taskId = id,
  patch: Partial<WorkflowNode> = {},
): WorkflowNode => ({
  id,
  taskId,
  memberId: "worker",
  order: 0,
  state: "waiting",
  label: "선행 업무 대기",
  current: false,
  reason: null,
  action: null,
  assignedAt: "2026-11-18T00:00:00Z",
  observedAt: null,
  lastActivity: null,
  counts: { queued: 0, held: 0, notices: 0 },
  ...patch,
});
test("parent families and independent tasks cover every identity exactly once without enrolling records", () => {
  const tasks = [
    task("root"),
    task("child", "root"),
    task("grand", "child"),
    task("single"),
    task("missing", "absent"),
    task("record"),
  ];
  const flow = {
    nodes: [
      node("r", "root"),
      node("c", "child"),
      node("c2", "child", { memberId: "reviewer", state: "blocked" }),
      node("g", "grand"),
      node("s", "single", { memberId: null }),
      node("m", "missing"),
    ],
    edges: [],
  };
  const before = JSON.stringify({ tasks, flow }),
    m = workflowMap(tasks, flow);
  expect(m.groups.map((g) => [g.id, g.taskIds])).toEqual([
    ["root", ["root", "child", "grand"]],
    ["individual", ["single", "missing"]],
  ]);
  expect(m.groups[0].members).toEqual(["worker", "reviewer"]);
  expect(m.groups[0].counts).toEqual({
    all: 3,
    action: 0,
    review: 1,
    history: 0,
    running: 0,
    next: 2,
    done: 0,
    unassigned: 0,
  });
  expect(m.groups[0].blocked).toBe(1);
  expect(JSON.stringify({ tasks, flow })).toBe(before);
  expect(m.occurrences.has("record")).toBe(false);
});
test("map scopes, counts and selected evidence agree on the person who can act", () => {
  const flow: ProjectWorkflow = { nodes: [
    node("internal", "x", { state: "blocked", label: "총괄 점검", ownerActionRequired: false }),
    node("decision", "x", { memberId: null, state: "blocked", label: "대표 확인", ownerActionRequired: true }),
    node("review", "r", { state: "review" }), node("history", "h", { historical: true, state: "review" }),
    node("running", "w", { state: "running" }), node("past", "w", { historical: true, state: "blocked" }),
  ], edges: [] };
  const ids = ["x", "r", "h", "w"];
  const model = workflowMap(ids.map(id => task(id)), flow);
  const counts = model.groups[0].counts;
  for (const [category, expected] of [["action", ["x"]], ["review", ["r"]], ["history", ["h"]], ["running", ["w"]]] as const) {
    const scope = resolveWorkflowMapScope(model, flow, { kind: "tasks", source: "group", groupId: "individual", category }, new Set(ids));
    expect(scope.kind === "tasks" && scope.ids).toEqual([...expected]);
    expect(counts[category]).toBe(expected.length);
  }
  expect(workflowTaskNodes(flow.nodes, ["x", "w"]).map(n => n.id)).toEqual(["decision", "running"]);
});
test("aggregate links retain both original directions and staff provenance", () => {
  const tasks = [task("a"), task("aa", "a"), task("b"), task("bb", "b")];
  const flow: ProjectWorkflow = {
    nodes: [
      node("a1", "a"),
      node("aa1", "aa"),
      node("b1", "b"),
      node("b2", "b", { memberId: "other" }),
      node("bb2", "bb", { memberId: "other" }),
      node("a2", "a", { memberId: "other" }),
    ],
    edges: [
      { id: "forward", from: "a1", to: "b1", kind: "sequence" },
      { id: "back", from: "b2", to: "a2", kind: "sequence" },
      { id: "within", from: "b2", to: "bb2", kind: "sequence" },
      { id: "derived", from: "a1", to: "aa1", kind: "derived" },
      { id: "missing", from: "absent", to: "b1", kind: "sequence" },
    ],
  };
  const m = workflowMap(tasks, flow);
  expect(m.links).toHaveLength(1);
  expect(m.links[0].edges.map((e) => e.id)).toEqual(["forward", "back"]);
  expect(m.byNode.get(m.links[0].edges[1].from)?.memberId).toBe("other");
});
test("cycles, missing task metadata and unassigned completion remain discoverable", () => {
  const m = workflowMap(
    [task("a", "b"), task("b", "a"), task("c", "b"), task("orphan", "gone")],
    {
      nodes: [
        node("a"),
        node("b"),
        node("c"),
        node("orphan"),
        node("unknown"),
        node("done", "done", { memberId: null, state: "done" }),
      ],
      edges: [],
    },
  );
  expect(m.groups.flatMap((g) => g.taskIds).sort()).toEqual([
    "a",
    "b",
    "c",
    "done",
    "orphan",
    "unknown",
  ]);
  expect(m.groups.find((g) => g.id === "a")?.taskIds).toEqual(["a", "b", "c"]);
  expect(m.groups.find((g) => g.id === "individual")?.counts.done).toBe(1);
  expect(workflowMap([], { nodes: [], edges: [] }).groups).toEqual([]);
});
test("a selected task opens its blocking evidence without mutating queue order or discarding other occurrences", () => {
  const ns = [
    node("run", "a", { state: "running", order: 1 }),
    node("blocked", "a", {
      state: "blocked",
      order: 9,
      memberId: "reviewer",
      reason: "실패 근거",
    }),
    node("done", "a", { state: "done" }),
    node("stale", "b", { state: "unknown" }),
    node("free", "c", { memberId: null }),
  ];
  expect(
    workflowTaskNodes(ns, ["b", "a", "c", "absent"]).map((n) => n.id),
  ).toEqual(["stale", "blocked", "free"]);
  expect(ns.map((n) => n.id)).toEqual([
    "run",
    "blocked",
    "done",
    "stale",
    "free",
  ]);
});
