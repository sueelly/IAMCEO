// 마크다운 서식 단추의 글 바꾸기(본문 고치기의 서식 막대). 브라우저 API 를 쓰지 않는다.
// 입력: 본문 전체와 고른 범위(start·end). 출력: 바꿀 범위(from·to)와 넣을 글, 그리고 바꾼 뒤에 고를 범위.

export interface MdEdit {
  from: number;
  to: number;
  insert: string;
  /** 바꾼 뒤 본문에서 고를 범위. */
  selectFrom: number;
  selectTo: number;
}

/** 고른 글을 표시(**·*·~~·`)로 감싼다. 이미 감싸져 있으면 벗긴다. 고른 글이 없으면 표시 한 쌍을 넣고 그 사이에 커서를 둔다. */
export function wrap(text: string, start: number, end: number, mark: string): MdEdit {
  const picked = text.slice(start, end);
  const n = mark.length;
  // 고른 글 바깥이 이미 표시다
  if (start >= n && text.slice(start - n, start) === mark && text.slice(end, end + n) === mark) {
    return { from: start - n, to: end + n, insert: picked, selectFrom: start - n, selectTo: end - n };
  }
  // 고른 글 안쪽이 이미 표시다
  if (picked.length >= 2 * n + 1 && picked.startsWith(mark) && picked.endsWith(mark)) {
    const inner = picked.slice(n, picked.length - n);
    return { from: start, to: end, insert: inner, selectFrom: start, selectTo: start + inner.length };
  }
  // 앞뒤 빈칸은 표시 밖에 둔다(마크다운은 '** 글 **' 을 굵게 하지 않는다)
  const lead = picked.length - picked.trimStart().length, trail = picked.length - picked.trimEnd().length;
  const core = picked.slice(lead, picked.length - trail);
  if (!core) return { from: start, to: end, insert: `${mark}${mark}`, selectFrom: start + n, selectTo: start + n };
  const insert = `${picked.slice(0, lead)}${mark}${core}${mark}${picked.slice(picked.length - trail)}`;
  return { from: start, to: end, insert, selectFrom: start + lead + n, selectTo: start + lead + n + core.length };
}

/** 고른 범위가 걸친 줄 전체. */
function lines(text: string, start: number, end: number): { from: number; to: number; rows: string[] } {
  const from = text.lastIndexOf("\n", start - 1) + 1;
  // 줄 끝의 줄바꿈까지 골랐으면(다음 줄 머리) 그 줄은 넣지 않는다
  const last = end > start && text[end - 1] === "\n" ? end - 1 : end;
  const at = text.indexOf("\n", last);
  const to = at < 0 ? text.length : at;
  return { from, to, rows: text.slice(from, to).split("\n") };
}

const LIST = /^(\s*)(?:[-*+]\s+|\d+[.)]\s+)/;
const QUOTE = /^(\s*)>\s?/;

/**
 * 줄 머리 표시를 붙이거나 뗀다. kind: bullet(- ) · number(1. 2. …) · quote(> ).
 * 고른 줄이 모두 그 표시면 떼고, 아니면 붙인다(목록끼리는 서로 바꾼다).
 */
export function linePrefix(text: string, start: number, end: number, kind: "bullet" | "number" | "quote"): MdEdit {
  const { from, to, rows } = lines(text, start, end);
  const filled = rows.filter((r) => r.trim());
  const has = (r: string) => (kind === "quote" ? QUOTE.test(r) : kind === "bullet" ? /^\s*[-*+]\s+/.test(r) : /^\s*\d+[.)]\s+/.test(r));
  const off = filled.length > 0 && filled.every(has);
  let n = 0;
  const next = rows.map((r) => {
    if (!r.trim() && rows.length > 1) return r;
    if (kind === "quote") return off ? r.replace(QUOTE, "$1") : `> ${r}`;
    const bare = r.replace(LIST, "$1");
    if (off) return bare;
    const indent = /^\s*/.exec(bare)![0];
    return `${indent}${kind === "bullet" ? "- " : `${++n}. `}${bare.slice(indent.length)}`;
  });
  const insert = next.join("\n");
  return { from, to, insert, selectFrom: from, selectTo: from + insert.length };
}

/** 줄의 제목 수준을 돌린다: 글 → # → ## → ### → 글. 여러 줄을 골랐으면 첫 줄만 바꾼다. */
export function heading(text: string, start: number): MdEdit {
  const { from, rows } = lines(text, start, start);
  const row = rows[0] ?? "";
  const m = /^(#{1,6})\s+/.exec(row);
  const level = m ? m[1]!.length : 0;
  const bare = m ? row.slice(m[0].length) : row;
  const next = level >= 3 ? bare : `${"#".repeat(level + 1)} ${bare}`;
  return { from, to: from + row.length, insert: next, selectFrom: from + next.length, selectTo: from + next.length };
}

/** 고른 글을 링크로: [글](주소). 고른 글이 주소면 주소 자리에 넣는다. 바꾼 뒤에는 채울 자리(주소나 글)를 고른다. */
export function link(text: string, start: number, end: number): MdEdit {
  const picked = text.slice(start, end);
  if (/^(https?:\/\/|mailto:)\S+$/i.test(picked.trim())) {
    const insert = `[](${picked.trim()})`;
    return { from: start, to: end, insert, selectFrom: start + 1, selectTo: start + 1 };
  }
  const label = picked || "글";
  const insert = `[${label}](주소)`;
  const at = start + label.length + 3;
  return picked ? { from: start, to: end, insert, selectFrom: at, selectTo: at + 2 } : { from: start, to: end, insert, selectFrom: start + 1, selectTo: start + 1 + label.length };
}

/** 고른 줄들을 코드 울타리로 감싼다. 고른 글이 없으면 빈 울타리를 넣고 그 안에 커서를 둔다. */
export function codeBlock(text: string, start: number, end: number): MdEdit {
  if (start === end) {
    const head = start > 0 && text[start - 1] !== "\n" ? "\n" : "";
    const insert = `${head}\`\`\`\n\n\`\`\`\n`;
    return { from: start, to: end, insert, selectFrom: start + head.length + 4, selectTo: start + head.length + 4 };
  }
  const { from, to, rows } = lines(text, start, end);
  const body = rows.join("\n");
  // 본문에 든 가장 긴 ` 줄보다 긴 울타리를 쓴다
  const fence = "`".repeat(Math.max(3, ...[...body.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  const insert = `${fence}\n${body}\n${fence}`;
  return { from, to, insert, selectFrom: from + fence.length + 1, selectTo: from + fence.length + 1 + body.length };
}

/** 고친 결과를 본문에 적용한 글(시험과, 브라우저가 입력 명령을 받지 않을 때 쓴다). */
export const applyEdit = (text: string, edit: MdEdit): string => text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
