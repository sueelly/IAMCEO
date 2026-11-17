import {
  useEffect,
  useLayoutEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Member, Task } from "@shared/types";
import type { ProjectWorkflow, WorkflowNode } from "@shared/workflow";
import { GlassButton } from "../glass";
import {
  workflowMap,
  workflowTaskNodes,
  type WorkflowMapScope,
} from "@shared/workflow-map";
import { workflowSummary } from "@shared/workflow-view";
type Data = {
  tasks: Task[];
  workflow: ProjectWorkflow;
  members: Pick<Member, "id" | "name" | "kind">[];
};
type Props = {
  data: Data;
  visible: Set<string>;
  focusTask: string | null;
  onFocus: (id: string | null) => void;
  onMember: (id: string) => void;
  onTask: (id: string) => void;
  onScope: (scope: WorkflowMapScope) => void;
  onRecords: () => void;
};
export default function WorkflowMap({
  data,
  visible,
  focusTask,
  onFocus,
  onMember,
  onTask,
  onScope,
  onRecords,
}: Props) {
  const model = useMemo(
      () => workflowMap(data.tasks, data.workflow),
      [data.tasks, data.workflow],
    ),
    view = useRef<HTMLDivElement>(null);
  const marker = useId().replace(/:/g, ""),
    worldHeight = focusTask
      ? 520
      : Math.max(520, Math.ceil(model.groups.length / 3) * 235 + 54);
  const [zoom, setZoom] = useState(1),
    [fit, setFit] = useState(1),
    [offset, setOffset] = useState({ x: 0, y: 0 }),
    [member, setMember] = useState<string | null>(null);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(
    null,
  );
  const overviewCamera = useRef<{
    zoom: number;
    offset: { x: number; y: number };
  } | null>(null);
  useEffect(() => {
    const el = view.current;
    if (!el) return;
    const sync = () =>
      setFit(Math.min(el.clientWidth / 1120, el.clientHeight / worldHeight));
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    sync();
    return () => ro.disconnect();
  }, [worldHeight, focusTask]);
  useLayoutEffect(() => {
    if (focusTask) {
      overviewCamera.current ??= { zoom, offset };
      setZoom(1);
      setOffset({ x: 0, y: 0 });
    } else if (overviewCamera.current) {
      setZoom(overviewCamera.current.zoom);
      setOffset(overviewCamera.current.offset);
      overviewCamera.current = null;
    }
  }, [focusTask]);
  const name = (id: string) =>
    data.members
      .find((m) => m.id === id)
      ?.name.replace("God of the world ", "") ?? "이전 직원";
  const title = (id: string) => model.taskMap.get(id)?.title ?? "업무";
  const rank = (n: WorkflowNode) =>
    ({
      blocked: 0,
      unknown: 1,
      running: 2,
      starting: 2,
      review: 3,
      queued: 4,
      waiting: 4,
      done: 5,
    })[n.state];
  const info = (id: string) =>
    workflowTaskNodes(model.occurrences.get(id) ?? [], [id])[0];
  const positions = new Map(
    model.groups.map((g, i) => [
      g.id,
      { x: 30 + (i % 3) * 370, y: 70 + Math.floor(i / 3) * 235 },
    ]),
  );
  const activeGroups = model.groups
    .map((g) => {
      const shown = g.taskIds.filter((id) => visible.has(id)),
        ns = shown.flatMap((id) => model.occurrences.get(id) ?? []);
      return {
        ...g,
        shown,
        counts: workflowSummary(ns),
        blocked: new Set(
          ns
            .filter((n) => ["blocked", "unknown"].includes(n.state))
            .map((n) => n.taskId),
        ).size,
        members: [
          ...new Set(ns.map((n) => n.memberId).filter(Boolean)),
        ] as string[],
      };
    })
    .filter((g) => g.shown.length);
  const activeLinks = model.links
    .map((l) => ({
      ...l,
      edges: l.edges.filter(
        (e) =>
          visible.has(model.byNode.get(e.from)!.taskId) &&
          visible.has(model.byNode.get(e.to)!.taskId),
      ),
    }))
    .filter((l) => l.edges.length);
  const linkGeometry = (l: (typeof model.links)[number]) => {
    const a = positions.get(l.from)!,
      b = positions.get(l.to)!;
    if (a.y === b.y)
      return {
        path: `M${a.x + 155},${a.y} C${a.x + 155},${a.y - 60} ${b.x + 155},${b.y - 60} ${b.x + 155},${b.y}`,
        x: (a.x + b.x) / 2 + 112,
        y: a.y - 44,
      };
    const top = a.y < b.y ? a : b,
      bottom = a.y < b.y ? b : a,
      middle = (top.y + 204 + bottom.y) / 2;
    return {
      path: `M${top.x + 155},${top.y + 204} V${middle} H${bottom.x + 155} V${bottom.y}`,
      x: (top.x + bottom.x) / 2 + 112,
      y: middle - 12,
    };
  };
  // Labels sharing a hit area open one live scope containing all of their real pairs.
  // Keep one original anchor, so clustering cannot push labels out of the map.
  let linkLabels: {
    links: typeof activeLinks;
    points: { x: number; y: number }[];
  }[] = [];
  for (const link of activeLinks) {
    const p = linkGeometry(link);
    const colliding = linkLabels.filter((label) =>
      label.points.some(
        (q) => Math.abs(p.x - q.x) < 128 && Math.abs(p.y - q.y) < 28,
      ),
    );
    linkLabels = linkLabels.filter((label) => !colliding.includes(label));
    linkLabels.push({
      links: [...colliding.flatMap((label) => label.links), link],
      points: [...colliding.flatMap((label) => label.points), p],
    });
  }
  const selectedNodes = new Set(
    (model.occurrences.get(focusTask ?? "") ?? []).map((n) => n.id),
  );
  const relationEdges = focusTask
    ? data.workflow.edges.filter(
        (e) =>
          (selectedNodes.has(e.from) || selectedNodes.has(e.to)) &&
          model.byNode.has(e.from) &&
          model.byNode.has(e.to),
      )
    : [];
  const leftIds = [
    ...new Set(
      relationEdges
        .filter((e) => selectedNodes.has(e.to))
        .map((e) => model.byNode.get(e.from)!.taskId),
    ),
  ].filter((id) => id !== focusTask);
  const rightIds = [
    ...new Set(
      relationEdges
        .filter((e) => selectedNodes.has(e.from))
        .map((e) => model.byNode.get(e.to)!.taskId),
    ),
  ].filter((id) => id !== focusTask);
  const attention = (ids: string[]) =>
    [...ids].sort(
      (a, b) =>
        rank(info(a)) - rank(info(b)) || title(a).localeCompare(title(b)),
    );
  const left = attention(leftIds.filter((id) => !rightIds.includes(id))).slice(
      0,
      4,
    ),
    right = attention(rightIds).slice(0, 4);
  const focusPos = new Map<string, { x: number; y: number }>(
    focusTask
      ? [
          [focusTask, { x: 403, y: 180 }],
          ...left.map((id, i) => [id, { x: 24, y: 55 + i * 102 }] as const),
          ...right.map((id, i) => [id, { x: 782, y: 55 + i * 102 }] as const),
        ]
      : [],
  );
  const focusEdges = [
    ...new Map(
      relationEdges.map((e) => {
        const a = model.byNode.get(e.from)!.taskId,
          b = model.byNode.get(e.to)!.taskId;
        return [`${a}:${b}:${e.kind}`, { ...e, a, b }];
      }),
    ).values(),
  ].filter((e) => focusPos.has(e.a) && focusPos.has(e.b) && e.a !== e.b);
  const participantChips = (
    ids: string[],
    max: number,
    scope: Extract<WorkflowMapScope, { kind: "members" }>,
  ) => (
    <div className="map-owners">
      {ids.slice(0, max).map((id) => (
        <button
          key={id}
          title={data.members.find((m) => m.id === id)?.name}
          disabled={!data.members.some((m) => m.id === id)}
          onClick={() => onMember(id)}
        >
          {name(id)}
        </button>
      ))}
      {ids.length > max && (
        <button className="more-members" onClick={() => onScope(scope)}>
          외 {ids.length - max}
        </button>
      )}
    </div>
  );
  const focusCard = (id: string, center = false) => {
    const p = focusPos.get(id)!,
      n = info(id),
      members = [
        ...new Set(
          (model.occurrences.get(id) ?? [])
            .map((n) => n.memberId)
            .filter(Boolean),
        ),
      ] as string[];
    return (
      <article
        className="map-task"
        data-center={center || undefined}
        data-task-id={id}
        key={id}
        style={{ left: p.x, top: p.y }}
      >
        <button
          onClick={() => onTask(id)}
          onContextMenu={(e) => {
            e.preventDefault();
            onFocus(id);
          }}
        >
          <span className="to-state" data-state={n.state}>
            {n.label}
          </span>
          <strong>{title(id)}</strong>
        </button>
        {center &&
          participantChips(members, 3, {
            kind: "members",
            source: "task",
            taskId: id,
          })}
        {!center && (
          <button
            className="map-focus-action"
            aria-label={`${title(id)} 연결 보기`}
            onClick={() => onFocus(id)}
          >
            연결 →
          </button>
        )}
      </article>
    );
  };
  if (focusTask && !model.occurrences.has(focusTask))
    return (
      <section className="map-explorer">
        <p className="wf-empty" role="status">
          선택한 업무의 흐름이 변경되었습니다.
        </p>
        <GlassButton size="s" onClick={() => onFocus(null)}>
          전체 지도
        </GlassButton>
      </section>
    );
  return (
    <section className="map-explorer" aria-label="전체 업무 지도">
      <div className="map-tools">
        <div className="map-breadcrumb">
          <button onClick={() => onFocus(null)}>전체 지도</button>
          {focusTask && (
            <>
              <span>›</span>
              <b>{title(focusTask)}</b>
            </>
          )}
        </div>
        <div className="map-zoom">
          <GlassButton
            size="s"
            variant="ghost"
            ariaLabel="지도 축소"
            onClick={() => setZoom((z) => Math.max(0.65, z - 0.2))}
          >
            −
          </GlassButton>
          <span>{Math.round(zoom * 100)}%</span>
          <GlassButton
            size="s"
            variant="ghost"
            ariaLabel="지도 확대"
            onClick={() =>
              setZoom((z) =>
                Math.min(Math.max(2.2, 1 / Math.max(0.01, fit)), z + 0.2),
              )
            }
          >
            ＋
          </GlassButton>
          <GlassButton
            size="s"
            variant="ghost"
            onClick={() => {
              setZoom(1);
              setOffset({ x: 0, y: 0 });
            }}
          >
            맞춤
          </GlassButton>
        </div>
      </div>
      {!focusTask && (
        <div className="map-member-filter">
          <button aria-pressed={!member} onClick={() => setMember(null)}>
            담당 전체
          </button>
          {data.members.map((m) => (
            <button
              key={m.id}
              aria-pressed={member === m.id}
              onClick={() => setMember(member === m.id ? null : m.id)}
            >
              {name(m.id)}
            </button>
          ))}
        </div>
      )}
      {focusTask && (
        <div className="focus-headings">
          <span>선행·부모 {leftIds.length}</span>
          <span>선택 업무</span>
          <span>다음·파생 {rightIds.length}</span>
        </div>
      )}
      <div
        className="map-viewport"
        ref={view}
        tabIndex={0}
        aria-label="업무 연결 지도 영역"
        onPointerDown={(e) => {
          if ((e.target as Element).closest("button")) return;
          drag.current = {
            x: e.clientX,
            y: e.clientY,
            ox: offset.x,
            oy: offset.y,
          };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (drag.current)
            setOffset({
              x: drag.current.ox + e.clientX - drag.current.x,
              y: drag.current.oy + e.clientY - drag.current.y,
            });
        }}
        onKeyDown={(e) => {
          const delta: Record<string, [number, number]> = {
            ArrowLeft: [-40, 0],
            ArrowRight: [40, 0],
            ArrowUp: [0, -40],
            ArrowDown: [0, 40],
          };
          if (e.target === e.currentTarget && delta[e.key]) {
            e.preventDefault();
            setOffset((v) => ({
              x: v.x + delta[e.key][0],
              y: v.y + delta[e.key][1],
            }));
          }
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
      >
        <div
          className="map-world"
          style={{
            height: worldHeight,
            transform: `translate(${offset.x}px,${offset.y}px) scale(${fit * zoom})`,
          }}
        >
          <svg
            className="map-lines"
            viewBox={`0 0 1120 ${worldHeight}`}
            style={{ height: worldHeight }}
            aria-hidden="true"
          >
            <defs>
              <marker
                id={`${marker}-seq-arrow`}
                markerWidth="7"
                markerHeight="7"
                refX="6"
                refY="3.5"
                orient="auto"
              >
                <path d="M0,0 L7,3.5 L0,7" fill="none" stroke="var(--ink-3)" />
              </marker>
              <marker
                id={`${marker}-parent-arrow`}
                markerWidth="7"
                markerHeight="7"
                refX="6"
                refY="3.5"
                orient="auto"
              >
                <path d="M0,0 L7,3.5 L0,7" fill="none" stroke="var(--link)" />
              </marker>
            </defs>
            {!focusTask
              ? activeLinks.map((l) => {
                  const p = linkGeometry(l);
                  return (
                    <path
                      key={l.id}
                      className="aggregate-line"
                      d={p.path}
                      data-dim={
                        (member &&
                          !l.edges.some(
                            (e) =>
                              model.byNode.get(e.from)?.memberId === member,
                          )) ||
                        undefined
                      }
                    />
                  );
                })
              : focusEdges.map((e) => {
                  const a = focusPos.get(e.a)!,
                    b = focusPos.get(e.b)!;
                  return (
                    <path
                      key={`${e.a}:${e.b}:${e.kind}`}
                      data-kind={e.kind}
                      markerEnd={`url(#${marker}-${e.kind === "derived" ? "parent" : "seq"}-arrow)`}
                      d={
                        a.x < b.x
                          ? `M${a.x + 304},${a.y + 42} C${a.x + 344},${a.y + 42} ${b.x - 40},${b.y + 42} ${b.x},${b.y + 42}`
                          : `M${a.x},${a.y + 60} C${a.x - 40},${a.y + 60} ${b.x + 344},${b.y + 60} ${b.x + 304},${b.y + 60}`
                      }
                    />
                  );
                })}
          </svg>
          {!focusTask ? (
            <>
              {linkLabels.map((label) => {
                const p = label.points[0];
                return (
                  <button
                    key={label.links.map((l) => l.id).join(":")}
                    className="map-link-count"
                    style={{ left: p.x, top: p.y }}
                    onClick={() =>
                      onScope({
                        kind: "relations",
                        pairs: label.links.map((l) => l.id),
                      })
                    }
                    title="개별 업무의 직원별 선후관계"
                  >
                    순서 관계{" "}
                    {label.links.reduce((n, l) => n + l.edges.length, 0)}
                  </button>
                );
              })}
              {activeGroups.map((g) => {
                const p = positions.get(g.id)!;
                return (
                  <article
                    className="map-group"
                    key={g.id}
                    data-group-id={g.id}
                    data-dim={
                      (member && !g.members.includes(member)) || undefined
                    }
                    data-blocked={g.blocked > 0 || undefined}
                    style={{ left: p.x, top: p.y }}
                  >
                    <div className="map-group-top">
                      <span>
                        {g.id === "individual" ? "개별 업무" : "파생 업무 묶음"}
                      </span>
                      <button
                        aria-label={`${g.title} 업무 ${g.shown.length}개 전체`}
                        onClick={() =>
                          onScope({
                            kind: "tasks",
                            source: "group",
                            groupId: g.id,
                          })
                        }
                      >
                        {g.shown.length}
                        {g.shown.length !== g.taskIds.length
                          ? ` / ${g.taskIds.length}`
                          : ""}
                      </button>
                    </div>
                    <button
                      className="map-group-title"
                      onClick={() =>
                        g.id === "individual"
                          ? onScope({
                              kind: "tasks",
                              source: "group",
                              groupId: g.id,
                            })
                          : onFocus(g.id)
                      }
                      onContextMenu={(e) => {
                        e.preventDefault();
                        if (g.id !== "individual") onFocus(g.id);
                      }}
                    >
                      <strong>{g.title}</strong>
                    </button>
                    <div
                      className="map-progress"
                      aria-label={`확인 필요 ${g.counts.action}, 실행 중 ${g.counts.running}, 다음 ${g.counts.next}, 완료 ${g.counts.done}, 미배정 ${g.counts.unassigned}`}
                    >
                      {(
                        [
                          "action",
                          "running",
                          "next",
                          "done",
                          "unassigned",
                        ] as const
                      ).map((k) => (
                        <i
                          key={k}
                          data-category={k}
                          style={{ flex: g.counts[k] }}
                        />
                      ))}
                    </div>
                    <div className="map-group-counts">
                      <button
                        data-warn={g.blocked > 0 || undefined}
                        onClick={() =>
                          onScope({
                            kind: "tasks",
                            source: "group",
                            groupId: g.id,
                            category: "blocked",
                          })
                        }
                      >
                        막힘 <b>{g.blocked}</b>
                      </button>
                      <button
                        onClick={() =>
                          onScope({
                            kind: "tasks",
                            source: "group",
                            groupId: g.id,
                            category: "action",
                          })
                        }
                      >
                        확인 {g.counts.action}
                      </button>
                      <span>실행 {g.counts.running}</span>
                      <span>다음 {g.counts.next}</span>
                      <span>완료 {g.counts.done}</span>
                      <span>미배정 {g.counts.unassigned}</span>
                    </div>
                    {participantChips(g.members, 2, {
                      kind: "members",
                      source: "group",
                      groupId: g.id,
                    })}
                  </article>
                );
              })}
            </>
          ) : (
            <>
              {left.map((id) => focusCard(id))}
              {focusCard(focusTask, true)}
              {right.map((id) => focusCard(id))}
              {leftIds.some((id) => !left.includes(id)) && (
                <button
                  className="map-more"
                  style={{ left: 24, top: 472 }}
                  onClick={() =>
                    onScope({
                      kind: "tasks",
                      source: "neighbors",
                      taskId: focusTask,
                      direction: "before",
                    })
                  }
                >
                  연결 {leftIds.length}개 모두 보기
                </button>
              )}
              {rightIds.length > 4 && (
                <button
                  className="map-more"
                  style={{ left: 782, top: 472 }}
                  onClick={() =>
                    onScope({
                      kind: "tasks",
                      source: "neighbors",
                      taskId: focusTask,
                      direction: "after",
                    })
                  }
                >
                  연결 {rightIds.length}개 모두 보기
                </button>
              )}
            </>
          )}
        </div>
      </div>
      <footer className="map-legend">
        <span>
          <i className="derived" />
          부모·파생
        </span>
        <span>
          <i />
          직원별 순서
        </span>
        <span className="map-total">
          {focusTask
            ? `${new Set([focusTask, ...leftIds, ...rightIds]).size}개 연결 업무`
            : `${activeGroups.reduce((n, g) => n + g.shown.length, 0)}개 업무 · ${activeGroups.length}개 묶음`}
        </span>
        {data.tasks.length > model.occurrences.size && (
          <button className="text-link records-link" onClick={onRecords}>
            흐름 밖 기록 {data.tasks.length - model.occurrences.size}
          </button>
        )}
      </footer>
      <div className="map-mobile-list">
        {focusTask ? (
          <>
            {[...new Set([focusTask, ...leftIds, ...rightIds])].map((id) => (
              <button key={id} onClick={() => onTask(id)}>
                <span className="to-state" data-state={info(id).state}>
                  {info(id).label}
                </span>
                {title(id)}
              </button>
            ))}
          </>
        ) : (
          activeGroups.map((g) => (
            <button
              key={g.id}
              onClick={() =>
                onScope({ kind: "tasks", source: "group", groupId: g.id })
              }
            >
              <b>{g.title}</b>
              <span>
                {g.shown.length}개 · 막힘 {g.blocked} · 확인 {g.counts.action} ·
                완료 {g.counts.done}
              </span>
              <span>{g.members.map(name).join(" · ")}</span>
            </button>
          ))
        )}
      </div>
    </section>
  );
}
