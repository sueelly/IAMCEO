// Agent-A 검토 길: IAMCEO 화면 부품(댓글·답글·전체 댓글·그림 영역·수정안·판·문서 관리)이 쓰는 서버 쪽.
// - 화면은 Agent-A 를 직접 부르지 않는다. 이 서버가 Agent-A 원래 화면과 같은 검토 규약(검토 세션·초안·댓글·수정안·판)을 대신 부른다.
//   그래서 Agent-A 앱을 통째로 칸(iframe)에 넣지 않아도 같은 정본·댓글·답·수정안을 쓴다(계약 근거: Agent-A c559881 의
//   src/server/plannotator.js · auto-comments.js · app.js).
// - Agent-A 가 준 모양을 그대로 넘기지 않는다. 화면이 쓰는 칸만 골라 shared/agent-a.ts 의 모양으로 옮긴다.
// - 새 댓글은 검토 초안에 '주석 하나만 더하는' 길(POST /api/draft/annotations)로 만든다(그때 Agent-A 가 답을 시작한다).
//   초안을 읽어 통째로 다시 쓰지 않는다: 원래 Agent-A 의 초안 저장은 늘 통째로 바꾸고 세대 번호도 그대로라,
//   읽은 뒤 다른 창이 저장한 직접 편집·첨부·주석을 덮게 된다(독립 검토 F1). 그래서 이 길이 없는 Agent-A(원래 c559881)에는
//   새 댓글·초안 고치기를 보내지 않고 거절한다(AGENT_A_UNSUPPORTED). 필요한 Agent-A 변경은 docs/agent-a/ 에 있다.
// - 지난 판의 검토에는 새 댓글을 받지 않는다(같은 길이 한 트랜잭션에서 정본을 다시 확인한다). 읽기·있던 댓글의 답글은 그대로다.
// - 열쇠·Agent-A 주소는 이 서버 프로세스에만 있다.
import { createHash } from "node:crypto";
import { ApiError } from "../store.ts";
import { AgentAError, blockView, proposalView, verifyApplied, versionsOf, type AAsset, type AgentAService, type AState } from "./agent-a.ts";
import type {
  AgentABlockLayout,
  AgentAChatEntry,
  AgentAChatHistory,
  AgentAChatSession,
  AgentAManageBranch,
  AgentAReviewAiCatalog,
  AgentAReviewAiSettings,
  AgentAReviewAttachment,
  AgentAReviewDraft,
  AgentAReviewSubmitResult,
  AgentAProposalStatus,
  AgentAReviewAnnotation,
  AgentAReviewCommentReq,
  AgentAReviewComments,
  AgentAReviewDoc,
  AgentAReviewImage,
  AgentAReviewImageRegion,
  AgentAReviewManage,
  AgentAReviewProposal,
  AgentAReviewRecovery,
  AgentAReviewVersion,
  AgentAReviewWriteResult,
} from "../../shared/agent-a.ts";

const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ANNOTATION = /^[A-Za-z0-9_-]{1,200}$/;
const OP = /^[A-Za-z0-9_-]{8,100}$/;
/** Agent-A 가 검토 본문에 싣는 그림 경로(src/server/plannotator.js 의 /api/image 와 같은 규칙). */
export const REVIEW_ASSET = /^\/assets\/(user\/[a-f0-9]{64}\/1|workbench-flow\.svg)$/;
/** Agent-A 가 답을 쓰는 동안 보여 주는 글(src/server/auto-comments.js). 이 글이면 아직 답이 아니다. */
const WRITING = new Set(["현재 답변이 끝나기를 기다리고 있습니다…", "답변을 준비하고 있습니다…"]);
const MAX_TEXT = 30_000;
const MAX_QUOTE = 60_000;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"]);

type Json = Record<string, unknown>;
const obj = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Agent-A 의 거절을 일상어로 옮긴다. 판 충돌·닫힌 검토·없는 것은 화면이 구분해야 해서 상태와 code 를 남긴다. */
const KNOWN: Record<string, string> = {
  session_mismatch: "이 검토는 다른 문서나 지난 화면의 것입니다. 자료를 다시 열어 주세요",
  revision_conflict: "그사이 정본이 바뀌었습니다. 최신 정본을 다시 열어 주세요",
  already_decided: "이미 제출한 검토입니다. 최신 정본을 다시 열어 주세요",
  invalid_image_region: "그림 영역을 원래 그림에서 찾지 못했습니다. 영역을 다시 골라 주세요",
  local_only: "Agent-A 가 이 서버의 요청을 받지 않습니다(이 기기 전용 설정)",
  idempotency_conflict: "같은 요청 id 로 다른 내용을 보냈습니다",
  draft_conflict: "그사이 다른 화면이 초안을 저장했습니다. 다시 불러온 초안에서 고쳐 주세요",
  permission_not_pending: "이미 지난 권한 요청입니다",
  chat_busy: "답을 쓰는 중입니다. 답이 끝나거나 멈춘 뒤에 해 주세요",
  chat_not_found: "이 문서의 대화가 아니거나 그 질문을 찾지 못했습니다",
  unsupported: "이 Agent-A 는 초안 보존 규약을 몰라 새 댓글과 초안 고치기를 막았습니다. Agent-A 를 초안 보존 판으로 올려야 합니다",
};
const LAYOUT_CONFLICT = "그사이 배치가 바뀌었습니다. 다시 불러온 배치에서 고쳐 주세요";
const unsupported = (): never => {
  throw new ApiError(409, KNOWN.unsupported!, "AGENT_A_UNSUPPORTED");
};

function refuse(status: number, json: unknown, fallback: string): never {
  const e = obj(json) ? json : {};
  const code = str(e.code) || str(e.error) || `http_${status}`;
  const message = KNOWN[code] ?? (str(e.message) || fallback);
  if (status === 401 || status === 403) throw new ApiError(502, code === "local_only" ? KNOWN.local_only! : "Agent-A 연결 열쇠가 맞지 않습니다", "AGENT_A_AUTH");
  throw new ApiError(status >= 500 ? 502 : status, message, `AGENT_A_${code.toUpperCase()}`);
}

/** 그림 영역: 정수 픽셀, 그림 안. 모양이 다르면 null(서버가 지어내지 않는다). */
export function parseRegion(v: unknown): AgentAReviewImageRegion | null {
  if (!obj(v) || v.v !== 1 || !obj(v.box)) return null;
  const src = str(v.src);
  const nw = v.naturalWidth, nh = v.naturalHeight;
  const { x, y, w, h } = v.box as Json;
  const ints = [nw, nh, x, y, w, h];
  if (!src || src.length > 2048 || !ints.every((n) => Number.isSafeInteger(n))) return null;
  const [NW, NH, X, Y, W, H] = ints as number[];
  if (NW! <= 0 || NH! <= 0 || NW! > 1_000_000 || NH! > 1_000_000 || X! < 0 || Y! < 0 || W! <= 0 || H! <= 0 || X! + W! > NW! || Y! + H! > NH!) return null;
  const line = v.sourceLine;
  if (line != null && (!Number.isSafeInteger(line) || (line as number) < 1)) return null;
  return { v: 1, src, sourceLine: (line as number | null | undefined) ?? null, naturalWidth: NW!, naturalHeight: NH!, box: { x: X!, y: Y!, w: W!, h: H! } };
}

/** Agent-A 의 댓글 한 줄을 화면 모양으로. 모양이 맞지 않으면 null. */
export function toAnnotation(raw: unknown): AgentAReviewAnnotation | null {
  if (!obj(raw) || typeof raw.id !== "string" || !raw.id) return null;
  const ai = raw.isAIReply === true;
  const err = obj(raw.answerError) ? { code: str(raw.answerError.code) || "provider_failed", message: str(raw.answerError.message) || "답을 받지 못했습니다" } : null;
  // 실패한 답의 text 는 '부분 답 + 오류 글'이다. 부분 답(answerText)만 본문으로 쓰고 오류는 따로 보인다.
  const text = ai && err ? str(raw.answerText) : str(raw.text);
  const branch = obj(raw.branchOrigin) ? str(raw.branchOrigin.title) : "";
  return {
    id: raw.id,
    kind: raw.type === "GLOBAL_COMMENT" ? "global" : raw.type === "DELETION" ? "deletion" : "comment",
    text,
    quote: str(raw.originalText),
    inReplyTo: typeof raw.inReplyTo === "string" && raw.inReplyTo ? raw.inReplyTo : null,
    ai,
    author: str(raw.author) || null,
    createdAt: num(raw.createdA) ?? 0,
    updatedAt: num(raw.updatedAt),
    resolved: raw.resolved === true,
    region: ai ? null : parseRegion(raw.imageRegion),
    writing: ai && !err && (!text.trim() || WRITING.has(text.trim())),
    error: err,
    canRetry: raw.canRetry === true,
    branchOf: branch || null,
    extra: Boolean(raw.implementationProposal || raw.fulfillment || raw.previousAnswer),
    images: ai ? [] : (Array.isArray(raw.images) ? raw.images : []).flatMap((x) => (obj(x) && UPLOADED.test(str(x.path)) ? [{ path: str(x.path), name: str(x.name) || "그림" }] : [])),
    aiSettings: ai || !obj(raw.aiSettings) ? null : {
      ...(str(raw.aiSettings.providerId) ? { providerId: str(raw.aiSettings.providerId) } : {}),
      ...(str(raw.aiSettings.model) ? { model: str(raw.aiSettings.model) } : {}),
      ...(str(raw.aiSettings.reasoningEffort) ? { reasoningEffort: str(raw.aiSettings.reasoningEffort) } : {}),
    },
    label: !ai && raw.isQuickLabel === true,
    labelTip: !ai && raw.isQuickLabel === true && str(raw.quickLabelTip) ? str(raw.quickLabelTip) : null,
  };
}

/** 댓글에 붙인 그림: Agent-A 에 올려서 받은 경로만(다른 주소는 받지 않는다). */
const UPLOADED = /^\/assets\/user\/[a-f0-9]{64}\/1$/;
function attachments(v: unknown): AgentAReviewAttachment[] {
  if (v == null) return [];
  if (!Array.isArray(v) || v.length > 10) throw new ApiError(400, "붙인 그림은 10개까지입니다");
  return v.map((x) => {
    if (!obj(x) || !UPLOADED.test(str(x.path)) || typeof x.name !== "string" || x.name.length > 200) throw new ApiError(400, "붙인 그림이 올바르지 않습니다");
    return { path: str(x.path), name: x.name };
  });
}
/** AI 설정: 아는 세 칸의 짧은 글만. 비었으면 null(Agent-A 기본값). */
function aiSettings(v: unknown): AgentAReviewAiSettings | null {
  if (v == null) return null;
  if (!obj(v)) throw new ApiError(400, "AI 설정이 올바르지 않습니다");
  const out: AgentAReviewAiSettings = {};
  for (const [key, value] of Object.entries(v)) {
    if (!["providerId", "model", "reasoningEffort"].includes(key) || typeof value !== "string" || value.length > 200) throw new ApiError(400, "AI 설정이 올바르지 않습니다");
    if (value) out[key as keyof AgentAReviewAiSettings] = value;
  }
  return Object.keys(out).length ? out : null;
}

/** 줄 단위로 달라진 곳만 뽑는다(같은 머리·꼬리는 뺀다). 직접 고친 본문을 제출 글에 싣는 데 쓴다. */
function lineDiff(before: string, after: string): string {
  const a = before.split("\n"), b = after.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const removed = a.slice(head, a.length - tail), added = b.slice(head, b.length - tail);
  return [`@@ line ${head + 1} @@`, ...removed.map((l) => `- ${l}`), ...added.map((l) => `+ ${l}`)].join("\n").slice(0, 60_000);
}

/**
 * 검토 제출에 싣는 전체 의견 글. 원래 화면이 내보내는 글과 같은 짜임이다(주석 목록 + '# Direct Edits').
 * Agent-A 는 이 글을 문서 전체 질문 하나로 남긴다. 주석 하나하나는 따로 분기의 질문이 된다.
 */
