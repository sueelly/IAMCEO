import { deliveryWaitText, memberIssueLabel, providerIssueKind } from "../shared/execution-issues.ts";
import type { ProgressFacts } from "./task-progress.ts";
import type { Member, Task, WorkItem } from "../shared/types.ts";
import { WORKFLOW_OBSERVATION_MAX_AGE_MS, type ProjectWorkflow, type WorkflowInputBlock, type WorkflowNode } from "../shared/workflow.ts";
import { taskStageLabel } from "../shared/task-stage.ts";

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
  source?: WorkflowNode["assignmentSource"];
  inputBlocks?: WorkflowInputBlock[];
  continuation?: boolean;
  blocksSequence?: boolean;
  /** The representative reviewed placement on the worker's ordered workflow. */
  reviewedOrder?: boolean;
  awaitingOwner?: { taskId: string; title: string; terminal: boolean } | null;
  suspendedBy?: { taskId: string; title: string } | null;
}
export type WorkflowOwnerFacts = Pick<ProgressFacts, "decisions" | "todos">;
export interface WorkflowReport { taskId: string; memberId: string | null; kind: string; title: string; at: string; participatedAt?: string | null }

function inputExplanation(block: WorkflowInputBlock | undefined): { label: string; reason: string; thread?: boolean } {
  if (block?.reason === "restore_reconciliation_required") return { label: "복원 확인 필요", reason: "맥미니 복원 때 이전 입력의 수신·실행 결과를 확인하지 못해 추가 전달을 멈췄습니다. 총괄이 원래 지시와 복원된 기록을 대조해 남은 업무를 이어갈 차례입니다. 이 입력은 자동으로 다시 보내지 않습니다", thread: true };
  if (block?.phase === "stopped") return { label: "추가 전달 중지", reason: "이 입력의 추가 전달이 중지되었습니다. 과거 수신 여부와 업무 완료 여부는 별도 확인이 필요합니다. 총괄이 업무 대화에서 남은 일과 재개 여부를 확인할 차례입니다", thread: true };
  if (block?.retryReason === "rejected_limit") return { label: "전달 재시도 한도", reason: "입력 전에 반복해서 거절되어 자동 전달을 멈췄습니다. 직원의 입력칸과 승인 창을 확인한 뒤 전달 알림에서 다시 확인할 수 있습니다" };
  if (block?.phase === "checking") return { label: "수신 확인 중", reason: "원래 입력이 직원에게 들어갔는지 확인하고 있습니다. 확인이 끝나기 전에는 같은 입력을 다시 보내지 않습니다" };
  if (block?.phase === "resolved") return { label: "이전 입력 확인 필요", reason: "이전 입력의 복구 절차는 닫혔지만 이 업무의 완료 근거는 확인되지 않았습니다. 총괄이 업무 대화와 실행 결과를 확인할 차례입니다. 같은 입력을 자동으로 다시 보내지 않습니다", thread: true };
  const reasons: Record<string, string> = {
    session_lost: "세션이나 터미널이 바뀌어 이전 입력의 수신 결과를 확인하지 못했습니다. 직원의 연결과 전달 알림을 확인해 주세요",
    identity_changed: "직원의 세션이 다시 열려 이전 입력의 수신 결과를 확인하지 못했습니다. 같은 대화인지 확인한 뒤 전달 알림에서 다시 확인해 주세요",
    session_unbound: "CLI 대화 연결을 확인하지 못했습니다. 직원의 터미널에서 세션을 확인해 주세요",
    manual_control: "직원 터미널을 직접 조작 중입니다. 조작이 끝나면 수신 여부를 다시 확인합니다",
    busy: "직원이 입력을 받을 수 있을 때 수신 여부를 다시 확인합니다",
    blocked: "직원의 승인·선택 창이 닫히면 수신 여부를 다시 확인합니다",
    source_changed: "원래 지시가 변경되어 이전 입력을 다시 보내지 않습니다. 직원의 전달 알림에서 수신 여부를 확인해 주세요",
    duplicate_draft: "이미 받은 지시가 입력칸에도 남아 있습니다. 직원 터미널의 초안을 확인해 주세요",
    retry_exhausted: "자동 재전송 한도에 도달했습니다. 직원의 전달 알림에서 수신 근거와 가능한 조치를 확인해 주세요",
    log_missing: "세션 기록을 찾지 못해 수신 여부를 확인하지 못했습니다. 직원의 연결과 기록 상태를 확인해 주세요",
    log_incomplete: "세션 기록을 끝까지 읽지 못해 수신 여부를 확정하지 못했습니다. 직원의 전달 알림에서 다시 확인해 주세요",
    unsupported_schema: "현재 실행기는 수신 여부를 확인할 수 없습니다. 직원 터미널에서 원래 지시의 처리 결과를 확인해 주세요",
  };
  const holdReasons: Record<string, string> = {
    asleep: "직원이 잠들어 입력 전달을 기다립니다", offline: "직원 연결이 끊겨 입력 전달을 기다립니다",
    backend_down: "실행기에 연결하지 못해 입력 전달을 기다립니다", runner_disabled: "직원 실행이 꺼져 있어 입력 전달을 기다립니다",
    input_busy: "직원의 입력칸을 사용할 수 없어 전달을 기다립니다", blocked: "직원의 승인·선택 창에서 응답을 기다립니다",
    archived: "보관된 프로젝트의 입력이라 전달을 보류했습니다", legacy_session: "이전 세션의 입력이라 전달을 보류했습니다",
  };
  const known = block?.reason && reasons[block.reason];
  if (known) return { label: block?.phase === "waiting" ? "수신 확인 대기" : "수신 확인 필요", reason: known };
  if (block?.phase === "none" && block.holdReason && holdReasons[block.holdReason]) return { label: "전달 보류", reason: holdReasons[block.holdReason]! };
  return { label: "수신 확인 필요", reason: "이전 입력이 들어갔는지 확정하지 못했습니다. 직원의 전달 알림에서 수신 근거와 가능한 조치를 확인해 주세요. 확인 전에는 자동으로 다시 보내지 않습니다" };
}

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

