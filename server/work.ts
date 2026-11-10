// 업무 중심 로컬 체험판의 원장과 규칙. 체험판 전용 DB(자기 홈 아래)만 쓰고 운영 DB·세션·core 를 건드리지 않는다.
// 업무가 대화·결재·자료·실행의 주인이다. 입력은 보낼 때의 업무·실행에 고정되고, 늦게 온 옛 실행의 결과는
// 업무 상태를 바꾸지 않는다. 역할·모델 교체와 재개는 새 실행에 그 업무의 기록만 인계한다.
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import type {
  CoordinationNote, DecisionOption, HindsightConfig, HindsightRecordView, InputSource, MessageKind, RunInput, RunReason, SearchContext,
  TaskDetail, TaskStatus, WorkDecision, WorkFile, WorkGoal, WorkMessage, WorkProject, WorkRole, WorkRun, WorkState, WorkTask,
} from "../shared/work-types.ts";
import { DEFAULT_HINDSIGHT, TestUploadAdapter, buildSearchContext, createUploadAdapter, idempotencyKey, searchStateLabel, uploadStateLabel, type UploadRecord } from "./integrations/hindsight.ts";
import { TrialRunner, type TrialOutput } from "./runner/trial.ts";

export class WorkError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
export function newWorkId(prefix: string): string {
  const b = randomBytes(12);
  let s = "";
  for (const x of b) s += ALPHA[x % ALPHA.length];
  return `${prefix}_${s}`;
}

