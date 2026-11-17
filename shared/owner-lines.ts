// 보고·결재 카드 첫 줄 약속. DB 칸을 늘리지 않고, 서버가 글 맨 위에 정해진 한 줄을 쓰고 웹이 그 줄을 읽는다.
//   보고 본문 첫 줄:      "● 대표 차례: <owner_action>"
//   결재 카드 detail 첫 줄: "★ 권장: <권장 선택지 label> — <rec_reason>"
// 서버(server/orchestrator.ts)와 웹은 이 파일의 함수만 쓴다. 줄 모양을 바꾸면 양쪽이 함께 바뀐다.

export const OWNER_LINE_PREFIX = "● 대표 차례: ";
export const REC_LINE_PREFIX = "★ 권장: ";
/** 권장 줄에서 선택지 이름과 이유를 가르는 글자(앞뒤 빈칸 포함). */
export const REC_REASON_SEPARATOR = " — ";

// 직원이 손으로 쓴 줄도 읽는다: 앞뒤 굵은 표시(**), ●/★ 뒤 빈칸 없음, 전각 쌍점.
const OWNER_RE = /^●\s*대표\s*차례\s*[:：]\s*(.*\S)\s*$/;
const REC_RE = /^★\s*권장\s*[:：]\s*(.*\S)\s*$/;

/** 한 줄로 만든다. 줄바꿈·연속 빈칸은 빈칸 하나로. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** 첫 번째 비지 않은 줄과 그 뒤 나머지(앞 빈 줄 제거). */
function splitFirstLine(text: string): { first: string; rest: string } {
  const src = text.replace(/\r\n?/g, "\n").replace(/^(?:[ \t]*\n)+/, "");
  const at = src.indexOf("\n");
  const first = at < 0 ? src : src.slice(0, at);
  const rest = at < 0 ? "" : src.slice(at + 1).replace(/^(?:[ \t]*\n)+/, "");
  return { first, rest };
}

function unbold(line: string): string {
  return line.replace(/\*\*|__/g, "").trim();
}

// ---- 보고: 대표 차례 줄 ----

export function buildOwnerLine(action: string): string {
  return `${OWNER_LINE_PREFIX}${oneLine(action)}`;
}

export interface ParsedOwnerLine {
  /** 대표가 할 일(한 줄). */
  action: string;
  /** 대표 차례 줄을 뺀 나머지 본문. */
  rest: string;
}

/** 본문 첫 줄이 대표 차례 줄이면 그 내용과 나머지 본문을 돌려준다. 아니면 null. */
export function parseOwnerLine(body: string | null | undefined): ParsedOwnerLine | null {
  if (!body) return null;
  const { first, rest } = splitFirstLine(body);
  const m = OWNER_RE.exec(unbold(first));
  return m ? { action: m[1]!, rest } : null;
}

/**
 * 본문 맨 위에 대표 차례 줄을 둔다. action 이 비면 본문을 그대로 돌려준다.
 * 본문이 이미 대표 차례 줄로 시작하면 그 줄을 새 줄로 바꾼다(두 줄이 되지 않게).
 */
export function withOwnerLine(body: string | null | undefined, action: string | null | undefined): string {
  const text = body ?? "";
  const value = oneLine(action ?? "");
  if (!value) return text;
  const rest = parseOwnerLine(text)?.rest ?? text.replace(/^\s+/, "");
  return rest ? `${buildOwnerLine(value)}\n\n${rest}` : buildOwnerLine(value);
}

// ---- 결재 카드: 권장 줄 ----

export function buildRecLine(label: string, reason?: string | null): string {
  const why = oneLine(reason ?? "");
  return `${REC_LINE_PREFIX}${oneLine(label)}${why ? `${REC_REASON_SEPARATOR}${why}` : ""}`;
}

export interface ParsedRecLine {
  /** '★ 권장: ' 뒤의 글 전체. */
  text: string;
  /** 권장 선택지 이름. 가르는 글자가 없으면 text 와 같다. */
  label: string;
  /** 권장 이유. 없으면 빈 글. */
  reason: string;
  /** 권장 줄을 뺀 나머지 detail. */
  rest: string;
}

/**
 * detail 첫 줄이 권장 줄이면 나눠 돌려준다. 아니면 null.
 * recLabel 을 주면(카드의 권장 선택지 label) 이름 안에 가르는 글자가 있어도 바르게 나눈다.
 */
export function parseRecLine(detail: string | null | undefined, recLabel?: string | null): ParsedRecLine | null {
  if (!detail) return null;
  const { first, rest } = splitFirstLine(detail);
  const m = REC_RE.exec(unbold(first));
  if (!m) return null;
  const text = m[1]!;
  const known = recLabel ? oneLine(recLabel) : "";
  if (known && text.startsWith(`${known}${REC_REASON_SEPARATOR}`)) return { text, label: known, reason: text.slice(known.length + REC_REASON_SEPARATOR.length).trim(), rest };
  if (known && text === known) return { text, label: known, reason: "", rest };
  const at = text.indexOf(REC_REASON_SEPARATOR);
  return at < 0 ? { text, label: text, reason: "", rest } : { text, label: text.slice(0, at).trim(), reason: text.slice(at + REC_REASON_SEPARATOR.length).trim(), rest };
}

/**
 * detail 맨 위에 권장 줄을 둔다. 이미 권장 줄로 시작하면 그 줄을 바꾼다.
 * label 이나 reason 이 비면 detail 을 그대로 돌려준다(이유 없는 권장은 화면이 선택지 표시로 보여 준다).
 */
export function withRecLine(detail: string | null | undefined, label: string | null | undefined, reason: string | null | undefined): string {
  const text = detail ?? "";
  if (!oneLine(label ?? "") || !oneLine(reason ?? "")) return text;
  const rest = parseRecLine(text)?.rest ?? text.replace(/^\s+/, "");
  const line = buildRecLine(label!, reason);
  return rest ? `${line}\n\n${rest}` : line;
}

/** 예전 결재 본문에서 별도의 검수 절차를 설명하던 문구. */
export const EXTERNAL_REVIEW_BOILERPLATE = "대표 요청에 따른 외부 검수 대행입니다.";
