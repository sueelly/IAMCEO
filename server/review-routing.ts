import type { Delivery, Member } from "../shared/types.ts";
import type { CompletionReviewRow } from "./task-completion.ts";
import { relatedWork } from "./workflow.ts";
import type { Store } from "./store.ts";

/** A healthy busy reviewer, offline worker, native prompt, or human's terminal lease
 * is not a reason to dispatch a review twice. These are delivery-confirmation fences. */
export function reviewFence(store: Store, memberId: string) {
  return store.db.query<{ id: string; task_id: string | null }, [string]>(`SELECT d.id,d.task_id
    FROM deliveries d LEFT JOIN delivery_recovery r ON r.delivery_id=d.id WHERE d.member_id=? AND
    (r.delivery_id IS NULL OR r.phase NOT IN ('none','resolved','stopped') OR
     (r.phase='none' AND (d.status='delivering' OR (d.status='held' AND d.hold_reason='delivery_unknown'))) OR
     EXISTS(SELECT 1 FROM delivery_dispatch_items i JOIN delivery_dispatches p ON p.id=i.dispatch_id
       WHERE i.delivery_id=d.id AND p.transport_state IN ('prepared','write_started','unknown')))`).all(memberId);
}

export function protectedReviewScope(store: Store, primary: Member, fence: ReturnType<typeof reviewFence>) {
  const cases = new Set<string>(), reports = new Set<string>(), contracts = new Set<string>();
  let unknown = false;
  for (const d of fence) {
    if (d.task_id) cases.add(d.task_id);
    const rows = store.db.query<CompletionReviewRow,[string]>("SELECT * FROM task_completion_reviews WHERE delivery_id=?").all(d.id);
    if (!rows.length && !d.task_id) unknown = true;
    for (const row of rows) { cases.add(row.task_id); contracts.add(row.contract_task_id); reports.add(row.report_id); }
  }
  const parents = store.db.query<{id: string; parentTaskId: string | null}, [string]>(
    "SELECT id,parent_task_id AS parentTaskId FROM tasks WHERE project_id=?").all(primary.projectId);
  const tasks = new Map(parents.map(task => [task.id, task]));
  return (row: CompletionReviewRow) => !unknown && !reports.has(row.report_id) && !contracts.has(row.contract_task_id) &&
    ![...cases].some(id => relatedWork(id,row.task_id,tasks));
}

export function disjointFromFence(store: Store, member: Member | null) {
  if (!member) return null;
  const fences = reviewFence(store, member.id);
  return fences.length ? protectedReviewScope(store, member, fences) : null;
}

export function oppositeReviewScope(store: Store, member: Member) {
  const other = member.standbyReviewer ? store.getFinalReviewer(member.projectId) : store.getStandbyReviewer(member.projectId);
  return disjointFromFence(store, other);
}

/** Only the server-minted identities qualify. The current review delivery binds a
 * standby to one exact report. Legacy unassigned/old conductor notices stay primary. */
export function assignedReviewMember(store: Store, member: Member, review: CompletionReviewRow | null): boolean {
  if (!member.finalReviewer || !review || store.getTask(review.task_id)?.projectId !== member.projectId) return false;
  if (review.status !== "pending" && review.reviewer_id) return review.reviewer_id === member.id;
  const d = review.delivery_id ? store.getDelivery(review.delivery_id) : null;
  if (d && d.projectId === member.projectId && d.kind === "system" && store.getMember(d.memberId)?.finalReviewer) {
    if (d.memberId !== member.id) return false;
    if (d.status !== "queued") return true;
    const other = oppositeReviewScope(store, member);
    return !other || other(review) || !untouchedReviewBatch(store, d);
  }
  if (store.getFinalReviewer(member.projectId)?.id !== member.id) return false;
  const other = oppositeReviewScope(store, member);
  return !other || other(review);
}

export function mayReadReviewReport(store: Store, member: Member, reportId: string) {
  const rows = store.db.query<CompletionReviewRow,[string,string]>(`SELECT * FROM task_completion_reviews
    WHERE report_id=? OR integration_report_id=?`).all(reportId,reportId);
  return rows.some(row => assignedReviewMember(store, member, row) &&
    store.db.query<{ report_id:string },[string]>("SELECT report_id FROM task_completion_reviews WHERE task_id=? ORDER BY rowid DESC LIMIT 1").get(row.task_id)?.report_id === row.report_id);
}

export function untouchedReviewBatch(store: Store, delivery: Delivery): boolean {
  return !delivery.refId && !delivery.refType && untouchedQueuedInput(store, delivery);
}

export function untouchedQueuedInput(store: Store, delivery: Delivery): boolean {
  if (delivery.status !== "queued" || !delivery.wake || delivery.attempts || delivery.deliveredAt || delivery.holdReason ||
      delivery.lastError || delivery.nextAttemptAt) return false;
  const r = store.getDeliveryRecovery(delivery.id), retry = store.getDeliveryRetry(delivery.id);
  if (!r || r.phase !== "none" || r.version !== 1 || r.activeCheckMs || r.nextCheckAt || r.lastCheckedAt || r.marker || r.autoAttempts || r.checkCount || r.reason || r.evidence.length ||
      retry.retryReason || retry.sourceRevision || retry.correctionRevision || retry.retryScope) return false;
  if (store.listDeliveryDispatches(delivery.id).length ||
      store.db.query("SELECT 1 FROM delivery_recovery_operations WHERE delivery_id=? LIMIT 1").get(delivery.id)) return false;
  return !store.db.query(`SELECT 1 FROM execution_journal e,json_each(e.delivery_ids_json) j WHERE e.member_id=? AND j.value=?
    UNION ALL SELECT 1 FROM lifecycle_journal c,json_each(c.delivery_ids_json) j WHERE c.member_id=? AND j.value=? LIMIT 1`)
    .get(delivery.memberId,delivery.id,delivery.memberId,delivery.id);
}

/** Older schedulers kept only the newest delivery_id and did not count an earlier
 * delivery. Do this lookup only for zero-count restored cases behind a fence. */
export function previousLegacyReviewAttempt(store: Store, row: CompletionReviewRow, delivery: Delivery): boolean {
  if (row.review_dispatch_count !== 0) return false;
  return !!store.db.query(`SELECT 1 FROM deliveries d WHERE d.project_id=? AND d.rowid<(SELECT rowid FROM deliveries WHERE id=?)
    AND d.kind='system' AND d.text LIKE '[시스템] 비동기 최종 확인:%'
    AND (d.task_id=? OR instr(d.text,?)>0) AND instr(d.text,?)>0 AND (
      d.attempts>0 OR d.delivered_at IS NOT NULL OR d.status IN ('delivered','delivering')
      OR d.hold_reason='delivery_unknown' OR EXISTS(SELECT 1 FROM delivery_dispatch_items i WHERE i.delivery_id=d.id)
      OR EXISTS(SELECT 1 FROM delivery_recovery r WHERE r.delivery_id=d.id AND (r.phase<>'none' OR r.marker IS NOT NULL))
      OR EXISTS(SELECT 1 FROM execution_journal e, json_each(e.delivery_ids_json) j WHERE e.member_id=d.member_id AND j.value=d.id)
    ) LIMIT 1`).get(delivery.projectId,delivery.id,row.task_id,"#"+row.task_id,"#"+row.report_id);
}