export const TRIAL_MODELS = ["테스트-기본", "테스트-정밀", "테스트-빠름"];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, note TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS goals(id TEXT PRIMARY KEY, title TEXT NOT NULL, note TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS roles(id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, default_model TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, goal_id TEXT, title TEXT NOT NULL, criteria TEXT NOT NULL,
  status TEXT NOT NULL, role_id TEXT NOT NULL, model TEXT NOT NULL, depends_on TEXT, active_run_id TEXT, template TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, task_id TEXT NOT NULL, role_id TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL,
  reason TEXT NOT NULL, handoff TEXT, started_at TEXT NOT NULL, ended_at TEXT);
CREATE TABLE IF NOT EXISTS run_inputs(id TEXT PRIMARY KEY, run_id TEXT NOT NULL, seq INTEGER NOT NULL, source TEXT NOT NULL, text TEXT NOT NULL,
  search_context TEXT, peer_task_id TEXT, state TEXT NOT NULL, at TEXT NOT NULL, UNIQUE(run_id, seq));
CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, task_id TEXT NOT NULL, run_id TEXT, author TEXT NOT NULL, kind TEXT NOT NULL,
  body TEXT NOT NULL, peer_task_id TEXT, client_id TEXT, at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS messages_client ON messages(client_id) WHERE client_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS decisions(id TEXT PRIMARY KEY, task_id TEXT NOT NULL, run_id TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL,
  options TEXT NOT NULL, status TEXT NOT NULL, answer TEXT, answer_op TEXT, answered_at TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY, task_id TEXT NOT NULL, run_id TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS hs_records(id TEXT PRIMARY KEY, task_id TEXT NOT NULL, record_id TEXT NOT NULL, revision INTEGER NOT NULL, kind TEXT NOT NULL,
  idem_key TEXT NOT NULL UNIQUE, content TEXT NOT NULL, source_refs TEXT NOT NULL, status TEXT NOT NULL, adapter TEXT NOT NULL, receipt TEXT,
  attempts INTEGER NOT NULL, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
`;

type Row = Record<string, any>;

const toTask = (r: Row): WorkTask => ({ id: r.id, projectId: r.project_id, goalId: r.goal_id, title: r.title, criteria: r.criteria, status: r.status, roleId: r.role_id,
  model: r.model, dependsOn: r.depends_on, activeRunId: r.active_run_id, template: r.template, createdAt: r.created_at, updatedAt: r.updated_at });
const toRun = (r: Row): WorkRun => ({ id: r.id, taskId: r.task_id, roleId: r.role_id, model: r.model, status: r.status, reason: r.reason, handoff: r.handoff,
  runner: "trial", startedAt: r.started_at, endedAt: r.ended_at });
const toInput = (r: Row): RunInput => ({ id: r.id, runId: r.run_id, seq: r.seq, source: r.source, text: r.text,
  searchContext: r.search_context ? JSON.parse(r.search_context) : null, state: r.state, at: r.at });
const toMessage = (r: Row): WorkMessage => ({ id: r.id, taskId: r.task_id, runId: r.run_id, author: r.author, kind: r.kind, body: r.body, peerTaskId: r.peer_task_id, clientId: r.client_id, at: r.at });
const toDecision = (r: Row): WorkDecision => ({ id: r.id, taskId: r.task_id, runId: r.run_id, title: r.title, detail: r.detail, options: JSON.parse(r.options),
  status: r.status, answer: r.answer, answeredAt: r.answered_at, createdAt: r.created_at });
const toFile = (r: Row): WorkFile => ({ id: r.id, taskId: r.task_id, runId: r.run_id, title: r.title, content: r.content, at: r.at });
const toRecord = (r: Row): HindsightRecordView => ({ id: r.id, taskId: r.task_id, recordId: r.record_id, revision: r.revision, kind: r.kind, idempotencyKey: r.idem_key,
  status: r.status, adapter: r.adapter, receipt: r.receipt, attempts: r.attempts, lastError: r.last_error, createdAt: r.created_at, updatedAt: r.updated_at });

export interface WorkServiceOptions {
  dbPath: string;
  /** 테스트 실행기 응답 지연. 체험에서 '보내는 중 다른 업무로 이동'을 해 볼 수 있게 기본 1.5초. */
  delayMs?: number;
  seed?: boolean;
  label?: string;
}

export interface CreateTaskReq {
  title: string;
  projectId?: string | null;
  goalId?: string | null;
  criteria?: string;
  roleId?: string | null;
  model?: string | null;
  dependsOn?: string | null;
  instruction?: string | null;
  clientId?: string | null;
}

export class WorkService {
  readonly db: Database;
  readonly runner: TrialRunner;
  readonly testAdapters = new Map<string, TestUploadAdapter>();
  readonly instanceId: string;
  readonly startedAt = new Date().toISOString();
  private version = 0;
  private lastAt = 0;
  private publishing = new Set<Promise<unknown>>();
  private readonly label: string;

  constructor(opts: WorkServiceOptions) {
    this.db = new Database(opts.dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;");
    this.db.exec(SCHEMA);
    this.label = opts.label ?? "로컬 체험판";
    const existing = this.db.query("SELECT v FROM meta WHERE k = 'instance'").get() as Row | null;
    this.instanceId = existing?.v ?? newWorkId("trial");
    if (!existing) this.db.run("INSERT INTO meta(k, v) VALUES ('instance', ?)", [this.instanceId]);
    this.runner = new TrialRunner({ delayMs: opts.delayMs, onOutput: (out) => this.onOutput(out) });
    const empty = !(this.db.query("SELECT 1 FROM projects LIMIT 1").get());
    if (empty && opts.seed !== false) this.seed();
    else this.resumePending();
  }

  close(): void { this.runner.close(); this.db.close(); }
  async settled(): Promise<void> { await Promise.all([...this.publishing]); }

  // ---- 시각·트랜잭션 ----
  private now(): string {
    // 같은 밀리초 안의 기록도 순서를 잃지 않게 한다.
    const t = Math.max(Date.now(), this.lastAt + 1);
    this.lastAt = t;
    return new Date(t).toISOString();
  }
  private tx<T>(fn: () => T): T {
    const out = this.db.transaction(fn)();
    this.version++;
    return out;
  }

  // ---- 조회 ----
  private task(id: string): WorkTask {
    const r = this.db.query("SELECT * FROM tasks WHERE id = ?").get(id) as Row | null;
    if (!r) throw new WorkError(404, "업무를 찾을 수 없습니다");
    return toTask(r);
  }
  private run(id: string): WorkRun {
    const r = this.db.query("SELECT * FROM runs WHERE id = ?").get(id) as Row | null;
    if (!r) throw new WorkError(404, "실행을 찾을 수 없습니다");
    return toRun(r);
  }
  private role(id: string): WorkRole {
    const r = this.db.query("SELECT * FROM roles WHERE id = ?").get(id) as Row | null;
    if (!r) throw new WorkError(400, "역할을 찾을 수 없습니다");
    return { id: r.id, name: r.name, description: r.description, defaultModel: r.default_model };
  }
  private config(): HindsightConfig {
    const r = this.db.query("SELECT v FROM meta WHERE k = 'hindsight'").get() as Row | null;
    return r ? JSON.parse(r.v) : DEFAULT_HINDSIGHT;
  }
  inputsOf(runId: string): RunInput[] {
    return (this.db.query("SELECT * FROM run_inputs WHERE run_id = ? ORDER BY seq").all(runId) as Row[]).map(toInput);
  }

  state(): WorkState {
    const tasks = (this.db.query("SELECT * FROM tasks ORDER BY created_at").all() as Row[]).map(toTask);
    const roles = (this.db.query("SELECT * FROM roles ORDER BY rowid").all() as Row[]).map((r) => ({ id: r.id, name: r.name, description: r.description, defaultModel: r.default_model }));
    const config = this.config();
    return {
      trial: { instanceId: this.instanceId, label: this.label, runner: "trial", externalModelCalls: this.runner.externalCalls, startedAt: this.startedAt },
      projects: (this.db.query("SELECT * FROM projects ORDER BY rowid").all() as Row[]).map((r) => ({ id: r.id, name: r.name, kind: r.kind, note: r.note })) as WorkProject[],
      goals: (this.db.query("SELECT * FROM goals ORDER BY rowid").all() as Row[]).map((r) => ({ id: r.id, title: r.title, note: r.note })) as WorkGoal[],
      roles,
      models: TRIAL_MODELS,
      tasks,
      decisions: (this.db.query("SELECT * FROM decisions ORDER BY created_at").all() as Row[]).map(toDecision),
      files: (this.db.query("SELECT id, task_id, run_id, title, at FROM files ORDER BY at").all() as Row[]).map((r) => ({ id: r.id, taskId: r.task_id, runId: r.run_id, title: r.title, at: r.at })),
      coordination: this.coordination(tasks, roles),
      hindsight: { config, records: (this.db.query("SELECT * FROM hs_records ORDER BY created_at").all() as Row[]).map(toRecord), uploadState: uploadStateLabel(config), searchState: searchStateLabel(config) },
      version: this.version,
    };
  }

  detail(taskId: string): TaskDetail {
    const task = this.task(taskId);
    const runs = (this.db.query("SELECT * FROM runs WHERE task_id = ? ORDER BY started_at").all(taskId) as Row[]).map(toRun).map((r) => ({ ...r, inputs: this.inputsOf(r.id) }));
    return {
      task,
      messages: (this.db.query("SELECT * FROM messages WHERE task_id = ? ORDER BY at, rowid").all(taskId) as Row[]).map(toMessage),
      runs,
      decisions: (this.db.query("SELECT * FROM decisions WHERE task_id = ? ORDER BY created_at").all(taskId) as Row[]).map(toDecision),
      files: (this.db.query("SELECT * FROM files WHERE task_id = ? ORDER BY at").all(taskId) as Row[]).map(toFile),
      records: (this.db.query("SELECT * FROM hs_records WHERE task_id = ? ORDER BY created_at").all(taskId) as Row[]).map(toRecord),
    };
  }

  file(id: string): WorkFile {
    const r = this.db.query("SELECT * FROM files WHERE id = ?").get(id) as Row | null;
    if (!r) throw new WorkError(404, "자료를 찾을 수 없습니다");
    return toFile(r);
  }

  /** 총괄 종합: 업무 간 선후·대기·같은 역할의 병행·대표 차례. 말을 중계하지 않고 상태만 모은다. */
  private coordination(tasks: WorkTask[], roles: WorkRole[]): CoordinationNote[] {
    const notes: CoordinationNote[] = [];
    const byId = new Map(tasks.map((t) => [t.id, t]));
    for (const t of tasks) {
      if (!t.dependsOn) continue;
      const dep = byId.get(t.dependsOn);
      if (!dep) continue;
      notes.push({ kind: t.status === "waiting_dep" ? "waiting" : "order", text: `${dep.title} → ${t.title}: ${dep.status === "done" ? "선행 결과 도착" : "선행 결과를 기다리는 중"}`, taskIds: [dep.id, t.id] });
    }
    for (const r of roles) {
      const live = tasks.filter((t) => t.roleId === r.id && t.status !== "done");
      if (live.length >= 2) notes.push({ kind: "parallel_role", text: `${r.name} 역할이 업무 ${live.length}개를 각각 다른 실행으로 처리 중: ${live.map((t) => t.title).join(", ")}`, taskIds: live.map((t) => t.id) });
    }
    const open = this.db.query("SELECT DISTINCT task_id FROM decisions WHERE status = 'open'").all() as Row[];
    if (open.length) notes.push({ kind: "owner", text: `대표 답을 기다리는 업무 ${open.length}개`, taskIds: open.map((r) => r.task_id) });
    return notes;
  }

  // ---- 쓰기 ----
  private addMessage(taskId: string, m: { runId?: string | null; author: WorkMessage["author"]; kind: MessageKind; body: string; peerTaskId?: string | null; clientId?: string | null }): WorkMessage {
    const msg: WorkMessage = { id: newWorkId("msg"), taskId, runId: m.runId ?? null, author: m.author, kind: m.kind, body: m.body, peerTaskId: m.peerTaskId ?? null, clientId: m.clientId ?? null, at: this.now() };
    this.db.run("INSERT INTO messages(id, task_id, run_id, author, kind, body, peer_task_id, client_id, at) VALUES (?,?,?,?,?,?,?,?,?)",
      [msg.id, msg.taskId, msg.runId, msg.author, msg.kind, msg.body, msg.peerTaskId, msg.clientId, msg.at]);
    return msg;
  }
  private setStatus(taskId: string, status: TaskStatus): void {
    this.db.run("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?", [status, this.now(), taskId]);
  }
  private settleStatus(taskId: string): void {
    const t = this.task(taskId);
    if (t.status === "done" || t.status === "waiting_dep") return;
    const open = this.db.query("SELECT 1 FROM decisions WHERE task_id = ? AND status = 'open' LIMIT 1").get(taskId);
    this.setStatus(taskId, open ? "waiting_owner" : "working");
  }

  /** 그 업무의 기록만으로 인계문을 만든다. 다른 업무·옛 실행의 대화 원문은 넣지 않는다. */
  handoffFor(taskId: string): string {
    const t = this.task(taskId);
    const owner = (this.db.query("SELECT body FROM messages WHERE task_id = ? AND author = 'owner' ORDER BY at DESC LIMIT 5").all(taskId) as Row[]).map((r) => String(r.body).replace(/\s*\[(file|decision):[\w-]+\]/g, "")).reverse();
    const open = (this.db.query("SELECT title FROM decisions WHERE task_id = ? AND status = 'open'").all(taskId) as Row[]).map((r) => r.title);
    const answered = (this.db.query("SELECT title, answer FROM decisions WHERE task_id = ? AND status = 'answered'").all(taskId) as Row[]).map((r) => `${r.title} → ${r.answer}`);
    const files = (this.db.query("SELECT title FROM files WHERE task_id = ? ORDER BY at").all(taskId) as Row[]).map((r) => r.title);
    return [
      `업무 인계: ${t.title} (${t.id})`,
      `완료 기준: ${t.criteria}`,
      `대표 지시: ${owner.length ? owner.join(" / ") : "없음"}`,
      `열린 결재: ${open.length ? open.join(", ") : "없음"}`,
      `답한 결재: ${answered.length ? answered.join(", ") : "없음"}`,
      `자료: ${files.length ? files.join(", ") : "없음"}`,
    ].join("\n");
  }

  private startRun(taskId: string, reason: RunReason, withHandoff: boolean): WorkRun {
    const t = this.task(taskId);
    const at = this.now();
    if (t.activeRunId) this.db.run("UPDATE runs SET status = 'retired', ended_at = ? WHERE id = ? AND status = 'active'", [at, t.activeRunId]);
    const handoff = withHandoff ? this.handoffFor(taskId) : null;
    const run: WorkRun = { id: newWorkId("run"), taskId, roleId: t.roleId, model: t.model, status: "active", reason, handoff, runner: "trial", startedAt: at, endedAt: null };
    this.db.run("INSERT INTO runs(id, task_id, role_id, model, status, reason, handoff, started_at) VALUES (?,?,?,?,?,?,?,?)",
      [run.id, taskId, run.roleId, run.model, "active", reason, handoff, at]);
    this.db.run("UPDATE tasks SET active_run_id = ?, updated_at = ? WHERE id = ?", [run.id, at, taskId]);
    if (handoff) {
      const label = { start: "시작", role_change: "담당 역할 변경", model_change: "모델 변경", resume: "재개" }[reason];
      this.addMessage(taskId, { runId: run.id, author: "system", kind: "handoff", body: `${label}: 새 실행 ${run.id}에 이 업무의 기록만 인계했습니다.` });
      this.enqueueInput(run.id, "handoff", handoff);
    }
    return run;
  }

  private enqueueInput(runId: string, source: InputSource, text: string, peerTaskId: string | null = null, dispatch = true): RunInput {
    const run = this.run(runId);
    const t = this.task(run.taskId);
    const seq = ((this.db.query("SELECT MAX(seq) AS m FROM run_inputs WHERE run_id = ?").get(runId) as Row).m ?? 0) + 1;
    const files = (this.db.query("SELECT id FROM files WHERE task_id = ?").all(t.id) as Row[]).map((r) => `file:${r.id}`);
    const search: SearchContext = buildSearchContext({ trialInstanceId: this.instanceId, projectId: t.projectId, taskId: t.id, roleId: run.roleId, sourceRefs: [`task:${t.id}`, ...files] }, this.config().search);
    const input: RunInput = { id: newWorkId("in"), runId, seq, source, text, searchContext: search, state: "pending", at: this.now() };
    this.db.run("INSERT INTO run_inputs(id, run_id, seq, source, text, search_context, peer_task_id, state, at) VALUES (?,?,?,?,?,?,?,?,?)",
      [input.id, runId, seq, source, text, JSON.stringify(search), peerTaskId, "pending", input.at]);
    if (dispatch) queueMicrotask(() => this.dispatch(input.id));
    return input;
  }

  private dispatch(inputId: string): void {
    const r = this.db.query("SELECT * FROM run_inputs WHERE id = ?").get(inputId) as Row | null;
    if (!r || r.state !== "pending") return;
    const run = this.run(r.run_id);
    const t = this.task(run.taskId);
    if (run.status !== "active") { this.db.run("UPDATE run_inputs SET state = 'done' WHERE id = ?", [inputId]); return; }
    if (t.status === "waiting_dep") return; // 선행 결과가 오면 풀린다
    const context = this.inputsOf(run.id).filter((i) => i.seq <= r.seq).map((i) => ({ source: i.source, text: i.text }));
    const peer = r.peer_task_id ? this.task(r.peer_task_id) : null;
    this.runner.send({ runId: run.id, taskId: t.id, inputId, source: r.source, text: r.text, model: run.model, roleName: this.role(run.roleId).name, template: t.template,
      taskTitle: t.title, context, peer: peer ? { taskId: peer.id, title: peer.title } : null });
  }

  private resumePending(): void {
    const rows = this.db.query("SELECT i.id FROM run_inputs i JOIN runs r ON r.id = i.run_id WHERE i.state = 'pending' ORDER BY i.at").all() as Row[];
    for (const r of rows) this.dispatch(r.id);
  }

  /** 실행기 결과. 보낼 때 고정한 업무·실행에만 붙인다. 옛 실행의 결과는 기록만 남기고 상태를 바꾸지 않는다. */
  onOutput(out: TrialOutput): void {
    let follow: (() => void)[] = [];
    try {
      this.tx(() => {
        this.db.run("UPDATE run_inputs SET state = 'done' WHERE id = ?", [out.inputId]);
        const run = this.run(out.runId);
        const t = this.task(out.taskId);
        if (run.taskId !== t.id) throw new WorkError(500, "실행과 업무가 맞지 않습니다");
        if (run.status !== "active" || t.activeRunId !== run.id) {
          this.addMessage(t.id, { runId: run.id, author: "agent", kind: "late", body: `옛 실행(${run.id})에서 늦게 온 결과라 업무 상태·결재·자료에 반영하지 않았습니다: ${out.replies.join(" ")}` });
          return;
        }
        for (const body of out.replies) this.addMessage(t.id, { runId: run.id, author: "agent", kind: "reply", body });
        if (out.file) {
          const id = newWorkId("file");
          this.db.run("INSERT INTO files(id, task_id, run_id, title, content, at) VALUES (?,?,?,?,?,?)", [id, t.id, run.id, out.file.title, out.file.content, this.now()]);
          this.addMessage(t.id, { runId: run.id, author: "agent", kind: "result", body: `자료를 올렸습니다: ${out.file.title} [file:${id}]` });
        }
        if (out.decision) {
          const id = newWorkId("dec");
          this.db.run("INSERT INTO decisions(id, task_id, run_id, title, detail, options, status, created_at) VALUES (?,?,?,?,?,?, 'open', ?)",
            [id, t.id, run.id, out.decision.title, out.decision.detail, JSON.stringify(out.decision.options), this.now()]);
          this.addMessage(t.id, { runId: run.id, author: "agent", kind: "status", body: `결재를 올렸습니다: ${out.decision.title} [decision:${id}]` });
        }
        if (out.collabAsk) {
          const target = this.collabTarget(t, out.collabAsk.template);
          if (target) follow.push(() => this.collabQuestion(t.id, target.id, out.collabAsk!.question));
          else this.addMessage(t.id, { runId: run.id, author: "system", kind: "status", body: "협업 질문을 받을 업무를 찾지 못했습니다" });
        }
        if (out.collabAnswer?.toTaskId) follow.push(() => this.collabAnswer(t.id, out.collabAnswer!.toTaskId, out.collabAnswer!.answer));
        if (out.readyToComplete) this.addMessage(t.id, { runId: run.id, author: "system", kind: "status", body: "완료 기준을 채웠다고 보고했습니다. 확인 후 '완료'를 누르세요." });
        this.settleStatus(t.id);
      });
    } catch (e) {
      if (!(e instanceof WorkError) && !String(e).includes("closed")) throw e;
    }
    for (const f of follow) f();
  }

  private collabTarget(from: WorkTask, template: string): WorkTask | null {
    const r = this.db.query("SELECT * FROM tasks WHERE template = ? AND id != ? AND project_id = ? ORDER BY created_at LIMIT 1").get(template, from.id, from.projectId) as Row | null;
    return r ? toTask(r) : null;
  }

  /** 업무 사이 직접 질의. 질문만 상대 업무의 실행에 들어가고, 묻는 쪽 문맥은 넘기지 않는다. */
  collabQuestion(fromTaskId: string, toTaskId: string, question: string): void {
    this.tx(() => {
      const from = this.task(fromTaskId), to = this.task(toTaskId);
      this.addMessage(from.id, { author: "agent", kind: "collab_q", body: `→ ${to.title}에 질문: ${question}`, peerTaskId: to.id, runId: from.activeRunId });
      this.addMessage(to.id, { author: "agent", kind: "collab_q", body: `${from.title}에서 온 질문: ${question}`, peerTaskId: from.id });
      if (to.activeRunId && to.status !== "done") this.enqueueInput(to.activeRunId, "collab_question", question, from.id);
      else {
        // 끝난 업무는 새 실행을 띄우지 않고 최종 자료로 답한다.
        const last = this.db.query("SELECT title FROM files WHERE task_id = ? ORDER BY at DESC LIMIT 1").get(to.id) as Row | null;
        const answer = `완료된 업무라 최종 자료로 답합니다: ${last?.title ?? "자료 없음"}`;
        queueMicrotask(() => this.collabAnswer(to.id, from.id, answer));
      }
    });
  }

  private collabAnswer(fromTaskId: string, toTaskId: string, answer: string): void {
    this.tx(() => {
      const from = this.task(fromTaskId), to = this.task(toTaskId);
      this.addMessage(from.id, { author: "agent", kind: "collab_a", body: `→ ${to.title}에 답: ${answer}`, peerTaskId: to.id });
      this.addMessage(to.id, { author: "agent", kind: "collab_a", body: `${from.title}의 답: ${answer}`, peerTaskId: from.id });
      if (to.activeRunId && to.status !== "done") this.enqueueInput(to.activeRunId, "collab_answer", answer, from.id);
    });
  }

  private inferRole(title: string): string {
    const rules: [RegExp, string][] = [[/조사|검토|분석|비교 연구/, "role_research"], [/글|작성|소개|문안/, "role_writer"], [/견적|구매|비교/, "role_buyer"], [/구현|개발|연동|수정/, "role_dev"]];
    for (const [re, id] of rules) if (re.test(title)) return id;
    return "role_general";
  }

  createTask(req: CreateTaskReq): WorkTask {
    const title = req.title?.trim();
    if (!title) throw new WorkError(400, "업무 제목을 적어 주세요");
    if (title.length > 120) throw new WorkError(400, "업무 제목이 너무 깁니다");
    if (req.clientId) {
      const dup = this.db.query("SELECT task_id FROM messages WHERE client_id = ?").get(`task:${req.clientId}`) as Row | null;
      if (dup) return this.task(dup.task_id);
    }
    return this.tx(() => {
      const hq = (this.db.query("SELECT id FROM projects WHERE kind = 'hq' LIMIT 1").get() as Row).id;
      const projectId = req.projectId ?? hq;
      if (!this.db.query("SELECT 1 FROM projects WHERE id = ?").get(projectId)) throw new WorkError(400, "소속을 찾을 수 없습니다");
      if (req.goalId && !this.db.query("SELECT 1 FROM goals WHERE id = ?").get(req.goalId)) throw new WorkError(400, "목표 묶음을 찾을 수 없습니다");
      if (req.dependsOn) this.task(req.dependsOn);
      const roleId = req.roleId ?? this.inferRole(title);
      const role = this.role(roleId);
      const model = req.model ?? role.defaultModel;
      if (!TRIAL_MODELS.includes(model)) throw new WorkError(400, "모델을 찾을 수 없습니다");
      const id = newWorkId("task");
      const at = this.now();
      const template = (req as { template?: string }).template ?? "generic";
      const dep = req.dependsOn ? this.task(req.dependsOn) : null;
      const status: TaskStatus = dep && dep.status !== "done" ? "waiting_dep" : "received";
      this.db.run("INSERT INTO tasks(id, project_id, goal_id, title, criteria, status, role_id, model, depends_on, template, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        [id, projectId, req.goalId ?? null, title, req.criteria?.trim() || "대표가 결과를 확인하고 완료를 누르면 끝", status, roleId, model, req.dependsOn ?? null, template, at, at]);
      this.addMessage(id, { author: "system", kind: "status", body: `업무를 접수했습니다. 담당 역할은 '${role.name}'(자동), 모델은 '${model}'입니다. 상세에서 바꿀 수 있습니다.`, clientId: req.clientId ? `task:${req.clientId}` : null });
      if (status === "waiting_dep") this.addMessage(id, { author: "system", kind: "status", body: `선행 업무 '${dep!.title}'의 결과를 기다립니다.`, peerTaskId: dep!.id });
      this.startRun(id, "start", false);
      if (req.instruction?.trim()) this.sendInTx(id, req.instruction.trim(), null);
      return this.task(id);
    });
  }

  /** 대표 지시. 보낼 때의 업무·실행에 고정한다. 같은 clientId 는 한 번만 받는다. */
  send(taskId: string, req: { clientId?: string | null; text: string }): WorkMessage {
    const text = req.text?.trim();
    if (!text) throw new WorkError(400, "보낼 글을 적어 주세요");
    if (text.length > 4000) throw new WorkError(400, "글이 너무 깁니다");
    if (req.clientId) {
      const dup = this.db.query("SELECT * FROM messages WHERE client_id = ?").get(req.clientId) as Row | null;
      if (dup) {
        if (dup.task_id !== taskId) throw new WorkError(409, "같은 전송 ID가 다른 업무에 이미 쓰였습니다");
        return toMessage(dup);
      }
    }
    return this.tx(() => this.sendInTx(taskId, text, req.clientId ?? null));
  }

  private sendInTx(taskId: string, text: string, clientId: string | null): WorkMessage {
    let t = this.task(taskId);
    if (t.status === "done") { this.resumeInTx(taskId); t = this.task(taskId); }
    if (!t.activeRunId) this.startRun(taskId, "start", false);
    t = this.task(taskId);
    const msg = this.addMessage(taskId, { runId: t.activeRunId, author: "owner", kind: "instruction", body: text, clientId });
    this.enqueueInput(t.activeRunId!, "owner", text);
    if (t.status === "received") this.setStatus(taskId, "working");
    return msg;
  }

  setRole(taskId: string, roleId: string): WorkTask {
    return this.tx(() => {
      const t = this.task(taskId);
      const role = this.role(roleId);
      if (t.roleId === roleId) return t;
      this.db.run("UPDATE tasks SET role_id = ?, updated_at = ? WHERE id = ?", [roleId, this.now(), taskId]);
      this.addMessage(taskId, { author: "system", kind: "status", body: `담당 역할을 '${this.role(t.roleId).name}' → '${role.name}'로 바꿨습니다.` });
      if (t.status !== "done") this.startRun(taskId, "role_change", true);
      return this.task(taskId);
    });
  }

  setModel(taskId: string, model: string): WorkTask {
    if (!TRIAL_MODELS.includes(model)) throw new WorkError(400, "모델을 찾을 수 없습니다");
    return this.tx(() => {
      const t = this.task(taskId);
      if (t.model === model) return t;
      this.db.run("UPDATE tasks SET model = ?, updated_at = ? WHERE id = ?", [model, this.now(), taskId]);
      this.addMessage(taskId, { author: "system", kind: "status", body: `모델을 '${t.model}' → '${model}'(테스트 모델)로 바꿨습니다.` });
      if (t.status !== "done") this.startRun(taskId, "model_change", true);
      return this.task(taskId);
    });
  }

  complete(taskId: string): WorkTask {
    const recordIds: string[] = [];
    const t0 = this.task(taskId);
    if (t0.status === "done") return t0;
    if (t0.status === "waiting_dep") throw new WorkError(409, "선행 업무 결과를 기다리는 중이라 완료할 수 없습니다");
    const released: string[] = [];
    const out = this.tx(() => {
      const t = this.task(taskId);
      const at = this.now();
      if (t.activeRunId) this.db.run("UPDATE runs SET status = 'retired', ended_at = ? WHERE id = ? AND status = 'active'", [at, t.activeRunId]);
      this.db.run("UPDATE tasks SET status = 'done', active_run_id = NULL, updated_at = ? WHERE id = ?", [at, taskId]);
      this.addMessage(taskId, { author: "system", kind: "status", body: "대표가 완료로 처리했습니다." });
      recordIds.push(...this.prepareRecords(t));
      for (const r of this.db.query("SELECT id FROM tasks WHERE depends_on = ? AND status = 'waiting_dep'").all(taskId) as Row[]) released.push(r.id);
      for (const id of released) this.releaseDependency(id, t);
      return this.task(taskId);
    });
    for (const id of recordIds) this.trackPublish(this.publish(id));
    return out;
  }

  private releaseDependency(taskId: string, dep: WorkTask): void {
    const t = this.task(taskId);
    this.setStatus(taskId, "working");
    const files = (this.db.query("SELECT title FROM files WHERE task_id = ? ORDER BY at").all(dep.id) as Row[]).map((r) => r.title);
    this.addMessage(taskId, { author: "system", kind: "status", body: `선행 업무 '${dep.title}'가 끝나 결과를 넘겼습니다(${files.join(", ") || "자료 없음"}). 이어서 진행합니다.`, peerTaskId: dep.id });
    if (!t.activeRunId) this.startRun(taskId, "start", false);
    const runId = this.task(taskId).activeRunId!;
    for (const r of this.db.query("SELECT id FROM run_inputs WHERE run_id = ? AND state = 'pending' ORDER BY seq").all(runId) as Row[]) queueMicrotask(() => this.dispatch(r.id));
    this.enqueueInput(runId, "dependency", `선행 업무 '${dep.title}' 완료. 결과 자료: ${files.join(", ") || "없음"}`, dep.id);
  }

  resume(taskId: string, text?: string | null): WorkTask {
    return this.tx(() => {
      const t = this.task(taskId);
      if (t.status !== "done") throw new WorkError(409, "완료된 업무만 재개할 수 있습니다");
      this.resumeInTx(taskId);
      if (text?.trim()) this.sendInTx(taskId, text.trim(), null);
      return this.task(taskId);
    });
  }
  private resumeInTx(taskId: string): void {
    this.addMessage(taskId, { author: "system", kind: "status", body: "완료된 업무를 다시 열었습니다. 같은 업무에 이력을 이어 붙입니다." });
    this.setStatus(taskId, "working");
    this.startRun(taskId, "resume", true);
  }

  /** 결재 답. 같은 operationId 는 같은 결과를 돌려주고, 다른 답으로 다시 답할 수 없다. 답은 그 업무의 현재 실행에만 들어간다. */
  answer(decisionId: string, req: { operationId: string; optionKey: string }): WorkDecision {
    if (!req.operationId) throw new WorkError(400, "operationId가 필요합니다");
    return this.tx(() => {
      const r = this.db.query("SELECT * FROM decisions WHERE id = ?").get(decisionId) as Row | null;
      if (!r) throw new WorkError(404, "결재를 찾을 수 없습니다");
      const d = toDecision(r);
      if (d.status === "answered") {
        if (r.answer_op === req.operationId) return d;
        throw new WorkError(409, "이미 답한 결재입니다");
      }
      const opt = d.options.find((o: DecisionOption) => o.k === req.optionKey);
      if (!opt) throw new WorkError(400, "선택지를 찾을 수 없습니다");
      const at = this.now();
      this.db.run("UPDATE decisions SET status = 'answered', answer = ?, answer_op = ?, answered_at = ? WHERE id = ?", [opt.label, req.operationId, at, decisionId]);
      let t = this.task(d.taskId);
      if (t.status === "done") this.resumeInTx(t.id);
      t = this.task(d.taskId);
      this.addMessage(t.id, { runId: t.activeRunId, author: "owner", kind: "instruction", body: `결재 답: ${d.title} → ${opt.label} [decision:${d.id}]` });
      this.enqueueInput(t.activeRunId!, "answer", opt.label);
      this.settleStatus(t.id);
      return toDecision(this.db.query("SELECT * FROM decisions WHERE id = ?").get(decisionId) as Row);
    });
  }

  // ---- Hindsight ----
  private prepareRecords(t: WorkTask): string[] {
    const revision = ((this.db.query("SELECT MAX(revision) AS m FROM hs_records WHERE task_id = ? AND kind = 'verified_record'").get(t.id) as Row).m ?? 0) + 1;
    const files = (this.db.query("SELECT id, title FROM files WHERE task_id = ?").all(t.id) as Row[]);
    const decisions = (this.db.query("SELECT id, title, answer FROM decisions WHERE task_id = ? AND status = 'answered'").all(t.id) as Row[]);
    const refs = [`task:${t.id}`, ...files.map((f) => `file:${f.id}`), ...decisions.map((d) => `decision:${d.id}`)];
    const runs = (this.db.query("SELECT COUNT(*) AS n FROM runs WHERE task_id = ?").get(t.id) as Row).n;
    const bodies: [HindsightRecordView["kind"], string][] = [
      ["verified_record", `업무 '${t.title}' 완료(대표 확인). 완료 기준: ${t.criteria}. 자료: ${files.map((f) => f.title).join(", ") || "없음"}. 결재: ${decisions.map((d) => `${d.title}→${d.answer}`).join(", ") || "없음"}.`],
      ["retrospective", `회고(자동 초안·미검증): 실행 ${runs}회. 담당·모델 교체나 재개가 있었다면 인계 기록을 확인하세요.`],
    ];
    const ids: string[] = [];
    const config = this.config();
    const adapterKind = config.upload.mode === "none" ? "none" : config.upload.mode === "external" ? "external" : "test";
    for (const [kind, content] of bodies) {
      const recordId = `${t.id}:${kind}`;
      const id = newWorkId("hs");
      const at = this.now();
      this.db.run("INSERT INTO hs_records(id, task_id, record_id, revision, kind, idem_key, content, source_refs, status, adapter, attempts, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?, 'not_configured', ?, 0, ?, ?)",
        [id, t.id, recordId, revision, kind, idempotencyKey(this.instanceId, recordId, revision), content, JSON.stringify(refs), adapterKind, at, at]);
      ids.push(id);
    }
    return ids;
  }

  private trackPublish(p: Promise<unknown>): void {
    this.publishing.add(p);
    void p.finally(() => this.publishing.delete(p));
  }

  async publish(recordRowId: string): Promise<HindsightRecordView> {
    const r = this.db.query("SELECT * FROM hs_records WHERE id = ?").get(recordRowId) as Row | null;
    if (!r) throw new WorkError(404, "기록을 찾을 수 없습니다");
    const t = this.task(r.task_id);
    const adapter = createUploadAdapter(this.config(), this.testAdapters);
    const record: UploadRecord = { recordId: r.record_id, revision: r.revision, kind: r.kind,
      scope: { trialInstanceId: this.instanceId, projectRef: t.projectId, taskRef: t.id, roleRef: t.roleId }, content: r.content, sourceRefs: JSON.parse(r.source_refs) };
    const attempted = adapter.kind !== "none" && adapter.kind !== "external";
    let result;
    try { result = await adapter.publish(record, r.idem_key); }
    catch (e) { result = { status: "unknown" as const, error: e instanceof Error ? e.message : String(e) }; }
    try {
      this.tx(() => this.db.run("UPDATE hs_records SET status = ?, adapter = ?, receipt = COALESCE(?, receipt), attempts = attempts + ?, last_error = ?, updated_at = ? WHERE id = ?",
        [result.status, adapter.kind, result.remoteReceipt ?? null, attempted ? 1 : 0, result.error ?? null, this.now(), recordRowId]));
    } catch { /* closed */ }
    return toRecord(this.db.query("SELECT * FROM hs_records WHERE id = ?").get(recordRowId) as Row);
  }

  /** 실패·미확인·미설정 기록을 같은 키(같은 판)로 다시 보낸다. 새 키로 중복 업로드하지 않는다. */
  async retryRecord(recordRowId: string): Promise<HindsightRecordView> {
    const r = this.db.query("SELECT status FROM hs_records WHERE id = ?").get(recordRowId) as Row | null;
    if (!r) throw new WorkError(404, "기록을 찾을 수 없습니다");
    if (r.status === "uploaded") throw new WorkError(409, "이미 올라간 기록입니다");
    return this.publish(recordRowId);
  }

  setHindsight(next: HindsightConfig): HindsightConfig {
    const modes = ["none", "test_success", "test_fail", "test_lost", "external"];
    if (!next?.upload || !modes.includes(next.upload.mode)) throw new WorkError(400, "업로드 방식이 올바르지 않습니다");
    const clean = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : null);
    // 인증값 자체가 아니라 참조 이름만 받는다(예: env:HINDSIGHT_TOKEN). 값처럼 보이는 긴 비밀은 받지 않는다.
    for (const ref of [next.upload.authRef, next.search?.authRef]) if (ref && !/^(env|keychain|file):[\w.\-/]+$/.test(ref)) throw new WorkError(400, "인증은 참조 이름(env:이름 등)으로만 적어 주세요");
    const cfg: HindsightConfig = {
      upload: { mode: next.upload.mode, endpointRef: clean(next.upload.endpointRef), authRef: clean(next.upload.authRef) },
      search: { mcpServerRef: clean(next.search?.mcpServerRef), toolRef: clean(next.search?.toolRef), authRef: clean(next.search?.authRef),
        scopeMapping: next.search?.scopeMapping && typeof next.search.scopeMapping === "object" ? next.search.scopeMapping : DEFAULT_HINDSIGHT.search.scopeMapping },
    };
    this.tx(() => this.db.run("INSERT INTO meta(k, v) VALUES ('hindsight', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", [JSON.stringify(cfg)]));
    return cfg;
  }

  // ---- 샘플 ----
  private seed(): void {
    this.tx(() => {
      const at = this.now();
      this.db.run("INSERT INTO projects(id, name, kind, note) VALUES ('proj_trial', '체험 프로젝트', 'project', '출시 준비 묶음의 업무 3개'), ('proj_hq', '본사 일반업무', 'hq', '프로젝트 없이 맡기는 일')");
      this.db.run("INSERT INTO goals(id, title, note) VALUES ('goal_launch', '출시 준비', '연동·구조 검토·소개 글을 한 목표로 묶음')");
      const roles: [string, string, string, string][] = [
        ["role_dev", "개발", "구현·연동", "테스트-정밀"], ["role_research", "조사", "조사·검토·비교", "테스트-기본"],
        ["role_writer", "글쓰기", "소개 글·문안", "테스트-기본"], ["role_buyer", "구매", "견적·발주 비교", "테스트-빠름"], ["role_general", "일반 비서", "그 밖의 일", "테스트-기본"],
      ];
      for (const r of roles) this.db.run("INSERT INTO roles(id, name, description, default_model) VALUES (?,?,?,?)", r);
      void at;
    });
    const mk = (r: CreateTaskReq & { template: string }) => this.createTask(r as CreateTaskReq);
    const integration = mk({ title: "연동 구현", projectId: "proj_trial", goalId: "goal_launch", criteria: "연동 접점이 시험 연결로 동작", template: "integration", instruction: "연동 접점을 정리하고 진행 상황을 알려 주세요" });
    const structure = mk({ title: "대화 구조 검토", projectId: "proj_trial", goalId: "goal_launch", criteria: "두 안 비교와 권장안", template: "structure", instruction: "두 가지 대화 구조안을 비교해 주세요. 식별:구조검토" });
    mk({ title: "소개 글 작성", projectId: "proj_trial", goalId: "goal_launch", criteria: "구조 검토 결과를 반영한 소개 글 초안", template: "intro", dependsOn: structure.id, instruction: "대화 구조 검토가 끝나면 소개 글 초안을 써 주세요" });
    mk({ title: "출장 동선 조사", projectId: null, criteria: "동선 후보 3안", template: "trip", instruction: "다음 주 부산 출장 동선을 조사해 주세요. 식별:출장동선" });
    mk({ title: "견적 비교", projectId: null, criteria: "조건에 맞춘 비교표", template: "quote", instruction: "사무용 의자 견적 3곳을 비교해 주세요" });
    void integration;
  }
}