export function feedbackText(markdown: string, annotations: Json[], edited: string | null, attachments: number): string {
  const parts: string[] = ["# Plan Feedback", "", `I've reviewed this document and have ${annotations.length} piece${annotations.length === 1 ? "" : "s"} of feedback:`, ""];
  // 빠른 라벨은 원래 화면처럼 머리에 [라벨]로 싣고 지침을 인용 줄로 붙인다. 끝에 라벨별 개수를 모아 적는다.
  const isLabel = (a: Json) => a.type === "COMMENT" && a.isQuickLabel === true && Boolean(str(a.text));
  annotations.forEach((a, i) => {
    const quote = str(a.originalText), text = str(a.text);
    const label = isLabel(a);
    const head = a.type === "DELETION" ? "Remove this" : a.type === "GLOBAL_COMMENT" || !quote ? "General feedback" : "Feedback on";
    parts.push(`## ${i + 1}. ${label ? `[${text.replace(/\s+/g, " ")}] ` : ""}${head}${quote && a.type !== "DELETION" ? `: "${quote.replace(/\s+/g, " ").slice(0, 200)}"` : ""}`);
    if (a.type === "DELETION" && quote) parts.push("```", quote.slice(0, 2000), "```");
    if (label) {
      if (str(a.quickLabelTip)) parts.push(`> ${str(a.quickLabelTip).replace(/\s+/g, " ")}`);
    } else if (text) parts.push(...text.split("\n").map((l) => `> ${l}`));
    if (obj(a.imageRegion)) parts.push(`(image region: ${str(a.imageRegion.src)})`);
    if (Array.isArray(a.images) && a.images.length) parts.push(`(attachments: ${a.images.length})`);
    parts.push("");
  });
  const labels = new Map<string, number>();
  for (const a of annotations) if (isLabel(a)) labels.set(str(a.text).replace(/\s+/g, " "), (labels.get(str(a.text).replace(/\s+/g, " ")) ?? 0) + 1);
  if (labels.size) parts.push("## Label Summary", "", ...[...labels].map(([text, count]) => `- **${text}**: ${count}`), "");
  if (attachments) parts.push(`(review attachments: ${attachments})`, "");
  if (edited !== null && edited !== markdown) parts.push("# Direct Edits", "", "```diff", lineDiff(markdown, edited), "```", "");
  return parts.join("\n").trim().slice(0, 95_000);
}

const revisionOf = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);
/**
 * 같은 명령 id 로 이미 실행된 명령: Agent-A 가 사건 기록에 남긴 그때의 명령이다. 없으면 null(처음 보내는 요청).
 * 판을 생략한 요청의 재전송이 처음과 같은 명령이 되게 하는 데 쓴다.
 */
function ranCommand(state: AState, commandId: string): Json | null {
  const events = Array.isArray(state.events) ? state.events : [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.command_id === commandId) return obj(e.payload) ? e.payload : {};
  }
  return null;
}
/**
 * 명령에 실을 판. 화면이 본 판을 보냈으면 그것을 쓴다.
 * 보내지 않은 요청은, 같은 요청 id 의 명령이 이미 실행됐으면 그때 쓴 판(first)을, 처음 보내는 요청이면 지금 판을 쓴다.
 * 지금 판으로 매번 채우면 저장 뒤 응답만 잃은 요청의 재전송이 그사이 문맥·배치가 바뀌었을 때 다른 명령이 되어 거절된다(독립 재검토 R2).
 * 보낸 판은 여기서 바꾸지 않는다: 같은 요청 id 로 다른 내용·다른 판을 보내면 Agent-A 가 거절하고, 새 요청의 낡은 판도 Agent-A 가 거절한다.
 */
const revisionOr = (sent: number | null | undefined, first: unknown, current: number): number => revisionOf(sent) ?? revisionOf(first) ?? current;

/**
 * 초안에 남기는 '마지막 조건 저장' 표지(독립 재검토 R1). 조건 저장이 초안과 한 번에 싣기 때문에, 저장이 들어갔으면 표지도 들어가 있다.
 * key 는 그 저장 요청(어느 검토의 무엇을·어느 초안 판에서·어떤 값으로)의 지문이다. 저장은 됐는데 응답만 잃은 같은 요청이 다시 오면
 * 초안 판이 이미 올라 있어도 이 표지로 '이미 저장됨'을 확인하고 다시 쓰지 않는다. 표지가 없거나 다르면 다른 화면의 저장이다.
 * Agent-A 는 초안의 모르는 칸을 그대로 보관하고(POST /api/draft), 주석 하나를 더할 때도 그대로 둔다. 원래 화면이 통째로 저장하면 사라진다.
 */
const SAVE_MARK = "iamceoSave";
type SaveMark = { key: string; holds: (draft: Json) => boolean };
const saveKey = (artifactId: string, sid: string, kind: "body" | "attachments", revision: number, value: unknown): string =>
  createHash("sha256").update(JSON.stringify([artifactId, sid, kind, revision, value])).digest("hex");
/** 지금 초안이 이 요청의 저장을 담고 있는가: 표지가 이 요청의 것이고, 그 칸의 값도 요청한 값 그대로다. */
const savedAlready = (draft: Json, mark: SaveMark): boolean => {
  const m = draft[SAVE_MARK];
  return obj(m) && m.v === 1 && m.key === mark.key && mark.holds(draft);
};

const STATUSES: AgentAProposalStatus[] = ["pending", "held", "rejected", "applied", "conflict"];
const bodyOf = (content: unknown): string | null => {
  if (!obj(content)) return null;
  return [str(content.summary), str(content.body)].filter(Boolean).join("\n\n");
};

const BLOCK_KINDS = ["markdown", "table", "mermaid", "image"] as const;
export type AgentABlockKind = (typeof BLOCK_KINDS)[number];
/** 표 블록의 본문 형식(Agent-A 의 규칙): {"headers":[글…],"rows":[[글·수·참거짓·null…]…]} 이고 줄마다 칸 수가 머리와 같다. */
export function tableBodyError(body: string): string | null {
  let v: unknown;
  try { v = JSON.parse(body); } catch { return "표 본문은 JSON 이어야 합니다"; }
  if (!obj(v) || !Array.isArray(v.headers) || !Array.isArray(v.rows)) return "표 본문은 {\"headers\":[…],\"rows\":[[…]]} 모양이어야 합니다";
  const headers = v.headers as unknown[];
  if (headers.some((h) => typeof h !== "string")) return "표 머리는 글이어야 합니다";
  for (const row of v.rows as unknown[]) {
    if (!Array.isArray(row) || row.length !== headers.length) return "표의 줄마다 칸 수가 머리와 같아야 합니다";
    if (row.some((cell) => cell !== null && !["string", "number", "boolean"].includes(typeof cell))) return "표의 칸은 글·수·참거짓만 됩니다";
  }
  return null;
}

