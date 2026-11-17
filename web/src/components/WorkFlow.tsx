import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { Message, ProjectState, Task } from "@shared/types";
import { WORKFLOW_OBSERVATION_MAX_AGE_MS, type WorkflowEdge, type WorkflowNode } from "@shared/workflow";
import { STAGE_LABEL } from "@shared/task-stage";
import { Glass, GlassButton } from "../glass";
import { api, errorText } from "../lib/api";
import { mergeHistoryMessages } from "../lib/history";
import { chooseTask } from "../lib/submission-client";
import { routeHash, useStore } from "../lib/store";
import { Markdown, Modal, MQ_DESKTOP, Sheet, Time, useMediaQuery } from "./ui";
import "../styles/workflow.css";

const EMPTY_NODES: WorkflowNode[] = [];
const EMPTY_EDGES: WorkflowEdge[] = [];
const executing = (node: WorkflowNode) => node.state === "running" || node.state === "starting";
const pastAssignment = (node: WorkflowNode) => node.historical && !node.current && node.state === "review" && !node.counts.queued && !node.counts.held;

/** A task occurrence belongs to the server's assignee, never Task.memberId (its registrar). */
export default function WorkFlow({ state, selectedTaskId }: { state: ProjectState; selectedTaskId?: string | null }) {
  const connection = useStore((s) => s.connection);
  const online = connection === "online";
  const [selection, setSelection] = useState<{ projectId: string; nodeId: string } | null>(null);
  const [historyProject, setHistoryProject] = useState<string | null>(null);
  const allHistory = historyProject === state.project.id;
  const desktop = useMediaQuery(MQ_DESKTOP);
  const Overlay = desktop ? Modal : Sheet;
  const sourceNodes = state.workflow?.nodes ?? EMPTY_NODES;
  const [clock, setClock] = useState(Date.now);
  const now = Math.max(clock, Date.now());
  // A healthy WebSocket can keep pinging without a new execution observation. One timer expires
  // the earliest active observation even when no server event causes another render.
  useEffect(() => {
    let next = Infinity;
    for (const node of sourceNodes) {
      const expires = Date.parse(node.observedAt ?? "") + WORKFLOW_OBSERVATION_MAX_AGE_MS;
      if (executing(node) && expires > now) next = Math.min(next, expires);
    }
    if (!Number.isFinite(next)) return;
    const timer = setTimeout(() => setClock(Date.now()), next - now + 1);
    return () => clearTimeout(timer);
  }, [sourceNodes, now]);
  const nodes = useMemo(() => sourceNodes.map((node): WorkflowNode => {
    if (!executing(node) || now - Date.parse(node.observedAt ?? "") < WORKFLOW_OBSERVATION_MAX_AGE_MS) return node;
    return { ...node, state: "unknown", label: "실행 확인 필요", reason: "최근 실행 상태를 확인하지 못했습니다. 직원 화면에서 확인해 주세요.",
      action: node.memberId ? { label: "직원 확인", tab: "team", sub: node.memberId } : node.action };
  }), [sourceNodes, now]);
  const edges = state.workflow?.edges ?? EMPTY_EDGES;
  const tasks = useMemo(() => new Map((state.tasks ?? []).map((t) => [t.id, t])), [state.tasks]);
  const allRows = useMemo(() => {
    const map = new Map(state.members.map((member) => [member.id as string | null, { id: member.id as string | null, name: member.name, nodes: [] as WorkflowNode[] }]));
    for (const node of nodes) {
      if (!map.has(node.memberId)) map.set(node.memberId, { id: node.memberId, name: node.memberId ? "이전 직원" : "미배정", nodes: [] });
      map.get(node.memberId)!.nodes.push(node);
    }
    return [...map.values()].map((row) => ({ ...row, nodes: row.nodes.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)) }));
  }, [state.members, nodes]);
  const hasHiddenHistory = allRows.some((row) => row.nodes.filter((node) => node.state === "done").length > 3 || row.nodes.filter(pastAssignment).length > 3);
  const historyLabel = nodes.some((node) => node.historical) ? "이전 업무 모두" : "완료 모두";
  const rows = useMemo(() => allRows.map((row) => {
    if (allHistory) return row;
    const recent = new Set([...row.nodes.filter((node) => node.state === "done").slice(-3), ...row.nodes.filter(pastAssignment).slice(-3)].map((node) => node.id));
    return { ...row, nodes: row.nodes.filter((node) => node.state !== "done" && !pastAssignment(node) || recent.has(node.id) || node.taskId === selectedTaskId) };
  }), [allRows, allHistory, selectedTaskId]);
  const selected = selection?.projectId === state.project.id ? nodes.find((n) => n.id === selection.nodeId) ?? null : null;
  const task = selected ? tasks.get(selected.taskId) : undefined;
  const canvas = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef(new Map<string, HTMLButtonElement>());
  const [paths, setPaths] = useState<{ edge: WorkflowEdge; d: string }[]>([]);
  const marker = `wf-${useId().replace(/:/g, "")}`;

  // Measure real button bounds so fonts, zoom, responsive widths and long task names keep edges attached.
  useLayoutEffect(() => {
    const root = canvas.current;
    if (!root) return;
    let frame = 0;
    const measure = () => {
      const bounds = root.getBoundingClientRect();
      const next = edges.flatMap((edge) => {
        const from = nodeRefs.current.get(edge.from)?.getBoundingClientRect();
        const to = nodeRefs.current.get(edge.to)?.getBoundingClientRect();
        if (!from || !to) return [];
        const sameRow = Math.abs(from.top - to.top) < 2;
        let d: string;
        if (edge.kind === "sequence") {
          const x1 = from.right - bounds.left, y1 = (from.top + from.bottom) / 2 - bounds.top;
          const x2 = to.left - bounds.left, y2 = (to.top + to.bottom) / 2 - bounds.top;
          d = `M ${x1} ${y1} C ${x1 + 18} ${y1}, ${x2 - 18} ${y2}, ${x2} ${y2}`;
        } else {
          const down = to.top >= from.top;
          const x1 = (from.left + from.right) / 2 - bounds.left, x2 = (to.left + to.right) / 2 - bounds.left;
          const y1 = (down ? from.bottom : from.top) - bounds.top;
          const y2 = (sameRow || !down ? to.bottom : to.top) - bounds.top;
          const bend = sameRow ? Math.max(y1, y2) + 24 : (y1 + y2) / 2;
          d = `M ${x1} ${y1} C ${x1} ${bend}, ${x2} ${bend}, ${x2} ${y2}`;
        }
        return [{ edge, d }];
      });
      setPaths((before) => before.length === next.length && before.every((p, i) => p.edge.id === next[i].edge.id && p.d === next[i].d) ? before : next);
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    measure();
    const observer = new ResizeObserver(schedule);
    observer.observe(root);
    for (const node of nodeRefs.current.values()) observer.observe(node);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [edges, rows]);

  return (
    <Glass as="section" level="regular" tint className="wf" aria-label="업무 흐름">
      <header className="wf-head"><h2>업무 흐름</h2>{hasHiddenHistory ? <GlassButton variant="ghost" size="s" aria-pressed={allHistory} onClick={() => setHistoryProject(allHistory ? null : state.project.id)}>{historyLabel}</GlassButton> : null}</header>
      {!online ? <p className="wf-connection" role="status">{connection === "connecting" ? "연결 확인 중 · 마지막으로 받은 상태입니다." : "연결이 끊겨 마지막으로 받은 상태를 표시합니다."}</p> : null}
      {!state.workflow ? <p className="wf-empty">업무 흐름을 확인할 수 없습니다.</p> : !nodes.length ? <p className="wf-empty">등록된 업무가 없습니다.</p> : (
        <div className="wf-scroll" tabIndex={0} aria-label="직원별 업무 순서">
          <div className="wf-canvas" ref={canvas} style={{ "--wf-columns": Math.max(1, ...rows.map((row) => row.nodes.length)) } as CSSProperties}>
            <svg className="wf-edges" aria-hidden="true">
              <defs>
                <marker id={`${marker}-sequence`} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M 0 0 L 7 3.5 L 0 7" fill="none" stroke="var(--ink-3)" /></marker>
                <marker id={`${marker}-derived`} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M 0 0 L 7 3.5 L 0 7" fill="none" stroke="var(--link)" /></marker>
              </defs>
              {paths.map(({ edge, d }) => <path className="wf-edge" data-kind={edge.kind} key={edge.id} d={d} markerEnd={`url(#${marker}-${edge.kind})`} />)}
            </svg>
            {rows.map((row) => (
              <div className="wf-row" key={row.id ?? "unassigned"} data-member-id={row.id ?? "unassigned"}>
                <h3 className="wf-person">{row.name}</h3>
                <ol className="wf-sequence" aria-label={`${row.name}의 업무`}>
                  {row.nodes.map((node) => {
                    const task = tasks.get(node.taskId);
                    const active = online && executing(node);
                    return (
                      <li key={node.id}>
                        <button type="button" className="wf-node" ref={(el) => { if (el) nodeRefs.current.set(node.id, el); else nodeRefs.current.delete(node.id); }}
                          data-task-id={node.taskId} data-member-id={node.memberId ?? "unassigned"} data-state={node.state}
                          data-active={active ? "true" : undefined} data-current={node.current ? "true" : undefined} data-selected={node.taskId === selectedTaskId ? "true" : undefined}
                          onClick={() => setSelection({ projectId: state.project.id, nodeId: node.id })} aria-haspopup="dialog"
                          aria-label={`${task?.title ?? "업무"} · ${row.name} · ${!online && executing(node) ? `마지막 확인: ${node.label}` : node.label}${node.current ? " · 현재 위치" : ""}`}>
                          <span className="wf-node__status"><span>{!online && executing(node) ? `마지막 확인: ${node.label}` : node.label}</span>{node.current ? <span className="wf-node__current">현재</span> : null}</span>
                          <strong className="wf-node__title">{task?.title ?? "업무"}</strong>
                          {node.reason ? <span className="wf-node__reason">{node.reason}</span> : node.lastActivity ? <span className="wf-node__activity">{node.lastActivity.title}</span> : null}
                        </button>
                      </li>
                    );
                  })}
                </ol>
                {!row.nodes.length ? <p className="wf-row__empty">배정된 업무 없음</p> : null}
              </div>
            ))}
          </div>
        </div>
      )}
      <Overlay open={!!selected} onClose={() => setSelection(null)} title={task?.title ?? (selected ? "업무" : undefined)}>
        {selected ? <WorkflowDetail key={`${state.project.id}/${selected.id}`} node={selected} task={task} state={state} online={online} onClose={() => setSelection(null)} /> : null}
      </Overlay>
    </Glass>
  );
}

function WorkflowDetail({ node, task, state, online, onClose }: { node: WorkflowNode; task?: Task; state: ProjectState; online: boolean; onClose: () => void }) {
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
