import { parseOwnerLine } from "../shared/owner-lines.ts";
import type { Delivery } from "../shared/types.ts";
import { hasNoInputHistory, untouchedQueuedInput } from "./review-routing.ts";
import type { Store } from "./store.ts";

interface Repair {
  issue: string;
  report: string;
  reviewer: string;
  sourceTitle: string;
  repairId: string;
  repairTitle: string;
}

/** A review finding gets its own repair task. A request to assign it is
 * obsolete only once the named task actually has a worker instruction. */
function assignedRepair(store: Store, projectId: string, column: "issue.id" | "repair.id", id: string): Repair | null {
  return store.db.query<Repair, [string, string]>(`SELECT issue.id AS issue, report.id AS report,
      reviewer.name AS reviewer, source.title AS sourceTitle, repair.id AS repairId, issue.title AS repairTitle
    FROM messages issue JOIN messages report ON report.id=issue.about_message_id AND report.project_id=issue.project_id
      AND report.task_id=issue.task_id AND report.kind='완료' AND report.mine=0
    JOIN tasks source ON source.id=report.task_id AND source.project_id=report.project_id
    JOIN task_completion_reviews r ON r.report_id=report.id AND r.task_id=source.id AND r.reviewer_id=issue.member_id
      AND r.status IN ('confirmed','changes_requested')
    JOIN members reviewer ON reviewer.id=issue.member_id AND reviewer.project_id=source.project_id AND reviewer.kind='worker'
    JOIN tasks repair ON repair.project_id=source.project_id AND repair.source_ref IN
      ('main-repair:'||source.id||':'||issue.id, 'independent-review-repair:'||report.id)
    WHERE issue.project_id=? AND ${column}=? AND issue.kind='알림' AND issue.mine=0 AND EXISTS(
      SELECT 1 FROM deliveries i JOIN members worker ON worker.id=i.member_id AND worker.kind='worker'
        AND worker.project_id=i.project_id WHERE i.task_id=repair.id AND i.project_id=repair.project_id
        AND i.kind='instruction' AND i.status='delivered') LIMIT 1`).get(projectId, id);
}

