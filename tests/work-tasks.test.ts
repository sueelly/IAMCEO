// 진행판 일 항목 → 대화 작업 칩: 만들면 바로 생기고(실시간 task 이벤트), 고치면 따라 바뀌며, 완료·삭제하면 칩에서 숨는다.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Backend, Task, WsEvent } from "../shared/types.ts";
import { Bus } from "../server/bus.ts";
import { loadConfig, updateConfigFile } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import type { Runner } from "../server/runner/types.ts";
import { Store } from "../server/store.ts";
import { chipTasks, taskActivity, workIdOf } from "../web/src/lib/tasks";

function setup() {
  const home = mkdtempSync(join(tmpdir(), "iamceo-worktask-"));
  const env = { IAMCEO_HOME: home, IAMCEO_PORT: "0" };
  updateConfigFile({ accessCode: "code", hosts: ["127.0.0.1"] }, env);
  const config = loadConfig(env);
  const bus = new Bus();
  const events: WsEvent[] = [];
  bus.subscribe((e) => { events.push(e); });
  const store = new Store(openDb(config.dbPath), bus);
  const project = store.createProject({ name: "시험", cwd: home });
  return { home, config, bus, store, project, events, taskEvents: () => events.filter((e): e is Extract<WsEvent, { type: "task" }> => e.type === "task").map((e) => e.task) };
}

describe("진행판 일 항목의 작업 칩", () => {
  test("일 항목을 만들면 작업이 생기고 task 이벤트가 바로 나간다. 제목·담당을 고치면 같은 id 로 바뀐다", () => {
    const t = setup();
    const item = t.store.upsertWork({ projectId: t.project.id, sec: "doing", title: "기억 기본 동작", who: "작업 실행 체계" });
    const id = Store.workTaskId(item.id);
    expect(t.store.getTask(id)).toMatchObject({ id, projectId: t.project.id, memberId: null, who: "작업 실행 체계", title: "기억 기본 동작" });
    expect(t.taskEvents().map((x) => x.id)).toEqual([id]);

    t.store.upsertWork({ projectId: t.project.id, id: item.id, sec: "doing", title: "기억 기본 동작·검색 먼저", who: "비서" });
    expect(t.store.getTask(id)).toMatchObject({ title: "기억 기본 동작·검색 먼저", who: "비서" });
    expect(t.taskEvents().map((x) => x.title)).toEqual(["기억 기본 동작", "기억 기본 동작·검색 먼저"]);

    // 바뀐 것이 없으면 이벤트를 다시 내지 않는다
    t.store.upsertWork({ projectId: t.project.id, id: item.id, sec: "next", title: "기억 기본 동작·검색 먼저" });
    expect(t.taskEvents()).toHaveLength(2);
    expect(t.store.listTasks(t.project.id)).toHaveLength(1);
  });

  test("처음부터 완료로 적은 항목은 작업을 만들지 않고, 완료해도 작업(과 그 글)은 남는다", () => {
    const t = setup();
    t.store.upsertWork({ projectId: t.project.id, sec: "done", title: "정리하며 옮김" });
    expect(t.store.listTasks(t.project.id)).toHaveLength(0);
    const item = t.store.upsertWork({ projectId: t.project.id, sec: "doing", title: "진행" });
    t.store.upsertWork({ projectId: t.project.id, id: item.id, sec: "done", title: "진행" });
    t.store.removeWork(item.id);
    expect(t.store.getTask(Store.workTaskId(item.id))).not.toBeNull();
  });

  test("이 기능 전에 있던 진행 중·예정 항목은 다시 열 때 작업이 생긴다(완료 항목은 아님)", () => {
    const t = setup();
    const doing = t.store.upsertWork({ projectId: t.project.id, sec: "doing", title: "진행" });
    const done = t.store.upsertWork({ projectId: t.project.id, sec: "done", title: "끝" });
    // 예전 서버가 만든 상태처럼 작업을 지운다
    t.store.db.run("DELETE FROM tasks");
    const reopened = new Store(t.store.db, new Bus());
    expect(reopened.getTask(Store.workTaskId(doing.id))).toMatchObject({ title: "진행" });
    expect(reopened.getTask(Store.workTaskId(done.id))).toBeNull();
    // 두 번 열어도 하나
    new Store(t.store.db, new Bus());
    expect(reopened.listTasks(t.project.id)).toHaveLength(1);
  });

  test("일 항목의 담당으로 적혀도 그 작업으로 짐작하지 않는다: 근거 없는 직원 글은 거절하고 새 업무를 만들라고 안내한다", async () => {
    const t = setup();
    const orch = new Orchestrator({ config: t.config, store: t.store, runners: new Map<Backend, Runner>() });
    const w = t.store.createMember({ projectId: t.project.id, kind: "worker", name: "작업 실행 체계", handle: "w3", role: "개발" } as never);
    const item = t.store.upsertWork({ projectId: t.project.id, sec: "doing", title: "기억", who: "작업 실행 체계" });
    expect(t.store.memberUsesTasks(w.id)).toBe(false);
    expect(() => orch.memberTask(w)).toThrow(/task 도구로 새 업무를 만들고/);
    expect(() => orch.memberTask(w, null)).toThrow(/null 로 '전체'에 두지 않/);
    expect(orch.memberTask(w, Store.workTaskId(item.id))).toBe(Store.workTaskId(item.id));
    await orch.shutdown();
  });

  test("conductor 의 work_set 결과에 대화 작업 id 가 나온다", async () => {
    const t = setup();
    const orch = new Orchestrator({ config: t.config, store: t.store, runners: new Map<Backend, Runner>() });
    const lead = t.store.createMember({ projectId: t.project.id, kind: "conductor", name: "총괄", handle: "lead", role: "총괄" } as never);
    const r = await orch.handleAgentTool(lead, "work_set", { sec: "doing", title: "새 일" });
    expect(r.isError).toBeFalsy();
    const workId = /일 항목 #(w_[A-Za-z0-9]+)/.exec(r.text)![1]!;
    expect(r.text).toContain(`대화 작업 #${Store.workTaskId(workId)}`);
    await orch.shutdown();
  });
});

