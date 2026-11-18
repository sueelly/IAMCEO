import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ProjectState } from "@shared/types";
import type { WorkflowEdge, WorkflowNode } from "@shared/workflow";
import { WORKFLOW_FILTER_LABELS, workflowBucket, workflowCategory, workflowFocus, workflowSummary, workflowTaskCategories, type WorkflowFilter } from "@shared/workflow-view";
import { GlassButton } from "../glass";
import { useStore } from "../lib/store";
import { Time } from "./ui";

const FILTERS = Object.entries(WORKFLOW_FILTER_LABELS) as [WorkflowFilter, string][];
const COLUMNS = [["done", "최근 완료"], ["now", "지금"], ["next", "다음"]] as const;
const executing = (node: WorkflowNode) => node.state === "running" || node.state === "starting";
type Focus = { nodeId: string; depth: "direct" | "family" };
type Props = { state: ProjectState; nodes: WorkflowNode[]; edges: WorkflowEdge[]; online: boolean; selectedTaskId?: string | null; onSelect: (nodeId: string) => void; onAssign: (taskId: string, memberId: string | null, origin: HTMLElement | null) => void };

/** View state is scoped to one project by the parent's key. No layout operation changes the queue. */
export default function WorkflowBoard({ state, nodes, edges, online, selectedTaskId, onSelect, onAssign }: Props) {
  const canAssign = useStore(s => s.capabilities?.capabilities.workflowAssignment === true) && online;
  const [filter, setFilter] = useState<WorkflowFilter>("all"), [allDone, setAllDone] = useState(false);
  const [map, setMap] = useState(false), [focus, setFocus] = useState<Focus | null>(null);
  const [menu, setMenu] = useState<string | null>(null), [drag, setDrag] = useState<string | null>(null), [drop, setDrop] = useState<string | null>(null);
  const scroll = useRef<HTMLDivElement>(null), canvas = useRef<HTMLDivElement>(null), menuRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef(new Map<string, HTMLButtonElement>()), menuRefs = useRef(new Map<string, HTMLButtonElement>());
  const dragRef = useRef<string | null>(null);
  const beforeFocus = useRef<{ left: number; top: number; x: number; y: number; origin: HTMLElement | null } | null>(null);
  const [paths, setPaths] = useState<{ edge: WorkflowEdge; d: string }[]>([]);
  const marker = `wf-${useId().replace(/:/g, "")}`;
  const tasks = useMemo(() => new Map(state.tasks?.map(t => [t.id, t]) ?? []), [state.tasks]);
  const counts = useMemo(() => workflowSummary(nodes), [nodes]);
  const categories = useMemo(() => workflowTaskCategories(nodes), [nodes]);
  const focused = useMemo(() => focus ? workflowFocus({ nodes, edges }, focus.nodeId, focus.depth) : null, [nodes, edges, focus]);
  const matches = (node: WorkflowNode) => focused ? focused.has(node.id) : filter === "all" || categories.get(node.taskId) === filter && workflowCategory(node) === filter;
  const rows = useMemo(() => {
    const groups = new Map(state.members.map(m => [m.id, { id: m.id, name: m.name, nodes: [] as WorkflowNode[] }]));
    for (const node of nodes) {
      if (workflowBucket(node) === "unassigned") continue;
      const id = node.memberId ?? "no-assignee";
      if (!groups.has(id)) groups.set(id, { id, name: node.memberId ? "이전 직원" : "담당 기록 없음", nodes: [] });
      groups.get(id)!.nodes.push(node);
    }
    return [...groups.values()].map(row => ({ ...row, nodes: row.nodes.sort((a,b) => a.order - b.order || a.id.localeCompare(b.id)) }));
  }, [state.members, nodes]);
  const hasHiddenDone = rows.some(row => row.nodes.filter(n => n.state === "done").length > 3);
  const visibleRows = rows.map(row => {
    const done = row.nodes.filter(n => n.state === "done").sort((a,b) => {
      const at = Date.parse(tasks.get(a.taskId)?.progress?.since ?? a.assignedAt ?? "") || 0;
      const bt = Date.parse(tasks.get(b.taskId)?.progress?.since ?? b.assignedAt ?? "") || 0;
      return at - bt || a.order - b.order;
    });
    const recent = new Set(done.slice(-3).map(n => n.id));
    return { ...row, nodes: row.nodes.filter(n => matches(n) && (focused || allDone || n.state !== "done" || workflowCategory(n) === "action" || recent.has(n.id) || n.taskId === selectedTaskId)) };
  }).filter(row => !focused && filter === "all" || row.nodes.length);
  const unassigned = nodes.filter(n => workflowBucket(n) === "unassigned" && matches(n));
  const showEdges = map || !!focus;

  const concentrate = (node: WorkflowNode, origin: HTMLElement | null) => {
    if (!focus) beforeFocus.current = { left: scroll.current?.scrollLeft ?? 0, top: scroll.current?.scrollTop ?? 0, x: window.scrollX, y: window.scrollY, origin };
    setMenu(null); setFocus({ nodeId: node.id, depth: "direct" });
  };
  useLayoutEffect(() => {
    if (focus || !beforeFocus.current) return;
    const previous = beforeFocus.current; beforeFocus.current = null;
    scroll.current?.scrollTo(previous.left, previous.top);
    previous.origin?.focus({ preventScroll: true }); window.scrollTo(previous.x, previous.y);
  }, [focus]);
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const outside = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node) && !menuRefs.current.get(menu)?.contains(event.target as Node)) setMenu(null); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [menu]);

  // Edges attach to measured card bounds, including mobile stacking and wrapped titles.
  useLayoutEffect(() => {
    const root = canvas.current;
    if (!root || !showEdges) { setPaths(previous => previous.length ? [] : previous); return; }
    let frame = 0;
    const measure = () => {
      const bounds = root.getBoundingClientRect();
      const next = edges.flatMap(edge => {
        const from = nodeRefs.current.get(edge.from)?.getBoundingClientRect(), to = nodeRefs.current.get(edge.to)?.getBoundingClientRect();
        if (!from || !to) return [];
        const sameRow = Math.abs(from.top - to.top) < 2;
        let d: string;
        if (sameRow) {
          const x1 = from.right - bounds.left, x2 = to.left - bounds.left, y1 = (from.top + from.bottom) / 2 - bounds.top, y2 = (to.top + to.bottom) / 2 - bounds.top;
          const bend = edge.kind === "derived" ? 20 : 10;
          d = `M ${x1} ${y1} C ${x1 + 16} ${y1 + bend}, ${x2 - 16} ${y2 + bend}, ${x2} ${y2}`;
        } else {
          const down = to.top >= from.top, x1 = (from.left + from.right) / 2 - bounds.left, x2 = (to.left + to.right) / 2 - bounds.left;
          const y1 = (down ? from.bottom : from.top) - bounds.top, y2 = (down ? to.top : to.bottom) - bounds.top, bend = (y1 + y2) / 2;
          d = `M ${x1} ${y1} C ${x1} ${bend}, ${x2} ${bend}, ${x2} ${y2}`;
        }
        return [{ edge, d }];
      });
      setPaths(before => before.length === next.length && before.every((p,i) => p.edge.id === next[i].edge.id && p.d === next[i].d) ? before : next);
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    measure(); const observer = new ResizeObserver(schedule); observer.observe(root);
    for (const el of nodeRefs.current.values()) observer.observe(el);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [edges, nodes, showEdges, focus, filter, allDone, selectedTaskId]);

  const renderNode = (node: WorkflowNode) => {
    const task = tasks.get(node.taskId), title = task?.title ?? "업무", isUnassigned = workflowBucket(node) === "unassigned";
    const member = state.members.find(m => m.id === node.memberId)?.name ?? (node.memberId ? "이전 직원" : "미배정");
    const label = !online && executing(node) ? `마지막 확인: ${node.label}` : node.label;
    return <li className="wf-card" key={node.id}>
      <button type="button" className="wf-node" ref={el => { if (el) nodeRefs.current.set(node.id, el); else nodeRefs.current.delete(node.id); }}
        data-task-id={node.taskId} data-member-id={node.memberId ?? "unassigned"} data-state={node.state}
        data-active={online && executing(node) ? "true" : undefined} data-current={node.current ? "true" : undefined}
        data-selected={node.taskId === selectedTaskId || node.id === focus?.nodeId ? "true" : undefined}
        draggable={canAssign && isUnassigned}
        onDragStart={event => { if (!canAssign || !isUnassigned) { event.preventDefault(); return; } dragRef.current = node.id; setDrag(node.id); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", node.id); }}
        onDragEnd={() => { dragRef.current = null; setDrag(null); setDrop(null); }}
        onContextMenu={event => { event.preventDefault(); concentrate(node, event.currentTarget); }}
        onKeyDown={event => { if ((event.shiftKey && event.key === "F10") || event.key === "ContextMenu") { event.preventDefault(); concentrate(node, event.currentTarget); } }}
        onClick={() => onSelect(node.id)} aria-haspopup="dialog" aria-label={`${title} · ${member} · ${label}${node.current ? " · 현재 위치" : ""}`}>
        <span className="wf-node__status">{label}</span><strong className="wf-node__title">{title}</strong>
        {node.reason ? <span className="wf-node__reason">{node.reason}</span> : node.lastActivity ? <span className="wf-node__activity">{node.lastActivity.title}</span> : null}
        {node.state === "done" && task?.progress?.stage === "done" && task.progress.since ? <Time iso={task.progress.since} className="wf-node__completed" /> : null}
      </button>
      <button type="button" className="wf-more" aria-label={`${title} 메뉴`} aria-haspopup="menu" aria-expanded={menu === node.id} ref={el => { if (el) menuRefs.current.set(node.id, el); else menuRefs.current.delete(node.id); }} onClick={() => setMenu(menu === node.id ? null : node.id)}>⋯</button>
      {menu === node.id ? <div className="wf-menu" role="menu" ref={menuRef} onKeyDown={event => {
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
        if (event.key === "Escape") { event.preventDefault(); setMenu(null); menuRefs.current.get(node.id)?.focus(); }
        else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) { event.preventDefault(); const index = buttons.indexOf(document.activeElement as HTMLButtonElement); buttons[event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus(); }
        else if (event.key === "Tab") setMenu(null);
      }}>
        <button type="button" role="menuitem" onClick={() => concentrate(node, menuRefs.current.get(node.id) ?? null)}>연결된 업무만 보기</button>
        {isUnassigned ? <button type="button" role="menuitem" disabled={!canAssign} onClick={() => { setMenu(null); onAssign(node.taskId, null, menuRefs.current.get(node.id) ?? null); }}>배정</button> : null}
      </div> : null}
    </li>;
  };

  return <>
    <header className="wf-head"><h2>업무 흐름</h2><div className="wf-modes" aria-label="보기 방식">
      <GlassButton variant="ghost" size="s" ariaPressed={!map} onClick={() => setMap(false)}>직원별 흐름</GlassButton>
      <GlassButton variant="ghost" size="s" ariaPressed={map} onClick={() => setMap(true)}>연결 지도</GlassButton>
    </div></header>
    <nav className="wf-filters" aria-label="업무 상태">{FILTERS.map(([key,label]) => <GlassButton key={key} variant="ghost" size="s" ariaPressed={filter === key} disabled={!!focus} onClick={() => setFilter(key)}>{label}<span className="wf-count">{counts[key]}</span></GlassButton>)}
      {hasHiddenDone ? <GlassButton className="wf-history" variant="ghost" size="s" ariaPressed={allDone} onClick={() => setAllDone(!allDone)}>완료 모두</GlassButton> : null}
    </nav>
    {focus ? <div className="wf-focus" role="region" aria-label="연결된 업무"><strong>{tasks.get(nodes.find(n => n.id === focus.nodeId)?.taskId ?? "")?.title ?? "선택한 업무"}</strong><div>
      <GlassButton variant="ghost" size="s" ariaPressed={focus.depth === "direct"} onClick={() => setFocus({ ...focus, depth: "direct" })}>직접 연결</GlassButton>
      <GlassButton variant="ghost" size="s" ariaPressed={focus.depth === "family"} onClick={() => setFocus({ ...focus, depth: "family" })}>파생 업무 묶음</GlassButton>
      <GlassButton size="s" onClick={() => setFocus(null)}>전체 보기</GlassButton>
    </div></div> : null}
    <div className="wf-scroll" ref={scroll} tabIndex={0} aria-label="직원별 업무 순서">
      <div className="wf-canvas" ref={canvas} data-dragging={drag ? "true" : undefined}>
        {showEdges ? <svg className="wf-edges" aria-hidden="true"><defs>{(["sequence", "derived"] as const).map(kind => <marker key={kind} id={`${marker}-${kind}`} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M 0 0 L 7 3.5 L 0 7" fill="none" stroke={kind === "derived" ? "var(--link)" : "var(--ink-3)"} /></marker>)}</defs>{paths.map(({edge,d}) => <path className="wf-edge" data-kind={edge.kind} key={edge.id} d={d} markerEnd={`url(#${marker}-${edge.kind})`} />)}</svg> : null}
        <div className="wf-board-layout"><div className="wf-people">
          <div className="wf-columns" aria-hidden="true"><span>직원</span>{COLUMNS.map(([key,label]) => <span key={key}>{label}</span>)}</div>
          {visibleRows.map(row => <div className="wf-row" key={row.id} data-member-id={row.id}>
            <h3 className="wf-person">{row.name}</h3>
            {COLUMNS.map(([key,label]) => <div className="wf-column" key={key} data-column={key} data-drop-member={key === "next" && state.members.some(m => m.id === row.id) ? row.id : undefined} data-drop-active={drop === row.id && key === "next" ? "true" : undefined}
              onDragOver={event => { if (key === "next" && canAssign && dragRef.current && state.members.some(m => m.id === row.id)) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDrop(row.id); } }}
              onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDrop(null); }}
              onDrop={event => { const node = nodes.find(n => n.id === dragRef.current); event.preventDefault(); setDrop(null); setDrag(null); dragRef.current = null; if (key === "next" && canAssign && node && workflowBucket(node) === "unassigned" && state.members.some(m => m.id === row.id)) onAssign(node.taskId, row.id, nodeRefs.current.get(node.id) ?? null); }}>
              <h4 className="wf-column__label">{label}</h4><ol className="wf-sequence" aria-label={`${row.name} · ${label}`}>{row.nodes.filter(n => workflowBucket(n) === key).map(renderNode)}</ol>
              {!row.nodes.some(n => workflowBucket(n) === key) ? <span className="wf-row__empty">—</span> : null}
            </div>)}
          </div>)}
          {!visibleRows.length ? <p className="wf-empty">해당하는 직원 업무가 없습니다.</p> : null}
        </div>
        {unassigned.length || !focus && (filter === "all" || filter === "unassigned") ? <aside className="wf-unassigned" aria-label="미배정 업무"><h3>미배정 <span>{unassigned.length}</span></h3><ol className="wf-sequence">{unassigned.map(renderNode)}</ol>{!unassigned.length ? <p className="wf-empty">미배정 업무가 없습니다.</p> : null}</aside> : null}
        </div>
      </div>
    </div>
  </>;
}
