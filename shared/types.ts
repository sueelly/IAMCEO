// IAMCEO 공유 계약: 서버·웹·MCP가 함께 쓰는 타입. 바꾸려면 docs/spec.md 와 같이 바꾼다.

export type Backend = "core" | "herdr" | "headless";
export type CliProvider = "claude" | "codex" | "antigravity";
export const CLI_PROVIDERS = ["claude", "codex", "antigravity"] as const;
/** bypassPermissions 묻지 않음(기본) · auto 위험한 것만 멈춤 · default 전부 승인 필요(herdr 는 승인 창, headless 는 창이 없어 막히고 활동에 남는다) */
export type PermissionMode = "bypassPermissions" | "auto" | "default";
export const PERMISSION_MODES = ["bypassPermissions", "auto", "default"] as const;
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const CODEX_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const CODEX_SPEEDS = ["standard", "fast"] as const;
export type CodexSpeed = typeof CODEX_SPEEDS[number];

export interface ModelOption {
  value: string;
  label: string;
  description?: string;
  efforts: string[];
  defaultEffort?: string;
  supportsFast?: boolean;
}
export interface ModelList { models: ModelOption[]; source: "cli" | "default"; updatedAt?: string }
export type ModelCatalog = Record<CliProvider, ModelList>;
/** CLI catalogs may introduce new per-model effort names; writes validate catalog membership. */
export type Effort = string;
/** manager 부장(총괄·본사 AI) · lead 팀장(직원 세션) · staff 직원(서브에이전트) */
export type Rank = "manager" | "lead" | "staff";
/** null 이면 CLI 기본값 */
export interface RankConfig { model: string | null; effort: Effort | null }
export type Ranks = Record<Rank, RankConfig>;
export type MemberKind = "root" | "conductor" | "worker";
export type MemberOrigin = "runner" | "adopted" | "manual";
/** working 일하는 중 · waiting 내 답 기다림 · idle 대기 · blocked 승인 창 앞(herdr) · asleep 잠듦 · offline 안 보임 · error 오류 */
export type MemberStatus = "working" | "waiting" | "idle" | "blocked" | "asleep" | "offline" | "error";

/**
 * 지금 대표의 말·결정을 받을 수 있는가. ok=false 면 화면은 입력을 막고 detail 을 보여 주고, 서버도 409 로 거부한다.
 * ok: 보관 아님 && ((runnerEnabled && 전역 실행기 쓸 수 있음) || 살아 있는 직접 띄운 세션 있음)
 */
export type ConnectionReason = "runner_off" | "backend_down" | "archived";
export interface ProjectConnection { ok: boolean; reason: ConnectionReason | null; detail: string | null }

export interface Project {
  id: string; // 'hq' 는 본사
  name: string;
  isHq: boolean;
  /** Stored chief provider; older servers omit it and retain their historical Claude default. */
  chiefCli?: CliProvider;
  cwd: string;
  /** false 면 메시지를 저장만 하고 어떤 세션도 띄우거나 깨우지 않는다(가져온 프로젝트 기본값). */
  runnerEnabled: boolean;
  /** null이면 전체 동시 실행 상한을 따른다. 별도 상한은 1~64. */
  maxConcurrentTurns: number | null;
  now: string; // '지금 상황' 한 줄~짧은 글
  /** 생성 때 대표가 쓴 목표 원문. 이후 수정하지 않으며 이전 프로젝트는 null. */
  readonly creationGoal: string | null;
  nowAt: string | null;
  herdrTabId: string | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  connection: ProjectConnection;
  /** 마지막으로 총괄에게 판 정리를 맡긴(또는 그 턴이 끝난) 시각. 한 번도 안 했으면 null. */
  tidiedAt: string | null;
  /** 개발 기억 운영. 옛 서버는 이 필드를 보내지 않는다. */
  memory?: ProjectMemory;
}

/**
 * 프로젝트의 개발 기억 운영 값. mode: 대표가 정한 값(on·off) 또는 이전 프로젝트(legacy: 서버 환경 목록을 따름).
 * on 은 이 프로젝트가 기억을 쓰기로 한 것이다. 실제로 닿는지는 RuntimeInfo.memory(서버 연결 상태)로 따로 본다.
 */
export interface ProjectMemory { mode: "on" | "off" | "legacy"; on: boolean; enabledAt: string | null }

/** 서버의 개발 기억 연결 상태. not_configured: 연결 설정 없음 · key_unreadable: 키 파일을 못 읽음 · unreachable: 서버가 응답 안 함 · ok: 마지막 확인에서 닿음 · unknown: 아직 확인 전 */
export interface MemoryServiceInfo {
  state: "not_configured" | "key_unreadable" | "unreachable" | "ok" | "unknown";
  detail: string | null;
  checkedAt: string | null;
  uploads?: { pending: number; sent: number; rejected: number; lastSentAt: string | null; lastError: string | null };
  feedback?: { unassessed: number; awaitingDelivery: number; pending: number; sent: number; notUsed: number; rejected: number; lastError: string | null };
}

export interface ProjectSummary extends Pick<Project, "id" | "name" | "isHq" | "cwd" | "now" | "runnerEnabled" | "maxConcurrentTurns" | "connection"> {
  decisionCount: number; // 열린 결재
  todoCount: number; // 안 한 내 할 일
  /** decisionCount + todoCount. 호환용으로 남겨 두었다. 새 화면은 위 둘을 쓴다. */
  inboxCount: number;
  workingCount: number;
  /** 승인 창 앞에서 멈춘 세션. 대표가 풀어 줘야 움직인다. */
  blockedCount: number;
  errorCount: number;
  memberCount: number;
}

export type ContextWindowSource = "statusline" | "codex" | "antigravity" | "headless" | "screen";

