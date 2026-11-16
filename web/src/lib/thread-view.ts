// 대화 화면이 글을 어떻게 보일지 정한다. 화면 없이 시험할 수 있게 React 를 쓰지 않는다.
// · 대표 차례 줄(본문 첫 줄)은 말풍선 맨 위 띠로 뺀다.
// · 결재 카드 사본(질문 + 결재 id)은 한 줄로 줄인다. 전체는 결재함에 있다.
// · 총괄의 과정 글(맡김, 직원 보고 직후 다시 알림, 원보고를 밝힌 확인 알림)은 한 줄로 접는다.
import type { Decision, MemberKind, Message, MessageKind } from "@shared/types";
import { parseOwnerLine } from "@shared/owner-lines";

/** 직원 보고 뒤 이 시간 안에 총괄이 다시 올린 글은 다시 알림으로 본다. */
export const RENOTIFY_MS = 2 * 60_000;
/** 대표 말 뒤 이 시간 안에 총괄이 올린 맡김 글만 접는다. */
export const ASSIGN_MS = 10 * 60_000;

/** 총괄 과정 글이 될 수 있는 종류. 완료·막힘·질문·답변은 접지 않는다. */
const PROCESS_KINDS: ReadonlySet<MessageKind> = new Set<MessageKind>(["진행", "알림"]);
/** 직원 보고로 치는 종류. */
const REPORT_KINDS: ReadonlySet<MessageKind> = new Set<MessageKind>(["완료", "막힘", "진행", "알림"]);
/** 맡김 글의 말. 구조 조건(총괄·진행·대표 말 바로 뒤)과 함께 맞아야 접는다. 말만으로는 접지 않는다. */
const ASSIGN_CUE = /맡겼|맡김|맡깁|맡기겠|배정했|나눠 맡/;
/** 새 소식의 말. 이런 말이 있는 총괄 글은 앞 보고를 되풀이한 글이 아니라 접지 않는다(실패·막힘·앞 보고와 다름·원인 설명). */
const NEWS_CUE = /실패|막힘|막혔|막힙|아직|다르|다릅|달리|달라|오류|에러|안\s?됩|안\s?돼|못\s?했|못\s?합|문제|틀렸|틀립|빠졌|빠집|다시 맡|되돌|취소|멈췄|멈춥|중단|원인|때문/;
/** 대표 말이 물음인지. 물음에 답한 총괄 글은 맡겼다는 말이 있어도 답이라 접지 않는다. */
const QUESTION_CUE = /[?？]|왜|어떻게|뭐|무엇|무슨|언제|어디|얼마|나요|까요|ㄹ까|는지|인가|가요\s*$|니\s*$/;
/** 다시 알림으로 접는 글의 본문 줄 수 한도. 길면 새 소식이 있을 수 있어 그대로 둔다. */
const RENOTIFY_MAX_LINES = 2;

export type KindOf = (memberId: string | null) => MemberKind | undefined;
export type ProcessKind = "assign" | "renotify" | "confirm";

export type ThreadItem =
  | { type: "message"; message: Message }
  | { type: "fold"; id: string; messages: Message[]; assign: number; renotify: number; confirm?: number };

const time = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

const firstLine = (text: string) => text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
const lineCount = (text: string) => text.split("\n").filter((l) => l.trim()).length;
/** 새 소식의 말이 제목이나 본문에 있는지. */
const hasNews = (m: Message) => NEWS_CUE.test(`${m.title}\n${m.body}`);

/** 본문 첫 줄의 대표 차례 줄을 뗀다. 없으면 action 이 null 이고 본문 그대로다. 줄 모양은 shared/owner-lines.ts 가 정한다. */
export function splitOwnerLine(body: string): { action: string | null; rest: string } {
  const parsed = parseOwnerLine(body);
  return parsed ? { action: parsed.action, rest: parsed.rest } : { action: null, rest: body };
}

/** 본문 첫 줄이 대표 차례 줄인지. */
export const hasOwnerLine = (body: string) => parseOwnerLine(body) !== null;

/** 결재 카드를 대화에 옮긴 글: ask 가 만든 질문 글이다. */
export const isCardCopy = (m: Message) => !m.mine && m.kind === "질문" && !!m.decisionId;

/** 총괄이 올린 진행·알림 가운데 대표가 볼 것이 따로 없는 글. 대표 차례·결재·첨부·받는 사람이 있으면 아니다. */
function isConductorProcess(m: Message, kindOf: KindOf): boolean {
  return (
    !m.mine &&
    kindOf(m.memberId) === "conductor" &&
    PROCESS_KINDS.has(m.kind) &&
    !m.decisionId &&
    !m.targetMemberId &&
    m.attachments.length === 0 &&
    !hasOwnerLine(m.body)
  );
}

/** 직원이 올린 보고. 총괄·본사 AI 의 글은 아니다(명부에서 빠진 직원은 직원으로 본다). */
function isWorkerReport(m: Message, kindOf: KindOf): boolean {
  if (m.mine || !m.memberId || !REPORT_KINDS.has(m.kind)) return false;
  const kind = kindOf(m.memberId);
  return kind !== "conductor" && kind !== "root";
}

