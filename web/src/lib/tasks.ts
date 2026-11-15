// 대화의 작업 고르기(화면 공통 규칙). 브라우저 API 를 쓰지 않는다.
import type { Message, Task } from "@shared/types";

/** 진행판 일 항목에서 생긴 작업이면 그 일 항목 id(서버 규칙: tk_<일 항목 id>). */
export function workIdOf(task: Pick<Task, "id">): string | null {
  return task.id.startsWith("tk_w_") ? task.id.slice(3) : null;
}

/** 업무의 마지막 글 시각: 서버가 준 값과 지금 화면에 받은 글 중 늦은 것. 글이 하나도 없으면 null. */
export function taskActivity(task: Pick<Task, "id" | "lastMessageAt">, messages: readonly Pick<Message, "taskId" | "at">[] = []): string | null {
  let last = task.lastMessageAt ?? null;
  for (const m of messages) if (m.taskId === task.id && (!last || m.at > last)) last = m.at;
  return last;
}

/**
 * 입력칸 아래 업무 목록(대표 2026-11-13·14). 업무는 여러 직원이 함께 하는 목적 단위라 받는 사람·담당과 상관없이 같은 목록이다.
 * - 대화가 있는 업무는 모두 보인다. 진행판에서 끝낸 일의 업무도 숨기지 않는다(글이 있는데 목록에 없으면 찾아갈 수 없다).
 * - 글이 하나도 없는 업무(진행판 계획만 있는 일 등)는 눌러도 빈 화면이라 뺀다. 지금 고른 업무는 비어 있어도 남긴다.
 * - 다른 업무로 합쳐진 업무는 뺀다. 최근 글 순, 같으면 최근 생긴 순.
 * 서버가 마지막 글 시각을 주지 않는 옛 응답(lastMessageAt 없음)이면 비었는지 모르니 남긴다.
 */
export function chipTasks(tasks: readonly Task[], messages: readonly Pick<Message, "taskId" | "at">[] = [], keepId: string | null = null): Task[] {
  const rows = tasks
    .filter((t) => !t.mergedInto || t.id === keepId)
    .map((t) => ({ t, last: taskActivity(t, messages) }))
    .filter(({ t, last }) => t.id === keepId || last !== null || t.lastMessageAt === undefined);
  const key = (r: { t: Task; last: string | null }) => r.last ?? r.t.createdAt;
  return rows.sort((a, b) => (key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : a.t.createdAt < b.t.createdAt ? 1 : -1)).map((r) => r.t);
}

/**
 * 업무 고르기: 초안의 업무만 바꾸고 받는 사람(targetId)은 그대로 둔다(대표 2026-11-13).
 * 한 업무를 시작·마무리하며 여러 직원과 이어서 말할 수 있어야 해서다. 같은 업무면 초안을 그대로 돌려준다.
 */
export function withTask<D extends { taskId?: string | null }>(draft: D, taskId: string | null): D {
  return (draft.taskId ?? null) === taskId ? draft : { ...draft, taskId };
}

/**
 * 자료 화면의 업무 거르기(대표 2026-11-16): 입력칸에서 고른 업무의 자료만 남긴다. 고르지 않았으면('전체') 그대로다.
 * 업무가 없는 옛 자료는 '전체'에서만 보인다(대화와 같은 규칙). 순서는 받은 그대로.
 */
export function taskFiles<F extends { taskId?: string | null }>(files: readonly F[], taskId: string | null): F[] {
  return taskId ? files.filter((f) => f.taskId === taskId) : [...files];
}

/**
 * 입력칸의 '/업무' 부르기(대표 2026-11-14): 글 맨 앞이나 빈칸 뒤의 '/'부터 커서까지. 주소(a/b)처럼 글자 뒤의 '/'는 부르지 않는다.
 * start 는 '/'의 자리, query 는 '/' 뒤에 친 글(소문자).
 */
export function findSlash(text: string, caret: number): { start: number; query: string } | null {
  const m = /(^|\s)\/([^\s/]*)$/.exec(text.slice(0, caret));
  return m ? { start: caret - m[2]!.length - 1, query: m[2]!.toLowerCase() } : null;
}

/** 업무 이름·브랜치에 친 글이 들어간 업무만. 빈 글이면 그대로. 순서는 받은 그대로(최근 글 순). */
export function filterTasks<T extends Pick<Task, "title" | "branch">>(tasks: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...tasks];
  return tasks.filter((t) => t.title.toLowerCase().includes(q) || (t.branch ?? "").toLowerCase().includes(q));
}