/** blocked는 입력 보류다. permission만 증거로 확인된 승인 대기로 집계한다. */
export type BlockedReason = "permission" | "selection" | "setup" | "status_unknown";
export interface StatusObservation {
  source: Backend | "manual";
  observedAt: string | null;
  freshness: "fresh" | "stale" | "unknown";
  ownership: "verified" | "conflict" | "unknown";
  consecutiveFailures: number;
  error: { code: string; note: string } | null;
}
/** 미수집/추정은 기존 subagents=0과 다르며 실제 자식 lifecycle 수집을 약속하지 않는다. */
export interface SubagentState {
  quality: "exact" | "estimated" | "unknown" | "unsupported";
  count: number | null;
  observedAt: string | null;
  sessionGeneration: number;
}
export interface MemberExecutionState {
  runId: string;
  sessionGeneration: number;
  turn: number | null;
  deliveryIds: string[];
  phase: "received" | "starting" | "running" | "ended" | "interrupted" | "unknown";
  inputReceivedAt: string | null;
  startedAt: string | null;
  lastProgressAt: string | null;
  endedAt: string | null;
  result: "success" | "error" | "interrupted" | null;
  /** 제한된 진단 code이며 원시 화면/프롬프트가 아니다. */
  reason: string | null;
  exitCode: number | null;
  /** 이 실행으로 나간 전달의 작업 id(중복 없이). 작업 없는 전달은 넣지 않는다. 한 CLI 턴이 여러 작업을 함께 받을 수 있다. */
  taskIds?: string[];
}
export interface MemberLifecycleState {
  operationId: string;
  sessionGeneration: number;
  /** journal의 confirmed만 확정 상태다. 기존 status는 종료/시작의 증거가 아니다. */
  phase: "starting" | "starting_unknown" | "stopping" | "stopping_unknown" | "closing" | "started_confirmed" | "stopped_confirmed" | "refused" | "reconnecting" | "quarantined";
  intent?: "start" | "sleep" | "close" | "archive" | "fresh_session";
  reason: string | null;
  exitCode?: number | null;
  updatedAt: string;
}
export interface ContextMeasurement {
  sessionId: string;
  sessionGeneration: number;
  turn: number | null;
  model: string | null;
  tokens: number | null;
  window: number | null;
  source: ContextWindowSource | "stored" | "model" | "default";
  quality: "exact" | "estimated";
  measuredAt: string;
  /** 같은 세션/세대/모델/완료 턴의 표본. 단순 경과시간으로 결정하지 않는다. */
  fresh: boolean;
}
export interface ContextCompaction {
  id: string;
  trigger: "auto" | "manual";
  phase: "queued" | "sending" | "running" | "succeeded" | "failed" | "uncertain";
  reason: "working" | "manual_control" | "draft" | "blocked" | "backend_down" | "measurement_pending" | "send_uncertain" | "completion_timeout" | "provider_error" | "interrupted" | "session_changed" | "user_resolved" | null;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}
export interface CoreContextState {
  measurement: ContextMeasurement | null;
  compaction: ContextCompaction | null;
}

export interface ExecutionIssue {
  kind: "startup_failed" | "session_missing" | "usage_limit" | "authentication";
  detail: string;
  at: string;
  sessionGeneration: number;
  terminalId: string | null;
  exitCode: number | null;
}
export interface DeliveryWait {
  kind: "capacity" | "project_capacity" | "working" | "manual_control" | "permission" | "selection" | "setup" | "compact" | "retry" | "runner_disabled" | "archived" | "backend_down" | "session" | "lifecycle" | "delivery_confirmation" | "manual_inbox" | "sequence" | "quiet" | "input";
  since: string;
  retryAt?: string;
  active?: number;
  limit?: number;
}

export interface Member {
  id: string;
  projectId: string;
  handle: string; // [a-z][a-z0-9_-]{0,31}, 프로젝트 안에서 유일
  name: string; // 화면 이름(한국어)
  role: string;
  kind: MemberKind;
  /** 프로젝트의 독립 최종 검수를 맡는 관리 직원. */
  finalReviewer?: boolean;
  origin: MemberOrigin;
  /** 편입으로 들어온 세션. 다시 열어 origin 이 runner 가 되어도 남는다. 편입 해제의 근거다. */
  wasAdopted: boolean;
  cli: CliProvider;
  /** 이 직원의 세션을 다루는 실행기. 띄울 때 기억한다. 세션이 없으면 null(다음에 띄울 때 전역 설정을 따른다). */
  backend: Backend | null;
  /** null 이면 직급 기본(Settings.ranks) */
  modelOverride: string | null;
  effortOverride: Effort | null;
  /** Legacy snapshots omit speed. Fast requires an explicit selection. */
  codexSpeed?: CodexSpeed;
  appliedCodexSpeed?: CodexSpeed | null;
  /** PATCH response only: saved overrides reset on a provider change. */
  resetOverrides?: ("modelOverride" | "effortOverride")[];
  /** 지금 세션에 실제로 들어간 값. null 은 CLI 기본이거나 모름(넘겨받은 세션). */
  appliedModel: string | null;
  appliedEffort: Effort | null;
  status: MemberStatus;
  now: string;
  next: string;
  cwd: string;
  sessionId: string | null; // CLI 세션 UUID
  paneId: string | null; // herdr pane
  contextPct: number | null;
  /** 이 세션에서 실측하거나 상태줄로 추정한 문맥 창 크기(토큰). 모르면 null. 세션·CLI·모델이 바뀌면 지운다. */
  contextWindow: number | null;
  contextWindowSource: ContextWindowSource | null;
  subagents: number; // 지금 돌고 있는 서브에이전트 수
  parallel: boolean; // ultracode 켬
  queuedCount: number; // 전달 대기 중 입력 수(보류 포함)
  /** queuedCount 중 보류(보호·확인 필요·보관)라 자동으로 들어가지 않는 입력 수. 옛 서버는 보내지 않는다. */
  heldCount?: number;
  lastError: string | null;
  executionIssue?: ExecutionIssue | null;
  deliveryWait?: DeliveryWait | null;
  /** CLI가 마지막으로 일한 시각(활동 turn_start/turn_end/tool/tool_result의 최신 ISO 시각). 기록이 없으면 null. */
  lastActiveAt: string | null;
  updatedAt: string;
  createdAt: string;
  /** 추가 메타데이터의 누락은 구형/미지원이다. 기존 status/문맥 창 필드는 유지한다. */
  statusObservation?: StatusObservation | null;
  blockedReason?: BlockedReason | null;
  subagentState?: SubagentState | null;
  /** now는 마지막 자기 보고이며 일반 updatedAt과 별도로 기록한다. next 생략 시 보존한다. */
  nowAt?: string | null;
  manualActivityAt?: string | null;
  executionState?: MemberExecutionState | null;
  lifecycleState?: MemberLifecycleState | null;
  contextState?: CoreContextState | null;
}

