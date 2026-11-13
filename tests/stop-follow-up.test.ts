// 멈춤과 '멈추고 이어서 지시'(2026-11-11 대표 요청 "동작중인걸 멈추거나 이어서 명령하는 게 안되는데").
// 재현: 일하는 중인 직원에게 보낸 후속 지시는 턴이 끝날 때까지 기다렸고(실제 6분), 멈춘 턴은 '성공'으로 기록돼
// 멈춘 직원에게 '보고 보완'을 다시 시켰다. 이 시험은 실제 Orchestrator·Store 와 가짜 core 실행기로 본다(실제 CLI 의 멈춤 키 반응은 아니다).
import { afterAll, describe, expect, test } from "bun:test";
import { Bus } from "../server/bus.ts";
import { loadConfig, updateConfigFile } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { startServer } from "../server/http.ts";
import { handleAgentTool } from "../server/agent-tools.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import type { Backend, StopResult } from "../shared/types.ts";
import type { Runner, RunnerEvent, RunnerMember, SendResult } from "../server/runner/types.ts";
import { Store } from "../server/store.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";
import { withDefaultTask } from "./fixtures/default-task.ts";

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });
async function until(what: string, condition: () => boolean) {
  for (let i = 0; i < 400; i++) { if (condition()) return; await Bun.sleep(5); }
  throw new Error(`기다리다 끝남: ${what}`);
}

/** 멈춤 키 결과를 고를 수 있는 가짜 core. 실제 CLI 는 띄우지 않는다. */
class FakeCore implements Runner {
  readonly kind = "core" as const;
  callback: (e: RunnerEvent) => void = () => {};
  sent: { memberId: string; text: string }[] = [];
  busy = new Set<string>();
  interrupts = 0;
  interruptGate: Promise<void> | null = null;
  interruptError: Error | null = null;
  async available() { return { ok: true }; }
  async start(): Promise<never> { throw new Error("이 시험은 CLI 를 띄우지 않는다"); }
  async send(m: RunnerMember, text: string): Promise<SendResult> { this.sent.push({ memberId: m.id, text }); this.busy.add(m.id); return { ok: true }; }
  async compact(): Promise<SendResult> { return { ok: true }; }
  isBusy(id: string) { return this.busy.has(id); }
  async setParallel(): Promise<SendResult> { return { ok: true }; }
  async interrupt() {
    this.interrupts++;
    if (this.interruptGate) await this.interruptGate;
    if (this.interruptError) throw this.interruptError;
  }
  async stop() {}
  async screen() { return ""; }
  on(callback: (e: RunnerEvent) => void) { this.callback = callback; }
  async shutdown() {}
}

function fixture() {
  const runtime = createIsolatedRuntime();
  const env = runtime.childEnv();
  updateConfigFile({ accessCode: "test-code", hosts: ["127.0.0.1"], claudeBin: runtime.bins.claudeBin }, env);
  const config = loadConfig(env);
  const bus = new Bus();
  const db = openDb(config.dbPath), store = new Store(db, bus);
  const fake = new FakeCore();
  const orch = new Orchestrator({ config, store, runners: new Map<Backend, Runner>([["core", fake]]), providerHomes: runtime.providerHomes,
    timings: { tickMs: 60_000, healthMs: 60_000, retryMs: 5 } });
  const project = store.createProject({ name: "멈춤", cwd: runtime.paths.work, runnerEnabled: true });
  const lead = store.createMember({ projectId: project.id, handle: "lead", name: "총괄", kind: "conductor", origin: "runner", backend: "core", status: "idle", paneId: "t-lead", sessionId: "s-lead" });
  const member = store.createMember({ projectId: project.id, handle: "w1", name: "철수", kind: "worker", origin: "runner", backend: "core", status: "idle", paneId: "t-w1", sessionId: "s-w1" });
  for (const m of [lead, member]) store.ensureContextState(m.id);
  const emit = async (e: RunnerEvent) => { fake.callback(e); await Bun.sleep(3); };
  const gen = (id = member.id) => store.memberRevisions(id).sessionGeneration;
  /** 일을 맡기고 그 턴이 '일하는 중'이 되게 한다. */
  const startWork = async (text: string, id = member.id) => {
    store.enqueue({ projectId: project.id, memberId: id, kind: "instruction", text });
    await orch.pump(id);
    await until("첫 전달", () => fake.sent.some(s => s.memberId === id && s.text.includes(text)));
    await emit({ type: "status", memberId: id, status: "working", observation: { source: "core", observedAt: new Date().toISOString(), freshness: "fresh", ownership: "verified", consecutiveFailures: 0, error: null } });
    await until("일하는 중", () => store.requireMember(id).status === "working");
    return store.requireMember(id).executionState!;
  };
  /** CLI 턴이 끝났다는 core 관찰(멈춘 턴도 core 에서는 오류 없는 turn_end 로 온다). */
  const endTurn = async (turn = 1, id = member.id) => {
    fake.busy.delete(id);
    await emit({ type: "turn_end", memberId: id, terminalId: store.requireMember(id).paneId, turn, finalText: "", isError: false });
    await emit({ type: "status", memberId: id, status: "idle", observation: { source: "core", observedAt: new Date().toISOString(), freshness: "fresh", ownership: "verified", consecutiveFailures: 0, error: null } });
  };
  const deliveries = (id = member.id) => store.listDeliveries(project.id).filter(d => d.memberId === id);
  const sentTo = (id = member.id) => fake.sent.filter(s => s.memberId === id).map(s => s.text);
  cleanups.push(async () => { await orch.shutdown(); db.close(); await runtime.stop(); });
  return { runtime, config, bus, store, fake, orch, project, lead, member, emit, gen, startWork, endTurn, deliveries, sentTo };
}

