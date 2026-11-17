import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ProjectState } from "@shared/types";
import type { WorkflowEdge, WorkflowNode } from "@shared/workflow";
import {
  workflowBucket,
  workflowCategory,
  workflowSummary,
  workflowTaskCategories,
  type WorkflowFilter,
} from "@shared/workflow-view";
import { workflowTaskNodes } from "@shared/workflow-map";
import { memberIssueLabel, deliveryWaitText } from "@shared/execution-issues";
import { GlassButton } from "../glass";
import { useStore } from "../lib/store";
import {
  Drawer,
  Sheet,
  MQ_DESKTOP,
  Time,
  StatusDot,
  useMediaQuery,
} from "./ui";
import WorkflowMap from "./WorkflowMap";
import TeamTaskList, { type TeamTaskTab } from "./TeamTaskList";
import "../styles/team-overview.css";
const filters: [WorkflowFilter, string][] = [
  ["all", "전체"],
  ["action", "확인 필요"],
  ["running", "실행 중"],
  ["next", "다음"],
  ["done", "완료"],
  ["unassigned", "미배정"],
];
type Scope =
  | { kind: "tasks"; ids: string[]; title: string }
  | { kind: "members"; ids: string[]; title: string }
  | { kind: "relations"; edges: WorkflowEdge[] };