describe("화면: 칩으로 보일 작업", () => {
  const task = (id: string, memberId: string | null = null): Task => ({ id, projectId: "p1", memberId, who: "", title: id, branch: null, worktree: null, createdAt: id, updatedAt: id });
  // 대표 2026-11-14: "밑에 업무 목록 뜰 때 맡은 직원은 뜨지 않게… 얘는 작업 목록에 뜨지도 않아… 누르면 아무것도 안뜨는 것도 있는데"
  // 실제 대표 화면(11-14 06시): 칩 14개 중 9개가 글 0건(진행판 계획만 있는 일), 글이 있는 업무 10개는 진행판에서 끝났다고 칩에서 빠짐.
  test("업무 목록은 글이 있는 업무를 모두 최근 글 순으로 보이고, 끝낸 일의 업무도 숨기지 않으며, 글 없는 업무는 뺀다", () => {
    const at = (h: number) => `2026-11-13T${String(h).padStart(2, "0")}:00:00.000Z`;
    const tasks: Task[] = [
      { ...task("tk_w_done"), createdAt: at(1), lastMessageAt: at(9) }, // 진행판에서 끝낸 일, 글 있음
      { ...task("tk_w_plan"), createdAt: at(8), lastMessageAt: null }, // 진행판 계획만, 글 0
      { ...task("tk_mine", "w1"), createdAt: at(2), lastMessageAt: at(3) },
      { ...task("tk_owner"), createdAt: at(7), lastMessageAt: null }, // 서버는 글 0이라 했지만 방금 화면에 글이 옴
      { ...task("tk_merged"), createdAt: at(6), lastMessageAt: at(6), mergedInto: "tk_mine" },
      { ...task("tk_old_server"), createdAt: at(0) }, // 마지막 글 시각을 모르는 옛 응답: 비었는지 모르니 남긴다
    ];
    const live = [{ taskId: "tk_owner", at: at(10) }];
    expect(chipTasks(tasks, live).map((x) => x.id)).toEqual(["tk_owner", "tk_w_done", "tk_mine", "tk_old_server"]);
    // 지금 고른 업무는 글이 없어도 남는다(팀 화면 일 목록에서 고른 계획 일)
    expect(chipTasks(tasks, live, "tk_w_plan").map((x) => x.id)).toContain("tk_w_plan");
    expect(taskActivity(tasks[3]!, live)).toBe(at(10));
    expect(workIdOf(task("tk_w_done"))).toBe("w_done");
    expect(workIdOf(task("tk_mine"))).toBeNull();
  });

  test("업무 목록은 받는 사람·담당과 상관없이 같다(맡은 직원으로 거르지 않는다)", () => {
    const tasks: Task[] = [{ ...task("tk_a"), who: "총괄·엘리트사원 클로드", lastMessageAt: "2026-11-13T02:00:00Z" }, { ...task("tk_b", "w3"), who: "작업 실행 체계", lastMessageAt: "2026-11-13T01:00:00Z" }];
    expect(chipTasks(tasks).map((x) => x.id)).toEqual(["tk_a", "tk_b"]);
  });
});

