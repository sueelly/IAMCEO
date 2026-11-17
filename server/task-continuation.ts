import type { Delivery, Member, Task } from "../shared/types.ts";
import { STAGE_LABEL } from "../shared/task-stage.ts";
import type { Store } from "./store.ts";
import type { ProgressFacts } from "./task-progress.ts";
import { relatedWork } from "./workflow.ts";
import { ordinaryInputAdmitted } from "./queue-admission.ts";
import { describeTaskContext } from "./task-context.ts";
import { bindingContract } from "./harness.ts";

interface Followthrough {
  task_id: string; project_id: string; source_delivery_id: string | null; evidence_key: string;
  delivery_id: string | null; round: number; no_progress_count: number; next_attempt_at: string | null;
  pause_token: string | null; pause_reason: string | null; paused_at: string | null;
  pause_source_seq: number; pause_mark_seq: number; attention_decision_id: string | null; updated_at: string;
}
interface Source { id: string; task_id: string; member_id: string; kind: string; status: string; seq: number; created_at: string; phase: string; recovery_reason: string | null }
interface Context {
  tasks: Map<string, Task>; facts: Map<string, ProgressFacts>; sources: Map<string, Source[]>;
  enrolled: Set<string>; pending: Delivery[]; running: Set<string>; own: Set<string>; boardDone: Set<string>; paused: Set<string>;
  markSources: Map<number, number | null>;
  criteriaSources: Map<string, Source>;
}
const waiting = new Set(["queued", "held", "delivering"]);
const finalOrExternal = new Set(["done", "hold", "owner", "approval", "held"]);

/** Waking inputs define execution scope; a report supplement follows the
 * original run's waking inputs without treating bundled quiet context as work. */
export function taskScopeForDeliveryIds(store: Store, deliveryIds: readonly string[]): string[] {
  const pending = [...deliveryIds], seen = new Set<string>(), tasks = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!; if (seen.has(id)) continue; seen.add(id);
    if (!store.getDelivery(id)?.wake) continue;
    const taskId = store.deliveryTaskId(id); if (taskId) tasks.add(taskId);
    const followup = store.getReportFollowupByDelivery(id);
    if (followup) pending.push(...(store.getExecutionJournal(followup.rootRunId)?.deliveryIds ?? []));
  }
  return [...tasks];
}

/** Shared read-only stop semantics for scheduling and the workflow projection. */
export function activeTaskContinuationPauses(store: Store, projectId: string): { taskId: string; reason: string; pausedAt: string | null }[] {
  const tasks = store.db.query("SELECT id,parent_task_id FROM tasks WHERE project_id=? AND merged_into IS NULL").all(projectId) as { id: string; parent_task_id: string | null }[];
  const parents = new Map(tasks.map(t => [t.id, t.parent_task_id]));
  const pauses = new Map((store.db.query("SELECT * FROM task_continuations WHERE project_id=? AND pause_token IS NOT NULL").all(projectId) as Followthrough[]).map(p => [p.task_id, p]));
  if (!pauses.size) return [];
  const owner = new Map((store.db.query("SELECT task_id,MAX(scope_seq) AS seq FROM deliveries WHERE project_id=? AND kind='user_message' AND wake=1 GROUP BY task_id").all(projectId) as { task_id: string; seq: number }[]).map(r => [r.task_id, r.seq]));
  const reopened = new Map((store.db.query("SELECT task_id,MAX(id) AS seq FROM task_stage_marks WHERE project_id=? AND stage='reopen' GROUP BY task_id").all(projectId) as { task_id: string; seq: number }[]).map(r => [r.task_id, r.seq]));
  return tasks.flatMap(task => {
    const seen = new Set<string>(); let id: string | null | undefined = task.id;
    let resumedByOwner = 0, reopenedAt = 0;
    while (id && !seen.has(id)) {
      seen.add(id); const p = pauses.get(id);
      // Resuming the node that originally paused also lifts its descendants'
      // inherited pause. A closer independent stop is checked before ancestors.
      resumedByOwner = Math.max(resumedByOwner, owner.get(id) ?? 0);
      reopenedAt = Math.max(reopenedAt, reopened.get(id) ?? 0);
      if (p && resumedByOwner <= p.pause_source_seq && reopenedAt <= p.pause_mark_seq) {
        return [{ taskId: task.id, reason: p.pause_reason ?? "대표가 직접 중단했습니다", pausedAt: p.paused_at }];
      }
      id = parents.get(id);
    }
    return [];
  });
}

