import type { Task, WorkItem } from "../shared/types.ts";
import { bindingContract, formatContract, type ContractInput, type TaskContract } from "./harness.ts";
import { ApiError, type Store } from "./store.ts";
import { completionReviewPaused, latestCompletionReview, requestCompletionChanges, synchronizeRelatedTaskCompletion } from "./task-completion.ts";
import { latestWorkerOutcome } from "./task-progress.ts";

import { beforeMainCommand, fullCommit, integrationHeadCommand, remoteMainCommand } from "./integration-evidence.ts";
export { fullCommit };
const prefix = "reviewed-main:";

interface IntegrationLink {
  source: string; report: string; branch: string; commit: string;
  cleanup?: { mergeMark: number; mainCommit: string };
}

function integrationLink(store: Store, task: Task | null): IntegrationLink | null {
  const ref = task ? store.taskSourceRef(task.id) : null;
  return ref?.startsWith(prefix) ? JSON.parse(ref.slice(prefix.length)) as IntegrationLink : null;
}

export function currentIntegrationCommit(store: Store, source: Task, reportId?: string): string | null {
  const review = latestCompletionReview(store, source.id);
  const contract = store.getEffectiveContract(source.id);
  if (source.mergedInto || store.requireProject(source.projectId).archived ||
    !review || (reportId && review.report_id !== reportId) ||
    store.doneMark(source.id)?.id !== review.mark_id || !bindingContract(contract) ||
    review.contract_rev !== contract?.rev || review.contract_task_id !== contract?.taskId) return null;
  const artifact = store.getReportHarness(review.report_id);
  const authorized = !!contract?.main_authority && !!artifact?.artifactBase;
  const legacy = !!review.legacy_integration && review.status === "confirmed" && review.reviewed_branch === source.branch && review.reviewed_commit === artifact?.artifactCommit;
  const commit = (authorized || legacy) && artifact?.artifactBranch === source.branch ? artifact.artifactCommit : null;
  if (!commit || !fullCommit.test(commit)) return null;
  const scope = new Set(store.taskCompletionScope(source.id));
  if (completionReviewPaused(store, source.projectId, source.id)) return null;
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
    currentIntegrationCommit(store, source, link.report) === link.commit &&
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
  if (!task) return true;
  const link = integrationStatus(store, task);
  if (!link) return true;
  return link.eligible && store.listStageMarks(task.id).at(-1)?.stage !== "hold" &&
    !completionReviewPaused(store, task.projectId, task.id) && !store.pendingTaskFailureDecision(task.id) && !store.pendingTaskIntervention(task.id);
}

