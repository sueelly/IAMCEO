// 업무 단계(대표 2026-11-17 #4aab3546): 팀 목록·대화가 같은 업무 id 의 근거로 같은 단계를 보이고,
// 막힘을 원인별로 가르며, 납품 뒤 단계가 이어지고, 반복을 경계에서 멈추고, 실제 완료에만 알림을 한 번 만든다.
// 실제 Store·Orchestrator·에이전트 도구 경로(가짜 실행기, 격리 데이터 폴더). 실제 직원·운영 DB 는 건드리지 않는다.
import { describe, expect, test } from "bun:test";
import { Bus } from "../server/bus.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import { Store } from "../server/store.ts";
import { fixture } from "./fixtures/harness-fixture.ts";
import type { Member, Task, WsEvent } from "../shared/types.ts";

const ONE = { kind: "coding", goal: "단계가 이어진다", acceptance: ["대화와 목록이 같은 단계"], checks: ["behavior", "regression"] };
const id = (r: { text: string }, prefix = "tk") => r.text.match(new RegExp(`#(${prefix}_[\\w-]+)`))![1]!;
type F = ReturnType<typeof fixture>;
const check = (kind: string, result: "pass" | "fail" | "not_run", name = kind) =>
  ({ kind, name, result, evidence: `${name} ${result}`, criterion: 1, ...(result === "pass" ? { command: `bun test ${name}` } : {}) });
const progressOf = (f: F, task: string) => f.store.listTasks(f.project.id).find((t: Task) => t.id === task)?.progress;
const newTask = async (f: F, contract: unknown = ONE, title = "단계 업무") => id(await f.tool(f.lead, "task", { title, ...(contract ? { contract } : {}) }));
async function deliver(f: F, task: string, member: Member = f.worker) {
  f.ran(member, "bun test behavior", "bun test regression");
  const r = await f.tool(member, "post", { task_id: task, kind: "완료", title: "작성자 납품", contract_rev: 1, checks: [check("behavior", "pass"), check("regression", "pass")] });
  expect(r.isError).toBeUndefined();
  return id(r, "msg");
}
const blocked = async (f: F, task: string, checks: unknown[], member: Member = f.worker, title = "막힘") => {
  const r = await f.tool(member, "post", { task_id: task, kind: "막힘", title, contract_rev: 1, ...(checks.length ? { checks } : {}) });
  expect(r.isError).toBeUndefined();
  return id(r, "msg");
};
const stage = (f: F, task: string, s: string, evidence = "근거") => f.tool(f.lead, "task_stage", { task_id: task, stage: s, evidence });
const notices = (f: F) => f.store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM task_notices").get()!.n;
const conductorSystem = (f: F) => f.store.db.query<{ text: string; wake: number }, [string]>("SELECT text, wake FROM deliveries WHERE member_id = ? AND kind = 'system' AND text LIKE '%반복 감시%'").all(f.lead.id);

test("코딩 업무는 main에 합쳐도 실제 적용 근거가 없으면 완료하지 않는다", async () => {
  const f = fixture(), task = await newTask(f);
  await deliver(f, task);
  expect((await stage(f, task, "merged", "main 0123abcd")).isError).toBeUndefined();
  const premature = await stage(f, task, "done", "코드만 합쳤습니다");
  expect(premature.isError).toBe(true);
  expect(premature.text).toContain("applied");
  expect(progressOf(f, task)!.stage).not.toBe("done");
  expect(notices(f)).toBe(0);
  expect((await stage(f, task, "applied", "검증한 릴리스와 실제 서비스 화면 일치")).isError).toBeUndefined();
  expect((await stage(f, task, "done", "완료 조건과 실제 적용을 확인했습니다")).isError).toBeUndefined();
  expect(progressOf(f, task)!.stage).toBe("done");
});

test("이전 릴리스의 적용 근거로 새 통합을 완료 처리하지 않는다", async () => {
  const f = fixture(), task = await newTask(f);
  await deliver(f, task);
  await stage(f, task, "merged", "main aaa1111");
  await stage(f, task, "applied", "실제 서비스 aaa1111 확인");
  await stage(f, task, "merged", "추가 수정 main bbb2222");
  expect((await stage(f, task, "done", "과거 적용 근거 재사용")).isError).toBe(true);
  expect(progressOf(f, task)!.stage).toBe("merged");
  await stage(f, task, "applied", "실제 서비스 bbb2222 확인");
  expect((await stage(f, task, "done", "최신 릴리스 적용 확인")).isError).toBeUndefined();
});