export interface DecisionOption { k: string; label: string; desc?: string }
export type DecisionStatus = "open" | "answered" | "delivered" | "closed";
export interface Decision {
  id: string;
  projectId: string;
  memberId: string | null; // 물은 직원
  who: string; // 화면 이름
  title: string;
  detail: string; // 마크다운. 카드만 읽고 고를 수 있어야 한다
  options: DecisionOption[]; // 비어 있으면 자유 답
  rec: string | null;
  group: string | null;
  fileId: string | null;
  images: Attachment[];
  status: DecisionStatus;
  choice: string | null;
  note: string | null;
  batch: boolean;
  createdAt: string;
  answeredAt: string | null;
  deliveredAt: string | null;
  /** 상태가 바뀔 때마다 는다. 되돌아간 상태(다시 열림)와 늦게 온 응답을 가른다. */
  updatedAt: string;
  /** 전달되지 못하고 다시 열린 카드의 직전 답. 대표가 다시 쓰지 않아도 되게 카드로 돌려준다. 새 답이 오면 지운다. */
  lastChoice: string | null;
  lastNote: string | null;
  /** 왜 다시 열렸는지. 카드에 그대로 보인다. */
  reopenNote: string | null;
  /** AI 가 ask_close 로 닫았을 때만 있다. 대표는 이 카드를 다시 열 수 있다. 직원이 명부에서 빠져 함께 닫힌 카드는 null. */
  closeKind: DecisionCloseKind | null;
  /** 닫힌 이유(한 줄). 결재된 항목에 '닫힘 · 이유'로 보인다. */
  closeReason: string | null;
  /** decided 로 닫을 때 서버가 대표 글과 맞춰 본 인용. */
  closeQuote: string | null;
  /** 닫은 이(화면 이름) 또는 '시스템'. */
  closedBy: string | null;
  closedAt: string | null;
  /** 이 카드가 속한 작업. 없으면(옛 카드 포함) 전체 대화에만 속한다. */
  taskId?: string | null;
}
/** decided 대표가 대화 등으로 이미 정함(서버가 대표 글로 확인) · obsolete 상황이 바뀌어 필요 없어짐 */
export type DecisionCloseKind = "decided" | "obsolete";

export type DecisionFileLink = Pick<FileDoc, "id" | "title">;
export interface DecisionContext {
  references: DecisionFileLink[];
  tasks: { id: string; title: string; files: DecisionFileLink[] }[];
}

/** done 끝남 · dropped 필요 없어짐(홈에서 빠진다). 둘 다 done=true 다. */
export type TodoOutcome = "done" | "dropped";
export interface Todo {
  id: string;
  projectId: string;
  memberId: string | null;
  who: string; // 요청한 직원 이름
  title: string;
  detail: string;
  done: boolean;
  doneAt: string | null;
  createdAt: string;
  /** 안 끝났으면 null. 대표가 체크하면 done. */
  outcome: TodoOutcome | null;
  /** AI 가 todo_close 로 정리했을 때의 이유와 정리한 이. 대표가 체크했으면 null. */
  closeReason: string | null;
  closedBy: string | null;
  taskId?: string | null;
}

/**
 * 업무가 생긴 곳. staff: 직원이 task 도구로 등록 · board: 총괄의 진행판 일 항목 · owner: 대표가 이름 붙인 새 업무 ·
 * auto: 업무를 고르지 않은 대표 글 등에서 서버가 첫 줄로 이름 붙인 새 업무 · backfill: 업무가 없던 옛 글을 정리하며 만든 업무.
 */
/** 업무가 생긴 곳. server 는 근거 없는 서버 알림·여러 업무가 섞인 자동 보고를 모으려고 서버가 직원마다 한 번 만든 업무. */
export type TaskOrigin = "staff" | "board" | "owner" | "auto" | "backfill" | "server";

/**
 * 업무(작업): 대화·결재·자료·할 일이 모이는 일 하나. id 는 처음 만들 때 정해지고, 제목·브랜치·워크트리를 고쳐도 바뀌지 않는다.
 * 대화·결재·자료·할 일은 taskId 로 업무에 붙는다. 본사가 아닌 프로젝트에서 새로 생기는 글은 모두 업무가 있다.
 * taskId 가 없는 것은 이 규칙 전의 옛 글이거나 서버 알림이다('모든 대화'에서만 보인다).
 */
export interface Task {
  id: string;
  projectId: string;
  /** 등록한 직원. 그 직원이 닫히면 null. 대표·서버가 만든 업무도 null(어느 직원 하나에 묶지 않는다). */
  memberId: string | null;
  who: string;
  title: string;
  branch: string | null;
  worktree: string | null;
  createdAt: string;
  updatedAt: string;
  /** 생긴 곳. 이 칸이 생기기 전 응답에는 없다. */
  origin?: TaskOrigin;
  /** 이 업무가 갈라져 나온 업무(파생 업무). 없으면 null. */
  parentTaskId?: string | null;
  /** 총괄이 이 업무의 글을 다른 업무로 분류해 합친 곳. 합쳐진 업무는 칩에서 숨기고, 이 id 로 오는 글은 합쳐진 업무로 간다. */
  mergedInto?: string | null;
  /** 만든 뒤 이름을 바꾼 때와 바꾼 직원. 서버가 지은 이름(auto·backfill)은 바꾸기 전까지 임시 이름이다. */
  renamedAt?: string | null;
  renamedBy?: string | null;
  /** 이 업무에 붙은 마지막 글의 시각. 글이 없으면 null. 이 칸이 생기기 전 응답에는 없다. */
  lastMessageAt?: string | null;
  /** 업무 단계. 서버가 같은 근거로 계산해 팀 목록·대화·결재함이 함께 쓴다. 싣지 않은 알림이면 화면은 앞서 받은 값을 남긴다. */
  progress?: TaskProgress;
}

/**
 * 업무 단계(대표 2026-11-17: 목록과 대화가 맞고, 막힘·적용 없이 끝나지 않게).
 * new 시작 전 · working 진행 중 · owner 대표 차례 · approval 승인 창 · held 전달 보류 · check 총괄 점검(반복 감시) ·
 * fix 고칠 것 · confirm 확인 대기 · delivered 작성자 납품 · review 검토 중 · merge 합치기 대기 · merged 메인 합침(통합 뒤 확인) ·
 * applied 대표 화면 반영 · hold 보류 · done 완료.
 */
