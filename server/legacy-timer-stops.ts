import { untouchedQueuedInput } from "./review-routing.ts";
import type { Store } from "./store.ts";
import type { WatchFact } from "./task-progress.ts";

interface TimerStop {
  task_id: string;
  project_id: string;
  tripped_at: string;
  trip_reason: string;
  notice_delivery_id: string | null;
}

function timerOnly(watch: WatchFact, reason: string): boolean {
  const match = /^진척 없이 (0|[1-9]\d*)분\(([1-9]\d*)번 시도\)$/.exec(reason);
  if (!match || match[0] !== reason || !Number.isSafeInteger(Number(match[1]))) return false;
  if (watch.same >= 3 || watch.fingerprint === "continuation:no_progress") return false;
  const subsequent = watch.attempts - Number(match[2]);
  if (!Number.isSafeInteger(subsequent) || subsequent < 0) return false;
  // While tripped, the old watch counted new reports without replacing its reason.
  // A third identical failure followed by a different report must remain stopped.
  if (subsequent <= 1) return true;
  const needed = Math.min(watch.attempts, subsequent + 2);
  if (watch.history.length < needed) return false;
  const attempts = watch.history.slice(-needed);
  return !attempts.some(({ fingerprint }, i) =>
    i >= 2 && fingerprint === attempts[i - 1]!.fingerprint && fingerprint === attempts[i - 2]!.fingerprint);
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
  if (!store.db.query("SELECT 1 FROM sqlite_schema WHERE name='legacy_task_timer_stops'").get()) return;
  if (!store.db.query("SELECT 1 FROM legacy_task_timer_stops WHERE outcome='pending' LIMIT 1").get()) return;
  store.transaction(() => {
    const stops = store.db.query<TimerStop, []>("SELECT * FROM legacy_task_timer_stops WHERE outcome='pending'").all();
    for (const stop of stops) {
      const watch = store.getTaskWatch(stop.task_id);
      const ownerEscalation = store.db.query("SELECT 1 FROM task_failure_escalations WHERE task_id=? AND tripped_at=?")
        .get(stop.task_id, stop.tripped_at);
      let released = false;
      if (watch?.trippedAt === stop.tripped_at && watch.reason === stop.trip_reason && !ownerEscalation && timerOnly(watch, stop.trip_reason)) {
        released = store.db.query(`UPDATE task_watch SET tripped_at=NULL,trip_reason=NULL,notice_delivery_id=NULL
          WHERE task_id=? AND project_id=? AND notice_delivery_id IS ?`).run(stop.task_id, stop.project_id, stop.notice_delivery_id).changes === 1;
      }
      if (released) retireUnsentNotice(store, stop);
      store.db.query("UPDATE legacy_task_timer_stops SET outcome=? WHERE task_id=?").run(released ? "released" : "retained", stop.task_id);
    }
  }, "immediate");
}
