import { createHash } from "node:crypto";
import { WORKFLOW_OBSERVATION_MAX_AGE_MS, type WorkflowAssignmentPreview, type WorkflowAssignmentRequest, type WorkflowAssignmentResult } from "../shared/workflow.ts";
import { canonicalAgentRequest } from "./agent-receipts.ts";
import { bindingContract, EXECUTION_CONTRACT_LABEL, missingExecutionContractFields } from "./harness.ts";
import { redactHarnessText } from "./harness-redaction.ts";
import { ApiError, type Store } from "./store.ts";
import { activeTaskContinuationPauses } from "./task-continuation.ts";

/** Read-only: no runner probes, queue writes, contract confirmation, or owner approval. */
export function previewWorkflowAssignment(store: Store, projectId: string, taskId: string, memberId: string): WorkflowAssignmentPreview {
  const project = store.requireProject(projectId), task = store.requireTask(taskId), member = store.requireMember(memberId);
  if (task.projectId !== projectId || member.projectId !== projectId) throw new ApiError(404, "이 프로젝트의 업무와 직원만 배정할 수 있습니다");
  const context = store.workflowAssignmentContext(taskId), contract = store.getEffectiveContract(taskId), progress = store.taskProgress(taskId);
  const queue = store.listPending(memberId), flow = store.projectWorkflow(projectId);
  const pauses = activeTaskContinuationPauses(store, projectId).filter(p => p.taskId === taskId);
  const row = flow.nodes.filter(n => n.memberId === memberId && n.state !== "done" && !n.historical).sort((a,b) => a.order-b.order);
  const placement = store.workflowAssignmentPlacement(taskId, memberId);
  const observation = member.statusObservation, age = Date.now() - Date.parse(observation?.observedAt ?? "");
  const targetTrust = { fresh: observation?.freshness === "fresh" && Number.isFinite(age) && age >= -5_000 && age < WORKFLOW_OBSERVATION_MAX_AGE_MS,
    ownership: observation?.ownership ?? "unknown", error: observation?.error?.code ?? null };
  const blockers: string[] = [];
  const failureDecision = store.pendingTaskFailureDecision(taskId);
  const intervention = store.pendingTaskIntervention(taskId);
  if (intervention) blockers.push(`업무 #${intervention.taskId}의 총괄 점검이 필요합니다: ${intervention.reason}. 바뀐 접근을 기록해 다시 연 뒤 배정하세요`);
  if (failureDecision) blockers.push(`같은 실패 세 번의 결재 #${failureDecision.id}에 대표 판단이 필요합니다. 결재함에서 재개 조건을 정해 주세요`);
  if (project.archived) blockers.push("보관된 프로젝트입니다");
  if (!project.runnerEnabled) blockers.push("프로젝트 실행이 꺼져 있습니다");
  if (task.mergedInto || progress.stage === "done") blockers.push("이미 합쳐졌거나 완료한 업무입니다");
  if (context.assigned || flow.nodes.some(n => n.taskId === taskId && n.memberId)) blockers.push("이미 배정된 업무입니다. 기존 담당과 전달을 먼저 확인해 주세요");
  if (pauses.length) blockers.push("대표가 중단한 업무입니다. 같은 업무의 새 지시나 다시 열기 근거를 먼저 확인해 주세요");
  if (!bindingContract(contract) || !contract?.goal.trim() || !contract.acceptance.length) blockers.push("업무의 목표와 완료 조건이 아직 확정되지 않았습니다");
  const missing = missingExecutionContractFields(contract);
  if (missing.length) blockers.push(`새 실행 전에 총괄이 업무 계약을 보완해야 합니다: ${missing.map(field => EXECUTION_CONTRACT_LABEL[field]).join(", ")}`);
  if (context.omitted.originals) blockers.push("원래 지시가 100건을 넘습니다. 업무 범위를 정리한 뒤 배정해 주세요");
  if (!context.originals.length && !bindingContract(contract)) blockers.push("확정된 지시를 확인할 수 없습니다");
  const lineage = new Set(context.lineage.map(t => t.id));
  const watches = context.lineage.map(t => store.getTaskWatch(t.id));
  if (watches.some(w => w?.trippedAt)) blockers.push("반복 감시로 멈춘 업무입니다. 총괄이 원인과 바뀐 접근을 확인해야 합니다");
  if (context.lineage.some(t => store.hasUnsettledTaskInput(t.id))) blockers.push("이 업무의 이전 입력 처리가 끝나지 않았습니다");
  const decisions = store.listOpenDecisions(projectId).filter(d => d.taskId && lineage.has(d.taskId));
  const todos = store.listTodos(projectId).filter(t => !t.done && t.taskId && lineage.has(t.taskId));
  if (decisions.length || todos.length || ["hold", "held", "approval", "owner", "check"].includes(progress.stage)) blockers.push("승인·보류 또는 대표가 확인할 조건이 남아 있습니다");
  if (member.origin === "manual") blockers.push("직접 연결한 세션은 이 화면에서 배정하지 않습니다");
  if (["asleep", "offline", "error"].includes(member.status)) blockers.push("직원의 연결과 실행 가능 여부를 먼저 확인해 주세요");
  if (member.executionState?.phase === "unknown" || member.lifecycleState && member.lifecycleState.phase !== "started_confirmed" || member.blockedReason === "status_unknown") blockers.push("직원의 실행 상태를 확인해야 합니다");
  if (!targetTrust.fresh || targetTrust.ownership !== "verified" || targetTrust.error) blockers.push("직원의 최근 연결과 세션 소유권을 확인해야 합니다");
  const safe = (text: string | null | undefined) => redactHarnessText(text ?? "");
  const startCondition = [member.status === "blocked" ? "직원의 승인·선택 응답이 필요합니다." : "",
    member.kind !== "worker" ? "총괄은 업무 완료 순서와 별개로 입력을 받습니다. 기존 전달·실행 검사를 통과하면 시작합니다"
      : placement.suspended ? `‘${placement.suspended.title}’의 보류·중단 범위입니다. 이 업무의 재개 조건을 먼저 확인해야 합니다`
      : placement.blocker ? `‘${placement.blocker.title}’의 직원 담당 단계가 끝나거나 보류되어 순서가 풀린 뒤 기존 전달·실행 검사를 통과하면 시작합니다`
      : placement.continuation ? "부모·파생 업무의 연속 작업입니다. 현재 입력 처리 뒤 기존 전달·실행 검사를 통과하면 시작합니다"
      : "기존 전달·실행 가능 검사를 통과하면 시작합니다"].filter(Boolean).join(" ");
  const preview: Omit<WorkflowAssignmentPreview, "revision"> = {
    projectId, task: { id: task.id, title: task.title, branch: task.branch, worktree: task.worktree, parentTaskId: task.parentTaskId ?? null },
    member: { id: member.id, name: member.name },
    contract: contract ? { taskId: contract.taskId, rev: contract.rev, goal: safe(contract.goal), scope: contract.scope ? safe(contract.scope) : null,
      inputs: contract.inputs?.map(safe) ?? null, outputs: contract.outputs?.map(safe) ?? null, constraints: contract.constraints?.map(safe) ?? null, exclusions: contract.exclusions?.map(safe) ?? null,
      acceptance: contract.acceptance.map(safe), forbidden: contract.forbidden.map(safe), evidence: contract.evidence.map(safe), checks: contract.checks, confirmed: bindingContract(contract) } : null,
    originals: context.originals.map(m => ({ id: m.id, taskId: m.taskId ?? null, who: m.who, at: m.at, body: safe(m.body) })),
    reports: context.reports.map(m => ({ id: m.id, taskId: m.taskId ?? null, who: m.who, at: m.at, kind: m.kind, title: safe(m.title), body: safe(m.body), harness: m.harness, correctsMessageId: m.correctsMessageId, correctedBy: m.correctedBy })),
    files: context.files.map(({ fingerprint, ...file }) => ({ ...file, title: safe(file.title), summary: safe(file.summary) })),
    attachments: context.attachments.map(a => ({ id: a.id, name: a.name })), omitted: context.omitted,
    position: placement.position,
    startCondition,
    blockers,
  };
  // Changes not visible in the compact preview still invalidate the reviewed instruction.
  const revision = createHash("sha256").update(canonicalAgentRequest({ preview, contract, task, progress, watches, decisions, todos, pauses, failureDecision, intervention, files: context.files,
    originals: context.originals, reports: context.reports, lineage: context.lineage,
    member: { revisions: store.memberRevisions(memberId), status: member.status, blockedReason: member.blockedReason, origin: member.origin, cwd: member.cwd, execution: member.executionState, lifecycle: member.lifecycleState, targetTrust },
    queue: queue.map(d => ({id:d.id,taskId:d.taskId,status:d.status,holdReason:d.holdReason})),
    row: row.map(n => ({id:n.id,taskId:n.taskId,order:n.order,state:n.state})), project: {archived:project.archived,runnerEnabled:project.runnerEnabled},
  })).digest("hex");
  return { ...preview, revision };
}

