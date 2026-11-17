import type { Delivery, Member } from "../shared/types.ts";
import { bindingContract, missingExecutionContractFields } from "./harness.ts";
import { ApiError, type Store } from "./store.ts";
import { activeTaskContinuationPauses } from "./task-continuation.ts";
import { latestWorkerOutcome, type MarkFact } from "./task-progress.ts";

interface CompletionReviewRow {
  report_id: string; task_id: string; contract_task_id: string; contract_rev: number;
  mark_id: number; status: "pending" | "confirmed" | "changes_requested";
  reviewed_at: string | null; completed_at: string; reviewer_id: string | null; evidence: string | null; delivery_id: string | null;
  reviewed_branch: string | null; reviewed_commit: string | null;
  evidence_reader_id: string | null;
}

export function latestCompletionReview(store: Store, taskId: string): CompletionReviewRow | null {
  return store.db.query<CompletionReviewRow, [string]>("SELECT * FROM task_completion_reviews WHERE task_id=? ORDER BY rowid DESC LIMIT 1").get(taskId);
}

function completionFamily(store: Store, taskId: string): string[] {
  return (store.db.query(`WITH RECURSIVE family(id) AS (
    SELECT id FROM tasks WHERE id=? UNION SELECT t.id FROM tasks t JOIN family f ON t.parent_task_id=f.id WHERE t.merged_into IS NULL
  ) SELECT f.id FROM family f WHERE f.id=? OR EXISTS(SELECT 1 FROM task_sequence q WHERE q.task_id=f.id) OR EXISTS(SELECT 1 FROM report_harness h WHERE h.task_id=f.id)`).all(taskId, taskId) as { id: string }[]).map(r => r.id);
}

/** A passing report releases execution; final review is a separate durable duty.
 * Re-evaluate existing automatic marks too, so later blockers cannot be approved. */
export function synchronizeTaskCompletion(store: Store, taskId: string, visiting = new Set<string>()): boolean {
  if (visiting.has(taskId)) return false;
  visiting.add(taskId);
  return store.transaction(() => {
    const task = store.requireTask(taskId);
    if (task.mergedInto || store.requireProject(task.projectId).archived) return false;
    const contract = store.getEffectiveContract(taskId);
    const scope = completionFamily(store, taskId);
    for (const id of scope.filter(id => id !== taskId).reverse()) synchronizeTaskCompletion(store, id, visiting);
    const facts = store.taskProgressFacts(task.projectId, new Set(scope));
    const candidates = contract ? new Set(store.completionEvidence(contract.taskId, contract.rev).filter(e => e.status === "passed").map(e => e.messageId)) : new Set<string>();
    const report = [...facts.values()].flatMap(f => f.reports)
      .filter(r => r.authorKind === "worker" && candidates.has(r.id)).sort((a, b) => a.seq - b.seq).at(-1);
    let valid = bindingContract(contract) && !missingExecutionContractFields(contract).length && !!report
      && report.passed && !report.failed.length && !report.notRun.length
      && store.getReportHarness(report.id)?.evidenceStatus !== "unsupported";
    const paused = new Set(activeTaskContinuationPauses(store, task.projectId).map(p => p.taskId));
    const previous = latestCompletionReview(store, taskId);
    // Stopping an independent review suspends delivery without generating a reopen that lifts the stop.
    if (previous && store.doneMark(taskId)?.id === previous.mark_id && scope.some(id => paused.has(id))) return false;
    for (const id of scope) {
      const f = facts.get(id);
      if (paused.has(id) || f?.decisions.length || f?.todos.length || f?.approvals.length || f?.watch?.trippedAt || store.hasUnsettledTaskInput(id)
        || f?.marks.at(-1)?.stage === "hold" || id !== taskId && !store.doneMark(id)) valid = false;
      const last = latestWorkerOutcome(f);
      if (last && (last.kind === "막힘" || last.continuesWork || !last.passed || last.failed.length || last.notRun.length)) valid = false;
    }
    if (previous && store.doneMark(taskId)?.id === previous.mark_id &&
      (!valid || previous.contract_task_id !== contract?.taskId || previous.contract_rev !== contract?.rev || previous.report_id !== report?.id)) {
      requestCompletionChanges(store, taskId, "완료 근거·업무 계약·차단 조건이 변경되어 남은 조건을 다시 확인합니다");
    }
    if (!valid || store.doneMark(taskId) || previous?.report_id === report!.id) return false;
    const mark = store.addStageMark({ projectId: task.projectId, taskId, stage: "done", memberId: null, who: "하네스",
      evidence: `계약 r${contract!.rev} 완료 조건 통과 · 보고 #${report!.id} · 독립 최종 검수 대기` });
    store.db.query(`INSERT INTO task_completion_reviews
      (report_id,task_id,contract_task_id,contract_rev,mark_id,status,completed_at) VALUES(?,?,?,?,?,'pending',?)`)
      .run(report!.id, taskId, contract!.taskId, contract!.rev, mark.id, mark.at);
    store.createTaskNotice(task.projectId, taskId, mark.id, [task.title + " 수행 완료", `계약 r${contract!.rev}의 완료 조건을 통과했습니다`, "최종 검수 직원이 확인할 예정입니다. 일반 후속 업무는 진행합니다"]);
    return true;
  });
}