/** Stale review bindings leave the worker's work order without rewriting receipts. */
export function holdStaleIntegration(store: Store, taskId: string): void {
  const task = store.getTask(taskId);
  const link = integrationLink(store, task);
  if (!task || !link || store.doneMark(task.id) || store.listStageMarks(task.id).at(-1)?.stage === "hold") return;
  const source = store.getTask(link.source);
  const review = source ? latestCompletionReview(store, source.id) : null;
  const contract = source ? store.getEffectiveContract(source.id) : null;
  if (source && !source.mergedInto && source.branch === link.branch && review &&
    review.report_id === link.report && currentIntegrationCommit(store, source, link.report) === link.commit &&
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
  return queueIntegration(store, source, commit);
}

function queueIntegration(store: Store, source: Task, commit: string): WorkItem {
  return store.transaction(() => {
    const branch = source.branch;
    if (!branch || ["main", "master", "HEAD"].includes(branch) || branch.startsWith("refs/")) {
      throw new ApiError(409, "통합할 작업 브랜치를 원 업무에 등록해 주세요");
    }
    const reviewed = currentIntegrationCommit(store, source);
    if (!reviewed || reviewed !== commit.toLowerCase()) {
      throw new ApiError(409, "현재 완료 계약·작업 커밋과 이 저장소의 main 통합 승인 근거를 확인해 주세요");
    }
    const report = latestCompletionReview(store, source.id)!.report_id;
    const link: IntegrationLink = { source: source.id, report, branch, commit: reviewed };
    const detail = [
      `원 업무 #${source.id} ${source.title}의 계약 검사를 통과한 완료 보고 #${report}을 확인했습니다.`,
      `작업 브랜치 ${branch} · 검증 커밋 ${reviewed}.`,
      "통합 권한을 확인하고 최신 origin/main에서 검증 커밋을 합칩니다. 통합 결과의 검사를 통과하면 일반 푸시하고 원격 main에 검증 커밋이 포함됐는지 확인합니다.",
      `같은 저장소에 통합용 워크트리를 준비하고 task(task_id, worktree)로 그 경로를 이 업무에 등록합니다. 원격 조회와 검사는 이 워크트리에서 실행합니다. 각 실행 검사는 '${integrationHeadCommand} && 검사 명령'으로 한 번 돌리고 checks에 해당 명령을 적습니다.`,
      `통합 전 ${beforeMainCommand}로 원격 main SHA를 기록하고, 그 명령도 behavior 검사로 제출합니다. 푸시 직전 task_trace에서 원 업무와 통합 업무의 현재 조건을 확인합니다. 푸시 후 ${remoteMainCommand}를 실행하고 같은 명령의 behavior 검사와 통합 검사를 남깁니다. post 완료에 main_base(통합 직전 원격 main), main_commit(확인한 원격 main), 본문에 작업·원격 SHA를 기록합니다.`,
      "문제가 생기면 재현과 남은 조건을 보고하고 발견한 범위의 별도 수정 업무로 연결합니다.",
    ].join("\n");
    return workFor(store, source, prefix + JSON.stringify(link), `${source.title}의 main 통합`, detail);
  });
}

/** One durable assignment per follow-up. Existing stops, receipts and assignees take priority. */
function dispatchScopedWork(store: Store, source: Task, work: WorkItem, workerId: string, terms: ContractInput) {
  if (!work.taskId || !["next", "doing"].includes(work.sec) || store.doneMark(work.taskId) ||
      store.hasTaskInstruction(work.taskId) ||
      store.listStageMarks(work.taskId).at(-1)?.stage === "hold" ||
      completionReviewPaused(store, source.projectId, work.taskId) ||
      store.pendingTaskIntervention(work.taskId) || store.pendingTaskFailureDecision(work.taskId)) return;
  const worker = store.getMember(workerId);
  if (!worker || worker.kind !== "worker" || worker.finalReviewer || worker.projectId !== source.projectId) return;
  const original = store.getEffectiveContract(source.id)!;
  let contract = store.getEffectiveContract(work.taskId);
  if (!contract) {
    // This contract derives from the bound source. Keep the actual author and confirmation provenance.
    contract = store.saveTaskContract(work.taskId, terms, { author: original.author, authorKind: original.authorKind,
      authorMemberId: original.authorMemberId, sourceMessageId: original.sourceMessageId });
    if (original.authorKind === "worker" && original.confirmedAt)
      contract = store.confirmTaskContract(work.taskId, contract.rev, { name: original.confirmedBy!, memberId: original.confirmedByMemberId ?? null });
  }
  if (!bindingContract(contract)) return;
  store.enqueue({ projectId: source.projectId, memberId: worker.id, kind: "instruction", taskId: work.taskId,
    text: [`업무 #${work.taskId} · ${work.title}`, work.detail, formatContract(contract)].join("\n") });
}

function followupContract(original: TaskContract, work: WorkItem, scope: string, acceptance: string[]): ContractInput {
  return { kind: "other", goal: work.title, scope, inputs: [original.goal, work.detail], outputs: [work.title + " 결과와 검증 보고"],
    constraints: original.constraints, exclusions: original.exclusions, forbidden: original.forbidden, acceptance, checks: [] };
}

export function scheduleVerifiedIntegration(store: Store, source: Task): void {
  if (!source.branch || ["main", "master", "HEAD"].includes(source.branch) || source.branch.startsWith("refs/")) return;
  const original = store.getEffectiveContract(source.id);
  const review = latestCompletionReview(store, source.id);
  if (!review || !original || (!original.main_authority && !review.legacy_integration) || review.main_commit ||
      !store.requireProject(source.projectId).runnerEnabled) return;
  const artifact = store.getReportHarness(review.report_id);
  if (!artifact?.artifactCommit || artifact.artifactBranch !== source.branch || store.getMessage(review.report_id)?.taskId !== source.id) return;
  // Only previously issued integration work may continue with an older contract.
  const link = { source: source.id, report: review.report_id, branch: source.branch, commit: artifact.artifactCommit };
  const existing = store.sourceTask(source.projectId, prefix + JSON.stringify(link));
  if (!original.main_authority && !(review.legacy_integration && existing)) return;
  if (existing && store.listStageMarks(existing.id).at(-1)?.stage !== "hold" && store.hasTaskInstruction(existing.id)) return;
  if (store.listStageMarks(source.id).some(m => m.stage === "merged" && m.id > review.mark_id) ||
      currentIntegrationCommit(store, source, review.report_id) !== artifact.artifactCommit) return;
  let work = queueIntegration(store, source, artifact.artifactCommit);
  const held = existing && store.listStageMarks(existing.id).at(-1);
  if (existing && held?.stage === "hold" && held.memberId === null && held.who === "하네스" &&
      held.evidence === `원 업무 #${source.id}의 계약 또는 검수 기록이 바뀌어 후속 지시를 보류합니다` &&
      !completionReviewPaused(store, existing.projectId, existing.id) && !store.pendingTaskIntervention(existing.id) &&
      !store.pendingTaskFailureDecision(existing.id)) {
    store.addStageMark({ projectId: source.projectId, taskId: existing.id, stage: "reopen", memberId: null, who: "하네스",
      evidence: `원 업무 #${source.id}의 계약 r${original.rev}과 통과 보고 #${review.report_id}의 작업 커밋이 일치합니다` });
    if (work.sec === "hold") work = store.upsertWork({ ...work, sec: "next" });
  }
  const conditions = followupContract(original, work, original.scope ?? source.title,
    [...original.acceptance.map(criterion => `통합판에서 검증: ${criterion}`), "원격 main에 해당 작업 커밋이 포함된 것을 확인한다"]);
  conditions.checks = [...new Set([...original.checks, "behavior" as const])];
  conditions.constraints = [...(conditions.constraints ?? []), original.main_authority
    ? `이 저장소에 기존 승인된 main 통합 근거: ${original.main_authority}. 적용 범위를 다시 확인한다.`
    : "기존 통합 업무의 승인 출처와 적용 범위를 확인한다. 승인을 확인할 수 없으면 Git을 변경하지 않고 막힘으로 보고한다."];
  dispatchScopedWork(store, source, work, artifact.memberId, conditions);
}

export function queueBranchCleanup(store: Store, source: Task, link: IntegrationLink, mergeMark: number, mainCommit: string): WorkItem {
  const cleanup: IntegrationLink = { ...link, cleanup: { mergeMark, mainCommit: mainCommit.toLowerCase() } };
  return workFor(store, source, prefix + JSON.stringify(cleanup), `${source.title}의 작업 브랜치 정리`, [
    `원 업무 #${source.id}의 작업 브랜치 ${link.branch} · 검증 커밋 ${link.commit} · 기록된 원격 main ${mainCommit}.`,
    "삭제 직전에 task_trace에서 원 업무의 완료·통합 기록을 확인하고, 현재 원격 main이 검증 커밋을 여전히 포함하는지 확인합니다.",
    "작업 브랜치 끝점이 검증 커밋과 같고 다른 업무나 사용 중인 워크트리가 없을 때 그 브랜치 하나만 조건부로 삭제합니다. 연결된 작업이나 검증할 수 없는 끝점은 보존합니다.",
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

export function findIndependentReviewRepair(store: Store, projectId: string, reportId: string): WorkItem | undefined {
  const sourceRef = `independent-review-repair:${reportId}`;
  return store.listWork(projectId).find(item => item.taskId && store.taskSourceRef(item.taskId) === sourceRef);
}

export function queueIndependentReviewRepair(store: Store, source: Task, reportId: string, findingId: string, title: string, evidence: string): WorkItem {
  const work = workFor(store, source, `independent-review-repair:${reportId}`, title,
    [`원 업무 #${source.id} · 완료 보고 #${reportId} · 사후 검수 결함 보고 #${findingId}`, evidence].join("\n"));
  const original = store.getEffectiveContract(source.id), author = store.getMessage(reportId)?.memberId;
  if (original && author && bindingContract(original)) {
    const terms = followupContract(original, work, `${original.scope} · 결함 범위: ${title}`,
      [`보고 #${findingId}의 재현 조건에서 ${title}의 수정 결과를 검증한다`, "원래 완료 조건의 회귀 검사를 통과한다"]);
    terms.constraints = [...(original.constraints ?? []), "원래 승인 범위에서만 수행한다. 범위를 넓혀야 할 때는 막힘으로 보고한다."];
    terms.kind = original.kind;
    terms.checks = original.checks;
    terms.main_authority = original.main_authority;
    dispatchScopedWork(store, source, work, author, terms);
  }
  return work;
}
