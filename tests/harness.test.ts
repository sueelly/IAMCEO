// 공통 하네스: 업무 시작 계약 → 직원 실행 → 필수 검사 → 근거 있는 완료 보고.
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

class FakeRunner implements Runner {
  readonly kind: Backend = "core";
  sent: { memberId: string; text: string }[] = [];
  busy = new Set<string>();
  callback: (event: RunnerEvent) => void = () => {};
  async available() { return { ok: true }; }
  async start(m: RunnerMember) { return { sessionId: m.sessionId ?? `session-${m.id}`, paneId: `pane-${m.id}` }; }
  async send(m: RunnerMember, text: string): Promise<SendResult> { this.sent.push({ memberId: m.id, text }); this.busy.add(m.id); return { ok: true, started: false, turn: 0 }; }
  isBusy(id: string) { return this.busy.has(id); }
  async compact(): Promise<SendResult> { return { ok: true }; }
  async setParallel(): Promise<SendResult> { return { ok: true }; }
  async interrupt() {}
  async stop(m: RunnerMember) { this.busy.delete(m.id); }
  async screen() { return ""; }
  on(callback: (event: RunnerEvent) => void) { this.callback = callback; }
  async shutdown() {}
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
  const project = store.createProject({ name: "하네스", cwd: isolated.paths.work });
  const runner = new FakeRunner();
  const orch = new Orchestrator({ config, store, runners: new Map([["core", runner]]), timings: { tickMs: 60_000, healthMs: 60_000, turnErrorRetryMs: 1000 } });
  const make = (handle: string, name: string, kind: "conductor" | "worker") => store.createMember({ projectId: project.id, handle, name, kind, origin: "runner", backend: "core", status: "idle", cwd: isolated.paths.work, paneId: `pane-${handle}`, sessionId: `session-${handle}` });
  const lead = make("lead", "총괄", "conductor");
  const worker = make("w1", "철수", "worker");
  const worker2 = make("w2", "영희", "worker");
  const tool = async (member: Member, name: string, args: Record<string, unknown>) => orch.handleAgentTool(store.requireMember(member.id), name, args);
  cleanups.push(async () => { await orch.shutdown(); db.close(); await isolated.stop(); });
  return { store, project, runner, orch, lead, worker, worker2, tool };
}

const CODING = {
  kind: "coding",
  goal: "보고 화면에 검사 줄을 보인다",
  acceptance: ["완료 보고 아래에 검사 결과가 한 줄로 보인다", "검사가 없으면 완료가 거절된다"],
  scope: "server/ 안에서만 고친다",
  forbidden: ["깃허브에 올리지 않는다", "임시 폴더를 지우지 않는다"],
  evidence: ["시험 이름과 통과 수"],
};
const pass = (kind: string, criterion?: number, name = kind) => ({ name, kind, result: "pass", evidence: `${name} 12 pass 0 fail`, command: `bun test ${name}`, ...(criterion ? { criterion } : {}) });

