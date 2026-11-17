import type { Member, Task } from "../shared/types.ts";
import { WORKFLOW_OBSERVATION_MAX_AGE_MS, type ProjectWorkflow, type WorkflowNode } from "../shared/workflow.ts";
import { STAGE_LABEL } from "../shared/task-stage.ts";

export interface WorkflowAssignment {
  taskId: string;
  memberId: string;
  order: number;
  assignedAt: string;
  eligible: boolean;
  enrolled: boolean;
  queued: number;
  held: number;
  notices: number;
  protected: number;
  retryAt: string | null;
}
export interface WorkflowReport { taskId: string; memberId: string | null; kind: string; title: string; at: string }

/** Derived work continues its ancestor; a parent is not its own execution prerequisite. */
export function relatedWork(a: string, b: string, tasks: ReadonlyMap<string, Pick<Task, "parentTaskId">>): boolean {
  const under = (child: string, parent: string) => {
    const seen = new Set<string>();
    while (!seen.has(child)) {
      if (child === parent) return true;
      seen.add(child);
      const next = tasks.get(child)?.parentTaskId;
      if (!next) break;
      child = next;
    }
    return false;
  };
  return under(a, b) || under(b, a);
}

/** Keep a parent's later continuations beside it, ahead of unrelated queued work. */
export function orderAssignments(input: readonly WorkflowAssignment[], tasks: ReadonlyMap<string, Pick<Task, "parentTaskId">>): WorkflowAssignment[] {
  const sorted = [...input].sort((a, b) => a.order - b.order);
  const assigned = new Set(sorted.map(a => a.taskId));
  const children = new Map<string | null, WorkflowAssignment[]>();
  for (const a of sorted) {
    let parent = tasks.get(a.taskId)?.parentTaskId ?? null;
    const seen = new Set([a.taskId]);
    while (parent && !assigned.has(parent) && !seen.has(parent)) { seen.add(parent); parent = tasks.get(parent)?.parentTaskId ?? null; }
    if (parent && seen.has(parent)) parent = null;
    const list = children.get(parent) ?? []; list.push(a); children.set(parent, list);
  }
  const ordered: WorkflowAssignment[] = [], seen = new Set<string>();
  const visit = (a: WorkflowAssignment) => {
    if (seen.has(a.taskId)) return;
    seen.add(a.taskId); ordered.push({ ...a, order: ordered.length });
    for (const child of children.get(a.taskId) ?? []) visit(child);
  };
  for (const a of children.get(null) ?? []) visit(a);
  for (const a of sorted) visit(a); // malformed historical cycles cannot hide tasks or recurse forever
  return ordered;
}

