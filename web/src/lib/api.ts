// REST 클라이언트 + 접속 코드 저장. 계약: docs/spec.md §3. 접속 코드는 이 기기 localStorage 에만 둔다.
import type {
  Activity,
  AnswerApprovalReq,
  AnswerReq,
  ApprovalPrompt,
  Attachment,
  Bootstrap,
  CreateProjectReq,
  CreateMemberReq,
  RuntimeInfo,
  Decision,
  Member,
  Message,
  MessagePage,
  MessagePageOptions,
  PatchMemberReq,
  PatchProjectReq,
  Project,
  ProjectState,
  SendMessageReq,
  Settings,
  SettingsPatch,
  TidyResult,
  Todo,
  SyncSnapshot,
} from "@shared/types";
import type { DeliveryNoticePage, DeliveryRecoveryRequest, DeliveryRecoveryResult } from "@shared/types";
import type { MemberConfigWriteResult, ServerCapabilities, SettingsWriteResult, TodoWriteResult } from "@shared/operations";

const CODE_KEY = "iamceo.accessCode";
let credentialGeneration = 0;
export const getCredentialGeneration = (): number => credentialGeneration;

export function getAccessCode(): string | null {
  try {
    return localStorage.getItem(CODE_KEY);
  } catch {
    return null; // 사파리 개인정보 모드 등
  }
}

export function setAccessCode(code: string): void {
  credentialGeneration++;
  localStorage.setItem(CODE_KEY, code);
}

export function clearAccessCode(): void {
  credentialGeneration++;
  try {
    localStorage.removeItem(CODE_KEY);
  } catch {
    // 저장소를 못 쓰는 환경에서는 지울 것도 없다
  }
  // 첨부 쿠키는 HttpOnly 라 서버가 지운다. 실패해도 쿠키는 첨부에만 통하고 코드가 바뀌면 무효다.
  void fetch("/api/files-session", { method: "DELETE" }).catch(() => {});
  void fetch("/api/realtime-session", { method: "DELETE" }).catch(() => {});
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const isUnauthorized = (e: unknown): boolean => e instanceof ApiError && e.status === 401;

/** 화면에 보여 줄 한 줄. */
export function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.status === 0 ? "서버에 연결할 수 없습니다" : e.message;
  return e instanceof Error ? e.message : String(e);
}

let onUnauthorized: () => void = () => {};
/** 저장된 코드가 거부되면(401) 부른다. store 가 접속 코드 화면으로 돌린다. */
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

/** 망이 멈추면 응답도 끊김도 오지 않아 버튼이 말없이 잠긴다(실측: 200초에도 안 끝남). 시간이 지나면 실패로 치고 기존 재시도·재동기화를 탄다. 결재·지시는 멱등이라 다시 보내도 안전하다. */
const READ_TIMEOUT_MS = 30_000;
const WRITE_TIMEOUT_MS = 20_000;
/** 세션을 띄우는 요청. 서버의 띄우기 시간 상한(120초)보다 길게 둔다. */
const SLOW_TIMEOUT_MS = 150_000;

