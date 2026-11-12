// 대화의 작업 고르기(화면 공통 규칙). 브라우저 API 를 쓰지 않는다.
import type { Member, Task, WorkItem } from "@shared/types";

/** 진행판 일 항목에서 생긴 작업이면 그 일 항목 id(서버 규칙: tk_<일 항목 id>). */
export function workIdOf(task: Pick<Task, "id">): string | null {
  return task.id.startsWith("tk_w_") ? task.id.slice(3) : null;
}

/** 칩으로 보일 작업: 진행판에서 완료했거나 지운 일 항목의 작업은 숨긴다(글은 '전체'에 남는다). 지금 고른 작업은 남긴다. */
export function liveTasks(tasks: readonly Task[], work: readonly Pick<WorkItem, "id" | "sec">[] | undefined, keepId: string | null = null): Task[] {
  if (!work) return [...tasks];
  const open = new Set(work.filter((w) => w.sec !== "done").map((w) => w.id));
  return tasks.filter((t) => {
    const workId = workIdOf(t);
    return !workId || open.has(workId) || t.id === keepId;
  });
}

/**
 * 대상 칩 옆의 작업 목록. 대상으로 직원을 골랐으면 그 직원의 작업만 보인다.
 * 작업을 고르면 받는 사람은 그 작업을 등록한 직원이 되고, 다른 직원을 고르면 작업 선택이 풀린다(→ taskTarget, Composer 의 keepTask).
 */
export function visibleTasks(tasks: readonly Task[], targetId: string | null): Task[] {
  const list = targetId ? tasks.filter((t) => t.memberId === targetId) : [...tasks];
  return list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

/** 작업을 고르면 보낼 대상: 등록한 직원이 지금 있는 직원이면 그 직원, 아니면(총괄이 등록했거나 직원이 닫힘) 기본 대상. */
export function taskTarget(task: Task, workers: readonly Pick<Member, "id">[]): string | null {
  return task.memberId && workers.some((w) => w.id === task.memberId) ? task.memberId : null;
}

