import { createHash } from "node:crypto";
import type { WsEvent } from "../../shared/types.ts";
import type { Store } from "../store.ts";
import { redactSensitive, stableEventId, type DevMemory, type ExperienceInput } from "./dev-memory.ts";

/** Appended by the normal DB migration; constructing an archive never changes schema. */
export const MEMORY_ARCHIVE_SCHEMA = `CREATE TABLE memory_archive_sources (
  project_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  version INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id, source_type, source_id)
);`;

export interface MemoryArchiveOptions {
  subscribe?: (listener: (event: WsEvent) => void) => () => void;
  batchSize?: number;
  intervalMs?: number;
}
export interface MemoryArchiveResult { sources: number; chunks: number }

type SourceType = "project" | "message" | "task" | "decision" | "file" | "todo" | "work" | "delivery" | "memory_feedback";
type Snapshot = { id: string; type: SourceType; taskId: string | null; title: string; at: string; authority: string; value: unknown };
type SourceRow = { fingerprint: string; version: number };
type PendingSource = { projectId: string; type: SourceType; id: string };
const TABLES = [
  ["message", "messages"], ["task", "tasks"], ["decision", "decisions"],
  ["file", "files"], ["todo", "todos"], ["work", "work"], ["delivery", "deliveries"],
  ["memory_feedback", "memory_feedback_exposures"],
] as const;
const MAX_CONTENT = 18_000;
const BODY_PART = MAX_CONTENT - 1_024;

/** Server facts are copied as attributed records, never promoted to decisions or adopted rules. */
export class MemoryArchive {
  private readonly batchSize: number;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private scheduled: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: (() => void) | null = null;
  private running: Promise<MemoryArchiveResult> | null = null;
  private runningKind: "full" | "pending" | null = null;
  private readonly pending = new Map<string, PendingSource>();
  private started = false;
  private stopped = false;
  private fullRequested = false;

  constructor(private readonly store: Store, private readonly memory: DevMemory,
    private readonly secrets: () => readonly string[], private readonly options: MemoryArchiveOptions = {}) {
    this.batchSize = Math.max(1, Math.min(200, Math.floor(options.batchSize ?? 32)));
    this.intervalMs = Math.max(100, options.intervalMs ?? 30_000);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.unsubscribe = this.options.subscribe?.(event => this.queueEvent(event)) ?? null;
    this.timer = setInterval(() => this.schedule(true), this.intervalMs);
    this.timer.unref?.();
    this.schedule(true);
  }

  async stop(): Promise<void> {
    this.started = false;
    this.stopped = true;
    this.fullRequested = false;
    this.pending.clear();
    if (this.timer) clearInterval(this.timer);
    if (this.scheduled) clearTimeout(this.scheduled);
    this.timer = null;
    this.scheduled = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.running?.catch(() => {});
  }

  private queueEvent(event: WsEvent): void {
    if (!this.started || this.stopped) return;
    const add = (projectId: string, type: SourceType, id: string) => this.pending.set(`${type}/${id}`, { projectId, type, id });
    switch (event.type) {
      case "project": add(event.project.id, "project", event.project.id); break;
      case "message": add(event.message.projectId, "message", event.message.id); break;
      case "task": add(event.task.projectId, "task", event.task.id); break;
      case "decision": add(event.decision.projectId, "decision", event.decision.id); break;
      case "file": add(event.file.projectId, "file", event.file.id); break;
      case "todo": add(event.todo.projectId, "todo", event.todo.id); break;
      case "work": for (const item of event.work) add(event.projectId, "work", item.id); break;
      // Aggregate counts and staff status are frequent UI updates, not archive changes.
      default: return;
    }
    this.schedule();
  }

  private schedule(full = false): void {
    if (!this.started || this.stopped) return;
    this.fullRequested ||= full;
    if (this.running) return;
    if (this.scheduled) return;
    this.scheduled = setTimeout(() => {
      this.scheduled = null;
      if (!this.started || this.stopped || this.running) return;
      // Error text from a source/credential supplier can itself contain private values.
      const work = this.fullRequested ? this.reconcile() : this.track(this.capturePending(), "pending");
      void work.catch(() => console.warn("활동 원문 보관 준비 실패. 다음 점검에서 다시 시도합니다."));
    }, 25);
    this.scheduled.unref?.();
  }

