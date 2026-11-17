// 도식의 한 부분에 다는 댓글의 계산. 브라우저 API 를 쓰지 않는다.
// 자리의 모양(이름·글·문서 줄)과 다시 찾는 차례는 원래 Agent-A 화면의 diagramAnchor 와 같게 둔다: 두 화면이 서로의 댓글을 같은 부분에 보인다.
// 자리는 도식 글에 적힌 이름이다. 그려진 좌표는 싣지 않는다(다시 그리면 달라진다). 좌표는 그릴 때마다 그리는 칸이 새로 돌려준다.
// 출처: 자리의 모양과 규칙(이름 읽기·줄 찾기·다시 찾는 차례)은 원래 화면의 편집기 plannotator v0.28.48(backnotprop, MIT OR Apache-2.0)의
// diagramAnchor 규약을 따른다. 그 소스를 싣지 않고 같은 규칙을 이 화면의 짜임(그림 + 겹친 단추)에 맞게 따로 썼다.
import type { AgentADiagramFamily, AgentAReviewDiagramAnchor } from "@shared/agent-a";
import { diagramLabel, ORDINAL, sourceLineOf, type DiagramTarget } from "@shared/agent-a-diagram";

// 도식 글에서 줄을 찾는 규칙은 서버도 쓴다(새 댓글의 자리가 문서의 도식에 이어지는지 본다). 한 곳(shared)에 둔다.
export { sourceLineOf, type DiagramTarget };

/** 그림 전체를 1 로 본 자리(왼쪽 위가 0,0). */
export interface DiagramBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 그려진 도식에서 누를 수 있는 부분 하나. 그리는 칸(server/diagram-frame.ts)이 돌려준 것을 cleanParts 로 다듬은 모양이다. */
export interface DiagramPart {
  kind: "node" | "edge" | "cluster";
  /** 노드·묶음의 이름. 번호만 있는 선(상태도의 전이, 순서도의 메시지)도 이 칸을 쓴다. */
  id?: string;
  /** 선의 양 끝 이름. */
  from?: string;
  to?: string;
  /** 그 부분에 보이는 글. */
  label: string;
  /** 부분을 두르는 자리(표시를 그리는 데 쓴다). */
  box: DiagramBox;
  /** 누르는 자리들. 선은 선을 따라 잘게 나눈 자리와 선에 붙은 글의 자리다. */
  hits: DiagramBox[];
}

const FAMILIES = new Set<string>(["flowchart", "state", "class", "er", "requirement", "sequence", "other"]);
/** 이름·글의 길이. 원래 화면도 이 길이까지만 둔다. */
const MAX_TEXT = 400;
const MAX_PARTS = 300;
const MAX_HITS = 24;

/** 그리는 칸이 밝힌 도식의 갈래. 모르는 값이면 부분을 가르지 않는 도식(other)으로 본다. */
export function cleanFamily(v: unknown): Exclude<AgentADiagramFamily, "graphviz"> {
  return typeof v === "string" && FAMILIES.has(v) ? (v as Exclude<AgentADiagramFamily, "graphviz">) : "other";
}

