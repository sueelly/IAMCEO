// 업무 단계 계산(대표 2026-11-17 #4aab3546). 같은 업무 id 의 근거만 읽고, 아무것도 바꾸지 않는 순수 함수다.
// 근거: 보고(종류·검사 결과·계약 판정), 열린 결재·할 일, 보류·대기 전달, 승인 창에 걸린 직원, 총괄의 단계 표시, 반복 감시, 완료 알림.
// 계약 판정(서버의 완료 근거)은 바꾸지 않는다. 판정은 '작성자 납품'의 근거일 뿐이고 실제 완료는 총괄의 완료 표시다.
import type { MemberKind, MessageKind, TaskBlockCause, TaskProgress, TaskStage, TaskStageMark } from "../shared/types.ts";

export interface ReportFact {
  id: string;
  /** 글 순서(rowid). 같은 시각이어도 순서를 정한다. */
  seq: number;
  at: string;
  kind: MessageKind;
  memberId: string | null;
  who: string;
  authorKind: MemberKind | null;
  /** 정정 보고는 기존 시도의 근거를 바로잡으며 새 실행으로 세지 않는다. */
  correctsMessageId?: string | null;
  /** 실패한 검사 이름 */
  failed: string[];
  /** 실행 안 한 검사 이름(미확인 항목 요약 줄은 빼고) */
  notRun: string[];
  /** 미확인 요약 줄을 뺀 검사 수 */
  checks: number;
  /** 지금 계약 판의 검사 완료 판정이 통과(정정되지 않음) */
  passed: boolean;
}
export interface MarkFact { id: number; stage: TaskStageMark; at: string; who: string; evidence: string; memberId?: string | null }
export interface AttemptFact { at: string; messageId: string; who: string; fingerprint: string; failed: string[] }
export interface WatchFact {
  startedAt: string;
  attempts: number;
  same: number;
  fingerprint: string;
  lastProgressAt: string;
  trippedAt: string | null;
  reason: string | null;
  updatedAt: string;
  history: AttemptFact[];
}
export interface HeldFact { id: string; who: string; reason: string | null; at: string }
export interface ProgressFacts {
  reports: ReportFact[];
  decisions: { id: string; title: string; at: string }[];
  todos: { id: string; title: string; at: string }[];
  held: HeldFact[];
  queued: { id: string; who: string; at: string }[];
  approvals: { who: string; at: string }[];
  marks: MarkFact[];
  watch: WatchFact | null;
  notice: { id: string; at: string; seenAt: string | null; lines: string[] } | null;
  /** 단계에 직접 쓰지 않지만 판을 올리는 근거 시각(닫힌 결재·할 일, 끝난 전달). */
  revTimes: string[];
}

const CONDUCTOR = "총괄";
const OWNER = "대표";
const josaI = (name: string) => {
  const code = name.charCodeAt(name.length - 1) - 0xac00;
  return name + (code >= 0 && code <= 11171 && code % 28 !== 0 ? "이" : "가");
};
const cut = (names: string[], n = 2) => names.slice(0, n).join(", ") + (names.length > n ? ` 외 ${names.length - n}건` : "");
const maxTime = (times: (string | null | undefined)[]) => times.reduce<string>((a, b) => (b && b > a ? b : a), "");

/**
 * 보류 까닭의 무리. 세션이 깨거나 실행기가 돌아오면 그대로 들어가는 기다림(dependency)과 자동으로 다시 보내지 않는 보류를 가른다.
 * 모르는 까닭은 unknown 으로 둔다(자동 재생 대상으로 보지 않는다).
 */
export function holdCause(reason: string | null): TaskBlockCause {
  switch (reason) {
    case "asleep": case "offline": case "backend_down": case "runner_disabled": case "input_busy": case "blocked": return "dependency";
    case "stopped": case "retry_exhausted": case "rejected_limit": case "send_error": return "limit";
    case "needs_owner": return "owner";
    case "archived": case "legacy_session": case "duplicate_draft": return "hold";
    default: return "unknown";
  }
}

const HOLD_WHY: Partial<Record<TaskBlockCause, string>> = { limit: "한도·수동 중단·전송 오류", owner: "대표 확인 필요", hold: "보관·보호", unknown: "수신·처리 불확실" };

/** 막힘의 실패 지문. 같은 지문이 이어지면 진척이 없는 반복이다. */
export function fingerprint(r: Pick<ReportFact, "failed" | "notRun" | "checks">): string {
  if (r.failed.length) return `fail:${[...r.failed].sort().join("|")}`;
  if (r.notRun.length) return `pending:${[...r.notRun].sort().join("|")}`;
  return r.checks ? "pending:" : "unknown";
}

