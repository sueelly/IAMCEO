import { createHash } from "node:crypto";
import type { Delivery, Task } from "../shared/types.ts";
import type { IndependentDeliveryRequest, WorkflowAssignmentRequest, WorkflowAssignmentResult } from "../shared/workflow.ts";
import { canonicalAgentRequest } from "./agent-receipts.ts";
import { ordinaryInputAdmitted } from "./queue-admission.ts";
import { ApiError, type Store } from "./store.ts";
import { taskScopeForDeliveryIds } from "./task-continuation.ts";

type Authorization = NonNullable<WorkflowAssignmentRequest["independent"]>;

function lineage(store: Store, projectId: string, taskId: string): Task[] {
  const chain: Task[] = [], seen = new Set<string>();
  let id: string | null = taskId;
  while (id) {
    if (seen.has(id) || seen.size >= 32) throw new ApiError(409, "업무의 부모 연결을 먼저 확인해 주세요");
    seen.add(id);
    const task = store.requireTask(id);
    if (task.projectId !== projectId || task.mergedInto) throw new ApiError(409, "현재 프로젝트의 독립된 업무만 확인할 수 있습니다");
    chain.push(task);
    id = task.parentTaskId ?? null;
  }
  return chain;
}

/** A different employee's local input fence cannot protect this employee.
 * Inspect all same-family inputs, without a recent-message window or side effects. */
function requireUnoccupiedFamily(store: Store, projectId: string, selected: Delivery, family: ReadonlySet<string>): void {
  const related = new Map<string, boolean>();
  const inFamily = (taskId: string): boolean => {
    if (related.has(taskId)) return related.get(taskId)!;
    const seen = new Set<string>();
    let id: string | null = taskId;
    while (id && !seen.has(id) && seen.size < 32) {
      if (family.has(id)) { related.set(taskId, true); return true; }
      seen.add(id);
      const task = store.getTask(id);
      if (!task || task.projectId !== projectId) break;
      id = task.parentTaskId ?? null;
    }
    related.set(taskId, false);
    return false;
  };
  const refuse = () => { throw new ApiError(409, "같은 계통에서 수신·실행 중인 입력을 먼저 확인해 주세요"); };
  const physical = new Set(store.physicalDeliveryIds());
  for (const input of store.listDeliveries(projectId)) {
    if (input.id === selected.id || !input.wake || !input.taskId || !inFamily(input.taskId)) continue;
    if (input.status === "delivering" || physical.has(input.id)) refuse();
    const recovery = store.getDeliveryRecovery(input.id);
    if (recovery && ["checking", "waiting", "needs_owner"].includes(recovery.phase)) refuse();
    if (["queued", "held"].includes(input.status) && (input.attempts > 0 || recovery?.phase !== "none")) {
      const dispatches = store.listDeliveryDispatches(input.id);
      const provenRefusal = dispatches.length > 0 && dispatches.every(dispatch => dispatch.transportState === "rejected") &&
        (recovery?.phase === "none" || recovery?.phase === "resolved" && recovery.reason === "not_received");
      if (!provenRefusal) refuse();
    }
  }
  for (const run of store.listPendingExecutions()) {
    if (run.projectId === projectId && !run.endedAt && taskScopeForDeliveryIds(store, run.deliveryIds).some(inFamily)) refuse();
  }
}

/** Validate only the order exception. Runner ownership, leases, approvals and
 * uncertain writes remain the ordinary pump's independent admission gates. */
