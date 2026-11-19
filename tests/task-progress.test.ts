// 업무 단계 계산의 단위 시험: 원인 가르기, 완료는 끝 단계, 판 번호, 실패 지문, 감시 경계. 순수 함수만 본다.
import { describe, expect, test } from "bun:test";
import { DEFAULT_WATCH_LIMITS, deriveProgress, fingerprint, holdCause, watchOnReopen, watchOnReport, type ProgressFacts, type ReportFact } from "../server/task-progress.ts";
import { needsAction, newerProgress, stageSec } from "../shared/task-stage.ts";
import { applyToProject } from "../web/src/lib/store.ts";
import { hasTaskRows, noticeTasks, workRows } from "../web/src/lib/task-list.ts";
import type { ProjectState, Task, TaskProgress, WorkItem } from "../shared/types.ts";

const empty = (): ProgressFacts => ({ reports: [], decisions: [], todos: [], held: [], queued: [], approvals: [], marks: [], watch: null, notice: null, revTimes: [] });
let seq = 0;
const report = (kind: ReportFact["kind"], over: Partial<ReportFact> = {}): ReportFact => ({
  id: `msg_${++seq}`, seq, at: `2026-11-17T09:${String(seq).padStart(2, "0")}:00.000Z`, kind, memberId: "w1", who: "철수", authorKind: "worker",
  failed: [], notRun: [], checks: 0, passed: false, ...over,
});

