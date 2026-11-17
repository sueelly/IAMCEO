import type { Member } from "../../shared/types.ts";
import type { Store } from "../store.ts";
import { createHash } from "node:crypto";
import { findSensitive, MemoryError, memoryProjectId, memoryTaskId, redactSensitive, type DevMemory, type Experience } from "./dev-memory.ts";

export const MEMORY_FEEDBACK_SCHEMA = `CREATE TABLE IF NOT EXISTS memory_feedback_exposures (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  task_id TEXT,
  scope TEXT NOT NULL,
  experience_id TEXT NOT NULL,
  source_task_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  immediate INTEGER NOT NULL DEFAULT 1 CHECK (immediate IN (0,1)),
  delivery_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(delivery_ids_json)),
  outcome TEXT CHECK (outcome IN ('helped','did_not_help','contradicted','not_used')),
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'unassessed' CHECK (status IN ('unassessed','pending','sent','not_used','rejected')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_at TEXT,
  last_error TEXT,
  assessed_at TEXT,
  accepted_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, member_id, scope, experience_id),
  CHECK ((status='unassessed' AND outcome IS NULL AND reason IS NULL AND assessed_at IS NULL)
    OR (status='not_used' AND outcome='not_used' AND length(reason)>0 AND assessed_at IS NOT NULL)
    OR (status IN ('pending','sent','rejected') AND outcome IN ('helped','did_not_help','contradicted') AND length(reason)>0 AND assessed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS memory_feedback_due ON memory_feedback_exposures(status,next_at);
CREATE INDEX IF NOT EXISTS memory_feedback_member ON memory_feedback_exposures(project_id,member_id,scope,status);`;

type Actor = Pick<Member, "id" | "projectId">;
export type MemoryFeedbackOutcome = "helped" | "did_not_help" | "contradicted" | "not_used";
type RemoteOutcome = Exclude<MemoryFeedbackOutcome, "not_used">;
type Status = "unassessed" | "pending" | "sent" | "not_used" | "rejected";
export interface MemoryFeedbackExposure { id: string; summary: string; sourceTaskId: string; firstSeenAt: string }
export interface MemoryFeedbackAssessment {
  id: string;
  experienceId: string;
  outcome: MemoryFeedbackOutcome;
  reason: string;
  status: Exclude<Status, "unassessed">;
  attempts: number;
  assessedAt: string;
  acceptedAt: string | null;
  lastError: string | null;
}
export interface MemoryFeedbackStatus {
  unassessed: number; awaitingDelivery: number; pending: number; sent: number; notUsed: number; rejected: number; lastError: string | null;
}
interface Options { now?: () => number; retryMs?: number; batchSize?: number; secrets?: () => readonly string[] }
interface Row {
  id: string; project_id: string; member_id: string; task_id: string | null; scope: string;
  experience_id: string; source_task_id: string; summary: string; first_seen_at: string;
  immediate: number; delivery_ids_json: string;
  outcome: MemoryFeedbackOutcome | null; reason: string | null; status: Status; attempts: number;
  next_at: string | null; last_error: string | null; assessed_at: string | null; accepted_at: string | null; updated_at: string;
}

export class MemoryFeedbackError extends Error {
  constructor(readonly status: number, message: string, readonly code: string) { super(message); this.name = "MemoryFeedbackError"; }
}

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const OUTCOMES: readonly string[] = ["helped", "did_not_help", "contradicted", "not_used"];
/** New search exposures only; no retrospective inference about historical use. */
export class MemoryFeedback {
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing: Promise<void> | null = null;
  private stopped = false;
  private readonly now: () => number;
  private readonly retryMs: number;
  private readonly batchSize: number;

  constructor(private readonly store: Store, private readonly memory: DevMemory, private readonly options: Options = {}) {
    this.now = options.now ?? Date.now;
    this.retryMs = Math.max(1, options.retryMs ?? 30_000);
    this.batchSize = Math.max(1, Math.min(100, options.batchSize ?? 25));
  }

