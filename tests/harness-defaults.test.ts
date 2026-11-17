// 하네스 후속: IAMCEO 전체 기본 적용(표시·필수 전환), 직원 계약 확인, 실행 증거(제공자 기록 대조), 조사 주장,
// 서버 소유 상태·백업 도구, 업무 사슬·개선 후보, Codex 훅 판정·제공자 설정(연결 안 함).
// 격리 데이터 폴더·가짜 core 실행기·가짜 세션 기록만 쓴다. 실제 직원·운영 DB·제공자 기록·대표 화면에는 아무것도 보내지 않는다.
import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BackupManager } from "../server/backup.ts";
import { MIGRATIONS } from "../server/db.ts";
import { execProves, parseClaudeLog, parseCodexLog } from "../server/harness-evidence.ts";
import { claudeSandboxSettings, codexGuardDecision, codexHookArgs, codexSandboxArgs, patchPaths } from "../server/harness-providers.ts";
import { CODING, fixture, pass, until, writeExec } from "./fixtures/harness-fixture.ts";
import type { Member } from "../shared/types.ts";

const id = (text: string, prefix = "tk") => text.match(new RegExp(`#(${prefix}_[A-Za-z0-9_-]+)`))![1]!;
const ONE = { ...CODING, checks: ["behavior"], acceptance: ["동작한다"] };

test("DB v32: 계약 확인·실행 증거·조사 주장·개선 후보 표가 생긴다", () => {
  const f = fixture();
  expect(MIGRATIONS.length).toBeGreaterThanOrEqual(32);
  const cols = (t: string) => (f.store.db.query(`PRAGMA table_info(${t})`).all() as { name: string }[]).map(c => c.name);
  expect(cols("task_contracts")).toEqual(expect.arrayContaining(["confirmed_by", "confirmed_by_member_id", "confirmed_at"]));
  expect(cols("report_checks")).toEqual(expect.arrayContaining(["exec_status", "exec_ref", "exec_exit", "exec_at", "exec_output_sha", "exec_command"]));
  expect(cols("report_harness")).toEqual(expect.arrayContaining(["gate", "evidence_status"]));
  for (const t of ["harness_exec_refs", "report_claims", "harness_findings"]) expect(cols(t).length).toBeGreaterThan(0);
});

test("하네스 표시 설정을 바꾸어도 기존·새 업무 모두 확정 계약이 있어야 완료한다", async () => {
  const f = fixture();
  expect(f.store.getSettings()).toMatchObject({ harnessMode: "required", harnessRequiredSince: null });
  const before = id((await f.tool(f.lead, "task", { title: "전환 전 업무" })).text);
  expect((await f.tool(f.worker, "post", { task_id: before, kind: "완료", title: "끝" })).isError).toBe(true);
  // 옛 설정 필드는 호환용으로 받으며, 특정 시점 이후만 적용하는 면제를 만들지 않는다.
  const settings = f.store.patchSettings({ harnessMode: "required" });
  expect(settings.harnessRequiredSince).toBeNull();
  const after = id((await f.tool(f.lead, "task", { title: "전환 뒤 업무" })).text);
  const refused = await f.tool(f.worker, "post", { task_id: after, kind: "완료", title: "끝" });
  expect(refused.isError).toBe(true);
  expect(refused.text).toContain("확정된 완료 기준이 없습니다");
  expect(refused.text).toContain("task 도구의 contract 로 계약을 제안하면 총괄이 확인합니다");
  // 총괄도 필수 적용 뒤 업무를 계약 없이 완료하지 못한다. 총괄이 정한 계약은 바로 묶인다
  expect((await f.tool(f.lead, "post", { task_id: after, kind: "완료", title: "끝" })).text).toContain("task 도구의 contract 로 계약을 정하세요");
  // 전환 전 업무의 완료 주장에도 같은 확정 기준이 필요하다.
  expect((await f.tool(f.worker, "post", { task_id: before, kind: "완료", title: "다시 끝" })).isError).toBe(true);
  // 진행·막힘은 그대로 받는다
  expect((await f.tool(f.worker, "post", { task_id: after, kind: "막힘", title: "계약 기다림" })).isError).toBeUndefined();
  expect(f.store.patchSettings({ harnessMode: "label" })).toMatchObject({ harnessMode: "required", harnessRequiredSince: null });
});

