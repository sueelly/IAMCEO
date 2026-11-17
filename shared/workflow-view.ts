import type { ProjectWorkflow, WorkflowNode } from "./workflow.ts";

export type WorkflowFilter = "all" | "action" | "running" | "next" | "done" | "unassigned";
export type WorkflowBucket = "done" | "now" | "next" | "unassigned";

/** Presentation never changes enrollment or executable queue order. */
export function workflowBucket(node: WorkflowNode): WorkflowBucket {
  if (node.state === "done") return "done";
  if (!node.memberId) return "unassigned";
  if (node.current || node.historical || !["waiting", "queued"].includes(node.state)) return "now";
  return "next";
}

export function workflowCategory(node: WorkflowNode): Exclude<WorkflowFilter, "all"> {
  if (node.state === "done") return "done";
  if (!node.memberId) return "unassigned";
  if (["blocked", "unknown", "review"].includes(node.state) || node.historical) return "action";
  if (node.state === "running" || node.state === "starting") return "running";
  return workflowBucket(node) === "now" ? "action" : "next";
}

export function workflowSummary(nodes: readonly WorkflowNode[]): Record<WorkflowFilter, number> {
  const priority: Exclude<WorkflowFilter, "all">[] = ["action", "running", "next", "unassigned", "done"];
  const tasks = new Map<string, Exclude<WorkflowFilter, "all">>();
  for (const node of nodes) {
    const next = workflowCategory(node), before = tasks.get(node.taskId);
    if (!before || priority.indexOf(next) < priority.indexOf(before)) tasks.set(node.taskId, next);
  }
  const counts = { all: tasks.size, action: 0, running: 0, next: 0, done: 0, unassigned: 0 };
  for (const category of tasks.values()) counts[category]++;
  return counts;
}

/** Expand task identity first. Only derived edges recurse; sequence edges remain one hop. */
export function workflowFocus(flow: ProjectWorkflow, nodeId: string, depth: "direct" | "family"): Set<string> {
  const nodes = new Map(flow.nodes.map(node => [node.id, node]));
  const start = nodes.get(nodeId);
  if (!start) return new Set();
  const byTask = new Map<string, string[]>();
  for (const node of flow.nodes) byTask.set(node.taskId, [...(byTask.get(node.taskId) ?? []), node.id]);
  const ids = new Set<string>();
  const addTask = (id: string) => { const node = nodes.get(id); if (node) for (const occurrence of byTask.get(node.taskId) ?? []) ids.add(occurrence); };
  addTask(nodeId);
  if (depth === "family") {
    const visited = new Set<string>();
    while ([...ids].some(id => !visited.has(id))) {
      for (const id of [...ids]) {
        if (visited.has(id)) continue;
        visited.add(id);
        for (const edge of flow.edges) if (edge.kind === "derived") {
          if (edge.from === id) addTask(edge.to);
          if (edge.to === id) addTask(edge.from);
        }
      }
    }
  }
  const roots = new Set(ids);
  for (const edge of flow.edges) {
    if (roots.has(edge.from)) addTask(edge.to);
    if (roots.has(edge.to)) addTask(edge.from);
  }
  return ids;
}
