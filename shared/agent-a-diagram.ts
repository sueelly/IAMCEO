// 도식 글(Mermaid 원문)만으로 하는 계산. 서버와 화면이 같은 규칙을 쓴다: 브라우저 API·그리는 부품을 쓰지 않는다.
// 화면은 이 규칙으로 도식 댓글의 자리(문서 줄·도식 전체의 글)를 만들고, 서버는 같은 규칙으로 새 댓글의 자리가 이 문서의 도식에 이어지는지 본다.
// 자리의 모양(이름·양 끝·번호·문서 줄)은 원래 화면의 편집기 plannotator v0.28.48(backnotprop, MIT OR Apache-2.0)의 diagramAnchor 규약과 같다(그 소스는 싣지 않는다).
// 줄을 찾는 규칙은 다르다: 원래 화면은 이름이 글에 처음 나오는 줄을 쓰고, 여기는 그 부분을 만든 문장의 줄을 쓴다(글 안의 낱말을 부분으로 보지 않으려고).
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

// ---- 도식 글의 문장에서 부분을 뽑는다 ----
// 서버는 도식을 그리지 않는다. 그래서 새 댓글의 대상이 실제로 있는지는 본문의 도식 글에서 갈래별 문장 규칙으로 직접 뽑은 부분 목록으로만 본다.
// 화면이 보낸 이름·글·목록은 근거가 아니다. 글 안의 낱말(상자 안의 글, 선 위의 글, 주석)은 부분이 아니다.
// 규칙이 읽지 못하는 문장의 부분은 목록에 없다(화면은 그 부분을 따로 누를 자리로 내지 않고 도식 전체에 달게 한다. 서버는 받지 않는다).

/** 도식 글에서 문장 규칙으로 뽑은 부분 하나. line 은 그 문장이 적힌 도식 글의 줄(1부터)이다. 이름은 그려진 도식의 이름과 같은 모양이다. */
export interface SourcePart {
  kind: "node" | "edge" | "cluster";
  id?: string;
  from?: string;
  to?: string;
  line: number;
}
/** 도식 글의 첫 문장이 밝히는 갈래. 부분을 뽑는 규칙이 있는 갈래만 가른다(그 밖은 other: 도식 전체에만 단다). */
export type SourceFamily = "flowchart" | "sequence" | "state" | "class" | "er" | "requirement" | "other";

interface Row { text: string; line: number }

