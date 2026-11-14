// 실제 원기록 f_uOCLcLxA0HYj의 비밀 없는 모양만 고정한다. 실제 제공자 기록은 열지 않는다.
import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseClaudeLog, parseCodexLog } from "../server/harness-evidence.ts";
import { transcriptPath } from "../server/runner/transcript.ts";
import { fixture } from "./fixtures/harness-fixture.ts";

const ONE = { kind: "coding", goal: "실패를 성공으로 받지 않는다", acceptance: ["성공 실행만 완료 근거다"], checks: ["behavior"] };
const id = (r: { text: string }) => r.text.match(/#(tk_[\w-]+)/)![1]!;
const complete = (stdout = "") => ({ stdout, stderr: "", interrupted: false });
let seq = 0;
function records(command: string, result: unknown, error: unknown = false, out = "(Bash completed with no output)", at = new Date().toISOString(), cwd = "/fake/work") {
  const call = `exit-fixture-${++seq}`;
  return [
    { type: "assistant", timestamp: at, cwd, message: { content: [{ type: "tool_use", id: call, name: "Bash", input: { command } }] } },
    { type: "user", timestamp: at, cwd, message: { content: [{ type: "tool_result", tool_use_id: call, content: out, ...(error === undefined ? {} : { is_error: error }) }] }, ...(result === undefined ? {} : { toolUseResult: result }) },
  ].map(x => JSON.stringify(x)).join("\n") + "\n";
}
function record(f: ReturnType<typeof fixture>, command: string, result: unknown, error: unknown = false, out?: string) {
  const path = transcriptPath(f.worker.cwd, f.worker.sessionId!, f.isolated.paths.claudeHome);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, records(command, result, error, out, undefined, f.worker.cwd));
}
const done = (f: ReturnType<typeof fixture>, task: string, command: string) => f.tool(f.worker, "post", { task_id: task, kind: "완료", title: "격리 판정", contract_rev: 1, checks: [{ kind: "behavior", name: "실행", result: "pass", evidence: "고정 기록과 실행 대조", command, criterion: 1 }] });

test("실제 기록 형태: Condition is false인 종료1은 post 완료로 받지 않는다", async () => {
  const f = fixture(), task = id(await f.tool(f.lead, "task", { title: "실제 기록 대조", contract: ONE }));
  const command = "test -f tests/harness-not-present.test.ts";
  const p = Bun.spawn(["/bin/bash", "--noprofile", "--norc", "-c", command], { cwd: f.worker.cwd, env: { PATH: "/usr/bin:/bin", HOME: f.worker.cwd }, stdout: "pipe", stderr: "pipe" });
  expect(await p.exited).toBe(1);
  expect(await new Response(p.stdout).text()).toBe("");
  record(f, command, { ...complete(), returnCodeInterpretation: "Condition is false", noOutputExpected: true });
  const refused = await done(f, task, command);
  expect(refused.isError).toBe(true);
  expect(refused.text).toContain("마지막 실행이 통과가 아닙니다");
  const trace = JSON.parse((await f.tool(f.lead, "task_trace", { task_id: task })).text);
  expect(trace.reports.some((r: { kind: string }) => r.kind === "완료")).toBe(false);
  expect(trace.findings.some((r: { kind: string }) => r.kind === "evidence_missing")).toBe(true);
});