export class AgentAReview {
  /** 같은 수정안의 반영·보류가 겹치지 않게 하는 이 프로세스 안의 줄. 다른 창·프로세스의 쓰기를 막는 장치가 아니다(그건 Agent-A 가 한다). */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly service: AgentAService,
    private readonly now: () => number = Date.now,
  ) {}

  private serial<T>(key: string, run: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(run);
    this.locks.set(key, next);
    void next.finally(() => {
      if (this.locks.get(key) === next) this.locks.delete(key);
    }).catch(() => {});
    return next;
  }

  private session(id: string): string {
    if (!SESSION.test(id)) throw new ApiError(400, "검토 id 가 올바르지 않습니다");
    return id;
  }

  private async call(fileId: string, sessionId: string | null, method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown; draftRevision: number | null }> {
    const doc = this.service.docOf(fileId);
    try {
      return await this.service.client.reviewCall(method, path, { artifactId: doc.artifactId, sessionId }, body);
    } catch (e) {
      if (e instanceof AgentAError) throw new ApiError(502, "Agent-A 서버에 닿지 않습니다", "AGENT_A_UNAVAILABLE");
      throw e;
    }
  }

  private async ok(fileId: string, sessionId: string | null, method: string, path: string, body: unknown, fallback: string): Promise<Json> {
    const { status, json } = await this.call(fileId, sessionId, method, path, body);
    if (status < 200 || status >= 300) refuse(status, json, fallback);
    return obj(json) ? json : {};
  }

  // ---- 문서 열기 ----

  /** 지금 정본의 검토를 연다(같은 판이면 Agent-A 가 있던 검토를 돌려준다). resume 을 주면 그 검토를 그때 본문 그대로 연다. */
  async open(fileId: string, resume?: string | null): Promise<AgentAReviewDoc> {
    const doc = this.service.docOf(fileId);
    const body = resume ? { artifact_id: doc.artifactId, resume_session_id: this.session(resume) } : { artifact_id: doc.artifactId };
    const s = await this.ok(fileId, null, "POST", "/api/plannotator/sessions", body, "문서를 열지 못했습니다");
    const sessionId = str(s.id);
    if (!SESSION.test(sessionId) || typeof s.markdown !== "string") throw new ApiError(502, "Agent-A 가 검토를 돌려주지 않았습니다", "AGENT_A_BAD_RESPONSE");
    const draft = obj(s.draft) ? s.draft : null;
    const edited = typeof draft?.editedMarkdown === "string";
    const latest = s.stale !== true;
    const protocol = obj(s.capabilities) ? num(s.capabilities.draft_protocol) : null;
    let artifactRevision: number | null = null;
    if (latest) {
      const r = await this.call(fileId, sessionId, "GET", "/api/plan/revision");
      artifactRevision = r.status === 200 && obj(r.json) ? num(r.json.revision) : null;
    }
    const images: AgentAReviewImage[] = [];
    for (const entry of Array.isArray(s.source_map) ? s.source_map : []) {
      if (!obj(entry) || entry.kind !== "image" || !obj(entry.asset)) continue;
      const src = str(entry.asset.src);
      const width = num(entry.asset.width), height = num(entry.asset.height), line = num(entry.start_line);
      if (REVIEW_ASSET.test(src) && width && height) images.push({ src, width, height, sourceLine: line ?? 1 });
    }
    return {
      fileId,
      sessionId,
      latest,
      title: doc.title || s.markdown.split("\n")[0]!.replace(/^#\s*/, ""),
      markdown: edited ? (draft!.editedMarkdown as string) : s.markdown,
      edited,
      canonical: s.markdown,
      artifactRevision,
      images,
      closed: Boolean(s.decision),
      safeWrites: (protocol ?? 1) >= 2,
      recoveries: (Array.isArray(s.recoveries) ? s.recoveries : []).flatMap((r): AgentAReviewRecovery[] => {
        if (!obj(r) || !SESSION.test(str(r.id))) return [];
        return [{
          sessionId: str(r.id),
          title: str(r.title),
          createdAt: str(r.created_at),
          artifactRevision: num(r.artifact_revision),
          stale: r.stale === true,
          submitted: Boolean(r.decision),
          annotations: num(r.annotation_count) ?? 0,
          attachments: num(r.attachment_count) ?? 0,
          editedMarkdown: r.has_edited_markdown === true,
        }];
      }),
    };
  }

  /** 본문의 그림 하나. Agent-A 가 이 검토의 그림으로 아는 것만 내준다. 그림이 아닌 응답은 넘기지 않는다. */
  async image(fileId: string, sessionId: string, src: string): Promise<Response> {
    const doc = this.service.docOf(fileId);
    if (!REVIEW_ASSET.test(src)) throw new ApiError(404, "그림을 찾을 수 없습니다");
    let res: Response;
    try {
      res = await this.service.client.reviewImage(src, { artifactId: doc.artifactId, sessionId: this.session(sessionId) });
    } catch (e) {
      if (e instanceof AgentAError) throw new ApiError(502, "Agent-A 서버에 닿지 않습니다", "AGENT_A_UNAVAILABLE");
      throw e;
    }
    const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!res.ok || !IMAGE_TYPES.has(type)) throw new ApiError(404, "그림을 찾을 수 없습니다");
    return new Response(res.body, { status: 200, headers: { "Content-Type": type, "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff" } });
  }

  // ---- 댓글 ----

  /** 이 검토의 댓글·답. since 가 그대로면 null(바뀐 것 없음). */
  async comments(fileId: string, sessionId: string, since: number | null): Promise<AgentAReviewComments | null> {
    const { status, json } = await this.call(fileId, this.session(sessionId), "GET", `/api/external-annotations${since !== null ? `?since=${since}` : ""}`);
    if (status === 304) return null;
    if (status !== 200 || !obj(json)) refuse(status, json, "댓글을 불러오지 못했습니다");
    const historical = new Map<string, number>();
    for (const h of Array.isArray(json.historical) ? json.historical : []) {
      const id = obj(h) ? str(h.review_session_id) : "";
      if (SESSION.test(id)) historical.set(id, (historical.get(id) ?? 0) + 1);
    }
    return {
      version: num(json.version) ?? 0,
      annotations: (Array.isArray(json.annotations) ? json.annotations : []).flatMap((a) => toAnnotation(a) ?? []),
      historical: [...historical].map(([id, count]) => ({ sessionId: id, count })),
    };
  }

  /**
   * 새 댓글(문장·전체·그림 영역·삭제 표시). 검토 초안에 주석 하나만 더한다. 그때 Agent-A 가 답을 시작한다(삭제 표시는 답이 없다).
   * - 초안을 읽어 통째로 다시 쓰지 않으므로 다른 창이 그사이 저장한 직접 편집·첨부·주석이 그대로 남는다.
   * - 같은 id·같은 내용으로 다시 보내면 Agent-A 가 처음 결과를 확인해 준다(댓글은 하나). 같은 id 로 다른 내용이면 거절한다.
   * - 지난 판의 검토·제출로 닫힌 검토에는 새 댓글을 받지 않는다. 그 확인은 Agent-A 가 쓰기와 같은 트랜잭션에서 한다.
   * - 이 규약을 모르는 Agent-A 에는 아무것도 보내지 않고 거절한다(AGENT_A_UNSUPPORTED).
   */
  async addComment(fileId: string, sessionId: string, req: AgentAReviewCommentReq): Promise<AgentAReviewWriteResult> {
    const sid = this.session(sessionId);
    if (!ANNOTATION.test(req.id)) throw new ApiError(400, "댓글 id 가 올바르지 않습니다");
    if (req.kind !== "comment" && req.kind !== "global" && req.kind !== "deletion") throw new ApiError(400, "댓글 종류가 올바르지 않습니다");
    const text = (req.text ?? "").trim();
    const quote = req.kind === "global" ? "" : (req.quote ?? "");
    if (req.kind === "deletion" ? !quote.trim() : !text) throw new ApiError(400, req.kind === "deletion" ? "지울 글을 골라 주세요" : "댓글은 1~30000자입니다");
    if (text.length > MAX_TEXT) throw new ApiError(400, "댓글은 1~30000자입니다");
    if (quote.length > MAX_QUOTE) throw new ApiError(400, "고른 글이 너무 깁니다");
    let region: AgentAReviewImageRegion | null = null;
    if (req.region != null) {
      region = req.kind === "deletion" ? null : parseRegion(req.region);
      if (!region || !REVIEW_ASSET.test(region.src)) throw new ApiError(400, KNOWN.invalid_image_region!, "AGENT_A_INVALID_IMAGE_REGION");
    }
    const images = attachments(req.images);
    const ai = aiSettings(req.ai);
    // 빠른 라벨: 고른 글·그림 영역에 한 줄짜리 라벨을 댓글로 남긴다. Agent-A 의 원래 화면과 같은 표시(isQuickLabel·quickLabelTip)를 싣는다.
    let label: { tip: string } | null = null;
    if (req.quickLabel != null) {
      const tip = obj(req.quickLabel) ? req.quickLabel.tip ?? "" : null;
      if (typeof tip !== "string" || tip.length > 2_000) throw new ApiError(400, "라벨 지침이 올바르지 않습니다");
      if (req.kind !== "comment" || (!quote.trim() && !region)) throw new ApiError(400, "라벨은 고른 글이나 그림 영역에 붙입니다");
      if (text.length > 200 || /[\r\n]/.test(text)) throw new ApiError(400, "라벨 글은 한 줄, 200자까지입니다");
      label = { tip: tip.trim() };
    }
    // 1) 이 Agent-A 가 초안 보존 규약을 아는지 먼저 본다(초안 판 머리). 모르면 쓰기를 하나도 보내지 않는다.
    const cur = await this.call(fileId, sid, "GET", "/api/draft");
    if (cur.status !== 200 && cur.status !== 404) refuse(cur.status, cur.json, "초안을 읽지 못했습니다");
    if (cur.draftRevision === null) unsupported();
    // 2) 주석 하나만 더한다. 여기서 읽은 초안은 보내지 않는다(그사이 다른 창이 저장해도 그 저장이 남는다).
    const saved = await this.call(fileId, sid, "POST", "/api/draft/annotations", {
      annotation: {
        id: req.id,
        blockId: "",
        startOffset: 0,
        endOffset: 0,
        type: req.kind === "global" ? "GLOBAL_COMMENT" : req.kind === "deletion" ? "DELETION" : "COMMENT",
        ...(text ? { text } : {}),
        originalText: quote,
        ...(region ? { imageRegion: region } : {}),
        ...(images.length ? { images } : {}),
        ...(ai ? { aiSettings: ai } : {}),
        ...(label ? { isQuickLabel: true, ...(label.tip ? { quickLabelTip: label.tip } : {}) } : {}),
      },
    });
    if (saved.status === 200) return { ok: true, id: req.id };
    const body = obj(saved.json) ? saved.json : {};
    if (saved.status === 409 && body.decided === true) throw new ApiError(409, KNOWN.already_decided!, "AGENT_A_ALREADY_DECIDED");
    // 길 자체가 없으면(404, Agent-A 의 code 없음) 규약을 모르는 Agent-A 다.
    if (saved.status === 404 && typeof body.code !== "string") unsupported();
    refuse(saved.status, saved.json, "댓글을 저장하지 못했습니다");
  }

  /** 대댓글. 첫 댓글 id 에 단다. Agent-A 가 같은 대화로 답한다. ai 를 주면 이 답글의 답만 그 AI·모델·추론 수준으로 받는다. */
  async reply(fileId: string, sessionId: string, input: { inReplyTo: string; text: string; ai?: AgentAReviewAiSettings | null }): Promise<AgentAReviewWriteResult> {
    const text = input.text.trim();
    if (!ANNOTATION.test(input.inReplyTo)) throw new ApiError(400, "댓글 id 가 올바르지 않습니다");
    if (!text || text.length > MAX_TEXT) throw new ApiError(400, "답글은 1~30000자입니다");
    const settings = aiSettings(input.ai);
    const r = await this.ok(fileId, this.session(sessionId), "POST", "/api/external-annotations", { inReplyTo: input.inReplyTo, text, ...(settings ? { settings } : {}) }, "답글을 저장하지 못했습니다");
    return { ok: true, id: str(r.id) };
  }

  /** 댓글 완료·다시 열기. */
  async setResolved(fileId: string, sessionId: string, id: string, resolved: boolean): Promise<{ ok: true }> {
    if (!ANNOTATION.test(id)) throw new ApiError(400, "댓글 id 가 올바르지 않습니다");
    await this.ok(fileId, this.session(sessionId), "PATCH", `/api/external-annotations?id=${encodeURIComponent(id)}`, { resolved }, "완료 상태를 저장하지 못했습니다");
    return { ok: true };
  }

  /** 댓글 하나를 지운다(대표가 화면에서 한 번 더 확인한 뒤에만 부른다). Agent-A 는 지운 기록을 남기고 목록에서 뺀다. */
  async remove(fileId: string, sessionId: string, id: string): Promise<{ ok: true }> {
    if (!ANNOTATION.test(id)) throw new ApiError(400, "댓글 id 가 올바르지 않습니다");
    await this.ok(fileId, this.session(sessionId), "DELETE", `/api/external-annotations?id=${encodeURIComponent(id)}`, undefined, "댓글을 지우지 못했습니다");
    return { ok: true };
  }

  /** 실패한 답을 같은 문맥으로 다시 요청한다. 같은 답에 두 번 눌러도 요청은 하나다(Agent-A 가 합친다). */
  async retry(fileId: string, sessionId: string, answerId: string): Promise<AgentAReviewWriteResult> {
    if (!ANNOTATION.test(answerId)) throw new ApiError(400, "댓글 id 가 올바르지 않습니다");
    const r = await this.ok(fileId, this.session(sessionId), "POST", "/api/external-annotations/retry", { annotation_id: answerId }, "다시 요청하지 못했습니다");
    return { ok: true, id: str(r.id) };
  }

  /** '다른 조건으로 질문': 그 댓글의 대화를 복사한 새 댓글을 만든다. 원래 댓글은 그대로다. */
  async fork(fileId: string, sessionId: string, id: string): Promise<AgentAReviewWriteResult> {
    if (!ANNOTATION.test(id)) throw new ApiError(400, "댓글 id 가 올바르지 않습니다");
    const r = await this.ok(fileId, this.session(sessionId), "POST", "/api/external-annotations/fork", { annotation_id: id }, "새 질문으로 가르지 못했습니다");
    return { ok: true, id: str(r.id) };
  }

  // ---- 댓글의 수정안 ----

  async proposals(fileId: string, sessionId: string): Promise<AgentAReviewProposal[]> {
    const r = await this.ok(fileId, this.session(sessionId), "GET", "/api/plannotator/comment-proposals", undefined, "수정안을 불러오지 못했습니다");
    return (Array.isArray(r.proposals) ? r.proposals : []).flatMap((p): AgentAReviewProposal[] => {
      if (!obj(p) || !str(p.annotation_id) || !str(p.proposal_id)) return [];
      const status = STATUSES.includes(p.status as AgentAProposalStatus) ? (p.status as AgentAProposalStatus) : "conflict";
      return [{
        annotationId: str(p.annotation_id),
        proposalId: str(p.proposal_id),
        status,
        reason: str(p.reason),
        current: status === "applied" && p.display_confirmed === true,
        operations: (Array.isArray(p.operations) ? p.operations : []).flatMap((op) => {
          if (!obj(op)) return [];
          const after = obj(op.content) ? op.content : null;
          const before = obj(op.before) ? op.before : null;
          return [{ op: str(op.op), blockId: str(op.block_id), title: str(after?.title) || str(before?.title) || "수정안", before: op.op === "insert" ? null : bodyOf(before), after: op.op === "archive" ? null : bodyOf(after) }];
        }),
      }];
    });
  }

  /**
   * 댓글의 수정안 하나를 정본에 반영한다(원래 화면의 수정안 Save). 어느 댓글의 수정안인지는 Agent-A 가 다시 확인한다.
   * 저장 응답만 믿지 않고 정본을 다시 읽어 바뀐 본문이 들어 있는지 본다.
   */
  async approve(fileId: string, sessionId: string, input: { annotationId: string; proposalId: string }): Promise<{ ok: true; artifactRevision: number; verified: boolean }> {
    const sid = this.session(sessionId);
    if (!ANNOTATION.test(input.annotationId) || !ANNOTATION.test(input.proposalId)) throw new ApiError(400, "수정안 id 가 올바르지 않습니다");
    return this.serial(`proposal:${input.proposalId}`, async () => {
      await this.ok(fileId, sid, "POST", "/api/plannotator/comment-proposals/approve", { annotation_id: input.annotationId, proposal_id: input.proposalId }, "수정안을 반영하지 못했습니다");
      const state = await this.service.readState(fileId);
      const p = state.proposals.find((x) => x.id === input.proposalId);
      return { ok: true as const, artifactRevision: state.artifact_revision, verified: Boolean(p && p.status === "applied" && verifyApplied(state, p)) };
    });
  }

  // ---- 판 ----

  async versions(fileId: string, sessionId: string): Promise<AgentAReviewVersion[]> {
    const r = await this.ok(fileId, this.session(sessionId), "GET", "/api/plan/versions", undefined, "판 목록을 불러오지 못했습니다");
    return (Array.isArray(r.versions) ? r.versions : []).flatMap((v) => (obj(v) && num(v.version) ? [{ version: num(v.version)!, at: str(v.timestamp) }] : []));
  }

  async version(fileId: string, sessionId: string, v: number): Promise<{ version: number; markdown: string }> {
    if (!Number.isSafeInteger(v) || v < 1) throw new ApiError(400, "판 번호가 올바르지 않습니다");
    const r = await this.ok(fileId, this.session(sessionId), "GET", `/api/plan/version?v=${v}`, undefined, "그 판을 찾지 못했습니다");
    if (typeof r.plan !== "string") throw new ApiError(404, "그 판을 찾지 못했습니다");
    return { version: v, markdown: r.plan };
  }

  // ---- AI 고르기 · 그림 붙이기 ----

  /** 답을 낼 수 있는 AI 목록. Agent-A 가 지금 쓸 수 있다고 알리는 것만 옮긴다. */
  async aiCatalog(fileId: string, sessionId: string): Promise<AgentAReviewAiCatalog> {
    const r = await this.ok(fileId, this.session(sessionId), "GET", "/api/ai/capabilities", undefined, "AI 목록을 불러오지 못했습니다");
    const providers = (Array.isArray(r.providers) ? r.providers : []).flatMap((p) => {
      if (!obj(p) || !str(p.id)) return [];
      const models = (Array.isArray(p.models) ? p.models : []).flatMap((m) => {
        if (!obj(m) || !str(m.id)) return [];
        const efforts = (Array.isArray(m.reasoningEfforts) ? m.reasoningEfforts : []).flatMap((e) => (obj(e) && str(e.id) ? [{ id: str(e.id), label: str(e.label) || str(e.id) }] : []));
        return [{ id: str(m.id), label: str(m.label) || str(m.id), default: m.default === true, efforts, defaultEffort: str(m.defaultReasoningEffort) || null }];
      });
      return [{ id: str(p.id), name: str(p.name) || str(p.id), models }];
    });
    return { available: r.available === true && providers.length > 0, defaultProvider: str(r.defaultProvider) || null, providers, error: str(r.error) || null };
  }

  /** 댓글에 붙일 그림을 Agent-A 에 올린다. 같은 그림은 같은 경로를 돌려준다(내용 해시). 올린 것만으로는 어디에도 붙지 않는다. */
  async upload(fileId: string, sessionId: string, input: { name: string; mediaType: string; base64: string }): Promise<AgentAReviewAttachment> {
    this.session(sessionId);
    this.service.docOf(fileId);
    const asset = await this.uploadImage(input);
    return { path: asset.src, name: input.name.trim().slice(0, 200) || "그림" };
  }

  /** 댓글·초안에 붙은 그림 하나. 이 검토의 댓글이나 초안이 가리키는 그림만 내준다(경로를 안다고 아무 그림이나 주지 않는다). */
  async attachment(fileId: string, sessionId: string, path: string): Promise<Response> {
    const sid = this.session(sessionId);
    if (!UPLOADED.test(path)) throw new ApiError(404, "그림을 찾을 수 없습니다");
    const list = await this.call(fileId, sid, "GET", "/api/external-annotations");
    const draft = await this.call(fileId, sid, "GET", "/api/draft");
    const known = new Set<string>();
    const collect = (items: unknown) => {
      for (const a of Array.isArray(items) ? items : []) {
        if (!obj(a)) continue;
        if (typeof a.path === "string") known.add(a.path);
        for (const image of Array.isArray(a.images) ? a.images : []) if (obj(image) && typeof image.path === "string") known.add(image.path);
      }
    };
    if (list.status === 200 && obj(list.json)) collect(list.json.annotations);
    if (draft.status === 200 && obj(draft.json)) {
      collect(draft.json.annotations);
      collect(draft.json.globalAttachments);
    }
    if (!known.has(path)) throw new ApiError(404, "그림을 찾을 수 없습니다");
    let res: Response;
    try {
      res = await this.service.client.asset(path);
    } catch (e) {
      if (e instanceof AgentAError) throw new ApiError(502, "Agent-A 서버에 닿지 않습니다", "AGENT_A_UNAVAILABLE");
      throw e;
    }
    const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!res.ok || !["image/png", "image/jpeg", "image/webp"].includes(type)) throw new ApiError(404, "그림을 찾을 수 없습니다");
    return new Response(res.body, { status: 200, headers: { "Content-Type": type, "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff" } });
  }

  // ---- 검토 초안: 본문 직접 고치기 · 검토 제출 ----

  private draftView(revision: number, json: unknown): AgentAReviewDraft {
    const d = obj(json) ? json : {};
    return {
      revision,
      editedMarkdown: typeof d.editedMarkdown === "string" ? d.editedMarkdown : null,
      annotations: Array.isArray(d.annotations) ? d.annotations.length : 0,
      attachments: (Array.isArray(d.globalAttachments) ? d.globalAttachments : []).flatMap((x) => (obj(x) && typeof x.path === "string" ? [{ path: x.path, name: str(x.name) || "그림" }] : [])),
    };
  }

  /** 초안을 읽는다. 초안 판을 주지 않는 Agent-A 면 거절한다(판 없이 고쳐 쓰면 다른 화면의 초안을 덮을 수 있다). */
  private async readDraft(fileId: string, sid: string): Promise<{ revision: number; found: boolean; json: Json }> {
    const cur = await this.call(fileId, sid, "GET", "/api/draft");
    if (cur.status !== 200 && cur.status !== 404) refuse(cur.status, cur.json, "초안을 읽지 못했습니다");
    if (cur.draftRevision === null) unsupported();
    return { revision: cur.draftRevision as number, found: cur.status === 200, json: cur.status === 200 && obj(cur.json) ? cur.json : {} };
  }

  async draft(fileId: string, sessionId: string): Promise<AgentAReviewDraft> {
    const got = await this.readDraft(fileId, this.session(sessionId));
    return this.draftView(got.revision, got.json);
  }

  /**
   * 직접 고친 본문을 초안에 저장한다(markdown 이 null 이면 고친 것을 버린다). 정본은 바뀌지 않는다.
   * revision 은 화면이 고치기 시작할 때 본 초안 판이다. 그 뒤 다른 화면이 초안을 저장했으면 아무것도 바꾸지 않고 거절한다:
   * 서버가 여기서 한 번 보고, Agent-A 가 쓰는 순간 다시 본다(ifDraftRevision). 초안의 다른 칸(주석·첨부)은 그대로 다시 싣는다.
   * 같은 요청(같은 초안 판·같은 본문)을 다시 보내면 다시 쓰지 않고 저장된 초안을 돌려준다(저장은 됐는데 응답만 잃은 경우).
   */
  async saveDraft(fileId: string, sessionId: string, input: { markdown: string | null; revision: number }): Promise<AgentAReviewDraft> {
    const sid = this.session(sessionId);
    if (!Number.isSafeInteger(input.revision) || input.revision < 0) throw new ApiError(400, "초안 판이 올바르지 않습니다");
    if (input.markdown !== null && (typeof input.markdown !== "string" || input.markdown.length > 500_000)) throw new ApiError(400, "본문이 너무 깁니다");
    const mark: SaveMark = {
      key: saveKey(this.service.docOf(fileId).artifactId, sid, "body", input.revision, input.markdown),
      holds: (draft) => (input.markdown === null ? typeof draft.editedMarkdown !== "string" : draft.editedMarkdown === input.markdown),
    };
    return this.writeDraft(fileId, sid, input.revision, "지난 판의 검토에서는 본문을 고치지 않습니다. 최신 정본을 열어 주세요", mark, (kept) => {
      const { editedMarkdown: _e, ...rest } = kept;
      return input.markdown !== null ? { ...rest, editedMarkdown: input.markdown } : rest;
    });
  }

  /**
   * 검토 전체에 붙인 그림의 목록을 초안에 저장한다(더하거나 뺀 뒤의 목록 전체). 정본은 바뀌지 않고, 검토 제출 때 함께 넘어간다.
   * 본문 고치기와 같은 조건 저장이다: revision 뒤에 다른 화면이 초안을 저장했으면 아무것도 바꾸지 않는다. 초안의 다른 칸(주석·고친 본문)은 그대로 둔다.
   * 같은 요청(같은 초안 판·같은 목록)을 다시 보내면 다시 쓰지 않고 저장된 초안을 돌려준다.
   */
  async saveAttachments(fileId: string, sessionId: string, input: { attachments: unknown; revision: number }): Promise<AgentAReviewDraft> {
    const sid = this.session(sessionId);
    if (!Number.isSafeInteger(input.revision) || input.revision < 0) throw new ApiError(400, "초안 판이 올바르지 않습니다");
    const list = attachments(input.attachments);
    if (new Set(list.map((x) => x.path)).size !== list.length) throw new ApiError(400, "같은 그림이 두 번 들어 있습니다");
    const mark: SaveMark = {
      key: saveKey(this.service.docOf(fileId).artifactId, sid, "attachments", input.revision, list.map((x) => [x.path, x.name])),
      holds: (draft) => {
        const stored = Array.isArray(draft.globalAttachments) ? draft.globalAttachments : [];
        return stored.length === list.length && list.every((x, i) => obj(stored[i]) && stored[i].path === x.path && stored[i].name === x.name);
      },
    };
    return this.writeDraft(fileId, sid, input.revision, "지난 판의 검토에는 그림을 붙이지 않습니다. 최신 정본을 열어 주세요", mark, (kept) => ({ ...kept, globalAttachments: list }));
  }

  /**
   * 초안의 한 칸만 바꿔 조건 저장한다. 읽은 초안의 다른 칸은 그대로 다시 싣고, revision(화면이 본 초안 판)이 지금 판과 다르면 아무것도 보내지 않는다.
   * 서버가 여기서 한 번 보고, Agent-A 가 쓰는 순간 다시 본다(ifDraftRevision).
   * 판을 견주기 전에 같은 요청이 이미 저장됐는지 먼저 본다(mark). 저장됐으면 다시 쓰지 않고 지금 초안을 돌려준다. 다른 화면의 저장은 그대로 충돌이다.
   */
  private async writeDraft(fileId: string, sid: string, revision: number, stale: string, mark: SaveMark, change: (kept: Json) => Json): Promise<AgentAReviewDraft> {
    const doc = this.service.docOf(fileId);
    const session = await this.ok(fileId, null, "POST", "/api/plannotator/sessions", { artifact_id: doc.artifactId, resume_session_id: sid }, "검토를 찾지 못했습니다");
    if (session.decision) throw new ApiError(409, KNOWN.already_decided!, "AGENT_A_ALREADY_DECIDED");
    if (session.stale === true) throw new ApiError(409, stale, "AGENT_A_REVISION_CONFLICT");
    const got = await this.readDraft(fileId, sid);
    if (got.revision !== revision) {
      if (got.revision > revision && savedAlready(got.json, mark)) return this.draftView(got.revision, got.json);
      throw new ApiError(409, KNOWN.draft_conflict!, "AGENT_A_DRAFT_CONFLICT");
    }
    const { draftGeneration, documents: _d, found: _f, ...kept } = got.json;
    const body = {
      ...change({
        ...kept,
        annotations: Array.isArray(kept.annotations) ? kept.annotations : [],
        globalAttachments: Array.isArray(kept.globalAttachments) ? kept.globalAttachments : [],
      }),
      [SAVE_MARK]: { v: 1, key: mark.key },
      draftGeneration: num(draftGeneration) ?? 0,
      ifDraftRevision: revision,
    };
    const saved = await this.call(fileId, sid, "POST", "/api/draft", body);
    if (saved.status !== 200) {
      const refusal = obj(saved.json) ? saved.json : null;
      if (saved.status === 409 && refusal?.decided === true) throw new ApiError(409, KNOWN.already_decided!, "AGENT_A_ALREADY_DECIDED");
      if (saved.status === 409 && refusal && (refusal.code === undefined || refusal.code === "draft_conflict")) {
        // 읽은 뒤에 초안이 바뀌었다. 앞서 보낸 같은 요청이 그사이 저장된 것이면 그 결과를 돌려주고, 아니면 다른 화면의 저장이다.
        const now = await this.readDraft(fileId, sid);
        if (savedAlready(now.json, mark)) return this.draftView(now.revision, now.json);
        throw new ApiError(409, KNOWN.draft_conflict!, "AGENT_A_DRAFT_CONFLICT");
      }
      refuse(saved.status, saved.json, "초안을 저장하지 못했습니다");
    }
    if (saved.draftRevision === null) unsupported();
    const { ifDraftRevision: _i, ...stored } = body;
    return this.draftView(saved.draftRevision as number, stored);
  }

  /**
   * 검토 제출: 이 판의 초안에 든 주석을 분기의 질문으로 넘기고 검토를 닫는다. 정본은 바뀌지 않는다.
   * decision 은 원래 화면의 두 단추다: approved = 머리의 Save(확인하고 저장), feedback = 의견 보내기. Agent-A 가 하는 일은 같고 남는 결정 이름만 다르다.
   * revision 은 화면이 본 초안 판이다. 그 뒤 다른 화면이 초안을 바꿨으면 제출하지 않는다(그 댓글이 분기가 되지 못한 채 닫히지 않게).
   * 같은 내용으로 다시 보내면 Agent-A 가 처음 결과를 돌려준다.
   */
  async submit(fileId: string, sessionId: string, input: { revision: number; decision?: "feedback" | "approved" }): Promise<AgentAReviewSubmitResult> {
    const sid = this.session(sessionId);
    if (!Number.isSafeInteger(input.revision) || input.revision < 0) throw new ApiError(400, "초안 판이 올바르지 않습니다");
    const decision = input.decision ?? "feedback";
    if (decision !== "feedback" && decision !== "approved") throw new ApiError(400, "결정이 올바르지 않습니다");
    const doc = this.service.docOf(fileId);
    const session = await this.ok(fileId, null, "POST", "/api/plannotator/sessions", { artifact_id: doc.artifactId, resume_session_id: sid }, "검토를 찾지 못했습니다");
    const cur = await this.call(fileId, sid, "GET", "/api/draft");
    if (cur.status !== 200 && cur.status !== 404) refuse(cur.status, cur.json, "초안을 읽지 못했습니다");
    if (cur.draftRevision === null) unsupported();
    const decided = obj(session.decision);
    // 이미 제출한 검토의 재전송은 초안 판이 달라져 있다(제출이 초안을 비운다). Agent-A 가 같은 내용인지 보고 처음 결과를 돌려주게 그대로 보낸다.
    const source = decided && obj(session.decision) && obj((session.decision as Json).original_payload) ? ((session.decision as Json).original_payload as Json) : cur.status === 200 && obj(cur.json) ? cur.json : {};
    if (!decided && cur.draftRevision !== input.revision) throw new ApiError(409, KNOWN.draft_conflict!, "AGENT_A_DRAFT_CONFLICT");
    const annotations = (Array.isArray(source.annotations) ? source.annotations : []).filter((a) => obj(a) && typeof a.id === "string" && ["COMMENT", "GLOBAL_COMMENT", "DELETION"].includes(str(a.type)));
    const attachments = Array.isArray(source.globalAttachments) ? source.globalAttachments : [];
    const edited = typeof source.editedMarkdown === "string" ? source.editedMarkdown : null;
    const nothing = !annotations.length && !attachments.length && edited === null;
    const payload = decided ? source : {
      serverSession: str(session.server_session),
      feedback: nothing ? "" : feedbackText(str(session.markdown), annotations as Json[], edited, attachments.length),
      annotations,
      ...(edited !== null ? { editedMarkdown: edited } : {}),
      ...(attachments.length ? { globalAttachments: attachments } : {}),
      ...(nothing ? { nothingToSend: true } : {}),
      ifDraftRevision: input.revision,
    };
    const sent = await this.call(fileId, sid, "POST", decision === "approved" ? "/api/approve" : "/api/feedback", payload);
    if (sent.status !== 200 || !obj(sent.json)) {
      if (sent.status === 409 && obj(sent.json) && sent.json.code === "draft_conflict") throw new ApiError(409, KNOWN.draft_conflict!, "AGENT_A_DRAFT_CONFLICT");
      refuse(sent.status, sent.json, "검토를 제출하지 못했습니다");
    }
    return { ok: true, sent: Array.isArray(sent.json.feedback_ids) ? sent.json.feedback_ids.length : 0, branches: Array.isArray(sent.json.branch_ids) ? sent.json.branch_ids.length : 0 };
  }

  // ---- 문서 대화(Ask AI) ----

  private chatHistoryOf(json: Json): AgentAChatHistory {
    const entries = (Array.isArray(json.entries) ? json.entries : []).flatMap((e): AgentAChatEntry[] => {
      if (!obj(e) || !obj(e.question) || !str(e.question.id)) return [];
      const q = e.question, r = obj(e.response) ? e.response : {};
      const scope = obj(q.scope) ? q.scope : {};
      return [{
        id: str(q.id),
        prompt: str(q.prompt),
        quote: scope.kind === "selection" && str(scope.text) ? str(scope.text) : null,
        createdAt: num(q.createdAt) ?? 0,
        answer: str(r.text),
        writing: r.isStreaming === true && !str(r.error),
        error: str(r.error) || null,
        provider: str(r.providerId) || null,
      }];
    });
    const origin = obj(json.origin) && str(json.origin.conversationId) ? json.origin : null;
    return {
      conversationId: str(json.conversationId),
      entries,
      branchedFrom: origin ? str(origin.conversationId) : null,
      branchPoint: origin && str(origin.questionId) ? { questionId: str(origin.questionId), point: origin.point === "question" ? "question" : "answer" } : null,
    };
  }
  private conversation(id: string): string {
    if (!ANNOTATION.test(id)) throw new ApiError(400, "대화 id 가 올바르지 않습니다");
    return id;
  }

  /** 이 문서의 대화. conversationId 를 비우면 지금 이어 가는 대화다(없으면 Agent-A 가 새로 만든다). */
  async chatHistory(fileId: string, sessionId: string, conversationId?: string | null): Promise<AgentAChatHistory> {
    const path = conversationId ? `/api/ai/history?conversationId=${encodeURIComponent(this.conversation(conversationId))}` : "/api/ai/history";
    return this.chatHistoryOf(await this.ok(fileId, this.session(sessionId), "GET", path, undefined, "대화를 불러오지 못했습니다"));
  }
  async chatSessions(fileId: string, sessionId: string): Promise<AgentAChatSession[]> {
    const { status, json } = await this.call(fileId, this.session(sessionId), "GET", "/api/ai/sessions");
    if (status !== 200 || !Array.isArray(json)) refuse(status, json, "대화 목록을 불러오지 못했습니다");
    return (json as unknown[]).flatMap((x): AgentAChatSession[] => (obj(x) && str(x.sessionId) ? [{ conversationId: str(x.sessionId), label: str(x.label), current: x.current === true, active: x.isActive === true, createdAt: num(x.createdAt) ?? 0, updatedAt: num(x.lastActiveAt) ?? 0 }] : []));
  }
  /** 새 대화를 시작한다. 앞 대화는 목록에 남는다. */
  async chatNew(fileId: string, sessionId: string): Promise<AgentAChatHistory> {
    return this.chatHistoryOf(await this.ok(fileId, this.session(sessionId), "POST", "/api/ai/new", {}, "새 대화를 시작하지 못했습니다"));
  }
  /** 앞 대화를 골라 이어 간다. */
  async chatSelect(fileId: string, sessionId: string, conversationId: string): Promise<AgentAChatHistory> {
    return this.chatHistoryOf(await this.ok(fileId, this.session(sessionId), "POST", "/api/ai/select", { conversationId: this.conversation(conversationId) }, "대화를 고르지 못했습니다"));
  }
  /**
   * 대화를 한 질문까지(point=question 은 그 질문만, answer 는 그 답까지) 복사해 새 대화로 가른다.
   * 원래 대화는 그대로 남고 새 대화가 '지금 대화'가 된다. 정본은 바뀌지 않는다. 답을 쓰는 중에는 Agent-A 가 거절한다.
   */
  async chatFork(fileId: string, sessionId: string, input: { conversationId: string; questionId: string; point: "question" | "answer" }): Promise<AgentAChatHistory> {
    if (!ANNOTATION.test(input.questionId)) throw new ApiError(400, "질문 id 가 올바르지 않습니다");
    if (input.point !== "question" && input.point !== "answer") throw new ApiError(400, "가를 자리가 올바르지 않습니다");
    return this.chatHistoryOf(await this.ok(fileId, this.session(sessionId), "POST", "/api/ai/fork", { conversationId: this.conversation(input.conversationId), questionId: input.questionId, point: input.point }, "대화를 가르지 못했습니다"));
  }
  /** 답을 쓰는 중에 AI 가 구한 허락(도구 실행)에 답한다. 대표가 누른 그대로만 보낸다. 이미 지난 요청이면 Agent-A 가 거절한다. */
  async chatPermission(fileId: string, sessionId: string, input: { conversationId: string; requestId: string; allow: boolean }): Promise<{ ok: true }> {
    if (typeof input.requestId !== "string" || !input.requestId || input.requestId.length > 500) throw new ApiError(400, "권한 요청 id 가 올바르지 않습니다");
    if (typeof input.allow !== "boolean") throw new ApiError(400, "허용·거절을 골라 주세요");
    await this.ok(fileId, this.session(sessionId), "POST", "/api/ai/permission", { sessionId: this.conversation(input.conversationId), requestId: input.requestId, allow: input.allow }, "권한 응답을 보내지 못했습니다");
    return { ok: true };
  }
  /** 쓰고 있는 답을 멈춘다. */
  async chatAbort(fileId: string, sessionId: string, conversationId: string): Promise<{ ok: true }> {
    await this.ok(fileId, this.session(sessionId), "POST", "/api/ai/abort", { sessionId: this.conversation(conversationId) }, "답을 멈추지 못했습니다");
    return { ok: true };
  }
  /**
   * 문서에 질문한다. 답은 줄마다 JSON 하나인 흐름으로 돌려준다: {type:"start",conversationId} · {type:"delta",text} · {type:"error",message,code} · {type:"done",ok}.
   * Agent-A 의 흐름을 그대로 넘기지 않고 화면이 쓰는 칸만 옮긴다. 같은 질문 id 를 다시 보내면 Agent-A 가 거절한다(질문은 하나다).
   */
  async chatAsk(fileId: string, sessionId: string, input: { id: string; prompt: string; quote?: string | null; ai?: AgentAReviewAiSettings | null }, signal?: AbortSignal): Promise<Response> {
    const sid = this.session(sessionId);
    const doc = this.service.docOf(fileId);
    if (!ANNOTATION.test(input.id)) throw new ApiError(400, "질문 id 가 올바르지 않습니다");
    const prompt = input.prompt.trim();
    const quote = (input.quote ?? "").trim();
    if (!prompt || prompt.length > MAX_TEXT) throw new ApiError(400, "질문은 1~30000자입니다");
    if (quote.length > MAX_QUOTE) throw new ApiError(400, "고른 글이 너무 깁니다");
    const settings = aiSettings(input.ai);
    // 이어 갈 대화와 이번 답의 AI 설정을 정한다(설정을 비우면 그 대화의 기존 설정·Agent-A 기본값).
    const opened = await this.ok(fileId, sid, "POST", "/api/ai/session", settings ?? {}, "대화를 열지 못했습니다");
    const conversationId = str(opened.sessionId);
    if (!conversationId) throw new ApiError(502, "Agent-A 가 대화를 돌려주지 않았습니다", "AGENT_A_BAD_RESPONSE");
    let res: Response;
    try {
      res = await this.service.client.reviewStream("/api/ai/query", { artifactId: doc.artifactId, sessionId: sid }, {
        sessionId: conversationId,
        prompt: quote ? `${prompt}\n\nSelected text:\n${quote}` : prompt,
        displayQuestion: { id: input.id, prompt, scope: quote ? { kind: "selection", text: quote } : { kind: "general" } },
      }, signal);
    } catch (e) {
      if (e instanceof AgentAError) throw new ApiError(502, "Agent-A 서버에 닿지 않습니다", "AGENT_A_UNAVAILABLE");
      throw e;
    }
    if (res.status !== 200 || !res.body) {
      const text = await res.text().catch(() => "");
      let json: unknown = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }
      refuse(res.status === 200 ? 502 : res.status, json, "질문을 보내지 못했습니다");
    }
    const encoder = new TextEncoder(), decoder = new TextDecoder();
    const line = (value: Record<string, unknown>) => encoder.encode(`${JSON.stringify(value)}\n`);
    let buffer = "";
    let finished = false;
    const lines = (packet: string): Uint8Array[] => {
      const data = packet.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
      if (!data || data === "[DONE]") return [];
      let event: unknown;
      try { event = JSON.parse(data); } catch { return []; }
      if (!obj(event)) return [];
      if (event.type === "text_delta" && typeof event.delta === "string") return [line({ type: "delta", text: event.delta })];
      if (event.type === "error") return [line({ type: "error", message: str(event.error) || "답을 받지 못했습니다", code: str(event.code) || "provider_failed" })];
      if (event.type === "permission_request" && typeof event.requestId === "string" && event.requestId) {
        // AI 가 도구를 쓰려고 허락을 구한다. 화면이 읽을 칸만 옮긴다(도구 이름·제목·무엇을 하려는지). 입력 전체는 넘기지 않는다.
        const input = obj(event.toolInput) ? event.toolInput : {};
        const detail = str(event.description) || str(input.command) || str(input.file_path) || str(input.path) || str(input.url) || (Object.keys(input).length ? JSON.stringify(input) : "");
        return [line({ type: "permission", requestId: event.requestId.slice(0, 500), tool: (str(event.displayName) || str(event.toolName) || "도구").slice(0, 200), title: str(event.title).slice(0, 500), detail: detail.slice(0, 2_000) })];
      }
      if (event.type === "result" && !finished) {
        finished = true;
        return [line({ type: "done", ok: event.success !== false, text: str(event.result) })];
      }
      return [];
    };
    const source = res.body.getReader();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(line({ type: "start", conversationId }));
      },
      async pull(controller) {
        // 한 번 부를 때 줄 하나는 내보내거나 끝낸다. 아무것도 내보내지 않고 돌아가면 흐름이 다시 불리지 않아 멈춘다
        // (Agent-A 의 조각 가운데 화면에 옮기지 않는 것이 있다).
        for (;;) {
          const { done, value } = await source.read();
          if (done) {
            for (const out of lines(buffer)) controller.enqueue(out);
            if (!finished) controller.enqueue(line({ type: "done", ok: false, text: "" }));
            controller.close();
            return;
          }
          buffer += decoder.decode(value, { stream: true });
          let emitted = false;
          let at: number;
          while ((at = buffer.indexOf("\n\n")) >= 0) {
            const packet = buffer.slice(0, at);
            buffer = buffer.slice(at + 2);
            for (const out of lines(packet)) {
              controller.enqueue(out);
              emitted = true;
            }
          }
          if (emitted) return;
        }
      },
      cancel() {
        void source.cancel().catch(() => {});
      },
    });
    return new Response(stream, { status: 200, headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Content-Type-Options": "nosniff" } });
  }

  // ---- 문서 관리 ----

  async manage(fileId: string): Promise<AgentAReviewManage> {
    const doc = this.service.docOf(fileId);
    const state = await this.service.readState(fileId);
    const titleOf = (blockId: string, fallback: string | null) => state.blocks.find((b) => b.id === blockId)?.content.title ?? fallback ?? blockId;
    // 전송 기록과 자동 연동 여부는 곁들임이다. 못 읽어도 정본·수정안은 보인다.
    const jobs = await this.service.client.jobs(doc.artifactId).catch(() => []);
    const adapter = await this.service.client.config_().then((c) => c.adapter_enabled === true, () => false);
    const targetOf = (t: Record<string, unknown>): string => {
      const block = typeof t.block_id === "string" ? titleOf(t.block_id, null) : "";
      if (t.kind === "text") return `${block} · “${str(t.exact).replace(/\s+/g, " ").slice(0, 80)}”`;
      if (t.kind === "region") return `${block} · 그림 영역`;
      if (t.kind === "message") return "앞 답변";
      return block || "문서 전체";
    };
    const branches = state.branches.map((b): AgentAManageBranch => ({
      id: b.id,
      title: b.title || "분기",
      status: b.status === "closed" ? "closed" : "open",
      parentId: b.parent_branch_id ?? null,
      target: targetOf(b.target),
      messages: b.messages.map((m) => ({ id: m.id, role: m.role, body: m.body, decision: m.decision ?? null, reason: m.reason || null, at: m.created_at })),
    }));
    return {
      artifactRevision: state.artifact_revision,
      contextRevision: state.context_revision,
      layoutRevision: state.layout_revision,
      goal: typeof state.goal === "string" ? state.goal : "",
      constraints: (Array.isArray(state.constraints) ? state.constraints : []).filter((c): c is string => typeof c === "string"),
      branches,
      feedback: state.feedback.map((f) => ({
        id: f.id,
        branchId: f.branch_id,
        branchTitle: branches.find((b) => b.id === f.branch_id)?.title ?? "",
        message: f.message ?? state.branches.find((b) => b.id === f.branch_id)?.messages.find((m) => m.role === "user" && (m.question_id ?? m.id) === f.question_id)?.body ?? "",
        state: f.state,
      })),
      jobs: (Array.isArray(jobs) ? jobs : []).map((j) => ({ id: j.id, state: j.state, error: j.error ?? null, feedback: j.packet?.selected_feedback?.length ?? 0 })),
      events: state.events.slice(-30).reverse().map((e) => ({ seq: e.seq, type: e.type, at: e.created_at })),
      adapter,
      blocks: state.blocks.map(blockView),
      proposals: state.proposals.map((p) => {
        const view = proposalView(p, state);
        return { ...view, operations: view.operations.map((op) => ({ ...op, blockTitle: titleOf(op.blockId, op.title) })) };
      }),
      versions: versionsOf(state, doc.createdAt),
    };
  }

  private async command(fileId: string, command: Record<string, unknown>, fallback: string, conflict: string = KNOWN.revision_conflict!): Promise<AState> {
    const doc = this.service.docOf(fileId);
    try {
      await this.service.client.command(doc.artifactId, command);
    } catch (e) {
      if (!(e instanceof AgentAError)) throw e;
      if (e.outcomeUnknown) throw new ApiError(502, "Agent-A 응답을 받지 못했습니다. 다시 누르면 같은 요청으로 결과를 확인합니다", "AGENT_A_UNKNOWN");
      if (e.kind === "conflict") throw new ApiError(409, e.code === "idempotency_conflict" ? "같은 요청 id 로 다른 내용을 보냈습니다" : conflict, "AGENT_A_REVISION_CONFLICT");
      throw new ApiError(e.kind === "not_found" ? 404 : e.kind === "auth" ? 502 : 400, e.kind === "auth" ? "Agent-A 연결 열쇠가 맞지 않습니다" : e.message || fallback, "AGENT_A_REFUSED");
    }
    return this.service.readState(fileId);
  }

  /** 수정안 하나를 반영·보류·거절한다. opId 가 같으면 Agent-A 가 같은 명령으로 본다(두 번 반영하지 않는다). */
  async decide(fileId: string, proposalId: string, decision: "apply" | "held" | "rejected", opId: string, reason = ""): Promise<{ ok: true; status: AgentAProposalStatus; artifactRevision: number; verified: boolean }> {
    if (!ANNOTATION.test(proposalId) || !OP.test(opId)) throw new ApiError(400, "요청 id 가 올바르지 않습니다");
    return this.serial(`proposal:${proposalId}`, async () => {
      const before = await this.service.readState(fileId);
      if (!before.proposals.some((p) => p.id === proposalId)) throw new ApiError(404, "이 문서의 수정안이 아닙니다");
      const command = decision === "apply"
        ? { command_id: `iamceo-review-apply-${opId}`, type: "apply_proposals", proposal_ids: [proposalId] }
        : { command_id: `iamceo-review-${decision}-${opId}`, type: "decide_proposal", proposal_id: proposalId, decision, reason: reason.slice(0, 1000) };
      const state = await this.command(fileId, command, "수정안을 처리하지 못했습니다");
      const p = state.proposals.find((x) => x.id === proposalId);
      const status = (p?.status ?? "conflict") as AgentAProposalStatus;
      return { ok: true as const, status, artifactRevision: state.artifact_revision, verified: decision === "apply" ? Boolean(p && status === "applied" && verifyApplied(state, p)) : status === decision };
    });
  }

  // ---- 문서 관리: 분기 · 피드백 ----

  /**
   * 새 분기: 블록에 질문하거나(blockId), 앞 분기의 답변에서 갈라 질문한다(parent). 정본은 바뀌지 않는다.
   * 분기 id 와 명령 id 를 opId 로 정해, 같은 요청을 다시 보내면 Agent-A 가 처음 결과를 돌려준다.
   */
  async branchCreate(fileId: string, input: { opId: string; question: string; blockId?: string | null; parent?: { branchId: string; messageId: string } | null }): Promise<{ ok: true; branchId: string }> {
    if (!OP.test(input.opId)) throw new ApiError(400, "요청 id 가 올바르지 않습니다");
    const question = input.question.trim();
    if (!question || question.length > MAX_TEXT) throw new ApiError(400, "질문은 1~30000자입니다");
    const state = await this.service.readState(fileId);
    const branchId = `iamceo-branch-${input.opId}`;
    let target: Record<string, unknown>;
    let child: Record<string, unknown> = {};
    if (input.parent) {
      if (!ANNOTATION.test(input.parent.branchId) || !ANNOTATION.test(input.parent.messageId)) throw new ApiError(400, "분기 id 가 올바르지 않습니다");
      // Agent-A 의 명령 형식: 답변 전체를 가리킬 때는 exact 를 null 로 싣는다(답변의 한 구절만 가리키는 기능은 쓰지 않는다).
      target = { kind: "message", branch_id: input.parent.branchId, message_id: input.parent.messageId, exact: null };
      child = { parent_branch_id: input.parent.branchId, origin_message_id: input.parent.messageId };
    } else {
      const block = state.blocks.find((b) => b.id === input.blockId && !b.archived);
      // 이미 만든 분기의 재전송이면 그때의 대상을 그대로 다시 쓴다(블록이 그사이 바뀌었어도 같은 명령이 된다).
      const made = state.branches.find((b) => b.id === branchId);
      if (!block && !made) throw new ApiError(404, "질문할 블록을 찾지 못했습니다");
      target = made ? made.target : { kind: "block", block_id: block!.id, block_revision: block!.revision };
    }
    await this.command(fileId, { command_id: `iamceo-review-branch-${input.opId}`, type: "create_branch", branch_id: branchId, target, ...child, title: question.replace(/\s+/g, " ").slice(0, 200), message: question }, "분기를 만들지 못했습니다");
    return { ok: true, branchId };
  }

  /** 분기에 후속 질문을 더한다. 닫힌 분기는 다시 열린다(Agent-A 규칙). */
  async branchMessage(fileId: string, input: { opId: string; branchId: string; text: string }): Promise<{ ok: true }> {
    const text = input.text.trim();
    if (!OP.test(input.opId) || !ANNOTATION.test(input.branchId)) throw new ApiError(400, "요청 id 가 올바르지 않습니다");
    if (!text || text.length > MAX_TEXT) throw new ApiError(400, "질문은 1~30000자입니다");
    await this.command(fileId, { command_id: `iamceo-review-message-${input.opId}`, type: "add_message", branch_id: input.branchId, message: text }, "후속 질문을 저장하지 못했습니다");
    return { ok: true };
  }

  /** 분기의 답변을 채택·보류·거절로 표시한다. 정본은 바뀌지 않는다(정본 반영은 변경안에서 따로 한다). */
  async branchDecide(fileId: string, input: { opId: string; branchId: string; messageId: string; decision: "accepted" | "held" | "rejected"; reason?: string }): Promise<{ ok: true }> {
    if (!OP.test(input.opId) || !ANNOTATION.test(input.branchId) || !ANNOTATION.test(input.messageId)) throw new ApiError(400, "요청 id 가 올바르지 않습니다");
    if (!["accepted", "held", "rejected"].includes(input.decision)) throw new ApiError(400, "결정이 올바르지 않습니다");
    await this.command(fileId, { command_id: `iamceo-review-answer-${input.opId}`, type: "decide_message", branch_id: input.branchId, message_id: input.messageId, decision: input.decision, reason: (input.reason ?? "").slice(0, 1000) }, "결정을 저장하지 못했습니다");
    return { ok: true };
  }

  /** 분기를 닫는다. 남은 것(답 없는 질문·열린 하위 분기·반영 안 한 변경안)의 수를 돌려준다. */
  async branchClose(fileId: string, input: { opId: string; branchId: string; reason?: string }): Promise<{ ok: true; unanswered: number; openChildren: number; unapplied: number }> {
    if (!OP.test(input.opId) || !ANNOTATION.test(input.branchId)) throw new ApiError(400, "요청 id 가 올바르지 않습니다");
    const doc = this.service.docOf(fileId);
    let receipt: { result?: Record<string, unknown> };
    try {
      // Agent-A 는 닫는 사유가 비면 받지 않는다. 대표가 사유를 적지 않았으면 '닫음'으로 남긴다.
      receipt = await this.service.client.command(doc.artifactId, { command_id: `iamceo-review-close-${input.opId}`, type: "close_branch", branch_id: input.branchId, reason: (input.reason ?? "").trim().slice(0, 1000) || "닫음" });
    } catch (e) {
      if (!(e instanceof AgentAError)) throw e;
      if (e.outcomeUnknown) throw new ApiError(502, "Agent-A 응답을 받지 못했습니다. 다시 누르면 같은 요청으로 결과를 확인합니다", "AGENT_A_UNKNOWN");
      throw new ApiError(e.kind === "not_found" ? 404 : e.kind === "conflict" ? 409 : e.kind === "auth" ? 502 : 400, e.message || "분기를 닫지 못했습니다", "AGENT_A_REFUSED");
    }
    const left = obj(receipt.result) && obj(receipt.result.unresolved) ? receipt.result.unresolved : {};
    return { ok: true, unanswered: num(left.unanswered) ?? 0, openChildren: num(left.open_children) ?? 0, unapplied: num(left.unapplied_proposals) ?? 0 };
  }

  /** 고른 변경안 여러 개를 한 번에(전부 되거나 전부 안 되게) 정본에 반영한다. */
  async applyMany(fileId: string, input: { opId: string; proposalIds: string[] }): Promise<{ ok: true; artifactRevision: number; verified: boolean }> {
    if (!OP.test(input.opId) || !input.proposalIds.length || input.proposalIds.length > 50 || new Set(input.proposalIds).size !== input.proposalIds.length || input.proposalIds.some((id) => !ANNOTATION.test(id))) throw new ApiError(400, "고른 변경안이 올바르지 않습니다");
    const state = await this.command(fileId, { command_id: `iamceo-review-applymany-${input.opId}`, type: "apply_proposals", proposal_ids: input.proposalIds }, "변경안을 반영하지 못했습니다");
    const picked = state.proposals.filter((p) => input.proposalIds.includes(p.id));
    return { ok: true, artifactRevision: state.artifact_revision, verified: picked.length === input.proposalIds.length && picked.every((p) => p.status === "applied" && verifyApplied(state, p)) };
  }

  private async jobCall<T>(run: () => Promise<T>, fallback: string): Promise<T> {
    try {
      return await run();
    } catch (e) {
      if (!(e instanceof AgentAError)) throw e;
      if (e.kind === "unreachable") throw new ApiError(502, "Agent-A 서버에 닿지 않습니다", "AGENT_A_UNAVAILABLE");
      if (e.code === "adapter_disabled") throw new ApiError(409, "Agent-A 의 자동 연동이 꺼져 있습니다. 전송 자료를 내보내 수동으로 교환해 주세요", "AGENT_A_ADAPTER_OFF");
      throw new ApiError(e.kind === "not_found" ? 404 : e.kind === "conflict" ? 409 : e.kind === "auth" || e.kind === "server" ? 502 : 400, e.kind === "auth" ? "Agent-A 연결 열쇠가 맞지 않습니다" : e.message || fallback, "AGENT_A_REFUSED");
    }
  }
  private async ownJob(fileId: string, jobId: string): Promise<void> {
    if (!ANNOTATION.test(jobId)) throw new ApiError(400, "전송 기록 id 가 올바르지 않습니다");
    const doc = this.service.docOf(fileId);
    const job = await this.jobCall(() => this.service.client.job(jobId), "전송 기록을 찾지 못했습니다");
    if (job.artifact_id !== doc.artifactId) throw new ApiError(404, "이 문서의 전송 기록이 아닙니다");
  }

  /** 고른 질문으로 전송 자료를 준비한다(아직 아무 데도 보내지 않는다). 같은 opId 로 다시 보내면 같은 자료다. */
  async feedbackPrepare(fileId: string, input: { opId: string; feedbackIds: string[]; template?: string }): Promise<{ ok: true; jobId: string }> {
    if (!OP.test(input.opId) || !input.feedbackIds.length || input.feedbackIds.length > 50 || new Set(input.feedbackIds).size !== input.feedbackIds.length || input.feedbackIds.some((id) => !ANNOTATION.test(id))) throw new ApiError(400, "고른 질문이 올바르지 않습니다");
    const doc = this.service.docOf(fileId);
    const template = (input.template ?? "").trim().slice(0, 4000);
    const job = await this.jobCall(() => this.service.client.feedbackBatch(doc.artifactId, { feedback_ids: input.feedbackIds, idempotency_key: `iamceo-review-batch-${input.opId}`, ...(template ? { template } : {}) }), "전송 자료를 준비하지 못했습니다");
    return { ok: true, jobId: job.id };
  }
  /** 전송 자료(읽기 범위·수정 허용 범위·결과 양식). 수동 교환에 쓴다. */
  async jobExport(fileId: string, jobId: string): Promise<Record<string, unknown>> {
    await this.ownJob(fileId, jobId);
    return this.jobCall(() => this.service.client.jobExport(jobId), "전송 자료를 내보내지 못했습니다");
  }
  /** Agent-A 에 설정된 CLI 로 실행한다(자동 연동이 켜진 Agent-A 에서만. 실제 AI 를 부른다). */
  async jobRun(fileId: string, jobId: string): Promise<{ ok: true; state: string }> {
    await this.ownJob(fileId, jobId);
    const job = await this.jobCall(() => this.service.client.runJob(jobId), "실행하지 못했습니다");
    return { ok: true, state: job.state };
  }
  async jobCancel(fileId: string, jobId: string): Promise<{ ok: true; state: string }> {
    await this.ownJob(fileId, jobId);
    const r = await this.jobCall(() => this.service.client.cancelJob(jobId), "취소하지 못했습니다");
    return { ok: true, state: r.state };
  }
  /** 수동으로 받은 결과(답·변경안)를 저장한다. 정본 반영은 변경안에서 따로 고른다. */
  async importResult(fileId: string, result: unknown): Promise<{ ok: true }> {
    const doc = this.service.docOf(fileId);
    if (!obj(result) || typeof result.receipt_id !== "string") throw new ApiError(400, "결과 JSON 에 receipt_id 가 있어야 합니다");
    await this.jobCall(() => this.service.client.importResult(doc.artifactId, result), "결과를 가져오지 못했습니다");
    return { ok: true };
  }

  /**
   * 블록의 이전 판 내용을 새 판으로 되살린다.
   * 명령은 요청이 가리킨 판(revision)과 화면이 본 문맥·배치 판으로만 만든다. 그래서 같은 요청을 다시 보내면 글자 하나 다르지 않은 같은 명령이 되고,
   * Agent-A 가 판 검사보다 먼저 보관해 둔 처음 결과를 돌려준다(저장은 됐는데 응답만 잃은 경우). 지금 판으로 바꿔 다시 보내지 않는다:
   * 새 요청이 낡은 판을 가리키면 Agent-A 가 거절하고, 같은 요청 id 로 다른 내용을 보내도 거절한다.
   */
  async restore(fileId: string, input: { blockId: string; revision: number; historyRevision: number; opId: string; contextRevision?: number | null; layoutRevision?: number | null }): Promise<{ ok: true; artifactRevision: number }> {
    if (!ANNOTATION.test(input.blockId) || !OP.test(input.opId)) throw new ApiError(400, "요청 id 가 올바르지 않습니다");
    if (!Number.isSafeInteger(input.revision) || !Number.isSafeInteger(input.historyRevision)) throw new ApiError(400, "판 번호가 올바르지 않습니다");
    const before = await this.service.readState(fileId);
    const block = before.blocks.find((b) => b.id === input.blockId);
    if (!block || !block.history.some((h) => h.revision === input.historyRevision)) throw new ApiError(404, "그 판을 찾지 못했습니다");
    const commandId = `iamceo-review-restore-${input.opId}`;
    const first = ranCommand(before, commandId);
    const state = await this.command(fileId, {
      command_id: commandId,
      type: "restore_block",
      block_id: block.id,
      base_revision: input.revision,
      history_revision: input.historyRevision,
      context_revision: revisionOr(input.contextRevision, first?.context_revision, before.context_revision),
      base_layout_revision: revisionOr(input.layoutRevision, first?.base_layout_revision, before.layout_revision),
    }, "이전 판을 되살리지 못했습니다");
    return { ok: true, artifactRevision: state.artifact_revision };
  }

  /**
   * 블록 제목·요약·본문을 직접 고쳐 정본에 저장한다. 요약을 보내지 않으면 요청이 가리킨 판의 요약을 그대로 둔다. 출처는 늘 그 판의 것을 그대로 둔다.
   * 되살리기와 같이, 같은 요청을 다시 보내면 같은 명령이 되어 처음 결과를 확인한다. 화면이 본 판과 정본이 다른 새 요청은 Agent-A 가 거절한다.
   */
  async edit(fileId: string, input: { blockId: string; revision: number; title: string; body: string; summary?: string; opId: string; contextRevision?: number | null }): Promise<{ ok: true; artifactRevision: number }> {
    if (!ANNOTATION.test(input.blockId) || !OP.test(input.opId)) throw new ApiError(400, "요청 id 가 올바르지 않습니다");
    if (!Number.isSafeInteger(input.revision)) throw new ApiError(400, "판 번호가 올바르지 않습니다");
    const title = input.title.trim();
    if (!title || title.length > 500 || input.body.length > 500_000) throw new ApiError(400, "제목이 비었거나 본문이 너무 깁니다");
    if (input.summary !== undefined && (typeof input.summary !== "string" || input.summary.length > 10_000)) throw new ApiError(400, "요약이 너무 깁니다");
    const before = await this.service.readState(fileId);
    const block = before.blocks.find((b) => b.id === input.blockId);
    if (!block) throw new ApiError(404, "그 블록을 찾지 못했습니다");
    // 요청이 가리킨 판의 내용: 지금 판이면 지금 것, 이미 지난 판이면 이력의 그 판(같은 요청의 재전송일 수 있다).
    const base = block.revision === input.revision ? { content: block.content, archived: block.archived } : block.history.find((h) => h.revision === input.revision);
    // 그 판이 이력에도 없으면 이 문서에서 나온 요청이 아니다. 지금 판에 맞춰 보내지 않는다.
    if (!base) throw new ApiError(409, KNOWN.revision_conflict!, "AGENT_A_REVISION_CONFLICT");
    if (block.revision === input.revision && block.archived) throw new ApiError(404, "그 블록을 찾지 못했습니다");
    const commandId = `iamceo-review-edit-${input.opId}`;
    const state = await this.command(fileId, {
      command_id: commandId,
      type: "edit_block",
      block_id: block.id,
      base_revision: input.revision,
      context_revision: revisionOr(input.contextRevision, ranCommand(before, commandId)?.context_revision, before.context_revision),
      content: { ...base.content, title, ...(input.summary !== undefined ? { summary: input.summary } : {}), body: input.body },
    }, "정본을 저장하지 못했습니다");
    return { ok: true, artifactRevision: state.artifact_revision };
  }

  // ---- 문서 관리: 검토 표시 · 보관 · 새 블록 · 순서와 배치 · 목표와 제약 ----
  // 아래 명령은 모두 요청이 가리킨 판(블록 판·문맥 판·배치 판)으로만 만든다. 같은 요청을 다시 보내면 글자 하나 다르지 않은 같은 명령이 되어
  // Agent-A 가 처음 결과를 돌려준다(저장은 됐는데 응답만 잃은 경우). 화면이 본 판이 낡았으면 Agent-A 가 거절하고, 여기서 지금 판으로 바꿔 다시 보내지 않는다.

  /** 블록을 '검토함'으로 표시한다(요청이 가리킨 판이 지금 판일 때만). 본문과 정본 판은 바뀌지 않는다. 블록이 고쳐지면 표시는 지난 판의 것이 된다. */
  async blockReview(fileId: string, input: { blockId: string; revision: number; opId: string }): Promise<{ ok: true; reviewedRevision: number | null }> {
    if (!ANNOTATION.test(input.blockId) || !OP.test(input.opId)) throw new ApiError(400, "요청 id 가 올바르지 않습니다");
    if (!Number.isSafeInteger(input.revision) || input.revision < 1) throw new ApiError(400, "판 번호가 올바르지 않습니다");
    const state = await this.command(fileId, { command_id: `iamceo-review-reviewed-${input.opId}`, type: "review_block", block_id: input.blockId, base_revision: input.revision }, "검토 표시를 저장하지 못했습니다");
    const block = state.blocks.find((b) => b.id === input.blockId);
    return { ok: true, reviewedRevision: typeof block?.reviewed_revision === "number" ? block.reviewed_revision : null };
  }

  /** 블록을 문서에서 보관한다. 지우는 것이 아니다: 이전 판과 함께 남고 '이전 판 되살리기'로 돌아온다. 새 정본 판이 생긴다. */
  async blockArchive(fileId: string, input: { blockId: string; revision: number; opId: string; contextRevision?: number | null; layoutRevision?: number | null }): Promise<{ ok: true; artifactRevision: number }> {
    if (!ANNOTATION.test(input.blockId) || !OP.test(input.opId)) throw new ApiError(400, "요청 id 가 올바르지 않습니다");
    if (!Number.isSafeInteger(input.revision) || input.revision < 1) throw new ApiError(400, "판 번호가 올바르지 않습니다");
    const before = await this.service.readState(fileId);
    const commandId = `iamceo-review-archive-${input.opId}`;
    const first = ranCommand(before, commandId);
    const state = await this.command(fileId, {
      command_id: commandId,
      type: "archive_block",
      block_id: input.blockId,
      base_revision: input.revision,
      base_layout_revision: revisionOr(input.layoutRevision, first?.base_layout_revision, before.layout_revision),
      context_revision: revisionOr(input.contextRevision, first?.context_revision, before.context_revision),
    }, "블록을 보관하지 못했습니다");
    return { ok: true, artifactRevision: state.artifact_revision };
  }

  /** 그림 하나를 Agent-A 에 올리고 그 그림의 정보(경로·크기)를 받는다. 같은 그림은 같은 경로다(내용 해시). */
  private async uploadImage(input: { name: string; mediaType: string; base64: string }): Promise<AAsset> {
    if (!["image/png", "image/jpeg", "image/webp"].includes(input.mediaType)) throw new ApiError(400, "PNG·JPEG·WebP 그림만 붙일 수 있습니다");
    if (!input.base64 || input.base64.length > 6 * 1024 * 1024) throw new ApiError(400, "그림은 4MB 까지입니다");
    try {
      const asset = await this.service.client.uploadAsset({ name: input.name.trim().slice(0, 200) || "그림", media_type: input.mediaType, base64: input.base64 });
      if (!UPLOADED.test(str(asset?.src))) throw new ApiError(502, "Agent-A 가 그림 경로를 돌려주지 않았습니다", "AGENT_A_BAD_RESPONSE");
      return asset;
    } catch (e) {
      if (!(e instanceof AgentAError)) throw e;
      if (e.outcomeUnknown) throw new ApiError(502, "Agent-A 서버에 닿지 않습니다", "AGENT_A_UNAVAILABLE");
      throw new ApiError(e.kind === "auth" ? 502 : 400, e.kind === "auth" ? "Agent-A 연결 열쇠가 맞지 않습니다" : e.message || "그림을 올리지 못했습니다", "AGENT_A_REFUSED");
    }
  }

  /**
   * 문서에 새 블록을 더한다(글·표·도식·그림). afterId 는 그 블록 바로 뒤, null 이면 맨 앞이다. 새 정본 판이 생긴다.
   * 블록 id 를 opId 로 정해, 같은 요청을 다시 보내면 블록이 하나만 생긴다. 그림은 먼저 Agent-A 에 올리고(같은 그림은 같은 경로) 그 정보를 싣는다.
   */
  async blockInsert(fileId: string, input: { opId: string; afterId: string | null; kind: AgentABlockKind; title: string; body: string; image?: { name: string; mediaType: string; base64: string } | null; contextRevision?: number | null; layoutRevision?: number | null }): Promise<{ ok: true; blockId: string; artifactRevision: number }> {
    if (!OP.test(input.opId) || (input.afterId !== null && !ANNOTATION.test(input.afterId))) throw new ApiError(400, "요청 id 가 올바르지 않습니다");
    if (!BLOCK_KINDS.includes(input.kind)) throw new ApiError(400, "블록 종류가 올바르지 않습니다");
    const title = input.title.trim();
    if (!title || title.length > 500) throw new ApiError(400, "블록 제목은 1~500자입니다");
    if (input.body.length > 500_000) throw new ApiError(400, "본문이 너무 깁니다");
    if (input.kind !== "image" && !input.body.trim()) throw new ApiError(400, "본문을 적어 주세요");
    if (input.kind === "table") {
      const bad = tableBodyError(input.body);
      if (bad) throw new ApiError(400, bad);
    }
    if (input.kind === "image" ? !input.image : Boolean(input.image)) throw new ApiError(400, input.kind === "image" ? "그림 파일을 골라 주세요" : "그림은 그림 블록에만 넣습니다");
    this.service.docOf(fileId);
    const uploaded = input.kind === "image" ? await this.uploadImage(input.image!) : null;
    const asset = uploaded ? { id: uploaded.id, revision: uploaded.revision, src: uploaded.src, width: uploaded.width, height: uploaded.height } : null;
    const before = await this.service.readState(fileId);
    const blockId = `iamceo-block-${input.opId}`;
    const commandId = `iamceo-review-insert-${input.opId}`;
    const first = ranCommand(before, commandId);
    const state = await this.command(fileId, {
      command_id: commandId,
      type: "insert_block",
      block_id: blockId,
      after_id: input.afterId,
      base_layout_revision: revisionOr(input.layoutRevision, first?.base_layout_revision, before.layout_revision),
      context_revision: revisionOr(input.contextRevision, first?.context_revision, before.context_revision),
      kind: input.kind,
      content: { title, summary: "", body: input.body, sources: [] },
      ...(asset ? { asset } : {}),
    }, "블록을 더하지 못했습니다");
    return { ok: true, blockId, artifactRevision: state.artifact_revision };
  }

  /** 블록의 읽는 순서를 바꾼다. blockIds 는 보관하지 않은 블록 전부의 새 순서다. 본문은 그대로이고 배치 판이 오른다(본문 순서가 달라져 새 판으로 열린다). */
  async blocksReorder(fileId: string, input: { opId: string; blockIds: string[]; layoutRevision: number }): Promise<{ ok: true; layoutRevision: number }> {
    if (!OP.test(input.opId) || !input.blockIds.length || input.blockIds.length > 500 || new Set(input.blockIds).size !== input.blockIds.length || input.blockIds.some((id) => !ANNOTATION.test(id))) throw new ApiError(400, "블록 순서가 올바르지 않습니다");
    if (!Number.isSafeInteger(input.layoutRevision) || input.layoutRevision < 1) throw new ApiError(400, "배치 판이 올바르지 않습니다");
    const state = await this.command(fileId, { command_id: `iamceo-review-order-${input.opId}`, type: "reorder_blocks", block_ids: input.blockIds, base_layout_revision: input.layoutRevision }, "순서를 저장하지 못했습니다", LAYOUT_CONFLICT);
    return { ok: true, layoutRevision: state.layout_revision };
  }

  /** 배치 보드에서 블록 하나의 자리와 크기를 정한다. 본문과 정본 판은 바뀌지 않고 배치 판만 오른다. */
  async layoutSet(fileId: string, input: { opId: string; blockId: string; layout: AgentABlockLayout; layoutRevision: number }): Promise<{ ok: true; layoutRevision: number }> {
    if (!OP.test(input.opId) || !ANNOTATION.test(input.blockId)) throw new ApiError(400, "요청 id 가 올바르지 않습니다");
    if (!Number.isSafeInteger(input.layoutRevision) || input.layoutRevision < 1) throw new ApiError(400, "배치 판이 올바르지 않습니다");
    const l = input.layout;
    const values = [l?.x, l?.y, l?.width, l?.height];
    if (!values.every((n) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 100_000) || l.width <= 0 || l.height <= 0) throw new ApiError(400, "배치 값이 올바르지 않습니다");
    const state = await this.command(fileId, { command_id: `iamceo-review-layout-${input.opId}`, type: "set_layout", block_id: input.blockId, base_layout_revision: input.layoutRevision, layout: { x: l.x, y: l.y, width: l.width, height: l.height } }, "배치를 저장하지 못했습니다", LAYOUT_CONFLICT);
    return { ok: true, layoutRevision: state.layout_revision };
  }

  /** 문서의 목표와 제약을 고친다. 문맥 판과 정본 판이 오른다. 그 전에 나온 수정안은 새 문맥에서 다시 확인해야 한다(Agent-A 규칙). */
  async contextUpdate(fileId: string, input: { opId: string; goal: string; constraints: string[]; contextRevision: number }): Promise<{ ok: true; contextRevision: number; artifactRevision: number }> {
    if (!OP.test(input.opId)) throw new ApiError(400, "요청 id 가 올바르지 않습니다");
    if (!Number.isSafeInteger(input.contextRevision) || input.contextRevision < 1) throw new ApiError(400, "문맥 판이 올바르지 않습니다");
    const goal = input.goal.trim();
    if (!goal || goal.length > 10_000) throw new ApiError(400, "목표는 1~10000자입니다");
    const constraints = input.constraints.map((c) => c.trim()).filter(Boolean);
    if (constraints.length > 100 || constraints.some((c) => c.length > 2_000)) throw new ApiError(400, "제약은 100줄까지, 한 줄에 2000자까지입니다");
    const state = await this.command(fileId, { command_id: `iamceo-review-context-${input.opId}`, type: "update_context", base_context_revision: input.contextRevision, goal, constraints }, "목표와 제약을 저장하지 못했습니다", "그사이 목표와 제약이 바뀌었습니다. 다시 불러온 내용에서 고쳐 주세요");
    return { ok: true, contextRevision: state.context_revision, artifactRevision: state.artifact_revision };
  }
}