/** An inherited report can release its original obligation in the same event. */
export function synchronizeRelatedTaskCompletion(store: Store, taskId: string): void {
  const seen = new Set<string>();
  let id: string | null = taskId;
  while (id && !seen.has(id)) {
    seen.add(id);
    synchronizeTaskCompletion(store, id);
    id = store.requireTask(id).parentTaskId ?? null;
  }
}

function retireReminder(store: Store, review: CompletionReviewRow): void {
  if (!review.delivery_id) return;
  const d = store.getDelivery(review.delivery_id);
  if (d && d.kind === "system" && ["queued", "held"].includes(d.status) && !d.attempts && !store.listDeliveryDispatches(d.id).length)
    store.markFailed(d.id, "최종 확인 상태가 바뀌어 이 알림을 종료합니다");
}

export function requestCompletionChanges(store: Store, taskId: string, evidence: string, member?: Member): MarkFact | null {
  const review = latestCompletionReview(store, taskId);
  if (!review || review.status === "changes_requested") return null;
  const task = store.requireTask(taskId);
  store.db.query("UPDATE task_completion_reviews SET status='changes_requested',reviewed_at=?,evidence=? WHERE task_id=? AND report_id=?")
    .run(new Date().toISOString(), evidence, taskId, review.report_id);
  retireReminder(store, review);
  store.queueProgress([taskId]);
  return store.doneMark(taskId)?.id === review.mark_id
    ? store.addStageMark({ projectId: task.projectId, taskId, stage: "reopen", evidence, memberId: member?.id ?? null, who: member?.name ?? "하네스" }) : null;
}

export function confirmCompletionReview(store: Store, taskId: string, member: Member, evidence: string,
  gitReview?: { branch: string; commit: string }): boolean {
  const review = latestCompletionReview(store, taskId);
  if (!review) return false;
  synchronizeTaskCompletion(store, taskId);
  if (store.doneMark(taskId)?.id !== review.mark_id) throw new ApiError(409, "완료 근거가 변경되었습니다. 남은 조건과 최신 검사 결과를 확인하세요");
  if (gitReview) {
    const artifact = store.getReportHarness(review.report_id);
    if (artifact?.artifactBranch !== gitReview.branch || artifact.artifactCommit !== gitReview.commit) {
      throw new ApiError(409, "같은 작업 브랜치와 커밋에서 검사한 직원 완료 보고가 필요합니다");
    }
  }
  if (review.status === "confirmed" && (!gitReview || review.reviewed_commit)) return true;
  store.db.query(`UPDATE task_completion_reviews SET status='confirmed',reviewed_at=?,reviewer_id=?,evidence=?,
      reviewed_branch=?,reviewed_commit=? WHERE task_id=? AND report_id=?`)
    .run(new Date().toISOString(), member.id, evidence, gitReview?.branch ?? null, gitReview?.commit ?? null, taskId, review.report_id);
  retireReminder(store, review);
  store.queueProgress([taskId]);
  return true;
}