  /** The upload queue is the durable handoff. DevMemory owns network retries. */
  reconcile(): Promise<MemoryArchiveResult> {
    if (this.stopped) return Promise.resolve({ sources: 0, chunks: 0 });
    if (this.running) return this.runningKind === "full" ? this.running : this.running.then(() => this.reconcile());
    this.fullRequested = false;
    // The sweep includes sources queued before it starts. Later events remain targeted.
    this.pending.clear();
    return this.track(this.scan(), "full");
  }

  private track(work: Promise<MemoryArchiveResult>, kind: "full" | "pending"): Promise<MemoryArchiveResult> {
    const run = work.finally(() => {
      if (this.running === run) { this.running = null; this.runningKind = null; }
      if (this.fullRequested || this.pending.size) this.schedule();
    });
    this.running = run;
    this.runningKind = kind;
    return run;
  }

  private enabled(projectId: string): boolean {
    return !this.stopped && this.memory.enabledFor(projectId);
  }

  private archiveSecrets(): readonly string[] {
    // Member credentials never belong to an activity archive, even if quoted in a message.
    const tokens = (this.store.db.query("SELECT id FROM members").all() as { id: string }[])
      .map(row => this.store.getMemberToken(row.id)).filter((value): value is string => !!value);
    return [...this.secrets(), ...tokens];
  }

  private async capturePending(): Promise<MemoryArchiveResult> {
    const total = { sources: 0, chunks: 0 }, secrets = this.archiveSecrets();
    // Limit each turn even while new events keep arriving; periodic catch-up can run next.
    for (let batch = 0; batch < 4 && this.pending.size && !this.stopped; batch++) {
      const entries = [...this.pending.entries()].slice(0, this.batchSize);
      for (const [key, source] of entries) {
        this.pending.delete(key);
        if (!this.enabled(source.projectId)) continue;
        const snapshot = this.snapshot(source.type, source.id);
        if (snapshot) this.add(total, this.capture(source.projectId, snapshot, secrets));
      }
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      if (this.fullRequested) break;
    }
    return total;
  }

  private async scan(): Promise<MemoryArchiveResult> {
    const total = { sources: 0, chunks: 0 }, secrets = this.archiveSecrets();
    const projects = this.store.db.query("SELECT id FROM projects ORDER BY rowid").all() as { id: string }[];
    for (const { id: projectId } of projects) {
      if (!this.enabled(projectId)) continue;
      const project = this.snapshot("project", projectId);
      if (project) this.add(total, this.capture(projectId, project, secrets));
      for (const [type, table] of TABLES) {
        let cursor = 0;
        while (this.enabled(projectId)) {
          // These table names are fixed above; user values are always bound parameters.
          // Row identity handles same-timestamp history without the 500-row UI page limit.
          const filter = type === "delivery" ? " AND kind IN ('instruction','user_message','answer','todo_done','report')"
            : type === "memory_feedback" ? " AND outcome IS NOT NULL" : "";
          const rows = this.store.db.query(`SELECT rowid AS position,id FROM ${table} WHERE project_id=? AND rowid>?${filter} ORDER BY rowid LIMIT ?`)
            .all(projectId, cursor, this.batchSize) as { position: number; id: string }[];
          if (!rows.length) break;
          for (const row of rows) {
            if (!this.enabled(projectId)) break;
            const snapshot = this.snapshot(type, row.id);
            if (snapshot) this.add(total, this.capture(projectId, snapshot, secrets));
            cursor = row.position;
          }
          // Yield between bounded batches so backfill does not hold the request loop.
          await new Promise<void>(resolve => setTimeout(resolve, 0));
          if (rows.length < this.batchSize) break;
        }
      }
    }
    return total;
  }

  private add(total: MemoryArchiveResult, next: MemoryArchiveResult): void {
    total.sources += next.sources;
    total.chunks += next.chunks;
  }