describe("막힘의 원인과 다음 차례", () => {
  test("결재 0건인데 막힘: 실행 안 한 검사만 남은 막힘은 대표 차례가 아니라 총괄 확인 대기다", async () => {
    const f = fixture(), task = await newTask(f);
    await blocked(f, task, [check("behavior", "pass"), check("regression", "not_run", "통합 뒤 회귀")]);
    f.ran(f.worker, "bun test behavior");
    expect(f.store.listDecisions(f.project.id).filter((d) => d.status === "open")).toHaveLength(0);
    expect(progressOf(f, task)).toMatchObject({ stage: "confirm", cause: "pending", owner: "총괄" });
    expect(progressOf(f, task)!.next).toContain("통합 뒤 회귀");
  });

  test("검사 근거 없는 막힘은 원인 미확인으로, 실패 검사가 있으면 기술 실패로 가른다", async () => {
    const f = fixture(), a = await newTask(f, ONE, "근거 없음"), b = await newTask(f, ONE, "실패");
    await blocked(f, a, []);
    await blocked(f, b, [check("behavior", "fail", "저장 시험")]);
    expect(progressOf(f, a)).toMatchObject({ stage: "confirm", cause: "unknown", owner: "총괄" });
    expect(progressOf(f, b)).toMatchObject({ stage: "fix", cause: "technical", owner: "철수" });
  });

  test("대표 할 일이 열려 있을 때만 대표 차례다. 닫히면 원래 단계로 돌아간다", async () => {
    const f = fixture(), task = await newTask(f, null, "할 일 기다림");
    const todo = await f.tool(f.worker, "todo", { title: "맥미니에 로그인", task_id: task });
    expect(todo.isError).toBeUndefined();
    await blocked(f, task, [], f.worker, "로그인 기다림");
    expect(progressOf(f, task)).toMatchObject({ stage: "owner", cause: "owner", owner: "대표" });
    const t = f.store.listTodos(f.project.id)[0]!;
    await f.orch.setTodoDone(t.id, true);
    expect(progressOf(f, task)!.stage).not.toBe("owner");
  });
});

describe("납품 뒤 단계: 검토·합치기·완료", () => {
  test("검토자 막힘(실패)은 작성자가 고칠 차례로 보이고, 계약 판정(작성자 납품)은 그대로 남는다", async () => {
    const f = fixture(), task = await newTask(f);
    await deliver(f, task);
    expect(progressOf(f, task)).toMatchObject({ stage: "delivered", owner: "총괄" });
    expect((await stage(f, task, "review", "영희에게 독립 검토 맡김")).isError).toBeUndefined();
    expect(progressOf(f, task)!.stage).toBe("review");
    await blocked(f, task, [check("behavior", "fail", "반례 2")], f.worker2, "검토 반례 실패");
    expect(progressOf(f, task)).toMatchObject({ stage: "fix", cause: "technical", owner: "철수" });
    // 의도된 보호: 다른 직원의 막힘은 작성자 완료 판정을 취소하지 않는다(단계는 따로 계산한다).
    const trace = JSON.parse((await f.tool(f.lead, "task_trace", { task_id: task })).text);
    expect(trace.currentCompletion.eligible).toBe(true);
    await deliver(f, task);
    expect(progressOf(f, task)!.stage).toBe("delivered");
  });

  test("완료는 근거가 있어야 받고, 알림은 재시도·재시작에도 한 번이며, 늦은 막힘이 완료를 되돌리지 않는다", async () => {
    const f = fixture(), task = await newTask(f);
    const early = await stage(f, task, "done", "끝난 것 같음");
    expect(early.isError).toBe(true);
    expect(early.text).toContain("통과 완료 보고가 없습니다");
    await deliver(f, task);
    const unmerged = await stage(f, task, "done", "납품 받음");
    expect(unmerged.isError).toBe(true);
    expect(unmerged.text).toContain("메인 합침");
    expect((await stage(f, task, "merged", "메인에 합침")).isError).toBe(true);
    expect((await stage(f, task, "merged", "메인에 합침 0123abcd")).isError).toBeUndefined();
    expect(progressOf(f, task)!.stage).toBe("merged");
    expect((await stage(f, task, "applied", "통합 릴리스의 실제 사용 화면 확인")).isError).toBeUndefined();
    const done = await stage(f, task, "done", "통합 뒤 확인 통과");
    expect(done.isError).toBeUndefined();
    const again = await stage(f, task, "done", "응답 유실 재시도");
    expect(again.text).toContain("이미 완료");
    expect(notices(f)).toBe(1);
    expect(id(again, "tn")).toBe(id(done, "tn"));
    const p = progressOf(f, task)!;
    expect(p).toMatchObject({ stage: "done", cause: null, next: null });
    expect(p.notice!.lines[0]).toBe("단계 업무 완료");
    expect(p.notice!.lines.join("\n")).toContain("메인 합침: 메인에 합침");
    expect(p.notice!.lines.join("\n")).not.toContain("0123abcd");
    // 늦게 온 막힘·중복 보고는 완료를 되돌리지 않는다.
    await blocked(f, task, [check("behavior", "fail", "늦은 반례")], f.worker2, "늦은 검토");
    expect(progressOf(f, task)!.stage).toBe("done");
    // 재시작(같은 DB 의 새 Store·Orchestrator): 단계·알림이 그대로이고 다시 만들지 않는다.
    const store = new Store(f.store.db, new Bus());
    const orch = new Orchestrator({ config: f.config, store, runners: new Map([["core", f.runner]]), providerHomes: f.isolated.providerHomes, timings: { tickMs: 60_000, healthMs: 60_000 } });
    try {
      expect(store.listTasks(f.project.id).find((t) => t.id === task)!.progress).toMatchObject({ stage: "done", notice: { id: p.notice!.id } });
      expect((await orch.handleAgentTool(store.requireMember(f.lead.id), "task_stage", { task_id: task, stage: "done", evidence: "재시작 뒤 재시도" })).text).toContain("이미 완료");
      expect(notices(f)).toBe(1);
    } finally { await orch.shutdown(); }
    // 대표가 확인하면 두 화면이 같은 값을 본다(두 번 눌러도 한 번).
    const seen1 = f.store.seeTaskNotice(f.project.id, p.notice!.id).progress!.notice!.seenAt;
    const seen2 = f.store.seeTaskNotice(f.project.id, p.notice!.id).progress!.notice!.seenAt;
    expect(seen1).toBeTruthy();
    expect(seen2).toBe(seen1!);
    // 결재 수로 세지 않는다.
    expect(f.store.listDecisions(f.project.id)).toHaveLength(0);
  });

  test("계약 없는 업무의 완료는 거절하고 열린 할 일과 미완료 상태를 유지한다", async () => {
    const f = fixture(), plain = await newTask(f, null, "질문 답하기"), waiting = await newTask(f, null, "로그인 뒤 확인");
    expect((await f.tool(f.worker, "post", { task_id: plain, kind: "완료", title: "답함" })).isError).toBe(true);
    expect(progressOf(f, plain)!.stage).not.toBe("done");
    expect(progressOf(f, plain)!.notice).toBeNull();
    await f.tool(f.worker, "todo", { title: "로그인", task_id: waiting });
    await f.tool(f.worker, "post", { task_id: waiting, kind: "완료", title: "확인함" });
    expect(progressOf(f, waiting)!.stage).toBe("owner");
    expect(notices(f)).toBe(0);
  });
});

