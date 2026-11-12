// 개발 기억 게이트웨이(Hindsight 색인을 쓰는 hj-brain development-memory) 연결.
// 계약 출처: https://hyejoo-mac-mini.tail5169d3.ts.net/brain-docs/ (2026-11-11 판). 여기 적힌 경로·필드만 쓴다.
//   REST(서비스 키): POST /v1/context · /v1/experiences · /v1/feedback · /v1/revoke, GET /healthz · /v1/stats
//   MCP(작업 키, 상태 없는 JSON-RPC POST): /mcp/{project_id}/{task_id} — search_experiences·get_experience·record_experience·experience_feedback
// 서비스 키는 모든 프로젝트에 닿는 키라 IAMCEO 서버만 쥔다. 직원에게는 키도 MCP 주소도 주지 않고, 서버가 직원의 프로젝트로 범위를 정해 대신 부른다.
// IAMCEO 의 결재·작업·전달·승인 상태의 정본은 IAMCEO DB 다. 게이트웨이에는 사본 기록만 간다.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { Store, MemoryUpload } from "../store.ts";
import type { MemoryServiceInfo } from "../../shared/types.ts";

/** 게이트웨이의 프로젝트·작업·턴 ID 형식: 영문·숫자·_·- 1~100자. */
const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 6;
const CONTENT_MAX = 30_000;

export interface DevMemoryConfig {
  baseUrl: string;
  keyFile: string;
  /**
   * 이전 방식으로 연결을 켠 IAMCEO 프로젝트 id(IAMCEO_MEMORY_PROJECTS). 새 프로젝트는 프로젝트 설정(memory_mode)으로 켜고,
   * 이 목록은 그 값이 없는 이전 프로젝트에만 쓴다. 프로젝트가 끈 값은 이 목록이 덮지 않는다.
   */
  projects: string[];
}

export class MemoryError extends Error {
  constructor(readonly code: "not_configured" | "key_unreadable" | "unreachable" | "http" | "redirect" | "mcp" | "invalid_id", message: string, readonly status?: number, readonly retryable = false) {
    super(message);
  }
}

/** 서버 공통 연결은 환경 변수로만 정한다. 주소·키 파일 중 하나라도 없으면 연결이 없는 상태(외부 호출 0건)다. */
export function devMemoryConfigFromEnv(env: NodeJS.ProcessEnv): DevMemoryConfig | null {
  const baseUrl = env.IAMCEO_MEMORY_URL?.trim();
  const keyFile = env.IAMCEO_MEMORY_KEY_FILE?.trim();
  const projects = (env.IAMCEO_MEMORY_PROJECTS ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  if (!baseUrl || !keyFile) return null;
  return { baseUrl: validateBaseUrl(baseUrl), keyFile, projects };
}

/**
 * 보내면 안 되는 글을 찾는다(키·토큰·비밀번호·개인 키 모양). 찾으면 그 종류를, 없으면 null.
 * 게이트웨이도 일부 키 모양을 거부하지만 모든 민감 정보를 알아보지는 못하므로 보내기 전에 서버가 먼저 거른다.
 * extra: 이 서버가 아는 실제 비밀(접속 코드·서비스 키). 글에 그대로 들어 있으면 막는다.
 */
const SENSITIVE: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "개인 키"],
  [/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{20,}/g, "API 키"],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g, "GitHub 토큰"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "Slack 토큰"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "AWS 키"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/gi, "인증 헤더"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "JWT"],
  [/(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|token|비밀번호|암호|접속\s*코드)\s*[:=]\s*\S{6,}/gi, "비밀번호·키 값"],
];

export function findSensitive(text: string, extra: readonly string[] = []): string | null {
  for (const secret of extra) if (secret && secret.length >= 8 && text.includes(secret)) return "서버 비밀값";
  for (const [re, kind] of SENSITIVE) { re.lastIndex = 0; if (re.test(text)) return kind; }
  return null;
}

