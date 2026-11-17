// Agent-A 검토 길(서버): IAMCEO 화면 부품이 쓰는 댓글·답글·그림 영역·수정안·판·문서 관리가 Agent-A 검토 규약으로 옮겨지는지 본다.
// Agent-A 는 tests/fixtures/fake-agent-a-review.ts 의 가짜다(실제 AI 없음). 실제 Agent-A 서버 코드와의 왕복은 화면 시험에서 따로 본다.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../server/bus.ts";
import { openDb } from "../server/db.ts";
import { AgentAClient, AgentAService } from "../server/integrations/agent-a.ts";
import { AgentAReview, parseRegion, toAnnotation } from "../server/integrations/agent-a-review.ts";
import { ApiError, Store } from "../server/store.ts";
import { buildThreads, imageFor, myTurn, outline, regionOf, saveRequests, splitDoc, threadRoot, wordDiff } from "../web/src/lib/agent-a-review.ts";
import { fakeAgentAReview } from "./fixtures/fake-agent-a-review.ts";
import { pngBase64 } from "./fixtures/png.ts";

const MARKDOWN = "머리 문단입니다.\n\n## 배경\n\n배경 문장 하나. 배경 문장 둘.\n\n## 계획\n\n계획은 세 단계입니다. 같은 말 같은 말.";

async function setup(options: { appToken?: string | null; delay?: number } = {}) {
  const fake = fakeAgentAReview({ answerDelayMs: options.delay ?? 5, appToken: options.appToken ?? null });
  const store = new Store(openDb(join(mkdtempSync(join(tmpdir(), "iamceo-aa-review-")), "iamceo.db")), new Bus());
  const project = store.createProject({ name: "검토 시험", cwd: tmpdir() });
  const service = new AgentAService(store, new AgentAClient({ baseUrl: "http://127.0.0.1:4999", appToken: options.appToken ?? null, agentToken: null }, fake.transport));
  const review = new AgentAReview(service);
  const view = await service.createDoc(project.id, { title: "검토 문서", markdown: MARKDOWN, images: [{ title: "구성도", name: "map.png", mediaType: "image/png", base64: pngBase64(200, 100) }] });
  return { fake, store, project, service, review, fileId: view.fileId, artifactId: view.artifactId };
}
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const status = async (p: Promise<unknown>): Promise<number> => p.then(() => 200, (e) => (e instanceof ApiError ? e.status : -1));

describe("검토 길: 문서 열기", () => {
  test("지금 정본의 검토를 열고, 다시 열어도 같은 검토다. 그림은 Agent-A 가 아는 것만 돌려준다", async () => {
    const { review, fileId, fake } = await setup();
    const doc = await review.open(fileId);
    expect(doc).toMatchObject({ fileId, latest: true, title: "검토 문서", edited: false, artifactRevision: 1, closed: false, recoveries: [] });
    expect(doc.markdown).toContain("## 배경");
    expect(doc.images).toHaveLength(1);
    expect(doc.images[0]).toMatchObject({ width: 200, height: 100 });
    expect((await review.open(fileId)).sessionId).toBe(doc.sessionId);
    // 그림: 형식이 그림이고 이 검토의 것일 때만
    const res = await review.image(fileId, doc.sessionId, doc.images[0]!.src);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await status(review.image(fileId, doc.sessionId, "/api/config"))).toBe(404);
    expect(await status(review.image(fileId, doc.sessionId, `/assets/user/${"0".repeat(64)}/1`))).toBe(404);
    // 화면이 Agent-A 의 다른 길을 고르지 못한다: 부른 길은 정해진 검토 규약뿐이다
    expect(new Set(fake.calls.map((c) => c.path.replace(/iamceo-[A-Za-z0-9_-]+/, ":id")))).toEqual(new Set(["/api/assets", "/api/artifacts", "/api/artifacts/:id", "/api/plannotator/sessions", "/api/plan/revision", "/api/image"]));
  });

  test("이어지지 않은 자료·모양이 다른 검토 id·닿지 않는 서버는 뜻에 맞는 상태로 거절한다", async () => {
    const { review, fileId, fake, store, project } = await setup();
    const other = store.createFile({ projectId: project.id, title: "보통 자료", body: "x", kind: "document" });
    expect(await status(review.open(other.id))).toBe(404);
    expect(await status(review.comments(fileId, "not-a-session", null))).toBe(400);
    expect(await status(review.comments(fileId, crypto.randomUUID(), null))).toBe(409);
    fake.setDown(true);
    expect(await status(review.open(fileId))).toBe(502);
  });

  test("열쇠 방식: 서버가 열쇠를 붙여 부르고, 열쇠가 틀리면 502 로 알린다(열쇠 글은 싣지 않는다)", async () => {
    const good = await setup({ appToken: "user-key-for-tests-0000" });
    expect((await good.review.open(good.fileId)).latest).toBe(true);
    const fake = fakeAgentAReview({ appToken: "user-key-for-tests-0000" });
    const service = new AgentAService(good.store, new AgentAClient({ baseUrl: "http://127.0.0.1:4999", appToken: "wrong-key-for-tests-0000", agentToken: null }, fake.transport));
    const error = await new AgentAReview(service).open(good.fileId).catch((e) => e as ApiError);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(502);
    expect((error as ApiError).message).not.toContain("wrong-key");
  });
});

