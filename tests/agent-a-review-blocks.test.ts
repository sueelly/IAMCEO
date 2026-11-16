// Agent-A 검토 길(서버): 문서 관리의 블록 일 — 검토 표시 · 보관과 되살리기 · 새 블록(글·표·도식·그림) · 요약 고치기 · 순서와 배치 · 목표와 제약.
// Agent-A 는 tests/fixtures/fake-agent-a-review.ts 의 가짜다(명령 검사는 실제 엔진 src/domain/engine.js 의 차례를 옮겼다).
// 실제 Agent-A 서버 코드와의 대조는 tests/agent-a-review-real.test.ts 가 한다.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../server/bus.ts";
import { openDb } from "../server/db.ts";
import { AgentAClient, AgentAService } from "../server/integrations/agent-a.ts";
import { AgentAReview, tableBodyError } from "../server/integrations/agent-a-review.ts";
import { ApiError, Store } from "../server/store.ts";
import { fakeAgentAReview } from "./fixtures/fake-agent-a-review.ts";
import { pngBase64 } from "./fixtures/png.ts";

const MARKDOWN = "머리 문단입니다.\n\n## 배경\n\n배경 문장 하나. 배경 문장 둘.\n\n## 계획\n\n계획은 세 단계입니다.";
type Hook = (input: string, init: RequestInit, res: Response) => void | Promise<void>;

async function setup() {
  const fake = fakeAgentAReview({ answerDelayMs: 5 });
  const store = new Store(openDb(join(mkdtempSync(join(tmpdir(), "iamceo-aa-blocks-")), "iamceo.db")), new Bus());
  const project = store.createProject({ name: "블록 시험", cwd: tmpdir() });
  const hooks: { after?: Hook } = {};
  const transport = async (input: string, init: RequestInit) => {
    const res = await fake.transport(input, init);
    if (hooks.after) await hooks.after(input, init, res);
    return res;
  };
  const service = new AgentAService(store, new AgentAClient({ baseUrl: "http://127.0.0.1:4999", appToken: null, agentToken: null }, transport));
  const review = new AgentAReview(service);
  const view = await service.createDoc(project.id, { title: "블록 문서", markdown: MARKDOWN });
  const manage = () => review.manage(view.fileId);
  const block = async (title: string) => (await manage()).blocks.find((b) => b.title === title)!;
  /** 다음 명령 하나는 저장된 뒤 응답을 잃는다. */
  const loseNextCommand = () => {
    let lost = false;
    hooks.after = (input, init, res) => {
      if (!lost && init.method === "POST" && new URL(input).pathname.endsWith("/commands") && res.status === 200) {
        lost = true;
        throw new Error("저장 뒤 응답 유실(시험)");
      }
    };
  };
  return { fake, review, hooks, manage, block, loseNextCommand, fileId: view.fileId, artifactId: view.artifactId };
}
const failure = async (p: Promise<unknown>): Promise<{ status: number; code?: string; message?: string }> =>
  p.then(() => ({ status: 200 }), (e) => (e instanceof ApiError ? { status: e.status, code: e.code, message: e.message } : { status: -1, message: String(e) }));