/** 서버가 스스로 올리는 글(결재 답 등)은 되물을 사람이 없어 민감해 보이는 부분만 가리고 보낸다. */
export function redactSensitive(text: string, extra: readonly string[] = []): string {
  let out = text;
  for (const secret of extra) if (secret && secret.length >= 8) out = out.split(secret).join("[가림: 서버 비밀값]");
  for (const [re, kind] of SENSITIVE) out = out.replace(re, `[가림: ${kind}]`);
  return out;
}

/** 문서 계약: 주소에는 경로·자격 증명이 없어야 하고, 루프백 또는 Tailscale(.ts.net) HTTPS 만 쓴다. 재지정은 따라가지 않는다. */
export function validateBaseUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`IAMCEO_MEMORY_URL 형식이 잘못되었습니다: ${raw}`); }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) throw new Error("IAMCEO_MEMORY_URL 에는 경로·자격 증명·쿼리를 넣지 않습니다");
  if (!(loopback && (url.protocol === "http:" || url.protocol === "https:")) && !(url.protocol === "https:" && url.hostname.endsWith(".ts.net"))) {
    throw new Error("IAMCEO_MEMORY_URL 은 루프백 주소나 Tailscale(.ts.net) HTTPS 주소여야 합니다");
  }
  return url.origin;
}

/** IAMCEO 프로젝트 → 게이트웨이 project_id. IAMCEO 프로젝트 경계를 그대로 기억 범위로 쓴다. */
export function memoryProjectId(projectId: string): string {
  return checkedId(`iamceo-${projectId}`);
}

/** IAMCEO 작업이 있으면 그 작업 id, 없으면 직원별 '전체' 범위. */
export function memoryTaskId(taskId: string | null, memberId: string): string {
  return checkedId(taskId ?? `iamceo-${memberId}-general`);
}

function checkedId(id: string): string {
  if (!ID_RE.test(id)) throw new MemoryError("invalid_id", `개발 기억 ID 형식에 맞지 않습니다: ${id}`);
  return id;
}

export interface Experience {
  id: string;
  project_id: string;
  event_id: string;
  kind: string;
  summary: string;
  content: string;
  source: Record<string, unknown>;
  status?: string;
  is_rule?: boolean;
  feedback?: unknown;
  created_at?: number;
  excerpted?: boolean;
  evidence?: unknown[];
}