/** A report is a turn outcome, not discharge of the original task obligation.
 * This coordinator creates NEW coordination requests, never retries old input.
 * Every request still passes the ordinary pump, receipt, ownership and limits.
 */
export class TaskContinuationCoordinator {
  constructor(private readonly store: Store, private readonly options: { intervalMs: number; sameLimit: number }) {}

  private row(taskId: string): Followthrough | null {
    return this.store.db.query("SELECT * FROM task_continuations WHERE task_id=?").get(taskId) as Followthrough | null;
  }
  private ensure(task: Task, source: Source | undefined, now: number): Followthrough {
    this.store.db.query(`INSERT INTO task_continuations(task_id,project_id,source_delivery_id,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(task_id) DO UPDATE SET source_delivery_id=COALESCE(excluded.source_delivery_id,task_continuations.source_delivery_id)`)
      .run(task.id, task.projectId, source?.id ?? null, new Date(now).toISOString());
    return this.row(task.id)!;
  }
  isContinuation(deliveryId: string): boolean {
    return !!this.store.db.query("SELECT 1 FROM task_continuation_deliveries WHERE delivery_id=?").get(deliveryId);
  }

  private awaitingCriteria(delivery: Delivery, taskId: string): boolean {
    if (!["queued", "held"].includes(delivery.status) || this.store.unconfirmedDelegatedTask(delivery.id) !== taskId ||
      !ordinaryInputAdmitted(this.store, delivery.id)) return false;
    const recovery = this.store.getDeliveryRecovery(delivery.id), dispatch = this.store.listDeliveryDispatches(delivery.id).at(-1);
    // A missing contract cannot turn an uncertain or stopped write into fresh
    // authority. Only the untouched queue or a proven pre-write refusal qualifies.
    return delivery.attempts === 0 && !dispatch && (!recovery || recovery.phase === "none") ||
      dispatch?.transportState === "rejected" && (recovery?.phase === "none" || recovery?.phase === "resolved" && recovery.reason === "not_received");
  }