describe("단계 계산", () => {
  test("우선순위: 완료 > 보류 > 대표 차례 > 승인 창 > 반복 감시 > 전달 보류 > 보고", () => {
    const f = empty();
    f.reports.push(report("막힘", { failed: ["a"], checks: 1 }));
    expect(deriveProgress(f).stage).toBe("fix");
    f.held.push({ id: "dl_1", who: "영희", reason: "delivery_unknown", at: "2026-11-17T10:00:00.000Z" });
    expect(deriveProgress(f)).toMatchObject({ stage: "held", cause: "unknown" });
    f.watch = { startedAt: "x", attempts: 3, same: 3, fingerprint: "fail:a", lastProgressAt: "x", trippedAt: "2026-11-17T10:01:00.000Z", reason: "같은 실패 3번", updatedAt: "2026-11-17T10:01:00.000Z", history: [] };
    expect(deriveProgress(f)).toMatchObject({ stage: "check", cause: "loop" });
    f.approvals.push({ who: "철수", at: "2026-11-17T10:02:00.000Z" });
    expect(deriveProgress(f)).toMatchObject({ stage: "approval", cause: "approval" });
    f.todos.push({ id: "td_1", title: "로그인", at: "2026-11-17T10:03:00.000Z" });
    expect(deriveProgress(f)).toMatchObject({ stage: "owner", owner: "대표" });
    f.marks.push({ id: 1, stage: "hold", at: "2026-11-17T10:04:00.000Z", who: "총괄", evidence: "다음 주로" });
    expect(deriveProgress(f)).toMatchObject({ stage: "hold", cause: "hold", next: "다음 주로" });
    f.marks.push({ id: 2, stage: "done", at: "2026-11-17T10:05:00.000Z", who: "총괄", evidence: "확인" });
    expect(deriveProgress(f)).toMatchObject({ stage: "done", cause: null, next: null });
  });

  test("완료는 끝 단계: 뒤에 온 막힘은 되돌리지 않고, 다시 열기 뒤에만 보고를 다시 읽는다", () => {
    const f = empty();
    f.reports.push(report("완료", { passed: true, checks: 2 }));
    f.marks.push({ id: 1, stage: "done", at: "2026-11-17T11:00:00.000Z", who: "총괄", evidence: "끝" });
    f.reports.push(report("막힘", { failed: ["늦은"], checks: 1, at: "2026-11-17T11:30:00.000Z" }));
    expect(deriveProgress(f).stage).toBe("done");
    f.marks.push({ id: 2, stage: "reopen", at: "2026-11-17T11:40:00.000Z", who: "총괄", evidence: "늦은 반례 확인" });
    expect(deriveProgress(f).stage).toBe("fix");
  });

  test("작성자 납품 뒤 독립 검토가 통과하면 두 보고를 근거로 합치기를 기다린다", () => {
    const f = empty();
    f.reports.push(report("완료", { id: "msg_author", at: "2026-11-17T10:00:00.000Z", passed: true, checks: 2 }));
    f.marks.push({ id: 1, stage: "review", at: "2026-11-17T11:00:00.000Z", who: "총괄", evidence: "영희에게 독립 검토 맡김" });
    f.reports.push(report("완료", { id: "msg_review", at: "2026-11-17T12:00:00.000Z", memberId: "w2", who: "영희", passed: true, checks: 2 }));
    expect(deriveProgress(f)).toMatchObject({ stage: "merge", owner: "총괄", basis: ["msg_review", "msg_author"] });
  });

  test("같은 시각의 납품과 검토도 글 순서로 독립 검토 결과를 구분한다", () => {
    const f = empty(), at = "2026-11-17T10:00:00.000Z";
    f.reports.push(report("완료", { id: "msg_author", at, passed: true, checks: 2 }));
    f.marks.push({ id: 1, stage: "review", at, who: "총괄", evidence: "영희에게 독립 검토 맡김" });
    f.reports.push(report("완료", { id: "msg_review", at, memberId: "w2", who: "영희", passed: true, checks: 2 }));
    expect(deriveProgress(f)).toMatchObject({ stage: "merge", basis: ["msg_review", "msg_author"] });
  });

  test("검토 기준은 검토를 맡기기 전의 최신 통과 납품이다", () => {
    const f = empty();
    f.reports.push(report("완료", { id: "msg_old", at: "2026-11-17T09:00:00.000Z", memberId: "w2", who: "영희", passed: true, checks: 2 }));
    f.reports.push(report("완료", { id: "msg_author", at: "2026-11-17T10:00:00.000Z", passed: true, checks: 2 }));
    f.marks.push({ id: 1, stage: "review", at: "2026-11-17T11:00:00.000Z", who: "총괄", evidence: "영희에게 최신 납품 검토 맡김" });
    f.reports.push(report("완료", { id: "msg_review", at: "2026-11-17T12:00:00.000Z", memberId: "w2", who: "영희", passed: true, checks: 2 }));
    expect(deriveProgress(f)).toMatchObject({ stage: "merge", basis: ["msg_review", "msg_author"] });
  });

  test("검토를 맡기기 전 납품이 없으면 뒤의 서로 다른 완료만으로 검토 통과라 하지 않는다", () => {
    const f = empty();
    f.marks.push({ id: 1, stage: "review", at: "2026-11-17T10:00:00.000Z", who: "총괄", evidence: "검토 맡김" });
    f.reports.push(report("완료", { at: "2026-11-17T11:00:00.000Z", passed: true, checks: 2 }));
    f.reports.push(report("완료", { at: "2026-11-17T12:00:00.000Z", memberId: "w2", who: "영희", passed: true, checks: 2 }));
    expect(deriveProgress(f).stage).not.toBe("merge");
  });

  for (const [name, change] of [
    ["판정을 통과하지 않은 검토", { passed: false }],
    ["실패 검사가 있는 검토", { failed: ["회귀"] }],
    ["실행하지 않은 검사가 남은 검토", { notRun: ["회귀"] }],
    ["작성자가 다시 올린 완료", { memberId: "w1", who: "철수" }],
    ["작성자를 확인할 수 없는 검토", { memberId: null }],
  ] satisfies [string, Partial<ReportFact>][]) {
    test(`${name}는 합치기 대기로 올리지 않는다`, () => {
      const f = empty();
      f.reports.push(report("완료", { at: "2026-11-17T10:00:00.000Z", passed: true, checks: 2 }));
      f.marks.push({ id: 1, stage: "review", at: "2026-11-17T11:00:00.000Z", who: "총괄", evidence: "영희에게 독립 검토 맡김" });
      f.reports.push({ ...report("완료", { at: "2026-11-17T12:00:00.000Z", memberId: "w2", who: "영희", passed: true, checks: 2 }), ...change });
      expect(deriveProgress(f).stage).not.toBe("merge");
    });
  }

  test("정정되어 통과 근거에서 빠진 검토는 뒤에 알림이 있어도 합치기 대기가 아니다", () => {
    const f = empty();
    f.reports.push(report("완료", { at: "2026-11-17T10:00:00.000Z", passed: true, checks: 2 }));
    f.marks.push({ id: 1, stage: "review", at: "2026-11-17T11:00:00.000Z", who: "총괄", evidence: "영희에게 독립 검토 맡김" });
    // Store는 정정된 완료의 passed를 false로 내려 준다.
    f.reports.push(report("완료", { at: "2026-11-17T12:00:00.000Z", memberId: "w2", who: "영희", passed: false, checks: 2 }));
    f.reports.push(report("알림", { at: "2026-11-17T13:00:00.000Z", memberId: "w2", who: "영희" }));
    expect(deriveProgress(f).stage).not.toBe("merge");
  });

  test("검토자의 막힘은 총괄이 조정하고, 다시 열면 원 작성자가 고친다", () => {
    const f = empty();
    f.reports.push(report("완료", { at: "2026-11-17T10:00:00.000Z", passed: true, checks: 2 }));
    f.marks.push({ id: 1, stage: "review", at: "2026-11-17T11:00:00.000Z", who: "총괄", evidence: "영희에게 독립 검토 맡김" });
    f.reports.push(report("막힘", { at: "2026-11-17T12:00:00.000Z", memberId: "w2", who: "영희", failed: ["회귀"], checks: 2 }));
    expect(deriveProgress(f)).toMatchObject({ stage: "fix", owner: "총괄" });
    expect(deriveProgress(f).next).toContain("철수");
    f.marks.push({ id: 1, stage: "reopen", who: "총괄", at: "2026-11-17T23:59:00.000Z", evidence: "수정 범위를 확인했습니다" });
    expect(deriveProgress(f)).toMatchObject({ stage: "fix", owner: "철수" });
  });

  test("잠든 세션을 기다리는 입력은 막힘이 아니라 진행 중(의존 대기)이다", () => {
    const f = empty();
    f.held.push({ id: "dl_1", who: "영희", reason: "asleep", at: "2026-11-17T10:00:00.000Z" });
    expect(deriveProgress(f)).toMatchObject({ stage: "working", cause: "dependency" });
    expect(needsAction(deriveProgress(f))).toBe(false);
  });

  test("보고 없이 전달 대기 입력만 있으면 실행 중인 보고로 표현하지 않는다", () => {
    const f = empty();
    f.queued.push({ id: "dl_1", who: "영희", at: "2026-11-17T10:00:00.000Z" });
    const p = deriveProgress(f);
    expect(p).toMatchObject({ stage: "working", cause: "dependency", basis: ["dl_1"] });
    expect(p.next).toContain("전달 대기");
  });

  test("보류 까닭: 자동으로 들어가는 기다림과 다시 보내지 않는 보류를 가른다", () => {
    expect(["asleep", "offline", "backend_down", "runner_disabled", "input_busy", "blocked"].map(holdCause)).toEqual(Array(6).fill("dependency"));
    expect(holdCause("delivery_unknown")).toBe("unknown");
    expect(holdCause("archived")).toBe("hold");
    expect(holdCause("stopped")).toBe("limit");
    expect(holdCause(null)).toBe("unknown");
  });

  test("판 번호는 근거 시각 중 가장 늦은 것이다. 화면은 낮은 판을 버리고 단계 없는 알림은 앞 단계를 남긴다", () => {
    const f = empty();
    f.reports.push(report("진행", { at: "2026-11-17T08:00:00.000Z" }));
    f.revTimes.push("2026-11-17T12:00:00.000Z");
    expect(deriveProgress(f).rev).toBe("2026-11-17T12:00:00.000Z");
    const hi = { ...deriveProgress(f), stage: "done" } as TaskProgress, lo = { ...hi, stage: "fix", rev: "2026-11-17T07:00:00.000Z" } as TaskProgress;
    expect(newerProgress(hi, lo)).toBe(hi);
    expect(newerProgress(lo, hi)).toBe(hi);
    expect(newerProgress(hi, undefined)).toBe(hi);
    const task: Task = { id: "tk_1", projectId: "p1", memberId: null, who: "철수", title: "업무", branch: null, worktree: null, createdAt: "2026-11-17T00:00:00.000Z", updatedAt: "2026-11-17T00:00:00.000Z", progress: hi } as Task;
    const state = { project: { id: "p1" }, tasks: [task] } as unknown as ProjectState;
    const late = applyToProject(state, { type: "task", task: { ...task, progress: lo } });
    expect(late.tasks![0]!.progress!.stage).toBe("done");
    const bare = applyToProject(state, { type: "task", task: { ...task, progress: undefined, title: "이름만 바뀜" } });
    expect(bare.tasks![0]).toMatchObject({ title: "이름만 바뀜", progress: { stage: "done" } });
  });

  test("목록 칸: 완료·보류·시작 전만 따로, 나머지는 진행 중", () => {
    expect(stageSec("done")).toBe("done");
    expect(stageSec("hold")).toBe("hold");
    expect(stageSec("new")).toBe("next");
    expect(stageSec("confirm")).toBe("doing");
  });
});