export interface ExperienceInput {
  event_id: string;
  kind: "decision" | "mistake" | "lesson" | "outcome";
  summary: string;
  content: string;
  source: { task_id: string; turn_id?: string; item_id?: string; commit_sha?: string; service: string };
  evidence?: { kind: string; text: string }[];
  capture?: "complete" | "excerpt";
  /** 같은 프로젝트의 앞 경험 id. 게이트웨이는 대체된 원본을 지우지 않고 기본 검색에서 뺀다(신뢰하는 REST 서비스만). */
  supersedes?: string;
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export class DevMemory {
  private readonly sessions = new Map<string, { path: string; token: string; initialized: boolean }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private flushing: Promise<void> | null = null;
  private gate: (projectId: string) => boolean;
  private state: MemoryServiceInfo = { state: "unknown", detail: null, checkedAt: null };

  constructor(readonly config: DevMemoryConfig, private readonly fetchImpl: Fetch = fetch) {
    this.gate = (projectId) => this.config.projects.includes(projectId);
  }

  /** 어느 프로젝트가 기억을 쓰는지는 서버(프로젝트 설정)가 정한다. 정하지 않으면 환경 목록만 본다. */
  setProjectGate(gate: (projectId: string) => boolean): void {
    this.gate = gate;
  }

  enabledFor(projectId: string): boolean {
    return this.gate(projectId);
  }

  /** 마지막으로 확인한 연결 상태. 화면에 사실대로 보인다(키 내용·전체 경로는 싣지 않는다). */
  status(): MemoryServiceInfo {
    return { ...this.state };
  }

  private note(state: MemoryServiceInfo["state"], detail: string | null): void {
    this.state = { state, detail, checkedAt: new Date().toISOString() };
  }

  /** 키 파일을 읽을 수 있는지와 게이트웨이 /healthz(인증 없음)를 본다. 키 내용은 밖으로 내지 않는다. */
  async checkHealth(): Promise<MemoryServiceInfo> {
    try { this.key(); } catch (e) { this.note("key_unreadable", (e as Error).message); return this.status(); }
    try {
      const res = await this.fetchImpl(this.config.baseUrl + "/healthz", { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.ok) this.note("ok", null);
      else this.note("unreachable", `개발 기억 서버 상태 확인이 실패했습니다(HTTP ${res.status})`);
    } catch (e) {
      this.note("unreachable", `개발 기억 서버에 닿지 못했습니다: ${(e as Error).name === "TimeoutError" ? "시간 초과" : (e as Error).message}`);
    }
    return this.status();
  }

  private key(): string {
    try {
      const st = statSync(this.config.keyFile);
      if (!st.isFile()) throw new Error("not a file");
      const key = readFileSync(this.config.keyFile, "utf8").trim();
      if (!key) throw new Error("empty");
      return key;
    } catch {
      throw new MemoryError("key_unreadable", `개발 기억 서비스 키 파일을 읽을 수 없습니다(${this.config.keyFile.split("/").pop()})`);
    }
  }

  /** 글에 서비스 키가 그대로 들어 있는지 보려고 쓴다. 키를 읽지 못하면 빈 목록. */
  secrets(): string[] {
    try { return [this.key()]; } catch { return []; }
  }

  private async send(path: string, body: unknown, token: string, timeoutMs = TIMEOUT_MS): Promise<{ status: number; json: unknown }> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.config.baseUrl + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const err = new MemoryError("unreachable", `개발 기억 서버에 닿지 못했습니다: ${(e as Error).name === "TimeoutError" ? "시간 초과" : (e as Error).message}`, undefined, true);
      this.note("unreachable", err.message);
      throw err;
    }
    if (res.status < 500) this.note("ok", null);
    if (res.status >= 300 && res.status < 400) throw new MemoryError("redirect", "개발 기억 서버가 다른 주소로 보냈습니다. 자격 증명을 옮기지 않으려고 따라가지 않았습니다", res.status);
    const text = await res.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (res.status === 202) return { status: res.status, json };
    if (!res.ok) {
      const code = json && typeof json === "object" && "error" in json ? String((json as { error: unknown }).error) : `HTTP ${res.status}`;
      throw new MemoryError("http", `개발 기억 서버가 거절했습니다(${res.status} ${code})`, res.status, res.status === 503 || res.status >= 500);
    }
    return { status: res.status, json };
  }

  private rest<T>(path: string, body?: unknown, timeoutMs?: number): Promise<T> {
    let key: string;
    try { key = this.key(); } catch (e) { this.note("key_unreadable", (e as Error).message); throw e; }
    return this.send(path, body, key, timeoutMs).then((r) => r.json as T);
  }

