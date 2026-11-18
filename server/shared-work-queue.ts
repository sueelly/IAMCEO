import { randomUUID } from "node:crypto";
import { untouchedQueuedInput } from "./review-routing.ts";
import type { Delivery, Member, Task, WorkItem } from "../shared/types.ts";
import { bindingContract, missingExecutionContractFields, type TaskContract } from "./harness.ts";
import { Store } from "./store.ts";
import { prepareReviewedRepair, reviewedRepairSource } from "./task-main-followup.ts";
import { taskScopeForDeliveryIds } from "./task-continuation.ts";
import { relatedWork } from "./workflow.ts";

const claimMessagePrefix = "msg_board_claim_";

function workTaskId(work: WorkItem): string {
  return work.taskId ?? Store.workTaskId(work.id);
}

function directContract(store: Store, taskId: string): TaskContract | null {
  const contract = store.getEffectiveContract(taskId);
  return contract?.taskId === taskId && bindingContract(contract) && !missingExecutionContractFields(contract).length ? contract : null;
}

function standardWorker(member: Member): boolean {
  return member.kind === "worker" && !member.finalReviewer && !member.standbyReviewer && member.origin === "runner" &&
    (member.cli !== "codex" || member.codexSpeed !== "fast" && member.appliedCodexSpeed !== "fast");
}

function namedRecipient(store: Store, projectId: string, who: string): Member | null {
  const value = who.trim();
  if (!value) return null;
  if (value.startsWith("@")) return store.getMemberByHandle(projectId, value.slice(1));
  const member = store.findMember(projectId, value) ?? store.getMember(value);
  return member?.projectId === projectId ? member : null;
}

function matchesRecipient(member: Member, who: string, named: Member | null): boolean {
  return named ? member.id === named.id : !who.trim().startsWith("@") && member.role === who.trim();
}

/** Only the server's unopened board instruction can change inbox. Keep already dispatched,
 * manually handled, shared-family, or uncertain work on its durable original receipt. */
function changedClaims(store: Store, projectId: string): Map<string, Delivery> {
  const result = new Map<string, Delivery>();
  const rows = store.db.query<{ id: string; workId: string; who: string }, [string, number, string]>(`SELECT d.id,w.id AS workId,w.who
    FROM deliveries d JOIN messages a ON a.id=d.ref_id AND a.target_member_id=d.member_id AND a.mine=0 AND a.kind='시스템'
    JOIN members m ON m.id=d.member_id
    JOIN work w ON w.project_id=d.project_id AND COALESCE(w.task_id,'tk_'||w.id)=d.task_id
    WHERE d.project_id=? AND d.kind='instruction' AND d.ref_type='message' AND substr(d.ref_id,1,?)=?
      AND d.status='queued' AND d.attempts=0 AND w.sec IN ('next','doing') AND trim(w.who)<>''
      AND (w.who<>a.target_name OR w.who<>m.name)
      AND EXISTS(SELECT 1 FROM task_sequence q WHERE q.task_id=d.task_id AND q.member_id=d.member_id)
      AND NOT EXISTS(SELECT 1 FROM manual_inbox_items mi WHERE mi.delivery_id=d.id)
      AND NOT EXISTS(SELECT 1 FROM deliveries other WHERE other.task_id=d.task_id AND other.id<>d.id AND other.wake=1
        AND other.status IN ('queued','held','delivering'))`).all(projectId, claimMessagePrefix.length, claimMessagePrefix);
  for (const row of rows) {
    const input = store.requireDelivery(row.id);
    if (input.refId?.slice(claimMessagePrefix.length).split(".")[0] !== row.workId) continue;
    const target = namedRecipient(store, projectId, row.who);
    if (!target || target.id === input.memberId || !untouchedQueuedInput(store, input)) continue;
    const state = store.inputState(input.memberId);
    if (!state.lease && !state.unresolvedDispatches.length && !store.hasLogicalDeliveryFence(input.memberId)) result.set(row.workId, input);
  }
  return result;
}

/** The board recipient is explicit. The task creator and the contract author are not assignees. */
function fit(member: Member, work: WorkItem, task: Task, contract: TaskContract, author: string | null, named: Member | null): number {
  if ((work.who.trim() && !matchesRecipient(member, work.who, named)) || (author && member.id !== author)) return -1;
  if (work.who.trim() || author) return 1;
  if ((task.branch || task.worktree) && (!task.worktree || task.worktree !== member.cwd)) return -1;
  const text = [work.title, contract.goal, contract.scope].join(" ").normalize("NFKC").toLowerCase();
  const words = new Set((member.name + " " + member.role).normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]{2,}/gu));
  let score = 0;
  for (const word of words) if (text.includes(word)) score++;
  return score === 0 && member.role.trim() ? -1 : score;
}

