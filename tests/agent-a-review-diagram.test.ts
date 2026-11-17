// 도식의 한 부분에 다는 댓글(원래 Agent-A 화면의 diagramAnchor)과 그림 영역의 '좋아요' 라벨.
// 서버가 자리(부분의 이름·글·문서 줄)를 원래 화면과 같은 모양으로 싣고 다시 읽는지, 틀린 모양은 쓰지 않고 거절하는지 본다.
// 화면 쪽 계산(부분 목록 다듬기 · 문서 줄 찾기 · 다시 그렸을 때 부분 찾기)은 브라우저 없이 본다.
// Agent-A 는 tests/fixtures/fake-agent-a-review.ts 의 가짜다. 실제 Agent-A 서버 코드와의 대조는 tests/agent-a-review-real.test.ts 가 한다.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../server/bus.ts";
import { openDb } from "../server/db.ts";
import { AgentAClient, AgentAService } from "../server/integrations/agent-a.ts";
import { AgentAReview, feedbackText, parseDiagramAnchor, toAnnotation } from "../server/integrations/agent-a-review.ts";
import { ApiError, Store } from "../server/store.ts";
import type { AgentAReviewDiagramAnchor } from "../shared/agent-a.ts";
import { diagramLabel, mermaidBlocks, type MermaidBlock } from "../shared/agent-a-diagram.ts";
import { anchorFor, anchorText, cleanParts, findPart, ownerOf, sourceLineOf, type DiagramPart } from "../web/src/lib/agent-a-diagram.ts";
import { kindLabel, splitDoc } from "../web/src/lib/agent-a-review.ts";
import { fakeAgentAReview } from "./fixtures/fake-agent-a-review.ts";
import { pngBase64 } from "./fixtures/png.ts";

const FLOW = ["graph TD", "  A[시작] --> B[검토]", "  B -->|통과| C[끝]", "  subgraph G1 [묶음]", "    C", "  end"];
const MARKDOWN = ["머리 문단입니다.", "", "## 흐름", "", "```mermaid", ...FLOW, "```", "", "끝 문장입니다."].join("\n");
/** ```mermaid 줄의 문서 줄 번호(1부터). 도식 글의 k 번째 줄은 문서의 FENCE + k 번째 줄이다. */
const FENCE = 5;
/** 도식이 둘인 문서. 첫째와 둘째는 첫 줄 글도 부분 이름도 다르다. */
const TWO = ["## 첫째", "", "```mermaid", "flowchart TD", "  A[첫 도식] --> C[다른 부분]", "```", "", "## 둘째", "", "```mermaid", "flowchart LR", "  B[둘째 도식] --> D[끝]", "```"].join("\n");

async function setup(options: { draftProtocol?: 1 | 2 } = {}) {
  const fake = fakeAgentAReview({ answerDelayMs: 5, draftProtocol: options.draftProtocol ?? 2 });
  const store = new Store(openDb(join(mkdtempSync(join(tmpdir(), "iamceo-aa-diagram-")), "iamceo.db")), new Bus());
  const project = store.createProject({ name: "도식 댓글 시험", cwd: tmpdir() });
  // Agent-A 가 응답한 뒤에 끼어드는 고리: 서버가 초안을 읽은 뒤·쓰기 전에 다른 화면이 저장하는 경우를 만든다.
  const hooks: { after?: (path: string, method: string) => Promise<void> | void } = {};
  const transport: typeof fake.transport = async (url, init) => {
    const res = await fake.transport(url, init);
    await hooks.after?.(new URL(String(url)).pathname, String(init?.method ?? "GET"));
    return res;
  };
  const service = new AgentAService(store, new AgentAClient({ baseUrl: "http://127.0.0.1:4999", appToken: null, agentToken: null }, transport));
  const review = new AgentAReview(service);
  const view = await service.createDoc(project.id, { title: "도식 문서", markdown: MARKDOWN, images: [{ title: "구성도", name: "map.png", mediaType: "image/png", base64: pngBase64(400, 200) }] });
  const doc = await review.open(view.fileId);
  const drafted = (): Record<string, any>[] => fake.sessions.filter((s) => s.id === doc.sessionId).flatMap((s) => s.draft?.annotations ?? []);
  const writes = () => fake.sessions.find((s) => s.id === doc.sessionId)!.draft_revision ?? 0;
  /** 다른 창(원래 Agent-A 화면)이 IAMCEO 를 거치지 않고 Agent-A 에 직접 쓴다. */
  const other = async (method: string, path: string, body?: unknown): Promise<number> => (await fake.transport(`http://127.0.0.1:4999${path}`, { method, headers: { "x-enouv-artifact": view.artifactId, "x-enouv-review-session": doc.sessionId, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined })).status;
  /** 이 검토의 초안 전체와 초안 판(거절 뒤에 그대로인지 견준다). */
  const snapshot = () => JSON.stringify([writes(), fake.sessions.find((x) => x.id === doc.sessionId)!.draft]);
  return { fake, service, projectId: project.id, review, fileId: view.fileId, doc, sid: doc.sessionId, drafted, writes, other, hooks, snapshot };
}
/** 실제로 열린 문서에서 ```mermaid 줄의 줄 번호(1부터)와 마지막 줄 번호. */
const docLines = (markdown: string) => ({ fence: markdown.split("\n").indexOf("```mermaid") + 1, last: markdown.split("\n").length });
const failure = async (p: Promise<unknown>): Promise<{ status: number; code?: string }> => p.then(() => ({ status: 200 }), (e) => (e instanceof ApiError ? { status: e.status, code: e.code } : { status: -1 }));
const NODE_B: AgentAReviewDiagramAnchor = { v: 1, family: "flowchart", kind: "node", id: "B", label: "검토", sourceLine: [FENCE + 2, FENCE + 2] };
/** 실제로 열린 문서에서 노드 B 의 자리(화면이 만드는 것과 같다). */
const nodeB = (markdown: string): AgentAReviewDiagramAnchor => ({ ...NODE_B, sourceLine: [docLines(markdown).fence + 2, docLines(markdown).fence + 2] });
const REFUSED = { status: 400, code: "AGENT_A_DIAGRAM_NOT_IN_DOCUMENT" };
const BOX = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 };
/** 화면이 하는 대로 만든 자리: 도식 조각의 부분(이름이 없으면 도식 전체). */
const anchorIn = (b: MermaidBlock, id?: string, label = ""): AgentAReviewDiagramAnchor => anchorFor("flowchart", id === undefined ? null : { kind: "node", id, label, box: BOX, hits: [BOX] }, b.code, b.line);