describe("반복 감시", () => {
  test("같은 실패 3번이면 총괄이 접근을 바꾸고 다시 연다", async () => {
    const f = fixture(), task = await newTask(f, { ...ONE, inputs: ["승인된 요청과 기존 결과"], outputs: ["검증한 결과"], scope: "승인된 업무의 남은 조건", constraints: [], exclusions: [] });
    for (let i = 0; i < 2; i++) await blocked(f, task, [check("regression", "fail", "저장 시험")]);
    expect(progressOf(f, task)!.stage).toBe("fix");
    expect(conductorSystem(f)).toHaveLength(0);
    await blocked(f, task, [check("regression", "fail", "저장 시험")]);
    const p = progressOf(f, task)!;
    expect(p).toMatchObject({ stage: "check", cause: "loop", owner: "총괄", loop: { attempts: 3, same: 3 } });
    expect(p.loop!.trippedAt).toBeTruthy();
    expect(conductorSystem(f)).toHaveLength(1);
    expect(conductorSystem(f)[0]!.text).toContain("같은 실패 3번");
    expect(conductorSystem(f)[0]!.text).toContain("저장 시험");
    const quiet = await blocked(f, task, [check("regression", "fail", "저장 시험")]);
    const wake = f.store.db.query<{ wake: number }, [string, string]>("SELECT wake FROM deliveries WHERE member_id = ? AND ref_id = ?").get(f.lead.id, quiet)!.wake;
    expect(wake).toBe(0);
    expect(conductorSystem(f)).toHaveLength(1);
    const refused = await f.tool(f.lead, "team_assign", { member: "철수", text: "같은 방법으로 다시", task_id: task });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("접근");
    // 재시작에도 감시가 남는다.
    const store = new Store(f.store.db, new Bus());
    expect(store.getTaskWatch(task)).toMatchObject({ attempts: 4, trippedAt: p.loop!.trippedAt });
    expect(f.store.pendingTaskFailureDecision(task)).toBeNull();
    expect((await stage(f, task, "reopen", "원인을 저장 경로로 좁혀 접근을 바꿈")).isError).toBeUndefined();
    expect(progressOf(f, task)!.stage).toBe("fix");
    expect(progressOf(f, task)!.loop).toMatchObject({ attempts: 4, trippedAt: null });
    expect((await f.tool(f.lead, "team_assign", { member: "철수", text: "저장 경로부터 다시", task_id: task })).isError).toBeUndefined();
  });

  test("시간 경계: 직원 쪽 단계에서 진척 없이 2시간이면 한 번 멈춘다. 대표 차례는 세지 않는다", async () => {
    const f = fixture(), task = await newTask(f), owner = await newTask(f, ONE, "대표 기다림");
    await blocked(f, task, [check("regression", "fail", "저장 시험")]);
    await f.tool(f.worker, "todo", { title: "결제 확인", task_id: owner });
    await blocked(f, owner, [check("regression", "fail", "결제 시험")]);
    const later = Date.now() + 2 * 60 * 60_000 + 1000;
    f.orch.checkTaskWatches(Date.now() + 60_000);
    expect(progressOf(f, task)!.stage).toBe("fix");
    f.orch.checkTaskWatches(later);
    f.orch.checkTaskWatches(later + 60_000);
    expect(progressOf(f, task)).toMatchObject({ stage: "check", cause: "loop" });
    expect(progressOf(f, task)!.loop!.reason).toContain("진척 없이");
    expect(progressOf(f, owner)!.stage).toBe("owner");
    expect(conductorSystem(f)).toHaveLength(1);
  });

  test("통과 완료가 오면 반복이 끝난다", async () => {
    const f = fixture(), task = await newTask(f);
    await blocked(f, task, [check("regression", "fail", "저장 시험")]);
    expect(f.store.getTaskWatch(task)).toBeTruthy();
    await deliver(f, task);
    expect(f.store.getTaskWatch(task)).toBeNull();
  });
});