describe("검토 길: 댓글", () => {
  test("문장 댓글을 달면 Agent-A 가 답하고, 바뀐 것이 없으면 null 이다. 같은 id 를 다시 보내도 댓글은 하나다", async () => {
    const { review, fileId, fake } = await setup({ delay: 40 });
    const { sessionId } = await review.open(fileId);
    await review.addComment(fileId, sessionId, { id: "c-1", kind: "comment", text: "이 문장 뜻이 뭔가요?", quote: "배경 문장 하나." });
    await review.addComment(fileId, sessionId, { id: "c-1", kind: "comment", text: "이 문장 뜻이 뭔가요?", quote: "배경 문장 하나." });
    let list = (await review.comments(fileId, sessionId, null))!;
    expect(list.annotations.filter((a) => !a.ai)).toHaveLength(1);
    // 답을 쓰는 동안: 쓰는 중으로 보이고 글은 아직 답이 아니다
    expect(list.annotations.find((a) => a.ai)).toMatchObject({ writing: true, inReplyTo: "c-1", error: null });
    await settle(80);
    const next = (await review.comments(fileId, sessionId, list.version))!;
    expect(next.annotations.find((a) => a.ai)).toMatchObject({ writing: false, text: "시험 답: 이 문장 뜻이 뭔가요?", author: "Codex" });
    expect(next.annotations.find((a) => !a.ai)).toMatchObject({ id: "c-1", kind: "comment", quote: "배경 문장 하나.", resolved: false });
    expect(await review.comments(fileId, sessionId, next.version)).toBeNull();
    // 원래 화면과 같은 길: 초안에 주석이 남아 있다(Agent-A 원래 화면에서도 같은 댓글로 보인다)
    expect(fake.sessions[0]!.draft.annotations.map((a: { id: string }) => a.id)).toEqual(["c-1"]);
    list = next;
  });

  test("있던 초안(다른 주석·직접 편집·첨부)은 그대로 두고 주석만 더한다", async () => {
    const { review, fileId, fake } = await setup();
    const { sessionId } = await review.open(fileId);
    const session = fake.sessions.find((s) => s.id === sessionId)!;
    session.draft = { annotations: [{ id: "old-native", type: "COMMENT", text: "원래 화면에서 쓴 주석", originalText: "계획", createdA: 1 }], globalAttachments: [{ path: "/assets/x", name: "첨부" }], editedMarkdown: "# 직접 고친 초안\n\n배경 문장 하나.", custom: { keep: true } };
    session.draft_generation = 7;
    // 직접 편집 초안이 있으면 그 초안을 본문으로 연다
    expect(await review.open(fileId)).toMatchObject({ edited: true, markdown: "# 직접 고친 초안\n\n배경 문장 하나." });
    await review.addComment(fileId, sessionId, { id: "c-new", kind: "global", text: "전체 의견입니다" });
    expect(session.draft.annotations.map((a: { id: string }) => a.id)).toEqual(["old-native", "c-new"]);
    expect(session.draft).toMatchObject({ editedMarkdown: "# 직접 고친 초안\n\n배경 문장 하나.", globalAttachments: [{ path: "/assets/x", name: "첨부" }], custom: { keep: true } });
    expect(session.draft_generation).toBe(7);
    expect(session.draft.annotations[1]).toMatchObject({ type: "GLOBAL_COMMENT", originalText: "", text: "전체 의견입니다" });
    // 옛 주석은 새 질문이 아니다: 답을 시작하지 않는다
    expect(fake.rows.find((r) => r.annotation_id === "old-native")!.state).toBe("ignored");
  });

  test("답글·완료·다시 요청·갈라 내기·지우기", async () => {
    const { review, fileId } = await setup();
    const { sessionId } = await review.open(fileId);
    await review.addComment(fileId, sessionId, { id: "c-fail", kind: "comment", text: "이건 실패 시험", quote: "계획은 세 단계입니다." });
    await settle();
    let list = (await review.comments(fileId, sessionId, null))!;
    const failed = list.annotations.find((a) => a.ai)!;
    expect(failed).toMatchObject({ canRetry: true, writing: false, text: "" });
    expect(failed.error).toMatchObject({ code: "provider_failed" });
    await review.retry(fileId, sessionId, failed.id);
    await review.retry(fileId, sessionId, failed.id); // 두 번 눌러도 요청은 하나
    await settle();
    list = (await review.comments(fileId, sessionId, null))!;
    expect(list.annotations.filter((a) => a.ai && a.text.startsWith("다시 답"))).toHaveLength(1);
    expect(list.annotations.find((a) => a.id === failed.id)).toMatchObject({ canRetry: false });
    // 답글은 첫 댓글에 달고, 답에 단 답글은 거절된다
    const reply = await review.reply(fileId, sessionId, { inReplyTo: "c-fail", text: "한 번 더 설명해 주세요" });
    expect(await status(review.reply(fileId, sessionId, { inReplyTo: reply.id, text: "답글의 답글" }))).toBe(404);
    await settle();
    list = (await review.comments(fileId, sessionId, null))!;
    const threads = buildThreads(list.annotations);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.messages.map((m) => m.ai)).toEqual([false, true, false, true, false, true]);
    await review.setResolved(fileId, sessionId, "c-fail", true);
    expect((await review.comments(fileId, sessionId, null))!.annotations.find((a) => a.id === "c-fail")!.resolved).toBe(true);
    const fork = await review.fork(fileId, sessionId, "c-fail");
    list = (await review.comments(fileId, sessionId, null))!;
    expect(list.annotations.find((a) => a.id === fork.id)).toMatchObject({ branchOf: "이건 실패 시험", inReplyTo: null, resolved: false });
    await review.remove(fileId, sessionId, fork.id);
    expect((await review.comments(fileId, sessionId, null))!.annotations.some((a) => a.id === fork.id)).toBe(false);
  });

  test("그림 영역 질문: 그림 픽셀 기준의 영역이 그대로 가고, 그림 밖 영역·다른 그림은 서버가 거절한다", async () => {
    const { review, fileId, fake } = await setup();
    const doc = await review.open(fileId);
    const image = doc.images[0]!;
    const region = { v: 1 as const, src: image.src, sourceLine: image.sourceLine, naturalWidth: 200, naturalHeight: 100, box: { x: 10, y: 20, w: 80, h: 40 } };
    await review.addComment(fileId, doc.sessionId, { id: "c-region", kind: "comment", text: "이 부분은 뭔가요?", region });
    expect(fake.sessions[0]!.draft.annotations[0]).toMatchObject({ id: "c-region", originalText: "", imageRegion: region });
    const list = (await review.comments(fileId, doc.sessionId, null))!;
    expect(list.annotations.find((a) => a.id === "c-region")!.region).toEqual(region);
    expect(list.annotations.find((a) => a.ai)!.region).toBeNull();
    expect(await status(review.addComment(fileId, doc.sessionId, { id: "c-out", kind: "comment", text: "밖", region: { ...region, box: { x: 150, y: 20, w: 80, h: 40 } } }))).toBe(400);
    expect(await status(review.addComment(fileId, doc.sessionId, { id: "c-other", kind: "comment", text: "다른 주소", region: { ...region, src: "https://example.com/a.png" } }))).toBe(400);
    expect(parseRegion({ ...region, box: { x: 1.5, y: 0, w: 1, h: 1 } })).toBeNull();
  });

  test("AI 답이 꺼져 있으면 댓글은 저장되고 답은 없다. 답글은 Agent-A 의 거절 글로 알린다", async () => {
    const { review, fileId, fake } = await setup();
    const { sessionId } = await review.open(fileId);
    fake.setEnabled(false);
    await review.addComment(fileId, sessionId, { id: "c-off", kind: "global", text: "답 없이 남깁니다" });
    await settle();
    const list = (await review.comments(fileId, sessionId, null))!;
    expect(list.annotations).toHaveLength(1);
    const error = await review.reply(fileId, sessionId, { inReplyTo: "c-off", text: "답글" }).catch((e) => e as ApiError);
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).message).toBe("AI 답변이 비활성화되어 있습니다.");
  });

  test("Agent-A 가 준 모양에서 화면이 쓰는 칸만 옮긴다", () => {
    expect(toAnnotation({ id: "a", type: "GLOBAL_COMMENT", text: "글", originalText: "", createdA: 5, secret: "x", implementationProposal: "앱 수정" })).toEqual({
      id: "a", kind: "global", text: "글", quote: "", inReplyTo: null, ai: false, author: null, createdAt: 5, updatedAt: null, resolved: false, region: null, writing: false, error: null, canRetry: false, branchOf: null, extra: true, images: [], aiSettings: null, label: false, labelTip: null,
    });
    // 빠른 라벨: 표시와 지침을 옮긴다(AI 답에는 싣지 않는다)
    expect(toAnnotation({ id: "l", type: "COMMENT", text: "❓ 더 설명해 주세요", originalText: "고른 글", isQuickLabel: true, quickLabelTip: "예를 들어 설명" })).toMatchObject({ kind: "comment", label: true, labelTip: "예를 들어 설명" });
    expect(toAnnotation({ id: "m", type: "COMMENT", isAIReply: true, text: "답", isQuickLabel: true, quickLabelTip: "x" })).toMatchObject({ label: false, labelTip: null });
    expect(toAnnotation({ id: "b", isAIReply: true, text: "부분 답\n\n실패 [x]", answerText: "부분 답", answerError: { code: "request_timeout", message: "시간 초과" }, canRetry: true })).toMatchObject({ text: "부분 답", writing: false, error: { code: "request_timeout", message: "시간 초과" }, canRetry: true });
    expect(toAnnotation({ id: "c", isAIReply: true, text: "답변을 준비하고 있습니다…" })).toMatchObject({ writing: true });
    expect(toAnnotation({ text: "id 없음" })).toBeNull();
  });
});