/** 마지막 다시 열기 뒤의 표시만 산다. */
function activeMarks(marks: MarkFact[]): MarkFact[] {
  let from = 0;
  marks.forEach((m, i) => { if (m.stage === "reopen") from = i + 1; });
  return marks.slice(from);
}

export function isDone(marks: MarkFact[]): MarkFact | null {
  const active = activeMarks(marks);
  return active.findLast((m) => m.stage === "done") ?? null;
}

export function deriveProgress(f: ProgressFacts): TaskProgress {
  const rev = maxTime([
    ...f.reports.map((r) => r.at), ...f.marks.map((m) => m.at), ...f.decisions.map((d) => d.at), ...f.todos.map((t) => t.at),
    ...f.held.map((h) => h.at), ...f.queued.map((q) => q.at), ...f.approvals.map((a) => a.at), f.watch?.updatedAt, f.notice?.at, f.notice?.seenAt, ...f.revTimes,
  ]);
  const loop = f.watch ? { startedAt: f.watch.startedAt, attempts: f.watch.attempts, same: f.watch.same, trippedAt: f.watch.trippedAt, reason: f.watch.reason } : null;
  const make = (stage: TaskStage, cause: TaskBlockCause | null, next: string | null, owner: string | null, since: string | null, basis: string[]): TaskProgress =>
    ({ stage, cause, next, owner, since, basis, rev, loop, notice: stage === "done" ? f.notice : null });

  const active = activeMarks(f.marks);
  const done = active.findLast((m) => m.stage === "done");
  // 완료는 끝 단계다. 뒤에 온 글·이벤트는 되돌리지 않는다(총괄이 다시 열 때만).
  if (done) return make("done", null, null, null, done.at, [`mark:${done.id}`]);
  const last = active.at(-1);
  if (last?.stage === "hold") return make("hold", "hold", `보류: ${last.evidence}`, CONDUCTOR, last.at, [`mark:${last.id}`]);

  if (f.decisions.length) {
    const d = f.decisions[0]!;
    return make("owner", "owner", `대표님이 결재함에서 정하실 차례: ${d.title}${f.decisions.length > 1 ? ` 외 ${f.decisions.length - 1}건` : ""}`, OWNER, d.at, f.decisions.map((x) => x.id));
  }
  if (f.todos.length) {
    const t = f.todos[0]!;
    return make("owner", "owner", `대표님 할 일: ${t.title}${f.todos.length > 1 ? ` 외 ${f.todos.length - 1}건` : ""}`, OWNER, t.at, f.todos.map((x) => x.id));
  }
  if (f.approvals.length) {
    const a = f.approvals[0]!;
    return make("approval", "approval", `${a.who}의 터미널 승인 창이 열려 있습니다`, OWNER, a.at, []);
  }
  if (f.watch?.trippedAt) {
    return make("check", "loop", `총괄 점검: ${f.watch.reason ?? "반복 멈춤"}`, CONDUCTOR, f.watch.trippedAt, f.watch.history.map((h) => h.messageId));
  }
  const stuck = f.held.filter((h) => holdCause(h.reason) !== "dependency");
  if (stuck.length) {
    const h = stuck[0]!, cause = holdCause(h.reason);
    const why = HOLD_WHY[cause] ?? "보류";
    return make("held", cause, `${h.who}에게 갈 입력 ${stuck.length}건 보류(${why}) · 자동으로 다시 보내지 않습니다. 총괄이 확인할 차례`, CONDUCTOR, h.at, stuck.map((x) => x.id));
  }

  const outcomes = f.reports.filter((r) => r.kind === "완료" || r.kind === "막힘");
  const lastOutcome = outcomes.at(-1);
  const progressMark = active.findLast((m) => m.stage === "review" || m.stage === "merged" || m.stage === "applied");
  // 작성자 납품: 마지막 통과 완료(계약 판정). 계약이 없으면 마지막 완료.
  const delivery = f.reports.findLast((r) => r.kind === "완료" && r.passed) ?? f.reports.findLast((r) => r.kind === "완료");

  if (lastOutcome && (!progressMark || lastOutcome.at >= progressMark.at)) {
    if (lastOutcome.kind === "막힘") {
      if (lastOutcome.failed.length) {
        const fixer = delivery && delivery.memberId && delivery.memberId !== lastOutcome.memberId && delivery.seq < lastOutcome.seq ? delivery.who : lastOutcome.who;
        const busy = f.reports.some((r) => r.seq > lastOutcome.seq && r.who === fixer && r.kind === "진행");
        return make("fix", "technical", `${josaI(fixer)} ${busy ? "고치는 중" : "고칠 차례"}: 실패 ${lastOutcome.failed.length}건(${cut(lastOutcome.failed)})`, fixer, lastOutcome.at, [lastOutcome.id]);
      }
      if (!lastOutcome.checks && !lastOutcome.notRun.length) {
        return make("confirm", "unknown", "검사 근거 없는 막힘 · 총괄이 원인을 확인할 차례", CONDUCTOR, lastOutcome.at, [lastOutcome.id]);
      }
      const what = lastOutcome.notRun.length ? `남은 확인 ${lastOutcome.notRun.length}건(${cut(lastOutcome.notRun)})` : "남은 확인";
      const after = progressMark?.stage === "merged" || progressMark?.stage === "applied" ? "합친 뒤" : "검토·통합";
      return make("confirm", "pending", `${what} · 총괄이 ${after} 확인 순서를 정할 차례`, CONDUCTOR, lastOutcome.at, [lastOutcome.id]);
    }
    // 완료
    if (progressMark?.stage === "merged" || progressMark?.stage === "applied") {
      return make(progressMark.stage, null, "통합 뒤 확인 통과 · 총괄이 완료로 옮길 차례", CONDUCTOR, lastOutcome.at, [lastOutcome.id, `mark:${progressMark.id}`]);
    }
    // 검토자의 완료를 작성자 납품으로 다시 고르면 두 보고가 같아진다. 검토를 맡기기 전 납품을 따로 찾는다.
    // 시각이 같아도 마지막 보고 자신을 기준으로 삼지 않도록 글 순서를 함께 비교한다.
    const reviewDelivery = progressMark?.stage === "review" ? f.reports.findLast((r) =>
      r.kind === "완료" && r.passed && !r.failed.length && !r.notRun.length && r.at <= progressMark.at && r.seq < lastOutcome.seq) : null;
    if (reviewDelivery?.memberId && lastOutcome.memberId && lastOutcome.memberId !== reviewDelivery.memberId
      && lastOutcome.passed && !lastOutcome.failed.length && !lastOutcome.notRun.length) {
      return make("merge", null, "검토 통과 · 총괄이 메인에 합칠 차례", CONDUCTOR, lastOutcome.at, [lastOutcome.id, reviewDelivery.id]);
    }
    const d = delivery ?? lastOutcome;
    return make("delivered", null, "총괄이 독립 검토를 맡기거나 합칠 차례", CONDUCTOR, d.at, [d.id]);
  }
  if (progressMark) {
    const basis = [`mark:${progressMark.id}`];
    if (progressMark.stage === "review") return make("review", null, `검토 중: ${progressMark.evidence}`, null, progressMark.at, basis);
    if (progressMark.stage === "merged") return make("merged", null, "통합 뒤 확인·대표 화면 반영이 남았습니다", CONDUCTOR, progressMark.at, basis);
    return make("applied", null, "총괄이 완료를 확인할 차례", CONDUCTOR, progressMark.at, basis);
  }
  const waiting = f.held.filter((h) => holdCause(h.reason) === "dependency");
  if (waiting.length) {
    const h = waiting[0]!;
    return make("working", "dependency", `${h.who} 세션을 기다림(${h.reason}) · 깨면 그대로 들어갑니다`, null, h.at, waiting.map((x) => x.id));
  }
  const lastAny = f.reports.at(-1);
  if (!lastAny && f.queued.length) {
    const q = f.queued[0]!;
    return make("working", "dependency", `${q.who}에게 입력 ${f.queued.length}건 전달 대기`, q.who, q.at, f.queued.map((x) => x.id));
  }
  if (lastAny || f.queued.length) {
    const since = maxTime([lastAny?.at, f.queued.at(-1)?.at]);
    return make("working", null, null, lastAny?.who ?? f.queued[0]!.who, since, lastAny ? [lastAny.id] : f.queued.map((q) => q.id));
  }
  return make("new", null, null, null, null, []);
}