  private context(projectId: string): Context {
    const tasks = new Map(this.store.listTasks(projectId).filter(t => !t.mergedInto).map(t => [t.id, t]));
    const facts = this.store.taskProgressFacts(projectId);
    const sources = new Map<string, Source[]>();
    for (const source of this.store.db.query(`SELECT d.id,d.task_id,d.member_id,d.kind,d.status,d.scope_seq AS seq,d.created_at,
      COALESCE(r.phase,'none') AS phase,r.reason AS recovery_reason
      FROM deliveries d JOIN tasks t ON t.id=d.task_id LEFT JOIN delivery_recovery r ON r.delivery_id=d.id WHERE d.project_id=? AND d.wake=1
      AND d.kind IN ('instruction','user_message') AND t.origin<>'server' ORDER BY d.rowid`).all(projectId) as Source[]) {
      const list = sources.get(source.task_id) ?? []; list.push(source); sources.set(source.task_id, list);
    }
    const enrolled = new Set((this.store.db.query("SELECT DISTINCT q.task_id FROM task_sequence q JOIN tasks t ON t.id=q.task_id WHERE t.project_id=?").all(projectId) as { task_id: string }[]).map(r => r.task_id));
    const own = new Set((this.store.db.query("SELECT c.delivery_id FROM task_continuation_deliveries c JOIN tasks t ON t.id=c.task_id WHERE t.project_id=?").all(projectId) as { delivery_id: string }[]).map(r => r.delivery_id));
    const running = new Set((this.store.db.query(`SELECT DISTINCT d.task_id FROM execution_journal e
      JOIN members m ON m.id=e.member_id JOIN json_each(e.delivery_ids_json) j JOIN deliveries d ON d.id=j.value
      WHERE e.project_id=? AND e.generation=m.session_generation AND e.ended_at IS NULL
      AND e.phase NOT IN ('ended','interrupted') AND d.task_id IS NOT NULL`).all(projectId) as { task_id: string }[]).map(r => r.task_id));
    // Batched report supplements intentionally have task_id=NULL. Their durable
    // root-run link retains every original scope while queued or executing.
    for (const r of this.store.db.query(`SELECT DISTINCT d.task_id FROM report_followups f
      JOIN execution_journal e ON e.run_id=f.root_run_id JOIN json_each(e.delivery_ids_json) j
      JOIN deliveries d ON d.id=j.value JOIN deliveries reminder ON reminder.id=f.delivery_id
      LEFT JOIN delivery_recovery rr ON rr.delivery_id=reminder.id
      WHERE f.project_id=? AND f.settled_at IS NULL AND d.task_id IS NOT NULL AND (
        reminder.status IN ('queued','held','delivering') OR rr.phase IN ('checking','waiting','needs_owner') OR
        EXISTS(SELECT 1 FROM delivery_dispatch_items i JOIN delivery_dispatches x ON x.id=i.dispatch_id
          WHERE i.delivery_id=reminder.id AND x.transport_state IN ('prepared','write_started','unknown')) OR
        EXISTS(SELECT 1 FROM execution_journal live JOIN members lm ON lm.id=live.member_id JOIN json_each(live.delivery_ids_json) lj
          WHERE lj.value=reminder.id AND live.generation=lm.session_generation AND live.ended_at IS NULL AND live.phase NOT IN ('ended','interrupted')) OR
        (reminder.status='delivered' AND NOT EXISTS(SELECT 1 FROM execution_journal ended JOIN json_each(ended.delivery_ids_json) ej
          WHERE ej.value=reminder.id AND ended.ended_at IS NOT NULL))
      )`).all(projectId) as { task_id: string }[]) running.add(r.task_id);
    const markSources = new Map((this.store.db.query("SELECT id,source_seq FROM task_stage_marks WHERE project_id=?").all(projectId) as { id: number; source_seq: number | null }[]).map(m => [m.id, m.source_seq]));
    const boardDone = new Set<string>();
    for (const w of this.store.listWork(projectId)) {
      if (w.sec !== "done") continue;
      const id = w.taskId ?? `tk_${w.id}`, task = tasks.get(id);
      // A legacy board card is not proof of completion for a modern coding task.
      if (!task || task.origin !== "board" || w.taskId) continue;
      const last = facts.get(id)?.reports.at(-1);
      if (!last || last.at <= w.updatedAt) boardDone.add(id);
    }
    const criteriaSources = new Map<string, Source>();
    for (const [taskId, list] of sources) {
      // A later accepted owner input does not settle an earlier queued delegation.
      // Keep its criteria request separate from the latest owner scope below.
      const awaiting = list.findLast(source => {
        const delivery = this.store.getDelivery(source.id);
        return delivery && this.awaitingCriteria(delivery, taskId);
      });
      if (awaiting) criteriaSources.set(taskId, awaiting);
    }
    return { tasks, facts, sources, enrolled, pending: this.store.listUndelivered(projectId), running, own, boardDone,
      paused: new Set(activeTaskContinuationPauses(this.store, projectId).map(p => p.taskId)), markSources, criteriaSources };
  }

