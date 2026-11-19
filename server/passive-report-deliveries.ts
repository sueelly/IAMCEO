import { parseOwnerLine } from "../shared/owner-lines.ts";
import { untouchedQueuedInput } from "./review-routing.ts";
import type { Store } from "./store.ts";

/** Retire a legacy terminal copy only while both its author and its untouched
 * transport can be identified. The original post and the canceled envelope remain readable. */
export function retirePassiveReports(store: Store): void {
  if (!store.db.query("SELECT 1 FROM pragma_table_info('report_references') WHERE name='board_only'").get()) return;
  store.transaction(() => {
    const copies = store.db.query<{id: string; messageId: string; body: string}, []>(`SELECT d.id,m.id AS messageId,m.body
      FROM deliveries d JOIN members lead ON lead.id=d.member_id AND lead.project_id=d.project_id AND lead.kind='conductor'
      JOIN messages m ON m.id=d.ref_id AND m.project_id=d.project_id AND m.mine=0 AND m.kind IN ('알림','진행')
      JOIN members author ON author.id=m.member_id AND author.kind='worker' AND author.project_id=m.project_id
      JOIN report_references r ON r.source_message_id=m.id AND r.project_id=m.project_id
      LEFT JOIN report_harness h ON h.message_id=m.id
      WHERE d.kind='report' AND d.ref_type='message' AND d.status='queued' AND d.wake=0 AND d.attempts=0
        AND d.urgent=0 AND m.decision_id IS NULL AND m.file_id IS NULL AND m.about_message_id IS NULL
        AND r.corrects_message_id IS NULL AND r.file_ids_json='[]' AND r.decision_ids_json='[]'
        AND COALESCE(h.review_needed,'')='' AND NOT EXISTS(SELECT 1 FROM manual_inbox_items i WHERE i.delivery_id=d.id)
        AND NOT EXISTS(SELECT 1 FROM workflow_assignment_receipts a WHERE a.delivery_id=d.id)`).all();
    for (const copy of copies) {
      if (parseOwnerLine(copy.body) || !untouchedQueuedInput(store, store.requireDelivery(copy.id), false)) continue;
      store.db.query("UPDATE report_references SET board_only=1 WHERE source_message_id=?").run(copy.messageId);
      store.updateDeliveryRecovery(copy.id, 1, { phase: "stopped" });
      store.setDeliveryStatus(copy.id, "failed", { lastError: "업무 대화에 게시된 진행 알림의 총괄 사본을 전송 전에 정리했습니다." });
    }
  }, "immediate");
}
