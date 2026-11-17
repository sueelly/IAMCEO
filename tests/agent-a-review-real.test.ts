// Agent-A 검토 길을 실제 Agent-A 서버 코드에 대고 본다(가짜가 아니라 실제 규약). 평소에는 건너뛴다.
//   IAMCEO_AGENT_A_REAL_URL=http://127.0.0.1:<포트> bun test tests/agent-a-review-real.test.ts
// 그 서버는 '초안 규약 2'(docs/agent-a/agent-a-draft-protocol-2.patch)를 넣은 Agent-A 를 새 격리 데이터로 띄운 것이어야 하고,
// AI 는 정해진 답을 내는 대역이어야 한다(댓글 '시험 답: …', 문서에 묻기 '문서 답: …', 고른 AI 는 답 끝의 [플랫폼/모델/추론]).
// IAMCEO_AGENT_A_REAL_PROTOCOL=1 을 함께 주면 원래 Agent-A(c559881)로 보고, 안전하지 않은 쓰기를 거절하는지만 본다.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../server/bus.ts";
import { openDb } from "../server/db.ts";
import { AgentAClient, AgentAService } from "../server/integrations/agent-a.ts";
import type { AgentAImageInput, AgentAReviewDiagramAnchor } from "../shared/agent-a.ts";
import { AgentAReview } from "../server/integrations/agent-a-review.ts";
import { ApiError, Store } from "../server/store.ts";
import { anchorFor, type DiagramPart } from "../web/src/lib/agent-a-diagram.ts";
import { splitDoc } from "../web/src/lib/agent-a-review.ts";
import { pngBase64 } from "./fixtures/png.ts";

const REAL = process.env.IAMCEO_AGENT_A_REAL_URL ?? null;
const ORIGINAL = process.env.IAMCEO_AGENT_A_REAL_PROTOCOL === "1";
const MARKDOWN = "머리 문단입니다.\n\n## 배경\n\n배경 문장 하나. 배경 문장 둘.\n\n## 계획\n\n계획은 세 단계입니다.";

