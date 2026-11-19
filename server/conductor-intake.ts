import type { Delivery, Member, Message } from "../shared/types.ts";
import { relatedWork } from "./workflow.ts";
import { untouchedQueuedInput } from "./review-routing.ts";
import type { Store } from "./store.ts";

function reliefMember(store: Store, lead: Member): Member {
  const existing = store.conductorIntakeId(lead.id);
  if (existing && !store.isRetiredMember(existing)) return store.requireMember(existing);
  let handle = "command-intake";
  let name = "대표 지시 수신 총괄";
  for (let i = 2; store.findMember(lead.projectId, handle) || store.findMember(lead.projectId, name); i++) {
    handle = "command-intake-" + i;
    name = "대표 지시 수신 총괄 " + i;
  }
  const relief = store.createMember({
    projectId: lead.projectId, handle, name, role: "대표 원문을 받아 기존 업무·계약과 담당자를 확인하고 지시를 조정한다",
    kind: "conductor", origin: "runner", status: "offline", cwd: lead.cwd,
    cli: lead.cli, modelOverride: lead.modelOverride, effortOverride: lead.effortOverride,
  });
  store.db.query(`INSERT INTO conductor_intake(lead_id,relief_id) VALUES(?,?)
    ON CONFLICT(lead_id) DO UPDATE SET relief_id=excluded.relief_id`).run(lead.id, relief.id);
  return relief;
}

function stoppedNotificationScope(store: Store, lead: Member) {
  const state = store.inputState(lead.id);
  if (state.lease || !state.unresolvedDispatches.length || store.hasLogicalDeliveryFence(lead.id) ||
      store.listPendingExecutions().some(run => run.memberId === lead.id)) return null;
  const protectedTasks = new Set<string>();
  let unknown = false;
  for (const dispatch of state.unresolvedDispatches) {
    if (!["prepared", "write_started", "unknown"].includes(dispatch.transportState) || !dispatch.items.length) return null;
    for (const item of dispatch.items) {
      const original = store.requireDelivery(item.deliveryId);
      if (!["system", "report"].includes(original.kind) || store.getDeliveryRecovery(original.id)?.phase !== "stopped") return null;
      if (!original.wake) continue;
      if (original.taskId) protectedTasks.add(original.taskId);
      else unknown = true;
    }
  }
  const parents = store.db.query<{ id: string; parentTaskId: string | null }, [string]>(
    "SELECT id,parent_task_id AS parentTaskId FROM tasks WHERE project_id=?").all(lead.projectId);
  const tasks = new Map(parents.map(t => [t.id, t]));
  return { blocksAutomatic: (targets: string[]) => unknown ||
    targets.some(id => [...protectedTasks].some(protectedId => relatedWork(id, protectedId, tasks))) };
}

/** The original terminal still owns its stopped write. Only untouched, independently
 * sourced work can be assigned to another managed conductor in this project. */
export function handoffConductorInputs(store: Store, lead: Member, pending: Delivery[],
  boardRequest: (input: Delivery) => boolean, prepareText: (input: Delivery, source: Message, relief: Member) => string | null): string | null {
  if (lead.kind !== "conductor" || lead.origin !== "runner" || lead.status !== "idle" || lead.executionIssue ||
      !pending.some(d => d.wake && ["user_message", "system", "report"].includes(d.kind)) || store.getConductor(lead.projectId)?.id !== lead.id) return null;
  return store.transaction(() => {
    const project = store.requireProject(lead.projectId);
    if (project.archived || !project.runnerEnabled) return null;
    const scope = stoppedNotificationScope(store, lead);
    if (!scope) return null;
    let movedTo: string | null = null;
    for (const input of pending) {
      if (!untouchedQueuedInput(store, input) || store.db.query("SELECT 1 FROM manual_inbox_items WHERE delivery_id=?").get(input.id)) continue;
      let source: Message | null = null;
      if (input.kind === "user_message" && input.refType === "message" && input.refId) {
        source = store.getMessage(input.refId);
        if (!source?.mine || source.delivery !== "queued" || source.projectId !== project.id ||
            (source.targetMemberId && source.targetMemberId !== lead.id)) continue;
      } else if (input.kind === "report" && input.refType === "message" && input.refId) {
        const report = store.getMessage(input.refId);
        if (!report || report.mine || report.kind !== "막힘" || report.projectId !== project.id || !report.memberId ||
            !input.taskId || report.taskId !== input.taskId || !store.historicalWorker(project.id, report.memberId) || scope.blocksAutomatic([input.taskId])) continue;
      } else if (input.kind === "system" && !input.refId && !input.refType) {
        const reviews = store.db.query<{ task_id: string; contract_task_id: string; status: string }, [string]>(
          "SELECT task_id,contract_task_id,status FROM task_completion_reviews WHERE attention_delivery_id=?").all(input.id);
        if (!reviews.some(row => row.status === "pending") && !boardRequest(input)) continue;
        if (scope.blocksAutomatic(reviews.flatMap(row => [row.task_id, row.contract_task_id]))) continue;
      } else continue;
      const relief = reliefMember(store, lead);
      if (relief.origin !== "runner" || relief.kind !== "conductor" || relief.status === "asleep" || relief.executionIssue ||
          (relief.cli === "codex" && relief.codexSpeed !== "standard")) break;
      const text = source ? prepareText(input, source, relief) : input.text;
      if (text !== null && store.handoffConductorInput(input, relief.id, text)) movedTo = relief.id;
    }
    return movedTo;
  });
}
