import { afterEach, expect, test } from "bun:test";
import { Bus } from "../server/bus.ts";
import { loadConfig } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import { renderRole } from "../server/roles.ts";
import { Store } from "../server/store.ts";
import { CoreError } from "../server/runner/core-client.ts";
import type { Member } from "../shared/types.ts";
import type { Runner, RunnerEvent, RunnerMember, SendResult } from "../server/runner/types.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";
import { defaultTaskId, withDefaultTask } from "./fixtures/default-task.ts";

// All execution is in-memory; no HTTP listener, core or herdr connection.
class AckRunner implements Runner {
  readonly kind = "core" as const;
  busy = new Set<string>();
  failStart = false;
  callback: (e: RunnerEvent) => void = () => {};
  async available() { return { ok: true }; }
  async start(m: RunnerMember) {
    if (this.failStart) throw new CoreError("rejected", "fixture: start rejected");
    return { sessionId: `session-${m.id}`, paneId: `pane-${m.id}` }; }
  async send(m: RunnerMember): Promise<SendResult> { this.busy.add(m.id); return { ok: true, started: true, turn: 0 }; }
  isBusy(id: string) { return this.busy.has(id); }
  async compact(): Promise<SendResult> { return { ok: true }; }
  async setParallel(): Promise<SendResult> { return { ok: true }; }
  async interrupt() {}
  async stop(m: RunnerMember) { this.busy.delete(m.id); }
  async screen() { return ""; }
  async shutdown() {}
  on(callback: (e: RunnerEvent) => void) { this.callback = callback; }
  end(m: Member, turn = 1, finalText = "") {
    this.busy.delete(m.id);
    this.callback({ type: "turn_end", memberId: m.id, terminalId: m.paneId, sessionGeneration: 0, turn, finalText, isError: false });
  }
}
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(5);
  expect(check()).toBe(true);
}
function fixture(kind: "conductor" | "root" = "conductor") {
  const isolated = createIsolatedRuntime();
  const config = loadConfig({ IAMCEO_HOME: isolated.paths.iamceoHome, IAMCEO_PORT: "0", IAMCEO_CORE_SOCKET: isolated.socketPath,
    IAMCEO_CORE_BIN: isolated.bins.coreBin, IAMCEO_CLAUDE_BIN: isolated.bins.claudeBin, IAMCEO_CODEX_BIN: isolated.bins.codexBin });
  let db = openDb(config.dbPath);
  let store = new Store(db, new Bus());
  store.patchSettings({ maxConcurrentTurns: 8, boardTidyHours: 0 });
  const project = store.createProject({ name: "배정 확인", cwd: isolated.paths.work });
  const lead = store.createMember({ projectId: project.id, handle: "lead", name: "업무 총괄", kind, origin: "runner", backend: "core", status: "idle", cwd: project.cwd, paneId: "lead-pane", sessionId: "lead-session" });
  const runner = new AckRunner();
  const makeOrch = () => new Orchestrator({ config, store, runners: new Map([["core", runner]]), timings: { tickMs: 60_000, healthMs: 60_000 } });
  let orch = makeOrch();
  const taskId = defaultTaskId(store, project.id);
  orch.saveTask(lead, { taskId, contract: { kind: "other", goal: "결제 오류의 재현 결과와 수정 필요 여부를 보고한다",
    inputs: ["대표의 결제 오류 검토 요청", "격리 실행기에서 얻은 결제 오류와 재현 결과"],
    outputs: ["확인한 오류·재현 결과·수정 필요 여부를 구분한 결제 검토 보고"],
    scope: "대표가 요청한 결제 오류를 검토하고 그 결과에 따른 직원 배정과 후속 지시를 기록한다",
    constraints: [], exclusions: [],
    acceptance: ["결제 요청에서 확인한 오류와 재현 결과를 구분해 보고한다"], checks: ["real"] } });
  const reviewChecks = [{ name: "결제 오류 재현", kind: "real" as const, result: "pass" as const, evidence: "격리 실행기에서 결제 요청의 오류와 재현 결과를 확인", criterion: 1 }];
  let seq = 0;
  const notices = () => store.listMessages(project.id, { limit: 500 }).filter(m => m.id.startsWith("msg_delegation_ack_"));
  const member = () => store.createMember({ projectId: project.id, handle: `w${++seq}`, name: `검토 ${seq}`, kind: "worker", origin: "runner", backend: "core", status: "idle", cwd: project.cwd, paneId: `pane-${seq}`, sessionId: `session-${seq}` });
  const tool = async (name: string, args: Record<string, unknown>) => {
    const result = await orch.handleAgentTool(store.requireMember(lead.id), name, withDefaultTask(store, lead, name, args));
    expect(result.isError, result.text).not.toBe(true);
    return result;
  };
  const start = () => orch.sendUserMessage(project.id, { taskId, text: "결제 오류를 검토해 주세요", id: "owner-command" });
  const end = async (turn = 1, finalText = "") => {
    runner.end(store.requireMember(lead.id), turn, finalText);
    await until(() => store.listActivity(lead.id).filter(a => a.kind === "turn_end").length >= turn);
  };
  const restart = async () => {
    await orch.shutdown(); db.close();
    db = openDb(config.dbPath); store = new Store(db, new Bus());
    orch = makeOrch(); await orch.recover();
  };
  cleanups.push(async () => { await orch.shutdown(); db.close(); await isolated.stop(); });
  return { get orch() { return orch; }, get store() { return store; }, project, lead, runner, member, tool, start, end, restart, notices, taskId, reviewChecks };
}