test("받은 계약 업무의 갈래로 올린 통과 완료도 그 업무를 마감한다(다음 일의 완료를 계속 묶지 않는다)", async () => {
  const f = fixture();
  const gated = id((await f.tool(f.lead, "task", { title: "계약 업무" })).text);
  await f.tool(f.lead, "team_assign", { member: "w1", text: "해 주세요", task_id: gated, contract: ONE });
  await until("직원 지시", () => f.runner.to(f.worker).some(t => t.includes("업무 계약 r1")));
  const run = f.store.listPendingExecutions().find(r => r.memberId === f.worker.id)!;
  const child = id((await f.tool(f.worker, "task", { title: "갈래", parent_task_id: gated })).text);
  f.ran(f.worker, "bun test behavior");
  expect((await f.tool(f.worker, "post", { task_id: child, kind: "완료", title: "갈래로 끝", contract_rev: 1, checks: [pass("behavior", 1)] })).isError).toBeUndefined();
  f.runner.end(f.worker, 1);
  await until("갈래 보고 턴 종료", () => f.store.getExecutionJournal(run.runId)?.phase === "ended");
  expect(f.store.getReportFollowup(run.runId)).toBeNull();
  const own = id((await f.tool(f.worker, "task", { title: "다음 내 일" })).text);
  const next = await f.tool(f.worker, "post", { task_id: own, kind: "완료", title: "끝" });
  expect(next.isError).toBe(true);
  expect(next.text).not.toContain("받은 업무(");
  await f.tool(f.lead, "task", { task_id: own, contract: ONE });
  f.ran(f.worker, "bun test behavior");
  expect((await f.tool(f.worker, "post", { task_id: own, kind: "완료", title: "다음 업무 확인", contract_rev: 1, checks: [pass("behavior", 1)] })).isError).toBeUndefined();
});

test("직원이 제안한 계약은 총괄 확인 전까지 판정에 묶이지 않고, 총괄이 확인하면 묶인다. 직원이 고친 새 판은 다시 확인받는다", async () => {
  const f = fixture();
  f.store.patchSettings({ harnessMode: "required" });
  await Bun.sleep(2);
  const task = id((await f.tool(f.lead, "task", { title: "직원 계약 업무" })).text);
  const proposed = await f.tool(f.worker, "task", { task_id: task, contract: ONE });
  expect(proposed.text).toContain("직원 작성 계약(확인 전)");
  expect(proposed.text).toContain("총괄에게 확인 요청을 보냈습니다");
  await until("총괄 확인 요청", () => f.store.listDeliveries().some(d => d.memberId === f.lead.id && d.text.includes("계약 확인 요청")));
  const ask = f.store.listDeliveries().find(d => d.memberId === f.lead.id && d.text.includes("계약 확인 요청"))!;
  expect(ask.text).toContain(`confirm_contract_rev 1`);
  expect(ask.text).toContain("합격 기준 1: 동작한다");
  // 확인 전: required 모드에서 완료를 받지 않는다(검사를 다 갖춰도)
  f.ran(f.worker, "bun test behavior");
  const early = await f.tool(f.worker, "post", { task_id: task, kind: "완료", title: "끝", contract_rev: 1, checks: [pass("behavior", 1)] });
  expect(early.text).toContain("아직 총괄 확인 전입니다");
  // 직원은 확인하지 못한다
  expect((await f.tool(f.worker, "task", { task_id: task, confirm_contract_rev: 1 })).text).toContain("총괄만 합니다");
  // 총괄 확인: 옛 판은 확인하지 않는다
  expect((await f.tool(f.lead, "task", { task_id: task, confirm_contract_rev: 2 })).isError).toBe(true);
  const confirmed = await f.tool(f.lead, "task", { task_id: task, confirm_contract_rev: 1 });
  expect(confirmed.text).toContain("계약 r1 을 확인했습니다");
  expect(confirmed.text).toContain("직원 작성·총괄 확인");
  // 확인 뒤: 검사·실행 증거가 있어야 받는다
  expect((await f.tool(f.worker, "post", { task_id: task, kind: "완료", title: "끝" })).text).toContain("관련 동작 시험(behavior) 검사가 없습니다");
  // 직원의 새 제안은 확인 전까지 기존 확정 r1을 대신하지 않는다
  const loosened = await f.tool(f.worker, "task", { task_id: task, contract: { ...ONE, acceptance: ["대충 된다"], checks: [] } });
  expect(loosened.text).toContain("업무 계약 r2");
  await until("두 번째 확인 요청", () => f.store.listDeliveries().some(d => d.memberId === f.lead.id && d.text.includes("계약 r2 을 제안했습니다") && d.text.includes("바로 전 판 r1(총괄 확인)")));
  expect((await f.tool(f.worker, "post", { task_id: task, kind: "완료", title: "끝", contract_rev: 2, checks: [{ name: "봄", kind: "other", result: "pass", evidence: "봄", criterion: 1 }] })).text).toContain("현재 확정 판은 r1");
  await f.tool(f.lead, "task", { task_id: task, confirm_contract_rev: 2 });
  f.ran(f.worker, "bun test behavior");
  expect((await f.tool(f.worker, "post", { task_id: task, kind: "완료", title: "끝", contract_rev: 2, checks: [{ name: "봄", kind: "other", result: "pass", evidence: "봄", criterion: 1 }] })).isError).toBeUndefined();
});