describe("검토 표시", () => {
  test("지금 판을 '검토함'으로 표시하고, 블록이 고쳐지면 표시는 지난 판의 것이 된다", async () => {
    const s = await setup();
    const plan = await s.block("계획");
    expect(plan.reviewedRevision).toBeNull();
    const before = await s.manage();
    expect(await s.review.blockReview(s.fileId, { blockId: plan.id, revision: plan.revision, opId: "reviewed-0001" })).toEqual({ ok: true, reviewedRevision: 1 });
    const after = await s.manage();
    expect(after.blocks.find((b) => b.id === plan.id)!.reviewedRevision).toBe(1);
    // 본문·정본 판·배치 판은 그대로다
    expect([after.artifactRevision, after.layoutRevision, after.contextRevision]).toEqual([before.artifactRevision, before.layoutRevision, before.contextRevision]);
    // 같은 요청을 다시 보내면 같은 결과다
    expect(await s.review.blockReview(s.fileId, { blockId: plan.id, revision: plan.revision, opId: "reviewed-0001" })).toEqual({ ok: true, reviewedRevision: 1 });
    await s.review.edit(s.fileId, { blockId: plan.id, revision: 1, title: "계획", body: "고친 계획", opId: "edit-after-review" });
    const edited = await s.block("계획");
    expect(edited).toMatchObject({ revision: 2, reviewedRevision: 1 });
    // 화면이 본 판이 낡았으면 표시하지 않는다
    expect(await failure(s.review.blockReview(s.fileId, { blockId: plan.id, revision: 1, opId: "reviewed-0002" }))).toMatchObject({ status: 409, code: "AGENT_A_REVISION_CONFLICT" });
    expect(await failure(s.review.blockReview(s.fileId, { blockId: "no-such-block", revision: 1, opId: "reviewed-0003" }))).toMatchObject({ status: 404 });
    expect(await failure(s.review.blockReview(s.fileId, { blockId: plan.id, revision: 0, opId: "reviewed-0004" }))).toMatchObject({ status: 400 });
  });
});

describe("블록 보관과 되살리기", () => {
  test("보관하면 본문에서 빠지고 이전 판과 함께 남는다. 이전 판 되살리기로 돌아온다", async () => {
    const s = await setup();
    const start = await s.manage();
    const plan = start.blocks.find((b) => b.title === "계획")!;
    const input = { blockId: plan.id, revision: plan.revision, opId: "archive-0001", contextRevision: start.contextRevision, layoutRevision: start.layoutRevision };
    expect(await s.review.blockArchive(s.fileId, input)).toEqual({ ok: true, artifactRevision: start.artifactRevision + 1 });
    const archived = await s.manage();
    expect(archived.blocks.find((b) => b.id === plan.id)).toMatchObject({ archived: true, revision: 2, body: "계획은 세 단계입니다." });
    expect(archived.layoutRevision).toBe(start.layoutRevision + 1);
    expect((await s.review.open(s.fileId)).markdown).not.toContain("계획은 세 단계입니다.");
    // 같은 요청을 다시 보내면 처음 결과다(두 번 보관하지 않는다)
    expect(await s.review.blockArchive(s.fileId, input)).toEqual({ ok: true, artifactRevision: start.artifactRevision + 1 });
    // 이미 보관된 블록·낡은 판은 거절한다
    expect(await failure(s.review.blockArchive(s.fileId, { ...input, revision: 2, opId: "archive-0002", layoutRevision: archived.layoutRevision }))).toMatchObject({ status: 409 });
    expect(await failure(s.review.edit(s.fileId, { blockId: plan.id, revision: 2, title: "계획", body: "보관된 것 고치기", opId: "edit-archived" }))).toMatchObject({ status: 404 });
    // 되살리기: 보관 전 판(판 1)의 내용과 상태로 새 판을 만든다
    expect(await s.review.restore(s.fileId, { blockId: plan.id, revision: 2, historyRevision: 1, opId: "unarchive-0001", contextRevision: archived.contextRevision, layoutRevision: archived.layoutRevision })).toEqual({ ok: true, artifactRevision: start.artifactRevision + 2 });
    expect(await s.block("계획")).toMatchObject({ archived: false, revision: 3, body: "계획은 세 단계입니다." });
    expect((await s.review.open(s.fileId)).markdown).toContain("계획은 세 단계입니다.");
  });

  test("보관은 저장됐는데 응답만 잃어도, 같은 요청을 다시 보내면 한 번만 보관된다", async () => {
    const s = await setup();
    const start = await s.manage();
    const plan = start.blocks.find((b) => b.title === "계획")!;
    const input = { blockId: plan.id, revision: plan.revision, opId: "archive-lost-0001", contextRevision: start.contextRevision, layoutRevision: start.layoutRevision };
    s.loseNextCommand();
    expect(await failure(s.review.blockArchive(s.fileId, input))).toMatchObject({ status: 502, code: "AGENT_A_UNKNOWN" });
    expect(await s.review.blockArchive(s.fileId, input)).toEqual({ ok: true, artifactRevision: start.artifactRevision + 1 });
    expect(await s.block("계획")).toMatchObject({ archived: true, revision: 2 });
  });
});