describe("재현: 멈춘 턴을 성공으로 치고 보고 보완을 다시 시켰다", () => {
  test("멈추지 않고 보고 없이 끝난 턴은 지금처럼 보고 보완을 요청한다(대조군)", async () => {
    const f = fixture();
    await f.startWork("긴 일");
    await f.endTurn();
    await until("보고 보완 요청", () => f.deliveries().some(d => d.text.includes("보고 보완")));
  });

  test("대표가 멈춘 턴은 '중단'으로 남고 보고 보완을 요청하지 않으며, 총괄을 깨우지 않는다", async () => {
    const f = fixture();
    const run = await f.startWork("긴 일");
    const r = await f.orch.stopMember(f.member.id, { by: "user", expectRunId: run.runId, expectGeneration: f.gen() });
    expect(r).toMatchObject({ outcome: "stopped", runId: run.runId, memberName: "철수" });
    expect(f.fake.interrupts).toBe(1);
    await f.endTurn();
    await until("멈춘 뒤 쉼", () => f.store.requireMember(f.member.id).status === "idle");
    expect(f.store.getExecutionJournal(run.runId)).toMatchObject({ phase: "interrupted", result: "interrupted", reason: "대표가 멈췄습니다" });
    await Bun.sleep(30);
    expect(f.deliveries().some(d => d.text.includes("보고 보완"))).toBe(false);
    const notice = f.deliveries(f.lead.id).find(d => d.text.includes("직접 멈췄습니다"));
    expect(notice).toMatchObject({ wake: false });
    expect(f.store.listMessages(f.project.id).some(m => m.kind === "시스템" && m.body.includes(`실행 ${run.runId} 중단 — 대표가 멈췄습니다`))).toBe(true);
    // 끊긴 일은 다시 보내지 않는다.
    expect(f.sentTo().filter(t => t.includes("긴 일"))).toHaveLength(1);
  });
});

