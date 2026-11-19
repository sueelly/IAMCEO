import type { OwnerCommandMilestone } from "../shared/owner-commands.ts";
import type { Store } from "./store.ts";

interface MainReceipt { id: string; at: string; who: string; base: string; mainSha: string; source: string }
interface AppliedMark { id: number; at: string; who: string; evidence: string }

export function commandMilestones(store: Store, projectId: string, taskIds: string[], commandId: string | null): OwnerCommandMilestone[] {
  const milestones: OwnerCommandMilestone[] = [];
  for (const taskId of taskIds) {
    const reopened = store.db.query<{id:number},[string,string]>(`SELECT COALESCE(MAX(id),0) AS id FROM task_stage_marks
      WHERE project_id=? AND task_id=? AND stage='reopen'`).get(projectId,taskId)!.id;
    // The source completion and the integration report are paired by the existing verified remote-push receipt.
    const receipt = store.db.query<MainReceipt, [string,string,string,number,string|null,string|null]>(`SELECT m.id,m.at,m.who,r.main_base AS base,r.main_commit AS mainSha,r.report_id AS source
      FROM task_completion_reviews r JOIN messages m ON m.id=r.integration_report_id AND m.project_id=?
      JOIN messages src ON src.id=r.report_id AND src.project_id=m.project_id AND src.task_id=r.task_id
      WHERE r.task_id=? AND r.report_id=(SELECT report_id FROM task_completion_reviews WHERE task_id=? ORDER BY mark_id DESC,completed_at DESC,rowid DESC LIMIT 1)
        AND r.mark_id>? AND r.status='confirmed' AND r.main_base IS NOT NULL AND r.main_commit IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM report_references corr WHERE corr.project_id=m.project_id AND corr.corrects_message_id IN (r.report_id,m.id))
        AND (? IS NULL OR EXISTS(SELECT 1 FROM owner_command_evidence e WHERE e.command_id=? AND e.ref_type='message' AND e.ref_id IN (src.id,m.id)))`)
      .get(projectId,taskId,taskId,reopened,commandId,commandId);
    if (receipt && [receipt.base,receipt.mainSha].every(sha => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha))) {
      milestones.push({ kind: "main", at: receipt.at, actor: receipt.who, evidence: `기준 ${receipt.base} → 원격 main ${receipt.mainSha}`,
        messageId: receipt.id, fileIds: [], commit: receipt.mainSha });
    }
    // An applied stage is a staff attestation. Surface it only alongside an actual task-scoped report or file.
    const mark = store.db.query<AppliedMark,[string,string,number]>(`SELECT id,at,who,evidence FROM task_stage_marks
      WHERE project_id=? AND task_id=? AND stage='applied' AND id>? ORDER BY id DESC LIMIT 1`).get(projectId,taskId,reopened);
    if (!mark) continue;
    const ids = [...new Set(mark.evidence.match(/\b(?:msg_|f_)[A-Za-z0-9_-]+\b/g) ?? [])].slice(0,30);
    if (!ids.length) continue;
    const files: string[] = [], reports: string[] = [];
    let attributable = commandId === null || !!store.db.query(`SELECT 1 FROM owner_command_evidence WHERE command_id=? AND ref_type='stage' AND ref_id=?`)
      .get(commandId,String(mark.id));
    for (const id of ids) {
      if (id.startsWith("msg_")) {
        const msg = store.db.query("SELECT 1 FROM messages WHERE project_id=? AND task_id=? AND id=? AND mine=0").get(projectId,taskId,id);
        if (!msg) continue;
        reports.push(id);
        attributable ||= !!store.db.query("SELECT 1 FROM owner_command_evidence WHERE command_id=? AND ref_type='message' AND ref_id=?").get(commandId,id);
      } else {
        if (!store.db.query("SELECT 1 FROM files WHERE project_id=? AND task_id=? AND id=?").get(projectId,taskId,id)) continue;
        files.push(id);
        attributable ||= !!store.db.query(`SELECT 1 FROM owner_command_evidence e JOIN messages m ON m.id=e.ref_id AND m.project_id=?
          LEFT JOIN report_references r ON r.source_message_id=m.id AND r.project_id=m.project_id
          WHERE e.command_id=? AND e.ref_type='message' AND m.task_id=? AND (m.file_id=? OR ? IN (SELECT value FROM json_each(r.file_ids_json))) LIMIT 1`)
          .get(projectId,commandId,taskId,id,id);
      }
    }
    if (attributable && (files.length || reports.length)) milestones.push({ kind: "application", at: mark.at, actor: mark.who,
      evidence: mark.evidence, messageId: reports[0] ?? null, fileIds: files, commit: null });
  }
  return milestones.sort((a,b) => a.at.localeCompare(b.at));
}