export function workflowHandoffText(p: WorkflowAssignmentPreview): string {
  const c = p.contract!;
  return [
    `대표가 업무 흐름에서 ${p.member.name}에게 이 범위의 실행을 배정했습니다.`,
    `작업 #${p.task.id}: ${p.task.title}`, p.task.parentTaskId ? `부모 업무 #${p.task.parentTaskId}` : "",
    `계약 r${c.rev} · 계약 업무 #${c.taskId}`, `목표: ${c.goal}`, c.scope ? `범위: ${c.scope}` : "",
    ...(["inputs", "outputs", "constraints", "exclusions"] as const).flatMap(field => {
      const values = c[field];
      return values?.length ? values.map(s => `${EXECUTION_CONTRACT_LABEL[field]}: ${s}`)
        : [`${EXECUTION_CONTRACT_LABEL[field]}: ${values && (field === "constraints" || field === "exclusions") ? "없음" : "미정"}`];
    }),
    "완료 조건:", ...c.acceptance.map((s,i) => `${i+1}. ${s}`),
    "지켜야 할 조건:", ...c.forbidden.map(s => `- ${s}`),
    "- 기존 승인·중단 보호·선행 업무 조건을 유지합니다. 이 배정은 승인 창 응답이나 반복 감시 해제를 허용하지 않습니다.",
    `필수 검사: ${c.checks.join(", ")}`, ...c.evidence.map(s => `필요 근거: ${s}`),
    p.task.branch ? `브랜치: ${p.task.branch}` : "", p.task.worktree ? `워크트리: ${p.task.worktree}` : "",
    "대표 원문(이전 기록의 맥락이며 현재 계약·권한을 임의로 넓히지 않습니다):",
    ...p.originals.map(m => `원문 #${m.id} · 업무 #${m.taskId} · ${m.who} · ${m.at}\n${m.body}`),
    "최근 보고와 실패·정정 근거(작성자 주장과 검증 결과를 구분해서 확인합니다):",
    ...p.reports.map(m => [`보고 #${m.id} · 업무 #${m.taskId} · ${m.who} · ${m.kind} · ${m.at}`, m.title, m.body,
      m.correctsMessageId ? `정정 대상: #${m.correctsMessageId}` : "", m.correctedBy.length ? `후속 정정: ${m.correctedBy.map(id=>`#${id}`).join(", ")}` : "",
      m.harness ? `보고 검사·계약 판·대조 상태(정정 연결만으로 통과를 추정하지 않습니다):\n${JSON.stringify(m.harness, null, 2)}` : ""].filter(Boolean).join("\n")),
    ...p.files.map(f => `자료 #${f.id} · 업무 #${f.taskId}: ${f.title}\n${f.summary}`),
    ...p.attachments.map(a => `첨부 ID #${a.id}: ${a.name}`),
    `생략: 이전 보고 ${p.omitted.reports}건, 자료 ${p.omitted.files}건. 작업 #${p.task.id}와 부모 업무의 대화·자료에서 추가 조회합니다.`,
    `시작 조건: ${p.startCondition}`,
    "같은 업무 ID와 계약 판으로 결과·실패 근거를 보고합니다. 실행 턴 종료만으로 완료로 처리하지 않습니다.",
  ].filter(Boolean).join("\n");
}