for (const [label, command, interpretation] of [
  ["test", "test -f absent-file", "Condition is false"],
  ["grep", "/usr/bin/grep needle haystack.txt", "No matches found"],
  ["diff", "/usr/bin/diff left.txt right.txt", "Files differ"],
] as const) test(`${label}: 무해한 실제 종료1과 해석이 있는 기록을 성공으로 받지 않는다`, async () => {
  const f = fixture(), task = id(await f.tool(f.lead, "task", { title: label, contract: ONE }));
  writeFileSync(join(f.worker.cwd, "haystack.txt"), "plain\n");
  writeFileSync(join(f.worker.cwd, "left.txt"), "left\n");
  writeFileSync(join(f.worker.cwd, "right.txt"), "right\n");
  const p = Bun.spawn(["/bin/bash", "--noprofile", "--norc", "-c", command], { cwd: f.worker.cwd, env: { PATH: "/usr/bin:/bin", HOME: f.worker.cwd }, stdout: "pipe", stderr: "pipe" });
  const output = await new Response(p.stdout).text();
  expect(await p.exited).toBe(1);
  // test 이외 해석 문자열은 제공자의 실제 문구라는 주장이 아니다. 알 수 없는 해석의 차단 대조다.
  record(f, command, { ...complete(output), returnCodeInterpretation: interpretation });
  expect((await done(f, task, command)).isError).toBe(true);
});

const bad: [string, unknown, unknown, string?][] = [
  ["알 수 없는 해석", { ...complete(), returnCodeInterpretation: "unrecognized interpretation" }, false],
  ["해석과 숫자0 충돌", { ...complete(), exitCode: 0, returnCodeInterpretation: "Condition is false" }, false],
  ["숫자1", { ...complete(), exitCode: 1 }, false],
  ["숫자 필드 충돌", { ...complete(), exitCode: 0, exit_code: 1 }, false],
  ["문자열 숫자", { ...complete(), exitCode: "0" }, false],
  ["오류 플래그와 0 충돌", { ...complete(), exitCode: 0 }, true, "Exit code 0\nerror"],
  ["오류 플래그 누락", complete(), null],
  ["중단 상태 누락", { stdout: "", stderr: "" }, false],
  ["stderr 누락", { stdout: "", interrupted: false }, false],
  ["실행 중", { ...complete(), status: "in_progress", exitCode: 0 }, false],
  ["실패 상태", { ...complete(), status: "failed", exitCode: 0 }, false],
  ["알 수 없는 상태", { ...complete(), status: "mystery" }, false],
  ["중단", { ...complete(), interrupted: true, exitCode: 0 }, false],
  ["백그라운드", { ...complete(), backgroundTaskId: "pending", exitCode: 0 }, false],
  ["누락 결과", undefined, false],
];
for (const [label, result, error, output] of bad) test(`불명확 기록: ${label}는 post 완료를 거절한다`, async () => {
  const f = fixture(), task = id(await f.tool(f.lead, "task", { title: label, contract: ONE }));
  record(f, "bun test boundary", result, error, output);
  expect((await done(f, task, "bun test boundary")).isError).toBe(true);
});

test("정상 완결 구조와 명시 숫자0은 실제 post에서 수용한다", async () => {
  for (const result of [complete(), { ...complete("ok"), exitCode: 0 }, { ...complete(), exit_code: 0, status: "completed" }]) {
    const f = fixture(), task = id(await f.tool(f.lead, "task", { title: "정상 성공", contract: ONE }));
    record(f, "bun test accepted", result);
    const accepted = await done(f, task, "bun test accepted");
    expect(accepted.isError).toBeUndefined();
    const trace = JSON.parse((await f.tool(f.lead, "task_trace", { task_id: task })).text);
    expect(trace.reports.at(-1)).toMatchObject({ gate: "contract", evidence: "ok", checks: [{ exec: "matched", exit: 0 }] });
  }
});

test("최근 실행이 해석·부분 결과면 앞선 성공을 재사용하지 않는다", async () => {
  const f = fixture(), task = id(await f.tool(f.lead, "task", { title: "마지막 결과", contract: ONE }));
  record(f, "bun test latest", complete());
  record(f, "bun test latest", { ...complete(), returnCodeInterpretation: "Condition is false" });
  expect((await done(f, task, "bun test latest")).isError).toBe(true);
  record(f, "bun test latest", { stdout: "" });
  expect((await done(f, task, "bun test latest")).isError).toBe(true);
  record(f, "bun test latest", complete());
  expect((await done(f, task, "bun test latest")).isError).toBeUndefined();
});

