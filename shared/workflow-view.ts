import { WORKFLOW_OBSERVATION_MAX_AGE_MS, type ProjectWorkflow, type WorkflowNode } from "./workflow.ts";

export const WORKFLOW_FILTER_LABELS = {
  all: "전체", action: "대표 응답", review: "팀 처리", running: "실행 중", next: "다음·대기",
  done: "완료", history: "이전 기록", unassigned: "미배정",
} as const;
export type WorkflowFilter = keyof typeof WORKFLOW_FILTER_LABELS;
export type WorkflowCategory = Exclude<WorkflowFilter, "all">;
export type WorkflowBucket = "done" | "now" | "next" | "unassigned";

export function workflowNodeAt(node: WorkflowNode, now: number): WorkflowNode {
  if (node.state !== "running" && node.state !== "starting" ||
    now - Date.parse(node.observedAt ?? "") < WORKFLOW_OBSERVATION_MAX_AGE_MS) return node;
  return { ...node, state: "unknown", label: "실행 상태 미확인", reason: "최근 실행 상태를 확인하지 못했습니다.",
    action: node.memberId && !node.ownerActionRequired ? { label: "직원 확인", tab: "team", sub: node.memberId } : node.action };
}

/** Presentation never changes enrollment or executable queue order. */
export function workflowBucket(node: WorkflowNode): WorkflowBucket {
  if (node.state === "done") return "done";
  if (!node.memberId) return workflowCategory(node) === "action" ? "now" : "unassigned";
  if (node.current || node.historical || !["waiting", "queued"].includes(node.state)) return "now";
  return "next";
}

/** Earlier projections only identify the recipient in the input evidence or action destination. */
function legacyOwnerRequest(node: WorkflowNode): boolean {
  if (node.state !== "blocked") return false;
  const input = node.inputBlock;
  if (input && input.phase !== "none") return input.phase === "needs_owner" ||
    input.phase === "resolved" && input.reason === "not_received" && input.retryReason === "rejected_limit";
  if (node.action?.tab === "inbox") return node.label === "대표 확인" && !node.reason?.endsWith("’에서 대표의 결정을 기다립니다");
  return node.current && node.action?.tab === "team" &&
    ["승인 응답 대기", "선택 응답 대기", "초기 설정 대기", "입력 상태 확인", "승인 창", "로그인 필요"].includes(node.label);
}

export function workflowCategory(node: WorkflowNode): WorkflowCategory {
  if (node.ownerActionRequired ?? legacyOwnerRequest(node)) return "action";
  if (node.state === "done") return "done";
  if (node.state === "running" || node.state === "starting") return "running";
  if (node.state === "unknown") return "review";
  if (node.historical) return "history";
  if (node.state === "blocked" || node.state === "review") return "review";
  return node.memberId ? "next" : "unassigned";
}

export function workflowBlocked(node: WorkflowNode): boolean {
  return (node.state === "blocked" || node.state === "unknown") && workflowCategory(node) !== "history";
}

const priority: Record<WorkflowCategory, number> = { action: 0, running: 2, review: 3, next: 4, unassigned: 5, done: 6, history: 7 };
export function workflowNodePriority(node: WorkflowNode): number {
  const category = workflowCategory(node);
  return category === "review" && (node.state === "blocked" || node.state === "unknown") ? 1 : priority[category];
}

/** Use the same occurrence for a task's filter, count and drill-down. */
export function workflowRepresentativeNodes(nodes: readonly WorkflowNode[]): Map<string, WorkflowNode> {
  const tasks = new Map<string, WorkflowNode>();
  for (const node of nodes) {
    const before = tasks.get(node.taskId);
    if (!before || workflowNodePriority(node) < workflowNodePriority(before)) tasks.set(node.taskId, node);
  }
  return tasks;
}

export function workflowTaskCategories(nodes: readonly WorkflowNode[]): Map<string, WorkflowCategory> {
  return new Map([...workflowRepresentativeNodes(nodes)].map(([id, node]) => [id, workflowCategory(node)]));
}

export function workflowSummary(nodes: readonly WorkflowNode[]): Record<WorkflowFilter, number> {
  const tasks = workflowTaskCategories(nodes);
  const counts = { all: tasks.size, action: 0, review: 0, history: 0, running: 0, next: 0, done: 0, unassigned: 0 };
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