describe("팀 목록과 대화의 연결", () => {
  test("진행판 항목이 기존 업무를 가리키면 새 업무를 만들지 않고 그 업무의 단계를 쓴다", async () => {
    const f = fixture(), task = await newTask(f);
    await deliver(f, task);
    const r = await f.tool(f.lead, "work_set", { sec: "doing", title: "단계 업무", who: "철수", task_id: task });
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain("작성자 납품");
    const item = f.store.listWork(f.project.id)[0]!;
    expect(item.taskId).toBe(task);
    expect(f.store.getTask(Store.workTaskId(item.id))).toBeNull();
    const list = JSON.parse((await f.tool(f.lead, "work_list", {})).text);
    expect(list[0]).toMatchObject({ task_id: task, stage: "작성자 납품" });
    const done = await f.tool(f.lead, "work_set", { id: item.id, sec: "done", title: "단계 업무", task_id: task });
    expect(done.text).toContain("아직 '작성자 납품'");
    expect((await f.tool(f.lead, "work_set", { sec: "doing", title: "없는 업무", task_id: "tk_none" })).isError).toBe(true);
  });

  test("대기열은 실행할 입력과 보류를 나눠 센다. 보류(수신 불확실)는 단계에 보이고 자동으로 다시 보내지 않는다", async () => {
    const f = fixture(), task = await newTask(f);
    f.store.enqueue({ projectId: f.project.id, memberId: f.worker2.id, kind: "instruction", text: "보호된 옛 입력", status: "held", holdReason: "delivery_unknown", taskId: task });
    const m = f.store.requireMember(f.worker2.id);
    expect(m.queuedCount).toBe(1);
    expect(m.heldCount).toBe(1);
    expect(progressOf(f, task)).toMatchObject({ stage: "held", cause: "unknown", owner: "총괄" });
    expect(progressOf(f, task)!.next).toContain("자동으로 다시 보내지 않습니다");
    f.orch.checkTaskWatches();
    expect(f.runner.to(f.worker2).some((t) => t.includes("보호된 옛 입력"))).toBe(false);
  });

  test("단계가 바뀌면 같은 업무의 task 이벤트가 단계와 판 번호를 싣고 나간다", async () => {
    const f = fixture(), task = await newTask(f);
    const events: WsEvent[] = [];
    (f.store as unknown as { bus: Bus }).bus.subscribe((e) => { events.push(e); });
    await blocked(f, task, [check("regression", "fail", "저장 시험")]);
    const sent = events.filter((e): e is Extract<WsEvent, { type: "task" }> => e.type === "task" && e.task.id === task && !!e.task.progress);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.at(-1)!.task.progress).toMatchObject({ stage: "fix" });
    expect(sent.at(-1)!.task.progress!.rev).toBe(progressOf(f, task)!.rev);
  });
});
