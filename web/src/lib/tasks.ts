// 대화의 작업 고르기(화면 공통 규칙). 브라우저 API 를 쓰지 않는다.
import type { Member, Task } from "@shared/types";

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