function redundantSystemNotice(store: Store, d: Delivery): string | null {
  if (d.refType || d.refId) return null;
  const text = d.text, projectId = d.projectId;
  if (!d.wake && text.startsWith("[시스템] 대표가 ")) {
    const id = /에게 직접 지시했습니다 #([^\s(]+)/.exec(text)?.[1];
    const msg = id && store.getMessage(id);
    if (!msg || !msg.mine || msg.projectId !== projectId || !msg.targetMemberId || msg.taskId !== d.taskId) return null;
    const worker = store.getMember(msg.targetMemberId);
    const task = d.taskId ? store.getTask(d.taskId) : null;
    if (!worker || worker.projectId !== projectId || worker.kind !== "worker" || (task && task.projectId !== projectId)) return null;
    const name = msg.targetName ?? worker.name;
    const original = store.db.query(`SELECT 1 FROM deliveries WHERE kind='user_message' AND ref_type='message'
      AND ref_id=? AND project_id=? AND member_id=? AND status='delivered'`).get(msg.id, projectId, worker.id);
    const expected = `[시스템] 대표가 ${name}에게 직접 지시했습니다 #${msg.id}${task ? `(작업 #${task.id} '${task.title}')` : ""}. 이미 ${name}에게 전달했습니다. 같은 일을 다시 시키지 말고, 결과 보고를 기다려 판만 맞추세요.`;
    return text === expected && original ? "담당자가 대표 지시를 수신했습니다." : null;
  }
  if (!d.wake && d.taskId && text.endsWith("를 독립 검수했습니다.")) {
    const id = /의 최신 완료 보고 #([^\s]+)를 독립 검수했습니다\.$/.exec(text)?.[1];
    const record = id && store.db.query<{ title: string; name: string }, [string,string,string]>(`SELECT t.title,m.name
      FROM task_completion_reviews r JOIN tasks t ON t.id=r.task_id
      JOIN members m ON m.id=r.reviewer_id AND m.project_id=t.project_id
      JOIN messages report ON report.id=r.report_id AND report.task_id=t.id AND report.project_id=t.project_id
      WHERE t.project_id=? AND t.id=? AND r.report_id=? AND r.status='confirmed' AND r.reviewed_at IS NOT NULL`).get(projectId,d.taskId,id);
    if (record && text === `[시스템] ${record.name}가 '${record.title}'의 최신 완료 보고 #${id}를 독립 검수했습니다.`) return "독립 검수 판정이 업무에 기록됐습니다.";
  }
  if (d.taskId && (text.includes("예정 업무 #") || text.includes("수정 업무 #"))) {
    const r = assignedRepair(store, projectId, "repair.id", d.taskId);
    if (r) {
      const heading = `[시스템] ${r.reviewer}가 '${r.sourceTitle}'`;
      const assigned = `${heading}의 완료 보고 #${r.report}에서 결함을 확인하고 수정 업무에 연결했습니다. 수정 업무 #${r.repairId} '${r.repairTitle}'를 원 담당자에게 전달했습니다.`;
      const request = `${heading}에서 수정할 부분을 확인했습니다. 문제 보고 #${r.issue}를 확인해 주세요. 예정 업무 #${r.repairId} '${r.repairTitle}'을 승인 범위에 맞는 직원에게 맡기세요.`;
      if (d.wake ? text === request : text === assigned) return "담당자가 연결된 수정 업무를 수신했습니다.";
    }
  }
  if (obsoleteTimer(store, d)) return "중단 이후 업무가 재개됐고 해당 감시 중단이 해제됐습니다.";
  if (!d.wake && !d.taskId && /^\[시스템\] 깨어 있는 직원이 \d+명으로 상한 \d+명을 넘었습니다\. (잠재울 후보\(오래된 순\): [^\n]+|지금 잠재울 수 있는 직원이 없습니다)$/.test(text)) {
    const { awake } = store.db.query<{ awake: number }, [string]>(`SELECT count(*) AS awake FROM members
      WHERE project_id=? AND kind='worker' AND origin<>'manual' AND status NOT IN ('offline','asleep')`).get(projectId)!;
    if (awake <= store.getSettings().maxAwakeWorkers) return "현재 깨어 있는 직원이 상한 이내입니다.";
  }
  return null;
}

function obsoleteTimer(store: Store, d: Delivery): boolean {
  if (d.kind !== "system" || !d.wake || !d.taskId || d.refType || d.refId ||
      !d.text.startsWith(`[시스템] 반복 감시: 업무 #${d.taskId} '`)) return false;
  const task = store.getTask(d.taskId), watch = store.getTaskWatch(d.taskId);
  if (task?.projectId !== d.projectId || !watch || watch.trippedAt || watch.reason) return false;
  const prefix = `[시스템] 반복 감시: 업무 #${task.id} '${task.title}'의 막힘이 진척 없이 `;
  const [heading, timeline] = d.text.split("\n", 2);
  return !!heading?.startsWith(prefix) && /^\d+분\(\d+번 시도\)\. 이 업무의 자동 반복을 멈췄습니다\. 같은 실패의 막힘은 더는 총괄을 깨우지 않습니다\.$/.test(heading.slice(prefix.length)) &&
    !!timeline?.startsWith(`- 시작 ${watch.startedAt} · 시도 `) &&
    store.listStageMarks(task.id).some(mark => mark.stage === "reopen" && mark.at > d.createdAt && mark.evidence.trim());
}

/** An old observation without a receipt must stay unknown. Cancel future attempts
 * only when the specific timer episode has already been reopened. */
function stopObsoleteLegacyTimer(store: Store, d: Delivery): void {
  if (!obsoleteTimer(store, d) || d.attempts || d.deliveredAt || d.holdReason || d.nextAttemptAt || d.lastError) return;
  const r = store.getDeliveryRecovery(d.id), retry = store.getDeliveryRetry(d.id);
  if (r?.phase !== "none" || r.marker || r.reason || r.autoAttempts || r.nextCheckAt || !r.checkCount || !r.lastCheckedAt ||
      !r.evidence.length || !r.evidence.every(e => e.source === "transport" && e.verdict === "unknown" && e.code === "legacy_unknown" && e.location === "none" && !e.complete) ||
      retry.retryScope || retry.retryReason || retry.sourceRevision || retry.correctionRevision || !hasNoInputHistory(store, d)) return;
  store.updateDeliveryRecovery(d.id, r.version, { phase: "stopped", nextCheckAt: null });
  store.setDeliveryStatus(d.id, "failed", { wake: false, lastError: "업무가 재개되어 이전 감시 알림의 재전송을 종료했습니다. 과거 수신 여부는 미확정입니다." });
}

/** A command which merely mentions a blocker is insufficient. The same worker
 * must already have acted on it and posted a new, still-actionable report from that run. */
function linkAnsweredBlocker(store: Store, d: Delivery): string | null {
  if (d.kind !== "report" || !d.wake || !d.taskId || d.refType !== "message" || !d.refId) return null;
  const row = store.db.query<{ updated: string; command: string; body: string }, [string,string,string,string]>(`SELECT pending.id AS updated,cmd.id AS command,cmd.body
    FROM messages old JOIN members author ON author.id=old.member_id AND author.kind='worker' AND author.project_id=old.project_id
    JOIN messages cmd ON cmd.mine=1 AND cmd.project_id=old.project_id AND cmd.task_id=old.task_id AND cmd.at>old.at
      AND cmd.target_member_id=old.member_id AND instr(cmd.body,old.id)>0
    JOIN deliveries request ON request.project_id=old.project_id AND request.ref_type='message' AND request.ref_id=cmd.id
      AND request.member_id=old.member_id AND request.kind='user_message' AND request.status='delivered'
    JOIN messages newer ON newer.project_id=old.project_id AND newer.member_id=old.member_id AND newer.task_id=old.task_id
      AND newer.at>cmd.at AND newer.kind='막힘' AND newer.mine=0
    JOIN report_harness h ON h.message_id=newer.id AND h.task_id=newer.task_id AND h.member_id=newer.member_id
    JOIN execution_journal e ON e.run_id=h.run_id AND e.project_id=old.project_id AND e.member_id=old.member_id
      AND e.phase='ended' AND e.result='success' AND EXISTS(SELECT 1 FROM json_each(e.delivery_ids_json) j WHERE j.value=request.id)
    JOIN deliveries pending ON pending.project_id=old.project_id AND pending.ref_id=newer.id AND pending.ref_type='message'
      AND pending.kind='report' AND pending.member_id=? AND pending.status='queued' AND pending.wake=1 AND pending.urgent=0
    WHERE old.id=? AND old.kind='막힘' AND old.mine=0 AND old.project_id=? AND old.task_id=?
    ORDER BY newer.at DESC LIMIT 1`).get(d.memberId,d.refId,d.projectId,d.taskId);
  if (!row || !row.body.match(/[A-Za-z0-9_-]+/g)?.includes(d.refId)) return null;
  const next = store.requireDelivery(row.updated);
  if (!untouchedQueuedInput(store,next) || store.db.query("SELECT 1 FROM manual_inbox_items WHERE delivery_id=?").get(next.id)) return null;
  store.db.query("UPDATE deliveries SET text=? WHERE id=?").run(
    next.text + `\n이 업무의 이전 막힘 원본 #${d.refId}와 이를 인용한 대표 지시 #${row.command}도 함께 확인하세요.`, next.id);
  return "담당자가 이 보고를 인용한 대표 지시를 수행했고 이전 원본을 후속 막힘 보고에 연결했습니다.";
}

function redundantReport(store: Store, d: Delivery): string | null {
  if (d.refType !== "message" || !d.refId) return null;
  const msg = store.getMessage(d.refId);
  if (!msg || msg.mine || !msg.memberId || msg.projectId !== d.projectId || msg.taskId !== d.taskId) return null;
  const author = store.getMember(msg.memberId);
  if (author?.kind !== "worker" || author.projectId !== d.projectId) return null;
  if (!d.wake && msg.taskId && msg.kind === "완료" && store.db.query("SELECT 1 FROM task_completion_reviews WHERE task_id=? AND report_id=?").get(msg.taskId,msg.id)) return "완료 보고가 업무의 독립 검수 절차에 접수됐습니다.";
  if (!d.wake && msg.kind === "알림" && msg.aboutMessageId && assignedRepair(store, d.projectId, "issue.id", msg.id)) return "담당자가 검수 지적에 연결된 수정 업무를 수신했습니다.";
  const refs = store.getReportReferences(msg.projectId, msg.id);
  if (!refs || msg.decisionId || refs.decisionIds.length) return null;
  if (!d.wake && (msg.kind === "진행" || msg.kind === "알림") && !msg.fileId && !msg.aboutMessageId &&
      !refs.correctsMessageId && !refs.fileIds.length && !store.getReportHarness(msg.id)?.reviewNeeded && !parseOwnerLine(msg.body)) return "업무 대화에 진행 기록이 있습니다.";
  if (!refs.correctsMessageId && msg.taskId && msg.kind === "진행" && !d.wake && !store.getReportHarness(msg.id)?.reviewNeeded &&
      store.db.query(`SELECT 1 FROM messages newer WHERE newer.project_id=? AND newer.member_id=? AND newer.task_id=?
        AND newer.at>? AND newer.kind IN ('막힘','완료') AND newer.mine=0`).get(msg.projectId,msg.memberId,msg.taskId,msg.at)) return "같은 담당자가 이 업무의 후속 결과를 남겼습니다.";
  if (d.wake && msg.kind === "막힘" && msg.taskId && store.db.query(`SELECT 1 FROM task_stage_marks mark
    JOIN messages next ON next.project_id=mark.project_id AND next.task_id=mark.task_id AND next.at>mark.at
      AND next.member_id=? AND next.mine=0 AND next.kind IN ('막힘','완료')
    WHERE mark.project_id=? AND mark.task_id=? AND mark.stage='reopen' AND mark.at>?`).get(msg.memberId,msg.projectId,msg.taskId,msg.at))
    return "업무가 재개된 뒤 같은 담당자가 후속 결과를 남겼습니다.";
  return null;
}

/** Reconcile only provably unsent, redundant copies. Source records and delivery
 * history are retained, including original worker messages and uncertain writes. */
export function retirePassiveReports(store: Store, assignedTaskId?: string): void {
  if (!store.db.query("SELECT 1 FROM pragma_table_info('report_references') WHERE name='board_only'").get()) return;
  store.transaction(() => {
    const copies = store.db.query<{ id: string }, [string | null, string | null]>(`SELECT d.id FROM deliveries d JOIN members lead
      ON lead.id=d.member_id AND lead.project_id=d.project_id AND lead.kind='conductor'
      WHERE d.kind IN ('report','system') AND d.status='queued' AND d.attempts=0 AND d.urgent=0 AND (? IS NULL OR d.task_id=?)
        AND NOT EXISTS(SELECT 1 FROM manual_inbox_items i WHERE i.delivery_id=d.id)
        AND NOT EXISTS(SELECT 1 FROM workflow_assignment_receipts a WHERE a.delivery_id=d.id)`).all(assignedTaskId ?? null, assignedTaskId ?? null);
    for (const copy of copies) {
      const d = store.requireDelivery(copy.id);
      if (!untouchedQueuedInput(store, d, d.wake)) {
        stopObsoleteLegacyTimer(store, d);
        continue;
      }
      const reason = d.kind === "report" ? redundantReport(store, d) ?? linkAnsweredBlocker(store, d) : redundantSystemNotice(store, d);
      if (!reason) continue;
      if (d.kind === "report") store.db.query("UPDATE report_references SET board_only=1 WHERE source_message_id=?").run(d.refId);
      store.updateDeliveryRecovery(d.id, 1, { phase: "stopped" });
      store.setDeliveryStatus(d.id, "failed", { wake: false, lastError: reason + " 총괄 사본을 전송 전에 정리했습니다." });
    }
  }, "immediate");
}
