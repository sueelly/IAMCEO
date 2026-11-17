// 도식 글(Mermaid 원문)만으로 하는 계산. 서버와 화면이 같은 규칙을 쓴다: 브라우저 API·그리는 부품을 쓰지 않는다.
// 화면은 이 규칙으로 도식 댓글의 자리(문서 줄·도식 전체의 글)를 만들고, 서버는 같은 규칙으로 새 댓글의 자리가 이 문서의 도식에 이어지는지 본다.
// 출처: 이름을 글에서 찾는 규칙은 원래 화면의 편집기 plannotator v0.28.48(backnotprop, MIT OR Apache-2.0)의 diagramAnchor 규약을 따른다.
// 그 소스를 싣지 않고 같은 규칙을 따로 썼다.
import type { AgentAReviewDiagramAnchor } from "./agent-a.ts";

/** 자리에서 부분을 가리키는 칸만. */
export type DiagramTarget = Pick<AgentAReviewDiagramAnchor, "family" | "kind"> & { id?: string; from?: string; to?: string };

/** 문서 안의 Mermaid 조각 하나. */
export interface MermaidBlock {
  /** ```mermaid 줄의 문서 줄 번호(1부터). 도식 글의 k 번째 줄은 문서의 line + k 번째 줄이다. */
  line: number;
  /** 도식 글(울타리 줄은 뺀다). */
  code: string;
}

/**
 * 문서에서 닫힌 ```mermaid(~~~ 도 같다) 울타리를 찾는다. 다른 코드 울타리 안의 것과 닫히지 않은 것은 도식이 아니다.
 * 화면의 본문 나누기(web/src/lib/agent-a-review.ts 의 splitDoc)가 도식으로 떼는 조각과 같아야 한다(시험이 둘을 견준다).
 */
export function mermaidBlocks(markdown: string): MermaidBlock[] {
  const blocks: MermaidBlock[] = [];
  let fence: string | null = null;
  let open: { line: number; code: string[] } | null = null;
  markdown.split("\n").forEach((line, i) => {
    const f = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (f) {
      const mark = f[1]!;
      if (fence === null) {
        fence = mark[0]!.repeat(mark.length);
        if (f[2]!.trim().toLowerCase() === "mermaid") open = { line: i + 1, code: [] };
        return;
      }
      if (mark[0] === fence[0] && mark.length >= fence.length && !f[2]!.trim()) {
        fence = null;
        if (open) blocks.push({ line: open.line, code: open.code.join("\n") });
        open = null;
        return;
      }
    }
    if (open) open.code.push(line);
  });
  return blocks;
}

const WORD = /[A-Za-z0-9_]/;
/** 줄에 이름이 통째로 나오는지(D 는 DR 이 아니다). 이름은 그려진 도식에서 온 글이라 정규식으로 만들지 않고 글자 그대로 찾는다. */
function mentions(line: string, token: string): boolean {
  if (!token) return false;
  for (let at = line.indexOf(token); at !== -1; at = line.indexOf(token, at + 1)) {
    const before = at === 0 ? "" : line[at - 1]!, after = line[at + token.length] ?? "";
    if (!WORD.test(before) && !WORD.test(after)) return true;
  }
  return false;
}

// 순서도(sequence)의 줄: 메시지(화살표 뒤에 받는 쪽과 쌍점) · 메모 · 틀. 그려진 차례와 글의 차례가 같다.
const SEQ_NOTE = /^\s*note\s+(?:left\s+of|right\s+of|over)\b/i;
const SEQ_FRAME = /^\s*(?:loop|alt|opt|par|critical|break|rect)\b/i;
const SEQ_MESSAGE = /^\s*[^\s:][^:]*?(?:<<)?--?(?:>>|>|x|\))\s*[+-]?\s*[^:\s][^:]*:/;
/** 순서도의 메시지·메모·틀은 이름이 차례 번호다(msg-2: 둘째 메시지). */
export const ORDINAL = /^(msg|note|frame)-(\d+)$/;

/** 도식 글에서 비어 있지 않은 첫 줄과 끝 줄(1부터). 빈 글이면 null. */
function wholeLines(lines: readonly string[]): [number, number] | null {
  let last = lines.length;
  while (last > 0 && !lines[last - 1]!.trim()) last--;
  let first = 1;
  while (first <= last && !lines[first - 1]!.trim()) first++;
  return last === 0 || first > last ? null : [first, last];
}

/**
 * 그 부분이 적힌 도식 글의 줄(1부터, [첫 줄, 끝 줄]). 못 찾으면 null.
 * 노드는 이름이 통째로 나오는 첫 줄, 묶음은 그 이름의 subgraph 줄, 선은 양 끝이 함께 나오는 첫 줄(번호뿐인 선은 찾지 않는다),
 * 순서도의 메시지·메모·틀은 그 차례의 줄, 도식 전체는 글 전부.
 */
export function sourceLineOf(source: string, target: DiagramTarget): [number, number] | null {
  const lines = source.split("\n");
  if (target.kind === "diagram") return wholeLines(lines);
  const ordinal = target.family === "sequence" && target.id !== undefined ? ORDINAL.exec(target.id) : null;
  let index = -1;
  if (ordinal) {
    const is = (line: string) => (ordinal[1] === "note" ? SEQ_NOTE.test(line) : ordinal[1] === "frame" ? SEQ_FRAME.test(line) : SEQ_MESSAGE.test(line) && !SEQ_NOTE.test(line));
    let seen = 0;
    index = lines.findIndex((line) => is(line) && ++seen === Number(ordinal[2]));
  } else if (target.kind === "edge") {
    const { from, to } = target;
    if (from !== undefined && to !== undefined) index = lines.findIndex((line) => mentions(line, from) && mentions(line, to));
  } else if (target.id !== undefined) {
    const id = target.id;
    index = lines.findIndex((line) => (target.kind === "cluster" ? /^\s*subgraph\b/.test(line) : true) && mentions(line, id));
  }
  return index === -1 ? null : [index + 1, index + 1];
}

/** 도식 전체에 다는 댓글의 글: 도식 글의 비어 있지 않은 첫 줄(길면 120자까지). */
export function diagramLabel(source: string): string {
  const first = source.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return first.length > 120 ? `${first.slice(0, 120)}…` : first;
}