describe("도식 부분 댓글(서버)", () => {
  test("부분의 자리를 원래 화면과 같은 모양(diagramAnchor)으로 싣고, 다시 읽으면 그 자리가 돌아온다", async () => {
    const s = await setup();
    // 자리의 줄은 실제로 열린 문서의 줄이다(Agent-A 가 머리말을 붙여 MARKDOWN 보다 뒤다)
    const { fence } = docLines(s.doc.markdown);
    const NODE_B = nodeB(s.doc.markdown);
    const edge: AgentAReviewDiagramAnchor = { v: 1, family: "flowchart", kind: "edge", from: "B", to: "C", label: "통과", sourceLine: [fence + 3, fence + 3] };
    const whole: AgentAReviewDiagramAnchor = { v: 1, family: "flowchart", kind: "diagram", label: "graph TD", sourceLine: [fence + 1, fence + FLOW.length] };
    const unlabelled: AgentAReviewDiagramAnchor = { v: 1, family: "flowchart", kind: "edge", from: "A", to: "B", label: "", sourceLine: null };
    await s.review.addComment(s.fileId, s.sid, { id: "diagram-node-1", kind: "comment", text: "이 단계는 누가 하나요?", diagram: NODE_B });
    await s.review.addComment(s.fileId, s.sid, { id: "diagram-edge-1", kind: "comment", text: "통과 기준이 뭔가요?", diagram: edge });
    await s.review.addComment(s.fileId, s.sid, { id: "diagram-whole-1", kind: "comment", text: "도식 전체가 너무 단순합니다", diagram: whole });
    // 고른 글(quote)을 같이 보내도 쓰지 않는다: 원문 칸은 부분의 글(없으면 양 끝, 없으면 이름)이다.
    await s.review.addComment(s.fileId, s.sid, { id: "diagram-edge-2", kind: "comment", text: "이 선은 왜 있나요?", quote: "화면이 보낸 다른 글", diagram: unlabelled });
    const stored = s.drafted();
    expect(stored.map((a) => [a.id, a.type, a.text, a.originalText, a.blockId, a.diagramAnchor])).toEqual([
      ["diagram-node-1", "COMMENT", "이 단계는 누가 하나요?", "검토", "", NODE_B],
      ["diagram-edge-1", "COMMENT", "통과 기준이 뭔가요?", "통과", "", edge],
      ["diagram-whole-1", "COMMENT", "도식 전체가 너무 단순합니다", "graph TD", "", whole],
      ["diagram-edge-2", "COMMENT", "이 선은 왜 있나요?", "A → B", "", unlabelled],
    ]);
    // 그림 영역·라벨 칸은 싣지 않는다
    for (const a of stored) expect(["imageRegion" in a, "isQuickLabel" in a]).toEqual([false, false]);
    const read = (await s.review.comments(s.fileId, s.sid, null))!.annotations.filter((a) => !a.ai);
    expect(read.map((a) => [a.id, a.kind, a.quote, a.diagram, a.region, a.label])).toEqual([
      ["diagram-node-1", "comment", "검토", NODE_B, null, false],
      ["diagram-edge-1", "comment", "통과", edge, null, false],
      ["diagram-whole-1", "comment", "graph TD", whole, null, false],
      ["diagram-edge-2", "comment", "A → B", unlabelled, null, false],
    ]);
    // 같은 id·같은 내용의 재전송은 댓글을 늘리지 않는다
    const before = s.writes();
    await s.review.addComment(s.fileId, s.sid, { id: "diagram-node-1", kind: "comment", text: "이 단계는 누가 하나요?", diagram: NODE_B });
    expect([s.drafted().length, s.writes()]).toEqual([4, before]);
    // 도식 댓글에도 Agent-A 가 답을 시작한다
    const answered = async () => (await s.review.comments(s.fileId, s.sid, null))!.annotations.filter((a) => a.ai).map((a) => a.inReplyTo).sort();
    for (let i = 0; i < 200 && (await answered()).length < 4; i++) await Bun.sleep(10);
    expect(await answered()).toEqual(["diagram-edge-1", "diagram-edge-2", "diagram-node-1", "diagram-whole-1"]);
  });

  test("틀린 자리는 쓰지 않고 거절한다. 삭제 표시·전체 댓글·그림 영역·라벨과 함께 보낸 것도 거절한다", async () => {
    const s = await setup();
    const long = "가".repeat(401);
    const bad: unknown[] = [
      "B", [], { ...NODE_B, v: 2 }, { ...NODE_B, family: "pie" }, { ...NODE_B, kind: "point" }, { ...NODE_B, id: undefined }, { ...NODE_B, id: "" }, { ...NODE_B, id: 7 },
      { ...NODE_B, id: long }, { ...NODE_B, label: long }, { ...NODE_B, label: 3 }, { ...NODE_B, sourceLine: [0, 1] }, { ...NODE_B, sourceLine: [3, 2] }, { ...NODE_B, sourceLine: [1.5, 2] },
      { ...NODE_B, sourceLine: 7 }, { ...NODE_B, sourceLine: [1, 2, 3] }, { ...NODE_B, extra: "x" }, { v: 1, family: "flowchart", kind: "edge", from: "A", label: "", sourceLine: null },
      { v: 1, family: "flowchart", kind: "diagram", id: "B", label: "graph TD", sourceLine: null },
    ];
    for (const diagram of bad) {
      expect([JSON.stringify(diagram)?.slice(0, 60), await failure(s.review.addComment(s.fileId, s.sid, { id: "diagram-bad-1", kind: "comment", text: "댓글", diagram: diagram as never }))])
        .toEqual([JSON.stringify(diagram)?.slice(0, 60), { status: 400, code: "AGENT_A_INVALID_DIAGRAM_ANCHOR" }]);
    }
    const region = { v: 1, src: s.doc.images[0]!.src, sourceLine: s.doc.images[0]!.sourceLine, naturalWidth: 400, naturalHeight: 200, box: { x: 10, y: 10, w: 50, h: 50 } } as const;
    expect((await failure(s.review.addComment(s.fileId, s.sid, { id: "diagram-bad-2", kind: "deletion", text: "", quote: "검토", diagram: NODE_B }))).status).toBe(400);
    expect((await failure(s.review.addComment(s.fileId, s.sid, { id: "diagram-bad-3", kind: "global", text: "댓글", diagram: NODE_B }))).status).toBe(400);
    expect((await failure(s.review.addComment(s.fileId, s.sid, { id: "diagram-bad-4", kind: "comment", text: "댓글", diagram: NODE_B, region }))).status).toBe(400);
    expect((await failure(s.review.addComment(s.fileId, s.sid, { id: "diagram-bad-5", kind: "comment", text: "👍 좋아요", diagram: NODE_B, quickLabel: { tip: null } }))).status).toBe(400);
    expect([s.drafted(), s.writes()]).toEqual([[], 0]);
  });

  test("초안 보존 규약을 모르는 원래 Agent-A 에는 도식 댓글도 보내지 않는다", async () => {
    const s = await setup({ draftProtocol: 1 });
    expect(await failure(s.review.addComment(s.fileId, s.sid, { id: "diagram-old-1", kind: "comment", text: "댓글", diagram: NODE_B }))).toEqual({ status: 409, code: "AGENT_A_UNSUPPORTED" });
    expect(s.drafted()).toEqual([]);
  });

  test("이 문서의 도식에 이어지지 않는 새 자리는 쓰지 않고 거절한다(모양 검사와 다른 검사)", async () => {
    const s = await setup();
    const refused = REFUSED;
    // 실제로 열린 문서의 줄(Agent-A 가 머리말을 붙여 MARKDOWN 보다 길다): ```mermaid 줄과 마지막 줄
    const { fence, last } = docLines(s.doc.markdown);
    const B = nodeB(s.doc.markdown);
    // 모양은 모두 맞다(diagramAnchorIn 을 지난다). 이 문서·이 도식에 이어지지 않을 뿐이다.
    const unbound: [string, AgentAReviewDiagramAnchor][] = [
      ["문서에 없는 줄", { ...B, sourceLine: [999_999, 999_999] }],
      ["문서 끝 다음 줄", { ...B, sourceLine: [last + 1, last + 1] }],
      ["문서 끝을 넘는 범위", { v: 1, family: "flowchart", kind: "diagram", label: "graph TD", sourceLine: [fence + 1, last + 1] }],
      ["어느 도식 글에도 없는 이름", { ...B, id: "없는이름", label: "없는 글" }],
      ["도식 글에 한 끝이 없는 선", { v: 1, family: "flowchart", kind: "edge", from: "A", to: "없음", label: "", sourceLine: [fence + 2, fence + 2] }],
      ["묶음(subgraph) 줄에 없는 이름의 묶음", { v: 1, family: "flowchart", kind: "cluster", id: "B", label: "검토", sourceLine: [fence + 2, fence + 2] }],
      ["어느 도식의 첫 줄도 아닌 글의 도식 전체", { v: 1, family: "flowchart", kind: "diagram", label: "sequenceDiagram", sourceLine: [fence + 1, fence + FLOW.length] }],
      ["줄은 있는데 글에서 찾을 수 없는 번호뿐인 선", { v: 1, family: "state", kind: "edge", id: "edge3", label: "", sourceLine: [fence + 2, fence + 2] }],
      // 줄이 그 도식의 그 부분 줄이어야 한다(화면이 자리를 만드는 규칙과 같다)
      ["문서 안이지만 도식 밖인 줄", { ...B, sourceLine: [1, 1] }],
      ["문서의 마지막 줄", { ...B, sourceLine: [last, last] }],
      ["이름이 나오지만 처음 적힌 줄이 아닌 줄", { ...B, sourceLine: [fence + 3, fence + 3] }],
      ["도식 글의 일부만 가리키는 도식 전체", { v: 1, family: "flowchart", kind: "diagram", label: "graph TD", sourceLine: [fence + 1, fence + 2] }],
      ["울타리 줄까지 가리키는 도식 전체", { v: 1, family: "flowchart", kind: "diagram", label: "graph TD", sourceLine: [fence, fence + FLOW.length] }],
      ["줄이 없는 도식 전체", { v: 1, family: "flowchart", kind: "diagram", label: "graph TD", sourceLine: null }],
    ];
    for (const [name, diagram] of unbound) {
      expect([name, await failure(s.review.addComment(s.fileId, s.sid, { id: "diagram-unbound-1", kind: "comment", text: "댓글", diagram }))]).toEqual([name, refused]);
    }
    expect([s.drafted(), s.writes()]).toEqual([[], 0]);
    // 도식이 없는 문서에는 줄이 없는 자리도 받지 않는다
    const plain = await s.service.createDoc(s.projectId, { title: "도식 없는 문서", markdown: "문단 하나.\n\n```ts\nconst B = 1;\n```\n" });
    const opened = await s.review.open(plain.fileId);
    for (const diagram of [B, { ...B, sourceLine: null }, { ...B, sourceLine: [4, 4] as [number, number] }]) {
      expect(await failure(s.review.addComment(plain.fileId, opened.sessionId, { id: "diagram-unbound-2", kind: "comment", text: "댓글", diagram }))).toEqual(refused);
    }
    expect(s.fake.sessions.find((x) => x.id === opened.sessionId)!.draft).toBeNull();
  });

  test("묶이는 자리는 받는다: 화면이 만든 자리, 줄이 없는 부분, 본문 초안의 줄. 갈래와 보이는 글은 가리지 않는다(남은 범위)", async () => {
    const s = await setup();
    const { fence, last } = docLines(s.doc.markdown);
    const B = nodeB(s.doc.markdown);
    const ok = async (id: string, diagram: AgentAReviewDiagramAnchor) => [id, (await failure(s.review.addComment(s.fileId, s.sid, { id, kind: "comment", text: "댓글", diagram }))).status];
    // 화면이 만든 자리(그 부분이 적힌 줄)와 줄이 없는 부분(글에서 이름을 찾지 못하는 부분)
    expect(await ok("diagram-bound-1", B)).toEqual(["diagram-bound-1", 200]);
    expect(await ok("diagram-bound-2", { v: 1, family: "flowchart", kind: "cluster", id: "G1", label: "묶음", sourceLine: [fence + 4, fence + 4] })).toEqual(["diagram-bound-2", 200]);
    expect(await ok("diagram-bound-3", { v: 1, family: "flowchart", kind: "diagram", label: "graph TD", sourceLine: [fence + 1, fence + FLOW.length] })).toEqual(["diagram-bound-3", 200]);
    expect(await ok("diagram-bound-4", { v: 1, family: "state", kind: "edge", id: "edge3", label: "", sourceLine: null })).toEqual(["diagram-bound-4", 200]);
    // 남은 범위(서버는 도식을 그리지 않는다): 줄과 이름이 그 도식의 것이면 갈래와 보이는 글은 가리지 않는다
    expect(await ok("diagram-loose-3", { ...B, family: "state" })).toEqual(["diagram-loose-3", 200]);
    expect(await ok("diagram-loose-4", { ...B, label: "그려진 글과 다른 글" })).toEqual(["diagram-loose-4", 200]);
    expect(s.drafted().map((a) => a.id)).toEqual(["diagram-bound-1", "diagram-bound-2", "diagram-bound-3", "diagram-bound-4", "diagram-loose-3", "diagram-loose-4"]);
    // 본문 초안이 있으면 화면은 그 글을 보이고 그 줄로 자리를 만든다: 정본에 없는 줄이어도 초안의 그 부분 줄이면 받는다
    const shifted = `${"앞에 넣은 줄\n".repeat(20)}${s.doc.markdown}`;
    const draft = await s.review.draft(s.fileId, s.sid);
    await s.review.saveDraft(s.fileId, s.sid, { markdown: shifted, revision: draft.revision, opId: "diagram-shift-0001" });
    const far: AgentAReviewDiagramAnchor = { ...B, sourceLine: [fence + 2 + 20, fence + 2 + 20] };
    expect([shifted.split("\n")[far.sourceLine![0] - 1], far.sourceLine![0] > last]).toEqual(["  A[시작] --> B[검토]", true]);
    expect(await ok("diagram-bound-5", far)).toEqual(["diagram-bound-5", 200]);
    // 초안이 있으면 정본의 줄은 받지 않는다(정본에는 맞아도 지금 보이는 본문의 그 줄은 도식이 아니다)
    const before = s.snapshot();
    expect(await failure(s.review.addComment(s.fileId, s.sid, { id: "diagram-unbound-3", kind: "comment", text: "댓글", diagram: B }))).toEqual(REFUSED);
    expect(await failure(s.review.addComment(s.fileId, s.sid, { id: "diagram-unbound-4", kind: "comment", text: "댓글", diagram: { ...B, sourceLine: [last + 21, last + 21] } }))).toEqual(REFUSED);
    expect(s.snapshot()).toBe(before);
  });

  test("본문 초안이 있으면 그 초안만 본다: 초안에서 지운 도식의 자리는 정본에 있어도 새로 받지 않는다. 빈 초안도 초안이다", async () => {
    const s = await setup();
    const B = nodeB(s.doc.markdown);
    const req = { id: "draft-only-1", kind: "comment" as const, text: "정본에서 고른 부분", diagram: B };
    expect(await s.review.addComment(s.fileId, s.sid, req)).toEqual({ ok: true, id: "draft-only-1" });
    // 다른 화면이 본문 초안에서 도식을 모두 지웠다. 그다음에는 본문을 아예 비웠다
    for (const [name, markdown, opId] of [["도식을 지운 초안", "# 지금 본문 초안\n\n도식과 부분 B 를 모두 지웠습니다.", "draft-only-0001"], ["빈 초안", "", "draft-only-0002"]] as const) {
      const d = await s.review.draft(s.fileId, s.sid);
      expect((await s.review.saveDraft(s.fileId, s.sid, { markdown, revision: d.revision, opId })).editedMarkdown).toBe(markdown);
      const before = s.snapshot();
      // 이미 저장된 id 의 재전송은 처음 결과를 확인한다. 새 id 는 새 쓰기라 지금 보이는 본문(초안)에 묶여야 한다
      expect([name, await s.review.addComment(s.fileId, s.sid, req)]).toEqual([name, { ok: true, id: "draft-only-1" }]);
      expect([name, await failure(s.review.addComment(s.fileId, s.sid, { ...req, id: "draft-only-new" }))]).toEqual([name, REFUSED]);
      expect([name, await failure(s.review.addComment(s.fileId, s.sid, { ...req, id: "draft-only-new", diagram: { ...B, sourceLine: null } }))]).toEqual([name, REFUSED]);
      expect([name, s.snapshot()]).toEqual([name, before]);
    }
    // 고친 본문을 버리면(본문 초안 없음) 다시 정본이 지금 보이는 본문이다
    const d = await s.review.draft(s.fileId, s.sid);
    await s.review.saveDraft(s.fileId, s.sid, { markdown: null, revision: d.revision, opId: "draft-only-0003" });
    expect(await s.review.addComment(s.fileId, s.sid, { ...req, id: "draft-only-2" })).toEqual({ ok: true, id: "draft-only-2" });
    expect(s.drafted().map((a) => a.id)).toEqual(["draft-only-1", "draft-only-2"]);
  });

  test("다른 도식에서 따로 맞는 글·이름·줄을 섞은 새 자리는 받지 않는다: 글·이름과 줄이 같은 도식의 것이어야 한다", async () => {
    const s = await setup();
    const view = await s.service.createDoc(s.projectId, { title: "도식 둘", markdown: TWO });
    const o = await s.review.open(view.fileId);
    const [a, b] = mermaidBlocks(o.markdown) as [MermaidBlock, MermaidBlock];
    expect([diagramLabel(a.code), diagramLabel(b.code)]).toEqual(["flowchart TD", "flowchart LR"]);
    const wholeA = anchorIn(a), wholeB = anchorIn(b), nodeA = anchorIn(a, "A", "첫 도식"), nodeOfB = anchorIn(b, "B", "둘째 도식");
    const mixed: [string, AgentAReviewDiagramAnchor][] = [
      ["둘째 도식의 첫 줄 글 + 첫째 도식의 줄", { ...wholeB, sourceLine: wholeA.sourceLine }],
      ["첫째 도식의 첫 줄 글 + 둘째 도식의 줄", { ...wholeA, sourceLine: wholeB.sourceLine }],
      ["둘째 도식의 부분 B + 첫째 도식의 줄", { ...nodeOfB, sourceLine: nodeA.sourceLine }],
      ["첫째 도식의 부분 A + 둘째 도식의 줄", { ...nodeA, sourceLine: nodeOfB.sourceLine }],
      ["두 도식에 걸친 줄", { ...wholeB, sourceLine: [wholeA.sourceLine![0], wholeB.sourceLine![1]] }],
    ];
    const draft = () => JSON.stringify(s.fake.sessions.find((x) => x.id === o.sessionId)!.draft);
    for (const [name, diagram] of mixed) {
      expect([name, await failure(s.review.addComment(view.fileId, o.sessionId, { id: "mixed-1", kind: "comment", text: "섞은 자리", diagram }))]).toEqual([name, REFUSED]);
    }
    expect(draft()).toBe("null");
    // 같은 도식의 글·이름과 줄이면 받는다. 화면은 그 줄의 도식에 표시한다
    const drawn = [a, b].map((x) => ({ line: x.line, lines: x.code.split("\n").length, drawn: { family: "flowchart" as const, parts: x === a ? [{ kind: "node" as const, id: "A", label: "첫 도식", box: BOX, hits: [BOX] }] : [{ kind: "node" as const, id: "B", label: "둘째 도식", box: BOX, hits: [BOX] }] } }));
    for (const [id, diagram, owner] of [["mixed-ok-1", wholeB, 1], ["mixed-ok-2", nodeOfB, 1], ["mixed-ok-3", wholeA, 0], ["mixed-ok-4", nodeA, 0]] as const) {
      expect([id, await s.review.addComment(view.fileId, o.sessionId, { id, kind: "comment", text: "제자리", diagram }), ownerOf(diagram, drawn)]).toEqual([id, { ok: true, id }, owner]);
    }
  });

  test("화면이 본 본문의 표(bodyMark)를 실으면 그 본문이 지금도 그대로일 때만 쓴다", async () => {
    const s = await setup();
    const B = nodeB(s.doc.markdown);
    const add = (id: string, bodyMark?: string | null) => s.review.addComment(s.fileId, s.sid, { id, kind: "comment", text: "댓글", diagram: B, bodyMark });
    expect([s.doc.edited, /^c:[0-9a-f]{32}$/.test(s.doc.bodyMark)]).toEqual([false, true]);
    expect(await add("mark-1", s.doc.bodyMark)).toEqual({ ok: true, id: "mark-1" });
    // 댓글이 늘어도 본문은 그대로다: 같은 표로 또 쓴다
    expect(await add("mark-2", s.doc.bodyMark)).toEqual({ ok: true, id: "mark-2" });
    // 다른 화면이 본문 초안을 저장했다. 글 끝에 한 줄만 더해 도식의 줄은 그대로다(자리만 보면 여전히 묶인다)
    const d = await s.review.draft(s.fileId, s.sid);
    await s.review.saveDraft(s.fileId, s.sid, { markdown: `${s.doc.markdown}\n끝에 더한 줄`, revision: d.revision, opId: "mark-body-0001" });
    const before = s.snapshot();
    // 정본을 보던 옛 화면의 새 댓글은 쓰지 않는다. 이미 저장된 id 의 재전송은 처음 결과를 확인한다
    expect(await failure(add("mark-3", s.doc.bodyMark))).toEqual({ status: 409, code: "AGENT_A_BODY_CHANGED" });
    expect(await add("mark-1", s.doc.bodyMark)).toEqual({ ok: true, id: "mark-1" });
    expect(s.snapshot()).toBe(before);
    // 다시 연 화면은 초안의 표를 받는다. 그 표로는 쓴다
    const again = await s.review.open(s.fileId, s.sid);
    expect([again.edited, /^d:[0-9a-f]{32}$/.test(again.bodyMark)]).toEqual([true, true]);
    expect(await add("mark-3", again.bodyMark)).toEqual({ ok: true, id: "mark-3" });
    // 표를 싣지 않은 요청은 지금 보이는 본문에 묶이는지만 본다
    expect(await add("mark-4")).toEqual({ ok: true, id: "mark-4" });
    // 초안의 글이 정본과 글자까지 같아도 초안과 정본은 표가 다르다
    const d2 = await s.review.draft(s.fileId, s.sid);
    await s.review.saveDraft(s.fileId, s.sid, { markdown: s.doc.canonical, revision: d2.revision, opId: "mark-body-0002" });
    const same = await s.review.open(s.fileId, s.sid);
    expect([same.markdown === s.doc.markdown, same.bodyMark.slice(2) === s.doc.bodyMark.slice(2), same.bodyMark.startsWith("d:")]).toEqual([true, true, true]);
    expect(await failure(add("mark-5", s.doc.bodyMark))).toEqual({ status: 409, code: "AGENT_A_BODY_CHANGED" });
    // 틀린 모양의 표, 도식 댓글이 아닌 댓글에 실은 표는 거절한다
    const kept = s.snapshot();
    for (const bad of ["", "c:123", `x:${"0".repeat(32)}`, `c:${"G".repeat(32)}`, 7 as never]) expect([bad, (await failure(add("mark-6", bad))).status]).toEqual([bad, 400]);
    expect((await failure(s.review.addComment(s.fileId, s.sid, { id: "mark-7", kind: "global", text: "전체 댓글", bodyMark: same.bodyMark }))).status).toBe(400);
    expect(s.snapshot()).toBe(kept);
  });

  test("검사와 쓰기 사이에 다른 화면이 초안을 저장하면 다시 읽어 처음부터 본다: 지워진 대상에는 쓰지 않고, 남은 대상에는 다른 화면의 저장을 지우지 않고 쓴다", async () => {
    /** 서버가 이 댓글을 쓰려고 초안을 읽은 직후에 다른 화면의 저장을 times 번까지 끼운다. */
    const interleave = (s: Awaited<ReturnType<typeof setup>>, times: number, write: (n: number) => Promise<number>) => {
      let n = 0;
      s.hooks.after = async (path, method) => {
        if (path !== "/api/draft" || method !== "GET" || n >= times) return;
        n += 1;
        expect(await write(n)).toBe(200);
      };
      return () => n;
    };
    // ① 다른 화면(원래 편집기)이 도식을 지운 본문을 통째로 저장했다: 검사한 본문과 다른 본문에 쓰지 않는다
    {
      const s = await setup();
      const count = interleave(s, 1, () => s.other("POST", "/api/draft", { draftGeneration: 0, annotations: [], globalAttachments: [], editedMarkdown: "도식을 지운 본문" }));
      expect(await failure(s.review.addComment(s.fileId, s.sid, { id: "race-1", kind: "comment", text: "그사이 지워진 대상", diagram: nodeB(s.doc.markdown) }))).toEqual(REFUSED);
      s.hooks.after = undefined;
      const draft = s.fake.sessions.find((x) => x.id === s.sid)!.draft;
      expect([count(), s.writes(), draft.editedMarkdown, draft.annotations]).toEqual([1, 1, "도식을 지운 본문", []]);
    }
    // ② 다른 화면이 상관없는 댓글 하나를 더했다: 대상은 그대로라 쓴다. 다른 화면의 댓글도 남는다
    {
      const s = await setup();
      const count = interleave(s, 1, () => s.other("POST", "/api/draft/annotations", { annotation: { id: "other-window-1", blockId: "", startOffset: 0, endOffset: 0, type: "GLOBAL_COMMENT", text: "다른 창의 댓글", originalText: "" } }));
      expect(await s.review.addComment(s.fileId, s.sid, { id: "race-2", kind: "comment", text: "그사이 다른 댓글", diagram: nodeB(s.doc.markdown) })).toEqual({ ok: true, id: "race-2" });
      s.hooks.after = undefined;
      expect([count(), s.writes(), s.drafted().map((a) => a.id)]).toEqual([1, 2, ["other-window-1", "race-2"]]);
    }
    // ③ 화면이 본 본문의 표를 실었는데 그사이 본문이 바뀌었다(대상 줄은 그대로): 화면이 본 본문이 아니므로 쓰지 않는다
    {
      const s = await setup();
      const count = interleave(s, 1, () => s.other("POST", "/api/draft", { draftGeneration: 0, annotations: [], globalAttachments: [], editedMarkdown: `${s.doc.markdown}\n끝에 더한 줄` }));
      expect(await failure(s.review.addComment(s.fileId, s.sid, { id: "race-3", kind: "comment", text: "그사이 바뀐 본문", diagram: nodeB(s.doc.markdown), bodyMark: s.doc.bodyMark }))).toEqual({ status: 409, code: "AGENT_A_BODY_CHANGED" });
      s.hooks.after = undefined;
      expect([count(), s.writes(), s.drafted()]).toEqual([1, 1, []]);
    }
    // ④ 읽을 때마다 다른 화면이 저장한다: 몇 번 다시 해 보고 쓰지 않은 채 충돌로 끝낸다(다른 화면의 저장은 모두 남는다)
    {
      const s = await setup();
      const count = interleave(s, 99, (n) => s.other("POST", "/api/draft/annotations", { annotation: { id: `other-window-${n}`, blockId: "", startOffset: 0, endOffset: 0, type: "GLOBAL_COMMENT", text: "다른 창의 댓글", originalText: "" } }));
      expect(await failure(s.review.addComment(s.fileId, s.sid, { id: "race-4", kind: "comment", text: "계속 끼어드는 저장", diagram: nodeB(s.doc.markdown) }))).toEqual({ status: 409, code: "AGENT_A_DRAFT_CONFLICT" });
      s.hooks.after = undefined;
      expect(count()).toBeGreaterThan(1);
      expect([s.writes(), s.drafted().map((a) => a.id)]).toEqual([count(), Array.from({ length: count() }, (_, i) => `other-window-${i + 1}`)]);
    }
    // ⑤ 같은 요청이 동시에 두 번 들어오면 댓글은 하나다(늦은 쪽은 재전송으로 확인된다). 서로 다른 댓글 둘이 동시에 들어오면 둘 다 남는다
    {
      const s = await setup();
      const B = nodeB(s.doc.markdown);
      const req = { id: "race-5", kind: "comment" as const, text: "동시에 두 번", diagram: B, bodyMark: s.doc.bodyMark };
      expect(await Promise.all([s.review.addComment(s.fileId, s.sid, req), s.review.addComment(s.fileId, s.sid, req)])).toEqual([{ ok: true, id: "race-5" }, { ok: true, id: "race-5" }]);
      expect([s.writes(), s.drafted().map((a) => a.id)]).toEqual([1, ["race-5"]]);
      expect(await Promise.all([s.review.addComment(s.fileId, s.sid, { ...req, id: "race-6" }), s.review.addComment(s.fileId, s.sid, { ...req, id: "race-7" })])).toEqual([{ ok: true, id: "race-6" }, { ok: true, id: "race-7" }]);
      expect([s.writes(), s.drafted().map((a) => a.id).sort()]).toEqual([3, ["race-5", "race-6", "race-7"]]);
    }
  });

  test("Agent-A 가 이미 받은 id 는 초안에서 빠졌어도 새로 쓰지 않는다. 지난 판·닫힌 검토에는 자리가 맞든 틀리든 쓰지 않는다(409)", async () => {
    const s = await setup();
    const B = nodeB(s.doc.markdown);
    const req = { id: "known-1", kind: "comment" as const, text: "처음 보낸 댓글", diagram: B };
    expect(await s.review.addComment(s.fileId, s.sid, req)).toEqual({ ok: true, id: "known-1" });
    // 다른 화면(원래 편집기)이 그 댓글이 빠진 초안을 통째로 저장했다: Agent-A 는 그 댓글을 기억한다
    expect(await s.other("POST", "/api/draft", { draftGeneration: 0, annotations: [], globalAttachments: [] })).toBe(200);
    const before = s.snapshot();
    expect(await s.review.addComment(s.fileId, s.sid, req)).toEqual({ ok: true, id: "known-1" });
    expect(await failure(s.review.addComment(s.fileId, s.sid, { ...req, text: "다른 내용" }))).toEqual({ status: 409, code: "AGENT_A_IDEMPOTENCY_CONFLICT" });
    expect([s.snapshot(), s.drafted()]).toEqual([before, []]);
    // 정본이 바뀌어 이 검토는 지난 판이 됐다: 맞는 자리도 틀린 자리도 409 다(자리 검사보다 먼저다)
    const block = (await s.review.manage(s.fileId)).blocks[0]!;
    await s.review.edit(s.fileId, { blockId: block.id, revision: block.revision, title: block.title, body: `${block.body}\n새 판의 줄`, opId: "known-edit-0001" });
    for (const diagram of [B, { ...B, sourceLine: [1, 1] as [number, number] }]) {
      expect(await failure(s.review.addComment(s.fileId, s.sid, { id: "known-stale", kind: "comment", text: "지난 판의 새 댓글", diagram }))).toEqual({ status: 409, code: "AGENT_A_REVISION_CONFLICT" });
    }
    expect(s.snapshot()).toBe(before);
    // 제출로 닫힌 검토
    const now = await s.review.open(s.fileId);
    const d = await s.review.draft(s.fileId, now.sessionId);
    await s.review.submit(s.fileId, now.sessionId, { revision: d.revision, decision: "feedback" });
    for (const diagram of [nodeB(now.markdown), { ...B, sourceLine: [1, 1] as [number, number] }]) {
      expect(await failure(s.review.addComment(s.fileId, now.sessionId, { id: "known-closed", kind: "comment", text: "닫힌 검토의 새 댓글", diagram }))).toEqual({ status: 409, code: "AGENT_A_ALREADY_DECIDED" });
    }
  });

  test("이미 저장된 도식 댓글의 재전송(같은 id)은 그사이 본문이 바뀌어 자리가 이어지지 않아도 처음 결과를 확인한다. 새로 쓰지는 않는다", async () => {
    const s = await setup();
    const { fence, last } = docLines(s.doc.markdown);
    // 본문 초안 앞에 20줄을 넣은 화면에서 단 댓글: 그 줄은 정본에는 없다
    const first = await s.review.draft(s.fileId, s.sid);
    await s.review.saveDraft(s.fileId, s.sid, { markdown: `${"앞에 넣은 줄\n".repeat(20)}${s.doc.markdown}`, revision: first.revision, opId: "diagram-retry-0001" });
    const anchor: AgentAReviewDiagramAnchor = { ...NODE_B, sourceLine: [fence + 2 + 20, fence + 2 + 20] };
    expect(anchor.sourceLine![0]).toBeGreaterThan(last);
    const req = { id: "diagram-retry-1", kind: "comment" as const, text: "응답을 잃은 댓글", diagram: anchor };
    expect(await s.review.addComment(s.fileId, s.sid, req)).toEqual({ ok: true, id: "diagram-retry-1" });
    // 다른 화면이 본문 초안을 처음 글로 되돌렸다: 그 줄은 이제 정본에도 초안에도 없다
    const second = await s.review.draft(s.fileId, s.sid);
    await s.review.saveDraft(s.fileId, s.sid, { markdown: s.doc.markdown, revision: second.revision, opId: "diagram-retry-0002" });
    const before = [s.writes(), s.drafted().map((a) => [a.id, a.text, a.diagramAnchor])];
    expect(before[1]).toEqual([["diagram-retry-1", "응답을 잃은 댓글", anchor]]);
    // 같은 id·같은 내용의 재전송은 처음 결과를 확인한다(저장된 댓글은 그대로, 초안의 판도 그대로)
    expect(await s.review.addComment(s.fileId, s.sid, req)).toEqual({ ok: true, id: "diagram-retry-1" });
    // 같은 id 에 다른 내용은 Agent-A 가 거절한다. 새 id 로 같은 자리를 보내면 새 쓰기라 연결 검사에서 거절한다
    expect(await failure(s.review.addComment(s.fileId, s.sid, { ...req, text: "다른 내용" }))).toEqual({ status: 409, code: "AGENT_A_IDEMPOTENCY_CONFLICT" });
    expect(await failure(s.review.addComment(s.fileId, s.sid, { ...req, id: "diagram-retry-2" }))).toEqual({ status: 400, code: "AGENT_A_DIAGRAM_NOT_IN_DOCUMENT" });
    expect([s.writes(), s.drafted().map((a) => [a.id, a.text, a.diagramAnchor])]).toEqual(before);
  });

  test("이미 있는 댓글은 문서 밖 줄·다른 갈래의 자리여도 그대로 읽고, 새 댓글을 달아도 남는다", async () => {
    const s = await setup();
    // 원래 화면(또는 옛 판의 IAMCEO)이 Agent-A 에 직접 남긴 댓글들
    const far: AgentAReviewDiagramAnchor = { v: 1, family: "flowchart", kind: "node", id: "B", label: "검토", sourceLine: [999_999, 999_999] };
    const graphviz: AgentAReviewDiagramAnchor = { v: 1, family: "graphviz", kind: "node", id: "B", label: "검토", sourceLine: null };
    expect(await s.other("POST", "/api/draft/annotations", { annotation: { id: "old-far-line", blockId: "", startOffset: 0, endOffset: 0, type: "COMMENT", text: "줄이 문서 밖인 옛 댓글", originalText: "검토", diagramAnchor: far } })).toBe(200);
    expect(await s.other("POST", "/api/draft/annotations", { annotation: { id: "old-graphviz", blockId: "old-graphviz-block", startOffset: 0, endOffset: 0, type: "COMMENT", text: "Graphviz 의 B 에 남긴 옛 댓글", originalText: "검토", diagramAnchor: graphviz } })).toBe(200);
    const read = async () => (await s.review.comments(s.fileId, s.sid, null))!.annotations.filter((a) => !a.ai).map((a) => [a.id, a.text, a.diagram]);
    const old = [["old-far-line", "줄이 문서 밖인 옛 댓글", far], ["old-graphviz", "Graphviz 의 B 에 남긴 옛 댓글", graphviz]];
    expect(await read()).toEqual(old);
    // 같은 자리를 새 댓글로 보내면 거절하지만, 옛 댓글은 건드리지 않는다
    expect((await failure(s.review.addComment(s.fileId, s.sid, { id: "new-far-line", kind: "comment", text: "새 댓글", diagram: far }))).code).toBe("AGENT_A_DIAGRAM_NOT_IN_DOCUMENT");
    expect(await read()).toEqual(old);
    const B = nodeB(s.doc.markdown);
    await s.review.addComment(s.fileId, s.sid, { id: "new-node-b", kind: "comment", text: "새 댓글", diagram: B });
    expect(await read()).toEqual([...old, ["new-node-b", "새 댓글", B]]);
  });

  test("읽기: 원래 화면이 남긴 자리는 그대로 읽고, 모양이 틀린 자리는 자리 없는 댓글로 읽는다(댓글은 잃지 않는다)", () => {
    const base = { id: "a1", type: "COMMENT", text: "댓글", originalText: "검토", createdA: 1 };
    expect(toAnnotation({ ...base, blockId: "block-7", diagramAnchor: NODE_B })!.diagram).toEqual(NODE_B);
    // 원래 화면의 다른 도식 종류(Graphviz)와 원래 화면이 줄이지 못한 긴 글
    expect(toAnnotation({ ...base, diagramAnchor: { v: 1, family: "graphviz", kind: "node", id: "n1", label: "x".repeat(500), sourceLine: [2, 2] } })!.diagram).toEqual({ v: 1, family: "graphviz", kind: "node", id: "n1", label: "x".repeat(400), sourceLine: [2, 2] });
    // 줄 번호만 틀리면 줄만 버린다
    expect(toAnnotation({ ...base, diagramAnchor: { ...NODE_B, sourceLine: [0, 0] } })!.diagram).toEqual({ ...NODE_B, sourceLine: null });
    for (const diagramAnchor of [null, "B", { ...NODE_B, v: 2 }, { ...NODE_B, family: "pie" }, { ...NODE_B, kind: "point" }, { v: 1, family: "flowchart", kind: "node", label: "검토" }]) {
      const a = toAnnotation({ ...base, diagramAnchor })!;
      expect([a.id, a.text, a.quote, a.diagram]).toEqual(["a1", "댓글", "검토", null]);
    }
    // AI 답에는 자리가 없다
    expect(toAnnotation({ ...base, isAIReply: true, diagramAnchor: NODE_B })!.diagram).toBeNull();
    expect(parseDiagramAnchor({ ...NODE_B, sourceLine: null })).toEqual({ ...NODE_B, sourceLine: null });
  });

  test("검토 제출 글에 도식 자리를 한 줄로 싣는다", () => {
    const text = feedbackText("본문", [
      { type: "COMMENT", text: "누가 하나요?", originalText: "검토", diagramAnchor: NODE_B },
      { type: "COMMENT", text: "왜 있나요?", originalText: "A → B", diagramAnchor: { v: 1, family: "flowchart", kind: "edge", from: "A", to: "B", label: "", sourceLine: null } },
      { type: "COMMENT", text: "단순합니다", originalText: "graph TD", diagramAnchor: { v: 1, family: "flowchart", kind: "diagram", label: "graph TD", sourceLine: [6, 11] } },
      { type: "COMMENT", text: "틀린 자리", originalText: "검토", diagramAnchor: { v: 3 } },
    ], null, 0);
    expect(text).toContain("(diagram: node 검토 (B), line 7)");
    expect(text).toContain("(diagram: edge A → B)");
    expect(text).toContain("(diagram: whole flowchart, lines 6–11)");
    expect(text.match(/\(diagram:/g)!.length).toBe(3);
  });
});

describe("그림 영역의 '좋아요' 라벨(서버)", () => {
  test("그림 영역에 붙인 라벨은 영역과 라벨 표시를 함께 싣고, 다시 읽으면 둘 다 돌아온다", async () => {
    const s = await setup();
    const image = s.doc.images[0]!;
    const region = { v: 1, src: image.src, sourceLine: image.sourceLine, naturalWidth: 400, naturalHeight: 200, box: { x: 40, y: 40, w: 160, h: 100 } } as const;
    await s.review.addComment(s.fileId, s.sid, { id: "region-label-1", kind: "comment", text: "👍 좋아요", quote: "", region, quickLabel: { tip: null } });
    const a = s.drafted()[0]!;
    expect([a.type, a.text, a.originalText, a.isQuickLabel, "quickLabelTip" in a, a.imageRegion]).toEqual(["COMMENT", "👍 좋아요", "", true, false, region]);
    const read = (await s.review.comments(s.fileId, s.sid, null))!.annotations.find((x) => x.id === "region-label-1")!;
    expect([read.label, read.labelTip, read.region, read.text, read.diagram]).toEqual([true, null, region, "👍 좋아요", null]);
  });
});

describe("도식 부분 댓글(화면 계산)", () => {
  const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
  const part = (p: Partial<DiagramPart> & Pick<DiagramPart, "kind">): DiagramPart => ({ label: "", box: box(0.1, 0.1, 0.2, 0.2), hits: [box(0.1, 0.1, 0.2, 0.2)], ...p });
  const parts: DiagramPart[] = [
    part({ kind: "node", id: "A", label: "시작" }), part({ kind: "node", id: "B", label: "검토" }), part({ kind: "node", id: "C", label: "끝" }),
    part({ kind: "edge", from: "A", to: "B" }), part({ kind: "edge", from: "B", to: "C", label: "통과" }), part({ kind: "cluster", id: "G1", label: "묶음" }),
  ];

  test("본문 나누기: 도식 조각에 ```mermaid 줄의 문서 줄 번호를 적는다", () => {
    const doc = splitDoc(MARKDOWN);
    expect(doc.map((p) => p.kind)).toEqual(["markdown", "mermaid", "markdown"]);
    expect(doc[1]).toEqual({ kind: "mermaid", code: FLOW.join("\n"), line: FENCE });
    expect(splitDoc("```mermaid\ngraph LR\n  X --> Y\n```")[0]).toEqual({ kind: "mermaid", code: "graph LR\n  X --> Y", line: 1 });
  });

  test("문서 줄 찾기: 이름이 통째로 나오는 첫 줄, 선은 양 끝이 함께 나오는 줄, 묶음은 subgraph 줄, 전체는 도식 글 전부", () => {
    const source = FLOW.join("\n");
    expect(sourceLineOf(source, { family: "flowchart", kind: "node", id: "B" })).toEqual([2, 2]);
    expect(sourceLineOf(source, { family: "flowchart", kind: "node", id: "C" })).toEqual([3, 3]);
    expect(sourceLineOf(source, { family: "flowchart", kind: "edge", from: "B", to: "C" })).toEqual([3, 3]);
    expect(sourceLineOf(source, { family: "flowchart", kind: "cluster", id: "G1" })).toEqual([4, 4]);
    expect(sourceLineOf(source, { family: "flowchart", kind: "diagram" })).toEqual([1, FLOW.length]);
    expect(sourceLineOf("\n\ngraph TD\n  A --> B\n\n", { family: "flowchart", kind: "diagram" })).toEqual([3, 4]);
    // 이름의 일부만 맞는 줄은 아니다(D 는 DR 이 아니다). 정규식 글자가 든 이름도 글자 그대로 찾는다.
    expect(sourceLineOf("graph TD\n  DR --> X\n  D --> X", { family: "flowchart", kind: "node", id: "D" })).toEqual([3, 3]);
    expect(sourceLineOf("graph TD\n  a.b(c --> X", { family: "flowchart", kind: "node", id: "a.b(c" })).toEqual([2, 2]);
    expect(sourceLineOf(source, { family: "flowchart", kind: "node", id: "없는이름" })).toBeNull();
    expect(sourceLineOf(source, { family: "state", kind: "edge", id: "edge0" })).toBeNull();
    expect(sourceLineOf("", { family: "flowchart", kind: "diagram" })).toBeNull();
    // 순서도(sequence)의 메시지·메모·틀은 차례로 센다
    const seq = "sequenceDiagram\n  participant A as 대표\n  A->>B: 요청\n  Note over A,B: 메모\n  loop 반복\n    B-->>A: 응답\n  end";
    expect(sourceLineOf(seq, { family: "sequence", kind: "edge", id: "msg-2" })).toEqual([6, 6]);
    expect(sourceLineOf(seq, { family: "sequence", kind: "node", id: "note-1" })).toEqual([4, 4]);
    expect(sourceLineOf(seq, { family: "sequence", kind: "cluster", id: "frame-1" })).toEqual([5, 5]);
    expect(sourceLineOf(seq, { family: "sequence", kind: "node", id: "A" })).toEqual([2, 2]);
    expect(sourceLineOf(seq, { family: "sequence", kind: "edge", id: "msg-9" })).toBeNull();
  });

  test("자리 만들기: 부분의 이름·글과 문서 줄(도식 줄 + ```mermaid 줄)을 싣는다. 부분이 없으면 도식 전체다", () => {
    const source = FLOW.join("\n");
    expect(anchorFor("flowchart", parts[1]!, source, FENCE)).toEqual(NODE_B);
    expect(anchorFor("flowchart", parts[4]!, source, FENCE)).toEqual({ v: 1, family: "flowchart", kind: "edge", from: "B", to: "C", label: "통과", sourceLine: [FENCE + 3, FENCE + 3] });
    expect(anchorFor("flowchart", null, source, FENCE)).toEqual({ v: 1, family: "flowchart", kind: "diagram", label: "graph TD", sourceLine: [FENCE + 1, FENCE + FLOW.length] });
    expect(anchorFor("flowchart", part({ kind: "node", id: "없는이름", label: "글" }), source, FENCE).sourceLine).toBeNull();
    expect(anchorFor("other", null, `${"가".repeat(200)}\n나`, 1).label).toBe(`${"가".repeat(120)}…`);
    expect([anchorText(NODE_B), anchorText({ v: 1, family: "flowchart", kind: "edge", from: "A", to: "B", label: "", sourceLine: null }), anchorText({ v: 1, family: "state", kind: "edge", id: "edge0", label: "", sourceLine: null })]).toEqual(["검토", "A → B", "edge0"]);
  });

  test("댓글이 어느 도식의 것인지: 문서 줄이 가리키는 도식 → 그 자리를 찾는 첫 도식 → 없음. 그리는 중이면 기다린다", () => {
    const drawn = { family: "flowchart" as const, parts };
    const other = { family: "flowchart" as const, parts: [part({ kind: "node", id: "X", label: "다른 노드" })] };
    // 도식 둘: 첫째는 문서 5줄(도식 글 6~11줄), 둘째는 20줄(21~23줄)
    const blocks = (a: typeof drawn | null | undefined, b: typeof drawn | null | undefined) => [{ line: FENCE, lines: FLOW.length, drawn: a }, { line: 20, lines: 3, drawn: b }];
    expect(ownerOf(NODE_B, blocks(drawn, other))).toBe(0);
    // 같은 이름의 노드가 두 도식에 있어도 줄이 가리키는 쪽이다
    expect(ownerOf({ ...NODE_B, sourceLine: [22, 22] }, blocks(drawn, drawn))).toBe(1);
    // 줄이 가리키는 도식에 그 부분이 없으면(본문이 바뀌었으면) 그 자리를 찾는 첫 도식이다
    expect(ownerOf({ ...NODE_B, sourceLine: [22, 22] }, blocks(drawn, other))).toBe(0);
    // 줄이 없으면(원래 화면이 줄을 못 찾은 자리) 그 자리를 찾는 첫 도식
    expect(ownerOf({ ...NODE_B, sourceLine: null }, blocks(other, drawn))).toBe(1);
    // 어느 도식에도 없으면 표시하지 않는다
    expect(ownerOf({ ...NODE_B, id: "없음", label: "없는 글", sourceLine: null }, blocks(drawn, other))).toBeNull();
    // 가릴 도식을 아직 그리는 중이면 기다린다. 그리지 못한 도식은 건너뛴다.
    expect(ownerOf(NODE_B, blocks(undefined, drawn))).toBeNull();
    expect(ownerOf({ ...NODE_B, sourceLine: null }, blocks(drawn, undefined))).toBeNull();
    expect(ownerOf({ ...NODE_B, sourceLine: null }, blocks(null, drawn))).toBe(1);
    // 도식 전체에 단 댓글은 줄이 가리키는 도식의 것이다. 줄이 없으면 첫 도식(Mermaid 안의 갈래는 견주지 않는다).
    const whole: AgentAReviewDiagramAnchor = { v: 1, family: "flowchart", kind: "diagram", label: "graph TD", sourceLine: [21, 23] };
    expect(ownerOf(whole, blocks(drawn, other))).toBe(1);
    expect(ownerOf(whole, blocks(drawn, null))).toBeNull();
    expect(ownerOf({ ...whole, sourceLine: null }, blocks(drawn, other))).toBe(0);
    expect(ownerOf({ ...whole, family: "sequence", sourceLine: null }, blocks(drawn, other))).toBe(0);
  });

  test("갈래: Graphviz 댓글은 이름·글이 같아도 Mermaid 도식의 것이 아니다. Mermaid 안의 갈래는 견주지 않는다(원래 화면과 같다)", () => {
    const flow = { family: "flowchart" as const, parts };
    // 상태도에도 B 라는 이름의 상태가 있다
    const state = { family: "state" as const, parts: [part({ kind: "node", id: "B", label: "검토" })] };
    const one = [{ line: FENCE, lines: FLOW.length, drawn: flow }];
    const two = [{ line: FENCE, lines: FLOW.length, drawn: flow }, { line: 20, lines: 3, drawn: state }];
    expect(ownerOf(NODE_B, one)).toBe(0);
    // Graphviz 댓글: 줄이 이 도식 안이어도, 줄이 없어도, 다른 블록 줄이어도 Mermaid 도식에 붙지 않는다(목록에만 남는다)
    const graphviz: AgentAReviewDiagramAnchor = { ...NODE_B, family: "graphviz" };
    expect([ownerOf(graphviz, one), ownerOf({ ...graphviz, sourceLine: null }, one), ownerOf({ ...graphviz, sourceLine: [40, 40] }, one), ownerOf(graphviz, two)]).toEqual([null, null, null, null]);
    expect(ownerOf({ v: 1, family: "graphviz", kind: "edge", from: "A", to: "B", label: "", sourceLine: null }, one)).toBeNull();
    // Graphviz 도식 전체에 단 댓글도 줄이 가리키는 Mermaid 도식의 것이 아니다
    const whole: AgentAReviewDiagramAnchor = { v: 1, family: "graphviz", kind: "diagram", label: "digraph G {", sourceLine: [FENCE + 1, FENCE + FLOW.length] };
    expect([ownerOf(whole, one), ownerOf({ ...whole, sourceLine: null }, one), ownerOf({ ...whole, family: "flowchart" }, one)]).toEqual([null, null, 0]);
    // Mermaid 안의 갈래는 견주지 않는다(원래 화면의 규칙: 이름의 문법이 같으면 붙고, 없으면 그려진 도식이 가린다).
    // 본문의 도식을 흐름도에서 상태도로 바꾼 뒤에도 옛 댓글은 같은 줄·같은 이름의 부분에 다시 붙는다. 줄이 없어도 같다
    const changed = [{ line: FENCE, lines: FLOW.length, drawn: state }];
    expect([ownerOf(NODE_B, changed), ownerOf({ ...NODE_B, sourceLine: null }, changed)]).toEqual([0, 0]);
    const stateB: AgentAReviewDiagramAnchor = { ...NODE_B, family: "state" };
    expect([ownerOf(stateB, one), ownerOf({ ...stateB, sourceLine: null }, one)]).toEqual([0, 0]);
    // 같은 이름이 두 도식에 있으면 줄이 가리키는 도식이다. 줄이 없으면 문서 차례의 첫 도식이다(원래 화면과 같다)
    expect([ownerOf(stateB, two), ownerOf({ ...stateB, sourceLine: [22, 22] }, two), ownerOf({ ...stateB, sourceLine: null }, two)]).toEqual([0, 1, 0]);
    expect([ownerOf({ ...NODE_B, sourceLine: [22, 22] }, two), ownerOf({ ...NODE_B, sourceLine: null }, two)]).toEqual([1, 0]);
    // 그 이름이 없는 갈래의 도식에는 붙지 않는다: 순서도의 차례 이름(msg-2)은 흐름도에 없다
    expect(ownerOf({ v: 1, family: "sequence", kind: "edge", id: "msg-2", label: "응답", sourceLine: [FENCE + 2, FENCE + 2] }, two)).toBeNull();
    // 도식 전체 댓글은 줄이 가리키는 도식의 것이다(다른 도식으로 옮기지 않는다)
    expect(ownerOf({ v: 1, family: "state", kind: "diagram", label: "stateDiagram-v2", sourceLine: [FENCE + 1, FENCE + FLOW.length] }, two)).toBe(0);
    // 그리는 중이면 기다린다
    expect(ownerOf({ ...stateB, sourceLine: null }, [{ line: FENCE, lines: FLOW.length, drawn: undefined }, { line: 20, lines: 3, drawn: state }])).toBeNull();
  });

  test("서버와 화면이 같은 도식 조각을 본다: 문서에서 찾은 Mermaid 조각과 줄 번호가 본문 나누기와 같다", () => {
    const samples = [
      MARKDOWN,
      "```mermaid\ngraph TD\n  A --> B\n```",
      "글\n\n~~~Mermaid\nsequenceDiagram\n  A->>B: 안녕\n~~~\n\n```ts\n```mermaid\nconst x = 1;\n```\n\n   ````mermaid\n\n  graph LR\n```\n  X --> Y\n````\n끝",
      "```js\n```mermaid\n가짜\n```\n```\n```mermaid\n닫히지 않은 도식\ngraph TD",
      "    ```mermaid\n들여쓴 코드\n    ```\n```mermaid   \n\n```",
      "도식 없는 글\n![그림](/a.png)",
    ];
    for (const markdown of samples) {
      expect([markdown, mermaidBlocks(markdown)]).toEqual([markdown, splitDoc(markdown).flatMap((p) => (p.kind === "mermaid" ? [{ line: p.line, code: p.code }] : []))]);
    }
    expect(mermaidBlocks(samples[2]!).map((b) => [b.line, diagramLabel(b.code)])).toEqual([[3, "sequenceDiagram"], [13, "graph LR"]]);
    // 도식 전체의 글: 비어 있지 않은 첫 줄, 길면 120자까지
    expect([diagramLabel("\n  graph TD  \n A"), diagramLabel(""), diagramLabel("가".repeat(200))]).toEqual(["graph TD", "", `${"가".repeat(120)}…`]);
    expect(anchorFor("other", null, `${"가".repeat(200)}\n나`, 1).label).toBe(diagramLabel(`${"가".repeat(200)}\n나`));
  });

  test("다시 그렸을 때 부분 찾기: 이름 → 글이 같은 하나뿐인 노드 → 못 찾음. 도식 전체는 늘 찾는다", () => {
    expect(findPart(parts, NODE_B)).toBe(parts[1]!);
    // 댓글 목록의 종류 글
    expect([kindLabel({ kind: "comment", region: null, diagram: NODE_B }), kindLabel({ kind: "comment", region: null, diagram: null })]).toEqual(["도식", "문장"]);
    expect(findPart(parts, { v: 1, family: "flowchart", kind: "edge", from: "B", to: "C", label: "", sourceLine: null })).toBe(parts[4]!);
    expect(findPart(parts, { v: 1, family: "flowchart", kind: "cluster", id: "G1", label: "", sourceLine: null })).toBe(parts[5]!);
    expect(findPart(parts, { v: 1, family: "flowchart", kind: "diagram", label: "graph TD", sourceLine: null })).toBe("whole");
    expect(findPart([], { v: 1, family: "flowchart", kind: "diagram", label: "graph TD", sourceLine: null })).toBe("whole");
    // 이름이 바뀌었어도 글이 같은 노드가 하나뿐이면 그 노드다
    expect(findPart(parts, { ...NODE_B, id: "옛이름" })).toBe(parts[1]!);
    // 같은 글의 노드가 둘이면 고르지 않는다. 종류가 다르면 이름이 같아도 아니다.
    expect(findPart([...parts, part({ kind: "node", id: "B2", label: "검토" })], { ...NODE_B, id: "옛이름" })).toBeNull();
    expect(findPart(parts, { ...NODE_B, kind: "cluster" })).toBeNull();
    expect(findPart(parts, { v: 1, family: "flowchart", kind: "edge", from: "C", to: "A", label: "통과", sourceLine: null })).toBeNull();
    expect(findPart(parts, { ...NODE_B, id: "없음", label: "" })).toBeNull();
    // 순서도: 차례가 밀렸으면 글이 같은 하나를 찾고, 글이 고쳐졌으면 그 차례의 것을 쓴다
    const seq: DiagramPart[] = [part({ kind: "edge", id: "msg-1", label: "새 요청" }), part({ kind: "edge", id: "msg-2", label: "요청" }), part({ kind: "edge", id: "msg-3", label: "응답" })];
    expect(findPart(seq, { v: 1, family: "sequence", kind: "edge", id: "msg-1", label: "요청", sourceLine: null })).toBe(seq[1]!);
    expect(findPart(seq, { v: 1, family: "sequence", kind: "edge", id: "msg-3", label: "고쳐진 글", sourceLine: null })).toBe(seq[2]!);
    expect(findPart(seq, { v: 1, family: "sequence", kind: "edge", id: "msg-9", label: "없는 글", sourceLine: null })).toBeNull();
  });

  test("그리는 칸이 돌려준 부분 목록: 모양이 맞는 것만 받고, 자리는 그림 안으로 자른다", () => {
    const ok = { kind: "node", id: "B", label: "검토", box: box(0.2, 0.3, 0.1, 0.1), hits: [box(0.2, 0.3, 0.1, 0.1)] };
    expect(cleanParts([ok])).toEqual([ok as DiagramPart]);
    // 누를 자리가 없으면 부분의 자리 하나를 쓴다. 그림 밖으로 나간 자리는 자른다.
    expect(cleanParts([{ kind: "edge", from: "A", to: "B", label: 7, box: box(-0.25, 0.75, 0.5, 0.5) }])).toEqual([{ kind: "edge", from: "A", to: "B", label: "", box: box(0, 0.75, 0.25, 0.25), hits: [box(0, 0.75, 0.25, 0.25)] }]);
    const junk: unknown[] = [null, "node", { kind: "diagram", id: "B", box: box(0, 0, 1, 1) }, { kind: "node", box: box(0, 0, 1, 1) }, { kind: "node", id: "", box: box(0, 0, 1, 1) }, { kind: "edge", from: "A", box: box(0, 0, 1, 1) },
      { kind: "node", id: "B" }, { kind: "node", id: "B", box: box(0, 0, 0, 1) }, { kind: "node", id: "B", box: box(2, 2, 1, 1) }, { kind: "node", id: "B", box: { x: "0", y: 0, w: 1, h: 1 } }, { kind: "node", id: "B", box: box(Number.NaN, 0, 1, 1) }];
    expect(cleanParts(junk)).toEqual([]);
    expect(cleanParts("parts")).toEqual([]);
    // 긴 글은 400자로 줄이고, 부분은 300개·누를 자리는 부분마다 24개까지만 받는다
    const many = cleanParts(Array.from({ length: 400 }, (_, i) => ({ kind: "node", id: `n${i}`, label: "글".repeat(500), box: box(0, 0, 0.5, 0.5), hits: Array.from({ length: 40 }, () => box(0, 0, 0.1, 0.1)) })));
    expect([many.length, many[0]!.label.length, many[0]!.hits.length]).toEqual([300, 400, 24]);
    // 누를 자리 중 틀린 것만 버린다
    expect(cleanParts([{ ...ok, hits: [box(0.2, 0.3, 0.1, 0.1), null, box(5, 5, 1, 1)] }])[0]!.hits).toEqual([box(0.2, 0.3, 0.1, 0.1)]);
  });
});