// ---- 반복 감시 ----

/** 같은 실패 3번은 2026-11-18 대표 정책이다. 2시간은 별도의 진척 확인 간격이다. */
export const DEFAULT_WATCH_LIMITS = { sameLimit: 3, idleMs: 2 * 60 * 60_000 } as const;
export interface WatchLimits { sameLimit: number; idleMs: number }
const HISTORY = 10;

/**
 * 보고 하나로 감시를 옮긴다. 통과 완료면 반복이 끝난다(null). 막힘이면 시도를 하나 더하고, 같은 지문이 이어지면 진척이 없다.
 * trip 은 이번에 처음 멈출 때만 까닭을 준다(이미 멈췄으면 null). quiet 는 멈춘 뒤 같은 실패라 총괄을 다시 깨우지 않을 보고다.
 */
export function watchOnReport(prev: WatchFact | null, r: ReportFact, limits: WatchLimits = DEFAULT_WATCH_LIMITS): { next: WatchFact | null; trip: string | null; quiet: boolean } {
  // Coordination summaries and repeated processing of the same report are not
  // new implementation attempts. Do not let them consume the retry allowance.
  if (r.authorKind !== "worker" || r.correctsMessageId || prev?.history.some(h => h.messageId === r.id)) return { next: prev, trip: null, quiet: false };
  if (r.kind === "완료") return { next: r.passed || !prev ? null : prev, trip: null, quiet: false };
  if (r.kind !== "막힘") return { next: prev, trip: null, quiet: false };
  const fp = fingerprint(r);
  const attempt: AttemptFact = { at: r.at, messageId: r.id, who: r.who, fingerprint: fp, failed: r.failed };
  if (!prev) return { next: { startedAt: r.at, attempts: 1, same: 1, fingerprint: fp, lastProgressAt: r.at, trippedAt: null, reason: null, updatedAt: r.at, history: [attempt] }, trip: null, quiet: false };
  const same = fp === prev.fingerprint ? prev.same + 1 : 1;
  const next: WatchFact = { ...prev, attempts: prev.attempts + 1, same, fingerprint: fp, lastProgressAt: same > 1 ? prev.lastProgressAt : r.at, updatedAt: r.at, history: [...prev.history, attempt].slice(-HISTORY) };
  if (prev.trippedAt) return { next, trip: null, quiet: same > 1 };
  if (same >= limits.sameLimit) {
    const reason = `같은 실패 ${same}번(${fp === "unknown" ? "검사 근거 없음" : cut(r.failed.length ? r.failed : r.notRun)})`;
    return { next: { ...next, trippedAt: r.at, reason }, trip: reason, quiet: false };
  }
  return { next, trip: null, quiet: false };
}