describe("새 블록", () => {
  test("글 블록을 고른 블록 뒤와 맨 앞에 더한다. 같은 요청을 다시 보내도 블록은 하나다", async () => {
    const s = await setup();
    const start = await s.manage();
    const background = start.blocks.find((b) => b.title === "배경")!;
    const input = { opId: "insert-0001", afterId: background.id, kind: "markdown" as const, title: "새 근거", body: "새로 더한 문단입니다.", contextRevision: start.contextRevision, layoutRevision: start.layoutRevision };
    const made = await s.review.blockInsert(s.fileId, input);
    expect(made).toEqual({ ok: true, blockId: "iamceo-block-insert-0001", artifactRevision: start.artifactRevision + 1 });
    expect(await s.review.blockInsert(s.fileId, input)).toEqual(made);
    let now = await s.manage();
    const titles = () => now.blocks.filter((b) => !b.archived).map((b) => b.title);
    expect(titles().slice(titles().indexOf("배경"))).toEqual(["배경", "새 근거", "계획"]);
    expect(now.blocks.filter((b) => b.title === "새 근거")).toHaveLength(1);
    expect(now.blocks.find((b) => b.title === "새 근거")).toMatchObject({ kind: "markdown", revision: 1, summary: "", sources: [], reviewedRevision: null });
    await s.review.blockInsert(s.fileId, { opId: "insert-0002", afterId: null, kind: "markdown", title: "맨 앞", body: "처음에 둘 문단", contextRevision: now.contextRevision, layoutRevision: now.layoutRevision });
    now = await s.manage();
    expect(titles()[0]).toBe("맨 앞");
    expect((await s.review.open(s.fileId)).markdown).toContain("## 새 근거\n\n새로 더한 문단입니다.");
  });

  test("저장은 됐는데 응답만 잃은 새 블록도 다시 보내면 하나만 생긴다", async () => {
    const s = await setup();
    const start = await s.manage();
    const input = { opId: "insert-lost-0001", afterId: start.blocks.at(-1)!.id, kind: "markdown" as const, title: "한 번만", body: "한 번만 들어갈 문단", contextRevision: start.contextRevision, layoutRevision: start.layoutRevision };
    s.loseNextCommand();
    expect(await failure(s.review.blockInsert(s.fileId, input))).toMatchObject({ status: 502, code: "AGENT_A_UNKNOWN" });
    expect(await s.review.blockInsert(s.fileId, input)).toMatchObject({ ok: true, artifactRevision: start.artifactRevision + 1 });
    expect((await s.manage()).blocks.filter((b) => b.title === "한 번만")).toHaveLength(1);
  });

  test("표·도식·그림 블록: 표는 형식을 먼저 보고, 그림은 올린 그림의 정보를 싣는다", async () => {
    const s = await setup();
    let now = await s.manage();
    const base = () => ({ afterId: now.blocks.at(-1)!.id, contextRevision: now.contextRevision, layoutRevision: now.layoutRevision });
    expect(tableBodyError('{"headers":["가","나"],"rows":[["1",2],[true,null]]}')).toBeNull();
    expect(tableBodyError("표가 아님")).toBe("표 본문은 JSON 이어야 합니다");
    expect(tableBodyError('{"headers":["가"],"rows":[["1","2"]]}')).toBe("표의 줄마다 칸 수가 머리와 같아야 합니다");
    expect(await failure(s.review.blockInsert(s.fileId, { ...base(), opId: "table-bad-0001", kind: "table", title: "표", body: '{"headers":["가"],"rows":[["1","2"]]}' }))).toMatchObject({ status: 400 });
    await s.review.blockInsert(s.fileId, { ...base(), opId: "table-0001", kind: "table", title: "비교 표", body: '{"headers":["항목","값"],"rows":[["기간","2주"],["비용",0]]}' });
    now = await s.manage();
    await s.review.blockInsert(s.fileId, { ...base(), opId: "mermaid-0001", kind: "mermaid", title: "흐름", body: "flowchart LR\n  A --> B" });
    now = await s.manage();
    // 그림: 그림 없이·다른 종류에 그림을 실으면 거절
    expect(await failure(s.review.blockInsert(s.fileId, { ...base(), opId: "image-none-0001", kind: "image", title: "그림", body: "" }))).toMatchObject({ status: 400 });
    expect(await failure(s.review.blockInsert(s.fileId, { ...base(), opId: "image-wrong-0001", kind: "markdown", title: "글", body: "글", image: { name: "a.png", mediaType: "image/png", base64: pngBase64(8, 8) } }))).toMatchObject({ status: 400 });
    const image = { name: "shot.png", mediaType: "image/png", base64: pngBase64(40, 30) };
    await s.review.blockInsert(s.fileId, { ...base(), opId: "image-0001", kind: "image", title: "화면 그림", body: "그림 설명", image });
    // 같은 요청(같은 그림)을 다시 보내도 블록은 하나다
    await s.review.blockInsert(s.fileId, { ...base(), opId: "image-0001", kind: "image", title: "화면 그림", body: "그림 설명", image });
    now = await s.manage();
    expect(now.blocks.map((b) => b.kind).slice(-3)).toEqual(["table", "mermaid", "image"]);
    expect(now.blocks.filter((b) => b.kind === "image")).toHaveLength(1);
    const doc = await s.review.open(s.fileId);
    expect(doc.markdown).toContain("| 항목 | 값 |\n| --- | --- |\n| 기간 | 2주 |\n| 비용 | 0 |");
    expect(doc.markdown).toContain("```mermaid\nflowchart LR\n  A --> B\n```");
    expect(doc.images).toHaveLength(1);
    expect(doc.images[0]).toMatchObject({ width: 40, height: 30 });
    expect(doc.markdown).toContain(`![화면 그림](${doc.images[0]!.src})\n\n그림 설명`);
  });

  test("낡은 배치 판·보관된 블록 뒤·없는 블록 뒤에는 더하지 않는다", async () => {
    const s = await setup();
    const start = await s.manage();
    const plan = start.blocks.find((b) => b.title === "계획")!;
    const background = start.blocks.find((b) => b.title === "배경")!;
    await s.review.blockArchive(s.fileId, { blockId: plan.id, revision: 1, opId: "archive-anchor-0001" });
    const now = await s.manage();
    const input = { kind: "markdown" as const, title: "새 블록", body: "글" };
    expect(await failure(s.review.blockInsert(s.fileId, { ...input, opId: "insert-stale-0001", afterId: background.id, layoutRevision: start.layoutRevision, contextRevision: start.contextRevision }))).toMatchObject({ status: 409, code: "AGENT_A_REVISION_CONFLICT" });
    expect(await failure(s.review.blockInsert(s.fileId, { ...input, opId: "insert-anchor-0001", afterId: plan.id, layoutRevision: now.layoutRevision, contextRevision: now.contextRevision }))).toMatchObject({ status: 409 });
    expect(await failure(s.review.blockInsert(s.fileId, { ...input, opId: "insert-missing-0001", afterId: "no-such-block", layoutRevision: now.layoutRevision, contextRevision: now.contextRevision }))).toMatchObject({ status: 404 });
    expect(await failure(s.review.blockInsert(s.fileId, { ...input, title: "  ", opId: "insert-title-0001", afterId: null }))).toMatchObject({ status: 400 });
    expect((await s.manage()).blocks.some((b) => b.title === "새 블록")).toBe(false);
  });
});

