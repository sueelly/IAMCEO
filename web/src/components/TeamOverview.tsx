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
import {
  workflowTaskNodes,
  workflowMap,
  resolveWorkflowMapScope,
  type WorkflowMapScope,
  type ResolvedMapScope,
} from "@shared/workflow-map";
import { memberIssueLabel, deliveryWaitText } from "@shared/execution-issues";
import { Glass, GlassButton } from "../glass";
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
import TeamTaskList, { teamTaskScope, type TeamTaskTab } from "./TeamTaskList";
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
  | WorkflowMapScope
  | { kind: "staff"; memberId: string; tab: TeamTaskTab; title: string };
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
    [unassignedDismissed, setUnassignedDismissed] = useState(false),
    [drop, setDrop] = useState<string | null>(null);
  const drag = useRef<string | null>(null),
    previous = useRef<{
      mode: "compact" | "map";
      origin: HTMLElement | null;
      selector: string | null;
      x: number;
      y: number;
      scope: Scope | null;
      expanded: string | null;
      dialogScroll: number;
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
  const matchesQuery = (n: WorkflowNode) =>
    !query ||
    `${title(n)} ${n.memberId ? name(n.memberId) : "미배정"}`
      .toLowerCase()
      .includes(query.toLowerCase());
  const matches = (n: WorkflowNode) =>
    (filter === "all" || categories.get(n.taskId) === filter) &&
    matchesQuery(n);
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
      nodes: nodes
        .filter((n) => n.memberId === m.id && matches(n))
        .sort((a, b) => a.order - b.order),
    }))
    .filter(
      (m) =>
        m.nodes.length ||
        (filter === "all" &&
          (!query || m.name.toLowerCase().includes(query.toLowerCase()))),
    );
  const unowned = nodes.filter(
    (n) => !n.memberId && workflowBucket(n) !== "unassigned",
  );
  if (unowned.some(matches))
    rows.push({
      id: "no-assignee",
      name: "담당 기록 없음",
      member: null,
      nodes: unowned.filter(matches),
    });
  const free = nodes.filter((n) => workflowBucket(n) === "unassigned");
  const matchingFree = free.filter(matchesQuery);
  const unassignedShown =
    unassignedOpen ||
    (!!query && matchingFree.length > 0 && !unassignedDismissed);
  const closeUnassigned = () => {
    setUnassignedOpen(false);
    setUnassignedDismissed(true);
  };
  const scopeView: ResolvedMapScope | null = !scope
    ? null
    : scope.kind === "staff"
      ? {
          kind: "tasks",
          title: scope.title,
          ids: teamTaskScope(
            nodes.filter((n) =>
              scope.memberId === "no-assignee"
                ? !n.memberId && workflowBucket(n) !== "unassigned"
                : n.memberId === scope.memberId,
            ),
            scope.tab,
          ).map((n) => n.taskId),
        }
      : resolveWorkflowMapScope(
          workflowMap(state.tasks ?? [], { nodes, edges }),
          { nodes, edges },
          scope,
          visible,
        );
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
  const concentrate = (
    taskId: string,
    onReturn?: () => void,
    origin = document.activeElement as HTMLElement,
  ) => {
    if (!focus || onReturn) {
      const shell = document.querySelector(".shell__body");
      const nodeId =
        origin?.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId;
      const groupId =
        origin?.closest<HTMLElement>("[data-group-id]")?.dataset.groupId;
      const originTaskId =
        origin?.closest<HTMLElement>("[data-task-id]")?.dataset.taskId;
      previous.current = {
        mode,
        origin,
        selector: nodeId
          ? `[data-node-id="${CSS.escape(nodeId)}"]`
          : groupId
            ? `[data-group-id="${CSS.escape(groupId)}"] .map-group-title`
            : originTaskId
              ? `[data-task-id="${CSS.escape(originTaskId)}"] .tt-title`
              : null,
        x: shell?.scrollLeft ?? 0,
        y: shell?.scrollTop ?? 0,
        scope,
        expanded,
        dialogScroll:
          origin?.closest("dialog")?.querySelector(".dialog__body")
            ?.scrollTop ?? 0,
        onReturn,
      };
    }
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
      setScope(p.scope);
      setExpanded(p.expanded);
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const root = p.scope
            ? document.querySelector("dialog[open]")
            : document.querySelector(".to-overview");
          const origin = p.origin?.isConnected
            ? p.origin
            : p.selector
              ? root?.querySelector<HTMLElement>(p.selector)
              : null;
          origin?.focus({ preventScroll: true });
          document.querySelector(".shell__body")?.scrollTo(p.x, p.y);
          if (p.scope)
            root?.querySelector(".dialog__body")?.scrollTo(0, p.dialogScroll);
        }),
      );
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
        concentrate(n.taskId, undefined, e.currentTarget);
      }}
      onKeyDown={(e) => {
        if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
          e.preventDefault();
          concentrate(n.taskId);
        }
      }}
      title={title(n)}
    >
      <strong>{title(n)}</strong>
      <span className="to-state" data-state={n.state}>
        <span className="to-state-label" title={n.label}>
          {n.label}
        </span>
        {extra > 0 ? (
          <b>
            {tab === "next" ? "다른 대기 " : "외 "}
            {extra}
          </b>
        ) : null}
      </span>
    </button>
  );
  return (
    <div className="to-overview">
      <header className="to-head">
        <h2>
          업무 흐름 <small>{state.members.length}명</small>
        </h2>
        <div className="to-head-actions">
          <Glass className="team-segments to-modes" level="regular">
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
          </Glass>
          {headerActions}
        </div>
      </header>
      <div className="to-toolbar">
        <nav className="to-filters team-options" aria-label="업무 상태">
          {filters.map(([key, label]) => (
            <GlassButton
              key={key}
              className={key === "action" && counts.action > 0 ? "to-attention-filter" : undefined}
              size="s"
              variant="ghost"
              ariaPressed={
                key === "unassigned"
                  ? unassignedShown
                  : !focus && filter === key
              }
              onClick={() => {
                if (key === "unassigned") {
                  if (unassignedShown) closeUnassigned();
                  else setUnassignedOpen(true);
                  setMode("compact");
                } else {
                  setFilter(key);
                  clearFocus();
                }
              }}
            >
              {label}
              {state.workflow ? (
                <span className="wf-count">{counts[key]}</span>
              ) : null}
            </GlassButton>
          ))}
        </nav>
        <div className="to-search-field">
          <input
            className="input to-search"
            type="search"
            aria-label="직원·업무 검색"
            placeholder="직원·업무 검색"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setUnassignedDismissed(false);
              clearFocus();
            }}
          />
        </div>
      </div>
      {!state.workflow ? (
        <p className="wf-empty" role="status">
          업무 흐름을 확인할 수 없습니다.
        </p>
      ) : null}
      {unassignedShown && mode === "compact" ? (
        <aside className="to-unassigned" aria-label="미배정 업무">
          <header>
            <h3>미배정 {matchingFree.length}</h3>
            <GlassButton
              size="s"
              variant="ghost"
              ariaLabel="미배정 닫기"
              onClick={closeUnassigned}
            >
              ×
            </GlassButton>
          </header>
          <div>
            {matchingFree.map((n) => (
              <article key={n.id}>
                <button
                  type="button"
                  className="to-free"
                  data-task-id={n.taskId}
                  data-node-id={n.id}
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
                    concentrate(n.taskId, undefined, e.currentTarget);
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
          {!matchingFree.length ? (
            <p className="wf-empty">미배정 업무가 없습니다.</p>
          ) : null}
        </aside>
      ) : null}
      {mode === "compact" ? (
        <div className="to-table" data-filter={filter} data-search={!!query || undefined}>
          <div className="to-columns" aria-hidden="true">
            <span>직원</span>
            <span>현재 업무</span>
            <span>다음·대기</span>
            <span>확인 필요</span>
            <span>최근 완료</span>
          </div>
          <div>
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
              const displayName = row.name === state.project.name + " 총괄" ? "총괄" : row.name;
              const lead = !!row.member && row.member.kind !== "worker";
              const role = row.member?.role || (lead ? "총괄" : "");
              const subtitle = issue || (role !== displayName ? role : "");
              return (
                <article
                  className="to-row"
                  key={row.id}
                  data-member-id={row.id}
                  data-former={!row.member || undefined}
                >
                  <button
                    type="button"
                    className="to-person"
                    onClick={() =>
                      row.member
                        ? onMember(row.id)
                        : showScope({
                            kind: "staff",
                            memberId: row.id,
                            tab: "all",
                            title: row.name + "의 업무",
                          })
                    }
                  >
                    <span className="to-avatar" data-lead={lead || undefined}>
                      <span aria-hidden="true">{row.member ? Array.from(displayName.trim())[0]?.toUpperCase() : "–"}</span>
                      {row.member ? (
                        <StatusDot
                          status={issue ? "error" : row.member.status}
                        />
                      ) : null}
                    </span>
                    <span className="to-person-text">
                      <b title={displayName}>{displayName}</b>
                      {subtitle ? <small title={subtitle} data-issue={!!issue || undefined}>{subtitle}</small> : null}
                    </span>
                  </button>
                  <div className="to-now" data-has-task={!!head || undefined}>
                    {head ? (
                      summaryTask(
                        head,
                        "now",
                        now.filter((n) => n.label === head.label).length - 1,
                      )
                    ) : null}
                  </div>
                  <div
                    className="to-next"
                    data-has-task={!!next[0] || undefined}
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
                    ) : null}
                  </div>
                  <div className="to-checks" data-has-checks={!!checks.length || undefined}>
                    {blocked.length ? (
                      <button
                        type="button"
                        className="to-blocked"
                        onClick={() =>
                          row.member
                            ? onMember(row.id, "blocked")
                            : showScope({
                                kind: "staff",
                                memberId: row.id,
                                tab: "blocked",
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
                            ? onMember(row.id, "reviews")
                            : showScope({
                                kind: "staff",
                                memberId: row.id,
                                tab: "reviews",
                                title: "확인 필요",
                              })
                        }
                      >
                        확인 필요 <b>{reviews.length}</b>
                      </button>
                    ) : null}
                  </div>
                  <div className="to-done" data-has-task={!!done[0] || undefined}>
                    {done[0] ? (
                      <button
                        type="button"
                        className="to-task"
                        data-task-id={done[0].taskId}
                        data-node-id={done[0].id}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          concentrate(
                            done[0].taskId,
                            undefined,
                            e.currentTarget,
                          );
                        }}
                        onClick={() =>
                          row.member
                            ? onMember(row.id, "done", done[0].id)
                            : onSelect(done[0].id)
                        }
                      >
                        <strong>{title(done[0])}</strong>
                        <span className="to-state" data-state="done">
                          <Time
                            iso={
                              tasks.get(done[0].taskId)?.progress?.since ??
                              done[0].assignedAt
                            }
                          />
                          {done.length > 1 ? <b>+{done.length - 1}</b> : null}
                        </span>
                      </button>
                    ) : null}
                  </div>
                  {row.member && (next.length > 0 || checks.length > 0 || done.length > 0) ? (
                    <div className="to-mobile-counts">
                      {next.length > 0 ? <button
                        type="button"
                        onClick={() => onMember(row.id, "next")}
                      >
                        다음·대기 {next.length}
                      </button> : null}
                      {checks.length > 0 ? <button
                        type="button"
                        data-tone={blocked.length > 0 ? "blocked" : "review"}
                        onClick={() => onMember(row.id, "checks")}
                      >
                        확인 필요 {checks.length}
                      </button> : null}
                      {done.length > 0 ? <button
                        type="button"
                        onClick={() => onMember(row.id, "done")}
                      >
                        완료 {done.length}
                      </button> : null}
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
          {!rows.length && !(query && matchingFree.length) ? (
            <p className="wf-empty">해당하는 직원·업무가 없습니다.</p>
          ) : null}
        </div>
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
            onScope={showScope}
            onRecords={() => onRecords?.()}
          />
        </>
      )}
      <Overlay open={!!scope} title={scopeView?.title} onClose={closeScope}>
        {scopeView?.kind === "tasks" ? (
          <>
            <p className="tt-scope">
              업무{" "}
              {
                new Set(
                  scopeView.ids.filter((id) =>
                    nodes.some((n) => n.taskId === id),
                  ),
                ).size
              }
              개
            </p>
            <TeamTaskList
              state={{ ...state, workflow: { nodes, edges } }}
              nodes={workflowTaskNodes(nodes, scopeView.ids)}
              online={online}
              expanded={expanded}
              onExpand={setExpanded}
              onFocus={(id, origin) => concentrate(id, undefined, origin)}
              onMember={openMember}
              onClose={closeScope}
            />
          </>
        ) : null}
        {scopeView?.kind === "members" ? (
          <div className="map-member-list">
            {scopeView.ids.map((id) => (
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
        {scopeView?.kind === "relations" ? (
          <div className="map-relations">
            {!scopeView.edges.length ? (
              <p className="wf-empty" role="status">
                현재 범위에 선후관계가 없습니다.
              </p>
            ) : null}
            {scopeView.edges.map((e) => {
              const a = byNode.get(e.from),
                b = byNode.get(e.to);
              if (!a || !b) return null;
              return (
                <article key={e.id} data-edge-id={e.id}>
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