test("실행 증거: 실패한 실행·파이프 뒤 종료 코드·echo 안의 명령·계약 전 실행·다른 업무에 쓴 실행은 통과 증거가 아니다", async () => {
  const f = fixture();
  const home = f.isolated.paths.claudeHome;
  const w = f.store.requireMember(f.worker.id);
  // 계약 전에 돌린 실행은 이 판의 증거가 아니다
  writeExec(home, w, "bun test behavior");
  await Bun.sleep(5);
  const a = id((await f.tool(f.lead, "task", { title: "증거 A", contract: ONE })).text);
  const post = () => f.tool(f.worker, "post", { task_id: a, kind: "완료", title: "끝", contract_rev: 1, checks: [pass("behavior", 1)] });
  expect((await post()).text).toContain("계약 뒤 실행 기록에서 찾지 못했습니다");
  writeExec(home, w, "echo bun test behavior");
  expect((await post()).text).toContain("계약 뒤 실행 기록에서 찾지 못했습니다");
  writeExec(home, w, "bun test behavior", 1, "1 fail");
  expect((await post()).text).toContain("마지막 실행이 통과가 아닙니다(종료 코드 1)");
  writeExec(home, w, "bun test behavior 2>&1 | tail -5");
  expect((await post()).text).toContain("뒤에 붙은 파이프");
  writeExec(home, w, "set -o pipefail; bun test behavior 2>&1 | tail -5");
  const ok = await post();
  expect(ok.isError).toBeUndefined();
  const refA = f.store.getReportHarness(id(ok.text, "msg"))!.checks[0]!.execRef!;
  expect(refA).toStartWith("claude:");
  // 같은 실행을 다른 업무의 증거로 쓰지 못한다(새로 돌려야 한다)
  const b = id((await f.tool(f.lead, "task", { title: "증거 B", contract: ONE })).text);
  // 계약 B 는 A 의 실행 뒤에 생겼으므로, 시각으로 막히지 않게 실행 기록의 그 줄을 다시 쓰지 않고 표지 중복만 본다
  const lines = readFileSync(join(home, "projects", w.cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${w.sessionId}.jsonl`), "utf8").trim().split("\n");
  const at = new Date(Date.now() + 1000).toISOString();
  appendFileSync(join(home, "projects", w.cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${w.sessionId}.jsonl`), lines.slice(-2).map(l => JSON.stringify({ ...JSON.parse(l), timestamp: at })).join("\n") + "\n");
  const reused = await f.tool(f.worker, "post", { task_id: b, kind: "완료", title: "끝", contract_rev: 1, checks: [pass("behavior", 1)] });
  expect(reused.text).toContain(`이미 다른 업무 #${a} 의 증거로 쓰였습니다`);
  f.ran(f.worker, "bun test behavior");
  expect((await f.tool(f.worker, "post", { task_id: b, kind: "완료", title: "끝", contract_rev: 1, checks: [pass("behavior", 1)] })).isError).toBeUndefined();
  // 거절은 개선 후보로 남는다(규칙은 바꾸지 않는다)
  const findings = JSON.parse((await f.tool(f.lead, "harness_findings", { task_id: a })).text);
  expect(findings.counts.evidence_missing).toBeGreaterThanOrEqual(4);
  expect(findings.howTo).toContain("대표 결재 없이 바꾸지 않습니다");
});

