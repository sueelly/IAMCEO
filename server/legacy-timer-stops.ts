import { untouchedQueuedInput } from "./review-routing.ts";
import type { Store } from "./store.ts";
import type { WatchFact } from "./task-progress.ts";

interface TimerStop {
  task_id: string;
  project_id: string;
  tripped_at: string;
  trip_reason: string;
  notice_delivery_id: string | null;
  v57_recheck: string | null;
}

/** Count only reports made after the timer fired. A third repeated failure
 * while already stopped still needs intervention even if the last report changed. */
function subsequentTimerAttempts(watch: WatchFact, reason: string): number | null {
  const match = /^진척 없이 (0|[1-9]\d*)분\(([1-9]\d*)번 시도\)$/.exec(reason);
  if (!match || match[0] !== reason || !Number.isSafeInteger(Number(match[1]))) return null;
  if (watch.same >= 3 || watch.fingerprint === "continuation:no_progress") return null;
  const subsequent = watch.attempts - Number(match[2]);
  if (!Number.isSafeInteger(subsequent) || subsequent < 0) return null;
  if (subsequent <= 1) return subsequent;
  const needed = Math.min(watch.attempts, subsequent + 2);
  if (watch.history.length < needed) return null;
  const attempts = watch.history.slice(-needed);
  const repeated = attempts.some(({ fingerprint }, i) =>
    i >= 2 && fingerprint === attempts[i - 1]!.fingerprint && fingerprint === attempts[i - 2]!.fingerprint);
  return repeated ? null : subsequent;
}

/** A buggy v57 clear changed only the three active trip fields. Verify its
 * original watch and report timeline before correcting an existing receipt. */
function previouslyCleared(store: Store, stop: TimerStop, watch: WatchFact, subsequent: number): boolean {
  if (watch.trippedAt !== null || watch.reason !== null || !(watch.startedAt <= stop.tripped_at)) return false;
  if (subsequent === 0) {
    if (watch.updatedAt !== stop.tripped_at) return false;
  } else if (watch.updatedAt <= stop.tripped_at || watch.history.at(-1)?.at !== watch.updatedAt ||
      watch.history.filter(report => report.at > stop.tripped_at).length !== subsequent) return false;
  const unchanged = store.db.query(`SELECT 1 FROM task_watch w JOIN tasks t ON t.id=w.task_id AND t.project_id=w.project_id
    WHERE w.task_id=? AND w.project_id=? AND w.notice_delivery_id IS NULL`).get(stop.task_id, stop.project_id);
  if (!unchanged) return false;
  const reopened = store.db.query(`WITH RECURSIVE
    ancestors(id) AS (SELECT ? UNION SELECT t.parent_task_id FROM tasks t JOIN ancestors a ON t.id=a.id WHERE t.parent_task_id IS NOT NULL),
    children(id) AS (SELECT ? UNION SELECT t.id FROM tasks t JOIN children c ON t.parent_task_id=c.id)
    SELECT 1 FROM task_stage_marks WHERE stage='reopen' AND at>=?
      AND (task_id=? OR (at<=? AND task_id IN (SELECT id FROM ancestors UNION SELECT id FROM children))) LIMIT 1`)
    .get(stop.task_id, stop.task_id, stop.tripped_at, stop.task_id, watch.updatedAt);
  return !reopened;
}

function retireUnsentNotice(store: Store, stop: TimerStop): void {
  const id = stop.notice_delivery_id;
  if (!id) return;
  const d = store.getDelivery(id);
  if (!d || d.kind !== "system" || d.projectId !== stop.project_id || d.taskId !== stop.task_id ||
      d.refId || d.refType || !(Date.parse(d.createdAt) >= Date.parse(stop.tripped_at))) return;
  if (!d.text.startsWith(`[시스템] 반복 감시: 업무 #${stop.task_id} '`) ||
      !d.text.includes(`의 막힘이 ${stop.trip_reason}. 이 업무의 자동 반복을 멈췄습니다.`)) return;
  if (!untouchedQueuedInput(store, d) || store.db.query(`SELECT 1 FROM manual_inbox_items WHERE delivery_id=?
      UNION ALL SELECT 1 FROM workflow_assignment_receipts WHERE delivery_id=? LIMIT 1`).get(id, id)) return;
  // Preserve the original envelope. The stopped recovery prevents treating a
  // canceled input as an unconfirmed physical write during a later boot.
  store.updateDeliveryRecovery(id, 1, { phase: "stopped" });
  store.setDeliveryStatus(id, "failed", { wake: false, lastError: "경과 시간에 따른 반복 감시 알림을 전송 전에 취소했습니다." });
}

/** Offline migration snapshots the episodes. The writable host reconciles
 * dispatch evidence before any coordinator starts consuming the queue. */
export function reconcileLegacyTimerStops(store: Store): void {
  if (!store.db.query("SELECT 1 FROM pragma_table_info('legacy_task_timer_stops') WHERE name='v57_recheck'").get()) return;
  const pending = "outcome='pending' OR v57_recheck='pending'";
  if (!store.db.query(`SELECT 1 FROM legacy_task_timer_stops WHERE ${pending} LIMIT 1`).get()) return;
  store.transaction(() => {
    const stops = store.db.query<TimerStop, []>(`SELECT * FROM legacy_task_timer_stops WHERE ${pending}`).all();
    for (const stop of stops) {
      const watch = store.getTaskWatch(stop.task_id);
      const ownerEscalation = store.db.query("SELECT 1 FROM task_failure_escalations WHERE task_id=? AND tripped_at=?")
        .get(stop.task_id, stop.tripped_at);
      const subsequent = watch && subsequentTimerAttempts(watch, stop.trip_reason);
      let released = false;
      if (watch && subsequent !== null && !ownerEscalation) {
        if (stop.v57_recheck === "pending") {
          released = previouslyCleared(store, stop, watch, subsequent);
        } else {
          // .run().changes includes writes made by the completion_changes trigger.
          released = !!store.db.query(`UPDATE task_watch SET tripped_at=NULL,trip_reason=NULL,notice_delivery_id=NULL
            WHERE task_id=? AND project_id=? AND tripped_at=? AND trip_reason=? AND notice_delivery_id IS ?
            RETURNING task_id`).get(stop.task_id, stop.project_id, stop.tripped_at, stop.trip_reason, stop.notice_delivery_id);
        }
      }
      if (released) retireUnsentNotice(store, stop);
      store.db.query(`UPDATE legacy_task_timer_stops SET outcome=?,
        v57_recheck=CASE WHEN v57_recheck='pending' THEN ? ELSE v57_recheck END WHERE task_id=?`)
        .run(released ? "released" : "retained", released ? "verified" : "unchanged", stop.task_id);
    }
  }, "immediate");
}
