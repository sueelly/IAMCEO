// Agent-A 검토 길(서버): 독립 검토가 찾은 반례(F1 초안 경합 · F2 저장 뒤 응답 유실과 재전송 · F3 지난 판의 새 댓글)와
// 되살린 기능(삭제 표시 · AI 고르기 · 그림 붙이기 · 본문 직접 고치기 · 검토 제출 · 문서에 묻기 · 분기 · 피드백)을 본다.
// Agent-A 는 tests/fixtures/fake-agent-a-review.ts 의 가짜다. 가짜의 초안 규약은 실제와 같게 두 가지로 돌린다:
//   2 = 초안 보존 규약을 넣은 Agent-A, 1 = 원래 Agent-A(c559881: 초안 판이 없고 초안 저장이 늘 통째로 바꾼다).
// 실제 Agent-A 서버 코드와의 대조는 docs/agent-a/README.md 의 절차로 따로 한다.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../server/bus.ts";
import { openDb } from "../server/db.ts";
import { AgentAClient, AgentAService } from "../server/integrations/agent-a.ts";
import { AgentAReview, feedbackText } from "../server/integrations/agent-a-review.ts";
import { ApiError, Store } from "../server/store.ts";
import { splitDoc } from "../web/src/lib/agent-a-review.ts";
import { fakeAgentAReview } from "./fixtures/fake-agent-a-review.ts";
import { pngBase64 } from "./fixtures/png.ts";

const MARKDOWN = "머리 문단입니다.\n\n## 배경\n\n배경 문장 하나. 배경 문장 둘.\n\n## 계획\n\n계획은 세 단계입니다.";
type Hook = (input: string, init: RequestInit, res: Response) => void | Promise<void>;

