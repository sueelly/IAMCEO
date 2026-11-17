import type { Task } from "./types";
import type { ProjectWorkflow, WorkflowEdge, WorkflowNode } from "./workflow";
import {
  workflowCategory,
  workflowSummary,
  workflowTaskCategories,
} from "./workflow-view";

/** Collapse presentation identities only. No inferred dependency or enrollment is created. */
export function workflowMap(tasks: readonly Task[], flow: ProjectWorkflow) {
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const byNode = new Map(flow.nodes.map((n) => [n.id, n]));
  const occurrences = new Map<string, WorkflowNode[]>();
  for (const n of flow.nodes) {
    const list = occurrences.get(n.taskId) ?? [];
    list.push(n);
    occurrences.set(n.taskId, list);
  }
  const families = new Map<string, string[]>();
  for (const id of occurrences.keys()) {
    let root = id;
    const path: string[] = [];
    while (
      taskMap.get(root)?.parentTaskId &&
      occurrences.has(taskMap.get(root)!.parentTaskId!)
    ) {
      const cycle = path.indexOf(root);
      if (cycle >= 0) {
        root = path.slice(cycle).sort()[0];
        break;
      }
      path.push(root);
      root = taskMap.get(root)!.parentTaskId!;
    }
    const family = families.get(root) ?? [];
    family.push(id);
    families.set(root, family);
  }
  const sets: [string, string[]][] = [...families].filter(
    ([, ids]) => ids.length > 1,
  );
  const singles = [...families.values()]
    .filter((ids) => ids.length === 1)
    .flat();
  if (singles.length) sets.push(["individual", singles]);
  const groups = sets
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([id, taskIds]) => {
      const nodes = taskIds.flatMap((taskId) => occurrences.get(taskId) ?? []);
      return {
        id,
        title:
          id === "individual"
            ? "개별 업무"
            : (taskMap.get(id)?.title ?? "연결 확인 필요"),
        taskIds,
        members: [
          ...new Set(
            nodes
              .map((n) => n.memberId)
              .filter((id): id is string => id !== null),
          ),
        ],
        counts: workflowSummary(nodes),
        blocked: new Set(
          nodes
            .filter((n) => n.state === "blocked" || n.state === "unknown")
            .map((n) => n.taskId),
        ).size,
      };
    });
  const owner = new Map(
    groups.flatMap((g) => g.taskIds.map((id) => [id, g.id] as const)),
  );
  const links = new Map<
    string,
    { id: string; from: string; to: string; edges: WorkflowEdge[] }
  >();
  for (const edge of flow.edges) {
    if (edge.kind !== "sequence") continue;
    const a = byNode.get(edge.from),
      b = byNode.get(edge.to);
    if (!a || !b) continue;
    const from = owner.get(a.taskId)!,
      to = owner.get(b.taskId)!;
    if (from === to) continue;
    const pair = [from, to].sort(),
      id = JSON.stringify(pair);
    const link = links.get(id) ?? { id, from: pair[0], to: pair[1], edges: [] };
    link.edges.push(edge);
    links.set(id, link);
  }
  return { groups, links: [...links.values()], taskMap, byNode, occurrences };
}

/** Keep input task order; within one task lead with the occurrence needing attention. */
export function workflowTaskNodes(
  nodes: readonly WorkflowNode[],
  ids: readonly string[],
): WorkflowNode[] {
  const rank = (n: WorkflowNode) =>
    n.state === "blocked"
      ? 0
      : n.state === "unknown"
        ? 1
        : workflowCategory(n) === "action"
          ? 2
          : n.state === "running" || n.state === "starting"
            ? 3
            : n.state === "done"
              ? 6
              : n.memberId
                ? 4
                : 5;
  const best = new Map<string, WorkflowNode>();
  for (const n of nodes) {
    const previous = best.get(n.taskId);
    if (!previous || rank(n) < rank(previous)) best.set(n.taskId, n);
  }
  return [...new Set(ids)].flatMap((id) => {
    const node = best.get(id);
    return node ? [node] : [];
  });
}

/** Keep the selection's meaning, then resolve it against the current live projection. */
export type WorkflowMapScope =
  | {
      kind: "tasks";
      source: "group";
      groupId: string;
      category?: "blocked" | "action";
    }
  | {
      kind: "tasks";
      source: "neighbors";
      taskId: string;
      direction: "before" | "after";
    }
  | { kind: "members"; source: "group"; groupId: string }
  | { kind: "members"; source: "task"; taskId: string }
  | { kind: "relations"; pairs: string[] };
export type ResolvedMapScope =
  | { kind: "tasks" | "members"; ids: string[]; title: string }
  | { kind: "relations"; edges: WorkflowEdge[]; title: string };
export function resolveWorkflowMapScope(
  model: ReturnType<typeof workflowMap>,
  flow: ProjectWorkflow,
  scope: WorkflowMapScope,
  visible: ReadonlySet<string>,
): ResolvedMapScope {
  if (scope.kind === "relations")
    return {
      kind: "relations",
      title: "직원별 선후관계",
      edges: model.links
        .filter((l) => scope.pairs.includes(l.id))
        .flatMap((l) => l.edges)
        .filter(
          (e) =>
            visible.has(model.byNode.get(e.from)!.taskId) &&
            visible.has(model.byNode.get(e.to)!.taskId),
        ),
    };
  const group =
    scope.source === "group"
      ? model.groups.find((g) => g.id === scope.groupId)
      : null;
  if (scope.kind === "members") {
    const ids =
      scope.source === "group"
        ? (group?.taskIds ?? []).filter((id) => visible.has(id))
        : [scope.taskId];
    return {
      kind: "members",
      title:
        (group?.title ??
          (scope.source === "task"
            ? model.taskMap.get(scope.taskId)?.title
            : "업무 묶음") ??
          "업무") + " · 참여 직원",
      ids: [
        ...new Set(
          ids
            .flatMap((id) => model.occurrences.get(id) ?? [])
            .flatMap((n) => (n.memberId ? [n.memberId] : [])),
        ),
      ],
    };
  }
  if (scope.source === "neighbors") {
    const selected = new Set(
      (model.occurrences.get(scope.taskId) ?? []).map((n) => n.id),
    );
    const ids = flow.edges.flatMap((e) => {
      const target =
        scope.direction === "before"
          ? selected.has(e.to)
            ? e.from
            : null
          : selected.has(e.from)
            ? e.to
            : null;
      const n = target ? model.byNode.get(target) : null;
      return n && n.taskId !== scope.taskId ? [n.taskId] : [];
    });
    return {
      kind: "tasks",
      ids: [...new Set(ids)],
      title:
        scope.direction === "before"
          ? "선행·부모 업무 전체"
          : "다음·파생 업무 전체",
    };
  }
  const ids = (group?.taskIds ?? []).filter((id) => visible.has(id));
  const categories = workflowTaskCategories(
    ids.flatMap((id) => model.occurrences.get(id) ?? []),
  );
  return {
    kind: "tasks",
    title:
      (group?.title ?? "업무 묶음") +
      (scope.category === "blocked"
        ? " · 막힘"
        : scope.category === "action"
          ? " · 확인 필요"
          : ""),
    ids: ids.filter((id) =>
      scope.category === "blocked"
        ? (model.occurrences.get(id) ?? []).some(
            (n) => n.state === "blocked" || n.state === "unknown",
          )
        : !scope.category || categories.get(id) === scope.category,
    ),
  };
}