/** An older card can still say "next" after the task or an ancestor has closed.
 * Refuse broken ancestry rather than treating a missing parent as a new root. */
function openLineage(store: Store, task: Task, closedCards: ReadonlySet<string>): boolean {
  const seen = new Set<string>();
  let node: Task | null = task;
  while (node && node.projectId === task.projectId && !seen.has(node.id)) {
    if (node.mergedInto || closedCards.has(node.id) || store.doneMark(node.id)) return false;
    if (!node.parentTaskId) return true;
    seen.add(node.id);
    node = store.getTask(node.parentTaskId);
  }
  return false;
}

function workerAlreadyAssigned(store: Store, taskId: string, moving?: Delivery): boolean {
  // Keep pre-enrollment history, including failed deliveries and gone recipients.
  // A delivered owner message to the conductor is intake for the task.
  return !!store.db.query(`SELECT 1 FROM deliveries d LEFT JOIN members m ON m.id=d.member_id
    WHERE d.task_id=? AND d.id IS NOT ? AND d.wake=1 AND d.kind IN ('instruction','user_message') AND (m.kind='worker' OR m.id IS NULL)
    UNION ALL SELECT 1 FROM task_sequence q JOIN members m ON m.id=q.member_id WHERE q.task_id=? AND m.kind='worker' AND q.member_id IS NOT ? LIMIT 1`).get(taskId, moving?.id ?? null, taskId, moving?.memberId ?? null);
}

/** All reads and writes for competing project claimants occur under one SQLite write reservation.
 * The synchronous callback checks the ordinary runtime/terminal gates and existing admitted input.
 * A claim only enqueues. The ordinary pump owns the physical write and its receipts. */
