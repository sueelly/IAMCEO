import type { Task, WorkItem } from "../shared/types.ts";
import { bindingContract } from "./harness.ts";
import { ApiError, type Store } from "./store.ts";
import { latestCompletionReview, requestCompletionChanges, synchronizeRelatedTaskCompletion } from "./task-completion.ts";
import { activeTaskContinuationPauses } from "./task-continuation.ts";
import { latestWorkerOutcome } from "./task-progress.ts";

export const fullCommit = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;
const prefix = "reviewed-main:";

interface IntegrationLink {
  source: string; report: string; branch: string; commit: string;
  cleanup?: { mergeMark: number; mainCommit: string };
}

function integrationLink(store: Store, task: Task | null): IntegrationLink | null {
  const ref = task ? store.taskSourceRef(task.id) : null;
  return ref?.startsWith(prefix) ? JSON.parse(ref.slice(prefix.length)) as IntegrationLink : null;
}

export function currentReviewedCommit(store: Store, source: Task, reportId?: string): string | null {
  const review = latestCompletionReview(store, source.id);
  const contract = store.getEffectiveContract(source.id);
  if (source.mergedInto || store.requireProject(source.projectId).archived ||
    review?.status !== "confirmed" || (reportId && review.report_id !== reportId) ||
    store.doneMark(source.id)?.id !== review.mark_id || !bindingContract(contract) ||
    review.contract_rev !== contract?.rev || review.contract_task_id !== contract?.taskId) return null;
  const commit = review.reviewed_branch === source.branch ? review.reviewed_commit : null;
  if (!commit || !fullCommit.test(commit)) return null;
  const scope = new Set(store.taskCompletionScope(source.id));
  if (activeTaskContinuationPauses(store, source.projectId).some(p => scope.has(p.taskId))) return null;
  const facts = store.taskProgressFacts(source.projectId, scope);
  for (const id of scope) {
    const f = facts.get(id);
    const last = latestWorkerOutcome(f);
    if (f?.decisions.length || f?.todos.length || f?.approvals.length || f?.watch?.trippedAt ||
      f?.marks.at(-1)?.stage === "hold" || store.hasUnsettledTaskInput(id) ||
      (id !== source.id && !store.doneMark(id)) ||
      (last && (!last.passed || last.failed.length || last.notRun.length))) return null;
  }
  return commit;
}

export function integrationStatus(store: Store, task: Task): (IntegrationLink & { eligible: boolean }) | null {
  const link = integrationLink(store, task);
  if (!link) return null;
  const source = store.getTask(link.source);
  const eligible = !!source && source.projectId === task.projectId && source.branch === link.branch &&
    currentReviewedCommit(store, source, link.report) === link.commit &&
    (!link.cleanup || store.listStageMarks(source.id).some(mark => mark.stage === "merged" && mark.id === link.cleanup!.mergeMark));
  return { ...link, eligible };
}

export function requireIntegrationResult(store: Store, source: Task, reportId: string | undefined, mainCommit: string | undefined): IntegrationLink {
  const report = reportId ? store.getMessage(reportId) : null;
  const task = report?.taskId ? store.getTask(report.taskId) : null;
  const link = task ? integrationStatus(store, task) : null;
  const contract = task ? store.getEffectiveContract(task.id) : null;
  const reportedCommits: string[] = report?.body.toLowerCase().match(/\b(?:[0-9a-f]{40}|[0-9a-f]{64})\b/gu) ?? [];
  if (!mainCommit || !fullCommit.test(mainCommit) || !report || report.kind !== "완료" ||
    report.projectId !== source.projectId || !link?.eligible || link.cleanup || link.source !== source.id ||
    !reportedCommits.includes(link.commit) || !reportedCommits.includes(mainCommit.toLowerCase()) ||
    !report.memberId || store.getMember(report.memberId)?.kind !== "worker" || !bindingContract(contract) ||
    !store.completionEvidence(contract!.taskId, contract!.rev).some(ref => ref.messageId === report.id && ref.status === "passed")) {
    throw new ApiError(409, "검수한 작업 커밋과 원격 main 커밋을 모두 확인한 통합 담당자의 통과 보고를 연결해 주세요");
  }
  const { source: original, report: reviewedReport, branch, commit } = link;
  return { source: original, report: reviewedReport, branch, commit };
}

export function integrationTaskAllowsInput(store: Store, taskId: string | null | undefined): boolean {
  const task = taskId ? store.getTask(taskId) : null;
  return !task || integrationStatus(store, task)?.eligible !== false;
}

/** Stale review bindings leave the worker's work order without rewriting receipts. */
export function holdStaleIntegration(store: Store, taskId: string): void {
  const task = store.getTask(taskId);
  const link = integrationLink(store, task);
  if (!task || !link || store.doneMark(task.id) || store.listStageMarks(task.id).at(-1)?.stage === "hold") return;
  const source = store.getTask(link.source);
  const review = source ? latestCompletionReview(store, source.id) : null;
  const contract = source ? store.getEffectiveContract(source.id) : null;
  if (source && !source.mergedInto && source.branch === link.branch && review?.status === "confirmed" &&
    review.report_id === link.report && review.reviewed_branch === link.branch && review.reviewed_commit === link.commit &&
    store.doneMark(source.id)?.id === review.mark_id &&
    contract?.rev === review.contract_rev && contract?.taskId === review.contract_task_id) return;
  holdFollowup(store, task, `원 업무 #${link.source}의 계약 또는 검수 기록이 바뀌어 후속 지시를 보류합니다`);
}

