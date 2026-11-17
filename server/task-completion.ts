import type { Delivery, Member, Task, WorkItem } from "../shared/types.ts";
import { bindingContract, missingExecutionContractFields } from "./harness.ts";
import { ApiError, type Store } from "./store.ts";
import { activeTaskContinuationPauses } from "./task-continuation.ts";
import { latestWorkerOutcome, type MarkFact } from "./task-progress.ts";
import { relatedWork } from "./workflow.ts";

interface CompletionReviewRow {
  report_id: string; task_id: string; contract_task_id: string; contract_rev: number;
  mark_id: number; status: "pending" | "confirmed" | "changes_requested";
  reviewed_at: string | null; completed_at: string; evidence: string | null; delivery_id: string | null;
  reviewed_branch: string | null; reviewed_commit: string | null;
}

interface PendingReviewRow extends CompletionReviewRow {
  cursor: number;
  task_title: string;
  author_id: string | null;
  artifact_commit: string | null;
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
    for (const id of scope) {
      const f = facts.get(id);
      if (paused.has(id) || f?.decisions.length || f?.todos.length || f?.approvals.length || f?.watch?.trippedAt || store.hasUnsettledTaskInput(id)
        || f?.marks.at(-1)?.stage === "hold" || id !== taskId && !store.doneMark(id)) valid = false;
      const last = latestWorkerOutcome(f);
      if (last && (last.kind === "막힘" || last.continuesWork || !last.passed || last.failed.length || last.notRun.length)) valid = false;
    }
    const previous = latestCompletionReview(store, taskId);
    if (previous && store.doneMark(taskId)?.id === previous.mark_id &&
      (!valid || previous.contract_task_id !== contract?.taskId || previous.contract_rev !== contract?.rev || previous.report_id !== report?.id)) {
      requestCompletionChanges(store, taskId, "완료 근거·업무 계약·차단 조건이 변경되어 남은 조건을 다시 확인합니다");
    }
    if (!valid || store.doneMark(taskId) || previous?.report_id === report!.id) return false;
    const mark = store.addStageMark({ projectId: task.projectId, taskId, stage: "done", memberId: null, who: "하네스",
      evidence: `계약 r${contract!.rev} 완료 조건 통과 · 보고 #${report!.id} · 총괄 최종 확인 대기` });
    store.db.query(`INSERT INTO task_completion_reviews
      (report_id,task_id,contract_task_id,contract_rev,mark_id,status,completed_at) VALUES(?,?,?,?,?,'pending',?)`)
      .run(report!.id, taskId, contract!.taskId, contract!.rev, mark.id, mark.at);
    store.createTaskNotice(task.projectId, taskId, mark.id, [task.title + " 수행 완료", `계약 r${contract!.rev}의 완료 조건을 통과했습니다`, "총괄이 최종 확인할 예정입니다. 후속 업무는 진행합니다"]);
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
  if (d && d.kind === "system" && !completionReviewAllowsDelivery(store, d) &&
      ["queued", "held"].includes(d.status) && !d.attempts && !store.listDeliveryDispatches(d.id).length)
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

export function completionReviewAllowsDelivery(store: Store, delivery: Delivery): boolean {
  if (delivery.kind !== "system") return true;
  const state = store.db.query<{ pending: number | null }, [string]>(
    "SELECT MAX(status='pending') AS pending FROM task_completion_reviews WHERE delivery_id=?",
  ).get(delivery.id);
  return state?.pending !== 0;
}

function pendingReviewRows(store: Store, projectId: string, after = 0): PendingReviewRow[] {
  if (store.requireProject(projectId).archived) return [];
  const paused = new Set(activeTaskContinuationPauses(store, projectId).map(p => p.taskId));
  const rows = store.db.query<PendingReviewRow, [string, number]>(`
    SELECT r.*, r.rowid AS cursor, t.title AS task_title, m.member_id AS author_id, h.artifact_commit
    FROM task_completion_reviews r
    JOIN tasks t ON t.id=r.task_id
    JOIN messages m ON m.id=r.report_id
    LEFT JOIN report_harness h ON h.message_id=r.report_id
    WHERE t.project_id=? AND t.merged_into IS NULL AND r.rowid>? AND r.status='pending'
      AND r.rowid=(SELECT MAX(x.rowid) FROM task_completion_reviews x WHERE x.task_id=r.task_id)
    ORDER BY r.rowid`).all(projectId, after);
  return rows.filter(row => {
    if (paused.has(row.task_id) || store.doneMark(row.task_id)?.id !== row.mark_id) return false;
    const contract = store.getEffectiveContract(row.task_id);
    return contract?.taskId === row.contract_task_id && contract.rev === row.contract_rev;
  });
}

export function listCompletionReviews(store: Store, projectId: string, after: number, limit: number) {
  const reviews = pendingReviewRows(store, projectId, after);
  const page = reviews.slice(0, limit);
  return {
    items: page.map(row => ({ taskId: row.task_id, title: row.task_title, reportId: row.report_id,
      authorId: row.author_id, contractTaskId: row.contract_task_id, contractRev: row.contract_rev,
      artifactCommit: row.artifact_commit, completedAt: row.completed_at })),
    next: reviews.length > page.length ? page.at(-1)!.cursor : null,
  };
}

export function queueCompletionReviewRepair(store: Store, source: Task, input: {
  completionReportId: string; findingReportId: string; title: string; detail: string;
}): WorkItem {
  const completion = store.getMessage(input.completionReportId);
  const finding = store.getMessage(input.findingReportId);
  const reviewer = finding?.memberId ? store.getMember(finding.memberId) : null;
  const findingTask = finding?.taskId ? store.getTask(finding.taskId) : null;
  if (!completion?.memberId || completion.projectId !== source.projectId ||
      !finding || finding.projectId !== source.projectId || finding.aboutMessageId !== completion.id ||
      !["진행", "알림", "막힘"].includes(finding.kind) || reviewer?.kind !== "worker" ||
      reviewer.projectId !== source.projectId || reviewer.id === completion.memberId ||
      !findingTask || findingTask.projectId !== source.projectId || findingTask.mergedInto) {
    throw new ApiError(400, "다른 직원이 별도 검수 업무에서 원 완료 보고를 연결한 결함 보고가 필요합니다");
  }
  const tasks = new Map(store.listTasks(source.projectId).map(task => [task.id, task]));
  if (relatedWork(source.id, findingTask.id, tasks)) {
    throw new ApiError(400, "사후 검수는 원 업무의 상위·하위 업무와 독립된 업무에서 보고해 주세요");
  }
  const sourceRef = `completion-review-repair:${source.id}:${finding.id}`;
  const previous = store.db.query<{ id: string }, [string, string]>(`
    SELECT w.id FROM work w JOIN tasks t ON t.id=w.task_id WHERE t.project_id=? AND t.source_ref=?`).get(source.projectId, sourceRef);
  if (previous) return store.getWork(previous.id)!;

  synchronizeTaskCompletion(store, source.id);
  return store.transaction(() => {
    const review = latestCompletionReview(store, source.id);
    if (review?.report_id !== completion.id || review.status === "changes_requested" || store.doneMark(source.id)?.id !== review.mark_id) {
      throw new ApiError(409, "현재 완료 근거가 바뀌었습니다. 원 업무의 완료 조건을 먼저 확인하세요");
    }
    const { task } = store.ensureSourceTask({ projectId: source.projectId, sourceRef, title: input.title, origin: "auto" });
    return store.upsertWork({ projectId: source.projectId, taskId: task.id, sec: "next", title: task.title,
      detail: [`원 업무 #${source.id} · 완료 보고 #${completion.id} · 사후 검수의 결함 보고 #${finding.id}`, input.detail].join("\n") });
  });
}

function outstandingReviewReminder(store: Store, delivery: Delivery): boolean {
  if (["queued", "held", "delivering"].includes(delivery.status)) return true;
  const recovery = store.getDeliveryRecovery(delivery.id);
  return !!recovery && !["none", "resolved"].includes(recovery.phase);
}

/** A shared reminder refers to a live queue, so individual review decisions can settle independently. */
export function checkCompletionReviews(store: Store, now: number, intervalMs: number): Delivery[] {
  return store.transaction(() => {
    const out: Delivery[] = [];
    for (const project of store.listProjects()) {
      if (project.archived || !project.runnerEnabled) continue;
      const lead = store.getConductor(project.id);
      if (!lead) continue;
      const pending = pendingReviewRows(store, project.id);
      if (!pending.length) continue;
      const notices = new Map<string, { delivery: Delivery; outstanding: boolean }>();
      for (const id of new Set(pending.flatMap(row => row.delivery_id ? [row.delivery_id] : []))) {
        const delivery = store.getDelivery(id);
        if (delivery) notices.set(id, { delivery, outstanding: outstandingReviewReminder(store, delivery) });
      }
      if ([...notices.values()].some(({ delivery, outstanding }) => outstanding && !delivery.taskId)) continue;
      const pendingReports = new Set(store.listPending(lead.id).filter(d => d.kind === "report").map(d => d.refId));
      const due = pending.filter(review => {
        const last = review.delivery_id ? notices.get(review.delivery_id) : undefined;
        return !last?.outstanding && !pendingReports.has(review.report_id) &&
          now - Date.parse(last?.delivery.deliveredAt ?? last?.delivery.createdAt ?? review.completed_at) >= intervalMs;
      });
      if (!due.length) continue;
      const delivery = store.enqueue({ projectId: project.id, memberId: lead.id, kind: "system", wake: true,
        text: "[시스템] 비동기 최종 확인 대기\ncompletion_reviews로 현재 완료 보고를 모아 작성자가 아닌 기존 직원에게 별도 사후 검수를 맡기세요. 이미 맡긴 보고는 이어서 처리합니다. 일반 후속 업무는 진행합니다. main에 합칠 판은 검수 뒤 task_stage(done)의 reviewed_commit으로 확인하세요. 완료 근거가 유효한 업무의 새 결함은 task_followup(kind: review_repair)로 연결하세요." });
      const link = store.db.query("UPDATE task_completion_reviews SET delivery_id=? WHERE task_id=? AND report_id=?");
      for (const review of due) link.run(delivery.id, review.task_id, review.report_id);
      out.push(delivery);
    }
    return out;
  });
}
