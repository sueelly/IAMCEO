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
import { anchorFor, anchorText, cleanParts, findPart, ownerOf, sourceLineOf, type DiagramPart } from "../web/src/lib/agent-a-diagram.ts";
import { kindLabel, splitDoc } from "../web/src/lib/agent-a-review.ts";
import { fakeAgentAReview } from "./fixtures/fake-agent-a-review.ts";
import { pngBase64 } from "./fixtures/png.ts";

const FLOW = ["graph TD", "  A[시작] --> B[검토]", "  B -->|통과| C[끝]", "  subgraph G1 [묶음]", "    C", "  end"];
const MARKDOWN = ["머리 문단입니다.", "", "## 흐름", "", "```mermaid", ...FLOW, "```", "", "끝 문장입니다."].join("\n");
/** ```mermaid 줄의 문서 줄 번호(1부터). 도식 글의 k 번째 줄은 문서의 FENCE + k 번째 줄이다. */
const FENCE = 5;

async function setup(options: { draftProtocol?: 1 | 2 } = {}) {
  const fake = fakeAgentAReview({ answerDelayMs: 5, draftProtocol: options.draftProtocol ?? 2 });
  const store = new Store(openDb(join(mkdtempSync(join(tmpdir(), "iamceo-aa-diagram-")), "iamceo.db")), new Bus());
  const project = store.createProject({ name: "도식 댓글 시험", cwd: tmpdir() });
  const service = new AgentAService(store, new AgentAClient({ baseUrl: "http://127.0.0.1:4999", appToken: null, agentToken: null }, fake.transport));
  const review = new AgentAReview(service);
  const view = await service.createDoc(project.id, { title: "도식 문서", markdown: MARKDOWN, images: [{ title: "구성도", name: "map.png", mediaType: "image/png", base64: pngBase64(400, 200) }] });
  const doc = await review.open(view.fileId);
  const drafted = (): Record<string, any>[] => fake.sessions.filter((s) => s.id === doc.sessionId).flatMap((s) => s.draft?.annotations ?? []);
  const writes = () => fake.sessions.find((s) => s.id === doc.sessionId)!.draft_revision ?? 0;
  return { fake, review, fileId: view.fileId, doc, sid: doc.sessionId, drafted, writes };
}
const failure = async (p: Promise<unknown>): Promise<{ status: number; code?: string }> => p.then(() => ({ status: 200 }), (e) => (e instanceof ApiError ? { status: e.status, code: e.code } : { status: -1 }));
const NODE_B: AgentAReviewDiagramAnchor = { v: 1, family: "flowchart", kind: "node", id: "B", label: "검토", sourceLine: [FENCE + 2, FENCE + 2] };

describe("도식 부분 댓글(서버)", () => {
  test("부분의 자리를 원래 화면과 같은 모양(diagramAnchor)으로 싣고, 다시 읽으면 그 자리가 돌아온다", async () => {
    const s = await setup();
    const edge: AgentAReviewDiagramAnchor = { v: 1, family: "flowchart", kind: "edge", from: "B", to: "C", label: "통과", sourceLine: [FENCE + 3, FENCE + 3] };
    const whole: AgentAReviewDiagramAnchor = { v: 1, family: "flowchart", kind: "diagram", label: "graph TD", sourceLine: [FENCE + 1, FENCE + FLOW.length] };
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
    // 도식 전체에 단 댓글은 줄이 가리키는 도식의 것이다. 줄이 없으면 갈래가 같은 첫 도식.
    const whole: AgentAReviewDiagramAnchor = { v: 1, family: "flowchart", kind: "diagram", label: "graph TD", sourceLine: [21, 23] };
    expect(ownerOf(whole, blocks(drawn, other))).toBe(1);
    expect(ownerOf(whole, blocks(drawn, null))).toBeNull();
    expect(ownerOf({ ...whole, sourceLine: null }, blocks(drawn, other))).toBe(0);
    expect(ownerOf({ ...whole, family: "sequence", sourceLine: null }, blocks(drawn, other))).toBeNull();
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
