// 알려진 이벤트 분기마다 관찰해야 할 짝 행동을 실제 도구 응답으로 검사한다.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fixture } from "./fixtures/harness-fixture.ts";
import { transcriptPath } from "../server/runner/transcript.ts";
type Family = "command" | "exec" | "function" | "claude";
type Fields = { at?: string | null; command?: string; cwd?: string };
const wanted = "git rev-parse HEAD", observations: unknown[] = [];
afterAll(() => {
  const p = join(import.meta.dir, "../.pumasi/diagnostic-pairing-20261115/evidence/pairing-observations.json");
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ syntheticOnly: true, liveDiagnosisExecuted: false, observations }, null, 2));
});
async function setup(family: Family) {
  const f = fixture(), cli = family === "claude" ? "claude" : "codex";
  const member = f.make("paired", "가짜 짝 관찰", "worker", cli);
  const task = (await f.tool(f.lead, "task", { title: "분기별 짝 관찰", contract: { kind: "coding", goal: "관찰한 짝만 표시한다", acceptance: ["모호함과 정상군을 구분"], checks: ["behavior"] } })).text.match(/#(tk_[\w-]+)/)![1]!;
  const report = (await f.tool(member, "post", { task_id: task, kind: "막힘", title: "가짜 실패 검사", contract_rev: 1, checks: [{ kind: "behavior", name: "대조", result: "fail", criterion: 1, command: wanted, evidence: "가짜 대조" }] })).text.match(/#(msg_[\w-]+)/)![1]!;
  const args = { task_id: task, report_id: report, check_index: 0 };
  const at = new Date(Date.now() + 20).toISOString(), later = new Date(Date.now() + 40).toISOString();
  const event = (begin: boolean, fields: Fields = {}) => {
    const timestamp = fields.at === undefined ? begin ? at : later : fields.at;
    const command = fields.command ?? wanted, cwd = fields.cwd ?? member.cwd;
    if (family === "command") return { type: "event_msg", timestamp, payload: { type: begin ? "item_started" : "item_completed", thread_id: member.sessionId, item: { id: "FAKE_ITEM", type: "CommandExecution", command, cwd, status: begin ? "in_progress" : "completed", ...(begin ? {} : { exit_code: 0 }) } } };
    if (family === "exec") return { type: "event_msg", timestamp, payload: { type: begin ? "exec_command_begin" : "exec_command_end", call_id: "FAKE_EXEC", command, cwd, ...(begin ? {} : { exit_code: 0 }) } };
    if (family === "function") return { type: "response_item", timestamp, payload: begin ? { type: "function_call", name: "exec_command", call_id: "FAKE_FUNCTION", arguments: JSON.stringify({ cmd: command, workdir: cwd }) } : { type: "function_call_output", call_id: "FAKE_FUNCTION", output: "FAKE_OUTPUT_PRIVATE" } };
    return begin ? { type: "assistant", timestamp, cwd, message: { content: [{ type: "tool_use", id: "FAKE_BASH", name: "Bash", input: { command } }] } }
      : { type: "user", timestamp, message: { content: [{ type: "tool_result", tool_use_id: "FAKE_BASH", content: "FAKE_OUTPUT_PRIVATE", is_error: false }] }, toolUseResult: { stdout: "", stderr: "", interrupted: false, exitCode: 0 } };
  };
  const query = async (label: string, rows: unknown[]) => {
    const path = cli === "codex" ? join(f.isolated.paths.codexHome, "sessions/fake/rollout-pairing.jsonl") : transcriptPath(member.cwd, member.sessionId!, f.isolated.paths.claudeHome);
    mkdirSync(dirname(path), { recursive: true });
    const meta = { type: "session_meta", payload: { id: member.sessionId, cwd: member.cwd } };
    writeFileSync(path, [...(cli === "codex" ? [meta] : []), ...rows].map(v => JSON.stringify(v)).join("\n") + "\n");
    const response = await f.tool(member, "exec_diagnose", args);
    expect(response.isError).toBeUndefined(); const d = JSON.parse(response.text);
    expect(JSON.stringify(d)).not.toContain("FAKE_OUTPUT_PRIVATE");
    observations.push({ label: family + ":" + label, args, rows, response, data: d }); return d;
  };
  return { ...f, member, event, query, at, later };
}
for (const family of ["command", "exec", "function", "claude"] as const) {
  test(`${family}: 실제 시작→결과는 시작 시각과 정상 짝을 보존한다`, async () => {
    const s = await setup(family), d = await s.query("valid", [s.event(true), s.event(false)]);
    expect(d.events.candidates[0]).toMatchObject({ pair: "paired", startObserved: true, callObserved: true, callAt: s.at, resultAt: s.later, identityAmbiguous: false });
  });
  test(`${family}: 시작만 있으면 결과를 만들지 않는다`, async () => {
    const s = await setup(family), d = await s.query("start-only", [s.event(true)]);
    expect(d.events.candidates[0]).toMatchObject({ pair: "missing_result", startObserved: true, resultObserved: false, callAt: s.at, resultAt: null });
  });
  test(`${family}: 결과만 있으면 별도 시작을 만들지 않는다`, async () => {
    const s = await setup(family), d = await s.query("result-only", [s.event(false)]);
    if (family === "command") expect(d.events.candidates[0]).toMatchObject({ pair: "combined", startObserved: false, callAt: null, resultObserved: true, parsedExit: 0 });
    else if (family === "exec") expect(d.events.candidates[0]).toMatchObject({ pair: "missing_call", startObserved: false, callAt: null, resultObserved: true });
    else expect(d.events.candidates).toEqual([]);
    expect(d.events.orphanResults).toBe(family === "command" ? 0 : 1);
  });
  for (const part of ["start", "result"]) test(`${family}: ${part} 시각이 없어도 관찰 유무와 나눈다`, async () => {
    const s = await setup(family), d = await s.query("missing-time-" + part, [s.event(true, part === "start" ? { at: null } : {}), s.event(false, part === "result" ? { at: null } : {})]);
    expect(d.events.candidates[0]).toMatchObject({ pair: "paired", startObserved: true, resultObserved: true, contractTime: "unknown", ...(part === "start" ? { callAt: null } : { resultAt: null }) });
  });
  for (const part of ["start", "result"]) test(`${family}: ${part} 중복은 확정 짝이 아니다`, async () => {
    const s = await setup(family), begin = s.event(true), end = s.event(false);
    const d = await s.query("duplicate-" + part, part === "start" ? [begin, begin, end] : [begin, end, end]);
    expect(d.events.candidates[0]).toMatchObject({ pair: "ambiguous", duplicateReference: true, identityAmbiguous: true, completion: "unknown", callAt: null });
  });
  test(`${family}: 결과 뒤 시작은 정상 짝으로 소급하지 않는다`, async () => {
    const s = await setup(family), d = await s.query("reversed-lines", [s.event(false), s.event(true)]);
    expect(d.events.candidates[0]).toMatchObject({ pair: "ambiguous", startObserved: true, identityAmbiguous: true, completion: "unknown" });
  });
  test(`${family}: 결과의 시각이 시작보다 앞서면 모호함을 표시한다`, async () => {
    const s = await setup(family), d = await s.query("reversed-time", [s.event(true, { at: s.later }), s.event(false, { at: s.at })]);
    expect(d.events.candidates[0]).toMatchObject({ pair: "ambiguous", identityAmbiguous: true, completion: "unknown" });
  });
}
for (const family of ["command", "exec"] as const) for (const field of ["command", "cwd"] as const) test(`${family}: 시작/결과의 ${field} 상충을 숨기지 않는다`, async () => {
  const s = await setup(family), fields = field === "command" ? { command: "printf other" } : { cwd: "/fake/other" };
  const d = await s.query("conflicting-" + field, [s.event(true, fields), s.event(false)]);
  expect(d.events.candidates[0]).toMatchObject({ pair: "ambiguous", identityAmbiguous: true, completion: "unknown" });
});
for (const family of ["command", "exec"] as const) for (const field of ["command", "cwd"] as const) test(`${family}: 대상 시작 뒤 결과의 ${field}가 달라도 모호한 후보를 보존한다`, async () => {
  const s = await setup(family), fields = field === "command" ? { command: "printf other" } : { cwd: "/fake/other" };
  const d = await s.query("conflicting-result-" + field, [s.event(true), s.event(false, fields)]);
  expect(d.events.candidates[0]).toMatchObject({ pair: "ambiguous", identityAmbiguous: true, completion: "unknown" });
});
test("CommandExecution: 시각 없는 단독 통합 완료도 별도 시작과 구분한다", async () => {
  const s = await setup("command"), d = await s.query("combined-missing-time", [s.event(false, { at: null })]);
  expect(d.events.candidates[0]).toMatchObject({ pair: "combined", startObserved: false, callAt: null, contractTime: "unknown" });
});
test("CommandExecution: 반복 통합 완료는 별도 짝이 아니며 중복 모호함을 알린다", async () => {
  const s = await setup("command"), end = s.event(false), d = await s.query("duplicate-combined", [end, end]);
  expect(d.events.candidates[0]).toMatchObject({ pair: "combined", startObserved: false, duplicateReference: true, identityAmbiguous: true, callAt: null });
});
test("CommandExecution: 완료와 시작이 다른 ID면 연결하지 않는다", async () => {
  const s = await setup("command"), end: any = s.event(false); end.payload.item.id = "FAKE_OTHER_ID";
  const d = await s.query("different-ids", [s.event(true), end]);
  expect(d.events.candidates).toHaveLength(2);
  expect(d.events.candidates.map((c: any) => c.pair)).toEqual(["missing_result", "combined"]);
});
test("종류만 관찰: Codex MCP와 사용자 도구는 본문에서 실행을 추측하지 않는다", async () => {
  const s = await setup("command"), d = await s.query("count-only", [
    { type: "event_msg", timestamp: s.at, payload: { type: "item_completed", item: { type: "McpToolCall", id: "FAKE_MCP", result: { content: [{ type: "text", text: wanted }] } } } },
    { type: "response_item", payload: { type: "custom_tool_call", call_id: "FAKE_CUSTOM", input: wanted } },
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "FAKE_CUSTOM", output: wanted } }]);
  expect(d.events.candidates).toEqual([]); expect(d.events.kinds).toMatchObject({ codex_mcp_item: 1, codex_custom_call: 1, codex_custom_result: 1 });
  expect(d.comparison.status).toBe("not_found");
});
test("종류만 관찰: Claude 비Bash/MCP 도구는 실행 후보가 아니다", async () => {
  const s = await setup("claude"), begin: any = s.event(true); begin.message.content[0].name = "mcp__fake__tool";
  const d = await s.query("non-bash", [begin, s.event(false)]);
  expect(d.events.candidates).toEqual([]); expect(d.events.kinds).toMatchObject({ claude_assistant: 1, claude_user: 1 });
  expect(d.comparison.status).toBe("not_found");
});
for (const family of ["claude", "function"] as const) for (const field of ["command", "cwd"] as const) for (const targetFirst of [true, false]) test(`${family}: 서로 다른 ${field}의 반복 호출은 대상이 ${targetFirst ? "먼저" : "나중"}여도 모호함을 남긴다`, async () => {
  const s = await setup(family), fields = field === "command" ? { command: "printf other" } : { cwd: "/fake/other" };
  const target = s.event(true), different = s.event(true, fields);
  const d = await s.query("conflicting-calls-" + field + targetFirst, [...(targetFirst ? [target, different] : [different, target]), s.event(false)]);
  expect(d.events.candidates[0]).toMatchObject({ pair: "ambiguous", duplicateReference: true, identityAmbiguous: true, completion: "unknown" });
});
for (const family of ["claude", "function"] as const) test(`${family}: 같은 ID의 미지원 도구 시작도 유일한 실행 짝으로 숨기지 않는다`, async () => {
  const s = await setup(family), other: any = s.event(true);
  if (family === "claude") other.message.content[0].name = "mcp__fake__tool";
  else other.payload.name = "mcp__fake__tool";
  const d = await s.query("unknown-tool-same-id", [s.event(true), other, s.event(false)]);
  expect(d.events.candidates[0]).toMatchObject({ pair: "ambiguous", duplicateReference: true, identityAmbiguous: true, completion: "unknown" });
});