/** list[i] 가 접을 총괄 과정 글인지, 어떤 글인지. 앞 글만 본다(뒤에 글이 와도 이미 접힌 글이 펴지지 않는다). */
export function processKind(list: readonly Message[], i: number, kindOf: KindOf): ProcessKind | null {
  const m = list[i];
  if (!m || !isConductorProcess(m, kindOf)) return null;
  const at = time(m.at);
  if (at === null) return null;

  // 새 소식(실패·막힘·앞 보고와 다름·원인)이 있으면 접지 않는다.
  if (hasNews(m)) return null;

  // 확인: 직원 보고 원본을 밝힌 알림(post about_report_id)은 시간·자리와 상관없이 그 보고의 확인이다.
  // 원보고가 목록에 있으면 직원 보고여야 하고, 자료가 있으면 그 보고의 자료여야 한다(새 자료는 새 소식이라 펴 둔다).
  if (m.kind === "알림" && m.aboutMessageId) {
    const about = list.slice(0, i).find((p) => p.id === m.aboutMessageId);
    if (about && !isWorkerReport(about, kindOf)) return null;
    if (m.fileId && m.fileId !== about?.fileId) return null;
    return "confirm";
  }

  // 맡김: 대표 말 바로 뒤(시스템 글만 사이에 둠)의 첫 진행 글이고, 맡겼다는 말이 있다. 대표 말이 물음이면 답이라 접지 않는다.
  if (m.kind === "진행" && !m.fileId && ASSIGN_CUE.test(`${m.title}\n${firstLine(m.body)}`)) {
    for (let j = i - 1; j >= 0; j--) {
      const p = list[j]!;
      if (p.kind === "시스템" && !p.mine) continue;
      const pAt = time(p.at);
      if (p.mine && !QUESTION_CUE.test(p.body.trim()) && pAt !== null && at - pAt >= 0 && at - pAt <= ASSIGN_MS) return "assign";
      break;
    }
  }

  // 다시 알림: 같은 총괄의 과정 글·시스템 글만 사이에 두고, 직원 보고 뒤 2분 안. 자료가 있으면 그 보고의 자료여야 한다.
  // 같은 자료가 아니면 본문이 짧을 때(2줄 이하)만 되풀이로 본다.
  for (let j = i - 1; j >= 0; j--) {
    const p = list[j]!;
    if (p.kind === "시스템" && !p.mine) continue;
    if (p.memberId === m.memberId && isConductorProcess(p, kindOf)) continue;
    if (!isWorkerReport(p, kindOf)) return null;
    const pAt = time(p.at);
    if (pAt === null || at - pAt < 0 || at - pAt > RENOTIFY_MS) return null;
    if (m.fileId && m.fileId !== p.fileId) return null;
    if (!m.fileId && lineCount(m.body) > RENOTIFY_MAX_LINES) return null;
    return "renotify";
  }
  return null;
}

/** 글 목록을 화면 줄로 바꾼다. 이어진 과정 글은 한 줄로 묶는다. */
export function foldThread(list: readonly Message[], kindOf: KindOf): ThreadItem[] {
  const items: ThreadItem[] = [];
  let open: Extract<ThreadItem, { type: "fold" }> | null = null;
  for (let i = 0; i < list.length; i++) {
    const m = list[i]!;
    const kind = processKind(list, i, kindOf);
    if (!kind) {
      open = null;
      items.push({ type: "message", message: m });
      continue;
    }
    if (!open) {
      open = { type: "fold", id: `fold:${m.id}`, messages: [], assign: 0, renotify: 0, confirm: 0 };
      items.push(open);
    }
    open.messages.push(m);
    if (kind === "assign") open.assign++;
    else if (kind === "confirm") open.confirm = (open.confirm ?? 0) + 1;
    else open.renotify++;
  }
  return items;
}

/** 접은 줄의 글: '총괄 · 맡김 1건, 다시 알림 2건, 확인 1건'. */
export function foldLabel(item: { assign: number; renotify: number; confirm?: number }): string {
  const confirm = item.confirm ?? 0;
  const parts = [item.assign > 0 ? `맡김 ${item.assign}건` : null, item.renotify > 0 ? `다시 알림 ${item.renotify}건` : null, confirm > 0 ? `확인 ${confirm}건` : null].filter(Boolean);
  return `총괄 · ${parts.join(", ")}`;
}

/** 접은 줄에 함께 보일 첫 글의 제목(없으면 본문 첫 줄). 접어도 무슨 글인지 알 수 있게 한다. */
export function foldPreview(item: { messages: readonly Message[] }): string {
  const m = item.messages[0];
  if (!m) return "";
  return (m.title.trim() || firstLine(m.body)).replace(/\s+/g, " ");
}

/** 대표 차례 글 끝의 '결재함 N건'을 떼어 띠 오른쪽 링크로 쓴다. '정해 주세요 · 결재함 1건', '정해 주세요(결재함 1건).' 모두 받는다. */
export function splitOwnerAction(action: string): { text: string; inbox: string | null } {
  const m = /^(.*?)[\s.]*(?:·\s*|\(\s*)(결재함\s*\d+\s*건)\s*\)?\s*\.?\s*$/.exec(action.trim());
  if (!m || !m[1]!.trim()) return { text: action.trim(), inbox: null };
  return { text: m[1]!.trim(), inbox: m[2]!.replace(/\s+/g, " ").replace(/(\d+) 건/, "$1건") };
}

/** 결재 카드 사본 한 줄: '결재 1건: 제목 · 권장 안 → 결재함'. 답했으면 권장 대신 고른 답, 닫혔으면 닫힘. */
export function cardCopyText(m: Message, d: Decision | undefined): string {
  const title = (d?.title ?? m.title).trim() || "제목 없음";
  let tail = "";
  if (d?.status === "open") {
    const rec = d.options.find((o) => o.k === d.rec)?.label;
    if (rec) tail = ` · 권장 ${rec}`;
  } else if (d?.status === "closed") {
    tail = " · 닫힘";
  } else if (d) {
    const answer = d.options.find((o) => o.k === d.choice)?.label ?? d.note ?? null;
    tail = answer ? ` · 답함 ${answer}` : " · 답함";
  }
  return `결재 1건: ${title}${tail} → 결재함`;
}
