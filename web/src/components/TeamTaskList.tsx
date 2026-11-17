import { useEffect, useRef } from "react";
import type { ProjectState } from "@shared/types";
import type { WorkflowNode } from "@shared/workflow";
import { workflowBucket, workflowCategory } from "@shared/workflow-view";
import { GlassButton } from "../glass";
import WorkflowDetail from "./WorkflowDetail";
export type TeamTaskTab =
  "all" | "now" | "next" | "checks" | "reviews" | "blocked" | "done";
export const TEAM_TASK_TABS: [TeamTaskTab, string][] = [
  ["all", "전체"],
  ["now", "지금"],
  ["next", "다음·대기"],
  ["checks", "확인 필요"],
  ["done", "완료"],
];
export function teamTaskScope(nodes: WorkflowNode[], tab: TeamTaskTab) {
  return tab === "all"
    ? nodes
    : tab === "checks"
      ? nodes.filter((n) => workflowCategory(n) === "action")
      : tab === "blocked"
        ? nodes.filter((n) => n.state === "blocked" || n.state === "unknown")
        : tab === "reviews"
          ? nodes.filter(
              (n) =>
                workflowCategory(n) === "action" &&
                n.state !== "blocked" &&
                n.state !== "unknown",
            )
          : nodes.filter((n) => workflowBucket(n) === tab);
}
export default function TeamTaskList({
  state,
  nodes,
  online,
  tab = "all",
  onTab,
  expanded,
  onExpand,
  onFocus,
  onMember,
  onClose,
}: {
  state: ProjectState;
  nodes: WorkflowNode[];
  online: boolean;
  tab?: TeamTaskTab;
  onTab?: (tab: TeamTaskTab) => void;
  expanded: string | null;
  onExpand: (id: string | null) => void;
  onFocus: (taskId: string, origin?: HTMLElement) => void;
  onMember: (memberId: string) => void;
  onClose: () => void;
}) {
  const root = useRef<HTMLDivElement>(null),
    visible = teamTaskScope(nodes, tab);
  useEffect(() => {
    if (expanded)
      requestAnimationFrame(() =>
        root.current
          ?.querySelector("[data-expanded]")
          ?.scrollIntoView({ block: "nearest" }),
      );
  }, [expanded]);
  return (
    <div className="tt-list" ref={root}>
      {onTab ? (
        <nav className="tt-filters team-options" aria-label="직원 업무 상태">
          {TEAM_TASK_TABS.map(([key, label]) => (
            <GlassButton
              key={key}
              size="s"
              variant="ghost"
              ariaPressed={
                tab === key ||
                (["blocked", "reviews"].includes(tab) && key === "checks")
              }
              onClick={() => onTab(key)}
            >
              {label}
              <span className="wf-count">
                {teamTaskScope(nodes, key).length}
              </span>
            </GlassButton>
          ))}
        </nav>
      ) : null}
      {tab === "blocked" ? (
        <p className="tt-scope">막힘 {visible.length}</p>
      ) : null}
      {tab === "reviews" ? (
        <p className="tt-scope">막힘 외 확인 필요 {visible.length}</p>
      ) : null}
      {expanded && !nodes.some((n) => n.id === expanded) ? (
        <p role="status" className="wf-empty">
          선택한 업무의 담당 기록이 변경되었습니다.
        </p>
      ) : null}
      {visible.map((n) => {
        const task = state.tasks?.find((t) => t.id === n.taskId),
          isOpen = expanded === n.id;
        return (
          <article
            className="tt-item"
            key={n.id}
            data-expanded={isOpen || undefined}
            data-task-id={n.taskId}
          >
            <button
              type="button"
              className="tt-title"
              data-node-id={n.id}
              aria-expanded={isOpen}
              onClick={() => onExpand(isOpen ? null : n.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                onFocus(n.taskId, e.currentTarget);
              }}
              onKeyDown={(e) => {
                if (
                  e.key === "ContextMenu" ||
                  (e.shiftKey && e.key === "F10")
                ) {
                  e.preventDefault();
                  onFocus(n.taskId);
                }
              }}
            >
              <span className="to-state" data-state={n.state}>
                {online ? n.label : `마지막 확인: ${n.label}`}
              </span>
              <strong>{task?.title ?? "업무"}</strong>
              <span aria-hidden="true">{isOpen ? "−" : "+"}</span>
            </button>
            {isOpen ? (
              <WorkflowDetail
                node={n}
                task={task}
                state={state}
                online={online}
                onClose={onClose}
                onFocus={onFocus}
                onMember={onMember}
              />
            ) : null}
          </article>
        );
      })}
      {!visible.length ? (
        <p className="wf-empty">해당하는 업무가 없습니다.</p>
      ) : null}
    </div>
  );
}