/** 문장이 될 수 있는 줄(앞뒤 빈칸을 뗀 글과 줄 번호). 빈 줄 · %% 주석(지시문 포함) · 맨 앞 머리말(--- 사이) · accDescr { } 덩어리를 뺀다. */
function statementRows(source: string): Row[] {
  const lines = source.split("\n");
  const rows: Row[] = [];
  let i = 0;
  while (i < lines.length && !lines[i]!.trim()) i++;
  if (i < lines.length && lines[i]!.trim() === "---") {
    const close = lines.findIndex((l, at) => at > i && l.trim() === "---");
    if (close === -1) return [];
    i = close + 1;
  }
  for (; i < lines.length; i++) {
    const text = lines[i]!.trim();
    if (!text || text.startsWith("%%")) continue;
    if (/^accDescr\s*\{/.test(text) && !text.includes("}")) {
      while (i + 1 < lines.length && !lines[i]!.includes("}")) i++;
      continue;
    }
    rows.push({ text, line: i + 1 });
  }
  return rows;
}

const HEADERS: [RegExp, SourceFamily][] = [
  [/^(?:graph|flowchart(?:-elk)?)(?=\s|;|$)/, "flowchart"],
  [/^sequenceDiagram(?=\s|;|$)/, "sequence"],
  [/^stateDiagram(?:-v2)?(?=\s|;|$)/, "state"],
  [/^classDiagram(?:-v2)?(?=\s|;|$)/, "class"],
  [/^erDiagram(?=\s|;|$)/, "er"],
  [/^requirementDiagram(?=\s|;|$)/, "requirement"],
];

/** 도식 글의 갈래(첫 문장의 낱말로 가린다). */
export function sourceFamily(source: string): SourceFamily {
  const head = statementRows(source)[0];
  return (head && HEADERS.find(([re]) => re.test(head.text))?.[1]) || "other";
}

/** 따옴표 밖에서 짝이 맞는 괄호 덩어리([ ( { 로 시작)를 건너뛴 다음 자리. 짝이 안 맞으면 -1. */
function skipGroup(s: string, p: number): number {
  const close: Record<string, string> = { "[": "]", "(": ")", "{": "}" };
  const stack: string[] = [];
  for (let q = p; q < s.length; q++) {
    const c = s[q]!;
    if (c === '"') {
      const end = s.indexOf('"', q + 1);
      if (end === -1) return -1;
      q = end;
    } else if (close[c]) stack.push(close[c]!);
    else if (c === "]" || c === ")" || c === "}") {
      if (stack.pop() !== c) return -1;
      if (!stack.length) return q + 1;
    }
  }
  return -1;
}

const WORD = /[\p{L}\p{N}_]/u;
/** 흐름도의 이름: 글자·숫자·밑줄. 이음표와 점은 이름 가운데에서만(뒤에 글자가 올 때만) 이름이다(A-->B 의 A, a-b 의 a-b). 이름이 아니면 -1. */
function readName(s: string, p: number): number {
  let q = p;
  while (q < s.length) {
    const c = s[q]!;
    if (WORD.test(c)) q++;
    else if ((c === "-" || c === ".") && q > p && q + 1 < s.length && WORD.test(s[q + 1]!)) q++;
    else break;
  }
  return q > p ? q : -1;
}

// 흐름도의 선(Mermaid 의 낱말 규칙을 따른다): 다 적힌 선과, 글을 사이에 둔 선의 앞·뒤.
const FLOW_LINK = [/[xo<]?--+[-xo>]/y, /[xo<]?==+[=xo>]/y, /[xo<]?-?\.+-[xo>]?/y, /~~~+/y];
const FLOW_TEXT_LINK: [RegExp, RegExp][] = [[/[xo<]?--/y, FLOW_LINK[0]!], [/[xo<]?==/y, FLOW_LINK[1]!], [/[xo<]?-\./y, FLOW_LINK[2]!]];
const at = (re: RegExp, s: string, p: number): number => {
  re.lastIndex = p;
  const m = re.exec(s);
  return m ? p + m[0].length : -1;
};
const skipSpace = (s: string, p: number): number => {
  while (p < s.length && /\s/.test(s[p]!)) p++;
  return p;
};

/** 흐름도의 선 하나를 건너뛴 다음 자리(선 위의 글 |글| · -- 글 --> 도 함께). 선이 아니면 -1. */
function skipFlowLink(s: string, p: number): number {
  let end = -1;
  for (const re of FLOW_LINK) if ((end = at(re, s, p)) !== -1) break;
  if (end === -1) {
    for (const [open, close] of FLOW_TEXT_LINK) {
      const start = at(open, s, p);
      if (start === -1) continue;
      for (let q = start; q < s.length && end === -1; q++) {
        if (s[q] === '"') {
          const quote = s.indexOf('"', q + 1);
          if (quote === -1) return -1;
          q = quote;
        } else end = at(close, s, q);
      }
      break;
    }
    return end;
  }
  const next = skipSpace(s, end);
  if (s[next] !== "|") return end;
  const bar = s.indexOf("|", next + 1);
  return bar === -1 ? -1 : bar + 1;
}

/** 흐름도의 한 줄을 문장으로 가른다(따옴표·괄호·|글| 밖의 쌍반점에서). */
function flowStatements(text: string): string[] {
  const out: string[] = [];
  let depth = 0, quote = false, bar = false, from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') quote = !quote;
    else if (quote) continue;
    else if (c === "|") bar = !bar;
    else if (bar) continue;
    else if (c === "[" || c === "(" || c === "{") depth++;
    else if (c === "]" || c === ")" || c === "}") depth = Math.max(0, depth - 1);
    else if (c === ";" && depth === 0) {
      out.push(text.slice(from, i));
      from = i + 1;
    }
  }
  out.push(text.slice(from));
  return out.map((x) => x.trim()).filter(Boolean);
}

/**
 * 흐름도의 이음 문장 하나(A[글] --> B & C -->|글| D)에서 노드와 선을 뽑는다. 끝까지 읽지 못한 문장에서는 아무것도 뽑지 않는다.
 * 노드: 이름 뒤의 모양 글([ ] ( ) { } >…]) · :::꾸밈 · @{ } 는 건너뛴다. 선: 앞 묶음의 노드마다 뒤 묶음의 노드로 하나씩(보이지 않는 선 ~~~ 은 뺀다).
 */