/** Unrelated deliveries share an inbox, not a prerequisite. A reviewed row
 * placement retains its order, as do separate branches of a single task family. */
export function assignmentPredecessor(targetId: string, ordered: readonly WorkflowAssignment[],
  tasks: ReadonlyMap<string, Pick<Task, "parentTaskId">>, reviewedOrder: boolean, nearest = false): WorkflowAssignment | undefined {
  const ancestors = new Set<string>();
  let id: string | null | undefined = targetId;
  while (id && !ancestors.has(id)) {
    ancestors.add(id);
    id = tasks.get(id)?.parentTaskId;
  }
  // A standalone task has no family-specific predecessors.
  if (!reviewedOrder && ancestors.size === 1) return;
  let prior: WorkflowAssignment | undefined;
  for (const item of ordered) {
    if (item.taskId === targetId) break;
    if (ancestors.has(item.taskId)) continue;
    const visited = new Set<string>();
    let parent = tasks.get(item.taskId)?.parentTaskId;
    while (parent && !visited.has(parent)) {
      visited.add(parent);
      if (ancestors.has(parent)) break;
      parent = tasks.get(parent)?.parentTaskId;
    }
    if (parent !== targetId && (reviewedOrder || !!parent && ancestors.has(parent))) {
      if (!nearest) return item;
      prior = item;
    }
  }
  return prior;
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
export function buildWorkflow(tasks: readonly Task[], members: readonly Member[], assignments: readonly WorkflowAssignment[], reports: readonly WorkflowReport[], now = Date.now(), activity: readonly { memberId: string; kind: string; title: string; at: string }[] = [], work: readonly WorkItem[] = [], pauses: readonly { taskId: string; reason: string; pausedAt: string | null }[] = [], ownerFacts?: ReadonlyMap<string, WorkflowOwnerFacts>): ProjectWorkflow {
  const hasOwnerRequest = (id: string) => {
    const f = ownerFacts?.get(id);
    return !!(f?.decisions.length || f?.todos.length);
  };
  const board = new Map(work.map(w => [w.taskId ?? `tk_${w.id}`, w]));
  const pausedTasks = new Map(pauses.map(p => [p.taskId, p]));
  const lastReport = new Map<string, string>();
  for (const report of reports) if (report.at > (lastReport.get(report.taskId) ?? "")) lastReport.set(report.taskId, report.at);
  const taskById = new Map(tasks.map(t => [t.id, t]));
  const completedBoardRecords = new Set(work.filter(w => {
    const id = `tk_${w.id}`, task = taskById.get(id);
    // The old board is a historical disposition, not a modern verified done mark.
    return !w.taskId && w.sec === "done" && task?.origin === "board"
      && (lastReport.get(id) ?? "") <= w.updatedAt && (task.progress?.since ?? "") <= w.updatedAt;
  }).map(w => `tk_${w.id}`));
  const deliveredTasks = new Set(assignments.map(a => a.taskId));
  const taskMap = new Map(tasks.filter(t => !t.mergedInto
    && (t.origin !== "server" || deliveredTasks.has(t.id) || hasOwnerRequest(t.id))
    && !(completedBoardRecords.has(t.id) && !deliveredTasks.has(t.id) && !pausedTasks.has(t.id) && !hasOwnerRequest(t.id)))
    .map(t => [t.id, t]));
  const memberMap = new Map(members.map(m => [m.id, m]));
  const rows = new Map<string, WorkflowAssignment[]>();
  const projected = [...assignments];
  const occurrences = new Set(assignments.map(a => `${a.memberId}:${a.taskId}`));
  const infer = (taskId: string, memberId: string, at: string, source: "report" | "board") => {
    const key = `${memberId}:${taskId}`;
    if (!taskMap.has(taskId) || !memberMap.has(memberId) || occurrences.has(key)) return;
    occurrences.add(key);
    // Projection evidence must not enroll, reorder or unblock executable work.
    projected.push({ taskId, memberId, order: Number.MAX_SAFE_INTEGER, assignedAt: at, source,
      eligible: false, enrolled: false, queued: 0, held: 0, notices: 0, protected: 0, retryAt: null });
  };
  for (const r of reports) {
    const at = r.participatedAt ?? (["진행", "막힘", "완료"].includes(r.kind) ? r.at : null);
    if (r.memberId && at) infer(r.taskId, r.memberId, at, "report");
  }
  for (const [taskId, w] of board) {
    const matches = members.filter(m => w.who.trim() && (m.name === w.who.trim() || m.handle === w.who.trim()));
    if (matches.length === 1) infer(taskId, matches[0]!.id, w.createdAt, "board");
  }
  projected.sort((a, b) => a.order - b.order || a.assignedAt.localeCompare(b.assignedAt));
  for (const a of projected) {
    if (!taskMap.has(a.taskId) || !memberMap.has(a.memberId)) continue;
    const row = rows.get(a.memberId) ?? [];
    row.push(a); rows.set(a.memberId, row);
  }
  const nodes: WorkflowNode[] = [], edges: ProjectWorkflow["edges"] = [];
  const assigned = new Set<string>();
  const lastReports = new Map<string, WorkflowReport>();
  for (const r of reports) lastReports.set(`${r.taskId}:${r.memberId ?? ""}`, r);
  const make = (task: Task, a: WorkflowAssignment | null, m: Member | undefined, first: WorkflowAssignment | undefined, blocker?: WorkflowAssignment): WorkflowNode => {
    const p = task.progress;
    const w = board.get(task.id);
    const own = m ? lastReports.get(`${task.id}:${m.id}`) : undefined;
    const report = own ?? lastReports.get(`${task.id}:`);
    const n: WorkflowNode = { id: `${m?.id ?? "unassigned"}:${task.id}`, taskId: task.id, memberId: m?.id ?? null,
      order: a?.order ?? 0, historical: !!a && !a.enrolled && !a.continuation && (!a.source || a.source === "delivery") && (!p || p.stage === "new"),
      ...(a ? { assignmentSource: a.source ?? "delivery" } : {}),
      assignedAt: a?.assignedAt ?? task.createdAt, state: "waiting", label: "배정 전", current: false, ownerActionRequired: false,
      reason: null, action: { label: "대화 열기", tab: "thread", sub: task.id }, observedAt: m?.statusObservation?.observedAt ?? null,
      lastActivity: report ? { kind: report.kind, title: report.title, at: report.at } : null,
      counts: { queued: a?.queued ?? 0, held: a?.held ?? 0, notices: a?.notices ?? 0 } };
    const e = m?.executionState;
    const hasRun = !!e && !e.endedAt && !!e.taskIds?.length && ["received", "starting", "running", "unknown"].includes(e.phase);
    const inRun = hasRun && !!e?.taskIds?.includes(task.id);
    if (inRun) {
      const live = activity.find(x => x.memberId === m?.id && x.at >= (e?.startedAt ?? e?.inputReceivedAt ?? "~"));
      if (live) n.lastActivity = { kind: live.kind, title: live.title, at: live.at };
    }
    const obs = m?.statusObservation;
    const verified = obs?.freshness === "fresh" && obs.ownership === "verified" && now - Date.parse(obs.observedAt ?? "") < WORKFLOW_OBSERVATION_MAX_AGE_MS;
    n.current = inRun || (!hasRun && !!first && first.taskId === task.id);
    const memberAction = m ? { label: "직원 확인", tab: "team" as const, sub: m.id } : n.action;
    const loginRequired = !!m && (m.executionIssue?.kind ?? providerIssueKind(m.lastError)) === "authentication";
    const nativePrompt = !!m && m.status === "blocked" && !!m.blockedReason && m.blockedReason !== "status_unknown" && verified;
    const hold = a?.suspendedBy || w?.sec === "hold" || p?.stage === "hold" || pausedTasks.has(task.id);
    const ownerBlock = a?.inputBlocks?.find(b => b.phase === "needs_owner" || (!hold && b.phase === "resolved" && b.reason === "not_received" && b.retryReason === "rejected_limit"));
    const fact = ownerFacts?.get(task.id);
    if (hasOwnerRequest(task.id) || p?.stage === "owner") {
      const requests = [...(fact?.decisions ?? []).map(d => ({ tab: "inbox" as const, sub: d.id, label: d.title })),
        ...(fact?.todos ?? []).map(t => ({ tab: "home" as const, sub: t.id, label: t.title }))];
      const [primary, ...others] = requests;
      const additional: NonNullable<WorkflowNode["action"]>[] = others;
      if (m && memberAction && (ownerBlock || n.current && (nativePrompt || loginRequired))) additional.push(memberAction);
      return { ...n, ownerActionRequired: true, historical: false, state: p?.stage === "done" ? "done" : "blocked",
        label: p?.stage === "done" ? "완료 · 대표 응답" : "대표 확인", reason: primary?.label ?? p?.next ?? null,
        action: primary ? { ...primary, label: primary.tab === "home" ? "내 할 일 열기" : "결재 열기" } : { label: "결재함 열기", tab: "inbox", sub: null },
        ...(ownerBlock ? { inputBlock: ownerBlock } : {}), ...(additional.length ? { additionalOwnerActions: additional } : {}) };
    }
    if (p?.stage === "done") return { ...n, state: "done", label: "완료" };
    if (ownerBlock) {
      const { label, reason } = inputExplanation(ownerBlock);
      return { ...n, ownerActionRequired: true, historical: false, state: "blocked", inputBlock: ownerBlock, label, reason, action: memberAction };
    }
    const pause = pausedTasks.get(task.id);
    if (pause) return { ...n, historical: false, state: "blocked", label: "대표가 중단",
      reason: `${pause.reason.replace(/[.\s]+$/, "")}. 같은 업무에 새 대표 지시가 오거나 다시 열기 전까지 후속 실행을 멈춥니다`,
      ...(a?.inputBlocks?.length ? { inputBlock: a.inputBlocks[0] } : {}) };
    // Only current, verified execution evidence earns a running highlight.
    if (inRun && verified && m?.status === "working" && e?.phase === "running") return { ...n, historical: false, state: "running", label: "실행 중", reason: null };
    if (inRun && verified && (e?.phase === "starting" || e?.phase === "received")) return { ...n, state: "starting", label: "시작 중" };
    if (inRun && m?.status === "blocked") {
      const realPrompt = verified && m.blockedReason && m.blockedReason !== "status_unknown";
      const prompt = realPrompt ? deliveryWaitText({ kind: m.blockedReason === "permission" || m.blockedReason === "selection" || m.blockedReason === "setup" ? m.blockedReason : "input", since: "" }) : null;
      return { ...n, ownerActionRequired: !!realPrompt, state: realPrompt ? "blocked" : "unknown", label: prompt?.label ?? "실행 상태 미확인",
        reason: prompt?.reason ?? "실행 상태를 확인하지 못했습니다. 직원의 연결 상태를 확인해 주세요", action: memberAction };
    }
    if (inRun && (!verified || e?.phase === "unknown")) return { ...n, state: "unknown", label: "실행 상태 미확인", reason: "마지막 관측으로 현재 실행을 확정할 수 없습니다", action: memberAction };
    if (hold) {
      const sourceId = a?.suspendedBy?.taskId ?? task.id;
      const source = taskById.get(sourceId);
      const sourceCard = board.get(sourceId);
      const reason = pausedTasks.get(sourceId)?.reason ||
        (source?.progress?.stage === "hold" && source.progress.next) ||
        (sourceCard?.sec === "hold" && sourceCard.detail) || "진행판에 보류로 기록되어 있습니다";
      const parent = a?.suspendedBy;
      return { ...n, historical: false, current: inRun, state: "blocked", label: "보류",
        reason: parent && parent.taskId !== task.id ? `‘${parent.title}’에서 대기 중입니다. ${reason}` : reason,
        ...(a?.inputBlocks?.length ? { inputBlock: a.inputBlocks[0] } : {}) };
    }
    if (a?.protected || a?.held) {
      const block = a.inputBlocks?.find(b => !["stopped", "resolved"].includes(b.phase)) ?? a.inputBlocks?.[0];
      const ordinaryHold = !a.protected && block?.phase === "none";
      const issue = ordinaryHold && m ? memberIssueLabel(m) : null;
      const explanation = issue ? { label: issue, reason: m!.executionIssue?.detail ?? m!.lastError }
        : ordinaryHold && m?.deliveryWait ? deliveryWaitText(m.deliveryWait) : inputExplanation(block);
      return { ...n, ownerActionRequired: ordinaryHold && n.current && (loginRequired || nativePrompt), historical: false, state: "blocked", label: explanation.label, reason: explanation.reason,
        ...(block ? { inputBlock: block } : {}), action: "thread" in explanation && explanation.thread ? n.action : memberAction };
    }
    if (a?.awaitingOwner && a.awaitingOwner.taskId !== task.id) {
      const gate = a.awaitingOwner;
      return { ...n, state: "blocked", label: "선행 응답 대기",
        reason: `‘${gate.title}’에서 ${gate.terminal ? "직원 터미널의 승인 응답" : "대표의 결정"}을 기다립니다`,
        action: gate.terminal ? { label: "업무 보기", tab: "thread", sub: gate.taskId } : { label: "결재함 열기", tab: "inbox", sub: null } };
    }
    if (blocker) return { ...n, state: "waiting", label: "선행 업무 대기", reason: `‘${taskMap.get(blocker.taskId)!.title}’의 직원 담당 단계가 끝나거나 보류되어 순서가 풀리면 시작합니다` };
    if (p && ["delivered", "review", "merge", "merged", "applied"].includes(p.stage)) return { ...n, state: "review", label: taskStageLabel(p), reason: p.next };
    if (p?.stage === "fix" && p.continuesWork) return { ...n, state: a?.queued ? "queued" : "waiting", label: taskStageLabel(p), reason: p.next };
    if (p && ["fix", "confirm", "check", "hold", "held", "approval"].includes(p.stage)) return { ...n, ownerActionRequired: p.stage === "approval" && nativePrompt && n.current, state: p.stage === "confirm" ? "review" : "blocked", label: taskStageLabel(p), reason: p.next,
      action: p.stage === "approval" ? memberAction : n.action };
    if (n.historical) return { ...n, state: "review", label: "이전 지시", reason: "이전에 전달된 지시입니다. 이 업무의 완료 근거는 아직 기록되지 않았습니다" };
    if (!m || !a) return { ...n, label: p?.stage === "working" ? "담당 확인" : "배정 전", reason: p?.next ?? (w?.who ? `진행판 담당은 ‘${w.who}’입니다. 현재 직원 한 명과 일치하지 않아 담당을 확인해야 합니다` : "담당 직원이 아직 배정되지 않았습니다") };
    if (a.source === "board" && (!p || p.stage === "new")) return { ...n, label: "착수 대기", reason: "진행판에 담당이 지정되어 있습니다. 실행 지시의 전달은 아직 확인되지 않았습니다" };
    const issue = memberIssueLabel(m);
    if (issue) return { ...n, ownerActionRequired: loginRequired && n.current, state: "blocked", label: issue, reason: m.executionIssue?.detail ?? m.lastError, action: memberAction };
    if (a.queued && m.deliveryWait && m.deliveryWait.kind !== "sequence") return { ...n, state: "queued", ...deliveryWaitText(m.deliveryWait) };
    if (m.status === "asleep" || m.status === "offline" || m.status === "error") return { ...n, state: "blocked", label: m.status === "asleep" ? "직원 잠듦" : "연결 확인", reason: "직원 화면에서 연결 상태와 실행 가능 여부를 확인해 주세요", action: memberAction };
    if (a.queued) return { ...n, state: "queued", label: a.retryAt ? "재시도 대기" : "전달 대기", reason: a.retryAt ? `다음 전달 시각: ${a.retryAt}` : null };
    return { ...n, state: "waiting", label: "결과 기록 대기", reason: p?.next ?? "직원의 실행이 끝났고 업무 결과를 기다리고 있습니다" };
  };
  for (const [memberId, originalRow] of rows) {
    // Report/board ancestors provide context, never an execution-order anchor.
    const inferred = (a: WorkflowAssignment) => a.source === "report" || a.source === "board";
    const row = [...orderAssignments(originalRow.filter(a => !inferred(a)), taskMap),
      ...orderAssignments(originalRow.filter(inferred), taskMap)].map((a, order) => ({ ...a, order }));
    const enrolled = row.filter(a => a.eligible && a.blocksSequence !== false);
    const open = enrolled.filter(a => taskMap.get(a.taskId)?.progress?.stage !== "done");
    const blockers = new Map(open.map(a => [a.taskId, memberMap.get(memberId)?.kind === "worker"
      ? assignmentPredecessor(a.taskId, open, taskMap, !!a.reviewedOrder) : undefined]));
    const first = open.find(a => a.queued && !a.awaitingOwner && !blockers.get(a.taskId)) ?? open[0];
    for (const a of row) {
      const t = taskMap.get(a.taskId)!, blocker = blockers.get(a.taskId);
      const node = make(t, a, memberMap.get(memberId), first, blocker);
      assigned.add(t.id); nodes.push(node);
      // Show adjacent ordered assignments, including completed history. The
      // waiting label above instead identifies the earliest unfinished blocker.
      const prior = a.eligible && a.blocksSequence !== false && memberMap.get(memberId)?.kind === "worker"
        ? assignmentPredecessor(t.id, enrolled, taskMap, !!a.reviewedOrder, true) : undefined;
      if (prior) {
        const from = `${memberId}:${prior.taskId}`;
        edges.push({ id: `seq:${from}:${node.id}`, from, to: node.id, kind: "sequence" });
      }
    }
  }
  for (const t of taskMap.values()) if (!assigned.has(t.id)) nodes.push(make(t, null, undefined, undefined));
  const byTask = new Map<string, WorkflowNode[]>();
  for (const n of nodes) { const list = byTask.get(n.taskId) ?? []; list.push(n); byTask.set(n.taskId, list); }
  for (const n of nodes) {
    const parent = taskMap.get(n.taskId)?.parentTaskId;
    if (!parent) continue;
    const sources = byTask.get(parent) ?? [];
    const from = sources.find(p => p.memberId === n.memberId) ?? sources[0];
    if (from) edges.push({ id: `derived:${from.id}:${n.id}`, from: from.id, to: n.id, kind: "derived" });
  }
  return { nodes, edges };
}