function authorizationRevision(store: Store, projectId: string, delivery: Delivery, authorization: Authorization): string {
  const project = store.requireProject(projectId), member = store.requireMember(delivery.memberId);
  if (delivery.projectId !== projectId || member.projectId !== projectId || member.kind !== "worker" || !delivery.taskId) throw new ApiError(409, "이 프로젝트 직원의 업무 지시만 확인할 수 있습니다");
  if (project.archived || !project.runnerEnabled) throw new ApiError(409, "실행 중인 프로젝트에서만 독립 지시를 확인할 수 있습니다");
  if (delivery.kind !== "instruction" || !delivery.wake || delivery.urgent || !ordinaryInputAdmitted(store, delivery.id)) throw new ApiError(409, "보호된 입력이나 긴급 지시의 실행 순서는 바꿀 수 없습니다");
  if (!Number.isSafeInteger(authorization.sessionGeneration) || authorization.sessionGeneration < 0 || store.memberRevisions(member.id).sessionGeneration !== authorization.sessionGeneration) throw new ApiError(409, "직원의 세션이 바뀌었습니다. 현재 지시를 다시 확인해 주세요");
  const blocker = store.taskSequenceBlocker(member.id, delivery.taskId);
  if (!blocker || blocker.taskId !== authorization.blockerTaskId) throw new ApiError(409, "선행 업무가 바뀌었습니다. 현재 순서를 다시 확인해 주세요");

  const targetLineage = lineage(store, projectId, delivery.taskId);
  const blockerLineage = lineage(store, projectId, blocker.taskId);
  const targetFamily = new Set(targetLineage.map(task => task.id));
  const predecessors = new Set([blocker.taskId, ...store.taskSequencePredecessors(member.id, delivery.taskId)]);
  for (const taskId of predecessors) {
    if (lineage(store, projectId, taskId).some(task => targetFamily.has(task.id))) throw new ApiError(409, "같은 계통 업무의 선행 조건은 독립 지시로 건너뛸 수 없습니다");
  }
  requireUnoccupiedFamily(store, projectId, delivery, targetFamily);
  const pauses = store.taskContinuationPauses(projectId);
  if (pauses.some(pause => targetFamily.has(pause.taskId))) throw new ApiError(409, "대표님이 중단한 대상 업무를 먼저 확인해 주세요");
  const facts = store.taskProgressFacts(projectId, targetFamily);
  for (const task of targetLineage) {
    const fact = facts.get(task.id);
    if (fact?.decisions.length || fact?.todos.length || fact?.approvals.length || fact?.watch?.trippedAt) throw new ApiError(409, "대상 업무의 결재·대표 확인·승인·반복 멈춤을 먼저 확인해 주세요");
    const reopen = fact?.marks.findLastIndex(mark => mark.stage === "reopen") ?? -1;
    const active = fact?.marks.slice(reopen + 1) ?? [];
    if (active.at(-1)?.stage === "hold" || task.id === delivery.taskId && active.some(mark => mark.stage === "done")) throw new ApiError(409, "대상 업무의 보류나 완료 상태는 독립 지시로 바꿀 수 없습니다");
    if (fact?.held.some(input => !["asleep", "offline", "backend_down", "runner_disabled", "input_busy", "blocked"].includes(input.reason ?? ""))) throw new ApiError(409, "대상 업무의 보호된 입력을 먼저 확인해 주세요");
  }

  const source = store.requireMessage(authorization.sourceMessageId);
  if (source.projectId !== projectId || !source.mine || source.targetMemberId !== member.id || ![delivery.taskId, blocker.taskId].includes(source.taskId ?? "")) throw new ApiError(409, "같은 직원과 업무를 지정한 대표 원문이 필요합니다");
  const sourceAt = Date.parse(source.at), inputAt = Date.parse(delivery.createdAt);
  if (!Number.isFinite(sourceAt) || !Number.isFinite(inputAt) || sourceAt < inputAt) throw new ApiError(409, "대기 중인 지시 이후에 작성한 대표 원문이 필요합니다");

  return createHash("sha256").update(canonicalAgentRequest({
    delivery: { id: delivery.id, projectId, memberId: member.id, taskId: delivery.taskId, kind: delivery.kind, text: delivery.text, refType: delivery.refType, refId: delivery.refId, createdAt: delivery.createdAt },
    source: { id: source.id, projectId: source.projectId, taskId: source.taskId, mine: source.mine, targetMemberId: source.targetMemberId, at: source.at, title: source.title, body: source.body },
    lineage: { target: targetLineage.map(task => ({ id: task.id, parentTaskId: task.parentTaskId ?? null })), blocker: blockerLineage.map(task => ({ id: task.id, parentTaskId: task.parentTaskId ?? null })) },
    contracts: { target: store.getEffectiveContract(delivery.taskId), blocker: store.getEffectiveContract(blocker.taskId) },
    authorization,
  })).digest("hex");
}

