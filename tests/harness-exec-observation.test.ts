// 독립 반례에 대응하는 추가 영구 회귀. 가짜 기록의 실제 도구 응답만 검사한다.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fixture } from "./fixtures/harness-fixture.ts";
import { transcriptPath } from "../server/runner/transcript.ts";
const observations: unknown[] = [];
afterAll(() => {
  const p = join(import.meta.dir, "../.pumasi/diagnostic-remediation-20261115/evidence/extensions-current.json");
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ syntheticOnly: true, liveDiagnosisExecuted: false, observations }, null, 2));
});
const wanted = "git rev-parse HEAD", id = (r: {text:string}, prefix = "tk") => r.text.match(new RegExp(`#(${prefix}_[\\w-]+)`))![1]!;
async function setup(cli: "codex" | "claude" = "codex") {
  const f = fixture(), member = f.make("observed", "가짜 관찰", "worker", cli);
  const task = id(await f.tool(f.lead, "task", { title: "관찰 회귀", contract: { kind: "coding", goal: "관찰을 정확히 표시한다", acceptance: ["관찰 오류가 없다"], checks: ["behavior"] } }));
  const report = id(await f.tool(member, "post", { task_id: task, kind: "막힘", title: "가짜 실패 검사", contract_rev: 1,
    checks: [{ name: "실행", kind: "behavior", result: "fail", evidence: "대조 불가", command: wanted, criterion: 1 }] }), "msg");
  const args = { task_id: task, report_id: report, check_index: 0 };
  const at = new Date(Date.now() + 10).toISOString(), later = new Date(Date.now() + 20).toISOString();
  const event = (type: string, fields: Record<string, unknown> = {}) => ({ type: "event_msg", timestamp: type.endsWith("end") ? later : at,
    payload: { type, call_id: "FAKE_SHARED_ID", cwd: member.cwd, ...fields } });
  const path = cli === "codex" ? join(f.isolated.paths.codexHome, "sessions", "fake", "rollout-observation.jsonl") : transcriptPath(member.cwd, member.sessionId!, f.isolated.paths.claudeHome);
  const query = async (label: string, rows: unknown[]) => {
    mkdirSync(dirname(path), { recursive: true });
    const meta = { type: "session_meta", timestamp: at, payload: { id: member.sessionId, cwd: member.cwd } };
    writeFileSync(path, [...(cli === "codex" ? [meta] : []), ...rows].map(x => JSON.stringify(x)).join("\n") + "\n");
    const response = await f.tool(member, "exec_diagnose", args);
    expect(response.isError).toBeUndefined(); const data = JSON.parse(response.text);
    observations.push({ label, args, rows, response }); return data;
  };
  return { ...f, member, task, at, later, event, query, args };
}

test("D1 추가: 종료에 명령이 있어도 실제 시작과 시작시각은 만들지 않는다", async () => {
  const s = await setup(), d = await s.query("end-with-command-only", [s.event("exec_command_end", { command: ["git", "rev-parse", "HEAD"], exit_code: 0 })]);
  expect(d.events.candidates[0]).toMatchObject({ callObserved: false, callAt: null, resultObserved: true, pair: "missing_call", numericExit: 0, parserSupported: false });
  expect(d.events.orphanResults).toBe(1);
});
test("D1 추가: 실제 서로 다른 시작·종료 시각을 보존한다", async () => {
  const s = await setup(), d = await s.query("real-begin-end", [s.event("exec_command_begin", { command: wanted }), s.event("exec_command_end", { exit_code: 0 })]);
  expect(d.events.candidates[0]).toMatchObject({ callObserved: true, resultObserved: true, callAt: s.at, resultAt: s.later, pair: "paired" });
});
for (const variant of ["command", "cwd", "identical"]) test(`D1 추가: 중복 시작의 ${variant}는 확정 짝이 아니다`, async () => {
  const s = await setup(), second = { command: variant === "command" ? "printf other" : wanted, ...(variant === "cwd" ? { cwd: "/fake/other" } : {}) };
  const d = await s.query(`duplicate-begin-${variant}`, [s.event("exec_command_begin", { command: wanted }), s.event("exec_command_begin", second), s.event("exec_command_end", { exit_code: 0 })]);
  expect(d.events.candidates[0]).toMatchObject({ pair: "ambiguous", duplicateReference: true, identityAmbiguous: true, callAt: null });
});
for (const variant of ["command", "cwd"]) test(`D1 추가: 결과의 ${variant}가 시작과 다르면 모호함을 남긴다`, async () => {
  const s = await setup(), end = { exit_code: 0, ...(variant === "command" ? { command: "printf other" } : { cwd: "/fake/other" }) };
  const d = await s.query(`conflicting-end-${variant}`, [s.event("exec_command_begin", { command: wanted }), s.event("exec_command_end", end)]);
  expect(d.events.candidates[0]).toMatchObject({ pair: "ambiguous", identityAmbiguous: true, callAt: null });
});
test("D1 추가: 결과 뒤에 나타난 시작은 정상 짝으로 소급하지 않는다", async () => {
  const s = await setup(), d = await s.query("end-before-begin", [s.event("exec_command_end", { command: wanted, exit_code: 0 }), s.event("exec_command_begin", { command: wanted })]);
  expect(d.events.candidates[0]).toMatchObject({ pair: "ambiguous", identityAmbiguous: true });
});

