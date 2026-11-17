// 서버가 붙이는 새 업무 이름(임시). 글에서 목적 문장을 골라 만든다. 이름은 칩·목록·전달 글의 '작업 #' 줄에 그대로 보이므로
// 주소·내부 번호·해시·비밀값을 남기지 않는다. 브라우저·DB 를 쓰지 않는 순수 함수다.

/** 자동 임시 이름도 task 도구의 120자 범위에서 목적을 보존한다. 화면 폭으로 저장 내용을 자르지 않는다. */
export const TASK_TITLE_MAX = 120;

const URL = /\b(?:https?|ftp|file):\/\/\S+|\bwww\.\S+/gi;
/** 이 서버의 내부 id(msg_·tk_·f_·d_·dl_·m_·w_·p_·mc_·op_ 등)와 기억 id. */
const INTERNAL_ID = /#?\b(?:msg|tk|tk_w|f|d|dl|m|w|p|mc|op|run|ex|wf|sess|req)_[A-Za-z0-9_]{5,}\b|\bexp-[0-9a-f]{6,}\b/gi;
/** 커밋 해시처럼 보이는 16진수(숫자와 글자가 함께 있는 7자 이상). */
const HASH = /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,64}\b/gi;
/** 토큰·키처럼 보이는 긴 영숫자(숫자와 글자가 함께 있는 20자 이상). */
const TOKEN = /\b(?=[A-Za-z0-9+/=_-]*\d)(?=[A-Za-z0-9+/=_-]*[A-Za-z])[A-Za-z0-9+/=_-]{20,}\b/g;
/** 비밀값 낱말 뒤의 숫자 섞인 값. 낱말은 남기고 값만 가린다(예: "접속코드는 언제나 1234로" → "접속코드는 언제나 …로"). */
const SECRET_VALUE = /(비밀\s*번호|비번|암호|패스워드|접속\s*코드|인증\s*코드|인증\s*번호|코드|토큰|키|password|passcode|passwd|pin|token|secret|api[\s_-]*key|key)(\s*(?:[:=]|은|는|이|가|을|를|도)?\s*(?:언제나|항상|모두|전부)?\s*)((?=[^\s가-힣]*\d)[^\s,.;:!?'"“”‘’()[\]{}가-힣]{3,})/gi;
/** 경로(영문 낱말 사이 슬래시가 둘 이상)와 내부 주소·포트. '디자인/개발/시험' 같은 한글 나열은 남긴다. */
const PATH = /(?:~|\.{1,2})?\/(?:[\w.~-]+\/)+[\w.~-]*|\b(?:localhost|127\.0\.0\.1|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?\b/g;
/** 이메일. */
const EMAIL = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g;
/** 전화번호·카드번호처럼 긴 숫자(6자리 이상, 사이 기호 허용). */
const LONG_NUMBER = /\b\d(?:[\d -]{4,}\d)\b/g;

/** 한 줄의 비밀값·내부 번호·주소를 지운다. 지운 자리는 '…' 하나로 둔다. */
export function scrubTaskText(text: string): string {
  return text
    .replace(URL, "…")
    .replace(EMAIL, "…")
    .replace(PATH, "…")
    .replace(INTERNAL_ID, "…")
    .replace(SECRET_VALUE, (_m, word: string, glue: string) => `${word}${glue}…`)
    .replace(TOKEN, "…")
    .replace(HASH, "…")
    .replace(LONG_NUMBER, (m) => (m.replace(/\D/g, "").length >= 6 ? "…" : m))
    .replace(/(?:\s*…\s*){2,}/g, " … ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 마크다운 꾸밈을 걷어 낸 내용 줄들. 인용(> 줄)은 남의 말이라 뒤로 돌린다(인용만 있는 글이면 인용을 쓴다). */
function contentLines(text: string): string[] {
  const own: string[] = [];
  const quoted: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const isQuote = /^\s*>/.test(raw);
    const line = scrubTaskText(raw
      .replace(/^\s*(?:>\s*)+/, "")
      .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/, "")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]+)\]\(([^)]*)\)/g, "$1"))
      .replace(/\*\*|__|[*`]|~~/g, "")
      .trim();
    if (line.replace(/[…\s\p{P}\p{S}]/gu, "").length >= 2) (isQuote ? quoted : own).push(line);
  }
  return [...own, ...quoted];
}

/** 길면 낱말 경계에서 자르고 '…'를 붙인다. */
function cut(text: string, max: number): string {
  // Match oneLineProblem / Zod's UTF-16 bound without splitting a surrogate pair.
  if (text.length <= max) return text;
  let head = "";
  for (const char of text) {
    if (head.length + char.length > max - 1) break;
    head += char;
  }
  const space = head.lastIndexOf(" ");
  return `${(space >= max * 0.6 ? head.slice(0, space) : head).replace(/[\s,.;:·…-]+$/, "")}…`;
}

/** 부탁·지시의 표지. 이런 말이 든 문장을 글의 목적으로 본다(대표 2026-11-14: "첫 글에서가 아니라, 내용에서 목적을 추출해서"). */
const REQUEST_CUE = /해\s?줘|해\s?주세요|해\s?주십시오|해\s?줄래|해\s?봐|봐\s?줘|내\s?놔|알려\s?줘|부탁|해야\s?(?:해|돼|겠)|하자|합시다|해라|하도록|되도록|붙도록|하게\s?해|싶어|싶다|원해|바라|좋겠|(?:만들|고쳐|바꿔|넣어|올려|합쳐|맡겨|시켜|붙여|돌려|보내|지워|정해|줄여|늘려|나눠|옮겨)|(?:확인|정리|분석|개선|구현|검토|조사|적용|반영|진행|추가|삭제|수정|통일|준비|설정|연결|정의|비교|설계|작성|기록|요약|번역|검증|시험)\s?해/;
/** 목적 문장 끝의 부탁 말. 떼면 무엇을 할지만 남는다. */
const REQUEST_END = /\s*(?:좀\s*)?(?:해\s?줘|해\s?주세요|해\s?주십시오|해\s?줄래|해\s?봐|봐\s?줘|내\s?놔|알려\s?줘|해야\s?(?:해|돼|겠어)|하자|합시다|해라|부탁(?:해|합니다|드립니다|드려요)?|해)\s*[.!~]*$/;
/** 문장 앞의 군말. */
const FILLER = /^(?:(?:그리고|그럼|그러면|근데|그런데|아니|음+|아+|어+|자|일단|우선|혹시|이거|저기|그래서|또)[\s,.…]+)+/;
const meaningful = (text: string) => text.replace(/[…\s\p{P}\p{S}]/gu, "").length;

/** 내용 줄을 문장으로 나눈다(마침표·물음표·느낌표 뒤). */
function sentences(lines: string[]): string[] {
  return lines.flatMap((line) => line.split(/(?<=[.!?。？！])\s+/)).map((s) => s.replace(/^[\s…,.;:·-]+/, "").trim()).filter((s) => meaningful(s) >= 2);
}

/**
 * 글에서 새 업무 이름을 만든다. 첫 줄이 아니라 부탁·지시가 든 첫 문장을 목적으로 보고, 앞 군말과 끝의 부탁 말을 뗀다
 * (예: "… 모든 것에 업무가 붙도록 해줘" → "모든 것에 업무가 붙도록"). 그런 문장이 없으면 첫 문장을 쓴다.
 * 주소·내부 번호·해시·비밀값은 지우고 도구의 이름 범위까지 보존한다. 남는 글자가 없으면 fallback 을 쓴다.
 * 이 이름은 임시다. 총괄·직원이 대화로 목적을 알게 되면 task 도구로 목적 이름으로 바꾼다(formatTaskLine 의 안내).
 */
export function taskTitleFrom(text: string, fallback: string): string {
  const all = sentences(contentLines(text));
  const sentence = all.find((s) => REQUEST_CUE.test(s)) ?? all[0];
  if (!sentence) return cut(scrubTaskText(fallback) || "새 업무", TASK_TITLE_MAX);
  const core = sentence.replace(FILLER, "").replace(REQUEST_END, "").replace(/[\s,.;:·…-]+$/, "").trim();
  return cut(meaningful(core) >= 4 ? core : sentence.replace(/[.!?。？！]+$/, ""), TASK_TITLE_MAX);
}

/** 대표가 직접 붙인 이름은 기존 HTTP 입력 범위(200자)까지 보존한다. */
export function ownerTaskTitle(text: string): string {
  return cut(text.replace(/\s+/g, " ").trim(), 200);
}

/** 이름을 못 만들 때 쓰는 이름: '대표 글 11월 13일 20:15'(서울 시각). 내부 번호를 쓰지 않는다. */
export function datedTitle(label: string, at: string | Date): string {
  const d = typeof at === "string" ? new Date(at) : at;
  const parts = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(Number.isNaN(d.getTime()) ? new Date() : d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${label} ${get("month")}월 ${get("day")}일 ${get("hour")}:${get("minute")}`;
}
