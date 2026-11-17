import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ProjectState } from "@shared/types";
import { WORKFLOW_OBSERVATION_MAX_AGE_MS, type WorkflowEdge, type WorkflowNode } from "@shared/workflow";
import { Glass } from "../glass";
import { useStore } from "../lib/store";
import { Modal, MQ_DESKTOP, Sheet, useMediaQuery } from "./ui";
import WorkflowBoard from "./WorkflowBoard";
import WorkflowAssignment from "./WorkflowAssignment";
import WorkflowDetail from "./WorkflowDetail";
import TeamOverview from "./TeamOverview";
import type {TeamTaskTab} from "./TeamTaskList";
import "../styles/workflow.css";

const EMPTY_NODES: WorkflowNode[] = [];
const EMPTY_EDGES: WorkflowEdge[] = [];
const executing = (node: WorkflowNode) => node.state === "running" || node.state === "starting";

/** A task occurrence belongs to the server's assignee, never Task.memberId (its registrar). */
export default function WorkFlow({ state, selectedTaskId, overview = false, onMember, onNodeSelect, focusRequest, headerActions, onRecords }: { state: ProjectState; selectedTaskId?: string | null; overview?: boolean; onMember?: (id: string, tab?: TeamTaskTab, nodeId?: string | null) => void; onNodeSelect?: (node: WorkflowNode) => boolean; focusRequest?: {taskId: string; at: number; onReturn?: () => void} | null; headerActions?: ReactNode; onRecords?: () => void }) {
  const connection = useStore((s) => s.connection);
  const online = connection === "online";
  const [selection, setSelection] = useState<{ projectId: string; nodeId: string } | null>(null);
  const [assignment, setAssignment] = useState<{ projectId: string; taskId: string; memberId: string | null } | null>(null);
  const assignmentOrigin = useRef<HTMLElement | null>(null);
  const closeAssignment = () => { setAssignment(null); requestAnimationFrame(() => assignmentOrigin.current?.isConnected && assignmentOrigin.current.focus({ preventScroll: true })); };
  const desktop = useMediaQuery(MQ_DESKTOP);
  const Overlay = desktop ? Modal : Sheet;
  const nodes = useWorkflowNodes(state);
  const edges = state.workflow?.edges ?? EMPTY_EDGES;
  const tasks = useMemo(() => new Map((state.tasks ?? []).map((t) => [t.id, t])), [state.tasks]);
  const selected = selection?.projectId === state.project.id ? nodes.find(n => n.id === selection.nodeId) ?? null : null;
  const task = selected ? tasks.get(selected.taskId) : undefined;
  return (
    <Glass as="section" level="regular" tint className="wf" aria-label="업무 흐름">
      {!online ? <p className="wf-connection" role="status">{connection === "connecting" ? "연결 확인 중 · 마지막으로 받은 상태입니다." : "연결이 끊겨 마지막으로 받은 상태를 표시합니다."}</p> : null}
      {overview && onMember ? <TeamOverview key={state.project.id} state={state} nodes={nodes} edges={edges} online={online} onMember={onMember} focusRequest={focusRequest} headerActions={headerActions} onRecords={onRecords}
        onSelect={nodeId => { const node = nodes.find(n => n.id === nodeId); if (!node || !onNodeSelect?.(node)) setSelection({ projectId: state.project.id, nodeId }); }}
        onAssign={(taskId, memberId, origin) => { assignmentOrigin.current = origin; setAssignment({ projectId: state.project.id, taskId, memberId }); }} /> : !state.workflow ? <><header className="wf-head"><h2>업무 흐름</h2></header><p className="wf-empty">업무 흐름을 확인할 수 없습니다.</p></> : <WorkflowBoard key={state.project.id} state={state} nodes={nodes} edges={edges} online={online} selectedTaskId={selectedTaskId}
        onSelect={nodeId => setSelection({ projectId: state.project.id, nodeId })}
        onAssign={(taskId, memberId, origin) => { assignmentOrigin.current = origin; setAssignment({ projectId: state.project.id, taskId, memberId }); }} />}
      <Overlay open={!!selected} onClose={() => setSelection(null)} title={task?.title ?? (selected ? "업무" : undefined)}>
        {selected ? <WorkflowDetail key={`${state.project.id}/${selected.id}`} node={selected} task={task} state={state} online={online} onClose={() => setSelection(null)} /> : null}
      </Overlay>
      {assignment?.projectId === state.project.id ? <WorkflowAssignment key={`${assignment.projectId}/${assignment.taskId}`} state={state} taskId={assignment.taskId} initialMemberId={assignment.memberId} onClose={closeAssignment} /> : null}
    </Glass>
  );
}


export function useWorkflowNodes(state: ProjectState) {
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
  return nodes;
}