describe("요약 고치기", () => {
  test("요약을 보내면 요약이 바뀌고, 보내지 않으면 그 판의 요약이 그대로 남는다", async () => {
    const s = await setup();
    const plan = await s.block("계획");
    await s.review.edit(s.fileId, { blockId: plan.id, revision: 1, title: "계획", summary: "세 단계 요약", body: plan.body, opId: "summary-0001" });
    expect(await s.block("계획")).toMatchObject({ revision: 2, summary: "세 단계 요약", body: "계획은 세 단계입니다." });
    expect((await s.review.open(s.fileId)).markdown).toContain("## 계획\n\n세 단계 요약\n\n계획은 세 단계입니다.");
    await s.review.edit(s.fileId, { blockId: plan.id, revision: 2, title: "계획", body: "본문만 고침", opId: "summary-0002" });
    const now = await s.block("계획");
    expect(now).toMatchObject({ revision: 3, summary: "세 단계 요약", body: "본문만 고침" });
    expect(now.history.map((h) => h.summary)).toEqual(["", "세 단계 요약"]);
    expect(await failure(s.review.edit(s.fileId, { blockId: plan.id, revision: 3, title: "계획", summary: "가".repeat(10_001), body: "x", opId: "summary-0003" }))).toMatchObject({ status: 400 });
  });

  test("근거는 읽는 글로만 보인다(제목 → 이름표 → 주소 → 블록 id 차례)", async () => {
    const s = await setup();
    const state = s.fake.artifacts.get(s.artifactId)!;
    state.blocks.find((b: { content: { title: string } }) => b.content.title === "계획").content.sources = [{ title: "근거 문서" }, { url: "https://example.com/a" }, { note: "기타" }];
    expect((await s.block("계획")).sources).toEqual(["근거 문서", "https://example.com/a", '{"note":"기타"}']);
  });
});