test("Codex 직원은 rollout 기록(CommandExecution exit_code)으로, Antigravity 는 '미지원'으로 남긴다", async () => {
  const f = fixture();
  const codex = f.make("cx", "코덱스", "worker", "codex");
  const agy = f.make("ag", "안티", "worker", "antigravity");
  const task = id((await f.tool(f.lead, "task", { title: "제공자별 증거", contract: ONE })).text);
  const dir = join(f.isolated.paths.codexHome, "sessions", "2026", "11", "14");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "rollout-2026-11-14T00-00-00-session-cx.jsonl");
  const now = () => new Date().toISOString();
  const rec = (exit: number, command: string, n: number) => JSON.stringify({ timestamp: now(), type: "event_msg", payload: { type: "item_completed", thread_id: "th1", item: { type: "CommandExecution", id: `item-${n}`, command: ["/bin/zsh", "-lc", command], cwd: codex.cwd, exit_code: exit, status: exit === 0 ? "completed" : "failed", aggregated_output: "out", source: "unified_exec_startup" } } });
  appendFileSync(file, [JSON.stringify({ timestamp: now(), type: "session_meta", payload: { id: "session-cx", cwd: codex.cwd, source: "cli" } }), rec(1, "bun test behavior", 1)].join("\n") + "\n");
  const post = (m: typeof codex) => f.tool(m, "post", { task_id: task, kind: "완료", title: "끝", contract_rev: 1, checks: [pass("behavior", 1)] });
  expect((await post(codex)).text).toContain("종료 코드 1");
  appendFileSync(file, rec(0, "bun test behavior", 2) + "\n");
  const ok = await post(codex);
  expect(ok.isError).toBeUndefined();
  expect(f.store.getReportHarness(id(ok.text, "msg"))!.checks[0]).toMatchObject({ execStatus: "matched", execRef: "codex:th1:item-2" });
  const ag = await post(agy);
  expect(ag.isError).toBeUndefined();
  const h = f.store.getReportHarness(id(ag.text, "msg"))!;
  expect(h).toMatchObject({ evidenceStatus: "unsupported" });
  expect(h.checks[0]!.execStatus).toBe("unsupported");
  expect(f.store.listHarnessFindings(f.project.id).some(x => x.kind === "evidence_unsupported" && x.memberId === agy.id)).toBe(true);
});

test("다음 턴 비켜 가기: 이미 다음 업무까지 받은 옛 실행에서도 미마감 계약을 자기 업무의 완료로 비켜 가지 못한다", async () => {
  const f = fixture();
  const gated = id((await f.tool(f.lead, "task", { title: "계약 업무" })).text);
  await f.tool(f.lead, "team_assign", { member: "w1", text: "해 주세요", task_id: gated, contract: ONE });
  await until("직원 지시", () => f.runner.to(f.worker).some(t => t.includes("업무 계약 r1")));
  const firstRun = f.store.listPendingExecutions().find(r => r.memberId === f.worker.id)!;
  f.runner.end(f.worker);
  await until("보고 보완 지시", () => f.runner.to(f.worker).some(t => t.includes("보고 보완:")));
  f.runner.end(f.worker, 1);
  await until("보고 보완 턴 종료", () => !f.store.listPendingExecutions().some(r => r.memberId === f.worker.id));
  const free = id((await f.tool(f.lead, "task", { title: "다른 일" })).text);
  // 필수 기준을 적용하기 전에 이미 대기열에 있던 지시를 복원한다.
  f.store.enqueue({ projectId: f.project.id, memberId: f.worker.id, kind: "instruction", text: "이것도", taskId: free });
  expect(f.runner.to(f.worker).some(t => t.includes("이것도"))).toBe(false);
  // 새 전달은 앞 업무가 끝날 때까지 기다린다. 순서 제한 전에 다음 업무까지
  // 이미 받은 옛 실행의 영수증과 종료 기록을 복원해 계약 우회 방지를 검사한다.
  const received = f.store.listPending(f.worker.id).find(d => d.taskId === free && d.kind === "instruction")!;
  expect(received).toBeDefined();
  f.store.markDelivered(received.id);
  const at = new Date().toISOString();
  f.store.saveExecutionJournal({ ...firstRun, runId: `${firstRun.runId}-legacy-next`, deliveryIds: [received.id],
    phase: "ended", turn: 2, inputReceivedAt: at, startedAt: at, lastProgressAt: at, endedAt: at,
    result: "success", reportRequestedAt: null, createdAt: at, updatedAt: at });
  const own = id((await f.tool(f.worker, "task", { title: "내가 만든 업무" })).text);
  const bypass = await f.tool(f.worker, "post", { task_id: own, kind: "완료", title: "끝" });
  expect(bypass.isError).toBe(true);
  expect(bypass.text).toContain(`받은 업무(#${gated} 계약 r1)는 계약이 있고 아직 완료·막힘으로 마감하지 않았습니다`);
  // 이미 받은 옛 업무도 확정 기준 없는 완료로 통과하지 않는다.
  expect((await f.tool(f.worker, "post", { task_id: free, kind: "완료", title: "다른 일 끝" })).isError).toBe(true);
  // 계약 업무를 막힘으로 마감하면 묶임이 풀린다
  await f.tool(f.worker, "post", { task_id: gated, kind: "막힘", title: "막힘", unverified: ["동작"] });
  const missing = await f.tool(f.worker, "post", { task_id: own, kind: "완료", title: "끝" });
  expect(missing.isError).toBe(true);
  expect(missing.text).not.toContain("받은 업무(");
  expect(missing.text).toContain("확정된 완료 기준이 없습니다");
});