describe("멈추고 이어서 지시", () => {
  test("글을 먼저 대기열에 고정하고, 멈춤이 확인되고 입력이 가능해진 뒤 한 번만 보낸다", async () => {
    const f = fixture();
    const run = await f.startWork("긴 일");
    const message = await f.orch.sendUserMessage(f.project.id, { id: "msg-follow-1", text: "멈추고 이걸로 이어서 해", targetMemberId: f.member.id });
    // 보낸 순간 받는 사람·원문이 고정되고, 일하는 중이라 아직 나가지 않는다.
    const queued = f.deliveries().find(d => d.refId === message.id)!;
    expect(queued).toMatchObject({ status: "queued", kind: "user_message" });
    expect(f.sentTo().some(t => t.includes("이걸로 이어서"))).toBe(false);
    const r = await f.orch.stopMember(f.member.id, { by: "user", expectRunId: run.runId, expectGeneration: f.gen() });
    expect(r.outcome).toBe("stopped");
    // CLI 가 멈췄다고 해도 턴이 끝났다는 관찰 전에는 보내지 않는다.
    await Bun.sleep(20);
    expect(f.sentTo().some(t => t.includes("이걸로 이어서"))).toBe(false);
    await f.endTurn();
    await until("이어서 지시 전달", () => f.sentTo().some(t => t.includes("이걸로 이어서")));
    await Bun.sleep(30);
    expect(f.sentTo().filter(t => t.includes("이걸로 이어서"))).toHaveLength(1);
    expect(f.sentTo().some(t => t.includes("보고 보완"))).toBe(false);
    expect(f.store.requireDelivery(queued.id).status).toBe("delivered");
  });

  test("겹쳐 누른 멈춤은 키를 한 번만 보내고, 확인 뒤 다시 눌러도 다시 보내지 않는다", async () => {
    const f = fixture();
    const run = await f.startWork("긴 일");
    let open!: () => void;
    f.fake.interruptGate = new Promise<void>(resolve => { open = resolve; });
    const a = f.orch.stopMember(f.member.id, { by: "user", expectRunId: run.runId });
    const b = f.orch.stopMember(f.member.id, { by: "user", expectRunId: run.runId });
    open();
    const [ra, rb] = await Promise.all([a, b]);
    expect([ra.outcome, rb.outcome]).toEqual(["stopped", "stopped"]);
    expect(f.fake.interrupts).toBe(1);
    const again = await f.orch.stopMember(f.member.id, { by: "user", expectRunId: run.runId });
    expect(again).toMatchObject({ outcome: "stopped", detail: "이미 멈췄습니다" });
    expect(f.fake.interrupts).toBe(1);
    await f.endTurn();
    await until("쉼", () => f.store.requireMember(f.member.id).status === "idle");
    const late = await f.orch.stopMember(f.member.id, { by: "user", expectRunId: run.runId });
    expect(late).toMatchObject({ outcome: "stopped", detail: "이미 멈췄습니다" });
    expect((await f.orch.stopMember(f.member.id, { by: "user" })).outcome).toBe("not_running");
    expect(f.fake.interrupts).toBe(1);
  });

  test("화면에서 본 실행·세대와 지금이 다르면 멈추지 않고 대기열을 그대로 둔다", async () => {
    const f = fixture();
    const first = await f.startWork("첫 일");
    await f.orch.sendUserMessage(f.project.id, { id: "msg-follow-2", text: "다음 지시", targetMemberId: f.member.id });
    expect((await f.orch.stopMember(f.member.id, { by: "user", expectRunId: "other-run" })).outcome).toBe("changed");
    expect((await f.orch.stopMember(f.member.id, { by: "user", expectRunId: first.runId, expectGeneration: f.gen() + 1 })).outcome).toBe("changed");
    expect(f.fake.interrupts).toBe(0);
    expect(f.deliveries().find(d => d.refId === "msg-follow-2")?.status).toBe("queued");
    // 본 턴이 이미 끝나 대기열의 글로 새 턴이 시작됐으면 그 새 턴을 끊지 않는다.
    await f.endTurn();
    await until("다음 지시가 새 턴으로", () => f.sentTo().some(t => t.includes("다음 지시")));
    const stale = await f.orch.stopMember(f.member.id, { by: "user", expectRunId: first.runId });
    expect(stale.outcome).toBe("not_running");
    expect(f.fake.interrupts).toBe(0);
  });

  test("멈추지 못하면 실패로 알리고, 턴은 계속되며 대기열의 글은 그 턴이 끝난 뒤 한 번 나간다", async () => {
    const f = fixture();
    const run = await f.startWork("긴 일");
    await f.orch.sendUserMessage(f.project.id, { id: "msg-follow-3", text: "실패해도 남는 지시", targetMemberId: f.member.id });
    f.fake.interruptError = new Error("CLI interrupt outcome: not_stopped");
    const r = await f.orch.stopMember(f.member.id, { by: "user", expectRunId: run.runId });
    expect(r.outcome).toBe("failed");
    expect(r.detail).toContain("not_stopped");
    expect(f.store.requireMember(f.member.id).status).toBe("working");
    await f.endTurn();
    await until("턴이 끝난 뒤 전달", () => f.sentTo().some(t => t.includes("실패해도 남는 지시")));
    expect(f.store.getExecutionJournal(run.runId)).toMatchObject({ phase: "ended" });
    expect(f.sentTo().filter(t => t.includes("실패해도 남는 지시"))).toHaveLength(1);
  });

  test("일하지 않는 직원은 멈춤 키를 보내지 않는다", async () => {
    const f = fixture();
    expect((await f.orch.stopMember(f.member.id, { by: "user" })).outcome).toBe("not_running");
    expect(f.fake.interrupts).toBe(0);
  });
});