describe("순서와 배치", () => {
  test("읽는 순서를 바꾼다. 빠진 블록이 있거나 배치 판이 낡았으면 거절한다", async () => {
    const s = await setup();
    const start = await s.manage();
    const ids = start.blocks.map((b) => b.id);
    const reversed = [...ids].reverse();
    expect(await s.review.blocksReorder(s.fileId, { opId: "order-0001", blockIds: reversed, layoutRevision: start.layoutRevision })).toEqual({ ok: true, layoutRevision: start.layoutRevision + 1 });
    const now = await s.manage();
    expect(now.blocks.map((b) => b.id)).toEqual(reversed);
    // 본문은 그대로라 정본 판은 오르지 않는다
    expect(now.artifactRevision).toBe(start.artifactRevision);
    // 같은 요청을 다시 보내면 처음 결과다
    expect(await s.review.blocksReorder(s.fileId, { opId: "order-0001", blockIds: reversed, layoutRevision: start.layoutRevision })).toEqual({ ok: true, layoutRevision: start.layoutRevision + 1 });
    const stale = await failure(s.review.blocksReorder(s.fileId, { opId: "order-0002", blockIds: ids, layoutRevision: start.layoutRevision }));
    expect(stale).toMatchObject({ status: 409, code: "AGENT_A_REVISION_CONFLICT" });
    expect(stale.message).toContain("배치가 바뀌었습니다");
    expect(await failure(s.review.blocksReorder(s.fileId, { opId: "order-0003", blockIds: ids.slice(1), layoutRevision: now.layoutRevision }))).toMatchObject({ status: 400 });
    expect(await failure(s.review.blocksReorder(s.fileId, { opId: "order-0004", blockIds: [ids[0]!, ids[0]!], layoutRevision: now.layoutRevision }))).toMatchObject({ status: 400 });
    expect((await s.manage()).blocks.map((b) => b.id)).toEqual(reversed);
  });

  test("배치 보드: 블록의 자리와 크기를 정한다. 본문과 정본 판은 그대로다", async () => {
    const s = await setup();
    const start = await s.manage();
    const plan = start.blocks.find((b) => b.title === "계획")!;
    expect(plan.layout).toBeNull();
    const layout = { x: 40, y: 120.5, width: 480, height: 300 };
    expect(await s.review.layoutSet(s.fileId, { opId: "layout-0001", blockId: plan.id, layout, layoutRevision: start.layoutRevision })).toEqual({ ok: true, layoutRevision: start.layoutRevision + 1 });
    const now = await s.manage();
    expect(now.blocks.find((b) => b.id === plan.id)!.layout).toEqual(layout);
    expect([now.artifactRevision, now.blocks.find((b) => b.id === plan.id)!.revision]).toEqual([start.artifactRevision, 1]);
    // 낡은 배치 판은 거절하고(다른 창의 배치를 덮지 않는다), 크기가 0 이하면 받지 않는다
    expect(await failure(s.review.layoutSet(s.fileId, { opId: "layout-0002", blockId: plan.id, layout: { ...layout, x: 0 }, layoutRevision: start.layoutRevision }))).toMatchObject({ status: 409 });
    for (const bad of [{ ...layout, width: 0 }, { ...layout, height: -1 }, { ...layout, x: Number.NaN }, { ...layout, y: 1e9 }]) {
      expect(await failure(s.review.layoutSet(s.fileId, { opId: "layout-bad-0001", blockId: plan.id, layout: bad, layoutRevision: now.layoutRevision }))).toMatchObject({ status: 400 });
    }
    expect((await s.manage()).blocks.find((b) => b.id === plan.id)!.layout).toEqual(layout);
  });

  test("배치 저장 뒤 응답을 잃어도 같은 요청은 한 번만 반영된다", async () => {
    const s = await setup();
    const start = await s.manage();
    const plan = start.blocks.find((b) => b.title === "계획")!;
    const input = { opId: "layout-lost-0001", blockId: plan.id, layout: { x: 1, y: 2, width: 300, height: 200 }, layoutRevision: start.layoutRevision };
    s.loseNextCommand();
    expect(await failure(s.review.layoutSet(s.fileId, input))).toMatchObject({ status: 502, code: "AGENT_A_UNKNOWN" });
    expect(await s.review.layoutSet(s.fileId, input)).toEqual({ ok: true, layoutRevision: start.layoutRevision + 1 });
    expect((await s.manage()).layoutRevision).toBe(start.layoutRevision + 1);
  });
});