describe("검토 길: 수정안·판·문서 관리", () => {
  test("댓글의 수정안을 정본에 저장하면 정본을 다시 읽어 확인하고, 본문이 바뀌어 새 검토가 열린다. 옛 댓글은 그 판에 남는다", async () => {
    const { review, fileId } = await setup();
    const first = await review.open(fileId);
    await review.addComment(fileId, first.sessionId, { id: "c-edit", kind: "comment", text: "이 문장 고쳐 주세요", quote: "배경 문장 하나." });
    await settle();
    const list = (await review.comments(fileId, first.sessionId, null))!;
    const answer = list.annotations.find((a) => a.ai)!;
    const [proposal] = await review.proposals(fileId, first.sessionId);
    expect(proposal).toMatchObject({ annotationId: answer.id, status: "pending", current: false });
    expect(proposal!.operations[0]).toMatchObject({ op: "replace", title: "배경", before: "배경 문장 하나. 배경 문장 둘.", after: "배경 문장 하나. (고침) 배경 문장 둘." });
    expect(buildThreads(list.annotations, [proposal!])[0]).toMatchObject({ needsDecision: true, done: false });
    // 다른 댓글의 수정안인 척할 수 없다
    expect(await status(review.approve(fileId, first.sessionId, { annotationId: "c-edit", proposalId: proposal!.proposalId }))).toBe(404);
    const saved = await review.approve(fileId, first.sessionId, { annotationId: answer.id, proposalId: proposal!.proposalId });
    expect(saved).toEqual({ ok: true, artifactRevision: 2, verified: true });
    // 다시 눌러도 한 번만 반영된다
    expect((await review.approve(fileId, first.sessionId, { annotationId: answer.id, proposalId: proposal!.proposalId })).artifactRevision).toBe(2);
    const second = await review.open(fileId);
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(second.markdown).toContain("배경 문장 하나. (고침)");
    expect(second.artifactRevision).toBe(2);
    // 새 판에는 옛 댓글이 보이지 않고, 어느 검토에 남았는지 알려 준다
    const fresh = (await review.comments(fileId, second.sessionId, null))!;
    expect(fresh.annotations).toEqual([]);
    expect(fresh.historical).toEqual([{ sessionId: first.sessionId, count: 1 }]);
    // 옛 검토는 그때 본문 그대로 다시 열린다
    const old = await review.open(fileId, first.sessionId);
    expect(old).toMatchObject({ latest: false, sessionId: first.sessionId });
    expect(old.markdown).not.toContain("(고침)");
    expect(second.recoveries.map((r) => r.sessionId)).toEqual([first.sessionId]);
    // 판: 본문이 달랐던 때마다 하나
    const versions = await review.versions(fileId, second.sessionId);
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    expect((await review.version(fileId, second.sessionId, 1)).markdown).not.toContain("(고침)");
    expect(await status(review.version(fileId, second.sessionId, 9))).toBe(404);
  });

  test("문서 관리: 수정안 보류·거절·저장, 이전 판 되살리기, 직접 고치기. 같은 요청 id 는 한 번만 반영된다", async () => {
    const { review, fileId } = await setup();
    const { sessionId } = await review.open(fileId);
    await review.addComment(fileId, sessionId, { id: "c-1", kind: "comment", text: "고쳐 주세요", quote: "계획은 세 단계입니다." });
    await settle();
    let manage = await review.manage(fileId);
    expect(manage.artifactRevision).toBe(1);
    expect(manage.blocks.map((b) => b.title)).toEqual(["검토 문서", "배경", "계획", "구성도"]);
    const p = manage.proposals[0]!;
    expect(p).toMatchObject({ status: "pending", applicable: true });
    expect(p.operations[0]).toMatchObject({ blockTitle: "계획", before: "계획은 세 단계입니다. 같은 말 같은 말." });
    expect(await review.decide(fileId, p.id, "held", "op-held-0001")).toMatchObject({ status: "held", verified: true, artifactRevision: 1 });
    expect(await status(review.decide(fileId, "no-such-proposal", "apply", "op-none-0001"))).toBe(404);
    const applied = await review.decide(fileId, p.id, "apply", "op-apply-0001");
    expect(applied).toMatchObject({ status: "applied", verified: true, artifactRevision: 2 });
    expect((await review.decide(fileId, p.id, "apply", "op-apply-0001")).artifactRevision).toBe(2);
    // 반영된 수정안은 거절로 바꿀 수 없다
    expect(await status(review.decide(fileId, p.id, "rejected", "op-reject-0001"))).toBe(409);
    manage = await review.manage(fileId);
    const plan = manage.blocks.find((b) => b.title === "계획")!;
    expect(plan).toMatchObject({ revision: 2, body: "계획은 세 단계입니다. (고침) 같은 말 같은 말." });
    expect(plan.history).toEqual([{ revision: 1, title: "계획", summary: "", body: "계획은 세 단계입니다. 같은 말 같은 말.", archived: false }]);
    // 화면이 본 판이 지금 판과 다르면 거절한다(그사이 바뀜)
    expect(await status(review.restore(fileId, { blockId: plan.id, revision: 1, historyRevision: 1, opId: "op-restore-0000" }))).toBe(409);
    expect(await review.restore(fileId, { blockId: plan.id, revision: 2, historyRevision: 1, opId: "op-restore-0001" })).toEqual({ ok: true, artifactRevision: 3 });
    expect(await status(review.edit(fileId, { blockId: plan.id, revision: 2, title: "계획", body: "늦은 고침", opId: "op-edit-0000" }))).toBe(409);
    expect(await review.edit(fileId, { blockId: plan.id, revision: 3, title: "계획(고침)", body: "직접 고친 본문", opId: "op-edit-0001" })).toEqual({ ok: true, artifactRevision: 4 });
    manage = await review.manage(fileId);
    expect(manage.blocks.find((b) => b.id === plan.id)).toMatchObject({ title: "계획(고침)", body: "직접 고친 본문", revision: 4 });
    expect(manage.blocks.find((b) => b.id === plan.id)!.history.map((h) => h.revision)).toEqual([1, 2, 3]);
    expect(manage.versions.map((v) => v.cause)).toEqual(["처음 연결한 판", "수정안 반영", "예전 판 되살림", "직접 고침"]);
  });
});