type Hook = (input: string, init: RequestInit, res: Response) => void | Promise<void>;
async function setup(title: string, content: { markdown?: string; images?: AgentAImageInput[] } = {}) {
  const store = new Store(openDb(join(mkdtempSync(join(tmpdir(), "iamceo-aa-real-")), "iamceo.db")), new Bus());
  const project = store.createProject({ name: "실제 규약 시험", cwd: tmpdir() });
  // 실제 Agent-A 가 응답한 뒤에 끼어드는 고리. 저장은 됐는데 응답만 잃는 경우를 만든다(던지면 서버는 응답을 받지 못한 것이 된다).
  const hooks: { after?: Hook } = {};
  const transport = async (input: string, init: RequestInit) => {
    const res = await fetch(input, init);
    if (hooks.after) await hooks.after(input, init, res);
    return res;
  };
  const service = new AgentAService(store, new AgentAClient({ baseUrl: REAL!, appToken: null, agentToken: null }, transport));
  const review = new AgentAReview(service);
  const view = await service.createDoc(project.id, { title, markdown: content.markdown ?? MARKDOWN, images: content.images });
  const doc = await review.open(view.fileId);
  // 다른 창(원래 Agent-A 화면)이 직접 Agent-A 에 쓴다. IAMCEO 를 거치지 않는다.
  const other = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${REAL}${path}`, { method, headers: { "x-enouv-artifact": view.artifactId, "x-enouv-review-session": doc.sessionId, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, any> | null, revision: res.headers.get("x-enouv-draft-revision") };
  };
  /** 쓰기 하나(POST, 경로가 match 에 맞고 200)가 Agent-A 에 들어간 뒤 그 응답만 한 번 잃는다. */
  const loseOnce = (match: (path: string) => boolean) => {
    let lost = false;
    hooks.after = (input, init, res) => {
      if (!lost && init.method === "POST" && match(new URL(input).pathname) && res.status === 200) {
        lost = true;
        throw new Error("저장 뒤 응답 유실(시험)");
      }
    };
  };
  return { store, project, service, review, other, hooks, loseOnce, fileId: view.fileId, artifactId: view.artifactId, doc, sid: doc.sessionId };
}
const failure = async (p: Promise<unknown>): Promise<{ status: number; code?: string }> => p.then(() => ({ status: 200 }), (e) => (e instanceof ApiError ? { status: e.status, code: e.code } : { status: -1 }));
async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string): Promise<T> {
  for (let i = 0; i < 120; i++) {
    const v = await read();
    if (ok(v)) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`기다리다 그만둠: ${what}`);
}
const lines = async (res: Response) => (await res.text()).trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
/** 답 흐름을 줄 단위로 하나씩 읽는다(끝까지 기다리지 않는다: 허락을 구하는 동안 답은 멈춰 있다). */
async function* stream(res: Response): AsyncGenerator<Record<string, unknown>> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let at: number;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      if (line.trim()) yield JSON.parse(line) as Record<string, unknown>;
    }
  }
  if (buffer.trim()) yield JSON.parse(buffer) as Record<string, unknown>;
}
const failed = async (p: Promise<unknown>): Promise<{ status: number; code?: string; message?: string }> =>
  p.then(() => ({ status: 200 }), (e) => (e instanceof ApiError ? { status: e.status, code: e.code, message: e.message } : { status: -1, message: String(e) }));

describe.skipIf(!REAL || ORIGINAL)("실제 Agent-A(초안 규약 2): 검토 길", () => {
  test("새 댓글·삭제 표시·고른 AI·붙인 그림이 실제 규약으로 가고, 다른 창의 초안은 남는다", async () => {
    const s = await setup("실제: 댓글");
    expect(s.doc.safeWrites).toBe(true);
    await s.other("POST", "/api/draft", { draftGeneration: 0, annotations: [], globalAttachments: [], editedMarkdown: `${s.doc.canonical}\n\n다른 창의 편집` });
    const catalog = await s.review.aiCatalog(s.fileId, s.sid);
    expect(catalog.providers.map((p) => p.id)).toEqual(["codex-sdk", "claude-agent-sdk"]);
    const up = await s.review.upload(s.fileId, s.sid, { name: "shot.png", mediaType: "image/png", base64: pngBase64(40, 30) });
    await s.review.addComment(s.fileId, s.sid, { id: "real-c1", kind: "comment", text: "풀어 주세요", quote: "배경 문장 하나.", images: [up], ai: { providerId: "claude-agent-sdk", model: "claude-test" } });
    await s.review.addComment(s.fileId, s.sid, { id: "real-d1", kind: "deletion", text: "", quote: "배경 문장 둘." });
    // 같은 요청의 재전송은 처음 결과, 다른 내용은 거절
    expect((await failure(s.review.addComment(s.fileId, s.sid, { id: "real-c1", kind: "comment", text: "풀어 주세요", quote: "배경 문장 하나.", images: [up], ai: { providerId: "claude-agent-sdk", model: "claude-test" } }))).status).toBe(200);
    expect(await failure(s.review.addComment(s.fileId, s.sid, { id: "real-c1", kind: "comment", text: "다른 글", quote: "배경 문장 하나." }))).toEqual({ status: 409, code: "AGENT_A_IDEMPOTENCY_CONFLICT" });
    const list = await until(() => s.review.comments(s.fileId, s.sid, null), (c) => Boolean(c?.annotations.some((a) => a.ai && !a.writing)), "첫 답");
    expect(list!.annotations.map((a) => [a.kind, a.ai, a.text])).toEqual([["comment", false, "풀어 주세요"], ["comment", true, "시험 답: 풀어 주세요 [claude-agent-sdk/claude-test]"], ["deletion", false, ""]]);
    expect(list!.annotations[0]!.images).toEqual([up]);
    expect((await s.review.attachment(s.fileId, s.sid, up.path)).headers.get("content-type")).toBe("image/png");
    await s.review.reply(s.fileId, s.sid, { inReplyTo: "real-c1", text: "더 자세히", ai: { providerId: "codex-sdk", model: "test-model", reasoningEffort: "high" } });
    const more = await until(() => s.review.comments(s.fileId, s.sid, null), (c) => (c?.annotations.filter((a) => a.ai && !a.writing).length ?? 0) === 2, "답글의 답");
    expect(more!.annotations.filter((a) => a.ai).map((a) => a.text)).toContain("시험 답: 더 자세히 [codex-sdk/test-model/high]");
    // 다른 창의 직접 편집은 그대로이고, 내 주석 둘이 초안에 더해졌다
    const draft = (await s.other("GET", "/api/draft")).json!;
    expect(draft.editedMarkdown).toContain("다른 창의 편집");
    expect(draft.annotations.map((a: { id: string }) => a.id)).toEqual(["real-c1", "real-d1"]);
  }, 60_000);

  test("본문 직접 고치기: 초안으로만 남고, 다른 창이 먼저 저장하면 덮지 않는다", async () => {
    const s = await setup("실제: 초안");
    const first = await s.review.draft(s.fileId, s.sid);
    const saved = await s.review.saveDraft(s.fileId, s.sid, { markdown: `${s.doc.canonical}\n\n덧붙인 문단.`, revision: first.revision });
    expect((await s.review.open(s.fileId)).edited).toBe(true);
    await s.other("POST", "/api/draft", { draftGeneration: 0, annotations: [], globalAttachments: [], editedMarkdown: "다른 창의 본문" });
    expect(await failure(s.review.saveDraft(s.fileId, s.sid, { markdown: "내 본문", revision: saved.revision }))).toEqual({ status: 409, code: "AGENT_A_DRAFT_CONFLICT" });
    expect((await s.other("GET", "/api/draft")).json!.editedMarkdown).toBe("다른 창의 본문");
    const theirs = await s.review.draft(s.fileId, s.sid);
    expect(theirs.editedMarkdown).toBe("다른 창의 본문");
    const discarded = await s.review.saveDraft(s.fileId, s.sid, { markdown: null, revision: theirs.revision });
    expect(discarded.editedMarkdown).toBeNull();
    const reopened = await s.review.open(s.fileId);
    expect([reopened.edited, reopened.artifactRevision, reopened.markdown === reopened.canonical]).toEqual([false, 1, true]);
  }, 60_000);

  test("검토 제출 → 분기·피드백 → 전송 자료 → 수동 결과 가져오기 → 답변 채택 → 수정안 한 번에 저장", async () => {
    const s = await setup("실제: 제출");
    await s.review.addComment(s.fileId, s.sid, { id: "real-s1", kind: "comment", text: "이 문장을 풀어 주세요", quote: "배경 문장 하나." });
    await s.review.addComment(s.fileId, s.sid, { id: "real-s2", kind: "deletion", text: "", quote: "배경 문장 둘." });
    const draft = await s.review.draft(s.fileId, s.sid);
    // 제출하려는 사이 다른 창이 초안을 바꾸면 제출하지 않는다
    const raw = (await s.other("GET", "/api/draft")).json!;
    await s.other("POST", "/api/draft", { draftGeneration: 0, globalAttachments: [], annotations: raw.annotations, editedMarkdown: `${s.doc.canonical}\n\n다른 창이 덧붙임` });
    expect(await failure(s.review.submit(s.fileId, s.sid, { revision: draft.revision, decision: "approved" }))).toEqual({ status: 409, code: "AGENT_A_DRAFT_CONFLICT" });
    expect((await s.review.open(s.fileId, s.sid)).closed).toBe(false);
    const again = await s.review.draft(s.fileId, s.sid);
    const sent = await s.review.submit(s.fileId, s.sid, { revision: again.revision, decision: "approved" });
    expect(sent).toEqual({ ok: true, sent: 3, branches: 3 });
    // 응답을 잃고 다시 보낸 제출: 처음 결과
    expect(await s.review.submit(s.fileId, s.sid, { revision: again.revision, decision: "approved" })).toEqual(sent);
    expect((await s.review.open(s.fileId, s.sid)).closed).toBe(true);
    expect(await failure(s.review.addComment(s.fileId, s.sid, { id: "real-after", kind: "global", text: "제출 뒤" }))).toEqual({ status: 409, code: "AGENT_A_ALREADY_DECIDED" });
    let manage = await s.review.manage(s.fileId);
    expect(manage.artifactRevision).toBe(1);
    expect(manage.branches).toHaveLength(3);
    expect(manage.feedback.map((f) => f.state)).toEqual(["not_sent", "not_sent", "not_sent"]);
    expect(manage.feedback[0]!.message).toContain("이 문장을 풀어 주세요");
    expect(manage.feedback[2]!.message).toContain("# Direct Edits");
    expect(manage.adapter).toBe(false);

    // 분기: 블록에서 새 분기, 후속 질문
    const block = manage.blocks.find((b) => b.title === "계획")!;
    const made = await s.review.branchCreate(s.fileId, { opId: "real-branch-01", question: "세 단계가 무엇인가요?", blockId: block.id });
    expect(await s.review.branchCreate(s.fileId, { opId: "real-branch-01", question: "세 단계가 무엇인가요?", blockId: block.id })).toEqual(made);
    await s.review.branchMessage(s.fileId, { opId: "real-follow-01", branchId: made.branchId, text: "기간도 알려 주세요" });
    manage = await s.review.manage(s.fileId);
    const mine = manage.feedback.filter((f) => f.branchId === made.branchId);
    expect(mine.map((f) => f.message)).toEqual(["세 단계가 무엇인가요?", "기간도 알려 주세요"]);
    expect(manage.branches.find((b) => b.id === made.branchId)).toMatchObject({ status: "open", target: "계획", parentId: null });

    // 피드백: 전송 자료 준비 → 내보내기 → 자동 연동 꺼짐 → 수동 결과 가져오기(답 + 수정안)
    const job = await s.review.feedbackPrepare(s.fileId, { opId: "real-batch-01", feedbackIds: [mine[0]!.id] });
    expect(await s.review.feedbackPrepare(s.fileId, { opId: "real-batch-01", feedbackIds: [mine[0]!.id] })).toEqual(job);
    const exported = await s.review.jobExport(s.fileId, job.jobId);
    expect(exported.receipt_id).toBe(job.jobId);
    const packet = exported.packet as { selected_feedback: { feedback_id: string; branch_id: string; question_id: string }[]; base_artifact_revision: number; context_revision: number; read_set: unknown[]; allowed_write_set: { block_id: string; revision: number }[] };
    expect(await failure(s.review.jobRun(s.fileId, job.jobId))).toEqual({ status: 409, code: "AGENT_A_ADAPTER_OFF" });
    await s.review.importResult(s.fileId, { receipt_id: job.jobId, answers: [{ feedback_id: mine[0]!.id, body: "조사·설계·구현입니다." }], proposals: [] });
    manage = await s.review.manage(s.fileId);
    expect(manage.jobs.find((j) => j.id === job.jobId)).toMatchObject({ state: "succeeded", feedback: 1 });
    expect(packet.selected_feedback[0]!.feedback_id).toBe(mine[0]!.id);
    const branch = manage.branches.find((b) => b.id === made.branchId)!;
    const answer = branch.messages.find((m) => m.role === "assistant")!;
    expect(answer.body).toBe("조사·설계·구현입니다.");
    await s.review.branchDecide(s.fileId, { opId: "real-answer-01", branchId: made.branchId, messageId: answer.id, decision: "accepted", reason: "충분함" });
    const child = await s.review.branchCreate(s.fileId, { opId: "real-branch-02", question: "설계는 누가 하나요?", parent: { branchId: made.branchId, messageId: answer.id } });
    const closed = await s.review.branchClose(s.fileId, { opId: "real-close-01", branchId: made.branchId, reason: "정리" });
    expect(closed).toMatchObject({ ok: true, unanswered: 1, openChildren: 1 });
    manage = await s.review.manage(s.fileId);
    expect(manage.branches.find((b) => b.id === made.branchId)!.status).toBe("closed");
    expect(manage.branches.find((b) => b.id === made.branchId)!.messages.find((m) => m.id === answer.id)).toMatchObject({ decision: "accepted", reason: "충분함" });
    expect(manage.branches.find((b) => b.id === child.branchId)).toMatchObject({ status: "open", parentId: made.branchId, target: "앞 답변" });
    expect(manage.artifactRevision).toBe(1);
    expect(manage.events[0]!.type).toBeTruthy();
  }, 90_000);

  test("댓글 수정안 둘을 한 번에 정본에 저장하고, 직접 고치기의 같은 요청은 처음 결과를 확인한다", async () => {
    const s = await setup("실제: 수정안");
    await s.review.addComment(s.fileId, s.sid, { id: "real-p1", kind: "comment", text: "고쳐 주세요", quote: "배경 문장 하나." });
    await s.review.addComment(s.fileId, s.sid, { id: "real-p2", kind: "comment", text: "이것도 고쳐 주세요", quote: "계획은 세 단계입니다." });
    const manage = await until(() => s.review.manage(s.fileId), (m) => m.proposals.filter((p) => p.status === "pending").length === 2, "수정안 둘");
    const ids = manage.proposals.map((p) => p.id);
    const applied = await s.review.applyMany(s.fileId, { opId: "real-many-01", proposalIds: ids });
    expect(applied).toMatchObject({ ok: true, verified: true });
    expect(await s.review.applyMany(s.fileId, { opId: "real-many-01", proposalIds: ids })).toMatchObject({ ok: true, verified: true });
    const after = await s.review.manage(s.fileId);
    expect(after.blocks.map((b) => b.body).join("\n")).toContain("배경 문장 하나. (고침)");
    expect(after.blocks.map((b) => b.body).join("\n")).toContain("계획은 세 단계입니다. (고침)");
    const block = after.blocks.find((b) => b.title === "계획")!;
    const input = { blockId: block.id, revision: block.revision, title: block.title, body: "직접 고친 본문", opId: "real-edit-0001", contextRevision: after.contextRevision };
    const first = await s.review.edit(s.fileId, input);
    expect(await s.review.edit(s.fileId, input)).toEqual(first);
    expect(await failure(s.review.edit(s.fileId, { ...input, body: "다른 내용" }))).toEqual({ status: 409, code: "AGENT_A_REVISION_CONFLICT" });
    expect(await failure(s.review.edit(s.fileId, { ...input, opId: "real-edit-0002", body: "늦은 수정" }))).toEqual({ status: 409, code: "AGENT_A_REVISION_CONFLICT" });
    const now = (await s.review.manage(s.fileId)).blocks.find((b) => b.id === block.id)!;
    expect([now.revision, now.body]).toEqual([block.revision + 1, "직접 고친 본문"]);
    const restore = { blockId: block.id, revision: now.revision, historyRevision: block.revision, opId: "real-restore-01", contextRevision: after.contextRevision, layoutRevision: after.layoutRevision };
    const restored = await s.review.restore(s.fileId, restore);
    expect(await s.review.restore(s.fileId, restore)).toEqual(restored);
    expect((await s.review.manage(s.fileId)).blocks.find((b) => b.id === block.id)!.revision).toBe(block.revision + 2);
  }, 90_000);

  test("문서에 묻기: 답이 흐름으로 오고 대화에 남는다. 새 대화·앞 대화", async () => {
    const s = await setup("실제: 묻기");
    const events = await lines(await s.review.chatAsk(s.fileId, s.sid, { id: "real-q-0001", prompt: "이 문서의 요지는?", quote: "배경 문장 하나.", ai: { providerId: "codex-sdk", model: "test-model", reasoningEffort: "high" } }));
    expect(events[0]).toMatchObject({ type: "start" });
    expect(events.at(-1)).toMatchObject({ type: "done", ok: true });
    const answer = events.filter((e) => e.type === "delta").map((e) => e.text).join("");
    expect(answer).toBe("문서 답: 이 문서의 요지는? [codex-sdk/test-model/high]");
    const history = await s.review.chatHistory(s.fileId, s.sid);
    expect(history.entries).toEqual([expect.objectContaining({ id: "real-q-0001", prompt: "이 문서의 요지는?", quote: "배경 문장 하나.", answer, writing: false, error: null })]);
    expect((await failure(s.review.chatAsk(s.fileId, s.sid, { id: "real-q-0001", prompt: "이 문서의 요지는?" }))).status).toBe(409);
    const fresh = await s.review.chatNew(s.fileId, s.sid);
    expect(fresh.entries).toEqual([]);
    expect((await s.review.chatSessions(s.fileId, s.sid)).map((c) => c.current)).toEqual([false, true]);
    expect((await s.review.chatSelect(s.fileId, s.sid, history.conversationId)).entries).toHaveLength(1);
    // 묻기는 초안도 정본도 바꾸지 않는다
    expect(await s.review.draft(s.fileId, s.sid)).toMatchObject({ revision: 0, annotations: 0, editedMarkdown: null });
    expect((await s.review.manage(s.fileId)).artifactRevision).toBe(1);
  }, 60_000);

  test("문서 관리의 블록 일: 검토 표시 · 보관과 다시 꺼내기 · 요약 · 새 블록(글·표·도식·그림) · 순서 · 배치 · 목표와 제약", async () => {
    const s = await setup("실제: 블록");
    let m = await s.review.manage(s.fileId);
    const plan = m.blocks.find((b) => b.title === "계획")!;
    const background = m.blocks.find((b) => b.title === "배경")!;
    expect([plan.summary, plan.sources, plan.reviewedRevision, plan.layout]).toEqual(["", [], null, null]);
    // 검토 표시: 본문·정본 판은 그대로. 같은 요청은 처음 결과, 낡은 판은 거절
    expect(await s.review.blockReview(s.fileId, { blockId: plan.id, revision: 1, opId: "real-reviewed-01" })).toEqual({ ok: true, reviewedRevision: 1 });
    expect(await s.review.blockReview(s.fileId, { blockId: plan.id, revision: 1, opId: "real-reviewed-01" })).toEqual({ ok: true, reviewedRevision: 1 });
    expect((await s.review.manage(s.fileId)).artifactRevision).toBe(1);
    // 요약 고치기: 본문에 제목 아래 글로 실린다. 검토 표시는 지난 판의 것이 된다
    await s.review.edit(s.fileId, { blockId: plan.id, revision: 1, title: "계획", summary: "세 단계 요약", body: plan.body, opId: "real-summary-01", contextRevision: m.contextRevision });
    m = await s.review.manage(s.fileId);
    expect(m.blocks.find((b) => b.id === plan.id)).toMatchObject({ revision: 2, summary: "세 단계 요약", reviewedRevision: 1 });
    expect((await s.review.open(s.fileId)).markdown).toContain("## 계획\n\n세 단계 요약\n\n계획은 세 단계입니다.");
    expect(await failed(s.review.blockReview(s.fileId, { blockId: plan.id, revision: 1, opId: "real-reviewed-02" }))).toMatchObject({ status: 409, code: "AGENT_A_REVISION_CONFLICT" });
    // 보관: 본문에서 빠진다. 같은 요청은 처음 결과. 보관 전 판으로 다시 꺼낸다
    const archive = { blockId: background.id, revision: 1, opId: "real-archive-01", contextRevision: m.contextRevision, layoutRevision: m.layoutRevision };
    const archived = await s.review.blockArchive(s.fileId, archive);
    expect(await s.review.blockArchive(s.fileId, archive)).toEqual(archived);
    m = await s.review.manage(s.fileId);
    expect(m.blocks.find((b) => b.id === background.id)).toMatchObject({ archived: true, revision: 2 });
    expect((await s.review.open(s.fileId)).markdown).not.toContain("배경 문장 하나.");
    expect(await failed(s.review.edit(s.fileId, { blockId: background.id, revision: 2, title: "배경", body: "보관된 것", opId: "real-edit-archived" }))).toMatchObject({ status: 404 });
    await s.review.restore(s.fileId, { blockId: background.id, revision: 2, historyRevision: 1, opId: "real-unarchive-01", contextRevision: m.contextRevision, layoutRevision: m.layoutRevision });
    m = await s.review.manage(s.fileId);
    expect(m.blocks.find((b) => b.id === background.id)).toMatchObject({ archived: false, revision: 3 });
    expect((await s.review.open(s.fileId)).markdown).toContain("배경 문장 하나.");
    // 새 블록: 글(고른 블록 뒤) · 표 · 도식 · 그림. 같은 요청을 다시 보내도 하나다
    const insert = { opId: "real-insert-01", afterId: background.id, kind: "markdown" as const, title: "새 근거", body: "새로 더한 문단입니다.", contextRevision: m.contextRevision, layoutRevision: m.layoutRevision };
    const made = await s.review.blockInsert(s.fileId, insert);
    expect(await s.review.blockInsert(s.fileId, insert)).toEqual(made);
    m = await s.review.manage(s.fileId);
    const order = () => m.blocks.filter((b) => !b.archived).map((b) => b.title);
    expect(order().slice(order().indexOf("배경"), order().indexOf("배경") + 2)).toEqual(["배경", "새 근거"]);
    expect(m.blocks.filter((b) => b.title === "새 근거")).toHaveLength(1);
    const tail = () => ({ afterId: m.blocks.filter((b) => !b.archived).at(-1)!.id, contextRevision: m.contextRevision, layoutRevision: m.layoutRevision });
    expect(await failed(s.review.blockInsert(s.fileId, { ...tail(), opId: "real-table-bad", kind: "table", title: "표", body: "표가 아님" }))).toMatchObject({ status: 400 });
    await s.review.blockInsert(s.fileId, { ...tail(), opId: "real-table-01", kind: "table", title: "비교 표", body: '{"headers":["항목","값"],"rows":[["기간","2주"],["비용",0]]}' });
    m = await s.review.manage(s.fileId);
    await s.review.blockInsert(s.fileId, { ...tail(), opId: "real-mermaid-01", kind: "mermaid", title: "흐름", body: "flowchart LR\n  A --> B" });
    m = await s.review.manage(s.fileId);
    const image = { name: "shot.png", mediaType: "image/png", base64: pngBase64(40, 30) };
    const picture = await s.review.blockInsert(s.fileId, { ...tail(), opId: "real-image-01", kind: "image", title: "화면 그림", body: "그림 설명", image });
    expect(await s.review.blockInsert(s.fileId, { ...tail(), opId: "real-image-01", kind: "image", title: "화면 그림", body: "그림 설명", image })).toEqual(picture);
    m = await s.review.manage(s.fileId);
    expect(m.blocks.filter((b) => !b.archived).map((b) => b.kind).slice(-3)).toEqual(["table", "mermaid", "image"]);
    let doc = await s.review.open(s.fileId);
    expect(doc.markdown).toContain("| 항목 | 값 |\n| --- | --- |\n| 기간 | 2주 |\n| 비용 | 0 |");
    expect(doc.markdown).toContain("```mermaid\nflowchart LR\n  A --> B\n```");
    expect(doc.images).toHaveLength(1);
    expect(doc.images[0]).toMatchObject({ width: 40, height: 30 });
    // 낡은 배치 판에는 더하지 않는다(그사이 다른 변경을 덮지 않는다)
    expect(await failed(s.review.blockInsert(s.fileId, { ...insert, opId: "real-insert-stale", title: "늦은 블록" }))).toMatchObject({ status: 409, code: "AGENT_A_REVISION_CONFLICT" });
    // 순서: 본문 순서가 바뀌고 정본 판은 그대로다
    const ids = m.blocks.filter((b) => !b.archived).map((b) => b.id);
    const swapped = [ids[1]!, ids[0]!, ...ids.slice(2)];
    const before = m.artifactRevision;
    const reordered = await s.review.blocksReorder(s.fileId, { opId: "real-order-01", blockIds: swapped, layoutRevision: m.layoutRevision });
    expect(await s.review.blocksReorder(s.fileId, { opId: "real-order-01", blockIds: swapped, layoutRevision: m.layoutRevision })).toEqual(reordered);
    const stale = await failed(s.review.blocksReorder(s.fileId, { opId: "real-order-02", blockIds: ids, layoutRevision: m.layoutRevision }));
    expect(stale).toMatchObject({ status: 409, code: "AGENT_A_REVISION_CONFLICT" });
    expect(stale.message).toContain("배치가 바뀌었습니다");
    m = await s.review.manage(s.fileId);
    expect([m.blocks.filter((b) => !b.archived).map((b) => b.id), m.artifactRevision]).toEqual([swapped, before]);
    expect(await failed(s.review.blocksReorder(s.fileId, { opId: "real-order-03", blockIds: swapped.slice(1), layoutRevision: m.layoutRevision }))).toMatchObject({ status: 400 });
    // 배치: 자리와 크기만 바뀐다
    const layout = { x: 40, y: 120, width: 480, height: 300 };
    const placed = await s.review.layoutSet(s.fileId, { opId: "real-layout-01", blockId: plan.id, layout, layoutRevision: m.layoutRevision });
    expect(await s.review.layoutSet(s.fileId, { opId: "real-layout-01", blockId: plan.id, layout, layoutRevision: m.layoutRevision })).toEqual(placed);
    expect(await failed(s.review.layoutSet(s.fileId, { opId: "real-layout-02", blockId: plan.id, layout: { ...layout, x: 0 }, layoutRevision: m.layoutRevision }))).toMatchObject({ status: 409 });
    m = await s.review.manage(s.fileId);
    expect([m.blocks.find((b) => b.id === plan.id)!.layout, m.artifactRevision]).toEqual([layout, before]);
    // 목표와 제약: 문맥 판과 정본 판이 오르고 본문에 실린다
    const context = { opId: "real-context-01", goal: "새 목표입니다", constraints: ["첫째 제약", "둘째 제약"], contextRevision: m.contextRevision };
    const changed = await s.review.contextUpdate(s.fileId, context);
    expect(changed).toEqual({ ok: true, contextRevision: m.contextRevision + 1, artifactRevision: before + 1 });
    expect(await s.review.contextUpdate(s.fileId, context)).toEqual(changed);
    expect(await failed(s.review.contextUpdate(s.fileId, { ...context, opId: "real-context-02", goal: "덮으려는 목표" }))).toMatchObject({ status: 409, code: "AGENT_A_REVISION_CONFLICT" });
    m = await s.review.manage(s.fileId);
    expect([m.goal, m.constraints]).toEqual(["새 목표입니다", ["첫째 제약", "둘째 제약"]]);
    doc = await s.review.open(s.fileId);
    expect(doc.markdown).toContain("새 목표입니다\n\n- 첫째 제약\n- 둘째 제약");
  }, 90_000);

  test("빠른 라벨과 검토 전체에 붙인 그림: 실제 규약으로 가고, 다른 창의 초안은 남는다", async () => {
    const s = await setup("실제: 라벨과 첨부");
    await s.other("POST", "/api/draft", { draftGeneration: 0, annotations: [], globalAttachments: [], editedMarkdown: `${s.doc.canonical}\n\n다른 창의 편집` });
    const label = { id: "real-label-01", kind: "comment" as const, text: "🔍 확인이 필요해요", quote: "배경 문장 하나.", quickLabel: { tip: "근거를 확인해 주세요." } };
    await s.review.addComment(s.fileId, s.sid, label);
    expect((await failure(s.review.addComment(s.fileId, s.sid, label))).status).toBe(200);
    let raw = (await s.other("GET", "/api/draft")).json!;
    expect(raw.editedMarkdown).toContain("다른 창의 편집");
    expect(raw.annotations.map((a: Record<string, unknown>) => [a.id, a.text, a.isQuickLabel, a.quickLabelTip])).toEqual([["real-label-01", "🔍 확인이 필요해요", true, "근거를 확인해 주세요."]]);
    const list = await until(() => s.review.comments(s.fileId, s.sid, null), (c) => Boolean(c?.annotations.some((a) => a.ai && !a.writing)), "라벨의 답");
    expect(list!.annotations.find((a) => a.id === "real-label-01")).toMatchObject({ label: true, labelTip: "근거를 확인해 주세요.", quote: "배경 문장 하나." });
    // 검토 전체에 붙이는 그림: 조건 저장. 다른 창의 편집과 내 주석은 그대로다
    const a = await s.review.upload(s.fileId, s.sid, { name: "a.png", mediaType: "image/png", base64: pngBase64(20, 10) });
    const b = await s.review.upload(s.fileId, s.sid, { name: "b.png", mediaType: "image/png", base64: pngBase64(30, 10) });
    let draft = await s.review.draft(s.fileId, s.sid);
    draft = await s.review.saveAttachments(s.fileId, s.sid, { attachments: [a, b], revision: draft.revision });
    expect(draft).toMatchObject({ annotations: 1, attachments: [a, b] });
    expect((await s.review.attachment(s.fileId, s.sid, b.path)).headers.get("content-type")).toBe("image/png");
    raw = (await s.other("GET", "/api/draft")).json!;
    expect([raw.editedMarkdown.includes("다른 창의 편집"), raw.annotations.length, raw.globalAttachments]).toEqual([true, 1, [a, b]]);
    // 그사이 다른 창이 저장했으면 붙이지 않는다. 그 창의 초안은 그대로다
    await s.other("POST", "/api/draft", { draftGeneration: 0, annotations: raw.annotations, globalAttachments: [a], editedMarkdown: "다른 창이 다시 저장" });
    expect(await failure(s.review.saveAttachments(s.fileId, s.sid, { attachments: [b], revision: draft.revision }))).toEqual({ status: 409, code: "AGENT_A_DRAFT_CONFLICT" });
    raw = (await s.other("GET", "/api/draft")).json!;
    expect([raw.editedMarkdown, raw.globalAttachments]).toEqual(["다른 창이 다시 저장", [a]]);
    // 제출하면 붙인 그림과 라벨이 함께 넘어간다(라벨은 머리에 [라벨]로)
    draft = await s.review.draft(s.fileId, s.sid);
    await s.review.submit(s.fileId, s.sid, { revision: draft.revision, decision: "feedback" });
    const manage = await s.review.manage(s.fileId);
    const full = manage.feedback.map((f) => f.message).find((text) => text.includes("# Plan Feedback"))!;
    expect(full).toContain('[🔍 확인이 필요해요] Feedback on: "배경 문장 하나."');
    expect(full).toContain("> 근거를 확인해 주세요.");
    expect(full).toContain("## Label Summary");
    expect(full).toContain("(review attachments: 1)");
  }, 90_000);

  test("R3 도식 부분 댓글과 그림 영역의 '좋아요' 라벨: 자리와 라벨이 실제 규약의 초안에 그대로 남고 다시 읽힌다. 틀린 자리와 닫힌 검토에는 쓰지 않는다", async () => {
    const flow = ["graph TD", "  A[시작] --> B[검토]", "  B -->|통과| C[끝]"];
    const s = await setup("실제: 도식 댓글", { markdown: ["도식이 있는 문서입니다.", "", "```mermaid", ...flow, "```", "", "끝 문장입니다."].join("\n"), images: [{ title: "구성도", name: "map.png", mediaType: "image/png", base64: pngBase64(400, 200) }] });
    await s.other("POST", "/api/draft", { draftGeneration: 0, annotations: [], globalAttachments: [], editedMarkdown: `${s.doc.canonical}\n\n다른 창의 편집` });
    // 화면이 하는 대로: 본문에서 도식 조각을 찾아(```mermaid 줄 번호) 그리는 칸이 돌려준 부분으로 자리를 만든다.
    const diagram = splitDoc(s.doc.markdown).find((p) => p.kind === "mermaid")!;
    if (diagram.kind !== "mermaid") throw new Error("도식 조각이 없습니다");
    expect([diagram.code, s.doc.markdown.split("\n")[diagram.line - 1]]).toEqual([flow.join("\n"), "```mermaid"]);
    const box = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 };
    const partB: DiagramPart = { kind: "node", id: "B", label: "검토", box, hits: [box] };
    const partBC: DiagramPart = { kind: "edge", from: "B", to: "C", label: "통과", box, hits: [box] };
    const node = anchorFor("flowchart", partB, diagram.code, diagram.line);
    const edge = anchorFor("flowchart", partBC, diagram.code, diagram.line);
    const whole = anchorFor("flowchart", null, diagram.code, diagram.line);
    expect([node.sourceLine, edge.sourceLine, whole.sourceLine]).toEqual([[diagram.line + 2, diagram.line + 2], [diagram.line + 3, diagram.line + 3], [diagram.line + 1, diagram.line + 3]]);
    await s.review.addComment(s.fileId, s.sid, { id: "real-dg-node", kind: "comment", text: "이 단계는 누가 하나요?", diagram: node });
    await s.review.addComment(s.fileId, s.sid, { id: "real-dg-edge", kind: "comment", text: "통과 기준이 뭔가요?", diagram: edge });
    await s.review.addComment(s.fileId, s.sid, { id: "real-dg-whole", kind: "comment", text: "도식이 너무 단순합니다", diagram: whole });
    // 같은 요청의 재전송은 처음 결과, 틀린 자리는 보내지 않는다
    expect((await failure(s.review.addComment(s.fileId, s.sid, { id: "real-dg-node", kind: "comment", text: "이 단계는 누가 하나요?", diagram: node }))).status).toBe(200);
    expect(await failure(s.review.addComment(s.fileId, s.sid, { id: "real-dg-bad", kind: "comment", text: "틀린 자리", diagram: { ...node, family: "pie" } as never }))).toEqual({ status: 400, code: "AGENT_A_INVALID_DIAGRAM_ANCHOR" });
    // 그림 영역에 '좋아요' 라벨 한 번
    const image = s.doc.images[0]!;
    const region = { v: 1 as const, src: image.src, sourceLine: image.sourceLine, naturalWidth: image.width, naturalHeight: image.height, box: { x: 40, y: 40, w: 160, h: 100 } };
    await s.review.addComment(s.fileId, s.sid, { id: "real-rg-good", kind: "comment", text: "👍 좋아요", quote: "", region, quickLabel: { tip: null } });
    // 실제 Agent-A 의 초안: 다른 창의 편집은 그대로이고, 자리·영역·라벨 표시가 원래 화면과 같은 칸에 남았다
    const raw = (await s.other("GET", "/api/draft")).json!;
    expect(raw.editedMarkdown).toContain("다른 창의 편집");
    expect(raw.annotations.map((a: Record<string, unknown>) => [a.id, a.type, a.originalText, a.diagramAnchor ?? null, a.imageRegion ?? null, a.isQuickLabel ?? null, "quickLabelTip" in a])).toEqual([
      ["real-dg-node", "COMMENT", "검토", node, null, null, false],
      ["real-dg-edge", "COMMENT", "통과", edge, null, null, false],
      ["real-dg-whole", "COMMENT", "graph TD", whole, null, null, false],
      ["real-rg-good", "COMMENT", "", null, region, true, false],
    ]);
    // 실제 Agent-A 가 그 영역을 원본 그림의 바뀌지 않는 자리로 풀어 두었다
    const session = (await s.other("GET", `/api/plannotator/sessions/${s.sid}`)).json!;
    expect(session.image_region_targets["real-rg-good"]).toMatchObject({ kind: "region", bbox: { x: 0.1, y: 0.2, width: 0.4, height: 0.5 } });
    // 다시 읽기: 댓글마다 답이 시작됐고, 자리·영역·라벨이 돌아온다
    const list = await until(() => s.review.comments(s.fileId, s.sid, null), (c) => (c?.annotations.filter((a) => a.ai && !a.writing).length ?? 0) >= 4, "도식 댓글과 라벨의 답");
    const mine = list!.annotations.filter((a) => !a.ai);
    expect(mine.map((a) => [a.id, a.quote, a.diagram, a.region, a.label])).toEqual([
      ["real-dg-node", "검토", node, null, false],
      ["real-dg-edge", "통과", edge, null, false],
      ["real-dg-whole", "graph TD", whole, null, false],
      ["real-rg-good", "", null, region, true],
    ]);
    expect(list!.annotations.filter((a) => a.ai).map((a) => a.text)).toContain("시험 답: 이 단계는 누가 하나요?");
    // 제출하면 자리 한 줄과 라벨이 함께 넘어가고, 닫힌 검토에는 새 도식 댓글을 받지 않는다
    const draft = await s.review.draft(s.fileId, s.sid);
    await s.review.submit(s.fileId, s.sid, { revision: draft.revision, decision: "feedback" });
    const full = (await s.review.manage(s.fileId)).feedback.map((f) => f.message).find((text) => text.includes("# Plan Feedback"))!;
    expect(full).toContain(`(diagram: node 검토 (B), line ${diagram.line + 2})`);
    expect(full).toContain(`(diagram: edge 통과 (B → C), line ${diagram.line + 3})`);
    expect(full).toContain(`(diagram: whole flowchart, lines ${diagram.line + 1}–${diagram.line + 3})`);
    expect(full).toContain("[👍 좋아요] General feedback");
    expect(full).toContain(`(image region: ${image.src})`);
    expect(await failure(s.review.addComment(s.fileId, s.sid, { id: "real-dg-late", kind: "comment", text: "제출 뒤", diagram: node }))).toEqual({ status: 409, code: "AGENT_A_ALREADY_DECIDED" });
    // 거절된 댓글은 남지 않았다: 닫힌 검토를 다시 읽으면 넷 그대로다(실제 서버는 제출 뒤 초안 길을 닫으므로 검토 댓글 길로 읽는다)
    expect((await s.review.comments(s.fileId, s.sid, null))!.annotations.filter((a) => !a.ai).map((a) => a.id)).toEqual(["real-dg-node", "real-dg-edge", "real-dg-whole", "real-rg-good"]);
  }, 90_000);

  test("문서 대화 가르기와 AI 의 권한 요청: 허용·거절·멈춤", async () => {
    const s = await setup("실제: 가르기와 권한");
    for (const [id, prompt] of [["real-f-0001", "첫 질문"], ["real-f-0002", "둘째 질문"]] as const) await lines(await s.review.chatAsk(s.fileId, s.sid, { id, prompt }));
    const first = await s.review.chatHistory(s.fileId, s.sid);
    expect(first).toMatchObject({ branchedFrom: null, branchPoint: null });
    const forked = await s.review.chatFork(s.fileId, s.sid, { conversationId: first.conversationId, questionId: "real-f-0001", point: "answer" });
    expect(forked).toMatchObject({ branchedFrom: first.conversationId, branchPoint: { questionId: "real-f-0001", point: "answer" } });
    expect(forked.entries.map((e) => [e.id, e.answer])).toEqual([["real-f-0001", "문서 답: 첫 질문"]]);
    await lines(await s.review.chatAsk(s.fileId, s.sid, { id: "real-f-0003", prompt: "갈라서 묻기" }));
    expect((await s.review.chatHistory(s.fileId, s.sid)).entries.map((e) => e.id)).toEqual(["real-f-0001", "real-f-0003"]);
    expect((await s.review.chatHistory(s.fileId, s.sid, first.conversationId)).entries.map((e) => e.id)).toEqual(["real-f-0001", "real-f-0002"]);
    const asked = await s.review.chatFork(s.fileId, s.sid, { conversationId: first.conversationId, questionId: "real-f-0002", point: "question" });
    expect(asked.entries.map((e) => [e.id, e.answer, e.writing])).toEqual([["real-f-0001", "문서 답: 첫 질문", false], ["real-f-0002", "", false]]);
    expect((await s.review.chatSessions(s.fileId, s.sid)).filter((c) => c.current).map((c) => c.conversationId)).toEqual([asked.conversationId]);
    expect(await failed(s.review.chatFork(s.fileId, s.sid, { conversationId: first.conversationId, questionId: "no-such-question", point: "answer" }))).toMatchObject({ status: 404 });
    // 권한 요청: 화면이 읽을 칸만 넘어오고, 허용하면 답이 이어진다
    const allowed = stream(await s.review.chatAsk(s.fileId, s.sid, { id: "real-perm-01", prompt: "권한이 필요한 질문" }));
    const start = (await allowed.next()).value as Record<string, unknown>;
    const request = (await allowed.next()).value as Record<string, unknown>;
    expect(request).toEqual({ type: "permission", requestId: expect.stringMatching(/^perm-/), tool: "Bash", title: "명령 실행", detail: "ls docs" });
    expect(await failed(s.review.chatNew(s.fileId, s.sid))).toMatchObject({ status: 409 });
    await s.review.chatPermission(s.fileId, s.sid, { conversationId: start.conversationId as string, requestId: request.requestId as string, allow: true });
    const rest: Record<string, unknown>[] = [];
    for await (const e of allowed) rest.push(e);
    expect(rest.filter((e) => e.type === "delta").map((e) => e.text).join("")).toBe("허락을 받아 확인했습니다. 문서 답: 권한이 필요한 질문");
    expect(rest.at(-1)).toMatchObject({ type: "done", ok: true });
    expect(await failed(s.review.chatPermission(s.fileId, s.sid, { conversationId: start.conversationId as string, requestId: request.requestId as string, allow: true }))).toMatchObject({ status: 409, code: "AGENT_A_PERMISSION_NOT_PENDING" });
    // 거절
    const denied = stream(await s.review.chatAsk(s.fileId, s.sid, { id: "real-perm-02", prompt: "권한을 거절할 질문" }));
    const start2 = (await denied.next()).value as Record<string, unknown>;
    const request2 = (await denied.next()).value as Record<string, unknown>;
    await s.review.chatPermission(s.fileId, s.sid, { conversationId: start2.conversationId as string, requestId: request2.requestId as string, allow: false });
    const rest2: Record<string, unknown>[] = [];
    for await (const e of denied) rest2.push(e);
    expect(rest2.filter((e) => e.type === "delta").map((e) => e.text).join("")).toContain("허락을 받지 못해 확인하지 않았습니다.");
    // 기다리는 중에 멈춤
    const stopped = stream(await s.review.chatAsk(s.fileId, s.sid, { id: "real-perm-03", prompt: "권한을 기다리다 멈출 질문" }));
    const start3 = (await stopped.next()).value as Record<string, unknown>;
    expect(((await stopped.next()).value as Record<string, unknown>).type).toBe("permission");
    await s.review.chatAbort(s.fileId, s.sid, start3.conversationId as string);
    const tail: Record<string, unknown>[] = [];
    for await (const e of stopped) tail.push(e);
    expect(tail.find((e) => e.type === "error")).toMatchObject({ code: "aborted" });
    // 대화는 초안도 정본도 바꾸지 않는다
    expect(await s.review.draft(s.fileId, s.sid)).toMatchObject({ revision: 0, annotations: 0, editedMarkdown: null });
    expect((await s.review.manage(s.fileId)).artifactRevision).toBe(1);
  }, 90_000);

  // 독립 재검토 R1: 실제 Agent-A 가 초안을 저장한 뒤 응답만 끊긴 경우. 같은 요청은 다시 쓰지 않고 저장된 초안을 돌려준다.
  test("R1 초안 저장 뒤 응답 유실: 본문·검토 첨부의 같은 요청은 200 이고 초안은 한 번만 바뀐다. 기록 없이 통째로 쓴 다른 창의 저장 뒤에는 충돌이다", async () => {
    for (const kind of ["body", "attachments"] as const) {
      const s = await setup(`실제: R1 ${kind}`);
      const seen = await s.review.draft(s.fileId, s.sid);
      const image = kind === "attachments" ? [await s.review.upload(s.fileId, s.sid, { name: "own.png", mediaType: "image/png", base64: pngBase64(10, 10) })] : [];
      const run = () => (kind === "body"
        ? s.review.saveDraft(s.fileId, s.sid, { markdown: "한 번 저장할 초안", revision: seen.revision })
        : s.review.saveAttachments(s.fileId, s.sid, { attachments: image, revision: seen.revision }));
      s.loseOnce((path) => path === "/api/draft");
      expect(await failure(run())).toEqual({ status: 502, code: "AGENT_A_UNAVAILABLE" });
      const stored = await s.other("GET", "/api/draft");
      expect(stored.revision).toBe(String(seen.revision + 1));
      const again = await run();
      expect(again).toEqual({ revision: seen.revision + 1, editedMarkdown: kind === "body" ? "한 번 저장할 초안" : null, annotations: 0, attachments: image });
      expect(await s.other("GET", "/api/draft")).toEqual(stored);
      // 내 저장 뒤에 댓글이 더해져 초안 판이 또 올라도 같은 요청은 저장된 것으로 확인한다(Agent-A 가 주석을 더할 때 저장 기록을 그대로 둔다).
      await s.review.addComment(s.fileId, s.sid, { id: `r1-after-${kind}`, kind: "deletion", text: "", quote: "배경 문장 둘." });
      expect(await run()).toMatchObject({ revision: seen.revision + 2, annotations: 1 });
      // 다른 창이 저장 기록 없이 초안을 통째로 저장하면 같은 요청도 충돌이고, 그 저장은 그대로 남는다.
      await s.other("POST", "/api/draft", { draftGeneration: 0, annotations: [], globalAttachments: [], editedMarkdown: "다른 창 본문" });
      expect(await failure(run())).toEqual({ status: 409, code: "AGENT_A_DRAFT_CONFLICT" });
      expect((await s.other("GET", "/api/draft")).json!.editedMarkdown).toBe("다른 창 본문");
    }
    // 다른 창이 저장 기록 없이 먼저 저장했으면 값이 같아 보여도(빈 그림 목록·같은 본문) 내 요청의 결과가 아니다.
    const s = await setup("실제: R1 충돌");
    const seen = await s.review.draft(s.fileId, s.sid);
    expect((await s.other("POST", "/api/draft", { draftGeneration: 0, ifDraftRevision: seen.revision, annotations: [], globalAttachments: [], editedMarkdown: "다른 창 본문" })).status).toBe(200);
    expect(await failure(s.review.saveAttachments(s.fileId, s.sid, { attachments: [], revision: seen.revision }))).toEqual({ status: 409, code: "AGENT_A_DRAFT_CONFLICT" });
    expect(await failure(s.review.saveDraft(s.fileId, s.sid, { markdown: "다른 창 본문", revision: seen.revision }))).toEqual({ status: 409, code: "AGENT_A_DRAFT_CONFLICT" });
    // 저장 기록은 Agent-A 의 초안에만 남고, 제출 글·화면이 받는 초안에는 실리지 않는다.
    const mine = await s.review.draft(s.fileId, s.sid);
    await s.review.saveDraft(s.fileId, s.sid, { markdown: `${s.doc.canonical}\n\n덧붙임`, revision: mine.revision });
    expect(Object.keys(await s.review.draft(s.fileId, s.sid)).sort()).toEqual(["annotations", "attachments", "editedMarkdown", "revision"]);
    expect((await s.review.submit(s.fileId, s.sid, { revision: mine.revision + 1 })).ok).toBe(true);
  }, 60_000);

  // 독립 재검토(a474537)의 남은 조건: 저장 뒤 응답을 잃고, 다른 칸의 조건 저장이 끼어 초안 판이 또 오른 뒤의 재전송. 기록을 한 자리에만 둘 때는 409 였다.
  test("R1 중간 저장: 응답을 잃은 저장 뒤 다른 칸의 저장이 끼어도 처음 요청은 저장된 것으로 확인한다. 요청 id 가 다른 같은 값과 다시 바뀐 칸은 충돌이다", async () => {
    const CONFLICT = { status: 409, code: "AGENT_A_DRAFT_CONFLICT" };
    for (const kind of ["body", "attachments"] as const) {
      const s = await setup(`실제: R1 중간 ${kind}`);
      const seen = await s.review.draft(s.fileId, s.sid);
      const image = await s.review.upload(s.fileId, s.sid, { name: "own.png", mediaType: "image/png", base64: pngBase64(10, 10) });
      const run = (opId = `r1-lost-${kind}-0001`) => (kind === "body"
        ? s.review.saveDraft(s.fileId, s.sid, { markdown: "이미 들어간 본문", revision: seen.revision, opId })
        : s.review.saveAttachments(s.fileId, s.sid, { attachments: [image], revision: seen.revision, opId }));
      const middle = (revision: number, opId: string, clear = false) => (kind === "body"
        ? s.review.saveAttachments(s.fileId, s.sid, { attachments: clear ? [] : [image], revision, opId })
        : s.review.saveDraft(s.fileId, s.sid, { markdown: clear ? null : "나중 창의 본문", revision, opId }));
      s.loseOnce((path) => path === "/api/draft");
      expect(await failure(run())).toEqual({ status: 502, code: "AGENT_A_UNAVAILABLE" });
      // 새 초안 판에서 다른 칸이 저장된다
      expect((await middle(seen.revision + 1, `r1-middle-${kind}-01`)).revision).toBe(seen.revision + 2);
      const stored = await s.other("GET", "/api/draft");
      expect(stored.json!.iamceoSave).toMatchObject({ v: 1, body: [expect.any(String)], attachments: [expect.any(String)] });
      // 처음 요청을 그대로 다시 보낸다: 저장된 것으로 확인하고 지금 초안을 돌려준다. 초안도 초안 판도 그대로다.
      expect(await run()).toEqual({ revision: seen.revision + 2, editedMarkdown: kind === "body" ? "이미 들어간 본문" : "나중 창의 본문", annotations: 0, attachments: [image] });
      expect(await s.other("GET", "/api/draft")).toEqual(stored);
      // 끼어든 저장도 제 기록으로 확인된다
      expect((await middle(seen.revision + 1, `r1-middle-${kind}-01`)).revision).toBe(seen.revision + 2);
      // 다른 화면(다른 요청 id)이나 id 없는 호출이 같은 초안 판·같은 값을 보내면 충돌이고 아무것도 바뀌지 않는다
      expect(await failure(run(`r1-other-${kind}-0001`))).toEqual(CONFLICT);
      expect(await failure(kind === "body"
        ? s.review.saveDraft(s.fileId, s.sid, { markdown: "이미 들어간 본문", revision: seen.revision })
        : s.review.saveAttachments(s.fileId, s.sid, { attachments: [image], revision: seen.revision }))).toEqual(CONFLICT);
      expect(await s.other("GET", "/api/draft")).toEqual(stored);
      // 실제 Agent-A 가 댓글을 더할 때도, 다른 칸이 한 번 더 저장될 때도 앞 요청의 기록은 남는다
      await s.review.addComment(s.fileId, s.sid, { id: `r1-between-${kind}`, kind: "deletion", text: "", quote: "배경 문장 둘." });
      const more = await middle(seen.revision + 3, `r1-middle-${kind}-02`, true);
      expect(more.revision).toBe(seen.revision + 4);
      const later = await s.other("GET", "/api/draft");
      expect(await run()).toMatchObject({ revision: seen.revision + 4, annotations: 1 });
      expect(await s.other("GET", "/api/draft")).toEqual(later);
      // 그 칸의 값이 다시 바뀌면(앞 요청의 저장이 덮였다) 앞 요청은 충돌이고 바뀐 값이 남는다
      if (kind === "body") await s.review.saveDraft(s.fileId, s.sid, { markdown: "다른 화면이 고친 본문", revision: more.revision, opId: "r1-overwrite-body-01" });
      else await s.review.saveAttachments(s.fileId, s.sid, { attachments: [], revision: more.revision, opId: "r1-overwrite-attach-1" });
      const overwritten = await s.other("GET", "/api/draft");
      expect(await failure(run())).toEqual(CONFLICT);
      expect(await s.other("GET", "/api/draft")).toEqual(overwritten);
    }
  }, 60_000);

  // 독립 재확인(5f7f626)의 남은 조건: 이미 쓴 요청 id 에 지금 초안 판·다른 값을 붙이면 새 저장(200, 초안 판 +1)이 됐다.
  test("R1 요청 id 재사용: 기록에 남은 id 에 다른 입력을 붙이면 쓰지 않고 거절한다. 처음 입력의 재전송과 새 id 의 저장은 된다", async () => {
    const USED = { status: 409, code: "AGENT_A_IDEMPOTENCY_CONFLICT" };
    for (const kind of ["body", "attachments"] as const) {
      const s = await setup(`실제: R1 번호 ${kind}`);
      const base = (await s.review.draft(s.fileId, s.sid)).revision;
      const one = await s.review.upload(s.fileId, s.sid, { name: "one.png", mediaType: "image/png", base64: pngBase64(10, 10) });
      const two = await s.review.upload(s.fileId, s.sid, { name: "two.png", mediaType: "image/png", base64: pngBase64(11, 11) });
      const [first, changed] = kind === "body" ? ["첫 번호의 글", "다른 글"] : [[one], [one, two]];
      const body = (revision: number, markdown: string, opId: string) => s.review.saveDraft(s.fileId, s.sid, { markdown, revision, opId });
      const images = (revision: number, attachments: unknown, opId: string) => s.review.saveAttachments(s.fileId, s.sid, { attachments, revision, opId });
      const save = (revision: number, value: unknown, opId: string) => (kind === "body" ? body(revision, value as string, opId) : images(revision, value, opId));
      const beside = (revision: number, opId: string) => (kind === "body" ? images(revision, [two], opId) : body(revision, "옆 칸의 글", opId));
      const used = `r1-used-${kind}-0001`;
      expect((await save(base, first, used)).revision).toBe(base + 1);
      // 기록이 한 건뿐일 때(독립 재확인의 조건): 같은 id · 지금 초안 판 · 다른 값
      const single = await s.other("GET", "/api/draft");
      expect(single.json!.iamceoSave.ids).toEqual({ [single.json!.iamceoSave[kind][0]]: expect.stringMatching(/^[0-9a-f]{64}$/) });
      expect(await failure(save(base + 1, changed, used))).toEqual(USED);
      expect(await s.other("GET", "/api/draft")).toEqual(single);
      // 다른 칸의 저장과 실제 Agent-A 의 주석 추가가 끼어도 번호는 기록에 남는다
      expect((await beside(base + 1, `r1-beside-${kind}-001`)).revision).toBe(base + 2);
      await s.review.addComment(s.fileId, s.sid, { id: `r1-number-${kind}`, kind: "deletion", text: "", quote: "배경 문장 둘." });
      const stored = await s.other("GET", "/api/draft");
      const now = Number(stored.revision);
      expect(now).toBe(base + 3);
      expect(await failure(save(now, changed, used))).toEqual(USED);
      expect(await failure(save(now, first, used))).toEqual(USED);
      expect(await failure(beside(now, used))).toEqual(USED);
      expect(await failure(save(base, changed, used))).toEqual({ status: 409, code: "AGENT_A_DRAFT_CONFLICT" });
      // 거절은 아무것도 쓰지 않았다
      expect(await s.other("GET", "/api/draft")).toEqual(stored);
      // 처음 입력 그대로는 저장된 것으로 확인한다
      expect((await save(base, first, used)).revision).toBe(now);
      expect(await s.other("GET", "/api/draft")).toEqual(stored);
      // 새 id 의 지금 판 저장은 된다. 다른 칸과 주석은 그대로다.
      expect((await save(now, changed, `r1-fresh-${kind}-0001`)).revision).toBe(now + 1);
      const next = (await s.other("GET", "/api/draft")).json!;
      expect(next.annotations).toEqual(stored.json!.annotations);
      expect(next.annotations).toHaveLength(1);
      expect(kind === "body" ? next.globalAttachments : next.editedMarkdown).toEqual(kind === "body" ? stored.json!.globalAttachments : stored.json!.editedMarkdown);
      expect(kind === "body" ? next.editedMarkdown : next.globalAttachments).toEqual(changed);
    }
    // 요청 id 는 문서·검토에 묶는다: 그 초안을 기록까지 통째로 새 검토에 옮겨 써도, 그 검토에서는 쓴 적 없는 id 다.
    const s = await setup("실제: R1 번호 다른 검토");
    const base = (await s.review.draft(s.fileId, s.sid)).revision;
    await s.review.saveDraft(s.fileId, s.sid, { markdown: "옛 검토의 글", revision: base, opId: "r1-scope-number-01" });
    const raw = await s.other("GET", "/api/draft");
    const m = await s.review.manage(s.fileId);
    await s.review.contextUpdate(s.fileId, { opId: "r1-scope-context-01", goal: "새 검토를 여는 목표", constraints: [], contextRevision: m.contextRevision });
    const later = await s.review.open(s.fileId);
    expect(later.sessionId).not.toBe(s.sid);
    const head = { "x-enouv-artifact": s.artifactId, "x-enouv-review-session": later.sessionId, "content-type": "application/json" };
    expect((await fetch(`${REAL}/api/draft`, { method: "POST", headers: head, body: JSON.stringify({ ...raw.json, documents: undefined }) })).status).toBe(200);
    const there = (await s.review.draft(s.fileId, later.sessionId)).revision;
    expect(await s.review.saveDraft(s.fileId, later.sessionId, { markdown: "새 검토의 글", revision: there, opId: "r1-scope-number-01" })).toMatchObject({ revision: there + 1, editedMarkdown: "새 검토의 글" });
  }, 60_000);

  // 독립 재검토 R2: 문맥 판·배치 판 없이 보낸 요청이 저장된 뒤 응답을 잃고, 그사이 문맥(목표)이 바뀐 경우.
  test("R2 판을 생략한 직접 고치기·되살리기: 응답을 잃고 그사이 목표가 바뀌어도 같은 요청은 처음 결과다", async () => {
    for (const kind of ["edit", "restore"] as const) {
      const s = await setup(`실제: R2 ${kind}`);
      let m = await s.review.manage(s.fileId);
      let block = m.blocks[0]!;
      if (kind === "restore") {
        await s.review.edit(s.fileId, { blockId: block.id, revision: block.revision, title: block.title, body: "되살리기 전 새 본문", opId: `r2-prepare-${kind}-01`, contextRevision: m.contextRevision });
        m = await s.review.manage(s.fileId);
        block = m.blocks.find((b) => b.id === block.id)!;
      }
      const common = { opId: `r2-replay-${kind}-0001`, blockId: block.id, revision: block.revision };
      const run = (extra: { contextRevision?: number; layoutRevision?: number } = {}) => (kind === "edit"
        ? s.review.edit(s.fileId, { ...common, ...extra, title: block.title, body: "한 번만 적용" })
        : s.review.restore(s.fileId, { ...common, ...extra, historyRevision: 1 }));
      s.loseOnce((path) => path.endsWith("/commands"));
      expect(await failure(run())).toEqual({ status: 502, code: "AGENT_A_UNKNOWN" });
      await s.review.contextUpdate(s.fileId, { opId: `r2-between-${kind}-0001`, contextRevision: m.contextRevision, goal: "그사이 바뀐 목표", constraints: [] });
      const before = await s.review.manage(s.fileId);
      expect(before.contextRevision).toBe(m.contextRevision + 1);
      expect(await run()).toMatchObject({ ok: true });
      expect(await s.review.manage(s.fileId)).toEqual(before);
      expect(before.blocks.find((b) => b.id === block.id)!.revision).toBe(block.revision + 1);
      // 처음 명령이 쓴 판을 밝혀 다시 보내면 같은 명령, 지금 판을 밝히면 다른 명령이라 거절한다
      expect(await run({ contextRevision: m.contextRevision, ...(kind === "restore" ? { layoutRevision: m.layoutRevision } : {}) })).toMatchObject({ ok: true });
      expect(await failure(run({ contextRevision: before.contextRevision }))).toEqual({ status: 409, code: "AGENT_A_REVISION_CONFLICT" });
      expect(await s.review.manage(s.fileId)).toEqual(before);
    }
  }, 60_000);
});