const reviewPrefix = "[시스템] 비동기 최종 확인: ";

export function completionReviewPaused(store: Store, projectId: string, taskId: string): boolean {
  const pauses = activeTaskContinuationPauses(store, projectId);
  if (!pauses.length) return false;
  const scope = new Set(completionFamily(store, taskId));
  return pauses.some(pause => scope.has(pause.taskId));
}

export function isCompletionReviewDelivery(delivery: Delivery): boolean {
  return delivery.kind === "system" && delivery.text.startsWith(reviewPrefix);
}

export function completionReviewAllowsDelivery(store: Store, delivery: Delivery, recipient = store.getMember(delivery.memberId)): boolean {
  if (!isCompletionReviewDelivery(delivery)) return !recipient?.finalReviewer;
  const row = store.db.query<CompletionReviewRow, [string]>("SELECT * FROM task_completion_reviews WHERE delivery_id=?").get(delivery.id);
  return !!row && row.status === "pending" && recipient?.finalReviewer === true &&
    store.doneMark(row.task_id)?.id === row.mark_id &&
    !completionReviewPaused(store, delivery.projectId, row.task_id);
}

/** At most one outstanding reminder per current review. Do not replay an old lead's delivery. */
export function checkCompletionReviews(store: Store, now: number, intervalMs: number): Delivery[] {
  return store.transaction(() => {
    const out: Delivery[] = [];
    const reviews = store.db.query<CompletionReviewRow, []>("SELECT * FROM task_completion_reviews WHERE status='pending' ORDER BY rowid").all();
    const running = new Set(store.listPendingExecutions().flatMap(run => run.deliveryIds));
    for (const review of reviews) {
      const task = store.requireTask(review.task_id), project = store.requireProject(task.projectId);
      if (project.archived || !project.runnerEnabled || task.mergedInto || completionReviewPaused(store, project.id, task.id)) continue;
      if (store.doneMark(task.id)?.id !== review.mark_id) continue;
      const reviewer = store.getFinalReviewer(project.id);
      if (!reviewer) continue;
      const last = review.delivery_id ? store.getDelivery(review.delivery_id) : null;
      const recovery = last && store.getDeliveryRecovery(last.id);
      if (last && (last.status === "delivering" || running.has(last.id) ||
        recovery && !["none", "resolved"].includes(recovery.phase))) continue;
      if (last?.memberId === reviewer.id) {
        if (["queued", "held"].includes(last.status)) continue;
      } else if (last) {
        retireReminder(store, review);
      }
      const checkedAt = last?.memberId === reviewer.id ? last.deliveredAt ?? last.createdAt : review.completed_at;
      if (now - Date.parse(checkedAt) < intervalMs) continue;
      const delivery = store.enqueue({ projectId: project.id, memberId: reviewer.id, taskId: task.id, kind: "system", wake: true,
        text: `${reviewPrefix}#${task.id} '${task.title}'\n계약 #${review.contract_task_id} r${review.contract_rev} · 통과 보고 #${review.report_id}\ntask_review_evidence에서 계약, 보고와 검사 근거를 대조한 뒤 task_review로 검수 결과를 남기세요. 이 업무의 작업 브랜치를 확인했다면 읽은 커밋의 전체 SHA를 reviewed_commit에 적습니다. 문제가 있으면 changes_requested와 해당 부분의 수정 업무 이름을 적으세요.` });
      store.db.query("UPDATE task_completion_reviews SET delivery_id=? WHERE task_id=? AND report_id=?").run(delivery.id, task.id, review.report_id);
      out.push(delivery);
    }
    return out;
  });
}
