import { retirePassiveReports } from "./passive-report-deliveries.ts";
import { captureOwnerCommandEvidence, linkOwnerReportFollowup, type CommandSelection } from "./owner-commands.ts";
import { reconcileLegacyTimerStops } from "./legacy-timer-stops.ts";
import { projectMainContract, projectMainPolicyPrefix } from "./project-main-policy.ts";
import { describeTaskContext } from "./task-context.ts";
import { assignmentPredecessor, buildWorkflow, orderAssignments, relatedWork, type WorkflowAssignment, type WorkflowOwnerFacts } from "./workflow.ts";
import { activeTaskContinuationPauses, taskScopeForDeliveryIds } from "./task-continuation.ts";
import type { ProjectWorkflow, WorkflowAssignmentRequest, WorkflowAssignmentResult } from "../shared/workflow.ts";
import { publicHarness, redactHarnessText } from "./harness-redaction.ts";
import { canonicalAgentRequest as stableJson, agentRequestHash, encodeAgentResult, decodeAgentResult, type AgentReceiptState } from "./agent-receipts.ts";
import { encodeStoredText, decodeStoredText } from "./stored-text.ts";
import { claimObservation } from "./harness-evidence.ts";
import { CODE_READ_KIND, validCodeRead, type CodeReadScope, type CodeReadObservation } from "./harness-source-read.ts";
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { createHash } from "node:crypto";
import { z } from "zod";
import { homedir } from "node:os";
import type {
  ArchiveProjectState,
  CoreContextState,
  MessagePage,
  MessagePageOptions,
  MessageScope,
  ActivityKind,
  Activity,
  AnswerReq,
  Attachment,
  Backend,
  CliProvider,
  Decision,
  DecisionCloseKind,
  DecisionContext,
  DecisionFileLink,
  DecisionOption,
  DecisionStatus,
  Delivery,
  DeliveryKind,
  DeliveryStatus,
  Effort,
  FileDoc,
  FileKind,
  FilePage,
  FilePageOptions,
  FileListItem,
  Member,
  Task,
  TaskProgress,
  TaskLink,
  TaskOrigin,
  MemberLifecycleState,
  MemberKind,
  MemberOrigin,
  MemberStatus,
  Message,
  MessageKind,
  Project,
  ProjectConnection,
  ProjectState,
  ProjectSummary,
  Rank,
  Settings,
  SettingsPatch,
  Todo,
  TodoOutcome,
  WorkItem,
  WorkSec,
  WsEvent,
} from "../shared/types.ts";
import { CLI_PROVIDERS, DEFAULT_CODEX_RANKS, DEFAULT_RANKS, FILE_KINDS, fileKindOf } from "../shared/types.ts";
import type { MemberRevisions, OperationKind, OperationReceipt, OperationStatus, SyncRevisions, ManualInboxBatch } from "../shared/operations.ts";
import type { DeliveryDispatch, DeliveryIntentResult, DeliveryRecoveryRecord, DomainRecorder, LifecycleJournal, DecisionFollowUp, MessageReadStore, ProjectPatchStore, RunnerRecoveryStore, TerminalLease, RunnerRecoveryState, ReportReferences, BoardReview } from "./service-contracts.ts";
import type { RunnerTerminalIdentity } from "./runner/types.ts";
import type { Bus } from "./bus.ts";
import { newId, nowIso } from "./db.ts";
import { datedTitle, ownerTaskTitle, taskTitleFrom } from "./task-names.ts";
import { deriveProgress, isDone, watchNotice, type MarkFact, type ProgressFacts, type ReportFact, type WatchFact } from "./task-progress.ts";
import { bindingContract, missingExecutionContractFields, requiredChecks, type ContractAuthorKind, type ContractInput, type HarnessFinding, type HarnessGate, type ReportCheck, type ReportCheckInput, type TaskContract } from "./harness.ts";
import type { CheckEvidence, ClaimResult } from "./harness-evidence.ts";
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_CONTEXT_WINDOWS, exactSource } from "./runner/context.ts";
import { MAX_PROJECT_NAME, MAX_ROLE, nameProblem, oneLineProblem, RESERVED_HANDLES, workerNameProblem } from "./text.ts";
import { cleanName, cleanText, conductorName } from "./text.ts";

/** 과거 gate는 보존한다. 현재 승계에 쓸 수 있는 근거는 별도 계산한다. */
export interface CompletionEvidence {
  messageId: string;
  eligible: boolean;
  status: "passed" | "inherited" | "superseded" | "missing_basis" | "not_passed";
  correctedBy: string | null;
}

export interface MemoryUpload {
  eventId: string;
  projectId: string;
  refType: string;
  refId: string;
  body: string;
  /** pending: 보낼 차례를 기다림 · sent: 게이트웨이가 받음 · rejected: 게이트웨이가 거절(같은 본문으로 다시 보내도 같다) */
  status: "pending" | "sent" | "rejected";
  attempts: number;
  nextAt: string;
  lastError: string | null;
  remoteId: string | null;
  /** 이 기록이 대체하는 앞 기록의 event_id. 앞 기록이 게이트웨이에 들어가 id 를 받은 뒤에만 보낸다. */
  supersedesEventId: string | null;
  createdAt: string;
  updatedAt: string;
}

function toMemoryUpload(r: Row): MemoryUpload {
  return {
    eventId: r.event_id as string, projectId: r.project_id as string, refType: r.ref_type as string, refId: r.ref_id as string, body: r.body as string,
    status: r.status as MemoryUpload["status"], attempts: r.attempts as number, nextAt: r.next_at as string, lastError: (r.last_error as string | null) ?? null,
    remoteId: (r.remote_id as string | null) ?? null, supersedesEventId: (r.supersedes_event_id as string | null) ?? null, createdAt: r.created_at as string, updatedAt: r.updated_at as string,
  };
}

/** 총괄이 대화에서 고른 대표의 결정·제약·수정·피드백 한 건. 원문은 messages 의 대표 글이다. */
export interface MemoryCapture {
  id: string;
  projectId: string;
  eventId: string;
  type: "decision" | "constraint" | "correction" | "feedback";
  scope: "task" | "project" | "artifact";
  standing: boolean;
  messageIds: string[];
  taskId: string | null;
  interpretation: string;
  fileRefs: { fileId: string; title: string; version: string }[];
  supersedesId: string | null;
  capturedBy: string;
  createdAt: string;
}

function toMemoryCapture(r: Row): MemoryCapture {
  return {
    id: r.id as string, projectId: r.project_id as string, eventId: r.event_id as string, type: r.type as MemoryCapture["type"], scope: r.scope as MemoryCapture["scope"],
    standing: !!r.standing, messageIds: JSON.parse(r.message_ids as string) as string[], taskId: (r.task_id as string | null) ?? null, interpretation: r.interpretation as string,
    fileRefs: JSON.parse((r.file_refs as string) || "[]") as MemoryCapture["fileRefs"], supersedesId: (r.supersedes_id as string | null) ?? null, capturedBy: r.captured_by as string, createdAt: r.created_at as string,
  };
}

/** 서버가 일을 넣기 전에(또는 직원이 도구로) 한 기억 검색 한 번. ok·empty·error 를 나눠 남긴다. */
export interface MemorySearch {
  id: string;
  projectId: string;
  memberId: string;
  taskId: string | null;
  trigger: "delivery" | "tool";
  queryHash: string;
  status: "ok" | "empty" | "error";
  resultIds: string[];
  /** 직원에게 넣은 글(같은 검색을 다시 쓸 때 그대로 쓴다). */
  block: string | null;
  detail: string | null;
  createdAt: string;
}

function toMemorySearch(r: Row): MemorySearch {
  return {
    id: r.id as string, projectId: r.project_id as string, memberId: r.member_id as string, taskId: (r.task_id as string | null) ?? null, trigger: r.trigger as MemorySearch["trigger"],
    queryHash: r.query_hash as string, status: r.status as MemorySearch["status"], resultIds: JSON.parse((r.result_ids as string) || "[]") as string[], block: (r.block as string | null) ?? null,
    detail: (r.detail as string | null) ?? null, createdAt: r.created_at as string,
  };
}

/** status 가 그대로 HTTP 응답 코드가 되는 오류. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// ---- 입력 타입 ----
export interface NewProject {
  id?: string;
  name: string;
  cwd: string;
  chiefCli?: CliProvider;
  /** 개발 기억 운영. 생략하면 켠다(본사는 끈다). */
  memory?: boolean;
  runnerEnabled?: boolean;
  now?: string;
  creationGoal?: string | null;
}
export type ProjectPatch = Partial<
  Pick<
    Project,
    "name" | "cwd" | "runnerEnabled" | "maxConcurrentTurns" | "now" | "herdrTabId" | "archived"
  >
>;

export interface NewMember {
  cli?: CliProvider;
  modelOverride?: string | null;
  effortOverride?: string | null;
  projectId: string;
  handle: string;
  name: string;
  role?: string;
  kind: MemberKind;
  finalReviewer?: boolean;
  origin?: MemberOrigin;
  status?: MemberStatus;
  cwd?: string;
  sessionId?: string | null;
  paneId?: string | null;
  parallel?: boolean;
  backend?: Backend | null;
}
export type MemberPatch = Partial<
  Pick<
    Member,
    "name" | "role" | "cli" | "origin" | "backend" | "modelOverride" | "effortOverride" | "codexSpeed" | "status" | "now" | "next" | "cwd" | "sessionId" | "paneId" | "contextPct" | "contextWindow" | "contextWindowSource" | "subagents" | "parallel" | "lastError" | "executionIssue" | "statusObservation" | "blockedReason" | "subagentState" | "nowAt" | "manualActivityAt"
  >
>;

export interface AdoptedInfo { turnedOnRunner: boolean }

/** 지금 세션에 실제로 들어간 설정. 값이 달라지면 쉴 때 세션을 다시 연다. */
export interface AppliedConfig {
  model: string | null;
  effort: Effort | null;
  staffModel: string | null;
  staffEffort: Effort | null;
  codexSpeed?: Member["codexSpeed"];
  /** 세션을 띄울 때 서버가 준 도구 목록(이름·입력 형식)의 지문. 다르면 쉴 때 같은 대화를 이어 다시 연다. 옛 세션은 없다. */
  toolsSig?: string | null;
}

export interface NewDecision {
  projectId: string;
  memberId?: string | null;
  who: string;
  title: string;
  detail?: string;
  options?: DecisionOption[];
  rec?: string | null;
  group?: string | null;
  fileId?: string | null;
  images?: Attachment[];
  taskId?: string | null;
}

export interface NewTodo {
  projectId: string;
  memberId?: string | null;
  who?: string;
  title: string;
  detail?: string;
  taskId?: string | null;
}

/** 작업 등록·수정. id 가 있으면 그 작업을 고친다(제목·브랜치·워크트리만, id 는 그대로). */
export interface TaskInput {
  id?: string;
  projectId: string;
  memberId: string;
  who: string;
  title?: string;
  branch?: string | null;
  worktree?: string | null;
  /** 새로 만들 때만: 이 업무가 갈라져 나온 업무. */
  parentTaskId?: string | null;
}

export interface WorkInput {
  id?: string;
  projectId: string;
  sec: WorkSec;
  title: string;
  detail?: string;
  who?: string;
  /** 이 항목이 가리킬 기존 업무. 주면 항목에서 새 업무(tk_<id>)를 만들지 않는다. null 이면 연결을 푼다. 빼면 그대로. */
  taskId?: string | null;
}

export interface NewMessage {
  id?: string;
  projectId: string;
  at?: string;
  mine?: boolean;
  memberId?: string | null;
  who?: string;
  kind: MessageKind;
  title?: string;
  body?: string;
  targetMemberId?: string | null;
  targetName?: string | null;
  decisionId?: string | null;
  fileId?: string | null;
  attachments?: Attachment[];
  delivery?: DeliveryStatus | null;
  deliveryNote?: string | null;
  taskId?: string | null;
  aboutMessageId?: string | null;
}

export interface NewFile {
  projectId: string;
  title: string;
  who?: string;
  memberId?: string | null;
  summary?: string;
  body?: string;
  path?: string | null;
  attachments?: Attachment[];
  kind?: FileKind;
  /** kind=artifact 의 원본. 화면 상태에 싣지 않는다. */
  html?: string | null;
  taskId?: string | null;
}

export interface NewDelivery {
  sourceRevision?: string | null;
  nextAttemptAt?: string | null;
  projectId: string;
  memberId: string;
  kind: DeliveryKind;
  text: string;
  wake?: boolean;
  urgent?: boolean;
  status?: Extract<DeliveryStatus, "queued" | "held">;
  holdReason?: string | null;
  refType?: Delivery["refType"];
  refId?: string | null;
  /** 이 전달이 속한 작업. 생략하면 ref(대표 글·결재·할 일)의 작업을 따른다. */
  taskId?: string | null;
}

/** 대표 글·답·할 일 알림·지시: 턴 마지막 글(자동 보고)의 출처가 되는 전달. */
export const TASK_SOURCE_KINDS = new Set<DeliveryKind>(["user_message", "answer", "todo_done", "instruction"]);

export interface DeliveryUpdate {
  /** An explicit owner retry may wake an otherwise passive notification. */
  wake?: boolean;
  holdReason?: string | null;
  lastError?: string | null;
  /** 시도 횟수를 하나 올린다. */
  attempt?: boolean;
}

/** 가져온 프로젝트의 못 읽은 말에 붙는 표시. 재시작 정리가 이 말을 실패로 바꾸지 않게 가른다. */
export const IMPORT_HOLD_NOTE = "총괄을 시작하면 전달됩니다";

export const DEFAULT_SETTINGS: Settings = {
  backend: "core",
  permissionMode: "bypassPermissions",
  ranks: DEFAULT_RANKS,
  codexRanks: DEFAULT_CODEX_RANKS,
  maxConcurrentTurns: 4,
  compactAtPct: 70,
  contextWindowDefault: DEFAULT_CONTEXT_WINDOW,
  contextWindows: { ...DEFAULT_CONTEXT_WINDOWS },
  maxAwakeWorkers: 8,
  notifyMac: false,
  boardTidyHours: 6,
  harnessMode: "required",
  harnessRequiredSince: null,
};

type TimeField = "createdAt" | "updatedAt" | "answeredAt" | "deliveredAt" | "doneAt";
const RESTORABLE_TIMES = {
  decisions: { createdAt: "created_at", answeredAt: "answered_at", deliveredAt: "delivered_at" },
  todos: { createdAt: "created_at", doneAt: "done_at" },
  work: { createdAt: "created_at", updatedAt: "updated_at", doneAt: "done_at" },
  files: { createdAt: "created_at" },
} as const;

const HANDLE_RE = /^[a-z][a-z0-9_-]{0,31}$/;
export const MAX_ACTIVITY_PER_MEMBER = 500;
// 도구 결과 하나가 수 MB 일 수 있다. 활동 판은 훑어보는 용도라 잘라도 된다.
const MAX_ACTIVITY_TEXT = 4000;
// 현재 세대의 마지막 생성 순서를 따른다. 이전 journal의 늦은 갱신은 새 작업을 덮지 않는다.
const MEMBER_SELECT = `SELECT m.*, (SELECT COUNT(*) FROM deliveries d WHERE d.member_id = m.id AND d.status IN ('queued','held')) AS queued_count,
  (SELECT COUNT(*) FROM deliveries d WHERE d.member_id = m.id AND d.status = 'held') AS held_count,
  (SELECT c.measurement_json FROM member_context_state c WHERE c.member_id = m.id AND c.generation = m.session_generation) AS measurement_json,
  (SELECT c.compaction_json FROM member_context_state c WHERE c.member_id = m.id AND c.generation = m.session_generation) AS compaction_json,
  (SELECT c.member_id FROM member_context_state c WHERE c.member_id = m.id AND c.generation = m.session_generation) AS context_member_id,
  l.operation_id AS lifecycle_operation_id, l.intent AS lifecycle_intent, l.phase AS lifecycle_phase,
  l.reason AS lifecycle_reason, l.exit_code AS lifecycle_exit_code, l.updated_at AS lifecycle_updated_at,
  e.run_id AS execution_run_id, e.turn AS execution_turn, e.delivery_ids_json AS execution_delivery_ids_json,
  e.phase AS execution_phase, e.input_received_at AS execution_input_received_at, e.started_at AS execution_started_at,
  e.last_progress_at AS execution_last_progress_at, e.ended_at AS execution_ended_at,
  e.result AS execution_result, e.reason AS execution_reason, e.exit_code AS execution_exit_code,
  (SELECT json_group_array(t.task_id) FROM (SELECT DISTINCT d.task_id FROM json_each(e.delivery_ids_json) j JOIN deliveries d ON d.id = j.value WHERE d.task_id IS NOT NULL) t) AS execution_task_ids_json
  FROM active_members m
  LEFT JOIN lifecycle_journal l ON l.rowid = (
    SELECT j.rowid FROM lifecycle_journal j
    WHERE j.member_id = m.id AND j.project_id = m.project_id AND j.generation = m.session_generation
    ORDER BY j.created_at DESC, j.rowid DESC LIMIT 1)
  LEFT JOIN execution_journal e ON e.rowid = (
    SELECT j.rowid FROM execution_journal j
    WHERE j.member_id = m.id AND j.project_id = m.project_id AND j.generation = m.session_generation
    ORDER BY j.created_at DESC, j.rowid DESC LIMIT 1)`;

// SQL 행은 컬럼 이름이 곧 스키마(db.ts)다. 아래 toX 함수가 타입 경계다.
type Row = Record<string, any>;

function json<T>(raw: unknown): T {
  return JSON.parse(decodeStoredText(raw)) as T;
}

export function attachmentUrl(id: string, name: string): string {
  return `/files/${id}/${encodeURIComponent(name)}`;
}

/** 새 프로젝트의 기억 운영 값. 대표가 따로 정하지 않으면 켠다. 본사는 직원이 없어 NULL(서버 목록을 따름)로 둔다. */
function memoryMode(id: string, memory: boolean | undefined): "on" | "off" | null {
  if (memory !== undefined) return memory ? "on" : "off";
  return id === "hq" ? null : "on";
}

function toProject(r: Row, connection: ProjectConnection, legacyMemory: ReadonlySet<string>): Project {
  const mode = r.memory_mode === "on" || r.memory_mode === "off" ? r.memory_mode as "on" | "off" : null;
  return {
    id: r.id,
    name: r.name,
    isHq: !!r.is_hq,
    chiefCli: r.chief_cli === "codex" || r.chief_cli === "antigravity" ? r.chief_cli : "claude",
    cwd: r.cwd,
    runnerEnabled: !!r.runner_enabled,
    maxConcurrentTurns: r.max_concurrent_turns ?? null,
    now: r.now,
    creationGoal: r.creation_goal ?? null,
    nowAt: r.now_at,
    herdrTabId: r.herdr_tab_id,
    archived: !!r.archived,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    connection,
    tidiedAt: r.board_tidied_at ?? null,
    memory: { mode: mode ?? "legacy", on: mode === "on" || (mode === null && legacyMemory.has(r.id)), enabledAt: r.memory_enabled_at ?? null },
  };
}

function appliedOf(r: Row): AppliedConfig | null {
  return r.applied_config ? json<AppliedConfig>(r.applied_config) : null;
}

function lifecyclePhase(intent: LifecycleJournal["intent"], phase: LifecycleJournal["phase"]): MemberLifecycleState["phase"] {
  switch (phase) {
    case "confirmed": return intent === "start" ? "started_confirmed" : "stopped_confirmed";
    case "refused": return "refused";
    case "unknown": return intent === "start" ? "starting_unknown" : "stopping_unknown";
    default: return intent === "start" ? "starting" : intent === "close" ? "closing" : "stopping";
  }
}

// token 은 일부러 옮기지 않는다: Member 는 화면까지 나간다.
function toMember(r: Row): Member {
  const applied = appliedOf(r);
  return {
    id: r.id,
    projectId: r.project_id,
    handle: r.handle,
    name: r.name,
    role: r.role,
    kind: r.kind,
    ...(r.final_reviewer || r.standby_reviewer ? { finalReviewer: true } : {}),
    ...(r.standby_reviewer ? { standbyReviewer: true } : {}),
    origin: r.origin,
    wasAdopted: r.adopted_info != null,
    cli: r.cli,
    backend: r.backend ?? null,
    modelOverride: r.model_override ?? null,
    effortOverride: r.effort_override ?? null,
    ...(r.cli === "codex" ? { codexSpeed: r.codex_speed ?? "standard", appliedCodexSpeed: applied?.codexSpeed ?? null } : {}),
    appliedModel: applied?.model ?? null,
    appliedEffort: applied?.effort ?? null,
    status: r.status,
    now: r.now,
    next: r.next,
    cwd: r.cwd,
    sessionId: r.session_id,
    paneId: r.pane_id,
    contextPct: r.context_pct,
    contextWindow: r.context_window ?? null,
    contextWindowSource: r.context_window_source ?? null,
    subagents: r.subagents,
    parallel: !!r.parallel_preference,
    queuedCount: r.queued_count,
    heldCount: r.held_count ?? 0,
    lastError: r.last_error,
    executionIssue: r.execution_issue_json == null ? null : json<Member["executionIssue"]>(r.execution_issue_json),
    lastActiveAt: r.last_active_at ?? null,
    updatedAt: r.updated_at,
    createdAt: r.created_at,
    statusObservation: r.status_observation_json === null ? null : json<Member["statusObservation"]>(r.status_observation_json),
    blockedReason: r.blocked_reason,
    subagentState: r.subagent_state_json === null ? null : json<Member["subagentState"]>(r.subagent_state_json),
    nowAt: r.now_at,
    manualActivityAt: r.manual_activity_at,
    lifecycleState: r.lifecycle_operation_id === null ? null : {
      operationId: r.lifecycle_operation_id,
      sessionGeneration: r.session_generation,
      intent: r.lifecycle_intent,
      phase: lifecyclePhase(r.lifecycle_intent, r.lifecycle_phase),
      reason: r.lifecycle_reason,
      exitCode: r.lifecycle_exit_code,
      updatedAt: r.lifecycle_updated_at,
    },
    executionState: r.execution_run_id === null ? null : {
      runId: r.execution_run_id,
      sessionGeneration: r.session_generation,
      turn: r.execution_turn,
      deliveryIds: json<string[]>(r.execution_delivery_ids_json),
      phase: r.execution_phase,
      inputReceivedAt: r.execution_input_received_at,
      startedAt: r.execution_started_at,
      lastProgressAt: r.execution_last_progress_at,
      endedAt: r.execution_ended_at,
      result: r.execution_result,
      reason: r.execution_reason,
      exitCode: r.execution_exit_code,
      taskIds: r.execution_task_ids_json ? json<string[]>(r.execution_task_ids_json) : [],
    },
    ...(r.context_member_id ? { contextState: { measurement: r.measurement_json === null ? null : json<CoreContextState["measurement"]>(r.measurement_json), compaction: r.compaction_json === null ? null : json<CoreContextState["compaction"]>(r.compaction_json) } } : {}),
  };
}

function toDecision(r: Row): Decision {
  return {
    id: r.id,
    projectId: r.project_id,
    memberId: r.member_id,
    who: r.who,
    title: r.title,
    detail: r.detail,
    options: json(r.options),
    rec: r.rec,
    group: r.grp,
    fileId: r.file_id,
    images: json(r.images),
    status: r.status,
    choice: r.choice,
    note: r.note,
    batch: !!r.batch,
    createdAt: r.created_at,
    answeredAt: r.answered_at,
    deliveredAt: r.delivered_at,
    updatedAt: r.updated_at ?? r.created_at,
    lastChoice: r.last_choice ?? null,
    lastNote: r.last_note ?? null,
    reopenNote: r.reopen_note ?? null,
    closeKind: r.close_kind ?? null,
    closeReason: r.close_reason ?? null,
    closeQuote: r.close_quote ?? null,
    closedBy: r.closed_by ?? null,
    closedAt: r.closed_at ?? null,
    taskId: r.task_id ?? null,
  };
}

function toTodo(r: Row): Todo {
  return {
    id: r.id,
    projectId: r.project_id,
    memberId: r.member_id,
    who: r.who,
    title: r.title,
    detail: r.detail,
    done: !!r.done,
    doneAt: r.done_at,
    createdAt: r.created_at,
    outcome: r.outcome ?? (r.done ? "done" : null),
    closeReason: r.close_reason ?? null,
    closedBy: r.closed_by ?? null,
    taskId: r.task_id ?? null,
  };
}

/** 업무의 마지막 글 시각. 입력칸 업무 목록이 '대화가 있는 업무'를 고르고 최근 순으로 세운다(첫 쪽 글 밖의 옛 업무도 빠지지 않게). */
const TASK_LAST_MESSAGE = "(SELECT MAX(m.at) FROM messages m WHERE m.project_id = tasks.project_id AND m.task_id = tasks.id) AS last_message_at";

function toTask(r: Row): Task {
  return {
    id: r.id,
    projectId: r.project_id,
    memberId: r.member_id,
    who: r.who,
    title: r.title,
    branch: r.branch,
    worktree: r.worktree,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    origin: (r.origin ?? (String(r.id).startsWith("tk_w_") ? "board" : "staff")) as TaskOrigin,
    parentTaskId: r.parent_task_id ?? null,
    mergedInto: r.merged_into ?? null,
    renamedAt: r.renamed_at ?? null,
    renamedBy: r.renamed_by ?? null,
    // 마지막 글 시각을 함께 읽은 조회에서만 싣는다(칸이 없으면 '모름'이지 '글 없음'이 아니다).
    ...("last_message_at" in r ? { lastMessageAt: r.last_message_at ?? null } : {}),
  };
}

/** 서버가 글에서 지은 이름이고 아직 아무도 목적 이름으로 바꾸지 않았다. */
export function provisionalTaskTitle(task: Task): boolean {
  return (task.origin === "auto" || task.origin === "backfill") && !task.renamedAt;
}

function toTaskLink(r: Row): TaskLink {
  return {
    id: r.id, projectId: r.project_id, refType: r.ref_type, refId: r.ref_id, fromTaskId: r.from_task_id ?? null, toTaskId: r.to_task_id ?? null,
    basis: r.basis, note: r.note ?? null, actor: r.actor, batchId: r.batch_id ?? null, undoneAt: r.undone_at ?? null, createdAt: r.created_at,
  };
}

/** 업무를 붙이는 기록의 표. */
const TASK_REF_TABLES = { message: "messages", decision: "decisions", file: "files", todo: "todos" } as const;
export type TaskRefType = keyof typeof TASK_REF_TABLES;

function emptyFacts(): ProgressFacts {
  return { reports: [], decisions: [], todos: [], held: [], queued: [], approvals: [], marks: [], watch: null, notice: null, revTimes: [] };
}

function toMark(r: Row): MarkFact {
  return { id: r.id, stage: r.stage, at: r.at, who: r.who, evidence: r.evidence, memberId: r.member_id ?? null };
}

function toWatch(r: Row): WatchFact {
  return { startedAt: r.started_at, attempts: r.attempts, same: r.same_count, fingerprint: r.fingerprint, lastProgressAt: r.last_progress_at, trippedAt: r.tripped_at ?? null, reason: r.trip_reason ?? null, updatedAt: r.updated_at, history: json(r.history_json) };
}

function toWork(r: Row): WorkItem {
  return {
    id: r.id,
    projectId: r.project_id,
    sec: r.sec,
    title: r.title,
    detail: r.detail,
    who: r.who,
    order: r.sort_order,
    doneAt: r.done_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    taskId: r.task_id ?? null,
  };
}

function toMessage(r: Row): Message {
  return {
    id: r.id,
    projectId: r.project_id,
    at: r.at,
    mine: !!r.mine,
    memberId: r.member_id,
    who: r.who,
    kind: r.kind,
    title: r.title,
    body: r.body,
    targetMemberId: r.target_member_id,
    targetName: r.target_name,
    decisionId: r.decision_id,
    fileId: r.file_id,
    attachments: json(r.attachments),
    delivery: r.delivery,
    deliveryNote: r.delivery_note,
    taskId: r.task_id ?? null,
    aboutMessageId: r.about_message_id ?? null,
  };
}

/** 예전 자료에는 kind 가 없다. 첨부와 본문으로 정한다. */
function deriveFileKind(body: string, attachments: { name: string; mime: string }[]): FileKind {
  const first = attachments[0];
  if (!first) return body ? "document" : "file";
  const kinds = attachments.map((a) => fileKindOf(a.name, a.mime));
  // 글에 그림을 곁들인 자료는 글이 주인이다.
  if (body && kinds.every((k) => k === "image")) return "document";
  return kinds[0]!;
}

function toFile(r: Row): FileDoc {
  const attachments = json<Attachment[]>(r.attachments);
  const body = decodeStoredText(r.body);
  return {
    id: r.id,
    kind: r.kind ?? deriveFileKind(body, attachments),
    projectId: r.project_id,
    title: r.title,
    who: r.who,
    memberId: r.member_id,
    summary: r.summary,
    body,
    path: r.path,
    attachments,
    createdAt: r.created_at,
    order: r.sort_order,
    taskId: r.task_id ?? null,
  };
}

function toAttachment(r: Row): Attachment {
  return {
    id: r.id,
    name: r.name,
    mime: r.mime,
    size: r.size,
    url: attachmentUrl(r.id, r.name),
    path: r.path,
    isImage: String(r.mime).startsWith("image/"),
  };
}

function toDelivery(r: Row): Delivery {
  return {
    taskId: r.task_id ?? null,
    id: r.id,
    projectId: r.project_id,
    memberId: r.member_id,
    kind: r.kind,
    text: r.text,
    wake: !!r.wake,
    urgent: !!r.urgent,
    status: r.status,
    holdReason: r.hold_reason,
    refType: r.ref_type,
    refId: r.ref_id,
    attempts: r.attempts,
    lastError: r.last_error,
    createdAt: r.created_at,
    deliveredAt: r.delivered_at,
    ...(r.next_attempt_at !== null && r.next_attempt_at !== undefined ? { nextAttemptAt: r.next_attempt_at } : {}),
  };
}

function toActivity(r: Row): Activity {
  return { id: r.id, memberId: r.member_id, at: r.at, kind: r.kind, text: r.text };
}

function buildSet(patch: Record<string, unknown>, columns: Record<string, string>): { set: string[]; values: SQLQueryBindings[] } {
  const set: string[] = [];
  const values: SQLQueryBindings[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const column = columns[key];
    if (!column || value === undefined) continue;
    set.push(`${column} = ?`);
    values.push(typeof value === "boolean" ? (value ? 1 : 0) : (value as SQLQueryBindings));
  }
  return { set, values };
}

const PROJECT_COLUMNS: Record<keyof ProjectPatch, string> = {
  name: "name",
  cwd: "cwd",
  runnerEnabled: "runner_enabled",
  maxConcurrentTurns: "max_concurrent_turns",
  now: "now",
  herdrTabId: "herdr_tab_id",
  archived: "archived",
};

const MEMBER_COLUMNS: Record<keyof MemberPatch, string> = {
  name: "name",
  role: "role",
  origin: "origin",
  cli: "cli",
  backend: "backend",
  modelOverride: "model_override",
  effortOverride: "effort_override",
  codexSpeed: "codex_speed",
  status: "status",
  now: "now",
  next: "next",
  cwd: "cwd",
  sessionId: "session_id",
  paneId: "pane_id",
  contextPct: "context_pct",
  contextWindow: "context_window",
  contextWindowSource: "context_window_source",
  subagents: "subagents",
  parallel: "parallel_preference",
  lastError: "last_error",
  statusObservation: "status_observation_json",
  blockedReason: "blocked_reason",
  executionIssue: "execution_issue_json",
  subagentState: "subagent_state_json",
  nowAt: "now_at",
  manualActivityAt: "manual_activity_at",
};

function checkMemberText(name: string | undefined, role: string | undefined, kind: MemberKind): void {
  // 총괄·본사 AI 의 이름은 서버가 정한다. 직원만 대표·총괄처럼 보이는 이름을 못 쓴다.
  const problem = (name !== undefined && (kind === "worker" ? workerNameProblem(name) : nameProblem(name))) || null;
  if (problem) throw new ApiError(400, `이름이 잘못되었습니다: ${problem}`);
  const roleProblem = role !== undefined ? oneLineProblem(role, MAX_ROLE) : null;
  if (roleProblem) throw new ApiError(400, `역할이 잘못되었습니다: ${roleProblem}`);
}

function checkProjectName(name: string | undefined): void {
  const problem = name !== undefined ? oneLineProblem(name, MAX_PROJECT_NAME) : null;
  if (problem) throw new ApiError(400, `프로젝트 이름이 잘못되었습니다: ${problem}`);
}

/** 실행기가 지금 쓸 수 있는가. 모르면(아직 안 물어봄) 쓸 수 있는 것으로 친다. */
export interface RunnerHealth {
  ok: boolean;
  detail?: string | null;
}

export interface StoredContextState extends CoreContextState {
  memberId: string;
  generation: number;
  bindingNonce: string;
  rolloutPath: string | null;
  rolloutOffset: number;
  baseline: Record<string, unknown> | null;
  updatedAt: string;
}

export interface ExecutionJournal {
  runId: string;
  memberId: string;
  projectId: string;
  identity: RunnerTerminalIdentity;
  turn: number | null;
  deliveryIds: string[];
  phase: "received" | "starting" | "running" | "ended" | "interrupted" | "unknown";
  inputReceivedAt: string | null;
  startedAt: string | null;
  lastProgressAt: string | null;
  endedAt: string | null;
  result: "success" | "error" | "interrupted" | null;
  reason: string | null;
  exitCode: number | null;
  interruptionNotifiedAt: string | null;
  reportRequestedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * 보고 의무를 마감한 근거(v29). 글 종류만으로 마감하지 않는다: '알림'은 확인한 원보고(reviewed)나
 * 기다리는 자기 결재(waiting)를 밝혀야 하고, 계속 수행을 명시한 진행(continuing)은 실행 보고만 마감한다.
 */
export type ReportClosureKind = "result" | "question" | "delegated" | "waiting" | "reviewed" | "continuing";
export interface ReportClosure {
  memberId: string;
  projectId: string;
  /** 기록 순간 그 직원의 열린 실행(없으면 null). 판정은 실행 시작 이후의 근거 시각으로 한다. */
  runId: string | null;
  kind: ReportClosureKind;
  refType: "message" | "decision" | "delivery";
  refId: string;
  /** reviewed: 확인한 직원 보고 원본 id · waiting: 기다리는 결재 id */
  causeId: string | null;
  at: string;
}
/** 보고 보완 하나와 그 원인 실행. 원인 실행마다 한 번이고, 보완 실행이 끝나면 마감(closed) 또는 보고 미확인(unconfirmed)으로 한 번 정리한다. */
export interface ReportFollowup {
  rootRunId: string;
  memberId: string;
  projectId: string;
  deliveryId: string;
  requestedAt: string;
  settledKind: "closed" | "unconfirmed" | null;
  settledRef: string | null;
  settledAt: string | null;
}

export interface DeliveryRetryState {
  nextAttemptAt: string | null;
  sourceRevision: string | null;
  retryScope: string | null;
  retryReason: string | null;
  correctionRevision: number | null;
}

export const ASSIGNMENT_HISTORY_MS = 14 * 86_400_000;

export class Store implements MessageReadStore, ProjectPatchStore, RunnerRecoveryStore {
  readonly db: Database;
  private readonly sqlTransaction: Database["transaction"];
  private commitFrames: (() => void)[][] = [];
  private readonly commitListeners = new Set<() => void>();
  private lastMessageMs = 0;
  private readonly deliveryWaits = new Map<string, NonNullable<Member["deliveryWait"]>>();
  private runnerHealth = new Map<Backend, RunnerHealth>();
  private lastConnections = new Map<string, string>();
  private readonly fileBodies = new Map<string, { body: string; bytes: number }>();
  private fileBodyBytes = 0;
  private deliveryRead: { projectId: string; rows: Row[]; byId: Map<string, Row>; recoveries: Map<string, Row> } | null = null;

