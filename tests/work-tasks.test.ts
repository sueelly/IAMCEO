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
import { liveTasks, visibleTasks, workIdOf } from "../web/src/lib/tasks";

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
    // 직원을 대상으로 고르면 그 직원의 작업만(일 항목 작업은 총괄에게 가는 작업이라 빠진다)
    expect(visibleTasks(liveTasks(tasks, work), "w1").map((x) => x.id)).toEqual(["tk_mine"]);
  });
});