for (const kind of ["conductor", "root"] as const) {
  test(`${kind}: 위임과 재시작은 실행 근거만 남긴다`, async () => {
    const f = fixture(kind), worker = f.member();
    await f.start();
    await f.orch.assign(f.project.id, worker.handle, { taskId: f.taskId, text: "결제 검토" }, f.lead);
    const progress = await f.tool("post", { kind: "진행", title: "검토를 맡겼습니다" });
    expect(progress.text).not.toContain("보고했습니다");
    expect(f.store.listMessages(f.project.id).filter(m => m.kind === "진행")).toHaveLength(0);
    await f.end();
    expect(f.notices()).toHaveLength(0);
    expect(f.store.listReportClosures(f.lead.id, "").some(c => c.kind === "delegated")).toBe(true);
    await f.restart();
    expect(f.notices()).toHaveLength(0);
  });
}

test("배정만 한 실행이 마지막에 남긴 접수 문장은 자동 게시되지 않는다", async () => {
  const f = fixture(), worker = f.member();
  await f.start();
  await f.tool("team_assign", { member: worker.handle, text: "영수증 확인" });
  await f.end(1, "영수증 확인을 맡겼습니다");
  expect(f.store.listMessages(f.project.id).some(m => m.body === "영수증 확인을 맡겼습니다")).toBe(false);
  expect(f.store.listDeliveries().some(d => d.kind === "report")).toBe(false);
});

test("직원 보고로 깨어난 턴에 다음 직원에게 맡기면 시스템 줄을 남기지 않는다", async () => {
  const f = fixture(); const w = f.member(), next = f.member();
  await f.orch.recordPost(w, { kind: "완료", title: "검토 완료", taskId: f.taskId, contractRev: 1, checks: f.reviewChecks });
  await until(() => f.runner.busy.has(f.lead.id));
  await f.tool("team_assign", { member: next.handle, text: "확인된 오류 수정" });
  await f.end(); expect(f.notices()).toHaveLength(0);
});