  private secrets(): readonly string[] { return this.options.secrets?.() ?? this.memory.secrets(); }
  private at(): string { return new Date(this.now()).toISOString(); }
  private canonicalTask(projectId: string, taskId: string | null): string | null {
    const task = taskId ? this.store.getTask(taskId) : null;
    return task?.projectId === projectId ? this.store.resolveTask(task).id : taskId;
  }

  private rowScope(row: Row): string {
    return memoryTaskId(this.canonicalTask(row.project_id, row.task_id), row.member_id);
  }

  private ownSource(projectId: string, scope: string, sourceTaskId: string): boolean {
    return this.canonicalTask(projectId, sourceTaskId) === scope;
  }

  private scope(member: Actor, taskId: string | null): string {
    const actual = this.store.getMember(member.id);
    if (!actual || actual.projectId !== member.projectId) throw new MemoryFeedbackError(403, "이 직원의 기억 범위를 확인할 수 없습니다", "MEMORY_FEEDBACK_SCOPE");
    if (taskId !== null && this.store.getTask(taskId)?.projectId !== actual.projectId) throw new MemoryFeedbackError(403, "다른 프로젝트의 업무에 기억 평가를 남길 수 없습니다", "MEMORY_FEEDBACK_SCOPE");
    return memoryTaskId(this.canonicalTask(actual.projectId, taskId), actual.id);
  }

  private scopedRows(member: Actor, scope: string, experienceId?: string): Row[] {
    return this.store.db.query<Row, string[]>(`SELECT * FROM memory_feedback_exposures
      WHERE project_id=? AND member_id=?${experienceId === undefined ? "" : " AND experience_id=?"} ORDER BY first_seen_at,rowid`)
      .all(member.projectId, member.id, ...(experienceId === undefined ? [] : [experienceId]))
      .filter(row => this.rowScope(row) === scope && !this.ownSource(row.project_id, scope, row.source_task_id));
  }

  /** A merge preserves receipt scope. An unrelated reclassification does not. */
  private exposed(row: Row): boolean {
    if (row.immediate) return true;
    const scope = this.rowScope(row);
    return this.store.db.query<{ task_id: string | null }, [string, string, string]>(`SELECT task_id FROM deliveries
      WHERE id IN (SELECT value FROM json_each(?)) AND project_id=? AND member_id=? AND status='delivered'`)
      .all(row.delivery_ids_json, row.project_id, row.member_id)
      .some(delivery => memoryTaskId(this.canonicalTask(row.project_id, delivery.task_id), row.member_id) === scope);
  }

  private validDeliveries(member: Actor, taskId: string | null, ids: readonly string[]): string[] {
    return [...new Set(ids)].filter(id => {
      const delivery = this.store.getDelivery(id);
      return delivery?.projectId === member.projectId && delivery.memberId === member.id &&
        this.canonicalTask(member.projectId, this.store.deliveryTaskId(id)) === this.canonicalTask(member.projectId, taskId);
    });
  }

