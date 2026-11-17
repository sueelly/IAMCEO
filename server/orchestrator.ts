import { redactHarnessText } from "./harness-redaction.ts";
import { UNKNOWN_AGENT_RESULT } from "./agent-receipts.ts";
import { configuredSecretRoots } from "./secret-paths.ts";
import { readCodeSource, type CodeReadScope } from "./harness-source-read.ts";
import { createHash, randomUUID } from "node:crypto";
import { ModelCatalogReader } from "./models.ts";
import { DeliveryRecovery } from "./delivery-recovery.ts";
import { writeStatuslineWrapper } from "./runner/statusline.ts";
// Orchestrator: 전달 펌프, 턴 종료 처리, 압축 판단, 띄우기·잠재우기·다시 열기, 승인 근거 확인(spec §4·§6·§7).
//
// server/agent-tools.ts 가 쓰는 공개 메서드:
//   팀       addMember · assign · compactMember · sleepMember · resumeMember · closeMember · roster
//   보고     recordPost · registerAsk · setMemberStatus · setProjectNow · setWork
//   직접 CLI waitInbox · askWait
//   프로젝트 createProject · ensureConductor
//   그 밖의 읽기·쓰기(file·todo·project_list)는 orch.store 를 그대로 쓴다.
// agent-tools.ts 는 다음 두 함수를 내보낸다(AgentToolsImpl).
//   listAgentTools(member): AgentToolDef[]
//   handleAgentTool(orch, member, name, args): Promise<AgentToolResult>
//
// 조립 순서: createOrchestrator(config, store) → startServer(ctx) → setServerUrl(url) → recover() · 끝낼 때 shutdown().
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { bindingContract, completionGate, formatChecksLine, formatContract, type ContractInput, type HarnessFinding, type HarnessGate, type ReportCheckInput, type TaskContract } from "./harness.ts";
import { EXEC_CHECKS, inspectProviderEvidence, matchExecChecks, readProviderEvidence, researchGate, verifyClaims, type CheckEvidence, type ClaimInput, type ClaimResult } from "./harness-evidence.ts";
import type { LogSelectionObservation } from "./harness-exec-diagnostics.ts";
import type {
  AnswerNativePromptReq, NativeAnswerReceipt, NativePrompt, NativePromptContext, NativePromptState,
  AdoptPreview,
  AdoptReq,
  AnswerApprovalReq,
  ApprovalPrompt,
  AdoptWarning,
  AnswerReq,
  Attachment,
  Backend,
  CliProvider,
  CreateMemberReq,
  RuntimeInfo,
  CreateProjectReq,
  Decision,
  DecisionCloseKind,
  DecisionOption,
  Delivery,
  DeliveryKind,
  Effort,
  HerdrInfo,
  LiveAgent,
  MemoryServiceInfo,
  Member,
  MemberKind,
  Message,
  MessageKind,
  PatchProjectReq,
  Project,
  PatchMemberReq,
  ReleaseResult,
  SendMessageReq,
  Settings,
  SettingsPatch,
  StopReq,
  StopResult,
  MemberExecutionState,
  TidyResult,
  Task,
  TaskProgress,
  Todo,
  TodoOutcome,
  WorkItem,
  WorkSec,
} from "../shared/types.ts";
import { adoptRefusal, memberConfig, memberRank } from "../shared/types.ts";
import { VERSION, type Config } from "./config.ts";
import { listBackups, type BackupManager } from "./backup.ts";
import { normalizeHome } from "./home-owner.ts";
import type { AgentToolDef, AgentToolResult, AskWaitResult, OrchestratorApi } from "./orchestrator-api.ts";
import { sanitizeName } from "./files.ts";
import { josa, renderRole } from "./roles.ts";
import { DEFAULT_WATCH_LIMITS, watchNotice, watchOnReopen, watchOnReport, watchOnTick, type MarkFact } from "./task-progress.ts";
import { TaskContinuationCoordinator, taskScopeForDeliveryIds } from "./task-continuation.ts";
import { ordinaryInputAdmitted } from "./queue-admission.ts";
import { relatedWork } from "./workflow.ts";
import { STAGE_LABEL } from "../shared/task-stage.ts";
import { withOwnerLine, withRecLine } from "../shared/owner-lines.ts";
import { CoreError, coreRpc, type CoreHello, type CoreTerminal } from "./runner/core-client.ts";
import { CoreSupervisor } from "./core-supervisor.ts";
import type { DecisionFollowUp, DeliveryDispatch, ReportReferences, LifecycleJournal } from "./service-contracts.ts";
import type { IndependentDeliveryRequest, WorkflowAssignmentRequest, WorkflowAssignmentResult } from "../shared/workflow.ts";
import { commitWorkflowAssignment } from "./workflow-assignment.ts";
import { authorizeIndependentDelivery as commitIndependentDelivery, independentDeliveryAuthorized } from "./independent-delivery.ts";
import type { AgentOperationContext, ManualInboxBatch, ManualInboxAckRequest, ManualInboxAckResult, FreshSessionRequest, MemberConfigWriteResult, OperationReceipt, RevisionPrecondition, SettingsWriteResult, TerminalControlRequestV2, TerminalKey, TodoDoneRequest, TodoWriteResult } from "../shared/operations.ts";
import { coreContextMeasurement, observeCompactBoundary, type CompactBoundaryBaseline } from "./runner/core-context.ts";
import { readJsonlRange, parseCodexSessionMeta, jsonObject, providerLogRoot } from "./runner/delivery-evidence.ts";
import { ANTIGRAVITY_MODEL_RE, antigravityMemberHome, existingAntigravityTranscript } from "./runner/antigravity.ts";
import { defaultClaudeHome, findSessionFile } from "./runner/herdr.ts";
import { providerLaunch } from "./runner/providers.ts";
import { CoreRunner, ensureCoreServer, type CoreCompactState, type CoreRunnerDeps } from "./runner/core.ts";
import { isMissingSessionError } from "./runner/headless.ts";
import { HerdrError } from "./runner/herdr-client.ts";
import { detectHerdr, HerdrRunner, inspectPane, listAgents, type PaneInspection } from "./runner/herdr.ts";
import { approvalSummary } from "./runner/approval.ts";
import { exactSource, measureContext, validWindow } from "./runner/context.ts";
import type { Runner, RunnerEvent, RunnerMember, SendResult, StartOpts, TerminalControlAction, TerminalControlResult, RunnerStartResult, RunnerTerminalIdentity, DeliveryRepair } from "./runner/types.ts";
import { ApiError, provisionalTaskTitle, type AppliedConfig, type ExecutionJournal, type MemoryCapture, type NewDelivery, type Store } from "./store.ts";
import { cleanText, RESERVED_HANDLES } from "./text.ts";
import { MIGRATIONS, newId } from "./db.ts";
import { datedTitle, taskTitleFrom } from "./task-names.ts";
import { clip, DevMemory, devMemoryConfigFromEnv, findSensitive, memoryKindLabel, memoryTaskId, MemoryError, redactSensitive, stableEventId, type Experience, type ExperienceInput } from "./integrations/dev-memory.ts";
import { conductorHandle, conductorName } from "./text.ts";

// ---- 전달 글(§4). 서버만 만든다 ----
const SHORT_QUOTE = 4;
const QUOTE_SCAN_PAGES = 10;

export function normalizeSpace(text: string): string {
  return cleanText(text).replace(/\s+/g, " ").trim();
}

// 묶음 전달에서 글 안의 한 줄이 출처 접두어처럼 보이면 위조가 된다. 그런 줄의 맨 앞을 막는다.
// 목록·강조·표 기호를 씌우거나 다른 괄호로 바꿔도 같은 줄로 본다. 전각 괄호·호환 글자는 정규화해서 보고, 글자 사이 공백도 뺀다.
const LINE_NOISE = /^[\s\-*+#|`~_=:.,·•◦‣▪■□▶▷►●○※"'“”‘’«»]*(?:\d+[.)]\s*)?[\s*_`"'“”‘’]*/;
const OPENING = /^[\s*_`"'“”‘’\[({<【〔〖〘〚⟦「『〈《❲❴｟⟨⟪]+/;
const WITH_BRACKET = /^(?:대표|代表|총괄|보고|시스템)/;
const BARE_PREFIX = /^(?:대표(?:직접|답|글전문)|代表|사용자요청\(|총괄인용\(|(?:대표|총괄|보고|시스템):)/;

function looksForged(line: string): boolean {
  const head = line.normalize("NFKC").replace(LINE_NOISE, "");
  const opened = OPENING.exec(head);
  const rest = (opened ? head.slice(opened[0].length) : head).replace(/\s+/g, "");
  if (opened && /[\[({<【〔〖〘〚⟦「『〈《❲❴｟⟨⟪]/.test(opened[0]) && WITH_BRACKET.test(rest)) return true;
  return BARE_PREFIX.test(rest);
}

/** CR·U+2028 같은 숨은 줄바꿈과 제로폭 글자를 먼저 없앤 뒤 줄 머리를 본다. */
export function guardLines(text: string): string {
  return cleanText(text)
    .split("\n")
    .map((line) => (!line.trimStart().startsWith(">") && looksForged(line) ? `> ${line}` : line))
    .join("\n");
}

/** 직원·총괄이 쓴 여러 줄 글은 목록으로 막는 대신 줄마다 인용 표시를 붙인다. 어떤 모양을 지어내도 접두어 없는 입력으로 보이지 않는다. */
function quoteBlock(text: string): string {
  return cleanText(text)
    .split("\n")
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");
}

/** 직원이 쓴 값(카드 제목·버튼 글·설명·할 일 제목)을 따옴표 안에 넣는다. 따옴표를 닫아 대표 답을 지어내지 못하게 한다. */
function quotedInline(text: string): string {
  return normalizeSpace(text).replace(/[\\'"]/g, "\\$&");
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** 경로와 형식은 바깥에서 온 값이 섞인다. 한 줄이어야 줄을 끊어 접두어를 지어내지 못한다. */
function attachmentLines(attachments: Attachment[]): string[] {
  return attachments.map((a) => `첨부: ${normalizeSpace(a.path)} (${normalizeSpace(a.mime)}, ${humanSize(a.size)})`);
}

export function formatUserMessage(text: string, attachments: Attachment[], id: string, direct: boolean, task?: string | null): string {
  const lines = [`[대표${direct ? " 직접" : ""}] "${guardLines(text)}"`];
  lines.push(...attachmentLines(attachments));
  if (task) lines.push(task);
  lines.push(`#${id}`);
  return lines.join("\n");
}

/**
 * 전달 글의 작업 줄. 작업 제목·브랜치·경로는 직원이 쓴 값이라 한 줄로 따옴표 안에 넣는다.
 * task 가 null 이면 대표가 '전체'에서 보낸 글이다. 그 글의 보고를 직전 작업에 붙이지 않게 알린다.
 */
export function formatTaskLine(task: Task | null): string {
  if (!task) return "작업: 없음(업무가 붙기 전의 옛 글). 이 일의 post·ask·file·todo 에는 이어 갈 업무의 task_id 를 넣거나, 새 일이면 task 도구로 새 업무를 만들어 그 id 를 넣는다";
  const where = [task.branch ? `브랜치 '${quotedInline(task.branch)}'` : null, task.worktree ? `워크트리 '${quotedInline(task.worktree)}'` : null].filter(Boolean).join(" · ");
  const naming = provisionalTaskTitle(task) ? ` 이 이름은 서버가 글에서 지은 임시 이름이다. 목적이 드러나는 이름(40자 안)으로 task 도구(task_id "${task.id}", title)로 바꾸고, 대화 중 목적이 정해지거나 바뀌면 다시 바꾼다` : "";
  return `작업 #${task.id} '${quotedInline(task.title)}'${where ? ` · ${where}` : ""}. 이 작업의 글이다. 이 일의 post·ask·file·todo 에 task_id "${task.id}" 를 넣는다${naming ? `.${naming}` : ""}`;
}

/** 명령은 실행 데이터이므로 원문을 보존한다. 설명만 정리한다. 미확인 목록은 'unverified' 검사 한 줄로 붙인다(없다고 적은 것도 기록이다). */
function harnessChecks(input: PostInput): ReportCheckInput[] {
  const clean = (v: string) => cleanText(v).replace(/\s+/g, " ").trim();
  const checks = (input.checks ?? []).map(c => ({ name: clean(c.name), kind: c.kind, result: c.result, evidence: clean(c.evidence), command: c.command ?? null, criterion: c.criterion ?? null }));
  const unverified = (input.unverified ?? []).map(clean).filter(Boolean);
  if (input.unverified !== undefined) checks.push({ name: "미확인 항목", kind: "unverified", result: "pass", evidence: unverified.length ? unverified.join("; ") : "없음", command: null, criterion: null });
  return checks;
}

/** 계약 글의 제어 문자·빈 줄을 걷는다. 빈 합격 기준은 계약이 아니다. */
function cleanContract(input: ContractInput): ContractInput {
  const one = (v: string) => cleanText(v).replace(/\s+/g, " ").trim();
  const list = (v: string[] | undefined) => (v ?? []).map(one).filter(Boolean);
  const contract = { kind: input.kind, goal: one(input.goal), acceptance: list(input.acceptance), scope: input.scope ? one(input.scope) || null : null, forbidden: list(input.forbidden), evidence: list(input.evidence), ...(input.checks ? { checks: input.checks } : {}) };
  if (!contract.goal || !contract.acceptance.length) throw new ApiError(400, "계약에는 goal(원하는 결과)과 acceptance(합격 기준) 1개 이상이 필요합니다");
  return contract;
}

/** 결재 답·할 일 알림 끝에 붙는 작업 표지. 옛 카드(작업 없음)는 붙이지 않는다. */
function taskTag(taskId: string | null | undefined): string {
  return taskId ? ` · 작업 #${taskId}` : "";
}

export function formatAnswer(d: Decision): string {
  const option: DecisionOption | undefined = d.options.find((o) => o.k === d.choice);
  const head = `[대표 답(원문) '${quotedInline(d.title)}']`;
  const note = d.note ? guardLines(d.note) : null;
  const parts = [head];
  if (option) {
    parts.push(`"${quotedInline(option.label)}"${option.desc ? `(${quotedInline(option.desc)})` : ""}`);
    if (note) parts.push(`메모 "${note}"`);
  } else if (note) {
    parts.push(`"${note}"`);
  }
  if (d.batch) parts.push("(묶음 추천대로)");
  parts.push(`#${d.id}${taskTag(d.taskId)}`);
  return parts.join(" ");
}

export function formatTodoDone(t: Todo): string {
  return `[대표] '${quotedInline(t.title)}' 했음 #${t.id}${taskTag(t.taskId)}`;
}

export function formatTodoUndone(t: Todo): string {
  return `[대표] '${quotedInline(t.title)}' 아직 안 했음(체크를 풀었습니다) #${t.id}${taskTag(t.taskId)}`;
}

/** 총괄에게 작업 id 를 어디서 얻는지 알리는 꼬리말. */
const WORK_TASK_HINT = ". 진행판 일 항목의 일이면 맡기기 전에 work_set 으로 항목을 만들고, 결과의 대화 작업 id(tk_w_…)를 넣으세요.";

export interface QuoteSource {
  id: string;
  text: string;
  /** 대표가 쓰거나 고른 시각 */
  at?: string | null;
  /** 버튼 글이면 그 결재 카드의 제목. 버튼 글만으로는 무엇에 대한 답인지 알 수 없다. */
  card?: string | null;
}

export interface VerifiedQuote {
  text: string;
  verified: boolean;
  /** 맞은 대표 글. 일부 인용이면 전문을, 전체 인용이면 #id 와 시각을 함께 보내 판단 재료를 준다. */
  source?: QuoteSource | null;
}

/** '진행' 같은 버튼 글·짧은 글은 다른 안건의 답일 수 있다. 맞더라도 승인으로 바로 치지 말라고 표시한다. */
export function quoteNeedsContext(quote: VerifiedQuote): boolean {
  if (!quote.verified || !quote.source) return false;
  return quote.source.card != null || normalizeSpace(quote.text).length < SHORT_QUOTE;
}

const QUOTE_SOURCE_MAX = 1000;

export function formatInstruction(name: string, text: string, quote: VerifiedQuote | null): string {
  const lines = [`[총괄] ${name}에게`];
  if (quote) {
    const cited = normalizeSpace(quote.text);
    const label = !quote.verified ? "총괄 인용(미확인)" : quoteNeedsContext(quote) ? "사용자 요청(문맥 확인 필요)" : "사용자 요청(원문, 서버 확인)";
    const source = quote.source ? normalizeSpace(quote.source.text) : "";
    const whole = !!quote.source && source === cited;
    const stamp = quote.source?.at ? ` ${quote.source.at}` : "";
    const origin = !whole || !quote.source ? "" : quote.source.card != null ? ` 결재 #${quote.source.id} '${quotedInline(quote.source.card)}'에서 고른 답${stamp}` : ` #${quote.source.id}${stamp}`;
    lines.push(`${label}: "${cited}"${origin}`);
    if (quote.source && !whole) {
      lines.push(`대표 글 전문 #${quote.source.id}: "${source.length > QUOTE_SOURCE_MAX ? `${source.slice(0, QUOTE_SOURCE_MAX)}…` : source}"`);
    }
  }
  // 첫 줄 뒤는 총괄이 쓴 글이다. 어떤 모양이어도 줄 머리가 접두어처럼 보이지 않게 인용 표시를 붙인다.
  const [first, ...rest] = cleanText(text).split("\n");
  lines.push(`할 일: ${first}`);
  if (rest.length > 0) lines.push(quoteBlock(rest.join("\n")));
  return lines.join("\n");
}

export function formatReport(name: string, kind: string, title: string, body: string): string {
  const head = `[보고 ${name}] ${kind}: ${normalizeSpace(title)}`;
  return body ? `${head}\n${quoteBlock(body)}` : head;
}

export function formatSystem(text: string): string {
  return `[시스템] ${text}`;
}

/** 판 정리 지시의 머리. 대기열에 이미 있는지, 이번 턴이 판 정리였는지 이것으로 가린다. */
export const TIDY_HEAD = formatSystem("판 정리");

/** 총괄(본사는 본사 AI)에게 넣는 판 정리 지시. 본사 AI 에게는 진행판·지금 상황 도구가 없다. */
export function formatTidy(kind: MemberKind, manual: boolean): string {
  const tools =
    kind === "root"
      ? "이미 정해졌거나 필요 없어진 결재는 `ask_close`, 끝났거나 필요 없어진 할 일은 `todo_close`."
      : "이미 정해졌거나 필요 없어진 결재는 `ask_close`, 끝났거나 필요 없어진 할 일은 `todo_close`, 진행판은 `work_set`·`work_remove`, 전체 그림은 `project_now`.";
  return [
    `${TIDY_HEAD}${manual ? "(대표가 눌렀습니다)" : ""}: 열린 결재·내 할 일·진행판·지금 상황을 지금 상태에 맞춰라.`,
    "- `board` 로 판을 보고, 대화·보고·세션 기록으로 판단한다.",
    `- ${tools}`,
    "- 대표가 아직 정하지 않은 결재는 대신 닫지 않는다. 확실하지 않으면 그대로 둔다. 직원은 깨우지 않는다.",
    "- 바뀐 게 있으면 `post`(알림) 한 줄로 무엇을 정리했는지 알린다. 없으면 아무것도 올리지 말고 턴을 끝낸다.",
  ].join("\n");
}

/** 실행 기록·활동에 남기는 멈춤 이유. by 는 "user" 또는 "agent-<직원 id>". */
function stopReason(by: string | null): string {
  return by === "user" ? "대표가 멈췄습니다" : by?.startsWith("agent-") ? "총괄이 멈췄습니다" : "멈춤 요청으로 턴이 끝났습니다";
}

function isTidy(d: Pick<Delivery, "kind" | "text">): boolean {
  return d.kind === "system" && d.text.startsWith(TIDY_HEAD);
}

// ---- 공개 타입 ----
export interface AgentToolsImpl {
  listAgentTools(member: Member, opts?: { memory?: boolean }): AgentToolDef[] | Promise<AgentToolDef[]>;
  handleAgentTool(orch: Orchestrator, member: Member, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<AgentToolResult>;
}

/** herdr 어댑터만의 기능. Runner 인터페이스 밖이다. */
export interface HerdrCapable extends Runner {
  /** 재시작 뒤 snapshot 으로 sessionId→pane 재결합. 없으면 null. */
  reattach(m: RunnerMember): Promise<{ paneId: string; tabId: string | null } | null>;
  /** 표지가 칸에 이미 들어갔는가(재시작 복구). 기록이나 화면으로 확인한다. */
  promptSeen?(m: RunnerMember, markers: string[]): Promise<boolean>;
  /** 칸이 쉬고 있을 때 세션 기록의 마지막 글. since 뒤에 쓰인 것만 준다(서버가 꺼진 사이 끝난 턴의 보고). */
  finishedWhileAway?(m: RunnerMember, since: string): { finalText: string; isError: boolean } | null;
  /** 칸을 옮기지도 이름을 바꾸지도 않고 세션을 맡는다. */
  adopt(m: RunnerMember, paneId: string, o: StartOpts): Promise<{ sessionId: string | null; paneId: string; tabId: null }>;
  /** 칸과 세션은 그대로 두고 손을 뗀다. */
  release(m: RunnerMember, notice: string | null): Promise<{ notified: boolean }>;
  /** 명부에서 빠진 직원의 추적을 지우고 다시 묶지 않는다. */
  dropMember?(memberId: string): void;
}

/** 소켓에서 읽기만 하는 herdr 조회. 실행기가 없어도(시험·미설치) 화면은 떠야 해서 따로 둔다. */
export interface HerdrQueries {
  info(): Promise<HerdrInfo>;
  agents(): Promise<LiveAgent[]>;
  /** 편입 전 살펴보기(화면·명령줄·기록). 없으면 칸의 목록 정보만 본다. */
  inspect?(a: LiveAgent): Promise<PaneInspection>;
}

export interface OrchestratorTimings {
  inputBusyRetryMs: number;
  /** A pump still running after this long is reported once (diagnostics only). */
  stuckPumpMs: number;
  inputBusyLimitMs: number;
  retryMs: number;
  tickMs: number;
  compactTimeoutMs: number;
  /** 입력을 읽기 전에 오류로 끝난 턴을 다시 보내기까지(시도마다 곱한다). */
  turnErrorRetryMs: number;
  /** 직접 띄운 CLI: 도구 호출이 이만큼 없으면 일하는 중을 대기로, 안 보임으로 본다. */
  manualIdleMs: number;
  manualOfflineMs: number;
  /** 실행기가 켜졌는지 꺼졌는지 다시 보는 간격. 화면의 입력 허용이 이것을 따른다. */
  healthMs: number;
  /** 반복 감시(구현 기본값, 대표 정책 아님): 직원 쪽 단계에서 진척 없이 이만큼 지나면 자동 반복을 멈추고 총괄에게 한 번 알린다. */
  loopIdleMs: number;
  /** 반복 감시: 같은 실패 지문의 막힘이 이만큼 이어지면 멈춘다. 기존 재시도 상한(3)과 같다. */
  loopSameLimit: number;
  /** 미완료 업무의 후속 조정을 다시 확인하는 최소 간격. 실행·모델 한도는 바꾸지 않는다. */
  continuationMs: number;
}

const DEFAULT_TIMINGS: OrchestratorTimings = {
  inputBusyRetryMs: 5000,
  stuckPumpMs: 60_000,
  inputBusyLimitMs: 60_000,
  retryMs: 5000,
  tickMs: 30_000,
  compactTimeoutMs: 600_000,
  turnErrorRetryMs: 60_000,
  manualIdleMs: 5 * 60_000,
  manualOfflineMs: 30 * 60_000,
  healthMs: 5000,
  loopIdleMs: DEFAULT_WATCH_LIMITS.idleMs,
  loopSameLimit: DEFAULT_WATCH_LIMITS.sameLimit,
  continuationMs: 30_000,
};

/** 설정·병렬 제어 오류의 제한된 재시도 상한. 업무 입력은 전달 복구만 재시도한다. */
const MAX_TURN_ERROR_ATTEMPTS = 3;
/** 실행 방식을 바꿀 때 이미 돌던 전달을 기다리는 시간. 넘으면 거부한다. */
const SWITCH_SETTLE_MS = 5000;

export interface OrchestratorDeps {
  config: Pick<Config, "home" | "rolesDir" | "port"> & Partial<Pick<Config, "claudeBin" | "codexBin" | "antigravityBin" | "antigravityRoot" | "coreBin" | "coreSocket" | "claudeHome" | "codexHome">>;
  store: Store;
  runners: Map<Backend, Runner>;
  herdr?: HerdrQueries;
  serverUrl?: string;
  agentTools?: AgentToolsImpl;
  timings?: Partial<OrchestratorTimings>;
  /** 맥 알림. 시험에서는 넣지 않으면 아무것도 안 한다. */
  notifier?: (title: string, body: string) => void;
  deliveryRecovery?: DeliveryRecovery;
  /** 주입한 CoreRunner와 같은 기록 루트. 시험은 임시 경로만 사용한다. */
  providerHomes?: { claudeHome: string; codexHome: string; antigravityRoot?: string };
  /** 개발 기억(Hindsight 게이트웨이) 연결. 없으면 외부 호출 0건이고 기억 도구도 보이지 않는다. */
  devMemory?: DevMemory | null;
}

export interface NewMemberInput {
  cli?: CliProvider;
  modelOverride?: string | null;
  /** 직원별 effort. 그 CLI·모델이 지원하지 않으면 거절한다(바꿔 끼우지 않는다). */
  effortOverride?: string | null;
  name: string;
  role?: string;
  handle?: string;
  cwd?: string;
  kind?: Exclude<MemberKind, "root">;
  firstInstruction?: string;
  userQuote?: string;
  parallel?: boolean;
  /** 첫 지시가 속한 업무. 업무를 쓰는 프로젝트에서 첫 지시를 주면 꼭 있어야 한다(instructionTask 로 정한다). */
  taskId?: string | null;
}

export interface AssignInput {
  text: string;
  userQuote?: string;
  parallel?: boolean;
  urgent?: boolean;
  /** 대표 메시지의 첨부 id. 그 직원 폴더로 이어 경로를 알린다. */
  attachmentIds?: string[];
  /** 이 지시가 속한 작업. 없으면 받는 직원의 지금 작업을 비운다. */
  taskId?: string | null;
  /** 업무 시작 계약. 주면 그 업무의 새 판으로 남기고 지시에 싣는다. */
  contract?: ContractInput;
}

export interface AssignResult {
  delivery: Delivery;
  /** 앞에 일이 있어 기다리면 대기열 위치(1부터), 곧바로 들어가면 0. */
  position: number;
  verified: boolean | null;
  /** 맞았지만 버튼 글·짧은 글이라 '문맥 확인 필요'로 나갔다. */
  needsContext: boolean;
}

export interface PostInput {
  kind: Extract<MessageKind, "완료" | "진행" | "막힘" | "알림" | "질문">;
  title: string;
  body?: string;
  fileIds?: string[];
  decisionId?: string | null;
  correctsMessageId?: string | null;
  /** 이 글이 확인한 다른 직원의 보고 원본 id. '알림'이면 그 보고를 받은 입력의 보고 의무를 마감한다. */
  aboutReportId?: string | null;
  /** 대표가 할 일 한 줄. 서버가 본문 첫 줄에 '● 대표 차례: …'로 쓴다(shared/owner-lines.ts). */
  ownerAction?: string | null;
  /** 생략하면 직원의 지금 작업. null 이면 전체(작업 없음). */
  taskId?: string | null;
  /** 실제로 돌린 검사. 계약이 있는 업무의 완료는 이것으로 판정한다. */
  checks?: ReportCheckInput[];
  /** 확인하지 못한 것. 'unverified' 검사 한 줄로 남는다. */
  unverified?: string[];
  /** 검사가 따른 계약 판 번호. 계약이 있는 업무의 완료는 지금 판과 같아야 받는다. */
  contractRev?: number | null;
  /** 조사 주장. 사실 주장은 출처·원문 인용이 직원이 본 도구 결과나 자료 본문과 맞아야 한다. */
  claims?: ClaimInput[];
  /** 독립 검토가 필요하면 확인할 변경과 수용 기준. 총괄이 기존 다른 직원에게 검토를 맡길 근거다. */
  reviewNeeded?: string | null;
}

export interface AskInput {
  title: string;
  detail?: string;
  options?: DecisionOption[];
  rec?: string | null;
  group?: string | null;
  fileId?: string | null;
  images?: Attachment[];
  /** 권장 이유 한 줄. rec 가 있으면 서버가 detail 첫 줄에 '★ 권장: <label> — <이유>'로 쓴다(shared/owner-lines.ts). */
  recReason?: string | null;
  /** 생략하면 직원의 지금 작업. null 이면 전체(작업 없음). */
  taskId?: string | null;
}

/** 같은 안건인지 볼 때 제목에서 빈칸·문장부호·대소문자 차이를 지운다. */
export function askTitleKey(title: string): string {
  const plain = title.normalize("NFKC").toLowerCase();
  return plain.replace(/[\s\p{P}\p{S}]+/gu, "") || plain.trim();
}

/** 같은 안건인지 볼 때 제목 말고도 묶음·자료·그림이 같아야 한다. 같은 제목으로 시안 여러 장을 묻는 일은 다른 안건이다. */
export function askSameItem(d: Pick<Decision, "title" | "group" | "fileId" | "images">, input: AskInput): boolean {
  const imgs = (list: readonly Attachment[] | undefined) => (list ?? []).map((a) => `${a.name}:${a.size}`).sort().join("|");
  return askTitleKey(d.title) === askTitleKey(input.title) && (d.group ?? null) === (input.group ?? null) && (d.fileId ?? null) === (input.fileId ?? null) && imgs(d.images) === imgs(input.images);
}

export interface RosterEntry {
  handle: string;
  name: string;
  role: string;
  kind: MemberKind;
  status: Member["status"];
  now: string;
  next: string;
  queued: number;
  openDecisions: number;
  contextPct: number | null;
  subagents: number;
  parallel: boolean;
  updatedAt: string;
  /** 세션이 써야 할 값(직원별 지정 > 직급 기본). null 은 CLI 기본. */
  model: string | null;
  effort: Effort | null;
  /** 서브에이전트에 쓰는 값. */
  subagentModel: string | null;
  subagentEffort: Effort | null;
  /** 지금(또는 마지막) 실행. team_stop 의 expect_run_id 로 쓴다. 한 턴이 여러 작업을 받을 수 있다. */
  run: { id: string; phase: MemberExecutionState["phase"]; taskIds: string[] } | null;
}

interface Turn {
  kind: "work" | "compact" | "control";
  admitted: boolean;
  boardReview?: { requestedRevision: number; reviewedRevision: number | null };
  text: string;
  interrupted: boolean;
  /** 이 턴으로 나간 전달. 수신 여부는 별도 복구 증거로만 판단한다. */
  deliveries?: Delivery[];
}

interface Runtime {
  /** 화면 추정은 토큰이 달라진 다음 읽기와 맞아야 저장한다. */
  contextCandidate: { sessionId: string | null; window: number; tokens: number } | null;
  turn: Turn | null;
  pumping: Promise<void> | null;
  /** Where the current pump is waiting and since when (diagnostics only; never used to send or interrupt). */
  pumpStage: string | null;
  pumpSince: number | null;
  pumpReported: boolean;
  again: boolean;
  posted: boolean;
  delegated: boolean;
  direct: boolean;
  /** 방금 압축했거나 압축이 실패했다. 다음 턴이 끝나 새 usage 를 받기 전까지 다시 압축하지 않는다. */
  skipCompact: boolean;
  compactRequest: string | null;
  compactTimer: ReturnType<typeof setTimeout> | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  inputBusySince: number | null;
  wantParallel: boolean | null;
  /** 세션을 띄우는 중. 끝날 때까지 전달하지 않는다(둘이 함께 띄우면 칸이 둘 생기고 순서가 뒤집힌다). */
  starting: Promise<void> | null;
  reopening: Promise<Member | null> | null;
  /** 닫는 중. 틱이 대기열을 보고 세션을 다시 열면 명부 밖 칸이 남는다. */
  closing: boolean;
  /** 병렬 설정을 다시 시도한 횟수. 끝내 안 되면 총괄에게 알리고 일을 내보낸다. */
  parallelFails: number;
  /** 이 시각까지는 전달하지 않는다(입력을 못 읽고 끝난 턴을 곧바로 되풀이하지 않게). */
  holdUntil: number;
  /** 재결합 중에는 working 을 '대표가 터미널에 친 일'로 보지 않는다. */
  reattaching: boolean;
  /** 새 설정으로 다시 열기를 실패한 횟수와, 포기한 설정. 설정이 또 바뀌면 다시 시도한다. */
  configFails: number;
  configGaveUp: string | null;
  /** 도구 목록이 바뀌어 같은 대화를 이어 다시 열려다 실패한 지문. 같은 지문으로는 다시 시도하지 않고 옛 세션으로 일을 잇는다. */
  toolsGaveUp: string | null;
  /** 턴을 마치고 뒤 작업(워크플로 등)을 기다리는 중이면 그 작업. 그 팀은 일하는 중이고 세션은 글을 바로 받는다(herdr). */
  background: string | null;
  /** 대표·총괄이 멈춘 실행. CLI 가 멈춤을 확인하면 confirmed. 그 턴이 끝날 때 실행 기록을 '중단'으로 남기고 보고 보완을 요청하지 않는다. */
  stopRequest: { runId: string | null; by: string; at: string; confirmed: boolean } | null;
}

const HOLD_NOTES: Record<string, string> = {
  delivery_unknown: "전달 여부를 확인할 수 없어 보류했습니다. 중복 실행 방지를 위해 자동 재전송하지 않습니다",
  legacy_session: "이전 실행기의 세션입니다. 새 core 세션이 필요합니다",
  blocked: "승인 창 앞에서 멈춤",
  input_busy: "입력칸에 넣지 못함(선택 창 등)",
  asleep: "잠듦",
  offline: "세션이 보이지 않음",
  backend_down: "실행기에 연결할 수 없음",
  runner_disabled: "실행이 꺼져 있음",
  archived: "보관되어 멈춤",
};

/** 턴 오류·전달 오류가 이어질 때 ref 없는 전달(보고·지시·완료)을 다시 보내는 간격의 배수. 잃지 않되 사용량을 태우지 않게 멀리 둔다. */
const HELD_RETRY_FACTOR = 5;

const WAKE_POST_KINDS = new Set<string>(["완료", "막힘", "질문"]);
/** 보고 의무를 마감할 수 있는 도구. 실행이 끝날 때 결과가 안 돌아왔으면 보고 판정을 미룬다. */
const REPORT_CLOSING_TOOLS = new Set<string>(["post", "ask", "ask_close", "team_assign", "team_add", "team_resume"]);

/** Domain references also include orphan answers and todo correction notices. */
class OrchestratorDeliveryRecovery extends DeliveryRecovery {
  constructor(private readonly sourceStore: Store, runner: (member: Member) => Pick<Runner, "inspectDelivery" | "repairDelivery"> | null) {
    super({ store: sourceStore, runner,
      canRepair: (member, deliveries) => deliveries.every(d => sourceStore.taskSequenceBlocker(member.id, sourceStore.deliveryTaskId(d.id)) === null),
    });
  }
  override sourceRevision(delivery: Delivery): string | null {
    const revision = super.sourceRevision(delivery);
    if (revision !== null) return revision;
    if (delivery.refType === "decision" && delivery.refId) {
      const decision = this.sourceStore.getDecision(delivery.refId);
      if (decision && decision.projectId === delivery.projectId && ["answered", "delivered"].includes(decision.status) &&
        (!decision.memberId || !this.sourceStore.getMember(decision.memberId)) && this.sourceStore.getConductor(delivery.projectId)?.id === delivery.memberId) {
        return createHash("sha256").update(JSON.stringify({ decision, memberId: delivery.memberId })).digest("hex");
      }
    }
    if (delivery.refType === "todo" && delivery.refId) {
      const todo = this.sourceStore.getTodo(delivery.refId);
      if (todo && todo.projectId === delivery.projectId && (delivery.kind === "system" || delivery.text === formatTodoUndone(todo))) {
        return createHash("sha256").update(JSON.stringify({ todo, revision: this.sourceStore.todoRevision(todo.id), text: delivery.text, memberId: delivery.memberId })).digest("hex");
      }
    }
    return null;
  }
}

/** Runner의 외부 입력 baseline/cursor도 기존 세대별 문맥 행에 함께 저장한다. */
export function coreCompactStore(store: Store): NonNullable<CoreRunnerDeps["compactStore"]> {
  return {
    load(memberId) {
      const state = store.ensureContextState(memberId);
      const saved = state?.baseline?.coreCompact as CoreCompactState | undefined;
      if (!saved) {
        if (state.compaction && ["sending", "running", "uncertain"].includes(state.compaction.phase)) throw new ApiError(409, "미확정 압축의 baseline이 없어 자동 입력을 보류합니다");
        return null;
      }
      if (!saved.baseline || !["sending", "running", "uncertain", "succeeded", "failed"].includes(saved.phase)) throw new ApiError(409, "압축 기록이 손상되어 자동 입력을 보류합니다");
      if (saved.baseline.generation !== state.generation) return null;
      if (["sending", "running"].includes(saved.phase)) {
        const uncertain: CoreCompactState = { ...saved, phase: "uncertain" };
        store.saveContextState({ ...state, baseline: { ...state.baseline, coreCompact: uncertain },
          compaction: state.compaction ? { ...state.compaction, phase: "uncertain", reason: "send_uncertain" } : null });
        return uncertain;
      }
      return saved;
    },
    save(memberId, compact) {
      const state = store.ensureContextState(memberId);
      const member = store.requireMember(memberId);
      if (state.generation !== compact.baseline.generation || member.sessionId !== compact.baseline.sessionId || member.paneId !== compact.baseline.terminalId) throw new ApiError(409, "문맥 세대나 세션이 변경되었습니다");
      const before = state.compaction;
      if (before && before.id !== compact.id && (compact.phase !== "sending" || !["queued", "succeeded", "failed"].includes(before.phase))) throw new ApiError(409, "다른 압축 작업의 결과입니다");
      if (before?.id === compact.id && ["succeeded", "failed"].includes(before.phase) && compact.phase !== before.phase) return;
      const at = new Date().toISOString();
      store.saveContextState({ ...state,
        measurement: compact.phase === "sending" || compact.phase === "succeeded" ? null : state.measurement,
        baseline: { ...state.baseline, coreCompact: compact },
        compaction: { id: compact.id, trigger: before?.trigger ?? "manual", phase: compact.phase,
          reason: compact.phase === "uncertain" ? "send_uncertain" : compact.phase === "failed" ? "provider_error" : null,
          requestedAt: before?.requestedAt ?? at, startedAt: new Date(compact.startedAt).toISOString(),
          finishedAt: ["succeeded", "failed"].includes(compact.phase) ? at : null },
      }, compact.phase === "sending" || compact.phase === "succeeded" ? { contextPct: null } : {});
    },
  };
}

/** 실제 실행기로 조립한다. herdr 는 설정의 소켓만 쓴다. */
export function createOrchestrator(config: Config, store: Store): Orchestrator {
  const runners = new Map<Backend, Runner>();
  let orchestrator: Orchestrator | null = null;
  const deliveryRecovery = new OrchestratorDeliveryRecovery(store, member => orchestrator?.recoveryRunner(member) ?? null);
  runners.set("core", new CoreRunner({ contextHome: config.home, coreBin: config.coreBin, socketPath: config.coreSocket, session: "iamceo", stateDir: join(config.home, "core-state"), configDir: join(config.home, "core-config"), claudeBin: config.claudeBin, codexBin: config.codexBin, antigravityBin: config.antigravityBin, antigravityRoot: config.antigravityRoot }, {
    recoveryStore: store,
    compactStore: coreCompactStore(store),
    repair: deliveryRecovery.repair,
    // Generation 1 has no post-write drain or external-attach barrier. Unknown
    // writes stay unresolved; do not manufacture externalInput:false here.
    quiescence: (_memberId, dispatch) => ({ originalWrite: dispatch.transportState === "rejected" ? "rejected" : dispatch.transportState === "accepted" ? "settled" : "unresolved", externalInput: null }),
  }));
  const herdr: HerdrQueries = { info: () => detectHerdr(config.herdrSocket), agents: () => listAgents(config.herdrSocket), inspect: (a) => inspectPane(config.herdrSocket, a) };
  const memoryConfig = devMemoryConfigFromEnv(process.env);
  orchestrator = new Orchestrator({ config, store, runners, herdr, deliveryRecovery, providerHomes: { claudeHome: defaultClaudeHome(), codexHome: process.env.CODEX_HOME || join(homedir(), ".codex"), antigravityRoot: config.antigravityRoot }, notifier: macNotifier(), devMemory: memoryConfig ? new DevMemory(memoryConfig) : null });
  return orchestrator;
}

/** 인자로 넘기므로 글에 무엇이 있어도 AppleScript 로 해석되지 않는다. */
function macNotifier(): ((title: string, body: string) => void) | undefined {
  if (process.platform !== "darwin" || process.env.IAMCEO_TEST === "1") return undefined;
  return (title, body) => {
    try {
      Bun.spawn(["osascript", "-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", "--", title, body], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
    } catch (e) {
      console.warn("맥 알림 실패:", (e as Error).message);
    }
  };
}

export class Orchestrator implements OrchestratorApi {
  readonly store: Store;
  readonly deliveryRecovery: DeliveryRecovery;
  private readonly deliveryEpoch = randomUUID();
  private readonly config: OrchestratorDeps["config"];
  private readonly runners: Map<Backend, Runner>;
  private readonly timings: OrchestratorTimings;
  private readonly taskContinuations: TaskContinuationCoordinator;
  private readonly herdr: HerdrQueries | null;
  private agentTools: AgentToolsImpl | null;
  readonly devMemory: DevMemory | null;
  private memoryReconcileTimer: ReturnType<typeof setInterval> | null = null;
  private serverUrl: string;
  private runtimes = new Map<string, Runtime>();
  /** 직원별로 도는 멈춤 요청. 겹쳐 누르면 같은 결과를 받는다. */
  private stopping = new Map<string, Promise<StopResult>>();
  /** 동시 턴 상한에 걸려 기다리는 직원. 턴이 끝나면 차례로 다시 민다. */
  private waiting = new Set<string>();
  private askWaiters = new Map<string, Set<() => void>>();
  private inboxWaiters = new Map<string, Set<() => void>>();
  private tick: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private readonly notifier: ((title: string, body: string) => void) | null;
  /** 소켓이 안 닿아 재결합하지 못한 herdr 직원. 틱이 다시 시도한다. */
  private unattached = new Set<string>();
  /** 보관 전에 넘겨받은 칸을 끝내는 중인 프로젝트. 전달은 보관된 것처럼 멈춘다. */
  private archiving = new Set<string>();
  private lastHerdrInfo: string | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private healthProbe: Promise<void> | null = null;
  private switching = false;
  private recovering = false;
  private stopRecovery: Promise<void> | null = null;
  private readonly coreSupervisor: CoreSupervisor | null;
  private readonly eventQueues = new Map<string, Promise<void>>();
  private readonly observedTurns = new Map<string, { generation: number; terminal: string | null; turn: number; ended: number }>();
  private readonly configWrites = new Set<string>();
  private settingsWriting = false;
  private readonly projectPatches = new Set<string>();
  private readonly terminalMutations = new Set<string>();
  private readonly agentOperations = new Map<string, Promise<AgentToolResult>>();
  /** 결과가 아직 안 돌아온 보고·질문·위임 도구 수(직원별). 0 이 되면 미뤄 둔 보고 판정을 한다. */
  private readonly inflightReportTools = new Map<string, number>();
  private readonly deferredReportChecks = new Map<string, Set<string>>();
  private readonly providerHomes: OrchestratorDeps["providerHomes"];

  private readonly models: ModelCatalogReader;

  constructor(deps: OrchestratorDeps) {
    this.models = new ModelCatalogReader(deps.config);
    this.store = deps.store;
    this.providerHomes = deps.providerHomes;
    this.config = deps.config;
    this.runners = deps.runners;
    this.deliveryRecovery = deps.deliveryRecovery ?? new OrchestratorDeliveryRecovery(this.store, member => this.recoveryRunner(member));
    if (!this.runners.has("core")) {
      const selected = this.store.getSettings().backend;
      this.store.setRuntimeBackend(selected && this.runners.has(selected) ? selected : this.runners.has("headless") ? "headless" : "herdr");
    }
    this.timings = { ...DEFAULT_TIMINGS, ...deps.timings };
    this.taskContinuations = new TaskContinuationCoordinator(this.store, { intervalMs: this.timings.continuationMs, sameLimit: this.timings.loopSameLimit });
    this.herdr = deps.herdr ?? null;
    this.agentTools = deps.agentTools ?? null;
    this.devMemory = deps.devMemory ?? null;
    // 어느 프로젝트가 기억을 쓰는지는 프로젝트 설정이 정한다. 환경 목록은 값이 없는 이전 프로젝트에만 쓴다.
    this.store.setLegacyMemoryProjects(this.devMemory?.config.projects ?? []);
    this.devMemory?.setProjectGate((projectId) => this.store.getProject(projectId)?.memory?.on ?? false);
    this.devMemory?.start(this.store);
    if (this.devMemory) {
      queueMicrotask(() => { if (!this.closed) this.reconcileDecisionMemory(); });
      this.memoryReconcileTimer = setInterval(() => this.reconcileDecisionMemory(), 10 * 60_000);
      (this.memoryReconcileTimer as { unref?: () => void }).unref?.();
    }
    // 도구 지문은 세션을 띄울 때 같이 적는다. 도구 모듈을 미리 읽어 두면 첫 세션부터 지문이 남는다.
    void this.tools().catch(() => {});
    this.notifier = deps.notifier ?? null;
    this.serverUrl = deps.serverUrl ?? `http://127.0.0.1:${deps.config.port}`;
    const core = this.runners.get("core");
    this.coreSupervisor = core?.reattachOwned ? new CoreSupervisor({
      pollMs: this.timings.healthMs,
      retryMs: this.timings.healthMs,
      presence: async () => {
        if (!(core instanceof CoreRunner)) return (await core.available()).ok ? "owned" : "unknown";
        try {
          const hello = await coreRpc<CoreHello>(this.coreSocket(), "hello", { generation: 1 }, 1000);
          return hello.generation === 1 ? "owned" : "conflict";
        } catch (error) {
          return error instanceof CoreError && error.causeCode === "ENOENT" && error.deliveryEffect === "not_written" ? "absent" : "unknown";
        }
      },
      startOwned: () => ensureCoreServer({ coreBin: this.config.coreBin, socketPath: this.coreSocket(), session: "iamceo", stateDir: join(this.config.home, "core-state"), configDir: join(this.config.home, "core-config") }),
      reattachOwned: async watched => {
        const member = this.store.getMember(watched.id);
        if (!member || this.closed || this.runtime(watched.id).closing || this.runtime(watched.id).starting || this.runtime(watched.id).reopening || this.runtime(watched.id).pumping) return { outcome: "unknown", code: "mutation_in_progress" };
        const rt = this.runtime(member.id);
        rt.reattaching = true;
        try {
          const result = await core.reattachOwned!(this.runnerMember(member, this.store.requireProject(member.projectId)));
          if (result.outcome === "rejoined" && !this.closed && this.store.getMember(member.id)) {
            this.applyStarted(member.id, this.store.requireProject(member.projectId), result.started);
            for (const journal of this.store.listPendingLifecycleJournals()) {
              if (journal.memberId === member.id && journal.intent === "start" && journal.identity.sessionGeneration === watched.sessionGeneration) this.finishLifecycle(journal, "confirmed", null, result.started.identity ?? this.identity(this.store.requireMember(member.id)));
            }
            const current = this.store.requireMember(member.id);
            if (current.lastError?.startsWith("starting_unknown") || current.lastError?.startsWith("core 재연결 보류")) this.store.patchMember(member.id, { lastError: null });
            await this.reconcileExecutions(member.id);
          }
          const pendingStart = this.pendingLifecycle(member.id);
          const absentPreflight = result.outcome === "not_found" && pendingStart?.intent === "start" && pendingStart.phase === "unknown" &&
            member.paneId === null && pendingStart.identity.terminalId === null && pendingStart.runId === null && pendingStart.deliveryIds.length === 0 &&
            /^terminal\.list:/.test(pendingStart.reason ?? "");
          if (absentPreflight) {
            // Old releases treated a pre-launch list timeout as an uncertain creation.
            // A successful owner inventory now proves absence; an uncertain run stays fenced.
            // No holder/execution exists to reconcile. Finish synchronously so a
            // concurrent fresh-session request cannot be overwritten after an await.
            this.store.transaction(() => {
              this.finishLifecycle(pendingStart!, "refused", "시작 전 목록 조회 실패 후 소유 터미널 부재를 확인했습니다");
              this.store.patchMember(member.id, { status: "offline", lastError: null });
            });
            rt.turn = null;
            this.releaseSlots();
          }
          if (result.outcome === "not_found" && member.paneId && !this.pendingLifecycle(member.id)) {
            await this.reconcileAbsentTerminal(member);
            this.store.patchMember(member.id, { status: "offline" });
            rt.turn = null;
            this.releaseSlots();
          }
          return result;
        } finally { rt.reattaching = false; }
      },
      observed: state => {
        const member = this.store.getMember(state.memberId);
        if (!member || this.closed || state.code === "mutation_in_progress") return;
        const setupError = state.outcome === "rejoined" && core instanceof CoreRunner ? core.observationState(member.id)?.setupError ?? null : null;
        this.store.patchMember(member.id, { statusObservation: this.executionObservation(member, { source: "core", observedAt: state.lastObservedAt === null ? null : new Date(state.lastObservedAt).toISOString(), freshness: state.outcome === "rejoined" ? "fresh" : "stale", ownership: state.outcome === "rejoined" ? "verified" : state.outcome === "conflict" ? "conflict" : "unknown", consecutiveFailures: state.failures, error: state.code ? { code: state.code, note: "소유 터미널을 다시 관측합니다. 후보가 여러 개면 자동 선택하거나 종료하지 않습니다" } : setupError }) });
        if (state.outcome === "rejoined" && !this.recovering) void this.pump(member.id);
      },
    }) : null;
    for (const runner of this.runners.values()) {
      runner.on((event) => {
        const member = this.store.getMember(event.memberId);
        if (member && member.backend && member.backend !== runner.kind) return;
        if (this.runtimes.get(event.memberId)?.closing && (event.type !== "status" || event.status === "gone")) return;
        if (runner.kind !== "core") {
          if (!this.closed) void this.onRunnerEvent(event).catch(e => console.error("실행기 이벤트 처리 오류:", event.type, e));
          return;
        }
        const before = this.eventQueues.get(event.memberId);
        const pending = (before ? before.then(async () => {
          if (!this.closed) await this.onRunnerEvent(event);
        }) : this.onRunnerEvent(event)).catch((e) => console.error("실행기 이벤트 처리 오류:", event.type, e));
        this.eventQueues.set(event.memberId, pending);
        void pending.finally(() => { if (this.eventQueues.get(event.memberId) === pending) this.eventQueues.delete(event.memberId); });
      });
    }
  }

  /** Serve startup owns a private daemon; diagnostics remain read-only and shutdown leaves it alive. */
  async initializeRuntime(): Promise<void> {
    if (!this.runners.has("core")) return;
    if (this.coreSupervisor) {
      await this.coreSupervisor.tick();
      this.coreSupervisor.start();
    }
    await this.refreshConnection();
  }

  private coreSocket(): string { return this.config.coreSocket ?? join(this.config.home, "run", "core.sock"); }

  private readonly terminalStreamClosers = new Set<() => Promise<void>>();
  private readonly terminalLeaseListeners = new Set<(memberId: string, leaseId: string | null) => Promise<void>>();
  onTerminalLeaseEnded(ended: (memberId: string, leaseId: string | null) => Promise<void>): () => void {
    this.terminalLeaseListeners.add(ended);
    return () => { this.terminalLeaseListeners.delete(ended); };
  }
  onTerminalStreamShutdown(close: () => Promise<void>): () => void {
    this.terminalStreamClosers.add(close);
    return () => { this.terminalStreamClosers.delete(close); };
  }
  private requireTerminalStream(memberId: string): Member {
    const member = this.store.requireMember(memberId);
    const project = this.store.requireProject(member.projectId);
    const rt = this.runtime(memberId);
    if (this.closed || member.backend !== "core" || !member.paneId || member.origin === "manual" || project.archived || !project.runnerEnabled ||
        this.pendingLifecycle(memberId) || rt.closing || rt.starting || rt.reopening) {
      throw new ApiError(409, "세션을 처리하는 중이거나 터미널을 열 수 없습니다", "TERMINAL_REFUSED");
    }
    return member;
  }
  async terminalStreamInfo(memberId: string): Promise<{ cols: number; rows: number }> {
    const member = this.requireTerminalStream(memberId);
    const generation = this.store.memberRevisions(memberId).sessionGeneration;
    const runner = this.runnerOf(member);
    if (!runner.terminalInfo) throw new ApiError(409, "core 터미널을 확인할 수 없습니다", "TERMINAL_REFUSED");
    try {
      const size = await runner.terminalInfo(this.runnerMember(member, this.store.requireProject(member.projectId)));
      const latest = this.requireTerminalStream(memberId);
      if (latest.paneId !== member.paneId || this.store.memberRevisions(memberId).sessionGeneration !== generation) {
        throw new ApiError(409, "세션이 바뀌었습니다", "TERMINAL_REFUSED");
      }
      return size;
    } catch (error) {
      if (error instanceof CoreError && !error.uncertain && ["finished", "not_found"].includes(error.kind)) {
        throw new ApiError(409, "터미널이 끝났거나 없습니다", "TERMINAL_GONE");
      }
      throw new ApiError(409, "터미널 소유와 크기를 확인할 수 없습니다", "TERMINAL_REFUSED");
    }
  }
  terminalStreamLease(memberId: string) {
    const member = this.requireTerminalStream(memberId);
    const lease = this.runnerOf(member).terminalLease?.(memberId) ?? null;
    return lease && lease.identity.terminalId === member.paneId && lease.identity.sessionGeneration === this.store.memberRevisions(memberId).sessionGeneration ? lease : null;
  }
  renewTerminalStreamLease(memberId: string, leaseId: string): number {
    const member = this.requireTerminalStream(memberId);
    if (this.terminalStreamLease(memberId)?.leaseId !== leaseId) throw new ApiError(409, "조작권이 없습니다", "TERMINAL_REFUSED");
    const expiresAt = this.runnerOf(member).renewLease?.(memberId, leaseId);
    if (!expiresAt) throw new ApiError(409, "조작권이 없습니다", "TERMINAL_REFUSED");
    return expiresAt;
  }
  async terminalStreamInput(memberId: string, write: () => void): Promise<void> {
    const member = this.requireTerminalStream(memberId);
    this.invalidateCoreMeasurement(member);
    const runner = this.runnerOf(member);
    if (runner.noteTerminalInput) await runner.noteTerminalInput(memberId, write);
    else write();
  }

  async terminalControl(memberId: string, action: TerminalControlAction): Promise<TerminalControlResult> {
    const member = this.store.requireMember(memberId);
    if (member.backend !== "core") throw new ApiError(409, "core 터미널만 조작할 수 있습니다", "TERMINAL_REFUSED");
    if (action.action !== "release") {
      this.requireActive(this.store.requireProject(member.projectId));
      if (this.pendingLifecycle(memberId)) throw new ApiError(409, "미확정 세션 작업을 확인하는 중입니다", "TERMINAL_REFUSED");
    }
    const rt = this.runtime(memberId);
    if (rt.closing || rt.starting || rt.reopening || rt.pumping) throw new ApiError(409, "세션을 처리하는 중입니다. 잠시 뒤 다시 여세요", "TERMINAL_REFUSED");
    const runner = this.runnerOf(member);
    if (!runner.terminalControl) throw new ApiError(501, "터미널 조작을 지원하지 않습니다", "TERMINAL_REFUSED");
    if (this.terminalMutations.has(memberId)) throw new ApiError(409, "터미널 입력을 처리하는 중입니다");
    this.terminalMutations.add(memberId);
    try {
      if (action.action === "input" || action.action === "key") this.invalidateCoreMeasurement(member);
      const previousLease = runner.terminalLease?.(memberId);
      const result = await runner.terminalControl(this.runnerMember(member, this.store.requireProject(member.projectId)), action);
      if (previousLease && (action.action === "release" || (action.action === "claim" && result.leaseId !== previousLease.leaseId))) {
        await Promise.all([...this.terminalLeaseListeners].map(ended => ended(memberId, previousLease.leaseId)));
      }
      return result;
    } catch (e) {
      if (e instanceof CoreError && !e.uncertain) throw new ApiError(409, e.message, "TERMINAL_REFUSED");
      throw e;
    } finally {
      this.terminalMutations.delete(memberId);
      if (action.action === "release" && this.store.listPending(memberId).length > 0) void this.pump(memberId);
    }
  }

  async runtimeInfo(): Promise<RuntimeInfo> {
    const runner = this.runners.get("core");
    const available = runner ? await runner.available().catch((e: Error) => ({ ok: false, detail: e.message })) : { ok: false, detail: "core 실행기가 없습니다" };
    const configured = this.config as OrchestratorDeps["config"] & Partial<Config>;
    const binary = configured.coreBin ?? "herdr-core";
    const installed = !!Bun.which(binary);
    let version: string | null = null;
    if (installed) {
      try {
        const result = Bun.spawn([binary, "--version"], { stdout: "pipe", stderr: "ignore" });
        const timer = setTimeout(() => result.kill(), 2000);
        const output = await new Response(result.stdout).text();
        if (await result.exited === 0) version = output.trim().slice(0, 200) || null;
        clearTimeout(timer);
      } catch {}
    }
    return { backend: "core", core: { installed, available: available.ok, version, detail: available.ok ? null : available.detail ?? null }, providers: {
      claude: { installed: !!Bun.which(configured.claudeBin ?? "claude") }, codex: { installed: !!Bun.which(configured.codexBin ?? "codex") },
      antigravity: { installed: !!Bun.which(configured.antigravityBin ?? "agy") },
    }, memory: this.memoryServiceInfo() };
  }

  /** 서버의 개발 기억 연결 상태. 설정이 없으면 '미연결'을 사실대로 돌려준다. */
  memoryServiceInfo(): MemoryServiceInfo {
    return this.devMemory?.status() ?? { state: "not_configured", detail: "서버에 개발 기억 연결 설정(IAMCEO_MEMORY_URL·IAMCEO_MEMORY_KEY_FILE)이 없습니다", checkedAt: null };
  }

  /** 접속 코드·토큰이 있는 폴더. file 도구가 읽지 못하게 막는다. */
  get dataDir(): string {
    return this.config.home;
  }

  get protectedFileRoots(): string[] {
    return configuredSecretRoots(this.config).concat(configuredSecretRoots(this.providerHomes ?? {}));
  }

  /** file 도구가 원본을 복사해 두는 곳. */
  get uploadsDir(): string {
    return join(this.config.home, "uploads");
  }

  /** 서버가 실제 포트로 뜬 뒤 부른다. MCP 설정 파일에 들어간다. */
  private backups: BackupManager | null = null;
  /** 서버가 띄운 정기 백업. 직원은 데이터 폴더를 직접 복사하지 않고 server_backup 도구로 이 관리자에게 맡긴다. */
  setBackups(manager: BackupManager | null): void { this.backups = manager; }

  /**
   * 직원이 데이터 폴더를 직접 읽지 않고 볼 수 있는 서버 상태: 앱 판, DB 판, 하네스 적용, 최근 백업(만들 때 확인한 값), 마지막 백업 오류,
   * 이 직원 세션의 실행 기록 대조 가능 여부. 경로·토큰·접속 코드는 싣지 않는다.
   */
  serverCheck(member: Member): Record<string, unknown> {
    const schemaVersion = this.store.db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
    const settings = this.store.getSettings();
    const log = this.contextLog(member);
    return {
      version: VERSION, schema: { version: schemaVersion, supportedVersion: MIGRATIONS.length, ok: schemaVersion === MIGRATIONS.length },
      harness: { mode: settings.harnessMode, requiredSince: settings.harnessRequiredSince },
      backups: this.backups ? { recent: readVerifiedBackups(this.backups.options.backupDir, 5, this.backups.options.home), lastError: this.backups.lastError?.message ?? null } : { recent: [], lastError: null, note: "이 서버에는 정기 백업 관리자가 없습니다" },
      execEvidence: member.cli === "antigravity" ? "unsupported" : log ? "available" : "log_not_found",
    };
  }

  /** 서버가 자기 데이터 폴더를 백업한다(검증 포함, 보관 규칙대로 정리). 10분 안에 만든 백업이 있으면 새로 만들지 않고 그것을 알린다. */
  async serverBackup(member: Member): Promise<Record<string, unknown>> {
    if (!this.backups) throw new ApiError(503, "이 서버에는 백업 관리자가 없습니다. 대표에게 iamceo backup 을 부탁하세요");
    const recent = readVerifiedBackups(this.backups.options.backupDir, 1, this.backups.options.home)[0];
    if (recent && Date.now() >= Date.parse(recent.createdAt) && Date.now() - Date.parse(recent.createdAt) < 10 * 60_000) return { created: false, reason: "10분 안에 만든 백업이 있습니다", backup: recent };
    const snapshot = await this.backups.run(true);
    this.store.appendActivity(member.id, "system", `서버 백업 요청: ${snapshot?.manifest.id ?? "만들지 않음"}`);
    const made = snapshot ? readVerifiedBackups(this.backups.options.backupDir, 5, this.backups.options.home).find(b => b.id === snapshot.manifest.id) ?? null : null;
    if (!snapshot || !made) throw new ApiError(503, "새 백업을 검증하지 못했습니다. 백업을 재사용하지 않습니다");
    return { created: true, backup: made };
  }

  /** 업무 한 건의 시작→지시→보고 사슬(읽기만). 계약 판·전달·검사와 실행 증거·조사 주장·열린 결재·개선 후보. 글 본문은 싣지 않는다. */
  taskTrace(member: Member, taskId: string): Record<string, unknown> {
    const task = this.store.resolveTask(this.requireTaskInProject(member, taskId));
    const name = (id: string | null) => (id ? this.store.getMember(id)?.name : null) ?? id;
    const effective = this.store.getEffectiveContract(task.id);
    const basis = effective ? this.store.completionEvidence(effective.taskId, effective.rev) : [];
    const sources = basis.filter(b => b.status === "passed").map(b => b.messageId);
    const byMessage = new Map(basis.map(b => [b.messageId, b]));
    const deliveryTrace = this.store.taskDeliveryTrace(task.id);
    const deliveryMetadata = (d: (typeof deliveryTrace.recent)[number]) => {
      const { memberId, createdAt, ...rest } = d;
      return { ...rest, to: name(memberId), at: createdAt };
    };
    const reports = this.store.listTaskHarnessReports(task.id).map(id => {
      const m = this.store.getMessage(id);
      const h = this.store.getReportHarness(id);
      return { id, kind: m?.kind, title: m?.title, who: m?.who, at: m?.at, gate: h?.gate ?? null, contract: h?.contractTaskId ? `#${h.contractTaskId} r${h.contractRev}` : null, evidence: h?.evidenceStatus ?? null,
        correctsMessageId: this.store.getReportReferences(member.projectId, id)?.correctsMessageId ?? null,
        completionBasis: m?.kind === "완료" ? byMessage.get(id) ?? { messageId: id, eligible: false, status: "not_current", correctedBy: null } : null,
        checks: h?.checks.map(c => ({ name: c.name, kind: c.kind, result: c.result, exec: c.execStatus ?? null, exit: c.execExit ?? null, command: c.execCommand ?? c.command ?? null })) ?? [],
        claims: h?.claims.map(c => ({ basis: c.basis, verified: c.verified, quoteMatched: c.quoteMatched, sourceRead: c.sourceRead, semanticReview: c.semanticReview, via: c.via })) ?? [] };
    });
    return {
      task: { id: task.id, title: task.title, createdAt: task.createdAt, origin: task.origin ?? null, parent: task.parentTaskId ?? null },
      contract: effective ? { on: effective.taskId, rev: effective.rev, binding: bindingContract(effective), author: effective.author, authorKind: effective.authorKind, confirmedBy: effective.confirmedBy ?? null } : null,
      contractRevs: this.store.listTaskContracts(task.id).map(c => ({ rev: c.rev, author: c.author, authorKind: c.authorKind, confirmed: !!c.confirmedAt, at: c.at, acceptance: c.acceptance.length, checks: c.checks })),
      deliveries: deliveryTrace.history.map(d => ({ to: name(d.memberId), kind: d.kind, status: d.status, at: d.createdAt })),
      // Keep the original history sample for clients; expose recent/pending windows explicitly.
      deliveryCoverage: deliveryTrace.coverage,
      recentDeliveries: deliveryTrace.recent.map(deliveryMetadata),
      unsettledDeliveries: deliveryTrace.unsettled.map(deliveryMetadata),
      inputAdmission: deliveryTrace.unsettled.filter(d => d.wake && this.store.getMember(d.memberId)?.kind === "worker")
        .map(d => ({ deliveryId: d.id,
          sequenceBlockerTaskId: this.store.taskSequenceBlocker(d.memberId, task.id)?.taskId ?? null,
          sessionGeneration: this.store.memberRevisions(d.memberId).sessionGeneration,
          independentAuthorized: independentDeliveryAuthorized(this.store, this.store.requireDelivery(d.id)) })),
      reports,
      currentCompletion: { eligible: sources.length > 0, sources },
      openDecisions: this.store.listOpenDecisions(member.projectId).filter(d => d.taskId === task.id).map(d => ({ id: d.id, title: d.title })),
      findings: this.store.listHarnessFindings(member.projectId, { taskId: task.id, limit: 30 }).map(f => ({ id: f.id, kind: f.kind, who: name(f.memberId), detail: f.detail, at: f.at })),
    };
  }

  /** 서버에 저장된 실패 검사에서만 범위를 얻는다. 조회는 보고·근거·개선 후보·실행 기록을 갱신하지 않는다. */
  execDiagnose(caller: Member, taskId: string, reportId: string, checkIndex: number): Record<string, unknown> {
    const task = this.store.resolveTask(this.requireTaskInProject(caller, taskId));
    const report = this.store.getMessage(reportId), harness = this.store.getReportHarness(reportId);
    if (!report || report.projectId !== caller.projectId || report.mine || report.taskId !== task.id || !harness || harness.memberId !== report.memberId) throw new ApiError(404, "그 업무의 검사 보고를 찾을 수 없습니다");
    if (caller.kind !== "conductor" && caller.id !== harness.memberId) throw new ApiError(403, "직원은 자신의 실패 검사만 진단할 수 있습니다");
    const check = harness.checks[checkIndex];
    if (!check || check.result !== "fail" || !EXEC_CHECKS.has(check.kind) || !check.command) throw new ApiError(400, "명령이 있는 실패 실행 검사 번호를 고르세요(0부터 시작)");
    const contract = harness.contractTaskId && harness.contractRev ? this.store.listTaskContracts(harness.contractTaskId).find(c => c.rev === harness.contractRev) : null;
    if (!bindingContract(contract)) throw new ApiError(400, "확정된 계약 판을 가진 실패 검사만 진단합니다");
    const target = this.store.requireMember(harness.memberId);
    if (target.projectId !== caller.projectId) throw new ApiError(404, "해당 직원의 진단 범위를 찾을 수 없습니다");
    const selection: LogSelectionObservation = { code: "no_matching_session", registeredSession: !!target.sessionId,
      source: target.cli === "codex" ? "codex_session_meta" : target.cli === "claude" ? "claude_session_filename" : "unsupported",
      sessionMatch: null, cwdMatch: null, matchingFiles: 0, metadataReadLimitBytes: target.cli === "codex" ? 1024 * 1024 : null };
    const log = target.cli === "antigravity" ? null : this.contextLog(target, selection);
    if (target.cli === "antigravity") selection.code = "unsupported";
    const observed = inspectProviderEvidence(target.cli, log ? { ...log, root: providerLogRoot(target.cli, log.home) } : null,
      contract!.at, check.command, target.cwd, ref => { const used = this.store.execRefTask(ref); return used && used !== contract!.taskId ? used : null; });
    return { scope: { taskId: task.id, reportId, checkIndex, memberId: target.id,
      contract: { taskId: contract!.taskId, rev: contract!.rev, at: contract!.at } },
      observation: { kind: "current_requery", at: new Date().toISOString(), provider: target.cli,
        original: { status: "not_recorded", note: "당시미확인: 거절 당시 선택 세션·읽은 범위·검사별 관찰은 기록돼 있지 않습니다" } },
      selection, ...observed };
  }

  /** 확정 조사 계약에서 승인된 코드 조각만 서버가 직접 읽는다. */
  readCode(member: Member, taskId: string, rev: number, source: string, start: number, end: number) {
    const task = this.store.resolveTask(this.requireTaskInProject(member, taskId));
    const contract = this.store.getEffectiveContract(task.id);
    if (!bindingContract(contract) || contract!.rev !== rev || !(contract!.kind === "research" || contract!.checks.includes("source"))) throw new ApiError(403, "현재 확정된 조사 계약으로 코드 열람을 요청하세요");
    const scope = this.codeReadScope(member, task.id, contract!);
    return this.store.saveCodeRead(scope, readCodeSource(scope, source, start, end, this.protectedFileRoots));
  }

  private codeReadScope(member: Member, taskId: string, contract: TaskContract): CodeReadScope {
    return { projectId: member.projectId, memberId: member.id, taskId, contractTaskId: contract.taskId, contractRev: contract.rev,
      contractAt: contract.at, root: this.store.requireProject(member.projectId).cwd };
  }

  /** 개선 후보 목록(총괄). 규칙·권한을 바꾸지 않는다. 개발 기억에 남길지는 총괄이 정하고 memory_record 로 남긴다. */
  harnessFindings(member: Member, opts: { taskId?: string | null; limit?: number }): Record<string, unknown> {
    const taskId = opts.taskId ? this.store.resolveTask(this.requireTaskInProject(member, opts.taskId)).id : null;
    const items = this.store.listHarnessFindings(member.projectId, { taskId, limit: opts.limit ?? 30 });
    const counts: Record<string, number> = {};
    for (const f of items) counts[f.kind] = (counts[f.kind] ?? 0) + 1;
    return { counts, items: items.map(f => ({ id: f.id, kind: f.kind, task: f.taskId, who: f.memberId ? this.store.getMember(f.memberId)?.name ?? f.memberId : null, detail: f.detail, ref: f.refId ? `${f.refType}:${f.refId}` : null, at: f.at })),
      howTo: "되풀이되는 것만 memory_record(kind lesson·mistake, basis verified, evidence 에 후보 id·보고 id)로 남깁니다. 규칙·권한·계약 기본값은 대표 결재 없이 바꾸지 않습니다" };
  }

  setServerUrl(url: string): void {
    this.serverUrl = url;
  }

  private identity(member: Member): RunnerTerminalIdentity {
    const runner = this.runners.get(this.backendOf(member));
    return (runner instanceof CoreRunner ? runner.observationState(member.id)?.identity : null) ?? { terminalId: member.paneId, sessionId: member.sessionId, sessionGeneration: this.store.memberRevisions(member.id).sessionGeneration, process: null };
  }

  private pendingLifecycle(memberId: string): LifecycleJournal | undefined {
    const generation = this.store.memberRevisions(memberId).sessionGeneration;
    return this.store.listPendingLifecycleJournals().find(j => j.memberId === memberId && j.identity.sessionGeneration === generation);
  }

  private prepareLifecycle(member: Member, intent: LifecycleJournal["intent"]): LifecycleJournal {
    const before = this.pendingLifecycle(member.id);
    if (before) {
      if (before.intent !== intent) throw new ApiError(409, "미확정 세션 작업을 먼저 확인해야 합니다");
      return before;
    }
    const at = new Date().toISOString();
    const run = this.store.listPendingExecutions().find(r => r.memberId === member.id);
    const entry: LifecycleJournal = { operationId: randomUUID(), memberId: member.id, projectId: member.projectId, intent, phase: "prepared", identity: this.identity(member), runId: run?.runId ?? null, deliveryIds: run?.deliveryIds ?? [], baseline: null, reason: null, exitCode: null, createdAt: at, updatedAt: at };
    this.store.saveLifecycleJournal(entry);
    return entry;
  }

  private finishLifecycle(entry: LifecycleJournal, phase: LifecycleJournal["phase"], reason: string | null, identity = entry.identity): void {
    this.store.saveLifecycleJournal({ ...entry, phase, reason, identity, updatedAt: new Date().toISOString() });
  }

  private async startManaged(member: Member, project: Project, resume: boolean, prepared?: LifecycleJournal): Promise<RunnerStartResult> {
    this.requireActive(this.store.requireProject(project.id));
    const previous = this.pendingLifecycle(member.id);
    if (previous && (previous.operationId !== prepared?.operationId || previous.phase !== "prepared")) throw new CoreError("starting_unknown", "미완료 생성 의도가 있어 소유 라벨로 확인하는 중입니다");
    const entry = prepared ?? this.prepareLifecycle(member, "start");
    const runner = this.runnerOf(member);
    this.finishLifecycle(entry, "started", null);
    try {
      this.requireActive(this.store.requireProject(project.id));
      const started = await runner.start(this.runnerMember(member, project), { ...this.writeRunFiles(member, project, resume), operationId: entry.operationId });
      if (!this.store.getMember(member.id)) return started;
      const identity = started.identity ?? { ...entry.identity, sessionId: started.sessionId, terminalId: started.paneId };
      this.finishLifecycle(entry, "confirmed", null, identity);
      return started;
    } catch (error) {
      const unknown = runner.kind === "core" && (!(error instanceof CoreError) || error.uncertain || ["starting_unknown", "conflict", "unknown"].includes(error.kind));
      this.finishLifecycle(entry, unknown ? "unknown" : "refused", (error as Error).message.slice(0, 500));
      if (unknown) {
        this.store.patchMember(member.id, { lastError: `starting_unknown: ${(error as Error).message.slice(0, 500)}` });
        this.coreSupervisor?.watch(this.runnerMember(this.store.requireMember(member.id), project));
      }
      throw error;
    }
  }

  private async stopManaged(member: Member, intent: "sleep" | "close" | "archive" | "fresh_session", whileWorking: boolean): Promise<void> {
    const lease = this.store.inputState(member.id).lease;
    if (lease && lease.identity.terminalId === member.paneId) throw new ApiError(409, "직접 조작권이 유효한 동안 세션을 종료할 수 없습니다");
    const entry = this.prepareLifecycle(member, intent);
    this.finishLifecycle(entry, "started", whileWorking ? "while_working:" : "idle_only:");
    try {
      await this.runnerOf(member).stop(this.runnerMember(member, this.store.requireProject(member.projectId)), { whileWorking });
      // Final state and the confirmation share a transaction at the caller.
    } catch (error) {
      const refused = (error instanceof CoreError && !error.uncertain) || (error instanceof HerdrError && (error.code === "cannot_exit" || error.deliveryEffect !== "unknown")) || error instanceof ApiError;
      this.finishLifecycle(entry, entry.phase !== "unknown" && refused ? "refused" : "unknown", `${whileWorking ? "while_working" : "idle_only"}: ${(error as Error).message.slice(0, 500)}`);
      if (error instanceof CoreError && !error.uncertain && error.kind === "input_busy") throw new ApiError(409, "입력칸에 글이 남아 있거나 입력 상태를 확인하지 못해 닫지 않았습니다. 터미널에서 지운 뒤 다시 시도하세요");
      if (error instanceof CoreError && !error.uncertain && error.kind === "busy") throw new ApiError(409, "실행 중인 일이나 미해결 입력이 있어 닫지 않았습니다. 터미널과 전달 결과를 확인해 주세요");
      throw error;
    }
  }

  private confirmStop(memberId: string): void {
    const journal = this.pendingLifecycle(memberId);
    if (journal && journal.intent !== "start") this.finishLifecycle(journal, "confirmed", null);
    this.coreSupervisor?.unwatch(memberId);
  }

  private recoverStops(): Promise<void> {
    this.stopRecovery ??= this.recoverStopsOnce().finally(() => { this.stopRecovery = null; });
    return this.stopRecovery;
  }

  private async recoverStopsOnce(): Promise<void> {
    for (const journal of this.store.listPendingLifecycleJournals()) {
      if (!["sleep", "close", "archive"].includes(journal.intent)) continue;
      const member = this.store.getMember(journal.memberId);
      if (!member || this.store.memberRevisions(member.id).sessionGeneration !== journal.identity.sessionGeneration) continue;
      const rt = this.runtime(member.id);
      if (this.archiving.has(member.projectId) || rt.closing || rt.starting || rt.reopening || rt.pumping) continue;
      try {
        if (journal.intent === "close") await this.closeMember(member.id);
        else {
          await this.sleepMember(member.id, { force: journal.intent === "archive" || (journal.reason?.startsWith("while_working:") ?? false), ...(journal.intent === "archive" ? { holdAs: "archived" as const } : {}) });
          if (journal.intent === "archive" && !this.store.requireProject(member.projectId).archived) for (const d of this.store.listPending(member.id)) if (d.status === "held" && d.holdReason === "archived") this.hold(d, "asleep");
        }
      } catch (error) { this.store.patchMember(member.id, { lastError: `종료 확인 보류: ${(error as Error).message.slice(0, 500)}` }); }
    }
  }

  private async reconcileAbsentTerminal(member: Member): Promise<void> {
    if (!(this.runners.get("core") instanceof CoreRunner)) {
      this.endExecution(member, "interrupted", "재결합 조회에서 소유 터미널의 부재를 확인했습니다");
      return;
    }
    try {
      const terminal = await coreRpc<CoreTerminal>(this.coreSocket(), "terminal.get", { terminal: member.paneId! }, 1000);
      if (terminal.address !== member.paneId || terminal.labels?.["iamceo.member"] !== member.id || terminal.labels["iamceo.project"] !== member.projectId || terminal.labels["iamceo.cli"] !== member.cli || terminal.labels["iamceo.generation"] !== String(this.store.memberRevisions(member.id).sessionGeneration)) return;
      if (terminal.state === "live") return;
      const run = this.store.listPendingExecutions().find(r => r.memberId === member.id);
      const settled = ["idle", "done"].includes(terminal.status?.state ?? "") && run?.turn !== null && run?.turn !== undefined && (terminal.turn ?? -1) > run.turn;
      const result = terminal.status?.state === "error" ? "error" : settled ? "success" : "interrupted";
      this.endExecution(member, result, terminal.reason ?? terminal.status?.msg ?? "소유 터미널이 종료되었습니다", terminal.exit_code ?? null, terminal.turn);
      const detail = `초기/실행 종료: ${terminal.reason ?? "원인 미확인"} (exit_code=${terminal.exit_code ?? "unknown"})`;
      if (member.lastError !== detail) this.store.appendActivity(member.id, result === "success" ? "system" : "error", detail.slice(0, 500));
      this.store.patchMember(member.id, { lastError: result === "success" ? null : detail.slice(0, 500) });
    } catch (error) {
      if (error instanceof CoreError && error.kind === "not_found") this.endExecution(member, "interrupted", "소유 터미널의 부재를 확인했습니다");
    }
  }

  private async reconcileExecutions(memberId?: string): Promise<void> {
    for (const run of this.store.listPendingExecutions()) {
      if (memberId && run.memberId !== memberId) continue;
      const member = this.store.getMember(run.memberId);
      if (!member || this.store.memberRevisions(member.id).sessionGeneration !== run.identity.sessionGeneration) continue;
      const runner = this.runners.get(this.backendOf(member));
      const observed = runner instanceof CoreRunner ? runner.observationState(member.id) : null;
      if (!runner || !observed || observed.failures || observed.identity.terminalId !== run.identity.terminalId) continue;
      if (this.settleRecoveredStart(member, run, observed)) continue;
      const observation = this.executionObservation(member, { source: "core", observedAt: observed.observedAt, freshness: "fresh", ownership: "verified", consecutiveFailures: 0, error: observed.setupError });
      if (observation.error?.code === "progress_stalled" || observation.error?.code === "start_stalled" ||
          member.statusObservation?.error?.code === "progress_stalled" || member.statusObservation?.error?.code === "start_stalled") {
        this.store.patchMember(member.id, { statusObservation: observation });
      }
    }
  }

  /** Compose observation and execution evidence atomically. A successful reattach is not new output:
   * publishing its bare error:null used to erase the quiet-run advisory until the next reconciliation.
   * The same 20s threshold and execution timestamps apply to every observation writer. */
  private executionObservation(member: Member, observation: NonNullable<Member["statusObservation"]>, status: string = member.status): NonNullable<Member["statusObservation"]> {
    if (observation.source !== "core" || observation.freshness !== "fresh" || observation.ownership !== "verified" || observation.error || ["blocked", "waiting"].includes(status)) return observation;
    const generation = this.store.memberRevisions(member.id).sessionGeneration;
    const run = this.store.listPendingExecutions().find(run => run.memberId === member.id && run.identity.sessionGeneration === generation && run.identity.terminalId === member.paneId);
    if (!run) return observation;
    const since = run.lastProgressAt ?? run.startedAt ?? run.inputReceivedAt ?? run.createdAt;
    if (!(Date.now() - Date.parse(since) >= 20_000)) return observation;
    const code = run.startedAt ? "progress_stalled" : "start_stalled";
    return { ...observation, error: { code, note: `업무 ${run.runId}의 ${run.startedAt ? "진전" : "시작"}을 재관측 중입니다. 마지막 근거 ${since}. 소유 터미널과 업무 기록을 확인하세요. 시간만으로 입력·Enter·중단하지 않습니다` } };
  }

  /**
   * A write whose reply was lost (daemon killed mid-send, real 2026-11-07 run) leaves its run in "starting". Once
   * delivery recovery proves receipt from the CLI's own log, the run is received; the turn counter observed just
   * before the write is the comparison point. A quiet CLI past that counter means the input's turn already ended
   * while we were away: close it as success (which also asks for a missing report). Without that counter the run
   * stays received and fenced: elapsed time alone never ends it.
   */
  private settleRecoveredStart(member: Member, run: ExecutionJournal, observed: { turn: number | null; state: string | null }): boolean {
    if (run.phase !== "starting" || run.inputReceivedAt || !run.deliveryIds.length) return false;
    const dispatch = this.store.getDispatch(run.runId);
    if (!dispatch || dispatch.transportState === "rejected" || !run.deliveryIds.every(id => this.store.getDelivery(id)?.status === "delivered")) return false;
    const at = new Date().toISOString(), base = dispatch.baseline.turn ?? null;
    this.store.saveExecutionJournal({ ...run, phase: "received", inputReceivedAt: at, turn: base, reason: run.reason ?? "receipt_from_log", updatedAt: at });
    if (base !== null && observed.turn !== null && observed.turn > base && ["idle", "done"].includes(observed.state ?? "")) {
      this.endExecution(member, "success", "입력 응답은 끊겼지만 CLI 기록으로 수신을 확인했고, 그 턴이 끝난 것을 확인했습니다", null, observed.turn);
      this.runtime(member.id).turn = null;
      this.releaseSlots();
    }
    return true;
  }

  private reportTaskKey(taskId: string | null | undefined): string | null {
    const task = taskId ? this.store.getTask(taskId) : null;
    return task ? this.store.resolveTask(task).id : taskId ?? null;
  }

  private reportClosesTask(message: Message, taskId: string | null): boolean {
    const reported = this.reportTaskKey(message.taskId);
    if (reported === taskId) return true;
    // A child may fulfill the received contract. Sharing a contract with a
    // sibling, or merely posting a child question/block, does not close it.
    if (message.kind !== "완료" || !reported || !taskId || !this.isTaskUnder(reported, taskId)) return false;
    const contract = this.store.getEffectiveContract(taskId);
    if (!contract || !bindingContract(contract)) return false;
    const accepted = this.store.getReportHarness(message.id);
    return accepted?.gate === "contract" && accepted.memberId === message.memberId &&
      this.reportTaskKey(accepted.contractTaskId) === this.reportTaskKey(contract.taskId) && accepted.contractRev === contract.rev;
  }

  private completedReportSince(member: Member, run: ExecutionJournal): boolean {
    const since = run.createdAt;
    // A report followup still has an execution scope even though it creates no
    // new report obligation. Its own matching completion can settle that turn.
    const unreported = new Set(this.runDeliveries(run).filter(d => d.wake).map(d => this.reportTaskKey(this.store.deliveryTaskId(d.id))));
    if (!unreported.size) return false;
    let cursor: string | undefined;
    do {
      const opts = { scope: { kind: "member" as const, memberId: member.id }, cursor, limit: 200 };
      const page = this.store.requireProject(member.projectId).archived ? this.store.listArchiveMessagePage(member.projectId, opts) : this.store.listMessagePage(member.projectId, opts);
      for (const message of page.items) {
        if (message.memberId === member.id && !message.mine && message.at >= since && ["완료", "답변"].includes(message.kind)) {
          for (const taskId of unreported) if (this.reportClosesTask(message, taskId)) unreported.delete(taskId);
        }
      }
      if (!unreported.size) return true;
      if (!page.nextCursor || !page.items.some(message => message.at >= since)) return false;
      cursor = page.nextCursor;
    } while (cursor);
    return false;
  }

  private endExecution(member: Member, result: "success" | "error" | "interrupted", reason: string | null, exitCode: number | null = null, turn?: number | null, stoppedBy?: string | null): void {
    const at = new Date().toISOString();
    this.store.transaction(() => {
      for (const run of this.store.listPendingExecutions().filter(r => r.memberId === member.id && r.identity.sessionGeneration === this.store.memberRevisions(member.id).sessionGeneration)) {
        const reported = this.completedReportSince(member, run);
        const outcome = result === "interrupted" && reported ? "success" : result;
        this.store.saveExecutionJournal({ ...run, turn: turn ?? run.turn, phase: outcome === "interrupted" ? "interrupted" : "ended", result: outcome, reason, exitCode, endedAt: at, updatedAt: at });
        this.store.finishDelegationAck(member.id, run.runId);
        if (outcome === "success") {
          this.completeExecutionReview(member, run);
          this.requestMissingReport(member, run);
        }
        if (outcome === "interrupted") this.store.claimExecutionNotice(run.runId, "interruption", () => {
          // 중단 알림은 그 실행이 받은 업무에 붙인다(정할 수 없으면 그 직원의 세션 알림 업무). 총괄에게 가는 안내도 같은 업무다.
          const runTasks = this.certainTasks(this.runDeliveries(run));
          const runTask = runTasks.length === 1 ? runTasks[0]! : null;
          this.memberNotice(member, `${member.name}: 실행 ${run.runId} 중단 — ${reason ?? "종료 근거 없이 세션이 사라졌습니다"}`, this.runDeliveries(run));
          const conductor = this.store.getConductor(member.projectId);
          // 대표가 멈춘 것은 대표가 이어서 지시한다. 총괄을 깨워 같은 일을 다시 시키게 하지 않는다. 총괄이 멈춘 것은 총괄이 이미 안다.
          if (stoppedBy === "user") {
            if (conductor && conductor.id !== member.id) this.store.enqueue({ projectId: member.projectId, memberId: conductor.id, kind: "system", text: formatSystem(`대표가 ${member.name}의 실행 ${run.runId}을 직접 멈췄습니다. 전달 ${run.deliveryIds.join(", ")}. 이어서 할 지시는 대표가 직접 보냈거나 보냅니다. 같은 일을 다시 시키지 말고 판만 맞추세요.`), wake: false, taskId: runTask });
          } else if (!stoppedBy && conductor && conductor.id !== member.id) this.store.enqueue({ projectId: member.projectId, memberId: conductor.id, kind: "system", text: formatSystem(`${member.name}의 실행 ${run.runId}이 중단되었습니다. 전달 ${run.deliveryIds.join(", ")}. 기존 변경과 보고를 확인한 뒤 후속 지시를 결정하세요.`), wake: true, taskId: runTask });
        });
      }
    });
  }

  private completeExecutionReview(member: Member, run: ExecutionJournal): void {
    const match = /^board_review:(\d+):(\d+)$/.exec(run.reason ?? "");
    if (!match) return;
    const requestedRevision = Number(match[1]);
    const reviewedRevision = Number(match[2]);
    if (this.store.getBoardReview(member.projectId)?.requestedRevision !== requestedRevision) return;
    this.store.completeBoardReview(member.projectId, requestedRevision, reviewedRevision);
    this.store.setBoardTidiedAt(member.projectId, new Date().toISOString());
  }

  /**
   * 보고 의무는 실행을 깨운 입력에서만 생긴다. 조용한 안내(wake=false)·판 정리·보고 보완은 의무를 만들지 않는다.
   * 보고 보완은 원인 실행마다 한 번이고, 보완을 받은 실행이 끝나면 원인 실행을 마감 또는 '보고 미확인'으로 한 번 정리한다.
   * 같은 재촉으로 다시 깨우지 않는다.
   */
  private requestMissingReport(member: Member, run: ExecutionJournal): void {
    if (this.store.requireProject(member.projectId).archived || this.backendOf(member) !== "core") return;
    // 결과가 아직 돌아오지 않은 보고·질문·위임 도구가 있으면 그 결과를 본 뒤 판정한다. 확인 못 한 요청을 새로 시키지 않는다.
    if (this.inflightReportTools.get(member.id)) {
      const runs = this.deferredReportChecks.get(member.id) ?? new Set<string>();
      runs.add(run.runId);
      this.deferredReportChecks.set(member.id, runs);
      return;
    }
    const deliveries = run.deliveryIds.map(id => this.store.getDelivery(id)).filter((d): d is Delivery => !!d);
    for (const delivery of deliveries) {
      const followup = this.store.getReportFollowupByDelivery(delivery.id);
      if (followup && !followup.settledAt) this.settleReportFollowup(member, followup.rootRunId, run.runId);
    }
    if (this.runtime(member.id).background) return;
    // Delegation is recorded against its task. A whole-turn delegation flag
    // cannot discharge other tasks that arrived in the same execution.
    const open = this.openReportDuties(member, run.createdAt, this.reportDuties(deliveries));
    if (!open.length) return;
    const reports = open.filter(d => d.kind === "report" && d.refType === "message" && d.refId).map(d => d.refId!);
    const reviewHint = reports.length ? ` 직원 보고를 확인만 했으면 kind 알림에 about_report_id(${reports.map(id => `#${id}`).join(", ")})를 넣어 그 보고 확인을 마감하세요.` : "";
    // 보고 보완도 그 실행이 받은 업무를 밝힌다. 하나면 그 업무 줄을 붙이고, 여럿이면 업무마다 따로 보고하라고 적는다(서버가 고르지 않는다).
    const taskIds = this.turnTasks(open);
    const tasks = taskIds.map(id => this.store.getTask(id)).filter((t): t is Task => !!t);
    const taskNote = tasks.length > 1 ? `\n이 실행은 여러 업무의 글을 받았습니다: ${tasks.map(t => `#${t.id} '${t.title}'`).join(", ")}. 업무마다 그 task_id 로 따로 post 하세요.`
      : tasks.length === 1 ? `\n${formatTaskLine(tasks[0]!)}` : "";
    this.store.claimExecutionNotice(run.runId, "report", () => {
      this.store.appendActivity(member.id, "system", `실행 ${run.runId}의 필수 보고가 없어 보고 보완을 요청했습니다`, `${run.runId}:missing_report`);
      const supplement = this.store.enqueue({ projectId: member.projectId, memberId: member.id, kind: "system", ...(this.recovering ? { nextAttemptAt: new Date(Date.now() + this.timings.retryMs).toISOString() } : {}), text: formatSystem(`보고 보완: 실행 ${run.runId}의 결과만 post로 알려 주세요. 기존 업무를 다시 실행하지 마세요. 완료·막힘 또는 질문/위임 대기 상태를 명시하세요.${reviewHint}`) + taskNote, taskId: tasks.length === 1 ? tasks[0]!.id : null });
      this.store.recordReportFollowup(run.runId, member.id, member.projectId, supplement.id);
    });
  }

  /** 실행을 깨운 입력 중 보고가 필요한 것. 보고 보완(원인 실행에 이어진 전달·옛 글 머리)과 판 정리는 뺀다. */
  private reportDuties(deliveries: Delivery[]): Delivery[] {
    return deliveries.filter(d => d.wake && !isTidy(d) && !this.taskContinuations.isContinuation(d.id) && !this.store.getReportFollowupByDelivery(d.id) && !d.text.startsWith(formatSystem("보고 보완")));
  }

  /**
   * since 이후 같은 업무의 근거로 마감되지 않은 의무. 완료·답변·막힘·질문 글, 새 결재, 위임, 기다리는 자기 결재를 밝힌 알림은 그 업무만 마감한다.
   * 원보고를 밝힌 알림(reviewed)은 그 보고를 받은 입력만 마감한다. 진행·근거 없는 알림은 마감하지 않는다.
   */
  private openReportDuties(member: Member, since: string, duties: Delivery[]): Delivery[] {
    if (!duties.length) return [];
    const taskIds = new Set(duties.map(d => this.reportTaskKey(this.store.deliveryTaskId(d.id))));
    const closedTasks = new Set(this.store.listOpenDecisionsByMember(member.id).filter(d => d.createdAt >= since).map(d => this.reportTaskKey(d.taskId)));
    let cursor: string | undefined;
    do {
      const opts = { scope: { kind: "member" as const, memberId: member.id }, cursor, limit: 200 };
      const page = this.store.requireProject(member.projectId).archived ? this.store.listArchiveMessagePage(member.projectId, opts) : this.store.listMessagePage(member.projectId, opts);
      for (const message of page.items) {
        if (message.memberId === member.id && !message.mine && message.at >= since && ["완료", "답변", "막힘", "질문"].includes(message.kind)) {
          for (const taskId of taskIds) if (this.reportClosesTask(message, taskId)) closedTasks.add(taskId);
        }
      }
      if (!page.nextCursor || !page.items.some(m => m.at >= since)) break;
      cursor = page.nextCursor;
    } while (cursor);
    const closures = this.store.listReportClosures(member.id, since);
    for (const closure of closures) {
      if (closure.kind === "reviewed") continue;
      if (closure.refType === "delivery") {
        if (this.store.getDelivery(closure.refId)) closedTasks.add(this.reportTaskKey(this.store.deliveryTaskId(closure.refId)));
        continue;
      }
      const source = closure.refType === "message" ? this.store.getMessage(closure.refId)
        : this.store.getDecision(closure.refId);
      if (source) closedTasks.add(this.reportTaskKey(source.taskId));
    }
    const reviewed = new Set(closures.filter(c => c.kind === "reviewed").map(c => c.causeId));
    return duties.filter(d => !closedTasks.has(this.reportTaskKey(this.store.deliveryTaskId(d.id))) && !(d.kind === "report" && d.refType === "message" && d.refId && reviewed.has(d.refId)));
  }

  /** 보완을 받은 실행(byRunId)이 끝났다. 원인 실행의 의무가 그 사이 마감됐으면 closed, 아니면 '보고 미확인'을 한 번 남긴다. */
  private settleReportFollowup(member: Member, rootRunId: string, byRunId: string): void {
    const root = this.store.getExecutionJournal(rootRunId);
    const duties = root ? this.reportDuties(root.deliveryIds.map(id => this.store.getDelivery(id)).filter((d): d is Delivery => !!d)) : [];
    const open = root ? this.openReportDuties(member, root.createdAt, duties) : [];
    if (!open.length) {
      this.store.settleReportFollowup(rootRunId, "closed", byRunId, () => {
        this.store.appendActivity(member.id, "system", `실행 ${rootRunId}의 보고를 보완 실행 ${byRunId}에서 확인했습니다`, `${rootRunId}:report_closed`);
      });
      return;
    }
    this.store.settleReportFollowup(rootRunId, "unconfirmed", byRunId, () => {
      this.store.appendActivity(member.id, "system", `실행 ${rootRunId}의 보고가 보완 뒤에도 없어 보고 미확인으로 남겼습니다. 같은 보완으로 다시 깨우지 않습니다`, `${rootRunId}:report_unconfirmed`);
      const conductor = member.kind === "worker" ? this.store.getConductor(member.projectId) : null;
      if (conductor && conductor.id !== member.id) this.store.enqueue({ projectId: member.projectId, memberId: conductor.id, kind: "system", wake: false, text: formatSystem(`보고 미확인: ${member.name}의 실행 ${rootRunId} 결과 보고가 보고 보완 뒤에도 없습니다. 서버는 다시 재촉하지 않습니다. 다음에 판을 볼 때 이 직원의 상태와 결과를 확인하세요.`) });
    });
  }

  /** 늦게 끝난 보고·질문·위임 도구 뒤에 미뤄 둔 판정을 한다. */
  private runDeferredReportChecks(memberId: string): void {
    if (this.inflightReportTools.get(memberId)) return;
    const runs = this.deferredReportChecks.get(memberId);
    if (!runs) return;
    this.deferredReportChecks.delete(memberId);
    const member = this.store.getMember(memberId);
    if (!member) return;
    for (const runId of runs) {
      const run = this.store.getExecutionJournal(runId);
      if (run?.result === "success") this.requestMissingReport(member, run);
    }
  }

  async operation(operationId: string): Promise<OperationReceipt> {
    const receipt = this.store.getOperation(operationId);
    if (!receipt) throw new ApiError(404, "작업을 찾을 수 없습니다");
    if (receipt.projectId) this.store.requireProject(receipt.projectId);
    if (receipt.memberId && this.store.requireMember(receipt.memberId).projectId !== receipt.projectId) throw new ApiError(404, "작업을 찾을 수 없습니다");
    return receipt;
  }

  async freshMemberSessionV2(memberId: string, request: FreshSessionRequest): Promise<OperationReceipt<"fresh_session">> {
    const member = this.store.requireMember(memberId);
    const existing = this.store.getOperation(request.operationId);
    const receipt = this.store.beginOperation({ operationId: request.operationId, kind: "fresh_session", projectId: member.projectId, memberId, request }) as OperationReceipt<"fresh_session">;
    if (existing || receipt.status !== "pending") return receipt;
    try {
      if (this.store.memberRevisions(memberId).sessionGeneration !== request.expectedSessionGeneration) throw new ApiError(409, "세션 세대가 변경되었습니다", "SESSION_CONFLICT");
      const updated = await this.freshMemberSession(memberId);
      return this.store.finishOperation({ ...receipt, status: "applied", result: { member: updated, sessionGeneration: this.store.memberRevisions(memberId).sessionGeneration } }) as OperationReceipt<"fresh_session">;
    } catch (error) {
      const unknown = this.pendingLifecycle(memberId)?.phase === "unknown" || (error instanceof CoreError && error.uncertain);
      return this.store.finishOperation({ ...receipt, status: unknown ? "unknown" : "refused", code: unknown ? "SESSION_UNKNOWN" : "SESSION_REFUSED", error: (error as Error).message.slice(0, 500) }) as OperationReceipt<"fresh_session">;
    }
  }

  async terminalControlV2(memberId: string, request: TerminalControlRequestV2): Promise<OperationReceipt<"terminal_control">> {
    const member = this.store.requireMember(memberId);
    const existing = this.store.getOperation(request.operationId);
    const receipt = this.store.beginOperation({ operationId: request.operationId, kind: "terminal_control", projectId: member.projectId, memberId, request }) as OperationReceipt<"terminal_control">;
    if (existing || receipt.status !== "pending") return receipt;
    let attempted = false;
    try {
      if (request.action !== "release") this.requireActive(this.store.requireProject(member.projectId));
      const generation = this.store.memberRevisions(memberId).sessionGeneration;
      if (generation !== request.expectedSessionGeneration) throw new ApiError(409, "세션 세대가 변경되었습니다");
      const lease = this.store.inputState(memberId).lease;
      if (request.action === "claim" && lease && lease.claimId !== request.claimId) throw new ApiError(409, "다른 조작권이 있습니다");
      if (request.action !== "claim" && (!lease || lease.claimId !== request.claimId || lease.identity.terminalId !== member.paneId)) throw new ApiError(409, "조작권이 만료되었거나 바뀌었습니다");
      if ((request.action === "input" || request.action === "key") && request.inputSequence !== lease!.lastInputSequence + 1) throw new ApiError(409, "입력 순번이 변경되었습니다");
      attempted = true;
      const result = await this.terminalControl(memberId, { action: request.action, leaseId: lease?.leaseId ?? request.claimId, ...(request.action === "input" ? { text: request.text } : request.action === "key" ? { key: request.key } : {}) });
      return this.store.finishOperation({ ...receipt, status: "applied", result: { memberId, action: request.action, claimId: request.claimId, sessionGeneration: generation, ...result, ...((request.action === "input" || request.action === "key") ? { inputSequence: request.inputSequence } : {}) } }) as OperationReceipt<"terminal_control">;
    } catch (error) {
      const unknown = attempted && !(error instanceof ApiError && error.code === "TERMINAL_REFUSED");
      return this.store.finishOperation({ ...receipt, status: unknown ? "unknown" : "refused", code: unknown ? "TERMINAL_UNKNOWN" : "TERMINAL_REFUSED", error: (error as Error).message.slice(0, 500) }) as OperationReceipt<"terminal_control">;
    }
  }

  /**
   * 한 번에 보내기: 조작권 얻기 → 글 보내기(core terminal.send 는 글을 넣고 바로 제출한다) → 키 → 조작권 놓기. 모두 terminalControlV2(세대·조작권·입력 순번·operation ID)를 거친다.
   * 같은 operationId 로 다시 부르면 단계마다 저장된 결과를 돌려줘 글이 두 번 들어가지 않는다. 결과가 불명확하면 화면을 먼저 읽으라고 돌려준다.
   * AI 가 일하는 중(working)에는 글을 넣지 않는다(키만: 멈추기·승인 창 조작용).
   */
  async terminalSend(memberId: string, req: { operationId: string; text?: string; key?: TerminalKey; by: string }): Promise<{ status: "applied" | "refused" | "unknown"; steps: string[]; error?: string; sessionGeneration: number }> {
    const member = this.store.requireMember(memberId);
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(req.operationId)) throw new ApiError(400, "operationId 형식이 잘못되었습니다");
    if (!req.text && !req.key) throw new ApiError(400, "보낼 글이나 키가 필요합니다");
    if (req.text && (member.status === "working" || this.runtime(memberId).turn)) throw new ApiError(409, `${josa(member.name, "은")} 일하는 중이라 글을 넣지 않습니다. 끝난 뒤 다시 하거나, 멈추려면 key 'esc'/'ctrl+c' 만 보냅니다`, "TERMINAL_REFUSED");
    const generation = this.store.memberRevisions(memberId).sessionGeneration;
    const claimId = `${req.by}-${req.operationId}`.slice(0, 120);
    const steps: string[] = [];
    const run = async (suffix: string, body: { action: "claim" | "release" } | { action: "input"; text: string } | { action: "key"; key: TerminalKey }) => {
      // 다시 부른 같은 단계는 저장된 결과를 그대로 돌려준다(순번을 다시 셈하지 않는다: 두 번 넣지 않기 위해).
      const done = this.store.getOperation(`${req.operationId}-${suffix}`) as OperationReceipt<"terminal_control"> | null;
      if (done) { steps.push(`${suffix}:${done.status}(이전 결과)`); return done; }
      const lease = this.store.inputState(memberId).lease;
      const seq = body.action === "input" || body.action === "key" ? (lease?.lastInputSequence ?? 0) + 1 : undefined;
      const receipt = await this.terminalControlV2(memberId, { operationId: `${req.operationId}-${suffix}`, expectedSessionGeneration: generation, claimId, ...body, ...(seq !== undefined ? { inputSequence: seq } : {}) } as TerminalControlRequestV2);
      steps.push(`${suffix}:${receipt.status}`);
      return receipt;
    };
    let failed: OperationReceipt<"terminal_control"> | null = null;
    const claim = await run("claim", { action: "claim" });
    if (claim.status !== "applied") failed = claim;
    if (!failed && req.text) { const r = await run("input", { action: "input", text: req.text }); if (r.status !== "applied") failed = r; }
    if (!failed && req.key) { const r = await run("key", { action: "key", key: req.key }); if (r.status !== "applied") failed = r; }
    if (claim.status === "applied") await run("release", { action: "release" }).catch(() => undefined);
    if (!failed) return { status: "applied", steps, sessionGeneration: generation };
    return { status: failed.status === "unknown" ? "unknown" : "refused", steps, error: failed.error ?? undefined, sessionGeneration: generation };
  }

  async patchMemberConfigV2(memberId: string, patch: PatchMemberReq, precondition: RevisionPrecondition): Promise<MemberConfigWriteResult> {
    this.store.requireMember(memberId);
    if (this.configWrites.has(memberId)) throw new ApiError(409, "직원 설정을 적용하는 중입니다");
    if (this.store.memberRevisions(memberId).configRevision !== precondition.expectedRevision) throw new ApiError(409, "직원 설정이 변경되었습니다", "REVISION_CONFLICT");
    this.configWrites.add(memberId);
    try {
      const member = await this.patchMemberConfigOnce(memberId, patch);
      return { member, ...this.store.memberRevisions(memberId) };
    } finally { this.releaseConfigWrite(memberId); }
  }

  async updateSettingsV2(patch: SettingsPatch, precondition: RevisionPrecondition): Promise<SettingsWriteResult> {
    if (this.settingsWriting) throw new ApiError(409, "설정을 적용하는 중입니다");
    if (this.store.settingsRevision() !== precondition.expectedRevision) throw new ApiError(409, "설정이 변경되었습니다", "REVISION_CONFLICT");
    this.settingsWriting = true;
    try {
      const settings = await this.updateSettingsOnce(patch);
      return { settings, revision: this.store.settingsRevision() };
    } finally { this.settingsWriting = false; this.resumePumps(); }
  }

  async setTodoDoneV2(todoId: string, request: TodoDoneRequest, precondition: RevisionPrecondition): Promise<TodoWriteResult> {
    if (this.store.todoRevision(todoId) !== precondition.expectedRevision) throw new ApiError(409, "할 일이 변경되었습니다", "REVISION_CONFLICT");
    const writing = this.setTodoDone(todoId, request.done);
    const revision = this.store.todoRevision(todoId);
    const todo = await writing;
    return { todo, revision };
  }

  // ---- 시작·종료 ----
  /** 서버 재시작 복구(§6). 끊긴 턴을 정리하고 대기열을 다시 민다. */
  async recover(): Promise<void> {
    this.recovering = true;
    try {
      for (const member of this.store.listAllMembers()) {
        if (this.backendOf(member) !== "core") continue;
        const state = this.store.ensureContextState(member.id);
        this.store.saveContextState({ ...state, measurement: state.measurement ? { ...state.measurement, fresh: false } : null,
          compaction: state.compaction && ["sending", "running"].includes(state.compaction.phase) ? { ...state.compaction, phase: "uncertain", reason: "send_uncertain" } : state.compaction });
      }
      // An interrupted external mutation is never replayed on restart.
      for (const receipt of this.store.listPendingOperations()) if (receipt.status === "pending") this.store.finishOperation({ ...receipt, status: "unknown", code: "RESTART_UNKNOWN", error: "서버 재시작으로 작업 결과를 확인할 수 없습니다. 같은 입력을 재생하지 않습니다" });
      await this.recoverStops();
      // 서버가 강제로 죽었으면 전 턴의 자식이 살아 있다. 먼저 끝내야 같은 세션을 둘이 쓰지 않는다.
      await Promise.all([...this.runners.values()].map((r) => r.reapOrphans?.().catch((e) => console.warn("남은 자식 정리 실패:", (e as Error).message))));
      for (const d of this.store.listDeliveries()) this.deliveryRecovery.requeueRejected(d.id);
      for (const d of this.store.listDelivering()) this.deliveryRecovery.beginRecovery(d.id);
      this.store.releaseHeldBeforeConnection();
      await this.refreshConnection();
      const herdrMembers: Member[] = [];
      for (const member of this.store.listAllMembers()) {
        if (member.subagents !== 0 || !member.subagentState) this.store.patchMember(member.id, { subagents: 0, subagentState: { quality: "unknown", count: null, observedAt: null, sessionGeneration: this.store.memberRevisions(member.id).sessionGeneration } });
        if (member.origin === "manual") continue;
        const project = this.store.requireProject(member.projectId);
        if (this.runners.has("core")) {
          if (member.backend !== "core" && (member.sessionId || member.paneId)) {
            for (const d of this.store.listPending(member.id)) this.hold(d, "legacy_session");
            this.store.patchMember(member.id, { lastError: "이전 실행기의 세션입니다. 새 core 세션으로 명시적으로 전환해야 합니다" });
            continue;
          }
          if (member.backend === "core" && member.status !== "asleep" && !project.archived) {
            this.coreSupervisor?.watch(this.runnerMember(member, project));
            if (!this.coreSupervisor && member.paneId) this.store.patchMember(member.id, { lastError: "core 재연결 보류: 읽기 재결합을 지원하지 않습니다" });
          }
          continue;
        }
        if (this.backendOf(member) === "herdr") {
          // 가져온 명부의 직원은 세션도 칸도 없어 재결합할 것이 없다.
          if (member.status !== "asleep" && (member.sessionId || member.paneId)) herdrMembers.push(member);
          continue;
        }
        if (member.status === "working" || member.status === "blocked") {
          this.settle(member);
          this.memberNotice(member, `서버 재시작으로 ${member.name}의 턴이 끊겼습니다`);
          const conductor = this.store.getConductor(project.id);
          if (conductor && conductor.id !== member.id) {
            this.store.enqueue({
              projectId: project.id,
              memberId: conductor.id,
              kind: "system",
              text: formatSystem(`서버 재시작으로 ${member.name}의 턴이 끊겼습니다. 필요하면 다시 지시하세요.`),
              wake: false,
            });
          }
        }
      }
      await this.coreSupervisor?.tick();
      await Promise.all([...this.eventQueues.values()]);
      await this.reconcileExecutions();
      await Promise.all(herdrMembers.map((m) => this.reattachHerdr(m)));
    } finally { this.recovering = false; }
    this.coreSupervisor?.start();
    this.startTick();
    const checking = this.settleInFlight();
    const ids = new Set(this.store.listUndelivered().map((d) => d.memberId));
    await Promise.all([checking, ...[...ids].map(id => this.pump(id))]);
    await this.retryOrphans();
    this.checkTaskContinuations();
  }

  /** Every backend uses persisted item evidence; legacy missing envelopes stay fenced. */
  private async settleInFlight(): Promise<void> {
    await this.deliveryRecovery.tick();
    this.reconcileTodoCorrections();
    this.reconcileRejectedExecutions();
    this.releaseSlots();
  }

  private reconcileRejectedExecutions(): void {
    for (const run of this.store.listPendingExecutions()) {
      const dispatch = this.store.getDispatch(run.runId);
      if (dispatch?.transportState !== "rejected" || run.startedAt || run.inputReceivedAt) continue;
      const at = new Date().toISOString();
      this.store.saveExecutionJournal({ ...run, phase: "ended", result: "error", reason: run.reason ?? "not_written", endedAt: at, updatedAt: at });
    }
  }

  /** 일하던 칸을 잃었거나 턴이 끊겼다. 대기열이 없으면 아무도 깨우지 않아 팀이 조용히 멈춘다. 총괄이 기다리는 일이라 깨운다. */
  private noticeCutTurn(member: Member, why: string): void {
    this.memberNotice(member, `${member.name}: ${why}`);
    const conductor = this.store.getConductor(member.projectId);
    if (conductor && conductor.id !== member.id) {
      void this.deliver({ projectId: member.projectId, memberId: conductor.id, kind: "system", text: formatSystem(`${member.name}: ${why}. 필요하면 다시 지시하세요.`) });
    }
  }

  private async reattachHerdr(member: Member): Promise<void> {
    const runner = this.runners.get("herdr") as HerdrCapable | undefined;
    if (!runner) return;
    const project = this.store.requireProject(member.projectId);
    const rt = this.runtime(member.id);
    const wasWorking = member.status === "working";
    rt.reattaching = true;
    try {
      const found = await runner.reattach(this.runnerMember(member, project));
      this.unattached.delete(member.id);
      if (!found) {
        this.store.patchMember(member.id, { status: "offline", paneId: null, lastError: null });
        if (wasWorking) this.noticeCutTurn(member, "서버가 꺼진 사이 칸이 사라져 하던 턴이 끊겼습니다");
        return;
      }
      if (member.lastError?.startsWith("herdr 재결합 실패")) this.store.patchMember(member.id, { lastError: null });
      // reattach 안에서 칸의 실제 상태(승인 창 등)가 DB 에 이미 들어갔다. 옛 값으로 덮어쓰면 안 된다.
      const fresh = this.store.requireMember(member.id);
      if (runner.isBusy(member.id) || fresh.status === "blocked") {
        // 턴이 이어지는 중이다. 재시작 전에 이미 post 했으면 턴 끝에 (자동) 보고를 또 내지 않는다.
        const since = this.store.lastTurnStart(member.id);
        rt.posted = since !== null && this.store.hasMessageBySince(member.id, since);
        return;
      }
      if (wasWorking && (await this.reportFinishedWhileAway(fresh, project, runner))) return;
      this.settle(fresh);
      if (wasWorking) this.noticeCutTurn(fresh, "서버가 꺼진 사이 턴이 끊겼습니다. 끝났다는 보고를 찾지 못했습니다");
    } catch (e) {
      // 소켓이 안 닿으면 칸이 사라졌다고 볼 수 없다. 틱이 다시 시도한다.
      this.unattached.add(member.id);
      this.store.patchMember(member.id, { lastError: `herdr 재결합 실패: ${(e as Error).message}` });
    } finally {
      rt.reattaching = false;
    }
  }

  /** 서버가 꺼진 사이 끝난 턴의 마지막 글을 보고로 살린다. 이미 post 했거나 이번 입력 뒤의 글이 아니면 하지 않는다. */
  private async reportFinishedWhileAway(member: Member, project: Project, runner: HerdrCapable): Promise<boolean> {
    const since = this.store.lastTurnStart(member.id);
    if (!since || !runner.finishedWhileAway) return false;
    const finished = runner.finishedWhileAway(this.runnerMember(member, project), since);
    if (!finished) return false;
    const rt = this.runtime(member.id);
    rt.posted = this.store.hasMessageBySince(member.id, since);
    await this.onTurnEnd(member, { type: "turn_end", memberId: member.id, finalText: finished.finalText, isError: finished.isError, ...(finished.isError ? { errorText: finished.finalText } : {}) });
    return true;
  }

  private startTick(): void {
    if (this.tick) return;
    this.tick = setInterval(() => this.onTick(), this.timings.tickMs);
    this.tick.unref?.();
    this.healthTimer = setInterval(() => void this.refreshConnection().catch((e) => console.warn("실행기 상태 확인 실패:", (e as Error).message)), this.timings.healthMs);
    this.healthTimer.unref?.();
  }

  /** 전역 실행기가 지금 쓸 수 있는지 다시 본다. 달라졌으면 화면에 알리고, 돌아왔으면 보류된 것을 민다. 겹쳐 불러도 한 번만 묻는다. */
  refreshConnection(): Promise<void> {
    this.healthProbe ??= this.probeHealth().finally(() => {
      this.healthProbe = null;
    });
    return this.healthProbe;
  }

  /**
   * Real 2026-11-07 run: one member's pump never settled (queue stuck for minutes, other members fine, gone after a
   * daemon restart) and nothing said where it waited. Report the stage once per pump. Diagnostics only: this never
   * sends, presses Enter, interrupts or resets the pump.
   */
  private reportStuckPumps(): void {
    const now = Date.now();
    for (const [memberId, rt] of this.runtimes) {
      if (!rt.pumping || rt.pumpReported || rt.pumpSince === null || now - rt.pumpSince < this.timings.stuckPumpMs) continue;
      const member = this.store.getMember(memberId);
      if (!member) continue;
      rt.pumpReported = true;
      const seconds = Math.round((now - rt.pumpSince) / 1000);
      const text = `전달 처리가 ${seconds}초째 끝나지 않았습니다(대기 단계: ${rt.pumpStage ?? "알 수 없음"}). 자동으로 다시 넣거나 중단하지 않습니다`;
      this.store.appendActivity(memberId, "error", text, `pump-stuck:${rt.pumpSince}`);
      console.warn("전달 펌프 정체:", memberId, rt.pumpStage, `${seconds}s`);
    }
  }

  private async probeHealth(): Promise<void> {
    const backend = this.store.effectiveBackend();
    const runner = this.runners.get(backend);
    const state = runner ? await runner.available().catch((e: Error) => ({ ok: false, detail: e.message })) : { ok: false, detail: "실행기가 없습니다" };
    if (this.closed) return;
    const changed = this.store.setRunnerHealth(backend, { ok: state.ok, detail: state.ok ? null : state.detail });
    await this.recoverStops();
    for (const member of this.store.listAllMembers()) {
      const project = this.store.requireProject(member.projectId);
      if (member.backend === "core" && member.origin !== "manual" && member.status !== "asleep" && !project.archived) this.coreSupervisor?.watch(this.runnerMember(member, project));
      else this.coreSupervisor?.unwatch(member.id);
    }
    await this.coreSupervisor?.tick();
    await this.reconcileExecutions();
    this.reportStuckPumps();
    if (!changed) return;
    await this.broadcastHerdr();
    if (!state.ok) return;
    for (const id of new Set(this.store.listUndelivered().map((d) => d.memberId))) void this.pump(id);
    void this.retryOrphans().catch((e) => console.warn("보류된 말 전달 재시도 실패:", (e as Error).message));
  }

  private onTick(): void {
    for (const member of this.store.listAllMembers()) {
      if (this.backendOf(member) !== "core") continue;
      this.reconcileCoreCompact(member);
      if (this.store.getContextState(member.id)?.compaction?.phase === "queued") void this.pump(member.id);
    }
    void this.settleInFlight().catch(e => console.warn("전달 확인 실패:", e));
    for (const id of [...this.unattached]) {
      const member = this.store.getMember(id);
      if (member && member.status !== "asleep") void this.reattachHerdr(member);
      else this.unattached.delete(id);
    }
    this.checkManualMembers();
    // 입력칸을 못 찾았거나(선택 창 등) 소켓이 끊겨 못 맞춘 새 설정을 다시 시도한다.
    for (const m of this.store.listAllMembers()) {
      if ((m.status === "idle" || m.status === "waiting") && this.configPending(m)) void this.pump(m.id);
    }
    void this.retryOrphans().catch((e) => console.warn("보류된 말 전달 재시도 실패:", (e as Error).message));
    void this.broadcastHerdr();
    // Quiet notices remain pending until a real wake. Check before pumping them:
    // otherwise their short-lived pump would suppress this same tick every time.
    try {
      this.checkTaskContinuations();
    } catch (e) {
      console.warn("미완료 업무 재개 확인 실패:", (e as Error).message);
    }
    const ids = new Set(
      this.store
        .listUndelivered()
        .filter((d) => !(d.status === "held" && (d.holdReason === "asleep" || d.holdReason === "runner_disabled")))
        .map((d) => d.memberId),
    );
    for (const id of ids) void this.pump(id);
    try {
      this.checkBoardTidy();
    } catch (e) {
      console.warn("판 정리 확인 실패:", (e as Error).message);
    }
    try {
      this.checkTaskWatches();
    } catch (e) {
      console.warn("반복 감시 확인 실패:", (e as Error).message);
    }
  }

  /**
   * 판 정리(주기). 틱마다 부른다. 조건이 모두 맞는 프로젝트의 총괄(본사는 본사 AI)에게만 판 정리 지시를 깨움으로 넣는다:
   * 보관 아님 · 실행 켜짐 · 연결됨 · 총괄이 이미 떠 있고 쉬는 중(일하는 중·잠듦·꺼짐·넘겨받은 칸이면 건너뛴다. 정리하려고 띄우지 않는다)
   * · 간격이 지남 · 지난 정리 뒤 결재·할 일·진행판·대화에 바뀐 게 있음 · 기다리는 판 정리 지시가 없음. 넣은 프로젝트 id 를 돌려준다.
   */
  checkBoardTidy(now = Date.now()): string[] {
    const hours = this.store.getSettings().boardTidyHours;
    if (!(hours > 0) || this.closed || this.switching) return [];
    const queued: string[] = [];
    for (const project of this.store.listProjects()) {
      if (!project.runnerEnabled || !project.connection.ok || this.archiving.has(project.id)) continue;
      const lead = this.store.getConductor(project.id);
      if (!lead || lead.origin !== "runner" || (!lead.sessionId && !lead.paneId)) continue;
      if (lead.status !== "idle" && lead.status !== "waiting") continue;
      const rt = this.runtime(lead.id);
      if (this.isBusy(lead) || rt.starting || rt.reopening || rt.pumping || rt.closing) continue;
      if (this.tidyPending(lead.id)) continue;
      // 한 번도 정리하지 않았으면 총괄이 뜬 때부터 센다.
      const review = this.store.getBoardReview(project.id);
      const since = review?.requestedAt ?? project.tidiedAt ?? lead.createdAt;
      if (now - Date.parse(since) < hours * 3_600_000) continue;
      const changed = this.store.lastBoardChangeAt(project.id);
      if (review?.completedAt ? this.store.boardRevision(project.id) <= (review.reviewedRevision ?? -1) : !review && (!changed || changed <= since)) continue;
      this.queueBoardReview(project.id, lead, false, new Date(now).toISOString());
      void this.pump(lead.id);
      queued.push(project.id);
    }
    return queued;
  }

  private queueBoardReview(projectId: string, lead: Member, manual: boolean, at = new Date().toISOString()): void {
    this.store.transaction(() => {
      this.store.requestBoardReview(projectId, at);
      this.store.enqueue({ projectId, memberId: lead.id, kind: "system", text: formatTidy(lead.kind, manual) });
    });
  }

  /** 판 정리 지시가 줄 서 있거나 지금 그 턴이 돈다. */
  private tidyPending(memberId: string): boolean {
    if (this.runtimes.get(memberId)?.turn?.deliveries?.some(isTidy)) return true;
    if (this.store.listPendingExecutions().some(run => run.memberId === memberId && run.deliveryIds.some(id => { const delivery = this.store.getDelivery(id); return delivery && isTidy(delivery); }))) return true;
    return this.store.listPending(memberId).some(isTidy);
  }

  /**
   * 대표의 '지금 판 정리'. 간격·바뀐 것을 따지지 않는다. 총괄이 없거나 잠들었으면 띄운다. 연결은 http 가 먼저 본다(409).
   * 이미 기다리거나 도는 판 정리가 있으면 새로 넣지 않는다.
   */
  async tidyBoard(projectId: string): Promise<TidyResult> {
    const project = this.store.requireProject(projectId);
    this.requireActive(project);
    if (!project.runnerEnabled) throw new ApiError(409, "이 프로젝트는 실행이 꺼져 있습니다. 총괄을 시작하거나 기존 세션을 편입하세요");
    const lead = this.store.getConductor(projectId) ?? (await this.ensureConductor(projectId));
    if (lead.origin === "adopted") throw new ApiError(409, `${josa(lead.name, "은")} 넘겨받은 세션이라 도구가 없습니다. 팀 화면에서 '도구 붙여 다시 열기'를 먼저 하세요`);
    if (this.tidyPending(lead.id)) return { already: true };
    this.queueBoardReview(projectId, lead, true);
    await this.pump(lead.id);
    return { already: false };
  }

  /** 서버가 보낼 이벤트가 없어도 herdr 가 내려가거나 올라오면 화면이 알아야 한다. */
  private async broadcastHerdr(): Promise<void> {
    if (!this.herdr) return;
    const info = await this.herdrInfo();
    const key = JSON.stringify(info);
    if (key === this.lastHerdrInfo) return;
    if (this.lastHerdrInfo !== null) this.store.broadcast({ type: "herdr", herdr: info });
    this.lastHerdrInfo = key;
  }

  /** 직접 띄운 CLI 는 실행기가 없어 도구 호출 시각으로만 상태를 안다. */
  private checkManualMembers(): void {
    const now = Date.now();
    for (const m of this.store.listAllMembers()) {
      if (m.origin !== "manual") continue;
      const quiet = now - new Date(m.updatedAt).getTime();
      // 답을 기다리는 세션은 브리지가 롱폴을 다시 걸 때마다 시각이 새로워진다. 그것마저 끊겼으면 죽은 것이다.
      if (quiet >= this.timings.manualOfflineMs && (m.status === "idle" || m.status === "working" || m.status === "waiting")) this.store.patchMember(m.id, { status: "offline" });
      else if (quiet >= this.timings.manualIdleMs && m.status === "working") this.store.patchMember(m.id, { status: "idle" });
    }
  }

  /** 도구를 부르면 살아 있고 일하는 중이다. wait 는 지시를 기다리는 것이니 대기다. */
  noteManualCall(member: Member, tool: string): void {
    if (member.origin !== "manual") return;
    const next = tool === "wait" ? "idle" : tool === "ask_wait" || member.status === "waiting" ? "waiting" : "working";
    if (member.status !== next) this.store.patchMember(member.id, { status: next });
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    this.devMemory?.stop();
    if (this.memoryReconcileTimer) clearInterval(this.memoryReconcileTimer);
    await Promise.all([...this.terminalStreamClosers].map(close => close()));
    await this.coreSupervisor?.shutdown();
    await Promise.all([...this.eventQueues.values()]);
    if (this.tick) clearInterval(this.tick);
    if (this.healthTimer) clearInterval(this.healthTimer);
    for (const rt of this.runtimes.values()) {
      if (rt.compactTimer) clearTimeout(rt.compactTimer);
      if (rt.retryTimer) clearTimeout(rt.retryTimer);
    }
    for (const waiters of [...this.askWaiters.values(), ...this.inboxWaiters.values()]) {
      for (const wake of waiters) wake();
    }
    await this.deliveryRecovery.shutdown();
    await Promise.all([...this.runners.values()].map((r) => r.shutdown()));
  }

  // ---- REST 겉면 ----
  async createProject(req: CreateProjectReq): Promise<Project> {
    const goal = req.goal?.trim();
    const project = this.store.createProject({ name: req.name, cwd: req.cwd, now: goal, creationGoal: req.goal ?? null, chiefCli: req.chiefCli, ...(req.memory !== undefined ? { memory: req.memory } : {}) });
    if (req.startConductor) {
      const conductor = await this.ensureConductor(project.id);
      if (goal) await this.deliver({ projectId: project.id, memberId: conductor.id, kind: "system", text: formatSystem(`프로젝트 목표: ${guardLines(goal)}`) });
    }
    return this.store.requireProject(project.id);
  }

  async patchProject(projectId: string, input: PatchProjectReq): Promise<Project> {
    const { memory, ...patch } = input;
    if (memory !== undefined) {
      // 기억 운영 켜기·끄기는 세션을 건드리지 않는다. 바뀐 도구·규칙은 각 세션이 쉬는 틈에 같은 대화로 이어 열 때 들어간다.
      this.store.setProjectMemory(projectId, memory);
      if (Object.values(patch).every((value) => value === undefined)) return this.store.requireProject(projectId);
    }
    if (this.projectPatches.has(projectId) || this.archiving.has(projectId)) throw new ApiError(409, "프로젝트 변경을 처리하는 중입니다. 잠시 뒤 다시 하세요");
    this.projectPatches.add(projectId);
    const awake = new Set(this.store.listMembers(projectId).filter(m => m.status !== "asleep").map(m => m.id));
    try {
      const project = this.store.requireProject(projectId);
      const validated = this.store.validateProjectPatch(projectId, patch);
      if (project.archived && patch.archived !== false && this.store.listMembers(projectId).some(m => m.origin !== "manual" && m.status !== "asleep" && (m.sessionId || m.paneId))) throw new ApiError(409, "보관된 프로젝트의 세션 종료 상태를 확인해야 합니다");
      if (Object.entries(validated).every(([key, value]) => project[key as keyof Project] === value)) return project;
      await this.beforeProjectPatch(project, patch);
      const saved = this.store.patchProject(projectId, validated);
      await this.onProjectPatched(saved, patch);
      return this.store.requireProject(projectId);
    } catch (error) {
      if (!this.store.requireProject(projectId).archived) for (const memberId of awake) {
        if (this.store.getMember(memberId)?.status !== "asleep") continue;
        for (const delivery of this.store.listPending(memberId)) if (delivery.status === "held" && delivery.holdReason === "archived") this.hold(delivery, "asleep");
      }
      throw error;
    } finally {
      this.archiving.delete(projectId);
      this.projectPatches.delete(projectId);
    }
  }

  /** v1 HTTP hook 호환. W9에서 HTTP도 patchProject 한 곳으로 옮긴다. */
  async beforeProjectPatch(project: Project, patch: PatchProjectReq): Promise<void> {
    this.store.validateProjectPatch(project.id, patch);
    if (this.archiving.has(project.id)) throw new ApiError(409, "프로젝트 변경을 처리하는 중입니다. 잠시 뒤 다시 하세요");
    if (patch.runnerEnabled === true && (patch.archived ?? project.archived)) this.requireActive(project);
    if (patch.archived !== true || project.archived) return;
    this.archiving.add(project.id);
    const slept: Member[] = [];
    try {
      this.checkArchivable(project);
      const managed = this.store.listMembers(project.id).filter(m => m.origin !== "manual" && m.status !== "asleep" && (m.sessionId || m.paneId));
      for (const m of managed) {
        const rt = this.runtime(m.id);
        if (rt.starting || rt.reopening || rt.pumping || rt.closing || this.configWrites.has(m.id) || this.terminalMutations.has(m.id) || this.pendingLifecycle(m.id) || this.store.inputState(m.id).lease) throw new ApiError(409, `${m.name}의 세션을 처리하는 중입니다`);
        try {
          await this.verifyArchiveSession(m);
          await this.runnerOf(m).checkStop?.(this.runnerMember(m, project), { whileWorking: false });
        } catch (e) {
          if (this.backendOf(m) !== "core" && this.skipsArchiveRefusal(m, e)) continue;
          throw this.archiveRefusal(m, e);
        }
      }
      this.checkArchivable(project);
      for (const m of managed) {
        try {
          await this.sleepMember(m.id, { force: true, holdAs: "archived" });
          slept.push(m);
        } catch (e) {
          if (this.backendOf(m) !== "core" && this.skipsArchiveRefusal(m, e)) continue;
          const refusal = this.archiveRefusal(m, e);
          throw new ApiError(refusal.status, `${refusal.message}${slept.length ? ` (${slept.map(s => s.name).join(", ")}의 칸은 이미 끝나 잠든 채로 둡니다)` : ""}`);
        }
      }
      this.checkArchivable(project);
      // 장벽은 DB commit과 큐 보류까지 onProjectPatched가 유지한다.
    } catch (e) {
      for (const m of slept) for (const d of this.store.listPending(m.id)) if (d.status === "held" && d.holdReason === "archived") this.hold(d, "asleep");
      this.archiving.delete(project.id);
      throw e;
    }
  }

  private async verifyArchiveSession(member: Member): Promise<void> {
    const runner = this.runnerOf(member);
    if (this.store.inputState(member.id).lease) throw new ApiError(409, "직접 조작권을 해제한 뒤 보관하세요");
    if (runner instanceof CoreRunner && !member.sessionId) {
      // 읽기 poll은 기존 terminal의 nonce만 탐색한다. 식별용 업무를 보내지 않는다.
      await runner.screen(this.runnerMember(member, this.store.requireProject(member.projectId)));
      await Promise.all([...this.eventQueues.values()]);
      member = this.store.requireMember(member.id);
    }
    if (!member.sessionId) throw new ApiError(409, "이어갈 native 세션 기록을 확인하는 중입니다");
    if ((runner as Runner).sessionExists?.(this.runnerMember(member, this.store.requireProject(member.projectId))) === false) throw new ApiError(409, "이어갈 native 세션 기록을 확인할 수 없습니다");
    if (runner instanceof CoreRunner) {
      const log = this.contextLog(member);
      if (!log) throw new ApiError(409, "이어갈 native 세션 기록을 확인할 수 없습니다");
      const records = readJsonlRange(providerLogRoot(member.cli, log.home), log.path).records;
      if (member.cli === "antigravity" ? !records.some(record => jsonObject(record.value)?.type === "USER_INPUT") : member.cli !== "codex" && !records.some(record => {
        const entry = jsonObject(record.value);
        return entry?.sessionId === member.sessionId && entry.cwd === member.cwd && !entry.isSidechain;
      })) throw new ApiError(409, "현재 native 세션과 일치하는 주 세션 기록을 확인할 수 없습니다");
    }
  }

  /** 안 보이는 직원의 칸은 소켓이 안 닿아도 보관을 막지 않는다. 쓰던 글이 있다는 거절은 언제나 막는다. */
  private skipsArchiveRefusal(m: Member, e: unknown): boolean {
    if (m.status !== "offline" || this.isCannotExit(e)) return false;
    console.warn(`${m.name} 잠재우기 실패:`, (e as Error).message);
    return true;
  }

  private isCannotExit(e: unknown): boolean {
    return (e instanceof CoreError && !e.uncertain && ["busy", "input_busy", "conflict", "unsupported"].includes(e.kind)) || (e instanceof HerdrError && e.code === "cannot_exit") || (e instanceof ApiError && e.status === 409);
  }

  private archiveRefusal(m: Member, e: unknown): ApiError {
    const why = (e as Error).message;
    return this.isCannotExit(e) ? new ApiError(409, `${m.name}의 칸을 끝내지 못해 보관할 수 없습니다: ${why}`) : new ApiError(503, `${m.name}의 칸을 확인하지 못해 보관할 수 없습니다: ${why}`);
  }

  async createMember(projectId: string, req: CreateMemberReq): Promise<Member> {
    return (await this.addMember(projectId, req)).member;
  }

  async freshMemberSession(memberId: string): Promise<Member> {
    const member = this.store.requireMember(memberId);
    if (member.origin === "manual") throw new ApiError(400, "직접 띄운 세션은 새로 열 수 없습니다");
    return this.switchProvider(member, { cli: member.cli }, false, true);
  }

  private async switchProvider(member: Member, patch: PatchMemberReq, fromPump = false, freshSession = false): Promise<Member> {
    const project = this.store.requireProject(member.projectId);
    this.requireActive(project);
    const rt = this.runtime(member.id);
    if (rt.closing || rt.starting || (!fromPump && rt.pumping) || rt.reopening || rt.turn || this.isBusy(member) || member.status === "working" || member.status === "blocked") {
      throw new ApiError(409, "일하거나 세션을 처리하는 중입니다. 턴이 끝난 뒤 CLI를 바꾸세요");
    }
    if (this.store.listDelivering().some((d) => d.memberId === member.id) || this.store.listPending(member.id).some((d) => d.holdReason === "delivery_unknown")) {
      throw new ApiError(409, "전달 여부가 확인되지 않은 입력이 있어 CLI를 바꿀 수 없습니다");
    }
    rt.closing = true;
    let changedSession = false;
    let sessionReady = false;
    try {
      // Validate the target invocation before stopping a working installation.
      const target = { ...member, ...patch, cli: patch.cli!, sessionId: !freshSession && patch.cli === member.cli && member.cli === "claude" ? member.sessionId : null, paneId: null };
      const targetRunner = this.runners.get(this.store.effectiveBackend());
      if (targetRunner instanceof CoreRunner) {
        const model = this.desiredConfig(target).model;
        if (target.cli === "codex" && model && /^(?:claude[-:]|opus(?:-|$)|sonnet(?:-|$)|haiku(?:-|$))/i.test(model)) throw new ApiError(400, "Codex용 모델을 고르거나 직원 모델 지정을 기본값으로 되돌리세요");
        if (target.cli === "antigravity" && model && !ANTIGRAVITY_MODEL_RE.test(model)) throw new ApiError(400, "Antigravity용 모델을 고르거나 직원 모델 지정을 기본값으로 되돌리세요");
        try { providerLaunch(this.runnerMember(target, project), this.writeRunFiles(target, project, !!target.sessionId), this.config); }
        catch (e) { throw new ApiError(400, `CLI 설정을 적용할 수 없습니다: ${(e as Error).message}`); }
      }
      // Complete the old session before rotating credentials. Failure leaves the original identity intact.
      if ((member.sessionId || member.paneId) && !(freshSession && member.backend !== "core" && this.runners.has("core"))) {
        try { await this.stopManaged(member, "fresh_session", false); }
        catch (e) {
          if (!(freshSession && member.status === "offline" && e instanceof CoreError && e.kind === "not_found")) throw e;
        }
      }
      changedSession = true;
      const sameProvider = patch.cli === member.cli;
      this.store.transaction(() => {
        this.endExecution(member, "interrupted", freshSession ? "명시적 새 세션으로 전환했습니다" : "세션 설정을 변경했습니다");
        this.confirmStop(member.id);
        this.store.archiveAndRotateSession(member.id, patch.cli!, freshSession ? "fresh_session" : sameProvider ? "settings_change" : "provider_switch");
      });
      if (!freshSession && sameProvider && member.cli === "claude") this.store.patchMember(member.id, { sessionId: member.sessionId });
      this.store.patchMember(member.id, { ...patch, ...(freshSession ? { origin: "runner" as const } : {}), backend: this.store.effectiveBackend(), status: "idle", lastError: null });
      if (member.kind !== "worker") this.store.setChiefCli(project.id, patch.cli!);
      const handoff = [
        `CLI 설정 변경: ${member.cli} → ${patch.cli}. ${!freshSession && sameProvider && member.cli === "claude" ? "같은 Claude 세션을 새 설정으로 이어 열었습니다" : "이전 제공자의 세션을 재개하지 않는 새 세션입니다"}.`,
        `역할: ${member.role}. 현재 상황: ${member.now}. 다음: ${member.next}.`,
        `프로젝트 상황: ${project.now}. board 도구로 대화·결재·작업을 확인하고 계속하세요.`,
      ].join("\n");
      this.store.enqueue({ projectId: project.id, memberId: member.id, kind: "system", text: formatSystem(handoff), wake: false });
      const fresh = this.store.requireMember(member.id);
      this.openRunner(fresh);
      const started = await this.startManaged(fresh, project, !!fresh.sessionId);
      this.applyStarted(member.id, project, started, this.desiredConfig(fresh));
      sessionReady = true;
      this.store.appendActivity(member.id, "system", handoff);
      return this.store.requireMember(member.id);
    } catch (e) {
      if (changedSession) this.store.patchMember(member.id, { status: "error", lastError: `새 세션 시작 실패: ${(e as Error).message}` });
      throw e;
    } finally {
      rt.closing = false;
      if (sessionReady && !fromPump) void this.pump(member.id);
    }
  }

  /** 보관한 프로젝트는 화면에 없어 멈출 수 없다. 세션을 새로 띄우거나 깨우는 길은 모두 여기서 막는다. */
  private requireActive(project: Project): void {
    if (project.archived || this.archiving.has(project.id)) throw new ApiError(409, "보관된 프로젝트이거나 보관을 처리하는 중입니다. 꺼낸 뒤 다시 하세요");
  }

  /** 전체 설정을 고친다. 실행 방식은 일하는 직원이 있으면 거부하고, 아니면 이전 실행기의 칸을 닫은 뒤 다음 전달부터 새 방식으로 잇는다. */
  async updateSettings(patch: SettingsPatch): Promise<Settings> {
    if (this.settingsWriting) throw new ApiError(409, "설정을 적용하는 중입니다");
    this.settingsWriting = true;
    try { return await this.updateSettingsOnce(patch); }
    finally { this.settingsWriting = false; this.resumePumps(); }
  }

  private async updateSettingsOnce(patch: SettingsPatch): Promise<Settings> {
    const normalized = this.models.settingsPatch(patch, this.store.getSettings());
    patch = normalized.patch;
    const response = (settings: Settings): Settings => normalized.resetEfforts.length ? { ...settings, resetEfforts: normalized.resetEfforts } : settings;
    if (this.archiving.size) throw new ApiError(409, "프로젝트 보관을 처리하는 중입니다");
    const before = this.store.getSettings();
    if (this.runners.has("core")) {
      if (patch.backend && patch.backend !== "core") throw new ApiError(400, "실행기는 herdr-core 하나입니다");
      const settings = this.store.patchSettings({ ...patch, backend: "core" });
      await this.refreshConnection();
      for (const member of this.store.listAllMembers()) if (this.configPending(member)) void this.pump(member.id);
      return response(settings);
    }
    let settings: Settings;
    if (patch.backend && patch.backend !== before.backend) {
      this.requireNotSwitching();
      // 칸을 닫는 동안 나간 지시는 칸과 함께 사라진다. 끝날 때까지 전달을 세우고, 끝나면(거부돼도) 줄 선 것을 민다.
      this.switching = true;
      try {
        await this.switchBackend(patch.backend);
        settings = this.store.patchSettings(patch);
      } finally {
        this.switching = false;
        for (const m of this.store.listAllMembers()) if (m.origin !== "manual" && this.store.listPending(m.id).length > 0) void this.pump(m.id);
      }
    } else {
      settings = this.store.patchSettings(patch);
    }
    await this.refreshConnection();
    // 쉬고 있는 세션은 곧바로 새 설정으로 맞춘다. 응답을 칸 여는 시간만큼 붙잡지 않는다.
    for (const m of this.store.listAllMembers()) if (this.configPending(m)) void this.pump(m.id);
    return response(settings);
  }

  private requireNotSwitching(): void {
    if (this.switching) throw new ApiError(409, "실행 방식을 바꾸는 중입니다. 잠시 뒤 다시 하세요");
  }

  private refuseIfBusy(member: Member): void {
    const rt = this.runtime(member.id);
    if (this.isBusy(member) || member.status === "working" || member.status === "blocked" || rt.pumping || rt.starting || rt.reopening) {
      throw new ApiError(409, `${this.store.requireProject(member.projectId).name}의 ${josa(member.name, "이")} 일하는 중이라 실행 방식을 바꿀 수 없습니다. 끝난 뒤 다시 하세요`);
    }
  }

  private async switchBackend(next: Backend): Promise<void> {
    const members = this.store.listAllMembers().filter((m) => m.origin !== "manual");
    // 관문을 지난 전달이 아직 돌 수 있다. 끝나면 턴으로 잡혀 아래 검사에 걸린다.
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(members.map((m) => this.runtime(m.id).pumping)),
      new Promise((done) => {
        settleTimer = setTimeout(done, SWITCH_SETTLE_MS);
      }),
    ]);
    clearTimeout(settleTimer);
    for (const m of members) {
      const fresh = this.store.getMember(m.id);
      if (fresh) this.refuseIfBusy(fresh);
    }
    const moving = members.filter((m) => this.backendOf(m) !== next);
    // 넘겨받은 칸은 끝내지 못할 수 있다. 하나라도 그러면 아무 칸도 끝내기 전에 거부한다.
    for (const member of moving) {
      const project = this.store.requireProject(member.projectId);
      await this.runners
        .get(this.backendOf(member))
        ?.checkStop?.(this.runnerMember(member, project))
        .catch((e) => this.refuseSwitch(member, project, e));
    }
    const moved: string[] = [];
    try {
      for (const { id } of moving) {
        // 앞 칸을 닫는 동안 달라졌을 수 있다. 전달은 서 있지만 대표가 칸에서 일을 시작할 수 있다.
        const member = this.store.getMember(id);
        if (!member) continue;
        this.refuseIfBusy(member);
        const project = this.store.requireProject(member.projectId);
        // 칸을 남기면 같은 세션을 두 실행기가 함께 쓴다. 세션 파일은 그대로라 새 방식으로 이어서 열 수 있다.
        // 이전 실행기가 죽어 있어도 옮길 수 있어야 한다. herdr 가 안 켜져서 바꾸는 경우가 흔하다.
        await this.runners
          .get(this.backendOf(member))
          ?.stop(this.runnerMember(member, project))
          .catch(async (e) => {
            await this.refuseSwitch(member, project, e);
            this.store.appendActivity(member.id, "error", `이전 실행기의 칸을 닫지 못했습니다: ${(e as Error).message}`);
          });
        // 끝낸 넘겨받은 칸은 잠든 것과 같다. 깨울 때 도구와 규칙을 갖고 뜨며 서버 세션이 된다.
        const handedBack = member.origin === "adopted" && !!member.sessionId && member.status !== "asleep" && member.status !== "offline";
        // 병렬은 세션에만 있는 값이라 새 칸·새 프로세스에서 풀린다. 다음 일 전에 되살린다.
        if (member.parallel) this.runtime(id).wantParallel ??= true;
        this.store.patchMember(id, { backend: member.backend ? next : null, paneId: null, ...(member.parallel ? { parallel: false } : {}), ...(handedBack ? { status: "asleep" as const } : {}) });
        moved.push(member.name);
      }
    } catch (e) {
      // 닫은 칸은 되돌릴 수 없다. 옮긴 직원은 새 방식으로 잇고, 대표가 다시 시도하면 남은 직원만 옮긴다.
      if (e instanceof ApiError && moved.length > 0) throw new ApiError(e.status, `${e.message} (${moved.join(", ")}의 칸은 이미 닫아 새 방식으로 옮겼습니다)`);
      throw e;
    }
  }

  /** 칸의 세션이 살아 있는데 넘어가면 같은 세션을 두 프로세스가 쓴다. 실행기가 정말 죽어 있는 경우만 넘어간다. */
  private async refuseSwitch(member: Member, project: Project, e: unknown): Promise<void> {
    const refusal = new ApiError(409, `${project.name}의 ${member.name} 칸을 끝내지 못해 실행 방식을 바꿀 수 없습니다: ${(e as Error).message}`);
    if (e instanceof HerdrError) {
      if (e.code === "cannot_exit") throw refusal;
      if (e.code === "down" || e.code === "closed") return;
    }
    // 시간 초과 등은 실행기가 살아 있으면 칸도 살아 있을 수 있다.
    const health = await this.runners.get(this.backendOf(member))?.available().catch(() => ({ ok: false }));
    if (health?.ok) throw refusal;
  }

  /** 직원별 모델·effort. null 이면 직급 기본으로 돌아간다. */
  /**
   * 총괄이 직원의 CLI·모델·effort 를 바꾼다(대표 화면의 직원 설정과 같은 저장·검증 경로).
   * CLI 를 바꾸면 맞지 않게 되는 기존 지정을 서버가 몰래 비우지 않는다: 그런 경우 거절하고 model·effort 를 함께 밝히게 한다.
   */
  async configureMember(memberId: string, patch: PatchMemberReq): Promise<{ member: Member; applied: string }> {
    const target = this.store.requireMember(memberId);
    if (patch.cli === undefined && patch.modelOverride === undefined && patch.effortOverride === undefined) throw new ApiError(400, "바꿀 cli·model·effort 중 하나는 필요합니다");
    const cli = patch.cli ?? target.cli ?? "claude";
    if (cli === "antigravity" && patch.effortOverride != null) throw new ApiError(400, "Antigravity 는 effort 를 따로 받지 않습니다. 모델 이름에 들어 있는 값을 고르세요");
    const { resetOverrides } = this.models.memberPatch(target, patch, this.store.getSettings());
    if (resetOverrides.length) throw new ApiError(400, `CLI 를 ${cli}(으)로 바꾸면 지금 지정한 ${resetOverrides.map((k) => k === "modelOverride" ? `model(${target.modelOverride})` : `effort(${target.effortOverride})`).join("·")}을 그 CLI 가 지원하지 않습니다. 새 CLI 에 맞는 값을 함께 넣거나 null(직급 기본값)로 밝혀 다시 부르세요`);
    const member = await this.patchMemberConfig(memberId, patch);
    const config = memberConfig(member, this.store.getSettings().ranks, this.store.getSettings().codexRanks);
    const live = member.status !== "asleep" && member.status !== "offline";
    return { member, applied: `CLI ${member.cli ?? "claude"} · 모델 ${config.model ?? "CLI 기본"} · effort ${config.effort ?? (member.cli === "antigravity" ? "모델 이름에 포함" : "CLI 기본")}${live && patch.cli === undefined ? ". 모델·effort 는 세션을 다시 열 때 적용됩니다(team_sleep 뒤 team_resume)" : ""}` };
  }

  async patchMemberConfig(memberId: string, patch: PatchMemberReq): Promise<Member> {
    this.requireActive(this.store.requireProject(this.store.requireMember(memberId).projectId));
    if (this.configWrites.has(memberId)) throw new ApiError(409, "직원 설정을 적용하는 중입니다");
    this.configWrites.add(memberId);
    try { return await this.patchMemberConfigOnce(memberId, patch); }
    finally { this.releaseConfigWrite(memberId); }
  }

  private releaseConfigWrite(memberId: string): void {
    this.configWrites.delete(memberId);
    if (!this.closed && this.store.getMember(memberId)) void this.pump(memberId);
  }

  private async patchMemberConfigOnce(memberId: string, patch: PatchMemberReq): Promise<Member> {
    const member = this.store.requireMember(memberId);
    this.requireActive(this.store.requireProject(member.projectId));
    if (this.runtime(memberId).closing || this.runtime(memberId).starting || this.runtime(memberId).reopening || this.pendingLifecycle(memberId)) throw new ApiError(409, "세션을 처리하는 중입니다");
    if (member.origin === "manual") throw new ApiError(400, "직접 띄운 세션은 설정을 바꿀 수 없습니다");
    const normalized = this.models.memberPatch(member, patch, this.store.getSettings());
    patch = normalized.patch;
    if (patch.cli && patch.cli !== member.cli) {
      const updated = await this.switchProvider(member, patch);
      if (normalized.resetOverrides.length) {
        this.store.appendActivity(memberId, "system", `CLI 변경으로 지원하지 않는 ${normalized.resetOverrides.join(", ")} 지정을 비우고 직급 기본값으로 되돌렸습니다`);
        return { ...updated, resetOverrides: normalized.resetOverrides };
      }
      return updated;
    }
    if (this.runners.has("core") && member.backend === "core" && (member.sessionId || member.paneId) &&
        ((patch.modelOverride !== undefined && patch.modelOverride !== member.modelOverride) || (patch.effortOverride !== undefined && patch.effortOverride !== member.effortOverride))) {
      return this.switchProvider(member, { ...patch, cli: member.cli });
    }
    return this.store.patchMember(memberId, patch);
  }

  /** 보관하면 화면에서 사라진다. 답을 기다리는 세션이나 일하는 세션을 두고 사라지면 아무도 풀어 줄 수 없다. */
  private checkArchivable(project: Project): void {
    const members = this.store.listMembers(project.id);
    if (this.settingsWriting || this.switching) throw new ApiError(409, "실행 설정을 처리하는 중입니다");
    for (const member of members) {
      const rt = this.runtime(member.id);
      if (rt.starting || rt.reopening || rt.pumping || rt.closing || this.configWrites.has(member.id) || this.terminalMutations.has(member.id)) throw new ApiError(409, `${member.name}의 세션을 처리하는 중입니다`);
    }
    const busy = members.find((m) => m.status === "working" || m.status === "blocked" || (m.origin !== "manual" && this.isBusy(m)));
    if (busy) throw new ApiError(409, `${josa(busy.name, "이")} 일하는 중이라 보관할 수 없습니다`);
    const open = this.store.listDecisions(project.id).filter((d) => d.status === "open").length;
    if (open > 0) throw new ApiError(409, `열린 결재 ${open}건에 답한 뒤 보관하세요`);
    const todos = this.store.listTodos(project.id).filter((t) => !t.done).length;
    if (todos > 0) throw new ApiError(409, `안 한 할 일 ${todos}건을 처리한 뒤 보관하세요`);
  }

  async onProjectPatched(project: Project, patch: PatchProjectReq): Promise<void> {
    try {
      if (patch.archived === true) {
        // 사전 hook에서 전원 종료했다. commit 뒤 새 입력은 없다.
        for (const d of this.store.listUndelivered(project.id)) if (d.status === "queued" && d.attempts === 0) this.hold(d, "archived");
      }
      if (patch.runnerEnabled === true) {
        this.store.setRunnerByAdopt(project.id, false);
        if (patch.archived !== false) await this.enableProject(project.id);
      }
    } finally { this.archiving.delete(project.id); }
    if (patch.archived === false) {
      const stopped = this.store.listUndelivered(project.id).filter(d => d.status === "held" && d.holdReason === "archived");
      for (const id of new Set(stopped.map(d => d.memberId))) void this.pump(id);
    }
    if (patch.maxConcurrentTurns !== undefined) this.resumePumps();
  }

  async startConductor(projectId: string): Promise<Member> {
    const project = this.store.requireProject(projectId);
    this.requireActive(project);
    // 먼저 본다. 실행기가 없는데 켜 두면 연결된 것처럼 보인다.
    const backend = this.store.effectiveBackend();
    const runner = this.runners.get(backend);
    if (!runner) throw new ApiError(503, `실행기가 없습니다: ${backend}`);
    const available = await runner.available();
    if (!available.ok) throw new ApiError(503, available.detail ?? "실행기를 쓸 수 없습니다");
    this.requireActive(this.store.requireProject(projectId));
    if (!project.runnerEnabled) this.store.patchProject(projectId, { runnerEnabled: true });
    const conductor = await this.ensureConductor(projectId);
    if (conductor.status === "asleep") await this.resumeMember(conductor.id);
    await this.enableProject(projectId);
    return this.store.requireMember(conductor.id);
  }

  private async enableProject(projectId: string): Promise<void> {
    this.requireActive(this.store.requireProject(projectId));
    await this.adoptOrphans(projectId);
    await Promise.all(this.store.listMembers(projectId).map((m) => this.pump(m.id)));
  }

  /** 받을 사람이 없어 멈춘 대표의 말·답·완료를 총괄에게 넘긴다. */
  private async adoptOrphans(projectId: string): Promise<void> {
    if (this.orphanMessages(projectId).length + this.orphanAnswers(projectId).length + this.orphanTodos(projectId).length === 0) return;
    const conductor = await this.ensureConductor(projectId);
    // 기다리는 사이 겹친 호출이 이미 넘겼을 수 있다. 여기부터 줄 세우기까지 await 가 없어야 두 번 넘기지 않는다.
    const messages = this.orphanMessages(projectId);
    const answers = this.orphanAnswers(projectId);
    const todos = this.orphanTodos(projectId);
    for (const message of messages) {
      this.store.enqueue({
        projectId,
        memberId: conductor.id,
        kind: "user_message",
        text: formatUserMessage(message.body, this.attachmentsFor(conductor, message.attachments), message.id, false, this.taskLineFor(projectId, message.taskId)),
        refType: "message",
        refId: message.id,
      });
    }
    for (const d of answers) this.store.enqueue({ projectId, memberId: conductor.id, kind: "answer", text: formatAnswer(d), refType: "decision", refId: d.id });
    for (const t of todos) {
      this.store.enqueue({ projectId, memberId: conductor.id, kind: "todo_done", text: formatTodoDone(t), refType: "todo", refId: t.id });
      this.store.setTodoNoticePending(t.id, false);
    }
  }

  /** 실행이 켜진 프로젝트에서 총괄을 못 띄워 멈춘 말이 있으면 다시 시도한다. 실행기가 돌아오면 저절로 풀린다. */
  private repairSourceIntents(projectId: string): void {
    this.store.transaction(() => {
      for (const message of this.store.listMessagesMissingDeliveries(projectId)) {
        const member = message.targetMemberId ? this.store.getMember(message.targetMemberId) : null;
        if (member) this.store.enqueue({ projectId, memberId: member.id, kind: "user_message", text: formatUserMessage(message.body, this.attachmentsFor(member, message.attachments), message.id, true, this.taskLineFor(projectId, message.taskId)), refType: "message", refId: message.id });
      }
      for (const decision of this.store.listAnswersMissingDeliveries(projectId)) {
        const member = decision.memberId ? this.store.getMember(decision.memberId) : null;
        if (member && member.origin !== "manual") this.store.enqueue({ projectId, memberId: member.id, kind: "answer", text: formatAnswer(decision), refType: "decision", refId: decision.id });
      }
      const lead = this.store.getConductor(projectId);
      if (lead) for (const message of this.store.listReportsMissingDeliveries(projectId)) {
        const author = message.memberId ? this.store.getMember(message.memberId) : null;
        if (author?.kind === "worker" && author.id !== lead.id) this.store.enqueue({ projectId, memberId: lead.id, kind: "report", text: this.reportText(message), wake: WAKE_POST_KINDS.has(message.kind), refType: "message", refId: message.id });
      }
    });
  }

  private async retryOrphans(): Promise<void> {
    if (this.closed) return;
    for (const project of this.store.listProjects()) {
      if (!project.runnerEnabled) continue;
      this.repairSourceIntents(project.id);
      if (this.store.getConductor(project.id)) {
        await this.adoptOrphans(project.id);
        for (const id of new Set(this.store.listUndelivered(project.id).map(d => d.memberId))) void this.pump(id);
        continue;
      }
      // 편입은 세션 하나를 넘겨준 것이다. 대표가 시키지 않은 총괄을 띄워 옛 지시를 실행하지 않는다.
      if (this.store.runnerByAdopt(project.id)) continue;
      if (this.orphanMessages(project.id).length + this.orphanAnswers(project.id).length + this.orphanTodos(project.id).length === 0) continue;
      await this.enableProject(project.id).catch((e) => console.warn(`${project.name} 총괄 띄우기 재시도 실패:`, (e as Error).message));
    }
  }

  /** 전달 항목이 없는 대표 메시지: 총괄이 없을 때 보류됐거나, 총괄을 띄우다 실패해 항목째 사라졌다. */
  private orphanMessages(projectId: string): Message[] {
    return this.store.listMessagesMissingDeliveries(projectId).filter(m => !m.targetMemberId);
  }

  /** 답했는데 물은 직원이 없어(가져온 카드, 닫힌 직원) 아무에게도 가지 않은 결재. */
  private orphanAnswers(projectId: string): Decision[] {
    return this.store.listAnswersMissingDeliveries(projectId).filter(d => !d.memberId || !this.store.getMember(d.memberId));
  }

  private orphanTodos(projectId: string): Todo[] {
    return this.store.listTodoNoticesPending(projectId);
  }

  /** Legacy retry requests schedule evidence collection and never bypass a fence. */
  async resendMessage(existing: Message): Promise<Message> {
    const current = this.store.requireMessage(existing.id);
    if (current.delivery !== "failed") return current;
    const target = current.targetMemberId ? this.store.getMember(current.targetMemberId) : null;
    if (current.targetMemberId && !target) throw new ApiError(409, "그 직원이 닫혀 다시 보낼 수 없습니다. 새 글로 보내세요");
    await this.refreshConnection();
    this.store.requireReachable(current.projectId, target);
    let deliveries = this.store.listDeliveries(current.projectId).filter(d => d.refType === "message" && d.refId === current.id);
    if (!deliveries.length) deliveries = [this.deliveryRecovery.materializeLegacyMessage(current.id)];
    for (const d of deliveries) {
      if (d.status !== "delivered") this.deliveryRecovery.beginRecovery(d.id);
    }
    await this.deliveryRecovery.tick();
    return this.store.requireMessage(current.id);
  }

  async sendUserMessage(projectId: string, req: SendMessageReq): Promise<Message> {
    const project = this.store.requireProject(projectId);
    this.requireActive(project);
    const attachments = (req.attachmentIds ?? []).map(id => this.store.getAttachment(id)).filter((a): a is Attachment => a !== null);
    const target = req.targetMemberId ? this.store.requireMember(req.targetMemberId) : null;
    if (target && target.projectId !== projectId) throw new ApiError(400, "이 프로젝트의 직원이 아닙니다");
    const chosen = req.taskId ? this.store.requireTask(req.taskId) : null;
    if (chosen && chosen.projectId !== projectId) throw new ApiError(400, "이 프로젝트의 작업이 아닙니다");
    const named = req.newTaskTitle?.trim() || null;
    if (chosen && named) throw new ApiError(400, "고른 업무(taskId)와 새 업무 이름(newTaskTitle)은 함께 보내지 않습니다");
    if (named && project.isHq) throw new ApiError(400, "본사 대화는 업무를 쓰지 않습니다");
    // 합쳐진 업무를 골랐으면(오래 열어 둔 화면) 합쳐진 곳으로 보낸다.
    const picked = chosen ? this.store.resolveTask(chosen) : null;
    const messageId = req.id ?? newId("msg_");
    let recipient = target ?? this.store.getConductor(projectId);
    let booting: Promise<void> | null = null;
    const { value: message, deliveries } = this.store.withDeliveryIntents(() => {
      // 같은 id 로 다시 보낸 글은 처음 붙은 업무 그대로다(업무를 새로 만들지 않는다).
      const existing = this.store.getMessage(messageId);
      const taskId = existing ? existing.taskId ?? null : picked?.id ?? this.ownerMessageTask(project, messageId, req.text, named, attachments.length > 0, target);
      const message = this.store.createMessage({ id: messageId, projectId, mine: true, who: "나", kind: "나", body: req.text,
        targetMemberId: target?.id ?? null, targetName: target?.name ?? null, attachments, delivery: "queued", taskId });
      if (!recipient && project.runnerEnabled) {
        const spawn = this.beginConductor(project);
        recipient = spawn.member;
        booting = spawn.ready;
      }
      if (!recipient) return this.store.setMessageDelivery(message.id, "held", HOLD_NOTES.runner_disabled);
      return message;
    }, message => {
      if (!recipient) return [];
      const intents: NewDelivery[] = [{ projectId, memberId: recipient.id, kind: "user_message",
        text: formatUserMessage(message.body, this.attachmentsFor(recipient, attachments), message.id, !!target, this.taskLineFor(projectId, message.taskId)), refType: "message", refId: message.id }];
      const conductor = this.store.getConductor(projectId);
      const task = message.taskId ? this.store.getTask(message.taskId) : null;
      // 직접 지시 알림도 그 글의 업무에 붙인다(총괄이 같은 업무 칩에서 판을 맞추게).
      if (target && conductor && conductor.id !== target.id) intents.push({ projectId, memberId: conductor.id, kind: "system",
        text: formatSystem(`대표가 ${target.name}에게 직접 지시했습니다 #${message.id}${task ? `(작업 #${task.id} '${task.title}')` : ""}. 이미 ${target.name}에게 전달했습니다. 같은 일을 다시 시키지 말고, 결과 보고를 기다려 판만 맞추세요.`), wake: false, taskId: task?.id ?? null });
      return intents;
    });
    if (booting) await (booting as Promise<void>).catch(e => console.warn(`${project.name} 총괄을 띄우지 못했습니다:`, (e as Error).message));
    // 총괄이 맡긴 업무에 대표가 직원에게 바로 끼어들었으면 개선 후보로 남긴다(지시가 모자랐거나 판이 늦었을 수 있다). 규칙은 바꾸지 않는다.
    if (target?.kind === "worker" && message.taskId && (this.store.hasInstruction(target.id, message.taskId) || bindingContract(this.store.getEffectiveContract(message.taskId)))) {
      this.store.recordHarnessFinding({ projectId, taskId: message.taskId, memberId: target.id, kind: "owner_intervened", detail: `대표가 총괄이 맡긴 업무에 ${target.name}에게 직접 지시했습니다(#${message.id})`, refType: "message", refId: message.id });
    }
    await Promise.all([...new Set(deliveries.map(d => d.memberId))].map(id => this.pump(id)));
    return this.store.requireMessage(message.id);
  }

  /**
   * 업무를 고르지 않고 보낸 대표 글의 업무. 대표가 새 업무 이름을 줬으면 그 이름(owner), 아니면 글 첫 줄로 서버가 이름 붙인 새 업무(auto).
   * 출처 키가 글 id 라 같은 글로는 업무가 하나만 생긴다. 마지막으로 본 업무로 짐작하지 않는다. 본사는 업무를 쓰지 않는다.
   * auto 업무는 총괄이 그 대표 글을 인용해 다른 업무로 맡기면 그 업무로 합쳐진다(instructionTask).
   */
  private ownerMessageTask(project: Project, messageId: string, text: string, named: string | null, hasAttachments: boolean, target: Member | null): string | null {
    return this.store.ownerTask(project.id, { newTaskTitle: named, sourceRef: `message:${messageId}`, text, fallbackLabel: hasAttachments ? "대표 첨부" : "대표 글", who: target?.name ?? "" });
  }

  /** 첨부를 그 직원의 폴더로 잇는다. herdr 칸은 이 폴더만 승인 없이 읽고, 다른 프로젝트의 첨부는 열지 않는다. */
  private attachmentsFor(member: Member, attachments: Attachment[]): Attachment[] {
    if (attachments.length === 0) return attachments;
    const dir = join(this.config.home, "inbox", member.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return attachments.map((a) => {
      // 전에 올라온 첨부의 이름에는 위험한 글자가 남아 있을 수 있다. 전달 글에 들어가는 경로는 이 이름으로 만든다.
      const dest = join(dir, `${a.id}-${sanitizeName(a.name)}`);
      try {
        if (!existsSync(dest)) {
          try {
            linkSync(a.path, dest);
          } catch {
            copyFileSync(a.path, dest);
          }
        }
        return { ...a, path: dest };
      } catch {
        // 원본이 사라졌거나 잇지 못했다. 데이터 폴더의 원본 경로(하네스가 막는 곳)를 넘기지 않고 받을 자리를 그대로 알린다. 읽는 쪽에서 '없음'이 보인다.
        return { ...a, path: dest };
      }
    });
  }

  async answerDecision(decisionId: string, req: AnswerReq): Promise<Decision> {
    let booting: Promise<void> | null = null;
    const { value: { decision, changed }, deliveries } = this.store.withDeliveryIntents(() => this.store.answerDecision(decisionId, req), ({ decision, changed }) => {
      if (!changed) return [];
      const asker = decision.memberId ? this.store.getMember(decision.memberId) : null;
      let conductor = this.store.getConductor(decision.projectId);
      const project = this.store.requireProject(decision.projectId);
      if (!asker && !conductor && project.runnerEnabled && !this.store.runnerByAdopt(project.id)) {
        const spawn = this.beginConductor(project);
        conductor = spawn.member;
        booting = spawn.ready;
      }
      const recipient = asker ?? conductor;
      const intents: NewDelivery[] = [];
      if (recipient && asker?.origin !== "manual") intents.push({ projectId: project.id, memberId: recipient.id, kind: "answer", text: formatAnswer(decision), refType: "decision", refId: decision.id });
      if (conductor && recipient && conductor.id !== recipient.id) intents.push({ projectId: project.id, memberId: conductor.id, kind: "system",
        text: formatSystem(`대표가 ${decision.who}의 결재에 답했습니다. 이미 ${decision.who}에게 전달했습니다. 같은 일을 다시 시키지 말고, 결과 보고를 기다려 판만 맞추세요.\n${formatAnswer(decision)}`), wake: false });
      return intents;
    });
    if (!changed) return decision;
    this.queueDecisionMemory(decision);
    this.noteOwnerRejection(decision);
    if (booting) await (booting as Promise<void>).catch(e => console.warn("결재 답을 받을 총괄을 띄우지 못했습니다:", (e as Error).message));
    this.wakeAll(this.askWaiters, decisionId);
    if (decision.memberId) this.wakeAll(this.inboxWaiters, decision.memberId);
    await Promise.all([...new Set(deliveries.map(d => d.memberId))].map(id => this.pump(id)));
    const asker = decision.memberId ? this.store.getMember(decision.memberId) : null;
    if (asker && asker.origin !== "manual") this.refreshWaiting(asker.id);
    return this.store.requireDecision(decisionId);
  }

  /**
   * 대표가 결재에 거절·다시·보류로 보이는 답을 했으면 개선 후보로 남긴다. 글자로 짐작한 것이라 '추정'이라 쓴다.
   * 후보는 기록일 뿐 규칙·권한을 바꾸지 않는다(총괄이 보고 개발 기억에 남길지 정한다).
   */
  private noteOwnerRejection(decision: Decision): void {
    if (!decision.taskId) return;
    const option = decision.options.find(o => o.k === decision.choice);
    const said = [option?.label, decision.note].filter(Boolean).join(" / ");
    if (!said || !/반려|거절|다시|아니|안 ?돼|보류|중단|멈춰|하지 ?마|틀렸|빠졌|부족/.test(said)) return;
    this.store.recordHarnessFinding({ projectId: decision.projectId, taskId: decision.taskId, memberId: decision.memberId, kind: "owner_rejected",
      detail: `대표가 '${decision.title.slice(0, 80)}'에 '${said.slice(0, 160)}'로 답했습니다(거절·다시로 보임, 글자 추정)`, refType: "decision", refId: decision.id });
  }

  async setTodoDone(todoId: string, done: boolean): Promise<Todo> {
    let targetId: string | null = null;
    const { todo, changed } = this.store.transaction(() => {
      const result = this.store.setTodoDone(todoId, done);
      if (!result.changed) return result;
      const todo = result.todo;
      const target = (todo.memberId ? this.store.getMember(todo.memberId) : null) ?? this.store.getConductor(todo.projectId);
      targetId = target?.id ?? null;
      if (!done) {
        this.store.setTodoNoticePending(todo.id, false);
        this.store.cancelPendingFor("todo", todo.id);
        this.reconcileTodoCorrections(todo.id);
      } else if (target) {
        const delivery = this.store.enqueue({ projectId: todo.projectId, memberId: target.id, kind: "todo_done", text: formatTodoDone(todo), refType: "todo", refId: todo.id });
        this.store.patchDeliveryRetry(delivery.id, { correctionRevision: this.store.todoRevision(todo.id) });
      } else this.store.setTodoNoticePending(todo.id, true);
      return result;
    });
    if (changed && done && !targetId && this.store.requireProject(todo.projectId).runnerEnabled && !this.store.runnerByAdopt(todo.projectId)) {
      await this.ensureConductor(todo.projectId).catch(e => console.warn("할 일 완료를 받을 총괄을 띄우지 못했습니다:", (e as Error).message));
      await this.adoptOrphans(todo.projectId);
      targetId = this.store.getConductor(todo.projectId)?.id ?? null;
    }
    if (changed && targetId) {
      if (done) await this.pump(targetId);
      else void this.pump(targetId);
    }
    return todo;
  }

  /** A successful old send is an external fact. Compensate only after it settles. */
  private reconcileTodoCorrections(todoId?: string): void {
    this.store.transaction(() => {
      const groups = new Map<string, Delivery[]>();
      for (const delivery of this.store.listDeliveries()) if (delivery.refType === "todo" && delivery.refId && (!todoId || delivery.refId === todoId)) {
        const key = `${delivery.refId}:${delivery.memberId}`;
        groups.set(key, [...(groups.get(key) ?? []), delivery]);
      }
      for (const deliveries of groups.values()) {
        const delivered = deliveries.filter(d => d.status === "delivered").at(-1);
        if (!delivered?.refId) continue;
        const todo = this.store.getTodo(delivered.refId);
        if (!todo || todo.done) continue;
        const text = formatTodoUndone(todo);
        const revision = this.store.todoRevision(todo.id);
        if (delivered.text === text || deliveries.some(d => d.text === text && this.store.getDeliveryRetry(d.id).correctionRevision === revision)) continue;
        // A still unresolved older write can land after the correction. Wait for evidence.
        if (deliveries.some(d => d.status === "delivering" || this.store.inputState(d.memberId).unresolvedDispatches.some(dispatch => dispatch.items.some(item => item.deliveryId === d.id)))) continue;
        const correction = this.store.enqueue({ projectId: todo.projectId, memberId: delivered.memberId, kind: "todo_done", text, refType: "todo", refId: todo.id });
        this.store.patchDeliveryRetry(correction.id, { correctionRevision: revision });
        this.store.afterCommit(() => { void this.pump(correction.memberId); });
      }
    });
  }

  async memberSleep(memberId: string, opts: { force?: boolean } = {}): Promise<Member> {
    return this.sleepMember(memberId, opts);
  }

  async memberResume(memberId: string): Promise<Member> {
    return this.resumeMember(memberId);
  }

  async memberCompact(memberId: string): Promise<Member> {
    return this.compactMember(memberId);
  }

  /** 예전 화면·앱의 '중단'. 같은 멈춤 경로를 쓰고, 멈추지 못했으면 409 로 알린다. */
  async memberInterrupt(memberId: string): Promise<Member> {
    const result = await this.stopMember(memberId, { by: "user" });
    if (result.outcome === "failed") throw new ApiError(409, result.detail ?? "멈추지 못했습니다");
    return result.member;
  }

  /**
   * 직원의 지금 CLI 턴을 멈춘다. 대표 화면·총괄 도구가 같은 경로를 쓴다.
   * - 한 직원의 턴 단위다. 그 턴이 받은 작업이 여럿이면 모두 함께 멈춘다(taskIds 로 보인다).
   * - 화면에서 본 실행 id·세션 세대와 지금이 다르면 멈추지 않는다(다른 턴을 끊지 않는다).
   * - 같은 직원에 대한 멈춤이 이미 도는 중이면 그 결과를 함께 받는다(두 번 눌러도 키는 한 번).
   * - CLI 대화·바뀐 파일은 그대로다. 끊긴 턴은 다시 보내지 않고, 대기열의 지시는 입력이 가능해지면 차례로 나간다.
   */
  async stopMember(memberId: string, opts: { by: string } & StopReq): Promise<StopResult> {
    const inflight = this.stopping.get(memberId);
    if (inflight) return inflight;
    const run = this.stopOnce(memberId, opts).finally(() => this.stopping.delete(memberId));
    this.stopping.set(memberId, run);
    return run;
  }

  private async stopOnce(memberId: string, opts: { by: string } & StopReq): Promise<StopResult> {
    const member = this.store.requireMember(memberId);
    const project = this.store.requireProject(member.projectId);
    this.requireActive(project);
    const runner = this.runners.get(this.backendOf(member));
    if (member.origin === "manual" || !runner) throw new ApiError(400, "실행기가 관리하지 않는 세션입니다");
    const generation = this.store.memberRevisions(memberId).sessionGeneration;
    const rt = this.runtime(memberId);
    const exec = member.executionState ?? null;
    const live = exec && !["ended", "interrupted"].includes(exec.phase) ? exec : null;
    const result = (outcome: StopResult["outcome"], detail: string | null = null, shown: MemberExecutionState | null = live ?? exec): StopResult => {
      const now = this.store.requireMember(memberId);
      return { outcome, memberId, memberName: now.name, runId: shown?.runId ?? null, sessionGeneration: generation, taskIds: shown?.taskIds ?? [], detail, member: now };
    };
    if (opts.expectGeneration !== undefined && opts.expectGeneration !== null && opts.expectGeneration !== generation) return result("changed", "세션이 바뀌어 멈추지 않았습니다");
    if (opts.expectRunId && opts.expectRunId !== live?.runId) {
      const seen = this.store.getExecutionJournal(opts.expectRunId);
      if (seen && seen.memberId === memberId && ["ended", "interrupted"].includes(seen.phase)) {
        const shown = { ...seen, sessionGeneration: seen.identity.sessionGeneration, taskIds: [] } as unknown as MemberExecutionState;
        return result(seen.result === "interrupted" ? "stopped" : "not_running", seen.result === "interrupted" ? "이미 멈췄습니다" : "그 턴은 이미 끝났습니다", shown);
      }
      return result("changed", "화면에서 본 실행과 지금 실행이 달라 멈추지 않았습니다");
    }
    // core 압축은 턴(rt.turn) 없이 문맥 상태로만 돈다. 끝나지 않은 압축도 멈출 대상이다.
    const compaction = runner.kind === "core" ? this.store.getContextState(memberId)?.compaction : null;
    const compacting = !!compaction && !["succeeded", "failed"].includes(compaction.phase);
    const working = member.status === "working" || member.status === "blocked" || rt.turn?.kind === "work" || rt.turn?.kind === "compact" || compacting;
    if (!working) return result("not_running", "지금 하는 턴이 없습니다");
    if (rt.stopRequest?.confirmed && rt.stopRequest.runId === (live?.runId ?? null)) return result("stopped", "이미 멈췄습니다");
    const turn = rt.turn;
    const recordedIds = live ? this.store.getExecutionJournal(live.runId)?.deliveryIds : null;
    const receivedIds = recordedIds?.length ? recordedIds : turn?.deliveries?.map(d => d.id) ?? [];
    // A multi-task report supplement has no single taskId. Follow its recorded
    // waking scope. The display's taskIds may also contain unrelated quiet
    // context, so use it only when neither recorded nor current input IDs exist.
    const pausedTasks = opts.by === "user" ? receivedIds.length ? taskScopeForDeliveryIds(this.store, receivedIds) : live?.taskIds ?? [] : [];
    const pauseToken = pausedTasks.length ? randomUUID() : null;
    // 먼저 고정해야 중단 키 응답 중 서버가 재시작해도 같은 업무를 다시 깨우지 않는다.
    if (pauseToken) this.taskContinuations.pause(pausedTasks, pauseToken, stopReason(opts.by));
    rt.stopRequest = { runId: live?.runId ?? null, by: opts.by, at: new Date().toISOString(), confirmed: false };
    if (turn) turn.interrupted = true;
    try {
      await runner.interrupt(this.runnerMember(member, project));
    } catch (error) {
      if (pauseToken) this.taskContinuations.clearPause(pausedTasks, pauseToken);
      if (turn && rt.turn === turn) turn.interrupted = false;
      if (rt.stopRequest?.confirmed === false) rt.stopRequest = null;
      const after = this.store.requireMember(memberId);
      if (after.status !== "working" && after.status !== "blocked") return result("not_running", "멈추기 전에 턴이 끝났습니다");
      return result("failed", `멈추지 못했습니다: ${(error as Error).message}`);
    }
    if (rt.stopRequest) rt.stopRequest.confirmed = true;
    if (runner.kind === "core") {
      this.interruptCoreCompaction(member);
      const state = this.store.getContextState(memberId);
      if (state?.compaction?.phase === "failed" && rt.turn?.kind === "compact") this.store.saveContextState({ ...state, compaction: { ...state.compaction, reason: "interrupted" } });
      rt.compactRequest = null;
      if (rt.turn?.kind === "compact") this.endCompact(memberId, rt, "대표가 압축을 중단했습니다");
    }
    this.store.appendActivity(memberId, "system", `${stopReason(opts.by)}${live ? ` (실행 ${live.runId})` : ""}`);
    return result("stopped");
  }

  /** 화면의 '명부에서 빼기'. 직접 띄운 세션만. 실행기 세션은 총괄이 team_close 로 닫는다. */
  async memberClose(memberId: string): Promise<void> {
    const member = this.store.requireMember(memberId);
    if (member.origin !== "manual") throw new ApiError(400, "직접 띄운 세션만 여기서 뺄 수 있습니다");
    const { projectId, name } = member;
    const dropped = await this.closeMember(memberId);
    const conductor = this.store.getConductor(projectId);
    // 총괄이 보낸 지시가 안 나간 채 사라졌다. 도구 응답을 받을 사람이 없으니 알린다.
    if (conductor && dropped.length > 0) {
      await this.deliver({ projectId, memberId: conductor.id, kind: "system", text: formatSystem(`대표가 ${josa(name, "을")} 명부에서 뺐습니다. 나가지 않은 입력 ${dropped.length}건: ${dropped.join(" / ")}`), wake: false });
    }
  }

  async memberScreen(memberId: string): Promise<string> {
    const member = this.store.requireMember(memberId);
    if (this.runtime(memberId).closing) return ""; // 빠지는 중이다. 화면을 읽으려고 칸을 다시 묶지 않는다.
    const project = this.store.requireProject(member.projectId);
    return (await this.runners.get(this.backendOf(member))?.screen(this.runnerMember(member, project))) ?? "";
  }

  async memberApproval(memberId: string): Promise<ApprovalPrompt | null> {
    const member = this.store.requireMember(memberId);
    if (this.runtime(memberId).closing) return null;
    const runner = this.runners.get(this.backendOf(member));
    if (!runner?.approval) return null;
    return runner.approval(this.runnerMember(member, this.store.requireProject(member.projectId)));
  }

  /**
   * 대표가 승인 창의 선택지를 고른다. 대표 화면(HTTP)에서만 부른다. 총괄·직원의 도구에는 없다: AI 가 자기 일을 스스로 승인하면 안 된다.
   * 실행기가 누르기 직전 창을 다시 읽어 대표가 본 창과 같을 때만 누른다. 거절하며 남긴 말은 대표가 직원에게 직접 보낸 글로 넣는다.
   */
  async answerApproval(memberId: string, req: AnswerApprovalReq): Promise<void> {
    const member = this.store.requireMember(memberId);
    const runner = this.runners.get(this.backendOf(member));
    if (!runner?.answerApproval) throw new ApiError(501, "이 실행 방식에는 승인 창이 없습니다");
    const project = this.store.requireProject(member.projectId);
    this.requireActive(project);
    const r = await runner.answerApproval(this.runnerMember(member, project), req.fingerprint, req.option);
    if (!r.ok) {
      const why = {
        not_blocked: "승인 창 앞이 아닙니다. 이미 풀렸을 수 있습니다",
        unrecognized: "승인 창으로 읽히지 않는 창입니다. 터미널에서 푸세요",
        changed: "창이 바뀌었습니다. 새 창을 보고 다시 고르세요",
        no_option: "그 번호의 선택지가 없습니다",
        no_effect: "키를 눌렀지만 창이 그대로입니다. 터미널에서 확인하세요",
        gone: "칸을 찾지 못했습니다",
        input_busy: "수동 조작 중이거나 터미널 입력 상태가 바뀌었습니다. 조작을 끝내고 창을 다시 확인하세요",
      }[r.reason];
      throw new ApiError(r.reason === "no_option" ? 400 : 409, why);
    }
    this.store.appendActivity(member.id, "system", `대표가 승인 창에서 ${r.chosen.n}번 '${r.chosen.label}' 을 골랐습니다 · ${approvalSummary(r.prompt, 200)}`);
    const note = req.note?.trim();
    if (r.chosen.reject && note) await this.sendUserMessage(member.projectId, { text: note, targetMemberId: member.id });
  }

  /**
   * 결재함 '승인 대기'와 대화 '답을 기다림' 카드: 막힌 직원 CLI 의 질문·선택·승인 창과 그 귀속(프로젝트·직원·세대·실행·작업·창 차례·처음 읽은 시각).
   * 읽기만 한다. 실행기가 창을 읽지 못하면 prompt 는 limited(원문만)다. 보이는 글의 비밀값은 가린다(넣을 때는 원래 창 차례로 넣는다).
   */
  async memberNativePrompt(memberId: string): Promise<NativePromptState> {
    const member = this.store.requireMember(memberId);
    if (this.runtime(memberId).closing || member.status !== "blocked") return { prompt: null, context: null };
    const runner = this.runners.get(this.backendOf(member));
    if (!runner?.nativePrompt) return { prompt: null, context: null };
    const read = await runner.nativePrompt(this.runnerMember(member, this.store.requireProject(member.projectId)));
    if (!read) return { prompt: null, context: null };
    // 이미 답을 넣은 창: 창이 그대로여도 선택지를 다시 내지 않는다(두 번 넣지 않게)
    if (read.answered) return { prompt: null, context: null, answered: true };
    const observedAt = read.observedAt ?? null;
    this.nativeSeen.set(memberId, { promptId: read.promptKey, observedAt });
    return { prompt: this.shownPrompt(member, read.prompt), context: this.nativeContext(member, read.promptKey, observedAt) };
  }

  private nativeContext(member: Member, promptId: string, observedAt: string | null = null): NativePromptContext {
    const exec = member.executionState && !["ended", "interrupted"].includes(member.executionState.phase) ? member.executionState : null;
    const taskIds = exec?.taskIds ?? [];
    return { projectId: member.projectId, memberId: member.id, generation: this.store.memberRevisions(member.id).sessionGeneration, executionId: exec?.runId ?? null, taskId: taskIds.length === 1 ? taskIds[0]! : null, promptId, observedAt };
  }

  /** 대표 화면에 보일 창 글. 토큰·키·비밀번호 꼴과 서버 비밀값(접속 코드·직원 토큰)만 가린다. 선택지 번호·차례·뜻은 그대로다. */
  private shownPrompt(member: Member, prompt: NativePrompt): NativePrompt {
    const secrets = [...this.memorySecrets(), this.store.getMemberToken(member.id) ?? ""].filter((v) => v.length >= 8);
    const hide = (text: string) => redactSensitive(text, secrets);
    return { ...prompt, title: hide(prompt.title), body: hide(prompt.body), question: hide(prompt.question), raw: hide(prompt.raw),
      options: prompt.options.map((o) => ({ ...o, label: hide(o.label), ...(o.detail ? { detail: hide(o.detail) } : {}) })) };
  }

  private static cut(text: string, max: number): string { const t = text.replace(/\s+/g, " ").trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; }

  /** 마지막으로 카드에 보인 창(직원마다). 영수증의 '창 확인' 시각에 쓴다. */
  private nativeSeen = new Map<string, { promptId: string; observedAt: string | null }>();
  private nativeInflight = new Map<string, Promise<NativeAnswerReceipt>>();

  /**
   * 대표가 결재함·대화에서 직원 CLI 의 창에 답한다(대표 화면 HTTP 전용, AI 도구에는 없다). 업무 대기열을 거치지 않고 지금 창에 바로 넣는다.
   * 같은 operationId 는 처음 결과를 돌려준다(여러 탭·빠른 두 번 누름·응답 유실 재요청·서버 재시작 뒤). 넣는 중이든 끝난 뒤든 직원·프로젝트·요청 전체가 다르면 409 다. 넣기 전에 대기 영수증을 DB 에 적고,
   * 결과를 적기 전에 멈췄던 요청은 '모름'으로 답하며 다시 넣지 않는다. 직원·프로젝트·세대·실행·창 차례가 카드와 다르면 넣지 않는다.
   */
  async answerNativePrompt(memberId: string, req: AnswerNativePromptReq): Promise<NativeAnswerReceipt> {
    const member = this.store.requireMember(memberId);
    const scope = { operationId: req.operationId, projectId: member.projectId, memberId, request: req };
    // 넣는 중인 요청도 먼저 적은 대기 영수증과 같은 대조(직원·프로젝트·요청 전체)를 거친다. 하나라도 다르면 409 이고 넣지 않는다.
    const prior = this.store.getNativeAnswer(scope);
    const inflight = this.nativeInflight.get(req.operationId);
    if (inflight) return inflight;
    const project = this.store.requireProject(member.projectId);
    if (prior) return prior.pending ? this.nativeReceipt(memberId, req, "unknown", "결과를 적기 전에 서버가 멈췄습니다. 들어갔는지 모르니 다시 넣지 않습니다. 팀 화면에서 터미널을 확인하세요", { terminal: "unknown" }) : prior.receipt as NativeAnswerReceipt;
    this.requireActive(project);
    this.store.beginNativeAnswer(scope);
    const run = this.answerNativeOnce(member, project, req).catch((error: unknown) => {
      console.error("창 답 넣기 오류:", memberId, error);
      return this.nativeReceipt(memberId, req, "unknown", "넣는 중 결과를 확인하지 못했습니다. 다시 넣지 않습니다. 팀 화면에서 터미널을 확인하세요", { terminal: "unknown" });
    });
    this.nativeInflight.set(req.operationId, run);
    try {
      const receipt = await run;
      this.store.finishNativeAnswer(req.operationId, receipt);
      return receipt;
    } finally {
      this.nativeInflight.delete(req.operationId);
    }
  }

  private nativeReceipt(memberId: string, req: AnswerNativePromptReq, status: NativeAnswerReceipt["status"], note: string,
    extra: { terminal: NativeAnswerReceipt["terminal"]; label?: string | null; after?: NativeAnswerReceipt["after"]; reject?: boolean }): NativeAnswerReceipt {
    const seen = this.nativeSeen.get(memberId);
    return { operationId: req.operationId, status, note, memberId, promptId: req.promptId, option: status === "answered" ? req.option : null, label: extra.label ?? null,
      at: new Date().toISOString(), observedAt: seen?.promptId === req.promptId ? seen.observedAt : null, terminal: extra.terminal, after: extra.after ?? null, reject: extra.reject ?? false };
  }

  private async answerNativeOnce(member: Member, project: Project, req: AnswerNativePromptReq): Promise<NativeAnswerReceipt> {
    const refuse = (status: NativeAnswerReceipt["status"], note: string) => this.nativeReceipt(member.id, req, status, note, { terminal: "not_sent" });
    // 카드가 고정한 직원·프로젝트가 지금 받는 쪽과 다르면 넣지 않는다(다른 화면·다른 탭의 카드).
    if (req.memberId !== member.id || req.projectId !== member.projectId) return refuse("stale", "다른 직원이나 프로젝트의 카드라 넣지 않았습니다. 결재함을 새로고침해 지금 창을 보세요");
    const runner = this.runners.get(this.backendOf(member));
    if (!runner?.answerNativePrompt) return refuse("unsupported", "이 실행 방식은 화면에서 답할 수 없습니다. 터미널에서 답하세요");
    const context = this.nativeContext(member, req.promptId);
    if (context.generation !== req.generation) return refuse("stale", "세션이 바뀌어 넣지 않았습니다. 새 창을 보고 다시 고르세요");
    if (context.executionId !== req.executionId) return refuse("stale", "다른 실행으로 넘어가 넣지 않았습니다. 새 창을 보고 다시 고르세요");
    const r = await runner.answerNativePrompt(this.runnerMember(member, project), req.promptId, req.option, req.text);
    if (!r.ok) {
      const map: Record<typeof r.reason, [NativeAnswerReceipt["status"], string]> = {
        already: ["already_answered", "이 창에는 이미 답했습니다"],
        not_blocked: ["already_answered", "창이 이미 닫혔습니다. 다른 곳에서 답했을 수 있습니다"],
        changed: ["changed", "창이 바뀌어 넣지 않았습니다. 새 창을 보고 다시 고르세요"],
        unrecognized: ["unsupported", "창을 확실히 읽지 못해 넣지 않았습니다. 화면 원문을 보고 터미널에서 답하세요"],
        no_option: ["changed", "그 선택지가 지금 창에 없어 넣지 않았습니다"],
        needs_text: ["changed", "직접 입력하는 줄에는 보낼 글이 필요합니다"],
        gone: ["gone", "칸을 찾지 못했습니다(세션이 끝났을 수 있습니다)"],
        input_busy: ["busy", "다른 입력이 진행 중이라 넣지 않았습니다. 잠시 뒤 다시 보세요"],
        leased: ["busy", "다른 사람이 터미널을 조작 중이라 넣지 않았습니다"],
      };
      const [status, note] = map[r.reason];
      return refuse(status, note);
    }
    const prompt = this.shownPrompt(member, r.prompt);
    const chosen = prompt.options.find((o) => o.n === r.chosen.n) ?? r.chosen;
    const where = req.via === "inbox" ? "결재함" : "대화";
    const what = chosen.freeText ? `직접 입력으로 답했습니다: ${Orchestrator.cut(cleanText(req.text ?? ""), 120)}` : `${chosen.n}번 '${Orchestrator.cut(chosen.label, 80)}' 을 골랐습니다`;
    const terminal = r.terminal ?? "unconfirmed";
    this.store.appendActivity(member.id, "system", `대표가 ${where}에서 ${what} · ${Orchestrator.cut([prompt.title, prompt.question].filter(Boolean).join(" — "), 160)}${terminal === "accepted" ? "" : " · 넣은 뒤 창이 그대로였습니다"}`);
    // 대화에도 한 줄 남긴다: 다른 탭·기기에서도 이미 답한 것을 보고, 업무 지시와 섞이지 않게 시스템 글로 둔다.
    this.memberNotice(member, `${member.name}의 ${prompt.kind === "permission" ? "권한 창" : "질문 창"}에 대표가 ${where}에서 답함 — ${chosen.freeText ? `직접 입력 '${Orchestrator.cut(cleanText(req.text ?? ""), 80)}'` : `${chosen.n}번 '${Orchestrator.cut(chosen.label, 80)}'`}`);
    const label = Orchestrator.cut(chosen.label, 60);
    const note = terminal === "accepted" ? (chosen.freeText ? "보냈습니다" : `'${label}' 을 골랐습니다`)
      : `'${label}' 을 넣었지만 창이 그대로입니다. 다시 넣지 않습니다. 팀 화면에서 터미널을 확인하세요`;
    return this.nativeReceipt(member.id, req, "answered", note, { terminal, label: chosen.label, after: r.after ?? null, reject: chosen.reject });
  }

  async herdrInfo(): Promise<HerdrInfo> {
    const fallback: HerdrInfo = { installed: false, running: false, version: null, protocol: null, compatible: false, warning: null };
    if (!this.herdr) return fallback;
    return this.herdr.info().catch((e: Error) => ({ ...fallback, warning: e.message }));
  }

  async herdrAgents(): Promise<LiveAgent[]> {
    if (!this.herdr) return [];
    const members = this.store.listAllMembers();
    const adopted = new Set(members.map((m) => m.paneId));
    // 잠든 직원의 세션을 대표가 터미널에서 연 칸은 이미 있는 직원이다. 다른 직원으로 받으면 깨울 때 한 칸에 둘이 묶인다.
    const sessions = new Set(members.map((m) => m.sessionId).filter(Boolean));
    return (await this.herdr.agents()).map((a) => ({ ...a, adopted: a.adopted || adopted.has(a.paneId) || (!!a.sessionId && sessions.has(a.sessionId)) }));
  }

  cliCommand(): string {
    return cliCommand();
  }

  /** 편입 전 화면에 보여 줄 것. 읽기만 한다. 경고는 막지 않고, refuse 만 막는다. */
  async adoptPreview(projectId: string, paneId: string): Promise<AdoptPreview> {
    const project = this.store.requireProject(projectId);
    const live = (await this.herdrAgents()).find((a) => a.paneId === paneId);
    if (!live) throw new ApiError(404, "그 칸을 찾을 수 없습니다");
    const seen = await this.herdr?.inspect?.(live).catch(() => null);
    return {
      paneId,
      name: live.name,
      cwd: live.cwd,
      status: live.status,
      sessionId: live.sessionId,
      screen: seen?.screen ?? "",
      refuse: adoptRefusal(live) ?? (seen?.inputEmpty === null ? NO_INPUT_BOX : null),
      warnings: adoptWarnings(project, live, seen ?? null),
    };
  }

  /** 사용자가 화면에서 눌렀을 때만 온다(§6). 규칙은 시스템 프롬프트에 없으므로 첫 지시로 보낸다. */
  async adopt(projectId: string, req: AdoptReq): Promise<Member> {
    const project = this.store.requireProject(projectId);
    this.requireActive(project);
    const live = (await this.herdrAgents()).find((a) => a.paneId === req.paneId);
    if (!live) throw new ApiError(404, "그 칸을 찾을 수 없습니다");
    if (this.store.getMemberByPane(req.paneId)) throw new ApiError(409, "이미 등록된 칸입니다");
    const sameSession = live.sessionId ? this.store.getMemberBySession(live.sessionId) : null;
    if (sameSession) throw new ApiError(409, `이 세션은 이미 ${sameSession.name} 자리입니다. 그 직원을 깨우거나 터미널 칸을 닫으세요`);
    // 실행기는 claude 세션만 다룰 수 있다. 일하는 중·승인 창 앞이면 규칙이 턴 중간에 끼어들고, 쓰던 턴의 마지막 글이 보고로 나간다.
    const refusal = adoptRefusal(live);
    if (refusal) throw new ApiError(409, refusal);
    if ((await this.herdr?.inspect?.(live).catch(() => null))?.inputEmpty === null) throw new ApiError(409, NO_INPUT_BOX);
    const kind = req.kind ?? "worker";
    if (kind === "conductor" && this.store.getConductor(projectId)) throw new ApiError(409, "이미 총괄이 있습니다");
    // 실행 방식은 전체 설정 하나다. 편입은 칸이 있어야 하므로 herdr 일 때만 된다.
    this.requireActive(this.store.requireProject(projectId));
    this.requireNotSwitching();
    if (this.store.getSettings().backend !== "herdr") throw new ApiError(409, "실행 방식이 herdr 일 때만 편입할 수 있습니다. 설정에서 실행 방식을 먼저 바꾸세요");
    const runner = this.runners.get("herdr") as HerdrCapable | undefined;
    if (!runner) throw new ApiError(503, "herdr 실행기가 없습니다");
    const turnedOnRunner = !project.runnerEnabled;
    const herdrProject = project.runnerEnabled ? project : this.store.patchProject(projectId, { runnerEnabled: true });
    if (turnedOnRunner) this.store.setRunnerByAdopt(projectId, true);
    // 가져온 명부에 같은 직원이 있으면(칸 없는 offline) 그 자리를 잇는다. 새로 만들면 이름이 겹쳐 거부된다.
    const placeholder = [req.handle, req.name]
      .map((ref) => (ref ? this.store.findMember(projectId, ref) : null))
      .find((m) => m && m.origin === "adopted" && m.kind === kind && m.status === "offline" && !m.paneId && !m.sessionId);
    const placed = { cli: "claude", status: "idle", backend: "herdr", cwd: live.cwd ?? project.cwd, sessionId: live.sessionId, paneId: req.paneId } as const;
    let member: Member | undefined;
    try {
      member = placeholder
        ? this.store.patchMember(placeholder.id, { name: req.name, role: req.role, ...placed })
        : this.store.createMember({ projectId, handle: req.handle ?? this.deriveHandle(projectId, req.name), name: req.name, role: req.role, kind, origin: "adopted", ...placed });
      this.terminalMutations.add(member.id);
      const moved = await runner.adopt(this.runnerMember(member, herdrProject), req.paneId, this.writeRunFiles(member, herdrProject));
      // 넘겨받은 세션은 대표가 쓰던 그대로 둔다. 무슨 모델로 도는지 모르고, 설정은 잠재웠다 깨울 때 전체 인자로 들어간다.
      this.applyStarted(member.id, herdrProject, { ...moved, rejoined: true });
    } catch (e: unknown) {
      if (member) {
        if (placeholder) this.store.patchMember(member.id, { status: "offline", sessionId: null, paneId: null, backend: null });
        else this.store.removeMember(member.id);
      }
      // 거부된 편입이 실행을 켠 채 남기면 다음 대표 말에 총괄이 뜬다.
      if (turnedOnRunner) {
        this.store.patchProject(projectId, { runnerEnabled: false });
        this.store.setRunnerByAdopt(projectId, false);
      }
      if (e instanceof ApiError) throw e;
      if (e instanceof HerdrError && e.code === "cannot_adopt") throw new ApiError(409, e.message);
      throw new ApiError(502, `칸을 넘겨받지 못했습니다: ${(e as Error).message}`);
    } finally { if (member) this.terminalMutations.delete(member.id); }
    this.store.setAdoptedInfo(member.id, { turnedOnRunner });
    const conductorName = this.store.getConductor(projectId)?.name ?? "총괄";
    await this.deliver({
      projectId,
      memberId: member.id,
      kind: "system",
      text: formatSystem(`지금부터 이 세션은 '${project.name}'의 ${conductorName} 지휘를 받습니다. 아래 규칙을 이 대화 끝까지 따르세요. 단, 이 세션에는 iamceo 도구(post·ask·status·file·todo)가 연결되어 있지 않으니 찾지 말고, 보고와 질문은 턴 마지막 글로 하세요. 서버가 그 글을 총괄에게 전합니다. 이 세션의 CLAUDE.md·메모리 규칙과 아래 규칙이 부딪히면 임의로 고르지 말고 턴 마지막 글로 알리세요.\n\n${this.rulesFor(member, project)}`),
    });
    return this.store.requireMember(member.id);
  }

  /**
   * 편입 해제: 대화와 세션은 그대로 두고 관리에서 뺀다. 되돌릴 수 있어야 하므로 다시 편입할 수 있다.
   * 대표의 칸이면 칸을 그대로 두고 규칙이 풀렸다고 알린다. 다시 열어 서버 칸에 있으면 그 칸을 닫고 이어 열 명령을 돌려준다.
   */
  async releaseMember(memberId: string): Promise<ReleaseResult> {
    const member = this.store.requireMember(memberId);
    if (!member.wasAdopted || member.kind !== "worker") throw new ApiError(400, "편입한 직원만 해제할 수 있습니다");
    const project = this.store.requireProject(member.projectId);
    this.requireActive(project);
    let notified = false;
    const paneKept = member.origin === "adopted";
    // 칸에 알리는 동안 전달과 화면 조회가 칸을 다시 묶거나 알림과 겹치지 않게 먼저 막는다.
    this.runtime(memberId).closing = true;
    let dropped: string[];
    try {
      if (paneKept) notified = (await this.releasePane(member, project)).notified;
      this.runtime(memberId).closing = false;
      dropped = await this.closeMember(memberId, { paneDone: paneKept });
    } finally { this.runtime(memberId).closing = false; }
    // 편입이 켠 실행이고 남은 세션이 없으면 편입 전으로 돌린다. 칸도 세션도 없는 명부 행은 세션이 아니다.
    if (this.store.runnerByAdopt(project.id) && !this.store.listMembers(project.id).some((m) => m.origin !== "manual" && (m.kind === "conductor" || m.sessionId || m.paneId))) {
      this.store.patchProject(project.id, { runnerEnabled: false });
      this.store.setRunnerByAdopt(project.id, false);
    }
    this.memberNotice(member, `${josa(member.name, "을")} 편입 해제했습니다. 세션과 대화 기록은 그대로입니다`);
    const conductor = this.store.getConductor(project.id);
    if (conductor) await this.deliver({ projectId: project.id, memberId: conductor.id, kind: "system", text: formatSystem(`대표가 ${josa(member.name, "을")} 편입 해제했습니다. 이제 지시할 수 없습니다.${dropped.length ? ` 나가지 않은 입력 ${dropped.length}건: ${dropped.join(" / ")}` : ""}`), wake: false });
    const resumeCommand = !paneKept && member.sessionId ? `cd ${shellQuote(member.cwd)} && claude --resume ${shellQuote(member.sessionId)}` : null;
    return { notified, paneKept, resumeCommand };
  }

  private async releasePane(member: Member, project: Project): Promise<{ notified: boolean }> {
    const runner = this.runners.get("herdr") as HerdrCapable | undefined;
    if (!runner?.release) return { notified: false };
    await this.runtime(member.id).pumping; // 이미 나가는 전달이 있으면 끝을 본다. 그 턴 중이면 알리지 않는다.
    const notice = formatSystem("이 세션은 IAMCEO 관리에서 빠졌습니다. 앞서 받은 IAMCEO 운영 규칙은 이제 따르지 않아도 되고 보고도 하지 않아도 됩니다. 이 글에 짧게 알았다고만 답하세요.");
    return runner.release(this.runnerMember(member, project), notice).catch((e) => {
      console.warn(`${member.name} 편입 해제 중 칸에 알리지 못했습니다:`, (e as Error).message);
      return { notified: false };
    });
  }

  /** 넘겨받은 세션에 도구를 붙인다: 칸에서 세션을 끝내고(칸은 셸로 남는다) 전체 인자로 프로젝트 탭에 다시 연다. 기록은 이어진다. */
  async reopenWithTools(memberId: string): Promise<Member> {
    const member = this.store.requireMember(memberId);
    if (member.origin !== "adopted") throw new ApiError(400, "넘겨받은 세션만 다시 열 수 있습니다");
    this.requireActive(this.store.requireProject(member.projectId));
    if (member.status === "working" || member.status === "blocked" || this.isBusy(member)) throw new ApiError(409, `${josa(member.name, "은")} 일하는 중입니다. 턴이 끝난 뒤 다시 시도하세요`);
    if (member.status !== "asleep" && member.status !== "offline") await this.sleepMember(memberId, { force: true });
    return this.resumeMember(memberId);
  }

  async listAgentTools(member: Member): Promise<AgentToolDef[]> {
    return (await this.tools()).listAgentTools(member, { memory: this.memoryEnabledFor(member) });
  }

  // ---- 개발 기억 ----
  memoryEnabledFor(member: Member): boolean {
    return !!this.devMemory?.enabledFor(member.projectId) && member.origin !== "manual";
  }

  requireMemory(member: Member): DevMemory {
    if (!this.devMemory || !this.memoryEnabledFor(member)) throw new ApiError(400, "이 프로젝트는 개발 기억 연결이 켜져 있지 않습니다");
    return this.devMemory;
  }

  /** 기억 범위의 작업: 직원이 밝힌 task_id 만 쓴다(없으면 직원별 전체 범위). 검색·조회는 프로젝트 범위라 글 귀속 규칙과 따로 둔다. */
  memoryScope(member: Member, taskId?: string | null): string {
    return memoryTaskId(taskId ? this.requireTaskInProject(member, taskId).id : null, member.id);
  }

  /**
   * 일 시작 전 기억 검색. 대표 글·총괄의 위임처럼 새 일을 여는 전달에만 한 번 찾는다(결재 답·할 일 알림·보고·시스템 글은 같은 일의 후속이라 찾지 않는다).
   * 같은 직원이 10분 안에 같은 검색어로 찾았으면 그 결과를 다시 쓴다. 검색은 한 번, 6초까지만 기다리고 다시 시도하지 않는다.
   * 결과 없음과 실패를 다른 글로 넣는다. 실패를 '검색 완료'로 적지 않는다.
   */
  private async attachMemoryContext(member: Member, pending: Delivery[]): Promise<void> {
    const memory = this.devMemory;
    if (!memory || !this.memoryEnabledFor(member)) return;
    try {
      const triggers = pending.filter((d) => d.wake && d.attempts === 0 && MEMORY_SEARCH_KINDS.has(d.kind) && !this.store.memorySearchedDelivery(d.id));
      if (!triggers.length) return;
      const query = memoryQuery(triggers.map((d) => this.memoryQueryText(d)));
      if (query.length < MEMORY_QUERY_MIN) return; // "응", "진행해" 같은 짧은 답은 앞서 찾은 기억을 그대로 쓴다.
      const taskIds = [...new Set(triggers.map((d) => this.store.deliveryTaskId(d.id)))];
      const taskId = taskIds.length === 1 ? taskIds[0]! : null;
      const queryHash = createHash("sha256").update(query).digest("hex").slice(0, 32);
      const deliveryIds = triggers.map((d) => d.id);
      const notice = (block: string): NewDelivery => ({ projectId: member.projectId, memberId: member.id, kind: "system", text: formatSystem(block), wake: false, ...(taskId ? { taskId } : {}) });
      const reused = this.store.recentMemorySearch(member.projectId, member.id, queryHash, new Date(Date.now() - MEMORY_REUSE_MS).toISOString());
      if (reused?.block) {
        const block = `${reused.block}\n(10분 안에 같은 검색어로 찾은 결과를 다시 씀 · 검색 #${reused.id})`;
        this.store.recordMemorySearch({ projectId: member.projectId, memberId: member.id, taskId, trigger: "delivery", queryHash, status: reused.status, resultIds: reused.resultIds, block, detail: `reused:${reused.id}` }, { deliveryIds, notice: notice(block) });
        return;
      }
      let status: "ok" | "empty" | "error";
      let resultIds: string[] = [];
      let block: string;
      let detail: string | null = null;
      try {
        const scope = this.memoryScope(member, taskId);
        const result = await memory.context(member.projectId, scope, query, MEMORY_AUTO_LIMIT, MEMORY_SEARCH_TIMEOUT_MS);
        const found = result.experiences.slice(0, MEMORY_AUTO_LIMIT);
        resultIds = found.map((e) => e.id);
        status = found.length ? "ok" : "empty";
        block = formatMemoryContext(found, result.semantic_index ?? null);
        detail = result.semantic_index ? `semantic_index=${result.semantic_index}` : null;
      } catch (e) {
        status = "error";
        detail = (e as Error).message.slice(0, 300);
        block = formatMemoryFailure(detail);
      }
      if (!this.store.getMember(member.id)) return;
      this.store.recordMemorySearch({ projectId: member.projectId, memberId: member.id, taskId, trigger: "delivery", queryHash, status, resultIds, block, detail }, { deliveryIds, notice: notice(block) });
    } catch (e) {
      // 기억 붙이기가 일을 막지는 않는다.
      console.warn("일 시작 전 기억 검색을 붙이지 못했습니다:", (e as Error).message);
    }
  }

  /** 검색어로 쓸 글. 대표 글은 원문, 위임은 총괄이 쓴 할 일과 실린 대표 원문이다. 서버 표지·작업 줄은 뺀다. */
  private memoryQueryText(d: Delivery): string {
    if (d.kind === "user_message" && d.refType === "message" && d.refId) {
      const message = this.store.getMessage(d.refId);
      if (message) return message.body;
    }
    return d.text.split("\n")
      .filter((line) => !/^#\S+$/.test(line.trim()) && !/^작업[: #]/.test(line) && !/^\[총괄\] /.test(line) && !/^첨부:/.test(line))
      .map((line) => line.replace(/^(할 일|사용자 요청\([^)]*\)|총괄 인용\([^)]*\)|대표 글 전문 #\S+): ?/, "").replace(/^> ?/, ""))
      .join("\n");
  }

  /** 직원이 memory_search 도구로 찾은 것도 남긴다(일 시작 전 검색과 같은 기준으로 결과 없음·실패를 나눈다). */
  noteToolMemorySearch(member: Member, taskId: string | null, query: string, outcome: { ids: string[]; error?: string }): void {
    try {
      this.store.recordMemorySearch({ projectId: member.projectId, memberId: member.id, taskId, trigger: "tool", queryHash: createHash("sha256").update(memoryQuery([query])).digest("hex").slice(0, 32),
        status: outcome.error ? "error" : outcome.ids.length ? "ok" : "empty", resultIds: outcome.ids, block: null, detail: outcome.error?.slice(0, 300) ?? null });
    } catch (e) { console.warn("기억 검색 기록 실패:", (e as Error).message); }
  }

  /** 기억에 올릴 글에 그대로 들어 있으면 안 되는 이 서버의 비밀(접속 코드·서비스 키). 밖으로 내지 않는다. */
  memorySecrets(): string[] {
    return [(this.config as Partial<Config>).accessCode ?? "", ...(this.devMemory?.secrets() ?? [])].filter((v) => v.length >= 8);
  }

  /** 결재 답 저장과 기억 대기열 넣기 사이에 서버가 멈춰 빠진 것을 같은 사건 id 로 다시 넣는다(이미 있으면 그대로). */
  reconcileDecisionMemory(): number {
    if (!this.devMemory) return 0;
    let queued = 0;
    for (const project of this.store.listProjects()) {
      if (!this.devMemory.enabledFor(project.id)) continue;
      for (const decision of this.store.answeredDecisionsMissingMemory(project.id)) if (this.queueDecisionMemory(decision, true)) queued++;
    }
    return queued;
  }

  /**
   * 총괄이 대화에서 고른 대표의 결정·제약·수정 이유·피드백을 기억에 남긴다.
   * 원문·말한 사람·시각·작업은 서버가 그 대표 글에서 고정한다. 총괄의 해석은 따로 적는다. 결재 답·직원 글·인용·추론은 받지 않는다.
   * 앞 기록을 바꾸는 것은 supersedes 로 밝힐 때만이다. 한 글에 결정이 둘일 수 있어 서버가 짐작해 대체하지 않는다.
   * 같은 글을 쓴 앞 기록이 있으면 related 로 알려 총괄이 대체 여부를 정하게 한다. 같은 내용이면 처음 기록을 돌려준다.
   */
  captureOwnerMemory(member: Member, input: OwnerMemoryInput): { capture: MemoryCapture; created: boolean; supersedes: MemoryCapture | null; related: MemoryCapture[] } {
    if (member.kind !== "conductor") throw new ApiError(403, "대화 속 대표 결정은 총괄만 고릅니다");
    const memory = this.requireMemory(member);
    const project = this.store.requireProject(member.projectId);
    const ids = [...new Set(input.messageIds.map((id) => id.replace(/^#/, "").trim()))].sort();
    const messages = ids.map((id) => {
      const message = this.store.getMessage(id);
      if (!message || message.projectId !== project.id) throw new ApiError(404, `이 프로젝트의 글이 아닙니다: ${id}`);
      if (!message.mine) throw new ApiError(400, `대표가 쓴 글이 아닙니다(${message.who}). 직원 보고·총괄 글·인용은 대표 결정으로 올리지 않습니다: ${id}`);
      if (message.decisionId) throw new ApiError(400, `결재 카드 답은 서버가 이미 기억에 올립니다. 따로 남기지 않습니다: ${id}`);
      return message;
    }).sort((a, b) => a.at.localeCompare(b.at));
    const own = messages.map((m) => ({ m, text: ownText(m.body) }));
    for (const { m, text } of own) if (!text) throw new ApiError(400, `이 글은 인용(> 줄)뿐이라 대표의 말이 없습니다: ${m.id}`);
    const tasks = [...new Set(messages.map((m) => m.taskId ?? null))];
    if (tasks.length > 1) throw new ApiError(400, "작업이 다른 글은 한 기록으로 묶지 않습니다. 작업마다 따로 남기세요");
    const taskId = tasks[0] ?? null;
    if (input.standing) {
      const quote = normalizeSpace(input.standingQuote ?? "");
      if (!quote || !own.some(({ text }) => normalizeSpace(text).includes(quote))) throw new ApiError(400, "공통 기준(standing)은 대표가 '앞으로·언제나'처럼 직접 말한 문장(standing_quote)이 그 글에 그대로 있어야 합니다. 없으면 이번 일에 한한 기록으로 남기세요");
    }
    const reasonQuote = input.reasonQuote ? normalizeSpace(input.reasonQuote) : null;
    if (reasonQuote && !own.some(({ text }) => normalizeSpace(text).includes(reasonQuote))) throw new ApiError(400, "reason_quote 는 대표 글에 그대로 있는 문장이어야 합니다. 이유를 짐작했으면 interpretation 에 적으세요");
    const fileRefs = (input.fileIds ?? []).map((id) => {
      const file = this.store.getFile(id);
      if (!file || file.projectId !== project.id) throw new ApiError(404, `이 프로젝트의 자료가 아닙니다: ${id}`);
      return { fileId: file.id, title: file.title, version: fileVersion(file) };
    });
    const sensitive = findSensitive([...own.map(({ text }) => text), input.interpretation].join("\n"), this.memorySecrets());
    if (sensitive) throw new ApiError(400, `민감 정보(${sensitive})로 보이는 글이라 기억에 올리지 않았습니다. 그 부분을 빼고 해석만 남기거나 대표에게 확인하세요`);
    const captures = this.store.listMemoryCaptures(project.id);
    const replaced = new Map(captures.filter((c) => c.supersedesId).map((c) => [c.supersedesId!, c.id]));
    const previousId = input.supersedes?.replace(/^#/, "").trim() || null;
    const previous = previousId ? captures.find((c) => c.id === previousId) ?? null : null;
    if (previousId && !previous) throw new ApiError(404, `대체할 기록이 이 프로젝트에 없습니다: ${previousId}`);
    if (previous && replaced.has(previous.id)) throw new ApiError(409, `#${previous.id} 는 이미 #${replaced.get(previous.id)} 로 대체되었습니다. 최신 기록을 supersedes 에 넣으세요`);
    const task = taskId ? this.store.getTask(taskId) : null;
    const scopeLabel = input.scope === "task" ? (task ? `이 작업(${task.title}, #${task.id})에서만` : "이 일에서만(작업 없음)") : input.scope === "artifact" ? `이 자료${fileRefs.length ? `(${fileRefs.map((f) => `${f.title} ${f.version}`).join(", ")})` : ""}에만` : "이 프로젝트에서";
    const typeLabel = { decision: "대표 결정", constraint: "대표가 정한 제약", correction: "대표의 수정(이유 포함)", feedback: "대표 피드백" }[input.type];
    const lines = [
      `분류: ${typeLabel} — 대표가 IAMCEO 대화에 직접 쓴 글을 총괄이 골랐다. 대표 원문은 아래 '대표 원문'뿐이고, '총괄 해석'은 대표의 말이 아니다.`,
      `IAMCEO 프로젝트: ${project.name} (${project.id})`,
      `작업: ${task ? `${task.title} (#${task.id}${task.branch ? ` · ${task.branch}` : ""})` : "전체(작업 없음)"}`,
      `적용 범위: ${scopeLabel}. ${input.standing ? "대표가 공통 기준으로 말했다." : "이번 일의 선택이며 공통 성향으로 넓히지 않는다."} 지금 대표 지시·승인이 이 기록보다 앞선다.`,
      ...(fileRefs.length ? [`관련 자료(그때 판): ${fileRefs.map((f) => `${f.title} #${f.fileId} ${f.version}`).join(" · ")}`] : []),
      "",
      "대표 원문:",
      ...own.map(({ m, text }) => `- ${m.at} 대표(#${m.id}): "${text}"`),
      ...(input.standing ? ["", `공통 기준으로 말한 문장(대표 원문): "${normalizeSpace(input.standingQuote!)}"`] : []),
      ...(reasonQuote ? ["", `대표가 말한 이유(원문): "${reasonQuote}"`] : []),
      "",
      `총괄 해석(${member.name}, 대표 원문 아님):`,
      input.interpretation.trim(),
      ...(previous ? ["", `대체: 앞 기록 #${previous.id}(${previous.createdAt})을 이 기록으로 바꾼다.`] : []),
    ];
    const { content, capture } = clip(lines.join("\n"));
    const eventId = stableEventId("iamceo-owner", project.id, ids.join(","), input.type, input.scope, input.standing ? "standing" : "", input.interpretation.trim(), reasonQuote ?? "", fileRefs.map((f) => `${f.fileId}@${f.version}`).join(","));
    const summaryText = normalizeSpace(own.map(({ text }) => text).join(" / "));
    const experience: ExperienceInput = {
      event_id: eventId,
      kind: input.type === "correction" || input.type === "feedback" ? "lesson" : "decision",
      summary: `${typeLabel}: ${summaryText}`.slice(0, 300),
      content,
      capture,
      source: { task_id: memoryTaskId(taskId, member.id), item_id: ids[0]!, service: "iamceo" },
      evidence: [
        { kind: "classification", text: "explicit_user_statement" },
        { kind: "owner_type", text: input.type },
        { kind: "iamceo_ref", text: `project_id=${project.id}; message_ids=${ids.join(",")}; task_id=${taskId ?? "none"}; spoken_at=${messages.map((m) => m.at).join(",")}; scope=${input.scope}; standing=${input.standing ? "yes" : "no"}; captured_by=${member.id}` },
        ...fileRefs.map((f) => ({ kind: "iamceo_file", text: `${f.fileId}@${f.version}` })),
      ],
    };
    const saved = this.store.saveMemoryCapture(
      { projectId: project.id, eventId, type: input.type, scope: input.scope, standing: !!input.standing, messageIds: ids, taskId, interpretation: input.interpretation.trim(), fileRefs, supersedesId: previous && previous.eventId !== eventId ? previous.id : null, capturedBy: member.id },
      { body: JSON.stringify(experience), supersedesEventId: previous && previous.eventId !== eventId ? previous.eventId : null },
    );
    if (saved.created) void memory.flush(this.store).catch((e) => console.warn("개발 기억 업로드 실패:", (e as Error).message));
    const related = previous ? [] : captures.filter((c) => c.id !== saved.capture.id && !replaced.has(c.id) && c.messageIds.some((id) => ids.includes(id)));
    return { ...saved, supersedes: saved.capture.supersedesId ? this.store.getMemoryCapture(saved.capture.supersedesId) : null, related };
  }

  /**
   * 대표가 결재 카드에 답하면 그 결정을 개발 기억에 올린다. 직원이 쓴 배경은 대표 결정과 구분해 적는다.
   * 같은 카드의 같은 답은 한 번만 올라간다(event_id 고정). 다시 열린 뒤 다른 답이면 새 사건이다.
   * reconcile: 이미 전달된(delivered) 답도 받는다(빠진 것 메우기). 새로 넣었으면 true.
   */
  private queueDecisionMemory(decision: Decision, reconcile = false): boolean {
    const memory = this.devMemory;
    if (!memory?.enabledFor(decision.projectId) || !(decision.status === "answered" || (reconcile && decision.status === "delivered"))) return false;
    try {
      const project = this.store.requireProject(decision.projectId);
      const task = decision.taskId ? this.store.getTask(decision.taskId) : null;
      const option = decision.options.find((o) => o.k === decision.choice);
      const answer = option ? `"${option.label}"${option.desc ? ` (${option.desc})` : ""}` : "(선택지 없이 메모로 답함)";
      const lines = [
        `분류: 대표 명시 결정 — 대표가 IAMCEO 결재 카드에 직접 답했다${decision.batch ? "(묶음 추천을 한꺼번에 승인)" : ""}.`,
        `IAMCEO 프로젝트: ${project.name} (${project.id})`,
        `작업: ${task ? `${task.title} (#${task.id}${task.branch ? ` · ${task.branch}` : ""})` : "전체(작업 없음)"}`,
        `물은 직원: ${decision.who}`,
        `결재 질문: ${decision.title}`,
        `대표 답(원문): ${answer}`,
        ...(decision.note ? [`대표 메모(원문): ${decision.note}`] : []),
        `답한 시각: ${decision.answeredAt ?? ""}`,
        "적용 범위: 이 프로젝트에서 이 질문에 대한 결정이다. 다른 프로젝트·이후 지시보다 앞서지 않는다.",
        "",
        "선택지(직원이 제안한 것):",
        ...decision.options.map((o) => `- ${o.label}${o.desc ? `: ${o.desc}` : ""}${decision.rec === o.k ? " (직원 추천)" : ""}${o.k === decision.choice ? " ← 대표 선택" : ""}`),
        "",
        "배경(직원이 쓴 설명이며 대표 결정이 아니다):",
        decision.detail,
      ];
      // 직원이 쓴 배경·대표 메모에 키 모양이 섞여 있으면 그 부분만 가린다(서버가 스스로 올리는 글이라 되물을 사람이 없다).
      const { content, capture } = clip(redactSensitive(lines.join("\n"), this.memorySecrets()));
      const eventId = stableEventId("iamceo-decision", decision.id, decision.choice ?? "", decision.note ?? "", decision.answeredAt ?? "");
      const experience: ExperienceInput = {
        event_id: eventId,
        kind: "decision",
        summary: `대표 결정: ${decision.title}`.slice(0, 300),
        content,
        capture,
        source: { task_id: memoryTaskId(decision.taskId ?? null, decision.memberId ?? "rep"), item_id: decision.id, service: "iamceo" },
        evidence: [
          { kind: "classification", text: "explicit_user_decision" },
          { kind: "iamceo_ref", text: `project_id=${project.id}; decision_id=${decision.id}; task_id=${decision.taskId ?? "none"}; answered_at=${decision.answeredAt ?? ""}` },
        ],
      };
      const queued = this.store.enqueueMemoryUpload({ eventId, projectId: decision.projectId, refType: "decision", refId: decision.id, body: JSON.stringify(experience) });
      if (queued) void memory.flush(this.store).catch((e) => console.warn("개발 기억 업로드 실패:", (e as Error).message));
      return queued;
    } catch (e) {
      console.warn("개발 기억 업로드를 준비하지 못했습니다:", e instanceof MemoryError ? e.message : (e as Error).message);
      return false;
    }
  }

  async handleAgentTool(member: Member, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<AgentToolResult> {
    const closes = REPORT_CLOSING_TOOLS.has(name);
    if (closes) this.inflightReportTools.set(member.id, (this.inflightReportTools.get(member.id) ?? 0) + 1);
    try {
      return await this.runAgentTool(member, name, args, signal);
    } finally {
      if (closes) {
        const left = (this.inflightReportTools.get(member.id) ?? 1) - 1;
        if (left > 0) this.inflightReportTools.set(member.id, left);
        else this.inflightReportTools.delete(member.id);
        this.runDeferredReportChecks(member.id);
      }
    }
  }

  private async runAgentTool(member: Member, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<AgentToolResult> {
    const tools = await this.tools();
    const boardRevision = name === "board" ? this.store.boardRevision(member.projectId) : null;
    const result = await tools.handleAgentTool(this, member, name, args, signal);
    if (!result.isError) {
      if (boardRevision !== null) this.noteBoardReview(member, boardRevision);
      if (["team_assign", "team_add", "team_resume"].includes(name) && this.runtime(member.id).turn) {
        this.runtime(member.id).delegated = true;
        for (const run of this.store.listPendingExecutions().filter(run => run.memberId === member.id)) this.store.saveExecutionJournal({ ...run, reason: "awaiting_delegation", updatedAt: new Date().toISOString() });
      }
    }
    return result;
  }

  /** 영속 예약을 먼저 커밋한다. 프로세스가 죽으면 미확인 결과를 반환하며 효과를 재생하지 않는다. */
  async handleAgentOperation(member: Member, name: string, args: Record<string, unknown>, context: AgentOperationContext, signal?: AbortSignal): Promise<AgentToolResult> {
    const current = this.store.requireMember(member.id);
    if (current.projectId !== member.projectId) throw new ApiError(404, "직원을 찾을 수 없습니다");
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(context.operationId)) throw new ApiError(400, "operationId가 잘못되었습니다");
    const reservation = this.store.reserveAgentOperation(current.id, name, context.operationId, args, UNKNOWN_AGENT_RESULT);
    const running = this.agentOperations.get(context.operationId);
    if (running) return running;
    if (!reservation.created) return reservation.result;
    const execution = this.handleAgentTool(current, name, args, signal).then(result =>
      this.store.completeAgentOperation(current.id, name, context.operationId, args, result),
    ).finally(() => { this.agentOperations.delete(context.operationId); });
    this.agentOperations.set(context.operationId, execution);
    return execution;
  }

  /** Called at the board read boundary; completion only covers the requested revision. */
  noteBoardReview(member: Member, revision = this.store.boardRevision(member.projectId)): void {
    const turn = this.runtime(member.id).turn;
    const runs = this.store.listPendingExecutions().filter(run => run.memberId === member.id);
    const tidy = runs.some(run => run.deliveryIds.some(id => { const delivery = this.store.getDelivery(id); return delivery && isTidy(delivery); }));
    const requestedRevision = turn?.boardReview?.requestedRevision ?? (tidy ? this.store.getBoardReview(member.projectId)?.requestedRevision : undefined);
    if (requestedRevision === undefined) return;
    const reviewedRevision = Math.min(requestedRevision, revision);
    if (turn?.boardReview) turn.boardReview.reviewedRevision = reviewedRevision;
    for (const run of runs) this.store.saveExecutionJournal({ ...run, reason: `board_review:${requestedRevision}:${reviewedRevision}`, updatedAt: new Date().toISOString() });
  }

  private async tools(): Promise<AgentToolsImpl> {
    // agent-tools.ts 가 이 파일의 타입을 쓰므로 정적 import 로 순환시키지 않는다.
    this.agentTools ??= await import("./agent-tools.ts");
    return this.agentTools;
  }

  async askWait(member: Member, decisionId: string, timeoutMs: number, signal?: AbortSignal): Promise<AskWaitResult> {
    const ready = (): AskWaitResult | null => {
      const current = this.store.requireMember(member.id);
      const decision = this.store.requireDecision(decisionId);
      if (decision.projectId !== current.projectId || decision.memberId !== member.id) throw new ApiError(403, "자신이 올린 결재만 기다릴 수 있습니다");
      if (signal?.aborted || this.store.requireProject(member.projectId).archived || this.archiving.has(member.projectId) || decision.status === "open") return null;
      const answered = decision.status === "answered" || decision.status === "delivered";
      if (decision.status === "answered") {
        if (this.store.taskSequenceBlocker(current.id, decision.taskId ?? null)) return null;
        this.materializeManualAnswers(current);
        // An unacknowledged wait batch owns its items. askWait must not consume it.
        if (this.store.manualInbox(member.id, [])?.items.some(item => item.ref?.type === "decision" && item.ref.id === decisionId)) return null;
        const delivery = this.store.listPending(member.id).find(d => d.refType === "decision" && d.refId === decisionId);
        if (delivery) {
          const batch = this.store.manualInbox(member.id, [delivery.id]);
          if (!batch?.items.some(item => item.deliveryId === delivery.id)) return null;
          this.store.acknowledgeManualInbox(member.id, batch.id);
        } else this.store.setDecisionStatus(decisionId, "delivered");
      }
      const text = answered ? formatAnswer(decision) : formatSystem(`결재가 닫혔습니다${decision.closeReason ? `: ${normalizeSpace(decision.closeReason)}` : ""}. 이 질문의 답은 오지 않습니다 #${decision.id}`);
      this.settle(current);
      return { done: true, text, decision: this.store.requireDecision(decisionId) };
    };
    if (signal?.aborted) return { done: false };
    const now = ready();
    if (now) return now;
    await this.waitOn(this.askWaiters, decisionId, Math.min(Math.max(timeoutMs, 0), 50_000), signal);
    return ready() ?? { done: false };
  }

  // ---- 팀 ----
  /** 총괄·본사 AI 를 찾거나 만든다. 본사는 root. */
  async ensureConductor(projectId: string): Promise<Member> {
    this.requireActive(this.store.requireProject(projectId));
    const existing = this.store.getConductor(projectId);
    if (existing) {
      // 다른 요청이 띄우는 중이면 함께 기다린다.
      await this.runtime(existing.id).starting;
      return this.store.getConductor(projectId) ?? this.ensureConductor(projectId);
    }
    const spawn = this.beginConductor(this.store.requireProject(projectId));
    await spawn.ready;
    return this.store.requireMember(spawn.member.id);
  }

  private beginConductor(project: Project): { member: Member; ready: Promise<void> } {
    // 대표가 총괄을 시작했거나 말을 보냈다. 이제 편입만으로 켠 실행이 아니다.
    this.store.setRunnerByAdopt(project.id, false);
    // 예약 이름을 막기 전에 만들어진 명부에 같은 이름·핸들의 직원이 있어도 총괄은 떠야 한다.
    const free = (base: string, sep: string): string => {
      if (!this.store.findMember(project.id, base)) return base;
      for (let n = 2; ; n++) if (!this.store.findMember(project.id, `${base}${sep}${n}`)) return `${base}${sep}${n}`;
    };
    const spawn = this.beginSpawn(project, {
      kind: project.isHq ? "root" : "conductor",
      handle: free(project.isHq ? "root" : conductorHandle(project.name), "-"),
      name: free(project.isHq ? "본사 AI" : conductorName(project.name), " "),
      role: project.isHq ? "프로젝트 만들기와 잡다한 일" : "총괄",
      cli: this.store.chiefCli(project.id),
    });
    if (project.now) {
      this.store.enqueue({ projectId: project.id, memberId: spawn.member.id, kind: "system", text: formatSystem(`지금 상황: ${guardLines(project.now)}`), wake: false });
    }
    return spawn;
  }

  async addMember(projectId: string, input: NewMemberInput, assignedBy?: Member): Promise<{ member: Member; assigned: AssignResult | null }> {
    const project = this.store.requireProject(projectId);
    const cli = input.cli ?? this.store.defaultMemberCli(projectId);
    this.models.requireModel(cli, input.modelOverride);
    if (input.effortOverride != null) {
      if (cli === "antigravity") throw new ApiError(400, "Antigravity 는 effort 를 따로 받지 않습니다. 모델 이름에 들어 있는 값을 고르세요");
      const kind = input.kind ?? "worker";
      const rank = (cli === "codex" ? this.store.getSettings().codexRanks : this.store.getSettings().ranks)[memberRank(kind)];
      this.models.requireEffort(cli, input.modelOverride ?? rank.model, input.effortOverride);
    }
    if (!project.runnerEnabled) throw new ApiError(409, "이 프로젝트는 실행이 꺼져 있습니다");
    const name = input.name.trim();
    if (!name) throw new ApiError(400, "이름이 필요합니다");
    const source = input.userQuote?.trim() ? this.findQuoteSource(projectId, input.userQuote) : null;
    const quote = input.userQuote?.trim() ? { text: input.userQuote, verified: source !== null, source } : null;
    const firstTask = input.firstInstruction ? this.instructionTaskFor(projectId, input.taskId) : null;
    if (input.firstInstruction && assignedBy) this.requireInstructionContract(assignedBy, firstTask?.id ?? null);
    const { value: { member, ready }, deliveries } = this.store.transaction(() => {
      const spawned = this.store.withDeliveryIntents(() => this.beginSpawn(project, {
        kind: input.kind ?? "worker",
        handle: input.handle ?? this.deriveHandle(projectId, name),
        name,
        role: input.role ?? "",
        cli,
        modelOverride: input.modelOverride,
        effortOverride: input.effortOverride,
        cwd: input.cwd ? this.resolveCwd(project, input.cwd) : undefined,
      }), ({ member }) => {
        if (!input.firstInstruction) return [];
        const taskLine = this.instructionTaskLines(projectId, firstTask?.id ?? null);
        return [{ projectId, memberId: member.id, kind: "instruction", text: [formatInstruction(member.name, input.firstInstruction, quote), ...(taskLine ? [taskLine] : [])].join("\n"), taskId: firstTask?.id ?? null }];
      });
      if (assignedBy) for (const delivery of spawned.deliveries) this.store.noteDelegation(assignedBy.id, delivery, false);
      return spawned;
    });
    if (input.parallel) this.runtime(member.id).wantParallel = true;
    await ready;
    await this.pump(member.id);
    const assigned = deliveries[0] ? { delivery: this.store.requireDelivery(deliveries[0].id), position: 0,
      verified: quote?.verified ?? null, needsContext: quote ? quoteNeedsContext(quote) : false } : null;
    this.checkAwakeLimit(projectId);
    return { member: this.store.requireMember(member.id), assigned };
  }

  /** 명부에 올리고 세션을 띄우기 시작한다. 끝나기 전에는 pump 가 건너뛰고, 끝나면 다시 민다. */
  private beginSpawn(project: Project, input: { kind: MemberKind; handle: string; name: string; role: string; cwd?: string; cli?: CliProvider; modelOverride?: string | null; effortOverride?: string | null }): { member: Member; ready: Promise<void> } {
    this.requireActive(this.store.requireProject(project.id));
    this.requireNotSwitching(); // 옮기는 명단에 없는 칸이 옛 실행기에 남는다.
    const member = this.store.createMember({ projectId: project.id, ...input, origin: "runner", status: "idle" });
    if (!project.runnerEnabled) return { member, ready: Promise.resolve() };
    const rt = this.runtime(member.id);
    const intent = this.prepareLifecycle(member, "start");
    // No external start can observe a source transaction that may still roll back.
    const ready = new Promise<void>((resolve, reject) => {
      this.store.afterCommit(() => {
        void (async () => {
          this.openRunner(member);
          const sent = this.desiredConfig(member);
          const started = await this.startManaged(member, project, false, intent);
          this.applyStarted(member.id, project, started, sent);
        })().then(resolve, e => {
          if (this.backendOf(member) !== "core" || (e instanceof CoreError && !e.uncertain && !["starting_unknown", "conflict", "unknown"].includes(e.kind))) this.abandonSpawn(member.id);
          reject(new ApiError(502, `세션을 띄우지 못했습니다: ${(e as Error).message}`));
        });
      });
    });
    rt.starting = ready.then(
      () => {
        rt.starting = null;
        void this.pump(member.id);
      },
      () => {
        rt.starting = null;
      },
    );
    return { member, ready };
  }

  /** 명부에서 빼기 전에 그 직원 앞으로 줄 선 대표의 말을 보류로 남긴다(CASCADE 로 전달 항목이 사라진다). */
  private abandonSpawn(memberId: string): void {
    for (const d of this.store.listPending(memberId)) {
      if (d.refType === "message" && d.refId) this.store.setMessageDelivery(d.refId, "held", HOLD_NOTES.backend_down);
    }
    const rt = this.runtimes.get(memberId);
    if (rt) this.clearRuntime(memberId, rt);
    this.store.removeMember(memberId);
  }

  /** sent 는 start 에 실제로 넘긴 설정이다. 띄우는 동안 바뀐 값을 적으면 옛 값으로 돌면서 맞춘 것으로 기록된다. */
  private applyStarted(memberId: string, project: Project, started: { sessionId: string | null; paneId: string | null; tabId?: string | null; rejoined?: boolean }, sent?: AppliedConfig): void {
    const runner = this.runnerOf(this.store.requireMember(memberId));
    const currentError = runner instanceof CoreRunner ? runner.observationState(memberId)?.lastError : null;
    this.store.patchMember(memberId, { sessionId: started.sessionId, paneId: started.paneId, ...(!currentError ? { lastError: null } : {}) });
    // 이미 떠 있던 칸에 붙었으면 이번 인자가 들어간 것이 아니다.
    if (!started.rejoined && sent) this.store.setAppliedConfig(memberId, sent);
    if (started.tabId && started.tabId !== project.herdrTabId) this.store.patchProject(project.id, { herdrTabId: started.tabId });
  }

  private resolveCwd(project: Project, raw: string): string {
    const path = isAbsolute(raw) ? raw : resolve(project.cwd, raw);
    let isDir = false;
    try {
      isDir = statSync(path).isDirectory();
    } catch {
      // 없는 경로는 아래에서 같은 오류로 처리한다.
    }
    if (!isDir) throw new ApiError(400, `폴더가 없습니다: ${path}`);
    return path;
  }

  private deriveHandle(projectId: string, name: string): string {
    const ascii = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z]+/, "").replace(/-+$/, "").slice(0, 32);
    if (ascii && !RESERVED_HANDLES.has(ascii) && !this.store.getMemberByHandle(projectId, ascii)) return ascii;
    for (let n = 1; ; n++) {
      const handle = `w${n}`;
      if (!this.store.getMemberByHandle(projectId, handle)) return handle;
    }
  }

  private refuseOwnerDirectRepeat(target: Member, quote: VerifiedQuote | null): void {
    if (quote?.verified && quote.source) {
      const message = this.store.getMessage(quote.source.id);
      if (message?.mine && message.targetMemberId === target.id && this.store.listDeliveries(target.projectId).some(d =>
        d.memberId === target.id && d.kind === "user_message" && d.refType === "message" && d.refId === message.id &&
        ["queued", "delivering", "delivered"].includes(d.status))) {
        const reason = `대표가 이미 ${target.name}에게 직접 보낸 지시입니다(#${message.id}). 다시 보내지 마세요. 더할 일이 있으면 인용 없이 그 부분만 쓰세요.`;
        this.store.appendActivity(target.id, "system", reason);
        throw new ApiError(409, reason);
      }
    }
  }

  /** team_assign. member 는 핸들 또는 화면 이름. 다른 프로젝트 직원은 찾지 못한다. */
  async assignWorkflow(projectId: string, taskId: string, request: WorkflowAssignmentRequest): Promise<WorkflowAssignmentResult> {
    this.requireActive(this.store.requireProject(projectId));
    const prior = this.store.workflowAssignmentReceipt(request.operationId);
    const result = commitWorkflowAssignment(this.store, projectId, taskId, request, preview => {
      const member = this.store.requireMember(request.memberId);
      const attachments = preview.attachments.map(a => this.store.getAttachment(a.id)).filter((a): a is Attachment => !!a);
      return attachmentLines(this.attachmentsFor(member, attachments)).join("\n");
    });
    // A repeated confirmation only reads the committed result. It cannot wake or resend a turn.
    if (!prior) await this.pump(result.memberId);
    return result;
  }

  /** Owner-confirmed order exception. Reuse the existing input; retries only read the receipt. */
  async authorizeIndependentDelivery(projectId: string, deliveryId: string, request: IndependentDeliveryRequest): Promise<WorkflowAssignmentResult> {
    this.requireActive(this.store.requireProject(projectId));
    const prior = this.store.workflowAssignmentReceipt(request.operationId);
    const result = commitIndependentDelivery(this.store, projectId, deliveryId, request);
    if (!prior) await this.pump(result.memberId);
    return result;
  }

  async assign(projectId: string, memberRef: string, input: AssignInput, assignedBy?: Member): Promise<AssignResult> {
    const target = this.requireInProject(projectId, memberRef);
    const source = input.userQuote?.trim() ? this.findQuoteSource(projectId, input.userQuote) : null;
    const quote = input.userQuote?.trim() ? { text: input.userQuote, verified: source !== null, source } : null;
    this.refuseOwnerDirectRepeat(target, quote);
    const project = this.store.requireProject(projectId);
    const busy = this.isBusy(target);
    const attachments = (input.attachmentIds ?? []).map((id) => {
      const attachment = this.store.getAttachment(id);
      if (!attachment || !this.store.isProjectAttachment(projectId, id)) throw new ApiError(404, `이 프로젝트에서 대표가 보낸 첨부가 아닙니다: ${id}`);
      return attachment;
    });
    const task = this.instructionTaskFor(projectId, input.taskId);
    if (input.contract && !task) throw new ApiError(400, "계약은 업무에 붙습니다. task_id 를 함께 넣으세요");
    if (assignedBy) this.requireInstructionContract(assignedBy, task?.id ?? null, input.contract);
    // 반복 감시로 멈춘 업무는 총괄이 원인·접근을 바꿨다고 남긴 뒤에만 다시 맡긴다(같은 반복을 자동으로 잇지 않게). 대표 화면의 지시는 막지 않는다.
    const watch = task && assignedBy ? this.store.getTaskWatch(task.id) : null;
    if (watch?.trippedAt) throw new ApiError(409, `반복 감시로 멈춘 업무입니다(${watch.reason ?? "같은 실패 반복"}). 원인·접근을 바꿨으면 task_stage(task_id "${task!.id}", stage "reopen", evidence 바꾼 접근)로 다시 연 뒤 맡기세요`);
    const delivery = this.store.transaction(() => {
      if (input.contract && task) this.store.saveTaskContract(task.id, cleanContract(input.contract), { author: assignedBy?.name ?? "대표 화면", authorMemberId: assignedBy?.id ?? null, authorKind: !assignedBy ? "owner" : assignedBy.kind === "worker" ? "worker" : "conductor", sourceMessageId: quote?.verified ? quote.source?.id ?? null : null });
      const taskLine = this.instructionTaskLines(projectId, task?.id ?? null);
      const delivery = this.store.enqueue({
        projectId,
        memberId: target.id,
        kind: "instruction",
        text: [formatInstruction(target.name, input.text, quote), ...attachmentLines(this.attachmentsFor(target, attachments)), ...(taskLine ? [taskLine] : [])].join("\n"),
        urgent: input.urgent,
        taskId: task?.id ?? null,
      });
      if (assignedBy) this.store.noteDelegation(assignedBy.id, delivery, busy && !input.urgent);
      return delivery;
    });
    // 거절된 지시는 병렬 설정도 바꾸지 않는다.
    if (input.parallel !== undefined) this.runtime(target.id).wantParallel = input.parallel;
    const position = busy ? this.store.listPending(target.id).length : 0;
    await this.pump(target.id);
    return { delivery: this.store.requireDelivery(delivery.id), position, verified: quote?.verified ?? null, needsContext: quote ? quoteNeedsContext(quote) : false };
  }

  /**
   * 인용이 이 프로젝트의 대표 메시지·결재 답에 (공백 정규화 후) 그대로 있으면 그 글. 총괄의 말은 승인이 아니다.
   * 직원에게 전문·시각·카드 제목을 함께 보내 잘린 인용이나 다른 안건의 답으로 뜻이 뒤집히지 않게 한다.
   */
  findQuoteSource(projectId: string, rawQuote: string): QuoteSource | null {
    const quote = normalizeSpace(rawQuote).replace(/^["'“”‘’](.*)["'“”‘’]$/, "$1").trim();
    if (!quote) return null;
    // "네" 같은 짧은 인용은 다른 글의 일부로 우연히 맞는다. 글 전체가 같아야 한다.
    const matches = (source: string): boolean => {
      const text = normalizeSpace(source);
      return quote.length < SHORT_QUOTE ? text === quote : includesWhole(text, quote);
    };
    for (const d of this.store.listAllDoneDecisions(projectId)) {
      const option = d.options.find((o) => o.k === d.choice);
      // 버튼 글은 대표가 보고 누른 그대로만 친다. 설명·버튼 글의 일부는 직원이 쓴 글이라 대표의 말이 아니다.
      if (option && normalizeSpace(option.label) === quote) return { id: d.id, text: option.label, at: d.answeredAt, card: d.title };
      if (d.note && matches(d.note)) return { id: d.id, text: d.note, at: d.answeredAt };
    }
    const project = this.store.requireProject(projectId);
    if (project.creationGoal && matches(project.creationGoal)) return { id: project.id, text: project.creationGoal, at: project.createdAt };
    let before: string | undefined;
    for (let page = 0; page < QUOTE_SCAN_PAGES; page++) {
      const messages = this.store.listMessages(projectId, { before, limit: 500 });
      const found = [...messages].reverse().find((m) => m.mine && matches(m.body));
      if (found) return { id: found.id, text: found.body, at: found.at };
      if (messages.length < 500) return null;
      before = messages[0]!.at;
    }
    return null;
  }

  /** team_compact·화면 압축. 실행 중이어도 안전 조건을 우회하지 않고 예약한다. */
  async compactMember(memberId: string, focus?: string): Promise<Member> {
    const member = this.store.requireMember(memberId);
    if (member.origin === "manual") throw new ApiError(400, "직접 띄운 세션은 압축할 수 없습니다");
    const project = this.store.requireProject(member.projectId);
    this.requireActive(project);
    if (!project.runnerEnabled || ["asleep", "offline"].includes(member.status)) throw new ApiError(409, "깨어 있고 실행이 켜진 직원만 압축할 수 있습니다");
    if (!member.sessionId) throw new ApiError(this.backendOf(member) === "core" ? 409 : 400, "아직 native 세션을 확인하지 못했습니다");
    const normalized = (focus ? normalizeSpace(focus) : "") || this.compactFocus(member);
    if (this.backendOf(member) === "core") {
      if (!member.paneId) throw new ApiError(409, "세션 터미널이 없습니다");
      if (this.runnerOf(member) instanceof CoreRunner && !this.contextLog(member)) throw new ApiError(409, "압축 완료를 관찰할 native 세션 기록이 없습니다");
      this.coreCompactFenced(member); // 손상된 영속 상태도 새 예약으로 덮지 않는다.
      const state = this.store.ensureContextState(memberId);
      if (state.compaction && ["queued", "sending", "running", "uncertain"].includes(state.compaction.phase)) return this.store.requireMember(memberId);
      const generation = this.store.memberRevisions(memberId).sessionGeneration;
      const available = await this.runnerOf(member).available();
      this.requireActive(this.store.requireProject(project.id));
      if (!available.ok) throw new ApiError(409, "실행기에 연결할 수 없습니다");
      const current = this.store.requireMember(memberId);
      if (this.store.memberRevisions(memberId).sessionGeneration !== generation || current.sessionId !== member.sessionId || current.paneId !== member.paneId || ["asleep", "offline"].includes(current.status)) throw new ApiError(409, "압축을 예약하는 동안 세션이 변경되었습니다");
      this.queueCoreCompact(this.store.requireMember(memberId), "manual", normalized);
    } else this.runtime(memberId).compactRequest = normalized;
    await this.pump(memberId);
    return this.store.requireMember(memberId);
  }

  private queueCoreCompact(member: Member, trigger: "manual" | "auto", focus: string): void {
    const state = this.store.ensureContextState(member.id);
    if (state.compaction && ["queued", "sending", "running", "uncertain"].includes(state.compaction.phase)) return;
    this.store.saveContextState({ ...state, baseline: { ...state.baseline, focus,
      ...(trigger === "auto" ? { autoTurn: state.measurement?.turn } : {}) },
      compaction: { id: randomUUID(), trigger, phase: "queued", reason: member.status === "working" ? "working" : member.status === "blocked" ? "blocked" : null,
        requestedAt: new Date().toISOString(), startedAt: null, finishedAt: null } });
    this.runtime(member.id).compactRequest = focus;
  }

  private contextLog(member: Member, observation?: LogSelectionObservation): { path: string; home: string } | null {
    if (!this.providerHomes || !member.sessionId) { if (observation) observation.code = !this.providerHomes ? "provider_homes_missing" : "session_missing"; return null; }
    if (member.cli === "antigravity") {
      if (!this.providerHomes.antigravityRoot) return null;
      const home = antigravityMemberHome(this.providerHomes.antigravityRoot, member.id);
      const path = existingAntigravityTranscript(home, member.sessionId);
      return path ? { path, home } : null;
    }
    const home = member.cli === "codex" ? this.providerHomes.codexHome : this.providerHomes.claudeHome;
    if (member.cli !== "codex") {
      const path = findSessionFile(home, member.cwd, member.sessionId);
      if (observation) { observation.code = path ? "selected" : "no_matching_session"; observation.sessionMatch = !!path; observation.matchingFiles = path ? 1 : 0; }
      return path ? { path, home } : null;
    }
    const root = join(home, "sessions");
    try {
      const paths = [...new Bun.Glob("**/rollout-*.jsonl").scanSync({ cwd: root, absolute: true, onlyFiles: true, followSymlinks: false })].filter(path => {
        const meta = parseCodexSessionMeta(readJsonlRange(root, path, null, { maxBytes: 1024 * 1024, maxRecords: 1 }).records[0]?.value);
        if (observation && meta?.sessionId === member.sessionId) { observation.sessionMatch = true; if (meta.cwd === member.cwd) observation.cwdMatch = true; else observation.cwdMatch ??= false; }
        return meta?.sessionId === member.sessionId && meta.cwd === member.cwd;
      });
      if (observation) { observation.matchingFiles = paths.length; observation.code = paths.length === 1 ? "selected" : paths.length > 1 ? "ambiguous" : observation.sessionMatch ? "cwd_mismatch" : "no_matching_session"; observation.sessionMatch ??= false; }
      return paths.length === 1 ? { path: paths[0]!, home } : null;
    } catch (e) { if (observation) observation.code = (e as NodeJS.ErrnoException).code === "ENOENT" ? "no_matching_session" : "lookup_failed"; return null; }
  }

  private invalidateCoreMeasurement(member: Member): void {
    if (this.backendOf(member) !== "core") return;
    const state = this.store.getContextState(member.id);
    if (state?.measurement?.fresh) this.store.saveContextState({ ...state, measurement: { ...state.measurement, fresh: false } });
  }

  private deferCoreCompact(member: Member, reason: "manual_control" | "working" | "blocked" | "backend_down"): void {
    if (this.backendOf(member) !== "core") return;
    const state = this.store.getContextState(member.id);
    if (state?.compaction?.phase === "queued" && state.compaction.reason !== reason) this.store.saveContextState({ ...state, compaction: { ...state.compaction, reason } });
  }

  private interruptCoreCompaction(member: Member): void {
    if (this.backendOf(member) !== "core") return;
    const state = this.store.getContextState(member.id);
    if (!state?.compaction || ["succeeded", "failed"].includes(state.compaction.phase)) return;
    const saved = state.baseline?.coreCompact as CoreCompactState | undefined;
    this.store.saveContextState({ ...state, measurement: state.measurement ? { ...state.measurement, fresh: false } : null,
      baseline: { ...state.baseline, ...(saved?.id === state.compaction.id ? { coreCompact: { ...saved, phase: "failed" } } : {}) },
      compaction: { ...state.compaction, phase: "failed", reason: "interrupted", finishedAt: new Date().toISOString() } });
    this.runtime(member.id).compactRequest = null;
    this.runtime(member.id).skipCompact = true;
  }

  private coreCompactFenced(member: Member): boolean {
    if (this.backendOf(member) !== "core") return false;
    const compact = this.store.getContextState(member.id)?.compaction;
    if (compact && !["queued", "sending", "running", "uncertain", "succeeded", "failed"].includes(compact.phase)) throw new ApiError(409, "압축 상태를 읽을 수 없어 자동 입력을 보류합니다");
    return !!compact && ["sending", "running", "uncertain"].includes(compact.phase);
  }

  /** 실패/불확실도 Runner가 저장한 결과만 반영한다. idle이나 ACK는 완료 근거가 아니다. */
  private reconcileCoreCompact(member: Member): void {
    if (this.backendOf(member) !== "core") return;
    const state = this.store.getContextState(member.id);
    const rt = this.runtime(member.id);
    if (state?.compaction?.phase === "queued") rt.compactRequest ??= (state.baseline?.focus as string | undefined) ?? this.compactFocus(member);
    if (state?.compaction?.phase === "failed" && rt.turn?.kind === "compact") this.endCompact(member.id, rt, "제공자가 압축 종료/실패를 확인했습니다");
  }

  private compactFocus(member: Member): string {
    const questions = this.store.listOpenDecisionsByMember(member.id).map((d) => normalizeSpace(d.title));
    const queue = this.store.listPending(member.id).slice(0, 3).map((d) => normalizeSpace(d.text).slice(0, 80));
    const board =
      member.kind === "worker"
        ? ""
        : this.store
            .listWork(member.projectId)
            .filter((w) => w.sec !== "done")
            .slice(0, 12)
            .map((w) => `${w.id} ${w.sec} ${normalizeSpace(w.title).slice(0, 40)}`)
            .join(", ");
    const parts = [normalizeSpace(member.now), normalizeSpace(member.next), questions.length ? `대기 질문: ${questions.join(", ")}` : "", queue.length ? `대기열 앞부분: ${queue.join(" / ")}` : "", board ? `일 항목: ${board}` : ""].filter(Boolean);
    return `이어갈 일: ${parts.join(" · ") || "대표의 말과 결정, 지금까지 한 일을 빠짐없이 남긴다"}`;
  }

  /** 일하는 중·열린 결재·대기열이 있으면 거부(force 로만). sessionId 는 유지한다. */
  async sleepMember(memberId: string, opts: { force?: boolean; holdAs?: "archived" } = {}): Promise<Member> {
    const member = this.store.requireMember(memberId);
    if (member.status === "asleep" && !this.pendingLifecycle(memberId)) return member;
    if (member.origin === "manual") throw new ApiError(400, "직접 띄운 세션은 잠재울 수 없습니다");
    const project = this.store.requireProject(member.projectId);
    if (!opts.holdAs) this.requireActive(project);
    const rt = this.runtime(memberId);
    const pending = this.store.listPending(memberId);
    if (!opts.force) {
      if (this.store.inputState(memberId).lease) throw new ApiError(409, "직접 조작권이 남아 있어 잠재울 수 없습니다. 조작을 끝내고 조작권을 놓아 주세요");
      if (this.deliveryRecovery.fenced(memberId)) throw new ApiError(409, "전달 결과가 확인되지 않은 입력이 있어 잠재울 수 없습니다. 전달 확인을 먼저 끝내세요");
      if (this.coreCompactFenced(member)) throw new ApiError(409, "문맥 압축을 처리하고 있어 잠재울 수 없습니다. 압축 결과를 확인해 주세요");
      if (this.isBusy(member)) throw new ApiError(409, `${josa(member.name, "은")} 일하는 중입니다`);
      if (this.store.listOpenDecisionsByMember(memberId).length > 0) throw new ApiError(409, `${member.name}에게 열린 결재가 있습니다`);
      if (pending.length > 0) throw new ApiError(409, `${member.name}의 대기열이 남아 있습니다`);
    }
    if (rt.closing || rt.starting || rt.reopening) throw new ApiError(409, "세션을 처리하는 중입니다");
    rt.closing = true;
    try {
      if (opts.holdAs === "archived") {
        await this.verifyArchiveSession(member);
        await this.runnerOf(member).checkStop?.(this.runnerMember(member, project), { whileWorking: false });
      }
      // 넘겨받은 칸은 대표의 것이라 선택 창·승인 창이 떠 있으면 끝내지 않는다(입력칸에 남은 글은 지우고 끝낸다). 먼저 해 보고, 안 되면 아무것도 바꾸지 않고 이유를 돌려준다.
      const adopted = member.origin === "adopted";
      if (adopted) {
        const runner = this.runnerOf(member);
        const target = this.runnerMember(member, project);
        try {
          // 끊기 전에 본다. Esc 는 대표의 승인 창을 취소하고, 선택 창이 떠 있으면 끊고도 끝낼 수 없다. 승인 창은 force 여도 대표가 푼다.
          if (opts.force && !opts.holdAs && (this.isBusy(member) || member.status === "blocked")) {
            await runner.checkStop?.(target, { whileWorking: true });
            if (member.status !== "blocked") await runner.interrupt(target);
          }
          await this.stopManaged(member, opts.holdAs === "archived" ? "archive" : "sleep", !!opts.force && !opts.holdAs);
        } catch (e) {
          if (e instanceof HerdrError && e.code === "cannot_exit") throw new ApiError(409, e.message);
          throw e;
        }
      }
      if (!adopted) await this.stopManaged(member, opts.holdAs === "archived" ? "archive" : "sleep", !!opts.force && !opts.holdAs);
      this.endExecution(member, "interrupted", "직원을 잠재워 실행을 종료했습니다");
      if (rt.turn) rt.turn.interrupted = true;
      rt.compactRequest = null;
      this.store.transaction(() => {
        this.interruptCoreCompaction(member);
        this.store.patchMember(memberId, { status: "asleep", subagents: 0, paneId: null });
        for (const d of this.store.listPending(memberId)) {
          if (opts.holdAs && (d.attempts > 0 || d.status === "held" && d.holdReason !== "archived")) continue;
          this.hold(d, opts.holdAs ?? "asleep");
        }
        this.confirmStop(memberId);
      });
      // herdr 는 칸을 닫을 뿐 turn_end 를 내지 않는다. 턴을 비우지 않으면 깨운 뒤 전달이 영영 막힌다.
      if (rt.compactTimer) clearTimeout(rt.compactTimer);
      rt.compactTimer = null;
      if (rt.turn) {
        rt.turn = null;
        this.releaseSlots();
      }
      return this.store.requireMember(memberId);
    } finally { rt.closing = false; }
  }

  /** --resume 으로 다시 연다. 실패하면 같은 핸들로 새 세션을 띄우고 마지막 일을 첫 지시에 넣는다. */
  async resumeMember(memberId: string, firstInstruction?: string, assignedBy?: Member, taskId?: string | null): Promise<Member> {
    const member = this.store.requireMember(memberId);
    if (firstInstruction?.trim()) this.instructionTaskFor(member.projectId, taskId); // 없는 업무면 다시 열기 전에 거절한다.
    if (firstInstruction?.trim() && assignedBy) this.requireInstructionContract(assignedBy, taskId ?? null);
    if (member.origin === "manual") throw new ApiError(400, "직접 띄운 세션은 다시 열 수 없습니다");
    this.requireActive(this.store.requireProject(member.projectId));
    this.requireNotSwitching();
    if (this.runners.has("core") && member.backend !== "core" && (member.sessionId || member.paneId)) throw new ApiError(409, "이전 실행기의 세션은 자동으로 다시 열지 않습니다");
    if (member.status === "asleep" || member.status === "offline") {
      // 가져온 프로젝트는 총괄을 시작하거나 편입하기 전에는 어떤 세션도 움직이지 않는다고 약속했다.
      if (!this.store.requireProject(member.projectId).runnerEnabled) throw new ApiError(409, "이 프로젝트는 실행이 꺼져 있습니다. 총괄을 시작하거나 기존 세션을 편입하세요");
      const reopened = await this.reopen(member);
      if (!reopened) {
        const why = this.store.requireMember(memberId).lastError;
        throw new ApiError(502, `${josa(member.name, "을")} 다시 열지 못했습니다${why ? `: ${why}` : ""}`);
      }
      this.checkAwakeLimit(member.projectId);
    }
    if (firstInstruction?.trim()) {
      await this.assign(member.projectId, member.handle, { text: firstInstruction, taskId }, assignedBy);
    } else {
      await this.pump(memberId);
    }
    return this.store.requireMember(memberId);
  }

  /** 깨우기와 전달 펌프가 함께 불러도 세션은 하나만 연다. */
  private reopen(member: Member): Promise<Member | null> {
    const rt = this.runtime(member.id);
    rt.reopening ??= this.reopenOnce(member).finally(() => {
      rt.reopening = null;
    });
    return rt.reopening;
  }

  private async reopenOnce(member: Member): Promise<Member | null> {
    const project = this.store.requireProject(member.projectId);
    const runner = this.openRunner(member);
    try {
      const sent = this.desiredConfig(member);
      const started = await this.startManaged(member, project, !!member.sessionId);
      if (await this.dropIfClosed(member, project, runner, started)) return null;
      this.applyStarted(member.id, project, started, sent);
      // 넘겨받은 세션도 서버가 다시 띄우면 도구와 규칙을 갖고 뜬다. 이제 서버가 띄운 세션과 같다.
      // 대표가 칸에서 그 세션을 다시 열어 거기 붙었으면(rejoined) 도구가 없는 그대로다.
      if (member.origin === "adopted" && !started.rejoined) {
        this.store.patchMember(member.id, { origin: "runner" });
        this.store.enqueue({ projectId: project.id, memberId: member.id, kind: "system", text: formatSystem("이제 이 세션에 iamceo 도구(post·ask·status·file·todo)가 연결되었습니다. 앞서 받은 '도구가 없다'는 안내는 취소입니다. 보고와 질문은 도구로 하세요."), wake: false });
      }
    } catch (e) {
      const message = (e as Error).message;
      // 잠깐의 시간 초과·소켓 끊김으로 멀쩡한 세션을 버리면 직원이 맥락을 잃는다. 세션이 정말 없을 때만 새로 연다.
      const missing = isMissingSessionError(message) || runner.sessionExists?.(this.runnerMember(member, project)) === false;
      if (!missing) {
        console.warn(`${member.name} 이어 열기 실패, 세션을 그대로 두고 다시 시도합니다:`, message);
        if (this.store.getMember(member.id)) this.store.patchMember(member.id, { lastError: message });
        return null;
      }
      console.warn(`${member.name}의 이전 세션이 없어 새 세션을 엽니다:`, message);
      try {
        const fresh = { ...member, sessionId: null };
        const sent = this.desiredConfig(fresh);
        const started = await this.startManaged(fresh, project, false);
        if (await this.dropIfClosed(member, project, runner, started)) return null;
        this.applyStarted(member.id, project, started, sent);
        this.store.patchMember(member.id, { contextPct: null, parallel: false, ...(member.origin === "adopted" ? { origin: "runner" as const } : {}) });
        this.store.enqueue({ projectId: project.id, memberId: member.id, kind: "system", text: this.newSessionNote(member), wake: false });
      } catch (e2) {
        this.store.patchMember(member.id, { lastError: (e2 as Error).message });
        return null;
      }
    }
    this.settle(this.store.requireMember(member.id));
    return this.store.requireMember(member.id);
  }

  /** 띄우는 사이 직원이 닫혔다. 띄운 칸을 남기면 명부 밖에서 계속 산다. */
  private async dropIfClosed(member: Member, project: Project, runner: Runner, started: { sessionId: string | null; paneId: string | null; rejoined?: boolean }): Promise<boolean> {
    if (this.store.getMember(member.id)) return false;
    // 방금 띄운 칸은 서버 칸이다. 대표의 칸에 다시 붙은 경우(rejoined)만 넘겨받은 칸으로 다룬다.
    const origin = member.origin === "adopted" && !started.rejoined ? "runner" : member.origin;
    await runner.stop(this.runnerMember({ ...member, origin, sessionId: started.sessionId, paneId: started.paneId }, project)).catch((e) => console.warn("닫힌 직원의 칸을 닫지 못했습니다:", (e as Error).message));
    return true;
  }

  private newSessionNote(member: Member): string {
    const last = [member.now && `지금 일: ${normalizeSpace(member.now)}`, member.next && `다음: ${normalizeSpace(member.next)}`].filter(Boolean).join(" · ");
    return formatSystem(`이전 세션을 찾지 못해 새 세션으로 시작합니다. ${last ? `마지막 일 — ${last}` : "이전 기록은 없습니다."}`);
  }

  /** 세션을 끝내고 명부에서 뺀다. 대화·결재 기록은 남는다. 나가지 않고 사라진 입력의 요약을 돌려준다. */
  async closeMember(memberId: string, opts: { paneDone?: boolean } = {}): Promise<string[]> {
    const member = this.store.requireMember(memberId);
    if (this.archiving.has(member.projectId)) throw new ApiError(409, "프로젝트 보관을 처리하는 중입니다");
    if (member.kind !== "worker") throw new ApiError(400, "총괄은 닫을 수 없습니다");
    const rt = this.runtime(memberId);
    if (rt.closing || (this.backendOf(member) === "core" && (rt.starting || rt.reopening || rt.pumping))) throw new ApiError(409, "세션을 처리하는 중입니다");
    if (this.backendOf(member) !== "core") {
      const starting = this.pendingLifecycle(memberId);
      if (starting?.intent === "start") this.finishLifecycle(starting, "refused", "띄우는 동안 직원이 닫혔습니다");
    }
    rt.closing = true;
    try {
      if (member.origin !== "manual") {
        const project = this.store.requireProject(member.projectId);
        // 넘겨받은 칸은 대표의 세션이다. 총괄이 닫아도 끝내지 않고 손만 뗀다.
        if (member.origin === "adopted") {
          if (!opts.paneDone) await this.releasePane(member, project);
        } else await this.stopManaged(member, "close", true);
      }
      this.endExecution(member, "interrupted", "직원을 닫아 실행을 종료했습니다");
      if (rt.turn) rt.turn.interrupted = true;
      if (member.origin !== "manual") this.store.patchMember(memberId, { status: "asleep" });
      this.confirmStop(memberId);
      const dropped: string[] = [];
      const doneTodos: Todo[] = [];
      for (const d of this.store.listPending(memberId)) {
        if (d.refType === "message" && d.refId) this.store.setMessageDelivery(d.refId, "failed", `${josa(member.name, "이")} 닫혔습니다`);
        else if (d.kind === "todo_done" && d.refId) {
          const todo = this.store.getTodo(d.refId);
          if (todo?.done) doneTodos.push(todo);
        } else if (d.kind === "instruction") dropped.push(normalizeSpace(d.text.replace(/^\[총괄\][^\n]*\n/, "")).slice(0, 120));
      }
      for (const d of this.store.listOpenDecisionsByMember(memberId)) {
        this.store.closeDecision(d.id, { kind: null, reason: `${josa(member.name, "이")} 명부에서 빠져 함께 닫혔습니다`, by: "시스템" });
        this.wakeAll(this.askWaiters, d.id);
      }
      this.clearRuntime(memberId, rt);
      (this.runners.get("herdr") as HerdrCapable | undefined)?.dropMember?.(memberId);
      this.store.removeMember(memberId);
      this.releaseSlots();
      // 대표가 체크한 '했음'은 받을 직원이 사라져도 잃으면 안 된다. 총괄에게 넘긴다.
      const conductor = this.store.getConductor(member.projectId);
      for (const todo of doneTodos) {
        if (conductor) await this.deliver({ projectId: member.projectId, memberId: conductor.id, kind: "todo_done", text: formatTodoDone(todo), refType: "todo", refId: todo.id, wake: false });
        else this.store.setTodoNoticePending(todo.id, true);
      }
      return dropped;
    } finally { rt.closing = false; }
  }

  roster(projectId: string): RosterEntry[] {
    const { ranks, codexRanks } = this.store.getSettings();
    return this.store.listMembers(projectId).map((m) => ({
      handle: m.handle,
      name: m.name,
      role: m.role,
      kind: m.kind,
      status: m.status,
      now: m.now,
      next: m.next,
      queued: m.queuedCount,
      openDecisions: this.store.listOpenDecisionsByMember(m.id).length,
      contextPct: m.contextPct,
      subagents: m.subagents,
      parallel: m.parallel,
      updatedAt: m.updatedAt,
      ...memberConfig(m, ranks, codexRanks),
      ...staffSubagent(m.cli, ranks, codexRanks),
      run: m.executionState ? { id: m.executionState.runId, phase: m.executionState.phase, taskIds: m.executionState.taskIds ?? [] } : null,
    }));
  }

  requireInProject(projectId: string, memberRef: string): Member {
    const member = this.store.findMember(projectId, memberRef);
    if (!member) throw new ApiError(404, `이 프로젝트에 없는 직원입니다: ${memberRef}`);
    return member;
  }

  // ---- 작업 ----
  /** 직원이 작업을 등록하거나 고친다. 이후 그 직원의 출력은 task_id 를 밝혀야 한다. */
  saveTask(member: Member, input: { taskId?: string; title?: string; branch?: string | null; worktree?: string | null; parentTaskId?: string | null; contract?: ContractInput; confirmContractRev?: number }): { task: Task; created: boolean; contract: TaskContract | null } {
    const contract = input.contract ? cleanContract(input.contract) : null;
    if (input.confirmContractRev !== undefined) {
      // 직원이 단 계약의 확인은 총괄(과 본사)만 한다. 확인한 판만 완료 판정에 묶인다.
      if (member.kind === "worker") throw new ApiError(403, "계약 확인(confirm_contract_rev)은 총괄만 합니다. 직원은 contract 로 제안하고 총괄 확인을 기다립니다");
      if (!input.taskId || contract) throw new ApiError(400, "confirm_contract_rev 는 task_id 와 함께, contract 없이 줍니다");
      const task = this.store.resolveTask(this.requireTaskInProject(member, input.taskId));
      const confirmed = this.store.confirmTaskContract(task.id, input.confirmContractRev, { name: member.name, memberId: member.id });
      this.store.appendActivity(member.id, "system", `업무 #${task.id} 계약 r${confirmed.rev} 확인(작성 ${confirmed.author})`);
      return { task, created: false, contract: confirmed };
    }
    const saved = this.store.transaction(() => {
      if (input.taskId) this.requireTaskInProject(member, input.taskId);
      const parent = input.parentTaskId ? this.store.resolveTask(this.requireTaskInProject(member, input.parentTaskId)).id : null;
      // 갈래 업무는 위 업무의 계약을 따른다. 직원은 총괄·대표·다른 직원이 정한 계약(이어받은 것 포함)을 고치거나 덮어 기준을 낮추지 못한다.
      const under = input.taskId ?? parent;
      const current = contract && under ? this.store.getEffectiveContract(under) : null;
      if (current && member.kind === "worker" && current.authorMemberId !== member.id) {
        throw new ApiError(409, `업무 #${current.taskId} 계약 r${current.rev} 은 ${current.author}이(가) 정했습니다${!input.taskId || current.taskId !== input.taskId ? "(갈래 업무는 이 계약을 이어받습니다)" : ""}. 직원은 바꾸거나 덮지 않습니다. 바꿔야 하면 총괄에게 보고하세요`);
      }
      const saved = this.store.saveTask({ id: input.taskId, projectId: member.projectId, memberId: member.id, who: member.name, title: input.title, branch: input.branch, worktree: input.worktree, parentTaskId: parent });
      const by = { author: member.name, authorMemberId: member.id, authorKind: member.kind === "worker" ? "worker" as const : "conductor" as const };
      return { ...saved, contract: contract ? this.store.saveTaskContract(saved.task.id, contract, by) : this.store.getEffectiveContract(saved.task.id) };
    });
    // 직원이 계약을 제안했으면 총괄에게 확인을 부탁한다. 고친 판도 다시 확인을 받는다(느슨하게 고쳐 통과하지 못하게).
    const conductor = member.kind === "worker" ? this.store.getConductor(member.projectId) : null;
    if (contract && saved.contract && conductor && conductor.id !== member.id) {
      const previous = saved.contract.rev > 1 ? this.store.listTaskContracts(saved.contract.taskId).find(c => c.rev === saved.contract!.rev - 1) : null;
      const change = previous ? `\n바로 전 판 r${previous.rev}(${previous.confirmedAt ? `${previous.confirmedBy ?? "총괄"} 확인` : "확인 전"}): 합격 기준 ${previous.acceptance.length}개 → ${saved.contract.acceptance.length}개, 필수 검사 ${previous.checks.join("·") || "없음"} → ${saved.contract.checks.join("·") || "없음"}` : "";
      // 제안 등록은 실행 승인이 아니다. 확정된 실행 업무의 후속 확인은 영속 업무 추적기가 맡는다.
      void this.deliver({ projectId: member.projectId, memberId: conductor.id, kind: "system", wake: false, taskId: saved.task.id,
        text: formatSystem(`계약 확인 요청: ${member.name}이(가) 업무 #${saved.task.id} 에 계약 r${saved.contract.rev} 을 제안했습니다. 맞으면 task(task_id "${saved.task.id}", confirm_contract_rev ${saved.contract.rev})로 확인하세요. 기준을 바꿔야 하면 task 의 contract 로 총괄이 새 판을 정합니다. 확인 전 새 제안은 적용하지 않습니다. 기존 확정 계약이 있으면 그 판으로 검사합니다.${change}`) + `\n${formatContract(saved.contract)}` }).catch(() => {});
    }
    return saved;
  }

  private requireTaskInProject(member: Member, taskId: string): Task {
    const task = this.store.getTask(taskId);
    if (!task || task.projectId !== member.projectId) throw new ApiError(404, `작업을 찾을 수 없습니다: ${taskId}. task 도구로 등록한 이 프로젝트의 작업 id 를 쓴다`);
    return task;
  }

  /** 본사가 아닌 프로젝트는 모든 글에 업무를 붙인다. 본사(본사 AI 하나와 대표의 대화)는 업무를 쓰지 않는다. */
  usesTasks(projectId: string): boolean {
    return !this.store.requireProject(projectId).isHq;
  }

  /**
   * 직원이 남기는 글·카드·자료·할 일의 업무. 서버는 출처가 증명하는 것만 쓴다(마지막으로 받은 업무로 짐작하지 않는다).
   * 1) 직원이 밝힌 task_id(합쳐진 업무면 합쳐진 곳). 2) 바뀌지 않는 출처: 이어 준 결재·자료·정정 대상 글의 업무(서로 다르면 거절).
   * 3) 둘 다 없으면 거절해 task_id 를 넣거나 task 도구로 새 업무를 만들게 한다. 지금 턴이 받은 업무로도 붙이지 않는다:
   *    A 를 끝내고 B 를 받은 턴에 쓴 A 의 후속 글이 B 로 섞인다. 받은 업무는 거절 안내에만 적는다.
   * null(옛 도구의 '전체')도 같다. 새 글은 업무 없이 남지 않는다. 본사, 그리고 allowNone(개발 기억 기록)의 null 만 예외다.
   */
  memberTask(member: Member, explicit?: string | null, sources: (string | null | undefined)[] = [], opts: { allowNone?: boolean } = {}): string | null {
    if (typeof explicit === "string") return this.store.resolveTask(this.requireTaskInProject(member, explicit)).id;
    if (!this.usesTasks(member.projectId)) return null;
    if (explicit === null && opts.allowNone) return null;
    const fixed = [...new Set(sources.filter((id): id is string => !!id))];
    if (fixed.length === 1) return fixed[0]!;
    if (fixed.length > 1) throw new ApiError(400, `이어 준 결재·자료가 서로 다른 업무(${fixed.join(", ")})라 어느 업무의 글인지 정할 수 없습니다. task_id 를 넣어 다시 부르세요`);
    const lead = this.store.getConductor(member.projectId)?.id === member.id;
    const received = this.turnTasks(this.runtime(member.id).turn?.deliveries).map(id => this.store.getTask(id)).filter((t): t is Task => !!t);
    const hint = received.length ? ` 이번에 받은 글의 업무: ${received.map(t => `#${t.id} '${t.title}'`).join(", ")}. 이 글이 그중 하나의 일이면 그 id 를 넣으세요.` : "";
    throw new ApiError(400, `task_id 가 없습니다. 모든 글은 업무에 붙습니다(null 로 '전체'에 두지 않고, 서버가 업무를 짐작하지 않습니다).${hint} 받은 글의 '작업 #' 줄의 id 를 task_id 로 넣으세요. 새 일이면 task 도구로 새 업무를 만들고(제목만 넣어도 됩니다) 돌려받은 id 를 넣으세요${lead ? WORK_TASK_HINT : "."}`);
  }

  /**
   * 총괄 지시(team_assign·team_stop then)의 업무. 서버는 증거로만 정한다(마지막 업무로 짐작하지 않는다).
   * 1) 밝힌 task_id. 인용한 대표 글이 다른 업무에 있을 때: 대표가 고른 업무면 거절, 서버가 첫 줄로 만든 업무(auto)에
   *    그 대표 글(과 분류하는 총괄의 글)만 있으면 그 글들을 밝힌 업무로 옮기고 기록을 남긴다(총괄의 분류). 다른 글이 이미 있으면
   *    옮기지 않고 지시만 밝힌 업무로 보내며 갈라진 관계를 기록한다. 2) 인용한 대표 글·결재의 업무. 3) 둘 다 없으면 거절.
   * null(옛 도구의 '전체')도 2)를 거친다.
   */
  instructionTask(member: Member, explicit: string | null | undefined, userQuote?: string | null, proposedContract?: ContractInput): string | null {
    const checked = (id: string | null): string | null => {
      this.requireInstructionContract(member, id, proposedContract);
      return id;
    };
    if (!this.usesTasks(member.projectId)) return checked(explicit ? this.store.resolveTask(this.requireTaskInProject(member, explicit)).id : null);
    const source = userQuote?.trim() ? this.findQuoteSource(member.projectId, userQuote) : null;
    const quotedMessage = source ? this.store.getMessage(source.id) : null;
    const quoted = quotedMessage ? quotedMessage.taskId ?? null : source ? this.store.getDecision(source.id)?.taskId ?? null : null;
    if (typeof explicit === "string") {
      const target = this.store.resolveTask(this.requireTaskInProject(member, explicit)).id;
      if (!quoted || quoted === target) return checked(target);
      const from = this.store.getTask(quoted);
      if (from?.origin !== "auto" || !quotedMessage) {
        throw new ApiError(400, `인용한 대표 글은 업무 #${quoted} 에서 보낸 글인데 task_id 는 ${target} 입니다. 대표가 고른 업무(${quoted})로 다시 부르세요. 다른 일로 나누는 것이면 그 대표 글을 인용하지 마세요`);
      }
      checked(target); // 기준 없는 위임은 대표 원문 분류도 바꾸지 않는다.
      this.classifyAutoTask(member, from, quotedMessage.id, target);
      return target;
    }
    if (quoted) return checked(quoted);
    throw new ApiError(400, `task_id 가 없습니다. 모든 지시는 업무에 붙습니다(null 로 '전체'에 두지 않습니다). 대표 글에 '작업 #' 줄이 있으면 그 id 를, 새 일이면 task 도구로 새 업무를 만들어 그 id 를 넣으세요${WORK_TASK_HINT}`);
  }

  /** 직원에게 실행을 위임하기 전에 확정 기준을 갖춘다. 대표의 직접 입력과 업무 없는 본사 대화는 별도다. */
  private requireInstructionContract(member: Member, taskId: string | null, proposedContract?: ContractInput): void {
    if (!taskId) {
      if (this.usesTasks(member.projectId)) throw new ApiError(400, "실행 위임에는 task_id 와 확정된 완료 기준이 필요합니다. task 도구로 업무 계약을 정한 뒤 맡기세요");
      return;
    }
    const pending = this.store.pendingTaskFailureDecision(taskId);
    if (pending) throw new ApiError(409, `같은 실패 세 번으로 대표 판단을 기다립니다. 결재함 #${pending.id} 에서 답을 받은 뒤 남은 범위를 확인하고 다시 맡기세요`);
    if (proposedContract && member.kind !== "worker") {
      cleanContract(proposedContract);
      return;
    }
    const contract = this.store.getEffectiveContract(taskId);
    if (bindingContract(contract)) return;
    throw new ApiError(409, contract
      ? `업무 #${taskId} 계약 r${contract.rev} 은 아직 총괄 확인 전입니다. task 의 confirm_contract_rev 로 기준을 확인하거나 contract 로 확정한 뒤 맡기세요. 원 지시는 다시 보내지 않습니다`
      : `업무 #${taskId} 에 확정된 완료 기준이 없습니다. task 의 contract 로 원하는 결과와 합격 기준을 정하거나 team_assign 의 contract 에 함께 넣어 확정한 뒤 맡기세요. 원 지시는 다시 보내지 않습니다`);
  }

  /**
   * 서버가 첫 줄로 만든 업무(auto)의 대표 글을 총괄이 고른 업무로 옮긴다. 그 업무에 그 대표 글과 분류하는 총괄 자신의 글만 있을 때만
   * 옮긴다(다른 직원의 보고·결재·자료가 있으면 그 문맥을 깨지 않게 옮기지 않고, 갈라진 관계만 남긴다). 옮긴 기록은 task_links 에 남는다.
   */
  private classifyAutoTask(member: Member, from: Task, messageId: string, to: string): void {
    const projectId = member.projectId;
    if (this.store.taskOtherRecords(from.id, [messageId], member.id) > 0) {
      this.store.recordTaskRelation({ projectId, taskId: to, fromTaskId: from.id, basis: "derived", actor: member.id, note: `대표 글 #${messageId} 을 인용한 지시` });
      return;
    }
    this.store.transaction(() => {
      for (const m of this.store.taskMessageIds(from.id)) {
        if (m.id !== messageId && m.memberId !== member.id) continue;
        this.store.moveRecordTask({ projectId, refType: "message", refId: m.id, from: from.id, to, basis: "classify", actor: member.id, note: m.id === messageId ? "총괄이 대표 글을 이 업무로 분류" : "분류한 대표 글에 대한 총괄의 글" });
      }
      this.store.markTaskMerged(from.id, to, member.id);
    });
  }

  /**
   * 지시 전달의 업무가 이 프로젝트의 업무인지 본다(합쳐진 업무면 합쳐진 곳). 업무를 정하고 빠진 지시를 거절하는 것은
   * 도구 입구(team_assign·team_stop then·team_add·team_resume 의 instructionTask)다.
   */
  private instructionTaskFor(projectId: string, taskId: string | null | undefined): Task | null {
    if (!taskId) return null;
    const task = this.store.getTask(taskId);
    if (!task || task.projectId !== projectId) throw new ApiError(404, `작업을 찾을 수 없습니다: ${taskId}`);
    return this.store.resolveTask(task);
  }

  /** 턴이 받은 전달의 업무들(업무 없는 전달은 빼고, 받은 차례대로). */
  private turnTasks(deliveries: Delivery[] | undefined): string[] {
    const ids: string[] = [];
    for (const d of deliveries ?? []) {
      const id = this.store.deliveryTaskId(d.id);
      if (id && !ids.includes(id)) ids.push(id);
    }
    return ids;
  }

  /** 전달 글의 작업 줄. 이 프로젝트에 작업이 하나도 없으면 줄을 붙이지 않는다(작업을 안 쓰는 프로젝트의 글은 그대로). */
  /** 지시 글의 업무 줄. 계약이 있는 업무면 계약 판·원문 참조·최근 검사·열린 결재를 덧붙인다(대화 전량은 넘기지 않는다). */
  private instructionTaskLines(projectId: string, taskId: string | null | undefined): string | null {
    const line = this.taskLineFor(projectId, taskId);
    const contract = taskId ? this.store.getEffectiveContract(taskId) : null;
    if (!contract || !taskId) return line;
    const openDecisions = this.store.listOpenDecisions(projectId).filter(d => d.taskId === taskId).map(d => ({ id: d.id, title: d.title }));
    return [line, formatContract(contract, { latest: this.store.latestTaskChecks(taskId), openDecisions, forTaskId: taskId })].filter(Boolean).join("\n");
  }

  private taskLineFor(projectId: string, taskId: string | null | undefined): string | null {
    const task = taskId ? this.store.getTask(taskId) : null;
    if (task) return formatTaskLine(task);
    return this.store.hasTasks(projectId) ? formatTaskLine(null) : null;
  }

  // ---- 보고 ----
  async recordPost(member: Member, input: PostInput): Promise<Message> {
    const rt = this.runtime(member.id);
    const files = (input.fileIds ?? []).map((id) => {
      const file = this.store.getFile(id);
      if (!file || file.projectId !== member.projectId) throw new ApiError(404, `자료를 찾을 수 없습니다: ${id}`);
      return file;
    });
    if (input.decisionId && this.store.getDecision(input.decisionId)?.projectId !== member.projectId) {
      throw new ApiError(404, `결재를 찾을 수 없습니다: ${input.decisionId}`);
    }
    // 거부된 호출은 보고가 아니다. 턴 마지막 글의 자동 보고를 막으면 안 된다.
    // Message 는 자료 하나만 잇는다. 나머지는 본문의 앱 안 링크로 잇는다.
    const extra = files
      .slice(1)
      .map((f) => `[자료: ${f.title.replace(/[\[\]\\]/g, "\\$&")}](#/p/${encodeURIComponent(member.projectId)}/files/${encodeURIComponent(f.id)})`)
      .join("\n\n");
    if (input.correctsMessageId) {
      const previous = this.store.requireMessage(input.correctsMessageId);
      if (previous.projectId !== member.projectId || previous.memberId !== member.id || previous.mine) throw new ApiError(400, "자신이 작성한 보고만 정정할 수 있습니다");
    }
    if (input.aboutReportId) {
      const about = this.store.getMessage(input.aboutReportId);
      if (!about || about.projectId !== member.projectId || about.mine || !about.memberId || about.memberId === member.id) throw new ApiError(400, "about_report_id 는 이 프로젝트 다른 직원 보고의 원본 id 여야 합니다(받은 글의 '보고 원본 #' 줄)");
    }
    const closure = this.postClosure(member, input);
    const conductor = member.kind === "worker" ? this.store.getConductor(member.projectId) : null;
    // 고정 출처: 이어 준 결재·자료, 정정하는 자신의 이전 보고
    const taskId = this.memberTask(member, input.taskId, [
      input.decisionId ? this.store.getDecision(input.decisionId)?.taskId : null,
      ...files.map((f) => f.taskId),
      input.correctsMessageId ? this.store.getMessage(input.correctsMessageId)?.taskId : null,
    ]);
    const checks = harnessChecks(input);
    const contract = taskId ? this.store.getEffectiveContract(taskId) : null;
    const claims = (input.claims ?? []).map(c => ({ text: cleanText(c.text).replace(/\s+/g, " ").trim(), basis: c.basis, source: c.source ? cleanText(c.source).trim() || null : null, quote: c.quote ? cleanText(c.quote).trim() || null : null, criterion: c.criterion ?? null }));
    const gate = input.kind === "완료" ? this.gateCompletion(member, taskId, contract, checks, input.contractRev ?? null, claims) : null;
    // 기록하는 판: 밝힌 판(1~지금 판)이 있으면 그 판, 없으면 지금 판. 완료는 위 판정에서 지금 판과 같아야 남는다.
    const recordRev = contract ? (input.contractRev && input.contractRev >= 1 && input.contractRev <= contract.rev ? input.contractRev : contract.rev) : null;
    let noticeTo: string | null = null;
    const { value: message, deliveries } = this.store.withDeliveryIntents(() => this.store.createMessage({
      projectId: member.projectId, memberId: member.id, who: member.name, kind: input.kind,
      title: rt.direct ? `(직접) ${input.title}` : input.title,
      body: [withOwnerLine(input.body, input.ownerAction), extra].filter(Boolean).join("\n\n"), decisionId: input.decisionId ?? null, fileId: files[0]?.id ?? null, taskId, aboutMessageId: input.aboutReportId ?? null,
    }), message => {
      this.store.noteDelegationPost(member.id);
      if (closure) this.store.recordReportClosure({ memberId: member.id, refType: "message", refId: message.id, ...closure });
      this.store.saveReportReferences(member.projectId, { sourceMessageId: message.id, fileIds: files.map(file => file.id), decisionIds: input.decisionId ? [input.decisionId] : [], authoredAt: message.at, sequence: this.store.boardRevision(member.projectId), correctsMessageId: input.correctsMessageId ?? null });
      if (checks.length || input.reviewNeeded || contract || gate || claims.length) this.store.recordReportChecks(message, member, checks, { contractTaskId: contract?.taskId ?? null, contractRev: recordRev, reviewNeeded: input.reviewNeeded ? cleanText(input.reviewNeeded).trim() || null : null,
        gate: gate?.gate ?? null, evidenceStatus: gate?.evidenceStatus ?? null, evidence: gate?.evidence, claims: gate?.claims ?? claims.map(c => ({ ...c, verified: false, via: null })) });
      if (gate?.evidenceStatus === "unsupported") this.store.recordHarnessFinding({ projectId: member.projectId, taskId, memberId: member.id, kind: "evidence_unsupported", detail: `${member.name}(${member.cli})의 완료 검사를 실행 기록과 대조하지 못했습니다(이 제공자의 기록 형식을 지원하지 않음). 작성자 보고로만 받았습니다`, refType: "message", refId: message.id });
      // 반복 감시: 멈춘 뒤 같은 실패의 막힘은 총괄을 다시 깨우지 않는다. 처음 멈출 때 총괄에게 한 번 알린다.
      const watch = this.watchReport(message);
      if (watch.trip && taskId) noticeTo = this.watchNoticeDelivery(member.projectId, taskId, watch.trip)?.memberId ?? null;
      return conductor && conductor.id !== member.id ? [{ projectId: member.projectId, memberId: conductor.id, kind: "report", text: this.reportText(message), wake: WAKE_POST_KINDS.has(input.kind) && !watch.quiet, refType: "message", refId: message.id }] : [];
    });
    rt.posted = true;
    await Promise.all([...new Set([...deliveries.map(d => d.memberId), ...(noticeTo ? [noticeTo] : [])])].map(id => this.pump(id)));
    return message;
  }

  /**
   * 완료 판정. 계약은 업무에 붙고 갈래 업무는 위 업무의 계약을 따른다(getEffectiveContract).
   * 판정에 묶이는 계약(bindingContract)은 총괄·대표가 정했거나, 직원이 단 것을 총괄·대표가 확인한 것이다.
   * 1) 직원이 이번 턴에 받았거나 받고서 아직 마감하지 않은 업무에 계약이 있으면, 받지 않은 계약 없는 업무(직원이 새로 만든 업무 포함)로 완료를 올리지 못한다.
   * 2) 모든 실행 업무는 만든 시각·하네스 표시 설정과 관계없이 묶이는 계약이 있어야 직원·총괄 완료를 받는다.
   * 3) 검사는 지금 판(contract_rev)을 밝혀야 받는다. 옛 판의 기준 번호로 새 판을 통과시키지 않는다.
   * 4) 실행 검사의 통과는 이 세션의 제공자 기록에서 계약 시각 뒤 그 명령의 마지막 실행(종료 0)과 맞아야 하고, 다른 업무에 쓴 실행은 쓰지 않는다.
   *    조사 계약은 사실 주장의 원문 인용이 직원이 본 도구 결과나 다른 사람의 자료 본문에 있어야 한다. 기록 형식을 모르는 제공자(Antigravity)는 '미지원'으로 남긴다.
   * 5) 총괄·본사는 자기 검사가 없으면 이 계약 판으로 통과한 완료 보고가 있어야 한다. 자기 검사를 붙이면 같은 증거 대조를 받는다.
   * 거절된 완료는 글이 아니므로 보고 의무가 남는다(막힘으로 올리면 마감된다). 거절은 개선 후보로 남는다.
   */
  private gateCompletion(member: Member, taskId: string | null, contract: TaskContract | null, checks: ReportCheckInput[], declaredRev: number | null, claims: ClaimInput[]): { gate: HarnessGate; evidenceStatus: string | null; evidence: CheckEvidence[]; claims: ClaimResult[] } {
    const refuse = (reason: string, log = reason, kind: HarnessFinding["kind"] = "completion_refused"): never => {
      reason = redactHarnessText(reason);
      log = redactHarnessText(log);
      this.store.appendActivity(member.id, "system", `완료 차단: ${log}`);
      this.store.recordHarnessFinding({ projectId: member.projectId, taskId, memberId: member.id, kind, detail: log, refType: "task", refId: taskId });
      throw new ApiError(400, reason);
    };
    const none = (gate: HarnessGate) => ({ gate, evidenceStatus: null, evidence: [], claims: claims.map(c => ({ ...c, verified: false, via: null })) });
    if (!taskId && !this.usesTasks(member.projectId)) return none("exempt");
    const pending = taskId ? this.store.pendingTaskFailureDecision(taskId) : null;
    if (pending) refuse(`같은 실패 세 번으로 대표 판단을 기다립니다. 결재함 #${pending.id} 에서 답을 받은 뒤 남은 기준을 확인해야 완료할 수 있습니다`);
    if (!contract || !bindingContract(contract)) {
      if (member.kind === "worker") {
        const received = [...new Set([...this.turnTasks(this.runtime(member.id).turn?.deliveries), ...this.store.openAssignedTasks(member.id, (a, b) => this.isTaskUnder(a, b))])].map(id => this.store.getTask(id)).filter((t): t is Task => !!t).map(t => this.store.resolveTask(t).id);
        const boundReceived = received.map(id => this.store.getEffectiveContract(id)).filter((c): c is TaskContract => bindingContract(c));
        if (boundReceived.length && taskId && !received.some(id => this.isTaskUnder(taskId, id))) {
          const list = [...new Set(boundReceived.map(c => `#${c.taskId} 계약 r${c.rev}`))].join(", ");
          refuse(`받은 업무(${list})는 계약이 있고 아직 완료·막힘으로 마감하지 않았습니다. 그 일의 완료는 그 업무 id 와 contract_rev·checks 로 올리세요. 받지 않은 업무 #${taskId} 의 완료는 계약 없이 받지 않습니다. 정말 다른 일이면 진행·알림으로 남기고 총괄에게 계약을 받으세요`, `받은 업무(${list}) 대신 계약 없는 업무 #${taskId} 로 완료`);
        }
      }
      const how = member.kind === "worker" ? "task 도구의 contract 로 계약을 제안하면 총괄이 확인합니다" : "task 도구의 contract 로 계약을 정하세요(총괄이 정한 계약은 바로 묶입니다)";
      return refuse(contract
        ? `업무 #${contract.taskId} 계약 r${contract.rev} 은 직원이 단 계약이고 아직 총괄 확인 전입니다. 총괄이 확인(task 의 confirm_contract_rev)해야 완료를 받습니다. 기다리는 동안은 진행·막힘으로 올리세요`
        : `업무 #${taskId} 에 확정된 완료 기준이 없습니다. 기존 업무를 포함한 모든 실행 업무에는 계약이 있어야 완료를 받습니다. ${how}. 그동안은 진행·막힘으로 올리세요`,
        contract ? `확인 전 직원 계약 r${contract.rev} 로 완료` : `업무 #${taskId} 를 확정 기준 없이 완료(${member.kind === "worker" ? "직원" : "총괄"})`);
    }
    const now = formatContract(contract, { forTaskId: taskId });
    if (declaredRev != null && declaredRev > contract.rev) refuse(`계약 r${declaredRev} 은 아직 확정되지 않았습니다. 현재 확정 판은 r${contract.rev} 입니다. 이 판으로 검사하거나 새 판 확인을 기다리세요`);
    if (declaredRev != null && declaredRev !== contract.rev) refuse(`완료로 올릴 수 없습니다. 업무 #${contract.taskId} 계약이 r${declaredRev} 에서 r${contract.rev} 로 바뀌었습니다. 옛 판의 검사로는 받지 않습니다. 지금 판의 기준으로 다시 검사하세요.\n${now}`, `옛 판 r${declaredRev} 의 검사(지금 r${contract.rev})`);
    if (member.kind !== "worker" && !checks.length) {
      if (this.store.hasPassedCompletion(contract.taskId, contract.rev)) return none("contract");
      refuse(`업무 #${contract.taskId} 계약 r${contract.rev} 로 검사를 통과한 직원 완료 보고가 아직 없습니다. 완료로 올리려면 contract_rev 와 checks 를 넣거나, 직원 보고를 기다리세요(진행·알림·막힘은 받습니다)`);
    }
    const reasons = [...(declaredRev == null ? [`검사가 따른 계약 판을 contract_rev 로 밝히지 않았습니다(지금 판 r${contract.rev})`] : []), ...completionGate(contract, checks), ...researchGate(contract, claims)];
    if (reasons.length) refuse(`완료로 올릴 수 없습니다(업무 #${contract.taskId} 계약 r${contract.rev}). ${reasons.join(" / ")}. 고쳐서 다시 검사한 뒤 완료로 올리거나, 막힘으로 올리고 unverified 에 확인하지 못한 것을 적으세요${declaredRev == null ? `\n${now}` : ""}`, reasons.join(" / "));
    // 실행 증거: 이 세션의 제공자 기록에서 계약 시각 뒤의 실행만 본다(옛 판·다른 업무·실패·없는 실행은 받지 않는다).
    const log = this.contextLog(member);
    const evidence = readProviderEvidence(member.cli, log ? { ...log, root: providerLogRoot(member.cli, log.home) } : null, contract.at);
    const exec = matchExecChecks(checks, evidence, ref => { const used = this.store.execRefTask(ref); return used && used !== contract.taskId ? used : null; }, member.cwd);
    const verified = verifyClaims(claims, evidence, source => {
      const file = /^f_[A-Za-z0-9_-]+$/.test(source) ? this.store.getFile(source) : null;
      // 자기가 올린 자료는 자기 글이다. 대표·다른 직원의 자료 본문만 원문으로 친다.
      return file && file.projectId === member.projectId && file.memberId !== member.id ? `${file.title}\n${file.summary}\n${file.body}` : null;
    }, claims.length && taskId ? this.store.codeReads(this.codeReadScope(member, taskId, contract)) : []);
    const missing = [...exec.reasons, ...verified.reasons];
    if (missing.length) refuse(`완료로 올릴 수 없습니다(업무 #${contract.taskId} 계약 r${contract.rev}, 실행 증거). ${missing.join(" / ")}`, missing.join(" / "), "evidence_missing");
    return { gate: "contract", evidenceStatus: evidence.status, evidence: exec.results, claims: verified.results };
  }

  /** taskId 가 root 이거나 root 의 갈래(parent 를 따라 올라가 root 에 닿는다)인지. */
  private isTaskUnder(taskId: string, root: string): boolean {
    const seen = new Set<string>();
    let id: string | null | undefined = taskId;
    while (id && !seen.has(id) && seen.size < 32) {
      if (id === root) return true;
      seen.add(id);
      const task = this.store.getTask(id);
      id = task ? this.store.resolveTask(task).parentTaskId ?? null : null;
    }
    return false;
  }

  /**
   * 보고 글이 마감하는 의무. 완료·막힘·질문은 결과다. 알림은 확인한 원보고(reviewed)나 기다리는 자기 결재(waiting)를 밝힐 때만,
   * 진행은 어떤 경우에도 마감하지 않는다(중간 소식만으로 끝난 일로 치지 않는다).
   */
  private postClosure(member: Member, input: PostInput): { kind: "result" | "reviewed" | "waiting"; causeId: string | null } | null {
    if (WAKE_POST_KINDS.has(input.kind)) return { kind: "result", causeId: null };
    if (input.kind !== "알림") return null;
    if (input.aboutReportId) return { kind: "reviewed", causeId: input.aboutReportId };
    const decision = input.decisionId ? this.store.getDecision(input.decisionId) : null;
    if (decision && decision.memberId === member.id && decision.status === "open") return { kind: "waiting", causeId: decision.id };
    return null;
  }

  reportReferences(projectId: string, messageId: string): ReportReferences {
    const message = this.store.requireMessage(messageId);
    if (message.projectId !== projectId || message.mine || !message.memberId) throw new ApiError(404, "보고를 찾을 수 없습니다");
    return this.store.getReportReferences(projectId, messageId) ?? { sourceMessageId: message.id, fileIds: message.fileId ? [message.fileId] : [], decisionIds: message.decisionId ? [message.decisionId] : [], authoredAt: message.at, sequence: 0, correctsMessageId: null };
  }

  private reportText(message: Message): string {
    const refs = this.reportReferences(message.projectId, message.id);
    const direct = message.title.startsWith("(직접) ");
    const harness = this.store.getReportHarness(message.id);
    const contract = harness?.contractTaskId ? this.store.getTaskContract(harness.contractTaskId) : null;
    const checksLine = [harness ? formatChecksLine(harness.checks, harness.contractRev, harness.reviewNeeded, contract) : "",
      harness?.gate === "no_contract" ? (contract ? `하네스: 확인 전 직원 계약(완료 판정 밖, 작성자 보고만). 기준이 맞으면 task(task_id "${contract.taskId}", confirm_contract_rev ${contract.rev})로 확인하세요` : "하네스: 계약 없는 완료(완료 판정 밖, 작성자 보고만). 기준이 필요한 일이면 task 의 contract 로 계약을 정하고 다시 맡기세요") : "",
      harness?.claims.length ? `조사 주장 ${harness.claims.length}건: 사실 ${harness.claims.filter(c => c.basis === "fact").length}(인용 대조 ${harness.claims.filter(c => c.quoteMatched).length}) · 해석 ${harness.claims.filter(c => c.basis === "interpretation").length}. 인용 존재·출처 열람만 대조하며, 주장 의미는 별도 검토` : ""].filter(Boolean).join("\n");
    const stage = this.stageLine(message.taskId);
    return `${formatReport(message.who, direct ? `(직접) ${message.kind}` : message.kind, direct ? message.title.slice(5) : message.title, message.body)}${checksLine ? `\n${checksLine}` : ""}${stage ? `\n${stage}` : ""}\n보고 원본 #${refs.sourceMessageId} · 작성 ${refs.authoredAt} · 순번 ${refs.sequence}\n자료: ${refs.fileIds.join(", ") || "없음"} · 결재: ${refs.decisionIds.join(", ") || "없음"}${refs.correctsMessageId ? ` · 정정 대상 #${refs.correctsMessageId}` : ""}`;
  }

  private async reportToConductor(member: Member, kind: string, title: string, body: string, wake: boolean): Promise<void> {
    const conductor = this.store.getConductor(member.projectId);
    if (!conductor || conductor.id === member.id) return;
    await this.deliver({ projectId: member.projectId, memberId: conductor.id, kind: "report", text: formatReport(member.name, kind, title, body), wake });
  }

  /** ask. blocking 이면(manual) 호출자가 askWait 로 기다리고, 아니면 text 를 도구 결과로 돌려준다. */
  async registerAsk(member: Member, input: AskInput): Promise<{ decision: Decision; blocking: boolean; text: string }> {
    // 보관한 프로젝트의 카드는 화면에 없고 답도 409 다. 올리면 세션이 답 없는 대기에 묶인다.
    if (this.store.requireProject(member.projectId).archived || this.archiving.has(member.projectId)) throw new ApiError(409, "프로젝트가 보관되어 대표가 답할 수 없습니다. 묻지 말고 턴을 끝내세요");
    // 같은 안건으로 결재 카드가 두 장 오르면 대표가 같은 질문에 두 번 답한다. 열린 카드가 있으면 새 카드를 받지 않는다.
    // 제목·묶음·자료·그림이 모두 같아야 같은 안건으로 본다.
    const same = this.store.listOpenDecisionsByMember(member.id).find((d) => d.projectId === member.projectId && askSameItem(d, input));
    if (same) {
      const wait = member.origin === "manual" ? " 같은 질문이면 답은 wait 로 받습니다." : " 같은 질문이면 턴을 끝내고 답을 기다리세요.";
      throw new ApiError(409, `다른 안건이면 제목을 구체적으로 바꿔 다시 올리세요. 같은 제목의 결재 카드가 이미 열려 있어 새 카드를 올리지 않았습니다 #${same.id}.${wait} 같은 질문의 내용만 바꿀 때만 ask_close(obsolete)로 그 카드를 닫고 다시 올립니다`);
    }
    const recLabel = input.rec ? input.options?.find((o) => o.k === input.rec)?.label : undefined;
    const detail = withRecLine(input.detail, recLabel, input.recReason);
    const taskId = this.memberTask(member, input.taskId, [input.fileId ? this.store.getFile(input.fileId)?.taskId : null]);
    const { value: decision, deliveries } = this.store.withDeliveryIntents(() => {
      const decision = this.store.createDecision({
        projectId: member.projectId,
        memberId: member.id,
        who: member.name,
        title: input.title,
        detail,
        options: input.options,
        rec: input.rec,
        group: input.group,
        fileId: input.fileId,
        images: input.images,
        taskId,
      });
      this.store.createMessage({
        projectId: member.projectId,
        memberId: member.id,
        who: member.name,
        kind: "질문",
        title: input.title,
        body: detail,
        decisionId: decision.id,
        fileId: input.fileId ?? null,
        attachments: input.images,
        taskId,
      });
      this.store.patchMember(member.id, { status: "waiting" });
      this.store.recordReportClosure({ memberId: member.id, kind: "question", refType: "decision", refId: decision.id });
      return decision;
    }, decision => {
      const conductor = member.kind === "worker" ? this.store.getConductor(member.projectId) : null;
      return conductor ? [{ projectId: member.projectId, memberId: conductor.id, kind: "system",
        text: formatSystem(`${josa(member.name, "이")} 대표에게 질문했습니다: ${normalizeSpace(input.title)} #${decision.id}`), wake: false, taskId: decision.taskId ?? null }] : [];
    });
    this.runtime(member.id).posted = true;
    this.notifyInbox(`${member.name}의 결재`, input.title);
    await Promise.all(deliveries.map(d => this.pump(d.memberId)));
    if (member.origin === "manual") return { decision, blocking: true, text: `질문 #${decision.id} 등록됨. 답을 기다립니다` };
    return { decision, blocking: false, text: `질문 #${decision.id} 등록됨. 턴을 끝내세요. 답은 다음 입력으로 옵니다` };
  }

  // ---- 판 정리: 결재 닫기·할 일 정리 ----
  /**
   * ask_close. 열린 결재를 이유와 함께 닫는다. 대신 답하지 않는다: decided 는 user_quote 가 이 프로젝트의 대표 글과
   * team_assign 과 같은 방식으로 맞아야 하고, 버튼 글·아주 짧은 글은 근거가 못 된다. 직원은 자기가 올린 카드만.
   * 닫으면 물은 직원에게 깨우지 않고 알리고, ask 를 기다리던 직접 띄운 CLI 는 풀어 준다.
   */
  async closeDecision(member: Member, request: { id: string; kind: "decided" | "obsolete"; reason: string; userQuote?: string; followUp: DecisionFollowUp }): Promise<Decision> {
    return this.closeAsk(member, request);
  }

  async closeAsk(member: Member, input: { id: string; kind: DecisionCloseKind; reason: string; userQuote?: string; followUp?: DecisionFollowUp }): Promise<Decision> {
    const decision = this.store.getDecision(input.id);
    if (!decision || decision.projectId !== member.projectId) throw new ApiError(404, `결재를 찾을 수 없습니다: ${input.id}`);
    const failureDecision = this.store.isTaskFailureDecision(decision.id);
    if (input.kind === "obsolete" && failureDecision) {
      throw new ApiError(409, "같은 실패 세 번으로 올린 결재입니다. 대표의 재개·보류 판단 전에는 총괄이 닫을 수 없습니다");
    }
    if (member.kind === "worker" && decision.memberId !== member.id) throw new ApiError(403, "직원은 자기가 올린 결재만 닫을 수 있습니다");
    if (decision.status !== "open") throw new ApiError(409, decision.status === "closed" ? "이미 닫힌 결재입니다" : "대표가 이미 답한 결재입니다. 닫지 않습니다");
    const reason = normalizeSpace(input.reason);
    let quote: string | null = null;
    let sourceId: string | null = null;
    if (input.kind === "decided") {
      const raw = input.userQuote?.trim();
      if (!raw) throw new ApiError(400, "decided 로 닫으려면 user_quote 에 대표가 정한 말을 글자 그대로 실어야 합니다. 대표가 아직 정하지 않았으면 닫지 마세요");
      const owner = failureDecision ? this.store.taskFailureQuoteSource(decision.id, raw) : null;
      const source = failureDecision
        ? owner && { id: owner.id, text: owner.body, at: owner.at }
        : this.findQuoteSource(member.projectId, raw);
      if (failureDecision && !source) throw new ApiError(409, "같은 실패 세 번 이후 이 업무 또는 상위·하위 업무에서 대표가 정한 말을 인용해야 합니다");
      if (!source) throw new ApiError(409, "인용을 대표 글에서 찾지 못해 닫지 않았습니다. 대표가 정하지 않았으면 그대로 두세요");
      if (quoteNeedsContext({ text: raw, verified: true, source })) throw new ApiError(409, "버튼 글이나 아주 짧은 글은 이 결재를 정했다는 근거가 못 되어 닫지 않았습니다. 대표가 이 일을 정한 문장을 인용하세요");
      quote = normalizeSpace(raw);
      sourceId = source.id;
    }
    const followUp = input.followUp;
    if (followUp?.kind === "instruction") {
      const source = this.store.requireMessage(followUp.sourceMessageId);
      const target = this.store.requireMember(followUp.memberId);
      if (source.projectId !== member.projectId || !source.mine || target.projectId !== member.projectId || !followUp.text.trim()) throw new ApiError(400, "후속 지시의 대상·대표 원문·내용을 확인하세요");
      if (input.kind === "decided" && source.id !== sourceId) throw new ApiError(409, "후속 지시의 대표 원문이 닫기 근거와 다릅니다");
      this.refuseOwnerDirectRepeat(target, { text: input.userQuote ?? source.body, verified: true,
        source: { id: source.id, text: source.body, at: source.at } });
    }
    const closed = this.store.transaction(() => {
      const closed = this.store.closeDecision(decision.id, { kind: input.kind, reason, by: member.name, quote });
      if (followUp) {
        this.store.setDecisionFollowUp(decision.id, followUp);
        if (followUp.kind === "instruction") {
          const source = this.store.requireMessage(followUp.sourceMessageId);
          // 후속 지시는 닫은 결재 카드의 작업을 잇는다(카드가 전체면 대표 원문 글의 작업). 칩에서 시작한 일이 전체로 새지 않게 한다.
          const taskId = decision.taskId ?? source.taskId ?? null;
          // Validate after the verified close, in the same transaction. The
          // current failure card must not reject its own authorized follow-up.
          this.requireInstructionContract(member, taskId);
          const taskLine = this.instructionTaskLines(member.projectId, taskId);
          const delivery = this.store.enqueue({ projectId: member.projectId, memberId: followUp.memberId, kind: "instruction", text: [formatInstruction(member.name, `${followUp.text}\n결재 #${decision.id} 닫기의 후속 지시`, { text: input.userQuote ?? source.body, verified: true, source: { id: source.id, text: source.body, at: source.at } }), ...(taskLine ? [taskLine] : [])].join("\n"), taskId });
          this.store.noteDelegation(member.id, delivery, this.isBusy(this.store.requireMember(followUp.memberId)));
          this.store.afterCommit(() => { void this.pump(followUp.memberId); });
        }
      }
      return closed;
    });
    const why = `${reason}${sourceId ? ` (대표가 이미 정함, 대표 글 #${sourceId})` : ""}`;
    const asker = decision.memberId ? this.store.getMember(decision.memberId) : null;
    if (asker?.origin === "manual") this.wakeAll(this.askWaiters, decision.id);
    if (asker && asker.id !== member.id && asker.origin !== "manual") {
      await this.deliver({ projectId: decision.projectId, memberId: asker.id, kind: "system", text: formatSystem(`결재 #${decision.id} 가 닫혔습니다: ${why}. 질문 '${quotedInline(decision.title)}' 의 답은 오지 않습니다`), wake: false });
    }
    if (asker && asker.origin !== "manual") this.refreshWaiting(asker.id);
    // 직원이 스스로 닫았으면 총괄의 판도 맞춘다.
    const lead = this.store.getConductor(decision.projectId);
    if (lead && lead.id !== member.id && lead.id !== asker?.id) {
      await this.deliver({ projectId: decision.projectId, memberId: lead.id, kind: "system", text: formatSystem(`${josa(member.name, "이")} 결재 #${decision.id} 를 닫았습니다: ${why} (질문 '${quotedInline(decision.title)}')`), wake: false });
    }
    return closed;
  }

  /** todo_close. 대표의 할 일을 끝남·필요 없어짐으로 정리한다. 직원은 자기가 부탁한 할 일만. 부탁한 직원에게 깨우지 않고 알린다. */
  async closeTodo(member: Member, input: { id: string; outcome: TodoOutcome; reason: string }): Promise<Todo> {
    const todo = this.store.getTodo(input.id);
    if (!todo || todo.projectId !== member.projectId) throw new ApiError(404, `할 일을 찾을 수 없습니다: ${input.id}`);
    if (member.kind === "worker" && todo.memberId !== member.id) throw new ApiError(403, "직원은 자기가 부탁한 할 일만 정리할 수 있습니다");
    const reason = normalizeSpace(input.reason);
    const closed = this.store.closeTodo(todo.id, { outcome: input.outcome, reason, by: member.name });
    const label = input.outcome === "done" ? "끝남" : "필요 없어짐";
    const requester = todo.memberId ? this.store.getMember(todo.memberId) : null;
    if (requester && requester.id !== member.id) {
      // 대표가 체크를 풀면 '아직 안 했음'이 이 글을 바로잡도록 할 일에 잇는다.
      await this.deliver({ projectId: todo.projectId, memberId: requester.id, kind: "system", text: formatSystem(`${josa(member.name, "이")} 대표의 할 일 #${todo.id} 를 정리했습니다(${label}): ${reason} (할 일 '${quotedInline(todo.title)}')`), wake: false, refType: "todo", refId: todo.id });
    }
    const lead = this.store.getConductor(todo.projectId);
    if (lead && lead.id !== member.id && lead.id !== requester?.id) {
      await this.deliver({ projectId: todo.projectId, memberId: lead.id, kind: "system", text: formatSystem(`${josa(member.name, "이")} 대표의 할 일 #${todo.id} 를 정리했습니다(${label}): ${reason} (할 일 '${quotedInline(todo.title)}')`), wake: false });
    }
    return closed;
  }

  /** 대표가 AI 가 닫은 결재를 다시 연다. 결재할 항목으로 돌아가고, 물은 직원과 총괄에게 깨우지 않고 알린다. */
  async reopenDecision(decisionId: string): Promise<Decision> {
    const decision = this.store.requireDecision(decisionId);
    this.requireActive(this.store.requireProject(decision.projectId));
    if (decision.status !== "closed" || !decision.closeKind) throw new ApiError(409, "AI가 닫은 결재만 다시 열 수 있습니다");
    const reopened = this.store.reopenDecision(decisionId, `${josa(decision.closedBy ?? "AI", "이")} 닫았던 결재를 대표가 다시 열었습니다${decision.closeReason ? `(닫은 이유: ${normalizeSpace(decision.closeReason)})` : ""}`);
    const asker = decision.memberId ? this.store.getMember(decision.memberId) : null;
    const note = `대표가 결재 #${decision.id} 를 다시 열었습니다(질문 '${quotedInline(decision.title)}'). 닫은 것은 취소이며 답이 오면 전달됩니다`;
    if (asker && asker.origin !== "manual") {
      await this.deliver({ projectId: decision.projectId, memberId: asker.id, kind: "system", text: formatSystem(note), wake: false });
      const fresh = this.store.getMember(asker.id);
      if (fresh?.status === "idle" && !this.isBusy(fresh)) this.settle(fresh);
    }
    const lead = this.store.getConductor(decision.projectId);
    if (lead && lead.id !== asker?.id) await this.deliver({ projectId: decision.projectId, memberId: lead.id, kind: "system", text: formatSystem(note), wake: false });
    return this.store.requireDecision(reopened.id);
  }

  /** 대표가 다른 창에 있어도 결정할 일을 알게 한다. 설정에서 켠 때만. */
  notifyInbox(title: string, body: string): void {
    if (!this.notifier || !this.store.getSettings().notifyMac) return;
    this.notifier(`IAMCEO · ${normalizeSpace(title).slice(0, 60)}`, normalizeSpace(body).slice(0, 200));
  }

  setMemberStatus(member: Member, now: string, next?: string): Member {
    return this.store.patchMember(member.id, { now: normalizeSpace(now), ...(next !== undefined ? { next: normalizeSpace(next) } : {}) });
  }

  setProjectNow(projectId: string, text: string): Project {
    return this.store.patchProject(projectId, { now: text });
  }

  setWork(projectId: string, input: { id?: string; sec: WorkSec; title: string; detail?: string; who?: string; taskId?: string | null }): WorkItem {
    return this.store.upsertWork({ projectId, ...input });
  }

  // ---- 업무 단계(대표 2026-11-17 #4aab3546) ----
  /** 총괄에게 가는 보고 끝의 단계 줄. 납품 뒤 다음 차례가 보고와 함께 남아 추적이 끊기지 않게 한다. */
  private stageLine(taskId: string | null | undefined): string | null {
    if (!taskId) return null;
    const p = this.store.taskProgress(taskId);
    if (p.stage === "new") return null;
    const hint = p.stage === "delivered" || p.stage === "merge" || p.stage === "merged" || p.stage === "applied" || p.stage === "review"
      ? ` · 단계를 옮기면 task_stage(task_id "${taskId}")로 남긴다(검토 맡김 review · 메인 합침 merged · 대표 화면 반영 applied · 완료 done)` : "";
    return `업무 단계: ${STAGE_LABEL[p.stage]}${p.next ? ` · ${p.next}` : ""}${hint}`;
  }

  /** 보고 하나로 반복 감시를 옮긴다(같은 거래 안). 처음 멈추면 trip 을, 멈춘 뒤 같은 실패면 quiet 를 준다. */
  private watchReport(message: Message): { quiet: boolean; trip: string | null } {
    if (!message.taskId || (message.kind !== "막힘" && message.kind !== "완료")) return { quiet: false, trip: null };
    if (this.store.doneMark(message.taskId)) return { quiet: false, trip: null };
    const fact = this.store.reportFact(message.id);
    if (!fact) return { quiet: false, trip: null };
    const saved = this.store.getTaskWatch(message.taskId);
    let prev = saved;
    const correctsMessageId = this.store.getReportReferences(message.projectId, message.id)?.correctsMessageId ?? null;
    if (prev?.trippedAt && prev.same >= 3 && fact.kind === "막힘" && fact.authorKind === "worker"
      && !correctsMessageId && !prev.history.some(h => h.messageId === fact.id)) {
      const resolvedAt = this.store.taskFailureRetryAt(message.taskId, prev.trippedAt, fact);
      if (resolvedAt) {
        prev = watchOnReopen(prev, resolvedAt);
        this.store.resetWatchNotice(message.taskId);
      }
    }
    const { next, trip, quiet } = watchOnReport(prev, { ...fact, correctsMessageId }, { sameLimit: this.timings.loopSameLimit, idleMs: this.timings.loopIdleMs });
    if (next !== saved) this.store.saveTaskWatch(message.projectId, message.taskId, next);
    return { quiet, trip };
  }

  /** 멈춘 감시의 총괄 알림을 같은 거래 안에서 만든다. 감시 하나에 한 번(이미 보냈으면 null). */
  private watchNoticeDelivery(projectId: string, taskId: string, reason: string): Delivery | null {
    const conductor = this.store.getConductor(projectId);
    const w = this.store.getTaskWatch(taskId);
    // Owner escalation is independent of whether an awake lead can receive the
    // coordination notice. It is persisted atomically with the third failure.
    if (w?.trippedAt && w.same >= 3) this.store.ensureTaskFailureDecision(taskId);
    if (!conductor || !w || this.store.watchNoticeSent(taskId)) return null;
    const task = this.store.requireTask(taskId);
    const failed = [...new Set(w.history.flatMap((h) => h.failed))];
    const pending = w.fingerprint.startsWith("pending:") ? w.fingerprint.slice(8).split("|").filter(Boolean) : [];
    const delivery = this.store.enqueue({ projectId, memberId: conductor.id, kind: "system", text: `[시스템] ${watchNotice(task, w, reason, [...failed, ...pending])}\n작업 #${taskId}`, wake: true, taskId });
    this.store.claimWatchNotice(taskId, delivery.id);
    return delivery;
  }

  /** 시간 경계: 직원 쪽 단계에서 진척 없이 오래 지난 감시를 한 번 멈춘다. 대표·승인·보류 기다림은 세지 않는다. */
  checkTaskWatches(now = Date.now()): void {
    // Adopt unresolved pre-policy trips too, without replaying work or creating
    // duplicate cards on every restart/tick.
    for (const row of this.store.db.query("SELECT task_id,project_id FROM task_watch WHERE tripped_at IS NOT NULL AND same_count >= 3").all() as { task_id: string; project_id: string }[]) {
      if (!this.store.getProject(row.project_id)?.archived) this.store.ensureTaskFailureDecision(row.task_id);
    }
    const limits = { sameLimit: this.timings.loopSameLimit, idleMs: this.timings.loopIdleMs };
    for (const { taskId, projectId, watch } of this.store.listOpenTaskWatches()) {
      if (this.store.getProject(projectId)?.archived) continue;
      const reason = watchOnTick(watch, this.store.taskProgress(taskId).stage, now, limits);
      if (!reason) continue;
      const at = new Date(now).toISOString();
      const notice = this.store.transaction(() => {
        this.store.saveTaskWatch(projectId, taskId, { ...watch, trippedAt: at, reason, updatedAt: at });
        return this.watchNoticeDelivery(projectId, taskId, reason);
      });
      if (notice) void this.pump(notice.memberId);
    }
  }

  /** 미완료 업무를 총괄의 기존 대기열에 잇는다. 실행 중·승인·수동 조작·수신 불확실 상태는 깨우지 않는다. */
  checkTaskContinuations(now = Date.now()): Delivery[] {
    if (this.closed || this.recovering || this.switching || this.settingsWriting) return [];
    const deliveries = this.taskContinuations.check(now, member => {
      const project = this.store.requireProject(member.projectId);
      if (project.archived || !project.runnerEnabled || !project.connection.ok || this.archiving.has(project.id)) return false;
      if (member.origin !== "runner" || (!member.sessionId && !member.paneId) || !["idle", "waiting"].includes(member.status)) return false;
      const rt = this.runtime(member.id);
      if (rt.closing || rt.starting || rt.reopening || rt.pumping || rt.background || rt.stopRequest || this.isBusy(member)) return false;
      if (this.configWrites.has(member.id) || this.terminalMutations.has(member.id) || this.pendingLifecycle(member.id)) return false;
      if (this.inflightReportTools.get(member.id) || this.deferredReportChecks.has(member.id)) return false;
      if (this.store.inputState(member.id).lease || this.deliveryRecovery.fenced(member.id)) return false;
      if (this.store.listPendingExecutions().some(run => run.memberId === member.id && run.identity.sessionGeneration === this.store.memberRevisions(member.id).sessionGeneration)) return false;
      const observation = member.statusObservation;
      if (this.backendOf(member) === "core" && observation && (observation.ownership !== "verified" || observation.freshness !== "fresh")) return false;
      return true;
    });
    for (const memberId of new Set(deliveries.map(d => d.memberId))) void this.pump(memberId);
    return deliveries;
  }

  /** 완료 알림 본문: 무엇이 끝났는지와 근거, 남은 미검증. */
  private noticeLines(taskId: string, done: MarkFact): string[] {
    const task = this.store.requireTask(taskId);
    const facts = this.store.taskProgressFacts(task.projectId, new Set([taskId])).get(taskId);
    const contract = this.store.getEffectiveContract(taskId);
    const delivery = facts?.reports.findLast((r) => r.kind === "완료" && r.passed) ?? facts?.reports.findLast((r) => r.kind === "완료");
    const marks = this.store.listStageMarks(taskId);
    const merged = marks.findLast((m) => m.stage === "merged");
    const applied = marks.findLast((m) => m.stage === "applied");
    const unverified = delivery ? (this.store.getReportHarness(delivery.id)?.checks ?? []).filter((c) => c.kind === "unverified" || c.result === "not_run").map((c) => c.name) : [];
    const message = delivery ? this.store.getMessage(delivery.id) : null;
    // 대표가 읽는 글이라 내부 번호·커밋 id 는 뺀다(원래 근거는 단계 표시에 그대로 남는다).
    const plain = (text: string) => text.replace(/\s*#?\b(?:msg|tk|dl|tn|f|dc|td)_[\w-]+/g, "").replace(/\s*\b[0-9a-f]{7,40}\b/gi, "").replace(/\s+/g, " ").trim() || "확인함";
    return [
      `${task.title} 완료`,
      ...(contract && bindingContract(contract) ? [`계약 r${contract.rev} 기준`] : []),
      ...(message ? [`완료 보고: ${message.who} '${message.title.replace(/^\(직접\) /, "")}'`] : []),
      ...(merged ? [`메인 합침: ${plain(merged.evidence)}`] : []),
      ...(applied ? [`대표 화면 반영: ${plain(applied.evidence)}`] : []),
      done.memberId ? `완료 판단: ${done.who} · ${plain(done.evidence)}` : "완료 기준: 계약·브랜치가 없는 업무라 완료 보고로 끝났습니다",
      ...(unverified.length ? [`미검증: ${unverified.slice(0, 4).join(", ")}${unverified.length > 4 ? ` 외 ${unverified.length - 4}건` : ""}`] : []),
    ];
  }

  /**
   * 총괄의 단계 표시. 단계는 근거에서 계산하므로 여기서는 기록만 남긴다(지우지 않는다).
   * - merged 는 커밋 id(7~40자 16진)를 근거에 적어야 받는다. applied 는 merged 뒤에만 받는다.
   * - done 은 열린 결재·할 일·승인 창·고칠 것이 없고, 묶이는 계약이면 지금 판의 통과 완료가 있어야 받는다. 코딩 계약·브랜치 업무는 merged 표시도 있어야 한다.
   * - 이미 완료인 업무에 done 을 다시 부르면(응답 유실 재시도) 새 표시·알림 없이 같은 결과를 돌려준다.
   * - reopen 은 완료·보류·반복 감시 멈춤을 푼다. 감시의 시작 시각·시도 수·기록은 남는다.
   */
  markTaskStage(member: Member, input: { taskId: string; stage: MarkFact["stage"]; evidence: string }): { mark: MarkFact; progress: TaskProgress; noticeId: string | null; repeated: boolean } {
    const task = this.store.resolveTask(this.requireTaskInProject(member, input.taskId));
    const pendingFailure = input.stage === "reopen" ? this.store.pendingTaskFailureDecision(task.id) : null;
    if (pendingFailure) throw new ApiError(409, `같은 실패 세 번의 결재 #${pendingFailure.id} 에 대표 답이 필요합니다. 결재함에서 재개 조건을 정한 뒤 다시 열 수 있습니다`);
    const evidence = normalizeSpace(cleanText(input.evidence));
    if (!evidence) throw new ApiError(400, "evidence 에 근거를 적어 주세요(보고 id·커밋·확인한 화면 등)");
    return this.store.transaction(() => {
      const before = this.store.taskProgress(task.id);
      const done = this.store.doneMark(task.id);
      if (input.stage !== "reopen" && done) {
        if (input.stage === "done") {
          const notice = this.store.createTaskNotice(task.projectId, task.id, done.id, this.noticeLines(task.id, done));
          return { mark: done, progress: before, noticeId: notice.id, repeated: true };
        }
        throw new ApiError(409, "이미 완료된 업무입니다. 다시 열려면 stage reopen 과 까닭을 남기세요");
      }
      const marks = this.store.listStageMarks(task.id);
      let from = 0;
      marks.forEach((m, i) => { if (m.stage === "reopen") from = i + 1; });
      const active = marks.slice(from);
      if (input.stage === "merged" && !/\b[0-9a-f]{7,40}\b/i.test(evidence)) throw new ApiError(400, "merged 는 메인에 합친 커밋 id 를 evidence 에 적어야 합니다");
      if (input.stage === "applied" && !active.some((m) => m.stage === "merged")) throw new ApiError(409, "대표 화면 반영은 메인 합침(merged) 표시 뒤에만 남깁니다");
      if (input.stage === "done") {
        const refuse = this.doneRefusal(task, before, active);
        if (refuse) throw new ApiError(409, refuse);
      }
      const mark = this.store.addStageMark({ projectId: task.projectId, taskId: task.id, stage: input.stage, evidence, memberId: member.id, who: member.name });
      if (input.stage === "reopen") {
        const w = this.store.getTaskWatch(task.id);
        if (w) this.store.saveTaskWatch(task.projectId, task.id, watchOnReopen(w, mark.at));
        this.store.resetWatchNotice(task.id);
        // Reopening the encompassing work also starts a new episode for its
        // resolved failure scopes. Otherwise their old trip would suppress the
        // next three failures forever. Unrelated and still-pending scopes stay.
        const tasks = new Map(this.store.listTasks(task.projectId).map(t => [t.id, t]));
        for (const id of tasks.keys()) {
          if (id === task.id || !relatedWork(id, task.id, tasks)) continue;
          const watch = this.store.getTaskWatch(id);
          if (!watch?.trippedAt || watch.same < 3 || this.store.doneMark(id) || this.store.pendingTaskFailureDecision(id)) continue;
          this.store.saveTaskWatch(task.projectId, id, watchOnReopen(watch, mark.at));
          this.store.resetWatchNotice(id);
        }
      }
      const notice = input.stage === "done" ? this.store.createTaskNotice(task.projectId, task.id, mark.id, this.noticeLines(task.id, mark)) : null;
      return { mark, progress: this.store.taskProgress(task.id), noticeId: notice?.id ?? null, repeated: false };
    });
  }

  private doneRefusal(task: Task, p: TaskProgress, active: MarkFact[]): string | null {
    // Display precedence is not a completion gate. Inspect every independent blocker.
    const scope = this.store.taskCompletionScope(task.id);
    const allFacts = this.store.taskProgressFacts(task.projectId, new Set(scope));
    for (const id of scope) {
      const f = allFacts.get(id);
      const prefix = id === task.id ? "" : "파생 업무에 ";
      const pending = this.store.pendingTaskFailureDecision(id);
      if (pending) return `${prefix}같은 실패 세 번의 대표 판단이 남았습니다. 결재함 #${pending.id} 에서 답을 받은 뒤 완료로 옮깁니다`;
      if (f?.decisions.length || f?.todos.length) return `${prefix}대표 차례가 남았습니다. 열린 결재·할 일이 닫힌 뒤 완료로 옮깁니다`;
      if (f?.approvals.length) return `${prefix}터미널 승인 창이 열려 있습니다. 끝난 뒤 완료로 옮깁니다`;
      if (this.store.hasUnsettledTaskInput(id)) return `${prefix}미처리 입력이 남았습니다. 전달·보호 상태를 확인한 뒤 완료로 옮깁니다`;
      if (f?.watch?.trippedAt) return `${prefix}반복 감시 점검이 남았습니다. 원인을 확인하고 다시 연 뒤 완료로 옮깁니다`;
      if (f?.marks.at(-1)?.stage === "hold") return `${prefix}보류한 일이 있습니다. 다시 열고 남은 조건을 확인한 뒤 완료로 옮깁니다`;
      const from = f?.marks.findLast(m => m.stage === "reopen")?.at;
      const outcome = f?.reports.findLast(r => (!from || r.at >= from) && (r.kind === "완료" || r.kind === "막힘"));
      if (outcome && (outcome.kind === "막힘" || outcome.failed.length || outcome.notRun.length || !outcome.passed)) return `${prefix}고칠 것 또는 미확인 검사가 남았습니다. 최신 검사·검토 결과를 확인한 뒤 완료로 옮깁니다`;
    }
    const facts = allFacts.get(task.id);
    const reopenedAt = facts?.marks.findLast(m => m.stage === "reopen")?.at;
    const latest = facts?.reports.findLast(r => (!reopenedAt || r.at >= reopenedAt) && (r.kind === "완료" || r.kind === "막힘"));
    const contract = this.store.getEffectiveContract(task.id);
    if (!bindingContract(contract)) return "확정된 완료 기준이 없습니다. 총괄이 계약을 정하거나 직원 제안을 확인하고, 현재 기준의 검증 결과를 받은 뒤 완료로 옮깁니다";
    // 총괄 승계 완료는 독립 근거가 아니다. 계약 판정을 받은 정정되지 않은 검사 완료가 있어야 한다(갈래 업무의 완료 포함).
    if (!this.store.hasPassedCompletion(contract!.taskId, contract!.rev)) return `계약 r${contract!.rev} 의 통과 완료 보고가 없습니다. 작성자 납품을 먼저 받습니다`;
    if (contract!.kind === "coding" && !active.some((m) => m.stage === "merged")) return "코딩 계약은 메인 합침(merged) 표시가 먼저 있어야 완료로 옮깁니다";
    if ((task.branch || task.worktree) && !active.some((m) => m.stage === "merged")) {
      return "브랜치 업무는 메인 합침(merged) 표시가 먼저 있어야 완료로 옮깁니다. 합치지 않고 접을 일이면 hold 로 남깁니다";
    }
    const latestMerge = active.findLast(m => m.stage === "merged");
    const latestApplied = active.findLast(m => m.stage === "applied");
    if ((task.branch || task.worktree || bindingContract(contract) && contract!.kind === "coding") && (!latestApplied || latestApplied.id < (latestMerge?.id ?? 0))) {
      return "코딩·브랜치 업무는 실제 적용 확인(applied) 근거가 있어야 완료로 옮깁니다. 메인에 합친 것만으로 실제 반영을 완료 처리하지 않습니다";
    }
    if (!latest) return "완료 보고가 없습니다. 수행·검증 결과를 받은 뒤 완료로 옮깁니다";
    return null;
  }

  /** 직접 띄운 CLI 의 wait. 밀린 지시를 한 글로 묶어 돌려준다. 없으면 null. */
  async waitInbox(member: Member, timeoutMs: number, signal?: AbortSignal): Promise<string | null> {
    if (signal?.aborted) return null;
    const first = this.takeInbox(member);
    if (first) return first;
    await this.waitOn(this.inboxWaiters, member.id, timeoutMs, signal);
    // 끊긴 연결로 응답을 보내면 지시가 받은 것으로 표시된 채 사라진다.
    if (signal?.aborted) return null;
    return this.takeInbox(member);
  }

  private materializeManualAnswers(member: Member): void {
    if (this.store.requireProject(member.projectId).archived || this.archiving.has(member.projectId)) return;
    this.store.transaction(() => {
      for (const decision of this.store.listUnreceivedAnswers(member.id)) {
        if (!this.store.listDeliveries(member.projectId).some(d => d.refType === "decision" && d.refId === decision.id && d.memberId === member.id)) this.store.enqueue({ projectId: member.projectId, memberId: member.id, kind: "answer", text: formatAnswer(decision), refType: "decision", refId: decision.id });
      }
    });
  }

  async manualInbox(memberId: string, timeoutMs: number, signal?: AbortSignal): Promise<ManualInboxBatch | null> {
    const take = () => {
      const member = this.store.requireMember(memberId);
      if (member.origin !== "manual") throw new ApiError(409, "직접 띄운 직원만 수신함을 사용할 수 있습니다");
      if (signal?.aborted || this.store.requireProject(member.projectId).archived || this.archiving.has(member.projectId)) return null;
      this.materializeManualAnswers(member);
      return this.store.manualInbox(memberId, this.pendingInputs(memberId).map(d => d.id));
    };
    if (signal?.aborted) return null;
    const first = take();
    if (first) return first;
    await this.waitOn(this.inboxWaiters, memberId, Math.min(Math.max(timeoutMs, 0), 50_000), signal);
    return take();
  }

  async acknowledgeManualInbox(memberId: string, request: ManualInboxAckRequest): Promise<ManualInboxAckResult> {
    const member = this.store.requireMember(memberId);
    this.requireActive(this.store.requireProject(member.projectId));
    if (member.origin !== "manual") throw new ApiError(409, "직접 띄운 직원만 수신함을 사용할 수 있습니다");
    const result = this.store.acknowledgeManualInbox(memberId, request.batchId);
    this.reconcileTodoCorrections();
    for (const item of this.store.getManualInboxBatch(memberId, request.batchId)!.items) if (item.ref?.type === "decision") this.wakeAll(this.askWaiters, item.ref.id);
    return result;
  }

  /** v1 compatibility: delivery and ACK are inseparable in the old string response. */
  private takeInbox(member: Member): string | null {
    if (this.store.requireProject(member.projectId).archived || this.archiving.has(member.projectId)) return null;
    this.materializeManualAnswers(member);
    const batch = this.store.manualInbox(member.id, this.pendingInputs(member.id).map(d => d.id));
    if (!batch) return null;
    this.store.acknowledgeManualInbox(member.id, batch.id);
    this.reconcileTodoCorrections();
    return batch.items.map(item => item.text).join("\n\n");
  }

  private waitOn(table: Map<string, Set<() => void>>, key: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise((done) => {
      if (this.closed || signal?.aborted) return done();
      const waiters = table.get(key) ?? new Set<() => void>();
      table.set(key, waiters);
      const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        waiters.delete(finish);
        if (waiters.size === 0 && table.get(key) === waiters) table.delete(key);
        done();
      };
      const timer = setTimeout(finish, timeoutMs);
      signal?.addEventListener("abort", finish, { once: true });
      waiters.add(finish);
    });
  }

  private wakeAll(table: Map<string, Set<() => void>>, key: string): void {
    for (const wake of [...(table.get(key) ?? [])]) wake();
  }

  // ---- 전달 펌프 ----
  private async deliver(input: NewDelivery): Promise<Delivery> {
    const delivery = this.store.enqueue(input);
    await this.pump(input.memberId);
    return this.store.getDelivery(delivery.id) ?? delivery;
  }

  /** 직원마다 한 번에 하나만 돈다. 도는 중에 다시 불리면 끝나고 한 번 더 돈다. */
  pump(memberId: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    const rt = this.runtime(memberId);
    if (rt.pumping) {
      rt.again = true;
      return rt.pumping;
    }
    rt.pumpSince = Date.now(); rt.pumpStage = "start"; rt.pumpReported = false;
    rt.pumping = (async () => {
      try {
        do {
          rt.again = false;
          await this.pumpOnce(memberId);
        } while (rt.again && !this.closed);
      } catch (e) {
        const turn = rt.turn;
        if (turn && !this.store.listPendingExecutions().some(run => run.memberId === memberId)) rt.turn = null;
        this.releaseSlots();
        console.error("전달 펌프 오류:", memberId, e);
      } finally {
        rt.pumping = null; rt.pumpStage = null; rt.pumpSince = null;
      }
    })();
    return rt.pumping;
  }

  /** Protected history stays visible, but cannot be included in a new input envelope. */
  private pendingInputs(memberId: string): Delivery[] {
    return this.admittedInputs(memberId, this.store.listPending(memberId));
  }

  /** Recheck persisted delegation policy both before preparation and immediately
   * before terminal writes. Criteria requests are scheduled separately. */
  private instructionCriteriaAllow(delivery: Delivery): boolean {
    return this.store.unconfirmedDelegatedTask(delivery.id) === null;
  }

  private admittedInputs(memberId: string, deliveries: Delivery[]): Delivery[] {
    const worker = this.store.requireMember(memberId).kind === "worker";
    const blocked = new Map<string, boolean>();
    return deliveries.filter(d => {
      if (!ordinaryInputAdmitted(this.store, d.id)) return false;
      // Recheck at envelope preparation too: a human instruction, completion,
      // or user stop may have superseded this reminder while it waited.
      if (!this.taskContinuations.canDispatch(d)) return false;
      if (!this.instructionCriteriaAllow(d)) return false;
      const taskId = this.store.deliveryTaskId(d.id);
      if (!worker || !taskId) return true;
      // An independent order exception never resolves a failure decision.
      if (this.store.pendingTaskFailureDecision(taskId)) return false;
      if (!blocked.has(taskId)) blocked.set(taskId, this.store.taskSequenceBlocker(memberId, taskId) !== null);
      return !blocked.get(taskId) || independentDeliveryAuthorized(this.store, d);
    });
  }

  private async pumpOnce(memberId: string): Promise<void> {
    let member = this.store.getMember(memberId);
    if (!member) return;
    if (member.origin === "manual") {
      const pending = this.pendingInputs(memberId);
      if (pending.some((d) => d.wake) || this.store.listUnreceivedAnswers(memberId).length > 0) {
        this.wakeAll(this.inboxWaiters, memberId);
      }
      // 서버가 넣어 줄 수 없는 세션이다. 왜 안 가는지 화면에 보여 준다.
      for (const d of pending) {
        if (d.refType === "message" && d.refId && !this.store.getMessage(d.refId)?.deliveryNote) {
          this.store.setMessageDelivery(d.refId, "queued", `${member.name}이 wait 를 부르면 전달됩니다`);
        }
      }
      return;
    }
    const project = this.store.requireProject(member.projectId);
    let pending = this.pendingInputs(memberId);
    if (this.runners.has("core") && member.backend && member.backend !== "core" && (member.sessionId || member.paneId)) {
      for (const d of pending) this.hold(d, "legacy_session");
      return;
    }
    // Previously attempted entries must be inspected, including legacy held rows.
    for (const d of pending) if (d.attempts > 0 && !this.deliveryRecovery.requeueRejected(d.id) && this.store.getDeliveryRecovery(d.id)?.phase === "none") this.deliveryRecovery.beginRecovery(d.id);
    pending = this.pendingInputs(memberId);
    if (this.recovering || this.configWrites.has(memberId) || this.terminalMutations.has(memberId) || this.pendingLifecycle(memberId)) return;
    if (this.store.inputState(memberId).lease) { this.deferCoreCompact(member, "manual_control"); return; }
    // Expiry/replacement can be discovered by the runner/store before the socket timer.
    // Fence every delivery until old control attaches have detached and restored core.
    if (member.backend === "core" && this.terminalLeaseListeners.size) {
      await Promise.all([...this.terminalLeaseListeners].map(ended => ended(memberId, null)));
    }
    if (this.terminalMutations.has(memberId) || this.store.inputState(memberId).lease) return;
    if (member.backend === "core" && member.statusObservation && member.statusObservation.ownership !== "verified" && !(member.status === "offline" && member.statusObservation.error?.code === "no_owned_terminal")) return;
    if (member.backend === "core" && this.store.listPendingExecutions().some(run => run.memberId === memberId && run.identity.sessionGeneration === this.store.memberRevisions(memberId).sessionGeneration) && !this.runtime(memberId).turn) return;
    if (this.deliveryRecovery.fenced(memberId)) return;
    const rt = this.runtime(memberId);
    this.reconcileCoreCompact(member);
    if (this.coreCompactFenced(member)) return;
    if (rt.closing) return; // 닫는 중에 다시 열면 명부 밖 칸이 남는다.
    if (this.switching || this.settingsWriting) return; // 설정 적용이 끝나면 다시 민다.
    if (rt.starting) return; // 다 뜨면 다시 민다.
    const due = this.retryDue(member);
    if (Date.now() < Math.max(rt.holdUntil, due)) {
      this.scheduleRetry(memberId, rt, Math.max(rt.holdUntil, due));
      return;
    }

    // 보관 중에는 아무도 깨우지 않는다. 꺼낼 때 onProjectPatched 가 다시 민다.
    if (project.archived || this.archiving.has(project.id)) {
      for (const d of pending) if (d.status === "queued") this.hold(d, "archived");
      return;
    }
    if (!project.runnerEnabled) {
      for (const d of pending) this.hold(d, "runner_disabled");
      return;
    }
    // 세션이 없거나 잠들었으면 새로 연다: 전역 실행 방식을 따른다. 살아 있는 세션은 시작한 실행기로 계속 다룬다.
    const opening = member.status === "asleep" || member.status === "offline" || (!member.sessionId && !member.paneId);
    let runner = this.runners.get(opening ? this.store.effectiveBackend() : this.backendOf(member));
    if (!runner) {
      for (const d of pending) this.hold(d, "backend_down");
      return;
    }

    if (member.status === "asleep" || member.status === "offline") {
      // 잠들 때 보류된 것만 있으면 깨우지 않는다. 새 깨움이 와야 함께 나간다.
      const wakes = pending.some((d) => d.wake && !(d.status === "held" && d.holdReason === "asleep"));
      if (!wakes) return;
      rt.pumpStage = "reopen";
      const reopened = await this.reopen(member);
      if (!reopened) {
        for (const d of pending) this.hold(d, member.status === "offline" ? "offline" : "backend_down");
        return;
      }
      member = reopened;
      runner = this.runnerOf(member);
      this.checkAwakeLimit(member.projectId);
    }

    // 턴 도중 승인 창에 걸려도 보류로 보여 준다. isBusy 보다 먼저 본다(§6).
    if (member.status === "blocked") {
      this.deferCoreCompact(member, "blocked");
      for (const d of pending) this.hold(d, "blocked");
      return;
    }
    if (this.isBusy(member)) {
      this.deferCoreCompact(member, "working");
      const urgent = pending.filter((d) => d.urgent);
      // headless 는 돌고 있는 턴에 끼워 넣을 수 없다. 끝나면 묶어서 나간다.
      if (urgent.length > 0 && runner.kind !== "headless") { rt.pumpStage = "send_urgent"; await this.sendUrgent(member, project, runner, urgent); }
      return;
    }

    // 쉬는 동안 바뀐 설정을 먼저 맞춘다. 일을 넣고 나면 턴이 끝날 때까지 못 맞춘다.
    if (runner.applyConfig && this.configPending(member)) {
      rt.pumpStage = "sync_config";
      if (!(await this.syncConfig(member, project, runner, rt))) return;
      member = this.store.requireMember(memberId);
    }

    // 띄울 때와 도구 목록이 다르면(기억 연결 등) 일을 넣기 전, 쉬는 지금 같은 대화로 이어 다시 연다. 일하는 세션은 위에서 이미 돌아갔다.
    const toolsWant = pending.some((d) => d.wake) ? this.toolsPending(member) : null;
    if (toolsWant) {
      rt.pumpStage = "refresh_tools";
      const refreshed = await this.refreshSession(member, toolsWant);
      if (refreshed === null) {
        for (const d of this.store.listPending(memberId)) this.hold(d, "backend_down");
        return;
      }
      if (refreshed !== "kept") {
        member = refreshed;
        runner = this.runnerOf(member);
      }
    }

    // 새 일(대표 글·총괄의 위임)을 넣기 전에 관련 기억을 찾아 같은 묶음에 넣는다. 실패·없음도 사실대로 적는다.
    // 기억을 쓰지 않는 프로젝트는 기다림 없이 그대로 넘긴다(await 하나도 전달 순서·시각을 바꾼다).
    if (this.devMemory && this.memoryEnabledFor(member) && pending.some((d) => d.wake)) {
      rt.pumpStage = "memory_search";
      await this.attachMemoryContext(member, pending);
    }

    const hasWake = pending.some((d) => d.wake);
    if (!hasWake && rt.compactRequest === null) {
      for (const d of pending) if (d.status === "held") this.requeue(d);
      return;
    }

    // 상한 검사와 자리 잡기(rt.turn) 사이에 await 가 끼면 상한을 넘을 수 있어 세션부터 마련한다.
    if (!member.sessionId && !member.paneId) {
      let failure: Error | null = null;
      const current = member;
      runner = this.openRunner(current);
      const started = (async () => {
        try {
          const sent = this.desiredConfig(current);
          const result = await this.startManaged(current, project, false);
          this.applyStarted(current.id, project, result, sent);
        } catch (e) {
          failure = e as Error;
        } finally {
          rt.starting = null;
        }
      })();
      rt.starting = started;
      rt.pumpStage = "start_session";
      await started;
      if (failure) {
        this.store.patchMember(member.id, { lastError: (failure as Error).message });
        for (const d of pending) this.hold(d, "backend_down");
        return;
      }
      member = this.store.requireMember(member.id);
    }

    if ((runner.kind === "headless" || runner.kind === "core") && !this.hasAutomaticCapacity(member)) {
      this.waiting.add(memberId);
      for (const d of pending) if (d.status === "held") this.requeue(d);
      return;
    }

    const compactAt = this.store.getSettings().compactAtPct;
    const state = runner.kind === "core" ? this.store.getContextState(memberId) : null;
    const measurement = state?.measurement;
    const exact = measurement?.fresh && measurement.quality === "exact" && measurement.sessionId === member.sessionId &&
      measurement.sessionGeneration === this.store.memberRevisions(memberId).sessionGeneration && measurement.turn !== null &&
      state?.baseline?.completedTurn === measurement.turn && state.baseline.autoTurn !== measurement.turn &&
      state.baseline.configRevision === this.store.memberRevisions(memberId).configRevision;
    const autoCompact = hasWake && !rt.skipCompact && member.contextPct !== null && member.contextPct >= compactAt && (runner.kind !== "core" || exact);
    if (autoCompact && runner.kind === "core") this.queueCoreCompact(member, "auto", this.compactFocus(member));
    if (rt.compactRequest !== null || autoCompact) {
      rt.pumpStage = "compact";
      await this.beginCompact(member, project, runner, rt, rt.compactRequest ?? this.compactFocus(member));
      return;
    }
    if (!hasWake) return;

    const turn: Turn = { kind: "work", admitted: runner.kind === "headless" || runner.kind === "core", text: "", interrupted: false };
    rt.turn = turn;
    if (rt.wantParallel !== null) {
      rt.pumpStage = "parallel";
      const go = await this.applyParallel(member, project, runner, rt, this.pendingInputs(memberId));
      if (!go || this.store.requireMember(memberId).status === "asleep") {
        rt.turn = null;
        this.releaseSlots();
        return;
      }
    }

    const fresh = this.pendingInputs(memberId);
    if (!fresh.some(d => d.wake) || this.retryDue(member) > Date.now()) {
      rt.turn = null;
      this.releaseSlots();
      return;
    }
    // 병렬 설정을 기다리는 동안 상한이 바뀔 수 있다. 예약한 자기 자리만 빼고 전달 직전에 다시 검사한다.
    if (turn.admitted && !this.hasAutomaticCapacity(member, true)) {
      rt.turn = null;
      this.releaseSlots();
      this.waiting.add(memberId);
      for (const d of fresh) if (d.status === "held") this.requeue(d);
      return;
    }
    const ordered = orderForBundle(fresh);
    turn.text = ordered.map((d) => d.text).join("\n\n");
    rt.posted = false;
    rt.delegated = false;
    if (ordered.some(isTidy)) {
      const review = this.store.getBoardReview(project.id) ?? this.store.requestBoardReview(project.id);
      turn.boardReview = { requestedRevision: review.requestedRevision, reviewedRevision: null };
    }
    rt.direct = ordered.some((d) => d.kind === "user_message" && d.text.startsWith("[대표 직접]"));
    turn.deliveries = ordered;
    const current = this.store.requireMember(memberId);
    const sender = runner;
    const sentConfig = this.desiredConfig(current);
    let result: SendResult;
    rt.pumpStage = "send";
    try { result = await this.sendEnvelope(current, project, sender, ordered, false); }
    catch (error) {
      if (rt.turn === turn) rt.turn = null;
      this.releaseSlots();
      throw error;
    }
    if (!result.ok) {
      if (rt.turn === turn) rt.turn = null;
      if (["not_written", "rejected"].includes(result.deliveryEffect ?? "unknown")) this.onSendFailed(member, rt, ordered.filter(d => this.store.getDeliveryRetry(d.id).retryReason !== "rejected_limit"), result);
      this.releaseSlots();
      return;
    }
    rt.inputBusySince = null;
    // headless 는 턴마다 인자를 새로 정한다. 방금 나간 인자가 곧 지금 설정이다.
    if (!sender.applyConfig && this.store.getMember(memberId)) this.store.setAppliedConfig(memberId, sentConfig);
    this.store.appendActivity(memberId, "turn_start", normalizeSpace(turn.text).slice(0, 300));
    // 아주 빠른 턴은 send 가 돌아오기 전에 끝날 수 있다. 그때는 이미 정리되어 있다.
    if (rt.turn === turn && this.store.requireMember(memberId).status !== "asleep") this.store.patchMember(memberId, { status: "working", lastError: null });
  }

  /** 이 직원의 세션에 들어가 있어야 할 설정. */
  private desiredConfig(member: Member): AppliedConfig {
    const { ranks, codexRanks } = this.store.getSettings();
    const { model, effort } = memberConfig(member, ranks, codexRanks);
    const staff = staffSubagent(member.cli, ranks, codexRanks);
    return { model, effort, staffModel: staff.subagentModel, staffEffort: staff.subagentEffort, toolsSig: this.toolSignature(member) };
  }

  /**
   * 이 직원에게 지금 보일 도구와 역할 글의 지문. CLI 는 세션을 열 때 이 설정을 받으므로,
   * 도구나 기본·사용자 정의 역할이 바뀌면 쉬는 틈에 다시 받는다. 도구 모듈을 아직 읽지 않았으면 null.
   */
  private toolSignature(member: Member): string | null {
    if (!this.agentTools) return null;
    const tools = this.agentTools.listAgentTools(member, { memory: this.memoryEnabledFor(member) });
    const rules = this.rulesFor(member, this.store.requireProject(member.projectId));
    return createHash("sha256").update(JSON.stringify({ tools, rules })).digest("hex").slice(0, 16);
  }

  /**
   * 쉬는 세션이 띄울 때와 다른 도구·역할 글을 갖고 있는가. 서버가 띄운 core 세션만 본다(넘겨받은·직접 띄운 칸은 대표의 것).
   * 지문이 없는 옛 총괄도 필수 조정 규칙을 받는다. 다른 옛 세션은 기억 도구가 새로 붙을 때 연다. 같은 대화의 세션 id 가 있어야 한다.
   */
  private toolsPending(member: Member): string | null {
    if (member.origin !== "runner" || member.backend !== "core" || !member.sessionId || member.status === "asleep" || member.status === "offline") return null;
    const want = this.toolSignature(member);
    if (!want || this.runtime(member.id).toolsGaveUp === want) return null;
    const have = this.store.getAppliedConfig(member.id)?.toolsSig ?? null;
    if (have === want) return null;
    if (have === null && member.kind !== "conductor" && !this.memoryEnabledFor(member)) return null;
    return want;
  }

  /**
   * 쉬는 세션을 끝내고 같은 대화(--resume·codex resume)로 다시 연다. 새 도구 목록과 지금 규칙을 받는다. 일하는 중에는 부르지 않는다.
   * 끝내기에 실패하면 옛 세션 그대로 일을 잇고 같은 지문으로는 다시 시도하지 않는다. 이어 열기가 실패하면 다음 전달 때 다시 연다.
   */
  private async refreshSession(member: Member, want: string): Promise<Member | null | "kept"> {
    const rt = this.runtime(member.id);
    if (rt.closing || rt.starting || rt.reopening) return "kept";
    rt.closing = true;
    try {
      await this.stopManaged(member, "sleep", false);
      this.store.transaction(() => {
        this.store.patchMember(member.id, { status: "asleep", subagents: 0, paneId: null });
        this.confirmStop(member.id);
      });
    } catch (e) {
      rt.toolsGaveUp = want;
      this.store.appendActivity(member.id, "error", `도구 목록을 새로 받으려고 세션을 다시 열지 못해 지금 세션으로 잇습니다: ${(e as Error).message.slice(0, 300)}`);
      return "kept";
    } finally { rt.closing = false; }
    const reopened = await this.reopen(this.store.requireMember(member.id));
    if (reopened) this.store.appendActivity(member.id, "system", "도구 목록·규칙이 바뀌어 쉬는 틈에 같은 대화로 이어 다시 열었습니다");
    return reopened;
  }

  /** 서버가 띄운 세션이 지금 설정과 다른가. 넘겨받은 세션은 대표가 쓰던 칸이라 스스로 닫지 않는다(깨울 때 맞춰진다). 잠든 세션은 깨울 때 맞춰진다. */
  private configPending(member: Member): boolean {
    if (member.origin !== "runner" || (!member.sessionId && !member.paneId) || member.status === "asleep" || member.status === "offline") return false;
    if (!this.runners.get(this.backendOf(member))?.applyConfig) return false;
    const want = this.desiredConfig(member);
    if (this.runtime(member.id).configGaveUp === JSON.stringify(want)) return false;
    const have = this.store.getAppliedConfig(member.id);
    return want.model !== (have?.model ?? null) || want.effort !== (have?.effort ?? null) || want.staffModel !== (have?.staffModel ?? null) || want.staffEffort !== (have?.staffEffort ?? null);
  }

  /** 쉬는 세션을 새 설정으로 다시 연다. 이번 전달을 그대로 이어가도 되면 true. */
  private async syncConfig(member: Member, project: Project, runner: Runner, rt: Runtime): Promise<boolean> {
    const want = this.desiredConfig(member);
    if (runner.kind === "core") {
      try {
        await this.switchProvider(member, { cli: member.cli }, true);
        return true;
      } catch (e) {
        this.store.patchMember(member.id, { lastError: `설정 적용 보류: ${(e as Error).message}` });
        return false;
      }
    }
    const held = rt.turn;
    const control: Turn = { kind: "control", admitted: false, text: "", interrupted: false };
    rt.turn = control;
    const result = await this.safeSend(() => runner.applyConfig!(this.runnerMember(member, project), this.writeRunFiles(member, project, true)));
    if (rt.turn === control) rt.turn = held;
    if (!this.store.getMember(member.id)) return false;
    if (result.ok) {
      rt.configFails = 0;
      this.store.setAppliedConfig(member.id, want);
      this.store.appendActivity(member.id, "system", `새 설정으로 다시 열었습니다: 모델 ${want.model ?? "기본"}, effort ${want.effort ?? "기본"}`);
      // 병렬은 세션에만 있는 값이라 다시 열면 풀린다. 다음 일 전에 되살린다.
      if (member.parallel) {
        this.store.patchMember(member.id, { parallel: false });
        rt.wantParallel ??= true;
      }
      return true;
    }
    switch (result.reason) {
      case "busy":
      case "input_busy":
        // 선택 창이 떠 있는 등 입력칸을 못 찾았다(남은 글은 실행기가 지운다). 닫힐 때까지 기다린다.
        this.retryLater(member.id, rt, this.timings.inputBusyRetryMs);
        return true;
      case "gone":
        this.store.patchMember(member.id, { status: "offline", paneId: null });
        rt.again = true;
        return false;
      case "error": {
        rt.configFails++;
        const detail = result.detail ?? "알 수 없는 오류";
        if (rt.configFails < MAX_TURN_ERROR_ATTEMPTS) {
          this.retryLater(member.id, rt, this.timings.retryMs);
          return true;
        }
        // 일을 영영 막지는 않는다. 어떤 값으로 도는지는 활동에 남긴다.
        rt.configFails = 0;
        rt.configGaveUp = JSON.stringify(want);
        this.store.appendActivity(member.id, "error", `새 설정을 적용하지 못했습니다: ${detail}`);
        return true;
      }
      default:
        return true;
    }
  }

  private async sendUrgent(member: Member, project: Project, runner: Runner, urgent: Delivery[]): Promise<void> {
    await this.sendEnvelope(member, project, runner, orderForBundle(urgent), true);
  }

  /** Commit the exact envelope before I/O; all ambiguous results belong to recovery. */
  private async sendEnvelope(member: Member, project: Project, runner: Runner, deliveries: Delivery[], urgent: boolean): Promise<SendResult> {
    deliveries = this.admittedInputs(member.id, deliveries);
    if (project.archived || this.archiving.has(project.id) || this.coreCompactFenced(member) || !deliveries.length || this.deliveryRecovery.fenced(member.id)) return { ok: false, reason: "busy", retryable: false, deliveryEffect: "not_written" };
    // Retain which permission admitted this envelope. A later reparenting can
    // remove the row blocker, but must not discard the review used for this write.
    const independentIds = new Set(member.kind === "worker" ? deliveries.filter(d => {
      const taskId = this.store.deliveryTaskId(d.id);
      return taskId && this.store.taskSequenceBlocker(member.id, taskId);
    }).map(d => d.id) : []);
    const observed = runner instanceof CoreRunner ? runner.observationState(member.id) : null;
    const dispatch = this.deliveryRecovery.prepareDispatch(deliveries.map(d => d.id), observed?.identity ?? {
      terminalId: member.paneId, sessionId: member.sessionId, sessionGeneration: this.store.memberRevisions(member.id).sessionGeneration, process: null,
    }, { serverEpoch: this.deliveryEpoch, turn: observed?.turn ?? null, inputEpoch: observed?.inputEpoch ?? null, logs: [], capturedAt: new Date().toISOString() });
    this.store.transaction(() => {
      this.store.updateDispatch(dispatch.dispatchId, "prepared", "write_started");
      for (const d of deliveries) this.store.setDeliveryStatus(d.id, "delivering", { attempt: true });
    });
    this.invalidateCoreMeasurement(member);
    return this.executeDispatch(member, dispatch, () => runner.send(this.runnerMember(member, project), dispatch.wireText, { ...this.writeRunFiles(member, project), marker: dispatch.bundleMarker, beforeWrite: () => this.reservedInputAllowed(member, deliveries, urgent, dispatch.dispatchId, independentIds) }, urgent));
  }

  private async executeDispatch(member: Member, dispatch: DeliveryDispatch, send: () => Promise<SendResult>): Promise<SendResult> {
    const at = new Date().toISOString();
    const review = dispatch.items.some(item => { const delivery = this.store.getDelivery(item.deliveryId); return delivery && isTidy(delivery); }) ? this.store.getBoardReview(member.projectId) : null;
    const run: ExecutionJournal = { runId: dispatch.dispatchId, memberId: member.id, projectId: member.projectId, identity: dispatch.identity, turn: null, deliveryIds: dispatch.items.map(item => item.deliveryId), phase: "starting", inputReceivedAt: null, startedAt: null, lastProgressAt: null, endedAt: null, result: null, reason: null, exitCode: null, interruptionNotifiedAt: null, reportRequestedAt: null, createdAt: at, updatedAt: at };
    if (review) run.reason = `board_review:${review.requestedRevision}:pending`;
    this.store.transaction(() => {
      this.store.saveExecutionJournal(run);
      this.store.beginDelegationAck(run.runId, member.id, run.deliveryIds.map(id => this.store.requireDelivery(id)));
    });
    let result = await this.safeSend(send);
    if (result.ok && result.receipt && result.receipt.dispatchId !== dispatch.dispatchId) result = { ok: false, reason: "error", retryable: false, deliveryEffect: "unknown", detail: "다른 봉투의 수신 영수증입니다" };
    // The existing Runner.send success contract guarantees received input,
    // including core started:false. Bind legacy ACKs to the submitted envelope;
    // adapters with explicit receipts must identify this exact dispatch.
    this.deliveryRecovery.recordResult(dispatch.dispatchId, result.ok ? { ...result, receipt: result.receipt ?? { dispatchId: dispatch.dispatchId, receivedAt: new Date().toISOString(), source: "transport" } } : result);
    this.reconcileTodoCorrections();
    const current = this.store.getExecutionJournal(run.runId)!;
    if (!["ended", "interrupted"].includes(current.phase)) {
      const updatedAt = new Date().toISOString();
      this.store.saveExecutionJournal({ ...current, ...(result.ok ? { phase: current.startedAt || result.started ? "running" as const : "received" as const, inputReceivedAt: result.receipt?.receivedAt ?? updatedAt, startedAt: current.startedAt ?? (result.started ? updatedAt : null), turn: result.turn ?? current.turn } : result.deliveryEffect === "not_written" || result.deliveryEffect === "rejected" ? { phase: "ended" as const, result: "error" as const, reason: result.detail ?? result.reason, endedAt: updatedAt } : { phase: "unknown" as const, reason: result.detail ?? result.reason }), updatedAt });
    }
    return result;
  }

  /** Recovery writes share admission with ordinary work; inspection remains read-only. */
  recoveryRunner(member: Member): Pick<Runner, "inspectDelivery" | "repairDelivery"> | null {
    const runner = this.runners.get(this.backendOf(member));
    if (!runner) return null;
    return {
      ...(runner.inspectDelivery ? { inspectDelivery: runner.inspectDelivery.bind(runner) } : {}),
      ...(runner.repairDelivery ? { repairDelivery: async (m: RunnerMember, request: DeliveryRepair): Promise<SendResult> => {
        this.reconcileRejectedExecutions();
        const rt = this.runtime(member.id);
        const dispatch = this.store.getDispatch(request.dispatchId);
        if (dispatch && member.kind === "worker" && dispatch.items.some(item => {
          const taskId = this.store.deliveryTaskId(item.deliveryId);
          return taskId && this.store.pendingTaskFailureDecision(taskId);
        })) return { ok: false, reason: "busy", retryable: true, deliveryEffect: "not_written" };
        if (!dispatch || this.closed || this.recovering || this.settingsWriting || this.configWrites.has(member.id) || rt.turn || rt.starting || rt.closing || rt.reopening || this.retryDue(member) > Date.now() || !this.hasAutomaticCapacity(member)) {
          this.waiting.add(member.id);
          return { ok: false, reason: "busy", retryable: true, deliveryEffect: "not_written" };
        }
        const turn: Turn = { kind: "work", admitted: runner.kind === "core" || runner.kind === "headless", text: dispatch.wireText, interrupted: false, deliveries: dispatch.items.map(item => this.store.requireDelivery(item.deliveryId)) };
        rt.turn = turn; rt.posted = false; rt.delegated = false;
        try {
          const result = await this.executeDispatch(member, dispatch, () => runner.repairDelivery!(m, request, { beforeWrite: () => this.reservedInputAllowed(member, dispatch.items.map(item => this.store.requireDelivery(item.deliveryId))) }));
          if (!result.ok && rt.turn === turn) rt.turn = null;
          return result;
        } finally {
          if (!this.store.listPendingExecutions().some(run => run.memberId === member.id) && rt.turn === turn) rt.turn = null;
          this.releaseSlots();
        }
      } } : {}),
    };
  }

  private async safeSend(send: () => Promise<SendResult>): Promise<SendResult> {
    try {
      return await send();
    } catch (e) {
      return { ok: false, reason: "error", detail: (e as Error).message, retryable: true };
    }
  }

  /** 일을 내보내도 되면 true. 일시적으로 못 바꿨으면 지시를 되살리고 일도 미룬다(순차로 나가 버리면 되돌릴 수 없다). */
  private async applyParallel(member: Member, project: Project, runner: Runner, rt: Runtime, pending: Delivery[] = []): Promise<boolean> {
    const want = rt.wantParallel!;
    rt.wantParallel = null;
    if (want === member.parallel) return true;
    const held = rt.turn;
    rt.turn = { kind: "control", admitted: runner.kind === "headless" || runner.kind === "core", text: "", interrupted: false };
    const result = await this.safeSend(() => runner.setParallel(this.runnerMember(member, project), want, { ...this.writeRunFiles(member, project), beforeWrite: () => this.reservedInputAllowed(member, pending) }));
    rt.turn = held;
    if (result.ok) {
      rt.parallelFails = 0;
      this.store.patchMember(member.id, { parallel: want });
      this.store.appendActivity(member.id, "system", `병렬 ${want ? "켬" : "끔"}`);
      return true;
    }
    const detail = result.detail ?? result.reason;
    this.store.appendActivity(member.id, "error", `병렬 설정 실패: ${detail}`);
    // 세션을 못 찾았다면 이어지는 턴이 새 세션을 만든다. 그때 다시 켠다.
    if (isMissingSessionError(result.detail)) {
      rt.wantParallel = want;
      return true;
    }
    // 그 사이 온 새 지시가 이긴다.
    rt.wantParallel ??= want;
    if (result.reason !== "error") {
      // 입력칸·승인 창·연결 문제는 보통 전달과 같게 미룬다.
      this.onSendFailed(member, rt, pending, result);
      return false;
    }
    rt.parallelFails++;
    if (result.retryable && rt.parallelFails < MAX_TURN_ERROR_ATTEMPTS) {
      this.retryLater(member.id, rt, this.timings.retryMs);
      return false;
    }
    // 끝내 안 된다. 일을 영영 막지는 않되, 순차로 돈다는 것을 총괄이 알게 한다.
    rt.wantParallel = null;
    rt.parallelFails = 0;
    const conductor = this.store.getConductor(member.projectId);
    if (conductor && conductor.id !== member.id) {
      this.store.enqueue({ projectId: member.projectId, memberId: conductor.id, kind: "system", text: formatSystem(`${member.name} 병렬 ${want ? "켜기" : "끄기"} 실패: ${normalizeSpace(detail).slice(0, 200)}. 지금 설정대로 일을 넘겼습니다.`), wake: false });
    }
    return true;
  }

  private onSendFailed(member: Member, rt: Runtime, deliveries: Delivery[], result: Extract<SendResult, { ok: false }>): void {
    const memberId = member.id;
    if (result.reason === "error" && ["not_written", "rejected"].includes(result.deliveryEffect ?? "unknown")) {
      // A provider's non-retryable refusal is still not an ambiguous write.
      // Durable rejected-count admission bounds these ordinary retries.
      for (const d of deliveries) this.requeue(d);
      this.retryLater(memberId, rt, this.timings.retryMs);
      return;
    }
    if (this.backendOf(member) === "core" && !["not_written", "rejected"].includes(result.deliveryEffect ?? "unknown") && (result.reason === "error" || (result as { reason: string }).reason === "unknown")) {
      for (const d of deliveries) this.hold(d, "delivery_unknown");
      this.store.patchMember(memberId, { lastError: result.detail ?? "전달 여부를 확인할 수 없습니다" });
      return;
    }
    switch (result.reason) {
      case "busy":
        for (const d of deliveries) this.requeue(d);
        this.retryLater(memberId, rt, this.timings.retryMs);
        return;
      case "blocked":
        this.markBlocked(member);
        for (const d of deliveries) this.hold(d, "blocked");
        return;
      case "input_busy": {
        rt.inputBusySince ??= Date.now();
        if (Date.now() - rt.inputBusySince < this.timings.inputBusyLimitMs) {
          for (const d of deliveries) this.requeue(d);
          this.retryLater(memberId, rt, this.timings.inputBusyRetryMs);
        } else {
          rt.inputBusySince = null;
          for (const d of deliveries) this.hold(d, "input_busy");
        }
        return;
      }
      case "down":
        this.store.patchMember(memberId, { lastError: result.detail ?? "실행기에 연결할 수 없습니다" });
        for (const d of deliveries) this.hold(d, "backend_down");
        return;
      case "gone":
        this.store.patchMember(memberId, { status: "offline", paneId: null });
        for (const d of deliveries) this.hold(d, "offline");
        return;
      case "error": {
        const detail = result.detail ?? "전달 실패";
        const attempts = Math.max(...deliveries.map((d) => this.store.requireDelivery(d.id).attempts));
        if (result.retryable && attempts < 3) {
          for (const d of deliveries) this.requeue(d);
          this.retryLater(memberId, rt, this.timings.retryMs);
          return;
        }
        const first = member.status !== "error" || member.lastError !== detail;
        for (const d of deliveries) {
          if (d.refType === "message" && d.refId) {
            this.store.markFailed(d.id, detail);
            this.store.setMessageDelivery(d.refId, "failed", detail);
          } else {
            // 대표에게 돌려줄 글이 없는 전달(보고·지시·알림·완료)은 실패시키면 아무도 모르게 사라진다. 두었다가 다시 보낸다.
            this.hold(d, "send_error");
          }
        }
        this.store.patchMember(memberId, { status: "error", lastError: detail });
        this.holdHeld(memberId, rt, this.timings.retryMs);
        if (first) this.memberNotice(member, `${member.name}에게 전달하지 못했습니다: ${detail}`, deliveries);
        return;
      }
    }
  }

  /** 보류해 둔 전달을 시간을 두고 다시 보낸다. 틱이 그 전에 밀어도 holdUntil 이 막는다. */
  private holdHeld(memberId: string, rt: Runtime, baseMs: number): void {
    if (this.store.listPending(memberId).length === 0) return;
    const wait = baseMs * HELD_RETRY_FACTOR;
    rt.holdUntil = Date.now() + wait;
    if (rt.retryTimer) clearTimeout(rt.retryTimer);
    rt.retryTimer = null;
    this.retryLater(memberId, rt, wait);
  }

  private retryDue(member: Member): number {
    return this.store.deliveryRetryDue(member.id, this.backendOf(member));
  }

  private scheduleRetry(memberId: string, rt: Runtime, due: number): void {
    if (rt.retryTimer) clearTimeout(rt.retryTimer);
    if (this.closed) return;
    rt.retryTimer = setTimeout(() => {
      rt.retryTimer = null;
      void this.pump(memberId);
    }, Math.min(Math.max(due - Date.now(), 1), 2_147_483_647));
    rt.retryTimer.unref?.();
  }

  private retryLater(memberId: string, rt: Runtime, ms: number): void {
    const due = Date.now() + Math.max(ms, 0);
    this.store.transaction(() => {
      for (const delivery of this.store.listPending(memberId)) {
        if (!["none", "resolved"].includes(this.store.getDeliveryRecovery(delivery.id)?.phase ?? "none") || this.store.getDeliveryRetry(delivery.id).retryReason === "rejected_limit") continue;
        const retry = this.store.getDeliveryRetry(delivery.id);
        this.store.patchDeliveryRetry(delivery.id, { nextAttemptAt: new Date(Math.max(due, Date.parse(retry.nextAttemptAt ?? "") || 0)).toISOString(), retryScope: `member:${memberId}`, retryReason: retry.retryReason ?? "control_retry" });
      }
    });
    rt.holdUntil = Math.max(rt.holdUntil, due);
    this.scheduleRetry(memberId, rt, rt.holdUntil);
  }

  private hold(d: Delivery, reason: string): void {
    this.store.markHeld(d.id, reason);
    if (d.refType === "message" && d.refId) this.store.setMessageDelivery(d.refId, "held", HOLD_NOTES[reason] ?? reason);
  }

  private requeue(d: Delivery): void {
    this.store.setDeliveryStatus(d.id, "queued");
    if (d.refType === "message" && d.refId) this.store.setMessageDelivery(d.refId, "queued");
  }

  private markDelivered(d: Delivery): void {
    this.store.markDelivered(d.id);
    if (d.refType === "message" && d.refId) this.store.setMessageDelivery(d.refId, "delivered");
    if (d.refType === "decision" && d.refId && this.store.getDecision(d.refId)?.status === "answered") {
      this.store.setDecisionStatus(d.refId, "delivered");
    }
  }

  private isBusy(member: Member): boolean {
    return this.coreCompactFenced(member) || this.runtime(member.id).turn !== null || !!this.runners.get(this.backendOf(member))?.isBusy(member.id);
  }

  /** Persisted, reserved and physically busy turns share one slot per member. */
  private activeAutomaticTurns(): Map<string, string> {
    const projects = new Map<string, string>();
    for (const run of this.store.listPendingExecutions()) {
      const member = this.store.getMember(run.memberId);
      if (member && ["core", "headless"].includes(this.backendOf(member)) && this.store.memberRevisions(member.id).sessionGeneration === run.identity.sessionGeneration) projects.set(member.id, member.projectId);
    }
    for (const [id, rt] of this.runtimes) if (rt.turn?.admitted) {
      const member = this.store.getMember(id);
      if (member) projects.set(id, member.projectId);
    }
    for (const member of this.store.listAllMembers()) if (member.origin !== "manual" && member.status !== "offline" && member.status !== "asleep" && this.backendOf(member) === "core" && this.coreOccupiesSlot(member.id)) projects.set(member.id, member.projectId);
    return projects;
  }

  private hasAutomaticCapacity(member: Member, ownReservation = false): boolean {
    const active = this.activeAutomaticTurns();
    if (ownReservation) active.delete(member.id);
    const totalLimit = this.store.getSettings().maxConcurrentTurns;
    if (active.size >= totalLimit) return false;
    const projectLimit = this.store.requireProject(member.projectId).maxConcurrentTurns ?? totalLimit;
    let projectTurns = 0;
    for (const projectId of active.values()) if (projectId === member.projectId) projectTurns++;
    return projectTurns < Math.min(totalLimit, projectLimit);
  }

  /** Rechecked by async runners at the physical write boundary, after their terminal preflight. */
  private reservedInputAllowed(member: Member, deliveries: readonly Delivery[] = [], urgent = false, inFlightDispatchId?: string, independentIds: ReadonlySet<string> = new Set()): boolean {
    if (this.closed || !this.store.getMember(member.id)) return false;
    if (!urgent && ["core", "headless"].includes(this.backendOf(member)) && !this.hasAutomaticCapacity(member, true)) {
      this.waiting.add(member.id);
      return false;
    }
    return deliveries.every(delivery => {
      const taskId = this.store.deliveryTaskId(delivery.id);
      if (member.kind === "worker" && taskId && this.store.pendingTaskFailureDecision(taskId)) return false;
      if (member.kind === "worker" && taskId && (independentIds.has(delivery.id) || this.store.taskSequenceBlocker(member.id, taskId))
        && !independentDeliveryAuthorized(this.store, delivery, { inFlightDispatchId })) return false;
      return this.instructionCriteriaAllow(delivery);
    });
  }

  private coreOccupiesSlot(memberId: string): boolean {
    const runner = this.runners.get("core");
    return !!runner && (runner.occupiesTurnSlot ? runner.occupiesTurnSlot(memberId) : runner.isBusy(memberId));
  }

  private resumePumps(): void {
    if (this.closed) return;
    this.releaseSlots();
    for (const member of this.store.listAllMembers()) if (this.configPending(member) || this.store.listPending(member.id).length) void this.pump(member.id);
  }

  private releaseSlots(): void {
    const ids = [...this.waiting];
    this.waiting.clear();
    for (const id of ids) void this.pump(id);
  }

  // ---- 압축 ----
  private async beginCompact(member: Member, project: Project, runner: Runner, rt: Runtime, focus: string): Promise<void> {
    if (runner.kind === "core") return this.beginCoreCompact(member, project, runner, rt, focus);
    rt.compactRequest = null;
    const turn: Turn = { kind: "compact", admitted: runner.kind === "headless", text: "", interrupted: false };
    rt.turn = turn;
    this.store.patchMember(member.id, { status: "working" });
    this.store.appendActivity(member.id, "compact", `압축 시작 (문맥 ${member.contextPct ?? "?"}%)`);
    const result = await this.safeSend(() => runner.compact(this.runnerMember(member, project), focus, { ...this.writeRunFiles(member, project), beforeWrite: () => this.reservedInputAllowed(member) }));
    if (result.ok) {
      if (rt.turn === turn) {
        rt.compactTimer = setTimeout(() => {
          rt.compactTimer = null;
          if (rt.turn === turn) this.endCompact(member.id, rt, "압축이 끝났다는 신호를 받지 못했습니다");
        }, this.timings.compactTimeoutMs);
      }
      return;
    }
    if (rt.turn === turn) rt.turn = null;
    if (result.reason === "busy") {
      rt.compactRequest = focus;
      this.retryLater(member.id, rt, this.timings.retryMs);
    } else {
      this.store.appendActivity(member.id, "error", `압축 실패: ${result.detail ?? result.reason}`);
      rt.skipCompact = true;
      rt.again = true;
    }
    this.settle(this.store.requireMember(member.id));
    this.releaseSlots();
  }

  private async beginCoreCompact(member: Member, project: Project, runner: Runner, rt: Runtime, focus: string): Promise<void> {
    const state = this.store.ensureContextState(member.id);
    if (state.compaction?.phase !== "queued") return;
    this.requireActive(this.store.requireProject(project.id));
    const turn: Turn = { kind: "compact", admitted: true, text: "", interrupted: false };
    rt.turn = turn; // admission은 첫 await 이전에 예약한다.
    rt.compactRequest = null;
    const result = await this.safeSend(() => runner.compact(this.runnerMember(member, project), focus, { ...this.writeRunFiles(member, project), beforeWrite: () => this.reservedInputAllowed(member) }));
    if (rt.turn !== turn) return;
    const latest = this.store.ensureContextState(member.id);
    if (latest.compaction?.phase === "succeeded") { this.endCompact(member.id, rt, null); return; }
    if (result.ok) {
      this.store.appendActivity(member.id, "compact", `압축 시작 (문맥 ${member.contextPct ?? "?"}%)`);
      this.store.patchMember(member.id, { status: "working" });
      const id = latest.compaction?.id;
      rt.compactTimer = setTimeout(() => {
        rt.compactTimer = null;
        const current = this.store.getContextState(member.id);
        if (!current?.compaction || current.compaction.id !== id || !["sending", "running"].includes(current.compaction.phase)) return;
        this.store.saveContextState({ ...current, compaction: { ...current.compaction, phase: "uncertain", reason: "completion_timeout" } });
        this.store.appendActivity(member.id, "error", "압축 완료를 확인할 수 없어 후속 자동 입력을 보류합니다");
      }, this.timings.compactTimeoutMs);
      return;
    }
    const uncertain = !["not_written", "rejected"].includes(result.deliveryEffect ?? "unknown");
    const retry = !uncertain && (result.deliveryEffect === "rejected" || ["busy", "blocked", "input_busy", "down"].includes(result.reason));
    if (latest.compaction && (latest.compaction.phase !== "failed" || retry)) this.store.saveContextState({ ...latest,
      compaction: { ...latest.compaction, phase: uncertain ? "uncertain" : retry ? "queued" : "failed",
        reason: uncertain ? "send_uncertain" : result.reason === "input_busy" ? "draft" : result.reason === "blocked" ? "blocked" : result.reason === "down" ? "backend_down" : retry ? "working" : "provider_error",
        finishedAt: !uncertain && !retry ? new Date().toISOString() : null } });
    if (uncertain) {
      this.store.appendActivity(member.id, "error", "압축 응답을 확인할 수 없어 자동 재전송을 중지했습니다");
      return;
    }
    rt.turn = null;
    if (retry) { rt.compactRequest = focus; this.retryLater(member.id, rt, this.timings.retryMs); }
    else { rt.skipCompact = true; rt.again = true; this.store.appendActivity(member.id, "error", `압축 실패: ${result.detail ?? result.reason}`); }
    this.settle(this.store.requireMember(member.id));
    this.releaseSlots();
  }

  /** 압축 턴 정리. 실패해도 대기열은 멈추지 않는다. */
  private endCompact(memberId: string, rt: Runtime, error: string | null): void {
    rt.turn = null;
    if (rt.compactTimer) clearTimeout(rt.compactTimer);
    rt.compactTimer = null;
    rt.skipCompact = true;
    const member = this.store.getMember(memberId);
    if (member) {
      if (error) {
        this.store.appendActivity(memberId, "error", `압축 실패: ${error}`);
      } else {
        this.afterCompacted(member);
      }
      if (member.status !== "asleep") this.settle(this.store.requireMember(memberId));
      if (member.status !== "asleep") void this.pump(memberId);
    }
    this.releaseSlots();
  }

  private afterCompacted(member: Member): void {
    if (this.backendOf(member) !== "core") this.store.patchMember(member.id, { contextPct: null });
    this.store.appendActivity(member.id, "compact", "압축 완료");
    if (member.origin !== "adopted") return;
    // 넘겨받은 세션은 규칙이 시스템 프롬프트에 없어 요약에서 흐려진다(스킬 §4).
    const project = this.store.requireProject(member.projectId);
    const text = formatSystem(`압축 뒤 규칙을 다시 보냅니다. 단, 이 세션에는 iamceo 도구(post·ask·status·file·todo)가 연결되어 있지 않으니 찾지 말고, 보고와 질문은 턴 마지막 글로 하세요. 서버가 그 글을 총괄에게 전합니다.\n\n${this.rulesFor(member, project)}`);
    if (!this.store.listPending(member.id).some((d) => d.text === text)) {
      this.store.enqueue({ projectId: member.projectId, memberId: member.id, kind: "system", text, wake: false });
    }
  }

  // ---- 실행기 이벤트 ----
  private async onRunnerEvent(e: RunnerEvent): Promise<void> {
    const member = this.store.getMember(e.memberId);
    if (!member) {
      const rt = this.runtimes.get(e.memberId);
      if (rt && e.type === "turn_end") {
        this.clearRuntime(e.memberId, rt);
        this.releaseSlots();
      }
      return;
    }
    const generation = this.store.memberRevisions(member.id).sessionGeneration;
    if (e.sessionGeneration !== undefined && e.sessionGeneration !== generation) return;
    if (e.terminalId && member.paneId && e.terminalId !== member.paneId) return;
    if (this.runtime(member.id).closing) return;
    this.reconcileCoreCompact(member);
    if (e.turn !== undefined && e.turn !== null) {
      const previous = this.observedTurns.get(member.id);
      const same = previous?.generation === generation && previous.terminal === (e.terminalId ?? member.paneId);
      if (same && (e.turn < previous.turn || (e.type === "turn_end" && e.turn <= previous.ended))) return;
      this.observedTurns.set(member.id, { generation, terminal: e.terminalId ?? member.paneId, turn: e.turn, ended: e.type === "turn_end" ? e.turn : same ? previous.ended : -1 });
    }
    const pending = this.store.listPendingExecutions().filter(r => r.memberId === member.id && r.identity.sessionGeneration === generation && (!e.terminalId || !r.identity.terminalId || e.terminalId === r.identity.terminalId));
    const at = e.observedAt ?? new Date().toISOString();
    if (e.type === "activity" || (e.type === "status" && e.status === "working" && (!e.observation || e.observation.freshness === "fresh"))) for (const run of pending) {
      this.store.saveExecutionJournal({ ...run, turn: e.turn ?? run.turn, phase: "running", startedAt: run.startedAt ?? at, lastProgressAt: at, updatedAt: at });
    }
    switch (e.type) {
      case "status":
        if (["idle", "working"].includes(e.status) && (!e.observation || e.observation.freshness === "fresh") && member.lastError) this.store.patchMember(member.id, { lastError: null });
        if (e.status === "working" || e.observation?.freshness === "stale") this.invalidateCoreMeasurement(member);
        if (e.status === "idle" && e.turn !== undefined && e.turn !== null && pending.some(run => run.turn !== null && e.turn! > run.turn)) {
          this.endExecution(member, "success", "서버 부재 중 더 뒤의 종결 turn을 확인했습니다");
          this.runtime(member.id).turn = null;
          this.releaseSlots();
        }
        if (e.status === "gone") {
          this.endExecution(member, "interrupted", e.exit?.reason ?? "소유 터미널이 종료되거나 사라졌습니다", e.exit?.exitCode ?? null, e.turn);
          if (e.exit) {
            const detail = `초기/실행 종료: ${e.exit.reason ?? "원인 미확인"} (exit_code=${e.exit.exitCode ?? "unknown"})`;
            if (member.lastError !== detail) this.store.appendActivity(member.id, "error", detail.slice(0, 500));
            this.store.patchMember(member.id, { lastError: detail.slice(0, 500) });
          }
        }

        if (e.blockedReason !== undefined || e.observation !== undefined) this.store.patchMember(member.id, {
          ...(e.blockedReason !== undefined ? { blockedReason: e.blockedReason } : {}),
          ...(e.observation !== undefined ? { statusObservation: this.executionObservation(this.store.requireMember(member.id), e.observation, e.status) } : {}),
        });
        return this.onStatus(this.store.requireMember(member.id), e.status);
      case "turn_end":
        if (this.backendOf(member) === "core" && e.isError && /quota|rate.?limit|usage.?limit|authentication|unauthorized|한도|인증/i.test(e.errorText ?? "")) {
          const reason = /auth|unauthorized|인증/i.test(e.errorText ?? "") ? "processing_auth" : "processing_quota";
          const due = new Date(Date.now() + this.timings.turnErrorRetryMs).toISOString();
          for (const run of pending) for (const id of run.deliveryIds) this.store.patchDeliveryRetry(id, { nextAttemptAt: due, retryScope: `member:${member.id}`, retryReason: reason });
        }
        {
          // 멈춤을 CLI 가 확인한 턴은 성공으로 치지 않는다(보고 보완을 요청하지 않고, 끊긴 일을 끝난 일로 남기지 않는다).
          const rt = this.runtime(member.id);
          // 멈춤 키를 보내는 사이에 턴이 끝나도 그 멈춤 때문에 끝난 것으로 본다.
          const stop = rt.stopRequest;
          const stopped = !!stop || !!rt.turn?.interrupted;
          rt.stopRequest = null;
          if (stopped) this.endExecution(member, "interrupted", stopReason(stop?.by ?? null), e.exitCode ?? null, e.turn, stop?.by ?? null);
          else this.endExecution(member, e.isError ? "error" : "success", e.errorText ?? e.reason ?? null, e.exitCode ?? null, e.turn);
        }
        if (e.isError && !pending.length && member.status === "error" && member.lastError === (e.errorText ?? "오류")) return;
        return this.onTurnEnd(member, e);
      case "activity":
        this.store.appendActivity(member.id, e.kind, e.text);
        return;
      case "context":
        if (validWindow(e.window)) this.runtime(member.id).contextCandidate = null;
        this.store.patchMember(member.id, { contextPct: e.pct, ...(validWindow(e.window) ? { contextWindow: e.window, contextWindowSource: "headless" as const } : {}) });
        return;
      case "context_usage":
        this.onContextUsage(member, e);
        return;
      case "subagents":
        this.store.patchMember(member.id, { subagents: e.count, subagentState: e.measurement ?? { quality: "estimated", count: e.count, observedAt: e.observedAt ?? new Date().toISOString(), sessionGeneration: generation } });
        return;
      case "background":
        return this.onBackground(member, e.label);
      case "session":
        if (e.sessionId !== member.sessionId) this.store.patchMember(member.id, { sessionId: e.sessionId });
        return;
      case "compacted": {
        const rt = this.runtime(member.id);
        if (this.backendOf(member) === "core") {
          const state = this.store.getContextState(member.id);
          if (state?.compaction?.phase !== "succeeded" || e.runId !== state.compaction.id || state.baseline?.reportedCompact === e.runId) return;
          this.store.saveContextState({ ...state, baseline: { ...state.baseline, reportedCompact: e.runId } });
        }
        if (rt.turn?.kind === "compact") {
          this.endCompact(member.id, rt, null);
        } else {
          rt.skipCompact = true;
          this.afterCompacted(member);
          this.releaseSlots();
          void this.pump(member.id);
        }
        return;
      }
      case "pane":
        // 프로젝트 탭은 어댑터가 만든 탭으로 고정한다. 사용자가 칸을 자기 탭으로 옮겼다고 그 탭이 프로젝트 탭이 되면 안 된다.
        this.store.patchMember(member.id, { paneId: e.paneId });
        return;
    }
  }

  /** 승인 창 앞에서는 대표가 풀어 줘야 움직인다. 결재함에 안 보이므로 다른 창을 보고 있어도 알린다. */
  private markBlocked(member: Member): void {
    if (member.status !== "blocked") void this.notifyBlocked(member);
    // The observation's verified reason may have arrived before this status transition.
    this.store.patchMember(member.id, { status: "blocked", blockedReason: member.blockedReason ?? "status_unknown" });
  }

  /** 무엇을 승인할지 알림에 같이 싣는다. 창을 못 읽으면 예전 문구다. */
  private async notifyBlocked(member: Member): Promise<void> {
    let body = "승인 창 앞에서 멈췄습니다";
    try {
      const a = await this.memberApproval(member.id);
      if (a) body = `${approvalSummary(a)} · 결재함에서 승인·거절할 수 있습니다`;
      else {
        // core 칸: 질문·선택·승인 창을 읽어 요약한다(보이는 글과 같이 비밀값은 가림). 읽지 못한 창은 예전 문구다.
        const native = (await this.memberNativePrompt(member.id)).prompt;
        if (native && !native.limited) body = `${approvalSummary(native)} · 결재함에서 고를 수 있습니다`;
      }
    } catch { /* 알림은 그대로 보낸다 */ }
    this.notifyInbox(`${member.name} 승인 대기`, body);
  }

  private onStatus(member: Member, status: "working" | "idle" | "blocked" | "gone"): void {
    if (member.status === "asleep") return;
    const rt = this.runtime(member.id);
    switch (status) {
      case "working":
        // 서버가 넣지 않았는데 칸이 일을 시작했다: 대표가 터미널에 직접 친 일이다.
        if (!rt.turn && !rt.reattaching && this.backendOf(member) === "herdr" && member.status !== "working") {
          rt.direct = true;
          rt.posted = false;
        }
        // waiting 은 답하지 않은 결재가 있을 때만 남긴다(이번 턴에 ask 했으면 턴이 끝날 때 정한다). 답이 끝난 waiting 은 지금 일하는 대로 고친다.
        if (member.status !== "working" && !(member.status === "waiting" && this.hasOpenAsk(member))) this.store.patchMember(member.id, { status: "working" });
        break;
      case "idle":
        // turn_end 가 뒤따른다. 그때 정한다.
        if (!rt.turn && member.status !== "error") this.settle(member);
        break;
      case "blocked":
        this.markBlocked(member);
        break;
      case "gone":
        this.interruptCoreCompaction(member);
        if (rt.compactTimer) clearTimeout(rt.compactTimer);
        rt.compactTimer = null;
        this.store.patchMember(member.id, { status: "offline", ...(this.backendOf(member) === "core" ? {} : { paneId: null }), subagents: 0 });
        rt.turn = null;
        rt.background = null;
        this.releaseSlots();
        return;
    }
    if (status !== "blocked") void this.pump(member.id);
  }

  private async onTurnEnd(member: Member, e: Extract<RunnerEvent, { type: "turn_end" }>): Promise<void> {
    const rt = this.runtime(member.id);
    const turn = rt.turn;
    if (turn?.kind === "control") return;
    if (turn?.kind === "compact") {
      if (this.backendOf(member) === "core") return;
      if (turn.interrupted) {
        rt.turn = null;
        if (rt.compactTimer) clearTimeout(rt.compactTimer);
        rt.compactTimer = null;
        // 끊었는데 곧바로 다시 압축하면 멈출 길이 없다. 다음 턴이 끝날 때 다시 판단한다.
        rt.skipCompact = true;
        if (member.status !== "asleep") {
          this.settle(member);
          void this.pump(member.id);
        }
        this.releaseSlots();
        return;
      }
      if (e.isError && isMissingSessionError(e.errorText)) await this.resetSession(member);
      this.endCompact(member.id, rt, e.isError ? (e.errorText ?? "오류") : null);
      return;
    }

    rt.turn = null;
    const { posted, direct } = rt;
    rt.posted = false;
    rt.direct = false;
    rt.skipCompact = false;
    if (this.backendOf(member) === "core") {
      const state = this.store.ensureContextState(member.id);
      this.store.saveContextState({ ...state, baseline: { ...state.baseline, completedTurn: e.turn ?? null } });
    }
    this.store.finishDelegationAck(member.id);
    this.store.appendActivity(member.id, e.isError ? "error" : "turn_end", e.isError ? (e.errorText ?? "오류") : "턴 끝");
    if (member.subagents !== 0) this.store.patchMember(member.id, { subagents: 0 });

    if (member.status === "asleep") {
      this.releaseSlots();
      return;
    }
    if (turn?.interrupted) {
      this.settle(member);
    } else if (e.isError && e.noOutput && turn?.deliveries?.length) {
      await this.onTurnUnread(member, rt, turn.deliveries, e.errorText ?? "오류");
    } else if (e.isError) {
      await this.onTurnError(member, e.errorText ?? "오류", turn?.deliveries);
    } else {
      this.settle(member, true);
      const tidied = member.kind !== "worker" && !!turn?.deliveries?.some(isTidy);
      // 판 정리만 받은 턴은 바뀐 게 없으면 아무것도 올리지 않기로 했다. 마지막 글은 활동에만 남긴다.
      const tidyOnly = tidied && !!turn?.deliveries?.every((d) => d.kind === "system");
      if (!posted && e.finalText.trim()) {
        if (tidyOnly) this.store.appendActivity(member.id, "system", `판 정리: ${normalizeSpace(e.finalText).slice(0, 300)}`);
        else await this.fallbackReport(member, e.finalText, direct, turn?.deliveries);
      }
    }
    await this.pump(member.id);
    this.releaseSlots();
  }

  private async onTurnError(member: Member, errorText: string, deliveries?: Delivery[]): Promise<void> {
    this.store.patchMember(member.id, { status: "error", lastError: errorText });
    this.memberNotice(member, `${member.name} 오류: ${errorText}`, deliveries);
    if (member.kind === "worker") await this.reportToConductor(member, "막힘", "(자동) 턴 오류", errorText, true);
  }

  /** noOutput diagnoses execution, never whether an input was received. */
  private async onTurnUnread(member: Member, _rt: Runtime, deliveries: Delivery[], errorText: string): Promise<void> {
    for (const d of deliveries) {
      if (this.store.getDelivery(d.id)?.status !== "delivered") this.deliveryRecovery.beginRecovery(d.id);
    }
    await this.onTurnError(member, errorText, deliveries);
  }

  /**
   * post 를 안 부른 턴의 마지막 글(§6). 직원은 총괄에게 보고, 총괄·본사 AI 는 대표에게 하는 말.
   * 업무: 그 턴이 받은 전달(일을 시킨 전달이 먼저)의 업무. 여럿이면 업무마다 같은 글을 남긴다(한 업무로 몰거나 고르지 않는다.
   * 총괄에게는 한 번만 보고한다).
   * 받은 전달에 업무가 없으면(대표가 터미널에 직접 친 일 등) 글 첫 줄로 새 업무를 만든다. 본사는 예전대로다.
   */
  private async fallbackReport(member: Member, finalText: string, direct: boolean, turnDeliveries?: Delivery[]): Promise<void> {
    // 글은 한 번만 남긴다(업무마다 복사하지 않는다). 그 턴을 깨운 전달의 업무가 하나면 그 업무. 여럿이면 어느 업무의 결과인지
    // 정할 수 없어(A·B 결과가 섞인 글이 B 대화에 A 내용을 싣는다) 그 직원의 '여러 업무 결과' 업무에 한 번 남기고 받은 업무를 적는다.
    // 근거가 없으면 첫 줄로 새 업무를 만든다.
    const received = this.certainTasks(turnDeliveries);
    const usesTasks = this.usesTasks(member.projectId);
    const id = newId("msg_");
    const taskId: string | null = !usesTasks ? (received.length === 1 ? received[0]! : null)
      : received.length === 1 ? received[0]!
      : received.length > 1 ? this.serverTask(member, "mixed").id
      : this.store.ensureSourceTask({ projectId: member.projectId, sourceRef: `message:${id}`, title: taskTitleFrom(finalText, datedTitle(`${member.name} 보고`, new Date())), origin: "auto", who: member.kind === "worker" ? member.name : "" }).task.id;
    const note = usesTasks ? this.receivedTasksNote(received) : "";
    if (member.kind !== "worker") {
      this.store.createMessage({ id, projectId: member.projectId, memberId: member.id, who: member.name, kind: "답변", body: finalText + note, taskId });
      return;
    }
    const firstLine = normalizeSpace(finalText.split("\n")[0] ?? "").slice(0, 60);
    const title = `${direct ? "(직접) " : ""}(자동) ${firstLine}`;
    const conductor = this.store.getConductor(member.projectId);
    const { deliveries } = this.store.withDeliveryIntents(() => this.store.createMessage({ id, projectId: member.projectId, memberId: member.id, who: member.name, kind: "알림", title, body: finalText + note, taskId }), message => conductor && conductor.id !== member.id ? [{
      projectId: member.projectId, memberId: conductor.id, kind: "report", text: formatReport(member.name, direct ? "(직접) (자동) 알림" : "(자동) 알림", firstLine, finalText.trim() === firstLine ? "" : finalText) + `\n보고 원본 #${message.id}` + (usesTasks && received.length > 1 ? `\n받은 업무: ${received.map(t => `#${t}`).join(", ")}(어느 업무의 결과인지 정할 수 없어 업무마다 따로 보고하게 하세요)` : ""), wake: true, refType: "message", refId: message.id,
    }] : []);
    await Promise.all(deliveries.map(d => this.pump(d.memberId)));
  }

  private async resetSession(member: Member): Promise<Member> {
    const project = this.store.requireProject(member.projectId);
    this.store.patchMember(member.id, { sessionId: null, contextPct: null });
    const fresh = this.store.requireMember(member.id);
    const sent = this.desiredConfig(fresh);
    const started = await this.startManaged(fresh, project, false);
    this.applyStarted(member.id, project, started, sent);
    return this.store.requireMember(member.id);
  }

  /**
   * 턴 밖의 상태. 뒤 작업(워크플로 등)을 기다리면 그 팀이 일하는 중이라 working, 아니면 답하지 않은 결재가 있으면 waiting, 없으면 idle.
   */
  private settle(member: Member, clearError = false): void {
    const open = member.origin !== "manual" && this.store.listOpenDecisionsByMember(member.id).length > 0;
    const status = this.runtime(member.id).background ? "working" : open ? "waiting" : "idle";
    if (member.status === "error" && !clearError) return;
    if (member.status === status && !clearError) return;
    this.store.patchMember(member.id, { status, ...(clearError ? { lastError: null } : {}) });
  }

  private hasOpenAsk(member: Member): boolean {
    return member.origin !== "manual" && this.store.listOpenDecisionsByMember(member.id).length > 0;
  }

  /** waiting 인데 답하지 않은 결재가 남지 않았으면 지금 하는 대로(일하는 중·쉼) 바로 고친다. */
  private refreshWaiting(memberId: string): void {
    const member = this.store.getMember(memberId);
    if (!member || member.status !== "waiting" || member.origin === "manual" || this.hasOpenAsk(member)) return;
    if (this.isBusy(member)) this.store.patchMember(member.id, { status: "working" });
    else this.settle(member);
  }

  /**
   * 화면 % 는 바로 표시하고, 창 추정은 두 읽기가 맞아야 저장한다.
   */
  private onContextUsage(member: Member, e: Extract<RunnerEvent, { type: "context_usage" }>): void {
    if (this.backendOf(member) === "core") {
      if (!member.sessionId || !member.paneId || e.sessionId && e.sessionId !== member.sessionId) return;
      const state = this.store.ensureContextState(member.id);
      const settings = this.store.getSettings();
      const identity = { sessionId: member.sessionId, generation: state.generation, terminalId: member.paneId, turn: e.turn ?? null, model: e.model };
      const measurement = coreContextMeasurement(e, identity, identity,
        { learned: member.contextWindow, source: member.contextWindowSource, fallback: settings.contextWindowDefault, windows: settings.contextWindows },
        { complete: true, fresh: e.sessionGeneration === state.generation && e.terminalId === member.paneId, measuredAt: e.observedAt ?? new Date().toISOString() });
      if (!measurement) return;
      const measured = measureContext(e, { learned: member.contextWindow, source: member.contextWindowSource, fallback: settings.contextWindowDefault, windows: settings.contextWindows });
      const log = this.contextLog(member);
      const old = state.baseline?.measurementLog as CompactBoundaryBaseline | undefined;
      let builtin = false;
      if (log && old) builtin = observeCompactBoundary({ cli: member.cli, home: log.home, cwd: member.cwd, baseline: old, current: identity, settled: true, providerError: false }).outcome === "succeeded";
      const range = log ? readJsonlRange(providerLogRoot(member.cli, log.home), log.path) : null;
      const baseline = range?.complete && range.cursor && log ? { ...identity, path: log.path, fileIdentity: range.cursor.fileIdentity, offset: range.cursor.offset } : null;
      this.store.saveContextState({ ...state, measurement, baseline: { ...state.baseline, configRevision: this.store.memberRevisions(member.id).configRevision,
        measurementLog: baseline, ...(builtin ? { autoTurn: measurement.turn } : {}) } },
        { contextPct: measured?.pct ?? null, ...(measured?.learned !== null && measured?.learned !== undefined ? { contextWindow: measured.learned, contextWindowSource: measured.source } : {}) });
      return;
    }
    const rt = this.runtime(member.id);
    if (rt.contextCandidate?.sessionId !== member.sessionId) rt.contextCandidate = null;
    if (e.sessionId && e.sessionId !== member.sessionId) return;
    const settings = this.store.getSettings();
    const measured = measureContext(e, { learned: member.contextWindow, source: member.contextWindowSource, fallback: settings.contextWindowDefault, windows: settings.contextWindows });
    if (!measured) return;
    if (exactSource(measured.source)) rt.contextCandidate = null;
    let learned: Partial<Member> = {};
    if (measured.learned !== null) {
      if (measured.source === "screen") {
        const candidate = rt.contextCandidate;
        if (member.contextWindow === measured.learned) {
          rt.contextCandidate = null;
        } else if (candidate && candidate.tokens !== e.tokens && Math.abs(candidate.window - measured.learned) / candidate.window <= 0.05) {
          learned = { contextWindow: measured.learned, contextWindowSource: "screen" };
          rt.contextCandidate = null;
        } else {
          rt.contextCandidate = { sessionId: member.sessionId, window: measured.learned, tokens: e.tokens! };
        }
      } else {
        learned = { contextWindow: measured.learned, contextWindowSource: measured.source ?? null };
      }
    }
    this.store.patchMember(member.id, { ...(measured.pct !== null ? { contextPct: measured.pct } : {}), ...learned });
  }

  /**
   * 뒤 작업 기다림이 시작되거나 끝났다(herdr). 기다리는 동안은 그 팀이 일하는 중이라 working 으로 두고, 묶인 글은 곧바로 넣는다.
   * 턴 안에서 들어오면 곧이어 오는 turn_end 가 상태를 정한다.
   */
  private onBackground(member: Member, label: string | null): void {
    const rt = this.runtime(member.id);
    if (rt.background === label) return;
    rt.background = label;
    if (label) this.store.appendActivity(member.id, "system", `턴을 마치고 뒤 작업(${label})을 기다립니다. 그동안 온 글은 바로 넣습니다`);
    const fresh = this.store.requireMember(member.id);
    if ((fresh.status === "working" || fresh.status === "waiting" || fresh.status === "idle") && !this.isBusy(fresh)) this.settle(fresh);
    if (label) void this.pump(member.id);
  }

  /** 깨어 있는 직원이 상한을 넘으면 총괄에게 후보만 알린다. 잠재우기는 총괄 판단(§6). */
  private checkAwakeLimit(projectId: string): void {
    const max = this.store.getSettings().maxAwakeWorkers;
    const workers = this.store.listMembers(projectId).filter((m) => m.kind === "worker" && m.origin !== "manual");
    // 칸이 없는 offline(가져온 명부, 사라진 칸)은 깨어 있는 세션이 아니다.
    const awake = workers.filter((m) => m.status !== "asleep" && m.status !== "offline");
    if (awake.length <= max) return;
    const conductor = this.store.getConductor(projectId);
    if (!conductor) return;
    const candidates = awake
      .filter((m) => (m.status === "idle" || m.status === "waiting") && m.queuedCount === 0 && this.store.listOpenDecisionsByMember(m.id).length === 0)
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .map((m) => m.name);
    const list = candidates.length ? `잠재울 후보(오래된 순): ${candidates.join(", ")}` : "지금 잠재울 수 있는 직원이 없습니다";
    this.store.enqueue({
      projectId,
      memberId: conductor.id,
      kind: "system",
      text: formatSystem(`깨어 있는 직원이 ${awake.length}명으로 상한 ${max}명을 넘었습니다. ${list}`),
      wake: false,
    });
  }

  // ---- 도움 ----
  /** 서버 알림 글(대화 화면의 '시스템' 줄). 업무는 부르는 쪽이 정한다(memberNotice). */
  private systemMessage(projectId: string, body: string, taskId: string | null = null): void {
    this.store.createMessage({ projectId, who: "시스템", kind: "시스템", body, taskId });
  }

  /**
   * 직원의 실행·세션에 관한 서버 알림. 대화 화면에 보이는 글이라 업무에 붙는다(본사 제외). 그 실행이 받은 업무가
   * 하나로 정해지면 그 업무, 없거나 여럿이면 그 직원의 '세션 알림' 업무(출처 키로 직원마다 한 번만 만든다)에 한 번만 남긴다.
   * 마지막 업무로 짐작하지 않고, 여러 업무에 같은 글을 복사하지 않는다. 여럿이면 받은 업무를 글에 적는다.
   */
  private memberNotice(member: Member, body: string, deliveries?: Delivery[]): void {
    if (!this.usesTasks(member.projectId)) return this.systemMessage(member.projectId, body);
    const tasks = this.certainTasks(this.noticeDeliveries(member, deliveries));
    if (tasks.length === 1) return this.systemMessage(member.projectId, body, tasks[0]!);
    this.systemMessage(member.projectId, body + this.receivedTasksNote(tasks), this.serverTask(member, "notice").id);
  }

  /** 알림의 근거가 되는 전달: 넘겨받은 것, 없으면 지금 턴, 없으면 그 직원의 끝나지 않은 실행. */
  private noticeDeliveries(member: Member, deliveries?: Delivery[]): Delivery[] {
    if (deliveries?.length) return deliveries;
    const turn = this.runtimes.get(member.id)?.turn?.deliveries;
    if (turn?.length) return turn;
    const run = this.store.listPendingExecutions().filter(r => r.memberId === member.id).at(-1);
    return run ? this.runDeliveries(run) : [];
  }

  private runDeliveries(run: ExecutionJournal): Delivery[] {
    return run.deliveryIds.map(id => this.store.getDelivery(id)).filter((d): d is Delivery => !!d);
  }

  /**
   * 그 턴의 글이 어느 업무의 것인지 확실한 업무들. 깨운 전달(wake)의 업무만 본다: 함께 묶여 온 조용한 안내(wake=false)는
   * 맥락일 뿐 답할 일이 아니다. 깨운 전달에 업무가 없으면 받은 전달 전부의 업무. 하나면 확실하고, 여럿이면 정할 수 없다.
   */
  private certainTasks(deliveries: Delivery[] | undefined): string[] {
    const waking = this.turnTasks(deliveries?.filter(d => d.wake));
    return waking.length ? waking : this.turnTasks(deliveries);
  }

  /** 근거 없는(또는 여러 업무가 섞인) 서버 글을 모으는 직원별 업무. 출처 키로 한 번만 만들고 이름에 목적을 쓴다. */
  private serverTask(member: Member, kind: "notice" | "mixed"): Task {
    const title = `${member.name} ${kind === "notice" ? "세션 알림" : "여러 업무 결과"}`;
    return this.store.ensureSourceTask({ projectId: member.projectId, sourceRef: `${kind}:member:${member.id}`, title: [...title].slice(0, 60).join(""), origin: "server" }).task;
  }

  private receivedTasksNote(tasks: string[]): string {
    if (tasks.length < 2) return "";
    return `\n\n(업무 ${tasks.length}곳을 받은 실행이라 어느 업무의 글인지 정할 수 없어 여기에 한 번만 남겼습니다. 받은 업무: ${tasks.map(id => `#${id} '${this.store.getTask(id)?.title ?? ""}'`).join(", ")})`;
  }

  private runtime(memberId: string): Runtime {
    let rt = this.runtimes.get(memberId);
    if (!rt) {
      rt = { contextCandidate: null, turn: null, pumping: null, pumpStage: null, pumpSince: null, pumpReported: false, again: false, posted: false, delegated: false, direct: false, skipCompact: false, compactRequest: null, compactTimer: null, retryTimer: null, inputBusySince: null, wantParallel: null, starting: null, reopening: null, closing: false, parallelFails: 0, reattaching: false, holdUntil: 0, configFails: 0, configGaveUp: null, toolsGaveUp: null, background: null, stopRequest: null };
      this.runtimes.set(memberId, rt);
    }
    return rt;
  }

  private clearRuntime(memberId: string, rt: Runtime): void {
    if (rt.compactTimer) clearTimeout(rt.compactTimer);
    if (rt.retryTimer) clearTimeout(rt.retryTimer);
    this.waiting.delete(memberId);
    this.runtimes.delete(memberId);
  }

  /** 이 직원의 세션을 다루는 실행 방식. 세션을 시작한 실행기로 계속 다룬다. 아직 없으면 전역 설정. */
  private backendOf(member: Member): Backend {
    return member.backend ?? this.store.effectiveBackend();
  }

  private runnerOf(member: Member): Runner {
    const backend = this.backendOf(member);
    const runner = this.runners.get(backend);
    if (!runner) throw new ApiError(503, `실행기가 없습니다: ${backend}`);
    return runner;
  }

  /** 세션을 새로 띄우거나 다시 열 때. 전역 실행 방식을 따르고 그것을 기억한다. */
  private openRunner(member: Member): Runner {
    if (this.runners.has("core") && member.backend !== "core" && (member.sessionId || member.paneId)) {
      throw new ApiError(409, "이전 실행기의 세션은 자동 전환하지 않습니다. 새 직원을 만들거나 CLI 전환으로 새 세션을 시작하세요");
    }
    const backend = this.store.effectiveBackend();
    const runner = this.runners.get(backend);
    if (!runner) throw new ApiError(503, `실행기가 없습니다: ${backend}`);
    if (backend === "core" && this.store.getMember(member.id)) this.store.ensureContextState(member.id);
    if (this.store.getMember(member.id) && member.backend !== backend) {
      this.store.patchMember(member.id, { backend });
      member.backend = backend;
    }
    return runner;
  }

  private runnerMember(member: Member, _project: Project): RunnerMember {
    const settings = this.store.getSettings();
    return {
      id: member.id,
      projectId: member.projectId,
      handle: member.handle,
      name: member.name,
      cli: member.cli,
      parallel: member.parallel,
      cwd: member.cwd,
      sessionId: member.sessionId,
      paneId: member.paneId,
      ...memberConfig(member, settings.ranks, settings.codexRanks),
      subagentModel: staffSubagent(member.cli, settings.ranks, settings.codexRanks).subagentModel,
      permissionMode: settings.permissionMode,
      kind: member.kind,
      origin: member.origin,
      sessionGeneration: this.store.getMember(member.id) ? this.store.memberRevisions(member.id).sessionGeneration : undefined,
    };
  }

  private rulesFor(member: Member, project: Project): string {
    const conductor = this.store.getConductor(project.id);
    const staffEffort = member.cli === "codex" || member.cli === "antigravity" ? null : this.store.getSettings().ranks.staff.effort;
    return renderRole(member.kind, { PROJECT: project.name, NAME: member.name, ROLE: member.role, CONDUCTOR: conductor?.name ?? "총괄", SUBAGENT_EFFORT: staffEffort ? `- 서브에이전트·워크플로를 부를 때 effort=${staffEffort} 을 넘긴다.` : "", MEMORY: this.memoryEnabledFor(member) ? memoryGuide(member.kind) : "" }, this.config.rolesDir);
  }

  /** 시스템 프롬프트·MCP 설정 파일을 쓴다. MCP 설정에 멤버 토큰이 들어가 본인만 읽게 한다. */
  private writeRunFiles(member: Member, project: Project, resume: boolean = !!member.sessionId): StartOpts {
    const dir = join(this.config.home, "run");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const systemPromptFile = join(dir, `${member.id}.rules.md`);
    const mcpConfigFile = join(dir, `${member.id}.mcp.json`);
    writeFileSync(systemPromptFile, this.rulesFor(member, project));
    const env = { IAMCEO_URL: this.serverUrl, IAMCEO_TOKEN: this.store.getMemberToken(member.id) };
    writeFileSync(mcpConfigFile, `${JSON.stringify({ mcpServers: { iamceo: { ...mcpCommand(), env } } }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(mcpConfigFile, 0o600);
    // 넘겨받은 칸은 대표의 탭에 있다. 그 세션을 근거로 대표의 탭을 프로젝트 탭으로 믿으면 새 칸이 거기 생긴다.
    const projectSessions = this.store.listMembers(project.id).flatMap((m) => (m.origin === "adopted" ? [] : (m.sessionId ?? [])));
    // 바이패스는 대표가 설정에서 고른 모드다. 첫 경고 창이 아무도 안 보는 칸에서 일을 막지 않게 한다.
    let settingsFile: string | undefined;
    // Claude only (also legacy rows without a cli): Codex and Antigravity take their settings as launch arguments.
    if (member.cli !== "codex" && member.cli !== "antigravity") {
      settingsFile = join(dir, `${member.id}.settings.json`);
      const settings = { statusLine: writeStatuslineWrapper(this.config.home), hooks: guardHooks(this.config.home),
        ...(this.store.getSettings().permissionMode === "bypassPermissions" ? { skipDangerousModePermissionPrompt: true } : {}) };
      writeFileSync(settingsFile, `${JSON.stringify(settings)}\n`, { mode: 0o600 });
    }
    return { systemPromptFile, mcpConfigFile, resume, herdrTabId: project.herdrTabId, projectName: project.name, projectSessions, settingsFile };
  }
}

/**
 * 인용이 낱말 경계에 맞게 들어 있는가. '삭제는 하지 마'에서 '삭제'만 잘라 오면 조사에서 끊겨 맞지 않는다.
 * 공백·문장 부호에서 시작하고 끝나야 한다.
 */
function includesWhole(text: string, quote: string): boolean {
  const boundary = /[\s.,!?;:…·"'“”‘’()[\]{}<>~\-—–/]/;
  for (let at = text.indexOf(quote); at >= 0; at = text.indexOf(quote, at + 1)) {
    const before = at === 0 ? " " : text[at - 1]!;
    const after = at + quote.length >= text.length ? " " : text[at + quote.length]!;
    if (boundary.test(before) && boundary.test(after)) return true;
  }
  return false;
}

/** 깨움 없는 것을 앞에 묶는다(§6). */
// ---- 기억 운영 ----
/** 새 일을 여는 전달. 결재 답·할 일 알림·보고·시스템 글·압축은 같은 일의 후속이라 기억을 다시 찾지 않는다. */
const MEMORY_SEARCH_KINDS: ReadonlySet<DeliveryKind> = new Set(["user_message", "instruction"]);
/** 이보다 짧은 글("응", "진행해")은 앞서 찾은 기억을 그대로 쓴다. */
const MEMORY_QUERY_MIN = 12;
const MEMORY_REUSE_MS = 10 * 60_000;
const MEMORY_AUTO_LIMIT = 3;
const MEMORY_SEARCH_TIMEOUT_MS = 6_000;
const MEMORY_EXCERPT = 360;

export interface OwnerMemoryInput {
  messageIds: string[];
  type: MemoryCapture["type"];
  scope: MemoryCapture["scope"];
  interpretation: string;
  standing?: boolean;
  standingQuote?: string | null;
  reasonQuote?: string | null;
  fileIds?: string[];
  supersedes?: string | null;
}

/** 여러 글을 검색어 하나로 묶는다. 서버 표지·빈 줄은 빼고 2,000자 안으로 자른다. */
export function memoryQuery(texts: string[]): string {
  return normalizeSpace(texts.map((t) => t.replace(/#iamceo_[A-Za-z0-9_-]+/g, "")).join("\n")).slice(0, 2000).trim();
}

/** 대표 글에서 인용(> 줄)을 뺀 대표 자신의 말. */
export function ownText(body: string): string {
  return body.split("\n").filter((line) => !/^\s*>/.test(line)).join("\n").trim();
}

/** 자료의 그때 판: 자료 id 는 판마다 새로 생기고, 같은 id 안에서는 본문 지문으로 가린다. */
function fileVersion(file: { createdAt: string; body: string }): string {
  return `${file.createdAt}·${createHash("sha256").update(file.body ?? "").digest("hex").slice(0, 8)}`;
}


/** 일 시작 전 검색 결과 글. 과거 기록일 뿐이고 지금 원문·승인이 앞선다는 것과 전문 확인 방법을 함께 적는다. */
export function formatMemoryContext(found: Experience[], semanticIndex: string | null): string {
  if (!found.length) return "관련 기억 없음(일 시작 전에 서버가 이 프로젝트 기억을 찾았고 맞는 것이 없었다). 지금 근거로 진행한다. 새 조건이 나오면 memory_search 로 다시 찾는다.";
  const lines = [
    `관련 기억 ${found.length}건(일 시작 전에 서버가 이 프로젝트 기억에서 찾음${semanticIndex && semanticIndex !== "available" ? ` · 의미 색인 ${semanticIndex}, 키워드 검색 결과` : ""}).`,
    "과거 기록이다. 지금 대표 원문·승인·정본이 앞선다. 중요한 판단에 쓸 후보만 memory_get 으로 전문·근거를 확인하고, 적용·기각 이유를 보고에 적는다. 같은 일의 후속 대화에서는 이 결과를 다시 쓴다.",
  ];
  found.forEach((e, i) => {
    const when = e.created_at ? new Date(e.created_at * 1000).toISOString().slice(0, 10) : "";
    const body = normalizeSpace(e.content).slice(0, MEMORY_EXCERPT);
    lines.push(`${i + 1}. ${e.id} [${memoryKindLabel(e)}${when ? ` · ${when}` : ""}${e.excerpted || e.content.length > MEMORY_EXCERPT ? " · 발췌" : ""}] ${normalizeSpace(e.summary)}`);
    lines.push(quoteBlock(body));
  });
  return lines.join("\n");
}

/** 검색 실패 글. '검색 완료'가 아니라는 것과 다음 행동을 적는다. 다시 시도는 직원이 한 번만 한다. */
export function formatMemoryFailure(detail: string): string {
  return `기억 검색 실패(${detail}). 기억을 찾지 못한 것이지 '관련 기억 없음'이 아니다. 지금 근거로 진행하고, 이전 결정 해석이 꼭 필요한 부분만 memory_search 를 한 번 다시 부른다. 그래도 안 되면 보고에 '기억 검색 실패'라고 적는다.`;
}

/** 역할 글의 기억 운영 단락. 기억이 켜진 프로젝트에만 붙는다. */
export function memoryGuide(kind: MemberKind): string {
  const common = [
    "## 개발 기억",
    "이 프로젝트는 개발 기억(과거 결정·실수·교훈·결과)을 쓴다. 새 일(대표 글·총괄의 위임)이 들어올 때 서버가 먼저 찾아 `[시스템] 관련 기억` 글로 함께 넣는다.",
    "- 그 기억은 과거 기록이다. 지금 대표 원문·승인·정본이 앞선다. 중요한 판단에 쓸 후보만 `memory_get`으로 전문·근거를 확인한다. '대표 결재 답'·'대표 원문' 기록이 아닌 것(직원·AI 보고 등)을 대표 결정으로 읽지 않는다.",
    "- 같은 일의 후속 대화에서는 받은 기억을 다시 쓴다. 새 조건·정정·반례가 나오면 `memory_search`로 다시 찾는다. 상태 안내·기존 결과 재보고에는 찾지 않는다.",
    "- '기억 검색 실패'는 '관련 기억 없음'이 아니다. 지금 근거로 진행하고, 이전 결정 해석이 꼭 필요할 때만 한 번 다시 찾는다.",
  ];
  if (kind === "conductor") return [...common,
    "- 대표가 대화에서 결정·제약을 밝히거나 수정 이유·피드백을 주면 `memory_capture`로 남긴다. 그 대표 글 끝의 `#id`를 `message_ids`에 넣는다. 원문·시각·작업은 서버가 고정하고, 네 해석은 `interpretation`에 따로 쓴다.",
    "  - 남기지 않는다: 결재 카드 답(서버가 올린다), 직원 보고·인용·AI 추론, 아직 논의 중인 안, 인사·확인·진행 글.",
    "  - 이번 한 번의 선택은 `scope`를 그 작업(`task`)·자료(`artifact`)로 좁힌다. 대표가 “앞으로·언제나”처럼 공통으로 정한 것만 `standing`과 그 대표 문장(`standing_quote`)을 넣는다.",
    "  - 같은 수정 라운드의 글은 끝난 뒤 한 번에 묶어 남긴다. 앞 기록을 고치거나 라운드가 이어져 다시 남길 때는 `supersedes`에 앞 기록 id 를 넣는다(넣지 않으면 따로 남는다).",
    "  - `memory_feedback`은 남은 기억이 일에 도움이 됐는지에 대한 투표다. 대표 피드백 기록과 다르다.",
    "- 직원에게 맡길 때 적용할 기억이 있으면 그 id와 적용 이유를 지시에 적는다.",
  ].join("\n") + "\n";
  return [...common,
    "- 대표 결정은 총괄이 남긴다. 직원은 `memory_record`로 대표 결정을 기록하지 않는다. 확인한 결과·교훈만 `memory_record`(`basis: verified`, 근거는 `evidence`)로 남긴다.",
  ].join("\n") + "\n";
}

function orderForBundle(pending: Delivery[]): Delivery[] {
  return [...pending.filter((d) => !d.wake), ...pending.filter((d) => d.wake)];
}

const NO_INPUT_BOX = "입력칸을 찾지 못했습니다. 선택 창이나 다른 화면이 떠 있는 것 같습니다. 닫은 뒤 다시 시도하세요";

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_\-./:=@]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function adoptWarnings(project: Project, live: LiveAgent, seen: PaneInspection | null): AdoptWarning[] {
  const out: AdoptWarning[] = [];
  const traces = seen?.traces ?? [];
  if (traces.length > 0) out.push({ kind: "conductor", text: `다른 지휘자가 있을 수 있습니다. ${traces.join(" · ")}. 지휘자가 둘이면 지시와 보고가 엇갈립니다` });
  if (live.cwd && live.cwd !== project.cwd && !live.cwd.startsWith(`${project.cwd.replace(/\/$/, "")}/`)) out.push({ kind: "folder", text: `이 프로젝트 폴더가 아닙니다. 세션 폴더: ${live.cwd} · 프로젝트 폴더: ${project.cwd}` });
  if (seen?.inputEmpty === false) out.push({ kind: "input", text: "입력칸에 쓰던 글이 있습니다. 넘겨받으면 그 글을 지우고 규칙을 넣습니다" });
  return out;
}

/** 서버 컴퓨터의 터미널에서 CLI 를 부르는 명령. 화면의 안내가 그대로 동작해야 한다. */
export function cliCommand(): string {
  const { command, args } = mcpCommand();
  return [command, ...args.slice(0, -1)].map(shellQuote).join(" ");
}

/** Claude 직원의 PreToolUse 훅 명령(셸 한 줄). 개발 실행은 서버 없이 판정 모듈만 읽는 진입 파일을 쓴다. */
export function guardCommand(home: string): string {
  const base = import.meta.path.startsWith("/$bunfs/") ? [process.execPath, "guard"] : [process.execPath, resolve(import.meta.dir, "..", "bin", "iamceo-guard.ts")];
  return [...base, "--home", home].map(shellQuote).join(" ");
}

/** IAMCEO 가 띄우는 Claude 세션에만 넘기는 훅 설정. 지우기·게시는 묻고 비밀 파일은 거절한다(server/harness-guard.ts). */
export function guardHooks(home: string): Record<string, unknown> {
  return { PreToolUse: [{ matcher: "Bash|Read|Write|Edit|MultiEdit|NotebookEdit|Grep|Glob", hooks: [{ type: "command", command: guardCommand(home), timeout: 10 }] }] };
}

/** 컴파일 실행이면 자기 자신, 아니면 bun 으로 CLI 를 띄운다. */
export function mcpCommand(): { command: string; args: string[] } {
  if (import.meta.path.startsWith("/$bunfs/")) return { command: process.execPath, args: ["mcp"] };
  return { command: process.execPath, args: [resolve(import.meta.dir, "..", "bin", "iamceo.ts"), "mcp"] };
}

/** Staff subagent model/effort the member's CLI passes on. Antigravity picks its own subagent model. */
function staffSubagent(cli: CliProvider, ranks: Settings["ranks"], codexRanks: Settings["codexRanks"]): { subagentModel: string | null; subagentEffort: Settings["ranks"]["staff"]["effort"] | null } {
  if (cli === "codex") return { subagentModel: codexRanks.staff.model, subagentEffort: null };
  if (cli === "antigravity") return { subagentModel: null, subagentEffort: null };
  return { subagentModel: ranks.staff.model, subagentEffort: ranks.staff.effort };
}

/** 명세의 주장만 믿지 않고 파일·해시·DB를 현재 검증한 같은 원본의 백업만 반환한다. */
function readVerifiedBackups(backupDir: string, limit: number, sourceHome: string): { id: string; createdAt: string; schemaVersion: number; databaseBytes: number; verified: boolean; appVersion: string }[] {
  const home = normalizeHome(sourceHome);
  return listBackups(backupDir).filter(s => s.manifest.sourceHome === home && s.manifest.database.size > 0).slice(0, limit).map(({manifest:m}) => ({
    id: m.id, createdAt: m.createdAt, schemaVersion: m.schemaVersion, databaseBytes: m.database.size, verified: true, appVersion: m.applicationVersion,
  }));
}