function completed(s: Awaited<ReturnType<typeof setup>>, timestamp: string, fields: Record<string, unknown> = {}) {
  return { type: "event_msg", timestamp, payload: { type: "item_completed", thread_id: s.member.sessionId,
    item: { id: "FAKE_COMPLETION_ID", type: "CommandExecution", command: ["git", "rev-parse", "HEAD"], cwd: s.member.cwd, status: "completed", exit_code: 0, ...fields } } };
}
test("D2 추가: 계약 뒤→전의 동일 ID는 마지막 후보 행 자체로 포함 여부를 판단한다", async () => {
  const s = await setup(), d = await s.query("duplicate-after-before", [completed(s, s.at), completed(s, "2000-01-01T00:00:00Z")]);
  expect(d.events.candidates[0]).toMatchObject({ contractTime: "before", inCurrentParser: false, duplicateReference: true, identityAmbiguous: true });
});
test("D2 정상군: 순서를 바꾸어 마지막 행이 계약 뒤면 그 행의 포함을 보존한다", async () => {
  const s = await setup(), d = await s.query("duplicate-before-after", [completed(s, "2000-01-01T00:00:00Z"), completed(s, s.at)]);
  expect(d.events.candidates[0]).toMatchObject({ contractTime: "after", inCurrentParser: true, duplicateReference: true, identityAmbiguous: true });
});
test("D2 추가: 동일 내용·시각·ID인 다른 행도 이벤트 지문과 중복 표시로 나눈다", async () => {
  const s = await setup(), row = completed(s, s.at), one = await s.query("one-completion", [row]), two = await s.query("same-tuple-other-line", [row, row]);
  expect(two.events.candidates[0]).toMatchObject({ duplicateReference: true, identityAmbiguous: true, inCurrentParser: true });
  expect(two.events.candidates[0].ref).not.toBe(one.events.candidates[0].ref);
});
test("D2 추가: 같은 ID의 명령·위치가 다른 행은 다른 행의 관찰값을 받지 않는다", async () => {
  const s = await setup(), d = await s.query("different-cwd-before", [completed(s, s.at), completed(s, "2000-01-01T00:00:00Z", { cwd: "/fake/elsewhere" })]);
  expect(d.events.candidates[0]).toMatchObject({ cwdMatch: "different", contractTime: "before", inCurrentParser: false, duplicateReference: true });
});