export type TaskStage = "new" | "working" | "owner" | "approval" | "held" | "check" | "fix" | "confirm" | "delivered" | "review" | "merge" | "merged" | "applied" | "hold" | "done";
/**
 * 막힌 까닭. technical 검사 실패 · pending 실행 안 함만 남음(시험·검토·적용 대기) · dependency 소관·의존 대기(잠든 세션 등) ·
 * owner 대표 결정·할 일 · approval 실제 터미널 승인 창 · limit 한도·수동 중단 · unknown 근거 없음·수신 불확실 · loop 반복 감시 · hold 총괄 보류.
 */
export type TaskBlockCause = "technical" | "pending" | "dependency" | "owner" | "approval" | "limit" | "unknown" | "loop" | "hold";
/** 총괄이 남기는 단계 표시. reopen 은 완료·점검·보류를 푼다. */
export type TaskStageMark = "review" | "merged" | "applied" | "done" | "hold" | "reopen";
export interface TaskProgress {
  finalReview?: { status: "pending" | "confirmed" | "changes_requested"; reportId: string; contractRev: number; at: string };
  stage: TaskStage;
  cause: TaskBlockCause | null;
  /** 다음 차례 한 줄(누가 무엇을). 아무도 할 일이 없으면 null. */
  next: string | null;
  /** 차례인 사람. 대표면 "대표". */
  owner: string | null;
  /** 이 단계를 정한 근거의 시각. */
  since: string | null;
  /** 근거 id(보고·결재·할 일·전달·단계 표시). */
  basis: string[];
  /** 계산 판: 근거 중 가장 늦은 시각. 화면은 이보다 이른 판을 버린다. */
  rev: string;
  /** 반복 감시: 막힘의 시작·시도 수·같은 실패 연속 수. 없으면 null. */
  loop: { startedAt: string; attempts: number; same: number; trippedAt: string | null; reason: string | null } | null;
  /** 완료 알림(결재함 읽기용). 완료가 아니면 null. */
  notice: { id: string; at: string; seenAt: string | null; lines: string[] } | null;
}

/** 글·카드·자료·할 일의 업무를 바꾼 기록 한 줄. 원문은 바꾸지 않고 업무 칸만 바꾼다. */
export interface TaskLink {
  id: string;
  projectId: string;
  /** task 는 업무 사이 관계(합침 merged·갈라짐 derived) 기록이다. */
  refType: "message" | "decision" | "file" | "todo" | "task";
  refId: string;
  fromTaskId: string | null;
  toTaskId: string | null;
  /** 바꾼 근거(예: classify 총괄 분류, backfill-decision 이어 준 결재). */
  basis: string;
  note: string | null;
  actor: string;
  batchId: string | null;
  undoneAt: string | null;
  createdAt: string;
}

