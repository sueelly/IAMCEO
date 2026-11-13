// 보고 보완 연쇄(2026-11-12 KST 22:24~22:26 총괄 실행 5건이 차례로 보완을 다시 만든 일)와 마감 근거.
// 격리 데이터·가짜 core 실행기로 본다. 실제 직원·대표 화면·운영 DB 에는 아무것도 보내지 않는다.
import { afterEach, expect, test } from "bun:test";
import { Bus } from "../server/bus.ts";
import { loadConfig } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import { Store } from "../server/store.ts";
import type { Backend, Member } from "../shared/types.ts";
import type { Runner, RunnerEvent, RunnerMember, SendResult } from "../server/runner/types.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";
import { defaultTaskId } from "./fixtures/default-task.ts";

class FakeRunner implements Runner {
  readonly kind: Backend = "core";
  sent: { memberId: string; text: string }[] = [];
  busy = new Set<string>();
  callback: (event: RunnerEvent) => void = () => {};
  turns = new Map<string, number>();
  async available() { return { ok: true }; }
  async start(m: RunnerMember) { return { sessionId: m.sessionId ?? `session-${m.id}`, paneId: `pane-${m.id}` }; }
  async send(m: RunnerMember, text: string): Promise<SendResult> {
    this.sent.push({ memberId: m.id, text });
    this.busy.add(m.id);
    return { ok: true, started: false, turn: this.turns.get(m.id) ?? 0 };
  }
  isBusy(id: string) { return this.busy.has(id); }
  async compact(): Promise<SendResult> { return { ok: true }; }
  async setParallel(): Promise<SendResult> { return { ok: true }; }
  async interrupt() {}
  async stop(m: RunnerMember) { this.busy.delete(m.id); }
  async screen() { return ""; }
  on(callback: (event: RunnerEvent) => void) { this.callback = callback; }
  async shutdown() {}
  /** 그 직원의 지금 턴을 오류 없이 끝낸다(post 없이 끝난 턴도 core 에서는 이렇게 온다). */
  end(member: Member) {
    const turn = (this.turns.get(member.id) ?? 0) + 1;
    this.turns.set(member.id, turn);
    this.busy.delete(member.id);
    this.callback({ type: "turn_end", memberId: member.id, terminalId: member.paneId, sessionGeneration: 0, turn, isError: false, finalText: "" });
  }
  to(member: Member) { return this.sent.filter(s => s.memberId === member.id).map(s => s.text); }
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function until(what: string, check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(5);
  if (!check()) throw new Error(`기다리다 끝남: ${what}`);
}

function fixture() {
  const isolated = createIsolatedRuntime();
  const config = loadConfig({ IAMCEO_HOME: isolated.paths.iamceoHome, IAMCEO_PORT: "0", IAMCEO_CORE_SOCKET: isolated.socketPath, IAMCEO_CORE_BIN: isolated.bins.coreBin, IAMCEO_CLAUDE_BIN: isolated.bins.claudeBin, IAMCEO_CODEX_BIN: isolated.bins.codexBin });
  const db = openDb(config.dbPath);
  const store = new Store(db, new Bus());
  store.patchSettings({ maxConcurrentTurns: 3, boardTidyHours: 0 });
  const project = store.createProject({ name: "보완", cwd: isolated.paths.work });
  // 업무를 주제로 하지 않는 시험이라, 규칙을 지키는 직원처럼 모든 글에 같은 시험 업무를 넣는다.
  const taskId = defaultTaskId(store, project.id);
  const runner = new FakeRunner();
  const orchestrators: Orchestrator[] = [];
  function orchestrator() {
    const orch = new Orchestrator({ config, store, runners: new Map([["core", runner]]), timings: { tickMs: 60_000, healthMs: 60_000, turnErrorRetryMs: 1000 } });
    orchestrators.push(orch);
    return orch;
  }
  const orch = orchestrator();
  const lead = store.createMember({ projectId: project.id, handle: "lead", name: "총괄", kind: "conductor", origin: "runner", backend: "core", status: "idle", cwd: isolated.paths.work, paneId: "pane-lead", sessionId: "session-lead" });
  const worker = store.createMember({ projectId: project.id, handle: "w1", name: "철수", kind: "worker", origin: "runner", backend: "core", status: "idle", cwd: isolated.paths.work, paneId: "pane-w1", sessionId: "session-w1" });
  const supplements = (member?: Member) => store.listDeliveries().filter(d => d.text.includes("보고 보완:") && (!member || d.memberId === member.id));
  const pendingRun = (member: Member) => store.listPendingExecutions().find(r => r.memberId === member.id);
  /** 직원 보고 하나로 총괄의 실행을 깨운다. */
  const wakeLeadWithReport = async (title = "구현 완료") => {
    const report = await orch.recordPost(worker, { kind: "완료", title, taskId });
    await until("총괄 실행", () => !!pendingRun(lead) && runner.to(lead).some(t => t.includes(report.id)));
    return { report, run: pendingRun(lead)! };
  };
  cleanups.push(async () => { for (const current of orchestrators) await current.shutdown(); db.close(); await isolated.stop(); });
  return { isolated, store, project, taskId, runner, orch, orchestrator, lead, worker, supplements, pendingRun, wakeLeadWithReport };
}

test("재현 조건: 보고 보완과 조용한 안내가 한 실행에 섞여도 보완을 다시 만들지 않는다", async () => {
  const f = fixture();
  const { run: first } = await f.wakeLeadWithReport();
  await f.orch.recordPost(f.lead, { taskId: f.taskId, kind: "알림", title: "판에 적었습니다" });
  // 실행 중에 쌓인 조용한 안내(대표가 직원에게 직접 지시했다는 사실 등)는 다음 깨움에 묶여 간다.
  f.store.enqueue({ projectId: f.project.id, memberId: f.lead.id, kind: "system", text: "[시스템] 대표가 철수에게 직접 지시했습니다", wake: false });
  f.runner.end(f.lead);
  await until("첫 보완", () => f.supplements(f.lead).length === 1);
  const second = await (async () => { await until("보완 실행", () => !!f.pendingRun(f.lead) && f.pendingRun(f.lead)!.runId !== first.runId); return f.pendingRun(f.lead)!; })();
  // 보완 실행은 보완과 조용한 안내를 함께 받았다(옛 판정은 '모두 보완'이 아니어서 여기서 보완을 또 만들었다).
  expect(second.deliveryIds.map(id => f.store.getDelivery(id)!.wake).sort()).toEqual([false, true]);
  await f.orch.recordPost(f.lead, { taskId: f.taskId, kind: "알림", title: "위임 결과를 기다립니다" });
  f.runner.end(f.lead);
  await Bun.sleep(30);
  expect(f.supplements(f.lead)).toHaveLength(1);
  expect(f.runner.to(f.lead)).toHaveLength(2);
  // 보완 뒤에도 마감 근거가 없으므로 원래 실행을 '보고 미확인'으로 한 번 남기고, 다시 깨우지 않는다.
  expect(f.store.getReportFollowup(first.runId)).toMatchObject({ settledKind: "unconfirmed", settledRef: second.runId });
  expect(f.store.listActivity(f.lead.id).filter(a => a.text.includes("보고 미확인"))).toHaveLength(1);
});

test("보완 실행에 실제 새 지시가 함께 오면 그 지시의 보고 의무는 남는다(원인은 새 실행)", async () => {
  const f = fixture();
  await f.orch.assign(f.project.id, f.worker.handle, { taskId: f.taskId, text: "첫 일" });
  await until("첫 실행", () => !!f.pendingRun(f.worker));
  const first = f.pendingRun(f.worker)!;
  f.store.enqueue({ projectId: f.project.id, memberId: f.worker.id, kind: "instruction", text: "[총괄] 철수에게\n할 일: 두 번째 일" });
  f.runner.end(f.worker);
  await until("보완 실행", () => !!f.pendingRun(f.worker) && f.pendingRun(f.worker)!.runId !== first.runId);
  const second = f.pendingRun(f.worker)!;
  expect(second.deliveryIds.map(id => f.store.getDelivery(id)!.kind).sort()).toEqual(["instruction", "system"]);
  f.runner.end(f.worker);
  await until("새 지시의 보완", () => f.supplements(f.worker).length === 2);
  expect(f.store.getReportFollowup(second.runId)?.deliveryId).toBe(f.supplements(f.worker)[1]!.id);
  expect(f.store.getReportFollowup(first.runId)?.settledKind).toBe("unconfirmed");
  // 직원의 보고 미확인은 총괄에게 조용히 한 번 알린다(총괄을 깨우지 않는다).
  const notices = f.store.listDeliveries().filter(d => d.memberId === f.lead.id && d.text.includes("보고 미확인"));
  expect(notices).toHaveLength(1);
  expect(notices[0]!.wake).toBe(false);
  // 두 번째 보완 실행이 완료를 올리면 두 원인 모두 더 깨우지 않는다.
  await until("두 번째 보완 실행", () => !!f.pendingRun(f.worker) && f.pendingRun(f.worker)!.runId !== second.runId);
  await f.orch.recordPost(f.worker, { taskId: f.taskId, kind: "완료", title: "두 일 모두 끝" });
  f.runner.end(f.worker);
  await Bun.sleep(30);
  expect(f.supplements(f.worker)).toHaveLength(2);
  expect(f.store.getReportFollowup(second.runId)?.settledKind).toBe("closed");
});

test("원보고를 밝힌 알림은 그 보고 확인을 마감한다. 다른 보고를 밝히거나 진행이면 마감하지 않는다", async () => {
  for (const variant of ["about", "other", "progress", "none"] as const) {
    const f = fixture();
    const earlier = await f.orch.recordPost(f.worker, { taskId: f.taskId, kind: "알림", title: "예전 보고" });
    const { report } = await f.wakeLeadWithReport();
    if (variant === "about") await f.orch.recordPost(f.lead, { taskId: f.taskId, kind: "알림", title: "판에 적었습니다", aboutReportId: report.id });
    if (variant === "other") await f.orch.recordPost(f.lead, { taskId: f.taskId, kind: "알림", title: "판에 적었습니다", aboutReportId: earlier.id });
    if (variant === "progress") await f.orch.recordPost(f.lead, { taskId: f.taskId, kind: "진행", title: "확인하는 중", aboutReportId: report.id });
    if (variant === "none") await f.orch.recordPost(f.lead, { taskId: f.taskId, kind: "알림", title: "판에 적었습니다" });
    f.runner.end(f.lead);
    await Bun.sleep(30);
    expect([variant, f.supplements(f.lead).length]).toEqual([variant, variant === "about" ? 0 : 1]);
    if (variant !== "about") expect(f.supplements(f.lead)[0]!.text).toContain(`about_report_id(#${report.id})`);
  }
});

test("about_report_id 는 이 프로젝트 다른 직원 보고만 받는다", async () => {
  const f = fixture();
  f.store.patchProject(f.project.id, { runnerEnabled: false });
  const own = await f.orch.recordPost(f.lead, { taskId: f.taskId, kind: "알림", title: "내 글" });
  const owner = f.store.createMessage({ projectId: f.project.id, mine: true, kind: "나", body: "대표 글" });
  for (const id of [own.id, owner.id, "msg_none"]) {
    await expect(f.orch.recordPost(f.lead, { taskId: f.taskId, kind: "알림", title: "확인", aboutReportId: id })).rejects.toThrow("about_report_id");
  }
  const tool = await f.orch.handleAgentTool(f.lead, "post", { task_id: f.taskId, kind: "알림", title: "확인", about_report_id: own.id });
  expect(tool.isError).toBe(true);
  const report = await f.orch.recordPost(f.worker, { taskId: f.taskId, kind: "완료", title: "직원 보고" });
  const ok = await f.orch.handleAgentTool(f.lead, "post", { task_id: f.taskId, kind: "알림", title: "확인", about_report_id: report.id });
  expect(ok.isError).toBeUndefined();
  const confirmation = f.store.getMessage(/#(msg_[A-Za-z0-9_]+)/.exec(ok.text)![1]!)!;
  expect(confirmation.aboutMessageId).toBe(report.id);
  // 원보고를 조회하면 확인 글이 함께 온다(원보고와 총괄 확인을 한 결과로 읽는다).
  const lookup = JSON.parse((await f.orch.handleAgentTool(f.lead, "post", { report_id: report.id })).text);
  expect(lookup.confirmations).toEqual([{ id: confirmation.id, who: f.lead.name, kind: "알림", title: "확인", at: confirmation.at }]);
});

test("기다리는 자기 결재를 밝힌 알림은 마감하고, 남의 결재나 닫힌 결재는 마감하지 않는다", async () => {
  for (const variant of ["own-open", "other", "closed"] as const) {
    const f = fixture();
    const owner = variant === "other" ? f.worker : f.lead;
    const decision = f.store.createDecision({ projectId: f.project.id, taskId: f.taskId, memberId: owner.id, who: owner.name, title: "합칠까요" });
    if (variant === "closed") f.store.closeDecision(decision.id, { kind: "obsolete", reason: "필요 없어짐", by: f.lead.name, quote: null });
    await f.orch.sendUserMessage(f.project.id, { text: "합치는 일은 어떻게 됐나요" });
    await until("총괄 실행", () => !!f.pendingRun(f.lead));
    await f.orch.recordPost(f.lead, { taskId: f.taskId, kind: "알림", title: "대표님 결재를 기다립니다", decisionId: decision.id });
    f.runner.end(f.lead);
    await Bun.sleep(30);
    expect([variant, f.supplements(f.lead).length]).toEqual([variant, variant === "own-open" ? 0 : 1]);
  }
});

test("실행이 끝날 때 결과가 안 돌아온 보고 도구가 있으면 그 결과를 본 뒤 판정한다", async () => {
  for (const kind of ["완료", "진행"] as const) {
    const f = fixture();
    await f.orch.assign(f.project.id, f.worker.handle, { taskId: f.taskId, text: "일" });
    await until("실행", () => !!f.pendingRun(f.worker));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = f.orch.recordPost.bind(f.orch);
    (f.orch as unknown as { recordPost: typeof original }).recordPost = async (member, input) => { await gate; return original(member, input); };
    const pending = f.orch.handleAgentTool(f.worker, "post", { task_id: f.taskId, kind, title: "늦게 도착한 보고" });
    f.runner.end(f.worker);
    await Bun.sleep(30);
    expect(f.supplements(f.worker)).toHaveLength(0);
    release();
    expect((await pending).isError).toBeUndefined();
    await Bun.sleep(30);
    expect([kind, f.supplements(f.worker).length]).toEqual([kind, kind === "완료" ? 0 : 1]);
  }
});

test("재시작해도 같은 원인 실행의 보완·보고 미확인은 한 번이다", async () => {
  const f = fixture();
  await f.orch.assign(f.project.id, f.worker.handle, { taskId: f.taskId, text: "일" });
  await until("실행", () => !!f.pendingRun(f.worker));
  const first = f.pendingRun(f.worker)!;
  f.runner.end(f.worker);
  await until("보완", () => f.supplements(f.worker).length === 1);
  await until("보완 실행", () => !!f.pendingRun(f.worker) && f.pendingRun(f.worker)!.runId !== first.runId);
  await f.orch.shutdown();
  const next = f.orchestrator();
  await next.recover();
  f.runner.end(f.worker);
  await Bun.sleep(40);
  await next.recover();
  await Bun.sleep(20);
  expect(f.supplements(f.worker)).toHaveLength(1);
  expect(f.store.getReportFollowup(first.runId)?.settledKind).toBe("unconfirmed");
  expect(f.store.listActivity(f.worker.id).filter(a => a.text.includes("보고 미확인"))).toHaveLength(1);
  expect(f.store.listDeliveries().filter(d => d.memberId === f.lead.id && d.text.includes("보고 미확인"))).toHaveLength(1);
});

test("질문·위임은 마감 근거로 남고, 결재가 바로 닫혀도 보완을 만들지 않는다", async () => {
  const f = fixture();
  await f.orch.sendUserMessage(f.project.id, { text: "정해 주세요" });
  await until("총괄 실행", () => !!f.pendingRun(f.lead));
  const ask = await f.orch.registerAsk(f.lead, { taskId: f.taskId, title: "A안으로 할까요", options: [{ k: "a", label: "A안" }, { k: "b", label: "B안" }] });
  f.store.closeDecision(ask.decision.id, { kind: "obsolete", reason: "스스로 풀었음", by: f.lead.name, quote: null });
  f.runner.end(f.lead);
  await Bun.sleep(30);
  expect(f.supplements(f.lead)).toHaveLength(0);
  expect(f.store.listReportClosures(f.lead.id, "").map(c => c.kind)).toContain("question");
});