test("server_check·server_backup: 직원은 데이터 폴더를 직접 읽지 않고 서버가 만든 백업과 상태를 본다. 경로는 싣지 않는다", async () => {
  const f = fixture();
  const none = JSON.parse((await f.tool(f.worker, "server_check", {})).text);
  expect(none).toMatchObject({ schema: { version: MIGRATIONS.length, supportedVersion: MIGRATIONS.length, ok: true }, harness: { mode: "required" }, backups: { recent: [] } });
  expect((await f.tool(f.worker, "server_backup", {})).text).toContain("백업 관리자가 없습니다");
  const manager = new BackupManager({ home: f.config.home, backupDir: join(f.config.home, "backups") });
  f.orch.setBackups(manager);
  const made = JSON.parse((await f.tool(f.worker, "server_backup", {})).text);
  expect(made).toMatchObject({ created: true, backup: { schemaVersion: MIGRATIONS.length, verified: true } });
  const again = JSON.parse((await f.tool(f.lead, "server_backup", {})).text);
  expect(again).toMatchObject({ created: false, backup: { id: made.backup.id } });
  const check = (await f.tool(f.worker, "server_check", {})).text;
  expect(JSON.parse(check).backups.recent[0]).toMatchObject({ id: made.backup.id, verified: true });
  expect(check).not.toContain(f.config.home);
  expect(JSON.parse(check).execEvidence).toBe("log_not_found");
  f.ran(f.worker, "ls");
  expect(JSON.parse((await f.tool(f.worker, "server_check", {})).text).execEvidence).toBe("available");
});