/** 팀 화면 아래: 진행 중 · 예정(AI가 곧 할 일) · 보류 · 완료 */
export type WorkSec = "doing" | "next" | "hold" | "done";
export interface WorkItem {
  id: string;
  projectId: string;
  sec: WorkSec;
  /** 이 일 항목이 가리키는 기존 업무(work_set task_id). 없으면 null(이 항목에서 생긴 업무 tk_<id> 를 쓴다). 옛 서버는 보내지 않는다. */
  taskId?: string | null;
  title: string;
  detail: string;
  who: string;
  order: number;
  doneAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type MessageKind = "완료" | "진행" | "질문" | "막힘" | "알림" | "답변" | "지시" | "직접" | "나" | "시스템";
export interface Attachment { id: string; name: string; mime: string; size: number; url: string; path: string; isImage: boolean }
export interface Message {
  id: string;
  projectId: string;
  at: string;
  mine: boolean; // 대표가 쓴 말
  memberId: string | null;
  who: string;
  kind: MessageKind;
  title: string;
  body: string; // 마크다운
  targetMemberId: string | null; // @직원 지정
  targetName: string | null;
  decisionId: string | null;
  fileId: string | null;
  attachments: Attachment[];
  /** 대표 말의 전달 상태: sent 보냄 · queued 대기 · held 보류(사유) · delivered 받음 · failed 실패 */
  delivery: DeliveryStatus | null;
  deliveryNote: string | null;
  /** 이 글이 속한 작업. 대표 글은 보낸 순간 고른 작업으로 정해진다. 없으면 전체 대화에만 속한다. */
  taskId?: string | null;
  /** 이 글이 확인한 다른 직원의 보고 원본(post about_report_id). 화면은 새 결정 없는 확인 글을 그 원보고에 묶는다. */
  aboutMessageId?: string | null;
}

export type MessageScope = { kind: "project" } | { kind: "member"; memberId: string } | { kind: "task"; taskId: string };
export interface MessagePageOptions { scope?: MessageScope; cursor?: string; limit?: number }
/** items는(at BINARY,id BINARY) 오름차순. cursor는 불투명하며 hasOlder=false이면 null. */
export interface MessagePage {
  projectId: string;
  scope: MessageScope;
  items: Message[];
  nextCursor: string | null;
  hasOlder: boolean;
}

/** 자료의 모양. artifact 는 GET /api/files/:id/artifact 의 html 을 격리 칸에 그린다. table·code 는 body 에 원문이 있다(1MB 이하). */
export const FILE_KINDS = ["document", "artifact", "image", "pdf", "table", "code", "video", "audio", "file"] as const;
export type FileKind = typeof FILE_KINDS[number];
export interface FileDoc {
  id: string;
  kind: FileKind;
  projectId: string;
  title: string;
  who: string;
  memberId: string | null;
  summary: string;
  body: string; // 마크다운 전문(없을 수 있음)
  path: string | null; // 원본 위치
  attachments: Attachment[];
  createdAt: string;
  order: number;
  taskId?: string | null;
}

/** 목록은 본문을 보내지 않는다. 본문은 GET /api/files/:id로 선택 시 조회한다. */
export type FileListItem = Omit<FileDoc, "body">;
export interface FilePageOptions { taskId?: string; kind?: FileKind; cursor?: string; limit?: number }
export interface FilePage {
  projectId: string;
  items: FileListItem[];
  nextCursor: string | null;
  hasMore: boolean;
  /** 종류 필터 전, 선택한 업무 전체의 개수. */
  counts: Partial<Record<FileKind, number>>;
}

export type DeliveryKind = "user_message" | "answer" | "todo_done" | "instruction" | "report" | "system" | "compact";
export type DeliveryStatus = "queued" | "held" | "delivering" | "delivered" | "failed";
export interface Delivery {
  id: string;
  taskId?: string | null;
  projectId: string;
  memberId: string;
  kind: DeliveryKind;
  text: string; // 서버가 접두어까지 붙인 최종 글
  wake: boolean; // false 면 다음 깨움에 묶어서만 전달
  urgent: boolean; // 일하는 중에도 넣기(herdr)
  status: DeliveryStatus;
  holdReason: string | null; // blocked · input_busy · asleep · offline · backend_down · runner_disabled · archived
  refType: "message" | "decision" | "todo" | null;
  refId: string | null;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  deliveredAt: string | null;
  /** 실제 재시도 큐의 예약 시각. 미지원/예약 없음은 누락 또는 null. */
  nextAttemptAt?: string | null;
}

export type EvidenceVerdict = "present" | "absent" | "unknown";
/** 공개 증거 요약. 원시 화면/프롬프트/로그 경로/lease ID는 포함하지 않는다. */
export interface DeliveryEvidence {
  source: "claude_log" | "codex_log" | "antigravity_log" | "core_screen" | "herdr_screen" | "transport";
  verdict: EvidenceVerdict;
  location: "received_input" | "composer" | "history" | "none";
  code: string;
  complete: boolean;
  checkedAt: string;
}
export type DeliveryFinding = "received" | "not_received" | "draft_only" | "wait" | "unknown";
export type DeliveryRecoveryPhase = "none" | "checking" | "waiting" | "retry_wait" | "needs_owner" | "resolved" | "stopped";
export type DeliveryRecoveryAction = "recheck" | "retry_with_risk" | "stop_retry";
export interface MemberDeliverySummary {
  memberId: string;
  /** undelivered/unknown/delivering은 배타적. 나머지는 보조 집합이므로 더하지 않는다. */
  undeliveredCount: number;
  unknownCount: number;
  deliveringCount: number;
  checkingCount: number;
  needsOwnerCount: number;
  waitingBehindCount: number;
  oldestAt: string | null;
  reasons: { code: string; count: number; note: string }[];
}
export interface DeliveryNotices {
  version: 2;
  /** state.members와 같은 순서, 0건도 포함. 최근 메시지가 아닌 전체 DB 집계. */
  members: MemberDeliverySummary[];
  unassigned: { undeliveredCount: number; unknownCount: number; needsOwnerCount: number };
}
export interface DeliveryNoticeItem {
  id: string;
  deliveryId: string | null;
  messageId: string | null;
  memberId: string;
  projectId: string;
  kind: DeliveryKind;
  status: DeliveryStatus;
  phase: Exclude<DeliveryRecoveryPhase, "resolved" | "stopped">;
  holdReason: string | null;
  reason: string | null;
  note: string;
  /** 실제 recovery는 양의 안전 정수, 가상 message:<id> 항목은 0. */
  version: number;
  createdAt: string;
  lastCheckedAt: string | null;
  nextCheckAt: string | null;
  autoAttempts: number;
  evidence: DeliveryEvidence[];
  recommendation: { code: string; text: string } | null;
  allowedActions: DeliveryRecoveryAction[];
  ref: { type: "message" | "decision" | "todo"; id: string } | null;
  preview: string;
}
export interface DeliveryNoticePage {
  memberId: string;
  summary: MemberDeliverySummary;
  items: DeliveryNoticeItem[];
  nextBefore: string | null;
}
export interface DeliveryNoticePageOptions { limit?: number; before?: string }
/** retry만 중복 위험 동의를 요구한다. 나머지 action에는 해당 키를 보내지 않는다. */
export type DeliveryRecoveryRequest = { operationId: string; expectedVersion: number } & (
  | { action: "retry_with_risk"; acceptDuplicateRisk: true }
  | { action: "recheck" | "stop_retry"; acceptDuplicateRisk?: never }
);
export interface DeliveryRecoveryResult {
  operationId: string;
  deliveryId: string;
  outcome: "check_scheduled" | "retry_scheduled" | "stopped";
  committedVersion: number;
}

export type ActivityKind = "text" | "tool" | "tool_result" | "turn_start" | "turn_end" | "compact" | "error" | "system";
export interface Activity { id: number; memberId: string; at: string; kind: ActivityKind; text: string }

/**
 * 실행기가 확인한 CLI 승인·설정 창. 선택지는 화면 원문 순서 그대로다.
 * fingerprint 는 창 근거의 해시다(herdr: 추출 내용, core 폴더 신뢰: 경로·선택 위치를 포함한 평문 화면).
 * 누를 때 다시 읽어 같을 때만 누른다. 설정 창에는 앱의 사실 설명을 붙일 수 있다.
 */
export interface ApprovalOption { n: number; label: string; /** 거절(No) 선택지 */ reject: boolean }
export interface ApprovalPrompt {
  /** 예: "Bash command", "Create file". 창 윗부분이 화면 밖이면 빈 글 */
  title: string;
  /** 설명·명령·미리보기. 줄바꿈 포함 */
  body: string;
  /** 예: "Do you want to proceed?" */
  question: string;
  options: ApprovalOption[];
  fingerprint: string;
}
/** 직원 CLI 가 띄운 질문·선택·승인 창의 선택지. detail 은 선택지 설명, freeText 는 고르면 글을 직접 쳐서 내는 줄. */
export interface NativePromptOption extends ApprovalOption { detail?: string; freeText?: boolean }
/**
 * 직원 CLI 가 화면에 띄운 질문·선택·승인 창. limited 면 선택지를 확실히 읽지 못한 것이라 버튼 없이 raw(화면 원문)만 보인다.
 * selected 는 지금 커서가 있는 선택지 자리(0부터). 서버는 이 자리에서 화살표로 옮겨 Enter 한 번으로 고른다.
 */
export interface NativePrompt extends ApprovalPrompt {
  kind: "permission" | "question" | "menu" | "setup" | "unknown";
  provider: CliProvider;
  options: NativePromptOption[];
  selected: number;
  limited: boolean;
  limitedReason?: string;
  raw: string;
}
/** 대화의 '답을 기다림' 카드가 고정하는 귀속. 누를 때 서버가 지금 것과 같은지 다시 본다. */
export interface NativePromptContext {
  projectId: string;
  memberId: string;
  /** 세션 세대(새 세션·다시 열기마다 바뀐다) */
  generation: number;
  /** 지금 실행(턴)을 가르는 id. 실행 기록이 없으면 null */
  executionId: string | null;
  /** 그 실행이 받은 글의 작업(없으면 전체) */
  taskId: string | null;
  /** 창이 뜬 차례(같은 창이 다시 떠도 다르게 센다)와 창 지문 */
  promptId: string;
  /** 서버가 이 창을 처음 읽은 시각(카드 등록). 모르면 null */
  observedAt: string | null;
}
/** answered: 지금 창에는 이미 답을 넣었다(창이 그대로일 수 있다). 선택지를 다시 보이지 않는다. */
export interface NativePromptState { prompt: NativePrompt | null; context: NativePromptContext | null; answered?: boolean }
export interface AnswerNativePromptReq {
  operationId: string;
  /** 카드가 고정한 귀속. 지금 직원·프로젝트와 다르면 넣지 않는다 */
  projectId: string;
  memberId: string;
  promptId: string;
  generation: number;
  executionId: string | null;
  /** 고른 선택지 번호. text 와 함께면 그 줄이 자유 응답 줄이어야 한다 */
  option: number;
  text?: string;
  /** 답한 화면(기록 문구용). 없으면 대화 */
  via?: "inbox" | "thread";
}
export type NativeAnswerStatus = "answered" | "already_answered" | "changed" | "gone" | "busy" | "stale" | "unsupported" | "unknown";
/**
 * 터미널 접수: accepted 넣은 뒤 창이 닫히거나 바뀜 · unconfirmed 넣었지만 창이 그대로(다시 넣지 않음)
 * · not_sent 넣지 않음 · unknown 넣는 중 결과를 모름(다시 넣지 않음)
 */
export type NativeAnswerTerminal = "accepted" | "unconfirmed" | "not_sent" | "unknown";
/** 접수를 확인한 순간의 직원 CLI 상태. 명령 출력 자체가 아니다 */
export type NativeAnswerAfter = "working" | "blocked" | "idle" | "gone";
export interface NativeAnswerReceipt {
  operationId: string;
  status: NativeAnswerStatus;
  /** 사람에게 보일 한 줄 */
  note: string;
  memberId: string;
  promptId: string;
  option: number | null;
  label: string | null;
  /** 응답 기록: 서버가 이 답을 받아 적은 시각 */
  at: string;
  /** 카드 등록: 서버가 그 창을 처음 읽은 시각 */
  observedAt: string | null;
  terminal: NativeAnswerTerminal;
  /** 이후 상태(명령 결과 쪽). 넣지 않았거나 모르면 null */
  after: NativeAnswerAfter | null;
  /** 고른 줄이 거절이었는가 */
  reject: boolean;
}
export interface AnswerApprovalReq { fingerprint: string; option: number; /** 거절할 때 직원에게 전할 말 */ note?: string }

/** 전체 설정 하나가 전부다. 프로젝트마다 따로 두지 않는다. */
export interface Settings {
  /** PUT response only: inherited efforts cleared by a rank model change. */
  resetEfforts?: (`${"ranks" | "codexRanks"}.${Rank}.effort`)[];
  /** null 이면 아직 첫 실행 선택 전 */
  backend: Backend | null;
  permissionMode: PermissionMode;
  ranks: Ranks;
  codexRanks: Ranks;
  maxConcurrentTurns: number;
  compactAtPct: number; // 기본 70
  /**
   * 문맥 창 크기(토큰)를 모를 때 쓰는 값. 기본 1000000. 상태줄이 잘려 % 가 안 보이고 아직 그 직원의 창 크기를 배우지 못했을 때
   * 토큰 수를 이것으로 나눠 문맥 %(와 자동 압축)를 정한다. 실측값·저장값·상태줄 추정·모델별 표가 이보다 먼저다.
   */
  contextWindowDefault: number;
  /** 모델 id → 문맥 창 크기(토큰). 기본 표와 병합하며 세션 실측값이 항상 우선한다. */
  contextWindows: Record<string, number>;
  maxAwakeWorkers: number; // 기본 8
  /** 결재·할 일이 올라오면 서버 컴퓨터(맥)에 알림을 띄운다. */
  notifyMac: boolean;
  /** 총괄에게 판 정리(결재·내 할 일·진행판·지금 상황)를 맡기는 간격(시간). 0 이면 끈다. 기본 6. */
  boardTidyHours: number;
  /** 모든 실행 업무는 확정 계약을 요구한다. 옛 label 입력은 호환용으로 받고 required 로 정규화한다. */
  harnessMode: HarnessMode;
  /** 옛 클라이언트 호환 필드. 생성 시점 면제가 없으므로 서버는 항상 null 을 반환한다. */
  harnessRequiredSince: string | null;
}
export type HarnessMode = "label" | "required";

export interface RuntimeInfo { backend: "core"; core: { installed: boolean; available: boolean; version: string | null; detail: string | null }; providers: Record<CliProvider, { installed: boolean }>; memory?: MemoryServiceInfo }

export interface HerdrInfo { installed: boolean; running: boolean; version: string | null; protocol: number | null; compatible: boolean; warning: string | null }
export interface LiveAgent { paneId: string; name: string | null; agent: string | null; status: string; cwd: string | null; sessionId: string | null; workspaceId: string | null; tabId: string | null; adopted: boolean }

export interface ConnectionOverrides {
  sshHost?: string;
  sshUser?: string;
  sshPort?: number;
}

export type ConnectionPatch = { [K in keyof ConnectionOverrides]?: ConnectionOverrides[K] | null };

export interface ConnectionInfo {
  home: string;
  port: number;
  cli: string;
  ssh: { host: string; user: string; port: number };
}

export interface Bootstrap {
  version: string;
  runtime?: RuntimeInfo;
  settings: Settings;
  projects: ProjectSummary[];
  herdr: HerdrInfo;
  home: string;
  /** 서버가 실제로 듣고 있는 주소들. 다른 기기에서 들어올 주소를 안내한다. */
  urls: string[];
  /** 서버 컴퓨터의 터미널에서 이 CLI 를 부르는 명령. 설치돼 있으면 iamceo, 아니면 실행 파일 전체 경로. */
  cli: string;
  /** Current server's terminal destination; optional for older servers. */
  connection?: ConnectionInfo;
  /** 직급 값 대신 자기 값을 쓰는 직원 수. 직급 값을 바꿔도 이들에게는 먹지 않는다. */
  rankOverrides: Record<Exclude<Rank, "staff">, number>;
}

export interface ProjectState {
  workflow?: import("./workflow.ts").ProjectWorkflow;
  project: Project;
  members: Member[];
  decisions: Decision[]; // 열린 것 + 최근 처리 50. 더 오래된 처리 건은 GET /api/projects/:id/decisions?status=done&before=&limit=
  doneDecisionCount: number; // 처리된 결재 전체 수
  todos: Todo[];
  work: WorkItem[];
  messages: Message[]; // 최근 200, 오래된 → 최신
  files: FileDoc[];
  deliveryNotices?: DeliveryNotices;
  /** 작업들. 최근 등록한 것부터. 옛 서버는 보내지 않는다. */
  tasks?: Task[];
}

/** 보관함 GET 전용 DTO. 늦은 manual 기록이 가능하므로 불변 DB snapshot은 아니다. */
export interface ArchiveProjectState extends ProjectState { project: Project & { archived: true } }
/** 일반 page와 같은 strict query 4개/정렬. 없는/활성 프로젝트는 404. */
export type ArchiveMessagePage = MessagePage;

export interface SyncCursor { epoch: string; seq: number }
export interface SyncSnapshot {
  protocol: 2;
  cursor: SyncCursor;
  requestedProjectId: string | null;
  projectStatus: "none" | "ok" | "not_found" | "archived";
  bootstrap: Omit<Bootstrap, "runtime">;
  state: ProjectState | null;
  /** Opt-in latest page read synchronously with state/revisions/cursor. */
  history?: MessagePage;
  /** state/cursor와 같은 동기 읽기 경계. 선택 프로젝트가 없으면 members/todos는 빈 map. */
  revisions: import("./operations.ts").SyncRevisions;
}

/** WebSocket 서버→화면. 화면은 받으면 해당 조각만 고치거나 state 를 다시 받는다. */
export type WsEvent =
  | { type: "hello"; seq: number }
  /** 소켓이 살아 있다는 신호. 화면은 한동안 아무것도 안 오면 소켓을 새로 잇는다. */
  | { type: "ping" }
  | { type: "projects"; projects: ProjectSummary[] }
  | { type: "project"; project: Project }
  | { type: "member"; member: Member }
  | { type: "member_removed"; projectId: string; memberId: string }
  | { type: "decision"; decision: Decision }
  | { type: "todo"; todo: Todo }
  | { type: "work"; projectId: string; work: WorkItem[] }
  | { type: "message"; message: Message }
  | { type: "file"; file: FileDoc }
  | { type: "task"; task: Task }
  | { type: "activity"; projectId: string; activity: Activity }
  | { type: "settings"; settings: Settings }
  | { type: "herdr"; herdr: HerdrInfo };

export type WsChangeEvent = Exclude<WsEvent, { type: "hello" } | { type: "ping" }>;
/** 별도 v2 wire. 기존 WsEvent를 수정하거나 v1 객체에 cursor를 덧붙이지 않는다. */
export type RealtimeEvent =
  | ({ type: "hello"; protocol: 2; heartbeatMs: 15000; staleAfterMs: 45000 } & SyncCursor)
  | ({ type: "ping" } & SyncCursor)
  | (WsChangeEvent & SyncCursor);

// ---- REST 요청 ----
export interface CreateProjectReq { name: string; cwd: string; goal?: string; startConductor?: boolean; chiefCli?: CliProvider; /** 개발 기억 운영. 생략하면 켠다. */ memory?: boolean }
export interface CreateMemberReq { name: string; role?: string; cli?: CliProvider; modelOverride?: string | null }
export interface PatchProjectReq { name?: string; cwd?: string; runnerEnabled?: boolean; maxConcurrentTurns?: number | null; now?: string; archived?: boolean; /** 개발 기억 운영 켜기·끄기. 끈 값은 다른 기본값이 덮지 않는다. */ memory?: boolean }
/** PUT /api/settings. ranks·codexRanks 는 고친 칸만 보내도 된다(나머지 유지). */
export type SettingsPatch = Partial<Omit<Settings, "ranks" | "codexRanks" | "resetEfforts">> & {
  ranks?: Partial<Record<Rank, Partial<RankConfig>>>;
  codexRanks?: Partial<Record<Rank, Partial<RankConfig>>>;
};
/** PATCH /api/members/:id. null 이면 직급 기본으로 돌아간다. */
export interface PatchMemberReq { cli?: CliProvider; modelOverride?: string | null; effortOverride?: Effort | null; codexSpeed?: CodexSpeed }
/**
 * taskId: 보낸 순간 고른 업무. newTaskTitle: 새 업무 이름(taskId 와 함께 쓰지 않는다).
 * 둘 다 없으면 서버가 글 첫 줄로 이름 붙인 새 업무를 만든다(본사는 업무를 쓰지 않는다). 같은 id 로 다시 보내면 업무를 새로 만들지 않는다.
 */
export interface SendMessageReq { id?: string; text: string; targetMemberId?: string | null; attachmentIds?: string[]; taskId?: string | null; newTaskTitle?: string | null }
/** POST /api/members/:id/stop 의 조건('멈추고 이어서'는 글을 먼저 대기열에 고정한 뒤 이것을 부른다). 화면에서 본 실행 id·세션 세대와 지금이 다르면 멈추지 않는다(다른 턴을 끊지 않는다). */
export interface StopReq { expectRunId?: string | null; expectGeneration?: number | null }
/**
 * 멈춤 결과. 직원 한 명의 지금 CLI 턴 단위다(작업 하나만 따로 멈추지 않는다).
 * stopped: CLI 가 멈춤을 확인 · not_running: 멈출 턴이 없다(이미 끝남) · changed: 본 실행·세대와 달라 멈추지 않음 · failed: 멈추지 못함(턴은 계속)
 */
export interface StopResult {
  outcome: "stopped" | "not_running" | "changed" | "failed";
  memberId: string;
  memberName: string;
  runId: string | null;
  sessionGeneration: number;
  taskIds: string[];
  detail: string | null;
  member: Member;
}
export interface AnswerReq { expectedVersion?: string; choice?: string | null; note?: string | null; batch?: boolean }
export interface AdoptReq { paneId: string; name: string; role: string; handle?: string; kind?: "conductor" | "worker" }
/** conductor 다른 지휘자의 흔적 · folder 프로젝트 밖 폴더 · input 입력칸에 쓰던 글(넘겨받을 때 지운다). 편입을 막지는 않는다. */
export interface AdoptWarning { kind: "conductor" | "folder" | "input"; text: string }
/** GET /api/projects/:id/adopt/preview?pane=. 읽기만 한다. */
export interface AdoptPreview { paneId: string; name: string | null; cwd: string | null; status: string; sessionId: string | null; screen: string; refuse: string | null; warnings: AdoptWarning[] }
/** POST /api/projects/:id/tidy. already: 이미 판 정리 지시가 기다리거나 도는 중이라 새로 넣지 않았다. */
export interface TidyResult { already: boolean }
/** POST /api/members/:id/release. notified: 세션에 규칙이 풀렸다고 알렸다. paneKept: 칸은 그대로 있다. false 면 서버 칸을 닫았고 resumeCommand 로 이어 연다. */
export interface ReleaseResult { notified: boolean; paneKept: boolean; resumeCommand: string | null }

/** 지금 넘겨받을 수 없는 이유. null 이면 받을 수 있다(서버·화면 공통). */
export function adoptRefusal(a: Pick<LiveAgent, "agent" | "status" | "sessionId" | "adopted">): string | null {
  if (a.adopted) return "이미 직원 자리인 세션입니다";
  if (a.agent !== "claude") return `Claude 세션만 편입할 수 있습니다: ${a.agent ?? "알 수 없음"}`;
  if (a.status === "working") return "일하는 중입니다. 지금 턴이 끝나면 다시 시도하세요";
  if (a.status === "blocked") return "승인 창 앞에서 멈춰 있습니다. 터미널에서 푼 뒤 다시 시도하세요";
  if (a.status !== "idle" && a.status !== "done") return "아직 뜨는 중이거나 상태를 알 수 없습니다. 잠시 뒤 다시 시도하세요";
  // 세션 ID 를 모르면 턴 마지막 글을 읽을 수 없어 보고가 끊기고, 재시작 뒤 어느 칸인지도 가릴 수 없다.
  if (!a.sessionId) return "세션 ID 를 알 수 없어 받을 수 없습니다(herdr 의 Claude 연동을 확인하세요)";
  return null;
}

// ---- 직급 ----
export const DEFAULT_RANKS: Ranks = { manager: { model: null, effort: null }, lead: { model: null, effort: null }, staff: { model: null, effort: null } };
export const DEFAULT_CODEX_RANKS: Ranks = { manager: { model: null, effort: null }, lead: { model: null, effort: null }, staff: { model: null, effort: null } };

/** 세션의 직급. 총괄·본사 AI 는 부장, 직원 세션은 팀장. 서브에이전트(직원)는 세션이 없다. */
export function memberRank(kind: MemberKind): Exclude<Rank, "staff"> {
  return kind === "worker" ? "lead" : "manager";
}

/** 이 직원이 써야 할 값. 직원별 지정이 직급 기본을 이긴다. */
export function memberConfig(m: Pick<Member, "kind" | "modelOverride" | "effortOverride"> & Partial<Pick<Member, "cli">>, ranks: Ranks, codexRanks: Ranks = DEFAULT_CODEX_RANKS): RankConfig {
  // Antigravity has no rank defaults: model ids carry their own effort, and Claude/Codex rank values never apply to it.
  if (m.cli === "antigravity") return { model: m.modelOverride ?? null, effort: null };
  const rank = (m.cli === "codex" ? codexRanks : ranks)[memberRank(m.kind)];
  return { model: m.modelOverride ?? rank.model, effort: m.effortOverride ?? rank.effort };
}

/** 이름과 형식으로 자료의 모양을 정한다(서버·화면 공통). */
const TABLE_EXT = new Set(["csv", "tsv"]);
const CODE_EXT = new Set(["json", "jsonl", "ndjson", "txt", "log", "yaml", "yml", "toml", "xml", "ini", "conf", "sh", "bash", "zsh", "js", "jsx", "mjs", "cjs", "ts", "tsx", "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cc", "cpp", "hpp", "cs", "php", "sql", "css", "scss", "diff", "patch"]);
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "heic", "heif", "tif", "tiff"]);
const VIDEO_EXT = new Set(["mp4", "mov", "webm", "m4v", "mkv", "avi"]);
const AUDIO_EXT = new Set(["mp3", "wav", "m4a", "aac", "ogg", "flac", "opus"]);

