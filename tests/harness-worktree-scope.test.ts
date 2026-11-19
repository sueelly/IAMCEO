import { releaseTestDir, testTempDir } from "./fixtures/test-run-dirs";
import { expect, test } from "bun:test";
import { matchExecChecks, parseCodexLog } from "../server/harness-evidence.ts";

const root = "/repo/.worktrees/editor";
const since = "2026-11-17T16:00:00.000Z";
const check = { name: "typecheck", kind: "typecheck" as const, result: "pass" as const, command: "npm run typecheck", evidence: "0 errors" };
function log(cwd: unknown, exit_code = 0, command = check.command, timestamp = "2026-11-17T18:00:00.000Z") {
  return JSON.stringify({ type: "event_msg", timestamp, payload: { type: "item_completed", thread_id: "session", item: { type: "CommandExecution", id: "exec", command, cwd, status: "completed", exit_code, aggregated_output: "checked" } } });
}
function match(text: string, used: (ref: string) => string | null = () => null, worktree: string | null = root) {
  return matchExecChecks([check], { status: "ok", code: "ok", ...parseCodexLog(text, since) }, used, "/repo/main", worktree);
}

test.each([root, root + "/app", root + "/한글 폴더", "file://" + root, "file://" + root + "/app", "file://localhost" + root + "/app"])("accepts verified execution in the registered task worktree: %s", cwd => {
  expect(parseCodexLog(log(cwd), since).execs).toHaveLength(1);
  const result = match(log(cwd));
  expect(result.reasons).toEqual([]);
  expect(result.results[0]).toMatchObject({ status: "matched", exitCode: 0 });
});
test("decodes a local file URL before comparing the employee's registered cwd", () => {
  expect(match(log("file:///repo/main"), () => null, null).results[0]?.status).toBe("matched");
});
test.each([root + "-other", root + "/../other", "/repo/other", "file://remote" + root, "file:relative", "file://" + root + "?query", "file://" + root + "/%ZZ", "file://" + root + "/%2Fother", null])("does not adopt unrelated or invalid workdirs: %s", cwd => {
  expect(match(log(cwd)).results).toEqual([]);
});
test("task ownership, contract time, result and evidence reuse remain required", () => {
  expect(match(log(root), () => null, null).results).toEqual([]);
  expect(match(log(root, 0, check.command, "2026-11-17T15:00:00.000Z")).results).toEqual([]);
  expect(match(log(root, 0) + "\n" + log(root, 1)).results).toEqual([]);
  expect(match(log(root, 0, check.command + "; true")).results).toEqual([]);
  expect(match(log(root), () => "another-task").results).toEqual([]);
});


test("completion and failure diagnosis both use the task worktree while session selection stays registered", async () => {
  const { fixture } = await import("./fixtures/harness-fixture.ts");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const f = fixture(), member = f.make("codex", "Codex worker", "worker", "codex");
  const task = f.store.saveTask({ projectId: f.project.id, memberId: member.id, who: member.name, title: "Worktree verification", worktree: root }).task;
  f.store.saveTaskContract(task.id, { kind: "coding", goal: "Verify task code", acceptance: ["Typecheck succeeds"], checks: ["typecheck"] }, { author: f.lead.name, authorMemberId: f.lead.id, authorKind: "conductor" });
  const dir = join(f.isolated.paths.codexHome, "sessions", "fixture"); mkdirSync(dir, { recursive: true });
  const at = new Date().toISOString();
  writeFileSync(join(dir, "rollout-task.jsonl"), JSON.stringify({ type: "session_meta", timestamp: at, payload: { id: member.sessionId, cwd: member.cwd } }) + "\n" + log("file://" + root + "/app", 0, check.command, at) + "\n");
  const failed = await f.tool(member, "post", { task_id: task.id, kind: "막힘", title: "Check was not recognized", contract_rev: 1, checks: [{ ...check, result: "fail", criterion: 1 }] });
  expect(failed.isError).toBeUndefined();
  const report = failed.text.match(/#(msg_[\w-]+)/)![1]!;
  const diagnosis = await f.tool(member, "exec_diagnose", { task_id: task.id, report_id: report, check_index: 0 });
  expect(diagnosis.isError).toBeUndefined();
  expect(JSON.parse(diagnosis.text).comparison.status).toBe("matched");
  const completed = await f.tool(member, "post", { task_id: task.id, kind: "완료", title: "Typecheck succeeded", contract_rev: 1, checks: [{ ...check, criterion: 1 }] });
  expect(completed.isError).toBeUndefined();
});

test("a matching cd command cannot move the actual check outside its assigned worktree", () => {
  const command = "cd ../other && npm run typecheck";
  const result = matchExecChecks([{ ...check, command }], { status: "ok", code: "ok", ...parseCodexLog(log(root, 0, command), since) }, () => null, "/repo/main", root);
  expect(result.results).toEqual([]);
});
test("a symbolic link inside the worktree cannot borrow a different directory's success", async () => {
  const { mkdirSync, symlinkSync } = await import("node:fs");
  const dir = testTempDir("iamceo-proof-scope-", "/private/tmp");
  try {
    mkdirSync(dir + "/task"); mkdirSync(dir + "/outside"); symlinkSync(dir + "/outside", dir + "/task/alias");
    expect(matchExecChecks([check], { status: "ok", code: "ok", ...parseCodexLog(log(dir + "/task/alias"), since) }, () => null, dir + "/main", dir + "/task").results).toEqual([]);
  } finally { releaseTestDir(dir); }
});