describe("반복 감시 경계", () => {
  const limits = DEFAULT_WATCH_LIMITS;
  test("같은 보고의 재처리는 새 실패 시도로 세지 않는다", () => {
    const failure = report("막힘", { failed: ["저장"], checks: 1 });
    const first = watchOnReport(null, failure, limits).next;
    let repeated = first;
    for (let i = 0; i < 4; i++) repeated = watchOnReport(repeated, failure, limits).next;
    expect(repeated).toEqual(first);
    expect(repeated).toMatchObject({ attempts: 1, same: 1, trippedAt: null });
  });
  test("지문이 바뀌면 진척으로 보고 연속 수를 새로 센다. 같은 지문 3번이면 한 번만 멈춘다", () => {
    const a = () => report("막힘", { failed: ["저장"], checks: 1 });
    let r = watchOnReport(null, a(), limits);
    r = watchOnReport(r.next, a(), limits);
    expect(r.next).toMatchObject({ attempts: 2, same: 2 });
    r = watchOnReport(r.next, report("막힘", { failed: ["다른"], checks: 1 }), limits);
    expect(r.next).toMatchObject({ attempts: 3, same: 1, trippedAt: null });
    r = watchOnReport(r.next, report("막힘", { failed: ["다른"], checks: 1 }), limits);
    r = watchOnReport(r.next, report("막힘", { failed: ["다른"], checks: 1 }), limits);
    expect(r.trip).toContain("같은 실패 3번");
    const after = watchOnReport(r.next, report("막힘", { failed: ["다른"], checks: 1 }), limits);
    expect(after).toMatchObject({ trip: null, quiet: true });
    expect(after.next!.history.length).toBeLessThanOrEqual(10);
    const reopened = watchOnReopen(after.next, "2026-11-17T13:00:00.000Z")!;
    expect(reopened).toMatchObject({ trippedAt: null, same: 0, attempts: 6, startedAt: after.next!.startedAt });
    expect(watchOnReport(reopened, report("완료", { passed: true }), limits).next).toBeNull();
  });

  test("지문: 실패 검사 이름(순서 무관) · 실행 안 함 · 근거 없음", () => {
    expect(fingerprint({ failed: ["b", "a"], notRun: [], checks: 2 })).toBe("fail:a|b");
    expect(fingerprint({ failed: [], notRun: ["회귀"], checks: 1 })).toBe("pending:회귀");
    expect(fingerprint({ failed: [], notRun: [], checks: 0 })).toBe("unknown");
  });

  test("보고 간격이 길어도 세 번째 동일 실패 보고에서 한 번만 멈춘다", () => {
    const failed = (at: string) => report("막힘", { at, failed: ["저장"], checks: 1 });
    const first = watchOnReport(null, failed("2026-11-17T00:00:00.000Z"));
    const second = watchOnReport(first.next, failed("2026-11-18T00:00:00.000Z"));
    expect(second.next).toMatchObject({ attempts: 2, same: 2, trippedAt: null });
    const third = failed("2026-11-20T00:00:00.000Z");
    const stopped = watchOnReport(second.next, third);
    expect(stopped.next).toMatchObject({ attempts: 3, same: 3, trippedAt: third.at });
    expect(stopped.trip).toContain("같은 실패 3번");
    expect(watchOnReport(stopped.next, third)).toMatchObject({ next: stopped.next, trip: null });
  });
});