function flowChain(s: string, line: number): SourcePart[] | null {
  const parts: SourcePart[] = [];
  let previous: string[] | null = null;
  let p = skipSpace(s, 0);
  for (;;) {
    const group: string[] = [];
    for (;;) {
      const end = readName(s, p);
      if (end === -1) return null;
      const id = s.slice(p, end);
      p = end;
      for (;;) {
        const c = s[p];
        let next = -1;
        if (c === "[" || c === "(" || c === "{") next = skipGroup(s, p);
        else if (c === ">") next = s.indexOf("]", p) + 1 || -1;
        else if (s.startsWith("@{", p)) next = skipGroup(s, p + 1);
        else if (s.startsWith(":::", p)) next = readName(s, p + 3);
        else break;
        if (next === -1) return null;
        p = next;
      }
      group.push(id);
      parts.push({ kind: "node", id, line });
      p = skipSpace(s, p);
      if (s[p] !== "&") break;
      p = skipSpace(s, p + 1);
    }
    if (previous) for (const from of previous) for (const to of group) parts.push({ kind: "edge", from, to, line });
    if (p >= s.length) return parts;
    const next = skipFlowLink(s, p);
    if (next === -1) return null;
    // 보이지 않는 선(~~~)은 그려지지 않는다: 노드만 잇고 선으로 내지 않는다.
    previous = s[p] === "~" ? null : group;
    p = skipSpace(s, next);
  }
}

const FLOW_SKIP = /^(?:direction|style|classDef|class|linkStyle|click|accTitle|accDescr|interpolate)(?=\s|:|$)/;

/**
 * 흐름도: 노드(이름) · 선(양 끝) · 묶음(이름). 제목만 있고 빈칸이 든 묶음은 Mermaid 가 번호로 이름을 붙인다(subGraphN):
 * N 은 모든 묶음을 닫히는(end) 차례로 센 번호다(Mermaid 12.2.0 의 addSubGraph).
 */