test("task_trace: 업무 한 건의 계약 판·전달·보고·검사 대조·결재·개선 후보를 읽기만 하고, 대표 개입·거절은 후보로 남는다", async () => {
  const f = fixture();
  const task = id((await f.tool(f.lead, "task", { title: "사슬 보기" })).text);
  await f.tool(f.lead, "team_assign", { member: "w1", text: "해 주세요", task_id: task, contract: ONE });
  await until("직원 지시", () => f.runner.to(f.worker).some(t => t.includes("업무 계약 r1")));
  await f.tool(f.worker, "post", { task_id: task, kind: "완료", title: "끝" });
  // 대표가 맡긴 업무에 직원에게 바로 끼어듦
  await f.orch.sendUserMessage(f.project.id, { text: "이 부분 먼저 봐 주세요", targetMemberId: f.worker.id, taskId: task });
  // 대표가 직원 결재에 '다시'로 답함
  const asked = await f.tool(f.worker, "ask", { task_id: task, title: "이 결과로 갈까요?", detail: "시험 결과", options: [{ k: "a", label: "이대로 진행" }, { k: "b", label: "다시 해 주세요" }] });
  const decisionId = asked.text.match(/#(d_[A-Za-z0-9_-]+)/)![1]!;
  await f.orch.answerDecision(decisionId, { choice: "b" });
  f.ran(f.worker, "bun test behavior");
  await f.tool(f.worker, "post", { task_id: task, kind: "완료", title: "고침", contract_rev: 1, checks: [pass("behavior", 1)] });
  const trace = JSON.parse((await f.tool(f.worker, "task_trace", { task_id: task })).text);
  expect(trace.contract).toMatchObject({ on: task, rev: 1, binding: true, authorKind: "conductor" });
  expect(trace.deliveries.some((d: { to: string; kind: string }) => d.to === "철수" && d.kind === "instruction")).toBe(true);
  expect(trace.reports.at(-1)).toMatchObject({ kind: "완료", gate: "contract", evidence: "ok", checks: [{ kind: "behavior", result: "pass", exec: "matched", exit: 0 }] });
  const kinds = trace.findings.map((x: { kind: string }) => x.kind);
  expect(kinds).toEqual(expect.arrayContaining(["completion_refused", "owner_intervened", "owner_rejected"]));
  expect(trace.findings.find((x: { kind: string }) => x.kind === "owner_rejected").detail).toContain("글자 추정");
  // 직원은 개선 후보 목록 도구를 쓰지 못한다(총괄만)
  expect((await f.tool(f.worker, "harness_findings", {})).isError).toBe(true);
});

test("셸 대조 규칙: 명령 자리·&& 사슬·pipefail·bash -c 를 가른다", () => {
  expect(execProves("cd x && bun test a.test.ts", "bun test a.test.ts")).toBe("absent");
  expect(execProves("cd x && bun test a.test.ts", "cd x && bun test a.test.ts", "/fixture", "/fixture")).toBe("ok");
  expect(execProves("bash -lc 'bun test a.test.ts'", "bun test a.test.ts")).toBe("ok");
  expect(execProves("bunx tsc --noEmit && echo ok", "bunx tsc --noEmit")).toBe("ok");
  expect(execProves("echo bun test a.test.ts", "bun test a.test.ts")).toBe("absent");
  expect(execProves("bun test a.test.ts | tail", "bun test a.test.ts")).toBe("masked");
  expect(execProves("bun test a.test.ts; true", "bun test a.test.ts")).toBe("masked");
  expect(execProves("bun test a.test.ts || true", "bun test a.test.ts")).toBe("masked");
  expect(execProves("bun test a.test.ts &", "bun test a.test.ts")).toBe("masked");
  expect(execProves("set -o pipefail; bun test a.test.ts | tail", "bun test a.test.ts")).toBe("ok");
});

test("기록 해석: Claude 는 is_error·'Exit code N'·중단·백그라운드를, Codex 는 status·exit_code 를 본다", () => {
  const at = new Date().toISOString();
  const claude = [
    { type: "assistant", timestamp: at, message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "bun test" } }, { type: "tool_use", id: "t2", name: "Bash", input: { command: "bun test" } }, { type: "tool_use", id: "t3", name: "Bash", input: { command: "bun test", run_in_background: true } }, { type: "tool_use", id: "t4", name: "Bash", input: { command: "rm -rf x" } }] } },
    { type: "user", timestamp: at, message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok", is_error: false }] }, toolUseResult: { stdout: "ok", stderr: "", interrupted: false } },
    { type: "user", timestamp: at, message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "Exit code 2\nboom", is_error: true }] }, toolUseResult: "Error: Exit code 2" },
    { type: "user", timestamp: at, message: { content: [{ type: "tool_result", tool_use_id: "t3", content: "running", is_error: false }] }, toolUseResult: { stdout: "", backgroundTaskId: "b1" } },
    { type: "user", timestamp: at, message: { content: [{ type: "tool_result", tool_use_id: "t4", content: "IAMCEO 하네스: hook denied", is_error: true }] } },
  ].map(r => JSON.stringify(r)).join("\n");
  expect(parseClaudeLog(claude, null).execs.map(e => e.exitCode)).toEqual([0, 2, null, null]);
  expect(parseClaudeLog(claude, new Date(Date.now() + 60_000).toISOString()).execs).toHaveLength(0);
  const codex = [
    { timestamp: at, type: "event_msg", payload: { type: "item_completed", thread_id: "th", item: { type: "CommandExecution", id: "i1", command: ["/bin/zsh", "-lc", "bun test"], exit_code: 0, status: "completed", aggregated_output: "ok" } } },
    { timestamp: at, type: "event_msg", payload: { type: "item_completed", thread_id: "th", item: { type: "CommandExecution", id: "i2", command: ["/bin/zsh", "-lc", "bun test"], exit_code: 1, status: "failed", aggregated_output: "x" } } },
    { timestamp: at, type: "event_msg", payload: { type: "item_completed", thread_id: "th", item: { type: "CommandExecution", id: "i3", command: ["/bin/zsh", "-lc", "sleep 9"], status: "in_progress" } } },
  ].map(r => JSON.stringify(r)).join("\n");
  expect(parseCodexLog(codex, null).execs.map(e => [e.command, e.exitCode])).toEqual([["bun test", 0], ["bun test", 1], ["sleep 9", null]]);
});