/** SQLite transaction owns validation, one delivery, audit message, and the receipt together. */
export function commitWorkflowAssignment(store: Store, projectId: string, taskId: string, request: WorkflowAssignmentRequest,
  prepareAttachments: (preview: WorkflowAssignmentPreview) => string = () => ""): WorkflowAssignmentResult {
  return store.transaction(() => {
    const prior = store.workflowAssignmentReceipt(request.operationId);
    if (prior) {
      if (prior.result.projectId !== projectId || prior.result.taskId !== taskId || canonicalAgentRequest(prior.request) !== canonicalAgentRequest(request)) throw new ApiError(409, "다른 배정 요청에 사용된 operationId입니다");
      return prior.result;
    }
    const preview = previewWorkflowAssignment(store, projectId, taskId, request.memberId);
    if (preview.revision !== request.revision) throw new ApiError(409, "업무·계약·대기열이 바뀌었습니다. 인계 내용을 다시 확인해 주세요", "WORKFLOW_REVIEW_CHANGED");
    if (preview.blockers.length) throw new ApiError(409, preview.blockers.join(". "), "WORKFLOW_ASSIGNMENT_BLOCKED");
    const instruction = workflowHandoffText(preview);
    if (Buffer.byteLength(instruction, "utf8") > 120_000) throw new ApiError(409, "인계 내용이 너무 깁니다. 업무 범위를 나눠 주세요");
    const attachmentText = prepareAttachments(preview);
    const message = store.createMessage({ projectId, taskId, mine: true, who: "대표", kind: "나", title: `${preview.member.name}에게 배정`, body: `업무 흐름에서 배정했습니다. 계약 r${preview.contract!.rev} · ${preview.startCondition}`, targetMemberId: request.memberId });
    const delivery = store.enqueue({ projectId, taskId, memberId: request.memberId, kind: "instruction", text: [instruction,attachmentText].filter(Boolean).join("\n"), refType: "message", refId: message.id });
    const result = { operationId: request.operationId, projectId, taskId, memberId: request.memberId, deliveryId: delivery.id, createdAt: delivery.createdAt };
    store.saveWorkflowAssignmentReceipt(request, result);
    return result;
  });
}