function flowParts(rows: Row[]): SourcePart[] {
  const parts: SourcePart[] = [];
  const open: { line: number; id: string | null }[] = [];
  let closed = 0;
  rows.forEach((row, i) => {
    const text = i === 0 ? row.text.replace(HEADERS[0]![0], "").replace(/^\s*(?:TB|TD|BT|RL|LR|[<>^v])?(?=\s|;|$)/, "") : row.text;
    for (const s of flowStatements(text)) {
      const sub = /^subgraph(?:\s+(.*))?$/.exec(s);
      if (sub) {
        const rest = (sub[1] ?? "").trim();
        const titled = /^([^\s[\]"]+)\s*\[.*\]$/.exec(rest), quoted = /^"(.*)"$/.exec(rest);
        const name = titled ? titled[1]! : quoted ? quoted[1]! : rest;
        // 이름이 없는 묶음(subgraph 만)은 번호는 차지하지만 부분으로 내지 않는다.
        open.push({ line: row.line, id: !rest ? "" : titled || !/\s/.test(name) ? name : null });
      } else if (s === "end") {
        const sub = open.pop();
        if (!sub) continue;
        const id = sub.id ?? `subGraph${closed}`;
        closed++;
        if (id) parts.push({ kind: "cluster", id, line: sub.line });
      } else if (!FLOW_SKIP.test(s)) parts.push(...(flowChain(s, row.line) ?? []));
    }
  });
  return parts;
}

// 순서도(sequence)의 줄: 메시지(화살표 뒤에 받는 쪽과 쌍점) · 메모 · 틀. 그려진 차례와 글의 차례가 같다.
const SEQ_NOTE = /^note\s+(?:left\s+of|right\s+of|over)\b/i;
const SEQ_FRAME = /^(?:loop|alt|opt|par|critical|break|rect)\b/i;
const SEQ_MESSAGE = /^([^\s:][^:]*?)\s*(?:<<)?--?(?:>>|>|x|\))\s*[+-]?\s*([^:\s][^:]*?)\s*:/;
const SEQ_ACTOR = /^(?:create\s+)?(participant|actor)\s+(.+?)(?:\s+as\s+.*)?$/i;
/** 순서도의 메시지·메모·틀은 이름이 차례 번호다(msg-2: 둘째 메시지). */
export const ORDINAL = /^(msg|note|frame)-(\d+)$/;

/**
 * 순서도: 참여자(이름: 선언한 줄이나 처음 메시지를 주고받은 줄) · 메시지 · 메모 · 틀(차례 번호).
 * actor 로 선언한 참여자(사람 그림)는 누를 부분으로 그려지지 않아 내지 않는다.
 */
function sequenceParts(rows: Row[]): SourcePart[] {
  const parts: SourcePart[] = [];
  const figures = new Set<string>();
  let message = 0, note = 0, frame = 0;
  for (const { text, line } of rows.slice(1)) {
    if (SEQ_NOTE.test(text)) parts.push({ kind: "node", id: `note-${++note}`, line });
    else if (SEQ_FRAME.test(text)) parts.push({ kind: "cluster", id: `frame-${++frame}`, line });
    else {
      const actor = SEQ_ACTOR.exec(text), sent = actor ? null : SEQ_MESSAGE.exec(text);
      if (actor) {
        const id = actor[2]!.trim();
        if (actor[1]!.toLowerCase() === "actor") figures.add(id);
        else parts.push({ kind: "node", id, line });
      }
      if (sent) parts.push({ kind: "edge", id: `msg-${++message}`, line }, { kind: "node", id: sent[1]!.trim(), line }, { kind: "node", id: sent[2]!.trim(), line });
    }
  }
  return parts.filter((p) => p.kind !== "node" || !figures.has(p.id!));
}

const NAME = "[\\p{L}\\p{N}_]+";
const STATE_END = `(?:\\[\\*\\]|${NAME})(?::::${NAME})?`;
const STATE_TRANSITION = new RegExp(`^(${STATE_END})\\s*-->\\s*(${STATE_END})\\s*(?::.*)?$`, "u");
const STATE_DECLARED = [
  new RegExp(`^state\\s+"[^"]*"\\s+as\\s+(${NAME})\\s*\\{?$`, "u"),
  new RegExp(`^state\\s+(${NAME})\\s*(?:<<\\w+>>|\\[\\[\\w+\\]\\])?\\s*\\{?$`, "u"),
  new RegExp(`^(${NAME})\\s*:\\s*\\S.*$`, "u"),
  new RegExp(`^(${NAME})$`, "u"),
];
const STATE_SKIP = /^(?:\}|--|\[\*\]|(?:direction|hide|scale|classDef|class|style|accTitle|accDescr)(?=\s|:|$).*)$/;
const STATE_NOTE = /^note\s+(?:left|right)\s+of\s+\S+\s*(:.*)?$/i;

/**
 * 상태도: 상태(이름) · 전이(번호). Mermaid 는 전이에 이름을 주지 않고 번호를 붙인다(edgeN):
 * N 은 전이와 메모를 글의 차례로 함께 센 번호다(묶음 상태 안의 것도 적힌 자리에서 센다. Mermaid 12.2.0 의 dataFetcher).
 * 읽지 못한 전이·메모 문장이 나오면 그 뒤의 번호는 믿을 수 없어 전이를 더 내지 않는다. 메모 · 구획(--)이 만든 조각 · 시작과 끝 점은 부분으로 내지 않는다.
 */
function stateParts(rows: Row[]): SourcePart[] {
  const parts: SourcePart[] = [];
  let count = 0, counted = true;
  for (let i = 1; i < rows.length; i++) {
    const { text, line } = rows[i]!;
    if (STATE_SKIP.test(text)) continue;
    const note = STATE_NOTE.exec(text);
    if (note) {
      count++;
      if (!note[1]) while (i + 1 < rows.length && !/^end\s+note$/i.test(rows[i]!.text)) i++;
      continue;
    }
    const move = STATE_TRANSITION.exec(text);
    if (move) {
      if (counted) parts.push({ kind: "edge", id: `edge${count}`, line });
      count++;
      for (const end of [move[1]!, move[2]!]) if (end !== "[*]") parts.push({ kind: "node", id: end.split(":::")[0]!, line });
      continue;
    }
    const declared = STATE_DECLARED.map((re) => re.exec(text)).find(Boolean);
    if (declared) parts.push({ kind: "node", id: declared[1]!, line });
    // 읽지 못한 문장: 전이(-->)나 메모(note)일 수 있는 것만 번호를 흔든다. 그 밖(state … 선언의 다른 모양 등)은 번호를 차지하지 않는다.
    else if (text.includes("-->") || /^note\b/i.test(text)) counted = false;
  }
  return parts;
}