export function claimReadyBoardWork(store: Store, projectId: string, available: (member: Member) => boolean): Delivery[] {
  return store.transaction(() => {
    const project = store.requireProject(projectId);
    if (project.isHq || project.archived || !project.runnerEnabled || !project.connection.ok) return [];
    const board = store.listWork(projectId);
    const transfers = changedClaims(store, projectId);
    const occupiedCards = new Set(board.filter(w => w.sec !== "next" && !transfers.has(w.id)).map(workTaskId));
    const candidates = board.filter(w => (w.sec === "next" || transfers.has(w.id)) && !occupiedCards.has(workTaskId(w)) && !workerAlreadyAssigned(store, workTaskId(w), transfers.get(w.id)))
      .filter(w => directContract(store, workTaskId(w)) || store.taskSourceRef(workTaskId(w))?.startsWith("main-repair:"));
    if (!candidates.length) return [];
    // Reserve the named worker before allocating interchangeable open cards.
    const pinned = (work: WorkItem) => !!work.who.trim() || !!store.taskSourceRef(workTaskId(work))?.startsWith("main-repair:");
    candidates.sort((a, b) => Number(pinned(b)) - Number(pinned(a)));
    const workers = store.listMembers(projectId).filter(m => standardWorker(m) && !m.executionIssue &&
      !!(m.paneId || m.sessionId) && (m.status === "idle" || m.status === "waiting") && available(m));
    if (!workers.length) return [];

    const facts = store.taskProgressFacts(projectId);
    const sequence = store.taskSequenceSnapshot(projectId, undefined, facts);
    const blockedFamily = new Set([...sequence.suspended.keys(), ...sequence.awaitingOwner.keys(), ...board.filter(w => w.sec === "hold").map(workTaskId)]);
    const pendingInputs = new Set<string>();
    for (const [id, f] of facts) {
      if (f.watch?.trippedAt || f.held.length) blockedFamily.add(id);
      if (f.queued.length && store.hasUnsettledTaskInput(id)) pendingInputs.add(id);
    }
    for (const run of store.listPendingExecutions()) {
      if (run.projectId === projectId && !run.endedAt) {
        for (const id of taskScopeForDeliveryIds(store, run.deliveryIds)) blockedFamily.add(id);
      }
    }
    const closed = new Set(board.filter(w => w.sec === "done").map(workTaskId));
    const deliveries: Delivery[] = [];
    for (const work of candidates) {
      if (!workers.length) break;
      const taskId = workTaskId(work), task = store.getTask(taskId), moving = transfers.get(work.id);
      if (!task || occupiedCards.has(taskId) || task.mergedInto || task.projectId !== projectId || (!moving && store.hasUnsettledTaskInput(task.id))) continue;
      if ([...blockedFamily].some(id => relatedWork(task.id, id, sequence.byId))) continue;
      if ([...pendingInputs].some(id => id !== moving?.taskId && relatedWork(task.id, id, sequence.byId))) continue;
      if (!openLineage(store, task, closed) || store.pendingTaskIntervention(task.id) || store.pendingTaskFailureDecision(task.id)) continue;
      const f = facts.get(task.id);
      if (f?.finalReview || f?.reports.some(r => r.authorKind === "worker" && ["완료", "진행", "막힘"].includes(r.kind)) ||
        f?.marks.some(m => ["review", "merged", "applied"].includes(m.stage))) continue;
      const ref = store.taskSourceRef(task.id);
      // The integration scheduler binds these to the exact reviewed commit and author.
      if (ref?.startsWith("reviewed-main:") || ref?.startsWith("independent-review-repair:")) continue;
      const binding = reviewedRepairSource(store, work);
      if (binding.status === "blocked") continue;
      if (binding.status === "ready" && !moving) prepareReviewedRepair(store, work, binding);
      const author = binding.status === "ready" ? binding.authorId : null;
      const contract = directContract(store, task.id);
      if (!contract) continue;
      const named = namedRecipient(store, projectId, work.who);
      const choices = workers.map(member => ({ member, score: fit(member, work, task, contract, author, named) }))
        .filter(c => c.score >= 0 && !store.taskSequenceBlocker(c.member.id, task.id, sequence))
        .sort((a, b) => b.score - a.score);
      const recipient = choices[0]?.member;
      if (!recipient) continue;
      const message = store.createMessage({ id: claimMessagePrefix + work.id + "." + task.id + (moving ? "." + randomUUID() : ""),
        projectId, taskId, mine: false, kind: "시스템", who: "시스템", targetMemberId: recipient.id, targetName: recipient.name,
        title: work.title + " 배정", body: `진행판에서 ${recipient.name}에게 배정했습니다. 업무 #${task.id} · 계약 r${contract.rev}` });
      const text = [`진행판 업무 #${task.id} · ${work.title}`, work.detail,
        `task_trace에서 업무 #${task.id}의 최신 지시와 근거를 확인하고 이번 실행의 확정 계약에 따라 수행하세요.`].filter(Boolean).join("\n");
      deliveries.push(moving ? store.moveBoardClaim(moving, recipient.id, message.id, text) :
        store.enqueue({ projectId, taskId, memberId: recipient.id, kind: "instruction", refType: "message", refId: message.id, text }));
      store.upsertWork({ ...work, sec: "doing", who: recipient.name });
      occupiedCards.add(task.id);
      blockedFamily.add(task.id);
      workers.splice(workers.indexOf(recipient), 1);
    }
    return deliveries;
  }, "immediate");
}

/** Ordinary deliveries keep their existing admission rules. A held claim can resume on
 * the same receipt. The pump appends the current contract and checks its revision again at write time. */
export function sharedWorkAllowsDelivery(store: Store, delivery: Delivery): boolean {
  if (delivery.kind !== "instruction" || delivery.refType !== "message" || !delivery.refId?.startsWith(claimMessagePrefix)) return true;
  const [workId, claimedTask] = delivery.refId.slice(claimMessagePrefix.length).split(".");
  const work = workId ? store.getWork(workId) : null;
  const worker = store.getMember(delivery.memberId), task = delivery.taskId ? store.getTask(delivery.taskId) : null;
  if (!worker || !standardWorker(worker) || !task || task.mergedInto || store.doneMark(task.id) || !work ||
      work.projectId !== delivery.projectId || workTaskId(work) !== task.id || claimedTask !== task.id ||
      !["next", "doing"].includes(work.sec) || !directContract(store, task.id)) return false;
  const binding = reviewedRepairSource(store, work);
  if (binding.status === "blocked" || (binding.status === "ready" && binding.authorId !== worker.id)) return false;
  const message = store.getMessage(delivery.refId);
  if (!message || message.mine || message.kind !== "시스템" || message.targetMemberId !== worker.id || message.taskId !== task.id) return false;
  const current = store.getDelivery(delivery.id);
  if (current?.memberId !== worker.id || current.refId !== delivery.refId) return false;
  const named = namedRecipient(store, work.projectId, work.who);
  if (work.who.trim() && !matchesRecipient(worker, work.who, named) && (named || work.who !== message.targetName)) return false;
  const closedCards = new Set(store.listWork(work.projectId).filter(item => item.sec === "done" || item.sec === "hold").map(workTaskId));
  return openLineage(store, task, closedCards);
}