type Props = {
  state: ProjectState;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  online: boolean;
  onMember: (id: string, tab?: TeamTaskTab, nodeId?: string | null) => void;
  onSelect: (nodeId: string) => void;
  onAssign: (
    taskId: string,
    memberId: string | null,
    origin: HTMLElement | null,
  ) => void;
  focusRequest?: { taskId: string; at: number; onReturn?: () => void } | null;
  headerActions?: ReactNode;
  onRecords?: () => void;
};
export default function TeamOverview({
  state,
  nodes,
  edges,
  online,
  onMember,
  onSelect,
  onAssign,
  focusRequest,
  headerActions,
  onRecords,
}: Props) {
  const [mode, setMode] = useState<"compact" | "map">("compact"),
    [filter, setFilter] = useState<WorkflowFilter>("all"),
    [query, setQuery] = useState(""),
    [focus, setFocus] = useState<string | null>(null),
    [scope, setScope] = useState<Scope | null>(null),
    [expanded, setExpanded] = useState<string | null>(null),
    [unassignedOpen, setUnassignedOpen] = useState(false),
    [drop, setDrop] = useState<string | null>(null);
  const drag = useRef<string | null>(null),
    previous = useRef<{
      mode: "compact" | "map";
      origin: HTMLElement | null;
      x: number;
      y: number;
      onReturn?: () => void;
    } | null>(null),
    scopeOrigin = useRef<HTMLElement | null>(null);
  const canAssign =
    useStore((s) => s.capabilities?.capabilities.workflowAssignment === true) &&
    online;
  const tasks = useMemo(
      () => new Map(state.tasks?.map((t) => [t.id, t]) ?? []),
      [state.tasks],
    ),
    counts = useMemo(() => workflowSummary(nodes), [nodes]),
    categories = useMemo(() => workflowTaskCategories(nodes), [nodes]);
  const byNode = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const title = (n: WorkflowNode) => tasks.get(n.taskId)?.title ?? "업무",
    name = (id: string) =>
      state.members.find((m) => m.id === id)?.name ?? "이전 직원";
  const matches = (n: WorkflowNode) =>
    (filter === "all" || categories.get(n.taskId) === filter) &&
    (!query ||
      `${title(n)} ${n.memberId ? name(n.memberId) : "미배정"}`
        .toLowerCase()
        .includes(query.toLowerCase()));
  const visible = new Set(nodes.filter(matches).map((n) => n.taskId));
  const rows = [
    ...state.members.map((m) => ({ id: m.id, name: m.name, member: m })),
    ...[
      ...new Set(
        nodes.map((n) => n.memberId).filter((id): id is string => !!id),
      ),
    ]
      .filter((id) => !state.members.some((m) => m.id === id))
      .map((id) => ({ id, name: "이전 직원", member: null })),
  ]
    .map((m) => ({
      ...m,
      all: nodes
        .filter((n) => n.memberId === m.id)
        .sort((a, b) => a.order - b.order),
      nodes: nodes
        .filter((n) => n.memberId === m.id && matches(n))
        .sort((a, b) => a.order - b.order),
    }))
    .filter((m) => m.nodes.length || (filter === "all" && !query));
  const unowned = nodes.filter(
    (n) => !n.memberId && workflowBucket(n) !== "unassigned",
  );
  if (unowned.some(matches))
    rows.push({
      id: "no-assignee",
      name: "담당 기록 없음",
      member: null,
      all: unowned,
      nodes: unowned.filter(matches),
    });
  const free = nodes.filter((n) => workflowBucket(n) === "unassigned");
  const Overlay = useMediaQuery(MQ_DESKTOP) ? Drawer : Sheet;
  const closeScope = () => {
    setScope(null);
    requestAnimationFrame(
      () =>
        scopeOrigin.current?.isConnected &&
        scopeOrigin.current.focus({ preventScroll: true }),
    );
  };
  const showScope = (value: Scope) => {
    scopeOrigin.current = document.activeElement as HTMLElement;
    setExpanded(null);
    setScope(value);
  };
  const concentrate = (taskId: string, onReturn?: () => void) => {
    if (!focus || onReturn)
      previous.current = {
        mode,
        origin: document.activeElement as HTMLElement,
        x: window.scrollX,
        y: window.scrollY,
        onReturn,
      };
    setFocus(taskId);
    setMode("map");
    setScope(null);
  };
  const clearFocus = () => {
    setFocus(null);
    previous.current = null;
  };
  const restore = () => {
    setFocus(null);
    const p = previous.current;
    if (p) {
      setMode(p.mode);
      requestAnimationFrame(() => {
        p.origin?.isConnected && p.origin.focus({ preventScroll: true });
        window.scrollTo(p.x, p.y);
      });
      previous.current = null;
      p.onReturn?.();
    }
  };
  useEffect(() => {
    if (focusRequest) concentrate(focusRequest.taskId, focusRequest.onReturn);
  }, [focusRequest]);
  const openMember = (
    id: string,
    tab?: TeamTaskTab,
    nodeId?: string | null,
  ) => {
    closeScope();
    onMember(id, tab, nodeId);
  };
  const selectTask = (id: string) => {
    const n = workflowTaskNodes(nodes, [id])[0];
    if (n) {
      closeScope();
      onSelect(n.id);
    }
  };
  const summaryTask = (n: WorkflowNode, tab: TeamTaskTab, extra = 0) => (
    <button
      type="button"
      className="to-task"
      data-task-id={n.taskId}
      data-node-id={n.id}
      onClick={() =>
        n.memberId && state.members.some((m) => m.id === n.memberId)
          ? onMember(n.memberId, tab, n.id)
          : onSelect(n.id)
      }
      onContextMenu={(e) => {
        e.preventDefault();
        concentrate(n.taskId);
      }}
      onKeyDown={(e) => {
        if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
          e.preventDefault();
          concentrate(n.taskId);
        }
      }}
      title={title(n)}
    >
      <span className="to-state" data-state={n.state}>
        {online ? n.label : `마지막 확인: ${n.label}`}
        {extra > 0 ? (
          <b>
            {tab === "next" ? "다른 대기 " : "외 "}
            {extra}
          </b>
        ) : null}
      </span>
      <strong>{title(n)}</strong>
    </button>
  );
  return (
    <div className="to-overview">
      <header className="to-head">
        <h2>
          업무 흐름 <small>직원 {state.members.length}</small>
        </h2>
        <div className="to-modes">
          <GlassButton
            size="s"
            variant="ghost"
            ariaPressed={mode === "compact"}
            onClick={() => {
              setMode("compact");
              clearFocus();
            }}
          >
            한눈에
          </GlassButton>
          <GlassButton
            size="s"
            variant="ghost"
            ariaPressed={mode === "map"}
            onClick={() => setMode("map")}
          >
            전체 지도
          </GlassButton>
          {headerActions}
        </div>
      </header>
      <div className="to-toolbar">
        <nav className="to-filters" aria-label="업무 상태">
          {filters.map(([key, label]) => (
            <GlassButton
              key={key}
              size="s"
              variant="ghost"
              ariaPressed={
                key === "unassigned" ? unassignedOpen : !focus && filter === key
              }
              onClick={() => {
                if (key === "unassigned") {
                  setUnassignedOpen((v) => !v);
                  setMode("compact");
                } else {
                  setFilter(key);
                  clearFocus();
                }
              }}
            >
              {label}
              <span className="wf-count">{counts[key]}</span>
            </GlassButton>
          ))}
        </nav>
        <input
          className="to-search"
          aria-label="직원·업무 검색"
          placeholder="직원·업무 검색"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            clearFocus();
          }}
        />
      </div>
      {mode === "compact" ? (
        <>
          <div className="to-columns" aria-hidden="true">
            <span>직원</span>
            <span>지금</span>
            <span>다음·대기</span>
            <span>확인 필요</span>
            <span>최근 완료</span>
          </div>
          <div className="to-table">
            {rows.map((row) => {
              const now = row.nodes.filter((n) => workflowBucket(n) === "now"),
                next = row.nodes.filter((n) => workflowBucket(n) === "next"),
                checks = row.nodes.filter(
                  (n) => workflowCategory(n) === "action",
                ),
                blocked = checks.filter(
                  (n) => n.state === "blocked" || n.state === "unknown",
                ),
                reviews = checks.filter((n) => !blocked.includes(n)),
                done = row.nodes
                  .filter((n) => n.state === "done")
                  .sort(
                    (a, b) =>
                      (Date.parse(
                        tasks.get(b.taskId)?.progress?.since ?? b.assignedAt,
                      ) || 0) -
                      (Date.parse(
                        tasks.get(a.taskId)?.progress?.since ?? a.assignedAt,
                      ) || 0),
                  );
              const head =
                now.find(
                  (n) => n.state === "running" || n.state === "starting",
                ) ??
                workflowTaskNodes(
                  now,
                  now.map((n) => n.taskId),
                )[0];
              const issue = row.member ? memberIssueLabel(row.member) : null;
              return (
                <article
                  className="to-row"
                  key={row.id}
                  data-member-id={row.id}
                >
                  <button
                    type="button"
                    className="to-person"
                    onClick={() =>
                      row.member
                        ? onMember(row.id)
                        : showScope({
                            kind: "tasks",
                            ids: row.all.map((n) => n.taskId),
                            title: row.name + "의 업무",
                          })
                    }
                  >
                    <span>
                      {row.member ? (
                        <StatusDot
                          status={issue ? "error" : row.member.status}
                        />
                      ) : null}
                      <b>
                        {row.name === state.project.name + " 총괄"
                          ? "총괄"
                          : row.name}
                      </b>
                    </span>
                    <small>{issue ?? `업무 ${row.all.length}`}</small>
                  </button>
                  <div className="to-now">
                    {head ? (
                      summaryTask(
                        head,
                        "now",
                        now.filter((n) => n.label === head.label).length - 1,
                      )
                    ) : (
                      <span className="to-empty">현재 실행 없음</span>
                    )}
                  </div>
                  <div
                    className="to-next"
                    data-drop-member={row.member ? row.id : undefined}
                    data-drop-active={drop === row.id || undefined}
                    onDragOver={(e) => {
                      if (canAssign && drag.current && row.member) {
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                        setDrop(row.id);
                      }
                    }}
                    onDragLeave={() => setDrop(null)}
                    onDrop={(e) => {
                      e.preventDefault();
                      const n = nodes.find((n) => n.id === drag.current);
                      drag.current = null;
                      setDrop(null);
                      if (
                        canAssign &&
                        row.member &&
                        n &&
                        workflowBucket(n) === "unassigned"
                      )
                        onAssign(n.taskId, row.id, e.currentTarget);
                    }}
                  >
                    {next[0] ? (
                      summaryTask(next[0], "next", next.length - 1)
                    ) : (
                      <span className="to-empty">—</span>
                    )}
                  </div>
                  <div className="to-checks">
                    {blocked.length ? (
                      <button
                        type="button"
                        className="to-blocked"
                        onClick={() =>
                          row.member
                            ? onMember(row.id, "blocked")
                            : showScope({
                                kind: "tasks",
                                ids: blocked.map((n) => n.taskId),
                                title: "막힘",
                              })
                        }
                      >
                        막힘 <b>{blocked.length}</b>
                      </button>
                    ) : null}
                    {reviews.length ? (
                      <button
                        type="button"
                        onClick={() =>
                          row.member
                            ? onMember(row.id, "checks")
                            : showScope({
                                kind: "tasks",
                                ids: checks.map((n) => n.taskId),
                                title: "확인 필요",
                              })
                        }
                      >
                        확인 필요 <b>{reviews.length}</b>
                      </button>
                    ) : null}
                    {!checks.length ? (
                      <span className="to-empty">—</span>
                    ) : null}
                  </div>
                  <div className="to-done">
                    {done[0] ? (
                      <button
                        type="button"
                        className="to-task"
                        data-task-id={done[0].taskId}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          concentrate(done[0].taskId);
                        }}
                        onClick={() =>
                          row.member
                            ? onMember(row.id, "done", done[0].id)
                            : onSelect(done[0].id)
                        }
                      >
                        <span className="to-state">
                          <Time
                            iso={
                              tasks.get(done[0].taskId)?.progress?.since ??
                              done[0].assignedAt
                            }
                          />
                          {done.length > 1 ? <b>+{done.length - 1}</b> : null}
                        </span>
                        <strong>{title(done[0])}</strong>
                      </button>
                    ) : (
                      <span className="to-empty">—</span>
                    )}
                  </div>
                  {row.member ? (
                    <div className="to-mobile-counts">
                      <button
                        type="button"
                        onClick={() => onMember(row.id, "next")}
                      >
                        다음·대기 {next.length}
                      </button>
                      <button
                        type="button"
                        onClick={() => onMember(row.id, "checks")}
                      >
                        확인 필요 {checks.length}
                      </button>
                      <button
                        type="button"
                        onClick={() => onMember(row.id, "done")}
                      >
                        완료 {done.length}
                      </button>
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
          {!rows.length ? (
            <p className="wf-empty">해당하는 직원·업무가 없습니다.</p>
          ) : null}
        </>
      ) : (
        <>
          {focus ? (
            <div className="to-return">
              <GlassButton size="s" variant="ghost" onClick={restore}>
                {previous.current?.onReturn ? "← 직원 상세" : "← 이전 보기"}
              </GlassButton>
            </div>
          ) : null}
          <WorkflowMap
            data={{
              tasks: state.tasks ?? [],
              members: state.members,
              workflow: { nodes, edges },
            }}
            visible={visible}
            focusTask={focus}
            onFocus={(id) => (id ? concentrate(id) : clearFocus())}
            onMember={(id) =>
              state.members.some((m) => m.id === id) && onMember(id)
            }
            onTask={selectTask}
            onList={(ids, title) => showScope({ kind: "tasks", ids, title })}
            onMembers={(ids, title) =>
              showScope({ kind: "members", ids, title })
            }
            onRelations={(edges) => showScope({ kind: "relations", edges })}
            onRecords={() => onRecords?.()}
          />
        </>
      )}
      {unassignedOpen && mode === "compact" ? (
        <aside className="to-unassigned" aria-label="미배정 업무">
          <header>
            <h3>미배정 {free.length}</h3>
            <GlassButton
              size="s"
              variant="ghost"
              ariaLabel="미배정 닫기"
              onClick={() => setUnassignedOpen(false)}
            >
              ×
            </GlassButton>
          </header>
          <div>
            {free.map((n) => (
              <article key={n.id}>
                <button
                  type="button"
                  className="to-free"
                  data-task-id={n.taskId}
                  draggable={canAssign}
                  onDragStart={(e) => {
                    drag.current = n.id;
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", n.id);
                  }}
                  onDragEnd={() => {
                    drag.current = null;
                    setDrop(null);
                  }}
                  onClick={() => onSelect(n.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    concentrate(n.taskId);
                  }}
                >
                  {title(n)}
                </button>
                <GlassButton
                  size="s"
                  variant="ghost"
                  disabled={!canAssign}
                  ariaLabel={`${title(n)} 배정`}
                  onClick={() =>
                    onAssign(
                      n.taskId,
                      null,
                      document.activeElement as HTMLElement,
                    )
                  }
                >
                  배정
                </GlassButton>
              </article>
            ))}
          </div>
          {!free.length ? (
            <p className="wf-empty">미배정 업무가 없습니다.</p>
          ) : null}
        </aside>
      ) : null}
      <Overlay
        open={!!scope}
        title={scope?.kind === "relations" ? "직원별 선후관계" : scope?.title}
        onClose={closeScope}
      >
        {scope?.kind === "tasks" ? (
          <>
            <p className="tt-scope">
              업무{" "}
              {
                new Set(
                  scope.ids.filter((id) => nodes.some((n) => n.taskId === id)),
                ).size
              }
              개
            </p>
            <TeamTaskList
              state={{ ...state, workflow: { nodes, edges } }}
              nodes={workflowTaskNodes(nodes, scope.ids)}
              online={online}
              expanded={expanded}
              onExpand={setExpanded}
              onFocus={concentrate}
              onMember={openMember}
              onClose={closeScope}
            />
          </>
        ) : null}
        {scope?.kind === "members" ? (
          <div className="map-member-list">
            {scope.ids.map((id) => (
              <button
                type="button"
                key={id}
                disabled={!state.members.some((m) => m.id === id)}
                onClick={() => openMember(id)}
              >
                <b>{name(id)}</b>
                <span>{state.members.find((m) => m.id === id)?.role}</span>
              </button>
            ))}
          </div>
        ) : null}
        {scope?.kind === "relations" ? (
          <div className="map-relations">
            {scope.edges.map((e) => {
              const a = byNode.get(e.from),
                b = byNode.get(e.to);
              if (!a || !b) return null;
              return (
                <article key={e.id}>
                  <button
                    type="button"
                    disabled={!state.members.some((m) => m.id === a.memberId)}
                    onClick={() => a.memberId && openMember(a.memberId)}
                  >
                    {a.memberId ? name(a.memberId) : "미배정"}
                  </button>
                  <button type="button" onClick={() => selectTask(a.taskId)}>
                    {title(a)}
                  </button>
                  <span>↓</span>
                  <button type="button" onClick={() => selectTask(b.taskId)}>
                    {title(b)}
                  </button>
                  <GlassButton
                    size="s"
                    variant="ghost"
                    onClick={() => concentrate(a.taskId)}
                  >
                    연결 보기
                  </GlassButton>
                </article>
              );
            })}
          </div>
        ) : null}
      </Overlay>
    </div>
  );
}
