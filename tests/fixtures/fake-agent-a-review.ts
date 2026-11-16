// 가짜 Agent-A(검토 규약). Agent-A c559881 의 src/server/plannotator.js · auto-comments.js · app.js · assets.js 가 하는 일을 흉내 낸다.
// 실제 AI 는 부르지 않는다. 답은 댓글 글에 따라 정해진다:
//   '실패' 가 들어 있으면 답 실패(다시 요청 가능) · '고쳐' 가 들어 있고 고른 글이 한 블록에 한 번 있으면 문서 수정안 · 그 밖에는 '시험 답: <댓글>'.
// 같은 시나리오를 실제 Agent-A 서버 코드로도 돌려 본다(tests/agent-a-review.browser.ts 의 IAMCEO_AGENT_A_REAL_URL).
import { createHash, randomUUID } from "node:crypto";

type Json = Record<string, any>;
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const clone = <T,>(v: T): T => structuredClone(v);
const oneLine = (v: unknown) => String(v ?? "").replace(/[\r\n]+/g, " ");
const ANNOTATION = /^[A-Za-z0-9_-]{1,200}$/;
const answerId = (artifact: string, annotation: string) => `comment-answer-${sha(`${artifact}:${annotation}`).slice(0, 40)}`;

/** Agent-A 의 표시용 본문(src/server/plannotator.js projectArtifact 와 같은 모양). */
export function projectArtifact(state: Json) {
  let markdown = `# ${oneLine(state.title)}\n\n`;
  if (state.goal) markdown += `${state.goal}\n\n`;
  const sourceMap: Json[] = [];
  for (const block of state.blocks.filter((b: Json) => !b.archived)) {
    const start = markdown.length;
    markdown += `## ${oneLine(block.content.title)}\n\n`;
    if (block.content.summary) markdown += `${block.content.summary}\n\n`;
    const bodyStart = markdown.length;
    let body: string = block.content.body;
    if (block.kind === "image") body = `![${oneLine(block.content.title).replace(/\]/g, "\\]")}](${block.asset.src})${body ? `\n\n${body}` : ""}`;
    markdown += `${body}\n\n`;
    sourceMap.push({
      block_id: block.id, revision: block.revision, kind: block.kind, start, end: markdown.length, body_start: bodyStart, body_end: bodyStart + body.length,
      start_line: markdown.slice(0, start).split("\n").length, end_line: markdown.split("\n").length, raw_body: block.content.body, body_identity: block.kind === "markdown",
      ...(block.asset ? { asset: block.asset } : {}),
    });
  }
  return { markdown, markdown_hash: sha(markdown), source_map: sourceMap, context_revision: state.context_revision, layout_revision: state.layout_revision, blocks: sourceMap.map((e) => ({ block_id: e.block_id, revision: e.revision })) };
}

export interface FakeReviewOptions {
  /** 답이 '쓰는 중'으로 머무는 시간(ms). */
  answerDelayMs?: number;
  /** 열쇠 방식(사용자 열쇠가 있어야 받는다). 없으면 이 기기 전용 기본 방식. */
  appToken?: string | null;
  /** 자동 연동(CLI 실행)이 켜진 Agent-A 인지. 기본은 꺼짐(수동 교환만). */
  adapter?: boolean;
  /**
   * 초안 규약 판. 2(기본)는 초안 보존 규약을 넣은 Agent-A(초안 판 머리·조건 저장·댓글 원자 추가),
   * 1 은 원래 Agent-A(c559881): 초안 판이 없고 초안 저장은 늘 통째로 바꾼다.
   */
  draftProtocol?: 1 | 2;
}

