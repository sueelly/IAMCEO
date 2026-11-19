// 팀 아래 일 목록과 결재함 완료 알림의 화면 공통 규칙(대표 2026-11-17 #4aab3546). 브라우저 API 를 쓰지 않는다.
// 대화와 같은 업무 id 의 단계(서버 계산)를 쓴다. 진행판 항목이 업무를 가리키면 그 단계가 손으로 정한 칸보다 앞선다.
import type { Task, TaskStage, WorkItem, WorkSec } from "@shared/types";
import { needsAction, taskStageLabel, stageSec } from "@shared/task-stage";

export const SEC_LABEL: Record<WorkSec, string> = { doing: "진행 중", next: "예정", hold: "보류", done: "완료" };
/** 진행판에 없는 대화 업무는 최근 14일 것만 목록에 올린다(서버의 '받은 업무' 기간과 같다). */
export const TASK_ROW_DAYS = 14;

export interface WorkRow {
  key: string;
  title: string;
  who: string;
  detail: string;
  sec: WorkSec;
  label: string;
  /** 업무 단계를 따르는 줄이면 그 단계. 손으로 정한 칸만 있으면 null. */
  stage: TaskStage | null;
  /** 누가 무엇을 해야 할 때만: 원인과 다음 차례 */
  next: string | null;
  doneAt: string | null;
  at: string;
  order: number;
  taskId: string | null;
}

function taskRow(t: Task, now: number): WorkRow | null {
  const p = t.progress;
  if (!p || p.stage === "new" || t.mergedInto) return null;
  const at = p.rev || t.updatedAt;
  if (now - Date.parse(at) > TASK_ROW_DAYS * 86_400_000) return null;
  return { key: t.id, title: t.title, who: p.owner ?? t.who ?? "", detail: "", sec: stageSec(p.stage), label: taskStageLabel(p), stage: p.stage,
    next: needsAction(p) ? p.next : null, doneAt: p.stage === "done" ? p.since : null, at, order: Number.MAX_SAFE_INTEGER, taskId: t.id };
}

/**
 * 한 목록: 진행판 항목 + 진행판에 없는 대화 업무.
 * - 업무를 가리키는 항목(task_id): 명시적인 보류 카드에는 보류 사유를 유지한다. 완료·대표 응답·터미널 승인은 해당 업무의 근거를 표시한다.
 * - 가리키지 않는 옛 항목: 총괄이 정한 칸 그대로. 그 항목의 업무(tk_<id>)에 할 차례가 있으면 그 원인만 덧붙인다.
 * - 진행판에 없는 업무: 직원·서버가 만든 업무도 목록에 오른다(최근 14일, 시작 전·합쳐진 업무 제외). 진행판 항목의 업무는 두 번 올리지 않는다.
 */
export function workRows(work: readonly WorkItem[], tasks: readonly Task[], now: number): WorkRow[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const onBoard = new Set<string>();
  const rows: WorkRow[] = work.map((w) => {
    const own = `tk_${w.id}`;
    onBoard.add(w.taskId ?? own);
    const linked = w.taskId ? byId.get(w.taskId) : undefined;
    const p = linked?.progress;
    const boardHold = w.sec === "hold" && p && !["owner", "approval", "done", "hold"].includes(p.stage);
    if (linked && p && !boardHold) {
      return { key: w.id, title: w.title, who: w.who, detail: w.detail, sec: stageSec(p.stage), label: taskStageLabel(p), stage: p.stage,
        next: needsAction(p) ? p.next : null, doneAt: p.stage === "done" ? p.since : null, at: p.rev || w.updatedAt, order: w.order, taskId: linked.id };
    }
    const board = byId.get(own)?.progress;
    return { key: w.id, title: w.title, who: w.who, detail: w.detail, sec: w.sec, label: SEC_LABEL[w.sec], stage: null,
      next: w.sec !== "done" && needsAction(board) ? board!.next : null, doneAt: w.doneAt, at: w.updatedAt, order: w.order, taskId: w.taskId ?? (byId.has(own) ? own : null) };
  });
  for (const t of tasks) {
    if (onBoard.has(t.id) || t.id.startsWith("tk_w_")) continue;
    const row = taskRow(t, now);
    if (row) rows.push(row);
  }
  return rows;
}

/** 진행판이 비어도 목록을 보일지: 올릴 대화 업무가 하나라도 있으면. */
export function hasTaskRows(tasks: readonly Task[], now: number): boolean {
  return tasks.some((t) => !t.id.startsWith("tk_w_") && taskRow(t, now) !== null);
}

/** 결재함의 완료 알림: 완료 단계이고 아직 확인하지 않은 것, 최근 것부터. */
export function noticeTasks(tasks: readonly Task[]): Task[] {
  return tasks
    .filter((t) => t.progress?.stage === "done" && t.progress.notice && !t.progress.notice.seenAt)
    .sort((a, b) => b.progress!.notice!.at.localeCompare(a.progress!.notice!.at));
}