test("Codex 훅 판정(연결 안 함): 묻기는 거절로 바꾸고, apply_patch 가 비밀 위치를 고치면 거절한다. 진입 파일 --codex 출력", async () => {
  const ctx = { iamceoHome: "/fake/iamceo-home", userHome: "/fake/home" };
  expect(codexGuardDecision({ tool_name: "Bash", tool_input: { command: "git push" }, cwd: "/fake/home/work" }, ctx)).toMatchObject({ decision: "deny", reason: expect.stringContaining("Codex 는 승인 창이 없어") });
  expect(codexGuardDecision({ tool_name: "Bash", tool_input: { command: "bun test" }, cwd: "/fake/home/work" }, ctx).decision).toBe("allow");
  const patch = "*** Begin Patch\n*** Update File: /fake/home/.ssh/config\n@@\n-a\n+b\n*** End Patch";
  expect(patchPaths(patch)).toEqual(["/fake/home/.ssh/config"]);
  expect(codexGuardDecision({ tool_name: "apply_patch", tool_input: { command: patch }, cwd: "/fake/home/work" }, ctx).decision).toBe("deny");
  expect(codexGuardDecision({ tool_name: "apply_patch", tool_input: { command: "*** Begin Patch\n*** Add File: src/a.ts\n+x\n*** End Patch" }, cwd: "/fake/home/work" }, ctx).decision).toBe("allow");
  const proc = Bun.spawn([process.execPath, resolve(import.meta.dir, "..", "bin", "iamceo-guard.ts"), "--home", "/fake/iamceo-home", "--codex"], { stdin: new TextEncoder().encode(JSON.stringify({ tool_name: "Bash", tool_input: { command: "rm -rf build" }, cwd: "/tmp" })), stdout: "pipe" });
  const out = JSON.parse((await new Response(proc.stdout).text()).trim());
  expect(out.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
});

test("제공자 설정(준비만): Claude 샌드박스는 밖 재실행·허용 목록 밖 접속을 끄고, Codex 는 /tmp 쓰기까지 닫으며, 훅 설정은 TOML 로 읽힌다", () => {
  const sb = claudeSandboxSettings({ iamceoHome: "/fake/iamceo-home", userHome: "/fake/home" }).sandbox as Record<string, any>;
  expect(sb).toMatchObject({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, network: { allowedDomains: [], strictAllowlist: true } });
  expect(sb.filesystem.denyRead).toEqual(expect.arrayContaining(["/fake/iamceo-home", "/fake/home/.ssh", "/fake/home/.config/gh"]));
  expect(sb.filesystem.allowRead).toEqual(["/fake/iamceo-home/inbox", "/fake/iamceo-home/roles"]);
  const args = codexSandboxArgs();
  expect(args).toEqual(expect.arrayContaining(["--sandbox", "workspace-write", "sandbox_workspace_write.exclude_slash_tmp=true", "sandbox_workspace_write.network_access=false"]));
  expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  const hook = codexHookArgs("/x/bun /x/iamceo-guard.ts --home '/h' --codex");
  const value = hook[3]!.slice("hooks.PreToolUse=".length);
  const parsed = Bun.TOML.parse(`v = ${value}`) as { v: { matcher: string; hooks: { type: string; command: string; timeout: number }[] }[] };
  expect(parsed.v[0]).toEqual({ matcher: "^(Bash|apply_patch)$", hooks: [{ type: "command", command: "/x/bun /x/iamceo-guard.ts --home '/h' --codex", timeout: 10 }] });
});

test("첨부를 잇지 못하면 데이터 폴더 원본 경로(훅이 막는 곳) 대신 직원 받을 자리 경로를 넘긴다", () => {
  const f = fixture();
  const gone = join(f.config.home, "uploads", "f_gone-a.txt");
  const [out] = (f.orch as unknown as { attachmentsFor(m: Member, a: { id: string; name: string; path: string }[]): { path: string }[] }).attachmentsFor(f.worker, [{ id: "f_gone", name: "a.txt", path: gone }]);
  expect(out!.path).toBe(join(f.config.home, "inbox", f.worker.id, "f_gone-a.txt"));
  expect(out!.path).not.toContain(`${join(f.config.home, "uploads")}`);
});