function holdFollowup(store: Store, task: Task, evidence: string): void {
  if (store.doneMark(task.id) || store.listStageMarks(task.id).at(-1)?.stage === "hold") return;
  store.addStageMark({ projectId: task.projectId, taskId: task.id, stage: "hold", evidence, memberId: null, who: "하네스" });
  const work = store.listWork(task.projectId).find(w => w.taskId === task.id);
  if (work && work.sec !== "done" && work.sec !== "hold") store.upsertWork({ ...work, sec: "hold" });
}

function workFor(store: Store, source: Task, sourceRef: string, title: string, detail: string): WorkItem {
  const { task } = store.ensureSourceTask({ projectId: source.projectId, origin: "auto", sourceRef, title });
  const existing = store.listWork(source.projectId).find(w => w.taskId === task.id);
  return existing ?? store.upsertWork({ projectId: source.projectId, taskId: task.id, sec: "next", title, detail });
}

export function queueReviewedIntegration(store: Store, source: Task, commit: string): WorkItem {
  synchronizeRelatedTaskCompletion(store, source.id);
  return store.transaction(() => {
    const branch = source.branch;
    if (!branch || ["main", "master", "HEAD"].includes(branch) || branch.startsWith("refs/")) {
      throw new ApiError(409, "통합할 작업 브랜치를 원 업무에 등록해 주세요");
    }
    const reviewed = currentReviewedCommit(store, source);
    if (!reviewed || reviewed !== commit.toLowerCase()) {
      throw new ApiError(409, "완료 조건을 통과하고 같은 작업 브랜치 커밋을 총괄이 최종 검수해야 통합을 올릴 수 있습니다");
    }
    const report = latestCompletionReview(store, source.id)!.report_id;
    const link: IntegrationLink = { source: source.id, report, branch, commit: reviewed };
    const detail = [
      `원 업무 #${source.id} ${source.title}의 총괄 최종 검수 보고 #${report}을 확인했습니다.`,
      `작업 브랜치 ${branch} · 검수 커밋 ${reviewed}.`,
      "통합 권한을 확인하고 최신 origin/main에서 검수 커밋을 합칩니다. 통합 결과의 검사를 통과하면 일반 푸시하고 원격 main에 검수 커밋이 포함됐는지 확인합니다.",
      "완료 보고에 검수 커밋과 원격 main의 전체 SHA를 남깁니다. 원격 main 반영이 기록되면 브랜치 정리 업무가 별도로 열립니다.",
      "문제가 생기면 재현과 남은 조건을 보고하고 발견한 범위의 별도 수정 업무로 연결합니다.",
    ].join("\n");
    return workFor(store, source, prefix + JSON.stringify(link), `${source.title}의 main 통합`, detail);
  });
}

export function queueBranchCleanup(store: Store, source: Task, link: IntegrationLink, mergeMark: number, mainCommit: string): WorkItem {
  const cleanup: IntegrationLink = { ...link, cleanup: { mergeMark, mainCommit: mainCommit.toLowerCase() } };
  return workFor(store, source, prefix + JSON.stringify(cleanup), `${source.title}의 작업 브랜치 정리`, [
    `원 업무 #${source.id}의 작업 브랜치 ${link.branch} · 검수 커밋 ${link.commit} · 기록된 원격 main ${mainCommit}.`,
    "삭제 직전에 task_trace에서 검수를 확인하고, 현재 원격 main이 검수 커밋을 여전히 포함하는지 확인합니다.",
    "작업 브랜치 끝점이 검수 커밋과 같고 다른 업무나 사용 중인 워크트리가 없을 때 그 브랜치 하나만 조건부로 삭제합니다. 연결된 작업이나 검증할 수 없는 끝점은 보존합니다.",
    "정리에서 실패하면 원격 main 통합 확인과 삭제 실패를 구분해 보고합니다.",
  ].join("\n"));
}

export function queueIntegrationRepair(store: Store, source: Task, reportId: string, title: string, detail?: string): WorkItem {
  return store.transaction(() => {
    const report = store.getMessage(reportId);
    const reportedTask = report?.taskId ? store.getTask(report.taskId) : null;
    if (!report || report.projectId !== source.projectId || report.mine || !["막힘", "알림", "진행"].includes(report.kind) ||
      (reportedTask?.id !== source.id && integrationLink(store, reportedTask)?.source !== source.id)) {
      throw new ApiError(400, "원 업무나 그 통합 업무에 남긴 문제 보고를 연결해 주세요");
    }
    const sourceRef = `main-repair:${source.id}:${reportId}`;
    const existing = store.listWork(source.projectId).find(w => w.taskId && store.taskSourceRef(w.taskId) === sourceRef);
    if (existing) return existing;
    const marks = store.listStageMarks(source.id);
    if (!marks.slice(marks.findLastIndex(mark => mark.stage === "reopen") + 1).some(mark => mark.stage === "merged")) {
      requestCompletionChanges(store, source.id, `통합 전 문제 보고 #${reportId} · ${report.title}`);
      for (const work of store.listWork(source.projectId)) {
        if (work.sec === "done" || work.sec === "hold" || !work.taskId ||
          integrationLink(store, store.getTask(work.taskId))?.source !== source.id) continue;
        holdStaleIntegration(store, work.taskId);
      }
    } else if (reportedTask && integrationLink(store, reportedTask)?.cleanup) {
      holdFollowup(store, reportedTask, `브랜치 정리 실패 보고 #${reportId} · ${report.title}`);
    }
    return workFor(store, source, sourceRef, title,
      [`원 업무 #${source.id} ${source.title} · 문제 보고 #${reportId} ${report.title}`, detail].filter(Boolean).join("\n"));
  });
}
