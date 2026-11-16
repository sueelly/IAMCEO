// Agent-A 검토 길(서버): 빠른 라벨 · 검토 전체에 붙인 그림 · 문서 대화 가르기 · AI 의 권한 요청에 답하기.
// Agent-A 는 tests/fixtures/fake-agent-a-review.ts 의 가짜다. 실제 Agent-A 서버 코드와의 대조는 tests/agent-a-review-real.test.ts 가 한다.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../server/bus.ts";
import { openDb } from "../server/db.ts";
import { AgentAClient, AgentAService } from "../server/integrations/agent-a.ts";
import { AgentAReview, feedbackText } from "../server/integrations/agent-a-review.ts";
import { ApiError, Store } from "../server/store.ts";
import { fakeAgentAReview } from "./fixtures/fake-agent-a-review.ts";
import { pngBase64 } from "./fixtures/png.ts";

const MARKDOWN = "머리 문단입니다.\n\n## 배경\n\n배경 문장 하나. 배경 문장 둘.\n\n## 계획\n\n계획은 세 단계입니다.";
type Hook = (input: string, init: RequestInit, res: Response) => void | Promise<void>;

async function setup(options: { draftProtocol?: 1 | 2 } = {}) {
  const fake = fakeAgentAReview({ answerDelayMs: 5, draftProtocol: options.draftProtocol ?? 2 });
  const store = new Store(openDb(join(mkdtempSync(join(tmpdir(), "iamceo-aa-extras-")), "iamceo.db")), new Bus());
  const project = store.createProject({ name: "덧붙임 시험", cwd: tmpdir() });
  const hooks: { after?: Hook } = {};
  const transport = async (input: string, init: RequestInit) => {
    const res = await fake.transport(input, init);
    if (hooks.after) await hooks.after(input, init, res);
    return res;
  };
  const service = new AgentAService(store, new AgentAClient({ baseUrl: "http://127.0.0.1:4999", appToken: null, agentToken: null }, transport));
  const review = new AgentAReview(service);
  const view = await service.createDoc(project.id, { title: "덧붙임 문서", markdown: MARKDOWN });
  const doc = await review.open(view.fileId);
  /** 다른 창(원래 Agent-A 화면)이 직접 Agent-A 에 쓰는 것을 흉내 낸다. */
  const other = async (method: string, path: string, body?: unknown) => {
    const res = await fake.transport(`http://127.0.0.1:4999${path}`, { method, headers: { "x-enouv-artifact": view.artifactId, "x-enouv-review-session": doc.sessionId, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  return { fake, review, hooks, other, fileId: view.fileId, artifactId: view.artifactId, sid: doc.sessionId };
}
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const failure = async (p: Promise<unknown>): Promise<{ status: number; code?: string; message?: string }> =>
  p.then(() => ({ status: 200 }), (e) => (e instanceof ApiError ? { status: e.status, code: e.code, message: e.message } : { status: -1, message: String(e) }));
/** 답 흐름을 줄 단위로 읽는다(끝까지 기다리지 않고 하나씩). */
async function* events(res: Response): AsyncGenerator<Record<string, unknown>> {
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

describe("빠른 라벨", () => {
  test("고른 글에 라벨을 댓글로 남긴다. 원래 화면과 같은 표시와 지침을 싣고, 다시 보내도 하나다", async () => {
    const s = await setup();
    const req = { id: "label-0001", kind: "comment" as const, text: "🔍 확인 필요", quote: "배경 문장 하나.", quickLabel: { tip: "추측입니다. 근거를 확인해 주세요." } };
    expect(await s.review.addComment(s.fileId, s.sid, req)).toEqual({ ok: true, id: "label-0001" });
    expect(await s.review.addComment(s.fileId, s.sid, req)).toEqual({ ok: true, id: "label-0001" });
    const stored = (await s.other("GET", "/api/draft")).json.annotations;
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: "label-0001", type: "COMMENT", text: "🔍 확인 필요", originalText: "배경 문장 하나.", isQuickLabel: true, quickLabelTip: "추측입니다. 근거를 확인해 주세요." });
    await settle();
    const list = (await s.review.comments(s.fileId, s.sid, null))!.annotations;
    expect(list.find((a) => a.id === "label-0001")).toMatchObject({ kind: "comment", label: true, labelTip: "추측입니다. 근거를 확인해 주세요.", quote: "배경 문장 하나." });
    // 지침이 없는 라벨
    await s.review.addComment(s.fileId, s.sid, { id: "label-0002", kind: "comment", text: "👍 좋아요", quote: "계획은 세 단계입니다.", quickLabel: {} });
    const plain = (await s.other("GET", "/api/draft")).json.annotations.find((a: { id: string }) => a.id === "label-0002");
    expect(plain.isQuickLabel).toBe(true);
    expect("quickLabelTip" in plain).toBe(false);
  });

  test("문서 전체·삭제 표시·여러 줄 글에는 라벨을 붙이지 않고, 원래 Agent-A 에는 보내지 않는다", async () => {
    const s = await setup();
    const label = { quickLabel: { tip: null } };
    expect(await failure(s.review.addComment(s.fileId, s.sid, { id: "label-g", kind: "global", text: "👍 좋아요", ...label }))).toMatchObject({ status: 400 });
    expect(await failure(s.review.addComment(s.fileId, s.sid, { id: "label-d", kind: "deletion", text: "", quote: "배경 문장 하나.", ...label }))).toMatchObject({ status: 400 });
    expect(await failure(s.review.addComment(s.fileId, s.sid, { id: "label-n", kind: "comment", text: "👍 좋아요\n둘째 줄", quote: "배경 문장 하나.", ...label }))).toMatchObject({ status: 400 });
    expect(await failure(s.review.addComment(s.fileId, s.sid, { id: "label-q", kind: "comment", text: "👍 좋아요", quote: "  ", ...label }))).toMatchObject({ status: 400 });
    expect(await failure(s.review.addComment(s.fileId, s.sid, { id: "label-t", kind: "comment", text: "👍 좋아요", quote: "배경 문장 하나.", quickLabel: { tip: "가".repeat(2_001) } }))).toMatchObject({ status: 400 });
    expect((await s.other("GET", "/api/draft")).status).toBe(404);
    const old = await setup({ draftProtocol: 1 });
    expect(await failure(old.review.addComment(old.fileId, old.sid, { id: "label-old", kind: "comment", text: "👍 좋아요", quote: "배경 문장 하나.", ...label }))).toMatchObject({ status: 409, code: "AGENT_A_UNSUPPORTED" });
    expect(old.fake.calls.some((c) => c.method === "POST" && c.path.startsWith("/api/draft"))).toBe(false);
  });

  test("제출 글: 라벨은 머리에 [라벨]로, 지침은 인용 줄로 싣고 끝에 라벨별 개수를 적는다", () => {
    const text = feedbackText("가\n나\n다", [
      { id: "a", type: "COMMENT", text: "🔍 확인 필요", originalText: "나", isQuickLabel: true, quickLabelTip: "근거를 확인" },
      { id: "b", type: "COMMENT", text: "🔍 확인 필요", originalText: "다", isQuickLabel: true },
      { id: "c", type: "COMMENT", text: "그냥 댓글", originalText: "가" },
    ], null, 0);
    expect(text).toContain('## 1. [🔍 확인 필요] Feedback on: "나"\n> 근거를 확인');
    expect(text).toContain('## 2. [🔍 확인 필요] Feedback on: "다"\n');
    expect(text).not.toContain("> 🔍 확인 필요");
    expect(text).toContain('## 3. Feedback on: "가"\n> 그냥 댓글');
    expect(text).toContain("## Label Summary\n\n- **🔍 확인 필요**: 2");
    expect(feedbackText("가", [{ id: "c", type: "COMMENT", text: "댓글", originalText: "가" }], null, 0)).not.toContain("Label Summary");
  });
});

describe("검토 전체에 붙인 그림", () => {
  test("올린 그림을 초안에 붙이고 뺀다. 고친 본문과 주석은 그대로 남고, 붙인 그림만 내준다", async () => {
    const s = await setup();
    await s.review.addComment(s.fileId, s.sid, { id: "keep-0001", kind: "global", text: "남을 댓글" });
    let draft = await s.review.saveDraft(s.fileId, s.sid, { markdown: "고친 본문", revision: (await s.review.draft(s.fileId, s.sid)).revision });
    const a = await s.review.upload(s.fileId, s.sid, { name: "a.png", mediaType: "image/png", base64: pngBase64(20, 10) });
    const b = await s.review.upload(s.fileId, s.sid, { name: "b.png", mediaType: "image/png", base64: pngBase64(30, 10) });
    // 올리기만 한 그림은 아직 내주지 않는다
    expect(await failure(s.review.attachment(s.fileId, s.sid, a.path))).toMatchObject({ status: 404 });
    draft = await s.review.saveAttachments(s.fileId, s.sid, { attachments: [a, b], revision: draft.revision });
    expect(draft).toMatchObject({ editedMarkdown: "고친 본문", annotations: 1, attachments: [a, b] });
    expect((await s.review.attachment(s.fileId, s.sid, a.path)).headers.get("content-type")).toBe("image/png");
    draft = await s.review.saveAttachments(s.fileId, s.sid, { attachments: [b], revision: draft.revision });
    expect(draft.attachments).toEqual([b]);
    const stored = (await s.other("GET", "/api/draft")).json;
    expect(stored).toMatchObject({ editedMarkdown: "고친 본문", globalAttachments: [b] });
    expect(stored.annotations.map((x: { id: string }) => x.id)).toEqual(["keep-0001"]);
    expect(await failure(s.review.saveAttachments(s.fileId, s.sid, { attachments: [b, b], revision: draft.revision }))).toMatchObject({ status: 400 });
    expect(await failure(s.review.saveAttachments(s.fileId, s.sid, { attachments: [{ path: "/assets/workbench-flow.svg", name: "x" }], revision: draft.revision }))).toMatchObject({ status: 400 });
    expect(await failure(s.review.saveAttachments(s.fileId, s.sid, { attachments: Array.from({ length: 11 }, () => a), revision: draft.revision }))).toMatchObject({ status: 400 });
  });

  test("그사이 다른 창이 초안을 저장했으면 붙이지 않는다(읽기 전·읽은 직후 모두). 그 창의 초안은 그대로다", async () => {
    const s = await setup();
    const a = await s.review.upload(s.fileId, s.sid, { name: "a.png", mediaType: "image/png", base64: pngBase64(20, 10) });
    const seen = (await s.review.draft(s.fileId, s.sid)).revision;
    await s.other("POST", "/api/draft", { draftGeneration: 0, annotations: [], globalAttachments: [], editedMarkdown: "다른 창의 초안" });
    expect(await failure(s.review.saveAttachments(s.fileId, s.sid, { attachments: [a], revision: seen }))).toMatchObject({ status: 409, code: "AGENT_A_DRAFT_CONFLICT" });
    // 읽은 직후(쓰기 직전)의 저장은 Agent-A 가 쓰는 순간 다시 보고 거절한다
    const now = (await s.review.draft(s.fileId, s.sid)).revision;
    let raced = false;
    s.hooks.after = async (input, init) => {
      if (!raced && new URL(input).pathname === "/api/draft" && init.method === "GET") {
        raced = true;
        await s.other("POST", "/api/draft", { draftGeneration: 0, annotations: [], globalAttachments: [{ name: "theirs.png", path: "/assets/fake" }], editedMarkdown: "읽은 직후의 다른 창 초안" });
      }
    };
    expect(await failure(s.review.saveAttachments(s.fileId, s.sid, { attachments: [a], revision: now }))).toMatchObject({ status: 409, code: "AGENT_A_DRAFT_CONFLICT" });
    expect(raced).toBe(true);
    expect((await s.other("GET", "/api/draft")).json).toMatchObject({ editedMarkdown: "읽은 직후의 다른 창 초안", globalAttachments: [{ name: "theirs.png", path: "/assets/fake" }] });
  });

  test("붙인 그림은 검토 제출 때 함께 넘어가고, 원래 Agent-A 에는 붙이지 않는다", async () => {
    const s = await setup();
    const a = await s.review.upload(s.fileId, s.sid, { name: "a.png", mediaType: "image/png", base64: pngBase64(20, 10) });
    const draft = await s.review.saveAttachments(s.fileId, s.sid, { attachments: [a], revision: 0 });
    await s.review.submit(s.fileId, s.sid, { revision: draft.revision, decision: "feedback" });
    const session = s.fake.sessions.find((x) => x.id === s.sid)!;
    expect(session.decision.original_payload.globalAttachments).toEqual([a]);
    expect(session.decision.original_payload.feedback).toContain("(review attachments: 1)");
    const old = await setup({ draftProtocol: 1 });
    const up = await old.review.upload(old.fileId, old.sid, { name: "a.png", mediaType: "image/png", base64: pngBase64(20, 10) });
    expect(await failure(old.review.saveAttachments(old.fileId, old.sid, { attachments: [up], revision: 0 }))).toMatchObject({ status: 409, code: "AGENT_A_UNSUPPORTED" });
  });
});

describe("문서 대화 가르기", () => {
  const ask = async (s: Awaited<ReturnType<typeof setup>>, id: string, prompt: string) => {
    for await (const _ of events(await s.review.chatAsk(s.fileId, s.sid, { id, prompt }))) void _;
  };

  test("답까지·질문까지 복사해 새 대화로 가른다. 원래 대화는 그대로 남는다", async () => {
    const s = await setup();
    await ask(s, "q-000001", "첫 질문");
    await ask(s, "q-000002", "둘째 질문");
    const first = await s.review.chatHistory(s.fileId, s.sid);
    expect(first).toMatchObject({ branchedFrom: null, branchPoint: null });
    const forked = await s.review.chatFork(s.fileId, s.sid, { conversationId: first.conversationId, questionId: "q-000001", point: "answer" });
    expect(forked.conversationId).not.toBe(first.conversationId);
    expect(forked).toMatchObject({ branchedFrom: first.conversationId, branchPoint: { questionId: "q-000001", point: "answer" } });
    expect(forked.entries.map((e) => [e.id, e.answer])).toEqual([["q-000001", "문서 답: 첫 질문"]]);
    // 새 대화가 지금 대화다. 이어서 물으면 새 대화에만 쌓인다.
    await ask(s, "q-000003", "갈라서 묻기");
    expect((await s.review.chatHistory(s.fileId, s.sid)).entries.map((e) => e.id)).toEqual(["q-000001", "q-000003"]);
    expect((await s.review.chatHistory(s.fileId, s.sid, first.conversationId)).entries.map((e) => e.id)).toEqual(["q-000001", "q-000002"]);
    // 질문까지만: 그 질문의 답은 비운 채로 가른다
    const asked = await s.review.chatFork(s.fileId, s.sid, { conversationId: first.conversationId, questionId: "q-000002", point: "question" });
    expect(asked.entries.map((e) => [e.id, e.answer, e.writing])).toEqual([["q-000001", "문서 답: 첫 질문", false], ["q-000002", "", false]]);
    expect(asked.branchPoint).toEqual({ questionId: "q-000002", point: "question" });
    const sessions = await s.review.chatSessions(s.fileId, s.sid);
    expect(sessions).toHaveLength(3);
    expect(sessions.filter((c) => c.current).map((c) => c.conversationId)).toEqual([asked.conversationId]);
    // 정본도 초안도 바뀌지 않는다
    expect((await s.review.manage(s.fileId)).artifactRevision).toBe(1);
    expect(await s.review.draft(s.fileId, s.sid)).toMatchObject({ revision: 0, annotations: 0 });
  });

  test("없는 질문·다른 문서의 대화·틀린 자리는 거절한다", async () => {
    const s = await setup();
    await ask(s, "q-000001", "첫 질문");
    const first = await s.review.chatHistory(s.fileId, s.sid);
    expect(await failure(s.review.chatFork(s.fileId, s.sid, { conversationId: first.conversationId, questionId: "no-such-question", point: "answer" }))).toMatchObject({ status: 404 });
    expect(await failure(s.review.chatFork(s.fileId, s.sid, { conversationId: "no-such-conversation", questionId: "q-000001", point: "answer" }))).toMatchObject({ status: 404 });
    expect(await failure(s.review.chatFork(s.fileId, s.sid, { conversationId: first.conversationId, questionId: "q-000001", point: "middle" as "answer" }))).toMatchObject({ status: 400 });
    expect(await s.review.chatSessions(s.fileId, s.sid)).toHaveLength(1);
  });
});

describe("AI 의 권한 요청", () => {
  test("허락을 구하면 화면이 읽을 칸만 넘기고, 허용하면 답이 이어진다. 답한 요청에 다시 답하면 거절한다", async () => {
    const s = await setup();
    const stream = events(await s.review.chatAsk(s.fileId, s.sid, { id: "q-perm-01", prompt: "권한이 필요한 질문" }));
    const start = (await stream.next()).value as Record<string, unknown>;
    expect(start).toMatchObject({ type: "start" });
    const asked = (await stream.next()).value as Record<string, unknown>;
    expect(asked).toEqual({ type: "permission", requestId: expect.stringMatching(/^perm-/), tool: "Bash", title: "명령 실행", detail: "ls docs" });
    const conversation = start.conversationId as string, requestId = asked.requestId as string;
    // 답하기 전에는 대화를 가르거나 새로 시작할 수 없다(답을 쓰는 중이다)
    expect(await failure(s.review.chatNew(s.fileId, s.sid))).toMatchObject({ status: 409 });
    expect(await s.review.chatPermission(s.fileId, s.sid, { conversationId: conversation, requestId, allow: true })).toEqual({ ok: true });
    const rest: Record<string, unknown>[] = [];
    for await (const e of stream) rest.push(e);
    expect(rest.filter((e) => e.type === "delta").map((e) => e.text).join("")).toBe("허락을 받아 확인했습니다. 문서 답: 권한이 필요한 질문");
    expect(rest.at(-1)).toMatchObject({ type: "done", ok: true });
    const again = await failure(s.review.chatPermission(s.fileId, s.sid, { conversationId: conversation, requestId, allow: true }));
    expect(again).toMatchObject({ status: 409, code: "AGENT_A_PERMISSION_NOT_PENDING", message: "이미 지난 권한 요청입니다" });
    expect(await failure(s.review.chatPermission(s.fileId, s.sid, { conversationId: conversation, requestId: "", allow: true }))).toMatchObject({ status: 400 });
  });

  test("거절하면 그 도구 없이 답하고, 기다리는 중에 멈추면 답이 멈춘다", async () => {
    const s = await setup();
    const denied = events(await s.review.chatAsk(s.fileId, s.sid, { id: "q-perm-02", prompt: "권한을 거절할 질문" }));
    const start = (await denied.next()).value as Record<string, unknown>;
    const asked = (await denied.next()).value as Record<string, unknown>;
    await s.review.chatPermission(s.fileId, s.sid, { conversationId: start.conversationId as string, requestId: asked.requestId as string, allow: false });
    const rest: Record<string, unknown>[] = [];
    for await (const e of denied) rest.push(e);
    expect(rest.filter((e) => e.type === "delta").map((e) => e.text).join("")).toContain("허락을 받지 못해 확인하지 않았습니다.");
    const stopped = events(await s.review.chatAsk(s.fileId, s.sid, { id: "q-perm-03", prompt: "권한을 기다리다 멈출 질문" }));
    const start2 = (await stopped.next()).value as Record<string, unknown>;
    const asked2 = (await stopped.next()).value as Record<string, unknown>;
    expect(asked2.type).toBe("permission");
    await s.review.chatAbort(s.fileId, s.sid, start2.conversationId as string);
    const tail: Record<string, unknown>[] = [];
    for await (const e of stopped) tail.push(e);
    expect(tail.find((e) => e.type === "error")).toMatchObject({ code: "aborted" });
    expect(tail.at(-1)).toMatchObject({ type: "done", ok: false });
    expect(await failure(s.review.chatPermission(s.fileId, s.sid, { conversationId: start2.conversationId as string, requestId: asked2.requestId as string, allow: true }))).toMatchObject({ status: 409 });
  });
});