function claudeRows(s: Awaited<ReturnType<typeof setup>>, result: Record<string, unknown>, item: Record<string, unknown> = {}) {
  return [{ type: "assistant", timestamp: s.at, cwd: s.member.cwd, message: { content: [{ type: "tool_use", id: "FAKE_NUMERIC_CALL", name: "Bash", input: { command: wanted } }] } },
    { type: "user", timestamp: s.later, message: { content: [{ type: "tool_result", tool_use_id: "FAKE_NUMERIC_CALL", is_error: false, content: "", ...item }] }, toolUseResult: { stdout: "", stderr: "", interrupted: false, ...result } }];
}
for (const [label, result, item, status, count, exit, parsed] of [
  ["없음과 구조추정", {}, {}, "absent", 0, null, 0],
  ["단일 결과0", { exitCode: 0 }, {}, "consistent", 1, 0, 0],
  ["결과 필드 둘의 일치", { exitCode: 0, exit_code: 0 }, {}, "consistent", 2, 0, 0],
  ["도구 결과 단일0", {}, { exit_code: 0 }, "consistent", 1, 0, 0],
  ["네 위치의 일치", { exitCode: 0, exit_code: 0 }, { exitCode: 0, exit_code: 0 }, "consistent", 4, 0, 0],
  ["결과 안 충돌", { exitCode: 0, exit_code: 1 }, {}, "conflict", 2, null, null],
  ["도구 결과와 충돌", { exitCode: 0 }, { exit_code: 1 }, "conflict", 2, null, null],
  ["네 위치의 충돌", { exitCode: 0, exit_code: 0 }, { exitCode: 0, exit_code: 1 }, "conflict", 4, null, null],
] as const) test(`D3 숫자 관찰: ${label}를 구분한다`, async () => {
  const s = await setup("claude"), d = await s.query(`numeric-${label}`, claudeRows(s, result, item));
  expect(d.events.candidates[0]).toMatchObject({ numericExit: exit, parsedExit: parsed, numericObservation: { status, fieldCount: count } });
});
for (const bad of [null, "FAKE_NUMERIC_SECRET", -1, 0.5, 256]) test(`D3 숫자 관찰: 유효하지 않은 ${typeof bad} 값이 정상0을 가리지 않는다`, async () => {
  const s = await setup("claude"), d = await s.query("invalid-numeric-with-zero", claudeRows(s, { exitCode: 0, exit_code: bad }));
  expect(d.events.candidates[0]).toMatchObject({ numericExit: null, numericObservation: { status: "invalid", fieldCount: 2, invalidCount: 1 } });
  expect(JSON.stringify(d)).not.toContain("FAKE_NUMERIC_SECRET");
});
test("D3 숫자 관찰: 충돌과 잘못된 값이 함께 있으면 두 관찰을 모두 남긴다", async () => {
  const s = await setup("claude"), d = await s.query("invalid-and-conflict", claudeRows(s, { exitCode: 0, exit_code: 1 }, { exitCode: "FAKE_NUMERIC_SECRET" }));
  expect(d.events.candidates[0]).toMatchObject({ numericExit: null, numericObservation: { status: "invalid", fieldCount: 3, invalidCount: 1, hasConflict: true } });
});

test("D1 추가: Claude의 같은 ID 시작 반복도 확정 짝으로 묶지 않는다", async () => {
  const s = await setup("claude"), rows = claudeRows(s, { exitCode: 0 });
  const d = await s.query("duplicate-claude-call", [rows[0], rows[0], rows[1]]);
  expect(d.events.candidates[0]).toMatchObject({ pair: "ambiguous", duplicateReference: true, identityAmbiguous: true, callAt: null });
});
test("D1 추가: 미지원 함수 호출도 같은 ID 시작 반복이면 확정 짝이 아니다", async () => {
  const s = await setup(), call = { type: "response_item", timestamp: s.at, payload: { type: "function_call", name: "exec_command", call_id: "FAKE_FUNCTION_ID", arguments: JSON.stringify({ cmd: wanted, workdir: s.member.cwd }) } };
  const result = { type: "response_item", timestamp: s.later, payload: { type: "function_call_output", call_id: "FAKE_FUNCTION_ID", output: "FAKE_ONLY" } };
  const d = await s.query("duplicate-function-call", [call, call, result]);
  expect(d.events.candidates[0]).toMatchObject({ pair: "ambiguous", duplicateReference: true, identityAmbiguous: true, callAt: null });
});

test("공통 요청 보관: 거절된 임의 입력은 기존대로 보관하되 오류 응답에는 내보내지 않는다", async () => {
  const s = await setup(), marker = "FAKE_REQUEST_ONLY_AUTH", args = { ...s.args, path: "/fake/" + marker };
  const response = await s.orch.handleAgentOperation(s.member, "exec_diagnose", args, { operationId: "remediation-rejected-request" });
  expect(response.isError).toBe(true); expect(JSON.stringify(response)).not.toContain(marker);
  const rows = s.store.db.query("SELECT request_json, result_json FROM agent_operation_receipts").all() as { request_json: string; result_json: string }[];
  expect(rows).toHaveLength(1); expect(rows.every(r => r.request_json.includes(marker))).toBe(true);
  expect(rows.every(r => !r.result_json.includes(marker))).toBe(true);
  observations.push({ label: "preexisting-request-retention", args, response, rawRequestRetained: true });
});
