// 글 검사기(경고만, 막지 않음). 직원이 post·ask·file(content)로 올린 글을 재고, 걸린 곳을 도구 결과 끝에 붙여 직원에게 돌려준다.
// 대표 화면에는 보이지 않는다. 막으면 다듬지 않은 마지막 글이 대신 올라가므로 언제나 경고로 끝낸다.
// 길이·강조 개수·기술 용어 때문에 대상과 근거를 지우게 하지 않는다.
// 이 검사는 의미 판정이 아닌 비차단 안내이며 공통 작성 프롬프트를 보완한다.
import { parseOwnerLine, parseRecLine } from "../shared/owner-lines.ts";

/** 도구 결과에 붙일 경고 줄 수(머리 줄 제외). */
export const MAX_WARNING_LINES = 4;

export interface LintWarning {
  /** 검사 이름. 시험과 정렬에 쓴다. */
  code: string;
  /** 직원에게 보일 한 줄. */
  text: string;
}

// ---------- 3판 검사 ----------
// '완료·막힘', '완료 보고', '\'완료\''처럼 종류 이름으로 쓴 '완료'는 주장이 아니다.
const DONE = /((?<!['‘])완료(?![·'’]|\s?보고)|끝났|끝냈|마쳤|다\s?됐|구현했|적용했|반영했|통과했)/;
const VERIFY = /(시험|확인|검사|쟀|측정|캡처|대비|열어|돌려|통과)/;
// '~할 수 있습니다'는 능력을 말할 때가 많아 오탐이 잦다. 시안의 그 항목은 옮기지 않았다.
// '아마'는 낱말일 때만 본다(아마존·아마추어는 아니다).
const UNSURE = /(것 같|로 보입니다|듯합니다|듯하다|로 보인다|(?<![가-힣])아마(?:도)?(?=\s|$|[,.]))/;
const UNSURE_LABEL = /(미정|가정|확인하지 못|확인 전|위험)/;
const OWNER_ASK = /(주세요|주십시오|할까요|될까요|까요)[.?!]*$/;