function cleanBox(v: unknown): DiagramBox | null {
  if (!v || typeof v !== "object") return null;
  const { x, y, w, h } = v as Record<string, unknown>;
  if (![x, y, w, h].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  // 그림 밖으로 나간 부분은 자른다. 안에 있으면 받은 값을 그대로 둔다.
  const cut = (at: number, size: number): [number, number] => {
    const a = Math.max(0, at), b = Math.min(1, at + size);
    return [a, a === at && b === at + size ? size : b - a];
  };
  const [cx, cw] = cut(x as number, w as number), [cy, ch] = cut(y as number, h as number);
  return cw > 0 && ch > 0 ? { x: cx, y: cy, w: cw, h: ch } : null;
}

/**
 * 그리는 칸이 돌려준 부분 목록을 다듬는다. 칸은 믿을 수 없는 도식 글을 그린 곳이라, 모양이 맞는 것만 받는다:
 * 종류·이름이 있고 자리가 그림 안의 숫자인 것만, 글은 400자·부분은 300개·누를 자리는 부분마다 24개까지.
 */
export function cleanParts(v: unknown): DiagramPart[] {
  if (!Array.isArray(v)) return [];
  const out: DiagramPart[] = [];
  for (const raw of v.slice(0, 2_000)) {
    if (out.length >= MAX_PARTS) break;
    if (!raw || typeof raw !== "object") continue;
    const p = raw as Record<string, unknown>;
    if (p.kind !== "node" && p.kind !== "edge" && p.kind !== "cluster") continue;
    const name = (x: unknown): string | undefined => (typeof x === "string" && x ? x.slice(0, MAX_TEXT) : undefined);
    const id = name(p.id), from = name(p.from), to = name(p.to);
    const ends = from !== undefined && to !== undefined;
    if (id === undefined && !(p.kind === "edge" && ends)) continue;
    const box = cleanBox(p.box);
    if (!box) continue;
    const hits = (Array.isArray(p.hits) ? p.hits.slice(0, 200) : []).flatMap((h) => cleanBox(h) ?? []).slice(0, MAX_HITS);
    out.push({
      kind: p.kind,
      ...(id !== undefined ? { id } : {}),
      ...(ends ? { from, to } : {}),
      label: typeof p.label === "string" ? p.label.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT) : "",
      box,
      hits: hits.length ? hits : [box],
    });
  }
  return out;
}

/** 부분을 가리키는 짧은 열쇠(화면의 표시·시험이 쓴다): 이름, 없으면 '시작→끝'. */
export const partKey = (p: Pick<DiagramPart, "id" | "from" | "to">): string => p.id ?? `${p.from ?? ""}→${p.to ?? ""}`;

/** 그 부분을 부르는 글: 보이는 글, 없으면 선의 양 끝, 없으면 이름(원문 칸에 싣는 글과 같다). */
export const anchorText = (a: AgentAReviewDiagramAnchor | Pick<DiagramPart, "label" | "id" | "from" | "to">): string => a.label || (a.from !== undefined && a.to !== undefined ? `${a.from} → ${a.to}` : a.id ?? "");

/**
 * 고른 부분의 자리를 만든다. part 가 null 이면 도식 전체다(글은 도식 글의 첫 줄).
 * fenceLine 은 ```mermaid 줄의 문서 줄 번호다: 도식 글의 k 번째 줄은 문서의 fenceLine + k 번째 줄이다.
 */
export function anchorFor(family: Exclude<AgentADiagramFamily, "graphviz">, part: DiagramPart | null, source: string, fenceLine: number): AgentAReviewDiagramAnchor {
  const inDoc = (line: [number, number] | null): [number, number] | null => (line ? [line[0] + fenceLine, line[1] + fenceLine] : null);
  if (!part) return { v: 1, family, kind: "diagram", label: diagramLabel(source), sourceLine: inDoc(sourceLineOf(source, { family, kind: "diagram" })) };
  const target: DiagramTarget = { family, kind: part.kind, ...(part.id !== undefined ? { id: part.id } : {}), ...(part.from !== undefined && part.to !== undefined ? { from: part.from, to: part.to } : {}) };
  return { v: 1, ...target, label: part.label, sourceLine: inDoc(sourceLineOf(source, target)) };
}

/** 두 자리가 같은 부분을 가리키는지: 종류가 같고, 이름이 있으면 이름이, 없으면 양 끝이 같다. */
function sameTarget(a: Pick<DiagramPart, "kind" | "id" | "from" | "to">, b: Pick<AgentAReviewDiagramAnchor, "kind" | "id" | "from" | "to">): boolean {
  if (a.kind !== b.kind) return false;
  if (a.id !== undefined || b.id !== undefined) return a.id === b.id;
  return a.from === b.from && a.to === b.to;
}