async function setup(options: { draftProtocol?: 1 | 2; adapter?: boolean } = {}) {
  const fake = fakeAgentAReview({ answerDelayMs: 5, draftProtocol: options.draftProtocol ?? 2, adapter: options.adapter });
  const store = new Store(openDb(join(mkdtempSync(join(tmpdir(), "iamceo-aa-preserve-")), "iamceo.db")), new Bus());
  const project = store.createProject({ name: "보존 시험", cwd: tmpdir() });
  const hooks: { after?: Hook } = {};
  const transport = async (input: string, init: RequestInit) => {
    const res = await fake.transport(input, init);
    if (hooks.after) await hooks.after(input, init, res);
    return res;
  };
  const service = new AgentAService(store, new AgentAClient({ baseUrl: "http://127.0.0.1:4999", appToken: null, agentToken: null }, transport));
  const review = new AgentAReview(service);
  const view = await service.createDoc(project.id, { title: "보존 문서", markdown: MARKDOWN });
  const doc = await review.open(view.fileId);
  // 다른 창(원래 Agent-A 화면)이 직접 Agent-A 에 쓰는 것을 흉내 낸다. IAMCEO 를 거치지 않는다.
  const other = async (method: string, path: string, body?: unknown) => {
    const res = await fake.transport(`http://127.0.0.1:4999${path}`, { method, headers: { "x-enouv-artifact": view.artifactId, "x-enouv-review-session": doc.sessionId, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: res.status === 304 ? null : await res.json().catch(() => null), revision: res.headers.get("x-enouv-draft-revision") };
  };
  return { fake, store, project, service, review, hooks, other, fileId: view.fileId, artifactId: view.artifactId, doc, sid: doc.sessionId };
}
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const failure = async (p: Promise<unknown>): Promise<{ status: number; code?: string }> => p.then(() => ({ status: 200 }), (e) => (e instanceof ApiError ? { status: e.status, code: e.code } : { status: -1 }));
const pathOf = (input: string) => new URL(input).pathname;

describe("F1 초안 경합: 새 댓글이 다른 창의 초안을 덮지 않는다", () => {
  test("초안을 읽은 직후 다른 창이 같은 세대로 본문·주석·첨부를 저장해도 그 저장이 남고 내 댓글도 들어간다", async () => {
    const s = await setup();
    await s.other("POST", "/api/draft", { draftGeneration: 0, annotations: [], globalAttachments: [], editedMarkdown: "이전 초안" });
    let raced = false;
    s.hooks.after = async (input, init) => {
      // 원래 Agent-A 처럼 세대 번호는 그대로 둔 채(올리지 않고) 통째로 저장한다.
      if (!raced && pathOf(input) === "/api/draft" && init.method === "GET") {
        raced = true;
        const saved = await s.other("POST", "/api/draft", { draftGeneration: 0, editedMarkdown: "다른 창에서 고친 새 초안", globalAttachments: [{ name: "other.png", path: "/assets/fake" }],
          annotations: [{ id: "concurrent", type: "COMMENT", text: "다른 창 댓글", originalText: "", createdA: Date.now() }] });
        expect(saved.status).toBe(200);
      }
    };
    expect(await s.review.addComment(s.fileId, s.sid, { id: "ours", kind: "global", text: "검토 댓글" })).toEqual({ ok: true, id: "ours" });
    expect(raced).toBe(true);
    const draft = (await s.other("GET", "/api/draft")).json;
    expect(draft.editedMarkdown).toBe("다른 창에서 고친 새 초안");
    expect(draft.annotations.map((a: { id: string }) => a.id)).toEqual(["concurrent", "ours"]);
    expect(draft.globalAttachments).toEqual([{ name: "other.png", path: "/assets/fake" }]);
    // 통째 저장(POST /api/draft)은 댓글 길에서 한 번도 부르지 않는다
    expect(s.fake.calls.filter((c) => c.method === "POST" && c.path === "/api/draft/annotations")).toHaveLength(1);
  });

  test("내 댓글이 들어간 뒤 다른 창이 옛 초안을 통째로 저장해도 내 댓글과 답은 남는다(초안에서 빠져도 지워지지 않는다)", async () => {
    const s = await setup();
    await s.review.addComment(s.fileId, s.sid, { id: "ours", kind: "global", text: "남을 댓글" });
    await s.other("POST", "/api/draft", { draftGeneration: 0, annotations: [], globalAttachments: [], editedMarkdown: "다른 창의 다음 편집" });
    await settle();
    const list = (await s.review.comments(s.fileId, s.sid, null))!;
    expect(list.annotations.map((a) => a.text)).toEqual(["남을 댓글", "시험 답: 남을 댓글"]);
    expect((await s.other("GET", "/api/draft")).json.editedMarkdown).toBe("다른 창의 다음 편집");
  });

  test("같은 id·같은 내용의 재전송은 처음 결과를 확인하고(댓글 하나), 같은 id 에 다른 내용은 거절한다", async () => {
    const s = await setup();
    const req = { id: "same", kind: "comment" as const, text: "한 번만", quote: "배경 문장 하나." };
    expect((await failure(s.review.addComment(s.fileId, s.sid, req))).status).toBe(200);
    expect((await failure(s.review.addComment(s.fileId, s.sid, req))).status).toBe(200);
    expect(await failure(s.review.addComment(s.fileId, s.sid, { ...req, text: "다른 내용" }))).toEqual({ status: 409, code: "AGENT_A_IDEMPOTENCY_CONFLICT" });
    await settle();
    expect(s.fake.rows.filter((r) => r.annotation_id === "same")).toHaveLength(1);
    expect(s.fake.sessions[0]!.draft.annotations.filter((a: { id: string }) => a.id === "same")).toHaveLength(1);
  });

  test("초안 보존 규약을 모르는 원래 Agent-A 에는 새 댓글을 보내지 않고 거절한다(조용히 통째 저장하지 않는다)", async () => {
    const s = await setup({ draftProtocol: 1 });
    expect(s.doc.safeWrites).toBe(false);
    await s.other("POST", "/api/draft", { draftGeneration: 0, annotations: [], globalAttachments: [], editedMarkdown: "원래 화면의 초안" });
    const before = s.fake.calls.length;
    expect(await failure(s.review.addComment(s.fileId, s.sid, { id: "ours", kind: "global", text: "댓글" }))).toEqual({ status: 409, code: "AGENT_A_UNSUPPORTED" });
    // 읽기 한 번뿐이다. 쓰기는 하나도 가지 않았다.
    expect(s.fake.calls.slice(before)).toEqual([{ method: "GET", path: "/api/draft" }]);
    expect((await s.other("GET", "/api/draft")).json).toMatchObject({ editedMarkdown: "원래 화면의 초안", annotations: [] });
    expect(await failure(s.review.saveDraft(s.fileId, s.sid, { markdown: "덮기", revision: 0 }))).toEqual({ status: 409, code: "AGENT_A_UNSUPPORTED" });
    expect(await failure(s.review.submit(s.fileId, s.sid, { revision: 0 }))).toEqual({ status: 409, code: "AGENT_A_UNSUPPORTED" });
    // 읽기·수정안·판 같은 다른 길은 그대로다
    expect((await s.review.comments(s.fileId, s.sid, null))!.annotations).toEqual([]);
    expect((await s.review.manage(s.fileId)).blocks.length).toBeGreaterThan(0);
  });
});

describe("F2 저장 뒤 응답 유실: 같은 요청은 처음 결과를 확인한다", () => {
  test("직접 고치기: 저장은 됐는데 응답만 잃으면 502, 같은 요청을 다시 보내면 200 이고 판은 한 번만 오른다", async () => {
    const s = await setup();
    const block = (await s.review.manage(s.fileId)).blocks.find((b) => b.title === "계획")!;
    const input = { blockId: block.id, revision: block.revision, title: block.title, body: "한 번만 고친 본문", opId: "edit-lost-0001" };
    let lost = false;
    s.hooks.after = (input_, init, res) => {
      if (!lost && init.method === "POST" && pathOf(input_).endsWith("/commands") && res.status === 200) {
        lost = true;
        throw new Error("저장 뒤 응답 유실(시험)");
      }
    };
    expect(await failure(s.review.edit(s.fileId, input))).toEqual({ status: 502, code: "AGENT_A_UNKNOWN" });
    expect(await s.review.edit(s.fileId, input)).toMatchObject({ ok: true });
    const now = (await s.review.manage(s.fileId)).blocks.find((b) => b.id === block.id)!;
    expect(now).toMatchObject({ revision: block.revision + 1, body: "한 번만 고친 본문" });
    expect(now.history).toHaveLength(1);
    // 세 번째도 같은 결과(새 판을 또 만들지 않는다)
    expect(await s.review.edit(s.fileId, input)).toMatchObject({ ok: true });
    expect((await s.review.manage(s.fileId)).blocks.find((b) => b.id === block.id)!.revision).toBe(block.revision + 1);
  });

  test("되살리기도 같은 요청은 처음 결과를 확인한다", async () => {
    const s = await setup();
    const block = (await s.review.manage(s.fileId)).blocks.find((b) => b.title === "계획")!;
    await s.review.edit(s.fileId, { blockId: block.id, revision: block.revision, title: block.title, body: "고친 글", opId: "prepare-0001" });
    const input = { blockId: block.id, revision: block.revision + 1, historyRevision: block.revision, opId: "restore-same-0001" };
    expect(await s.review.restore(s.fileId, input)).toMatchObject({ ok: true });
    expect(await s.review.restore(s.fileId, input)).toMatchObject({ ok: true });
    const now = (await s.review.manage(s.fileId)).blocks.find((b) => b.id === block.id)!;
    expect(now.revision).toBe(block.revision + 2);
    expect(now.body).toBe("계획은 세 단계입니다.");
  });

  test("같은 요청 id 에 다른 내용, 새 요청의 낡은 판은 계속 거절한다(지금 판으로 바꿔 보내지 않는다)", async () => {
    const s = await setup();
    const block = (await s.review.manage(s.fileId)).blocks.find((b) => b.title === "계획")!;
    const input = { blockId: block.id, revision: block.revision, title: block.title, body: "처음 내용", opId: "edit-same-0001" };
    await s.review.edit(s.fileId, input);
    expect(await failure(s.review.edit(s.fileId, { ...input, body: "다른 내용" }))).toEqual({ status: 409, code: "AGENT_A_REVISION_CONFLICT" });
    // 새 요청(새 id)이 지난 판을 가리킨다
    expect(await failure(s.review.edit(s.fileId, { ...input, body: "늦은 수정", opId: "edit-late-0001" }))).toEqual({ status: 409, code: "AGENT_A_REVISION_CONFLICT" });
    // 이 문서에 없던 판
    expect(await failure(s.review.edit(s.fileId, { ...input, revision: block.revision + 7, opId: "edit-future-001" }))).toEqual({ status: 409, code: "AGENT_A_REVISION_CONFLICT" });
    const now = (await s.review.manage(s.fileId)).blocks.find((b) => b.id === block.id)!;
    expect(now).toMatchObject({ revision: block.revision + 1, body: "처음 내용" });
    // 명령은 요청의 판 그대로 간다
    expect(await failure(s.review.restore(s.fileId, { blockId: block.id, revision: block.revision, historyRevision: block.revision, opId: "restore-late-001" }))).toEqual({ status: 409, code: "AGENT_A_REVISION_CONFLICT" });
  });
});

describe("F3 지난 판: 새 댓글은 서버가 거절하고, 읽기와 답글은 남는다", () => {
  test("정본이 바뀐 뒤 옛 검토로 보낸 새 댓글은 409. 옛 댓글 읽기·답글과 지금 정본의 새 댓글은 된다", async () => {
    const s = await setup();
    await s.review.addComment(s.fileId, s.sid, { id: "root", kind: "global", text: "옛 판의 댓글" });
    await settle();
    const block = (await s.review.manage(s.fileId)).blocks.find((b) => b.title === "계획")!;
    await s.review.edit(s.fileId, { blockId: block.id, revision: block.revision, title: block.title, body: "새 정본 본문", opId: "new-canonical-01" });
    const latest = await s.review.open(s.fileId), old = await s.review.open(s.fileId, s.sid);
    expect(old.latest).toBe(false);
    expect(latest.sessionId).not.toBe(s.sid);
    expect(await failure(s.review.addComment(s.fileId, s.sid, { id: "late", kind: "global", text: "지난 판에 새 질문" }))).toEqual({ status: 409, code: "AGENT_A_REVISION_CONFLICT" });
    expect(await failure(s.review.addComment(s.fileId, s.sid, { id: "late-del", kind: "deletion", text: "", quote: "배경 문장 하나." }))).toEqual({ status: 409, code: "AGENT_A_REVISION_CONFLICT" });
    expect(s.fake.rows.some((r) => r.annotation_id === "late" || r.annotation_id === "late-del")).toBe(false);
    // 지난 판: 읽기와 있던 댓글의 답글
    expect((await s.review.comments(s.fileId, s.sid, null))!.annotations.map((a) => a.text)).toContain("옛 판의 댓글");
    expect((await failure(s.review.reply(s.fileId, s.sid, { inReplyTo: "root", text: "옛 판 댓글에 답글" }))).status).toBe(200);
    // 지난 판에서 보냈던 댓글의 재전송은 여전히 처음 결과를 확인한다
    expect((await failure(s.review.addComment(s.fileId, s.sid, { id: "root", kind: "global", text: "옛 판의 댓글" }))).status).toBe(200);
    // 지금 정본의 새 댓글
    expect((await failure(s.review.addComment(s.fileId, latest.sessionId, { id: "current", kind: "global", text: "지금 정본에 질문" }))).status).toBe(200);
  });

  test("확인과 쓰기 사이에 정본이 바뀌어도 새 댓글은 들어가지 않는다(Agent-A 가 쓰는 순간 다시 본다)", async () => {
    const s = await setup();
    const block = (await s.review.manage(s.fileId)).blocks.find((b) => b.title === "계획")!;
    let changed = false;
    s.hooks.after = async (input, init) => {
      if (!changed && pathOf(input) === "/api/draft" && init.method === "GET") {
        changed = true;
        // 초안을 읽은 직후(쓰기 직전) 다른 곳에서 정본이 바뀐다
        const state = s.fake.artifacts.get(s.artifactId)!;
        const b = state.blocks.find((x: { id: string }) => x.id === block.id);
        b.history.push({ revision: b.revision, content: structuredClone(b.content), archived: false });
        b.revision++;
        b.content = { ...b.content, body: "그사이 바뀐 정본" };
        state.artifact_revision++;
      }
    };
    expect(await failure(s.review.addComment(s.fileId, s.sid, { id: "raced", kind: "global", text: "쓰는 사이 바뀜" }))).toEqual({ status: 409, code: "AGENT_A_REVISION_CONFLICT" });
    expect(changed).toBe(true);
    expect(s.fake.rows.some((r) => r.annotation_id === "raced")).toBe(false);
  });
});

describe("되살린 기능: 삭제 표시 · AI 고르기 · 그림 붙이기", () => {
  test("삭제 표시는 고른 글이 있어야 하고 답을 시작하지 않는다. 글이 빈 댓글은 받지 않는다", async () => {
    const s = await setup();
    expect((await failure(s.review.addComment(s.fileId, s.sid, { id: "del", kind: "deletion", text: "", quote: "배경 문장 둘." }))).status).toBe(200);
    expect((await failure(s.review.addComment(s.fileId, s.sid, { id: "del-empty", kind: "deletion", text: "", quote: " " }))).status).toBe(400);
    expect((await failure(s.review.addComment(s.fileId, s.sid, { id: "empty", kind: "comment", text: "  ", quote: "배경" }))).status).toBe(400);
    await settle();
    const list = (await s.review.comments(s.fileId, s.sid, null))!;
    expect(list.annotations).toHaveLength(1);
    expect(list.annotations[0]).toMatchObject({ id: "del", kind: "deletion", quote: "배경 문장 둘.", text: "", ai: false });
  });

  test("AI 목록을 옮기고, 댓글·답글마다 고른 플랫폼·모델·추론 수준이 Agent-A 에 실린다", async () => {
    const s = await setup();
    const catalog = await s.review.aiCatalog(s.fileId, s.sid);
    expect(catalog).toMatchObject({ available: true, defaultProvider: "codex-sdk" });
    expect(catalog.providers.map((p) => p.id)).toEqual(["codex-sdk", "claude-agent-sdk"]);
    expect(catalog.providers[0]!.models[0]).toEqual({ id: "test-model", label: "Test model", default: true, efforts: [{ id: "low", label: "Low" }, { id: "high", label: "High" }], defaultEffort: "low" });
    await s.review.addComment(s.fileId, s.sid, { id: "picked", kind: "global", text: "고른 AI 로", ai: { providerId: "claude-agent-sdk", model: "claude-test" } });
    await settle();
    await s.review.reply(s.fileId, s.sid, { inReplyTo: "picked", text: "이번엔 높게", ai: { providerId: "codex-sdk", model: "test-model", reasoningEffort: "high" } });
    await settle();
    const list = (await s.review.comments(s.fileId, s.sid, null))!.annotations;
    expect(list.map((a) => a.text)).toEqual(["고른 AI 로", "시험 답: 고른 AI 로 [claude-agent-sdk/claude-test]", "이번엔 높게", "시험 답: 이번엔 높게 [codex-sdk/test-model/high]"]);
    expect(list[0]!.aiSettings).toEqual({ providerId: "claude-agent-sdk", model: "claude-test" });
    expect(list[2]!.aiSettings).toEqual({ providerId: "codex-sdk", model: "test-model", reasoningEffort: "high" });
    // 모르는 칸·긴 값은 받지 않는다
    expect((await failure(s.review.reply(s.fileId, s.sid, { inReplyTo: "picked", text: "x", ai: { tool: "shell" } as never }))).status).toBe(400);
  });

  test("그림을 올려 댓글에 붙이고, 이 검토의 댓글이 가리키는 그림만 내준다", async () => {
    const s = await setup();
    const up = await s.review.upload(s.fileId, s.sid, { name: "shot.png", mediaType: "image/png", base64: pngBase64(40, 30) });
    expect(up.path).toMatch(/^\/assets\/user\/[a-f0-9]{64}\/1$/);
    // 아직 어느 댓글에도 붙지 않은 그림은 내주지 않는다
    expect((await failure(s.review.attachment(s.fileId, s.sid, up.path))).status).toBe(404);
    await s.review.addComment(s.fileId, s.sid, { id: "with-image", kind: "global", text: "그림과 함께", images: [up] });
    await settle();
    const root = (await s.review.comments(s.fileId, s.sid, null))!.annotations[0]!;
    expect(root.images).toEqual([{ path: up.path, name: "shot.png" }]);
    const res = await s.review.attachment(s.fileId, s.sid, up.path);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    // 다른 주소·모르는 종류는 받지 않는다
    expect((await failure(s.review.attachment(s.fileId, s.sid, "/api/config"))).status).toBe(404);
    expect((await failure(s.review.addComment(s.fileId, s.sid, { id: "bad-image", kind: "global", text: "x", images: [{ path: "https://example.com/a.png", name: "a" }] }))).status).toBe(400);
    expect((await failure(s.review.upload(s.fileId, s.sid, { name: "a.svg", mediaType: "image/svg+xml", base64: "PHN2Zy8+" }))).status).toBe(400);
  });
});

describe("되살린 기능: 본문 직접 고치기(초안)와 검토 제출", () => {
  test("고친 본문은 초안으로만 남고 정본은 그대로다. 버리면 정본 본문으로 돌아간다", async () => {
    const s = await setup();
    const before = await s.review.draft(s.fileId, s.sid);
    expect(before).toEqual({ revision: 0, editedMarkdown: null, annotations: 0, attachments: [] });
    const saved = await s.review.saveDraft(s.fileId, s.sid, { markdown: `${s.doc.markdown}\n\n덧붙인 문단.`, revision: before.revision });
    expect(saved).toMatchObject({ revision: 1, annotations: 0 });
    const opened = await s.review.open(s.fileId);
    expect(opened).toMatchObject({ edited: true, sessionId: s.sid, artifactRevision: 1 });
    expect(opened.markdown).toContain("덧붙인 문단.");
    expect(opened.canonical).not.toContain("덧붙인 문단.");
    const discarded = await s.review.saveDraft(s.fileId, s.sid, { markdown: null, revision: saved.revision });
    expect(discarded.editedMarkdown).toBeNull();
    expect((await s.review.open(s.fileId)).edited).toBe(false);
  });

  test("고치는 사이 다른 창이 초안을 저장했으면 덮지 않고 거절한다. 주석·첨부는 고쳐 쓸 때 그대로 싣는다", async () => {
    const s = await setup();
    await s.review.addComment(s.fileId, s.sid, { id: "kept", kind: "global", text: "있던 댓글" });
    const mine = await s.review.draft(s.fileId, s.sid);
    await s.other("POST", "/api/draft", { draftGeneration: 0, editedMarkdown: "다른 창의 본문", globalAttachments: [{ name: "o.png", path: "/assets/o" }], annotations: s.fake.sessions[0]!.draft.annotations });
    expect(await failure(s.review.saveDraft(s.fileId, s.sid, { markdown: "내 본문", revision: mine.revision }))).toEqual({ status: 409, code: "AGENT_A_DRAFT_CONFLICT" });
    expect((await s.other("GET", "/api/draft")).json.editedMarkdown).toBe("다른 창의 본문");
    // 다시 읽은 판으로는 저장된다: 주석·첨부가 그대로다
    const theirs = await s.review.draft(s.fileId, s.sid);
    expect(theirs).toMatchObject({ editedMarkdown: "다른 창의 본문", annotations: 1, attachments: [{ path: "/assets/o", name: "o.png" }] });
    await s.review.saveDraft(s.fileId, s.sid, { markdown: "보고 덮은 본문", revision: theirs.revision });
    const draft = (await s.other("GET", "/api/draft")).json;
    expect(draft).toMatchObject({ editedMarkdown: "보고 덮은 본문", globalAttachments: [{ name: "o.png", path: "/assets/o" }] });
    expect(draft.annotations.map((a: { id: string }) => a.id)).toEqual(["kept"]);
    expect(draft.ifDraftRevision).toBeUndefined();
  });

  test("쓰기 직전에 다른 창이 저장해도(읽기와 쓰기 사이) Agent-A 가 조건 저장을 거절한다", async () => {
    const s = await setup();
    const mine = await s.review.draft(s.fileId, s.sid);
    let raced = false;
    s.hooks.after = async (input, init) => {
      if (!raced && pathOf(input) === "/api/draft" && init.method === "GET") {
        raced = true;
        await s.other("POST", "/api/draft", { draftGeneration: 0, annotations: [], globalAttachments: [], editedMarkdown: "사이에 끼어든 저장" });
      }
    };
    expect(await failure(s.review.saveDraft(s.fileId, s.sid, { markdown: "내 본문", revision: mine.revision }))).toEqual({ status: 409, code: "AGENT_A_DRAFT_CONFLICT" });
    expect((await s.other("GET", "/api/draft")).json.editedMarkdown).toBe("사이에 끼어든 저장");
  });

  test("검토 제출: 초안의 주석이 분기의 질문이 되고 검토가 닫힌다. 정본은 그대로이고, 같은 제출을 다시 보내면 처음 결과다", async () => {
    const s = await setup();
    await s.review.addComment(s.fileId, s.sid, { id: "c1", kind: "comment", text: "이 문장을 풀어 주세요", quote: "배경 문장 하나." });
    await s.review.addComment(s.fileId, s.sid, { id: "d1", kind: "deletion", text: "", quote: "배경 문장 둘." });
    const draft = await s.review.draft(s.fileId, s.sid);
    expect(draft.annotations).toBe(2);
    const sent = await s.review.submit(s.fileId, s.sid, { revision: draft.revision });
    expect(sent).toEqual({ ok: true, sent: 3, branches: 3 });
    expect(await s.review.submit(s.fileId, s.sid, { revision: draft.revision })).toEqual(sent);
    const manage = await s.review.manage(s.fileId);
    expect(manage.artifactRevision).toBe(1);
    expect(manage.branches).toHaveLength(3);
    expect(manage.feedback.map((f) => f.state)).toEqual(["not_sent", "not_sent", "not_sent"]);
    expect(manage.feedback[1]!.message).toContain("Delete the selected content.");
    const closed = await s.review.open(s.fileId, s.sid);
    expect(closed.closed).toBe(true);
    // 닫힌 검토에는 새 댓글·초안 고치기를 받지 않는다. 새로 열면 새 검토다.
    expect(await failure(s.review.addComment(s.fileId, s.sid, { id: "after", kind: "global", text: "제출 뒤" }))).toEqual({ status: 409, code: "AGENT_A_ALREADY_DECIDED" });
    expect((await failure(s.review.saveDraft(s.fileId, s.sid, { markdown: "x", revision: 99 }))).status).toBe(409);
    expect((await s.review.open(s.fileId)).sessionId).not.toBe(s.sid);
  });

  test("제출하려는 사이 다른 창이 초안을 바꿨으면 제출하지 않는다(그 댓글이 분기가 되지 못한 채 닫히지 않게)", async () => {
    const s = await setup();
    await s.review.addComment(s.fileId, s.sid, { id: "c1", kind: "global", text: "첫 댓글" });
    const draft = await s.review.draft(s.fileId, s.sid);
    await s.other("POST", "/api/draft", { draftGeneration: 0, globalAttachments: [], annotations: [...s.fake.sessions[0]!.draft.annotations, { id: "late", type: "COMMENT", text: "늦게 온 댓글", originalText: "", createdA: Date.now() }] });
    expect(await failure(s.review.submit(s.fileId, s.sid, { revision: draft.revision }))).toEqual({ status: 409, code: "AGENT_A_DRAFT_CONFLICT" });
    expect((await s.review.open(s.fileId, s.sid)).closed).toBe(false);
    expect((await s.review.manage(s.fileId)).branches).toHaveLength(0);
    const again = await s.review.draft(s.fileId, s.sid);
    expect((await s.review.submit(s.fileId, s.sid, { revision: again.revision })).sent).toBe(3);
  });

  test("제출 글은 주석 목록과 직접 고친 곳을 싣는다", () => {
    const text = feedbackText("가\n나\n다", [{ id: "a", type: "COMMENT", text: "풀어 주세요", originalText: "나" }, { id: "b", type: "DELETION", originalText: "다" }, { id: "c", type: "GLOBAL_COMMENT", text: "전체 의견" }], "가\n나 고침\n다", 1);
    expect(text).toContain("I've reviewed this document and have 3 pieces of feedback");
    expect(text).toContain('## 1. Feedback on: "나"');
    expect(text).toContain("## 2. Remove this");
    expect(text).toContain("## 3. General feedback");
    expect(text).toContain("# Direct Edits");
    expect(text).toContain("- 나\n+ 나 고침");
    expect(feedbackText("가", [], null, 0)).not.toContain("# Direct Edits");
  });
});

describe("되살린 기능: 문서에 묻기", () => {
  const read = async (res: Response) => (await res.text()).trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);

  test("질문하면 답이 조각으로 오고 대화에 남는다. Agent-A 의 흐름을 그대로 넘기지 않는다", async () => {
    const s = await setup();
    expect((await s.review.chatHistory(s.fileId, s.sid)).entries).toEqual([]);
    const res = await s.review.chatAsk(s.fileId, s.sid, { id: "q-000001", prompt: "이 문서의 요지는?", quote: "배경 문장 하나.", ai: { providerId: "codex-sdk", model: "test-model", reasoningEffort: "high" } });
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    const events = await read(res);
    expect(events[0]).toMatchObject({ type: "start" });
    expect(events.filter((e) => e.type === "delta").map((e) => e.text).join("")).toBe("문서 답: 이 문서의 요지는? [codex-sdk/test-model/high]");
    expect(events.at(-1)).toEqual({ type: "done", ok: true, text: "문서 답: 이 문서의 요지는? [codex-sdk/test-model/high]" });
    expect(new Set(events.map((e) => Object.keys(e).sort().join(",")))).toEqual(new Set(["conversationId,type", "text,type", "ok,text,type"]));
    const history = await s.review.chatHistory(s.fileId, s.sid);
    expect(history.conversationId).toBe(events[0]!.conversationId as string);
    expect(history.entries).toEqual([expect.objectContaining({ id: "q-000001", prompt: "이 문서의 요지는?", quote: "배경 문장 하나.", answer: "문서 답: 이 문서의 요지는? [codex-sdk/test-model/high]", writing: false, error: null })]);
    // 같은 질문 id 는 다시 받지 않는다(질문은 하나다)
    expect((await failure(s.review.chatAsk(s.fileId, s.sid, { id: "q-000001", prompt: "이 문서의 요지는?" }))).status).toBe(409);
    // 묻기는 정본도 초안도 바꾸지 않는다
    expect((await s.review.manage(s.fileId)).artifactRevision).toBe(1);
    expect(await s.review.draft(s.fileId, s.sid)).toMatchObject({ revision: 0, annotations: 0 });
  });

  test("실패한 답은 오류로 오고, 새 대화·앞 대화 고르기가 된다", async () => {
    const s = await setup();
    const failed = await read(await s.review.chatAsk(s.fileId, s.sid, { id: "q-fail-01", prompt: "실패하는 질문" }));
    expect(failed.find((e) => e.type === "error")).toMatchObject({ code: "provider_failed" });
    expect(failed.at(-1)).toMatchObject({ type: "done", ok: false });
    const first = (await s.review.chatHistory(s.fileId, s.sid)).conversationId;
    const fresh = await s.review.chatNew(s.fileId, s.sid);
    expect(fresh).toMatchObject({ entries: [] });
    expect(fresh.conversationId).not.toBe(first);
    const sessions = await s.review.chatSessions(s.fileId, s.sid);
    expect(sessions.map((c) => [c.conversationId, c.current])).toEqual([[first, false], [fresh.conversationId, true]]);
    expect((await s.review.chatSelect(s.fileId, s.sid, first)).entries).toHaveLength(1);
    expect((await failure(s.review.chatSelect(s.fileId, s.sid, "no-such-conversation"))).status).toBe(404);
    expect((await failure(s.review.chatAsk(s.fileId, s.sid, { id: "bad id", prompt: "x" }))).status).toBe(400);
  });
});

describe("되살린 기능: 문서 관리의 분기와 피드백", () => {
  test("블록에서 분기를 만들고, 후속 질문·답변 결정·닫기를 한다. 정본은 바뀌지 않는다", async () => {
    const s = await setup();
    const block = (await s.review.manage(s.fileId)).blocks.find((b) => b.title === "계획")!;
    const made = await s.review.branchCreate(s.fileId, { opId: "branch-0001", question: "세 단계가 무엇인가요?", blockId: block.id });
    // 같은 요청의 재전송은 같은 분기다
    expect(await s.review.branchCreate(s.fileId, { opId: "branch-0001", question: "세 단계가 무엇인가요?", blockId: block.id })).toEqual(made);
    await s.review.branchMessage(s.fileId, { opId: "follow-0001", branchId: made.branchId, text: "기간도 알려 주세요" });
    let manage = await s.review.manage(s.fileId);
    expect(manage.branches).toHaveLength(1);
    expect(manage.branches[0]).toMatchObject({ id: made.branchId, title: "세 단계가 무엇인가요?", status: "open", parentId: null, target: "계획" });
    expect(manage.branches[0]!.messages.map((m) => [m.role, m.body])).toEqual([["user", "세 단계가 무엇인가요?"], ["user", "기간도 알려 주세요"]]);
    expect(manage.feedback.map((f) => [f.message, f.state, f.branchTitle])).toEqual([["세 단계가 무엇인가요?", "not_sent", "세 단계가 무엇인가요?"], ["기간도 알려 주세요", "not_sent", "세 단계가 무엇인가요?"]]);

    // 피드백: 자료 준비 → 내보내기 → 수동 결과 가져오기
    const job = await s.review.feedbackPrepare(s.fileId, { opId: "batch-0001", feedbackIds: [manage.feedback[0]!.id], template: "짧게 답해 주세요" });
    expect(await s.review.feedbackPrepare(s.fileId, { opId: "batch-0001", feedbackIds: [manage.feedback[0]!.id], template: "짧게 답해 주세요" })).toEqual(job);
    const exported = await s.review.jobExport(s.fileId, job.jobId);
    expect(exported).toMatchObject({ receipt_id: job.jobId });
    // 자동 연동이 꺼진 Agent-A: 실행은 거절되고 수동 교환만 된다
    expect(await failure(s.review.jobRun(s.fileId, job.jobId))).toEqual({ status: 409, code: "AGENT_A_ADAPTER_OFF" });
    expect((await failure(s.review.importResult(s.fileId, { answers: [] }))).status).toBe(400);
    await s.review.importResult(s.fileId, { receipt_id: job.jobId, answers: [{ feedback_id: manage.feedback[0]!.id, body: "조사·설계·구현입니다." }], proposals: [] });
    manage = await s.review.manage(s.fileId);
    expect(manage.adapter).toBe(false);
    expect(manage.jobs).toEqual([{ id: job.jobId, state: "succeeded", error: null, feedback: 1 }]);
    expect(manage.feedback.map((f) => f.state)).toEqual(["succeeded", "not_sent"]);
    const answer = manage.branches[0]!.messages.find((m) => m.role === "assistant")!;
    expect(answer.body).toBe("조사·설계·구현입니다.");

    // 답변 채택과, 그 답변에서 갈라 낸 분기
    await s.review.branchDecide(s.fileId, { opId: "answer-0001", branchId: made.branchId, messageId: answer.id, decision: "accepted", reason: "충분함" });
    const child = await s.review.branchCreate(s.fileId, { opId: "branch-0002", question: "설계는 누가 하나요?", parent: { branchId: made.branchId, messageId: answer.id } });
    const closed = await s.review.branchClose(s.fileId, { opId: "close-0001", branchId: made.branchId, reason: "정리" });
    expect(closed).toEqual({ ok: true, unanswered: 1, openChildren: 1, unapplied: 0 });
    manage = await s.review.manage(s.fileId);
    expect(manage.branches.map((b) => [b.id, b.status, b.parentId, b.target])).toEqual([[made.branchId, "closed", null, "계획"], [child.branchId, "open", made.branchId, "앞 답변"]]);
    expect(manage.branches[0]!.messages.find((m) => m.id === answer.id)).toMatchObject({ decision: "accepted", reason: "충분함" });
    expect(manage.artifactRevision).toBe(1);
    // 변경 이력은 새것부터다: 마지막 일은 분기 닫기
    expect(manage.events.slice(0, 2).map((e) => e.type)).toEqual(["close_branch", "create_branch"]);

    // 다른 문서의 전송 기록은 다루지 않는다
    const otherDoc = await s.service.createDoc(s.project.id, { title: "다른 문서", markdown: "다른 본문" });
    expect((await failure(s.review.jobExport(otherDoc.fileId, job.jobId))).status).toBe(404);
    expect((await failure(s.review.branchCreate(s.fileId, { opId: "branch-0003", question: "x", blockId: "no-such-block" }))).status).toBe(404);
  });

  test("고른 수정안 여러 개는 한 번에 반영되고, 하나라도 안 되면 아무것도 바뀌지 않는다", async () => {
    const s = await setup();
    await s.review.addComment(s.fileId, s.sid, { id: "p1", kind: "comment", text: "고쳐 주세요", quote: "배경 문장 하나." });
    await s.review.addComment(s.fileId, s.sid, { id: "p2", kind: "comment", text: "이것도 고쳐 주세요", quote: "계획은 세 단계입니다." });
    await settle(80);
    let manage = await s.review.manage(s.fileId);
    const ids = manage.proposals.filter((p) => p.status === "pending").map((p) => p.id);
    expect(ids).toHaveLength(2);
    expect((await failure(s.review.applyMany(s.fileId, { opId: "many-bad-0001", proposalIds: [ids[0]!, "no-such-proposal"] }))).status).toBe(404);
    expect((await s.review.manage(s.fileId)).artifactRevision).toBe(1);
    const applied = await s.review.applyMany(s.fileId, { opId: "many-0001", proposalIds: ids });
    expect(applied).toMatchObject({ ok: true, verified: true });
    expect(await s.review.applyMany(s.fileId, { opId: "many-0001", proposalIds: ids })).toMatchObject({ ok: true, verified: true });
    manage = await s.review.manage(s.fileId);
    expect(manage.proposals.filter((p) => p.status === "applied")).toHaveLength(2);
    expect(manage.blocks.map((b) => b.body).join("\n")).toContain("배경 문장 하나. (고침)");
    expect(manage.blocks.map((b) => b.body).join("\n")).toContain("계획은 세 단계입니다. (고침)");
  });
});

describe("도식 블록", () => {
  test("mermaid 울타리는 도식 조각으로 따로 나누고, 다른 코드 울타리와 닫히지 않은 울타리는 글로 둔다", () => {
    const parts = splitDoc("앞 글\n\n```mermaid\ngraph TD\n  A-->B\n```\n\n```js\nconst a = '```mermaid';\n```\n\n뒤 글\n\n```mermaid\n닫히지 않음");
    expect(parts.map((p) => p.kind)).toEqual(["markdown", "mermaid", "markdown"]);
    expect(parts[1]).toEqual({ kind: "mermaid", code: "graph TD\n  A-->B" });
    expect((parts[2] as { text: string }).text).toContain("```js");
    expect((parts[2] as { text: string }).text).toContain("```mermaid\n닫히지 않음");
  });
});
