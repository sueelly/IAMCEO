// 실행 근거 진단의 실제 도구 경로. 가짜 등록 세션·격리 DB만 쓴다. 실제 비서 기록은 읽지 않는다.
import { afterAll, expect, test } from "bun:test";
import { decodeStoredText } from "../server/stored-text.ts";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { fixture, writeExec } from "./fixtures/harness-fixture.ts";
import { transcriptPath } from "../server/runner/transcript.ts";
import type { Member } from "../shared/types.ts";
import { listAgentTools } from "../server/agent-tools.ts";

const observed: unknown[] = [];
afterAll(() => {
  const path = join(import.meta.dir, "../.pumasi/evidence/query-responses.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ syntheticOnly: true, liveSecretaryLogRead: false, responses: observed }, null, 2));
});

const ONE = { kind: "coding", goal: "실행 미발견을 좁게 진단한다", acceptance: ["비밀 없는 관찰"], checks: ["behavior"] };
const command = "git rev-parse HEAD";
const id = (r: { text: string }, prefix = "tk") => r.text.match(new RegExp(`#(${prefix}_[\\w-]+)`))![1]!;
type F = ReturnType<typeof fixture>;
async function setup(cli: "codex" | "claude" | "antigravity" = "codex", want = command) {
  const f = fixture(), member = f.make("diagnosed", "가짜 조회 대상", "worker", cli);
  const task = id(await f.tool(f.lead, "task", { title: "실패 검사 조회", contract: ONE }));
  const posted = await f.tool(member, "post", { task_id: task, kind: "막힘", title: "실행 미발견", contract_rev: 1, checks: [{ name: "실패한 검사", kind: "behavior", result: "fail", evidence: "대조 미확인", command: want.length > 500 ? command : want, criterion: 1 }] });
  expect(posted.isError).toBeUndefined();
  const report = id(posted, "msg"), args = { task_id: task, report_id: report, check_index: 0 };
  // 긴 인자는 현재 API 상한 밖이다. 과거 행 반환 경계만 가짜 값으로 주입한다.
  if (want.length > 500) f.store.db.query("UPDATE report_checks SET command = ? WHERE message_id = ?").run(want, report);
  const query = async (caller: Member = member, extra: Record<string, unknown> = {}) => {
    const request = { ...args, ...extra }, response = await f.tool(caller, "exec_diagnose", request);
    observed.push({ callerKind: caller.kind, callerId: caller.id, request, response });
    return response;
  };
  return { ...f, member, task, report, args, query };
}
type S = Awaited<ReturnType<typeof setup>>;
function codexRows(s: S, cmd = command) {
  const at = new Date().toISOString();
  return [
    { type: "session_meta", timestamp: at, payload: { id: s.member.sessionId, cwd: s.member.cwd } },
    { type: "event_msg", timestamp: at, payload: { type: "item_completed", thread_id: s.member.sessionId, item: { id: "FAKE_CALL_PRIVATE", type: "CommandExecution", command: ["/bin/bash", "-c", cmd], cwd: s.member.cwd, status: "completed", exit_code: 0, aggregated_output: "FAKE_STDOUT_PRIVATE", stderr: "FAKE_STDERR_PRIVATE", environment: { FAKE_ENV_PRIVATE: "FAKE_CREDENTIAL_PRIVATE" } } } },
  ] as any[];
}
function put(s: S, rows: unknown[], suffix = "", name = "one") {
  const path = join(s.isolated.paths.codexHome, "sessions", "fixture", `rollout-${name}.jsonl`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, rows.map(x => JSON.stringify(x)).join("\n") + "\n" + suffix);
  return path;
}
async function data(s: S, caller = s.member) {
  const r = await s.query(caller);
  expect(r.isError).toBeUndefined();
  return JSON.parse(r.text);
}
function privateValuesAbsent(value: unknown, s: S, ...extra: string[]) {
  const text = JSON.stringify(value);
  for (const v of ["FAKE_STDOUT_PRIVATE", "FAKE_STDERR_PRIVATE", "FAKE_ENV_PRIVATE", "FAKE_CREDENTIAL_PRIVATE", "FAKE_CALL_PRIVATE", s.member.sessionId!, s.member.cwd, s.isolated.paths.codexHome, ...extra]) expect(text).not.toContain(v);
}

test("진단: 자기 실패 검사와 총괄 조회는 현재 선택·범위·후보·대조를 반환한다", async () => {
  const s = await setup(); put(s, codexRows(s));
  const d = await data(s);
  expect(d.scope).toMatchObject({ taskId: s.task, reportId: s.report, checkIndex: 0, memberId: s.member.id, contract: { taskId: s.task, rev: 1 } });
  expect(d.observation).toMatchObject({ kind: "current_requery", original: { status: "not_recorded" } });
  expect(d.selection).toMatchObject({ code: "selected", sessionMatch: true, cwdMatch: true, matchingFiles: 1 });
  expect(d.read).toMatchObject({ limitBytes: 1048576, gateLimitBytes: 201326592, headTruncated: false, tail: "newline", complete: true });
  expect(d.comparison).toMatchObject({ scope: "observed_window_only", status: "matched" });
  expect(d.events.candidates[0]).toMatchObject({ format: "codex_command_execution", callObserved: true, resultObserved: true, pair: "combined", commandMatch: true, cwdMatch: "match", contractTime: "after", numericExit: 0, parsedExit: 0, completion: "completed" });
  expect((await data(s, s.lead)).comparison.status).toBe("matched");
  privateValuesAbsent(d, s);
});

for (const [name, mutate, selection] of [
  ["다른 등록 세션", (rows: any[]) => { rows[0].payload.id = "other-session"; }, "no_matching_session"],
  ["메타데이터 위치 차이", (rows: any[]) => { rows[0].payload.cwd = "/different"; }, "cwd_mismatch"],
] as const) test(`진단 선택: ${name}를 구분한다`, async () => {
  const s = await setup(), rows = codexRows(s); mutate(rows); put(s, rows);
  const d = await data(s); expect(d.selection.code).toBe(selection); expect(d.comparison.status).toBe("missing");
});

test("진단 선택: 같은 세션·위치의 후보 파일이 여럿이면 임의로 고르지 않는다", async () => {
  const s = await setup(); put(s, codexRows(s), "", "one"); put(s, codexRows(s), "", "two");
  const d = await data(s); expect(d.selection).toMatchObject({ code: "ambiguous", matchingFiles: 2 });
});

test("진단: 기록 없음과 미지원 제공자를 구분한다", async () => {
  const missing = await setup(); expect((await data(missing)).selection.code).toBe("no_matching_session");
  const unsupported = await setup("antigravity");
  expect((await data(unsupported)).comparison.status).toBe("unsupported");
});

for (const [name, mutate, want] of [
  ["다른 위치", (rows: any[]) => { rows[1].payload.item.cwd = "/different"; }, { cwdMatch: "different", contractTime: "after" }],
  ["위치 누락", (rows: any[]) => { delete rows[1].payload.item.cwd; }, { cwdMatch: "missing" }],
  ["계약 전", (rows: any[]) => { rows[1].timestamp = "2000-01-01T00:00:00Z"; }, { contractTime: "before" }],
  ["시각 누락", (rows: any[]) => { delete rows[1].timestamp; }, { contractTime: "unknown" }],
  ["실패 숫자", (rows: any[]) => { rows[1].payload.item.exit_code = 1; rows[1].payload.item.status = "failed"; }, { numericExit: 1, parsedExit: 1, completion: "failed" }],
  ["진행 중", (rows: any[]) => { rows[1].payload.type = "item_started"; rows[1].payload.item.status = "in_progress"; }, { resultObserved: false, pair: "missing_result", completion: "in_progress" }],
  ["숫자 없음", (rows: any[]) => { delete rows[1].payload.item.exit_code; }, { numericExit: null, parsedExit: null }],
  ["부가 인자", (rows: any[]) => { rows[1].payload.item.command[2] += " --help"; }, { commandMatch: false }],
] as const) test(`진단 후보: ${name}를 관찰하고 성공으로 재제출하지 않는다`, async () => {
  const s = await setup(), rows = codexRows(s); mutate(rows); put(s, rows);
  const d = await data(s); expect(d.events.candidates[0]).toMatchObject(want); expect(d.comparison.status).not.toBe("matched");
  expect(s.store.hasPassedCompletion(s.task, 1)).toBe(false);
});

test("진단: 미지원 response_item 형식은 관찰만 하고 기존 파서 성공으로 승격하지 않는다", async () => {
  const s = await setup(), rows = codexRows(s); rows[1].type = "response_item"; put(s, rows);
  const d = await data(s); expect(d.events.candidates[0]).toMatchObject({ parserSupported: false, parsedExit: null });
  expect(d.comparison.status).toBe("not_found");
});

test("진단: 미지원 함수 호출·결과의 짝은 내용 없이 관찰한다", async () => {
  const s = await setup(), rows = codexRows(s).slice(0, 1), at = new Date().toISOString();
  rows.push({ type: "response_item", timestamp: at, payload: { type: "function_call", name: "exec_command", call_id: "FAKE_CALL_PRIVATE", arguments: JSON.stringify({ cmd: command, workdir: s.member.cwd }) } });
  rows.push({ type: "response_item", timestamp: at, payload: { type: "function_call_output", call_id: "FAKE_CALL_PRIVATE", output: "FAKE_STDOUT_PRIVATE" } });
  put(s, rows); const d = await data(s);
  expect(d.events.candidates[0]).toMatchObject({ format: "codex_function_call", callObserved: true, resultObserved: true, pair: "paired", parserSupported: false, parsedExit: null });
  expect(d.comparison.status).toBe("not_found"); privateValuesAbsent(d, s);
});

test("진단: stdout 안 명령과 임의 이벤트 이름·대화는 반환하지 않는다", async () => {
  const s = await setup(), rows = codexRows(s); rows[1].payload.item.command = ["printf", "plain"]; rows[1].payload.item.aggregated_output = command;
  rows.push({ type: "FAKE_EVENT_PRIVATE", message: "FAKE_DIALOG_PRIVATE" }); put(s, rows);
  const d = await data(s); expect(d.events.candidates).toEqual([]); expect(d.comparison.status).toBe("not_found");
  privateValuesAbsent(d, s, "FAKE_EVENT_PRIVATE", "FAKE_DIALOG_PRIVATE");
});

test("진단: 최근 실패를 앞 성공으로 덮지 않는다", async () => {
  const s = await setup(), rows = codexRows(s), latest = structuredClone(rows[1]);
  latest.payload.item.id = "newer"; latest.payload.item.exit_code = 2; latest.payload.item.status = "failed"; rows.push(latest); put(s, rows);
  const d = await data(s); expect(d.comparison.status).toBe("not_passed"); expect(d.events.candidates.at(-1).numericExit).toBe(2);
});

test("진단: 끝 부분 JSON·잘못된 줄·진단 제한의 앞 잘림을 구분한다", async () => {
  const s = await setup(), rows = codexRows(s); put(s, rows, '{"type":"event_msg"');
  let d = await data(s); expect(d.read).toMatchObject({ complete: false, tail: "partial_or_invalid" });
  put(s, [rows[0]], "x".repeat(1048576 + 16) + "\n" + JSON.stringify(rows[1]) + "\n");
  d = await data(s); expect(d.read.headTruncated).toBe(true); expect(d.read.bytesRead).toBeLessThanOrEqual(1048576); expect(d.read.leadingFragmentDiscarded).toBe(true);
  put(s, rows, "invalid-json\n"); d = await data(s); expect(d.read.invalidLines).toBeGreaterThan(0);
});

test("진단: Claude 호출만 있거나 짝이 있거나 결과만 있는 모양을 구분한다", async () => {
  const s = await setup("claude"), path = transcriptPath(s.member.cwd, s.member.sessionId!, s.isolated.paths.claudeHome);
  mkdirSync(dirname(path), { recursive: true }); const at = new Date().toISOString();
  const call = { type: "assistant", timestamp: at, cwd: s.member.cwd, message: { content: [{ type: "tool_use", id: "FAKE_CALL_PRIVATE", name: "Bash", input: { command } }] } };
  writeFileSync(path, JSON.stringify(call) + "\n"); let d = await data(s); expect(d.events.candidates[0].pair).toBe("missing_result");
  const result = { type: "user", timestamp: at, message: { content: [{ type: "tool_result", tool_use_id: "FAKE_CALL_PRIVATE", is_error: false, content: "FAKE_STDOUT_PRIVATE" }] }, toolUseResult: { stdout: "", stderr: "", interrupted: false, returnCodeInterpretation: "Condition is false" } };
  appendFileSync(path, JSON.stringify(result) + "\n"); d = await data(s); expect(d.events.candidates[0]).toMatchObject({ pair: "paired", parsedExit: null, numericExit: null });
  writeFileSync(path, JSON.stringify(result) + "\n"); d = await data(s); expect(d.events.orphanResults).toBe(1); expect(d.events.candidates).toEqual([]);
});

test("진단 권한: 다른 직원·다른 프로젝트·다른 업무·검사 범위는 거절한다", async () => {
  const s = await setup(); put(s, codexRows(s));
  expect((await s.query(s.worker2)).isError).toBe(true);
  const p = s.store.createProject({ name: "다른 격리 프로젝트", cwd: s.member.cwd });
  const other = s.store.createMember({ projectId: p.id, handle: "lead", name: "다른 총괄", kind: "conductor", origin: "runner", backend: "core", status: "idle", cwd: s.member.cwd });
  expect((await s.query(other)).isError).toBe(true);
  const task = id(await s.tool(s.lead, "task", { title: "무관 업무", contract: ONE }));
  expect((await s.query(s.lead, { task_id: task })).isError).toBe(true);
  expect((await s.query(s.lead, { check_index: 1 })).isError).toBe(true);
});

for (const extra of [{ path: "/fake/secret" }, { session_id: "arbitrary" }, { member_id: "other" }, { command: "arbitrary" }, { raw: true }, { check_index: -1 }]) test(`진단 인자: 임의 범위 ${Object.keys(extra)[0]}를 거절한다`, async () => {
  const s = await setup(); expect((await s.query(s.member, extra)).isError).toBe(true);
});

test("진단 권한: 정상 통과 검사와 실행 검사가 아닌 항목은 조회 대상으로 받지 않는다", async () => {
  const s = await setup("claude"); writeExec(s.isolated.paths.claudeHome, s.member, command);
  const r = await s.tool(s.member, "post", { task_id: s.task, kind: "진행", title: "정상 검사", contract_rev: 1, checks: [{ name: "성공", kind: "behavior", result: "pass", evidence: "대조", command }] });
  expect((await s.query(s.member, { report_id: id(r, "cp") })).isError).toBe(true);
  const r2 = await s.tool(s.member, "post", { task_id: s.task, kind: "막힘", title: "실행 검사 밖", contract_rev: 1, checks: [{ name: "자료", kind: "real", result: "fail", evidence: "화면 미확인", command }] });
  expect((await s.query(s.member, { report_id: id(r2, "msg") })).isError).toBe(true);
});

for (const syntax of ["--token FAKE_SECRET_PRIVATE", "--user name:\u00a0FAKE_SECRET_PRIVATE", "-H 'Authorization: Be'\"arer FAKE_SECRET_PRIVATE\"", "--token 'FAKE_SECRET_PRIVATE" + "x".repeat(6000) + "'"]) test(`진단 비노출: 인증 표기 ${syntax.slice(0, 12)}`, async () => {
  const s = await setup("codex", command + " " + syntax); put(s, codexRows(s, command + " " + syntax));
  const d = await data(s, s.lead); privateValuesAbsent(d, s, "FAKE_SECRET_PRIVATE");
  expect(d.comparison).toMatchObject({ commandRedacted: true, status: "unavailable" });
});

test("진단 무변경: 조회와 거절은 계약·보고·근거·활동·제공자 원기록을 바꾸지 않는다", async () => {
  const s = await setup(), path = put(s, codexRows(s));
  const snapshot = () => {
    const names = (s.store.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(x => x.name);
    return JSON.stringify(names.map(n => [n, s.store.db.query(`SELECT * FROM "${n}"`).all()]));
  };
  const before = snapshot(), bytes = createHash("sha256").update(readFileSync(path)).digest("hex"), sent = JSON.stringify(s.runner.sent);
  await data(s); await s.query(s.worker2); await data(s, s.lead);
  expect(snapshot()).toBe(before); expect(JSON.stringify(s.runner.sent)).toBe(sent);
  expect(createHash("sha256").update(readFileSync(path)).digest("hex")).toBe(bytes);
});

test("진단: 미지원 이벤트가 앞 완료와 식별자가 같아도 파서 결과를 빌리지 않는다", async () => {
  const s = await setup(), rows = codexRows(s), other = structuredClone(rows[1]);
  other.type = "response_item"; rows.push(other); put(s, rows);
  const d = await data(s);
  expect(d.events.candidates.at(-1)).toMatchObject({ parserSupported: false, parsedExit: null, inCurrentParser: false });
});

test("진단: 후보 개수와 완료 없는 JSON 줄을 제한 범위로 정확히 표시한다", async () => {
  const s = await setup(), rows = codexRows(s);
  for (let i = 0; i < 30; i++) { const r = structuredClone(rows[1]); r.payload.item.id = `call-${i}`; rows.push(r); }
  put(s, rows); let d = await data(s);
  expect(d.events.candidates).toHaveLength(24); expect(d.events.omittedCandidates).toBe(7);
  const path = put(s, codexRows(s));
  writeFileSync(path, readFileSync(path, "utf8").trimEnd());
  d = await data(s); expect(d.read).toMatchObject({ tail: "valid_json_without_newline", complete: false });
});

test("진단: 선택된 파일이 제공자 폴더 밖을 가리키면 원문을 열지 않는다", async () => {
  const s = await setup("claude");
  const { symlinkSync } = await import("node:fs");
  const outside = join(s.member.cwd, "outside-fake.jsonl"); writeFileSync(outside, "FAKE_OUTSIDE_PRIVATE");
  const path = transcriptPath(s.member.cwd, s.member.sessionId!, s.isolated.paths.claudeHome);
  mkdirSync(dirname(path), { recursive: true }); symlinkSync(outside, path);
  const d = await data(s); expect(d.comparison.status).toBe("unreadable"); privateValuesAbsent(d, s, "FAKE_OUTSIDE_PRIVATE");
});

test("진단: 앞 경계 없는 잘린 한 줄을 완전한 JSON 이벤트로 만들지 않는다", async () => {
  const s = await setup(), rows = codexRows(s);
  put(s, [rows[0]], "invalid-prefix" + " ".repeat(1048576) + JSON.stringify(rows[1]));
  const d = await data(s);
  expect(d.read).toMatchObject({ headTruncated: true, complete: false, tail: "fragment_without_boundary" });
  expect(d.events.candidates).toEqual([]); expect(d.comparison.status).toBe("not_found");
});

test("진단 MCP 작업 경계: 공통 응답 보관 외에는 상태가 같고 같은 operation은 원응답을 돌려준다", async () => {
  const s = await setup(), path = put(s, codexRows(s));
  const domain = () => JSON.stringify((s.store.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'agent_operation_receipts' ORDER BY name").all() as {name:string}[]).map(({name}) => [name, s.store.db.query(`SELECT * FROM "${name}"`).all()]));
  const before = domain(), raw = readFileSync(path, "utf8"), sent = JSON.stringify(s.runner.sent);
  const context = { operationId: "diagnostic-fake-operation" };
  const first = await s.orch.handleAgentOperation(s.member, "exec_diagnose", s.args, context);
  observed.push({ operation: "MCP 작업 경계", request: s.args, response: first });
  expect(first.isError).toBeUndefined();
  expect(await s.orch.handleAgentOperation(s.member, "exec_diagnose", s.args, context)).toEqual(first);
  expect(domain()).toBe(before); expect(readFileSync(path, "utf8")).toBe(raw); expect(JSON.stringify(s.runner.sent)).toBe(sent);
  const receipts = s.store.db.query("SELECT * FROM agent_operation_receipts").all();
  expect(receipts).toHaveLength(1);
  expect((receipts[0] as { state: string }).state).toBe("completed");
  privateValuesAbsent(receipts.map(row => {
    const r = row as { request_json: unknown; result_json: unknown };
    return { ...r, request_json: decodeStoredText(r.request_json), result_json: decodeStoredText(r.result_json) };
  }), s);
});

test("진단 도구 목록은 세 범위 인자만 공개하고 자유 경로를 허용하지 않는다", async () => {
  const s = await setup();
  for (const caller of [s.member, s.lead]) {
    const definition = listAgentTools(caller).find(t => t.name === "exec_diagnose")!;
    expect(definition).toBeDefined();
    expect(definition.inputSchema).toMatchObject({ type: "object", additionalProperties: false, required: ["task_id", "report_id", "check_index"] });
    expect(Object.keys(definition.inputSchema.properties as object)).toEqual(["task_id", "report_id", "check_index"]);
  }
});

test("진단: 사용자 도구 이벤트 종류는 세되 그 스크립트와 출력에서 명령을 추측하지 않는다", async () => {
  const s = await setup(), rows = codexRows(s).slice(0, 1);
  rows.push({ type: "response_item", payload: { type: "custom_tool_call", name: "FAKE_TOOL_PRIVATE", call_id: "FAKE_CALL_PRIVATE", input: "FAKE_SCRIPT_PRIVATE " + command } });
  rows.push({ type: "response_item", payload: { type: "custom_tool_call_output", call_id: "FAKE_CALL_PRIVATE", output: "FAKE_STDOUT_PRIVATE" } });
  put(s, rows); const d = await data(s);
  expect(d.events.kinds).toMatchObject({ codex_custom_call: 1, codex_custom_result: 1 });
  expect(d.events.candidates).toEqual([]); expect(d.comparison.status).toBe("not_found");
  privateValuesAbsent(d, s, "FAKE_TOOL_PRIVATE", "FAKE_SCRIPT_PRIVATE");
});

test("진단 짝: 완료 이벤트를 반복해도 별도 호출과 결과의 짝으로 표시하지 않는다", async () => {
  const s = await setup(), rows = codexRows(s); rows.push(structuredClone(rows[1])); put(s, rows);
  expect((await data(s)).events.candidates[0].pair).toBe("combined");
});

test("진단 짝: 명령 없는 완료만 있으면 해당 호출로 연결하지 않고 결과 누락 원인으로 센다", async () => {
  const s = await setup(), rows = codexRows(s); delete rows[1].payload.item.command; put(s, rows);
  const d = await data(s); expect(d.events.candidates).toEqual([]); expect(d.events.orphanResults).toBe(1);
  const start = codexRows(s)[1]; start.payload.type = "item_started"; start.payload.item.status = "in_progress";
  // 정상 순서 대조군: 새로 만든 시작의 시각이 앞서 만든 결과보다 늦어지지 않게 고정한다.
  start.timestamp = rows[1].timestamp;
  put(s, [rows[0], start, rows[1]]);
  expect((await data(s)).events.candidates[0]).toMatchObject({ pair: "paired", parsedExit: null, inCurrentParser: false });
});