export function fileKindOf(name: string, mime = ""): FileKind {
  const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase() ?? "";
  if (ext === "md" || ext === "markdown") return "document";
  if (ext === "html" || ext === "htm") return "artifact";
  if (ext === "pdf" || mime === "application/pdf") return "pdf";
  if (TABLE_EXT.has(ext)) return "table";
  if (CODE_EXT.has(ext)) return "code";
  if (IMAGE_EXT.has(ext) || mime.startsWith("image/")) return "image";
  if (VIDEO_EXT.has(ext) || mime.startsWith("video/")) return "video";
  if (AUDIO_EXT.has(ext) || mime.startsWith("audio/")) return "audio";
  if (mime === "text/html") return "artifact";
  if (mime === "text/csv" || mime === "text/tab-separated-values") return "table";
  if (mime.startsWith("text/") || mime === "application/json") return "code";
  return "file";
}

// ---- 에이전트 도구 이름 ----
/** ask_close·todo_close: 직원은 자기가 올린 결재·할 일만, 총괄·본사 AI 는 프로젝트 전체를 정리한다. */
export const FINAL_REVIEW_TOOLS = ["task_review", "task_review_evidence"] as const;
export const WORKER_TOOLS = ["status", "task", "ask", "post", "file", "todo", "ask_close", "todo_close", "server_check", "server_backup", "task_trace", "exec_diagnose", "code_read"] as const;
export const CONDUCTOR_TOOLS = ["team_add", "team_assign", "team_stop", "team_compact", "team_sleep", "team_resume", "team_close", "team_config", "terminal_read", "terminal_input", "roster", "project_now", "work_set", "work_list", "work_remove", "board", "harness_findings", "task_stage", "task_followup"] as const;
export const ROOT_TOOLS = ["project_create", "project_list", "board"] as const;
export const MANUAL_TOOLS = ["wait"] as const;
