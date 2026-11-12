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
 * 대상 칩 옆의 작업 목록. 대상으로 직원을 골랐으면 그 직원이 맡은 작업만 보인다(직접 등록한 작업 + 진행판에서 담당으로 적힌 작업).
 * 작업을 고르면 받는 사람이 정해지고, 그 작업을 맡지 않은 직원을 고르면 작업 선택이 풀린다(→ taskTarget, keepsTask).
 */
export function visibleTasks(tasks: readonly Task[], targetId: string | null, workers: readonly Pick<Member, "id" | "name">[] = []): Task[] {
  const list = targetId ? tasks.filter((t) => t.memberId === targetId || taskWorkers(t, workers).includes(targetId)) : [...tasks];
  return list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

/**
 * 작업을 고르면 보낼 대상. 등록한 직원이 지금 있으면 그 직원.
 * 진행판 일 항목의 작업은 기본이 총괄이지만, 지금 고른 직원이 그 작업의 담당이면 그 직원에게 그대로 보낸다.
 */
export function taskTarget(task: Task, workers: readonly Pick<Member, "id" | "name">[], current: string | null = null): string | null {
  if (task.memberId) return workers.some((w) => w.id === task.memberId) ? task.memberId : null;
  return current && taskWorkers(task, workers).includes(current) ? current : null;
}

/** 대상을 바꿔도 고른 작업을 그대로 둘지: 그 작업의 받는 사람이거나 담당 직원이거나, 진행판 작업을 총괄에게 보낼 때. */
export function keepsTask(task: Task, workers: readonly Pick<Member, "id" | "name">[], targetId: string | null): boolean {
  if (task.memberId) return taskTarget(task, workers) === targetId;
  return targetId === null || taskWorkers(task, workers).includes(targetId);
}