describe("검토 화면의 계산", () => {
  const note = (id: string, over: Partial<ReturnType<typeof toAnnotation> & object> = {}) => ({ ...toAnnotation({ id, type: "COMMENT", text: id, originalText: "", createdA: 1 })!, ...over });
  test("댓글 묶기: 안 끝난 것 먼저, 최근에 바뀐 것 먼저. 부모가 없는 답글도 잃지 않는다", () => {
    const list = [
      note("a", { createdAt: 1 }), note("a-ai", { inReplyTo: "a", ai: true, createdAt: 2, text: "답" }),
      note("b", { createdAt: 3, resolved: true }), note("c", { createdAt: 4 }), note("orphan", { inReplyTo: "gone", createdAt: 5 }),
      note("a-2", { inReplyTo: "a", createdAt: 9 }),
    ];
    expect(threadRoot(list, "a-2")).toBe("a");
    expect(threadRoot(list, "orphan")).toBe("orphan");
    const threads = buildThreads(list);
    expect(threads.map((t) => t.root.id)).toEqual(["a", "orphan", "c", "b"]);
    expect(threads[0]!.messages.map((m) => m.id)).toEqual(["a", "a-ai", "a-2"]);
    // 내 차례: 읽지 않은 마지막 답. 읽으면 빠지고, 답이 바뀌면 다시 나온다
    expect(myTurn(threads, {}).map((t) => t.answerId)).toEqual(["a-ai"]);
    expect(myTurn(threads, { "a-ai": "답" })).toEqual([]);
    expect(myTurn(threads, { "a-ai": "예전 답" })).toHaveLength(1);
  });
  test("본문 나누기·목차·영역·비교", () => {
    const src = `/assets/user/${"a".repeat(64)}/1`;
    const md = `# 제목\n\n글\n\n## 그림\n\n![구성\\]도](${src})\n\n설명\n\n\`\`\`\n## 코드 안\n![x](${src})\n\`\`\`\n\n### 끝`;
    expect(splitDoc(md).map((p) => p.kind)).toEqual(["markdown", "image", "markdown"]);
    expect(splitDoc(md)[1]).toEqual({ kind: "image", src, alt: "구성]도", line: 7 });
    expect(outline(md).map((h) => [h.level, h.text])).toEqual([[1, "제목"], [2, "그림"], [3, "끝"]]);
    const image = { src, width: 200, height: 100, sourceLine: 7 };
    expect(imageFor([{ ...image, sourceLine: 40 }, image], src, 8)).toBe(image);
    expect(regionOf(image, { x: 0.5, y: 0.25 }, { x: 0.1, y: 0.75 })).toEqual({ v: 1, src, sourceLine: 7, naturalWidth: 200, naturalHeight: 100, box: { x: 20, y: 25, w: 80, h: 50 } });
    // 그림 밖으로 끌어도 그림 안으로 자른다. 점은 영역이 아니다
    expect(regionOf(image, { x: -0.2, y: 0.9 }, { x: 1.4, y: 1.3 })!.box).toEqual({ x: 0, y: 90, w: 200, h: 10 });
    expect(regionOf(image, { x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 })).toBeNull();
    expect(wordDiff("배경 문장 하나. 둘.", "배경 문장 하나. (고침) 둘.")).toEqual([{ kind: "same", text: "배경 문장 하나. " }, { kind: "add", text: "(고침) " }, { kind: "same", text: "둘." }]);
    expect(wordDiff("가 나", "가 다").map((p) => p.kind)).toEqual(["same", "del", "add"]);
  });

  test("초안 저장의 요청 id: 같은 초안 판·같은 값은 같은 id 로 다시 보내고, 판이나 값이 달라지거나 저장이 끝나면 새 id 다", () => {
    let n = 0;
    const requests = saveRequests(() => `request-${++n}`);
    // 저장이 끝나지 않은(응답을 잃은) 같은 저장은 같은 요청이다
    expect([requests.id(3, "글"), requests.id(3, "글")]).toEqual(["request-1", "request-1"]);
    expect(requests.id(3, [["/a", "그림"]])).toBe("request-2");
    expect(requests.id(3, [["/a", "그림"]])).toBe("request-2");
    // 초안 판이나 값이 달라지면 새 요청이다. 앞 요청으로 돌아가도 새 id 다(마지막 저장만 기억한다)
    expect(requests.id(4, [["/a", "그림"]])).toBe("request-3");
    expect(requests.id(4, null)).toBe("request-4");
    expect(requests.id(3, "글")).toBe("request-5");
    // 저장이 끝난 뒤의 같은 저장은 새 요청이다
    requests.done();
    expect(requests.id(3, "글")).toBe("request-6");
    // 다른 화면(다른 묶음)은 같은 판·같은 값에도 다른 id 를 쓴다
    expect(saveRequests(() => "other-window").id(3, "글")).toBe("other-window");
  });
});