/**
 * 다시 그린 도식에서 자리의 부분을 찾는다. 차례는 원래 화면과 같다: ① 이름(선은 양 끝)이 같은 부분 ② 글이 같은 하나뿐인 노드 ③ 못 찾음(null).
 * 순서도의 메시지·메모·틀은 이름이 차례 번호라, 그 차례의 글이 달라졌으면 글이 같은 하나를 먼저 찾고 없으면 그 차례의 것을 쓴다.
 * 도식 전체는 늘 "whole" 이다. 못 찾은 댓글은 표시 없이 댓글 목록에만 남는다.
 */
export function findPart(parts: readonly DiagramPart[], anchor: AgentAReviewDiagramAnchor): DiagramPart | "whole" | null {
  if (anchor.kind === "diagram") return "whole";
  const byName = parts.find((p) => sameTarget(p, anchor)) ?? null;
  const ordinal = anchor.id !== undefined && ORDINAL.test(anchor.id);
  if (ordinal) {
    if (byName && (!anchor.label || byName.label === anchor.label)) return byName;
    const same = anchor.label ? parts.filter((p) => p.kind === anchor.kind && p.id !== undefined && ORDINAL.test(p.id) && p.label === anchor.label) : [];
    return same.length === 1 ? same[0]! : byName;
  }
  if (byName) return byName;
  if (anchor.kind !== "node" || !anchor.label) return null;
  const same = parts.filter((p) => p.kind === "node" && !(p.id !== undefined && ORDINAL.test(p.id)) && p.label === anchor.label);
  return same.length === 1 ? same[0]! : null;
}

/** 그려진(또는 그리지 못한) 도식 조각 하나의 사정. 댓글이 어느 도식의 것인지 가리는 데 쓴다. */
export interface DiagramBlockInfo {
  /** ```mermaid 줄의 문서 줄 번호. */
  line: number;
  /** 도식 글의 줄 수. */
  lines: number;
  /** 그려졌으면 갈래와 부분. 아직 그리는 중이면 undefined, 그리지 못했으면 null. */
  drawn: { family: AgentADiagramFamily; parts: readonly DiagramPart[] } | null | undefined;
}

/**
 * 도식 댓글이 본문의 몇 번째 도식 것인지. 주인은 갈래가 같은 도식뿐이다: 이름·글만 같은 다른 갈래의 도식은 주인이 아니다
 * (Graphviz 댓글의 B 는 Mermaid 흐름도의 B 가 아니고, 상태도 댓글의 B 도 흐름도의 B 가 아니다. 원래 화면도 Graphviz 댓글을 Mermaid 도식에 대 보지 않는다).
 * 이 화면은 Mermaid 만 그리므로 Graphviz 댓글은 늘 null 이다: 표시 없이 댓글 목록에만 남는다.
 * 자리의 문서 줄이 그 도식의 줄 안이고 그 도식에 그 부분이 있으면 그 도식이다. 줄이 없거나 맞지 않으면(본문이 바뀌었으면)
 * 갈래가 같고 그 자리를 찾는 첫 도식이다(원래 화면과 같다). 가릴 도식을 아직 그리는 중이면 기다린다(null).
 * 어느 도식에서도 못 찾으면 null 이다: 표시 없이 댓글 목록에만 남는다.
 */
export function ownerOf(anchor: AgentAReviewDiagramAnchor, blocks: readonly DiagramBlockInfo[]): number | null {
  const has = (b: DiagramBlockInfo): boolean => b.drawn != null && b.drawn.family === anchor.family && (anchor.kind === "diagram" || findPart(b.drawn.parts, anchor) !== null);
  if (anchor.sourceLine) {
    const [first, last] = anchor.sourceLine;
    const at = blocks.findIndex((b) => first > b.line && last <= b.line + b.lines);
    if (at !== -1) {
      const b = blocks[at]!;
      if (b.drawn === undefined) return null;
      // 도식 전체에 단 댓글은 줄이 가리키는 도식의 것이다(다른 도식으로 옮기지 않는다). 그 도식의 갈래가 다르면 표시하지 않는다.
      if (anchor.kind === "diagram") return has(b) ? at : null;
      if (has(b)) return at;
    }
  }
  if (blocks.some((b) => b.drawn === undefined)) return null;
  const at = blocks.findIndex(has);
  return at === -1 ? null : at;
}