test("업무 한 건 전 과정: 계약이 지시에 실리고, 검사 없는·실패한 완료는 거절되며, 통과한 완료는 실행·계약 판과 함께 총괄에게 간다", async () => {
  const f = fixture();
  const task = (await f.tool(f.lead, "task", { title: "검사 줄 보이기" })).text.match(/#(tk_[A-Za-z0-9_-]+)/)![1]!;
  const assigned = await f.tool(f.lead, "team_assign", { member: "w1", text: "검사 줄을 보이게 고쳐 주세요", task_id: task, contract: CODING });
  expect(assigned.isError).toBeUndefined();
  await until("직원 지시", () => f.runner.to(f.worker).some(t => t.includes("업무 계약 r1")));
  const delivered = f.runner.to(f.worker).find(t => t.includes("업무 계약 r1"))!;
  for (const part of ["원하는 결과: 보고 화면에 검사 줄을 보인다", "합격 기준 1: 완료 보고 아래에", "합격 기준 2: 검사가 없으면", "자율 범위: server/ 안에서만", "금지: 깃허브에 올리지 않는다", "필요한 증거: 시험 이름과 통과 수", "필수 검사: behavior(관련 동작 시험), typecheck(코드 검사), regression(회귀 시험), real(실제 화면·실행 증거)"]) expect(delivered).toContain(part);

  // 검사 없는 완료 → 거절(글이 남지 않는다)
  const bare = await f.tool(f.worker, "post", { task_id: task, kind: "완료", title: "고쳤습니다" });
  expect(bare.isError).toBe(true);
  expect(bare.text).toContain("관련 동작 시험(behavior) 검사가 없습니다");
  expect(bare.text).toContain("합격 기준 1(");
  // 코드 검사 실패가 남은 완료 → 거절
  const failing = await f.tool(f.worker, "post", { task_id: task, kind: "완료", title: "고쳤습니다", checks: [pass("behavior", 1), { name: "tsc", kind: "typecheck", result: "fail", evidence: "오류 2건" }, pass("regression", 2), pass("real", 1)] });
  expect(failing.isError).toBe(true);
  expect(failing.text).toContain("'tsc' 검사가 실패했습니다");
  // 실행 안 함은 통과가 아니다
  const skipped = await f.tool(f.worker, "post", { task_id: task, kind: "완료", title: "고쳤습니다", checks: [pass("behavior", 1), pass("typecheck"), pass("regression", 2), { name: "화면", kind: "real", result: "not_run", evidence: "브라우저 없음" }] });
  expect(skipped.isError).toBe(true);
  expect(skipped.text).toContain("실제 화면·실행 증거(real)이 통과하지 않았습니다(실행 안 함)");
  expect(f.store.listMessages(f.project.id).filter(m => m.kind === "완료")).toHaveLength(0);
  // 막힘은 실패를 안고도 받는다
  const blocked = await f.tool(f.worker, "post", { task_id: task, kind: "막힘", title: "코드 검사 실패", checks: [{ name: "tsc", kind: "typecheck", result: "fail", evidence: "오류 2건" }], unverified: ["화면 확인"] });
  expect(blocked.isError).toBeUndefined();
  // 고쳐서 다시 검사한 완료 → 받음
  const done = await f.tool(f.worker, "post", { task_id: task, kind: "완료", title: "검사 줄을 보이게 고침", checks: [pass("behavior", 1), pass("typecheck"), pass("regression", 2), pass("real", 1)], unverified: [], review_needed: "server/harness.ts 의 판정 규칙을 다른 직원이 계약 기준 1·2로 확인" });
  expect(done.isError).toBeUndefined();
  const id = done.text.match(/#(msg_[A-Za-z0-9_-]+)/)![1]!;
  // 총괄은 앞 보고(막힘)를 받는 중이라 이 보고는 대기열에 있다. 전달 글을 본다.
  const report = f.store.listDeliveries().find(d => d.memberId === f.lead.id && d.kind === "report" && d.text.includes(id))!.text;
  expect(report).toContain("검사(작성자 자기 확인, 계약 r1): behavior 통과 · typecheck 통과 · regression 통과 · real 통과 · 미확인 항목 통과");
  expect(report).toContain("독립 검토 필요: server/harness.ts 의 판정 규칙");
  const lookup = JSON.parse((await f.tool(f.lead, "post", { report_id: id })).text);
  expect(lookup.harness).toMatchObject({ contractRev: 1, contractRevNow: 1, memberId: f.worker.id, reviewNeeded: expect.stringContaining("다른 직원") });
  expect(lookup.harness.checks.map((c: { kind: string; criterion: number | null }) => [c.kind, c.criterion])).toEqual([["behavior", 1], ["typecheck", null], ["regression", 2], ["real", 1], ["unverified", null]]);
  expect(lookup.harness.checks[0]).toMatchObject({ taskId: task, who: "철수", command: "bun test behavior" });
});

test("총괄의 완료는 그 계약 판으로 통과한 직원 완료 보고가 있어야 받고, 계약이 바뀌면 다시 막힌다", async () => {
  const f = fixture();
  const task = (await f.tool(f.lead, "task", { title: "총괄 완료 판정", contract: { ...CODING, checks: ["behavior"], acceptance: ["동작한다"] } })).text.match(/#(tk_[A-Za-z0-9_-]+)/)![1]!;
  expect((await f.tool(f.lead, "post", { task_id: task, kind: "완료", title: "끝났습니다" })).text).toContain("계약 r1 로 검사를 통과한 직원 완료 보고가 아직 없습니다");
  expect((await f.tool(f.worker, "post", { task_id: task, kind: "완료", title: "동작함", checks: [pass("behavior", 1)] })).isError).toBeUndefined();
  expect((await f.tool(f.lead, "post", { task_id: task, kind: "완료", title: "끝났습니다" })).isError).toBeUndefined();
  // 총괄이 기준을 바꾸면 새 판이다. 옛 판의 통과는 새 판의 완료 근거가 아니다.
  expect((await f.tool(f.lead, "task", { task_id: task, contract: { ...CODING, checks: ["behavior"], acceptance: ["동작한다", "문서도 고친다"] } })).text).toContain("업무 계약 r2");
  expect((await f.tool(f.lead, "post", { task_id: task, kind: "완료", title: "끝났습니다" })).text).toContain("계약 r2 로 검사를 통과한 직원 완료 보고가 아직 없습니다");
});

test("조사 업무: 출처·사실과 해석·미확인이 없는 완료는 거절하고, 갖춘 결과 한 건은 받는다", async () => {
  const f = fixture();
  const task = (await f.tool(f.lead, "task", { title: "CLI 훅 조사", contract: { kind: "research", goal: "직원 CLI 별 훅 지원을 정리한다", acceptance: ["주장마다 원문 출처가 있다", "사실과 해석이 갈린다"] } })).text.match(/#(tk_[A-Za-z0-9_-]+)/)![1]!;
  const thin = await f.tool(f.worker, "post", { task_id: task, kind: "완료", title: "조사 끝", checks: [{ name: "정리", kind: "fact", result: "pass", evidence: "표 1개", criterion: 2 }] });
  expect(thin.isError).toBe(true);
  expect(thin.text).toContain("주장별 원문 출처(source) 검사가 없습니다");
  expect(thin.text).toContain("미확인 항목(unverified) 검사가 없습니다");
  const full = await f.tool(f.worker, "post", { task_id: task, kind: "완료", title: "직원 CLI 훅 지원을 정리함", checks: [
    { name: "주장 3개의 출처", kind: "source", result: "pass", evidence: "claude --help 2.1.323 · codex --help 0.167.0 · agy --help 1.5.8", criterion: 1 },
    { name: "사실/해석 표시", kind: "fact", result: "pass", evidence: "표의 '확정'·'해석' 열", criterion: 2 },
  ], unverified: ["Codex 훅의 실행 시 신뢰 절차"] });
  expect(full.isError).toBeUndefined();
});

test("같은 업무를 다른 직원에게 넘기면 계약 판·지난 검사(보고 id·누가)가 실리고, 직원은 총괄 계약을 바꾸지 못한다", async () => {
  const f = fixture();
  const task = (await f.tool(f.lead, "task", { title: "두 직원 업무" })).text.match(/#(tk_[A-Za-z0-9_-]+)/)![1]!;
  await f.tool(f.lead, "team_assign", { member: "w1", text: "첫 부분", task_id: task, contract: { ...CODING, checks: ["behavior"], acceptance: ["동작한다"] } });
  const first = await f.tool(f.worker, "post", { task_id: task, kind: "막힘", title: "절반만 됨", checks: [{ name: "동작", kind: "behavior", result: "fail", evidence: "1 fail", criterion: 1 }] });
  const firstId = first.text.match(/#(msg_[A-Za-z0-9_-]+)/)![1]!;
  await f.tool(f.lead, "team_assign", { member: "w2", text: "이어서 마저", task_id: task });
  await until("두 번째 직원 지시", () => f.runner.to(f.worker2).some(t => t.includes("업무 계약 r1")));
  const second = f.runner.to(f.worker2).find(t => t.includes("업무 계약 r1"))!;
  expect(second).toContain(`지난 검사(보고 #${firstId}, 철수, 계약 r1): 동작 실패`);
  // 지시에는 계약·지난 검사만 실린다. 첫 직원이 받은 지시 원문은 넘어가지 않는다.
  expect(second).not.toContain("첫 부분");
  const changed = await f.tool(f.worker2, "task", { task_id: task, contract: { kind: "other", goal: "대충", acceptance: ["아무거나"] } });
  expect(changed.isError).toBe(true);
  expect(changed.text).toContain("직원은 바꾸지 않습니다");
  expect(f.store.getTaskContract(task)!.rev).toBe(1);
});

test("계약 없는 업무의 완료는 지금처럼 검사 없이 받는다", async () => {
  const f = fixture();
  const task = (await f.tool(f.lead, "task", { title: "옛 방식 업무" })).text.match(/#(tk_[A-Za-z0-9_-]+)/)![1]!;
  expect((await f.tool(f.worker, "post", { task_id: task, kind: "완료", title: "끝" })).isError).toBeUndefined();
  expect(f.store.getTaskContract(task)).toBeNull();
});
