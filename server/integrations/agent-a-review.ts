// Agent-A 검토 길: IAMCEO 화면 부품(댓글·답글·전체 댓글·그림 영역·수정안·판·문서 관리)이 쓰는 서버 쪽.
// - 화면은 Agent-A 를 직접 부르지 않는다. 이 서버가 Agent-A 원래 화면과 같은 검토 규약(검토 세션·초안·댓글·수정안·판)을 대신 부른다.
//   그래서 Agent-A 앱을 통째로 칸(iframe)에 넣지 않아도 같은 정본·댓글·답·수정안을 쓴다(계약 근거: Agent-A c559881 의
//   src/server/plannotator.js · auto-comments.js · app.js).
// - Agent-A 가 준 모양을 그대로 넘기지 않는다. 화면이 쓰는 칸만 골라 shared/agent-a.ts 의 모양으로 옮긴다.
// - 댓글은 원래 화면과 똑같이 '검토 초안에 주석을 더해 저장'하는 길로 만든다(그때 Agent-A 가 답을 시작한다).
//   있던 초안(다른 주석·직접 편집·첨부)은 그대로 다시 싣는다. 지우거나 덮지 않는다.
// - 열쇠·Agent-A 주소는 이 서버 프로세스에만 있다.
import { ApiError } from "../store.ts";
import { AgentAError, proposalView, verifyApplied, versionsOf, type AgentAService, type AState } from "./agent-a.ts";
import type {
  AgentABlock,
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
  };
}

const STATUSES: AgentAProposalStatus[] = ["pending", "held", "rejected", "applied", "conflict"];
const bodyOf = (content: unknown): string | null => {
  if (!obj(content)) return null;
  return [str(content.summary), str(content.body)].filter(Boolean).join("\n\n");
};

export class AgentAReview {
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

