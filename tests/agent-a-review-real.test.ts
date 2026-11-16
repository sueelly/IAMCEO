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
import { AgentAReview } from "../server/integrations/agent-a-review.ts";
import { ApiError, Store } from "../server/store.ts";
import { pngBase64 } from "./fixtures/png.ts";

const REAL = process.env.IAMCEO_AGENT_A_REAL_URL ?? null;
const ORIGINAL = process.env.IAMCEO_AGENT_A_REAL_PROTOCOL === "1";
const MARKDOWN = "머리 문단입니다.\n\n## 배경\n\n배경 문장 하나. 배경 문장 둘.\n\n## 계획\n\n계획은 세 단계입니다.";

async function setup(title: string) {
  const store = new Store(openDb(join(mkdtempSync(join(tmpdir(), "iamceo-aa-real-")), "iamceo.db")), new Bus());
  const project = store.createProject({ name: "실제 규약 시험", cwd: tmpdir() });
  const service = new AgentAService(store, new AgentAClient({ baseUrl: REAL!, appToken: null, agentToken: null }));
  const review = new AgentAReview(service);
  const view = await service.createDoc(project.id, { title, markdown: MARKDOWN });
  const doc = await review.open(view.fileId);
  // 다른 창(원래 Agent-A 화면)이 직접 Agent-A 에 쓴다. IAMCEO 를 거치지 않는다.
  const other = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${REAL}${path}`, { method, headers: { "x-enouv-artifact": view.artifactId, "x-enouv-review-session": doc.sessionId, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, any> | null };
  };
  return { store, project, service, review, other, fileId: view.fileId, artifactId: view.artifactId, doc, sid: doc.sessionId };
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
});