function originalRequest(request: WorkflowAssignmentRequest): IndependentDeliveryRequest | null {
  if (request.kind !== "independent_delivery" || !request.independent) return null;
  return { operationId: request.operationId, sourceMessageId: request.independent.sourceMessageId, expectedSessionGeneration: request.independent.sessionGeneration, expectedBlockerTaskId: request.independent.blockerTaskId };
}

/** Only an authenticated representative action may call this mutation. It
 * records permission for one existing delivery; it never queues or sends input. */
export function authorizeIndependentDelivery(store: Store, projectId: string, deliveryId: string, request: IndependentDeliveryRequest): WorkflowAssignmentResult {
  return store.transaction(() => {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(request.operationId) || store.getOperation(request.operationId)) throw new ApiError(409, "다른 작업에 사용된 요청 번호입니다");
    const prior = store.workflowAssignmentReceipt(request.operationId);
    if (prior) {
      const original = originalRequest(prior.request);
      if (prior.result.projectId !== projectId || prior.result.deliveryId !== deliveryId || prior.result.memberId !== prior.request.memberId || !original || canonicalAgentRequest(original) !== canonicalAgentRequest(request)) throw new ApiError(409, "다른 독립 지시 확인에 사용된 요청 번호입니다");
      return prior.result;
    }
    const delivery = store.requireDelivery(deliveryId), recovery = store.getDeliveryRecovery(deliveryId);
    if (delivery.status !== "queued" || delivery.attempts !== 0 || recovery?.phase !== "none" || store.listDeliveryDispatches(deliveryId).length) throw new ApiError(409, "아직 전달을 시도하지 않은 대기 지시만 독립 실행으로 확인할 수 있습니다");
    const independent: Authorization = { sourceMessageId: request.sourceMessageId, sessionGeneration: request.expectedSessionGeneration, blockerTaskId: request.expectedBlockerTaskId };
    const revision = authorizationRevision(store, projectId, delivery, independent);
    const receiptRequest: WorkflowAssignmentRequest = { kind: "independent_delivery", operationId: request.operationId, memberId: delivery.memberId, revision, independent };
    const result: WorkflowAssignmentResult = { operationId: request.operationId, projectId, taskId: delivery.taskId!, memberId: delivery.memberId, deliveryId, createdAt: new Date().toISOString() };
    store.saveWorkflowAssignmentReceipt(receiptRequest, result);
    return result;
  });
}

/** Read-only: permission is per delivery, not a cached property of the task or
 * native parallel setting. Invalid or changed evidence always fails closed. */
export function independentDeliveryAuthorized(store: Store, delivery: Delivery): boolean {
  try {
    const current = store.getDelivery(delivery.id);
    if (!current || current.projectId !== delivery.projectId || current.memberId !== delivery.memberId || current.taskId !== delivery.taskId || current.text !== delivery.text) return false;
    delivery = current;
    if (!["queued", "held"].includes(delivery.status)) return false;
    const receipt = store.workflowAssignmentReceiptForDelivery(delivery.id);
    if (!receipt || receipt.request.kind !== "independent_delivery" || !receipt.request.independent || receipt.request.operationId !== receipt.result.operationId || receipt.request.memberId !== delivery.memberId || receipt.result.memberId !== delivery.memberId || receipt.result.projectId !== delivery.projectId || receipt.result.taskId !== delivery.taskId || receipt.result.deliveryId !== delivery.id || store.getOperation(receipt.request.operationId)) return false;
    return receipt.request.revision === authorizationRevision(store, delivery.projectId, delivery, receipt.request.independent);
  } catch {
    return false;
  }
}