describe("팀 목록 한 줄 규칙", () => {
  const now = Date.parse("2026-11-17T12:00:00.000Z");
  const prog = (stage: TaskProgress["stage"], next: string | null = null, extra: Partial<TaskProgress> = {}): TaskProgress =>
    ({ stage, cause: null, next, owner: "총괄", since: "2026-11-17T11:00:00.000Z", basis: [], rev: "2026-11-17T11:00:00.000Z", loop: null, notice: null, ...extra });
  const task = (id: string, progress?: TaskProgress, over: Partial<Task> = {}): Task =>
    ({ id, projectId: "p1", memberId: null, who: "철수", title: `업무 ${id}`, branch: null, worktree: null, createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-17T00:00:00.000Z", progress, ...over } as Task);
  const item = (id: string, sec: WorkItem["sec"], taskId?: string): WorkItem =>
    ({ id, projectId: "p1", sec, title: `항목 ${id}`, detail: "", who: "총괄", order: 0, doneAt: null, createdAt: "x", updatedAt: "2026-11-17T00:00:00.000Z", ...(taskId ? { taskId } : {}) });

  test("업무를 가리키는 항목은 손으로 정한 칸보다 업무 단계를 따르고, 진행판에 없는 업무도 같은 목록에 오른다", () => {
    const rows = workRows([item("w_1", "done", "tk_a")], [task("tk_a", prog("confirm", "총괄이 확인할 차례")), task("tk_b", prog("fix", "철수가 고칠 차례")), task("tk_old", prog("fix", "x", { rev: "2026-10-01T00:00:00.000Z" })), task("tk_new", prog("new"))], now);
    expect(rows.map((r) => [r.key, r.sec, r.label, r.next])).toEqual([
      ["w_1", "doing", "팀 확인 대기", "총괄이 확인할 차례"],
      ["tk_b", "doing", "고칠 것", "철수가 고칠 차례"],
    ]);
  });

  test("연결한 보류 카드의 대기 조건은 팀 목록에서도 볼 수 있다", () => {
    const card = { ...item("w_hold", "hold", "tk_a"), detail: "검수 자료가 도착하면 재개" };
    expect(workRows([card], [task("tk_a", prog("new"))], now)[0]).toMatchObject({
      sec: "hold", label: "보류", detail: card.detail,
    });
  });

  test("가리키지 않는 옛 항목은 칸을 그대로 두고, 그 항목의 업무는 두 번 올리지 않는다", () => {
    const rows = workRows([item("w_2", "next")], [task("tk_w_2", prog("owner", "대표님 할 일: 로그인"))], now);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sec: "next", label: "예정", next: "대표님 할 일: 로그인" });
    expect(hasTaskRows([task("tk_w_2", prog("fix", "x"))], now)).toBe(false);
  });

  test("완료 알림은 완료 단계이고 확인하지 않은 것만, 최근 것부터", () => {
    const n = (id: string, at: string, seenAt: string | null = null) => ({ id, at, seenAt, lines: ["끝"] });
    const list = noticeTasks([
      task("tk_1", prog("done", null, { notice: n("tn_1", "2026-11-17T10:00:00.000Z") })),
      task("tk_2", prog("done", null, { notice: n("tn_2", "2026-11-17T11:00:00.000Z") })),
      task("tk_3", prog("done", null, { notice: n("tn_3", "2026-11-17T09:00:00.000Z", "2026-11-17T09:30:00.000Z") })),
      task("tk_4", prog("fix", "x")),
    ]);
    expect(list.map((t) => t.id)).toEqual(["tk_2", "tk_1"]);
  });
});