  private authorized(task: Task, ctx: Context): boolean {
    const latest = ctx.sources.get(task.id)?.at(-1);
    if (ctx.boardDone.has(task.id)) return false;
    // Proven queued delegation authorizes defining its missing criteria only.
    // The original input stays queued until a binding contract exists.
    if (ctx.criteriaSources.has(task.id)) return true;
    // Sequence membership says order, not permission to replace cancelled or
    // uncertain instructions. Only accepted, reconciled scope can be continued.
    if (!latest || latest.status !== "delivered" || !["none", "resolved"].includes(latest.phase) || ["duplicate_draft", "not_received"].includes(latest.recovery_reason ?? "") || ctx.boardDone.has(task.id)) return false;
    if (ctx.enrolled.has(task.id) || this.row(task.id)?.source_delivery_id) return true;
    const f = ctx.facts.get(task.id), last = f?.reports.findLast(r => r.kind === "완료" || r.kind === "막힘");
    // Adopt proven unfinished legacy work, not every old delivered utterance.
    return !!(last && (last.kind === "막힘" || last.failed.length || last.notRun.length ||
      (last.kind === "완료" && (task.branch || task.worktree)))) || !!f?.marks.some(m => ["review", "merged", "applied", "reopen"].includes(m.stage));
  }
  private family(id: string, other: string | null, ctx: Context): boolean {
    return !!other && relatedWork(id, other, ctx.tasks);
  }
  private occupied(task: Task, ctx: Context, except?: string): boolean {
    if ([...ctx.running].some(id => this.family(task.id, id, ctx))) return true;
    return ctx.pending.some(d => d.id !== except && d.wake && this.family(task.id, d.taskId ?? null, ctx) &&
      !(ctx.criteriaSources.has(task.id) && this.awaitingCriteria(d, task.id)));
  }
  private familyGated(task: Task, ctx: Context): boolean {
    const ancestors = new Set<string>();
    let id = task.parentTaskId;
    while (id && !ancestors.has(id)) { ancestors.add(id); id = ctx.tasks.get(id)?.parentTaskId; }
    for (const other of ctx.tasks.values()) {
      if (other.id === task.id || !this.family(task.id, other.id, ctx)) continue;
      if (["hold", "owner", "approval", "held"].includes(other.progress?.stage ?? "") || ctx.paused.has(other.id)) return true;
      if (!ancestors.has(other.id) || other.progress?.stage !== "done") continue;
      const done = ctx.facts.get(other.id)?.marks.findLast(m => m.stage === "done");
      if (!done) continue;
      const source = ctx.sources.get(task.id)?.at(-1), cutoff = ctx.markSources.get(done.id);
      const newInput = source && (cutoff == null ? source.created_at > done.at : source.seq > cutoff);
      const reopen = ctx.facts.get(task.id)?.marks.findLast(m => m.stage === "reopen");
      if (!newInput && (!reopen || reopen.id < done.id)) return true;
    }
    return false;
  }
  private paused(task: Task, ctx: Context): boolean {
    return ctx.paused.has(task.id);
  }
  private key(task: Task, ctx: Context): string {
    const f = ctx.facts.get(task.id), outcome = f?.reports.findLast(r => r.kind === "완료" || r.kind === "막힘");
    const mark = f?.marks.at(-1), contract = this.store.getEffectiveContract(task.id);
    const sources = ctx.sources.get(task.id) ?? [];
    const owner = sources.findLast(s => s.kind === "user_message");
    const assignment = sources.findLast(s => s.kind === "instruction");
    const scopeText = assignment ? this.store.getDelivery(assignment.id)?.text.replace(/\s+/g, " ").trim() : null;
    // Deliberately omit timestamps, heartbeat, report wording and our own input.
    return JSON.stringify({ stage: task.progress?.stage, contract: contract ? [contract.taskId, contract.rev] : null,
      // A repeated downstream assignment is not progress. A genuinely new
      // owner instruction may explicitly revise scope or authorize a new attempt.
      source: { owner: owner?.id ?? null, assignment: scopeText },
      outcome: outcome ? [outcome.kind, outcome.memberId, outcome.passed, [...outcome.failed].sort(), [...outcome.notRun].sort()] : null,
      mark: mark ? [mark.stage, mark.evidence] : null });
  }
  private retire(delivery: Delivery, reason: string): void {
    const current = this.store.requireDelivery(delivery.id);
    if (!["queued", "held"].includes(current.status)) return;
    // A generated queued reminder can be cancelled. Never invent a receipt or
    // touch a write already in flight (the ordinary recovery owns that fence).
    const recovery = this.store.getDeliveryRecovery(current.id);
    const dispatch = this.store.listDeliveryDispatches(current.id).at(-1);
    const neverSent = current.attempts === 0 && !dispatch && (!recovery || recovery.phase === "none");
    const refused = dispatch?.transportState === "rejected" && (recovery?.phase === "none" || recovery?.phase === "resolved" && recovery.reason === "not_received");
    if (!neverSent && !refused) return;
    this.store.transaction(() => {
      this.store.markFailed(delivery.id, `후속 확인 취소: ${reason}`);
      this.store.db.query("UPDATE task_continuation_deliveries SET retired_reason=? WHERE delivery_id=?").run(reason, delivery.id);
    });
  }
  canDispatch(delivery: Delivery): boolean {
    if (!this.isContinuation(delivery.id)) return true;
    const ctx = this.context(delivery.projectId), task = ctx.tasks.get(delivery.taskId ?? "");
    let reason: string | null = null;
    if (!task || !this.authorized(task, ctx)) reason = "현재 실행 대상으로 확인되지 않습니다";
    else if (this.store.pendingTaskFailureDecision(task.id)) reason = "같은 실패 세 번의 대표 결재를 기다립니다";
    else if (this.paused(task, ctx)) reason = "대표가 중단한 업무입니다";
    else if (finalOrExternal.has(task.progress?.stage ?? "")) reason = task.progress?.next ?? "완료되었거나 외부 확인을 기다립니다";
    else if (this.familyGated(task, ctx)) reason = "연결된 업무의 완료·보류·대표 확인 범위를 먼저 확인합니다";
    else if (this.occupied(task, ctx, delivery.id)) reason = "기존 실행이나 후속 지시가 처리 중입니다";
    if (reason) { this.retire(delivery, reason); return false; }
    return true;
  }