describe.skipIf(!REAL || !ORIGINAL)("실제 원래 Agent-A(c559881): 안전하지 않은 쓰기를 거절한다", () => {
  test("새 댓글·삭제 표시·본문 고치기·검토 제출은 보내지 않고 거절하고, 다른 창의 초안은 그대로다. 읽기·분기·재전송은 된다", async () => {
    const s = await setup("원래: 거절");
    expect(s.doc.safeWrites).toBe(false);
    await s.other("POST", "/api/draft", { draftGeneration: 0, annotations: [{ id: "native-1", type: "COMMENT", text: "원래 화면의 댓글", originalText: "", createdA: Date.now() }], globalAttachments: [], editedMarkdown: "원래 화면의 초안" });
    for (const attempt of [
      () => s.review.addComment(s.fileId, s.sid, { id: "orig-c1", kind: "global", text: "댓글" }),
      () => s.review.addComment(s.fileId, s.sid, { id: "orig-d1", kind: "deletion", text: "", quote: "배경 문장 하나." }),
      () => s.review.saveDraft(s.fileId, s.sid, { markdown: "덮기", revision: 0 }),
      () => s.review.submit(s.fileId, s.sid, { revision: 0 }),
      () => s.review.draft(s.fileId, s.sid),
    ]) expect(await failure(attempt())).toEqual({ status: 409, code: "AGENT_A_UNSUPPORTED" });
    const draft = (await s.other("GET", "/api/draft")).json!;
    expect([draft.editedMarkdown, draft.annotations.map((a: { id: string }) => a.id)]).toEqual(["원래 화면의 초안", ["native-1"]]);
    expect((await s.review.open(s.fileId, s.sid)).closed).toBe(false);
    // 초안을 건드리지 않는 길은 그대로다
    expect((await s.review.comments(s.fileId, s.sid, null))!.annotations.map((a) => a.id)).toContain("native-1");
    const manage = await s.review.manage(s.fileId);
    const block = manage.blocks.find((b) => b.title === "계획")!;
    const input = { blockId: block.id, revision: block.revision, title: block.title, body: "직접 고친 본문", opId: "orig-edit-0001" };
    const first = await s.review.edit(s.fileId, input);
    expect(await s.review.edit(s.fileId, input)).toEqual(first);
    expect((await failure(s.review.branchCreate(s.fileId, { opId: "orig-branch-01", question: "질문", blockId: manage.blocks[0]!.id }))).status).toBe(200);
  }, 60_000);

  test("빠른 라벨과 검토 첨부는 거절하고(초안을 건드린다), 문서 관리의 블록 일과 대화 가르기는 그대로 된다", async () => {
    const s = await setup("원래: 새 기능");
    await s.other("POST", "/api/draft", { draftGeneration: 0, annotations: [], globalAttachments: [], editedMarkdown: "원래 화면의 초안" });
    const up = await s.review.upload(s.fileId, s.sid, { name: "a.png", mediaType: "image/png", base64: pngBase64(20, 10) });
    for (const attempt of [
      () => s.review.addComment(s.fileId, s.sid, { id: "orig-label-1", kind: "comment", text: "👍 좋아요", quote: "배경 문장 하나.", quickLabel: {} }),
      () => s.review.addComment(s.fileId, s.sid, { id: "orig-diagram-1", kind: "comment", text: "도식 댓글", diagram: { v: 1, family: "flowchart", kind: "node", id: "B", label: "검토", sourceLine: null } }),
      () => s.review.saveAttachments(s.fileId, s.sid, { attachments: [up], revision: 0 }),
    ]) expect(await failure(attempt())).toEqual({ status: 409, code: "AGENT_A_UNSUPPORTED" });
    const draft = (await s.other("GET", "/api/draft")).json!;
    expect([draft.editedMarkdown, draft.annotations, draft.globalAttachments]).toEqual(["원래 화면의 초안", [], []]);
    // 문서 관리의 블록 일은 초안과 상관없는 정본 명령이라 원래 Agent-A 에서도 된다
    let m = await s.review.manage(s.fileId);
    const plan = m.blocks.find((b) => b.title === "계획")!;
    expect(await s.review.blockReview(s.fileId, { blockId: plan.id, revision: 1, opId: "orig-reviewed-01" })).toEqual({ ok: true, reviewedRevision: 1 });
    await s.review.layoutSet(s.fileId, { opId: "orig-layout-01", blockId: plan.id, layout: { x: 10, y: 20, width: 300, height: 200 }, layoutRevision: m.layoutRevision });
    m = await s.review.manage(s.fileId);
    await s.review.blockInsert(s.fileId, { opId: "orig-insert-01", afterId: plan.id, kind: "markdown", title: "더한 블록", body: "더한 글", contextRevision: m.contextRevision, layoutRevision: m.layoutRevision });
    m = await s.review.manage(s.fileId);
    expect(m.blocks.map((b) => b.title)).toContain("더한 블록");
    expect(m.blocks.find((b) => b.id === plan.id)).toMatchObject({ reviewedRevision: 1, layout: { x: 10, y: 20, width: 300, height: 200 } });
    // 대화 가르기도 초안을 건드리지 않는다
    await lines(await s.review.chatAsk(s.fileId, s.sid, { id: "orig-q-0001", prompt: "첫 질문" }));
    const first = await s.review.chatHistory(s.fileId, s.sid);
    const forked = await s.review.chatFork(s.fileId, s.sid, { conversationId: first.conversationId, questionId: "orig-q-0001", point: "answer" });
    expect(forked.branchedFrom).toBe(first.conversationId);
  }, 60_000);
});