  private snapshot(type: SourceType, id: string): Snapshot | null {
    const base = (record: { title?: string; createdAt?: string; at?: string; taskId?: string | null }, authority: string, value: unknown): Snapshot => ({
      id, type, taskId: record.taskId ?? null, title: record.title ?? id,
      at: record.at ?? record.createdAt ?? "시각 미상", authority, value,
    });
    switch (type) {
      case "project": {
        const p = this.store.getProject(id);
        if (!p) return null;
        const record = { id: p.id, projectId: p.id, name: p.name, cwd: p.cwd, creationGoal: p.creationGoal,
          now: p.now, runnerEnabled: p.runnerEnabled, maxConcurrentTurns: p.maxConcurrentTurns,
          archived: p.archived, createdAt: p.createdAt, updatedAt: p.updatedAt };
        return base({ ...record, title: p.name }, "프로젝트 설정 원본", { record });
      }
      case "message": {
        const record = this.store.getMessage(id);
        if (!record) return null;
        const harness = this.store.getReportHarness(id);
        const references = this.store.db.query("SELECT * FROM report_references WHERE source_message_id=? ORDER BY sequence").all(id);
        return base(record, record.mine ? "대표가 직접 쓴 원문" : "직원·시스템의 보고 원문 — 대표 발언 아님", { record, harness, references });
      }
      case "task": {
        const task = this.store.getTask(id);
        if (!task) return null;
        const { lastMessageAt: _last, progress: _progress, ...record } = task;
        const contracts = this.store.listTaskContracts(id);
        const stages = this.store.db.query("SELECT * FROM task_stage_marks WHERE task_id=? ORDER BY id").all(id);
        const sequence = this.store.db.query("SELECT * FROM task_sequence WHERE task_id=? ORDER BY member_id").all(id);
        const links = this.store.db.query("SELECT * FROM task_links WHERE to_task_id=? OR from_task_id=? ORDER BY id").all(id, id);
        return base({ ...record, taskId: id }, "업무 등록·계약·단계의 저장 원본", { record, contracts, stages, sequence, links });
      }
      case "decision": {
        const record = this.store.getDecision(id);
        return record ? base(record, "결재 원본 — 질문·선택지는 직원 제안, 대표 답은 choice·note·answeredAt으로 구분", { record }) : null;
      }
      case "file": {
        const record = this.store.getFile(id);
        return record ? base(record, "자료 원문 — 작성자 표시를 보존하며 대표 발언으로 간주하지 않음", { record, html: this.store.getFileHtml(id) }) : null;
      }
      case "todo": {
        const record = this.store.getTodo(id);
        return record ? base(record, "할 일의 저장 원본", { record }) : null;
      }
      case "work": {
        const record = this.store.getWork(id);
        return record ? base(record, "진행판의 저장 원본", { record }) : null;
      }
      case "delivery": {
        const record = this.store.getDelivery(id);
        return record ? base(record, record.kind === "user_message" ? "대표 입력의 전달 기록 — 원문 message 참조" : "직원에게 전달한 지시·후속 입력 — 작성 주체는 ref 참조", { record }) : null;
      }
      case "memory_feedback": {
        const record = this.store.db.query(`SELECT id,project_id,experience_id,member_id,task_id,source_task_id,summary,outcome,reason,assessed_at
          FROM memory_feedback_exposures WHERE id=? AND outcome IS NOT NULL`).get(id) as {
          id: string; project_id: string; experience_id: string; member_id: string; task_id: string | null;
          source_task_id: string; summary: string; outcome: string; reason: string; assessed_at: string;
        } | null;
        return record ? base({ taskId: record.task_id, at: record.assessed_at, title: record.summary },
          "직원이 직접 남긴 기억 활용 평가 — 미사용(not_used)은 긍정·부정 투표 아님", { record }) : null;
      }
    }
  }