interface RequestOptions { signal?: AbortSignal; revision?: number; contract?: boolean }
async function request<T>(method: string, path: string, body?: unknown, timeoutMs: number | null = method === "GET" ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const generation = credentialGeneration;
  const code = getAccessCode();
  if (code) headers.Authorization = `Bearer ${code}`;
  if (options.contract) headers["X-IAMCEO-Contract"] = "2";
  if (options.revision !== undefined) {
    if (!Number.isSafeInteger(options.revision) || options.revision < 0) throw new ApiError(409, "최신 상태를 확인한 뒤 다시 시도해 주세요");
    headers["If-Match"] = `"${options.revision}"`;
  }
  let payload: BodyInit | undefined;
  if (body instanceof FormData) {
    payload = body; // 경계 문자열은 브라우저가 Content-Type 에 넣는다
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

  const abort = new AbortController();
  const cancel = () => abort.abort();
  if (options.signal?.aborted) throw new ApiError(0, "요청을 취소했습니다");
  options.signal?.addEventListener("abort", cancel, { once: true });
  const timer = timeoutMs === null ? null : setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetch(path, { method, headers, body: payload, signal: abort.signal, cache: "no-store", credentials: "same-origin" });
    if (!res.ok) {
      if (res.status === 401 && generation === credentialGeneration && code === getAccessCode()) onUnauthorized();
      throw new ApiError(res.status, await readError(res));
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(0, e instanceof Error ? e.message : "network error");
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
  }
}

async function readError(res: Response): Promise<string> {
  const fallback = `요청 실패 (${res.status})`;
  try {
    const text = await res.text();
    if (!text) return fallback;
    try {
      const j = JSON.parse(text) as { error?: unknown; message?: unknown };
      const m = j.error ?? j.message;
      return typeof m === "string" && m ? m : fallback;
    } catch {
      return text.length <= 200 ? text : fallback;
    }
  } catch {
    return fallback;
  }
}

const seg = encodeURIComponent;
const post = <T>(path: string, body?: unknown) => request<T>("POST", path, body);
const slowPost = <T>(path: string, body?: unknown) => request<T>("POST", path, body, SLOW_TIMEOUT_MS);
const get = <T>(path: string, signal?: AbortSignal) => request<T>("GET", path, undefined, READ_TIMEOUT_MS, { signal });

export const api = {
  bootstrap: (signal?: AbortSignal) => get<Bootstrap>("/api/bootstrap", signal),
  runtime: (signal?: AbortSignal) => get<RuntimeInfo>("/api/runtime", signal),
  capabilities: (signal?: AbortSignal) => get<ServerCapabilities>("/api/capabilities", signal),
  realtimeSession: (signal?: AbortSignal) => request<void>("POST", "/api/realtime-session", undefined, WRITE_TIMEOUT_MS, { signal }),
  sync: (projectId: string, signal?: AbortSignal) => get<SyncSnapshot>(`/api/sync?projectId=${seg(projectId)}`, signal),
  /** <img>·<video> 가 쓸 첨부 쿠키를 받는다. 화면을 그리기 전에 부른다. */
  filesSession: () => post<void>("/api/files-session"),

  projectState: (id: string, signal?: AbortSignal) => get<ProjectState>(`/api/projects/${seg(id)}/state`, signal),
  archivedProjects: () => get<Project[]>("/api/projects/archived"),
  createProject: (req: CreateProjectReq) => slowPost<Project>("/api/projects", req),
  patchProject: (id: string, req: PatchProjectReq) => request<Project>("PATCH", `/api/projects/${seg(id)}`, req, SLOW_TIMEOUT_MS),
  createMember: (id: string, req: CreateMemberReq) => slowPost<Member>(`/api/projects/${seg(id)}/members`, req),
  startConductor: (id: string) => slowPost<Member>(`/api/projects/${seg(id)}/conductor/start`),

  messages: (id: string, opts: { before?: string; limit?: number } = {}, signal?: AbortSignal) => {
    const q = new URLSearchParams();
    if (opts.before) q.set("before", opts.before);
    if (opts.limit) q.set("limit", String(opts.limit));
    const s = q.toString();
    return get<Message[]>(`/api/projects/${seg(id)}/messages${s ? `?${s}` : ""}`, signal);
  },
  message: (id: string, signal?: AbortSignal) => get<Message>(`/api/messages/${seg(id)}`, signal),
  messagePage: (id: string, opts: MessagePageOptions = {}, signal?: AbortSignal) => {
    const q = new URLSearchParams({ scope: opts.scope?.kind ?? "project" });
    if (opts.scope?.kind === "member") q.set("memberId", opts.scope.memberId);
    if (opts.scope?.kind === "task") q.set("taskId", opts.scope.taskId);
    if (opts.cursor) q.set("cursor", opts.cursor);
    if (opts.limit !== undefined) q.set("limit", String(opts.limit));
    return get<MessagePage>(`/api/projects/${seg(id)}/messages/page?${q}`, signal);
  },
  sendMessage: (id: string, req: SendMessageReq) => post<Message>(`/api/projects/${seg(id)}/messages`, req),

  /** to 를 주면 서버가 받기 전에 연결부터 본다(끝까지 올린 뒤 보내기에서 거부당하지 않게). */
  upload: (file: File | Blob, name?: string, to?: { project: string; target?: string | null }) => {
    const form = new FormData();
    if (name !== undefined) form.append("file", file, name);
    else form.append("file", file);
    const q = new URLSearchParams();
    if (to) q.set("project", to.project);
    if (to?.target) q.set("target", to.target);
    const s = q.toString();
    return request<Attachment>("POST", `/api/uploads${s ? `?${s}` : ""}`, form, null); // 50MB 까지라 시간을 정할 수 없다
  },

  decision: (decisionId: string, signal?: AbortSignal) => get<Decision>(`/api/decisions/${seg(decisionId)}`, signal),
  doneDecisions: (projectId: string, opts: { before?: string; limit?: number } = {}, signal?: AbortSignal) => {
    const q = new URLSearchParams();
    if (opts.before) q.set("before", opts.before);
    if (opts.limit) q.set("limit", String(opts.limit));
    const s = q.toString();
    return get<Decision[]>(`/api/projects/${seg(projectId)}/decisions${s ? `?${s}` : ""}`, signal);
  },
  answer: (decisionId: string, req: AnswerReq) => request<Decision>("POST", `/api/decisions/${seg(decisionId)}/answer`, req, WRITE_TIMEOUT_MS, { contract: req.expectedVersion !== undefined }),
  todoDone: (todoId: string, done: boolean) => post<Todo>(`/api/todos/${seg(todoId)}/done`, { done }),
  /** AI 가 닫은 결재를 다시 연다. 결재할 항목으로 돌아간다. */
  reopenDecision: (decisionId: string) => post<Decision>(`/api/decisions/${seg(decisionId)}/reopen`),
  /** 총괄에게 판 정리를 맡긴다. 총괄이 없거나 잠들었으면 띄우므로 오래 걸릴 수 있다. */
  tidy: (projectId: string) => slowPost<TidyResult>(`/api/projects/${seg(projectId)}/tidy`),

  activity: (memberId: string, limit?: number, signal?: AbortSignal) =>
    get<Activity[]>(`/api/members/${seg(memberId)}/activity${limit ? `?limit=${limit}` : ""}`, signal),
  screen: (memberId: string) => get<{ text: string }>(`/api/members/${seg(memberId)}/screen`),
  /** 조작권 얻기→글→Enter→키→놓기를 서버가 한 번에 한다. 같은 operationId 는 같은 결과(두 번 넣지 않음). */
  terminalSend: (memberId: string, req: { operationId: string; text?: string; submit?: boolean; key?: "enter" | "up" | "down" | "esc" | "tab" | "ctrl+c" | "backspace" }) =>
    post<{ status: "applied" | "refused" | "unknown"; steps: string[]; error?: string; sessionGeneration: number }>(`/api/members/${seg(memberId)}/terminal/send`, req),
  sleep: (memberId: string, force = false) => slowPost<Member>(`/api/members/${seg(memberId)}/sleep`, force ? { force: true } : undefined),
  freshSession: (memberId: string) => slowPost<Member>(`/api/members/${seg(memberId)}/fresh-session`),
  resume: (memberId: string) => slowPost<Member>(`/api/members/${seg(memberId)}/resume`),
  compact: (memberId: string) => post<Member>(`/api/members/${seg(memberId)}/compact`),
  interrupt: (memberId: string) => post<Member>(`/api/members/${seg(memberId)}/interrupt`),
  closeMember: (memberId: string) => post<{ ok: boolean }>(`/api/members/${seg(memberId)}/close`),
  /** herdr 칸에 뜬 권한 승인 창. 승인 창 앞이 아니거나 승인 창으로 알아보지 못하면 null(터미널에서 푼다). */
  approval: (memberId: string) => get<{ approval: ApprovalPrompt | null }>(`/api/members/${seg(memberId)}/approval`),
  /** 고른 선택지를 칸에서 누른다. 서버가 누르기 직전에 다시 읽어 fingerprint 가 다르면 409. note 는 거절일 때만. */
  answerApproval: (memberId: string, req: AnswerApprovalReq) => post<{ ok: true }>(`/api/members/${seg(memberId)}/approval`, req),

  /** 전달 알림(대표 차례·확인 중인 전달). 앱의 전달 알림 패널과 같은 서버 API다. */
  deliveryNotices: (memberId: string, signal?: AbortSignal) => get<DeliveryNoticePage>(`/api/members/${seg(memberId)}/delivery-notices?limit=50`, signal),
  /** 같은 operationId 재요청은 같은 결과를 돌려준다(서버 멱등). */
  recoverDelivery: (deliveryId: string, req: DeliveryRecoveryRequest) => post<DeliveryRecoveryResult>(`/api/deliveries/${seg(deliveryId)}/recovery`, req),

  /** 아티팩트 원본. 격리 칸(ArtifactFrame)에만 넣는다. */
  artifact: (fileId: string) => get<{ html: string }>(`/api/files/${seg(fileId)}/artifact`),

  patchMember: (memberId: string, patch: PatchMemberReq) => request<Member>("PATCH", `/api/members/${seg(memberId)}`, patch, SLOW_TIMEOUT_MS),
  putSettings: (patch: SettingsPatch) => request<Settings>("PUT", "/api/settings", patch),
  putSettingsV2: (patch: SettingsPatch, revision: number) => request<SettingsWriteResult>("PUT", "/api/settings", patch, WRITE_TIMEOUT_MS, { contract: true, revision }),
  patchMemberV2: (id: string, patch: PatchMemberReq, revision: number) => request<MemberConfigWriteResult>("PATCH", `/api/members/${seg(id)}`, patch, SLOW_TIMEOUT_MS, { contract: true, revision }),
  todoDoneV2: (id: string, done: boolean, revision: number) => request<TodoWriteResult>("POST", `/api/todos/${seg(id)}/done`, { done }, WRITE_TIMEOUT_MS, { contract: true, revision }),
};

/** <img>·<video>·<audio> 주소. 태그는 헤더를 못 붙이므로 filesSession 이 준 첨부 쿠키로 인증한다(§3). 주소에 접속 코드를 싣지 않는다. 내려받기는 saveAttachment. */
export function fileUrl(att: Pick<Attachment, "url">): string {
  return att.url;
}

/** 첨부를 헤더 인증으로 받는다. 주소에 접속 코드를 싣지 않으니 표·코드·PDF 처럼 내용을 스크립트로 다룰 때 쓴다. */
export async function fetchAttachment(att: Pick<Attachment, "url">, signal?: AbortSignal): Promise<Response> {
  const generation = credentialGeneration;
  const code = getAccessCode();
  let res: Response;
  try {
    res = await fetch(att.url, { headers: code ? { Authorization: `Bearer ${code}` } : {}, signal });
  } catch (e) {
    throw new ApiError(0, e instanceof Error ? e.message : "network error");
  }
  if (!res.ok) {
    if (res.status === 401 && generation === credentialGeneration && code === getAccessCode()) onUnauthorized();
    throw new ApiError(res.status, await readError(res));
  }
  return res;
}

/** 헤더 인증으로 받아 파일로 저장한다. 형식을 지워 어떤 문서로도 해석되지 않게 한다. */
export async function saveAttachment(att: Pick<Attachment, "url" | "name">): Promise<void> {
  const buf = await (await fetchAttachment(att)).arrayBuffer();
  const href = URL.createObjectURL(new Blob([buf], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = href;
  a.download = att.name;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
  // Safari 는 눌린 뒤에 blob 을 읽으므로 바로 지우지 않는다.
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
}

export function wsUrl(protocol: 1 | 2 = 1): string {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  if (protocol === 2) return `${scheme}://${location.host}/ws?v=2`;
  return `${scheme}://${location.host}/ws?t=${seg(getAccessCode() ?? "")}`;
}