describe("총괄 도구와 화면이 같은 경로", () => {
  test("team_stop(then): 지시를 먼저 대기열에 넣고 멈추며, 총괄 자신에게 중단 알림을 다시 보내지 않는다", async () => {
    const f = fixture();
    const run = await f.startWork("잘못 맡긴 일");
    const lead = f.store.requireMember(f.lead.id);
    const out = await handleAgentTool(f.orch, lead, "team_stop", withDefaultTask(f.store, lead, "team_stop", { member: "w1", expect_run_id: run.runId, then: "방향을 바꿔 이렇게 해" }));
    expect(out.isError).toBeFalsy();
    expect(out.text).toContain(`실행 ${run.runId}을 멈췄습니다`);
    expect(f.fake.interrupts).toBe(1);
    await f.endTurn();
    await until("then 전달", () => f.sentTo().some(t => t.includes("방향을 바꿔")));
    expect(f.store.getExecutionJournal(run.runId)).toMatchObject({ result: "interrupted", reason: "총괄이 멈췄습니다" });
    await Bun.sleep(30);
    expect(f.deliveries(f.lead.id).some(d => d.text.includes("중단되었습니다") || d.text.includes("직접 멈췄습니다"))).toBe(false);
    expect(f.sentTo().filter(t => t.includes("방향을 바꿔"))).toHaveLength(1);
  });

  test("HTTP /api/members/:id/stop 은 같은 결과를 돌려주고, 예전 /interrupt 는 실패를 409 로 알린다", async () => {
    const f = fixture();
    const server = await startServer({ config: f.config, store: f.store, bus: f.bus, orch: f.orch });
    cleanups.push(() => server.stop());
    const call = (path: string, body?: unknown) => fetch(`${server.urls[0]}${path}`, { method: "POST", headers: { Authorization: `Bearer ${f.config.accessCode}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const idle = await call(`/api/members/${f.member.id}/stop`, {});
    expect(idle.status).toBe(200);
    expect(((await idle.json()) as StopResult).outcome).toBe("not_running");
    const run = await f.startWork("긴 일");
    const res = await call(`/api/members/${f.member.id}/stop`, { expectRunId: run.runId, expectGeneration: f.gen() });
    const body = (await res.json()) as StopResult;
    expect(body).toMatchObject({ outcome: "stopped", runId: run.runId, memberId: f.member.id });
    expect(body.member.id).toBe(f.member.id);
    expect((await call(`/api/members/${f.member.id}/stop`, { unknown: 1 })).status).toBe(400);
    await f.endTurn();
    await until("쉼", () => f.store.requireMember(f.member.id).status === "idle");
    await f.startWork("또 긴 일");
    f.fake.interruptError = new Error("CLI interrupt outcome: not_stopped");
    expect((await call(`/api/members/${f.member.id}/interrupt`)).status).toBe(409);
  });
});

describe("실행의 작업 표시", () => {
  test("멈출 실행이 받은 작업들을 보인다(한 턴이 여러 작업을 받을 수 있다)", async () => {
    const f = fixture();
    const a = f.store.saveTask({ projectId: f.project.id, memberId: f.member.id, who: "철수", title: "작업 A", branch: "feat/a" }).task;
    const b = f.store.saveTask({ projectId: f.project.id, memberId: f.member.id, who: "철수", title: "작업 B", branch: "feat/b" }).task;
    f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, kind: "instruction", text: "A 일", taskId: a.id });
    f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, kind: "instruction", text: "B 일", taskId: b.id });
    await f.orch.pump(f.member.id);
    await until("묶음 전달", () => f.sentTo().length === 1);
    const exec = f.store.requireMember(f.member.id).executionState!;
    expect([...exec.taskIds!].sort()).toEqual([a.id, b.id].sort());
    expect(f.orch.roster(f.project.id).find(r => r.handle === "w1")?.run).toMatchObject({ id: exec.runId, taskIds: expect.arrayContaining([a.id, b.id]) });
  });
});
