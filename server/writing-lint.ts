// 글 검사기(경고만, 막지 않음). 직원이 post·ask·file(content)로 올린 글을 재고, 걸린 곳을 도구 결과 끝에 붙여 직원에게 돌려준다.
// 대표 화면에는 보이지 않는다. 막으면 다듬지 않은 마지막 글이 대신 올라가므로 언제나 경고로 끝낸다.
// 3판 검사기 시안(lint3.ts)과 2판 검사기(lint.ts)에서 오탐이 적은 검사만 옮겼다:
//   길이(제목 45 · 요청 40 · 설명 60), 용어, 코드 무늬, 굵은 글씨 수, 짧은 답의 제목,
//   검증 낱말 없는 '완료' 주장, '반영'의 뜻, 표시 없는 흐린 말끝, 대표 할 일이 첫 줄에 없음.
// 규칙의 근거는 역할 글에 붙는 지침(server/roles/writing.md)이다.

import { parseOwnerLine, parseRecLine } from "../shared/owner-lines.ts";
import { josa } from "./roles.ts";

export const LIMITS = { title: 45, askTitle: 40, req: 40, desc: 60 } as const;
/** 보고 설명의 권장 길이. 접수·증거 대조·저장에는 상한으로 쓰지 않는다. */
export const REPORT_LENGTH_GUIDANCE = { checkName: 200, evidence: 1000, command: 500, claim: 400, source: 500, quote: 600, unverified: 300, review: 600 } as const;
/** 도구 결과에 붙일 경고 줄 수(머리 줄 제외). */
export const MAX_WARNING_LINES = 4;

export interface LintWarning {
  /** 검사 이름. 시험과 정렬에 쓴다. */
  code: string;
  /** 직원에게 보일 한 줄. */
  text: string;
}

// ---------- 용어 (writing.md '쓰지 않을 말'과 같은 짝) ----------
const VOCAB: { pat: RegExp; use: string }[] = [
  { pat: /\bworktrees?\b|작업\s?사본|작업\s?폴더/gi, use: "워크트리" },
  { pat: /\bmerge[ds]?\b|(?<!나)머지|병합/gi, use: "합치기" },
  { pat: /\bmain\b/g, use: "메인" },
  { pat: /\bpush(?:ed|es)?\b|푸시/gi, use: "깃허브에 올리기" },
  { pat: /풀\s?리퀘스트|pull request/gi, use: "PR" },
  { pat: /\bbuild\b|빌드/gi, use: "앱 만들기" },
  { pat: /테스트|\btests?\b/gi, use: "시험" },
  { pat: /타입\s?검사|typecheck|\btsc\b/gi, use: "코드 검사" },
  { pat: /대표\s?서버/g, use: "대표 화면" },
  { pat: /재시작|배포|\bdeploy\b|\brestart\b/gi, use: "대표 화면에 반영" },
  { pat: /위임/g, use: "맡김" },
  { pat: /서브\s?에이전트|subagent/gi, use: "하위 에이전트" },
  { pat: /(?<!하위\s?|서브\s?)에이전트|담당자/g, use: "직원·총괄" },
  { pat: /\bartifacts?\b|아티팩트|첨부\s?자료/gi, use: "자료" },
  { pat: /\bask\b|승인\s?요청/gi, use: "결재 카드" },
  { pat: /승인함/g, use: "결재함" },
  { pat: /\bpost\b/gi, use: "보고" },
  { pat: /롤백|\brollback\b|\brevert\b/gi, use: "되돌리기" },
  { pat: /캐시|\bcache\b|하드\s?리프레시/gi, use: "새로고침" },
  { pat: /\bqueue\b|(?<![가-힣])큐(?![가-힣])/gi, use: "대기열" },
  { pat: /(?<![가-힣])로그(?!인)|\blogs?\b/gi, use: "실행 기록" },
  { pat: /진행판|판\s?정리/g, use: "(쓰지 않음)" },
];

