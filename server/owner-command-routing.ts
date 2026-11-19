import type { Delivery, Member, Task } from "../shared/types.ts";
import { bindingContract, missingExecutionContractFields } from "./harness.ts";
import { standardWorker } from "./shared-work-queue.ts";
import { Store } from "./store.ts";

/** Even the command composer can receive a status question or a request to stop/delegate. */
export function ownerRequestsExecution(text: string): boolean {
  const line = text.trim().split("\n", 1)[0]!;
  if (!line || /[?？]$/.test(line)) return false;
  const courtesy = /^(?:안녕(?:하세요)?|고마워(?:요)?|고맙습니다|감사(?:해요|합니다)|수고했(?:어|어요)|hello|hi|thanks|thank you)[.!\s]*$/iu;
  const control = /^(?:(?:please\s+)?(?:stop|pause|hold|cancel|delegate|coordinate)\b|(?:please )?(?:do not|don't|don’t) (?:start|run|resume|continue|send)\b)|(?:중단|중지|보류|취소|일시\s*정지)(?:해|하[고지세요]|시켜|\s*(?:요청|부탁)|[.!\s]*$)|멈(?:춰|추[고세길])|(?:시작|실행|재개|진행|전송)?하지\s*(?:마|말아|말자)|(?:업무|담당|역할|일정|계획|범위|직원).{0,20}(?:배정|위임|조율|조정)(?:해|하)|^(?:배정|위임|조정|조율)해/iu;
  const question = /^(?:how|when|who|what|why|is|are|did|has|have)\s|(?:^|\s)(?:왜|언제|누가|누구|어디까지)\s|(?:끝났|됐|되었|인가|했|있는|있나|어디까지|어떻게 되).{0,10}(?:니|나요|는지|을까|알려)|(?:진행\s*(?:상황|상태)|어디까지).{0,18}(?:알려|보고|확인)/iu;
  return !courtesy.test(line) && !control.test(line) && !question.test(line);
}

/** A task id is authoritative. Textual titles must identify one whole title in this project. */
export function referencedOwnerTask(store: Store, projectId: string, text: string): Task | "ambiguous" | null {
  const ids = new Set(text.match(/\btk_[A-Za-z0-9_-]+/g) ?? []);
  if (ids.size > 1) return "ambiguous";
  const namedId = [...ids][0];
  const referenced = namedId ? store.getTask(namedId) : null;
  if (namedId && referenced?.projectId !== projectId) return "ambiguous";
  const titles = store.db.query<{ id: string; title: string }, [string]>("SELECT id,title FROM tasks WHERE project_id=? AND merged_into IS NULL").all(projectId);
  const matches = titles.filter(({ title }) => {
    if (title.length < 2) return false;
    const literal = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${literal}(?=$|[^\\p{L}\\p{N}_]|(?:을|를|의|으로|에서|부터|까지|은|는)\\s)`, "u").test(text);
  });
  if (referenced) return matches.every(m => m.id === referenced.id) ? referenced : "ambiguous";
  if (matches.length > 1) return "ambiguous";
  return matches[0] ? store.getTask(matches[0].id) : null;
}

function unique<T>(items: T[]): T | null { return items.length === 1 ? items[0]! : null; }

function matches(member: Member, label: string): boolean {
  return [member.id, member.name, "@" + member.handle, member.role].some(field => field && field === label);
}

function openTask(store: Store, task: Task): boolean {
  const seen = new Set<string>();
  let current: Task | null = task;
  while (current) {
    if (seen.has(current.id) || current.projectId !== task.projectId || current.mergedInto || store.doneMark(current.id)) return false;
    seen.add(current.id);
    const frozen = store.db.query(`SELECT 1 FROM work WHERE project_id=? AND COALESCE(task_id,'tk_' || id)=?
      AND sec IN ('hold','done') LIMIT 1`).get(task.projectId, current.id);
    if (frozen) return false;
    if (!current.parentTaskId) return true;
    current = store.getTask(current.parentTaskId);
  }
  return false;
}

function boardRecipients(store: Store, task: Task): string[] {
  return store.db.query<{ who: string }, [string, string]>(`SELECT DISTINCT trim(who) AS who FROM work
    WHERE project_id=? AND COALESCE(task_id,'tk_' || id)=? AND sec IN ('next','doing') AND trim(who)<>''`)
    .all(task.projectId, task.id).map(row => row.who);
}

/** Task creators and contract authors are not proof of a present worker assignment. */
export function resolveOwnerCommandWorker(store: Store, task: Task, newCommand: boolean, requestedRole?: string): Member | null {
  if (!openTask(store, task) || /^(?:reviewed-main|main-repair|independent-review-repair):/.test(store.taskSourceRef(task.id) ?? "")) return null;
  const contract = store.getEffectiveContract(task.id);
  if (!contract || contract.taskId !== task.id || !bindingContract(contract) || missingExecutionContractFields(contract).length) return null;
  const state = store.taskSequenceSnapshot(task.projectId);
  if (state.suspended.has(task.id) || state.awaitingOwner.has(task.id) || store.pendingTaskFailureDecision(task.id) || store.pendingTaskIntervention(task.id)) return null;
  const phase = store.taskProgress(task.id);
  if (["done", "hold", "held", "review", "merge", "merged", "applied", "delivered", "approval", "owner", "check"].includes(phase.stage) || phase.finalReview?.status === "pending") return null;
  const workers = store.listMembers(task.projectId).filter(m => standardWorker(m) && !m.executionIssue &&
    !(m.status === "asleep" && store.listPending(m.id).some(d => d.wake && d.status === "held")));
  const board = boardRecipients(store, task);
  const assigned = new Set(state.assignments.filter(a => a.taskId === task.id && a.enrolled && a.eligible && workers.some(w => w.id === a.memberId)).map(a => a.memberId));
  const named = requestedRole?.trim();
  if (board.length || assigned.size) {
    return unique(workers.filter(m => (!named || matches(m, named)) && board.every(name => matches(m, name)) && (!assigned.size || assigned.has(m.id))));
  }
  if (!newCommand) return null;
  const scoped = workers.filter(m => !m.executionIssue && (!task.worktree && !task.branch || task.worktree === m.cwd));
  if (named) return unique(scoped.filter(m => matches(m, named)));
  const description = [contract.goal, contract.scope].join(" ").normalize("NFKC").toLocaleLowerCase();
  const matched = scoped.filter(m => [m.name, m.role].some(label => label.trim().length >= 2 && description.includes(label.trim().normalize("NFKC").toLocaleLowerCase())));
  return unique(matched);
}

/** An automatically chosen worker still needs an open scope and a current contract at terminal write time. */
export function ownerCommandAllowsDelivery(store: Store, input: Delivery): boolean {
  if (input.kind !== "user_message" || input.refType !== "message" || !input.refId) return true;
  const row = store.db.query<{ routed_worker_id: string | null; routed_task_id: string | null }, [string]>(
    "SELECT routed_worker_id,routed_task_id FROM owner_commands WHERE message_id=?",
  ).get(input.refId);
  if (!row?.routed_worker_id) return true;
  if (!input.taskId || row.routed_task_id !== input.taskId) return false;
  const task = store.getTask(input.taskId);
  const member = store.getMember(input.memberId);
  const contract = task && store.getEffectiveContract(task.id);
  return !!task && !!member && member.id === row.routed_worker_id && standardWorker(member) && openTask(store, task) &&
    !!contract && contract.taskId === task.id && bindingContract(contract) && !missingExecutionContractFields(contract).length &&
    boardRecipients(store, task).every(name => matches(member, name));
}