  private async call(fileId: string, sessionId: string | null, method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
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
      artifactRevision,
      images,
      closed: Boolean(s.decision),
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
   * 새 댓글(문장·전체·그림 영역). 원래 화면과 같은 길: 검토 초안에 주석 하나를 더해 저장한다. 그때 Agent-A 가 답을 시작한다.
   * 있던 초안은 그대로 다시 싣는다. 같은 id 를 다시 보내면 댓글을 또 만들지 않는다.
   */
  async addComment(fileId: string, sessionId: string, req: AgentAReviewCommentReq): Promise<AgentAReviewWriteResult> {
    const sid = this.session(sessionId);
    if (!ANNOTATION.test(req.id)) throw new ApiError(400, "댓글 id 가 올바르지 않습니다");
    const text = req.text.trim();
    const quote = req.kind === "global" ? "" : (req.quote ?? "");
    if (!text || text.length > MAX_TEXT) throw new ApiError(400, "댓글은 1~30000자입니다");
    if (quote.length > MAX_QUOTE) throw new ApiError(400, "고른 글이 너무 깁니다");
    let region: AgentAReviewImageRegion | null = null;
    if (req.region != null) {
      region = parseRegion(req.region);
      if (!region || !REVIEW_ASSET.test(region.src)) throw new ApiError(400, KNOWN.invalid_image_region!, "AGENT_A_INVALID_IMAGE_REGION");
    }
    return this.serial(`draft:${sid}`, async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const cur = await this.call(fileId, sid, "GET", "/api/draft");
        if (cur.status !== 200 && cur.status !== 404) refuse(cur.status, cur.json, "초안을 읽지 못했습니다");
        const got = obj(cur.json) ? cur.json : {};
        const generation = num(got.draftGeneration) ?? 0;
        // 있던 초안의 모든 칸을 그대로 싣는다(직접 편집·첨부 포함). 문서별 초안(documents)은 Agent-A 가 따로 들고 있어 싣지 않는다.
        const { draftGeneration: _g, documents: _d, found: _f, ...kept } = cur.status === 200 ? got : {};
        const annotations = Array.isArray(kept.annotations) ? [...kept.annotations] : [];
        if (annotations.some((a) => obj(a) && a.id === req.id)) return { ok: true as const, id: req.id };
        annotations.push({
          id: req.id,
          blockId: "",
          startOffset: 0,
          endOffset: 0,
          type: req.kind === "global" ? "GLOBAL_COMMENT" : "COMMENT",
          text,
          originalText: quote,
          createdA: this.now(),
          ...(region ? { imageRegion: region } : {}),
        });
        const saved = await this.call(fileId, sid, "POST", "/api/draft", { ...kept, annotations, globalAttachments: Array.isArray(kept.globalAttachments) ? kept.globalAttachments : [], draftGeneration: generation });
        if (saved.status === 200) return { ok: true as const, id: req.id };
        if (saved.status === 409 && obj(saved.json) && saved.json.decided === true) throw new ApiError(409, KNOWN.already_decided!, "AGENT_A_ALREADY_DECIDED");
        // 그사이 다른 화면이 초안을 저장했다(세대가 앞섰다). 새 초안을 다시 읽어 한 번만 더 해 본다.
        if (saved.status === 409 && obj(saved.json) && saved.json.code === undefined && attempt === 0) continue;
        refuse(saved.status, saved.json, "댓글을 저장하지 못했습니다");
      }
      throw new ApiError(409, "그사이 다른 화면이 초안을 저장했습니다. 잠시 뒤 다시 보내 주세요", "AGENT_A_DRAFT_BUSY");
    });
  }

  /** 대댓글. 첫 댓글 id 에 단다. Agent-A 가 같은 대화로 답한다. */
  async reply(fileId: string, sessionId: string, input: { inReplyTo: string; text: string }): Promise<AgentAReviewWriteResult> {
    const text = input.text.trim();
    if (!ANNOTATION.test(input.inReplyTo)) throw new ApiError(400, "댓글 id 가 올바르지 않습니다");
    if (!text || text.length > MAX_TEXT) throw new ApiError(400, "답글은 1~30000자입니다");
    const r = await this.ok(fileId, this.session(sessionId), "POST", "/api/external-annotations", { inReplyTo: input.inReplyTo, text }, "답글을 저장하지 못했습니다");
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

  // ---- 문서 관리 ----

  async manage(fileId: string): Promise<AgentAReviewManage> {
    const doc = this.service.docOf(fileId);
    const state = await this.service.readState(fileId);
    const titleOf = (blockId: string, fallback: string | null) => state.blocks.find((b) => b.id === blockId)?.content.title ?? fallback ?? blockId;
    return {
      artifactRevision: state.artifact_revision,
      blocks: state.blocks.map((b): AgentABlock => ({
        id: b.id,
        revision: b.revision,
        kind: b.kind,
        title: b.content.title,
        body: b.content.body,
        archived: b.archived,
        history: b.history.map((h) => ({ revision: h.revision, title: h.content.title, body: h.content.body, archived: h.archived })),
      })),
      proposals: state.proposals.map((p) => {
        const view = proposalView(p, state);
        return { ...view, operations: view.operations.map((op) => ({ ...op, blockTitle: titleOf(op.blockId, op.title) })) };
      }),
      versions: versionsOf(state, doc.createdAt),
    };
  }

  private async command(fileId: string, command: Record<string, unknown>, fallback: string): Promise<AState> {
    const doc = this.service.docOf(fileId);
    try {
      await this.service.client.command(doc.artifactId, command);
    } catch (e) {
      if (!(e instanceof AgentAError)) throw e;
      if (e.outcomeUnknown) throw new ApiError(502, "Agent-A 응답을 받지 못했습니다. 다시 누르면 같은 요청으로 결과를 확인합니다", "AGENT_A_UNKNOWN");
      if (e.kind === "conflict") throw new ApiError(409, e.code === "idempotency_conflict" ? "같은 요청 id 로 다른 내용을 보냈습니다" : KNOWN.revision_conflict!, "AGENT_A_REVISION_CONFLICT");
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

  /** 블록의 이전 판 내용을 새 판으로 되살린다. 기준 판은 서버가 지금 정본에서 읽는다(그사이 바뀌면 Agent-A 가 거절한다). */
  async restore(fileId: string, input: { blockId: string; revision: number; historyRevision: number; opId: string }): Promise<{ ok: true; artifactRevision: number }> {
    if (!ANNOTATION.test(input.blockId) || !OP.test(input.opId)) throw new ApiError(400, "요청 id 가 올바르지 않습니다");
    const before = await this.service.readState(fileId);
    const block = before.blocks.find((b) => b.id === input.blockId);
    if (!block || !block.history.some((h) => h.revision === input.historyRevision)) throw new ApiError(404, "그 판을 찾지 못했습니다");
    if (block.revision !== input.revision) throw new ApiError(409, KNOWN.revision_conflict!, "AGENT_A_REVISION_CONFLICT");
    const state = await this.command(fileId, {
      command_id: `iamceo-review-restore-${input.opId}`,
      type: "restore_block",
      block_id: block.id,
      base_revision: block.revision,
      history_revision: input.historyRevision,
      context_revision: before.context_revision,
      base_layout_revision: before.layout_revision,
    }, "이전 판을 되살리지 못했습니다");
    return { ok: true, artifactRevision: state.artifact_revision };
  }

  /** 블록 제목·본문을 직접 고쳐 정본에 저장한다. 요약·출처는 그대로 둔다. 화면이 본 판(revision)과 다르면 거절한다. */
  async edit(fileId: string, input: { blockId: string; revision: number; title: string; body: string; opId: string }): Promise<{ ok: true; artifactRevision: number }> {
    if (!ANNOTATION.test(input.blockId) || !OP.test(input.opId)) throw new ApiError(400, "요청 id 가 올바르지 않습니다");
    const title = input.title.trim();
    if (!title || title.length > 500 || input.body.length > 500_000) throw new ApiError(400, "제목이 비었거나 본문이 너무 깁니다");
    const before = await this.service.readState(fileId);
    const block = before.blocks.find((b) => b.id === input.blockId);
    if (!block || block.archived) throw new ApiError(404, "그 블록을 찾지 못했습니다");
    if (block.revision !== input.revision) throw new ApiError(409, KNOWN.revision_conflict!, "AGENT_A_REVISION_CONFLICT");
    const state = await this.command(fileId, {
      command_id: `iamceo-review-edit-${input.opId}`,
      type: "edit_block",
      block_id: block.id,
      base_revision: block.revision,
      context_revision: before.context_revision,
      content: { ...block.content, title, body: input.body },
    }, "정본을 저장하지 못했습니다");
    return { ok: true, artifactRevision: state.artifact_revision };
  }
}