// ---------- 코드 무늬 ----------
const CODEISH: { name: string; pat: RegExp }[] = [
  { name: "커밋 해시", pat: /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g },
  { name: "색 코드", pat: /#(?:[0-9A-Fa-f]{6}|(?=\d*[A-Fa-f])[0-9A-Fa-f]{3})\b/g },
  { name: "경로", pat: /(?<![\w\/~.])(?:~\/|\.{1,2}\/|\/)[\w.\-]+(?:\/[\w.\-]*)*|(?<![\w\/])[A-Za-z_][\w.\-]*\/[\w.\-]+\/[\w.\-\/]*/g },
  // Next.js·Node.js 같은 제품 이름(대문자로 시작하는 낱말 + .js)은 파일 이름이 아니다.
  { name: "파일 이름", pat: /\b(?![A-Z][a-z]+\.js\b)[\w\-]+\.(?:tsx?|jsx?|swift|json|html?|md|css|py|sh|ya?ml|plist)\b/g },
  { name: "내부 번호", pat: /\b(?:[a-z]{1,4}_[A-Za-z0-9_\-]{8,}|msg_[A-Za-z0-9]+)\b/g },
  { name: "포트", pat: /:\d{4,5}\b|\b\d{4,5}\s?(?:번\s?)?포트|포트\s?\d{4,5}/g },
  // iPhone·iCloud 같은 i 제품 이름과 macOS·watchOS 같은 OS 이름은 코드 이름이 아니다.
  { name: "코드 이름", pat: /\b(?!i[A-Z]|[a-z]+OS\b)(?:[a-z]+_[a-z_]+|[a-z]+[A-Z][A-Za-z]+)\b/g },
];

// ---------- 3판 검사 ----------
// '완료·막힘', '완료 보고', '\'완료\''처럼 종류 이름으로 쓴 '완료'는 주장이 아니다.
const DONE = /((?<!['‘])완료(?![·'’]|\s?보고)|끝났|끝냈|마쳤|다\s?됐|구현했|적용했|반영했|통과했)/;
const VERIFY = /(시험|확인|검사|쟀|측정|캡처|대비|열어|돌려|통과)/;
// '~할 수 있습니다'는 능력을 말할 때가 많아 오탐이 잦다. 시안의 그 항목은 옮기지 않았다.
// '아마'는 낱말일 때만 본다(아마존·아마추어는 아니다).
const UNSURE = /(것 같|로 보입니다|듯합니다|듯하다|로 보인다|(?<![가-힣])아마(?:도)?(?=\s|$|[,.]))/;
const UNSURE_LABEL = /(미정|가정|확인하지 못|확인 전|위험)/;
const BOLD = /\*\*[^*\n]+\*\*/g;
const HEADING = /^\s{0,3}#{1,6}\s|^\s*\*\*[^*\n]{1,14}\*\*\s*[:：]?\s*$/m;
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

function charLen(value: string): number {
  return [...value.trim()].length;
}

// ---------- 검사 ----------
type Bag = LintWarning[];

interface PostLintInput {
  title: string;
  body?: string | null;
  ownerAction?: string | null;
  checks?: readonly { name: string; evidence: string; command?: string | null }[];
  claims?: readonly { text: string; source?: string | null; quote?: string | null }[];
  unverified?: readonly string[];
  reviewNeeded?: string | null;
}

function reportLength(bag: Bag, input: PostLintInput) {
  const guide = REPORT_LENGTH_GUIDANCE;
  const fields: [string, number, readonly (string | null | undefined)[]][] = [
    ["검사 이름", guide.checkName, input.checks?.map(c => c.name) ?? []],
    ["검사 근거", guide.evidence, input.checks?.map(c => c.evidence) ?? []],
    ["명령", guide.command, input.checks?.map(c => c.command) ?? []],
    ["주장", guide.claim, input.claims?.map(c => c.text) ?? []],
    ["출처", guide.source, input.claims?.map(c => c.source) ?? []],
    ["인용", guide.quote, input.claims?.map(c => c.quote) ?? []],
    ["미확인", guide.unverified, input.unverified ?? []],
    ["검토 요청", guide.review, [input.reviewNeeded]],
  ];
  const over = fields.flatMap(([label, limit, values]) => {
    const count = values.filter(value => value && charLen(value) > limit).length;
    return count ? [`${label} ${count}건(${limit}자 권장)`] : [];
  });
  if (over.length) bag.push({ code: "length-report", text: `보고 길이 권고: ${over.join(" · ")}. 필요한 원문은 줄이지 않아도 됩니다` });
}

function titleLength(bag: Bag, label: string, value: string | undefined, limit: number) {
  if (value && charLen(value) > limit) bag.push({ code: "length-title", text: `${label} ${limit}자 넘음(${charLen(value)}자): "${clip(value)}"` });
}

function sentenceLength(bag: Bag, plain: string) {
  for (const s of sentences(plain)) {
    const limit = s.kind === "req" ? LIMITS.req : LIMITS.desc;
    if (s.len > limit) bag.push({ code: "length-sentence", text: `${s.kind === "req" ? "요청" : "설명"} 문장 ${limit}자 넘음(${s.len}자): "${clip(s.text)}"` });
  }
}

function vocab(bag: Bag, plain: string) {
  for (const v of VOCAB) {
    v.pat.lastIndex = 0;
    const hit = plain.match(v.pat);
    if (hit?.length) bag.push({ code: "vocab", text: `용어: '${hit[0]}' 대신 '${v.use}'` });
  }
}

function codeish(bag: Bag, plain: string) {
  for (const c of CODEISH) {
    c.pat.lastIndex = 0;
    const hit = plain.match(c.pat);
    if (hit?.length) bag.push({ code: "codeish", text: `${josa(c.name, "은")} 본문에 쓰지 않습니다(필요하면 자료의 '세부'에): "${clip(hit[0], 30)}"` });
  }
}

function boldCount(bag: Bag, md: string, max: number, where: string) {
  const n = (md.match(BOLD) || []).length;
  if (n > max) bag.push({ code: "bold", text: `굵은 글씨 ${n}개(${where} 한도 ${max})` });
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

function reflectWord(bag: Bag, plain: string) {
  const s = sentences(plain).find((x) => /반영/.test(x.text) && !/대표 화면/.test(x.text));
  if (s) bag.push({ code: "reflect", text: `'반영'은 대표 화면에 보이게 한 것에만 씁니다: "${clip(s.text)}"` });
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

const ORDER = ["owner-first", "length-report", "length-title", "done", "bold", "codeish", "vocab", "reflect", "hedge", "heading", "length-sentence"];

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

export function lintPost(input: PostLintInput): LintWarning[] {
  return safe(() => {
    const bag: Bag = [];
    reportLength(bag, input);
    const body = input.body ?? "";
    const owner = input.ownerAction?.trim() || "";
    const parsed = parseOwnerLine(body);
    const rest = parsed ? parsed.rest : body;
    const plain = stripMd(rest);
    titleLength(bag, "보고 제목", input.title, LIMITS.title);
    if (owner && charLen(owner) > LIMITS.req) bag.push({ code: "length-title", text: `대표 차례 ${LIMITS.req}자 넘음(${charLen(owner)}자): "${clip(owner)}"` });
    if (!owner && !parsed) {
      const ask = sentences(plain).find((s) => OWNER_ASK.test(s.text));
      if (ask) bag.push({ code: "owner-first", text: `대표에게 부탁하는 말이 본문에 있습니다. owner_action 에 한 줄로 쓰거나, 정할 것이면 ask 로 올리세요: "${clip(ask.text)}"` });
    }
    const lines = rest.split("\n").filter((l) => l.trim()).length;
    if (lines <= 8 && HEADING.test(rest)) bag.push({ code: "heading", text: "짧은 보고에 제목·소제목·굵은 머리말을 붙이지 않습니다" });
    boldCount(bag, rest, 1, "보고");
    doneClaims(bag, rest, input.title);
    const all = `${input.title}\n${plain}\n${owner}`;
    reflectWord(bag, all);
    hedging(bag, all);
    vocab(bag, all);
    codeish(bag, all);
    sentenceLength(bag, `${plain}\n${owner}`);
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
    titleLength(bag, "카드 제목", input.title, LIMITS.askTitle);
    if (reason && charLen(reason) > LIMITS.desc) bag.push({ code: "length-title", text: `권장 이유 ${LIMITS.desc}자 넘음(${charLen(reason)}자): "${clip(reason)}"` });
    // 서버가 권장 줄을 그리면 본문에는 굵은 글씨를 쓰지 않는다. 손으로 쓴 권장 줄 하나만 허용한다.
    boldCount(bag, rest, reason || parsed ? 0 : 1, "카드");
    doneClaims(bag, rest);
    const all = `${input.title}\n${plain}\n${opts}\n${reason}`;
    reflectWord(bag, all);
    hedging(bag, all);
    vocab(bag, all);
    codeish(bag, all);
    sentenceLength(bag, `${plain}\n${reason}`);
    return finish(bag);
  });
}

export function lintFile(input: { title: string; content?: string | null }): LintWarning[] {
  return safe(() => {
    const bag: Bag = [];
    titleLength(bag, "자료 제목", input.title, LIMITS.title);
    const content = input.content ?? "";
    if (content.trim()) {
      // 해시·경로·파일 목록은 '세부' 장에 둘 수 있다. 그 장부터는 코드 무늬를 세지 않는다.
      const detailAt = content.search(/^\s{0,3}#{1,6}\s.*세부/m);
      const main = detailAt < 0 ? content : content.slice(0, detailAt);
      const plain = stripMd(content);
      doneClaims(bag, content);
      reflectWord(bag, plain);
      hedging(bag, plain);
      vocab(bag, `${input.title}\n${plain}`);
      codeish(bag, stripMd(main));
      sentenceLength(bag, plain);
    } else {
      vocab(bag, input.title);
    }
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