  async health(): Promise<{ ok: boolean }> {
    const res = await this.fetchImpl(this.config.baseUrl + "/healthz", { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    return { ok: res.ok };
  }

  /** 검색. 프로젝트는 호출한 직원의 IAMCEO 프로젝트로만 정해진다. 함께 온 작업 MCP 키는 서버 안에만 둔다. */
  async context(projectId: string, taskId: string, query: string, limit = 5, timeoutMs?: number): Promise<{ experiences: Experience[]; semantic_index?: string; truncated?: boolean }> {
    if (!this.enabledFor(projectId)) throw new MemoryError("not_configured", "이 프로젝트는 개발 기억 연결이 켜져 있지 않습니다");
    const project = memoryProjectId(projectId);
    const result = await this.rest<{ experiences: Experience[]; semantic_index?: string; truncated?: boolean; mcp?: { path: string; token: string } }>("/v1/context", { project_id: project, task_id: checkedId(taskId), query, limit }, timeoutMs);
    if (result.mcp?.path && result.mcp.token) {
      const key = `${project}/${taskId}`;
      const prev = this.sessions.get(key);
      if (!prev || prev.token !== result.mcp.token || prev.path !== result.mcp.path) this.sessions.set(key, { path: result.mcp.path, token: result.mcp.token, initialized: false });
    }
    const { mcp: _hidden, ...rest } = result;
    return rest;
  }

  /** 작업 범위 MCP 도구 호출. 키는 /v1/context 가 준 그 작업의 것만 쓴다(게이트웨이가 프로젝트·작업 범위를 강제한다). */
  async mcp(projectId: string, taskId: string, tool: "get_experience" | "search_experiences", args: Record<string, unknown>, seedQuery: string): Promise<unknown> {
    const project = memoryProjectId(projectId);
    const key = `${project}/${checkedId(taskId)}`;
    if (!this.sessions.has(key)) await this.context(projectId, taskId, seedQuery, 1);
    const session = this.sessions.get(key);
    if (!session) throw new MemoryError("mcp", "개발 기억 서버가 작업 범위 MCP 키를 주지 않았습니다");
    const rpc = async (method: string, params: unknown, id: number | null) => {
      const r = await this.send(session.path, id === null ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id, method, params }, session.token);
      return r.json as { error?: { message?: string }; result?: { content?: { type: string; text: string }[]; isError?: boolean } } | null;
    };
    if (!session.initialized) {
      const init = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "iamceo", version: "1" } }, 1);
      if (init?.error) throw new MemoryError("mcp", `개발 기억 MCP 초기화 실패: ${init.error.message ?? "오류"}`);
      await rpc("notifications/initialized", {}, null);
      session.initialized = true;
    }
    const out = await rpc("tools/call", { name: tool, arguments: args }, 2);
    if (out?.error) throw new MemoryError("mcp", `개발 기억 MCP 오류: ${out.error.message ?? "오류"}`);
    const text = out?.result?.content?.find((c) => c.type === "text")?.text ?? "";
    if (out?.result?.isError) throw new MemoryError("mcp", `개발 기억 MCP 도구 실패: ${text.slice(0, 300)}`);
    try { return JSON.parse(text); } catch { return text; }
  }

  async record(projectId: string, experience: ExperienceInput): Promise<Experience> {
    if (!this.enabledFor(projectId)) throw new MemoryError("not_configured", "이 프로젝트는 개발 기억 연결이 켜져 있지 않습니다");
    checkedId(experience.source.task_id);
    return this.rest<Experience>("/v1/experiences", { project_id: memoryProjectId(projectId), experience });
  }

  async feedback(projectId: string, id: string, taskId: string, turnId: string, outcome: "helped" | "did_not_help" | "contradicted"): Promise<unknown> {
    if (!this.enabledFor(projectId)) throw new MemoryError("not_configured", "이 프로젝트는 개발 기억 연결이 켜져 있지 않습니다");
    return this.rest("/v1/feedback", { project_id: memoryProjectId(projectId), id, feedback: { task_id: checkedId(taskId), turn_id: checkedId(turnId), outcome } });
  }

  /** 대기열을 보낸다. 같은 event_id·같은 본문만 다시 보내므로 게이트웨이에서 중복 기록이 생기지 않는다. */
  flush(store: Store): Promise<void> {
    // 이미 도는 중이면 그 뒤에 한 번 더 돈다(도는 동안 새로 들어온 기록도 빠짐없이 보낸다).
    const run = (this.flushing ?? Promise.resolve()).then(async () => {
      for (const job of store.dueMemoryUploads(new Date().toISOString())) await this.sendJob(store, job);
    });
    const tracked = run.finally(() => { if (this.flushing === tracked) this.flushing = null; });
    this.flushing = tracked;
    return tracked;
  }

  private async sendJob(store: Store, job: MemoryUpload): Promise<void> {
    const experience = JSON.parse(job.body) as ExperienceInput;
    // 대체 관계는 앞 기록이 게이트웨이 id 를 받은 뒤에만 실을 수 있다. 앞 기록이 아직이면 시도 수를 쓰지 않고 미룬다.
    // 앞 기록도 횟수 제한이 있어 끝내 sent·rejected 로 끝나므로 이 미룸도 끝이 있다. 거절됐으면 대체 없이 보내고 그 사실을 남긴다.
    let note: string | null = null;
    if (job.supersedesEventId) {
      const previous = store.getMemoryUpload(job.supersedesEventId);
      if (previous?.status === "pending") {
        store.settleMemoryUpload(job.eventId, { status: "pending", attempts: job.attempts, nextAt: new Date(Date.now() + 60_000).toISOString(), lastError: "앞 기록이 아직 전송 전이라 기다립니다" });
        return;
      }
      if (previous?.status === "sent" && previous.remoteId) experience.supersedes = previous.remoteId;
      else note = "앞 기록이 게이트웨이에 없어 대체 관계 없이 보냈습니다";
    }
    const attempts = job.attempts + 1;
    try {
      const saved = await this.record(job.projectId, experience);
      store.settleMemoryUpload(job.eventId, { status: "sent", attempts, lastError: note, remoteId: saved?.id ?? null });
    } catch (e) {
      const err = e instanceof MemoryError ? e : new MemoryError("unreachable", (e as Error).message, undefined, true);
      const retry = (err.retryable || err.code === "key_unreadable") && attempts < MAX_ATTEMPTS;
      const nextAt = new Date(Date.now() + Math.min(60 * 60_000, 30_000 * 2 ** (attempts - 1))).toISOString();
      store.settleMemoryUpload(job.eventId, { status: retry ? "pending" : "rejected", attempts, nextAt, lastError: err.message });
    }
  }

  start(store: Store, everyMs = 60_000, healthMs = 10 * 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(store).catch((e) => console.warn("개발 기억 업로드 실패:", (e as Error).message)), everyMs);
    (this.timer as { unref?: () => void }).unref?.();
    this.healthTimer = setInterval(() => void this.checkHealth().catch(() => {}), healthMs);
    (this.healthTimer as { unref?: () => void }).unref?.();
    void this.checkHealth().catch(() => {});
    void this.flush(store).catch(() => {});
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.timer = null;
    this.healthTimer = null;
  }
}

/** 누가 남긴 기록인가. 요약 글은 직원도 쓸 수 있어 서버가 만든 event_id 머리로 가린다. */
export function memoryKindLabel(e: Pick<Experience, "kind" | "event_id">): string {
  const id = e.event_id ?? "";
  const origin = id.startsWith("iamceo-decision-") ? "대표 결재 답 기록" : id.startsWith("iamceo-owner-") ? "대표 원문 기록 · 총괄 해석 따로" : id.startsWith("iamceo-ai-") ? "직원·AI 보고" : "다른 경로의 기록";
  return `${e.kind} · ${origin}`;
}

export function stableEventId(prefix: string, ...parts: string[]): string {
  return `${prefix}-${createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 32)}`;
}

/** 본문 상한을 넘으면 앞부분만 보내고 발췌로 표시한다. */
export function clip(content: string): { content: string; capture: "complete" | "excerpt" } {
  return content.length <= CONTENT_MAX ? { content, capture: "complete" } : { content: content.slice(0, CONTENT_MAX - 40) + "\n…(이하 생략: IAMCEO 원본 참조)", capture: "excerpt" };
}