  check(now: number, eligible: (member: Member) => boolean): Delivery[] {
    const queued: Delivery[] = [];
    for (const project of this.store.listProjects()) {
      if (project.archived || !project.runnerEnabled || !project.connection.ok) continue;
      const lead = this.store.getConductor(project.id);
      if (!lead || !eligible(lead)) continue;
      const ctx = this.context(project.id);
      // Ordinary instructions to the coordinator always take precedence.
      if (ctx.pending.some(d => d.memberId === lead.id && d.wake && !ctx.own.has(d.id) && ordinaryInputAdmitted(this.store, d.id) &&
        !(d.taskId && ctx.criteriaSources.has(d.taskId) && this.awaitingCriteria(d, d.taskId)))) continue;
      const candidates = [...ctx.tasks.values()].filter(t => this.authorized(t, ctx))
        .sort((a, b) => (this.row(a.id)?.next_attempt_at ?? a.createdAt).localeCompare(this.row(b.id)?.next_attempt_at ?? b.createdAt));
      for (const task of candidates) {
        if (this.store.pendingTaskFailureDecision(task.id)) continue;
        if (finalOrExternal.has(task.progress?.stage ?? "") || this.paused(task, ctx) || this.familyGated(task, ctx) || this.occupied(task, ctx)) continue;
        const f = ctx.facts.get(task.id), lastAt = Math.max(Date.parse(f?.reports.at(-1)?.at ?? "") || 0, Date.parse(f?.marks.at(-1)?.at ?? "") || 0);
        if (now < lastAt + this.options.intervalMs) continue;
        const sources = ctx.sources.get(task.id) ?? [];
        const criteriaSource = ctx.criteriaSources.get(task.id);
        const effectiveSource = sources.findLast(s => s.kind === "user_message") ?? sources.at(-1);
        const state = this.ensure(task, effectiveSource, now);
        if (state.next_attempt_at && now < Date.parse(state.next_attempt_at)) continue;
        const old = state.delivery_id ? this.store.getDelivery(state.delivery_id) : null;
        const retired = old ? this.store.db.query("SELECT retired_reason FROM task_continuation_deliveries WHERE delivery_id=?").get(old.id) as { retired_reason: string | null } | null : null;
        if (old && waiting.has(old.status)) continue;
        if (old && !retired?.retired_reason) {
          if (old.status !== "delivered") continue;
          const ended = this.store.db.query(`SELECT e.ended_at FROM execution_journal e JOIN json_each(e.delivery_ids_json) j
            WHERE j.value=? AND e.ended_at IS NOT NULL ORDER BY e.rowid DESC LIMIT 1`).get(old.id) as { ended_at: string } | null;
          if (!ended || now < Date.parse(ended.ended_at) + this.options.intervalMs) continue;
        }
        const key = this.key(task, ctx);
        const attention = state.attention_decision_id ? this.store.getDecision(state.attention_decision_id) : null;
        const answered = attention && ["answered", "delivered"].includes(attention.status);
        const noProgress = answered || key !== state.evidence_key || retired?.retired_reason ? 0 : state.no_progress_count + (old ? 1 : 0);
        if (noProgress >= this.options.sameLimit) {
          // Repeated no-op coordination remains an OPEN task with an actionable
          // owner item. It is neither silently abandoned nor retried forever.
          this.store.transaction(() => {
            const decision = this.store.createDecision({ projectId: project.id, memberId: lead.id, who: "업무 추적",
              taskId: task.id, title: `후속 조정 확인: ${task.title}`,
              detail: [
                `‘${project.name}’의 ‘${task.title}’ 업무에서 다음 진행 방법을 정해야 합니다.`,
                `결재를 만들기 직전 이 업무의 상태: ${STAGE_LABEL[task.progress!.stage]}. ${task.progress?.next ?? "아직 충족하지 못한 완료 조건을 확인해야 합니다."}`,
                "대표님은 아래 요청과 보고를 바탕으로 이 업무를 현재 직원에게 계속 맡길지, 조사 접근을 바꿀지, 자료·권한을 보완하거나 외부 결과를 기다릴지 정해 주세요. 담당 총괄이 답변 범위에서 배정을 조정합니다.",
                "", describeTaskContext(this.store, task, { sourceDeliveryId: state.source_delivery_id, facts: f }),
                "", "자동 조정을 멈춘 이유:",
                `앱이 이 업무의 총괄에게 남은 조건 확인과 다음 행동 배정을 요청한 조정 요청 ${state.round}회가 종료됐습니다. 이 수는 실제 구현이나 검사 횟수가 아닙니다.`,
                `최근 조정 ${noProgress}회 동안 기록된 요청 범위·완료 기준·검사 결과·단계 근거에 변화가 없습니다. 코드나 외부 환경이 그대로라고 확인한 것은 아닙니다.`,
                "이 업무는 완료 처리하지 않았으며, 대표 답을 기다리는 동안 같은 자동 조정을 반복하지 않습니다.",
              ].join("\n") });
            this.store.db.query("UPDATE task_continuations SET attention_decision_id=?,no_progress_count=?,updated_at=? WHERE task_id=?")
              .run(decision.id, noProgress, new Date(now).toISOString(), task.id);
          });
          continue;
        }
        const delivery = this.store.transaction(() => {
          // Synchronous transaction covers claim and enqueue; another tick or
          // a restarted coordinator sees the same durable delivery identity.
          const current = this.row(task.id)!;
          if (current.delivery_id !== state.delivery_id || current.round !== state.round) return null;
          const contract = this.store.getEffectiveContract(task.id);
          const criteriaStep = bindingContract(contract)
            ? `완료 기준은 현재 확정 계약 r${contract!.rev}입니다. 남은 기준을 확인하고 담당 직원에게 보완·검토를 맡기세요.`
            : `완료 기준을 먼저 확정하세요. 원 지시의 범위를 유지해 task(task_id "${task.id}", contract {goal, acceptance, kind})로 판정 가능한 기준을 정하거나, 직원 제안이 맞으면 confirm_contract_rev로 확인하세요. 기준 확정 전에는 구현을 재배정하지 마세요.`;
          const decisions = this.store.listAllDoneDecisions(project.id).filter(d => d.taskId === task.id &&
            (["answered", "delivered"].includes(d.status) || d.closeKind === "decided" && d.closeQuote))
            .sort((a, b) => (a.answeredAt ?? a.closedAt ?? a.updatedAt).localeCompare(b.answeredAt ?? b.closedAt ?? b.updatedAt)).slice(-3);
          const ownerAnswers = decisions.map(d => `최근 대표 결재 답 #${d.id}: ${[d.options.find(o => o.k === d.choice)?.label, d.note, d.closeQuote].filter(Boolean).join(" / ")}`).join("\n");
          const context = describeTaskContext(this.store, task, { sourceDeliveryId: state.source_delivery_id, facts: f });
          const purpose = criteriaSource
            ? `대기 중인 위임의 완료 기준 확정: #${task.id} '${task.title}'\n위임 지시 #${criteriaSource.id}는 확정 기준이 없어 아직 전송하지 않고 원문 그대로 보관 중입니다.`
            : `업무 계속 진행: #${task.id} '${task.title}'\n한 번의 보고·턴은 끝났지만 완료 조건이 남아 있습니다.`;
          const nextAction = criteriaSource
            ? `현재 승인 범위의 완료 기준만 먼저 확정하세요. 확정 후 보관된 지시 #${criteriaSource.id}가 일반 입장 검사와 수신 확인을 거쳐 한 번 전달됩니다. 직원은 현재 업무 계약을 확인해야 합니다. 같은 원 지시를 team_assign으로 다시 만들거나 구현을 직접 시작하지 마세요.`
            : `기존 수정·보고·계약을 확인하고 현재 승인 범위에 필요한 다음 행동을 수행하세요. 구현과 반영까지 승인된 업무라면 보완 → 독립 검토 → 메인 통합 → 실제 적용 확인 → task_stage(done)까지 이어갑니다. 코딩 완료는 통합·적용 근거를 남깁니다. 같은 지시를 통째로 재실행하거나 완료 근거를 만들지 마세요. 이미 처리한 범위는 다시 하지 말고 남은 조건만 처리하세요.\n담당자 없는 승인된 범위는 기존 적합한 직원에게 team_assign으로 맡기고, 검토 실패는 원 작성자에게 연결하세요. 총괄의 확인·막힘 보고만으로 끝내지 마세요. 후보·검토 요청을 구현 승인으로 확대하지 마세요.`;
          const d = this.store.enqueue({ projectId: project.id, memberId: lead.id, kind: "system", wake: true, urgent: false, taskId: task.id,
            text: `[시스템] ${purpose}\n최신 대표 지시가 이전 지시·계약보다 우선합니다. 조사·검토만 허용했으면 구현이나 배포를 시작하지 말고 허용된 결과만 확인하세요.\n현재 단계: ${STAGE_LABEL[task.progress!.stage]}\n${criteriaStep}\n다음 조건: ${task.progress?.next ?? "현재 결과와 미완료 조건을 확인해 담당자에게 구체적으로 맡기기"}\n${contract ? `기록된 완료 조건(최신 지시와 대조): ${contract.acceptance.join(" / ")}\n` : ""}${context}\n${ownerAnswers}\n최신 대표 지시와 결재 답의 제한을 우선합니다. 총괄은 제작·구현·제품 설계를 직접 하지 않고 기준 정의·배정·검토 요청·상태 종합을 맡습니다.\n${nextAction}\n대표 중단·터미널 승인·수신 불확실·계정 한도를 우회하지 마세요. 같은 실패 세 번의 결재가 있으면 대표 답 전에는 reopen하거나 재배정하지 마세요. 대표가 정한 범위 안에서만 다시 열고 직원에게 맡기세요.` });
          const stamp = new Date(now).toISOString();
          this.store.db.query("INSERT INTO task_continuation_deliveries(delivery_id,task_id,round,created_at) VALUES(?,?,?,?)").run(d.id, task.id, state.round + 1, stamp);
          this.store.db.query(`UPDATE task_continuations SET evidence_key=?,delivery_id=?,round=round+1,no_progress_count=?,next_attempt_at=?,attention_decision_id=NULL,updated_at=? WHERE task_id=?`)
            .run(key, d.id, noProgress, new Date(now + this.options.intervalMs).toISOString(), stamp, task.id);
          // Proven unfinished historical assignments now participate in row order.
          for (const s of ctx.sources.get(task.id) ?? []) if (s.status === "delivered") this.store.db.query("INSERT OR IGNORE INTO task_sequence(member_id,task_id,entered_at) VALUES(?,?,?)").run(s.member_id, task.id, s.created_at);
          return d;
        });
        if (delivery) { queued.push(delivery); break; }
      }
    }
    return queued;
  }

  pause(taskIds: readonly string[], token: string, reason: string): void {
    this.store.transaction(() => {
      for (const id of new Set(taskIds)) {
        const task = this.store.getTask(id); if (!task) continue;
        this.ensure(task, undefined, Date.now());
        const seq = this.store.db.query("SELECT COALESCE(MAX(scope_seq),0) AS seq FROM deliveries").get() as { seq: number };
        const mark = this.store.db.query("SELECT COALESCE(MAX(id),0) AS seq FROM task_stage_marks").get() as { seq: number };
        this.store.db.query("UPDATE task_continuations SET pause_token=?,pause_reason=?,paused_at=?,pause_source_seq=?,pause_mark_seq=?,updated_at=? WHERE task_id=?")
          .run(token, reason, new Date().toISOString(), seq.seq, mark.seq, new Date().toISOString(), id);
      }
    });
  }
  clearPause(taskIds: readonly string[], token: string): void {
    this.store.transaction(() => {
      for (const id of new Set(taskIds)) this.store.db.query("UPDATE task_continuations SET pause_token=NULL,pause_reason=NULL,paused_at=NULL WHERE task_id=? AND pause_token=?").run(id, token);
    });
  }
}