test("보고 턴에 묶여 온 wake=false 대표 답은 대표가 깨운 턴으로 세지 않는다", async () => {
  const f = fixture(); const w = f.member(), next = f.member();
  const decision = f.store.createDecision({ projectId: f.project.id, memberId: f.lead.id, who: f.lead.name, title: "검토" });
  f.store.answerDecision(decision.id, { note: "진행" });
  f.store.enqueue({ projectId: f.project.id, memberId: f.lead.id, kind: "answer", text: '[대표 답(원문) \'검토\'] "진행"', wake: false, refType: "decision", refId: decision.id });
  await f.orch.recordPost(w, { kind: "완료", title: "검토 완료", taskId: f.taskId, contractRev: 1, checks: f.reviewChecks });
  await until(() => f.runner.busy.has(f.lead.id));
  await f.tool("team_assign", { member: next.handle, text: "다음 검토" });
  await f.end(); expect(f.notices()).toHaveLength(0);
});

test("질문을 올리고 배정한 턴에는 결재 카드만 남는다", async () => {
  const f = fixture(), worker = f.member();
  await f.start();
  await f.tool("team_assign", { member: worker.handle, text: "결제 검토" });
  await f.tool("ask", { title: "검토 범위", detail: "추가 범위를 선택해 주세요" });
  await f.end();
  expect(f.notices()).toHaveLength(0);
  expect(f.store.listOpenDecisionsByMember(f.lead.id)).toHaveLength(1);
});

test("지시 없는 team_add·team_resume와 실패한 배정은 확인 안내를 만들지 않는다", async () => {
  const f = fixture(); const w = f.member();
  f.store.patchMember(w.id, { status: "asleep" });
  await f.start(); await f.tool("team_add", { name: "결제 구현", role: "결제" });
  await f.tool("team_resume", { member: w.handle });
  const failed = await f.orch.handleAgentTool(f.lead, "team_assign", { member: "없는 직원", text: "일" });
  expect(failed.isError).toBe(true);
  await f.end(); expect(f.notices()).toHaveLength(0);
});

test("신규 직원 기동 실패로 취소된 첫 지시는 배정으로 알리지 않는다", async () => {
  const f = fixture(); await f.start(); f.runner.failStart = true;
  const result = await f.orch.handleAgentTool(f.lead, "team_add", { name: "결제 구현", role: "결제", task_id: f.taskId, first_instruction: "새 결제 구현" });
  expect(result.isError).toBe(true);
  expect(result.text).toContain("fixture: start rejected");
  await f.end(); expect(f.notices()).toHaveLength(0);
});

test("대표 결재 답 턴의 ask_close follow_up도 배정 안내를 생략한다", async () => {
  const f = fixture(); const w = f.member();
  const pending = await f.orch.registerAsk(f.lead, { title: "결제 검토", detail: "어떻게 할까요", taskId: defaultTaskId(f.store, f.project.id) });
  await f.orch.answerDecision(pending.decision.id, { note: "검토를 시작하도록 승인합니다" });
  await until(() => f.runner.busy.has(f.lead.id));
  // 대화에서 정해진 별도 카드의 후속 지시를 같은 대표 원문에 연결한다.
  const source = f.store.createMessage({ projectId: f.project.id, taskId: f.taskId, mine: true, who: "대표", kind: "나", body: "결제 오류를 검토해 주세요" });
  const other = f.store.createDecision({ projectId: f.project.id, taskId: f.taskId, memberId: w.id, who: w.name, title: "중복 질문" });
  await f.tool("ask_close", { id: other.id, kind: "decided", reason: "대표가 정함", user_quote: source.body,
    follow_up: { kind: "instruction", member_id: w.id, text: "결제 오류 검토", source_message_id: source.id } });
  await f.end(); expect(f.notices()).toHaveLength(0);
});

test("직원·총괄·본사의 역할은 착수·위임 확인을 요청하지 않는다", () => {
  const vars = { PROJECT: "P", NAME: "N", ROLE: "R", CONDUCTOR: "C" };
  for (const kind of ["worker", "conductor", "root"] as const) {
    const role = renderRole(kind, vars);
    expect(role).not.toContain("알겠다는 확인");
    expect(role).toContain("착수·위임 확인");
  }
});
