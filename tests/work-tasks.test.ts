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
import { keepsTask, liveTasks, taskTarget, taskWorkers, visibleTasks, workIdOf } from "../web/src/lib/tasks";

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

  test("일 항목에서 생긴 작업은 직원에게 task_id 를 강제하지 않는다", async () => {
    const t = setup();
    const orch = new Orchestrator({ config: t.config, store: t.store, runners: new Map<Backend, Runner>() });
    const w = t.store.createMember({ projectId: t.project.id, kind: "worker", name: "작업 실행 체계", handle: "w3", role: "개발" } as never);
    t.store.upsertWork({ projectId: t.project.id, sec: "doing", title: "기억", who: "작업 실행 체계" });
    expect(t.store.memberUsesTasks(w.id)).toBe(false);
    expect(orch.memberTask(w)).toBeNull();
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
  test("완료했거나 지운 일 항목의 작업은 숨기고, 직원이 등록한 작업과 지금 고른 작업은 남긴다", () => {
    const tasks = [task("tk_w_open"), task("tk_w_done"), task("tk_w_gone"), task("tk_mine", "w1")];
    const work = [{ id: "w_open", sec: "doing" as const }, { id: "w_done", sec: "done" as const }];
    expect(liveTasks(tasks, work).map((x) => x.id)).toEqual(["tk_w_open", "tk_mine"]);
    expect(liveTasks(tasks, work, "tk_w_done").map((x) => x.id)).toEqual(["tk_w_open", "tk_w_done", "tk_mine"]);
    expect(workIdOf(task("tk_w_open"))).toBe("w_open");
    expect(workIdOf(task("tk_mine"))).toBeNull();
    // 직원을 대상으로 고르면 그 직원의 작업만(담당이 적히지 않은 일 항목 작업은 빠진다)
    expect(visibleTasks(liveTasks(tasks, work), "w1").map((x) => x.id)).toEqual(["tk_mine"]);
  });

  // 대표: "총괄에서는 잘 뜨는데 각 직원별로는 몇 개만 뜨네? 통일시켜" — 진행판 담당에 이름이 적힌 직원의 칩에도 그 작업이 보인다.
  test("진행판 담당에 이름이 적힌 직원을 고르면 그 일 항목 작업도 보이고, 그 직원에게 보낸다", () => {
    const workers = [{ id: "w1", name: "엘리트사원 클로드" }, { id: "w3", name: "작업 실행 체계" }];
    const t = (id: string, who: string, memberId: string | null = null): Task => ({ ...task(id, memberId), who, createdAt: id });
    const tasks = [t("tk_w_a", "총괄·엘리트사원 클로드"), t("tk_w_b", "작업 실행 체계"), t("tk_w_c", "비서·총괄"), t("tk_mine", "엘리트사원 클로드", "w1")];
    expect(taskWorkers(tasks[0]!, workers)).toEqual(["w1"]);
    expect(taskWorkers(tasks[2]!, workers)).toEqual([]);
    expect(visibleTasks(tasks, "w1", workers).map((x) => x.id).sort()).toEqual(["tk_mine", "tk_w_a"]);
    expect(visibleTasks(tasks, "w3", workers).map((x) => x.id)).toEqual(["tk_w_b"]);
    // 직원을 골라 둔 채 그 직원의 일 항목 작업을 고르면 받는 사람은 그 직원, 총괄로 고르면 총괄
    expect(taskTarget(tasks[0]!, workers, "w1")).toBe("w1");
    expect(taskTarget(tasks[0]!, workers, null)).toBeNull();
    expect(taskTarget(tasks[0]!, workers, "w3")).toBeNull();
    // 일 항목 작업은 총괄과 담당 직원 사이를 오가도 작업이 남고, 담당 아닌 직원을 고르면 풀린다
    expect(keepsTask(tasks[0]!, workers, null)).toBe(true);
    expect(keepsTask(tasks[0]!, workers, "w1")).toBe(true);
    expect(keepsTask(tasks[0]!, workers, "w3")).toBe(false);
    expect(keepsTask(tasks[3]!, workers, null)).toBe(false);
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
    const taskMessages = (taskId: string) => t.store.listMessagePage(t.project.id, { scope: { kind: "task", taskId } }).items;
    return { ...t, orch, lead, w, deliveries, chip, taskMessages };
  }

  test("작업이 없는 프로젝트는 예전대로: task_id 없이 맡기고 총괄 글은 전체", async () => {
    const t = await team();
    const r = await t.orch.handleAgentTool(t.lead, "team_assign", { member: "w1", text: "확인해 주세요" });
    expect(r.isError).toBeFalsy();
    expect(t.store.deliveryTaskId(t.deliveries()[0]!.id)).toBeNull();
    const p = await t.orch.handleAgentTool(t.lead, "post", { kind: "진행", title: "맡겼습니다" });
    expect(p.isError).toBeFalsy();
    await t.orch.shutdown();
  });

  test("칩이 생긴 뒤 task_id 를 빼면 지시·총괄 글을 거절하고, 밝히면 지시·보고가 같은 칩에 모인다", async () => {
    const t = await team();
    const a = await t.chip("작업A");
    const b = await t.chip("작업B");

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

    // 총괄 자기 글도 밝혀야 한다(빼면 전체로 새지 않게 거절)
    const leadMiss = await t.orch.handleAgentTool(t.lead, "post", { kind: "진행", title: "A 맡겼습니다" });
    expect(leadMiss.isError).toBe(true);
    expect(leadMiss.text).toContain("work_set");
    expect((await t.orch.handleAgentTool(t.lead, "post", { kind: "진행", title: "A 맡겼습니다", task_id: a })).isError).toBeFalsy();
    expect((await t.orch.handleAgentTool(t.lead, "post", { kind: "알림", title: "판 정리", task_id: null })).isError).toBeFalsy();

    // 직원 보고·결재·자료
    expect((await t.orch.handleAgentTool(t.w, "post", { kind: "완료", title: "A 끝", task_id: a })).isError).toBeFalsy();
    expect((await t.orch.handleAgentTool(t.w, "ask", { title: "A 합칠까요?", detail: "합칠지", task_id: a })).isError).toBeFalsy();
    expect((await t.orch.handleAgentTool(t.w, "file", { title: "A 결과", content: "# A", task_id: a })).isError).toBeFalsy();

    const titles = t.taskMessages(a).map((m) => m.title);
    expect(titles).toEqual(expect.arrayContaining(["A 맡겼습니다", "A 끝", "A 합칠까요?"]));
    expect(t.taskMessages(b)).toHaveLength(0);
    expect(t.store.listMessagePage(t.project.id).items.find((m) => m.title === "판 정리")!.taskId ?? null).toBeNull();

    // 일부러 전체 지시는 null 로
    expect((await t.orch.handleAgentTool(t.lead, "team_assign", { member: "w1", text: "전체 일", task_id: null })).isError).toBeFalsy();
    expect(t.store.deliveryTaskId(t.deliveries().at(-1)!.id)).toBeNull();
    await t.orch.shutdown();
  });

  test("대표가 칩에서 보낸 글을 인용하면 그 작업이 증거가 되고, 다른 작업을 넣으면 거절한다. 전체 글은 옮기지 않는다", async () => {
    const t = await team();
    const a = await t.chip("작업A");
    const b = await t.chip("작업B");
    const onB = await t.orch.sendUserMessage(t.project.id, { text: "B 버튼 색을 파랗게 바꿔 줘", taskId: b });
    expect(onB.taskId).toBe(b);
    const whole = await t.orch.sendUserMessage(t.project.id, { text: "전체에서 보낸 다른 부탁이야", taskId: null });

    const quoted = await t.orch.handleAgentTool(t.lead, "team_assign", { member: "w1", text: "B 색 바꾸기", user_quote: "B 버튼 색을 파랗게 바꿔 줘" });
    expect(quoted.isError).toBeFalsy();
    expect(t.store.deliveryTaskId(t.deliveries().at(-1)!.id)).toBe(b);

    const wrong = await t.orch.handleAgentTool(t.lead, "team_assign", { member: "w1", text: "B 색 바꾸기", user_quote: "B 버튼 색을 파랗게 바꿔 줘", task_id: a });
    expect(wrong.isError).toBe(true);
    expect(wrong.text).toContain(b);

    // 전체 글 인용만으로는 작업이 정해지지 않는다(밝혀야 한다)
    const fromWhole = await t.orch.handleAgentTool(t.lead, "team_assign", { member: "w1", text: "다른 부탁", user_quote: "전체에서 보낸 다른 부탁이야" });
    expect(fromWhole.isError).toBe(true);
    // 총괄이 새 칩으로 맡겨도 대표의 원래 전체 글은 전체에 남는다
    const c = await t.chip("작업C");
    expect((await t.orch.handleAgentTool(t.lead, "team_assign", { member: "w1", text: "다른 부탁", user_quote: "전체에서 보낸 다른 부탁이야", task_id: c })).isError).toBeFalsy();
    expect(t.store.getMessage(whole.id)!.taskId ?? null).toBeNull();
    expect(t.store.deliveryTaskId(t.deliveries().at(-1)!.id)).toBe(c);
    await t.orch.shutdown();
  });

  test("결재 닫기의 후속 지시는 그 결재 카드의 작업을 잇는다", async () => {
    const t = await team();
    const a = await t.chip("작업A");
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