/** 여는 중괄호로 끝난 덩어리(class X { … })의 닫는 줄까지 건너뛴 자리. */
function skipBody(rows: Row[], i: number): number {
  while (i + 1 < rows.length && rows[i]!.text !== "}") i++;
  return i;
}

const CLASS_NAME = `(?:\`[^\`]+\`|${NAME})(?:~[^~]*~)?`;
const CLASS_RELATION = new RegExp(`^(${CLASS_NAME})\\s*(?:"[^"]*"\\s*)?[<|*o()]*(?:--|\\.\\.)[>|*o()]*\\s*(?:"[^"]*"\\s*)?(${CLASS_NAME})\\s*(?::.*)?$`, "u");
const CLASS_DECLARED = new RegExp(`^class\\s+(${CLASS_NAME})(?:\\s*\\["[^"]*"\\])?(?:\\s*:::${NAME})?\\s*(\\{.*)?$`, "u");
const CLASS_NAMED = [new RegExp(`^(${CLASS_NAME})\\s*:\\s*\\S.*$`, "u"), new RegExp(`^<<[^>]+>>\\s+(${CLASS_NAME})$`, "u")];
const className = (text: string): string => text.replace(/~[^~]*~$/, "").replace(/^`|`$/g, "");

/** 클래스도: 클래스(이름) · 관계(적힌 차례의 양 끝). 클래스 몸(중괄호 안)의 줄은 부분이 아니다. */
function classParts(rows: Row[]): SourcePart[] {
  const parts: SourcePart[] = [];
  for (let i = 1; i < rows.length; i++) {
    const { text, line } = rows[i]!;
    const declared = CLASS_DECLARED.exec(text);
    if (declared) {
      parts.push({ kind: "node", id: className(declared[1]!), line });
      if (declared[2] && !declared[2].includes("}")) i = skipBody(rows, i + 1);
      continue;
    }
    const relation = CLASS_RELATION.exec(text);
    if (relation) {
      const from = className(relation[1]!), to = className(relation[2]!);
      parts.push({ kind: "node", id: from, line }, { kind: "node", id: to, line }, { kind: "edge", from, to, line });
      continue;
    }
    const named = CLASS_NAMED.map((re) => re.exec(text)).find(Boolean);
    if (named) parts.push({ kind: "node", id: className(named[1]!), line });
  }
  return parts;
}

const ER_NAME = `(?:"[^"]+"|[\\p{L}\\p{N}_][\\p{L}\\p{N}_-]*)`;
const ER_RELATION = new RegExp(`^(${ER_NAME})\\s*(?:\\|o|\\|\\||\\}o|\\}\\|)(?:--|\\.\\.)(?:o\\||\\|\\||o\\{|\\|\\{)\\s*(${ER_NAME})\\s*:.*$`, "u");
const ER_ENTITY = new RegExp(`^(${ER_NAME})(?:\\s*\\[[^\\]]*\\])?\\s*(\\{.*)?$`, "u");
const unquote = (text: string): string => text.replace(/^"|"$/g, "");

/** 관계도(ER): 개체(이름) · 관계(적힌 차례의 양 끝). 개체 몸(중괄호 안)의 줄은 부분이 아니다. */
function erParts(rows: Row[]): SourcePart[] {
  const parts: SourcePart[] = [];
  for (let i = 1; i < rows.length; i++) {
    const { text, line } = rows[i]!;
    if (/^(?:direction|style|classDef|class|accTitle|accDescr)(?=\s|:|$)/.test(text)) continue;
    const relation = ER_RELATION.exec(text);
    if (relation) {
      const from = unquote(relation[1]!), to = unquote(relation[2]!);
      parts.push({ kind: "node", id: from, line }, { kind: "node", id: to, line }, { kind: "edge", from, to, line });
      continue;
    }
    const entity = ER_ENTITY.exec(text);
    if (!entity) continue;
    parts.push({ kind: "node", id: unquote(entity[1]!), line });
    if (entity[2] && !entity[2].includes("}")) i = skipBody(rows, i + 1);
  }
  return parts;
}