  /** Manual searches are immediate. Automatic context is activated by delivery receipt. */
  register(member: Actor, taskId: string | null, experiences: readonly Experience[], options?: { deliveryIds?: readonly string[] }): number {
    const scope = this.scope(member, taskId);
    taskId = this.canonicalTask(member.projectId, taskId);
    if (!this.memory.enabledFor(member.projectId)) return 0;
    const immediate = options?.deliveryIds === undefined;
    const deliveryIds = this.validDeliveries(member, taskId, options?.deliveryIds ?? []);
    if (!immediate && !deliveryIds.length) return 0;
    const project = memoryProjectId(member.projectId), at = this.at();
    return this.store.transaction(() => {
      let added = 0;
      for (const experience of experiences) {
        const sourceTaskId = experience.source?.task_id;
        if (experience.project_id !== project || !/^exp-[A-Za-z0-9_-]{1,195}$/.test(experience.id) ||
            typeof sourceTaskId !== "string" || !ID.test(sourceTaskId) || this.ownSource(member.projectId, scope, sourceTaskId)) continue;
        const identity = JSON.stringify([member.projectId, member.id, scope, experience.id]);
        const id = "mfb-" + createHash("sha256").update(identity).digest("hex").slice(0, 40);
        const existing = this.scopedRows(member, scope, experience.id);
        const previous = existing.find(row => row.status !== "unassessed") ?? existing[0];
        if (previous) {
          if (previous.status === "unassessed") this.store.db.query(`UPDATE memory_feedback_exposures SET immediate=?,delivery_ids_json=?,updated_at=? WHERE id=?`)
            .run(immediate || previous.immediate ? 1 : 0, JSON.stringify([...new Set([...JSON.parse(previous.delivery_ids_json) as string[], ...deliveryIds])]), at, previous.id);
          continue;
        }
        const summary = redactSensitive(typeof experience.summary === "string" ? experience.summary : experience.id, this.secrets()).replace(/\s+/g, " ").slice(0, 300);
        this.store.db.query(`INSERT INTO memory_feedback_exposures
          (id,project_id,member_id,task_id,scope,experience_id,source_task_id,summary,first_seen_at,immediate,delivery_ids_json,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, member.projectId, member.id, taskId, scope, experience.id, sourceTaskId, summary, at, immediate ? 1 : 0, JSON.stringify(deliveryIds), at);
        added++;
      }
      return added;
    });
  }

  /** A cache can extend receipts only for known exposures; missing provenance requires a fresh search. */
  registerCached(member: Actor, taskId: string | null, experienceIds: readonly string[], deliveryIds: readonly string[]): boolean {
    const scope = this.scope(member, taskId);
    if (!this.memory.enabledFor(member.projectId)) return false;
    const receipts = this.validDeliveries(member, taskId, deliveryIds);
    if (!receipts.length) return false;
    return this.store.transaction(() => {
      const rows: Row[] = [];
      for (const id of new Set(experienceIds)) {
        const existing = this.scopedRows(member, scope, id);
        const row = existing.find(item => item.status !== "unassessed") ?? existing[0];
        if (!row) return false;
        rows.push(row);
      }
      for (const row of rows) if (row.status === "unassessed") {
        this.store.db.query("UPDATE memory_feedback_exposures SET delivery_ids_json=?,updated_at=? WHERE id=?")
          .run(JSON.stringify([...new Set([...JSON.parse(row.delivery_ids_json) as string[], ...receipts])]), this.at(), row.id);
      }
      return true;
    });
  }

  pending(member: Actor, taskId: string | null): MemoryFeedbackExposure[] {
    const scope = this.scope(member, taskId);
    if (!this.memory.enabledFor(member.projectId)) return [];
    const rows = this.scopedRows(member, scope), assessed = new Set(rows.filter(row => row.status !== "unassessed").map(row => row.experience_id));
    const pending = new Map<string, MemoryFeedbackExposure>();
    for (const row of rows) if (!assessed.has(row.experience_id) && !pending.has(row.experience_id) && this.exposed(row)) {
      pending.set(row.experience_id, { id: row.experience_id, summary: row.summary, sourceTaskId: row.source_task_id, firstSeenAt: row.first_seen_at });
    }
    return [...pending.values()];
  }

  /** This synchronous write can join the report transaction. It never sends HTTP. */
  assess(member: Actor, taskId: string | null, id: string, outcome: MemoryFeedbackOutcome, reason: string): MemoryFeedbackAssessment {
    const scope = this.scope(member, taskId);
    if (!this.memory.enabledFor(member.projectId)) throw new MemoryFeedbackError(400, "이 프로젝트의 기억 연결이 꺼져 있습니다", "MEMORY_FEEDBACK_DISABLED");
    if (!OUTCOMES.includes(outcome)) throw new MemoryFeedbackError(400, "기억 활용 결과를 확인해 주세요", "MEMORY_FEEDBACK_INVALID");
    if (typeof reason !== "string" || !reason.trim() || reason.trim().length > 2000) throw new MemoryFeedbackError(400, "기억을 적용한 결과나 사용하지 않은 이유를 1~2000자로 적어 주세요", "MEMORY_FEEDBACK_REASON");
    const normalized = reason.trim();
    if (findSensitive(normalized, this.secrets())) throw new MemoryFeedbackError(400, "기억 활용 근거에 인증값이 포함되어 저장하지 않았습니다", "MEMORY_FEEDBACK_SENSITIVE");
    return this.store.transaction(() => {
      const rows = this.scopedRows(member, scope, id), assessed = rows.filter(row => row.status !== "unassessed");
      if (assessed.some(row => row.outcome !== outcome || row.reason !== normalized)) throw new MemoryFeedbackError(409, "이미 남긴 기억 평가와 다릅니다. 앞 평가를 덮어쓰지 않았습니다", "MEMORY_FEEDBACK_CONFLICT");
      const row = assessed[0] ?? rows.find(row => this.exposed(row));
      if (!row) throw new MemoryFeedbackError(400, "이 업무에서 전달받은 기억만 평가할 수 있습니다", "MEMORY_NOT_EXPOSED");
      if (row.status !== "unassessed") {
        if (row.outcome !== outcome || row.reason !== normalized) throw new MemoryFeedbackError(409, "이미 남긴 기억 평가와 다릅니다. 앞 평가를 덮어쓰지 않았습니다", "MEMORY_FEEDBACK_CONFLICT");
        return this.assessment(row);
      }
      const at = this.at(), status = outcome === "not_used" ? "not_used" : "pending";
      this.store.db.query(`UPDATE memory_feedback_exposures SET outcome=?,reason=?,status=?,next_at=?,assessed_at=?,updated_at=?
        WHERE id=? AND status='unassessed'`).run(outcome, normalized, status, status === "pending" ? at : null, at, at, row.id);
      return this.assessment(this.store.db.query<Row, [string]>("SELECT * FROM memory_feedback_exposures WHERE id=?").get(row.id)!);
    });
  }

  private assessment(row: Row): MemoryFeedbackAssessment {
    return { id: row.id, experienceId: row.experience_id, outcome: row.outcome!, reason: row.reason!, status: row.status as MemoryFeedbackAssessment["status"],
      attempts: row.attempts, assessedAt: row.assessed_at!, acceptedAt: row.accepted_at, lastError: row.last_error };
  }

  status(projectId?: string): MemoryFeedbackStatus {
    const result: MemoryFeedbackStatus = { unassessed: 0, awaitingDelivery: 0, pending: 0, sent: 0, notUsed: 0, rejected: 0, lastError: null };
    const where = projectId === undefined ? "" : " WHERE project_id=?", params = projectId === undefined ? [] : [projectId];
    for (const row of this.store.db.query<{ status: Status; count: number }, string[]>(`SELECT status,COUNT(*) count FROM memory_feedback_exposures${where} GROUP BY status`).all(...params)) {
      result[row.status === "not_used" ? "notUsed" : row.status] = row.count;
    }
    result.unassessed = 0;
    const checked = new Set<string>();
    for (const row of this.store.db.query<Row, string[]>(`SELECT * FROM memory_feedback_exposures WHERE status='unassessed'
      ${projectId === undefined ? "" : " AND project_id=?"}`).all(...params)) {
      const scope = this.rowScope(row), key = JSON.stringify([row.project_id, row.member_id, scope, row.experience_id]);
      if (checked.has(key) || this.ownSource(row.project_id, scope, row.source_task_id)) continue;
      checked.add(key);
      const related = this.scopedRows({ id: row.member_id, projectId: row.project_id }, scope, row.experience_id);
      // A merge can join duplicate exposures. One explicit assessment covers that current scope.
      if (related.some(item => item.status !== "unassessed")) continue;
      if (related.some(item => this.exposed(item))) result.unassessed++;
      else result.awaitingDelivery++;
    }
    result.lastError = this.store.db.query<{ last_error: string }, string[]>(`SELECT last_error FROM memory_feedback_exposures
      WHERE last_error IS NOT NULL${projectId === undefined ? "" : " AND project_id=?"} ORDER BY updated_at DESC,rowid DESC LIMIT 1`).get(...params)?.last_error ?? null;
    return result;
  }

  flush(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.flushing) return this.flushing;
    const running = this.sendDue();
    const tracked = running.finally(() => { if (this.flushing === tracked) this.flushing = null; });
    this.flushing = tracked;
    return tracked;
  }

  private async sendDue(): Promise<void> {
    // The durable lease is longer than DevMemory's 10-second HTTP timeout.
    const allowed = this.store.db.query<{ project_id: string }, [string]>(`SELECT DISTINCT project_id FROM memory_feedback_exposures
      WHERE status='pending' AND next_at<=?`).all(this.at()).map(row => row.project_id).filter(id => this.memory.enabledFor(id));
    if (!allowed.length) return;
    // Filter before the batch limit so a disabled project's backlog cannot starve others.
    const rows = this.store.db.query<Row, (string | number)[]>(`SELECT * FROM memory_feedback_exposures
      WHERE status='pending' AND next_at<=? AND project_id IN (${allowed.map(() => "?").join(",")})
      ORDER BY next_at,rowid LIMIT ?`).all(this.at(), ...allowed, this.batchSize);
    for (const row of rows) {
      if (this.stopped) break;
      if (!this.memory.enabledFor(row.project_id)) continue;
      const attempt = row.attempts + 1, at = this.at();
      const claimed = this.store.db.query(`UPDATE memory_feedback_exposures SET attempts=?,next_at=?,updated_at=?
        WHERE id=? AND status='pending' AND attempts=? AND next_at<=?`)
        .run(attempt, new Date(this.now() + 15_000).toISOString(), at, row.id, row.attempts, at);
      if (!claimed.changes) continue;
      try {
        // The ledger ID is stable across retries and distinct from pre-ledger direct feedback.
        const result = await this.memory.feedback(row.project_id, row.experience_id, row.scope, row.id, row.outcome as RemoteOutcome);
        if (!this.validReceipt(row, result)) throw new MemoryError("unreachable", "기억 평가의 원격 영수증을 확인하지 못했습니다", undefined, true);
        this.store.db.query(`UPDATE memory_feedback_exposures SET status='sent',next_at=NULL,last_error=NULL,accepted_at=?,updated_at=?
          WHERE id=? AND status='pending' AND attempts=?`).run(this.at(), this.at(), row.id, attempt);
      } catch (error) {
        const retry = !(error instanceof MemoryError) || error.retryable || ["key_unreadable", "not_configured"].includes(error.code) || [401, 403, 408, 429].includes(error.status ?? 0);
        const detail = redactSensitive(error instanceof Error ? error.message : "기억 평가 전송 실패", this.secrets()).slice(0, 500);
        const delay = Math.min(3_600_000, this.retryMs * 2 ** Math.min(attempt - 1, 20));
        this.store.db.query(`UPDATE memory_feedback_exposures SET status=?,next_at=?,last_error=?,updated_at=?
          WHERE id=? AND status='pending' AND attempts=?`).run(retry ? "pending" : "rejected", retry ? new Date(this.now() + delay).toISOString() : null, detail, this.at(), row.id, attempt);
      }
    }
  }

  private validReceipt(row: Row, value: unknown): boolean {
    if (!value || typeof value !== "object") return false;
    const receipt = value as Record<string, unknown>;
    if (receipt.id !== row.experience_id || receipt.project_id !== memoryProjectId(row.project_id)) return false;
    // Current gateway returns aggregate counts. Legacy adapters may return rows.
    if (Array.isArray(receipt.feedback)) return receipt.feedback.some(v => v && typeof v === "object" &&
      v.task_id === row.scope && v.turn_id === row.id && v.outcome === row.outcome);
    if (!receipt.feedback || typeof receipt.feedback !== "object") return false;
    const count = (receipt.feedback as Record<string, unknown>)[row.outcome!];
    return typeof count === "number" && Number.isSafeInteger(count) && count > 0;
  }

  start(intervalMs = 60_000): void {
    if (this.timer) return;
    this.stopped = false;
    const send = () => { void this.flush().catch(() => { /* The durable queue remains available for the next tick. */ }); };
    this.timer = setInterval(send, Math.max(1, intervalMs));
    (this.timer as { unref?: () => void }).unref?.();
    send();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flushing;
  }
}