/** Metadata only. No current work is inferred from an employee's old `now` report. */
export function buildWorkflow(tasks: readonly Task[], members: readonly Member[], assignments: readonly WorkflowAssignment[], reports: readonly WorkflowReport[], now = Date.now(), activity: readonly { memberId: string; kind: string; title: string; at: string }[] = []): ProjectWorkflow {
  const taskMap = new Map(tasks.filter(t => !t.mergedInto).map(t => [t.id, t]));
  const memberMap = new Map(members.map(m => [m.id, m]));
  const rows = new Map<string, WorkflowAssignment[]>();
  for (const a of assignments) {
    if (!taskMap.has(a.taskId) || !memberMap.has(a.memberId)) continue;
    const row = rows.get(a.memberId) ?? [];
    row.push(a); rows.set(a.memberId, row);
  }
  const nodes: WorkflowNode[] = [], edges: ProjectWorkflow["edges"] = [];
  const assigned = new Set<string>();
  const lastReports = new Map<string, WorkflowReport>();
  for (const r of reports) lastReports.set(`${r.taskId}:${r.memberId ?? ""}`, r);
  const make = (task: Task, a: WorkflowAssignment | null, m: Member | undefined, first: WorkflowAssignment | undefined): WorkflowNode => {
    const p = task.progress;
    const own = m ? lastReports.get(`${task.id}:${m.id}`) : undefined;
    const report = own ?? lastReports.get(`${task.id}:`);
    const n: WorkflowNode = { id: `${m?.id ?? "unassigned"}:${task.id}`, taskId: task.id, memberId: m?.id ?? null,
      order: a?.order ?? 0, historical: !!a && !a.enrolled, assignedAt: a?.assignedAt ?? task.createdAt, state: "waiting", label: "배정 전", current: false,
      reason: null, action: { label: "대화 열기", tab: "thread", sub: task.id }, observedAt: m?.statusObservation?.observedAt ?? null,
      lastActivity: report ? { kind: report.kind, title: report.title, at: report.at } : null,
      counts: { queued: a?.queued ?? 0, held: a?.held ?? 0, notices: a?.notices ?? 0 } };
    if (p?.stage === "done") return { ...n, state: "done", label: "완료" };
    if (!m || !a) return { ...n, reason: p?.next ?? "담당 직원이 아직 배정되지 않았습니다" };
    const e = m.executionState;
    const hasRun = !!e && !e.endedAt && !!e.taskIds?.length && ["received", "starting", "running", "unknown"].includes(e.phase);
    const inRun = hasRun && !!e?.taskIds?.includes(task.id);
    if (inRun) {
      const live = activity.find(x => x.memberId === m.id && x.at >= (e?.startedAt ?? e?.inputReceivedAt ?? "~"));
      if (live) n.lastActivity = { kind: live.kind, title: live.title, at: live.at };
    }
    const obs = m.statusObservation;
    const verified = obs?.freshness === "fresh" && obs.ownership === "verified" && now - Date.parse(obs.observedAt ?? "") < WORKFLOW_OBSERVATION_MAX_AGE_MS;
    n.current = inRun || (!hasRun && !!first && first.taskId === task.id);
    const memberAction = { label: "직원 확인", tab: "team" as const, sub: m.id };
    // Only current, verified execution evidence earns a running highlight.
    if (inRun && verified && m.status === "working" && e?.phase === "running") return { ...n, state: "running", label: "실행 중", reason: null };
    if (inRun && verified && (e?.phase === "starting" || e?.phase === "received")) return { ...n, state: "starting", label: "시작 중" };
    if (p?.stage === "working" && p.execution?.background && p.execution.memberId === m.id && p.execution.sessionGeneration === e?.sessionGeneration) return { ...n, state: "running", label: "뒤 작업", reason: p.next };
    if (p?.stage === "owner") return { ...n, state: "blocked", label: "대표 확인", reason: p.next, action: { label: "결재함 열기", tab: "inbox", sub: null } };
    if (inRun && m.status === "blocked") {
      const realPrompt = verified && m.blockedReason && m.blockedReason !== "status_unknown";
      return { ...n, state: realPrompt ? "blocked" : "unknown", label: realPrompt ? "입력 확인" : "실행 확인 필요",
        reason: realPrompt ? "직원의 승인·선택 창에서 응답이 필요합니다" : "실행 상태를 확인하지 못했습니다. 직원의 연결 상태를 확인해 주세요", action: memberAction };
    }
    if (inRun && (!verified || e?.phase === "unknown")) return { ...n, state: "unknown", label: "실행 확인 필요", reason: "마지막 관측으로 현재 실행을 확정할 수 없습니다", action: memberAction };
    if (a.protected || a.held) return { ...n, state: "blocked", label: a.protected ? "입력 보호" : "전달 보류",
      reason: a.protected ? "이전 입력의 처리 결과를 확인해야 합니다. 자동으로 다시 보내지 않습니다" : p?.next ?? "입력 전달이 보류되었습니다. 직원 화면에서 이유와 가능한 조치를 확인해 주세요", action: memberAction };
    if (!a.enrolled) return { ...n, state: "review", label: "이전 업무", reason: p?.next ?? "완료 단계가 도입되기 전 기록입니다. 업무 대화에서 결과를 확인할 수 있습니다" };
    if (m.kind === "worker" && first && first.taskId !== task.id && !relatedWork(first.taskId, task.id, taskMap)) return { ...n, state: "waiting", label: "선행 업무 대기", reason: `‘${taskMap.get(first.taskId)?.title ?? "앞선 업무"}’ 완료 후 시작합니다` };
    if (p && ["delivered", "review", "merge", "merged", "applied"].includes(p.stage)) return { ...n, state: "review", label: STAGE_LABEL[p.stage], reason: p.next };
    if (p && !(p.stage === "confirm" && p.cause === "pending") && ["fix", "confirm", "check", "hold", "held", "approval"].includes(p.stage)) return { ...n, state: p.stage === "confirm" ? "waiting" : "blocked", label: STAGE_LABEL[p.stage], reason: p.next,
      action: p.stage === "approval" ? memberAction : n.action };
    if (m.status === "asleep" || m.status === "offline" || m.status === "error") return { ...n, state: "blocked", label: m.status === "asleep" ? "직원 잠듦" : "연결 확인", reason: "직원 화면에서 연결 상태와 실행 가능 여부를 확인해 주세요", action: memberAction };
    if (a.queued) return { ...n, state: "queued", label: a.retryAt ? "재시도 대기" : "전달 대기", reason: a.retryAt ? `다음 전달 시각: ${a.retryAt}` : null };
    return { ...n, state: "waiting", label: "완료 확인 대기", reason: p?.next ?? "실행 턴은 끝났지만 이 업무의 완료는 아직 확인되지 않았습니다" };
  };
  for (const [memberId, originalRow] of rows) {
    const row = orderAssignments(originalRow, taskMap);
    const first = row.find(a => a.eligible && taskMap.get(a.taskId)?.progress?.stage !== "done");
    let prev: WorkflowNode | undefined;
    for (const a of row) {
      const t = taskMap.get(a.taskId)!;
      const node = make(t, a, memberMap.get(memberId), first);
      if (first && memberMap.get(memberId)?.kind === "worker" && a.eligible && node.state !== "running" && node.state !== "starting" && node.state !== "done") {
        const predecessor = row.find(x => x.order < a.order && x.eligible && taskMap.get(x.taskId)?.progress?.stage !== "done" && relatedWork(first.taskId, x.taskId, taskMap) && !relatedWork(x.taskId, a.taskId, taskMap));
        if (predecessor) { node.state = "waiting"; node.label = "선행 업무 대기"; node.reason = `‘${taskMap.get(predecessor.taskId)!.title}’ 완료 후 시작합니다`; }
      }
      assigned.add(t.id); nodes.push(node);
      if (prev && a.eligible && memberMap.get(memberId)?.kind === "worker" && !relatedWork(prev.taskId, t.id, taskMap)) edges.push({ id: `seq:${prev.id}:${node.id}`, from: prev.id, to: node.id, kind: "sequence" });
      if (a.eligible) prev = node;
    }
  }
  for (const t of taskMap.values()) if (!assigned.has(t.id)) nodes.push(make(t, null, undefined, undefined));
  const occurrences = new Map<string, WorkflowNode[]>();
  for (const n of nodes) { const list = occurrences.get(n.taskId) ?? []; list.push(n); occurrences.set(n.taskId, list); }
  for (const n of nodes) {
    const parent = taskMap.get(n.taskId)?.parentTaskId;
    if (!parent) continue;
    const sources = occurrences.get(parent) ?? [];
    const from = sources.find(p => p.memberId === n.memberId) ?? sources[0];
    if (from) edges.push({ id: `derived:${from.id}:${n.id}`, from: from.id, to: n.id, kind: "derived" });
  }
  return { nodes, edges };
}