  private capture(projectId: string, snapshot: Snapshot, secrets: readonly string[]): MemoryArchiveResult {
    const content = JSON.stringify(scrub(snapshot.value, secrets), null, 2);
    const fingerprint = createHash("sha256").update(content).digest("hex");
    return this.store.transaction(() => {
      if (!this.enabled(projectId)) return { sources: 0, chunks: 0 };
      const previous = this.store.db.query("SELECT fingerprint,version FROM memory_archive_sources WHERE project_id=? AND source_type=? AND source_id=?")
        .get(projectId, snapshot.type, snapshot.id) as SourceRow | null;
      if (previous?.fingerprint === fingerprint) return { sources: 0, chunks: 0 };
      const version = (previous?.version ?? 0) + 1;
      const parts = split(content);
      let queued = 0;
      for (const [index, part] of parts.entries()) {
        const eventId = stableEventId("iamceo-archive", projectId, snapshot.type, snapshot.id, String(version), fingerprint, String(index + 1));
        const header = ["IAMCEO 활동 원문 보관 · 자동 판정·규칙 아님", `원본: ${snapshot.type}/${snapshot.id}`, `프로젝트: ${projectId}`,
          `버전: ${version}`, `조각: ${index + 1}/${parts.length}`, `원문 시각: ${snapshot.at}`, `출처: ${snapshot.authority}`,
          "첨부 바이너리는 포함하지 않음", "--- 원문 JSON ---", ""].join("\n");
        const body: ExperienceInput = {
          event_id: eventId, kind: "outcome", summary: `${snapshot.type} 원문: ${clean(snapshot.title, secrets)}`.slice(0, 280),
          content: clean(header, secrets) + part, capture: parts.length === 1 ? "complete" : "excerpt",
          source: { service: "iamceo", task_id: snapshot.taskId ?? `iamceo-${projectId}-archive`, item_id: snapshot.id },
          evidence: [
            { kind: "classification", text: "attributed_activity_archive_not_a_rule" },
            { kind: "iamceo_ref", text: `project_id=${projectId}; source_type=${snapshot.type}; source_id=${snapshot.id}` },
            { kind: "archive_part", text: JSON.stringify({ version, index: index + 1, count: parts.length, sha256: fingerprint }) },
          ],
        };
        if (body.content.length > MAX_CONTENT) throw new Error("보관 원문의 출처 정보가 조각 한도를 넘었습니다");
        if (this.store.enqueueMemoryUpload({ eventId, projectId, refType: `archive_${snapshot.type}`, refId: snapshot.id, body: JSON.stringify(body) })) queued++;
      }
      this.store.db.query(`INSERT INTO memory_archive_sources(project_id,source_type,source_id,fingerprint,version,updated_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(project_id,source_type,source_id) DO UPDATE SET fingerprint=excluded.fingerprint,version=excluded.version,updated_at=excluded.updated_at`)
        .run(projectId, snapshot.type, snapshot.id, fingerprint, version, new Date().toISOString());
      return { sources: 1, chunks: queued };
    });
  }
}

function clean(value: string, secrets: readonly string[]): string {
  let result = redactSensitive(value, secrets);
  // Supplied values are known credentials, including short owner access codes.
  for (const secret of secrets) if (secret && secret.length < 8) result = result.split(secret).join("[가림: 서버 비밀값]");
  return result.replace(/(["'](?:password|passwd|pwd|secret|client[_-]?secret|api[_-]?key|(?:access|refresh|id)[_-]?token|token|authorization|비밀번호|암호|접속\s*코드)["']\s*:\s*)["'][^"'\n]+["']/gi, "$1\"[가림: 인증값]\"");
}
function scrub(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return clean(value, secrets);
  if (Array.isArray(value)) return value.map(item => scrub(item, secrets));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item, secrets)]));
  return value;
}
function split(value: string): string[] {
  const parts: string[] = [];
  for (let offset = 0; offset < value.length;) {
    let end = Math.min(value.length, offset + BODY_PART);
    // Never split a UTF-16 pair; concatenating JSON fragments recovers the exact sanitized text.
    if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1]!) && /[\uDC00-\uDFFF]/.test(value[end]!)) end--;
    parts.push(value.slice(offset, end)); offset = end;
  }
  return parts;
}