// 대표가 작업 칩을 눌렀을 때 대화가 비던 원인: 총괄이 진행판 항목(칩)을 만든 뒤에도 지시·자기 글에 task_id 를 넣지 않아
// 모두 전체로 갔다. 서버는 작업을 추측하지 않고, 작업을 쓰는 프로젝트에서는 총괄이 작업을 밝히게 한다.
describe("작업 귀속: 칩 → 지시 → 보고", () => {
  async function team() {
    const t = setup();
    const orch = new Orchestrator({ config: t.config, store: t.store, runners: new Map<Backend, Runner>() });
    const lead = t.store.createMember({ projectId: t.project.id, kind: "conductor", name: "총괄", handle: "lead", role: "총괄" } as never);
    const w = t.store.createMember({ projectId: t.project.id, kind: "worker", name: "철수", handle: "w1", role: "개발" } as never);
    const deliveries = () => t.store.listDeliveries(t.project.id).filter((d) => d.memberId === w.id && d.kind === "instruction");
    const chip = async (title: string) => {
      const r = await orch.handleAgentTool(lead, "work_set", { sec: "doing", title, who: "철수" });
      return /대화 작업 #(tk_w_[A-Za-z0-9_-]+)/.exec(r.text)![1]!;
    };
    const setCriteria = async (taskId: string, acceptance: string) => {
      const title = t.store.requireTask(taskId).title;
      const result = await orch.handleAgentTool(lead, "task", { task_id: taskId, contract: {
        kind: "other", goal: title,
        inputs: [`${title} 작업 항목과 해당 작업에 연결한 대표 지시`],
        outputs: [`${title}의 수행 결과 보고와 작업별 지시·보고 연결 기록`],
        scope: `${title} 작업의 완료 기준을 수행하고 지시·보고·자료·결재를 해당 작업에 연결한다`,
        constraints: [], exclusions: [], acceptance: [acceptance], checks: ["real"],
      } });
      expect(result.isError, result.text).toBeFalsy();
    };
    const taskMessages = (taskId: string) => t.store.listMessagePage(t.project.id, { scope: { kind: "task", taskId } }).items;
    return { ...t, orch, lead, w, deliveries, chip, setCriteria, taskMessages };
  }

  test("업무가 하나도 없는 프로젝트에서도 지시·총괄 글은 업무 없이 남지 않는다: 빼면 거절하고, task 로 새 업무를 만들어 넣는다", async () => {
    const t = await team();
    const r = await t.orch.handleAgentTool(t.lead, "team_assign", { member: "w1", text: "확인해 주세요" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("task 도구로 새 업무");
    expect(t.deliveries()).toHaveLength(0);
    const made = await t.orch.handleAgentTool(t.lead, "task", { title: "로그인 확인" });
    const id = /#(tk_[A-Za-z0-9_-]+)/.exec(made.text)![1]!;
    // 같은 제목으로 다시 부르면(응답 유실·재시도) 새로 만들지 않는다
    expect(/#(tk_[A-Za-z0-9_-]+)/.exec((await t.orch.handleAgentTool(t.lead, "task", { title: "로그인 확인" })).text)![1]).toBe(id);
    expect(t.store.listTasks(t.project.id)).toHaveLength(1);
    await t.setCriteria(id, "로그인 성공 화면과 계정 표시를 확인한다");
    expect((await t.orch.handleAgentTool(t.lead, "team_assign", { member: "w1", text: "확인해 주세요", task_id: id })).isError).toBeFalsy();
    expect(t.store.deliveryTaskId(t.deliveries()[0]!.id)).toBe(id);
    expect((await t.orch.handleAgentTool(t.lead, "post", { kind: "진행", title: "맡겼습니다" })).isError).toBe(true);
    expect((await t.orch.handleAgentTool(t.lead, "post", { kind: "진행", title: "맡겼습니다", task_id: id })).isError).toBeFalsy();
    await t.orch.shutdown();
  });

  test("칩이 생긴 뒤 task_id 를 빼거나 null 이면 지시·총괄 글을 거절하고, 밝히면 지시·보고가 같은 칩에 모인다", async () => {
    const t = await team();
    const a = await t.chip("작업A");
    const b = await t.chip("작업B");
    await t.setCriteria(a, "작업A 결과와 합치기 판단을 같은 업무에 보고한다");

    const miss = await t.orch.handleAgentTool(t.lead, "team_assign", { member: "w1", text: "A 하세요" });
    expect(miss.isError).toBe(true);
    expect(miss.text).toContain("task_id 가 없습니다");
    expect(miss.text).toContain("work_set");
    expect(t.deliveries()).toHaveLength(0);

    const ok = await t.orch.handleAgentTool(t.lead, "team_assign", { member: "w1", text: "A 하세요", task_id: a });
    expect(ok.isError).toBeFalsy();
    expect(ok.text).toContain(`작업 #${a}`);
    const d = t.deliveries()[0]!;
    expect(t.store.deliveryTaskId(d.id)).toBe(a);
    expect(d.text).toContain(`작업 #${a}`);

    // 총괄 자기 글도 밝혀야 한다(빼거나 null 이면 업무 없이 새지 않게 거절)
    const leadMiss = await t.orch.handleAgentTool(t.lead, "post", { kind: "진행", title: "A 맡겼습니다" });
    expect(leadMiss.isError).toBe(true);
    expect(leadMiss.text).toContain("work_set");
    expect((await t.orch.handleAgentTool(t.lead, "post", { kind: "진행", title: "A 맡겼습니다", task_id: a })).isError).toBeFalsy();
    const leadNull = await t.orch.handleAgentTool(t.lead, "post", { kind: "알림", title: "판 정리", task_id: null });
    expect(leadNull.isError).toBe(true);
    expect(leadNull.text).toContain("null 로 '전체'에 두지 않");

    // 직원 보고·결재·자료
    expect((await t.orch.handleAgentTool(t.w, "post", { kind: "완료", title: "A 끝", task_id: a, contract_rev: 1,
      checks: [{ name: "A 결과 확인", kind: "real", result: "pass", evidence: "격리 작업A의 결과 자료와 합치기 판단을 확인", criterion: 1 }] })).isError).toBeFalsy();
    expect((await t.orch.handleAgentTool(t.w, "ask", { title: "A 합칠까요?", detail: "합칠지", task_id: a })).isError).toBeFalsy();
    expect((await t.orch.handleAgentTool(t.w, "file", { title: "A 결과", content: "# A", task_id: a })).isError).toBeFalsy();

    const titles = t.taskMessages(a).map((m) => m.title);
    expect(titles).toEqual(expect.arrayContaining(["A 맡겼습니다", "A 끝", "A 합칠까요?"]));
    expect(t.taskMessages(b)).toHaveLength(0);
    expect(t.store.listMessagePage(t.project.id).items.some((m) => m.title === "판 정리")).toBe(false);

    // null 지시(옛 도구의 '전체')도 근거가 없으면 거절한다
    const nullAssign = await t.orch.handleAgentTool(t.lead, "team_assign", { member: "w1", text: "전체 일", task_id: null });
    expect(nullAssign.isError).toBe(true);
    expect(t.deliveries()).toHaveLength(1);
    await t.orch.shutdown();
  });

  test("대표가 칩에서 보낸 글을 인용하면 그 작업이 증거가 되고, 다른 작업을 넣으면 거절한다. 업무 없이 보낸 글은 서버가 만든 새 업무를 총괄이 분류한다", async () => {
    const t = await team();
    const a = await t.chip("작업A");
    const b = await t.chip("작업B");
    await t.setCriteria(b, "B 버튼이 파란색으로 표시된다");
    const onB = await t.orch.sendUserMessage(t.project.id, { text: "B 버튼 색을 파랗게 바꿔 줘", taskId: b });
    expect(onB.taskId).toBe(b);
    const whole = await t.orch.sendUserMessage(t.project.id, { text: "전체에서 보낸 다른 부탁이야", taskId: null });
    const auto = t.store.getTask(whole.taskId!)!;
    await t.setCriteria(auto.id, "대표의 다른 부탁에 대한 결과를 원 지시 업무에 보고한다");
    expect(auto).toMatchObject({ title: "전체에서 보낸 다른 부탁이야", origin: "auto", memberId: null, mergedInto: null });

    const quoted = await t.orch.handleAgentTool(t.lead, "team_assign", { member: "w1", text: "B 색 바꾸기", user_quote: "B 버튼 색을 파랗게 바꿔 줘" });
    expect(quoted.isError).toBeFalsy();
    expect(t.store.deliveryTaskId(t.deliveries().at(-1)!.id)).toBe(b);

    // 대표가 고른 업무의 글은 다른 업무로 옮기지 않는다
    const wrong = await t.orch.handleAgentTool(t.lead, "team_assign", { member: "w1", text: "B 색 바꾸기", user_quote: "B 버튼 색을 파랗게 바꿔 줘", task_id: a });
    expect(wrong.isError).toBe(true);
    expect(wrong.text).toContain(b);
    expect(t.store.getMessage(onB.id)!.taskId).toBe(b);

    // 업무 없이 보낸 글을 인용하면 서버가 만든 그 업무가 증거다
    const fromWhole = await t.orch.handleAgentTool(t.lead, "team_assign", { member: "w1", text: "다른 부탁", user_quote: "전체에서 보낸 다른 부탁이야" });
    expect(fromWhole.isError).toBeFalsy();
    expect(t.store.deliveryTaskId(t.deliveries().at(-1)!.id)).toBe(auto.id);

    // 총괄이 그 글을 이미 있는 업무 C 의 일로 분류하면: 그 업무에 대표 글만 있으니 글을 C 로 옮기고 기록을 남긴다(원문은 그대로)
    const c = await t.chip("작업C");
    await t.setCriteria(c, "대표의 다른 부탁을 작업C에 분류하여 결과를 보고한다");
    const before = t.store.getMessage(whole.id)!;
    expect((await t.orch.handleAgentTool(t.lead, "team_assign", { member: "w1", text: "다른 부탁", user_quote: "전체에서 보낸 다른 부탁이야", task_id: c })).isError).toBeFalsy();
    const after = t.store.getMessage(whole.id)!;
    expect(after.taskId).toBe(c);
    expect({ ...after, taskId: null }).toEqual({ ...before, taskId: null });
    expect(t.store.getTask(auto.id)!.mergedInto).toBe(c);
    expect(t.store.listTaskLinks(t.project.id, { refType: "message", refId: whole.id })).toEqual([expect.objectContaining({ fromTaskId: auto.id, toTaskId: c, basis: "classify", actor: t.lead.id })]);
    expect(t.store.deliveryTaskId(t.deliveries().at(-1)!.id)).toBe(c);
    // 합쳐진 업무 id 로 오는 글은 합쳐진 곳으로 간다(오래 열어 둔 화면·옛 작업 줄)
    expect((await t.orch.sendUserMessage(t.project.id, { text: "하나 더", taskId: auto.id })).taskId).toBe(c);
    expect(t.orch.memberTask(t.w, auto.id)).toBe(c);
    await t.orch.shutdown();
  });

  test("서버가 만든 업무에 다른 직원 글이 이미 있으면 총괄이 다른 업무로 맡겨도 글을 옮기지 않고 갈라진 관계만 남긴다", async () => {
    const t = await team();
    const whole = await t.orch.sendUserMessage(t.project.id, { text: "견적서 양식 만들어 줘" });
    const auto = whole.taskId!;
    expect((await t.orch.handleAgentTool(t.w, "post", { kind: "진행", title: "양식 초안 작성 중", task_id: auto })).isError).toBeFalsy();
    const made = await t.orch.handleAgentTool(t.lead, "task", { title: "견적서 양식 개편" });
    const next = /#(tk_[A-Za-z0-9_-]+)/.exec(made.text)![1]!;
    await t.setCriteria(next, "견적서 양식에 항목·금액·합계 입력란이 있다");
    expect((await t.orch.handleAgentTool(t.lead, "team_assign", { member: "w1", text: "개편으로 이어서", user_quote: "견적서 양식 만들어 줘", task_id: next })).isError).toBeFalsy();
    expect(t.store.getMessage(whole.id)!.taskId).toBe(auto);
    expect(t.store.getTask(auto)!.mergedInto).toBeNull();
    expect(t.store.getTask(next)!.parentTaskId).toBe(auto);
    expect(t.store.listTaskLinks(t.project.id, { refType: "task", refId: next })).toEqual([expect.objectContaining({ fromTaskId: auto, toTaskId: next, basis: "derived" })]);
    expect(t.store.deliveryTaskId(t.deliveries().at(-1)!.id)).toBe(next);
    await t.orch.shutdown();
  });

  test("결재 닫기의 후속 지시는 그 결재 카드의 작업을 잇는다", async () => {
    const t = await team();
    const a = await t.chip("작업A");
    await t.setCriteria(a, "대표가 정한 첫 번째 방식으로 작업A를 수행한다");
    const asked = await t.orch.handleAgentTool(t.w, "ask", { title: "A 방식?", detail: "고르기", task_id: a });
    const decisionId = /#(d_[A-Za-z0-9_-]+)/.exec(asked.text)![1]!;
    const rep = await t.orch.sendUserMessage(t.project.id, { text: "A 는 첫 번째 방식으로 해", taskId: null });
    const closed = await t.orch.handleAgentTool(t.lead, "ask_close", { id: decisionId, kind: "decided", reason: "대표가 대화에서 정함", user_quote: "A 는 첫 번째 방식으로 해", follow_up: { kind: "instruction", member_id: t.w.id, text: "첫 번째 방식으로 진행", source_message_id: rep.id } });
    expect(closed.isError).toBeFalsy();
    const d = t.deliveries().at(-1)!;
    expect(t.store.deliveryTaskId(d.id)).toBe(a);
    expect(d.text).toContain(`작업 #${a}`);
    await t.orch.shutdown();
  });
});