// ---------- 글 꺼내기 ----------
function stripMd(src: string): string {
  return src
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/\*\*|__/g, "")
    .replace(/`/g, "")
    .replace(/^\s*\|?[\s:\-|]+\|?\s*$/gm, "")
    .replace(/\|/g, "\n");
}

const HANGUL = /[가-힣]/g;
const PRED_END = /(다|요|까|죠|니다|세요|시오|함|음|됨|임|있음|없음)[.?!…]*["'”’)]*$/;
const REQ_END = /(주세요|주십시오|하세요|십시오|할까요|갈까요|될까요|까요|나요|습니까|인가요)[.?!]*$|\?$/;

interface Sentence {
  text: string;
  len: number;
  kind: "req" | "desc";
}

/** 마침표·물음표 뒤 빈칸에서 문장을 자른다. 술어로 끝나지 않는 조각(표 칸·목록 조각)은 뺀다. */
function sentences(text: string): Sentence[] {
  const out: Sentence[] = [];
  for (const raw of text.split(/\n+/)) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (!line) continue;
    for (const p0 of line.split(/(?<=[가-힣a-zA-Z)"'”’][.?!])\s+/)) {
      const p = p0.trim();
      if ((p.match(HANGUL) || []).length < 2 || !PRED_END.test(p)) continue;
      out.push({ text: p, len: [...p].length, kind: REQ_END.test(p) ? "req" : "desc" });
    }
  }
  return out;
}

function clip(value: string, max = 24): string {
  const chars = [...value.replace(/\s+/g, " ").trim()];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("");
}

type Bag = LintWarning[];

/** Clearly generic whole titles only; advisory, never a rewrite or a save gate. */
function titlePurpose(bag: Bag, title: string, surface: "업무 이름" | "결재 제목" | "보고 제목" | "자료 제목") {
  // Body normalization strips raw URLs; a URL can be the title's actual subject.
  const plain = title.trim().replace(/^[#*_`]+\s*|\s*[*_`]+$/g, "").replace(/[.!?。？！:：]+$/u, "").trim();
  if (!/^(?:검토|검토 중|검토 대기|확인|확인 대기|확인 요청|후속 진행|진행 상황|진행 중|완료|업무|작업|자료|보고|결과물|알림)$/.test(plain)) return;
  const purpose = surface === "업무 이름" ? "다시 찾을 대상과 목표를 이름으로 적으세요. 변하는 진행 상태는 별도 상태에 둡니다."
    : surface === "결재 제목" ? "어떤 업무의 무엇을 결정할 질문인지 적으세요. 상세에는 이유와 선택 후 결과를 씁니다."
    : surface === "보고 제목" ? "어떤 업무에서 이번에 달라진 결과인지 적으세요. 본문에는 근거와 남은 조건을 씁니다."
    : "대상과 결과물 종류를 적으세요. 요약에는 용도·핵심 내용·사용 제한을 씁니다.";
  bag.push({ code: "title-purpose", text: `${surface}: ${purpose}` });
}

function contextReferences(bag: Bag, plain: string) {
  if (/원\s*ID/i.test(plain) && !/(전달|메시지|보고|업무|세션|실행|자료|결재)(의)?\s*(ID|아이디|식별자|번호)/i.test(plain)) {
    bag.push({ code: "context-reference", text: "‘원ID’가 무엇의 식별자인지 설명하세요. 업무명과 전달·메시지·세션 등 기록 종류, 필요한 값과 출처를 적고 모르면 무엇을 확인하지 못했는지 밝히세요." });
  }
  if (/원\s*(지시|요청)/.test(plain) && !/(요청|지시)(?:한)?\s*(내용|원문)|[‘“「]/.test(plain)) {
    bag.push({ code: "context-reference", text: "‘원 지시’가 가리키는 요청 내용과 출처·시점을 함께 적으세요. 앞선 대화를 다시 찾아야만 무엇을 요청했는지 알 수 있게 두지 마세요." });
  }
  if (/^(?:현재[:：]?\s*)?(?:진행 중|처리 중|검토 중|확인 대기|검토 대기|완료)[.!]?$/u.test(plain.trim())) {
    bag.push({ code: "context-subject", text: "업무명과 행동 대상을 적으세요. 무엇을 누가 확인하거나 처리하는지와 남은 조건이 필요합니다." });
  }
}

function doneClaims(bag: Bag, md: string, title?: string) {
  const all = stripMd(`${title ?? ""}\n${md}`);
  if (title && DONE.test(title) && !VERIFY.test(all)) {
    bag.push({ code: "done", text: `'완료' 주장에 확인한 근거가 없습니다(시험·확인 등): "${clip(title)}"` });
    return;
  }
  for (const para of md.split(/\n\s*\n/)) {
    const plain = stripMd(para);
    if (VERIFY.test(plain)) continue;
    const s = sentences(plain).find((x) => DONE.test(x.text));
    if (s) {
      bag.push({ code: "done", text: `'완료' 주장에 확인한 근거가 없습니다(시험·확인 등): "${clip(s.text)}"` });
      return;
    }
  }
}

function hedging(bag: Bag, plain: string) {
  for (const line of plain.split("\n")) {
    if (UNSURE_LABEL.test(line)) continue;
    const s = sentences(line).find((x) => UNSURE.test(x.text));
    if (s) {
      bag.push({ code: "hedge", text: `흐린 말끝에 '가정:'·'미정:' 표시가 없습니다: "${clip(s.text)}"` });
      return;
    }
  }
}

const ORDER = ["context-reference", "context-subject", "title-purpose", "owner-first", "done", "hedge"];

function finish(bag: Bag): LintWarning[] {
  const seen = new Set<string>();
  const unique = bag.filter((w) => (seen.has(w.text) ? false : (seen.add(w.text), true)));
  return unique.sort((a, b) => ORDER.indexOf(a.code) - ORDER.indexOf(b.code));
}

function safe(run: () => LintWarning[]): LintWarning[] {
  try {
    return run();
  } catch {
    return []; // 검사기의 잘못이 보고를 막으면 안 된다.
  }
}

// ---------- 통로별 ----------

export function lintPost(input: { title: string; body?: string | null; ownerAction?: string | null }): LintWarning[] {
  return safe(() => {
    const bag: Bag = [];
    const body = input.body ?? "";
    const owner = input.ownerAction?.trim() || "";
    const parsed = parseOwnerLine(body);
    const rest = parsed ? parsed.rest : body;
    const plain = stripMd(rest);
    titlePurpose(bag, input.title, "보고 제목");
    if (!owner && !parsed) {
      const ask = sentences(plain).find((s) => OWNER_ASK.test(s.text));
      if (ask) bag.push({ code: "owner-first", text: `대표에게 부탁하는 말이 본문에 있습니다. owner_action 에 한 줄로 쓰거나, 정할 것이면 ask 로 올리세요: "${clip(ask.text)}"` });
    }
    doneClaims(bag, rest, input.title);
    const all = `${input.title}\n${plain}\n${owner}`;
    hedging(bag, all);
    contextReferences(bag, all);
    return finish(bag);
  });
}

export function lintAsk(input: { title: string; detail?: string | null; options?: { label: string; desc?: string }[] | null; recReason?: string | null; recLabel?: string | null }): LintWarning[] {
  return safe(() => {
    const bag: Bag = [];
    const reason = input.recReason?.trim() || "";
    const parsed = parseRecLine(input.detail ?? "", input.recLabel);
    const rest = parsed ? parsed.rest : input.detail ?? "";
    const opts = (input.options ?? []).map((o) => `${o.label}\n${o.desc ?? ""}`).join("\n");
    const plain = stripMd(rest);
    titlePurpose(bag, input.title, "결재 제목");
    doneClaims(bag, rest);
    const all = `${input.title}\n${plain}\n${opts}\n${reason}`;
    hedging(bag, all);
    contextReferences(bag, all);
    return finish(bag);
  });
}

export function lintFile(input: { title: string; content?: string | null }): LintWarning[] {
  return safe(() => {
    const bag: Bag = [], content = input.content ?? "";
    titlePurpose(bag, input.title, "자료 제목");
    doneClaims(bag, content);
    const plain = stripMd(`${input.title}\n${content}`);
    hedging(bag, plain);
    contextReferences(bag, plain);
    return finish(bag);
  });
}

export function lintTask(title: string): LintWarning[] {
  return safe(() => {
    const bag: Bag = [];
    titlePurpose(bag, title, "업무 이름");
    return finish(bag);
  });
}

/** 팀 상태도 대상이 빠진 한 단어 상태나 설명 없는 참조를 안내한다. */
export function lintStatus(input: { now: string; next?: string | null }): LintWarning[] {
  return safe(() => {
    const bag: Bag = [];
    contextReferences(bag, input.now);
    if (input.next) contextReferences(bag, input.next);
    return finish(bag);
  });
}

/** 도구 결과 끝에 붙일 글. 경고가 없으면 빈 글. 머리 줄 하나와 경고 4줄까지. */
export function formatLintWarnings(warnings: LintWarning[], max = MAX_WARNING_LINES): string {
  if (!warnings.length) return "";
  const shown = warnings.length > max ? warnings.slice(0, max - 1) : warnings;
  const lines = shown.map((w) => `- ${w.text}`);
  if (warnings.length > shown.length) lines.push(`- 외 ${warnings.length - shown.length}건`);
  return `글 검사 경고 ${warnings.length}건(대표에게는 보이지 않습니다. 이미 올라갔으니 다음 글부터 고치세요):\n${lines.join("\n")}`;
}

/** 도구 결과 글에 경고를 붙인다. */
export function withLint(text: string, warnings: LintWarning[]): string {
  const note = formatLintWarnings(warnings);
  return note ? `${text}\n${note}` : text;
}