/** 시간 경계: 직원 쪽 단계(고칠 것·확인 대기)에서 마지막 진척 뒤 idleMs 가 지나면 한 번 멈춘다. 대표·승인·보류 기다림은 세지 않는다. */
export function watchOnTick(w: WatchFact | null, stage: TaskStage, now: number, limits: WatchLimits = DEFAULT_WATCH_LIMITS): string | null {
  if (!w || w.trippedAt || (stage !== "fix" && stage !== "confirm")) return null;
  const idle = now - Date.parse(w.lastProgressAt);
  return idle >= limits.idleMs ? `진척 없이 ${Math.floor(idle / 60_000)}분(${w.attempts}번 시도)` : null;
}

/** 총괄이 다시 열면 멈춤을 푼다. 시작 시각·시도 수·기록은 남기고, 같은 실패 연속 수와 진척 시각은 새로 센다. */
export function watchOnReopen(w: WatchFact | null, at: string): WatchFact | null {
  return w ? { ...w, trippedAt: null, reason: null, same: 0, lastProgressAt: at, updatedAt: at } : null;
}

/** 총괄에게 한 번 보내는 점검 글: 원인·지금까지 한 일·남은 조건. */
export function watchNotice(task: { id: string; title: string }, w: WatchFact, reason: string, remaining: string[]): string {
  const lines = w.history.slice(-5).map((h) => `- 보고 #${h.messageId} · ${h.at} ${h.who}: ${h.fingerprint === "unknown" ? "검사 근거 없는 막힘" : h.fingerprint}`);
  return [
    `반복 감시: 업무 #${task.id} '${task.title}'의 막힘이 ${reason}. 이 업무의 자동 반복을 멈췄습니다. 같은 실패의 막힘은 더는 총괄을 깨우지 않습니다.`,
    `- 시작 ${w.startedAt} · 시도 ${w.attempts}번 · 같은 실패 연속 ${w.same}번 · 마지막 진척 ${w.lastProgressAt}`,
    "지금까지:",
    ...lines,
    `남은 조건: ${remaining.length ? remaining.join(", ") : "보고에 적힌 남은 조건 없음"}`,
    "총괄이 원인과 남은 조건을 확인하고 바꾼 접근을 기록합니다. 같은 접근을 반복하지 말고 task_stage(reopen, evidence 바꾼 접근) 뒤 직원에게 맡기세요. 보류하면 task_stage(hold)를 남깁니다. 기존 대표 결재는 보존하고 새로운 권한·범위 판단이 필요할 때만 ask로 올립니다.",
  ].join("\n");
}