test("기록 해석: 명시 nonzero와 오류만 유지하고 종료0 오류를 성공으로 만들지 않는다", () => {
  expect(parseClaudeLog(records("false", "Error: Exit code 1", true, "Exit code 1\n"), null).execs[0].exitCode).toBe(1);
  expect(parseClaudeLog(records("false", complete(), true, "Exit code 0\n"), null).execs[0].exitCode).toBeNull();
  const at = new Date().toISOString();
  const codex = (status: string, exit_code: unknown) => JSON.stringify({ type: "event_msg", timestamp: at, payload: { type: "item_completed", item: { type: "CommandExecution", id: "synthetic", command: ["/bin/bash", "-c", "false"], cwd: "/fake/work", status, exit_code } } });
  expect(parseCodexLog(codex("failed", 0), null).execs[0].exitCode).toBeNull();
  expect(parseCodexLog(codex("completed", 0), null).execs[0].exitCode).toBe(0);
  expect(parseCodexLog(codex("failed", 1), null).execs[0].exitCode).toBe(1);
  expect(parseCodexLog(codex("in_progress", 0), null).execs[0].exitCode).toBeNull();
});

test("새 호출의 결과가 아직 없으면 앞 성공으로 완료하지 않는다", async () => {
  const f = fixture(), task = id(await f.tool(f.lead, "task", { title: "미완료 호출", contract: ONE }));
  record(f, "bun test pending", complete());
  const path = transcriptPath(f.worker.cwd, f.worker.sessionId!, f.isolated.paths.claudeHome);
  appendFileSync(path, JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(), cwd: f.worker.cwd, message: { content: [{ type: "tool_use", id: "pending", name: "Bash", input: { command: "bun test pending" } }] } }) + "\n");
  expect((await done(f, task, "bun test pending")).isError).toBe(true);
});

test("묶인 tool_result에 공통 숫자0 하나를 여러 호출 성공으로 배정하지 않는다", () => {
  const rows = records("bun test one", complete()).trim().split("\n").map(x => JSON.parse(x));
  rows[0].message.content.push({ type: "tool_use", id: "other", name: "Bash", input: { command: "bun test other" } });
  rows[1].message.content.push({ type: "tool_result", tool_use_id: "other", content: "", is_error: false });
  expect(parseClaudeLog(rows.map(x => JSON.stringify(x)).join("\n"), null).execs.map(x => x.exitCode)).toEqual([null, null]);
});

test("도구 결과 쪽의 숫자·오류·상태가 성공 구조와 충돌해도 거절한다", async () => {
  for (const metadata of [{ exit_code: 1 }, { returnCodeInterpretation: "unknown" }, { status: "failed" }, { error: "failure" }]) {
    const f = fixture(), task = id(await f.tool(f.lead, "task", { title: "도구 결과 충돌", contract: ONE }));
    const rows = records("bun test metadata", complete(), false, "", undefined, f.worker.cwd).trim().split("\n").map(x => JSON.parse(x));
    Object.assign(rows[1].message.content[0], metadata);
    const path = transcriptPath(f.worker.cwd, f.worker.sessionId!, f.isolated.paths.claudeHome);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, rows.map(x => JSON.stringify(x)).join("\n") + "\n");
    expect((await done(f, task, "bun test metadata")).isError).toBe(true);
  }
});

test("호출보다 앞선 결과 시각은 성공 근거가 아니다", async () => {
  const f = fixture(), task = id(await f.tool(f.lead, "task", { title: "역전된 시각", contract: ONE }));
  const at = new Date(Date.now() + 1000).toISOString();
  const rows = records("bun test time", complete(), false, "", at, f.worker.cwd).trim().split("\n").map(x => JSON.parse(x));
  rows[1].timestamp = new Date().toISOString();
  const path = transcriptPath(f.worker.cwd, f.worker.sessionId!, f.isolated.paths.claudeHome);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, rows.map(x => JSON.stringify(x)).join("\n") + "\n");
  expect((await done(f, task, "bun test time")).isError).toBe(true);
});