const REQ_NAME = `(?:"[^"]+"|${NAME})`;
const REQ_BLOCK = new RegExp(`^(?:requirement|functionalRequirement|interfaceRequirement|performanceRequirement|physicalRequirement|designConstraint|element)\\s+(${REQ_NAME})\\s*(\\{.*)?$`, "iu");
const REQ_KIND = "(?:contains|copies|derives|satisfies|verifies|refines|traces)";
const REQ_FORWARD = new RegExp(`^(${REQ_NAME})\\s*-\\s*${REQ_KIND}\\s*->\\s*(${REQ_NAME})$`, "iu");
const REQ_BACKWARD = new RegExp(`^(${REQ_NAME})\\s*<-\\s*${REQ_KIND}\\s*-\\s*(${REQ_NAME})$`, "iu");

/** 요구사항도: 요구사항과 요소(이름) · 관계(이름이 '보내는 쪽-받는 쪽'이다). */
function requirementParts(rows: Row[]): SourcePart[] {
  const parts: SourcePart[] = [];
  for (let i = 1; i < rows.length; i++) {
    const { text, line } = rows[i]!;
    const block = REQ_BLOCK.exec(text);
    if (block) {
      parts.push({ kind: "node", id: unquote(block[1]!), line });
      if (block[2] && !block[2].includes("}")) i = skipBody(rows, i + 1);
      continue;
    }
    const forward = REQ_FORWARD.exec(text), backward = forward ? null : REQ_BACKWARD.exec(text);
    if (forward) parts.push({ kind: "edge", id: `${unquote(forward[1]!)}-${unquote(forward[2]!)}`, line });
    if (backward) parts.push({ kind: "edge", id: `${unquote(backward[2]!)}-${unquote(backward[1]!)}`, line });
  }
  return parts;
}

/**
 * 도식 글에서 문장 규칙으로 뽑은 부분들(글의 차례). 같은 부분이 여러 줄에 나오면 여러 번 든다(처음 것이 그 부분의 줄이다).
 * 규칙이 없는 갈래(원그래프 등)와 읽지 못한 문장에서는 아무것도 나오지 않는다.
 */
export function sourceParts(source: string): SourcePart[] {
  const rows = statementRows(source);
  switch (sourceFamily(source)) {
    case "flowchart": return flowParts(rows);
    case "sequence": return sequenceParts(rows);
    case "state": return stateParts(rows);
    case "class": return classParts(rows);
    case "er": return erParts(rows);
    case "requirement": return requirementParts(rows);
    default: return [];
  }
}

/** 뽑은 부분 가운데 그 대상의 줄. 번호나 이름(id)이 있으면 그것으로, 없으면 선의 양 끝으로 찾는다. 없으면 null. */
export function partLine(parts: readonly SourcePart[], target: DiagramTarget): number | null {
  const { id, from, to } = target;
  const hit = parts.find((p) => p.kind === target.kind && (id !== undefined ? p.id === id : from !== undefined && to !== undefined && p.from === from && p.to === to));
  return hit ? hit.line : null;
}

/** 도식 글에서 비어 있지 않은 첫 줄과 끝 줄(1부터). 빈 글이면 null. */
function wholeLines(lines: readonly string[]): [number, number] | null {
  let last = lines.length;
  while (last > 0 && !lines[last - 1]!.trim()) last--;
  let first = 1;
  while (first <= last && !lines[first - 1]!.trim()) first++;
  return last === 0 || first > last ? null : [first, last];
}

/**
 * 그 부분의 문장이 적힌 도식 글의 줄(1부터, [첫 줄, 끝 줄]). 도식 글의 문장에서 그 부분을 찾지 못하면 null.
 * 부분은 sourceParts 가 뽑은 것만 찾는다(자리의 갈래 칸은 보지 않는다: 갈래는 도식 글이 정한다). 도식 전체는 글 전부.
 */
export function sourceLineOf(source: string, target: DiagramTarget): [number, number] | null {
  if (target.kind === "diagram") return wholeLines(source.split("\n"));
  const line = partLine(sourceParts(source), target);
  return line === null ? null : [line, line];
}

/** 도식 전체에 다는 댓글의 글: 도식 글의 비어 있지 않은 첫 줄(길면 120자까지). */
export function diagramLabel(source: string): string {
  const first = source.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return first.length > 120 ? `${first.slice(0, 120)}…` : first;
}