describe("목표와 제약", () => {
  test("목표와 제약을 고치면 문맥 판과 정본 판이 오르고 본문에 실린다. 낡은 문맥 판은 거절한다", async () => {
    const s = await setup();
    const start = await s.manage();
    expect(start.constraints).toEqual([]);
    expect(start.goal.length).toBeGreaterThan(0);
    const input = { opId: "context-0001", goal: "새 목표입니다", constraints: [" 첫째 제약 ", "", "둘째 제약"], contextRevision: start.contextRevision };
    expect(await s.review.contextUpdate(s.fileId, input)).toEqual({ ok: true, contextRevision: start.contextRevision + 1, artifactRevision: start.artifactRevision + 1 });
    expect(await s.review.contextUpdate(s.fileId, input)).toEqual({ ok: true, contextRevision: start.contextRevision + 1, artifactRevision: start.artifactRevision + 1 });
    const now = await s.manage();
    expect([now.goal, now.constraints]).toEqual(["새 목표입니다", ["첫째 제약", "둘째 제약"]]);
    expect((await s.review.open(s.fileId)).markdown).toContain("새 목표입니다\n\n- 첫째 제약\n- 둘째 제약");
    const stale = await failure(s.review.contextUpdate(s.fileId, { ...input, opId: "context-0002", goal: "덮으려는 목표" }));
    expect(stale).toMatchObject({ status: 409, code: "AGENT_A_REVISION_CONFLICT" });
    expect(stale.message).toContain("목표와 제약이 바뀌었습니다");
    expect(await failure(s.review.contextUpdate(s.fileId, { ...input, opId: "context-0003", goal: "  ", contextRevision: now.contextRevision }))).toMatchObject({ status: 400 });
    expect((await s.manage()).goal).toBe("새 목표입니다");
  });
});
