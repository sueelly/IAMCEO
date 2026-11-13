// 업무를 주제로 하지 않는 옛 시험용: 규칙을 지키는 직원처럼 글에 업무 id 를 넣는다.
// 본사가 아닌 프로젝트의 글은 업무 id 가 없으면 거절되므로, 시험이 밝히지 않은 곳에만 '시험 업무'를 넣는다.
// 업무 규칙 자체는 task-everywhere·task-threads·work-tasks 시험이 이 도우미 없이 본다.
import type { Member } from "../../shared/types.ts";
import type { Store } from "../../server/store.ts";

const RECORD_TOOLS = new Set(["post", "ask", "file", "todo"]);
const INSTRUCTION_TOOLS = new Set(["team_assign", "team_stop", "team_add", "team_resume"]);

/** 프로젝트마다 하나인 시험 업무 id(처음 부를 때 만든다). */
export function defaultTaskId(store: Store, projectId: string): string {
  return store.ensureSourceTask({ projectId, sourceRef: "test:default-task", title: "시험 업무", origin: "owner" }).task.id;
}

/**
 * args 에 task_id 를 넣어 돌려준다. 이미 밝혔거나(null 포함), 이어 준 결재·자료·인용 대표 글이 업무를 정하거나,
 * 업무가 필요 없는 호출(보고 조회·then 없는 멈춤·본사)이면 그대로 둔다.
 */
export function withDefaultTask<T>(store: Store, member: Pick<Member, "projectId">, name: string, args: T): T {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  const a = args as Record<string, unknown>;
  if ("task_id" in a) return args;
  if (RECORD_TOOLS.has(name)) {
    if (name === "post" && a.report_id) return args;
    if (a.decision_id || a.file_id) return args;
  } else if (INSTRUCTION_TOOLS.has(name)) {
    if (name === "team_stop" && !a.then) return args;
    if ((name === "team_add" || name === "team_resume") && !(typeof a.first_instruction === "string" && a.first_instruction.trim())) return args;
    // 업무가 붙은 대표 글을 인용하면 서버가 그 업무를 쓴다. 그 밖의 인용(업무 전 옛 글·미확인·결재 버튼 글)에는 시험 업무를 넣는다.
    if (typeof a.user_quote === "string" && quotesTaskedOwnerMessage(store, member.projectId, a.user_quote)) return args;
  } else return args;
  if (store.requireProject(member.projectId).isHq) return args;
  return { ...a, task_id: defaultTaskId(store, member.projectId) } as T;
}

const squash = (text: string) => text.replace(/\s+/g, " ").trim();
function quotesTaskedOwnerMessage(store: Store, projectId: string, quote: string): boolean {
  const q = squash(quote);
  if (!q) return false;
  return store.listMessages(projectId, { limit: 1000 }).some(m => m.mine && !!m.taskId && squash(m.body).includes(q));
}

/**
 * 서버를 따로 띄운 시험(화면 시험)용. 직원 토큰마다 task 도구로 '시험 업무'를 한 번 만들고(같은 제목이면 같은 업무),
 * 업무가 필요한 호출에만 넣는다. 인용(user_quote)이 있는 지시와 본사(task 도구가 없다)에는 넣지 않는다.
 */
export function httpDefaultTask(call: (token: string, name: string, args: unknown) => Promise<{ text: string; isError?: boolean }>) {
  const ids = new Map<string, Promise<string | null>>();
  const idFor = (token: string) => {
    let id = ids.get(token);
    if (!id) {
      id = call(token, "task", { title: "시험 업무" }).then(r => (r.isError ? null : (/#(tk_[A-Za-z0-9_]+)/.exec(r.text)?.[1] ?? null)), () => null);
      ids.set(token, id);
    }
    return id;
  };
  return async <T>(token: string, name: string, args: T): Promise<T> => {
    if (!args || typeof args !== "object" || Array.isArray(args)) return args;
    const a = args as Record<string, unknown>;
    if ("task_id" in a) return args;
    if (RECORD_TOOLS.has(name)) {
      if (name === "post" && a.report_id) return args;
      if (a.decision_id || a.file_id) return args;
    } else if (INSTRUCTION_TOOLS.has(name)) {
      if (name === "team_stop" && !a.then) return args;
      if ((name === "team_add" || name === "team_resume") && !(typeof a.first_instruction === "string" && a.first_instruction.trim())) return args;
      if (typeof a.user_quote === "string" && a.user_quote.trim()) return args;
    } else return args;
    const id = await idFor(token);
    return id ? ({ ...a, task_id: id } as T) : args;
  };
}