export function fakeAgentAReview(options: FakeReviewOptions = {}) {
  const delay = options.answerDelayMs ?? 250;
  const protocol = options.draftProtocol ?? 2;
  const REVISION = "x-enouv-draft-revision";
  const revisionHead = (s: Json): Record<string, string> => (protocol >= 2 ? { [REVISION]: String(s.draft_revision ?? 0) } : {});
  const startedAt = Date.now();
  const artifacts = new Map<string, Json>();
  const sessions: Json[] = [];
  const rows: Json[] = [];
  const assets = new Map<string, { bytes: Uint8Array; type: string; asset: Json }>();
  const receipts = new Map<string, Json>();
  const jobs: Json[] = [];
  /** 문서 대화: 문서마다 대화 여럿, 그중 하나가 '지금 대화'. */
  const chats: Json[] = [];
  const chatAborts = new Map<string, () => void>();
  const calls: { method: string; path: string }[] = [];
  let enabled = true;
  let down = false;
  let seq = 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const fail = (status: number, code: string, message = code) => Response.json({ error: code, code, message }, { status });
  const keyOf = (state: Json) => sha(JSON.stringify(projectArtifact(state)));
  const hasDraft = (d: Json | null) => Boolean(d && (typeof d.editedMarkdown === "string" || (Array.isArray(d.annotations) && d.annotations.length) || (Array.isArray(d.globalAttachments) && d.globalAttachments.length)));
  const recoveries = (artifactId: string, except: string | null, latest: string) =>
    sessions.filter((s) => s.artifact_id === artifactId && s.id !== except && (hasDraft(s.draft) || s.decision)).map((s) => ({
      id: s.id, artifact_id: s.artifact_id, created_at: s.created_at, title: s.title, artifact_revision: s.artifact_revision, stale: s.projection_key !== latest,
      decision: s.decision?.kind ?? null, annotation_count: (s.draft?.annotations ?? []).length, attachment_count: 0, has_edited_markdown: typeof s.draft?.editedMarkdown === "string",
    }));
  const sessionBody = (s: Json) => {
    const latest = keyOf(artifacts.get(s.artifact_id)!);
    return { id: s.id, artifact_id: s.artifact_id, server_session: s.server_session, markdown: s.projection.markdown, markdown_hash: s.projection.markdown_hash,
      context_revision: s.projection.context_revision, layout_revision: s.projection.layout_revision, blocks: s.projection.blocks, source_map: s.projection.source_map,
      image_region_targets: {}, decision: s.decision, draft: s.draft, documents: [], stale: s.projection_key !== latest, recoveries: recoveries(s.artifact_id, s.id, latest),
      ...(protocol >= 2 ? { draft_revision: s.draft_revision ?? 0, capabilities: { draft_protocol: 2 } } : {}) };
  };
  const compatible = (s: Json) => rows.filter((r) => r.artifact_id === s.artifact_id && (r.review_session_id === s.id || (r.projection_key === s.projection_key && r.markdown_hash === s.projection.markdown_hash)));
  const bump = (r: Json) => { r.version++; r.updated_at = Date.now(); };

  function command(state: Json, c: Json): Response {
    if (typeof c.command_id !== "string") return fail(400, "invalid_request");
    const hash = JSON.stringify(c);
    const prior = receipts.get(c.command_id);
    if (prior) return prior.hash === hash ? Response.json(prior.receipt) : fail(409, "idempotency_conflict");
    const block = (id: string) => state.blocks.find((b: Json) => b.id === id);
    let content = false;
    let result: Json = {};
    const branch = (id: string) => state.branches.find((b: Json) => b.id === id);
    const ask = (b: Json, message: string): Json => {
      const id = randomUUID(), feedbackId = randomUUID();
      b.messages.push({ id, role: "user", body: message, question_id: id, decision: "proposed", created_at: new Date().toISOString() });
      b.status = "open";
      state.feedback.push({ id: feedbackId, branch_id: b.id, question_id: id, message, state: "not_sent" });
      return { branch_id: b.id, question_id: id, feedback_id: feedbackId };
    };
    if (c.type === "apply_proposals") {
      // 고른 변경안 전부를 먼저 확인하고, 하나라도 안 되면 아무것도 바꾸지 않는다(원자적 반영).
      const picked = (Array.isArray(c.proposal_ids) ? c.proposal_ids : []).map((id: string) => state.proposals.find((x: Json) => x.id === id));
      if (!picked.length || picked.some((p: Json | undefined) => !p)) return fail(404, "not_found");
      const written = new Set<string>();
      for (const p of picked as Json[]) {
        if (!["pending", "held"].includes(p.status)) return fail(409, "revision_conflict", "Proposal is not applicable");
        for (const op of p.operations) {
          if (block(op.block_id)?.revision !== op.base_revision || written.has(op.block_id)) return fail(409, "revision_conflict", "Block changed");
          written.add(op.block_id);
        }
      }
      for (const p of picked as Json[]) {
        for (const op of p.operations) {
          const b = block(op.block_id);
          b.history.push({ revision: b.revision, content: clone(b.content), archived: false });
          b.revision++;
          b.content = clone(op.content);
        }
        p.status = "applied";
      }
      content = true;
      result = { proposal_ids: c.proposal_ids };
    } else if (c.type === "create_branch") {
      if (typeof c.branch_id !== "string" || typeof c.title !== "string" || typeof c.message !== "string") return fail(400, "invalid_request");
      if (branch(c.branch_id)) return fail(409, "revision_conflict", "Branch ID already exists");
      const parent = c.parent_branch_id ? branch(c.parent_branch_id) : null;
      if (c.parent_branch_id && (!parent || !parent.messages.some((m: Json) => m.id === c.origin_message_id && m.role === "assistant"))) return fail(400, "invalid_request", "Origin must be an assistant message in the parent branch");
      if (!c.parent_branch_id && c.target?.kind === "block" && block(c.target.block_id)?.revision !== c.target.block_revision) return fail(409, "revision_conflict", "Block changed");
      const b = { id: c.branch_id, target: clone(c.target), parent_branch_id: c.parent_branch_id ?? null, origin_message_id: c.origin_message_id ?? null, title: c.title, status: "open", messages: [] as Json[], created_at: new Date().toISOString() };
      state.branches.push(b);
      result = ask(b, c.message);
    } else if (c.type === "add_message") {
      const b = branch(c.branch_id);
      if (!b) return fail(404, "not_found");
      result = ask(b, c.message);
    } else if (c.type === "decide_message") {
      const m = branch(c.branch_id)?.messages.find((x: Json) => x.id === c.message_id);
      if (!m) return fail(404, "not_found");
      if (!["proposed", "accepted", "held", "rejected"].includes(c.decision)) return fail(400, "invalid_request");
      m.decision = c.decision;
      m.reason = c.reason ?? "";
      result = { message_id: m.id, decision: m.decision };
    } else if (c.type === "close_branch") {
      const b = branch(c.branch_id);
      if (!b) return fail(404, "not_found");
      b.status = "closed";
      b.close_reason = c.reason ?? "";
      result = { branch_id: b.id, unresolved: { unanswered: state.feedback.filter((f: Json) => f.branch_id === b.id && f.state !== "succeeded").length,
        open_children: state.branches.filter((x: Json) => x.parent_branch_id === b.id && x.status === "open").length,
        unapplied_proposals: state.proposals.filter((x: Json) => x.branch_id === b.id && ["pending", "held", "conflict"].includes(x.status)).length } };
    } else if (c.type === "decide_proposal") {
      const p = state.proposals.find((x: Json) => x.id === c.proposal_id);
      if (!p) return fail(404, "not_found");
      if (p.status === "applied" || !["held", "rejected"].includes(c.decision)) return fail(409, "revision_conflict");
      p.status = c.decision;
      result = { proposal_id: p.id, status: p.status };
    } else if (c.type === "edit_block" || c.type === "restore_block") {
      const b = block(c.block_id);
      if (!b || b.archived) return fail(404, "not_found");
      if (b.revision !== c.base_revision || state.context_revision !== c.context_revision) return fail(409, "revision_conflict", "Block changed");
      const next = c.type === "edit_block" ? c.content : b.history.find((h: Json) => h.revision === c.history_revision)?.content;
      if (!next) return fail(404, "not_found");
      b.history.push({ revision: b.revision, content: clone(b.content), archived: false });
      b.revision++;
      b.content = clone(next);
      content = true;
      result = { block_id: b.id, revision: b.revision };
    } else return fail(400, "invalid_command");
    if (content) state.artifact_revision++;
    state.event_seq++;
    state.events.push({ seq: state.event_seq, type: c.type, actor_id: "local-user", created_at: new Date().toISOString(), payload: {} });
    const receipt = { command_id: c.command_id, artifact_id: state.id, event_seq: state.event_seq, status: "committed", result };
    receipts.set(c.command_id, { hash, receipt });
    return Response.json(receipt);
  }

  /** 답 하나를 끝낸다(가짜 AI). */
  function finish(r: Json): void {
    if (r.state !== "running" || r.deleted) return;
    const a = r.annotation;
    const state = artifacts.get(r.artifact_id)!;
    const session = sessions.find((s) => s.id === r.review_session_id)!;
    if (String(a.text).includes("실패") && !a.retryOf) {
      r.state = "failed";
      r.error = "시험용 실패입니다.";
      r.error_code = "provider_failed";
    } else if (String(a.text).includes("고쳐") && a.originalText) {
      const hits = session.projection.source_map.filter((e: Json) => e.body_identity && e.raw_body.includes(a.originalText));
      const block = hits.length === 1 ? state.blocks.find((b: Json) => b.id === hits[0].block_id) : null;
      const at = block ? hits[0].raw_body.indexOf(a.originalText) : -1;
      if (block && !block.archived && block.revision === hits[0].revision && hits[0].raw_body.indexOf(a.originalText, at + 1) < 0) {
        const id = randomUUID();
        for (const old of state.proposals.filter((p: Json) => p.root === (a.inReplyTo || a.id) && ["pending", "held"].includes(p.status))) old.status = "rejected";
        state.proposals.push({ id, branch_id: `comment-edit-${sha(r.artifact_id + (a.inReplyTo || a.id)).slice(0, 32)}`, question_id: randomUUID(), root: a.inReplyTo || a.id, annotation_id: answerId(r.artifact_id, a.id),
          reason: "시험용 수정안입니다.", status: "pending", base_artifact_revision: state.artifact_revision, context_revision: state.context_revision,
          read_set: session.projection.blocks.map((b: Json) => ({ block_id: b.block_id, revision: b.revision })),
          operations: [{ op: "replace", block_id: block.id, base_revision: block.revision, content: { ...block.content, body: block.content.body.slice(0, at) + `${a.originalText} (고침)` + block.content.body.slice(at + a.originalText.length) } }] });
        r.answer_text = "수정안을 제안합니다.";
      } else r.answer_text = "고칠 곳을 한 군데로 찾지 못했습니다.";
      r.state = "succeeded";
    } else {
      r.state = "succeeded";
      const ai = a.aiSettings && (a.aiSettings.providerId || a.aiSettings.model) ? ` [${[a.aiSettings.providerId, a.aiSettings.model, a.aiSettings.reasoningEffort].filter(Boolean).join("/")}]` : "";
      r.answer_text = `${a.retryOf ? "다시 답" : "시험 답"}: ${a.text}${ai}`;
    }
    bump(r);
  }
  function pump(): void {
    if (!enabled) return;
    for (const r of rows.filter((x) => x.state === "queued" && !x.deleted)) {
      r.state = "running";
      bump(r);
      const t = setTimeout(() => { timers.delete(t); finish(r); }, delay);
      timers.add(t);
    }
  }
  function addRow(session: Json, annotation: Json, state: "queued" | "ignored"): Json {
    const r = { artifact_id: session.artifact_id, annotation_id: annotation.id, review_session_id: session.id, annotation: clone(annotation), state, answer_text: "", error: null, error_code: null,
      deleted: false, reply_deleted: false, version: 1, created_at: Date.now(), updated_at: Date.now(), order: seq++, projection_key: session.projection_key, markdown_hash: sha(typeof session.draft?.editedMarkdown === "string" ? session.draft.editedMarkdown : session.projection.markdown) };
    rows.push(r);
    return r;
  }
  function replyFor(r: Json, list: Json[]): Json {
    const failed = r.state === "failed";
    let body: string = r.answer_text;
    if (r.state === "queued") body = "현재 답변이 끝나기를 기다리고 있습니다…";
    else if (r.state === "running" && !body) body = "답변을 준비하고 있습니다…";
    const answerText = body;
    const answerError = failed ? { code: r.error_code, message: "답변을 받지 못했습니다. 다시 요청해 주세요." } : null;
    if (answerError) body = `${body ? `${body}\n\n` : ""}${answerError.message} [${answerError.code}]`;
    const retried = list.some((o) => !o.deleted && o.annotation.retryOf === r.annotation_id);
    return { ...r.annotation, id: answerId(r.artifact_id, r.annotation_id), text: body, ...(answerError ? { answerError, answerText, canRetry: enabled && !retried } : {}),
      type: "COMMENT", inReplyTo: r.annotation.id, author: "Codex", isAIReply: true, source: `enouv-auto-answer:${r.annotation.id}`, images: [], createdA: r.created_at + 1 };
  }

  const transport = async (input: string, init: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const path = url.pathname;
    const method = init.method ?? "GET";
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    calls.push({ method, path });
    if (down) throw new TypeError("fetch failed");
    if (options.appToken && headers.authorization !== `Bearer ${options.appToken}` && !(path === "/api/config" && method === "GET")) return fail(401, "unauthorized");
    const body: Json | null = typeof init.body === "string" && init.body ? JSON.parse(init.body) : null;
    const context = (): Json | Response => {
      const s = sessions.find((x) => x.id === headers["x-enouv-review-session"]);
      if (!s) return fail(409, "session_mismatch", "Open an ENOUV review session first.");
      if (headers["x-enouv-artifact"] !== s.artifact_id) return fail(409, "session_mismatch", "This review belongs to another document.");
      return s;
    };

    if (path === "/api/config") return Response.json({ adapter_enabled: options.adapter === true, auth_required: Boolean(options.appToken), mode: "local" });
    const uploaded = /^\/assets\/user\/[a-f0-9]{64}\/1$/.test(path) && method === "GET" ? assets.get(path) : undefined;
    if (/^\/assets\/user\//.test(path) && method === "GET") return uploaded ? new Response(new Blob([uploaded.bytes as BlobPart]), { headers: { "content-type": uploaded.type } }) : Response.json({ error: "not_found" }, { status: 404 });
    // ---- 전송 기록(피드백 묶음) ----
    const jobPath = /^\/api\/jobs\/([^/]+)(\/export|\/run|\/cancel)?$/.exec(path);
    if (jobPath) {
      const job = jobs.find((j) => j.id === decodeURIComponent(jobPath[1]!));
      if (!job) return fail(404, "not_found", "전송 기록이 없습니다.");
      if (!jobPath[2] && method === "GET") return Response.json(clone(job));
      if (jobPath[2] === "/export" && method === "GET") return Response.json({ receipt_id: job.id, packet: clone(job.packet), result_schema: { type: "object", required: ["receipt_id", "answers", "proposals"] }, instructions: "시험용 전송 자료입니다." });
      if (jobPath[2] === "/run" && method === "POST") {
        if (options.adapter !== true) return fail(503, "adapter_disabled", "자동 연동이 꺼져 있습니다. Context Packet을 내보내 수동으로 교환할 수 있습니다.");
        if (job.state !== "queued") return fail(409, "invalid_state", "대기 중인 새 요청만 실행할 수 있습니다.");
        job.state = "running";
        return Response.json(clone(job));
      }
      if (jobPath[2] === "/cancel" && method === "POST") {
        if (job.state !== "running") return fail(409, "request_failed", "현재 서버에서 실행 중인 요청이 아닙니다.");
        job.state = "unknown";
        return Response.json({ id: job.id, state: "unknown" });
      }
    }
    const batch = /^\/api\/artifacts\/([^/]+)\/(jobs|feedback-batches|import-result)$/.exec(path);
    if (batch) {
      const state = artifacts.get(decodeURIComponent(batch[1]!));
      if (!state) return fail(404, "not_found");
      if (batch[2] === "jobs" && method === "GET") return Response.json(jobs.filter((j) => j.artifact_id === state.id).reverse().map((j) => clone(j)));
      if (batch[2] === "feedback-batches" && method === "POST") {
        if (!ANNOTATION.test(body?.idempotency_key ?? "") || !Array.isArray(body?.feedback_ids) || !body.feedback_ids.length) return fail(400, "invalid_request", "전송할 질문과 중복 방지 ID를 확인하세요.");
        const prior = jobs.find((j) => j.idempotency_key === body.idempotency_key);
        if (prior) return prior.artifact_id === state.id && prior.request === JSON.stringify(body) ? Response.json(clone(prior)) : fail(409, "idempotency_conflict", "같은 전송 ID의 내용이 다릅니다.");
        const picked = body.feedback_ids.map((id: string) => state.feedback.find((f: Json) => f.id === id));
        if (picked.some((f: Json | undefined) => !f || f.state !== "not_sent")) return fail(409, "feedback_state", "이미 전송했거나 처리 중인 질문입니다.");
        for (const f of picked) f.state = "queued";
        const job = { id: randomUUID(), artifact_id: state.id, idempotency_key: body.idempotency_key, request: JSON.stringify(body), state: "queued", error: null, attempt: 0, result: null, created_at: new Date().toISOString(),
          packet: { base_artifact_revision: state.artifact_revision, context_revision: state.context_revision, layout_revision: state.layout_revision, ...(body.template ? { template: body.template } : {}),
            selected_feedback: picked.map((f: Json) => ({ feedback_id: f.id, branch_id: f.branch_id, question_id: f.question_id, message: f.message, target: state.branches.find((b: Json) => b.id === f.branch_id)?.target ?? {} })),
            target_snapshots: [], allowed_write_set: [], read_set: state.blocks.map((b: Json) => ({ block_id: b.id, revision: b.revision })) } };
        jobs.push(job);
        return Response.json(clone(job));
      }
      if (batch[2] === "import-result" && method === "POST") {
        const job = jobs.find((j) => j.id === body?.receipt_id && j.artifact_id === state.id);
        if (!job || !Array.isArray(body?.answers) || !Array.isArray(body?.proposals)) return fail(job ? 400 : 404, job ? "invalid_request" : "not_found", job ? "결과 형식과 전송 ID를 확인하세요." : "이 결과물의 전송 기록이 아닙니다.");
        if (job.state === "succeeded") return Response.json({ command_id: `result-${job.id}`, event_seq: state.event_seq, status: "committed", result: {} });
        for (const answer of body.answers) {
          const f = state.feedback.find((x: Json) => x.id === answer.feedback_id && job.packet.selected_feedback.some((s: Json) => s.feedback_id === x.id));
          if (!f) return fail(400, "invalid_request", "전송하지 않은 질문의 답입니다.");
          state.branches.find((b: Json) => b.id === f.branch_id)!.messages.push({ id: randomUUID(), role: "assistant", body: String(answer.body), question_id: f.question_id, decision: "proposed", created_at: new Date().toISOString() });
          f.state = "succeeded";
        }
        job.state = "succeeded";
        job.result = clone(body);
        state.event_seq++;
        state.events.push({ seq: state.event_seq, type: "record_agent_result", actor_id: "adapter-service", created_at: new Date().toISOString(), payload: {} });
        return Response.json({ command_id: `result-${job.id}`, event_seq: state.event_seq, status: "committed", result: {} });
      }
    }
    if (path === "/api/assets" && method === "POST") {
      const bytes = Uint8Array.from(Buffer.from(body!.base64, "base64"));
      const id = sha(body!.base64);
      const asset = { id, revision: 1, src: `/assets/user/${id}/1`, width: body!.width ?? 400, height: body!.height ?? 300 };
      // PNG 머리에서 실제 크기를 읽는다(영역 좌표가 그림 픽셀 기준이라 맞아야 한다)
      if (bytes.length > 24 && bytes[1] === 0x50 && bytes[2] === 0x4e) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        asset.width = view.getUint32(16);
        asset.height = view.getUint32(20);
      }
      assets.set(asset.src, { bytes, type: body!.media_type, asset });
      return Response.json(asset);
    }
    if (path === "/api/artifacts" && method === "POST") {
      const id = body!.id ?? randomUUID();
      const state = { id, title: body!.title, goal: body!.goal ?? "", project_id: body!.project_id ?? null, task_id: body!.task_id ?? null, artifact_revision: 1, context_revision: 1, layout_revision: 1, event_seq: 0,
        blocks: (body!.blocks ?? []).map((b: Json) => ({ id: b.id, revision: 1, kind: b.kind ?? "markdown", archived: false, content: clone(b.content), history: [], ...(b.asset ? { asset: b.asset } : {}) })),
        branches: [], proposals: [], feedback: [], events: [] };
      artifacts.set(id, state);
      return Response.json(clone(state));
    }
    const art = /^\/api\/artifacts\/([^/]+)(\/commands)?$/.exec(path);
    if (art) {
      const state = artifacts.get(decodeURIComponent(art[1]!));
      if (!state) return fail(404, "not_found");
      if (!art[2] && method === "GET") return Response.json(clone(state));
      if (art[2] && method === "POST") return command(state, body!);
    }
    if (path === "/api/plannotator/sessions" && method === "POST") {
      const state = artifacts.get(body!.artifact_id);
      if (!state) return fail(404, "not_found");
      if (body!.resume_session_id !== undefined) {
        const resumed = sessions.find((s) => s.id === body!.resume_session_id && s.artifact_id === state.id);
        return resumed ? Response.json(sessionBody(resumed)) : fail(404, "not_found", "Review session not found for this document.");
      }
      const key = keyOf(state);
      const prior = [...sessions].reverse().find((s) => s.artifact_id === state.id && s.projection_key === key && !s.decision);
      if (prior) return Response.json(sessionBody(prior));
      const session = { id: randomUUID(), artifact_id: state.id, projection_key: key, title: state.title, artifact_revision: state.artifact_revision, server_session: randomUUID(),
        projection: projectArtifact(state), draft: null, draft_generation: 0, draft_revision: 0, decision: null, created_at: new Date().toISOString() };
      sessions.push(session);
      return Response.json(sessionBody(session));
    }

    // ---- 아래는 검토 머리가 있어야 한다 ----
    const s = context();
    if (s instanceof Response) return s;
    const state = artifacts.get(s.artifact_id)!;
    if (path === "/api/plan/revision") return Response.json({ revision: state.artifact_revision });
    if (path === "/api/plan/versions" || path === "/api/plan/version") {
      const versions = [...new Map(sessions.filter((x) => x.artifact_id === s.artifact_id).map((x) => [x.projection_key, x])).values()];
      if (path === "/api/plan/versions") return Response.json({ project: s.artifact_id, slug: s.artifact_id, versions: versions.map((x, i) => ({ version: i + 1, timestamp: x.created_at })) });
      const picked = versions[Number(url.searchParams.get("v")) - 1];
      return picked ? Response.json({ plan: picked.projection.markdown, version: Number(url.searchParams.get("v")) }) : Response.json({ error: "Version not found." }, { status: 404 });
    }
    if (path === "/api/image") {
      const src = url.searchParams.get("path") ?? "";
      const known = s.projection.source_map.some((e: Json) => e.asset?.src === src);
      const asset = known ? assets.get(src) : undefined;
      return asset ? new Response(new Blob([asset.bytes as BlobPart]), { headers: { "content-type": asset.type } }) : Response.json({ error: "Image not found." }, { status: 404 });
    }
    if (path === "/api/draft" && method === "GET") {
      return s.draft ? Response.json({ ...s.draft, draftGeneration: s.draft_generation, documents: [] }, { headers: revisionHead(s) })
        : Response.json({ found: false, draftGeneration: s.draft_generation }, { status: 404, headers: revisionHead(s) });
    }
    const regionOk = (a: Json): boolean => {
      if (a?.imageRegion == null) return true;
      const r = a.imageRegion, b = r.box ?? {};
      return r.v === 1 && [r.naturalWidth, r.naturalHeight, b.x, b.y, b.w, b.h].every(Number.isSafeInteger) && b.x >= 0 && b.y >= 0 && b.w > 0 && b.h > 0 && b.x + b.w <= r.naturalWidth && b.y + b.h <= r.naturalHeight
        && s.projection.source_map.filter((e: Json) => e.kind === "image" && e.asset?.src === r.src).length >= 1;
    };
    /** 초안이 저장된 뒤: 새 댓글만 답을 시작한다(원래 Agent-A 의 onDraftSaved 와 같다). 빠진 댓글은 지우지 않는다. */
    const afterSaved = (previous: Set<string>, annotations: Json[]): void => {
      for (const a of annotations) {
        if (!a || !ANNOTATION.test(a.id ?? "") || !["COMMENT", "GLOBAL_COMMENT", "DELETION"].includes(a.type) || typeof a.originalText !== "string") continue;
        if (rows.some((r) => r.artifact_id === s.artifact_id && r.annotation_id === a.id)) continue;
        const live = ["COMMENT", "GLOBAL_COMMENT"].includes(a.type) && !a.source && typeof a.text === "string" && a.text.trim();
        const recent = Number.isFinite(a.createdA) && a.createdA >= startedAt - 1000 && a.createdA <= Date.now() + 60_000;
        addRow(s, a, enabled && live && recent && !previous.has(a.id) ? "queued" : "ignored");
      }
      queueMicrotask(pump);
    };
    if (path === "/api/draft/annotations" && method === "POST") {
      // 원래 Agent-A 에는 이 길이 없다(Fastify 의 없는 길 응답).
      if (protocol < 2) return Response.json({ message: "Route POST:/api/draft/annotations not found", error: "Not Found", statusCode: 404 }, { status: 404 });
      const a = body && typeof body.annotation === "object" && body.annotation && !Array.isArray(body.annotation) ? clone(body.annotation) : null;
      if (!a || Object.keys(body!).some((k) => k !== "annotation") || !ANNOTATION.test(a.id ?? "") || !["COMMENT", "GLOBAL_COMMENT", "DELETION"].includes(a.type) || a.source !== undefined || a.inReplyTo !== undefined
        || typeof a.originalText !== "string" || (a.type !== "DELETION" && !(typeof a.text === "string" && a.text.trim()))) return fail(400, "invalid_request", "Invalid annotation.");
      const draft = s.draft ?? { annotations: [], globalAttachments: [] };
      const stored: Json[] = Array.isArray(draft.annotations) ? draft.annotations : [];
      const same = (x: Json) => JSON.stringify([x.type, x.text ?? "", x.originalText ?? "", x.imageRegion ?? null, x.images ?? [], x.aiSettings ?? null]);
      const prior = stored.find((x) => x?.id === a.id) ?? rows.find((r) => r.artifact_id === s.artifact_id && r.annotation_id === a.id)?.annotation;
      if (prior) return same(prior) === same(a) ? Response.json({ ok: true, id: a.id, duplicate: true, draftRevision: s.draft_revision }) : fail(409, "idempotency_conflict", "This comment ID was already used for different content.");
      if (s.decision) return Response.json({ ok: false, decided: true, draftGeneration: s.draft_generation, draftRevision: s.draft_revision }, { status: 409 });
      if (s.projection_key !== keyOf(state)) return fail(409, "revision_conflict", "The document changed.");
      if (!regionOk(a)) return fail(400, "invalid_image_region", "The image rectangle must lie inside the original image.");
      a.createdA = Date.now();
      const previous = new Set(stored.map((x) => x.id));
      s.draft = { ...draft, annotations: [...stored, a], globalAttachments: Array.isArray(draft.globalAttachments) ? draft.globalAttachments : [] };
      s.draft_revision = (s.draft_revision ?? 0) + 1;
      afterSaved(previous, s.draft.annotations);
      return Response.json({ ok: true, id: a.id, draftRevision: s.draft_revision });
    }
    if (path === "/api/draft" && method === "POST") {
      if (!body || !Array.isArray(body.annotations)) return fail(400, "invalid_request", "Invalid annotation draft.");
      if (s.decision) return Response.json({ ok: false, decided: true, draftGeneration: s.draft_generation }, { status: 409 });
      const generation = body.draftGeneration ?? 0;
      if (generation < s.draft_generation) return Response.json({ ok: false, draftGeneration: s.draft_generation }, { status: 409 });
      // 조건 저장(초안 규약 2): 읽은 뒤 다른 화면이 저장했으면 아무것도 바꾸지 않고 거절한다. 원래 Agent-A 는 이 칸을 모른다(늘 통째로 바꾼다).
      if (protocol >= 2 && body.ifDraftRevision !== undefined && body.ifDraftRevision !== (s.draft_revision ?? 0))
        return Response.json({ ok: false, code: "draft_conflict", draftGeneration: s.draft_generation, draftRevision: s.draft_revision ?? 0 }, { status: 409 });
      for (const a of body.annotations) if (!regionOk(a)) return fail(400, "invalid_image_region", "The image rectangle must lie inside the original image.");
      const previous = new Set<string>((s.draft?.annotations ?? []).map((a: Json) => a.id));
      s.draft = clone(body);
      delete s.draft.documents;
      if (protocol >= 2) { delete s.draft.ifDraftRevision; delete s.draft.draftRevision; }
      s.draft_generation = generation;
      s.draft_revision = (s.draft_revision ?? 0) + 1;
      afterSaved(previous, body.annotations);
      return Response.json({ ok: true }, { headers: revisionHead(s) });
    }
    // ---- 검토 제출(원래 화면 머리의 Save) ----
    if (path === "/api/feedback" && method === "POST") {
      if (!body || typeof body !== "object" || (body.annotations !== undefined && !Array.isArray(body.annotations))) return fail(400, "invalid_request", "Invalid feedback body.");
      if (body.serverSession !== s.server_session) return fail(409, "session_mismatch", "This tab belongs to a different review session.");
      const annotations: Json[] = body.annotations ?? [];
      const ids = new Set<string>();
      for (const a of annotations) {
        if (!a || !ANNOTATION.test(a.id ?? "") || ids.has(a.id) || !["COMMENT", "GLOBAL_COMMENT", "DELETION"].includes(a.type)) return fail(400, "invalid_request", "Invalid or duplicate annotation.");
        ids.add(a.id);
      }
      const requestHash = JSON.stringify(["feedback", body.feedback ?? "", annotations, body.nothingToSend === true]);
      if (s.decision) return s.decision.request_hash === requestHash ? Response.json(s.decision.response) : fail(409, "already_decided", "This review was already submitted.");
      if (protocol >= 2 && body.ifDraftRevision !== undefined && body.ifDraftRevision !== (s.draft_revision ?? 0))
        return Response.json({ ok: false, code: "draft_conflict", draftGeneration: s.draft_generation, draftRevision: s.draft_revision ?? 0 }, { status: 409 });
      if (s.projection_key !== keyOf(state)) {
        s.draft = { ...(s.draft ?? { globalAttachments: [] }), ...(body.annotations !== undefined ? { annotations: clone(annotations) } : {}) };
        s.draft_revision = (s.draft_revision ?? 0) + 1;
        return Response.json({ ok: false, code: "revision_conflict", error: "The document changed.", message: "The document changed.", draft_preserved: true, session_id: s.id }, { status: 409 });
      }
      const feedbackIds: string[] = [], branchIds: string[] = [];
      const first = state.blocks.find((b: Json) => !b.archived);
      const open = (title: string, message: string, quote: string) => {
        const hit = quote ? state.blocks.find((b: Json) => !b.archived && String(b.content.body).includes(quote)) : null;
        const b = { id: `pln-${sha(s.id + title + message).slice(0, 40)}`, target: { kind: "block", block_id: (hit ?? first)?.id, block_revision: (hit ?? first)?.revision }, parent_branch_id: null, origin_message_id: null,
          title: title.slice(0, 200) || "Document feedback", status: "open", messages: [] as Json[], created_at: new Date().toISOString() };
        const id = randomUUID(), feedbackId = randomUUID();
        b.messages.push({ id, role: "user", body: message, question_id: id, decision: "proposed", created_at: b.created_at });
        state.branches.push(b);
        state.feedback.push({ id: feedbackId, branch_id: b.id, question_id: id, message, state: "not_sent" });
        feedbackIds.push(feedbackId);
        branchIds.push(b.id);
      };
      for (const a of annotations) {
        let message = typeof a.text === "string" ? a.text.trim() : "";
        if (a.type === "DELETION") message = `Delete the selected content.${message ? `\n\n${message}` : ""}`;
        if (a.originalText) message += `${message ? "\n\n" : ""}Selected text:\n${a.originalText}`;
        open(oneLine(a.text ?? a.originalText ?? "Document feedback"), message || "Review this selected block.", a.type === "GLOBAL_COMMENT" ? "" : String(a.originalText ?? ""));
      }
      if (String(body.feedback ?? "").trim() && !body.nothingToSend) open("[Full native feedback]", `[Full native feedback; includes comments also stored individually.]\n\n${body.feedback}`, "");
      state.event_seq++;
      state.events.push({ seq: state.event_seq, type: "create_branch", actor_id: "local-user", created_at: new Date().toISOString(), payload: {} });
      const response = { ok: true, session_id: s.id, artifact_id: s.artifact_id, decision: body.nothingToSend ? "done" : "feedback", canonical_changed: false, draft_preserved: Boolean(s.draft), feedback_ids: feedbackIds, branch_ids: [...new Set(branchIds)] };
      s.decision = { kind: response.decision, created_at: new Date().toISOString(), request_hash: requestHash, original_payload: clone(body), response };
      s.submitted_draft = s.draft;
      s.draft = null;
      s.draft_generation++;
      s.draft_revision = (s.draft_revision ?? 0) + 1;
      return Response.json(response);
    }
    // ---- 문서 대화(Ask AI) ----
    if (path.startsWith("/api/ai/")) {
      const catalog = { available: true, defaultProvider: "codex-sdk", providers: [
        { id: "codex-sdk", name: "Codex", models: [{ id: "test-model", label: "Test model", default: true, reasoningEfforts: [{ id: "low", label: "Low" }, { id: "high", label: "High" }], defaultReasoningEffort: "low" }, { id: "test-mini", label: "Test mini" }] },
        { id: "claude-agent-sdk", name: "Claude", models: [{ id: "claude-test", label: "Claude test", default: true }] }] };
      if (path === "/api/ai/capabilities") return Response.json(enabled ? catalog : { available: false, providers: [], defaultProvider: null });
      const mine = () => chats.filter((c) => c.artifact_id === s.artifact_id);
      const current = (): Json => {
        let c = mine().find((x) => x.current);
        if (!c) {
          c = { id: randomUUID(), artifact_id: s.artifact_id, current: true, entries: [] as Json[], settings: {}, origin: null, created_at: Date.now(), updated_at: Date.now(), active: false };
          chats.push(c);
        }
        return c;
      };
      const history = (c: Json) => ({ conversationId: c.id, entries: clone(c.entries), origin: c.origin });
      if (path === "/api/ai/history" && method === "GET") {
        const id = url.searchParams.get("conversationId");
        const c = id ? mine().find((x) => x.id === id) : current();
        return c ? Response.json(history(c)) : fail(404, "chat_not_found", "This conversation does not belong to the open document.");
      }
      if (path === "/api/ai/sessions" && method === "GET") return Response.json(mine().map((c) => ({ sessionId: c.id, mode: "annotate", parentSessionId: null, origin: c.origin, createdAt: c.created_at, lastActiveAt: c.updated_at, isActive: c.active, current: c.current, label: c.entries[0]?.question.prompt.slice(0, 80) })));
      if (!enabled) return fail(409, "chat_disabled", "AI 답변이 비활성화되어 있습니다.");
      if (path === "/api/ai/new" && method === "POST") {
        const live = current();
        if (live.active) return fail(409, "chat_busy", "Stop the current answer before starting a new conversation.");
        live.current = false;
        const c = { id: randomUUID(), artifact_id: s.artifact_id, current: true, entries: [] as Json[], settings: {}, origin: null, created_at: Date.now(), updated_at: Date.now(), active: false };
        chats.push(c);
        return Response.json({ conversationId: c.id, entries: [] });
      }
      if (path === "/api/ai/select" && method === "POST") {
        const c = mine().find((x) => x.id === body?.conversationId), live = current();
        if (!c) return fail(404, "chat_not_found", "This conversation does not belong to the open document.");
        if (live.active || c.active) return fail(409, "chat_busy", "Stop the current answer before switching conversations.");
        live.current = false;
        c.current = true;
        return Response.json(history(c));
      }
      if (path === "/api/ai/session" && method === "POST") {
        const c = current();
        if (c.active) return fail(409, "chat_busy", "This document is already answering a question.");
        const provider = catalog.providers.find((p) => p.id === (body?.providerId || c.settings.providerId || catalog.defaultProvider));
        const model = provider?.models.find((m) => m.id === (body?.model || provider.models.find((x) => x.default)?.id));
        if (!provider || !model) return fail(400, "invalid_chat_request", "선택한 플랫폼/모델을 사용할 수 없습니다. 모델을 다시 선택해 주세요.");
        if (body?.providerId || body?.model || body?.reasoningEffort) c.settings = { providerId: provider.id, model: model.id, ...(body.reasoningEffort ? { reasoningEffort: body.reasoningEffort } : {}) };
        return Response.json({ sessionId: c.id, parentSessionId: null, mode: "annotate", createdAt: c.created_at });
      }
      if (path === "/api/ai/abort" && method === "POST") {
        chatAborts.get(body?.sessionId)?.();
        return Response.json({ ok: true });
      }
      if (path === "/api/ai/query" && method === "POST") {
        const c = mine().find((x) => x.id === body?.sessionId);
        if (!c) return fail(404, "chat_not_found", "This conversation does not belong to the open document.");
        if (!c.current) return fail(409, "chat_archived", "Select this conversation before continuing it.");
        if (c.active) return fail(409, "chat_busy", "This document is already answering a question.");
        const question = { id: body.displayQuestion?.id ?? randomUUID(), prompt: body.displayQuestion?.prompt ?? body.prompt, createdAt: Date.now(), ...(body.displayQuestion?.scope ? { scope: body.displayQuestion.scope } : {}) };
        if (c.entries.some((e: Json) => e.question.id === question.id)) return fail(409, "duplicate_question", "This question was already submitted.");
        const entry = { question, response: { questionId: question.id, text: "", providerId: c.settings.providerId ?? "codex-sdk", isStreaming: true, createdAt: Date.now() } as Json };
        c.entries.push(entry);
        c.active = true;
        const tag = c.settings.model ? ` [${c.settings.providerId}/${c.settings.model}${c.settings.reasoningEffort ? `/${c.settings.reasoningEffort}` : ""}]` : "";
        const full = `문서 답: ${question.prompt}${tag}`;
        const pieces = [full.slice(0, Math.ceil(full.length / 2)), full.slice(Math.ceil(full.length / 2))];
        const encoder = new TextEncoder();
        const packet = (v: Json | string) => encoder.encode(`data: ${typeof v === "string" ? v : JSON.stringify(v)}\n\n`);
        let aborted = false;
        const wait = (ms: number) => new Promise<void>((resolve) => { const t = setTimeout(() => { timers.delete(t); resolve(); }, ms); timers.add(t); });
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            chatAborts.set(c.id, () => { aborted = true; });
            const end = (error?: { message: string; code: string }) => {
              if (error) { entry.response.error = error.message; entry.response.errorCode = error.code; controller.enqueue(packet({ type: "error", error: error.message, code: error.code })); }
              entry.response.isStreaming = false;
              c.active = false;
              c.updated_at = Date.now();
              chatAborts.delete(c.id);
              controller.enqueue(packet({ type: "result", sessionId: c.id, success: !error, result: entry.response.text }));
              controller.enqueue(packet("[DONE]"));
              controller.close();
            };
            await wait(delay);
            if (String(question.prompt).includes("실패")) return end({ message: "답변을 받지 못했습니다. 다시 요청해 주세요.", code: "provider_failed" });
            for (const piece of pieces) {
              if (aborted) return end({ message: "This answer was stopped before it finished.", code: "aborted" });
              entry.response.text += piece;
              controller.enqueue(packet({ type: "text_delta", delta: piece }));
              await wait(delay);
            }
            end();
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      }
      return fail(404, "not_found", "요청한 경로가 없습니다.");
    }
    if (path === "/api/external-annotations" && method === "GET") {
      const all = rows.filter((r) => r.artifact_id === s.artifact_id).sort((a, b) => a.order - b.order);
      const list = compatible(s).sort((a, b) => a.order - b.order);
      const version = parseInt(sha(JSON.stringify(all.map((r) => [r.annotation_id, r.version]))).slice(0, 12), 16);
      if (url.searchParams.has("since") && Number(url.searchParams.get("since")) === version) return new Response(null, { status: 304 });
      return Response.json({ artifact_id: s.artifact_id, version, deleted_ids: all.filter((r) => r.deleted).map((r) => r.annotation_id),
        annotations: list.filter((r) => !r.deleted).flatMap((r) => [{ ...r.annotation, source: `enouv-comment:${r.annotation_id}`, updatedAt: r.updated_at }, ...(r.state === "ignored" || r.reply_deleted ? [] : [replyFor(r, list)])]),
        historical: all.filter((r) => !r.deleted && !list.includes(r)).map((r) => ({ annotation_id: r.annotation_id, review_session_id: r.review_session_id })) });
    }
    if (path === "/api/external-annotations" && method === "POST") {
      if (!enabled) return fail(409, "invalid_comment_answer", "AI 답변이 비활성화되어 있습니다.");
      if (!body || typeof body.inReplyTo !== "string" || typeof body.text !== "string" || !body.text.trim()) return fail(400, "invalid_comment_answer", "대댓글 본문과 스레드를 확인해 주세요.");
      const root = compatible(s).find((r) => r.annotation_id === body.inReplyTo && !r.deleted);
      if (!root || root.annotation.inReplyTo) return fail(404, "invalid_comment_answer", "원래 댓글을 찾지 못했습니다.");
      if (body.settings !== undefined && (typeof body.settings !== "object" || !body.settings || Object.entries(body.settings).some(([k, v]) => !["providerId", "model", "reasoningEffort"].includes(k) || typeof v !== "string"))) return fail(400, "invalid_comment_answer", "AI 설정을 확인해 주세요.");
      const annotation = { ...root.annotation, id: randomUUID(), inReplyTo: root.annotation_id, text: body.text.trim(), createdA: Date.now(), author: "local-user", aiSettings: body.settings };
      const session = sessions.find((x) => x.id === root.review_session_id)!;
      addRow(session, annotation, "queued");
      queueMicrotask(pump);
      return Response.json({ id: annotation.id });
    }
    const id = url.searchParams.get("id");
    const find = (wanted: string | null) => compatible(s).find((r) => !r.deleted && (r.annotation_id === wanted || answerId(r.artifact_id, r.annotation_id) === wanted));
    if (path === "/api/external-annotations" && method === "PATCH") {
      const r = find(id);
      if (!r) return fail(404, "invalid_comment_answer", "이 댓글을 찾지 못했습니다.");
      if (r.annotation_id === id) r.annotation = { ...r.annotation, ...(body?.text !== undefined ? { text: body.text } : {}), ...(body?.resolved !== undefined ? { resolved: body.resolved } : {}) };
      else r.answer_text = body?.text ?? r.answer_text;
      bump(r);
      return Response.json({ ok: true });
    }
    if (path === "/api/external-annotations" && method === "DELETE") {
      const r = find(id);
      if (r) {
        if (r.annotation_id === id) r.deleted = true;
        else r.reply_deleted = true;
        bump(r);
      }
      return Response.json({ ok: true });
    }
    if (path === "/api/external-annotations/retry" && method === "POST") {
      const list = compatible(s);
      const r = list.find((x) => !x.deleted && answerId(x.artifact_id, x.annotation_id) === body?.annotation_id);
      if (!r) return fail(404, "invalid_comment_answer", "다시 요청할 댓글을 찾지 못했습니다.");
      if (r.state !== "failed" || !enabled) return fail(409, "invalid_comment_answer", "실패한 답변만 다시 요청할 수 있습니다.");
      const existing = list.find((o) => !o.deleted && o.annotation.retryOf === r.annotation_id);
      if (existing) return Response.json({ id: existing.annotation_id });
      const annotation = { ...r.annotation, id: randomUUID(), inReplyTo: r.annotation.inReplyTo || r.annotation.id, retryOf: r.annotation.id, createdA: Date.now() };
      addRow(sessions.find((x) => x.id === r.review_session_id)!, annotation, "queued");
      queueMicrotask(pump);
      return Response.json({ id: annotation.id });
    }
    if (path === "/api/external-annotations/fork" && method === "POST") {
      const r = compatible(s).find((x) => x.annotation_id === body?.annotation_id && !x.deleted);
      if (!r) return fail(404, "invalid_comment_answer", "원래 댓글을 찾지 못했습니다.");
      const thread = compatible(s).filter((x) => !x.deleted && (x.annotation_id === r.annotation_id || x.annotation.inReplyTo === r.annotation_id));
      if (thread.some((x) => ["queued", "running"].includes(x.state))) return fail(409, "invalid_comment_answer", "댓글 답변이 끝난 뒤 분기해 주세요.");
      const title = String(r.annotation.text ?? "").split("\n")[0]!.trim();
      const annotation = { ...r.annotation, id: randomUUID(), text: `--분기-- ${title}`, createdA: Date.now(), branchOrigin: { annotationId: r.annotation_id, title } };
      delete annotation.inReplyTo;
      delete annotation.resolved;
      addRow(sessions.find((x) => x.id === r.review_session_id)!, annotation, "ignored");
      return Response.json({ id: annotation.id });
    }
    if (path === "/api/plannotator/comment-proposals" || path === "/api/plannotator/comment-proposals/approve") {
      const currentMarkdown = projectArtifact(state).markdown;
      const list = state.proposals.map((p: Json) => {
        const isCurrent = p.status === "applied" && p.operations.every((op: Json) => JSON.stringify(state.blocks.find((b: Json) => b.id === op.block_id)?.content) === JSON.stringify(op.content));
        return { annotation_id: p.annotation_id, proposal_id: p.id, status: p.status, display_confirmed: isCurrent, display_markdown: p.status === "applied" ? currentMarkdown : undefined, reason: p.reason,
          operations: p.operations.map((op: Json) => {
            const b = state.blocks.find((x: Json) => x.id === op.block_id);
            return { ...op, before: b?.revision === op.base_revision ? b.content : b?.history.find((h: Json) => h.revision === op.base_revision)?.content };
          }) };
      });
      if (method === "GET") return Response.json({ proposals: list });
      const p = list.find((x: Json) => x.annotation_id === body?.annotation_id && x.proposal_id === body?.proposal_id);
      if (!p) return fail(404, "not_found", "이 댓글에 연결된 수정안이 없습니다.");
      if (p.status === "applied") return Response.json({ ok: true, status: "applied", proposal_id: p.proposal_id });
      const res = command(state, { type: "apply_proposals", command_id: randomUUID(), proposal_ids: [p.proposal_id] });
      return res.status === 200 ? Response.json({ ok: true, status: "applied", proposal_id: p.proposal_id, receipt: await res.json() }) : res;
    }
    return fail(404, "not_found", "요청한 경로가 없습니다.");
  };

  return {
    transport,
    calls,
    artifacts,
    sessions,
    rows,
    jobs,
    chats,
    /** AI 답을 끄면 새 댓글은 답 없이 저장되고 답글은 거절된다. */
    setEnabled(v: boolean) { enabled = v; },
    setDown(v: boolean) { down = v; },
    /** 쓰는 중인 답을 지금 끝낸다. */
    flush() {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      for (const r of rows) {
        if (r.state === "queued") { r.state = "running"; bump(r); }
        finish(r);
      }
    },
    stop() {
      for (const t of timers) clearTimeout(t);
      timers.clear();
    },
  };
}
