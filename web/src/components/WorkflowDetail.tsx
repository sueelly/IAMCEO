import { useEffect, useRef, useState } from "react";
import type { Message, ProjectState, Task } from "@shared/types";
import type { WorkflowNode } from "@shared/workflow";
import { STAGE_LABEL } from "@shared/task-stage";
import { GlassButton } from "../glass";
import { api, errorText } from "../lib/api";
import { mergeHistoryMessages } from "../lib/history";
import { chooseTask } from "../lib/submission-client";
import { routeHash } from "../lib/store";
import { Markdown, Time } from "./ui";
const executing = (node: WorkflowNode) => node.state === "running" || node.state === "starting";
export default function WorkflowDetail({ node, task, state, online, onClose, onFocus, onMember }: { node: WorkflowNode; task?: Task; state: ProjectState; online: boolean; onClose: () => void; onFocus?: (taskId: string) => void; onMember?: (memberId: string) => void }) {
  const projectId = state.project.id;
  const member = state.members.find((m) => m.id === node.memberId);
  const related = state.workflow?.edges.filter((edge) => edge.kind === "derived" && (edge.from === node.id || edge.to === node.id)) ?? [];
  const relationTasks = new Map<string, { task: Task; parent: boolean }>();
  for (const edge of related) {
    const other = state.workflow?.nodes.find((item) => item.id === (edge.from === node.id ? edge.to : edge.from));
    const otherTask = state.tasks?.find((item) => item.id === other?.taskId);
    if (otherTask) relationTasks.set(otherTask.id, { task: otherTask, parent: edge.to === node.id });
  }
  const toThread = () => { chooseTask(projectId, { id: node.taskId }); onClose(); };
  return (
    <div className="wf-detail">
      <p className="wf-detail__state"><b>{member?.name ?? (node.memberId ? "이전 직원" : "미배정")}</b><span>{online ? node.label : `마지막 확인: ${node.label}`}</span></p>
      {node.reason ? <p className="wf-detail__reason">{node.reason}</p> : null}
      {node.action && node.action.tab !== "thread" ? <a className="wf-action" href={routeHash({ projectId, tab: node.action.tab, sub: node.action.sub })} onClick={onClose}>{node.action.label}<span aria-hidden="true"> →</span></a> : null}
      <dl className="wf-detail__facts">
        {node.assignmentSource === "report" || node.assignmentSource === "board" ? <><dt>담당 근거</dt><dd>{node.assignmentSource === "report" ? "이 직원이 수행 보고를 남겼습니다" : "진행판에서 이 직원을 담당으로 지정했습니다"}</dd></> : null}
        {task?.progress ? <><dt>업무 단계</dt><dd>{STAGE_LABEL[task.progress.stage]}{task.progress.next ? <p>{task.progress.next}</p> : null}</dd></> : null}
        {node.lastActivity ? <><dt>{["text", "tool", "tool_result", "error", "turn_start", "turn_end", "system", "compact"].includes(node.lastActivity.kind) ? online && executing(node) ? "최근 실행" : "마지막 실행" : "마지막 보고"}</dt><dd>{node.lastActivity.title}<Time iso={node.lastActivity.at} /></dd></> : null}
        {node.observedAt ? <><dt>상태 확인</dt><dd><Time iso={node.observedAt} /></dd></> : null}
        {node.counts.queued || node.counts.held || node.counts.notices ? <><dt>전달</dt><dd>{[node.counts.queued ? `대기 ${node.counts.queued}` : "", node.counts.held ? `보류 ${node.counts.held}` : "", node.counts.notices ? `알림 ${node.counts.notices}` : ""].filter(Boolean).join(" · ")}</dd></> : null}
      </dl>
      {relationTasks.size ? <ul className="wf-relations">{[...relationTasks.values()].map(({ task: other, parent }) => <li key={other.id}>{parent ? "원래 업무" : "파생 업무"}<a href={routeHash({ projectId, tab: "thread" })} onClick={() => { chooseTask(projectId, other); onClose(); }}>{other.title}</a></li>)}</ul> : null}
      {onMember ? <section className="tt-participants" aria-label="참여 직원">{state.workflow?.nodes.filter(n => n.taskId === node.taskId).map(n => <button key={n.id} type="button" disabled={!n.memberId || !state.members.some(m => m.id === n.memberId)} onClick={() => n.memberId && onMember(n.memberId)}><span>{state.members.find(m => m.id === n.memberId)?.name ?? (n.memberId ? "이전 직원" : "미배정")}</span><span>{n.label}</span></button>)}</section> : null}
      {onFocus ? <GlassButton size="s" onClick={() => onFocus(node.taskId)}>연결만 보기</GlassButton> : null}
      <TaskEvidence key={`${projectId}/${node.taskId}`} projectId={projectId} taskId={node.taskId} messages={state.messages} />
      <a className="wf-action" href={routeHash({ projectId, tab: "thread" })} onClick={toThread}>업무 대화<span aria-hidden="true"> →</span></a>
    </div>
  );
}

/** Scope changes unmount this component: abort both initial/older reads and discard late responses. */
function TaskEvidence({ projectId, taskId, messages }: { projectId: string; taskId: string; messages: Message[] }) {
  const [items, setItems] = useState<Message[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasOlder, setHasOlder] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const load = async (before?: string | null) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true); setError(null);
    try {
      const page = await api.messagePage(projectId, { scope: { kind: "task", taskId }, limit: 50, ...(before ? { cursor: before } : {}) }, controller.signal);
      if (controller.signal.aborted) return;
      setItems((previous) => mergeHistoryMessages(previous, page.items.filter((message) => message.projectId === projectId && message.taskId === taskId)));
      setCursor(page.nextCursor); setHasOlder(page.hasOlder);
    } catch (e) { if (!controller.signal.aborted) setError(errorText(e)); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  };
  useEffect(() => { void load(); return () => request.current?.abort(); }, [projectId, taskId]);
  const evidence = mergeHistoryMessages(items, messages.filter((message) => message.projectId === projectId && message.taskId === taskId)).filter((message) => message.mine || ["지시", "직접", "진행", "완료", "막힘", "질문", "답변"].includes(message.kind));
  return (
    <section className="wf-evidence" aria-label="지시와 보고">
      <h3>지시·보고</h3>
      {hasOlder ? <GlassButton variant="ghost" size="s" disabled={busy} onClick={() => void load(cursor)}>이전 지시·보고</GlassButton> : null}
      {error ? <p className="wf-error" role="alert">{error}<button type="button" className="wf-action" onClick={() => void load(cursor)}>다시 불러오기</button></p> : null}
      {busy && !evidence.length ? <p className="wf-empty" role="status">불러오는 중</p> : null}
      {!busy && !error && !evidence.length ? <p className="wf-empty">등록된 지시·보고가 없습니다.</p> : null}
      {evidence.map((message) => <article className="wf-evidence__item" key={message.id}><header><b>{message.mine ? "대표 지시" : `${message.who} · ${message.kind}`}</b><Time iso={message.at} /></header>{message.title ? <h4>{message.title}</h4> : null}{message.body ? <Markdown text={message.body} /> : null}</article>)}
    </section>
  );
}
