// Counterfactual fixtures only. These do not represent the secretary's unknown native event shape.
// Exercise the real post path without touching live sessions or injecting live evidence.
import { test, expect } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "./fixtures/harness-fixture.ts";

const command = "git rev-parse HEAD";
const contract = { kind: "coding", goal: "Codex evidence baseline", acceptance: ["only current successful execution is evidence"], checks: ["behavior"] };
const taskId = (reply: { text: string }) => reply.text.match(/#(tk_[\w-]+)/)![1]!;
const observed: Array<{ name: string; response: unknown }> = [];

async function scenario(name: string, mutate: (rows: any[], f: ReturnType<typeof fixture>) => void = () => {}) {
  const f = fixture(), member = f.make("codex", "Isolated Codex", "worker", "codex");
  const task = taskId(await f.tool(f.lead, "task", { title: name, contract }));
  const at = new Date().toISOString();
  const rows: any[] = [
    { type: "session_meta", timestamp: at, payload: { id: member.sessionId, cwd: member.cwd, originator: "codex_cli_rs" } },
    { type: "event_msg", timestamp: at, payload: { type: "item_completed", thread_id: member.sessionId,
      item: { id: "isolated-command", type: "CommandExecution", command: ["/bin/zsh", "-lc", command], cwd: member.cwd, status: "completed", exit_code: 0, aggregated_output: "fake-commit\n" } } },
  ];
  mutate(rows, f);
  const folder = join(f.isolated.paths.codexHome, "sessions", "isolated");
  mkdirSync(folder, { recursive: true });
  const path = join(folder, "rollout-fixture.jsonl");
  writeFileSync(path, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const response = await f.tool(member, "post", { task_id: task, kind: "완료", title: "Isolated evidence result", contract_rev: 1,
    checks: [{ name: "command", kind: "behavior", result: "pass", evidence: "Explicitly synthetic fixture", command, criterion: 1 }] });
  observed.push({ name, response });
  return { f, member, task, rows, path, response };
}

test("given command/cwd/exit 0 is accepted through post when the supported Codex event exists", async () => {
  const s = await scenario("supported success");
  expect(s.response.isError).toBeUndefined();
  const trace = s.f.orch.taskTrace(s.member, s.task) as any;
  expect(trace.currentCompletion.eligible).toBe(true);
  expect(trace.reports[0].checks[0]).toMatchObject({ exec: "matched", exit: 0, command });
});

test("native session selection rejects another session", async () => {
  const s = await scenario("wrong session", rows => { rows[0].payload.id = "different-session"; });
  expect(s.response.isError).toBe(true);
  expect(s.response.text).toContain("log_not_found");
});

test("native session selection rejects a different metadata cwd", async () => {
  const s = await scenario("wrong metadata cwd", rows => { rows[0].payload.cwd = "/different/work"; });
  expect(s.response.isError).toBe(true);
  expect(s.response.text).toContain("log_not_found");
});

for (const [name, change] of [
  ["different execution cwd", (rows: any[]) => { rows[1].payload.item.cwd = "/different/work"; }],
  ["unknown execution cwd", (rows: any[]) => { delete rows[1].payload.item.cwd; }],
  ["before current contract", (rows: any[]) => { rows[1].timestamp = "2000-01-01T00:00:00.000Z"; }],
  ["nonzero completion", (rows: any[]) => { rows[1].payload.item.exit_code = 2; rows[1].payload.item.status = "failed"; }],
  ["unfinished execution", (rows: any[]) => { rows[1].payload.item.status = "in_progress"; }],
  ["command only in stdout", (rows: any[]) => { rows[1].payload.item.command = ["/bin/zsh", "-lc", "printf fixture"]; rows[1].payload.item.aggregated_output = command; }],
  ["hypothetical unsupported event shape", (rows: any[]) => { rows[1].type = "response_item"; }],
] as const) test(`post refuses ${name}`, async () => {
  const s = await scenario(name, change);
  expect(s.response.isError).toBe(true);
  expect((s.f.orch.taskTrace(s.member, s.task) as any).currentCompletion.eligible).toBe(false);
});

test("a later failed invocation is not replaced by an earlier successful invocation", async () => {
  const s = await scenario("initial success");
  const newer = { ...s.rows[1], timestamp: new Date().toISOString(), payload: { ...s.rows[1].payload,
    item: { ...s.rows[1].payload.item, id: "later-failure", status: "failed", exit_code: 1 } } };
  appendFileSync(s.path, JSON.stringify(newer) + "\n");
  const response = await s.f.tool(s.member, "post", { task_id: s.task, kind: "완료", title: "Later failure", contract_rev: 1,
    checks: [{ name: "command", kind: "behavior", result: "pass", evidence: "Synthetic later failure", command, criterion: 1 }] });
  observed.push({ name: "later failure", response });
  expect(response.isError).toBe(true);
  expect(response.text).toContain("종료 코드 1");
});

test("a matching execution cannot be borrowed by another task", async () => {
  const s = await scenario("first task");
  const other = taskId(await s.f.tool(s.f.lead, "task", { title: "Other task", contract }));
  const response = await s.f.tool(s.member, "post", { task_id: other, kind: "완료", title: "Borrowed execution", contract_rev: 1,
    checks: [{ name: "command", kind: "behavior", result: "pass", evidence: "Synthetic other-task counterexample", command, criterion: 1 }] });
  observed.push({ name: "other task", response });
  expect(response.isError).toBe(true);
});

test("save only isolated post responses for review", () => {
  const path = process.env.IAMCEO_DIAGNOSTIC_RESPONSE_FILE ?? join(import.meta.dir, "../.pumasi/evidence/diagnostic-responses.json");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({ syntheticOnly: true, liveSecretaryEventRead: false, responses: observed }, null, 2));
  expect(observed.length).toBeGreaterThanOrEqual(10);
});
