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
 * 이 작업을 맡은 직원 id. 직원이 task 도구로 등록한 작업은 그 직원, 진행판 일 항목의 작업은 담당(who: "엘리트사원 클로드·총괄")에
 * 이름이 적힌 직원들이다. 총괄은 직원이 아니라 빠진다.
 */
export function taskWorkers(task: Pick<Task, "memberId" | "who">, workers: readonly Pick<Member, "id" | "name">[]): string[] {
  if (task.memberId) return workers.some((w) => w.id === task.memberId) ? [task.memberId] : [];
  const names = new Set(task.who.split(/[·,、/]/).map((x) => x.trim()).filter(Boolean));
  return workers.filter((w) => names.has(w.name)).map((w) => w.id);
}

/**
 * 직원이 맡은 작업 목록(직접 등록한 작업 + 진행판에서 담당으로 적힌 작업). targetId 가 없으면 전부, 최신순.
 * 입력칸 업무 칩은 받는 사람과 떼어 늘 전부를 보인다(대표 2026-11-13). 업무를 골라도 받는 사람은 바뀌지 않는다.
 */
export function visibleTasks(tasks: readonly Task[], targetId: string | null, workers: readonly Pick<Member, "id" | "name">[] = []): Task[] {
  const list = targetId ? tasks.filter((t) => t.memberId === targetId || taskWorkers(t, workers).includes(targetId)) : [...tasks];
  return list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

/**
 * 업무 고르기: 초안의 업무만 바꾸고 받는 사람(targetId)은 그대로 둔다(대표 2026-11-13).
 * 한 업무를 시작·마무리하며 여러 직원과 이어서 말할 수 있어야 해서다. 같은 업무면 초안을 그대로 돌려준다.
 */
export function withTask<D extends { taskId?: string | null }>(draft: D, taskId: string | null): D {
  return (draft.taskId ?? null) === taskId ? draft : { ...draft, taskId };
}