  /** A synchronous read scope only: never reused by a later request or a mutation/admission path. */
  withDeliveryRead<T>(projectId: string, read: () => T): T {
    const previous = this.deliveryRead;
    if (previous?.projectId !== projectId) {
      const rows = this.rows("SELECT * FROM deliveries WHERE project_id = ? ORDER BY rowid", projectId);
      const recoveries = this.rows("SELECT r.* FROM delivery_recovery r JOIN deliveries d ON d.id = r.delivery_id WHERE d.project_id = ?", projectId);
      this.deliveryRead = { projectId, rows, byId: new Map(rows.map(row => [row.id, row])), recoveries: new Map(recoveries.map(row => [row.delivery_id, row])) };
    }
    try {
      const result = read();
      if (result instanceof Promise) throw new Error("withDeliveryRead requires a synchronous callback");
      return result;
    } finally { this.deliveryRead = previous; }
  }
  /** 이전 프로젝트(memory_mode NULL) 가운데 서버 환경 목록(IAMCEO_MEMORY_PROJECTS)으로 켠 것. */
  private legacyMemory: ReadonlySet<string> = new Set();

  constructor(
    db: Database,
    private readonly bus: Bus,
    private readonly recorder?: DomainRecorder,
    options: { readOnly?: boolean } = {},
  ) {
    this.sqlTransaction = db.transaction.bind(db);
    // 기존 import의 store.db.transaction도 같은 commit 큐를 사용한다.
    // 원래 DB 객체/다른 저장소는 변조하지 않고 이 Store의 호환 facade만 제공한다.
    const transaction = <A extends unknown[], T>(write: (...args: A) => T) => {
      const run = (mode: "deferred" | "immediate" | "exclusive") => (...args: A) => this.transaction(() => write(...args), mode);
      return Object.assign(run("deferred"), { deferred: run("deferred"), immediate: run("immediate"), exclusive: run("exclusive") });
    };
    this.db = new Proxy(db, {
      get(target, key) {
        if (key === "transaction") return transaction;
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    if (!options.readOnly) {
      this.ensureHq();
      this.backfillWorkTasks();
      reconcileLegacyTimerStops(this);
      retirePassiveReports(this);
    }
  }

  /** 동기 SQL 전용. await/외부 I/O는 이 경계 밖에서 한다. 중첩 실패는 해당 savepoint의 알림도 버린다. */
  transaction<T>(write: () => T, mode: "deferred" | "immediate" | "exclusive" = "deferred"): T {
    if (this.db.inTransaction && this.commitFrames.length === 0) {
      throw new Error("Store.transaction must own the outer transaction");
    }
    const frame: (() => void)[] = [];
    const messageMs = this.lastMessageMs;
    const backend = this.runtimeBackend;
    this.commitFrames.push(frame);
    let result: T;
    try {
      result = this.sqlTransaction(() => {
        const value = write();
        if (value instanceof Promise) throw new Error("Store.transaction requires a synchronous callback");
        return value;
      })[mode]();
    } catch (error) {
      this.commitFrames.pop();
      this.lastMessageMs = messageMs;
      this.runtimeBackend = backend;
      throw error;
    }
    this.commitFrames.pop();
    const parent = this.commitFrames.at(-1);
    if (parent) parent.push(...frame);
    else for (const effect of frame) {
      // commit은 이미 성공했다. 알림 실패를 쓰기 실패로 오인해 재실행하지 않는다.
      try { effect(); } catch (error) { console.error("Store afterCommit 오류:", error); }
    }
    if (!parent) for (const listener of this.commitListeners) {
      try { listener(); } catch (error) { console.error("Store commit 알림 오류:", error); }
    }
    return result;
  }

  /** Also announces committed writes with no UI event (for example a continuation pause). */
  subscribeTransactions(listener: () => void): () => void {
    this.commitListeners.add(listener);
    return () => this.commitListeners.delete(listener);
  }

  afterCommit(effect: () => void): void {
    const frame = this.commitFrames.at(-1);
    if (frame) frame.push(effect);
    else {
      if (this.db.inTransaction) throw new Error("Use Store.transaction for commit effects");
      effect();
    }
  }

  private emit(event: WsEvent): void {
    this.afterCommit(() => this.bus.emit(event));
    if (event.type === "message" || event.type === "decision" || event.type === "todo" || event.type === "member") {
      try { this.queueProgress(this.progressTargets(event)); } catch (error) { console.error("업무 단계 대상 계산 오류:", error); }
    }
  }

  /** 원본과 outbox를 하나로 접수한다. pump도 최외곽 commit 이후에만 실행한다. */
  withDeliveryIntents<T>(write: () => T, intents: (value: T) => NewDelivery[], pump?: (memberId: string) => void): DeliveryIntentResult<T> {
    return this.transaction(() => {
      const value = write();
      const pumpMembers = new Set<string>();
      const deliveries = intents(value).map((intent) => {
        if (intent.refType && intent.refId) {
          const existing = this.row("SELECT * FROM deliveries WHERE project_id = ? AND member_id = ? AND kind = ? AND ref_type = ? AND ref_id = ? AND source_revision IS ? ORDER BY rowid DESC LIMIT 1", intent.projectId, intent.memberId, intent.kind, intent.refType, intent.refId, intent.sourceRevision ?? null);
          if (existing) return toDelivery(existing);
        }
        pumpMembers.add(intent.memberId);
        return this.enqueue(intent);
      });
      if (pump) for (const id of pumpMembers) this.afterCommit(() => pump(id));
      return { value, deliveries };
    });
  }

  private ensureHq(): void {
    if (this.getProject("hq")) return;
    this.createProject({ id: "hq", name: "본사", cwd: homedir(), runnerEnabled: true });
  }

  private row(sql: string, ...params: SQLQueryBindings[]): Row | null {
    return this.db.query<Row, SQLQueryBindings[]>(sql).get(...params);
  }

  private rows(sql: string, ...params: SQLQueryBindings[]): Row[] {
    return this.db.query<Row, SQLQueryBindings[]>(sql).all(...params);
  }

  private run(sql: string, ...params: SQLQueryBindings[]): void {
    this.db.query<Row, SQLQueryBindings[]>(sql).run(...params);
  }

  private emitProjects(): void {
    this.afterCommit(() => {
      this.emit({ type: "projects", projects: this.projectSummaries() });
      // 연결 상태는 설정·실행기·직접 띄운 세션에 따라 저절로 바뀐다. 여는 화면이 보던 Project 도 고쳐 준다.
      for (const r of this.rows("SELECT * FROM projects")) {
        const project = this.projectFrom(r);
        const key = JSON.stringify(project.connection);
        const before = this.lastConnections.get(project.id);
        this.lastConnections.set(project.id, key);
        if (before !== undefined && before !== key) this.emit({ type: "project", project });
      }
    });
  }

  // ---- 연결 ----
  /** Production runtime is fixed to core. Historical backend values remain readable for migration. */
  private runtimeBackend: Backend = "core";
  /** Runtime is fixed in production; injected legacy runners can select their isolated test adapter. */
  setRuntimeBackend(backend: Backend): void { this.runtimeBackend = backend; }
  effectiveBackend(): Backend { return this.runtimeBackend; }

  chiefCli(projectId: string): CliProvider {
    const cli = this.row("SELECT chief_cli FROM projects WHERE id = ?", projectId)?.chief_cli;
    return (CLI_PROVIDERS as readonly string[]).includes(cli) ? cli as CliProvider : "claude";
  }

  defaultMemberCli(projectId: string): CliProvider {
    return this.getConductor(projectId)?.cli ?? this.chiefCli(projectId);
  }

  setChiefCli(projectId: string, cli: CliProvider): void {
    this.requireProject(projectId);
    this.run("UPDATE projects SET chief_cli = ? WHERE id = ?", cli, projectId);
  }

  archiveAndRotateSession(memberId: string, cli: CliProvider, reason = "provider_switch"): void {
    return this.transaction(() => {
      this.requireMember(memberId);
      this.transaction(() => {
        this.run(`INSERT INTO member_session_history (id, member_id, cli, backend, session_id, pane_id, generation, applied_config, archived_at, reason)
          SELECT ?, id, cli, backend, session_id, pane_id, session_generation, applied_config, ?, ? FROM members WHERE id = ?`, newId("hist_"), nowIso(), reason, memberId);
        this.run(`UPDATE members SET cli = ?, token = ?, session_id = NULL, pane_id = NULL, context_pct = NULL, context_window = NULL, context_window_source = NULL,
          applied_config = NULL, execution_issue_json = NULL, parallel = 0, subagents = 0, config_revision = config_revision + 1, session_generation = session_generation + 1 WHERE id = ?`, cli, `tk_${newId("")}${newId("")}`, memberId);
      });
    });
  }

  /** 실행기 상태를 적는다. 달라졌으면 화면에 알리고 true. */
  setRunnerHealth(backend: Backend, health: RunnerHealth): boolean {
    const before = this.runnerHealth.get(backend);
    this.runnerHealth.set(backend, health);
    if ((before?.ok ?? true) === health.ok && (before?.detail ?? null) === (health.detail ?? null)) return false;
    this.emitProjects();
    return true;
  }

  private hasLiveManual(projectId: string): boolean {
    return this.row("SELECT 1 FROM members WHERE project_id = ? AND origin = 'manual' AND status NOT IN ('offline','asleep','error') LIMIT 1", projectId) !== null;
  }

  private runnerUsable(runnerEnabled: boolean): boolean {
    return runnerEnabled && (this.runnerHealth.get(this.effectiveBackend())?.ok ?? true);
  }

  private connectionOf(id: string, runnerEnabled: boolean, archived: boolean): ProjectConnection {
    if (archived) return { ok: false, reason: "archived", detail: "보관된 프로젝트입니다. 보관함에서 꺼내면 쓸 수 있습니다" };
    if (this.runnerUsable(runnerEnabled) || this.hasLiveManual(id)) return { ok: true, reason: null, detail: null };
    if (!runnerEnabled) return { ok: false, reason: "runner_off", detail: "AI가 아직 연결되지 않았습니다. 총괄을 시작하거나 기존 세션을 편입하세요" };
    const backend = this.effectiveBackend();
    const health = this.runnerHealth.get(backend);
    return { ok: false, reason: "backend_down", detail: `${backend === "core" ? "herdr-core" : backend === "herdr" ? "herdr" : "claude"}에 연결할 수 없습니다. 연결되면 쓸 수 있습니다${health?.detail ? ` (${health.detail})` : ""}` };
  }

  private projectFrom(r: Row): Project {
    return toProject(r, this.connectionOf(r.id, !!r.runner_enabled, !!r.archived), this.legacyMemory);
  }

  /**
   * 대표의 말·답을 지금 받을 수 있는지 본다. 없으면 409. 받는 쪽이 직접 띄운 세션이면 그 세션만 살아 있으면 되고,
   * 그 밖에는 실행기가 돌아야 한다(직접 띄운 세션이 살아 있어도 총괄에게 갈 말은 갈 곳이 없다).
   */
  requireReachable(projectId: string, target: Member | null): void {
    const project = this.requireProject(projectId);
    if (!project.connection.ok) throw new ApiError(409, project.connection.detail ?? "연결되어야 쓸 수 있습니다");
    if (this.runnerUsable(project.runnerEnabled)) return;
    if (target?.origin === "manual" && !["offline", "asleep", "error"].includes(target.status)) return;
    throw new ApiError(409, "실행기가 연결되지 않아 직접 띄운 세션에게만 보낼 수 있습니다. 받을 세션을 @로 골라 주세요");
  }

  /**
   * 시작할 때마다 도는 정리(멱등). 연결 전에 쌓인 말·결재 답을 돌려준다: 결재는 직전 답을 카드에 남기고 다시 열고, 대표 글은 실패로 표시해 다시 보낼 수 있게 한다.
   * 실행이 꺼진 뒤 대기 중이던 답도 이 길로 온다. 가져온 못 읽은 말(IMPORT_HOLD_NOTE)은 총괄을 시작하면 전달하기로 약속했으므로 건드리지 않는다. 돌려준 건수를 돌려준다.
   */
  releaseHeldBeforeConnection(): { messages: number; decisions: number } {
    const note = "연결 전이라 전달되지 않았습니다";
    const reopenNote = "연결 전이라 전달되지 않았습니다. 다시 결정해 주세요";
    const out = { messages: 0, decisions: 0 };
    const held = this.rows("SELECT * FROM deliveries WHERE status = 'held' AND hold_reason = 'runner_disabled' ORDER BY rowid").map(toDelivery);
    const released: string[] = [];
    for (const d of held) {
      if (d.refType === "decision" && d.refId) {
        const decisionId = d.refId;
        // 지우고 다시 여는 사이에 죽으면 답도 전달도 사라진다. 한 번에 한다.
        this.transaction(() => {
          this.run("DELETE FROM deliveries WHERE id = ?", d.id);
          if (this.getDecision(decisionId)?.status === "answered") {
            this.reopenDecision(decisionId, reopenNote);
            out.decisions++;
          }
        });
        released.push(decisionId);
        this.emitMember(d.memberId);
      } else if (d.kind !== "report" && d.refType === "message" && d.refId) {
        // 직원 보고는 대표 글이 아니다. 실행기가 꺼진 동안 보류된 보고는 지우지 않고 다시 켜졌을 때 전달한다.
        this.run("DELETE FROM deliveries WHERE id = ?", d.id);
        released.push(d.refId);
        this.setMessageDelivery(d.refId, "failed", note);
        out.messages++;
        this.emitMember(d.memberId);
      }
    }
    // 총괄에게 묶어 둔 '대표가 답했습니다' 알림은 되돌린 답을 가리키므로 함께 거둔다.
    for (const d of held) {
      if (d.kind === "system" && released.some((id) => d.text.includes(id))) {
        this.run("DELETE FROM deliveries WHERE id = ?", d.id);
        this.emitMember(d.memberId);
      }
    }
    // 총괄이 없어 전달 항목 없이 보류된 말과, 받을 사람이 없어 멈춘 답.
    for (const p of this.rows("SELECT id FROM projects WHERE runner_enabled = 0")) {
      const linked = new Set(this.rows("SELECT ref_id FROM deliveries WHERE project_id = ? AND status IN ('queued','held','delivering')", p.id).map((r) => r.ref_id));
      for (const r of this.rows("SELECT id FROM messages WHERE project_id = ? AND mine = 1 AND delivery IN ('held','queued') AND target_member_id IS NULL AND COALESCE(delivery_note, '') != ?", p.id, IMPORT_HOLD_NOTE)) {
        if (linked.has(r.id)) continue;
        this.setMessageDelivery(r.id, "failed", note);
        out.messages++;
      }
      for (const d of this.listAnsweredDecisions(p.id)) {
        if (linked.has(d.id) || (d.memberId && this.getMember(d.memberId))) continue;
        this.reopenDecision(d.id, reopenNote);
        out.decisions++;
      }
    }
    return out;
  }

  // ---- 프로젝트 ----
  getProject(id: string): Project | null {
    const r = this.row("SELECT * FROM projects WHERE id = ?", id);
    return r ? this.projectFrom(r) : null;
  }

  requireProject(id: string): Project {
    const p = this.getProject(id);
    if (!p) throw new ApiError(404, "프로젝트를 찾을 수 없습니다");
    return p;
  }

  listProjects(opts: { includeArchived?: boolean } = {}): Project[] {
    const where = opts.includeArchived ? "" : "WHERE archived = 0";
    return this.rows(`SELECT * FROM projects ${where} ORDER BY is_hq DESC, created_at, rowid`).map((r) => this.projectFrom(r));
  }

  createProject(input: NewProject): Project {
    return this.transaction(() => {
      checkProjectName(input.name);
      const at = nowIso();
      const id = input.id ?? newId("p_");
      const now = input.now ?? "";
      this.run(
        `INSERT INTO projects (id, name, is_hq, cwd, runner_enabled, now, now_at, created_at, updated_at, creation_goal, chief_cli, memory_mode, memory_enabled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.name,
        id === "hq" ? 1 : 0,
        input.cwd,
        (input.runnerEnabled ?? true) ? 1 : 0,
        now,
        now ? at : null,
        at,
        at,
        input.creationGoal ?? null,
        input.chiefCli ?? "codex",
        // 새 프로젝트는 기억 운영을 켠 채로 만든다(본사는 직원이 없어 따로 켤 때만). 서버에 연결 설정이 없으면 '미연결'로 보인다.
        memoryMode(id, input.memory),
        memoryMode(id, input.memory) === "on" ? at : null,
      );
      const project = this.requireProject(id);
      this.emit({ type: "project", project });
      this.emitProjects();
      return project;
    });
  }

  private projectConductorName(name: string): string {
    return cleanName(conductorName(name), "총괄");
  }

  validateProjectPatch(id: string, patch: ProjectPatch): ProjectPatch {
    const project = this.requireProject(id);
    if (patch.archived === true && patch.runnerEnabled === true) throw new ApiError(400, "보관과 실행 켜기를 함께 요청할 수 없습니다");
    if (project.isHq && patch.archived === true) throw new ApiError(400, "본사는 보관할 수 없습니다");
    if (patch.maxConcurrentTurns !== undefined && patch.maxConcurrentTurns !== null &&
        (!Number.isInteger(patch.maxConcurrentTurns) || patch.maxConcurrentTurns < 1 || patch.maxConcurrentTurns > 64)) {
      throw new ApiError(400, "프로젝트 동시 실행 상한은 1부터 64까지의 정수입니다");
    }
    if (patch.name !== undefined) {
      // trim 전에도 줄바꿈/제어문자는 거부한다.
      const problem = oneLineProblem(patch.name, Number.MAX_SAFE_INTEGER);
      if (problem) throw new ApiError(400, problem);
      patch = { ...patch, name: patch.name.trim() };
      checkProjectName(patch.name);
      if (!patch.name) throw new ApiError(400, "프로젝트 이름이 필요합니다");
      const lead = this.getConductor(id);
      const name = this.projectConductorName(patch.name);
      if (lead?.kind === "conductor" && (lead.name === conductorName(project.name) || lead.name === this.projectConductorName(project.name)) && this.row("SELECT 1 FROM active_members WHERE project_id = ? AND id != ? AND name = ?", id, lead.id, name)) {
        throw new ApiError(409, "새 총괄 이름과 같은 직원이 있습니다");
      }
    }
    return { ...patch };
  }

  patchProject(id: string, patch: ProjectPatch): Project {
    return this.transaction(() => {
      patch = this.validateProjectPatch(id, patch);
      const before = this.requireProject(id);
      patch = Object.fromEntries(Object.entries(patch).filter(([key, value]) => value !== undefined && value !== before[key as keyof ProjectPatch]));
      const { set, values } = buildSet(patch, PROJECT_COLUMNS);
      if (set.length === 0) return before;
      const at = nowIso();
      set.push("updated_at = ?");
      values.push(at);
      if (patch.now !== undefined && patch.now !== before.now) {
        set.push("now_at = ?");
        values.push(at);
      }
      this.run(`UPDATE projects SET ${set.join(", ")} WHERE id = ?`, ...values, id);
      const project = this.requireProject(id);
      if (patch.name !== undefined && patch.name !== before.name) {
        const lead = this.getConductor(id);
        if (lead?.kind === "conductor" && (lead.name === conductorName(before.name) || lead.name === this.projectConductorName(before.name))) this.patchMember(lead.id, { name: this.projectConductorName(project.name) });
      }
      this.emit({ type: "project", project });
      this.emitProjects();
      return project;
    });
  }

  /** 실행을 켠 것이 편입인가. 맞으면 대표가 시키지 않은 총괄을 띄우지 않고, 남은 세션이 없을 때 실행을 끈다. */
  runnerByAdopt(id: string): boolean {
    return !!this.row("SELECT runner_by_adopt FROM projects WHERE id = ?", id)?.runner_by_adopt;
  }

  setRunnerByAdopt(id: string, on: boolean): void {
    this.run("UPDATE projects SET runner_by_adopt = ? WHERE id = ?", on ? 1 : 0, id);
  }

  projectSummaries(): ProjectSummary[] {
    return this.rows(
      `SELECT p.id, p.name, p.is_hq, p.cwd, p.now, p.runner_enabled, p.max_concurrent_turns, p.archived,
         (SELECT COUNT(*) FROM decisions d WHERE d.project_id = p.id AND d.status = 'open') AS decision_count,
         (SELECT COUNT(*) FROM todos t WHERE t.project_id = p.id AND t.done = 0) AS todo_count,
         (SELECT COUNT(*) FROM active_members m WHERE m.project_id = p.id AND m.status = 'working') AS working_count,
         (SELECT COUNT(*) FROM active_members m WHERE m.project_id = p.id AND m.status = 'blocked' AND m.blocked_reason = 'permission') AS blocked_count,
         (SELECT COUNT(*) FROM active_members m WHERE m.project_id = p.id AND m.status = 'error') AS error_count,
         (SELECT COUNT(*) FROM active_members m WHERE m.project_id = p.id) AS member_count
       FROM projects p WHERE p.archived = 0 ORDER BY p.is_hq DESC, p.created_at, p.rowid`,
    ).map((r) => ({
      id: r.id,
      name: r.name,
      isHq: !!r.is_hq,
      cwd: r.cwd,
      now: r.now,
      runnerEnabled: !!r.runner_enabled,
      maxConcurrentTurns: r.max_concurrent_turns ?? null,
      connection: this.connectionOf(r.id, !!r.runner_enabled, !!r.archived),
      decisionCount: r.decision_count,
      todoCount: r.todo_count,
      inboxCount: r.decision_count + r.todo_count,
      workingCount: r.working_count,
      blockedCount: r.blocked_count,
      errorCount: r.error_count,
      memberCount: r.member_count,
    }));
  }

  projectState(id: string, opts: { compact?: boolean } = {}): ProjectState {
    const project = this.requireProject(id);
    const facts = this.taskProgressFacts(id);
    const members = this.listMembers(id), tasks = this.listTasks(id, facts);
    return {
      project,
      members,
      workflow: this.projectWorkflow(id, tasks, members, facts),
      decisions: this.listDecisions(id),
      doneDecisionCount: this.row("SELECT COUNT(*) AS n FROM decisions WHERE project_id = ? AND status != 'open'", id)!.n as number,
      todos: this.listTodos(id),
      work: this.listWork(id),
      messages: opts.compact ? [] : this.listMessages(id, { limit: 200 }),
      files: opts.compact ? this.listFilePage(id).items.map(file => ({ ...file, body: "" })) : this.listFiles(id),
      tasks,
    };
  }

  private memberWithWait(row: Row): Member {
    const member = toMember(row);
    return { ...member, deliveryWait: member.queuedCount ? this.deliveryWaits.get(member.id) ?? null : null };
  }

  setDeliveryWait(memberId: string, wait: Omit<NonNullable<Member["deliveryWait"]>, "since"> | null): void {
    const before = this.deliveryWaits.get(memberId);
    if (!wait && !before) return;
    const next = wait ? { ...wait, since: before?.kind === wait.kind ? before.since : nowIso() } : null;
    if (JSON.stringify(next) === JSON.stringify(before ?? null)) return;
    if (next) this.deliveryWaits.set(memberId, next); else this.deliveryWaits.delete(memberId);
    const member = this.getMember(memberId);
    if (member) { this.emit({ type: "member", member }); }
  }

  // ---- 직원 ----
  getMember(id: string): Member | null {
    const r = this.row(`${MEMBER_SELECT} WHERE m.id = ?`, id);
    return r ? this.memberWithWait(r) : null;
  }

  requireMember(id: string): Member {
    const m = this.getMember(id);
    if (!m) throw new ApiError(404, "직원을 찾을 수 없습니다");
    return m;
  }

  /** MCP 인증용. 없으면 null. */
  getMemberByToken(token: string): Member | null {
    if (!token) return null;
    const r = this.row(`${MEMBER_SELECT} WHERE m.token = ?`, token);
    return r ? this.memberWithWait(r) : null;
  }

  /** MCP 설정 파일을 쓸 때만 쓴다. 화면으로 보내지 않는다. */
  getMemberToken(id: string): string {
    const r = this.row("SELECT token FROM members WHERE id = ?", id);
    if (!r) throw new ApiError(404, "직원을 찾을 수 없습니다");
    return r.token;
  }

  listMembers(projectId: string): Member[] {
    return this.rows(`${MEMBER_SELECT} WHERE m.project_id = ? ORDER BY m.created_at, m.roster_rowid`, projectId).map(r => this.memberWithWait(r));
  }

  listAllMembers(): Member[] {
    return this.rows(`${MEMBER_SELECT} ORDER BY m.created_at, m.roster_rowid`).map(r => this.memberWithWait(r));
  }

  getMemberByHandle(projectId: string, handle: string): Member | null {
    const r = this.row(`${MEMBER_SELECT} WHERE m.project_id = ? AND m.handle = ?`, projectId, handle);
    return r ? this.memberWithWait(r) : null;
  }

  /** 핸들 또는 화면 이름으로 찾는다. 같은 프로젝트 안에서만. */
  findMember(projectId: string, handleOrName: string): Member | null {
    const r = this.row(`${MEMBER_SELECT} WHERE m.project_id = ? AND (m.handle = ? OR m.name = ?) ORDER BY m.handle = ? DESC`, projectId, handleOrName, handleOrName, handleOrName);
    return r ? this.memberWithWait(r) : null;
  }

  /** 프로젝트의 총괄(본사는 root). */
  getConductor(projectId: string): Member | null {
    const r = this.row(`${MEMBER_SELECT} WHERE m.project_id = ? AND m.kind IN ('root','conductor') ORDER BY m.created_at LIMIT 1`, projectId);
    return r ? this.memberWithWait(r) : null;
  }

  getFinalReviewer(projectId: string): Member | null {
    const row = this.row(`${MEMBER_SELECT} WHERE m.project_id = ? AND m.final_reviewer = 1`, projectId);
    return row ? this.memberWithWait(row) : null;
  }

  getStandbyReviewer(projectId: string): Member | null {
    const row = this.row(`${MEMBER_SELECT} WHERE m.project_id=? AND m.standby_reviewer=1`, projectId);
    return row ? this.memberWithWait(row) : null;
  }

  ensureFinalReviewer(projectId: string): Member | null { return this.ensureManagedReviewer(projectId, false); }
  ensureStandbyReviewer(projectId: string): Member | null { return this.ensureManagedReviewer(projectId, true); }

  private ensureManagedReviewer(projectId: string, standby: boolean): Member | null {
    return this.transaction(() => {
      const project = this.requireProject(projectId);
      if (project.isHq || project.archived || !project.runnerEnabled) return null;
      const existing = standby ? this.getStandbyReviewer(projectId) : this.getFinalReviewer(projectId);
      if (existing) return existing;
      const baseHandle = standby ? "standby-review" : "final-review";
      const baseName = standby ? "예비 검수" : "최종 검수";
      let suffix = 0, handle = baseHandle, name = baseName;
      while (this.findMember(projectId, handle) || this.findMember(projectId, name)) {
        suffix++;
        handle = `${baseHandle}-${suffix}`; name = `${baseName} ${suffix + 1}`;
      }
      return this.insertMember({ projectId, handle, name, role: standby ? "별도로 배정된 완료 보고의 독립 검수" : "완료 조건과 검증 근거의 독립 최종 검수",
        kind: "worker", origin: "runner", status: "offline", finalReviewer: !standby,
        cli: this.defaultMemberCli(projectId) === "claude" ? "claude" : "codex" }, standby);
    });
  }

  getMemberBySession(sessionId: string): Member | null {
    const r = this.row(`${MEMBER_SELECT} WHERE m.session_id = ?`, sessionId);
    return r ? this.memberWithWait(r) : null;
  }

  getMemberByPane(paneId: string): Member | null {
    const r = this.row(`${MEMBER_SELECT} WHERE m.pane_id = ?`, paneId);
    return r ? this.memberWithWait(r) : null;
  }

  createMember(input: NewMember): Member { return this.insertMember(input, false); }

  private insertMember(input: NewMember, standby: boolean): Member {
    return this.transaction(() => {
      const project = this.requireProject(input.projectId);
      checkMemberText(input.name, input.role, input.kind);
      if (input.kind === "worker" && RESERVED_HANDLES.has(input.handle)) throw new ApiError(400, `총괄 자리의 핸들이라 직원에게 쓸 수 없습니다: ${input.handle}`);
      if (!HANDLE_RE.test(input.handle)) throw new ApiError(400, "핸들은 영문 소문자로 시작하고 영문 소문자·숫자·_·- 만 쓸 수 있습니다(32자 이내)");
      if (this.getMemberByHandle(input.projectId, input.handle)) throw new ApiError(409, `이미 있는 핸들입니다: ${input.handle}`);
      if (this.row("SELECT 1 FROM active_members WHERE project_id = ? AND name = ?", input.projectId, input.name)) {
        throw new ApiError(409, `이미 있는 이름입니다: ${input.name}`);
      }
      const id = newId("m_");
      const at = nowIso();
      this.run(
        `INSERT INTO members (id, project_id, handle, name, role, kind, origin, backend, status, cwd, session_id, pane_id, parallel_preference, token, updated_at, created_at, cli, model_override, effort_override, final_reviewer, standby_reviewer)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.projectId,
        input.handle,
        input.name,
        input.role ?? "",
        input.kind,
        input.origin ?? "runner",
        input.backend ?? null,
        input.status ?? "idle",
        input.cwd ?? project.cwd,
        input.sessionId ?? null,
        input.paneId ?? null,
        input.parallel === false ? 0 : 1,
        `tk_${newId("")}${newId("")}`,
        at,
        at,
        input.cli ?? this.defaultMemberCli(input.projectId),
        input.modelOverride ?? null,
        input.effortOverride ?? null,
        input.finalReviewer ? 1 : 0, standby ? 1 : 0,
      );
      const member = this.requireMember(id);
      this.emit({ type: "member", member });
      this.emitProjects();
      return member;
    });
  }

  patchMember(id: string, patch: MemberPatch): Member {
    return this.transaction(() => {
      const before = this.requireMember(id);
      checkMemberText(patch.name, patch.role, before.kind);
      // 배운 창 크기는 그 세션·CLI 의 것이다. 세션이나 CLI 가 바뀌면 다음 턴 끝에 다시 배운다.
      const sessionChanged = (patch.sessionId !== undefined && patch.sessionId !== before.sessionId) || (patch.cli !== undefined && patch.cli !== before.cli);
      if (sessionChanged && patch.contextWindow === undefined) patch = { ...patch, contextWindow: null, contextWindowSource: null };
      if (patch.contextWindow === null) patch = { ...patch, contextWindowSource: null };
      if (sessionChanged && patch.contextWindowSource === undefined) patch = { ...patch, contextWindowSource: null };
      // 같은 세션의 실측 창은 화면 추정으로 덮지 않는다.
      if (!sessionChanged && exactSource(before.contextWindowSource) && patch.contextWindowSource === "screen") {
        patch = { ...patch, contextWindow: before.contextWindow, contextWindowSource: before.contextWindowSource };
      }
      // blocked 자체는 입력 보류다. 새 진입에서 이전 승인의 증거를 재사용하지 않는다.
      if (patch.status !== undefined && patch.status !== "blocked") patch = { ...patch, blockedReason: null };
      else if (patch.status === "blocked" && before.status !== "blocked" && patch.blockedReason === undefined) patch = { ...patch, blockedReason: "status_unknown" };
      const at = nowIso();
      if (patch.now !== undefined && patch.nowAt === undefined) patch = { ...patch, nowAt: at };
      const { set, values } = buildSet({
        ...patch,
        executionIssue: patch.executionIssue == null ? patch.executionIssue : JSON.stringify(patch.executionIssue),
        statusObservation: patch.statusObservation == null ? patch.statusObservation : JSON.stringify(patch.statusObservation),
        subagentState: patch.subagentState == null ? patch.subagentState : JSON.stringify(patch.subagentState),
      }, MEMBER_COLUMNS);
      if (set.length === 0) return before;
      if (["name", "role", "cli", "modelOverride", "effortOverride", "codexSpeed", "cwd", "backend"].some((key) => patch[key as keyof MemberPatch] !== undefined && patch[key as keyof MemberPatch] !== before[key as keyof MemberPatch])) set.push("config_revision = config_revision + 1");
      set.push("updated_at = ?");
      values.push(at);
      this.run(`UPDATE members SET ${set.join(", ")} WHERE id = ?`, ...values, id);
      if ((patch.modelOverride !== undefined && patch.modelOverride !== before.modelOverride) || (patch.sessionId !== undefined && before.sessionId !== null && patch.sessionId !== before.sessionId) || (patch.cli !== undefined && patch.cli !== before.cli)) {
        this.run("UPDATE member_context_state SET measurement_json = NULL, updated_at = ? WHERE member_id = ?", nowIso(), id);
      }
      const member = this.requireMember(id);
      this.recorder?.member(before, member);
      this.emit({ type: "member", member });
      if (member.status !== before.status || member.blockedReason !== before.blockedReason) this.emitProjects();
      return member;
    });
  }

  /** Last confirmed session-level parallel control. Preference survives new processes and provider changes. */
  parallelApplied(id: string): boolean {
    return !!this.row("SELECT parallel FROM members WHERE id = ?", id)?.parallel;
  }

  setParallelApplied(id: string, enabled: boolean): void {
    this.run("UPDATE members SET parallel = ? WHERE id = ?", enabled ? 1 : 0, id);
  }

  getAppliedConfig(id: string): AppliedConfig | null {
    const r = this.row("SELECT applied_config FROM members WHERE id = ?", id);
    return r ? appliedOf(r) : null;
  }

  /** 세션에 실제로 들어간 설정을 적는다. 잦지 않고, 바뀌었을 때만 화면에 알린다. */
  /** 비어 있는 직급 effort 를 채운다. 비어 있으면 세션을 다시 열 때 CLI 기본값(medium)으로 돌아간다. */
  fillRankEfforts(fallback: Effort): void {
    const { ranks } = this.getSettings();
    const missing = (Object.keys(ranks) as Rank[]).filter((r) => !ranks[r].effort);
    if (missing.length === 0) return;
    this.patchSettings({ ranks: Object.fromEntries(missing.map((r) => [r, { effort: fallback }])) });
  }

  setAppliedConfig(id: string, config: AppliedConfig | null): void {

    this.transaction(() => {
      const value = config ? JSON.stringify(config) : null;
      const before = this.row("SELECT applied_config FROM members WHERE id = ?", id);
      if ((before?.applied_config ?? null) === value) return;
      // 세션에 들어간 모델이 바뀌면 배운 창 크기도 그 모델의 것이 아니다.
      const modelChanged = (before ? appliedOf(before)?.model ?? null : null) !== (config?.model ?? null);
      this.run(`UPDATE members SET applied_config = ?${modelChanged ? ", context_window = NULL, context_window_source = NULL" : ""} WHERE id = ?`, value, id);
      if (modelChanged) this.run("UPDATE member_context_state SET measurement_json = NULL, updated_at = ? WHERE member_id = ?", nowIso(), id);
      this.emitMember(id);
    });
  }

  /** 편입 표시. turnedOnRunner: 이 편입이 프로젝트 실행을 켰다(해제할 때 되돌린다). */
  setAdoptedInfo(id: string, info: AdoptedInfo | null): void {
    this.run("UPDATE members SET adopted_info = ? WHERE id = ?", info ? JSON.stringify(info) : null, id);
    this.emitMember(id);
  }

  getAdoptedInfo(id: string): AdoptedInfo | null {
    const raw = this.row("SELECT adopted_info FROM members WHERE id = ?", id)?.adopted_info;
    return raw ? json<AdoptedInfo>(raw) : null;
  }

  /** 도구 활동 시각은 일반 수정 시각과 분리한다. 잦아서 방송하지 않는다. */
  touchMember(id: string): void {
    const at = nowIso();
    this.run("UPDATE members SET updated_at = ?, manual_activity_at = CASE WHEN origin = 'manual' THEN ? ELSE manual_activity_at END WHERE id = ?", at, at, id);
  }

  isRetiredMember(id: string): boolean {
    return !!this.row("SELECT 1 FROM members WHERE id=? AND retired_at IS NOT NULL", id);
  }

  retireSleepingMember(id: string): void {
    this.transaction(() => {
      if (this.isRetiredMember(id)) return;
      const member = this.requireMember(id);
      if (member.origin !== "runner" || member.status !== "asleep" || member.paneId || member.subagents ||
          member.finalReviewer && !member.standbyReviewer) {
        throw new ApiError(409, "프로세스가 종료된 휴면 직원만 명부에서 뺄 수 있습니다. 기본 검수 담당자는 유지됩니다");
      }
      const input = this.inputState(id);
      if (input.lease || input.unresolvedDispatches.length || this.listOpenDecisionsByMember(id).length ||
          this.row("SELECT 1 FROM deliveries WHERE member_id=? AND status IN ('queued','delivering','held') LIMIT 1", id) ||
          this.row("SELECT 1 FROM execution_journal WHERE member_id=? AND phase NOT IN ('ended','interrupted') LIMIT 1", id) ||
          this.row(`SELECT 1 FROM task_completion_reviews r JOIN deliveries d ON d.id=r.delivery_id
                    WHERE r.status='pending' AND d.member_id=? LIMIT 1`, id)) {
        throw new ApiError(409, "남아 있는 실행·전달·결재·검수 기록을 먼저 확인해 주세요");
      }
      const at = nowIso();
      this.run("UPDATE members SET retired_at=?, updated_at=?, retired_handle=handle, handle='#'||id WHERE id=?", at, at, id);
      this.emit({ type: "member_removed", projectId: member.projectId, memberId: id });
      this.emitProjects();
    }, "immediate");
  }

  /** 그 직원의 전달·활동도 함께 사라진다(CASCADE). 대화·결재 기록은 남는다. */
  removeMember(id: string): void {
    return this.transaction(() => {
      const member = this.requireMember(id);
      this.run("DELETE FROM members WHERE id = ?", id);
      this.emit({ type: "member_removed", projectId: member.projectId, memberId: id });
      this.emitProjects();
    });
  }

  // ---- 결재 ----
  /** References named in this card and recent material from the exact tasks it points to. */
  getDecisionContext(id: string): DecisionContext {
    const decision = this.requireDecision(id);
    const projectId = decision.projectId;
    const refs = new Map<string, DecisionFileLink>();
    const tasks = new Map<string, DecisionContext["tasks"][number]>();
    const addFile = (fileId: string | null) => {
      if (!fileId || refs.has(fileId) || refs.size >= 10) return;
      const row = this.row("SELECT id, title FROM files WHERE id = ? AND project_id = ?", fileId, projectId);
      if (row) refs.set(row.id, { id: row.id, title: row.title });
    };
    const addTask = (taskId: string | null | undefined) => {
      if (!taskId || tasks.has(taskId) || tasks.size >= 4) return;
      const task = this.getTask(taskId);
      if (!task || task.projectId !== projectId) return;
      const resolved = this.resolveTask(task);
      tasks.set(resolved.id, { id: resolved.id, title: resolved.title, files: [] });
    };

    const addReport = (source: Row) => {
      addTask(source.task_id);
      addFile(source.file_id);
      for (const fileId of this.getReportReferences(projectId, source.id)?.fileIds ?? []) addFile(fileId);
    };

    addFile(decision.fileId);
    addTask(decision.taskId);
    const tokens = new Set(decision.detail.match(/\b(?:f_|msg_|tk_|d_)[A-Za-z0-9_-]{3,128}(?![A-Za-z0-9_-])/g) ?? []);
    for (const token of [...tokens].slice(0, 24)) {
      if (token.startsWith("f_")) addFile(token);
      else if (token.startsWith("tk_")) addTask(token);
      else if (token.startsWith("msg_")) {
        const source = this.row("SELECT id, file_id, task_id FROM messages WHERE id = ? AND project_id = ?", token, projectId);
        if (source) addReport(source);
      } else if (token !== decision.id) {
        const earlier = this.row("SELECT file_id, task_id FROM decisions WHERE id = ? AND project_id = ?", token, projectId);
        if (!earlier) continue;
        addFile(earlier.file_id);
        addTask(earlier.task_id);
      }
    }

    const reports = this.rows(`SELECT id, file_id, task_id FROM messages
      WHERE project_id = ? AND decision_id = ? AND kind IN ('완료', '진행', '막힘', '알림')
      ORDER BY at DESC, id DESC LIMIT 6`, projectId, decision.id);
    reports.forEach(addReport);

    const shown = new Set(refs.keys());
    for (const task of tasks.values()) {
      const rows = this.rows(`SELECT id, title FROM files WHERE project_id = ? AND task_id = ?
        ORDER BY sort_order DESC, id COLLATE BINARY DESC LIMIT ?`, projectId, task.id, 3 + shown.size);
      task.files = rows.filter(row => !shown.has(row.id)).slice(0, 3).map(row => ({ id: row.id, title: row.title }));
      task.files.forEach(file => shown.add(file.id));
    }
    return { references: [...refs.values()], tasks: [...tasks.values()] };
  }

  getDecision(id: string): Decision | null {
    const r = this.row("SELECT * FROM decisions WHERE id = ?", id);
    return r ? toDecision(r) : null;
  }

  requireDecision(id: string): Decision {
    const d = this.getDecision(id);
    if (!d) throw new ApiError(404, "결재를 찾을 수 없습니다");
    return d;
  }

  /** 열린 것 전부(오래된 순) + 처리된 것 최근 50(최근 순). */
  listDecisions(projectId: string): Decision[] {
    const open = this.rows("SELECT * FROM decisions WHERE project_id = ? AND status = 'open' ORDER BY created_at, rowid", projectId);
    const done = this.rows(
      "SELECT * FROM decisions WHERE project_id = ? AND status != 'open' ORDER BY COALESCE(answered_at, created_at) DESC, rowid DESC LIMIT 50",
      projectId,
    );
    return [...open, ...done].map(toDecision);
  }

  listOpenDecisions(projectId: string): Decision[] {
    return this.rows("SELECT * FROM decisions WHERE project_id = ? AND status = 'open' ORDER BY created_at, rowid", projectId).map(toDecision);
  }

  /** 처리된 결재를 이어 받는다. before 는 그보다 앞서 답한 것만. */
  listDoneDecisions(projectId: string, opts: { before?: string; limit?: number } = {}): Decision[] {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const when = "COALESCE(answered_at, created_at)";
    const rows = opts.before
      ? this.rows(`SELECT * FROM decisions WHERE project_id = ? AND status != 'open' AND ${when} < ? ORDER BY ${when} DESC, rowid DESC LIMIT ?`, projectId, opts.before, limit)
      : this.rows(`SELECT * FROM decisions WHERE project_id = ? AND status != 'open' ORDER BY ${when} DESC, rowid DESC LIMIT ?`, projectId, limit);
    return rows.map(toDecision);
  }

  /** 대표가 답한 결재 전부. 승인 근거 대조는 화면용 50건 제한을 받지 않는다. */
  listAllDoneDecisions(projectId: string): Decision[] {
    return this.rows("SELECT * FROM decisions WHERE project_id = ? AND status != 'open' ORDER BY COALESCE(answered_at, created_at) DESC, rowid DESC", projectId).map(toDecision);
  }

  /** 앞 판보다 반드시 큰 시각. 같은 ms 안의 전이도 화면이 순서를 가른다. */
  private nextDecisionStamp(id: string): string {
    const before = this.row("SELECT updated_at FROM decisions WHERE id = ?", id)?.updated_at as string | null | undefined;
    const prev = before ? Date.parse(before) : 0;
    return new Date(Math.max(Date.now(), prev + 1)).toISOString();
  }

  listOpenDecisionsByMember(memberId: string): Decision[] {
    return this.rows("SELECT * FROM decisions WHERE member_id = ? AND status = 'open' ORDER BY created_at, rowid", memberId).map(toDecision);
  }

  createDecision(input: NewDecision): Decision {
    return this.transaction(() => {
      this.requireProject(input.projectId);
      const id = newId("d_");
      this.run(
        `INSERT INTO decisions (id, project_id, member_id, who, title, detail, options, rec, grp, file_id, images, status, created_at, updated_at, task_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
        id,
        input.projectId,
        input.memberId ?? null,
        input.who,
        input.title,
        input.detail ?? "",
        JSON.stringify(input.options ?? []),
        input.rec ?? null,
        input.group ?? null,
        input.fileId ?? null,
        JSON.stringify(input.images ?? []),
        nowIso(),
        nowIso(),
        this.taskRef(input.projectId, input.taskId),
      );
      const decision = this.requireDecision(id);
      this.recorder?.decision(null, decision);
      this.bumpBoard(decision.projectId);
      this.emit({ type: "decision", decision });
      this.emitProjects();
      return decision;
    });
  }

  private normalizeAnswer(d: Decision, req: AnswerReq): { choice: string | null; note: string | null; batch: boolean } {
    const batch = !!req.batch;
    const choice = req.choice?.trim() || (batch ? d.rec : null);
    const note = req.note?.trim() || null;
    if (!choice && !note) throw new ApiError(400, "선택지나 메모가 필요합니다");
    if (choice && !d.options.some((o) => o.k === choice)) throw new ApiError(400, `없는 선택지입니다: ${choice}`);
    return { choice, note, batch };
  }

  /**
   * 기록 없이 답을 검사한다. 이미 답한 카드에 같은 답이면 그 카드를 돌려주고,
   * 아직 열려 있으면 null, 다른 답이면 409.
   */
  checkAnswer(id: string, req: AnswerReq): Decision | null {
    const d = this.requireDecision(id);
    const a = this.normalizeAnswer(d, req);
    if (d.status === "open") {
      if (req.expectedVersion && req.expectedVersion !== d.updatedAt) throw new ApiError(409, "결재가 변경되었습니다. 새로 불러온 뒤 다시 답하세요");
      return null;
    }
    if (d.choice === a.choice && d.note === a.note && d.batch === a.batch) return d;
    throw new ApiError(409, "이미 처리한 결재입니다");
  }

  /** 멱등: changed=false 면 같은 답이 이미 기록되어 있어 아무것도 안 했다. 다른 답이면 409. */
  answerDecision(id: string, req: AnswerReq): { decision: Decision; changed: boolean } {
    return this.transaction(() => {
      const existing = this.checkAnswer(id, req);
      if (existing) return { decision: existing, changed: false };
      const before = this.requireDecision(id);
      const a = this.normalizeAnswer(before, req);
      this.run(
        "UPDATE decisions SET status = 'answered', choice = ?, note = ?, batch = ?, answered_at = ?, updated_at = ?, last_choice = NULL, last_note = NULL, reopen_note = NULL WHERE id = ?",
        a.choice,
        a.note,
        a.batch ? 1 : 0,
        nowIso(),
        this.nextDecisionStamp(id),
        id,
      );
      const decision = this.requireDecision(id);
      this.recorder?.decision(before, decision);
      this.bumpBoard(decision.projectId);
      this.emit({ type: "decision", decision });
      this.emitProjects();
      return { decision, changed: true };
    });
  }

  /** 전달됨·닫힘으로 옮기거나, 전달이 실패하면 answered 로 되돌린다. 닫으면 inbox 에서 빠진다. */
  setDecisionStatus(id: string, status: Extract<DecisionStatus, "answered" | "delivered" | "closed">): Decision {
    return this.transaction(() => {
      const before = this.requireDecision(id);
      const stamp = this.nextDecisionStamp(id);
      if (status === "delivered") {
        this.run("UPDATE decisions SET status = 'delivered', delivered_at = COALESCE(delivered_at, ?), updated_at = ? WHERE id = ?", nowIso(), stamp, id);
      } else if (status === "answered") {
        this.run("UPDATE decisions SET status = 'answered', delivered_at = NULL, updated_at = ? WHERE id = ?", stamp, id);
      } else {
        this.run("UPDATE decisions SET status = 'closed', updated_at = ? WHERE id = ?", stamp, id);
      }
      const decision = this.requireDecision(id);
      this.recorder?.decision(before, decision);
      this.bumpBoard(decision.projectId);
      this.emit({ type: "decision", decision });
      this.emitProjects();
      return decision;
    });
  }

  /**
   * 열린 결재를 이유와 함께 닫는다. kind 가 있으면 AI 가 ask_close 로 닫은 것이라 대표가 다시 열 수 있다.
   * 열려 있지 않으면 409(대표가 이미 답했거나 닫혔다). 닫힌 카드는 결재된 항목으로 간다.
   */
  closeDecision(id: string, input: { kind: DecisionCloseKind | null; reason: string; by: string; quote?: string | null }): Decision {
    return this.transaction(() => {
      const before = this.requireDecision(id);
      if (before.status !== "open") throw new ApiError(409, before.status === "closed" ? "이미 닫힌 결재입니다" : "대표가 이미 답한 결재입니다");
      const at = nowIso();
      this.run(
        "UPDATE decisions SET status = 'closed', close_kind = ?, close_reason = ?, close_quote = ?, closed_by = ?, closed_at = ?, updated_at = ? WHERE id = ? AND status = 'open'",
        input.kind,
        input.reason,
        input.quote ?? null,
        input.by,
        at,
        this.nextDecisionStamp(id),
        id,
      );
      const decision = this.requireDecision(id);
      this.recorder?.decision(before, decision);
      this.bumpBoard(decision.projectId);
      this.emit({ type: "decision", decision });
      this.emitProjects();
      return decision;
    });
  }

  /** 끝내 전달하지 못한 답은 대표가 다시 답할 수 있게 카드를 연다. 메모의 사본은 전달 글뿐이었으니 직전 답을 카드에 남긴다. 닫힌 카드를 다시 열 때도 쓴다(닫은 이유는 지운다). */
  reopenDecision(id: string, why = "전달하지 못했습니다. 다시 결정해 주세요"): Decision {
    return this.transaction(() => {
      const before = this.requireDecision(id);
      this.run(
        "UPDATE decisions SET status = 'open', last_choice = COALESCE(choice, last_choice), last_note = COALESCE(note, last_note), reopen_note = ?, choice = NULL, note = NULL, batch = 0, answered_at = NULL, delivered_at = NULL, close_kind = NULL, close_reason = NULL, close_quote = NULL, closed_by = NULL, closed_at = NULL, updated_at = ? WHERE id = ?",
        why,
        this.nextDecisionStamp(id),
        id,
      );
      const decision = this.requireDecision(id);
      this.recorder?.decision(before, decision);
      this.bumpBoard(decision.projectId);
      this.emit({ type: "decision", decision });
      this.emitProjects();
      return decision;
    });
  }

  /** 답했지만 아직 누구에게도 가지 않은 결재. */
  listAnsweredDecisions(projectId: string): Decision[] {
    return this.rows("SELECT * FROM decisions WHERE project_id = ? AND status = 'answered' ORDER BY answered_at, rowid", projectId).map(toDecision);
  }

  // ---- 내 할 일 ----
  getTodo(id: string): Todo | null {
    const r = this.row("SELECT * FROM todos WHERE id = ?", id);
    return r ? toTodo(r) : null;
  }

  requireTodo(id: string): Todo {
    const t = this.getTodo(id);
    if (!t) throw new ApiError(404, "할 일을 찾을 수 없습니다");
    return t;
  }

  listTodos(projectId: string): Todo[] {
    return this.rows("SELECT * FROM todos WHERE project_id = ? ORDER BY created_at, rowid", projectId).map(toTodo);
  }

  createTodo(input: NewTodo): Todo {
    return this.transaction(() => {
      this.requireProject(input.projectId);
      const id = newId("t_");
      const at = nowIso();
      this.run(
        "INSERT INTO todos (id, project_id, member_id, who, title, detail, created_at, updated_at, task_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        id,
        input.projectId,
        input.memberId ?? null,
        input.who ?? "",
        input.title,
        input.detail ?? "",
        at,
        at,
        this.taskRef(input.projectId, input.taskId),
      );
      const todo = this.requireTodo(id);
      this.bumpBoard(todo.projectId);
      this.emit({ type: "todo", todo });
      this.emitProjects();
      return todo;
    });
  }

  /** 받을 사람이 없어 '했음'을 못 알린 할 일. 총괄이 뜨면 전한다. */
  setTodoNoticePending(id: string, pending: boolean): void {
    this.run("UPDATE todos SET notice_pending = ? WHERE id = ?", pending ? 1 : 0, id);
  }

  listTodoNoticesPending(projectId: string): Todo[] {
    return this.rows("SELECT * FROM todos WHERE project_id = ? AND notice_pending = 1 AND done = 1 ORDER BY done_at, rowid", projectId).map(toTodo);
  }

  /** 대표의 체크. changed=false 면 이미 그 값이었다. 체크를 풀면 AI 가 정리한 이유도 지운다. */
  setTodoDone(id: string, done: boolean): { todo: Todo; changed: boolean } {
    return this.transaction(() => {
      const before = this.requireTodo(id);
      if (before.done === done) return { todo: before, changed: false };
      const at = nowIso();
      this.run(
        "UPDATE todos SET revision = revision + 1, done = ?, done_at = ?, outcome = ?, close_reason = NULL, closed_by = NULL, updated_at = ? WHERE id = ?",
        done ? 1 : 0,
        done ? at : null,
        done ? "done" : null,
        at,
        id,
      );
      const todo = this.requireTodo(id);
      this.bumpBoard(todo.projectId);
      this.emit({ type: "todo", todo });
      this.emitProjects();
      return { todo, changed: true };
    });
  }

  /** AI 의 todo_close. 안 끝난 할 일만. 끝남·필요 없어짐 모두 안 한 할 일 수에서 빠진다. */
  closeTodo(id: string, input: { outcome: TodoOutcome; reason: string; by: string }): Todo {
    return this.transaction(() => {
      const before = this.requireTodo(id);
      if (before.done) throw new ApiError(409, "이미 끝났거나 정리된 할 일입니다");
      const at = nowIso();
      this.run(
        "UPDATE todos SET revision = revision + 1, done = 1, done_at = ?, outcome = ?, close_reason = ?, closed_by = ?, updated_at = ? WHERE id = ? AND done = 0",
        at,
        input.outcome,
        input.reason,
        input.by,
        at,
        id,
      );
      const todo = this.requireTodo(id);
      this.bumpBoard(todo.projectId);
      this.emit({ type: "todo", todo });
      this.emitProjects();
      return todo;
    });
  }

  // ---- 판 정리 ----
  /** 마지막으로 판 정리를 맡긴 시각. 화면도 알게 프로젝트로 방송한다. */
  setBoardTidiedAt(projectId: string, at: string): void {
    this.run("UPDATE projects SET board_tidied_at = ? WHERE id = ?", at, projectId);
    const project = this.getProject(projectId);
    if (project) this.emit({ type: "project", project });
  }

  /** 결재·할 일·진행판·대화에서 가장 늦게 바뀐 시각. 아무것도 없으면 null. */
  lastBoardChangeAt(projectId: string): string | null {
    const r = this.row(
      `SELECT MAX(t) AS at FROM (
         SELECT MAX(COALESCE(updated_at, created_at)) AS t FROM decisions WHERE project_id = ?1
         UNION ALL SELECT MAX(COALESCE(updated_at, done_at, created_at)) FROM todos WHERE project_id = ?1
         UNION ALL SELECT MAX(updated_at) FROM work WHERE project_id = ?1
         UNION ALL SELECT MAX(at) FROM messages WHERE project_id = ?1)`,
      projectId,
    );
    return (r?.at as string | null | undefined) ?? null;
  }

  // ---- 진행 판 ----
  getWork(id: string): WorkItem | null {
    const r = this.row("SELECT * FROM work WHERE id = ?", id);
    return r ? toWork(r) : null;
  }

  listWork(projectId: string): WorkItem[] {
    return this.rows("SELECT * FROM work WHERE project_id = ? ORDER BY sort_order, rowid", projectId).map(toWork);
  }

  private emitWork(projectId: string): void {
    this.bumpBoard(projectId);
    this.emit({ type: "work", projectId, work: this.listWork(projectId) });
  }

  /** Project a verified completion or its reopening within the same transaction as the stage mark. */
  syncWorkCompletion(projectId: string, taskId: string, stage: "done" | "reopen", at: string): void {
    const linked = "project_id=? AND COALESCE(task_id,'tk_'||id)=?";
    const write = stage === "done"
      ? this.db.query(`UPDATE work SET auto_done_from=sec, sec='done', done_at=?1, updated_at=?1
          WHERE sec IN ('doing','next') AND ${linked}`)
      : this.db.query(`UPDATE work SET sec=auto_done_from, auto_done_from=NULL, done_at=NULL, updated_at=?1
          WHERE sec='done' AND auto_done_from IS NOT NULL AND ${linked}`);
    if (write.run(at, projectId, taskId).changes) this.emitWork(projectId);
  }

  /** id 가 있으면 고치고(다른 프로젝트 항목이면 거부), 없으면 만든다. */
  upsertWork(input: WorkInput): WorkItem {
    return this.transaction(() => {
      this.requireProject(input.projectId);
      if (input.taskId) {
        const linked = this.getTask(input.taskId);
        if (!linked || linked.projectId !== input.projectId) throw new ApiError(404, `업무를 찾을 수 없습니다: ${input.taskId}`);
      }
      const at = nowIso();
      const doneAt = input.sec === "done" ? at : null;
      if (input.id) {
        const existing = this.getWork(input.id);
        if (!existing || existing.projectId !== input.projectId) throw new ApiError(404, `일 항목을 찾을 수 없습니다: ${input.id}`);
        const taskId = input.taskId === undefined ? existing.taskId ?? null : input.taskId;
        this.run(
          `UPDATE work SET auto_done_from=CASE WHEN sec=? AND task_id IS ? THEN auto_done_from END,
            sec=?, title=?, detail=?, who=?, done_at=?, updated_at=?, task_id=? WHERE id=?`,
          input.sec,
          taskId,
          input.sec,
          input.title,
          input.detail ?? existing.detail,
          input.who ?? existing.who,
          input.sec === "done" ? (existing.doneAt ?? at) : null,
          at,
          taskId,
          input.id,
        );
        const item = this.getWork(input.id)!;
        this.syncWorkTask(item);
        this.emitWork(input.projectId);
        return item;
      }
      const id = newId("w_");
      const order = this.row("SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM work WHERE project_id = ?", input.projectId)!.n as number;
      this.run(
        "INSERT INTO work (id, project_id, sec, title, detail, who, sort_order, done_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        id,
        input.projectId,
        input.sec,
        input.title,
        input.detail ?? "",
        input.who ?? "",
        order,
        doneAt,
        at,
        at,
      );
      if (input.taskId) this.run("UPDATE work SET task_id = ? WHERE id = ?", input.taskId, id);
      const item = this.getWork(id)!;
      this.syncWorkTask(item);
      this.emitWork(input.projectId);
      return item;
    });
  }

  removeWork(id: string): void {
    return this.transaction(() => {
      const item = this.getWork(id);
      if (!item) return;
      this.run("DELETE FROM work WHERE id = ?", id);
      this.emitWork(item.projectId);
    });
  }

  // ---- 작업 ----
  /**
   * 진행판 일 항목의 대화 작업. 총괄이 일 항목을 만들면 대화의 작업 칩이 바로 생기고, 제목·담당을 고치면 따라 바뀐다.
   * id 는 일 항목에서 정해진다(tk_<일 항목 id>). 등록한 직원은 없다(member_id NULL): 대표가 이 칩에서 보낸 글은 총괄에게 가고,
   * 직원이 task 도구로 등록한 작업처럼 그 직원에게 task_id 를 강제하지 않는다. 완료·삭제된 항목의 칩은 화면이 숨긴다(글은 남는다).
   */
  static workTaskId(workId: string): string {
    return `tk_${workId}`;
  }

  private syncWorkTask(item: WorkItem): void {
    // 기존 업무를 가리키는 항목은 새 업무를 만들지 않는다(같은 일이 두 업무로 갈라지지 않게).
    if (item.taskId) return;
    const id = Store.workTaskId(item.id);
    const existing = this.getTask(id);
    const title = item.title.trim();
    if (!title) return;
    if (!existing) {
      if (item.sec === "done") return;
      const at = nowIso();
      this.run("INSERT INTO tasks (id, project_id, member_id, who, title, branch, worktree, created_at, updated_at, origin) VALUES (?, ?, NULL, ?, ?, NULL, NULL, ?, ?, 'board')",
        id, item.projectId, item.who, title, at, at);
      this.emit({ type: "task", task: this.requireTask(id) });
      return;
    }
    if (existing.title === title && existing.who === item.who) return;
    this.run("UPDATE tasks SET title = ?, who = ?, updated_at = ? WHERE id = ?", title, item.who, nowIso(), id);
    this.emit({ type: "task", task: this.requireTask(id) });
  }

  /** 이 기능 전에 만든 진행 중·예정·보류 일 항목에도 작업 칩을 만든다(완료 항목은 만들지 않는다). 시작할 때 한 번. */
  private backfillWorkTasks(): void {
    const rows = this.rows("SELECT * FROM work WHERE sec != 'done' AND id NOT IN (SELECT substr(id, 4) FROM tasks WHERE id LIKE 'tk_w_%')");
    if (!rows.length) return;
    this.transaction(() => { for (const r of rows) this.syncWorkTask(toWork(r)); });
  }

  getTask(id: string): Task | null {
    const r = this.row(`SELECT tasks.*, ${TASK_LAST_MESSAGE} FROM tasks WHERE id = ?`, id);
    return r ? toTask(r) : null;
  }

  requireTask(id: string): Task {
    const t = this.getTask(id);
    if (!t) throw new ApiError(404, `작업을 찾을 수 없습니다: ${id}`);
    return t;
  }

  /** 최근 등록한 작업부터. 업무 단계(progress)를 함께 싣는다(화면용). 단계가 필요 없으면 hasTasks 를 쓴다. */
  listTasks(projectId: string, suppliedFacts?: Map<string, ProgressFacts>): Task[] {
    const tasks = this.rows(`SELECT tasks.*, ${TASK_LAST_MESSAGE} FROM tasks WHERE project_id = ? ORDER BY created_at DESC, rowid DESC`, projectId).map(toTask);
    if (!tasks.length) return tasks;
    const facts = suppliedFacts ?? this.taskProgressFacts(projectId);
    return tasks.map((t) => (t.mergedInto ? t : { ...t, progress: deriveProgress(facts.get(t.id) ?? emptyFacts()) }));
  }

  hasTasks(projectId: string): boolean {
    return !!this.row("SELECT 1 FROM tasks WHERE project_id = ? LIMIT 1", projectId);
  }

  /** A hold/owner stop fences its descendants, not unrelated assignments. */
  private taskSequenceGates(projectId: string, facts = this.taskProgressFacts(projectId)) {
    const tasks = this.rows("SELECT id,title,parent_task_id FROM tasks WHERE project_id=? AND merged_into IS NULL", projectId);
    const byId = new Map(tasks.map(t => [t.id as string, t]));
    const paused = new Set(this.taskContinuationPauses(projectId).map(p => p.taskId));
    const held = new Set([...facts].filter(([, f]) => deriveProgress(f).stage === "hold").map(([id]) => id));
    const suspended = new Map<string, { taskId: string; title: string }>();
    const awaitingOwner = new Map<string, { taskId: string; title: string; terminal: boolean }>();
    for (const task of tasks) {
      if (paused.has(task.id)) suspended.set(task.id, { taskId: task.id, title: task.title });
      const seen = new Set<string>(); let current: Row | undefined = task;
      while (current && !seen.has(current.id)) {
        seen.add(current.id);
        const scope = { taskId: current.id as string, title: current.title as string };
        const fact = facts.get(current.id);
        if (fact && (fact.decisions.length || fact.todos.length || fact.approvals.length) && !awaitingOwner.has(task.id)) {
          awaitingOwner.set(task.id, { ...scope, terminal: !fact.decisions.length && !fact.todos.length });
        }
        if (held.has(current.id) && !suspended.has(task.id)) suspended.set(task.id, scope);
        current = byId.get(current.parent_task_id);
      }
    }
    return { suspended, awaitingOwner };
  }

  /** Actual recipients and queue classes, one aggregate query regardless of task count. */
  private workflowAssignments(projectId: string, memberId?: string, facts = this.taskProgressFacts(projectId), gates = this.taskSequenceGates(projectId, facts)): WorkflowAssignment[] {
    const { suspended, awaitingOwner } = gates;
    const running = new Set<string>();
    for (const run of this.rows(`SELECT e.member_id,e.delivery_ids_json FROM execution_journal e JOIN members m ON m.id=e.member_id
      WHERE e.project_id=? AND e.generation=m.session_generation AND e.ended_at IS NULL
      AND e.phase NOT IN ('ended','interrupted')`, projectId)) {
      for (const taskId of taskScopeForDeliveryIds(this, JSON.parse(run.delivery_ids_json))) running.add(`${run.member_id}:${taskId}`);
    }
    const work = "d.kind IN ('instruction','user_message') AND d.wake = 1";
    const continuation = "d.kind = 'system' AND d.wake = 1 AND c.delivery_id IS NOT NULL AND (c.retired_reason IS NULL OR d.status = 'delivered')";
    const assignment = `(${work} OR (${continuation}))`;
    const retryableResolved = "COALESCE(r.reason,'') = 'not_received' AND COALESCE((SELECT x.transport_state FROM delivery_dispatches x JOIN delivery_dispatch_items i ON i.dispatch_id = x.id WHERE i.delivery_id = d.id ORDER BY x.created_at DESC, x.rowid DESC LIMIT 1),'') = 'rejected'";
    const protectedHistory = `(COALESCE(r.phase,'none') = 'stopped' OR (COALESCE(r.phase,'none') = 'resolved' AND NOT (${retryableResolved})))`;
    const protectedInput = `(COALESCE(r.phase,'none') IN ('needs_owner','checking','waiting') OR ${protectedHistory})`;
    return this.rows(`SELECT d.task_id, d.member_id, MIN(CASE WHEN ${assignment} THEN d.rowid END) AS first_order,
      MIN(CASE WHEN ${assignment} THEN d.created_at END) AS assigned_at,
      MAX(CASE WHEN ${continuation} THEN 1 ELSE 0 END) AS continuation,
      MAX(CASE WHEN ${work} THEN d.created_at END) AS last_input_at,
      SUM(CASE WHEN d.wake=1 AND d.status IN ('queued','held','delivering') THEN 1 ELSE 0 END) AS pending_work,
      MAX(CASE WHEN ${work} AND q.task_id IS NOT NULL AND (d.status = 'delivered' OR NOT ${protectedHistory}) THEN 1 ELSE 0 END) AS eligible,
      MAX(CASE WHEN q.task_id IS NOT NULL THEN 1 ELSE 0 END) AS enrolled,
      SUM(CASE WHEN d.status = 'queued' AND d.wake = 1 AND NOT (${protectedInput}) THEN 1 ELSE 0 END) AS queued,
      SUM(CASE WHEN d.status = 'held' AND d.wake = 1 THEN 1 ELSE 0 END) AS held,
      SUM(CASE WHEN d.status IN ('queued','held') AND d.wake = 0 THEN 1 ELSE 0 END) AS notices,
      SUM(CASE WHEN (d.status IN ('queued','held','delivering') OR (d.status = 'failed' AND r.phase = 'stopped')) AND d.wake = 1 AND ${protectedInput} THEN 1 ELSE 0 END) AS protected,
      json_group_array(json_object('deliveryId', d.id, 'phase', COALESCE(r.phase,'none'), 'reason', r.reason,
        'holdReason', d.hold_reason, 'retryReason', d.retry_reason, 'lastCheckedAt', r.last_checked_at, 'nextCheckAt', r.next_check_at))
        FILTER (WHERE (d.status IN ('queued','held','delivering') OR (d.status = 'failed' AND r.phase = 'stopped')) AND d.wake = 1 AND (${protectedInput} OR d.status = 'held')) AS input_blocks_json,
      EXISTS(SELECT 1 FROM workflow_assignment_receipts w
        WHERE w.project_id = d.project_id AND w.member_id = d.member_id AND w.task_id = d.task_id) AS reviewed_order,
      MIN(CASE WHEN d.status = 'queued' THEN d.next_attempt_at END) AS retry_at
      FROM deliveries d LEFT JOIN delivery_recovery r ON r.delivery_id = d.id
      LEFT JOIN task_sequence q ON q.member_id = d.member_id AND q.task_id = d.task_id
      LEFT JOIN task_continuation_deliveries c ON c.delivery_id = d.id AND c.task_id = d.task_id
      WHERE d.project_id = ? AND d.task_id IS NOT NULL ${memberId ? "AND d.member_id = ?" : ""}
      GROUP BY d.task_id, d.member_id HAVING first_order IS NOT NULL ORDER BY first_order`, projectId, ...(memberId ? [memberId] : [])).map(r => {
      const f = facts.get(r.task_id), stage = f ? deriveProgress(f).stage : "new";
      const report = f?.reports.findLast(report => report.memberId === r.member_id && ["진행", "완료", "막힘"].includes(report.kind));
      // A current, checked delivery releases this worker's slot, not the task's
      // completion obligation. New input, failed review and an active run retain it.
      const delivered = report?.kind === "완료" && report.passed && report.checks > 0 && !report.failed.length && !report.notRun.length &&
        report.at > (r.last_input_at ?? "") && !r.pending_work && !running.has(`${r.member_id}:${r.task_id}`) &&
        ["delivered", "review", "merge", "merged", "applied"].includes(stage);
      return ({
        taskId: r.task_id, memberId: r.member_id, order: r.first_order, assignedAt: r.assigned_at, eligible: !!r.eligible, enrolled: !!r.enrolled,
        queued: Number(r.queued), held: Number(r.held), notices: Number(r.notices), protected: Number(r.protected), retryAt: r.retry_at ?? null,
        inputBlocks: JSON.parse(r.input_blocks_json ?? "[]"), continuation: !!r.continuation,
        blocksSequence: !suspended.has(r.task_id) && !delivered,
        reviewedOrder: !!r.reviewed_order, suspendedBy: suspended.get(r.task_id) ?? null,
        awaitingOwner: awaitingOwner.get(r.task_id) ?? null,
      }); });
  }

  /** Only actionable work inputs block final completion; quiet reports to the coordinator do not. */
  hasUnsettledTaskInput(taskId: string): boolean {
    return !!this.row("SELECT 1 FROM deliveries WHERE task_id = ? AND wake = 1 AND kind IN ('instruction','user_message','answer','todo_done') AND status IN ('queued','held','delivering') LIMIT 1", taskId);
  }

  /** Current derived continuations share the ancestor's final completion obligation. */
  taskCompletionScope(taskId: string): string[] {
    return this.rows(`WITH RECURSIVE family(id) AS (
      SELECT id FROM tasks WHERE id = ? UNION SELECT t.id FROM tasks t JOIN family f ON t.parent_task_id = f.id WHERE t.merged_into IS NULL
    ) SELECT f.id FROM family f WHERE f.id = ? OR (
      EXISTS(SELECT 1 FROM task_sequence q WHERE q.task_id = f.id)
      AND NOT EXISTS(SELECT 1 FROM task_stage_marks d WHERE d.task_id = f.id AND d.stage = 'done'
        AND d.id > COALESCE((SELECT MAX(r.id) FROM task_stage_marks r WHERE r.task_id = f.id AND r.stage = 'reopen'),0))
    )`, taskId, taskId).map(r => r.id as string);
  }

  /** Read once per synchronous admission/context batch. Never retain across writes. */
  taskSequenceSnapshot(projectId: string, memberId?: string, facts = this.taskProgressFacts(projectId)) {
    const tasks = this.rows(`SELECT t.id,t.title,t.parent_task_id,t.merged_into FROM tasks t WHERE t.project_id=?`, projectId);
    const byId = new Map(tasks.map(t => [t.id as string, { title: t.title as string, done: deriveProgress(facts.get(t.id) ?? emptyFacts()).stage === "done",
      merged_into: t.merged_into as string | null, parentTaskId: t.parent_task_id as string | null }]));
    const gates = this.taskSequenceGates(projectId, facts);
    return { projectId, memberId, byId, ...gates, assignments: this.workflowAssignments(projectId, memberId, facts, gates) };
  }

  /** A reviewed workflow placement and related continuations retain their order. */
  taskSequenceBlocker(memberId: string, taskId: string | null, snapshot?: ReturnType<Store["taskSequenceSnapshot"]>,
    { prospective = false, checkOwner = true }: { prospective?: boolean; checkOwner?: boolean } = {}): { taskId: string; title: string } | null {
    if (!taskId) return null;
    const m = this.requireMember(memberId);
    if (m.kind !== "worker") return null;
    const state = snapshot && snapshot.projectId === m.projectId && (!snapshot.memberId || snapshot.memberId === memberId)
      ? snapshot : this.taskSequenceSnapshot(m.projectId, memberId);
    const suspended = state.suspended.get(taskId); if (suspended) return suspended;
    if (checkOwner && state.awaitingOwner.has(taskId)) return state.awaitingOwner.get(taskId)!;
    const byId = state.byId;
    const row = orderAssignments(state.assignments.filter(a => a.memberId === memberId), byId);
    if (!prospective && row.some(a => a.taskId === taskId && a.eligible && a.blocksSequence === false)) return null;
    const open = row.filter(a => a.eligible && (a.blocksSequence !== false || prospective && a.taskId === taskId) && byId.has(a.taskId) && !byId.get(a.taskId)!.done && !byId.get(a.taskId)!.merged_into);
    const target = row.find(a => a.taskId === taskId);
    const blocker = assignmentPredecessor(taskId, open, byId, prospective || !!target?.reviewedOrder);
    return blocker ? { taskId: blocker.taskId, title: byId.get(blocker.taskId)!.title } : null;
  }

  /** Executable predecessors only: projection-only reports cannot authorize an order exception. */
  taskSequencePredecessors(memberId: string, taskId: string): string[] {
    const member = this.requireMember(memberId);
    if (this.requireTask(taskId).projectId !== member.projectId) throw new ApiError(404, "이 프로젝트의 업무만 확인할 수 있습니다");
    const tasks = this.listTasks(member.projectId), byId = new Map(tasks.map(t => [t.id, t]));
    const open = orderAssignments(this.workflowAssignments(member.projectId, memberId), byId)
      .filter(a => a.eligible && a.blocksSequence !== false && byId.has(a.taskId) && byId.get(a.taskId)!.progress?.stage !== "done" && !byId.get(a.taskId)!.mergedInto);
    const index = open.findIndex(a => a.taskId === taskId);
    return index < 0 ? [] : open.slice(0, index).map(a => a.taskId);
  }

  taskContinuationPauses(projectId: string): { taskId: string; reason: string; pausedAt: string | null }[] {
    return activeTaskContinuationPauses(this, projectId);
  }

  projectWorkflow(projectId: string, tasks?: Task[], members = this.listMembers(projectId), facts = this.taskProgressFacts(projectId)): ProjectWorkflow {
    return this.buildProjectWorkflow(projectId, tasks ?? this.listTasks(projectId, facts), members, this.workflowAssignments(projectId, undefined, facts), facts);
  }

  private buildProjectWorkflow(projectId: string, tasks: Task[], members: Member[], assignments: WorkflowAssignment[], ownerFacts?: ReadonlyMap<string, WorkflowOwnerFacts>): ProjectWorkflow {
    const reports = this.rows(`SELECT m.task_id, m.member_id, m.kind, m.title, m.at, latest.participated_at FROM messages m
      JOIN (SELECT MAX(rowid) AS rid, MIN(CASE WHEN kind IN ('진행','막힘','완료') THEN at END) AS participated_at
        FROM messages WHERE project_id = ? AND mine = 0 AND task_id IS NOT NULL GROUP BY task_id, member_id) latest ON m.rowid = latest.rid
      ORDER BY m.rowid`, projectId).map(r => ({ taskId: r.task_id as string, memberId: r.member_id as string | null, kind: r.kind as string, title: r.title as string, at: r.at as string, participatedAt: r.participated_at as string | null }));
    const runningIds = members.filter(m => m.executionState && !m.executionState.endedAt && m.executionState.taskIds?.length).map(m => m.id);
    const activity = runningIds.length ? this.rows(`SELECT a.member_id, a.kind, a.text, a.at FROM activity a
      JOIN (SELECT MAX(a.id) AS id FROM activity a JOIN members m ON m.id = a.member_id
        WHERE m.project_id = ? AND a.member_id IN (${runningIds.map(() => '?').join(',')}) AND a.kind IN ('tool','text','error') GROUP BY a.member_id) latest ON latest.id = a.id`, projectId, ...runningIds)
      .map(r => ({ memberId: r.member_id as string, kind: r.kind as string, title: redactHarnessText(decodeStoredText(r.text)).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").slice(0, 180), at: r.at as string })) : [];
    return buildWorkflow(tasks, members, assignments, reports, Date.now(), activity, this.listWork(projectId), this.taskContinuationPauses(projectId), ownerFacts);
  }

  /** Simulate display order without enrolling anything; admission uses the same worker policy as pump. */
  workflowAssignmentPlacement(taskId: string, memberId: string) {
    const member = this.requireMember(memberId), task = this.requireTask(taskId);
    if (task.projectId !== member.projectId) throw new ApiError(404, "업무와 직원의 프로젝트가 다릅니다");
    const tasks = this.listTasks(task.projectId), byId = new Map(tasks.map(t => [t.id, t]));
    const existing = this.workflowAssignments(task.projectId, memberId);
    const candidate: WorkflowAssignment = { taskId, memberId, order: Math.max(0, ...existing.map(a => a.order)) + 1, assignedAt: task.createdAt,
      eligible: true, enrolled: true, queued: 1, held: 0, notices: 0, protected: 0, retryAt: null };
    const row = this.buildProjectWorkflow(task.projectId, tasks, this.listMembers(task.projectId), [...existing.filter(a => a.taskId !== taskId), candidate]).nodes
      .filter(n => n.memberId === memberId && n.state !== "done");
    return { position: row.findIndex(a => a.taskId === taskId) + 1, suspended: this.taskSequenceGates(task.projectId).suspended.get(taskId) ?? null, blocker: this.taskSequenceBlocker(memberId, taskId, undefined, { prospective: true }),
      continuation: existing.some(a => a.enrolled && a.taskId !== taskId && byId.get(a.taskId)?.progress?.stage !== "done" && relatedWork(a.taskId, taskId, byId)) };
  }

  /** Bounded task evidence, independent of the latest message window. Ancestors stay in-project. */
  workflowAssignmentContext(taskId: string) {
    const task = this.requireTask(taskId), lineage: Task[] = [], seen = new Set<string>();
    let next: Task | null = task;
    while (next && !seen.has(next.id) && seen.size < 32) {
      if (next.projectId !== task.projectId) throw new ApiError(409, "부모 업무의 프로젝트가 다릅니다");
      seen.add(next.id); lineage.push(next);
      next = next.parentTaskId ? this.requireTask(next.parentTaskId) : null;
    }
    if (next) throw new ApiError(409, "부모 업무 연결을 먼저 확인해 주세요");
    const ids = lineage.map(t => t.id), placeholders = ids.map(() => "?").join(",");
    const originals = this.rows(`SELECT * FROM messages WHERE project_id = ? AND task_id IN (${placeholders}) AND mine = 1 ORDER BY at, id LIMIT 101`, task.projectId, ...ids).map(toMessage);
    const recent = this.rows(`SELECT * FROM messages WHERE project_id = ? AND task_id IN (${placeholders}) AND mine = 0 AND kind IN ('진행','완료','막힘','질문','답변') ORDER BY at DESC, id DESC LIMIT 10`, task.projectId, ...ids).map(toMessage);
    // Routine chatter must not displace the latest failed check for each author/task.
    const failed = this.rows(`SELECT * FROM messages WHERE rowid IN (
      SELECT MAX(m.rowid) FROM messages m WHERE m.project_id = ? AND m.task_id IN (${placeholders}) AND m.mine = 0
      AND EXISTS(SELECT 1 FROM report_checks c WHERE c.message_id = m.id AND c.result = 'fail') GROUP BY m.task_id, m.member_id
    ) LIMIT 101`, task.projectId, ...ids).map(toMessage);
    const selected = new Map([...recent, ...failed].map(m => [m.id, m]));
    const pending = [...selected.keys()];
    for (let i = 0; i < pending.length; i++) {
      if (selected.size > 100) throw new ApiError(409, "인계할 실패·정정 근거가 100건을 넘습니다. 업무 범위를 먼저 정리해 주세요");
      const id = pending[i]!, source = this.getReportReferences(task.projectId, id)?.correctsMessageId;
      const related = this.rows(`SELECT m.* FROM messages m WHERE m.project_id = ? AND m.task_id IN (${placeholders}) AND m.mine = 0
        AND (m.id = ? OR m.id IN (SELECT r.source_message_id FROM report_references r WHERE r.project_id = ? AND r.corrects_message_id = ?))`, task.projectId, ...ids, source ?? "", task.projectId, id).map(toMessage);
      for (const message of related) if (!selected.has(message.id)) { selected.set(message.id, message); pending.push(message.id); }
    }
    const references = new Map([...selected.keys()].map(id => [id, this.getReportReferences(task.projectId, id)]));
    const correctedBy = new Map<string, string[]>();
    for (const [id, ref] of references) if (ref?.correctsMessageId) correctedBy.set(ref.correctsMessageId, [...(correctedBy.get(ref.correctsMessageId) ?? []), id]);
    const reports = [...selected.values()].sort((a,b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)).map(m => ({ ...m,
      harness: this.getReportHarness(m.id), correctsMessageId: references.get(m.id)?.correctsMessageId ?? null, correctedBy: correctedBy.get(m.id) ?? [] }));
    const files = this.rows(`SELECT id, task_id, title, summary, body, attachments FROM files WHERE project_id = ? AND task_id IN (${placeholders}) ORDER BY sort_order DESC, rowid DESC LIMIT 30`, task.projectId, ...ids);
    const total = (table: string, condition = "") => Number(this.row(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ? AND task_id IN (${placeholders}) ${condition}`, task.projectId, ...ids)!.n);
    const attachmentIds = new Set(originals.flatMap(m => m.attachments.map(a => a.id)));
    for (const file of files) for (const attachment of json<Attachment[]>(file.attachments) ?? []) attachmentIds.add(attachment.id);
    const attachments = [...attachmentIds].map(id => this.getAttachment(id)).filter((a): a is Attachment => !!a && this.isProjectAttachment(task.projectId, a.id));
    const assigned = !!this.row("SELECT 1 FROM deliveries WHERE task_id = ? AND wake = 1 AND kind IN ('instruction','user_message') LIMIT 1", taskId)
      || !!this.row("SELECT 1 FROM task_sequence WHERE task_id = ? LIMIT 1", taskId);
    return { lineage, originals: originals.slice(0, 100), reports,
      files: files.map(f => ({ id: f.id as string, taskId: f.task_id as string | null, title: f.title as string, summary: f.summary as string, fingerprint: createHash("sha256").update(String(f.body)).digest("hex") })), attachments, assigned,
      omitted: { originals: Math.max(0, total("messages", "AND mine = 1") - 100), reports: Math.max(0, total("messages", "AND mine = 0 AND kind IN ('진행','완료','막힘','질문','답변')") - reports.length), files: Math.max(0, total("files") - files.length) } };
  }

  workflowAssignmentReceipt(operationId: string): { request: WorkflowAssignmentRequest; result: WorkflowAssignmentResult } | null {
    const row = this.row("SELECT * FROM workflow_assignment_receipts WHERE operation_id = ?", operationId);
    return row ? { request: json(row.request_json), result: { operationId: row.operation_id, projectId: row.project_id, taskId: row.task_id, memberId: row.member_id, deliveryId: row.delivery_id, createdAt: row.created_at } } : null;
  }

  /** Read only: an order exception belongs to one existing delivery, never its whole task. */
  workflowAssignmentReceiptForDelivery(deliveryId: string): { request: WorkflowAssignmentRequest; result: WorkflowAssignmentResult } | null {
    const row = this.row("SELECT operation_id FROM workflow_assignment_receipts WHERE delivery_id = ? AND json_extract(request_json, '$.kind') = 'independent_delivery' ORDER BY created_at DESC, rowid DESC LIMIT 1", deliveryId);
    return row ? this.workflowAssignmentReceipt(row.operation_id) : null;
  }

  saveWorkflowAssignmentReceipt(request: WorkflowAssignmentRequest, result: WorkflowAssignmentResult): void {
    this.run("INSERT INTO workflow_assignment_receipts(operation_id, project_id, task_id, member_id, delivery_id, request_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", result.operationId, result.projectId, result.taskId, result.memberId, result.deliveryId, stableJson(request), result.createdAt);
  }

  // ---- 업무 단계 ----
  /** 업무 하나의 단계. 근거에서 다시 계산한다(저장하지 않는다). */
  taskProgress(taskId: string): TaskProgress {
    const task = this.requireTask(taskId);
    return deriveProgress(this.taskProgressFacts(task.projectId, new Set([taskId])).get(taskId) ?? emptyFacts());
  }

  /** 단계를 실은 업무. task 이벤트로 보내 팀 목록·대화·결재함이 같은 값을 쓰게 한다. */
  taskWithProgress(taskId: string): Task {
    const task = this.requireTask(taskId);
    return task.mergedInto ? task : { ...task, progress: this.taskProgress(taskId) };
  }

  /**
   * 같은 업무 id 의 근거를 한 번에 모은다: 보고(검사 결과·지금 계약 판정), 열린 결재·할 일, 보류·대기 전달, 승인 창에 걸린 직원,
   * 총괄 단계 표시, 반복 감시, 완료 알림. only 를 주면 그 업무만 남긴다.
   */
  taskProgressFacts(projectId: string, only?: Set<string>): Map<string, ProgressFacts> {
    const out = new Map<string, ProgressFacts>();
    const of = (taskId: string): ProgressFacts | null => {
      if (only && !only.has(taskId)) return null;
      let f = out.get(taskId);
      if (!f) out.set(taskId, (f = emptyFacts()));
      return f;
    };
    const filter = only ? ` AND task_id IN (${[...only].map(() => "?").join(",")})` : "";
    const ids = only ? [...only] : [];
    const reportRows = this.rows(`SELECT m.id, m.rowid AS seq, m.at, m.kind, m.member_id, m.who, m.task_id, mem.kind AS author_kind,
        CASE WHEN m.kind = '진행' THEN EXISTS(SELECT 1 FROM report_closures rc WHERE rc.member_id = m.member_id
          AND rc.at >= m.at AND rc.ref_id = m.id AND rc.ref_type = 'message' AND rc.kind = 'continuing') ELSE 0 END AS continues_work,
        (SELECT group_concat(c.name, char(31)) FROM report_checks c WHERE c.message_id = m.id AND c.result = 'fail') AS failed,
        (SELECT group_concat(c.name, char(31)) FROM report_checks c WHERE c.message_id = m.id AND c.result = 'not_run') AS not_run,
        CASE WHEN m.kind = '진행' THEN (SELECT group_concat(COALESCE(CAST(c.criterion AS TEXT), c.kind || ':' || c.name), char(31))
          FROM report_checks c WHERE c.message_id = m.id AND c.result = 'pass' AND c.kind <> 'unverified') END AS passing_checks,
        (SELECT COUNT(*) FROM report_checks c WHERE c.message_id = m.id AND NOT (c.kind = 'unverified' AND c.result = 'pass')) AS checks
      FROM messages m LEFT JOIN members mem ON mem.id = m.member_id
      WHERE m.project_id = ? AND m.mine = 0 AND m.task_id IS NOT NULL AND m.kind IN ('완료','막힘','진행','알림','질문')${filter.replaceAll("task_id", "m.task_id")}
      ORDER BY m.rowid`, projectId, ...ids);
    // 지금 계약 판의 통과 완료(서버 판정). 계약이 묶이지 않은 업무는 완료 보고가 곧 작성자 납품이다.
    const passed = new Map<string, Set<string> | null>();
    const parents = new Map<string, string | null>();
    const latestContracts = new Map<string, TaskContract>();
    const boundContracts = new Map<string, TaskContract>();
    const evidenceByContract = new Map<string, Set<string>>();
    let contractsLoaded = false;
    let evidenceLoaded = false;
    const passedFor = (taskId: string): Set<string> | null => {
      if (!passed.has(taskId)) {
        // 단일 업무 이벤트는 무관한 프로젝트 이력까지 읽지 않고 기존의 좁은 계약 조회를 쓴다.
        if (only?.size === 1) {
          const contract = this.getEffectiveContract(taskId);
          passed.set(taskId, bindingContract(contract)
            ? new Set(this.completionEvidence(contract!.taskId, contract!.rev).filter(b => b.eligible).map(b => b.messageId)) : null);
          return passed.get(taskId)!;
        }
        // 완료 이력마다 계약·부모를 다시 읽지 않는다. 이 조회 안에서만 공유하므로 다음 조회는 새 판을 읽는다.
        if (!contractsLoaded) {
          for (const r of this.rows("SELECT id, parent_task_id FROM tasks WHERE project_id = ?", projectId)) parents.set(r.id, r.parent_task_id ?? null);
          for (const r of this.rows(`SELECT c.* FROM task_contracts c JOIN tasks t ON t.id = c.task_id
              WHERE t.project_id = ? ORDER BY c.rev DESC`, projectId)) {
            if (!latestContracts.has(r.task_id)) latestContracts.set(r.task_id, toContract(r));
            if (!boundContracts.has(r.task_id) && (r.author_kind !== "worker" || r.confirmed_at != null)) boundContracts.set(r.task_id, toContract(r));
          }
          contractsLoaded = true;
        }
        // getEffectiveContract와 같은 규칙: 가까운 확정 계약이 제안보다 우선하며, 순환·깊이 한도를 지킨다.
        const seen = new Set<string>();
        let id: string | null = taskId, contract: TaskContract | null = null, pending: TaskContract | null = null;
        while (id && !seen.has(id) && seen.size < 32) {
          seen.add(id);
          contract = boundContracts.get(id) ?? null;
          if (contract) break;
          pending ??= latestContracts.get(id) ?? null;
          id = parents.get(id) ?? null;
        }
        contract ??= pending;
        if (bindingContract(contract)) {
          const key = JSON.stringify([contract!.taskId, contract!.rev]);
          if (!evidenceLoaded) {
            const groups = new Map<string, Row[]>();
            for (const r of this.completionEvidenceRows({ projectId })) {
              const groupKey = JSON.stringify([r.contract_task_id, r.contract_rev]);
              const group = groups.get(groupKey) ?? [];
              group.push(r);
              groups.set(groupKey, group);
            }
            for (const [groupKey, group] of groups) evidenceByContract.set(groupKey,
              new Set(this.classifyCompletionEvidence(group).filter(b => b.eligible).map(b => b.messageId)));
            evidenceLoaded = true;
          }
          passed.set(taskId, evidenceByContract.get(key) ?? new Set());
        } else passed.set(taskId, null);
      }
      return passed.get(taskId)!;
    };
    for (const r of reportRows) {
      const f = of(r.task_id);
      if (!f) continue;
      const split = (v: unknown) => (typeof v === "string" && v ? v.split("\u001f") : []);
      const set = r.kind === "완료" ? passedFor(r.task_id) : null;
      f.reports.push({ id: r.id, seq: r.seq, at: r.at, kind: r.kind, memberId: r.member_id, who: r.who, authorKind: r.author_kind ?? null,
        ...(r.continues_work ? { continuesWork: true, passingChecks: split(r.passing_checks) } : {}),
        failed: split(r.failed), notRun: split(r.not_run), checks: r.checks as number, passed: r.kind === "완료" && (set ? set.has(r.id) : true) } satisfies ReportFact);
    }
    for (const r of this.rows(`SELECT id, title, task_id, created_at FROM decisions WHERE project_id = ? AND status = 'open' AND task_id IS NOT NULL${filter} ORDER BY created_at, rowid`, projectId, ...ids)) of(r.task_id)?.decisions.push({ id: r.id, title: r.title, at: r.created_at });
    for (const r of this.rows(`SELECT id, title, task_id, created_at FROM todos WHERE project_id = ? AND done = 0 AND outcome IS NULL AND task_id IS NOT NULL${filter} ORDER BY created_at, rowid`, projectId, ...ids)) of(r.task_id)?.todos.push({ id: r.id, title: r.title, at: r.created_at });
    for (const r of this.rows(`SELECT task_id, MAX(COALESCE(updated_at, created_at)) AS at FROM decisions WHERE project_id = ? AND task_id IS NOT NULL${filter} GROUP BY task_id
        UNION ALL SELECT task_id, MAX(COALESCE(updated_at, created_at)) FROM todos WHERE project_id = ? AND task_id IS NOT NULL${filter} GROUP BY task_id
        UNION ALL SELECT task_id, MAX(COALESCE(delivered_at, created_at)) FROM deliveries WHERE project_id = ? AND task_id IS NOT NULL${filter} GROUP BY task_id`, projectId, ...ids, projectId, ...ids, projectId, ...ids)) of(r.task_id)?.revTimes.push(r.at);
    for (const r of this.rows(`SELECT d.id, d.task_id, d.status, d.hold_reason, d.created_at, mem.name FROM deliveries d JOIN members mem ON mem.id = d.member_id
        WHERE d.project_id = ? AND d.task_id IS NOT NULL AND d.wake = 1 AND d.status IN ('queued','held')${filter.replaceAll("task_id", "d.task_id")} ORDER BY d.created_at, d.rowid`, projectId, ...ids)) {
      const f = of(r.task_id);
      if (!f) continue;
      if (r.status === "held") f.held.push({ id: r.id, who: r.name, reason: r.hold_reason ?? null, at: r.created_at });
      else f.queued.push({ id: r.id, who: r.name, at: r.created_at });
    }
    // Keep the member change time even after an approval clears: removing a fact must not lower rev.
    const assigned = this.rows(`SELECT DISTINCT d.task_id, m.id, m.name, m.status, m.blocked_reason, m.updated_at
      FROM deliveries d JOIN members m ON m.id = d.member_id
      WHERE d.project_id = ? AND d.task_id IS NOT NULL AND d.kind IN ('instruction','user_message')${filter.replaceAll("task_id", "d.task_id")}`, projectId, ...ids);
    const openByMember = new Map<string, string[]>();
    for (const m of assigned) {
      of(m.task_id)?.revTimes.push(m.updated_at);
      if (m.status !== "blocked" || !["permission", "selection", "setup"].includes(m.blocked_reason)) continue;
      if (!openByMember.has(m.id)) {
        const execution = this.requireMember(m.id).executionState;
        openByMember.set(m.id, execution && !execution.endedAt ? execution.taskIds ?? [] : this.openAssignedTasks(m.id));
      }
      if (openByMember.get(m.id)!.includes(m.task_id)) of(m.task_id)?.approvals.push({ who: m.name, at: m.updated_at });
    }
    for (const r of this.rows(`SELECT * FROM task_stage_marks WHERE project_id = ?${filter} ORDER BY id`, projectId, ...ids)) of(r.task_id)?.marks.push(toMark(r));
    for (const r of this.rows(`SELECT * FROM task_watch WHERE project_id = ?${filter}`, projectId, ...ids)) { const f = of(r.task_id); if (f) f.watch = toWatch(r); }
    for (const r of this.rows(`SELECT * FROM task_notices WHERE project_id = ?${filter} ORDER BY created_at, rowid`, projectId, ...ids)) {
      const f = of(r.task_id);
      if (f) f.notice = { id: r.id, at: r.created_at, seenAt: r.seen_at ?? null, lines: json<string[]>(r.lines_json) };
    }
    for (const r of this.rows(`SELECT r.* FROM task_completion_reviews r JOIN tasks t ON t.id=r.task_id
        WHERE t.project_id=?${filter.replaceAll("task_id", "r.task_id")} ORDER BY r.rowid`, projectId, ...ids)) {
      const f = of(r.task_id);
      if (f) f.finalReview = { status: r.status, reportId: r.report_id, contractRev: r.contract_rev, at: r.reviewed_at ?? r.completed_at };
    }
    return out;
  }

  /** 보고 한 건의 단계 근거(검사 결과·지금 계약 판정). 반복 감시가 쓴다. */
  reportFact(messageId: string): ReportFact | null {
    const m = this.getMessage(messageId);
    if (!m?.taskId) return null;
    return this.taskProgressFacts(m.projectId, new Set([m.taskId])).get(m.taskId)?.reports.find((r) => r.id === messageId) ?? null;
  }

  listStageMarks(taskId: string): MarkFact[] {
    return this.rows("SELECT * FROM task_stage_marks WHERE task_id = ? ORDER BY id", taskId).map(toMark);
  }

  /** 단계 표시를 남긴다(지우지 않는다). 업무 단계 알림을 보낸다. */
  addStageMark(input: { projectId: string; taskId: string; stage: MarkFact["stage"]; evidence: string; memberId: string | null; who: string }): MarkFact {
    return this.transaction(() => {
      const at = nowIso();
      const row = this.row("INSERT INTO task_stage_marks (project_id, task_id, stage, evidence, member_id, who, at, source_seq) VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(scope_seq),0) FROM deliveries)) RETURNING *",
        input.projectId, input.taskId, input.stage, input.evidence, input.memberId, input.who, at)!;
      if (input.stage === "reopen") this.syncWorkCompletion(input.projectId, input.taskId, "reopen", at);
      this.queueProgress([input.taskId]);
      return toMark(row);
    });
  }

  /** 지금 완료 표시(다시 열기 뒤의 마지막 완료). 없으면 null. */
  doneMark(taskId: string): MarkFact | null {
    return isDone(this.listStageMarks(taskId));
  }

  getTaskWatch(taskId: string): WatchFact | null {
    const r = this.row("SELECT * FROM task_watch WHERE task_id = ?", taskId);
    return r ? toWatch(r) : null;
  }

  /** 반복 감시를 저장한다(null 이면 끝난 반복이라 지운다). 시작 시각과 기록은 DB 에 남아 재시작에도 이어진다. */
  saveTaskWatch(projectId: string, taskId: string, w: WatchFact | null): void {
    this.transaction(() => {
      if (!w) this.run("DELETE FROM task_watch WHERE task_id = ?", taskId);
      else this.run(`INSERT INTO task_watch (task_id, project_id, started_at, attempts, same_count, fingerprint, last_progress_at, tripped_at, trip_reason, history_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET started_at = excluded.started_at, attempts = excluded.attempts, same_count = excluded.same_count, fingerprint = excluded.fingerprint,
          last_progress_at = excluded.last_progress_at, tripped_at = excluded.tripped_at, trip_reason = excluded.trip_reason, history_json = excluded.history_json, updated_at = excluded.updated_at`,
        taskId, projectId, w.startedAt, w.attempts, w.same, w.fingerprint, w.lastProgressAt, w.trippedAt, w.reason, JSON.stringify(w.history), w.updatedAt);
      this.queueProgress([taskId]);
    });
  }

  /** 멈춤 알림을 한 번만 보낸다: 이미 보낸 감시면 false. */
  claimWatchNotice(taskId: string, deliveryId: string): boolean {
    return this.db.query("UPDATE task_watch SET notice_delivery_id = ? WHERE task_id = ? AND notice_delivery_id IS NULL").run(deliveryId, taskId).changes === 1;
  }

  /** 다시 연 감시는 다음 멈춤에서 다시 한 번 알린다. */
  resetWatchNotice(taskId: string): void {
    this.run("UPDATE task_watch SET notice_delivery_id = NULL WHERE task_id = ?", taskId);
  }

  watchNoticeSent(taskId: string): boolean {
    return !!this.row("SELECT notice_delivery_id FROM task_watch WHERE task_id = ? AND notice_delivery_id IS NOT NULL", taskId);
  }

  /** A leader cannot clear an owner escalation by merely closing or reopening
   * the task. A scoped owner answer or verified decided-close is required. */
  pendingTaskFailureDecision(taskId: string): Decision | null {
    const escalations = this.rows(`SELECT e.task_id,e.decision_id,t.project_id FROM task_failure_escalations e
      JOIN tasks t ON t.id=e.task_id JOIN decisions d ON d.id=e.decision_id
      WHERE t.project_id=(SELECT project_id FROM tasks WHERE id=?) AND d.status NOT IN ('answered','delivered')
      ORDER BY e.created_at,e.rowid`, taskId);
    // The ordinary no-escalation path must not scan tasks or message history on
    // every admission check. Only the few unresolved cards need family checks.
    if (!escalations.length) return null;
    const tasks = new Map(this.listTasks(escalations[0]!.project_id).map(t => [t.id, t]));
    // A parent instruction includes its failed descendant's scope. Walking only
    // upwards would allow the same work to restart under its parent id.
    for (const row of escalations) {
      if (!relatedWork(taskId, row.task_id, tasks)) continue;
      const decision = this.getDecision(row.decision_id);
      if (decision && !["answered", "delivered"].includes(decision.status)
        && !(decision.status === "closed" && decision.closeKind === "decided" && decision.closeQuote
          && this.taskFailureQuoteSource(decision.id, decision.closeQuote))) return decision;
    }
    return null;
  }

  /** A stopped failure episode blocks its execution scope until the conductor
   * records a changed approach. Previously resolved owner approvals retain their
   * established retry path, whose first new delivery starts the next episode. */
  pendingTaskIntervention(taskId: string): { taskId: string; reason: string } | null {
    const rows = this.rows(`SELECT w.task_id,w.trip_reason,w.tripped_at,w.project_id,e.decision_id,e.tripped_at AS owner_trip
      FROM task_watch w LEFT JOIN task_failure_escalations e ON e.task_id=w.task_id
      WHERE w.tripped_at IS NOT NULL AND w.project_id=(SELECT project_id FROM tasks WHERE id=?)`, taskId);
    if (!rows.length) return null;
    const tasks = new Map(this.listTasks(rows[0]!.project_id).map(task => [task.id, task]));
    for (const row of rows) {
      if (!relatedWork(taskId, row.task_id, tasks) || this.doneMark(row.task_id)) continue;
      if (row.decision_id && row.owner_trip === row.tripped_at && !this.pendingTaskFailureDecision(row.task_id)) continue;
      return { taskId: row.task_id, reason: row.trip_reason ?? "진척 없는 반복" };
    }
    return null;
  }

  isTaskFailureDecision(decisionId: string): boolean {
    return !!this.row("SELECT 1 FROM task_failure_escalations WHERE decision_id=?", decisionId);
  }

  /** Revalidate the actual owner source, including after restart or a legacy
   * decided-close. A project-wide or pre-failure quote cannot authorize retry. */
  taskFailureQuoteSource(decisionId: string, rawQuote: string): Message | null {
    const escalation = this.row(`SELECT e.*,m.rowid AS trigger_seq FROM task_failure_escalations e
      LEFT JOIN messages m ON m.id=e.trigger_message_id WHERE e.decision_id=?`, decisionId);
    if (!escalation) return null;
    const task = this.getTask(escalation.task_id);
    if (!task) return null;
    const normalize = (value: string) => cleanText(value).replace(/\s+/g, " ").trim();
    const quote = normalize(rawQuote).replace(/^["'“”‘’](.*)["'“”‘’]$/, "$1").trim();
    if (quote.length < 4) return null;
    const tasks = new Map(this.listTasks(task.projectId).map(t => [t.id, t]));
    const relatedIds = [...tasks.keys()].filter(id => relatedWork(id, task.id, tasks));
    const boundary = /[\s.,!?;:…·"'“”‘’()[\]{}<>~\-—–/]/;
    const afterTrigger = escalation.trigger_seq != null ? "rowid > ? AND at >= ?" : "at > ?";
    const bounds = escalation.trigger_seq != null ? [escalation.trigger_seq, escalation.tripped_at] : [escalation.tripped_at];
    for (const row of this.rows(`SELECT * FROM messages WHERE project_id=? AND mine=1 AND task_id IN (${relatedIds.map(() => "?").join(",")})
        AND ${afterTrigger} ORDER BY rowid DESC`, task.projectId, ...relatedIds, ...bounds)) {
      const message = toMessage(row), text = normalize(message.body);
      for (let at = text.indexOf(quote); at >= 0; at = text.indexOf(quote, at + 1)) {
        if (boundary.test(at ? text[at - 1]! : " ") && boundary.test(text[at + quote.length] ?? " ")) return message;
      }
    }
    return null;
  }

  /** A reply permits retry, but only a newly delivered instruction followed by
   * a new report starts the next episode. Keep that proof durable on restart. */
  taskFailureRetryAt(taskId: string, trippedAt: string, report: Pick<ReportFact, "memberId" | "at">): string | null {
    if (!report.memberId) return null;
    const row = this.row("SELECT decision_id FROM task_failure_escalations WHERE task_id=? AND tripped_at=?", taskId, trippedAt);
    const decision = row ? this.getDecision(row.decision_id) : null;
    if (!decision) return null;
    const resolvedAt = ["answered", "delivered"].includes(decision.status) ? decision.answeredAt
      : decision.status === "closed" && decision.closeKind === "decided" && decision.closeQuote
        && this.taskFailureQuoteSource(decision.id, decision.closeQuote) ? decision.closedAt : null;
    if (!resolvedAt || report.at < resolvedAt || this.pendingTaskFailureDecision(taskId)) return null;
    const inputs = this.rows(`SELECT DISTINCT task_id FROM deliveries WHERE member_id=? AND status='delivered'
      AND kind IN ('instruction','user_message') AND task_id IS NOT NULL AND delivered_at>=? AND delivered_at<=?`,
      report.memberId, resolvedAt, report.at);
    if (!inputs.length) return null;
    const tasks = new Map(this.listTasks(decision.projectId).map(t => [t.id, t]));
    return inputs.some(input => relatedWork(input.task_id, taskId, tasks)) ? resolvedAt : null;
  }

  /** Legacy owner approvals retain their gate. New failures are conductor work. */
  ensureTaskFailureDecision(taskId: string): Decision | null {
    return this.pendingTaskFailureDecision(taskId);
  }

  /** One actionable conductor notice per watch episode, including after restart.
   * An unavailable conductor leaves the watch intact for the next scan. */
  ensureTaskFailureNotice(taskId: string): Delivery | null {
    return this.transaction(() => {
      const task = this.requireTask(taskId), watch = this.getTaskWatch(taskId);
      const conductor = this.getConductor(task.projectId);
      if (!watch?.trippedAt || this.doneMark(taskId) || !conductor || this.watchNoticeSent(taskId)) return null;
      const contract = this.getEffectiveContract(taskId);
      const failed = [...new Set(watch.history.flatMap(h => h.failed))];
      const pending = watch.fingerprint.startsWith("pending:") ? watch.fingerprint.slice(8).split("|").filter(Boolean) : [];
      const remaining = [...(contract?.acceptance ?? []), ...failed, ...pending];
      const owner = this.pendingTaskFailureDecision(taskId);
      const delivery = this.enqueue({ projectId: task.projectId, memberId: conductor.id, kind: "system", wake: true, taskId,
        text: `[시스템] ${watchNotice(task, watch, watch.reason ?? "진척 없는 반복", remaining)}\n${describeTaskContext(this, task)}\n${owner ? `기존 대표 결재 #${owner.id}는 계속 대기합니다. 대표 답 전에는 해당 범위를 다시 열거나 배정하지 마세요.` : "현재 승인 범위에서 원인을 확인하고 바꾼 접근을 기록한 뒤 다시 열어 직원에게 맡기세요. 새로운 권한·범위 결정이 실제로 필요할 때만 ask로 대표에게 요청하세요."}` });
      this.claimWatchNotice(taskId, delivery.id);
      return delivery;
    });
  }

  /** 완료 알림을 완료 표시 하나에 하나 만든다. 이미 있으면 그것을 돌려준다(재시도·두 화면·재시작에도 하나). */
  createTaskNotice(projectId: string, taskId: string, markId: number, lines: string[]): { id: string; created: boolean } {
    return this.transaction(() => {
      const existing = this.row("SELECT id FROM task_notices WHERE mark_id = ?", markId);
      if (existing) return { id: existing.id as string, created: false };
      const id = newId("tn_");
      this.run("INSERT INTO task_notices (id, project_id, task_id, mark_id, lines_json, created_at) VALUES (?, ?, ?, ?, ?, ?)", id, projectId, taskId, markId, JSON.stringify(lines), nowIso());
      this.queueProgress([taskId]);
      return { id, created: true };
    });
  }

  /** 대표가 완료 알림을 확인했다. 두 화면에서 눌러도 한 번이다. */
  seeTaskNotice(projectId: string, noticeId: string): Task {
    return this.transaction(() => {
      const r = this.row("SELECT * FROM task_notices WHERE id = ? AND project_id = ?", noticeId, projectId);
      if (!r) throw new ApiError(404, "완료 알림을 찾을 수 없습니다");
      this.run("UPDATE task_notices SET seen_at = COALESCE(seen_at, ?) WHERE id = ?", nowIso(), noticeId);
      this.queueProgress([r.task_id]);
      return this.taskWithProgress(r.task_id);
    });
  }

  private progressDirty = new Set<string>();
  private blockedSeen = new Map<string, string>();
  /** 커밋 뒤 한 번 다시 계산해 task 이벤트로 보낸다(같은 커밋 안의 여러 변화는 한 번). */
  queueProgress(taskIds: (string | null | undefined)[]): void {
    const ids = taskIds.filter((id): id is string => !!id);
    if (!ids.length) return;
    for (const id of ids) this.progressDirty.add(id);
    // 부를 때마다 커밋 뒤 비우기를 건다. 먼저 돈 것이 모두 비우고 뒤의 것은 할 일이 없다. 되돌린 거래가 남긴 id 도 다음 비우기에서 다시 계산할 뿐이다.
    this.afterCommit(() => {
      const ids = [...this.progressDirty];
      this.progressDirty.clear();
      for (const id of ids) {
        try {
          const task = this.getTask(id);
          if (task && !task.mergedInto) this.bus.emit({ type: "task", task: { ...task, progress: this.taskProgress(id) } });
        } catch (error) { console.error("업무 단계 계산 오류:", error); }
      }
    });
  }

  /** 단계 근거가 바뀌는 이벤트에서 다시 계산할 업무. 직원은 승인 창·보류 수가 바뀔 때만 그 직원의 업무를 다시 본다. */
  private progressTargets(event: WsEvent): string[] {
    switch (event.type) {
      case "message": return event.message.mine ? [] : [event.message.taskId ?? null].filter((x): x is string => !!x);
      case "decision": return event.decision.taskId ? [event.decision.taskId] : [];
      case "todo": return event.todo.taskId ? [event.todo.taskId] : [];
      case "member": {
        const m = event.member;
        const key = `${m.status === "blocked"}:${m.heldCount ?? 0}:${m.queuedCount}`;
        if (this.blockedSeen.get(m.id) === key) return [];
        const first = !this.blockedSeen.has(m.id);
        this.blockedSeen.set(m.id, key);
        if (first && m.status !== "blocked" && !m.heldCount) return [];
        const held = this.rows("SELECT DISTINCT task_id FROM deliveries WHERE member_id = ? AND task_id IS NOT NULL AND status IN ('queued','held')", m.id).map((r) => r.task_id as string);
        return [...new Set([...this.openAssignedTasks(m.id), ...held])];
      }
      default: return [];
    }
  }

  /** 개발 기억 업로드 대기열에 넣는다. 같은 event_id 는 처음 것을 그대로 둔다(같은 사건을 두 번 만들지 않는다). */
  enqueueMemoryUpload(input: { eventId: string; projectId: string; refType: string; refId: string; body: string; supersedesEventId?: string | null }): boolean {
    const at = new Date().toISOString();
    const before = this.row("SELECT 1 AS hit FROM memory_outbox WHERE event_id = ?", input.eventId);
    if (before) return false;
    this.run("INSERT INTO memory_outbox (event_id, project_id, ref_type, ref_id, body, status, attempts, next_at, created_at, updated_at, supersedes_event_id) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)",
      input.eventId, input.projectId, input.refType, input.refId, input.body, at, at, at, input.supersedesEventId ?? null);
    return true;
  }

  getMemoryUpload(eventId: string): MemoryUpload | null {
    const r = this.row("SELECT * FROM memory_outbox WHERE event_id = ?", eventId);
    return r ? toMemoryUpload(r) : null;
  }

  // ---- 기억 운영: 프로젝트 기본값 ----
  /** Observers run after committed domain changes; they never control the original write. */
  subscribeCommitted(listener: (event: WsEvent) => void): () => void {
    return this.bus.subscribe(listener);
  }

  /** 서버 환경 목록으로 켠 이전 프로젝트. 프로젝트가 따로 정한 값(on·off)이 있으면 그쪽이 앞선다. */
  setLegacyMemoryProjects(ids: readonly string[]): void {
    this.legacyMemory = new Set(ids);
  }

  /** 대표가 프로젝트의 기억 운영을 켜거나 끈다. 끈 값은 다른 기본값이 덮지 않는다. 켤 때만 켠 시각을 새로 적는다. */
  setProjectMemory(id: string, on: boolean): Project {
    return this.transaction(() => {
      const before = this.requireProject(id);
      if (before.memory?.mode === (on ? "on" : "off")) return before;
      const at = nowIso();
      this.run("UPDATE projects SET memory_mode = ?, memory_enabled_at = CASE WHEN ? THEN COALESCE(CASE WHEN memory_mode = 'on' THEN memory_enabled_at END, ?) ELSE memory_enabled_at END, updated_at = ? WHERE id = ?",
        on ? "on" : "off", on ? 1 : 0, at, at, id);
      const project = this.requireProject(id);
      this.emit({ type: "project", project });
      this.emitProjects();
      return project;
    });
  }

  /**
   * 결재 답 가운데 기억 대기열에 없는 것. 원본 저장과 대기열 넣기 사이에 서버가 멈추면 생기는 빈틈을 메운다.
   * 프로젝트가 기억을 켠 뒤(켠 시각, 이전 프로젝트는 첫 업로드 시각) 답한 것만 본다. 그 전의 지난 결재는 모아 올리지 않는다.
   */
  answeredDecisionsMissingMemory(projectId: string): Decision[] {
    const project = this.requireProject(projectId);
    const since = project.memory?.enabledAt ?? (this.row("SELECT MIN(created_at) AS at FROM memory_outbox WHERE project_id = ?", projectId)?.at as string | null) ?? null;
    if (!since) return [];
    return this.rows(
      `SELECT * FROM decisions d WHERE d.project_id = ? AND d.status IN ('answered','delivered') AND d.answered_at >= ?
         AND NOT EXISTS (SELECT 1 FROM memory_outbox o WHERE o.ref_type = 'decision' AND o.ref_id = d.id) ORDER BY d.answered_at`,
      projectId, since,
    ).map(toDecision);
  }

  // ---- 기억 운영: 총괄의 선별 기록 ----
  /** 선별 기록과 그 업로드를 한 트랜잭션에 남긴다(기록만 있고 대기열이 빠지는 일이 없다). 같은 사건이면 처음 것을 돌려준다. */
  saveMemoryCapture(input: Omit<MemoryCapture, "id" | "createdAt">, upload: { body: string; supersedesEventId: string | null }): { capture: MemoryCapture; created: boolean } {
    return this.transaction(() => {
      const before = this.row("SELECT * FROM memory_captures WHERE event_id = ?", input.eventId);
      if (before) return { capture: toMemoryCapture(before), created: false };
      const id = newId("mc_");
      const at = nowIso();
      this.run(
        `INSERT INTO memory_captures (id, project_id, event_id, type, scope, standing, message_ids, task_id, interpretation, file_refs, supersedes_id, captured_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, input.projectId, input.eventId, input.type, input.scope, input.standing ? 1 : 0, JSON.stringify(input.messageIds), input.taskId, input.interpretation,
        JSON.stringify(input.fileRefs), input.supersedesId, input.capturedBy, at,
      );
      this.enqueueMemoryUpload({ eventId: input.eventId, projectId: input.projectId, refType: "owner_note", refId: id, body: upload.body, supersedesEventId: upload.supersedesEventId });
      return { capture: toMemoryCapture(this.row("SELECT * FROM memory_captures WHERE id = ?", id)!), created: true };
    });
  }

  getMemoryCapture(id: string): MemoryCapture | null {
    const r = this.row("SELECT * FROM memory_captures WHERE id = ?", id);
    return r ? toMemoryCapture(r) : null;
  }

  listMemoryCaptures(projectId: string): MemoryCapture[] {
    return this.rows("SELECT * FROM memory_captures WHERE project_id = ? ORDER BY created_at, rowid", projectId).map(toMemoryCapture);
  }

  // ---- 기억 운영: 일 시작 전 검색 ----
  /** 이미 기억을 찾아 붙인 전달인가(재전송·재시작 뒤에도 같은 전달은 다시 찾지 않는다). */
  memorySearchedDelivery(deliveryId: string): boolean {
    return !!this.row("SELECT 1 AS hit FROM memory_search_deliveries WHERE delivery_id = ?", deliveryId);
  }

  /** 같은 직원이 최근에 같은 검색어로 찾은 결과(같은 검토의 후속이면 다시 쓴다). 실패한 검색은 다시 쓰지 않는다. */
  recentMemorySearch(projectId: string, memberId: string, queryHash: string, since: string): MemorySearch | null {
    const r = this.row("SELECT * FROM memory_searches WHERE project_id = ? AND member_id = ? AND query_hash = ? AND status != 'error' AND created_at >= ? ORDER BY created_at DESC LIMIT 1", projectId, memberId, queryHash, since);
    return r ? toMemorySearch(r) : null;
  }

  /** 검색 기록과(전달로 넣을 때는) 직원에게 넣을 글을 한 트랜잭션에 남긴다. */
  recordMemorySearch(input: Omit<MemorySearch, "id" | "createdAt">, link?: { deliveryIds: string[]; notice: NewDelivery | null }): MemorySearch {
    return this.transaction(() => {
      const id = newId("ms_");
      const at = nowIso();
      this.run(
        "INSERT INTO memory_searches (id, project_id, member_id, task_id, trigger, query_hash, status, result_ids, block, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        id, input.projectId, input.memberId, input.taskId, input.trigger, input.queryHash, input.status, JSON.stringify(input.resultIds), input.block, input.detail, at,
      );
      for (const deliveryId of link?.deliveryIds ?? []) this.run("INSERT OR IGNORE INTO memory_search_deliveries (delivery_id, search_id) VALUES (?, ?)", deliveryId, id);
      if (link?.notice) this.enqueue(link.notice);
      return toMemorySearch(this.row("SELECT * FROM memory_searches WHERE id = ?", id)!);
    });
  }

  listMemorySearches(projectId: string): MemorySearch[] {
    return this.rows("SELECT * FROM memory_searches WHERE project_id = ? ORDER BY created_at, rowid", projectId).map(toMemorySearch);
  }

  dueMemoryUploads(now: string, limit = 20, projectIds?: readonly string[]): MemoryUpload[] {
    if (projectIds?.length === 0) return [];
    const projectFilter = projectIds ? ` AND project_id IN (${projectIds.map(() => "?").join(",")})` : "";
    return this.rows(`SELECT * FROM memory_outbox WHERE status = 'pending' AND next_at <= ?${projectFilter} ORDER BY created_at, rowid LIMIT ?`, now, ...(projectIds ?? []), limit).map(toMemoryUpload);
  }

  listMemoryUploads(projectId?: string): MemoryUpload[] {
    return (projectId ? this.rows("SELECT * FROM memory_outbox WHERE project_id = ? ORDER BY created_at", projectId) : this.rows("SELECT * FROM memory_outbox ORDER BY created_at")).map(toMemoryUpload);
  }

  settleMemoryUpload(eventId: string, patch: { status: MemoryUpload["status"]; attempts: number; nextAt?: string; lastError?: string | null; remoteId?: string | null }): void {
    const at = new Date().toISOString();
    this.run("UPDATE memory_outbox SET status = ?, attempts = ?, next_at = COALESCE(?, next_at), last_error = ?, remote_id = COALESCE(?, remote_id), updated_at = ? WHERE event_id = ?",
      patch.status, patch.attempts, patch.nextAt ?? null, patch.lastError ?? null, patch.remoteId ?? null, at, eventId);
  }

  /**
   * 등록하거나 고친다. id 를 주면 그 작업의 제목·브랜치·워크트리만 고치고 id 는 그대로 둔다.
   * id 없이 같은 직원이 같은 브랜치(없으면 같은 워크트리)로 이미 등록한 작업이 있으면 새로 만들지 않고 그 작업을 돌려준다.
   */
  saveTask(input: TaskInput): { task: Task; created: boolean } {
    return this.transaction(() => {
      this.requireProject(input.projectId);
      const at = nowIso();
      const clean = (v: string | null | undefined) => (v === undefined ? undefined : v?.trim() || null);
      const branch = clean(input.branch);
      const worktree = clean(input.worktree);
      const title = input.title?.trim();
      let existing: Task | null = null;
      if (input.id) {
        existing = this.requireTask(input.id);
        if (existing.projectId !== input.projectId) throw new ApiError(404, `작업을 찾을 수 없습니다: ${input.id}`);
      } else if (branch || worktree) {
        const r = branch
          ? this.row("SELECT * FROM tasks WHERE project_id = ? AND member_id = ? AND branch = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", input.projectId, input.memberId, branch)
          : this.row("SELECT * FROM tasks WHERE project_id = ? AND member_id = ? AND worktree = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", input.projectId, input.memberId, worktree!);
        existing = r ? toTask(r) : null;
      } else if (title) {
        // 브랜치 없이 제목만으로 만든 업무: 같은 직원이 같은 제목으로 다시 부르면(응답 유실·재시도) 새로 만들지 않는다.
        const r = this.row("SELECT * FROM tasks WHERE project_id = ? AND member_id = ? AND title = ? AND branch IS NULL AND worktree IS NULL AND merged_into IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1", input.projectId, input.memberId, title);
        existing = r ? toTask(r) : null;
      }
      if (existing) {
        const next = {
          title: input.id && title ? title : existing.title,
          branch: branch !== undefined ? branch : existing.branch,
          worktree: worktree !== undefined ? worktree : existing.worktree,
        };
        const renamed = next.title !== existing.title;
        // 대표가 이름 붙인 업무는 대표의 말이라 직원이 바꾸지 않는다. 서버가 지은 임시 이름·직원 이름은 목적이 정해지면 바꾼다.
        if (renamed && existing.origin === "owner") throw new ApiError(409, `대표가 이름 붙인 업무라 이름을 바꾸지 않습니다: #${existing.id} '${existing.title}'`);
        if (renamed || next.branch !== existing.branch || next.worktree !== existing.worktree) {
          this.run("UPDATE tasks SET title = ?, branch = ?, worktree = ?, updated_at = ? WHERE id = ?", next.title, next.branch, next.worktree, at, existing.id);
          if (renamed) this.run("UPDATE tasks SET renamed_at = ?, renamed_by = ? WHERE id = ?", at, input.who ?? null, existing.id);
          const task = this.requireTask(existing.id);
          this.emit({ type: "task", task });
          return { task, created: false };
        }
        return { task: existing, created: false };
      }
      if (!title) throw new ApiError(400, "새 작업에는 제목이 필요합니다");
      const id = newId("tk_");
      const parent = input.parentTaskId ? this.taskRef(input.projectId, input.parentTaskId) : null;
      this.run("INSERT INTO tasks (id, project_id, member_id, who, title, branch, worktree, created_at, updated_at, origin, parent_task_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'staff', ?)",
        id, input.projectId, input.memberId, input.who, title, branch ?? null, worktree ?? null, at, at, parent);
      const task = this.requireTask(id);
      this.emit({ type: "task", task });
      return { task, created: true };
    });
  }

  /** 이 직원이 작업을 쓰는가: 작업을 등록했거나 작업이 붙은 대표 글·답·지시를 받은 적이 있다. 그러면 출력마다 작업을 밝혀야 한다. */
  memberUsesTasks(memberId: string): boolean {
    return !!this.row("SELECT 1 FROM tasks WHERE member_id = ? LIMIT 1", memberId)
      || !!this.row("SELECT 1 FROM deliveries WHERE member_id = ? AND task_id IS NOT NULL AND status = 'delivered' LIMIT 1", memberId);
  }

  /**
   * 출처 하나에 업무 하나: 같은 출처 키(message:<글 id> 등)로 이미 만든 업무가 있으면 그것을 돌려주고 새로 만들지 않는다.
   * 대표 글을 같은 id 로 다시 보내거나, 보고 보완·자동 보고가 되풀이돼도 업무가 늘지 않는다. 등록한 직원은 두지 않는다(memberId NULL).
   */
  ensureSourceTask(input: { projectId: string; sourceRef: string; title: string; origin: Exclude<TaskOrigin, "staff" | "board">; who?: string; parentTaskId?: string | null }): { task: Task; created: boolean } {
    return this.transaction(() => {
      this.requireProject(input.projectId);
      const found = this.row("SELECT * FROM tasks WHERE project_id = ? AND source_ref = ?", input.projectId, input.sourceRef);
      if (found) return { task: toTask(found), created: false };
      const title = input.title.trim();
      if (!title) throw new ApiError(400, "새 업무에는 이름이 필요합니다");
      const parent = input.parentTaskId ? this.taskRef(input.projectId, input.parentTaskId) : null;
      const id = newId("tk_");
      const at = nowIso();
      this.run("INSERT INTO tasks (id, project_id, member_id, who, title, branch, worktree, created_at, updated_at, origin, source_ref, parent_task_id) VALUES (?, ?, NULL, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)",
        id, input.projectId, input.who ?? "", title, at, at, input.origin, input.sourceRef, parent);
      const task = this.requireTask(id);
      this.emit({ type: "task", task });
      return { task, created: true };
    });
  }

  /**
   * 대표가 남기는 기록(대화 글·자료)의 업무. 고른 업무가 있으면 그 업무(합쳐졌으면 합쳐진 곳), 새 업무 이름을 줬으면 그 이름(owner),
   * 둘 다 없으면 글 첫 줄로 서버가 이름 붙인 새 업무(auto). 같은 출처 키로는 업무가 하나만 생긴다. 본사는 업무를 쓰지 않는다(null).
   */
  ownerTask(projectId: string, input: { taskId?: string | null; newTaskTitle?: string | null; sourceRef: string; text: string; fallbackLabel: string; who?: string }): string | null {
    const project = this.requireProject(projectId);
    const named = input.newTaskTitle?.trim() || null;
    if (input.taskId && named) throw new ApiError(400, "고른 업무(taskId)와 새 업무 이름(newTaskTitle)은 함께 보내지 않습니다");
    if (input.taskId) {
      const task = this.getTask(input.taskId);
      if (!task || task.projectId !== projectId) throw new ApiError(400, "이 프로젝트의 작업이 아닙니다");
      return this.resolveTask(task).id;
    }
    if (project.isHq) {
      if (named) throw new ApiError(400, "본사 대화는 업무를 쓰지 않습니다");
      return null;
    }
    const title = named ? ownerTaskTitle(named) : taskTitleFrom(input.text, datedTitle(input.fallbackLabel, new Date()));
    return this.ensureSourceTask({ projectId, sourceRef: input.sourceRef, title, origin: named ? "owner" : "auto", who: input.who ?? "" }).task.id;
  }

  /** 출처 키로 만든 업무(없으면 null). */
  taskSourceRef(taskId: string): string | null {
    return this.row("SELECT source_ref FROM tasks WHERE id = ?", taskId)?.source_ref ?? null;
  }

  sourceTask(projectId: string, sourceRef: string): Task | null {
    const r = this.row("SELECT * FROM tasks WHERE project_id = ? AND source_ref = ?", projectId, sourceRef);
    return r ? toTask(r) : null;
  }

  /** 기록의 지금 업무(기록이 없으면 undefined). */
  recordTaskId(refType: TaskRefType, refId: string): string | null | undefined {
    const r = this.row(`SELECT task_id FROM ${TASK_REF_TABLES[refType]} WHERE id = ?`, refId);
    return r ? ((r.task_id as string | null) ?? null) : undefined;
  }

  /**
   * 기록 하나의 업무를 바꾼다. 원문(id·본문·시각·보낸 이)은 그대로 두고 업무 칸만 바꾸며, 바꾼 기록을 task_links 에 남긴다.
   * from 이 지금 값과 다르면(그새 누가 바꿨으면) 바꾸지 않고 false. 같은 값으로는 바꾸지 않는다.
   */
  moveRecordTask(input: { projectId: string; refType: TaskRefType; refId: string; from: string | null; to: string | null; basis: string; actor: string; note?: string | null; batchId?: string | null }): boolean {
    return this.transaction(() => {
      const table = TASK_REF_TABLES[input.refType];
      const row = this.row(`SELECT project_id, task_id FROM ${table} WHERE id = ?`, input.refId);
      if (!row || row.project_id !== input.projectId) throw new ApiError(404, `기록을 찾을 수 없습니다: ${input.refId}`);
      const current = (row.task_id as string | null) ?? null;
      if (current !== input.from || current === input.to) return false;
      const to = input.to ? this.taskRef(input.projectId, input.to) : null;
      this.run(`UPDATE ${table} SET task_id = ? WHERE id = ?`, to, input.refId);
      this.run("INSERT INTO task_links (id, project_id, ref_type, ref_id, from_task_id, to_task_id, basis, note, actor, batch_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        newId("tl_"), input.projectId, input.refType, input.refId, current, to, input.basis, input.note ?? null, input.actor, input.batchId ?? null, nowIso());
      if (input.refType === "message") {
        // 그 글을 다시 전달할 때도 같은 업무 줄이 붙게, 아직 안 나간 전달의 업무도 따라 바꾼다(나간 전달은 그때 받은 그대로 둔다).
        this.run("UPDATE deliveries SET task_id = ? WHERE ref_type = 'message' AND ref_id = ? AND status IN ('queued','held') AND task_id IS ?", to, input.refId, current);
        this.bumpBoard(input.projectId);
        this.emit({ type: "message", message: this.requireMessage(input.refId) });
      } else if (input.refType === "decision") this.emit({ type: "decision", decision: this.getDecision(input.refId)! });
      else if (input.refType === "todo") this.emit({ type: "todo", todo: this.getTodo(input.refId)! });
      else this.emit({ type: "file", file: this.getFile(input.refId)! });
      return true;
    });
  }

  /** 합쳐진 업무를 따라가 지금 쓸 업무를 돌려준다(합쳐지지 않았으면 그대로). */
  resolveTask(task: Task): Task {
    let current = task;
    for (let i = 0; i < 8 && current.mergedInto; i++) {
      const next = this.getTask(current.mergedInto);
      if (!next || next.projectId !== current.projectId) break;
      current = next;
    }
    return current;
  }

  /** 총괄의 분류로 빈 업무를 다른 업무에 합쳤다고 남긴다. 업무 자체와 그 출처 키는 지우지 않는다(같은 출처로 다시 만들지 않게). */
  markTaskMerged(taskId: string, into: string, actor: string): void {
    this.transaction(() => {
      const task = this.requireTask(taskId);
      if (task.mergedInto === into || taskId === into) return;
      this.taskRef(task.projectId, into);
      this.run("UPDATE tasks SET merged_into = ?, updated_at = ? WHERE id = ?", into, nowIso(), taskId);
      this.run("INSERT INTO task_links (id, project_id, ref_type, ref_id, from_task_id, to_task_id, basis, note, actor, created_at) VALUES (?, ?, 'task', ?, ?, ?, 'merged', NULL, ?, ?)",
        newId("tl_"), task.projectId, taskId, taskId, into, actor, nowIso());
      this.emit({ type: "task", task: this.requireTask(taskId) });
    });
  }

  /**
   * 업무 사이 갈라진 관계를 남긴다(글은 옮기지 않는다). 나중에 생긴 업무에 아직 부모가 없으면 부모로도 적는다. 같은 관계는 한 번만 남긴다.
   */
  recordTaskRelation(input: { projectId: string; taskId: string; fromTaskId: string; basis: "derived"; actor: string; note?: string | null }): void {
    this.transaction(() => {
      if (input.taskId === input.fromTaskId) return;
      const task = this.requireTask(input.taskId);
      const from = this.requireTask(input.fromTaskId);
      if (task.projectId !== input.projectId || from.projectId !== input.projectId) throw new ApiError(400, "이 프로젝트의 업무가 아닙니다");
      if (this.row("SELECT 1 FROM task_links WHERE project_id = ? AND ref_type = 'task' AND ref_id = ? AND from_task_id = ? AND basis = ? AND undone_at IS NULL", input.projectId, input.taskId, input.fromTaskId, input.basis)) return;
      this.run("INSERT INTO task_links (id, project_id, ref_type, ref_id, from_task_id, to_task_id, basis, note, actor, created_at) VALUES (?, ?, 'task', ?, ?, ?, ?, ?, ?, ?)",
        newId("tl_"), input.projectId, input.taskId, input.fromTaskId, input.taskId, input.basis, input.note ?? null, input.actor, nowIso());
      if (!task.parentTaskId && task.createdAt >= from.createdAt) {
        this.run("UPDATE tasks SET parent_task_id = ?, updated_at = ? WHERE id = ?", from.id, nowIso(), task.id);
        this.emit({ type: "task", task: this.requireTask(task.id) });
      }
    });
  }

  /** 옛 글 정리 묶음이 업무를 만들었다고 남긴다(되돌릴 때 그 묶음이 만든 업무만 지우려고). */
  noteTaskCreated(projectId: string, taskId: string, batchId: string, actor: string): void {
    this.run("INSERT INTO task_links (id, project_id, ref_type, ref_id, from_task_id, to_task_id, basis, note, actor, batch_id, created_at) VALUES (?, ?, 'task', ?, NULL, ?, 'backfill-created', NULL, ?, ?, ?)",
      newId("tl_"), projectId, taskId, taskId, actor, batchId, nowIso());
  }

  markTaskLinkUndone(id: string): void {
    this.run("UPDATE task_links SET undone_at = ? WHERE id = ? AND undone_at IS NULL", nowIso(), id);
  }

  /**
   * 아무 기록도 붙지 않은 업무만 지운다(옛 글 정리를 되돌릴 때). 글·결재·자료·할 일·전달·기억 기록이 붙었거나
   * 다른 업무의 부모·합친 곳이면 지우지 않고 false.
   */
  deleteTaskIfEmpty(taskId: string): boolean {
    return this.transaction(() => {
      if (!this.getTask(taskId)) return false;
      for (const table of ["messages", "decisions", "files", "todos", "deliveries", "memory_captures", "memory_searches"]) {
        if (this.row(`SELECT 1 FROM ${table} WHERE task_id = ? LIMIT 1`, taskId)) return false;
      }
      if (this.row("SELECT 1 FROM tasks WHERE parent_task_id = ? OR merged_into = ? LIMIT 1", taskId, taskId)) return false;
      this.run("DELETE FROM tasks WHERE id = ?", taskId);
      return true;
    });
  }

  /** 업무를 바꾼 기록. ref 를 주면 그 기록의 것만, 오래된 것부터. */
  listTaskLinks(projectId: string, ref?: { refType: TaskRefType | "task"; refId: string }): TaskLink[] {
    return (ref
      ? this.rows("SELECT * FROM task_links WHERE project_id = ? AND ref_type = ? AND ref_id = ? ORDER BY created_at, rowid", projectId, ref.refType, ref.refId)
      : this.rows("SELECT * FROM task_links WHERE project_id = ? ORDER BY created_at, rowid", projectId)).map(toTaskLink);
  }

  /**
   * 업무에 붙은 기록(글·결재·자료·할 일) 중 keep 에 없는 것의 수. 서버가 만든 업무가 대표 글 하나만 담고 있는지 볼 때 쓴다.
   * keepAuthor 를 주면 그 직원이 쓴 글도 센다에서 뺀다(분류하는 총괄 자신의 글).
   */
  taskOtherRecords(taskId: string, keepIds: string[], keepAuthor?: string | null): number {
    const keep = new Set(keepIds);
    let n = 0;
    for (const r of this.rows("SELECT id, member_id FROM messages WHERE task_id = ?", taskId)) if (!keep.has(r.id) && !(keepAuthor && r.member_id === keepAuthor)) n++;
    for (const table of ["decisions", "files", "todos"]) n += this.rows(`SELECT id FROM ${table} WHERE task_id = ?`, taskId).filter(r => !keep.has(r.id)).length;
    return n;
  }

  /** 업무에 붙은 글 id(오래된 것부터). */
  taskMessageIds(taskId: string): { id: string; memberId: string | null; mine: boolean }[] {
    return this.rows("SELECT id, member_id, mine FROM messages WHERE task_id = ? ORDER BY at, rowid", taskId).map(r => ({ id: r.id, memberId: r.member_id ?? null, mine: !!r.mine }));
  }

  /** 전달의 작업(없으면 null). */
  deliveryTaskId(id: string): string | null {
    return (this.row("SELECT task_id FROM deliveries WHERE id = ?", id)?.task_id as string | null | undefined) ?? null;
  }

  /** Persisted delegation proof distinguishes old agent assignments from direct
   * owner input and legacy instructions whose provenance is unknown. Status is
   * intentionally unrestricted: the final write guard also checks delivering rows. */
  unconfirmedDelegatedTask(deliveryId: string): string | null {
    const row = this.row(`SELECT d.task_id FROM deliveries d WHERE d.id=? AND d.kind='instruction' AND d.wake=1
      AND d.task_id IS NOT NULL AND EXISTS(SELECT 1 FROM report_closures c WHERE c.kind='delegated'
        AND c.ref_type='delivery' AND c.ref_id=d.id AND c.project_id=d.project_id)`, deliveryId);
    if (!row) return null;
    const task = this.resolveTask(this.requireTask(row.task_id as string));
    const contract = this.getEffectiveContract(task.id);
    return bindingContract(contract) && !missingExecutionContractFields(contract).length ? null : task.id;
  }

  /** 글·카드·자료·할 일에 붙일 작업 id. 다른 프로젝트의 작업이면 거절한다. */
  private taskRef(projectId: string, taskId: string | null | undefined): string | null {
    if (!taskId) return null;
    const task = this.getTask(taskId);
    if (!task || task.projectId !== projectId) throw new ApiError(400, `이 프로젝트의 작업이 아닙니다: ${taskId}`);
    return task.id;
  }

  private refTask(refType: Delivery["refType"], refId: string | null): string | null {
    if (!refType || !refId) return null;
    const table = refType === "message" ? "messages" : refType === "decision" ? "decisions" : refType === "todo" ? "todos" : null;
    if (!table) return null;
    return (this.row(`SELECT task_id FROM ${table} WHERE id = ?`, refId)?.task_id as string | null | undefined) ?? null;
  }

  // ---- 대화 ----
  getMessage(id: string): Message | null {
    const r = this.row("SELECT * FROM messages WHERE id = ?", id);
    return r ? toMessage(r) : null;
  }

  requireMessage(id: string): Message {
    const m = this.getMessage(id);
    if (!m) throw new ApiError(404, "메시지를 찾을 수 없습니다");
    return m;
  }

  /** `before`(at) 보다 앞선 것 중 최신 limit 개를 오래된 → 최신으로. */
  listMessages(projectId: string, opts: { before?: string; limit?: number } = {}): Message[] {
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
    const rows = opts.before
      ? this.rows("SELECT * FROM messages WHERE project_id = ? AND at < ? ORDER BY at DESC, rowid DESC LIMIT ?", projectId, opts.before, limit)
      : this.rows("SELECT * FROM messages WHERE project_id = ? ORDER BY at DESC, rowid DESC LIMIT ?", projectId, limit);
    return rows.reverse().map(toMessage);
  }

  private messageScope(projectId: string, scope: MessageScope = { kind: "project" }): MessageScope {
    if (scope.kind === "project") return { kind: "project" };
    if (scope.kind === "task") {
      if (!scope.taskId || Buffer.byteLength(scope.taskId) > 256) throw new ApiError(400, "대화 조회 조건이 잘못되었습니다", "INVALID_MESSAGE_PAGE_QUERY");
      if (this.getTask(scope.taskId)?.projectId !== projectId) throw new ApiError(404, "작업을 찾을 수 없습니다");
      return { kind: "task", taskId: scope.taskId };
    }
    if (!scope.memberId || Buffer.byteLength(scope.memberId) > 256) throw new ApiError(400, "대화 조회 조건이 잘못되었습니다", "INVALID_MESSAGE_PAGE_QUERY");
    const lead = this.listMembers(projectId).find((m) => m.kind === "root" || m.kind === "conductor");
    return lead?.id === scope.memberId ? { kind: "project" } : { kind: "member", memberId: scope.memberId };
  }

  private messagePage(projectId: string, opts: MessagePageOptions, archived: boolean): MessagePage {
    const project = this.requireProject(projectId);
    if (project.archived !== archived) throw new ApiError(404, "프로젝트를 찾을 수 없습니다");
    const limit = opts.limit ?? 200;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500 || !projectId || Buffer.byteLength(projectId) > 256) throw new ApiError(400, "대화 조회 조건이 잘못되었습니다", "INVALID_MESSAGE_PAGE_QUERY");
    const scope = this.messageScope(projectId, opts.scope);
    let before: { at: string; id: string } | null = null;
    if (opts.cursor !== undefined) {
      try {
        if (!opts.cursor || opts.cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(opts.cursor)) throw new Error("encoding");
        const bytes = Buffer.from(opts.cursor, "base64url");
        if (bytes.toString("base64url") !== opts.cursor) throw new Error("encoding");
        const bounded = (max: number) => z.string().min(1).refine((value) => Buffer.byteLength(value) <= max);
        const cursor = z.strictObject({
          v: z.literal(1), projectId: bounded(256),
          scope: z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("project") }), z.strictObject({ kind: z.literal("member"), memberId: bounded(256) }), z.strictObject({ kind: z.literal("task"), taskId: bounded(256) })]),
          before: z.strictObject({ at: bounded(128), id: bounded(256) }),
        }).parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
        if (cursor.projectId !== projectId) throw new Error("project");
        if (JSON.stringify(cursor.scope) !== JSON.stringify(scope)) {
          if (opts.scope?.kind === "member" && (cursor.scope.kind === "project" || (scope.kind === "project" && cursor.scope.kind === "member" && cursor.scope.memberId === opts.scope.memberId))) {
            throw new ApiError(409, "대화 대상이 변경되었습니다", "MESSAGE_SCOPE_CHANGED");
          }
          throw new Error("scope");
        }
        before = cursor.before;
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(400, "이전 기록의 위치 정보가 올바르지 않습니다", "INVALID_MESSAGE_CURSOR");
      }
    }
    const seek = before ? " AND (at, id) < ($at, $id)" : "";
    const params = { $project: projectId, $limit: limit + 1, ...(before ? { $at: before.at, $id: before.id } : {}) };
    const rows = scope.kind === "project"
      ? this.db.query<Row, typeof params>(`SELECT * FROM messages WHERE project_id = $project${seek} ORDER BY at COLLATE BINARY DESC, id COLLATE BINARY DESC LIMIT $limit`).all(params)
      : scope.kind === "task"
      ? this.db.query<Row, typeof params & { $task: string }>(`SELECT * FROM messages WHERE project_id = $project AND task_id = $task${seek} ORDER BY at COLLATE BINARY DESC, id COLLATE BINARY DESC LIMIT $limit`).all({ ...params, $task: scope.taskId })
      : this.db.query<Row, typeof params & { $member: string }>(`WITH authored AS (
          SELECT id, at FROM messages WHERE project_id = $project AND member_id = $member${seek}
          ORDER BY at COLLATE BINARY DESC, id COLLATE BINARY DESC LIMIT $limit
        ), targeted AS (
          SELECT id, at FROM messages WHERE project_id = $project AND target_member_id = $member${seek}
          ORDER BY at COLLATE BINARY DESC, id COLLATE BINARY DESC LIMIT $limit
        ), candidates AS (SELECT id, at FROM authored UNION SELECT id, at FROM targeted), page_keys AS (
          SELECT id, at FROM candidates ORDER BY at COLLATE BINARY DESC, id COLLATE BINARY DESC LIMIT $limit
        ) SELECT m.* FROM page_keys k JOIN messages m ON m.id = k.id ORDER BY k.at COLLATE BINARY DESC, k.id COLLATE BINARY DESC`).all({ ...params, $member: scope.memberId });
    const hasOlder = rows.length > limit;
    const items = rows.slice(0, limit).reverse().map(toMessage);
    const first = items[0];
    if (hasOlder && first && (Buffer.byteLength(first.at) > 128 || Buffer.byteLength(first.id) > 256 || !first.at || !first.id)) throw new ApiError(500, "저장된 메시지의 위치 정보가 올바르지 않습니다");
    return { projectId, scope, items, hasOlder, nextCursor: hasOlder && first ? Buffer.from(JSON.stringify({ v: 1, projectId, scope, before: { at: first.at, id: first.id } })).toString("base64url") : null };
  }

  listMessagePage(projectId: string, opts: MessagePageOptions = {}): MessagePage {
    return this.messagePage(projectId, opts, false);
  }

  listArchiveMessagePage(projectId: string, opts: MessagePageOptions = {}): MessagePage {
    return this.messagePage(projectId, opts, true);
  }

  archiveState(projectId: string): ArchiveProjectState {
    return this.transaction(() => {
      const state = this.projectState(projectId);
      if (!state.project.archived) throw new ApiError(404, "프로젝트를 찾을 수 없습니다");
      return { ...state, project: { ...state.project, archived: true } };
    });
  }

  listArchivedProjects(): Project[] {
    return this.rows("SELECT * FROM projects WHERE archived = 1 ORDER BY created_at, rowid").map((r) => this.projectFrom(r));
  }

  listMessagesAround(projectId: string, messageId: string, limit = 41): Message[] {
    this.requireProject(projectId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ApiError(400, "대화 조회 조건이 잘못되었습니다", "INVALID_MESSAGE_PAGE_QUERY");
    const anchor = this.requireMessage(messageId);
    if (anchor.projectId !== projectId) throw new ApiError(404, "메시지를 찾을 수 없습니다");
    const older = this.rows("SELECT * FROM messages WHERE project_id = ? AND (at, id) < (?, ?) ORDER BY at COLLATE BINARY DESC, id COLLATE BINARY DESC LIMIT ?", projectId, anchor.at, anchor.id, Math.floor((limit - 1) / 2));
    const newer = this.rows("SELECT * FROM messages WHERE project_id = ? AND (at, id) > (?, ?) ORDER BY at COLLATE BINARY, id COLLATE BINARY LIMIT ?", projectId, anchor.at, anchor.id, limit - 1 - older.length);
    return [...older.reverse().map(toMessage), anchor, ...newer.map(toMessage)];
  }

  // before 페이징이 같은 at 의 글을 건너뛰지 않도록 at 을 프로세스 안에서 단조 증가시킨다.
  private nextMessageAt(): string {
    const ms = Math.max(Date.now(), this.lastMessageMs + 1);
    this.lastMessageMs = ms;
    return new Date(ms).toISOString();
  }

  registerOwnerCommand(messageId: string, routedWorkerId: string | null = null): void {
    const message = this.requireMessage(messageId);
    if (!message.mine || message.kind !== "나" || (routedWorkerId && (routedWorkerId !== message.targetMemberId ||
        this.requireMember(routedWorkerId).projectId !== message.projectId))) throw new ApiError(400, "대표 명령 원본과 수신자가 일치해야 합니다");
    this.run("INSERT OR IGNORE INTO owner_commands(message_id,project_id,created_at,routed_worker_id,routed_task_id) VALUES(?,?,?,?,?)", message.id, message.projectId, message.at, routedWorkerId, routedWorkerId ? message.taskId ?? null : null);
  }

  recordOwnerCommandAnswer(commandId: string, responseId: string): void {
    const answer = this.requireMessage(responseId);
    if (answer.mine || answer.memberId || answer.kind !== "답변" || answer.aboutMessageId !== commandId ||
        !this.row("SELECT 1 FROM owner_commands WHERE message_id=? AND project_id=?", commandId, answer.projectId)) throw new ApiError(400, "명령 원본과 현황 답변이 일치하지 않습니다");
    this.run("INSERT OR IGNORE INTO owner_command_evidence(ref_type,ref_id,command_id) VALUES('message',?,?)", responseId, commandId);
  }

  /** 멱등: 같은 id 가 이미 있으면 새로 쓰지 않고 그 글을 돌려준다. */
  createMessage(input: NewMessage): Message {
    return this.transaction(() => {
      if (input.id) {
        const existing = this.getMessage(input.id);
        if (existing) {
          if (existing.projectId !== input.projectId) throw new ApiError(409, "다른 프로젝트에서 사용된 메시지 ID입니다");
          return existing;
        }
      }
      this.requireProject(input.projectId);
      const id = input.id ?? newId("msg_");
      this.run(
        `INSERT INTO messages (id, project_id, at, mine, member_id, who, kind, title, body, target_member_id, target_name, decision_id, file_id, attachments, delivery, delivery_note, task_id, about_message_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.projectId,
        input.at ?? this.nextMessageAt(),
        input.mine ? 1 : 0,
        input.memberId ?? null,
        input.who ?? "",
        input.kind,
        input.title ?? "",
        input.body ?? "",
        input.targetMemberId ?? null,
        input.targetName ?? null,
        input.decisionId ?? null,
        input.fileId ?? null,
        JSON.stringify(input.attachments ?? []),
        input.delivery ?? null,
        input.deliveryNote ?? null,
        this.taskRef(input.projectId, input.taskId),
        input.aboutMessageId ?? null,
      );
      const message = this.requireMessage(id);
      // 보관 중 늦은 manual 보고도 저장한다. 푸시는 활성 프로젝트의 실제 작성자만 대상이다.
      if (this.recorder && !this.requireProject(message.projectId).archived && (!message.memberId || this.getMember(message.memberId)?.projectId === message.projectId)) this.recorder.message(message);
      this.bumpBoard(message.projectId);
      this.emit({ type: "message", message });
      return message;
    });
  }

  setMessageDelivery(id: string, delivery: DeliveryStatus | null, note: string | null = null): Message {
    return this.transaction(() => {
      this.requireMessage(id);
      this.run("UPDATE messages SET delivery = ?, delivery_note = ? WHERE id = ?", delivery, note, id);
      const message = this.requireMessage(id);
      this.bumpBoard(message.projectId);
      this.emit({ type: "message", message });
      return message;
    });
  }

  // ---- 자료 ----
  getFile(id: string): FileDoc | null {
    const r = this.row("SELECT * FROM files WHERE id = ?", id);
    return r ? toFile(r) : null;
  }

  /** 아티팩트 원본. 예전 자료는 첨부에 들어 있어 호출하는 쪽이 첨부에서 읽는다. */
  getFileHtml(id: string): string | null {
    const html: unknown = this.row("SELECT html FROM files WHERE id = ?", id)?.html;
    return html === null || html === undefined ? null : decodeStoredText(html);
  }

  listFiles(projectId: string): FileDoc[] {
    // Artifact HTML is loaded separately by getFileHtml, never by a sync/list projection.
    // File bodies are immutable after creation; metadata (including task bindings)
    // is always re-read. Avoid reading megabytes of overflow pages on every sync.
    return this.rows(`SELECT id, project_id, title, who, member_id, summary, path, attachments, created_at, sort_order, kind, task_id
      FROM files INDEXED BY files_list_metadata WHERE project_id = ? ORDER BY sort_order DESC, rowid DESC`, projectId).map(row => toFile({ ...row, body: this.cachedFileBody(row.id) }));
  }

  listFilePage(projectId: string, opts: FilePageOptions = {}): FilePage {
    this.requireProject(projectId);
    const limit = opts.limit ?? 20, taskId = opts.taskId ?? null, kind = opts.kind ?? null;
    const bad = () => new ApiError(400, "자료 조회 조건이 잘못되었습니다", "INVALID_FILE_PAGE_QUERY");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || taskId !== null && (!taskId || Buffer.byteLength(taskId) > 256)
      || kind !== null && !FILE_KINDS.includes(kind)) throw bad();
    let before: { order: number; id: string } | null = null;
    if (opts.cursor !== undefined) {
      try {
        if (!opts.cursor || opts.cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(opts.cursor)) throw bad();
        const bytes = Buffer.from(opts.cursor, "base64url");
        if (bytes.toString("base64url") !== opts.cursor) throw bad();
        const bounded = z.string().min(1).max(256);
        const cursor = z.strictObject({ v: z.literal(1), projectId: bounded, taskId: bounded.nullable(), kind: z.enum(FILE_KINDS).nullable(),
          before: z.strictObject({ order: z.number().int().safe(), id: bounded }) }).parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
        if (cursor.projectId !== projectId || cursor.taskId !== taskId || cursor.kind !== kind) throw bad();
        before = cursor.before;
      } catch { throw new ApiError(400, "자료 목록의 위치 정보가 올바르지 않습니다", "INVALID_FILE_CURSOR"); }
    }
    const baseWhere = `project_id = ?${taskId === null ? "" : " AND task_id = ?"}`;
    const baseArgs: SQLQueryBindings[] = taskId === null ? [projectId] : [projectId, taskId];
    const index = taskId === null ? "files_page_project" : "files_page_task";
    const columns = "id, project_id, title, who, member_id, summary, path, attachments, created_at, sort_order, kind, task_id";
    const summary = (row: Row): FileListItem => {
      // Preserve old inferred kinds without ever transferring the legacy body.
      const { body: _body, ...file } = toFile({ ...row, body: row.kind === null ? this.cachedFileBody(row.id) : "" });
      return file;
    };
    const counts: FilePage["counts"] = {};
    for (const row of this.rows(`SELECT kind, COUNT(*) AS n FROM files INDEXED BY ${index} WHERE ${baseWhere} AND kind IS NOT NULL GROUP BY kind`, ...baseArgs)) {
      counts[row.kind as FileKind] = row.n;
    }
    for (const row of this.rows(`SELECT ${columns} FROM files INDEXED BY ${index} WHERE ${baseWhere} AND kind IS NULL`, ...baseArgs)) {
      const key = summary(row).kind; counts[key] = (counts[key] ?? 0) + 1;
    }
    const matches: FileListItem[] = [];
    while (matches.length <= limit) {
      const seek = before ? " AND (sort_order, id) < (?, ?)" : "";
      const kindWhere = kind === null ? "" : " AND (kind = ? OR kind IS NULL)";
      const args = [...baseArgs, ...(kind === null ? [] : [kind]), ...(before ? [before.order, before.id] : []), limit + 1];
      const rows = this.rows(`SELECT ${columns} FROM files INDEXED BY ${index} WHERE ${baseWhere}${kindWhere}${seek}
        ORDER BY sort_order DESC, id COLLATE BINARY DESC LIMIT ?`, ...args);
      for (const row of rows) { const file = summary(row); if (kind === null || file.kind === kind) matches.push(file); }
      if (rows.length < limit + 1 || matches.length > limit) break;
      const last = rows.at(-1)!; before = { order: last.sort_order, id: last.id };
    }
    const items = matches.slice(0, limit), last = items.at(-1), hasMore = matches.length > limit;
    return { projectId, items, counts, hasMore, nextCursor: hasMore && last ? Buffer.from(JSON.stringify({ v: 1, projectId, taskId, kind,
      before: { order: last.order, id: last.id } })).toString("base64url") : null };
  }

  private cachedFileBody(id: string): string {
    const cached = this.fileBodies.get(id);
    if (cached) {
      this.fileBodies.delete(id);
      this.fileBodies.set(id, cached);
      return cached.body;
    }
    const value: unknown = this.row("SELECT body FROM files WHERE id = ?", id)?.body;
    const body = value === undefined ? "" : decodeStoredText(value);
    // Count UTF-16 storage conservatively, and bound empty-body/key overhead too.
    const bytes = body.length * 2;
    const budget = 16 * 1024 * 1024;
    if (bytes <= budget) {
      while (this.fileBodies.size >= 1024 || this.fileBodyBytes + bytes > budget) {
        const oldest = this.fileBodies.keys().next().value!;
        this.fileBodyBytes -= this.fileBodies.get(oldest)!.bytes;
        this.fileBodies.delete(oldest);
      }
      this.fileBodies.set(id, { body, bytes });
      this.fileBodyBytes += bytes;
    }
    return body;
  }

  createFile(input: NewFile): FileDoc {
    return this.transaction(() => {
      this.requireProject(input.projectId);
      const id = newId("f_");
      const order = this.row("SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM files WHERE project_id = ?", input.projectId)!.n as number;
      this.run(
        "INSERT INTO files (id, project_id, title, who, member_id, summary, body, path, attachments, created_at, sort_order, kind, html, task_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        id,
        input.projectId,
        input.title,
        input.who ?? "",
        input.memberId ?? null,
        input.summary ?? "",
        encodeStoredText(input.body ?? ""),
        input.path ?? null,
        JSON.stringify(input.attachments ?? []),
        nowIso(),
        order,
        input.kind ?? deriveFileKind(input.body ?? "", input.attachments ?? []),
        input.html === null || input.html === undefined ? null : encodeStoredText(input.html),
        this.taskRef(input.projectId, input.taskId),
      );
      const file = this.getFile(id)!;
      this.emit({ type: "file", file });
      return file;
    });
  }

  // ---- 첨부 ----
  createAttachment(saved: { id: string; name: string; mime: string; size: number; path: string }): Attachment {
    this.run(
      "INSERT INTO attachments (id, name, mime, size, path, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      saved.id,
      saved.name,
      saved.mime,
      saved.size,
      saved.path,
      nowIso(),
    );
    return this.getAttachment(saved.id)!;
  }

  getAttachment(id: string): Attachment | null {
    const r = this.row("SELECT * FROM attachments WHERE id = ?", id);
    return r ? toAttachment(r) : null;
  }

  /** 가져오기 전용: 원본 시각을 그대로 옮긴다. 평소 흐름은 쓰지 않는다. */
  restoreTimes(table: keyof typeof RESTORABLE_TIMES, id: string, times: Partial<Record<TimeField, string | null>>): void {
    const allowed: Partial<Record<TimeField, string>> = RESTORABLE_TIMES[table];
    const fields = (Object.keys(times) as TimeField[]).filter((f) => allowed[f] && times[f]);
    if (fields.length === 0) return;
    this.run(`UPDATE ${table} SET ${fields.map((f) => `${allowed[f]} = ?`).join(", ")} WHERE id = ?`, ...fields.map((f) => times[f]!), id);
  }

  // ---- 전달 큐 ----
  getDelivery(id: string): Delivery | null {
    const r = this.deliveryRead?.byId.get(id) ?? this.row("SELECT * FROM deliveries WHERE id = ?", id);
    return r ? toDelivery(r) : null;
  }

  requireDelivery(id: string): Delivery {
    const d = this.getDelivery(id);
    if (!d) throw new ApiError(404, "전달 항목을 찾을 수 없습니다");
    return d;
  }

  private emitMember(memberId: string): void {
    const member = this.getMember(memberId);
    if (member) this.emit({ type: "member", member });
  }

  /** The board scheduler has validated the untouched input and its new scope under
   * its immediate transaction. Preserve the original audit; notify both inboxes. */
  moveBoardClaim(input: Delivery, memberId: string, messageId: string, text: string): Delivery {
    if (!this.db.inTransaction || !input.taskId) throw new Error("Board claim move requires the scheduling transaction");
    const moved = this.db.query(`UPDATE deliveries SET member_id=?,ref_id=?,text=? WHERE id=? AND member_id=?
      AND task_id=? AND status='queued' AND attempts=0 AND ref_id=?`)
      .run(memberId, messageId, text, input.id, input.memberId, input.taskId, input.refId);
    const enrolled = this.db.query("UPDATE task_sequence SET member_id=?,entered_at=? WHERE task_id=? AND member_id=?")
      .run(memberId, nowIso(), input.taskId, input.memberId);
    if (moved.changes !== 1 || enrolled.changes !== 1) throw new ApiError(409, "진행판 배정 상태가 바뀌었습니다");
    this.emitMember(input.memberId);
    this.emitMember(memberId);
    return this.requireDelivery(input.id);
  }

  enqueue(input: NewDelivery): Delivery {
    return this.transaction(() => {
      const member = this.requireMember(input.memberId);
      if (member.projectId !== input.projectId) throw new ApiError(400, "다른 프로젝트의 직원입니다");
      const id = newId("dl_");
      this.run(
        `INSERT INTO deliveries (id, project_id, member_id, kind, text, wake, urgent, status, hold_reason, ref_type, ref_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.projectId,
        input.memberId,
        input.kind,
        input.text,
        (input.wake ?? true) ? 1 : 0,
        input.urgent ? 1 : 0,
        input.status ?? "queued",
        input.holdReason ?? null,
        input.refType ?? null,
        input.refId ?? null,
        nowIso(),
      );
      this.run("UPDATE deliveries SET source_revision = ?, next_attempt_at = ?, task_id = ? WHERE id = ?", input.sourceRevision ?? null, input.nextAttemptAt ?? null,
        input.taskId !== undefined ? this.taskRef(input.projectId, input.taskId) : this.refTask(input.refType ?? null, input.refId ?? null), id);
      this.run("INSERT INTO delivery_recovery (delivery_id, updated_at) VALUES (?, ?)", id, nowIso());
      const taskId = this.deliveryTaskId(id);
      if (taskId && (input.wake ?? true) && ["instruction", "user_message"].includes(input.kind)) {
        this.run("INSERT OR IGNORE INTO task_sequence(member_id, task_id, entered_at) VALUES (?, ?, ?)", member.id, taskId, nowIso());
      }
      if (taskId && (input.wake ?? true) && ["instruction", "user_message"].includes(input.kind) && this.doneMark(taskId)) {
        this.addStageMark({ projectId: input.projectId, taskId, stage: "reopen", evidence: `새 지시 #${id}`, memberId: null, who: "서버" });
      }
      this.emitMember(input.memberId);
      return this.requireDelivery(id);
    });
  }

  /** 아직 전달되지 않은 것(queued·held), 넣은 순서대로. */
  listPending(memberId: string): Delivery[] {
    return this.rows("SELECT * FROM deliveries WHERE member_id = ? AND status IN ('queued','held') ORDER BY rowid", memberId).map(toDelivery);
  }

  listUndeliveredMemberIds({ projectId, skipInactiveHolds = false }: { projectId?: string; skipInactiveHolds?: boolean } = {}): string[] {
    return this.rows(`SELECT member_id FROM deliveries WHERE status IN ('queued','held','delivering')
      ${projectId !== undefined ? "AND project_id = ?" : ""}
      ${skipInactiveHolds ? "AND NOT (status = 'held' AND COALESCE(hold_reason, '') IN ('asleep','runner_disabled'))" : ""}
      GROUP BY member_id ORDER BY MIN(rowid)`, ...(projectId !== undefined ? [projectId] : [])).map(row => row.member_id as string);
  }

  /** 서버 재시작 복구용: 프로젝트 전체의 미전달 + 전달 중이던 것. */
  listUndelivered(projectId?: string): Delivery[] {
    const statuses = "status IN ('queued','held','delivering')";
    const rows = projectId
      ? this.rows(`SELECT * FROM deliveries WHERE project_id = ? AND ${statuses} ORDER BY rowid`, projectId)
      : this.rows(`SELECT * FROM deliveries WHERE ${statuses} ORDER BY rowid`);
    return rows.map(toDelivery);
  }

  /** 그 대상을 가리키는 전달 중 실제로 나간 마지막 글. 체크를 여러 번 풀어도 상대가 지금 무엇을 믿는지 안다. */
  lastDeliveredTextFor(refType: NonNullable<Delivery["refType"]>, refId: string): string | null {
    return (this.row("SELECT text FROM deliveries WHERE ref_type = ? AND ref_id = ? AND status = 'delivered' ORDER BY rowid DESC LIMIT 1", refType, refId)?.text as string | undefined) ?? null;
  }

  /** 서버가 죽기 직전에 넣고 있던 전달(복구 전). */
  listDelivering(): Delivery[] {
    return this.rows("SELECT * FROM deliveries WHERE status = 'delivering' ORDER BY rowid").map(toDelivery);
  }

  /** 아직 나가지 않은 전달을 거둔다. 거둔 수를 돌려준다. */
  cancelPendingFor(refType: NonNullable<Delivery["refType"]>, refId: string): number {
    return this.transaction(() => {
      const rows = this.rows(`SELECT id, member_id FROM deliveries WHERE ref_type = ? AND ref_id = ? AND status IN ('queued','held')
        AND NOT EXISTS (SELECT 1 FROM delivery_recovery r WHERE r.delivery_id = deliveries.id AND r.phase NOT IN ('none','resolved','stopped'))
        AND NOT EXISTS (SELECT 1 FROM delivery_dispatch_items i JOIN delivery_dispatches x ON x.id = i.dispatch_id WHERE i.delivery_id = deliveries.id AND x.transport_state != 'rejected')
        AND NOT EXISTS (SELECT 1 FROM manual_inbox_items i JOIN manual_inbox_batches b ON b.id = i.batch_id WHERE i.delivery_id = deliveries.id AND b.acknowledged_at IS NULL)`, refType, refId);
      for (const r of rows) {
        this.run("DELETE FROM deliveries WHERE id = ?", r.id);
        this.emitMember(r.member_id);
      }
      return rows.length;
    });
  }

  /** 받은 줄 알았는데 턴이 입력을 읽기 전에 끝났다. 대기로 되돌린다. */
  requeueDelivered(id: string): Delivery {
    const d = this.requireDelivery(id);
    this.run("UPDATE deliveries SET status = 'queued', delivered_at = NULL, hold_reason = NULL WHERE id = ?", id);
    this.emitMember(d.memberId);
    return this.requireDelivery(id);
  }

  /** 서버가 죽어 delivering 에 멈춘 것을 되돌린다. 되돌린 수를 돌려준다. */
  requeueDelivering(): number {
    return this.db.query("UPDATE deliveries SET status = 'queued' WHERE status = 'delivering'").run().changes;
  }

  setDeliveryStatus(id: string, status: DeliveryStatus, update: DeliveryUpdate = {}): Delivery {
    return this.transaction(() => {
      const before = this.requireDelivery(id);
      this.run(
        `UPDATE deliveries SET status = ?, wake = ?, hold_reason = ?, last_error = ?, attempts = attempts + ?,
           delivered_at = CASE WHEN ? = 'delivered' THEN COALESCE(delivered_at, ?) ELSE delivered_at END
         WHERE id = ?`,
        status,
        Number(update.wake ?? before.wake),
        status === "held" ? (update.holdReason ?? before.holdReason) : null,
        update.lastError !== undefined ? update.lastError : before.lastError,
        update.attempt ? 1 : 0,
        status,
        nowIso(),
        id,
      );
      this.emitMember(before.memberId);
      return this.requireDelivery(id);
    });
  }

  markDelivered(id: string): Delivery {
    return this.setDeliveryStatus(id, "delivered");
  }

  markHeld(id: string, reason: string): Delivery {
    return this.setDeliveryStatus(id, "held", { holdReason: reason });
  }

  markFailed(id: string, error: string): Delivery {
    return this.setDeliveryStatus(id, "failed", { lastError: error });
  }

  /** 전달 봉투를 턴 키로 사용한다. 대표가 깨운 턴만 배정 확인 대상이다. */
  beginDelegationAck(runId: string, memberId: string, deliveries: Delivery[]): void {
    if (this.requireMember(memberId).kind === "worker") return;
    const sourceIds = deliveries.filter(d => d.wake && (d.kind === "user_message" || d.kind === "answer"))
      .map(d => d.refId ?? d.id).sort();
    const sources = JSON.stringify(sourceIds);
    const posted = this.row("SELECT 1 FROM delegation_ack_turns WHERE member_id = ? AND source_ids = ? AND posted = 1 LIMIT 1", memberId, sources) ? 1 : 0;
    this.run("INSERT OR IGNORE INTO delegation_ack_turns (run_id, member_id, source_ids, posted) VALUES (?, ?, ?, ?)", runId, memberId, sources, posted);
  }

  /** 지시 outbox와 같은 트랜잭션에서 호출한다. 도구 응답 유실에도 배정 사실이 남는다. */
  noteDelegation(memberId: string, delivery: Delivery, queued: boolean, selection?: CommandSelection): void {
    // 맡긴 직원의 보고 의무는 위임으로 마감한다(지시 전달과 같은 트랜잭션).
    this.recordReportClosure({ memberId, kind: "delegated", refType: "delivery", refId: delivery.id }, selection);
    const turn = this.row("SELECT * FROM delegation_ack_turns WHERE member_id = ? AND ended = 0 ORDER BY rowid DESC LIMIT 1", memberId);
    if (!turn || JSON.parse(turn.source_ids).length === 0) return;
    const assignments: { deliveryId: string; memberId: string; name: string; summary: string; queued: boolean }[] = JSON.parse(turn.assignments);
    if (assignments.some(a => a.deliveryId === delivery.id)) return;
    const target = this.requireMember(delivery.memberId);
    const first = delivery.text.split("\n").find(line => line.startsWith("할 일: "))?.slice(5) ?? "";
    const summary = Array.from(cleanText(first).replace(/\s+/g, " ").trim()).slice(0, 60).join("");
    assignments.push({ deliveryId: delivery.id, memberId: target.id, name: target.name, summary, queued });
    this.run("UPDATE delegation_ack_turns SET assignments = ? WHERE run_id = ?", JSON.stringify(assignments), turn.run_id);
  }

  /** ask·post 조회·자동 마지막 글은 post가 아니다. 실제 게시와 원자적으로 기록한다. */
  noteDelegationPost(memberId: string): void {
    this.run("UPDATE delegation_ack_turns SET posted = 1 WHERE member_id = ? AND ended = 0", memberId);
  }

  finishDelegationAck(memberId: string, runId?: string): void {
    this.transaction(() => {
      const turns = runId
        ? this.rows("SELECT * FROM delegation_ack_turns WHERE member_id = ? AND run_id = ? AND ended = 0", memberId, runId)
        : this.rows("SELECT * FROM delegation_ack_turns WHERE member_id = ? AND ended = 0", memberId);
      for (const turn of turns) {
        this.run("UPDATE delegation_ack_turns SET ended = 1 WHERE run_id = ?", turn.run_id);
        const sources: string[] = JSON.parse(turn.source_ids);
        if (turn.posted || !sources.length) continue;
        const assignments: { deliveryId: string; memberId: string; name: string; summary: string; queued: boolean }[] = JSON.parse(turn.assignments);
        // 확정 기동 실패로 취소된 신규 직원의 outbox는 배정으로 알리지 않는다.
        const retained = assignments.filter(a => this.getDelivery(a.deliveryId));
        // 같은 직원에게 여러 번 보냈으면 마지막 지시를 한 줄로 보여 준다.
        for (const assignment of new Map(retained.map(a => [a.memberId, a])).values()) {
          const key = createHash("sha256").update(JSON.stringify([memberId, sources, assignment.memberId])).digest("hex").slice(0, 32);
          this.createMessage({ id: `msg_delegation_ack_${key}`, projectId: this.requireMember(memberId).projectId,
            who: "시스템", kind: "시스템", body: `총괄이 ${assignment.name}에게 맡겼습니다: ${assignment.summary}${assignment.queued ? " (앞 일 끝나면 시작)" : ""}` });
        }
      }
    });
  }

  // ---- 활동 ----
  /** 직원당 최근 MAX_ACTIVITY_PER_MEMBER 개만 남긴다. */
  appendActivity(memberId: string, kind: ActivityKind, text: string, eventKey?: string): Activity {
    return this.transaction(() => {
      if (eventKey !== undefined) {
        const before = this.row("SELECT * FROM activity WHERE delivery_event_key = ?", eventKey);
        if (before) {
          if (before.member_id !== memberId) throw new ApiError(409, "다른 직원의 활동 표식입니다");
          return toActivity(before);
        }
      }
      const member = this.requireMember(memberId);
      const clipped = text.length > MAX_ACTIVITY_TEXT ? `${text.slice(0, MAX_ACTIVITY_TEXT)}…` : text;
      const inserted = this.row("INSERT INTO activity (member_id, at, kind, text, delivery_event_key) VALUES (?, ?, ?, ?, ?) RETURNING *", memberId, nowIso(), kind, clipped, eventKey ?? null)!;
      if (kind === "turn_start" || kind === "turn_end" || kind === "tool" || kind === "tool_result") {
        // updated_at/직원 알림은 건드리지 않는다. 시계가 뒤로 가도 최신 작업 시각을 보존한다.
        this.run("UPDATE members SET last_active_at = ? WHERE id = ? AND (last_active_at IS NULL OR last_active_at < ?)", inserted.at, memberId, inserted.at);
      }
      // 마지막 턴 시작은 남긴다. 긴 턴이 500줄을 넘어도 재시작 뒤 '이번 턴'의 시작을 알아야 보고를 살린다.
      this.run(
        `DELETE FROM activity WHERE member_id = ? AND id <= COALESCE(
           (SELECT id FROM activity WHERE member_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?), 0)
           AND id != COALESCE((SELECT MAX(id) FROM activity WHERE member_id = ? AND kind = 'turn_start'), 0)`,
        memberId,
        memberId,
        MAX_ACTIVITY_PER_MEMBER,
        memberId,
      );
      const activity = toActivity(inserted);
      this.emit({ type: "activity", projectId: member.projectId, activity });
      return activity;
    });
  }

  /** 최신 limit 개를 오래된 → 최신으로. */
  listActivity(memberId: string, limit = 100): Activity[] {
    const n = Math.min(Math.max(limit, 1), MAX_ACTIVITY_PER_MEMBER);
    return this.rows("SELECT * FROM activity WHERE member_id = ? ORDER BY id DESC LIMIT ?", memberId, n).reverse().map(toActivity);
  }

  /** 마지막 턴 시작 시각. 활동이 아무리 쌓여도 찾는다. */
  lastTurnStart(memberId: string): string | null {
    return (this.row("SELECT at FROM activity WHERE member_id = ? AND kind = 'turn_start' ORDER BY id DESC LIMIT 1", memberId)?.at as string | undefined) ?? null;
  }

  /** since 이후에 그 직원이 쓴 글이 있는가(이번 턴에 이미 보고했는가). */
  hasMessageBySince(memberId: string, since: string): boolean {
    return this.row("SELECT 1 FROM messages WHERE member_id = ? AND at >= ? LIMIT 1", memberId, since) !== null;
  }

  /** 대표가 이 프로젝트에서 보낸 글에 그 첨부가 붙어 있는가. 다른 프로젝트의 첨부를 지시로 끌어오지 못하게 한다. */
  isProjectAttachment(projectId: string, attachmentId: string): boolean {
    return this.row("SELECT 1 FROM messages WHERE project_id = ? AND mine = 1 AND attachments LIKE ? LIMIT 1", projectId, `%"${attachmentId}"%`) !== null;
  }

  /** Store 를 거치지 않는 값(herdr 연결 상태 등)을 화면에 알린다. */
  broadcast(event: WsEvent): void {
    this.emit(event);
  }

  // ---- 설정 ----
  getSettings(): Settings {
    const settings: Settings = { ...DEFAULT_SETTINGS };
    for (const r of this.rows("SELECT key, value FROM settings")) {
      if (r.key in settings) (settings as unknown as Record<string, unknown>)[r.key] = JSON.parse(r.value);
    }
    // 나중에 생긴 직급이 저장값에 없어도 칸은 늘 있어야 한다.
    settings.ranks = Object.fromEntries((Object.keys(DEFAULT_RANKS) as Rank[]).map((rank) => [rank, { ...DEFAULT_RANKS[rank], ...settings.ranks[rank] }])) as Settings["ranks"];
    settings.codexRanks = Object.fromEntries((Object.keys(DEFAULT_CODEX_RANKS) as Rank[]).map((rank) => [rank, { ...DEFAULT_CODEX_RANKS[rank], ...settings.codexRanks[rank] }])) as Settings["codexRanks"];
    settings.contextWindows = { ...DEFAULT_CONTEXT_WINDOWS, ...settings.contextWindows };
    // 옛 클라이언트의 표시 설정은 보존된 입력 형식일 뿐, 모든 실행 업무의 확정 기준을 끌 수 없다.
    settings.harnessMode = "required";
    settings.harnessRequiredSince = null;
    return settings;
  }

  patchSettings(patch: SettingsPatch): Settings {
    return this.transaction(() => {
      const before = this.getSettings();
      if (this.runtimeBackend !== "core" && patch.backend) this.runtimeBackend = patch.backend;
      const next: Record<string, unknown> = { ...patch };
      // 기존 label·시점 인자를 보내는 클라이언트도 같은 필수 정책으로 정규화한다.
      if (patch.harnessMode !== undefined || patch.harnessRequiredSince !== undefined) {
        next.harnessMode = "required";
        next.harnessRequiredSince = null;
      }
      if (patch.ranks) {
        next.ranks = Object.fromEntries((Object.keys(DEFAULT_RANKS) as Rank[]).map((rank) => [rank, { ...before.ranks[rank], ...patch.ranks![rank] }]));
      }
      if (patch.codexRanks) {
        next.codexRanks = Object.fromEntries((Object.keys(DEFAULT_CODEX_RANKS) as Rank[]).map((rank) => [rank, { ...before.codexRanks[rank], ...patch.codexRanks![rank] }]));
      }
      this.transaction(() => {
        for (const key of Object.keys(DEFAULT_SETTINGS)) {
          if (next[key] === undefined) continue;
          this.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, JSON.stringify(next[key]));
        }
      });
      if (Object.keys(next).some((key) => next[key] !== undefined && key in DEFAULT_SETTINGS)) this.run("UPDATE domain_revisions SET revision = revision + 1 WHERE domain = 'settings'");
      const settings = this.getSettings();
      this.emit({ type: "settings", settings });
      if (settings.backend !== before.backend) this.emitProjects();
      return settings;
    });
  }

  // ---- 전체 DB 복구 조회: 화면의 50/200/500개 제한을 재사용하지 않는다 ----
  listMessagesMissingDeliveries(projectId?: string): Message[] {
    return this.rows(`SELECT m.* FROM messages m WHERE m.mine = 1 AND m.delivery IN ('queued','held')
      ${projectId === undefined ? "" : "AND m.project_id = ?"}
      AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.ref_type = 'message' AND d.ref_id = m.id)
      ORDER BY m.at COLLATE BINARY, m.id COLLATE BINARY`, ...(projectId === undefined ? [] : [projectId])).map(toMessage);
  }

  listReportsMissingDeliveries(projectId?: string): Message[] {
    return this.rows(`SELECT m.* FROM messages m WHERE m.mine = 0 AND m.member_id IS NOT NULL AND m.kind IN ('완료','진행','막힘','알림')
      AND m.rowid > COALESCE((SELECT legacy_max_rowid FROM report_delivery_tracking WHERE id = 1), 0)
      ${projectId === undefined ? "" : "AND m.project_id = ?"}
      AND NOT EXISTS (SELECT 1 FROM report_references r WHERE r.source_message_id=m.id AND r.board_only=1)
      AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.ref_type = 'message' AND d.ref_id = m.id AND d.kind = 'report')
      ORDER BY m.at COLLATE BINARY, m.id COLLATE BINARY`, ...(projectId === undefined ? [] : [projectId])).map(toMessage);
  }

  listAnswersMissingDeliveries(projectId?: string): Decision[] {
    return this.rows(`SELECT a.* FROM decisions a WHERE a.status = 'answered'
      ${projectId === undefined ? "" : "AND a.project_id = ?"}
      AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.ref_type = 'decision' AND d.ref_id = a.id)
      ORDER BY a.answered_at, a.rowid`, ...(projectId === undefined ? [] : [projectId])).map(toDecision);
  }

  listUnreceivedAnswers(memberId: string): Decision[] {
    const member = this.requireMember(memberId);
    return this.rows("SELECT * FROM decisions WHERE project_id = ? AND member_id = ? AND status = 'answered' AND delivered_at IS NULL ORDER BY answered_at, rowid", member.projectId, memberId).map(toDecision);
  }

  listDeliveries(projectId?: string): Delivery[] {
    if (projectId !== undefined && this.deliveryRead?.projectId === projectId) return this.deliveryRead.rows.map(toDelivery);
    return this.rows(`SELECT * FROM deliveries ${projectId === undefined ? "" : "WHERE project_id = ?"} ORDER BY rowid`, ...(projectId === undefined ? [] : [projectId])).map(toDelivery);
  }

  /** Load only referenced display text, avoiding message-history scans and attachment hydration. */
  deliveryNoticePreviews(projectId: string): Map<string, string> {
    const previews = new Map<string, string>();
    for (const [kind, table, column] of [["message", "messages", "body"], ["decision", "decisions", "title"], ["todo", "todos", "title"]] as const) {
      const rows = this.rows(`SELECT DISTINCT s.id, s.${column} AS preview FROM deliveries d JOIN ${table} s ON s.id = d.ref_id
        WHERE d.project_id = ? AND d.ref_type = ? AND
          (d.status != 'delivered' OR EXISTS (SELECT 1 FROM delivery_recovery r WHERE r.delivery_id = d.id AND r.reason = 'duplicate_draft'))
      `, projectId, kind);
      for (const row of rows) previews.set(`${kind}:${row.id}`, row.preview);
    }
    return previews;
  }

  listUnlinkedFailedMessages(projectId: string): Message[] {
    return this.rows(`SELECT m.* FROM messages m WHERE m.project_id = ? AND m.mine = 1 AND m.delivery = 'failed'
      AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.project_id = m.project_id AND d.ref_type = 'message' AND d.ref_id = m.id)
      ORDER BY m.at COLLATE BINARY DESC, m.id COLLATE BINARY DESC`, projectId).map(toMessage);
  }

  // ---- revision / CAS ----
  settingsRevision(): number {
    return this.row("SELECT revision FROM domain_revisions WHERE domain = 'settings'")!.revision;
  }

  memberRevisions(memberId: string): MemberRevisions {
    this.requireMember(memberId);
    const r = this.row("SELECT config_revision, session_generation FROM members WHERE id = ?", memberId)!;
    return { configRevision: r.config_revision, sessionGeneration: r.session_generation };
  }

  todoRevision(id: string): number {
    this.requireTodo(id);
    return this.row("SELECT revision FROM todos WHERE id = ?", id)!.revision;
  }

  syncRevisions(projectId: string): SyncRevisions {
    this.requireProject(projectId);
    return { settings: this.settingsRevision(), members: Object.fromEntries(this.rows("SELECT id, config_revision, session_generation FROM active_members WHERE project_id = ?", projectId).map((r) => [r.id, { configRevision: r.config_revision, sessionGeneration: r.session_generation }])), todos: Object.fromEntries(this.rows("SELECT id, revision FROM todos WHERE project_id = ?", projectId).map((r) => [r.id, r.revision])) };
  }

  private checkRevision(actual: number, expected: number): void {
    if (!Number.isSafeInteger(expected) || expected < 0) throw new ApiError(400, "revision이 올바르지 않습니다");
    if (actual !== expected) throw new ApiError(409, "내용이 변경되었습니다. 다시 검토해 주세요", "REVISION_CONFLICT");
  }

  patchSettingsCas(patch: SettingsPatch, expectedRevision: number): { settings: Settings; revision: number } {
    return this.transaction(() => {
      this.checkRevision(this.settingsRevision(), expectedRevision);
      const settings = this.patchSettings(patch);
      return { settings, revision: this.settingsRevision() };
    });
  }

  patchMemberCas(id: string, patch: MemberPatch, expectedRevision: number): { member: Member } & MemberRevisions {
    return this.transaction(() => {
      this.checkRevision(this.memberRevisions(id).configRevision, expectedRevision);
      const member = this.patchMember(id, patch);
      return { member, ...this.memberRevisions(id) };
    });
  }

  setTodoDoneCas(id: string, done: boolean, expectedRevision: number): { todo: Todo; revision: number } {
    return this.transaction(() => {
      this.checkRevision(this.todoRevision(id), expectedRevision);
      const { todo } = this.setTodoDone(id, done);
      return { todo, revision: this.todoRevision(id) };
    });
  }

  // ---- 작업 영수증: 같은 ID/요청만 합치고 결과에는 내부 요청을 싣지 않는다 ----
  getOperation(operationId: string): OperationReceipt | null {
    const r = this.row("SELECT * FROM operation_receipts WHERE operation_id = ?", operationId);
    if (!r) return null;
    const base = { operationId: r.operation_id, kind: r.kind, projectId: r.project_id, memberId: r.member_id, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at };
    return { ...base, ...(r.status === "applied" ? { result: json(r.result_json) } : r.status === "pending" ? {} : { code: r.code, error: r.error }) } as OperationReceipt;
  }

  beginOperation(input: { operationId: string; kind: OperationKind; projectId: string | null; memberId: string | null; request: unknown }): OperationReceipt {
    return this.transaction(() => {
      if (input.projectId !== null) this.requireProject(input.projectId);
      if (input.memberId !== null && this.requireMember(input.memberId).projectId !== input.projectId) throw new ApiError(400, "다른 프로젝트의 직원입니다");
      const r = this.row("SELECT * FROM operation_receipts WHERE operation_id = ?", input.operationId);
      if (r) {
        if (r.kind !== input.kind || r.project_id !== input.projectId || r.member_id !== input.memberId || r.request_json !== stableJson(input.request)) throw new ApiError(409, "다른 요청에 사용된 operationId입니다", "OPERATION_CONFLICT");
        return this.getOperation(input.operationId)!;
      }
      const at = nowIso();
      this.run("INSERT INTO operation_receipts (operation_id, kind, project_id, member_id, status, request_json, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)", input.operationId, input.kind, input.projectId, input.memberId, stableJson(input.request), at, at);
      return this.getOperation(input.operationId)!;
    });
  }

  finishOperation(receipt: OperationReceipt, expectedStatus: OperationStatus = "pending"): OperationReceipt {
    return this.transaction(() => {
      const before = this.getOperation(receipt.operationId);
      if (!before) throw new ApiError(404, "작업을 찾을 수 없습니다");
      if (before.kind !== receipt.kind || before.projectId !== receipt.projectId || before.memberId !== receipt.memberId) throw new ApiError(409, "작업 범위가 다릅니다");
      if (before.status !== expectedStatus || before.status === "applied" || before.status === "refused") throw new ApiError(409, "작업 결과가 변경되었습니다", "OPERATION_CONFLICT");
      this.run("UPDATE operation_receipts SET status = ?, result_json = ?, code = ?, error = ?, updated_at = ? WHERE operation_id = ? AND status = ?", receipt.status, receipt.status === "applied" ? JSON.stringify(receipt.result) : null, receipt.status === "unknown" || receipt.status === "refused" ? receipt.code : null, receipt.status === "unknown" || receipt.status === "refused" ? receipt.error : null, nowIso(), receipt.operationId, expectedStatus);
      return this.getOperation(receipt.operationId)!;
    });
  }

  listPendingOperations(): OperationReceipt[] {
    return this.rows("SELECT operation_id FROM operation_receipts WHERE status = 'pending' ORDER BY created_at, rowid").map((r) => this.getOperation(r.operation_id)!);
  }

  agentOperation<T>(memberId: string, toolName: string, operationId: string, request: unknown, execute: () => T): T {
    return this.transaction(() => {
      const member = this.requireMember(memberId);
      const r = this.row("SELECT * FROM agent_operation_receipts WHERE operation_id = ?", operationId);
      if (r) {
        this.checkAgentRequest(r, memberId, member.projectId, toolName, request);
        return decodeAgentResult<T>(this.db, member.projectId, r.result_kind, r.result_json);
      }
      const result = execute();
      if (result instanceof Promise) throw new Error("agentOperation requires synchronous Store writes");
      this.insertAgentReceipt(memberId, member.projectId, toolName, operationId, request, result, "completed");
      return result;
    });
  }

  private checkAgentRequest(row: Row, memberId: string, projectId: string, tool: string, request: unknown): void {
    if (row.member_id !== memberId || row.project_id !== projectId || row.tool_name !== tool || decodeStoredText(row.request_json) !== stableJson(request)) {
      throw new ApiError(409, "다른 요청에 사용된 operationId입니다", "OPERATION_CONFLICT");
    }
  }

  private insertAgentReceipt(memberId: string, projectId: string, tool: string, operationId: string, request: unknown, result: unknown, state: AgentReceiptState): void {
    const canonical = stableJson(request), at = nowIso();
    const encoded = encodeAgentResult(this.db, projectId, tool, request, result);
    this.run("INSERT INTO agent_operation_receipts (operation_id,member_id,project_id,tool_name,request_json,request_sha256,result_json,result_kind,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      operationId, memberId, projectId, tool, encodeStoredText(canonical), agentRequestHash(canonical), encoded.value, encoded.kind, state, at, at);
  }

  reserveAgentOperation<T>(memberId: string, tool: string, operationId: string, request: unknown, pending: T): { created: boolean; state: AgentReceiptState; result: T } {
    return this.transaction(() => {
      const member = this.requireMember(memberId);
      const row = this.row("SELECT * FROM agent_operation_receipts WHERE operation_id = ?", operationId);
      if (row) {
        this.checkAgentRequest(row, memberId, member.projectId, tool, request);
        return { created: false, state: row.state, result: decodeAgentResult<T>(this.db, member.projectId, row.result_kind, row.result_json) };
      }
      this.insertAgentReceipt(memberId, member.projectId, tool, operationId, request, pending, "reserved");
      return { created: true, state: "reserved", result: pending };
    });
  }

  completeAgentOperation<T>(memberId: string, tool: string, operationId: string, request: unknown, result: T): T {
    return this.transaction(() => {
      const member = this.requireMember(memberId);
      const row = this.row("SELECT * FROM agent_operation_receipts WHERE operation_id = ?", operationId);
      if (!row) throw new ApiError(409, "도구 실행 예약을 찾을 수 없습니다");
      this.checkAgentRequest(row, memberId, member.projectId, tool, request);
      if (row.state === "completed") return decodeAgentResult<T>(this.db, member.projectId, row.result_kind, row.result_json);
      const encoded = encodeAgentResult(this.db, member.projectId, tool, request, result);
      this.run("UPDATE agent_operation_receipts SET result_json = ?, result_kind = ?, state = 'completed', updated_at = ? WHERE operation_id = ? AND state = 'reserved'", encoded.value, encoded.kind, nowIso(), operationId);
      return result;
    });
  }

  // ---- 대표가 직원 CLI 창에 낸 답의 영수증(결재함·대화 카드) ----
  // 서버 소유 namespace 'native-answer:' 로 agent_operation_receipts 에 둔다(외부 operationId 에는 ':'가 없다). 새 표·판 올림 없이
  // 서버를 다시 띄운 뒤에도 같은 operationId 는 처음 결과만 돌려준다. 넣기 전에 대기 행을 먼저 적어, 결과를 모르는 행은 '모름'으로 남긴다.
  private static readonly NATIVE_ANSWER = "owner_native_answer";

  /** 같은 operationId 의 영수증. 다른 직원·프로젝트·요청에 쓴 id 면 409. 처음이면 null. pending 은 결과를 적기 전에 멈춘 행이다. */
  getNativeAnswer(input: { operationId: string; projectId: string; memberId: string; request: unknown }): { pending: true } | { pending: false; receipt: unknown } | null {
    const r = this.row("SELECT * FROM agent_operation_receipts WHERE operation_id = ?", `native-answer:${input.operationId}`);
    if (!r) return null;
    if (r.tool_name !== Store.NATIVE_ANSWER || r.member_id !== input.memberId || r.project_id !== input.projectId || r.request_json !== stableJson(input.request)) {
      throw new ApiError(409, "다른 요청에 쓴 operationId 입니다", "OPERATION_CONFLICT");
    }
    const value = json<{ pending?: boolean; receipt?: unknown }>(r.result_json);
    return value.pending ? { pending: true } : { pending: false, receipt: value.receipt };
  }

  /** 넣기 전에 대기 행을 적는다. 이미 있으면 false(먼저 getNativeAnswer 로 본다). */
  beginNativeAnswer(input: { operationId: string; projectId: string; memberId: string; request: unknown }): boolean {
    return this.transaction(() => {
      if (this.row("SELECT 1 FROM agent_operation_receipts WHERE operation_id = ?", `native-answer:${input.operationId}`)) return false;
      this.run("INSERT INTO agent_operation_receipts (operation_id, member_id, project_id, tool_name, request_json, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        `native-answer:${input.operationId}`, input.memberId, input.projectId, Store.NATIVE_ANSWER, stableJson(input.request), JSON.stringify({ pending: true }), nowIso());
      return true;
    });
  }

  finishNativeAnswer(operationId: string, receipt: unknown): void {
    this.run("UPDATE agent_operation_receipts SET result_json = ? WHERE operation_id = ? AND tool_name = ?", JSON.stringify({ pending: false, receipt }), `native-answer:${operationId}`, Store.NATIVE_ANSWER);
  }

  /** 외부 operation ID에는 ':'가 없어 이 서버 소유 관찰 namespace를 만들 수 없다. */
  codeReads(scope: CodeReadScope): CodeReadObservation[] {
    return this.rows("SELECT operation_id, result_json FROM agent_operation_receipts WHERE project_id = ? AND member_id = ? AND tool_name = ? AND request_sha256 = ? AND operation_id LIKE 'code-read:%' ORDER BY rowid DESC LIMIT 129",
      scope.projectId, scope.memberId, CODE_READ_KIND, agentRequestHash(stableJson(scope))).flatMap(r => {
        try {
          const value = json<unknown>(r.result_json);
          return validCodeRead(value, scope) && value.id === r.operation_id ? [value] : [];
        } catch { return []; }
      });
  }

  saveCodeRead(scope: CodeReadScope, observation: CodeReadObservation): CodeReadObservation {
    if (this.codeReads(scope).length >= 128) throw new ApiError(429, "이 계약의 코드 열람 관찰 한도에 도달했습니다");
    if (!validCodeRead(observation, scope) || this.requireMember(scope.memberId).projectId !== scope.projectId) throw new ApiError(403, "코드 열람 관찰의 범위가 맞지 않습니다");
    return this.agentOperation(scope.memberId, CODE_READ_KIND, observation.id, scope, () => observation);
  }

  // ---- lease / 입력 fence ----
  saveLease(lease: TerminalLease): void {
    this.transaction(() => {
      this.checkRevision(this.memberRevisions(lease.memberId).sessionGeneration, lease.identity.sessionGeneration);
      const r = this.row("SELECT * FROM terminal_leases WHERE member_id = ?", lease.memberId);
      if (r && r.expires_at > Date.now() && (r.claim_id !== lease.claimId || r.lease_id !== lease.leaseId || r.terminal_identity_json !== stableJson(lease.identity))) throw new ApiError(409, "다른 조작권이 있습니다");
      if (r && r.claim_id === lease.claimId && lease.lastInputSequence < r.last_input_sequence) throw new ApiError(409, "입력 순번이 오래되었습니다");
      this.run(`INSERT INTO terminal_leases (member_id, claim_id, lease_id, generation, terminal_identity_json, expires_at, last_input_sequence) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(member_id) DO UPDATE SET claim_id = excluded.claim_id, lease_id = excluded.lease_id, generation = excluded.generation, terminal_identity_json = excluded.terminal_identity_json, expires_at = excluded.expires_at, last_input_sequence = excluded.last_input_sequence`, lease.memberId, lease.claimId, lease.leaseId, lease.identity.sessionGeneration, stableJson(lease.identity), lease.expiresAt, lease.lastInputSequence);
    });
  }

  removeLease(memberId: string, claimId: string): void {
    this.run("DELETE FROM terminal_leases WHERE member_id = ? AND claim_id = ?", memberId, claimId);
  }

  activeTerminalLease(memberId: string, generation: number): TerminalLease | null {
    const r = this.row("SELECT * FROM terminal_leases WHERE member_id = ? AND generation = ? AND expires_at > ?", memberId, generation, Date.now());
    return r ? { memberId, claimId: r.claim_id, leaseId: r.lease_id, identity: json(r.terminal_identity_json), expiresAt: r.expires_at, lastInputSequence: r.last_input_sequence } : null;
  }

  inputState(memberId: string): RunnerRecoveryState {
    const lease = this.activeTerminalLease(memberId, this.memberRevisions(memberId).sessionGeneration);
    // Select before hydrating large wire texts. Old generations can still hold a physical fence.
    const unresolvedDispatches = this.rows(`SELECT d.id FROM delivery_dispatches d WHERE d.member_id = ? AND (
      d.transport_state IN ('prepared', 'write_started', 'unknown') OR EXISTS (
        SELECT 1 FROM delivery_dispatch_items i JOIN delivery_recovery r ON r.delivery_id = i.delivery_id
        WHERE i.dispatch_id = d.id AND r.phase NOT IN ('none', 'resolved', 'stopped')
      )) ORDER BY d.created_at, d.rowid`, memberId).map(d => this.getDispatch(d.id)!);
    return { lease, unresolvedDispatches };
  }

  // ---- 전달 복구 CAS / 봉투 ----
  getDeliveryRecovery(deliveryId: string): DeliveryRecoveryRecord | null {
    const r = this.deliveryRead?.byId.has(deliveryId) ? this.deliveryRead.recoveries.get(deliveryId) : this.row("SELECT * FROM delivery_recovery WHERE delivery_id = ?", deliveryId);
    return r ? { deliveryId, marker: r.marker, phase: r.phase, reason: r.reason, version: r.version, autoAttempts: r.auto_attempts, checkCount: r.check_count, activeCheckMs: r.active_check_ms, nextCheckAt: r.next_check_at, lastCheckedAt: r.last_checked_at, evidence: json(r.evidence_json), updatedAt: r.updated_at } : null;
  }

  updateDeliveryRecovery(deliveryId: string, expectedVersion: number, patch: Partial<Omit<DeliveryRecoveryRecord, "deliveryId" | "version" | "updatedAt">>): DeliveryRecoveryRecord {
    return this.transaction(() => {
      this.requireDelivery(deliveryId);
      const before = this.getDeliveryRecovery(deliveryId);
      if (!before) throw new ApiError(404, "전달 복구 상태를 찾을 수 없습니다");
      this.checkRevision(before.version, expectedVersion);
      if (before.marker !== null && patch.marker !== undefined && patch.marker !== before.marker) throw new ApiError(409, "저장된 전달 표식은 바꿀 수 없습니다");
      const { set, values } = buildSet({ ...patch, evidence: patch.evidence === undefined ? undefined : JSON.stringify(patch.evidence) }, { marker: "marker", phase: "phase", reason: "reason", autoAttempts: "auto_attempts", checkCount: "check_count", activeCheckMs: "active_check_ms", nextCheckAt: "next_check_at", lastCheckedAt: "last_checked_at", evidence: "evidence_json" });
      this.run(`UPDATE delivery_recovery SET ${[...set, "version = version + 1", "updated_at = ?"].join(", ")} WHERE delivery_id = ? AND version = ?`, ...values, nowIso(), deliveryId, expectedVersion);
      return this.getDeliveryRecovery(deliveryId)!;
    });
  }

  listDeliveryRecoveries(projectId?: string): DeliveryRecoveryRecord[] {
    return this.rows(`SELECT r.delivery_id FROM delivery_recovery r JOIN deliveries d ON d.id = r.delivery_id ${projectId === undefined ? "" : "WHERE d.project_id = ?"} ORDER BY d.rowid`, ...(projectId === undefined ? [] : [projectId])).map((r) => this.getDeliveryRecovery(r.delivery_id)!);
  }

  saveDispatch(dispatch: DeliveryDispatch): void {
    this.transaction(() => {
      if (this.requireMember(dispatch.memberId).projectId !== dispatch.projectId) throw new ApiError(400, "다른 프로젝트의 직원입니다");
      this.checkRevision(this.memberRevisions(dispatch.memberId).sessionGeneration, dispatch.identity.sessionGeneration);
      if (this.getDispatch(dispatch.dispatchId)) throw new ApiError(409, "이미 저장된 봉투입니다");
      if (!dispatch.items.length || dispatch.items.length !== dispatch.markers.length) throw new ApiError(400, "봉투 항목이 올바르지 않습니다");
      if (createHash("sha256").update(dispatch.wireText).digest("hex") !== dispatch.wireSha256) throw new ApiError(400, "봉투의 해시가 다릅니다");
      const at = dispatch.createdAt;
      this.run(`INSERT INTO delivery_dispatches (id, project_id, member_id, bundle_marker, cli, backend, generation, native_session_id, terminal_identity_json, baseline_json, wire_text, wire_sha256, transport_state, submit_attempts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, dispatch.dispatchId, dispatch.projectId, dispatch.memberId, dispatch.bundleMarker, dispatch.cli, dispatch.backend, dispatch.identity.sessionGeneration, dispatch.identity.sessionId, JSON.stringify(dispatch.identity), JSON.stringify(dispatch.baseline), dispatch.wireText, dispatch.wireSha256, dispatch.transportState, dispatch.submitAttempts, at, dispatch.updatedAt);
      for (const item of dispatch.items) {
        const delivery = this.requireDelivery(item.deliveryId);
        const marker = dispatch.markers.find((m) => m.deliveryId === item.deliveryId)?.marker;
        if (delivery.memberId !== dispatch.memberId || delivery.projectId !== dispatch.projectId || !marker) throw new ApiError(400, "봉투 항목의 대상이 다릅니다");
        this.run("INSERT INTO delivery_dispatch_items (dispatch_id, delivery_id, ordinal, source_revision) VALUES (?, ?, ?, ?)", dispatch.dispatchId, item.deliveryId, item.ordinal, item.sourceRevision);
        this.updateDeliveryRecovery(item.deliveryId, this.getDeliveryRecovery(item.deliveryId)!.version, { marker });
      }
    });
  }

  getDispatch(id: string): DeliveryDispatch | null {
    const r = this.row("SELECT * FROM delivery_dispatches WHERE id = ?", id);
    if (!r) return null;
    const items = this.rows("SELECT i.*, r.marker FROM delivery_dispatch_items i JOIN delivery_recovery r ON r.delivery_id = i.delivery_id WHERE dispatch_id = ? ORDER BY ordinal", id);
    return { dispatchId: id, projectId: r.project_id, memberId: r.member_id, cli: r.cli, backend: r.backend, bundleMarker: r.bundle_marker, identity: json(r.terminal_identity_json), baseline: json(r.baseline_json), wireText: r.wire_text, wireSha256: r.wire_sha256, transportState: r.transport_state, submitAttempts: r.submit_attempts, createdAt: r.created_at, updatedAt: r.updated_at, items: items.map((i) => ({ deliveryId: i.delivery_id, ordinal: i.ordinal, sourceRevision: i.source_revision })), markers: items.map((i) => ({ deliveryId: i.delivery_id, marker: i.marker })) };
  }

  listDispatches(memberId: string): DeliveryDispatch[] {
    return this.rows("SELECT id FROM delivery_dispatches WHERE member_id = ? ORDER BY created_at, rowid", memberId).map((r) => this.getDispatch(r.id)!);
  }

  listDeliveryDispatches(deliveryId: string): DeliveryDispatch[] {
    return this.rows(`SELECT d.id FROM delivery_dispatches d JOIN delivery_dispatch_items i ON i.dispatch_id = d.id
      WHERE i.delivery_id = ? ORDER BY d.created_at, d.rowid`, deliveryId).map(r => this.getDispatch(r.id)!);
  }

  physicalDeliveryIds(): string[] {
    return this.rows(`SELECT DISTINCT i.delivery_id FROM delivery_dispatches d JOIN delivery_dispatch_items i ON i.dispatch_id = d.id
      WHERE d.transport_state IN ('prepared', 'write_started', 'unknown')`).map(r => r.delivery_id);
  }

  hasLogicalDeliveryFence(memberId: string): boolean {
    return this.row(`SELECT 1 FROM deliveries d LEFT JOIN delivery_recovery r ON r.delivery_id = d.id WHERE d.member_id = ? AND
      (r.delivery_id IS NULL OR r.phase NOT IN ('none', 'resolved', 'stopped') OR
        (r.phase = 'none' AND (d.status = 'delivering' OR (d.status = 'held' AND d.hold_reason = 'delivery_unknown')))) LIMIT 1`, memberId) !== null;
  }

  updateDispatch(id: string, expected: DeliveryDispatch["transportState"], state: DeliveryDispatch["transportState"], submit = false): DeliveryDispatch {
    return this.transaction(() => {
      const result = this.db.query("UPDATE delivery_dispatches SET transport_state = ?, submit_attempts = submit_attempts + ?, updated_at = ? WHERE id = ? AND transport_state = ? AND submit_attempts + ? <= 1").run(state, submit ? 1 : 0, nowIso(), id, expected, submit ? 1 : 0);
      if (result.changes !== 1) throw new ApiError(409, "봉투 상태가 변경되었습니다");
      return this.getDispatch(id)!;
    });
  }

  /** A stopped phase alone is insufficient. Bind the actual stop receipts to every original input. */
  explicitlyStoppedStart(run: ExecutionJournal): DeliveryDispatch | null {
    if (run.phase !== "starting" || run.turn !== null || run.inputReceivedAt || run.startedAt || run.lastProgressAt ||
        run.endedAt || run.result || !run.deliveryIds.length) return null;
    const dispatch = this.getDispatch(run.runId);
    if (!dispatch || dispatch.memberId !== run.memberId || dispatch.projectId !== run.projectId || dispatch.backend !== "core" ||
        !["write_started", "unknown"].includes(dispatch.transportState) || stableJson(dispatch.identity) !== stableJson(run.identity) ||
        dispatch.baseline.turn == null || dispatch.items.length !== run.deliveryIds.length ||
        !dispatch.items.every((item, index) => item.deliveryId === run.deliveryIds[index])) return null;

    const stopped = this.row(`SELECT COUNT(*) AS count FROM delivery_dispatch_items i
      JOIN deliveries d ON d.id=i.delivery_id JOIN delivery_recovery r ON r.delivery_id=i.delivery_id
      WHERE i.dispatch_id=? AND d.member_id=? AND d.project_id=? AND d.status='failed' AND r.phase='stopped'
        AND EXISTS (SELECT 1 FROM delivery_recovery_operations o WHERE o.delivery_id=d.id AND o.created_at>=?
          AND json_extract(o.request_json,'$.action')='stop_retry'
          AND json_extract(o.request_json,'$.operationId')=o.operation_id
          AND json_extract(o.result_json,'$.deliveryId')=d.id AND json_extract(o.result_json,'$.operationId')=o.operation_id
          AND json_extract(o.result_json,'$.outcome')='stopped'
          AND json_extract(o.result_json,'$.committedVersion')=json_extract(o.request_json,'$.expectedVersion')+1
          AND json_extract(o.result_json,'$.committedVersion')<=r.version)
      `, dispatch.dispatchId, run.memberId, run.projectId, dispatch.createdAt);
    if (stopped?.count !== dispatch.items.length) return null;
    // A later execution on this terminal makes attribution to this baseline uncertain.
    const later = this.row(`SELECT 1 FROM execution_journal WHERE member_id=? AND generation=? AND
      rowid>(SELECT rowid FROM execution_journal WHERE run_id=?) LIMIT 1`, run.memberId, run.identity.sessionGeneration, run.runId);
    return later ? null : dispatch;
  }

  deliveryRecoveryOperation<T>(deliveryId: string, operationId: string, request: unknown, execute: () => T): T {
    return this.transaction(() => {
      this.requireDelivery(deliveryId);
      const r = this.row("SELECT * FROM delivery_recovery_operations WHERE operation_id = ?", operationId);
      if (r) {
        if (r.delivery_id !== deliveryId || r.request_json !== stableJson(request)) throw new ApiError(409, "다른 요청에 사용된 operationId입니다");
        return json<T>(r.result_json);
      }
      const result = execute();
      if (result instanceof Promise) throw new Error("deliveryRecoveryOperation requires synchronous Store writes");
      this.run("INSERT INTO delivery_recovery_operations (operation_id, delivery_id, request_json, result_json, created_at) VALUES (?, ?, ?, ?, ?)", operationId, deliveryId, stableJson(request), JSON.stringify(result), nowIso());
      return result;
    });
  }

  getDeliveryRetry(id: string): DeliveryRetryState {
    this.requireDelivery(id);
    const r = this.deliveryRead?.byId.get(id) ?? this.row("SELECT * FROM deliveries WHERE id = ?", id)!;
    return { nextAttemptAt: r.next_attempt_at, sourceRevision: r.source_revision, retryScope: r.retry_scope, retryReason: r.retry_reason, correctionRevision: r.correction_revision };
  }

  deliveryRetryDue(memberId: string, backend: Backend): number {
    const retries = this.rows(`SELECT next_attempt_at FROM deliveries WHERE next_attempt_at IS NOT NULL AND
      ((member_id = ? AND status IN ('queued', 'held')) OR retry_scope IN (?, ?))`, memberId, `member:${memberId}`, `backend:${backend}`);
    return retries.reduce((due, r) => r.next_attempt_at ? Math.max(due, Date.parse(r.next_attempt_at)) : due, 0);
  }

  /** A successful observation or an explicit retry releases only the provider cooldown. */
  clearProviderRetry(memberId: string): void {
    this.run(`UPDATE deliveries SET next_attempt_at = NULL, retry_scope = NULL, retry_reason = NULL
      WHERE member_id = ? AND retry_scope = ? AND retry_reason IN ('processing_quota', 'processing_auth')`, memberId, `member:${memberId}`);
  }

  patchDeliveryRetry(id: string, patch: Partial<DeliveryRetryState>): void {
    this.requireDelivery(id);
    const { set, values } = buildSet(patch, { nextAttemptAt: "next_attempt_at", sourceRevision: "source_revision", retryScope: "retry_scope", retryReason: "retry_reason", correctionRevision: "correction_revision" });
    if (set.length) this.run(`UPDATE deliveries SET ${set.join(", ")} WHERE id = ?`, ...values, id);
  }

  // ---- lifecycle / execution journal ----
  saveLifecycleJournal(entry: LifecycleJournal): void {
    this.transaction(() => {
      const before = this.getLifecycleJournal(entry.operationId);
      if (before && (before.memberId !== entry.memberId || before.projectId !== entry.projectId || before.intent !== entry.intent || before.identity.sessionGeneration !== entry.identity.sessionGeneration)) throw new ApiError(409, "종료/생성 의도의 신원이 다릅니다");
      if (before && ["confirmed", "refused"].includes(before.phase) && stableJson(before) !== stableJson(entry)) throw new ApiError(409, "이미 끝난 생성/종료 의도입니다");
      this.run(`INSERT INTO lifecycle_journal (operation_id, member_id, project_id, intent, phase, generation, terminal_identity_json, run_id, delivery_ids_json, baseline_json, reason, exit_code, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(operation_id) DO UPDATE SET phase = excluded.phase, terminal_identity_json = excluded.terminal_identity_json, run_id = excluded.run_id, delivery_ids_json = excluded.delivery_ids_json, baseline_json = excluded.baseline_json, reason = excluded.reason, exit_code = excluded.exit_code, updated_at = excluded.updated_at`, entry.operationId, entry.memberId, entry.projectId, entry.intent, entry.phase, entry.identity.sessionGeneration, JSON.stringify(entry.identity), entry.runId, JSON.stringify(entry.deliveryIds), entry.baseline === null ? null : JSON.stringify(entry.baseline), entry.reason, entry.exitCode, entry.createdAt, entry.updatedAt);
    });
  }

  getLifecycleJournal(operationId: string): LifecycleJournal | null {
    const r = this.row("SELECT * FROM lifecycle_journal WHERE operation_id = ?", operationId);
    return r ? { operationId, memberId: r.member_id, projectId: r.project_id, intent: r.intent, phase: r.phase, identity: json(r.terminal_identity_json), runId: r.run_id, deliveryIds: json(r.delivery_ids_json), baseline: r.baseline_json === null ? null : json(r.baseline_json), reason: r.reason, exitCode: r.exit_code, createdAt: r.created_at, updatedAt: r.updated_at } : null;
  }

  listPendingLifecycleJournals(): LifecycleJournal[] {
    return this.rows("SELECT operation_id FROM lifecycle_journal WHERE phase IN ('prepared','started','unknown') ORDER BY created_at, rowid").map((r) => this.getLifecycleJournal(r.operation_id)!);
  }

  saveExecutionJournal(entry: ExecutionJournal): void {
    this.transaction(() => {
      const before = this.getExecutionJournal(entry.runId);
      if (before && (before.memberId !== entry.memberId || before.projectId !== entry.projectId || before.identity.sessionGeneration !== entry.identity.sessionGeneration)) throw new ApiError(409, "실행 신원이 다릅니다");
      if (before && (before.phase === "ended" || before.phase === "interrupted") && stableJson(before) !== stableJson(entry)) throw new ApiError(409, "이미 끝난 실행입니다");
      this.run(`INSERT INTO execution_journal (run_id, member_id, project_id, generation, terminal_identity_json, turn, delivery_ids_json, phase, input_received_at, started_at, last_progress_at, ended_at, result, reason, exit_code, interruption_notified_at, report_requested_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET terminal_identity_json = excluded.terminal_identity_json, turn = excluded.turn, delivery_ids_json = excluded.delivery_ids_json, phase = excluded.phase, input_received_at = excluded.input_received_at, started_at = excluded.started_at, last_progress_at = excluded.last_progress_at, ended_at = excluded.ended_at, result = excluded.result, reason = excluded.reason, exit_code = excluded.exit_code, updated_at = excluded.updated_at`, entry.runId, entry.memberId, entry.projectId, entry.identity.sessionGeneration, JSON.stringify(entry.identity), entry.turn, JSON.stringify(entry.deliveryIds), entry.phase, entry.inputReceivedAt, entry.startedAt, entry.lastProgressAt, entry.endedAt, entry.result, entry.reason, entry.exitCode, entry.interruptionNotifiedAt, entry.reportRequestedAt, entry.createdAt, entry.updatedAt);
    });
  }

  getExecutionJournal(runId: string): ExecutionJournal | null {
    const r = this.row("SELECT * FROM execution_journal WHERE run_id = ?", runId);
    return r ? { runId, memberId: r.member_id, projectId: r.project_id, identity: json(r.terminal_identity_json), turn: r.turn, deliveryIds: json(r.delivery_ids_json), phase: r.phase, inputReceivedAt: r.input_received_at, startedAt: r.started_at, lastProgressAt: r.last_progress_at, endedAt: r.ended_at, result: r.result, reason: r.reason, exitCode: r.exit_code, interruptionNotifiedAt: r.interruption_notified_at, reportRequestedAt: r.report_requested_at, createdAt: r.created_at, updatedAt: r.updated_at } : null;
  }

  listPendingExecutions(): ExecutionJournal[] {
    return this.rows("SELECT run_id FROM execution_journal WHERE phase NOT IN ('ended','interrupted') ORDER BY created_at, rowid").map((r) => this.getExecutionJournal(r.run_id)!);
  }

  claimExecutionNotice(runId: string, kind: "interruption" | "report", write: () => void): boolean {
    return this.transaction(() => {
      const column = kind === "interruption" ? "interruption_notified_at" : "report_requested_at";
      if (this.db.query(`UPDATE execution_journal SET ${column} = ? WHERE run_id = ? AND ${column} IS NULL`).run(nowIso(), runId).changes !== 1) return false;
      write();
      return true;
    });
  }

  /** 이 보고 원본을 확인한 글(about_message_id). 작성 순서대로. */
  listMessagesAbout(projectId: string, messageId: string): Message[] {
    return this.rows("SELECT * FROM messages WHERE project_id = ? AND about_message_id = ? ORDER BY at COLLATE BINARY, id COLLATE BINARY", projectId, messageId).map(toMessage);
  }

  // ---- 공통 하네스: 업무 계약·검사 기록 ----
  /** 업무의 지금 계약(가장 높은 판). 없으면 null. */
  getTaskContract(taskId: string): TaskContract | null {
    const r = this.row("SELECT * FROM task_contracts WHERE task_id = ? ORDER BY rev DESC LIMIT 1", taskId);
    return r ? projectMainContract(this, taskId, toContract(r)) : null;
  }

  /**
   * 업무가 따르는 계약: 자기 계약, 없으면 가장 가까운 위 업무(parent)의 계약. 갈래 업무를 새로 만들어
   * 위 업무의 계약을 비켜 가지 못하게 한다. 돌아온 계약의 taskId 는 계약이 붙은 업무다.
   */
  getEffectiveContract(taskId: string, reportId?: string): TaskContract | null {
    const seen = new Set<string>();
    let id: string | null | undefined = taskId;
    let pending: TaskContract | null = null;
    while (id && !seen.has(id) && seen.size < 32) {
      seen.add(id);
      // 최신 제안과 현재 확정 판은 다르다. 제안만으로 기존 확정 판/부모 계약을 가릴 수 없다.
      const bound = this.row("SELECT * FROM task_contracts WHERE task_id = ? AND (author_kind <> 'worker' OR confirmed_at IS NOT NULL) ORDER BY rev DESC LIMIT 1", id);
      if (bound) return projectMainContract(this, taskId, toContract(bound), reportId);
      pending ??= this.getTaskContract(id);
      id = this.getTask(id)?.parentTaskId ?? null;
    }
    return pending;
  }

  /** 계약을 새 판으로 남긴다. 옛 판은 지우지 않는다(어느 판으로 일했는지 검사 기록이 가리킨다). */
  saveTaskContract(taskId: string, input: ContractInput, by: { author: string; authorMemberId: string | null; authorKind: ContractAuthorKind; sourceMessageId?: string | null }): TaskContract {
    this.requireTask(taskId);
    return this.transaction(() => {
      const rev = ((this.row("SELECT MAX(rev) AS rev FROM task_contracts WHERE task_id = ?", taskId)?.rev as number | null) ?? 0) + 1;
      this.run("INSERT INTO task_contracts (task_id, rev, kind, goal, acceptance, scope, forbidden, evidence, checks, author, author_member_id, author_kind, source_message_id, at, inputs, outputs, constraints_json, exclusions, main_authority) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        taskId, rev, input.kind, input.goal, JSON.stringify(input.acceptance), input.scope ?? null, JSON.stringify(input.forbidden ?? []), JSON.stringify(input.evidence ?? []), JSON.stringify(requiredChecks(input)), by.author, by.authorMemberId, by.authorKind, by.sourceMessageId ?? null, nowIso(),
        input.inputs == null ? null : JSON.stringify(input.inputs), input.outputs == null ? null : JSON.stringify(input.outputs), input.constraints == null ? null : JSON.stringify(input.constraints), input.exclusions == null ? null : JSON.stringify(input.exclusions), input.main_authority?.startsWith(projectMainPolicyPrefix) ? null : input.main_authority ?? null);
      return this.getTaskContract(taskId)!;
    });
  }

  /** 직원이 단 계약의 지금 판을 총괄·대표가 확인한다. 확인된 판은 총괄 계약처럼 완료 판정을 받는다. 옛 판은 확인하지 않는다. */
  confirmTaskContract(taskId: string, rev: number, by: { name: string; memberId: string | null }): TaskContract {
    const current = this.getTaskContract(taskId);
    if (!current) throw new ApiError(404, `업무 #${taskId} 에는 계약이 없습니다`);
    if (current.rev !== rev) throw new ApiError(409, `업무 #${taskId} 의 지금 계약은 r${current.rev} 입니다. r${rev} 은 확인하지 않습니다`);
    if (current.authorKind !== "worker") return current;
    if (!current.confirmedAt) this.run("UPDATE task_contracts SET confirmed_by = ?, confirmed_by_member_id = ?, confirmed_at = ? WHERE task_id = ? AND rev = ?", by.name, by.memberId, nowIso(), taskId, rev);
    return this.getTaskContract(taskId)!;
  }

  /** 보고 글의 검사 기록. 그 직원의 지금 실행과 계약 판, 검사마다 대조한 실행 증거, 조사 주장을 함께 남긴다. */
  recordReportChecks(message: Message, member: Member, checks: ReportCheckInput[], extra: { contractTaskId: string | null; contractRev: number | null; artifact?: { branch: string; commit: string; base?: string | null }; reviewNeeded?: string | null; gate?: HarnessGate | null; evidenceStatus?: string | null; evidence?: CheckEvidence[]; claims?: ClaimResult[] }): void {
    checks = publicHarness(checks);
    extra = publicHarness(extra);
    const run = this.row("SELECT run_id FROM execution_journal WHERE member_id = ? AND phase NOT IN ('ended','interrupted') ORDER BY created_at DESC, rowid DESC LIMIT 1", member.id);
    this.run("INSERT INTO report_harness (message_id, task_id, member_id, run_id, contract_task_id, contract_rev, review_needed, gate, evidence_status, at, artifact_branch, artifact_commit, artifact_base) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", message.id, message.taskId ?? null, member.id, run?.run_id ?? null, extra.contractTaskId, extra.contractRev, extra.reviewNeeded ?? null, extra.gate ?? null, extra.evidenceStatus ?? null, message.at, extra.artifact?.branch ?? null, extra.artifact?.commit ?? null, extra.artifact?.base ?? null);
    checks.forEach((c, i) => {
      const e = extra.evidence?.find(x => x.idx === i);
      this.run("INSERT INTO report_checks (message_id, idx, name, kind, result, evidence, command, workdir, criterion, exec_status, exec_ref, exec_exit, exec_at, exec_output_sha, exec_command) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        message.id, i, c.name, c.kind, c.result, c.evidence, c.command ?? null, c.workdir ?? null, c.criterion ?? null, e?.status ?? null, e?.ref ?? null, e?.exitCode ?? null, e?.at ?? null, e?.outputSha ?? null, e?.command ?? null);
      // 한 실행은 한 업무의 증거로만 쓴다(같은 업무의 다른 검사·다시 올린 보고는 같은 실행을 가리켜도 된다).
      if (e?.status === "matched" && e.ref) this.run("INSERT OR IGNORE INTO harness_exec_refs (exec_ref, message_id, contract_task_id, task_id, member_id, at) VALUES (?, ?, ?, ?, ?, ?)", e.ref, message.id, extra.contractTaskId, message.taskId ?? null, member.id, message.at);
    });
    (extra.claims ?? []).forEach((c, i) => this.run("INSERT INTO report_claims (message_id, idx, text, basis, source, quote, criterion, verified, via) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", message.id, i, c.text, c.basis, c.source ?? null, c.quote ?? null, c.criterion ?? null, c.verified ? 1 : 0, c.via));
  }

  /**
   * 이 직원이 지시·대표 글로 받은 업무 중 받은 뒤 완료·막힘으로 마감하지 않은 것(최근 14일, 최근 받은 차례).
   * 다음 턴에 계약 없는 다른 업무로 완료를 올려 받은 계약을 비켜 가지 못하게 한다.
   */
  openAssignedTasks(memberId: string, isUnder: (taskId: string, root: string) => boolean = (a, b) => a === b): string[] {
    const since = new Date(Date.now() - ASSIGNMENT_HISTORY_MS).toISOString();
    const received = this.rows(`SELECT d.task_id AS task_id, MAX(d.created_at) AS at FROM deliveries d
      WHERE d.member_id = ? AND d.task_id IS NOT NULL AND d.kind IN ('instruction','user_message') AND d.status = 'delivered' AND d.created_at >= ?
      GROUP BY d.task_id ORDER BY at DESC LIMIT 20`, memberId, since).map(r => ({ taskId: r.task_id as string, at: r.at as string }));
    if (!received.length) return [];
    // 받은 업무나 그 갈래로 올린 완료·막힘이 받은 뒤에 있으면 마감이다.
    const closing = this.rows("SELECT task_id, at FROM messages WHERE member_id = ? AND mine = 0 AND kind IN ('완료','막힘') AND task_id IS NOT NULL AND at >= ?", memberId, received[received.length - 1]!.at)
      .map(r => ({ taskId: r.task_id as string, at: r.at as string }));
    return received.filter(r => !closing.some(c => c.at >= r.at && isUnder(c.taskId, r.taskId))).map(r => r.taskId);
  }

  /** 총괄이 이 직원에게 이 업무를 맡긴 적이 있는지(전달된 지시). */
  hasInstruction(memberId: string, taskId: string): boolean {
    return !!this.row("SELECT 1 FROM deliveries WHERE member_id = ? AND task_id = ? AND kind = 'instruction' LIMIT 1", memberId, taskId);
  }

  /** An existing work order keeps its original assignee and delivery receipt across restarts. */
  hasTaskInstruction(taskId: string, receivedBy?: string): boolean {
    if (receivedBy) return !!this.row("SELECT 1 FROM deliveries WHERE task_id=? AND kind IN ('instruction','user_message') AND member_id=? AND status='delivered' LIMIT 1", taskId, receivedBy);
    return !!this.row("SELECT 1 FROM deliveries WHERE task_id=? AND kind IN ('instruction','user_message') LIMIT 1", taskId);
  }

  /** 업무의 전달(누구에게 어떤 글이 갔는지). 글 내용은 싣지 않는다. */
  listTaskDeliveries(taskId: string, limit = 60): { id: string; memberId: string; kind: string; status: string; createdAt: string; deliveredAt: string | null }[] {
    return this.rows("SELECT id, member_id, kind, status, created_at, delivered_at FROM deliveries WHERE task_id = ? ORDER BY created_at, rowid LIMIT ?", taskId, limit)
      .map(r => ({ id: r.id as string, memberId: r.member_id as string, kind: r.kind as string, status: r.status as string, createdAt: r.created_at as string, deliveredAt: (r.delivered_at as string | null) ?? null }));
  }

  /** Bounded metadata only. Counts cover the whole task; samples never imply an empty queue. */
  taskDeliveryTrace(taskId: string) {
    return this.transaction(() => {
      const limit = 60;
      const pending = "d.status IN ('queued','held','delivering')";
      const count = this.row(`SELECT COUNT(*) AS total,
        SUM(CASE WHEN ${pending} THEN 1 ELSE 0 END) AS unsettled,
        SUM(CASE WHEN d.status IN ('queued','held') AND d.wake = 1 THEN 1 ELSE 0 END) AS pending_wake,
        SUM(CASE WHEN d.status IN ('queued','held') AND d.wake = 0 THEN 1 ELSE 0 END) AS pending_notice
        FROM deliveries d WHERE d.task_id = ?`, taskId)!;
      const sample = (where: string, order: string) => this.rows(`SELECT d.id, d.member_id, d.kind, d.status, d.wake,
        d.hold_reason, d.attempts, d.created_at, d.delivered_at, d.next_attempt_at, d.retry_reason,
        r.phase AS recovery_phase, r.reason AS recovery_reason
        FROM deliveries d LEFT JOIN delivery_recovery r ON r.delivery_id = d.id
        WHERE d.task_id = ? ${where} ORDER BY ${order} LIMIT ?`, taskId, limit).map(r => {
          const latest = this.row(`SELECT e.run_id FROM execution_journal e
            JOIN delivery_dispatch_items i ON i.dispatch_id = e.run_id
            WHERE i.delivery_id = ? ORDER BY e.created_at DESC, e.rowid DESC LIMIT 1`, r.id);
          const run = latest ? this.getExecutionJournal(latest.run_id) : null;
          return { id: r.id as string, memberId: r.member_id as string, kind: r.kind as string,
            status: r.status as DeliveryStatus, wake: !!r.wake, holdReason: (r.hold_reason as string | null) ?? null,
            attempts: r.attempts as number, createdAt: r.created_at as string, deliveredAt: (r.delivered_at as string | null) ?? null,
            nextAttemptAt: (r.next_attempt_at as string | null) ?? null, retryReason: (r.retry_reason as string | null) ?? null,
            recovery: r.recovery_phase ? { phase: r.recovery_phase as string, reason: (r.recovery_reason as string | null) ?? null } : null,
            // Receipt time is journal evidence, never guessed from delivered_at or status.
            execution: run ? { runId: run.runId, sessionGeneration: run.identity.sessionGeneration, turn: run.turn,
              deliveryIds: run.deliveryIds, phase: run.phase, inputReceivedAt: run.inputReceivedAt, startedAt: run.startedAt,
              lastProgressAt: run.lastProgressAt, endedAt: run.endedAt, result: run.result, exitCode: run.exitCode } : null };
        });
      const recent = sample("", "d.created_at DESC, d.rowid DESC").reverse();
      const unsettled = sample(`AND ${pending}`, "d.created_at, d.rowid");
      const byStatus = Object.fromEntries(this.rows("SELECT status, COUNT(*) AS n FROM deliveries WHERE task_id = ? GROUP BY status", taskId).map(r => [r.status, r.n]));
      return { history: this.listTaskDeliveries(taskId), recent, unsettled, coverage: { scope: "task", observedAt: nowIso(), limit, total: Number(count.total), returned: recent.length,
        truncated: Number(count.total) > recent.length, historyOrder: "oldest_first", recentOrder: "latest_sixty_chronological",
        unsettledStatuses: ["queued", "held", "delivering"], unsettledTotal: Number(count.unsettled ?? 0),
        unsettledReturned: unsettled.length, unsettledTruncated: Number(count.unsettled ?? 0) > unsettled.length,
        pendingWake: Number(count.pending_wake ?? 0), pendingNotice: Number(count.pending_notice ?? 0), byStatus } };
    });
  }

  /** 이 실행 표지를 이미 증거로 쓴 업무(계약이 붙은 업무). 없으면 null. */
  execRefTask(ref: string): string | null {
    const r = this.row("SELECT contract_task_id, task_id FROM harness_exec_refs WHERE exec_ref = ?", ref);
    return r ? ((r.contract_task_id as string | null) ?? (r.task_id as string | null) ?? "?") : null;
  }

  /** 보고의 조사 주장과 대조 결과. */
  listReportClaims(messageId: string): ClaimResult[] {
    return this.rows("SELECT * FROM report_claims WHERE message_id = ? ORDER BY idx", messageId).map(r => publicHarness(claimObservation({ text: r.text as string, basis: r.basis as ClaimResult["basis"], source: (r.source as string | null) ?? null, quote: (r.quote as string | null) ?? null, criterion: (r.criterion as number | null) ?? null }, (r.via as string | null) ?? null)));
  }

  /** 개선 후보 한 줄. 규칙·권한을 바꾸지 않는 기록이다(총괄이 보고 개발 기억에 남길지 정한다). */
  recordHarnessFinding(input: Omit<HarnessFinding, "id" | "at">): void {
    this.run("INSERT INTO harness_findings (project_id, task_id, member_id, kind, detail, ref_type, ref_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", input.projectId, input.taskId, input.memberId, input.kind, redactHarnessText(input.detail).slice(0, 2000), input.refType, input.refId, nowIso());
  }

  listHarnessFindings(projectId: string, opts: { taskId?: string | null; since?: string | null; limit?: number } = {}): HarnessFinding[] {
    const where = ["project_id = ?"], args: (string | number)[] = [projectId];
    if (opts.taskId) { where.push("task_id = ?"); args.push(opts.taskId); }
    if (opts.since) { where.push("at >= ?"); args.push(opts.since); }
    return this.rows(`SELECT * FROM harness_findings WHERE ${where.join(" AND ")} ORDER BY at DESC, id DESC LIMIT ?`, ...args, Math.max(1, Math.min(opts.limit ?? 50, 200))).map(r => ({
      id: r.id as number, projectId: r.project_id as string, taskId: (r.task_id as string | null) ?? null, memberId: (r.member_id as string | null) ?? null,
      kind: r.kind as HarnessFinding["kind"], detail: redactHarnessText(r.detail as string), refType: (r.ref_type as string | null) ?? null, refId: (r.ref_id as string | null) ?? null, at: r.at as string,
    }));
  }

  /** 업무의 계약 판 전부(옛 판 포함, 오래된 것부터). */
  listTaskContracts(taskId: string): TaskContract[] {
    return this.rows("SELECT * FROM task_contracts WHERE task_id = ? ORDER BY rev", taskId).map(toContract);
  }

  /** 업무(와 그 업무 계약을 따른 갈래)의 하네스 기록 보고 id, 오래된 것부터. */
  listTaskHarnessReports(taskId: string): string[] {
    return this.rows("SELECT message_id FROM report_harness WHERE task_id = ? OR contract_task_id = ? ORDER BY at, rowid", taskId, taskId).map(r => r.message_id as string);
  }

  /** 보고 글의 하네스 기록(실행·계약 판·검토 요청)과 검사. 기록이 없으면 null. */
  getReportHarness(messageId: string): { runId: string | null; contractTaskId: string | null; contractRev: number | null; artifactBranch: string | null; artifactCommit: string | null; artifactBase: string | null; reviewNeeded: string | null; memberId: string; gate: HarnessGate | null; evidenceStatus: string | null; checks: ReportCheck[]; claims: ClaimResult[] } | null {
    const h = this.row("SELECT h.*, m.who AS who FROM report_harness h JOIN messages m ON m.id = h.message_id WHERE h.message_id = ?", messageId);
    if (!h) return null;
    const checks = this.rows("SELECT * FROM report_checks WHERE message_id = ? ORDER BY idx", messageId).map(r => toCheck(r, h));
    return { runId: (h.run_id as string | null) ?? null, contractTaskId: (h.contract_task_id as string | null) ?? null, contractRev: (h.contract_rev as number | null) ?? null,
      artifactBranch: h.artifact_branch ?? null, artifactBase: h.artifact_base ?? null, artifactCommit: h.artifact_commit ?? null, reviewNeeded: h.review_needed ? redactHarnessText(h.review_needed as string) : null, memberId: h.member_id as string,
      gate: (h.gate as HarnessGate | null) ?? null, evidenceStatus: (h.evidence_status as string | null) ?? null, checks, claims: this.listReportClaims(messageId) };
  }

  /**
   * 같은 작성자·프로젝트·업무·계약 판에서 뒤에 쓴 명시적 정정만 근거를 대체한다.
   * 정정을 다시 정정해도 옛 성공이 부활하지 않는다. 새 검사를 통과한 완료가 새 근거다.
   * 검사를 생략한 총괄 승계 보고는 독립 근거가 아니다(원 직원의 정정을 세탁하지 않는다).
   */
  completionEvidence(contractTaskId: string, rev: number): CompletionEvidence[] {
    return this.classifyCompletionEvidence(this.completionEvidenceRows({ contractTaskId, rev }));
  }

  /** 단계 일괄 조회와 단일 계약 조회가 같은 정정·작성자 범위를 사용한다. */
  private completionEvidenceRows(scope: { projectId: string } | { contractTaskId: string; rev: number }): Row[] {
    const where = "projectId" in scope ? "m.project_id = ? AND h.contract_task_id IS NOT NULL AND h.contract_rev IS NOT NULL" : "h.contract_task_id = ? AND h.contract_rev = ?";
    const params = "projectId" in scope ? [scope.projectId] : [scope.contractTaskId, scope.rev];
    return this.rows(`SELECT h.message_id, h.contract_task_id, h.contract_rev, h.gate, m.kind,
      EXISTS (SELECT 1 FROM report_checks c WHERE c.message_id = m.id) AS has_checks,
      (SELECT n.id FROM report_references r
        JOIN messages n ON n.id = r.source_message_id JOIN report_harness nh ON nh.message_id = n.id
        WHERE r.corrects_message_id = m.id AND r.project_id = m.project_id
          AND n.project_id = m.project_id AND n.member_id = m.member_id AND n.mine = 0
          AND n.task_id IS m.task_id AND nh.member_id = h.member_id
          AND nh.contract_task_id = h.contract_task_id AND nh.contract_rev = h.contract_rev
          AND n.rowid > m.rowid ORDER BY n.rowid DESC LIMIT 1) AS corrected_by
      FROM report_harness h JOIN messages m ON m.id = h.message_id
      WHERE ${where} AND m.mine = 0 AND m.member_id = h.member_id
      ORDER BY m.rowid`, ...params);
  }

  /** 한 계약·한 판 안의 근거만 받는다. 다른 계약의 성공을 승계 근거로 섞지 않는다. */
  private classifyCompletionEvidence(rows: Row[]): CompletionEvidence[] {
    const direct = rows.some(r => r.gate === "contract" && r.kind === "완료" && r.has_checks && !r.corrected_by);
    return rows.map(r => {
      const status: CompletionEvidence["status"] = r.gate !== "contract" || r.kind !== "완료" ? "not_passed"
        : r.corrected_by ? "superseded" : r.has_checks ? "passed" : direct ? "inherited" : "missing_basis";
      return { messageId: r.message_id as string, eligible: status === "passed" || status === "inherited", status, correctedBy: (r.corrected_by as string | null) ?? null };
    });
  }

  /** 실제 계약 판정을 받은, 정정되지 않은 검사 완료만 센다. 확인 전·총괄 승계 완료는 독립 근거가 아니다. */
  hasPassedCompletion(contractTaskId: string, rev: number): boolean {
    return this.completionEvidence(contractTaskId, rev).some(r => r.status === "passed");
  }

  /** 그 업무의 가장 최근 검사 보고(누가 올렸든). 재개·다음 직원의 지시에 '지난 검사'로 싣는다. */
  latestTaskChecks(taskId: string): ReportCheck[] {
    const h = this.row("SELECT h.*, m.who AS who FROM report_harness h JOIN messages m ON m.id = h.message_id WHERE (h.task_id = ? OR h.contract_task_id = ?) AND EXISTS (SELECT 1 FROM report_checks c WHERE c.message_id = h.message_id) ORDER BY h.at DESC, h.rowid DESC LIMIT 1", taskId, taskId);
    return h ? this.rows("SELECT * FROM report_checks WHERE message_id = ? ORDER BY idx", h.message_id as string).map(r => toCheck(r, h)) : [];
  }

  // ---- 보고 마감·보고 보완 ----
  recordReportClosure(input: { memberId: string; kind: ReportClosureKind; refType: ReportClosure["refType"]; refId: string; causeId?: string | null }, selection?: CommandSelection): void {
    const member = this.requireMember(input.memberId);
    const run = this.row("SELECT run_id FROM execution_journal WHERE member_id = ? AND phase NOT IN ('ended','interrupted') ORDER BY created_at DESC, rowid DESC LIMIT 1", member.id);
    if (input.refType === "decision" || input.refType === "delivery") captureOwnerCommandEvidence(this, member.id, input.refType, input.refId, null, selection);
    this.run("INSERT INTO report_closures (member_id, project_id, run_id, kind, ref_type, ref_id, cause_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", member.id, member.projectId, run?.run_id ?? null, input.kind, input.refType, input.refId, input.causeId ?? null, nowIso());
  }

  listReportClosures(memberId: string, since: string): ReportClosure[] {
    return this.rows("SELECT * FROM report_closures WHERE member_id = ? AND at >= ? ORDER BY at, id", memberId, since)
      .map((r) => ({ memberId: r.member_id, projectId: r.project_id, runId: r.run_id, kind: r.kind, refType: r.ref_type, refId: r.ref_id, causeId: r.cause_id, at: r.at }));
  }

  hasCountedRepairInRun(message: Message, continuing: boolean, counted: string[]): boolean {
    if (!counted.length || (!continuing && message.kind !== "막힘")) return false;
    return !!this.row(`SELECT 1 FROM report_closures current
      JOIN report_closures earlier ON earlier.member_id = current.member_id AND earlier.run_id = current.run_id AND earlier.id < current.id
      WHERE current.member_id = ? AND current.at >= ? AND current.ref_id = ?
        AND current.ref_type = 'message' AND earlier.ref_type = 'message' AND (? OR earlier.kind = 'continuing')
        AND earlier.ref_id IN (${counted.map(() => "?").join(",")}) LIMIT 1`, message.memberId, message.at, message.id, continuing ? 1 : 0, ...counted);
  }

  recordReportFollowup(rootRunId: string, memberId: string, projectId: string, deliveryId: string): void {
    linkOwnerReportFollowup(this, rootRunId, memberId, projectId, deliveryId);
    this.run("INSERT INTO report_followups (root_run_id, member_id, project_id, delivery_id, requested_at) VALUES (?, ?, ?, ?, ?)", rootRunId, memberId, projectId, deliveryId, nowIso());
  }

  private followupRow(r: Row): ReportFollowup {
    return { rootRunId: r.root_run_id, memberId: r.member_id, projectId: r.project_id, deliveryId: r.delivery_id, requestedAt: r.requested_at, settledKind: r.settled_kind, settledRef: r.settled_ref, settledAt: r.settled_at };
  }

  getReportFollowup(rootRunId: string): ReportFollowup | null {
    const r = this.row("SELECT * FROM report_followups WHERE root_run_id = ?", rootRunId);
    return r ? this.followupRow(r) : null;
  }

  getReportFollowupByDelivery(deliveryId: string): ReportFollowup | null {
    const r = this.row("SELECT * FROM report_followups WHERE delivery_id = ?", deliveryId);
    return r ? this.followupRow(r) : null;
  }

  /** 한 번만 정리한다. 이미 정리했으면 false 이고 write 를 부르지 않는다. */
  settleReportFollowup(rootRunId: string, kind: "closed" | "unconfirmed", ref: string, write: () => void): boolean {
    return this.transaction(() => {
      if (this.db.query("UPDATE report_followups SET settled_kind = ?, settled_ref = ?, settled_at = ? WHERE root_run_id = ? AND settled_at IS NULL").run(kind, ref, nowIso(), rootRunId).changes !== 1) return false;
      write();
      return true;
    });
  }

  // ---- 문맥: nonce는 같은 세대에서 재사용하고 늦은 세대 갱신은 거부한다 ----
  getContextState(memberId: string): StoredContextState | null {
    const r = this.row("SELECT c.* FROM member_context_state c JOIN members m ON m.id = c.member_id AND m.session_generation = c.generation WHERE c.member_id = ?", memberId);
    if (!r) return null;
    try {
      return { memberId, generation: r.generation, bindingNonce: r.binding_nonce, rolloutPath: r.rollout_path, rolloutOffset: r.rollout_offset, measurement: r.measurement_json === null ? null : json(r.measurement_json), compaction: r.compaction_json === null ? null : json(r.compaction_json), baseline: r.baseline_json === null ? null : json(r.baseline_json), updatedAt: r.updated_at };
    } catch { throw new ApiError(409, "문맥 상태를 읽을 수 없어 자동 입력을 보류합니다", "CONTEXT_STATE_CORRUPT"); }
  }

  ensureContextState(memberId: string): StoredContextState {
    return this.transaction(() => {
      const existing = this.getContextState(memberId);
      if (existing) return existing;
      const generation = this.memberRevisions(memberId).sessionGeneration;
      this.run(`INSERT INTO member_context_state (member_id, generation, binding_nonce, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(member_id) DO UPDATE SET generation = excluded.generation, binding_nonce = excluded.binding_nonce, rollout_path = NULL, rollout_offset = 0, measurement_json = NULL, compaction_json = NULL, baseline_json = NULL, updated_at = excluded.updated_at`, memberId, generation, crypto.randomUUID().replaceAll("-", ""), nowIso());
      return this.getContextState(memberId)!;
    });
  }

  saveContextState(state: StoredContextState, memberPatch: Pick<MemberPatch, "contextPct" | "contextWindow" | "contextWindowSource"> = {}): void {
    this.transaction(() => {
      this.checkRevision(this.memberRevisions(state.memberId).sessionGeneration, state.generation);
      const before = this.ensureContextState(state.memberId);
      if (before.bindingNonce !== state.bindingNonce || (state.measurement && state.measurement.sessionGeneration !== state.generation)) throw new ApiError(409, "문맥 세대가 변경되었습니다");
      this.run("UPDATE member_context_state SET rollout_path = ?, rollout_offset = ?, measurement_json = ?, compaction_json = ?, baseline_json = ?, updated_at = ? WHERE member_id = ? AND generation = ? AND binding_nonce = ?", state.rolloutPath, state.rolloutOffset, state.measurement === null ? null : JSON.stringify(state.measurement), state.compaction === null ? null : JSON.stringify(state.compaction), state.baseline === null ? null : JSON.stringify(state.baseline), nowIso(), state.memberId, state.generation, state.bindingNonce);
      if (Object.keys(memberPatch).length) this.patchMember(state.memberId, memberPatch);
      else this.emitMember(state.memberId);
    });
  }

  getDecisionFollowUp(id: string): DecisionFollowUp | null {
    this.requireDecision(id);
    const r = this.row("SELECT follow_up_json FROM decisions WHERE id = ?", id)!;
    return r.follow_up_json === null ? null : json(r.follow_up_json);
  }

  setDecisionFollowUp(id: string, followUp: DecisionFollowUp): void {
    this.transaction(() => {
      const decision = this.requireDecision(id);
      if (followUp.kind === "instruction" && (this.requireMember(followUp.memberId).projectId !== decision.projectId || this.requireMessage(followUp.sourceMessageId).projectId !== decision.projectId)) throw new ApiError(400, "후속 지시의 프로젝트가 다릅니다");
      const before = this.getDecisionFollowUp(id);
      if (before !== null && stableJson(before) !== stableJson(followUp)) throw new ApiError(409, "이미 기록된 후속 지시가 다릅니다");
      this.run("UPDATE decisions SET follow_up_json = ? WHERE id = ?", JSON.stringify(followUp), id);
    });
  }

  // ---- board 검토와 보고 출처 ----
  boardRevision(projectId: string): number {
    this.requireProject(projectId);
    return this.row("SELECT board_revision FROM projects WHERE id = ?", projectId)!.board_revision;
  }

  private bumpBoard(projectId: string): void {
    this.run("UPDATE projects SET board_revision = board_revision + 1 WHERE id = ?", projectId);
  }

  requestBoardReview(projectId: string, at = nowIso()): BoardReview {
    this.requireProject(projectId);
    this.run("UPDATE projects SET board_requested_revision = board_revision, board_requested_at = ? WHERE id = ?", at, projectId);
    return this.getBoardReview(projectId)!;
  }

  getBoardReview(projectId: string): BoardReview | null {
    this.requireProject(projectId);
    const r = this.row("SELECT * FROM projects WHERE id = ?", projectId)!;
    return r.board_requested_revision === null ? null : { requestedRevision: r.board_requested_revision, reviewedRevision: r.board_reviewed_revision, requestedAt: r.board_requested_at, completedAt: r.board_completed_at };
  }

  completeBoardReview(projectId: string, requestedRevision: number, reviewedRevision: number, at = nowIso()): void {
    this.transaction(() => {
      const review = this.getBoardReview(projectId);
      if (!review || review.requestedRevision !== requestedRevision || reviewedRevision < 0 || reviewedRevision > requestedRevision || !Number.isSafeInteger(reviewedRevision)) throw new ApiError(409, "검토한 업무판이 변경되었습니다");
      this.run("UPDATE projects SET board_completed_revision = ?, board_reviewed_revision = ?, board_completed_at = ? WHERE id = ?", requestedRevision, reviewedRevision, at, projectId);
    });
  }

  saveReportReferences(projectId: string, refs: ReportReferences, sourceCommandId?: string | null): void {
    this.transaction(() => {
      if (this.requireMessage(refs.sourceMessageId).projectId !== projectId || (refs.correctsMessageId && this.requireMessage(refs.correctsMessageId).projectId !== projectId)) throw new ApiError(400, "다른 프로젝트의 메시지입니다");
      for (const id of refs.fileIds) if (this.getFile(id)?.projectId !== projectId) throw new ApiError(400, "자료의 프로젝트가 다릅니다");
      for (const id of refs.decisionIds) if (this.requireDecision(id).projectId !== projectId) throw new ApiError(400, "결재의 프로젝트가 다릅니다");
      const before = this.getReportReferences(projectId, refs.sourceMessageId);
      if (before) {
        if (sourceCommandId && !this.row("SELECT 1 FROM owner_command_evidence WHERE ref_type='message' AND ref_id=? AND command_id=?", refs.sourceMessageId,sourceCommandId)) throw new ApiError(409, "이미 접수한 보고의 대표 명령 원본이 다릅니다");
        if (stableJson(before) !== stableJson(refs)) throw new ApiError(409, "이미 기록된 보고 출처가 다릅니다");
        return;
      }
      const report = this.requireMessage(refs.sourceMessageId);
      if (!report.mine && report.memberId) captureOwnerCommandEvidence(this, report.memberId, "message", report.id, refs.correctsMessageId ?? report.aboutMessageId, sourceCommandId ? { id: sourceCommandId } : undefined);
      this.run("INSERT INTO report_references (source_message_id, project_id, file_ids_json, decision_ids_json, authored_at, sequence, corrects_message_id) VALUES (?, ?, ?, ?, ?, ?, ?)", refs.sourceMessageId, projectId, JSON.stringify(refs.fileIds), JSON.stringify(refs.decisionIds), refs.authoredAt, refs.sequence, refs.correctsMessageId);
    });
  }

  getReportReferences(projectId: string, messageId: string): ReportReferences | null {
    const r = this.row("SELECT * FROM report_references WHERE project_id = ? AND source_message_id = ?", projectId, messageId);
    return r ? { sourceMessageId: r.source_message_id, fileIds: json(r.file_ids_json), decisionIds: json(r.decision_ids_json), authoredAt: r.authored_at, sequence: r.sequence, correctsMessageId: r.corrects_message_id } : null;
  }

  /** Reading admission must not create or acknowledge a manual delivery batch. */
  openManualInboxDeliveryIds(projectId: string): string[] {
    return this.rows(`SELECT i.delivery_id FROM manual_inbox_items i
      JOIN manual_inbox_batches b ON b.id = i.batch_id
      JOIN deliveries d ON d.id = i.delivery_id
      WHERE b.acknowledged_at IS NULL AND d.project_id = ?`, projectId).map(r => r.delivery_id);
  }

  // ---- manual ACK 전 batch 재조회. askWait도 이 소비 경계를 사용한다 ----
  manualInbox(memberId: string, deliveryIds?: string[]): ManualInboxBatch | null {
    return this.transaction(() => {
      const member = this.requireMember(memberId);
      if (this.requireProject(member.projectId).archived) return null;
      const existing = this.row("SELECT id FROM manual_inbox_batches WHERE member_id = ? AND acknowledged_at IS NULL", memberId);
      if (existing) return this.getManualInboxBatch(memberId, existing.id);
      const deliveries = deliveryIds === undefined ? this.listPending(memberId) : deliveryIds.map((id) => this.requireDelivery(id));
      if (!deliveries.length) return null;
      const id = newId("batch_");
      this.run("INSERT INTO manual_inbox_batches (id, member_id, created_at) VALUES (?, ?, ?)", id, memberId, nowIso());
      for (const [ordinal, d] of deliveries.entries()) {
        if (d.memberId !== memberId || d.projectId !== member.projectId || !["queued", "held"].includes(d.status)) throw new ApiError(409, "받을 전달 항목이 변경되었습니다");
        this.run("INSERT INTO manual_inbox_items (batch_id, delivery_id, ordinal) VALUES (?, ?, ?)", id, d.id, ordinal);
      }
      return this.getManualInboxBatch(memberId, id);
    });
  }

  getManualInboxBatch(memberId: string, batchId: string): ManualInboxBatch | null {
    const batch = this.row("SELECT * FROM manual_inbox_batches WHERE id = ? AND member_id = ?", batchId, memberId);
    if (!batch) return null;
    return { id: batchId, memberId, createdAt: batch.created_at, items: this.rows("SELECT d.* FROM manual_inbox_items i JOIN deliveries d ON d.id = i.delivery_id WHERE i.batch_id = ? ORDER BY i.ordinal", batchId).map((d) => ({ deliveryId: d.id, text: d.text, ref: d.ref_type && d.ref_id ? { type: d.ref_type, id: d.ref_id } : null })) };
  }

  acknowledgeManualInbox(memberId: string, batchId: string): { batchId: string; acknowledged: true } {
    return this.transaction(() => {
      const member = this.requireMember(memberId);
      if (this.requireProject(member.projectId).archived) throw new ApiError(409, "보관 중에는 지시를 소비할 수 없습니다");
      const batch = this.getManualInboxBatch(memberId, batchId);
      if (!batch) throw new ApiError(404, "수신 묶음을 찾을 수 없습니다");
      const r = this.row("SELECT acknowledged_at FROM manual_inbox_batches WHERE id = ?", batchId)!;
      if (r.acknowledged_at !== null) return { batchId, acknowledged: true };
      for (const item of batch.items) {
        this.markDelivered(item.deliveryId);
        if (item.ref?.type === "decision" && this.getDecision(item.ref.id)?.status === "answered") this.setDecisionStatus(item.ref.id, "delivered");
        if (item.ref?.type === "message" && this.getMessage(item.ref.id)) this.setMessageDelivery(item.ref.id, "delivered");
      }
      this.run("UPDATE manual_inbox_batches SET acknowledged_at = ? WHERE id = ? AND acknowledged_at IS NULL", nowIso(), batchId);
      return { batchId, acknowledged: true };
    });
  }
}

function toContract(r: Row): TaskContract {
  return {
    taskId: r.task_id as string, rev: r.rev as number, ...(r.main_authority ? { main_authority: String(r.main_authority) } : {}), kind: r.kind as TaskContract["kind"], goal: r.goal as string,
    acceptance: JSON.parse(r.acceptance as string), scope: (r.scope as string | null) ?? null, forbidden: JSON.parse(r.forbidden as string),
    inputs: r.inputs == null ? null : JSON.parse(r.inputs as string), outputs: r.outputs == null ? null : JSON.parse(r.outputs as string),
    constraints: r.constraints_json == null ? null : JSON.parse(r.constraints_json as string), exclusions: r.exclusions == null ? null : JSON.parse(r.exclusions as string),
    evidence: JSON.parse(r.evidence as string), checks: JSON.parse(r.checks as string), author: r.author as string,
    authorMemberId: (r.author_member_id as string | null) ?? null, authorKind: (r.author_kind as ContractAuthorKind | null) ?? "conductor",
    sourceMessageId: (r.source_message_id as string | null) ?? null, at: r.at as string,
    confirmedBy: (r.confirmed_by as string | null) ?? null, confirmedByMemberId: (r.confirmed_by_member_id as string | null) ?? null, confirmedAt: (r.confirmed_at as string | null) ?? null,
  };
}

function toCheck(r: Row, h: Row): ReportCheck {
  return publicHarness({
    messageId: r.message_id as string, name: r.name as string, kind: r.kind as ReportCheck["kind"], result: r.result as ReportCheck["result"],
    evidence: r.evidence as string, command: (r.command as string | null) ?? null, workdir: (r.workdir as string | null) ?? null, criterion: (r.criterion as number | null) ?? null,
    taskId: (h.task_id as string | null) ?? null, memberId: h.member_id as string, who: h.who as string, runId: (h.run_id as string | null) ?? null,
    contractTaskId: (h.contract_task_id as string | null) ?? null,
    contractRev: (h.contract_rev as number | null) ?? null, at: h.at as string,
    execStatus: (r.exec_status as ReportCheck["execStatus"]) ?? null, execRef: (r.exec_ref as string | null) ?? null, execExit: (r.exec_exit as number | null) ?? null,
    execAt: (r.exec_at as string | null) ?? null, execOutputSha: (r.exec_output_sha as string | null) ?? null, execCommand: (r.exec_command as string | null) ?? null,
  });
}
