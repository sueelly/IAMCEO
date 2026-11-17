// 합성 실행 메타데이터만 사용한다. 실제 검사·직원·제공자 기록을 실행하거나 바꾸지 않는다.
import { expect, test } from "bun:test";
import { matchExecChecks, parseCodexLog, parseClaudeLog } from "../server/harness-evidence.ts";
import type { ReportCheckInput } from "../server/harness.ts";

const command = "bun  test 'synthetic test.ts'";
const registered = "/fake/project";
const workdir = "/fake/project/review results/한글%";
const uri = "file:///fake/project/review%20results/%ED%95%9C%EA%B8%80%25";
const since = "2026-01-01T00:00:00.000Z";
function event(cwd: unknown, extra: Record<string, unknown> = {}, at = "2026-01-01T00:01:00.000Z") {
  return { type: "event_msg", timestamp: at, payload: { type: "item_completed", thread_id: "synthetic-thread", item: {
    type: "CommandExecution", id: "synthetic-exec", command: ["/bin/zsh", "-lc", command], cwd,
    status: "completed", exit_code: 0, ...extra,
  } } };
}
const evidence = (...rows: ReturnType<typeof event>[]) => ({ status: "ok" as const, code: "ok", ...parseCodexLog(rows.map(r => JSON.stringify(r)).join("\n"), since) });
const check = (location?: string | null): ReportCheckInput & { workdir?: string | null } => ({
  name: "합성 검사", kind: "behavior", result: "pass", evidence: "합성 메타데이터 대조", command,
  ...(location === undefined ? {} : { workdir: location }),
});
const match = (cwd: unknown, location?: string | null) => matchExecChecks([check(location)], evidence(event(cwd)), () => null, registered);

for (const [value, path] of [
  [registered, registered], ["/fake/한 글%#?", "/fake/한 글%#?"],
  ["file:///fake/project", registered], ["file:/fake/project", registered], ["FILE:///fake/project", registered], ["file://localhost/fake/project", registered],
  ["file://LOCALHOST/fake/project", registered], [uri, workdir],
] as const) test(`Codex cwd: 로컬 위치 ${value}를 정확한 경로로 읽는다`, () => {
  const parsed = evidence(event(value));
  expect(parsed.execs[0].cwd).toBe(path);
  expect(matchExecChecks([check(path)], parsed, () => null, path).reasons).toEqual([]);
  expect(parsed.execs[0].command).toBe(command);
});

for (const value of [undefined, null, "", "relative/path", "file:relative",
  "https://localhost/fake/project", "file://remote.invalid/fake/project", "file://127.0.0.1/fake/project",
  "file:///fake/project?x=1", "file:///fake/project#part", "file:///fake/project?", "file:///fake/project#",
  "file://", "file://localhost", "file:///fake/%ZZ", "file:///fake/%2", "file:///fake/%ED%A0%80", "file:///fake/a%2Fb",
  "file:///fake/%00", "file:///fake/\u0000", "file:///fake/a\nb", "file://localhost\\fake\\project",
  7, {}, "/fake/\u0000project", "/fake/\ud800", "/fake/\udc00", "file:///fake/\ud800", "file:///fake/\udc00"]) test(`Codex cwd: 미확인 위치 ${JSON.stringify(value)}는 일치하지 않는다`, () => {
  const parsed = evidence(event(value));
  expect(parsed.execs[0].cwd).toBeNull();
  expect(matchExecChecks([check()], parsed, () => null, registered).reasons).toHaveLength(1);
  // 등록 위치까지 없는 순수 호출에서도 null끼리 같다는 이유로 통과하지 않는다.
  expect(matchExecChecks([check()], parsed, () => null).reasons).toHaveLength(1);
});

test("명시적 workdir는 원 command를 바꾸지 않고 실제 위치를 대조한다", () => {
  const result = match(uri, workdir);
  expect(result.reasons).toEqual([]);
  expect(result.results[0]).toMatchObject({ status: "matched", command, exitCode: 0 });
  expect(match(uri, "/fake/other").reasons).toHaveLength(1);
});

test("workdir 생략·과거 null은 등록 위치 기준을 유지한다", () => {
  expect(match("file:///fake/project").reasons).toEqual([]);
  expect(match("file:///fake/project", null).reasons).toEqual([]);
  expect(match(uri).reasons).toHaveLength(1);
});

for (const value of ["", "relative", "file:///fake/project", "/fake/\u0000project"]) test(`matcher도 잘못된 명시 위치 ${JSON.stringify(value)}를 거절한다`, () => {
  expect(match("file:///fake/project", value).reasons).toHaveLength(1);
});

test("명시한 위치에서도 계약 앞 실행은 제외하고 계약 뒤 실행만 쓴다", () => {
  const old = event(uri, {}, "2025-12-31T23:59:59.999Z");
  expect(matchExecChecks([check(workdir)], evidence(old), () => null, registered).reasons).toHaveLength(1);
  expect(matchExecChecks([check(workdir)], evidence(old, event(uri)), () => null, registered).reasons).toEqual([]);
});

for (const fields of [{ exit_code: 3, status: "failed" }, { exit_code: 0, status: "in_progress" }, { exit_code: null }]) test(`명시한 위치에서도 종료 ${JSON.stringify(fields)}는 통과하지 않는다`, () => {
  expect(matchExecChecks([check(workdir)], evidence(event(uri, fields)), () => null, registered).reasons).toHaveLength(1);
});

test("같은 위치의 마지막 실패와 다른 업무 재사용을 보존한다", () => {
  const failed = event(uri, { id: "latest", exit_code: 4, status: "failed" }, "2026-01-01T00:02:00.000Z");
  const result = matchExecChecks([check(workdir)], evidence(event(uri), failed), () => null, registered);
  expect(result.reasons.join(" ")).toContain("종료 코드 4");
  expect(matchExecChecks([check(workdir)], evidence(event(uri)), () => "other-task", registered).reasons.join(" ")).toContain("other-task");
});

for (const suffix of ["; true", " | cat", " &"]) test(`명시한 위치에서도 뒤에 붙인 ${suffix}의 종료로 성공을 만들지 않는다`, () => {
  const parsed = evidence(event(uri, { command: ["/bin/zsh", "-lc", command + suffix] }));
  expect(matchExecChecks([check(workdir)], parsed, () => null, registered).reasons).toHaveLength(1);
});

test("명시적 pipefail과 기존 Claude·미지원 제공자 처리는 유지한다", () => {
  const safe = evidence(event(uri, { command: ["/bin/zsh", "-lc", "set -o pipefail; " + command + " | cat"] }));
  expect(matchExecChecks([check(workdir)], safe, () => null, registered).reasons).toEqual([]);
  const at = "2026-01-01T00:01:00.000Z";
  const claude = parseClaudeLog([
    { type: "assistant", timestamp: at, cwd: workdir, message: { content: [{ type: "tool_use", id: "synthetic", name: "Bash", input: { command } }] } },
    { type: "user", timestamp: at, message: { content: [{ type: "tool_result", tool_use_id: "synthetic", is_error: false, content: "" }] }, toolUseResult: { interrupted: false, stdout: "", stderr: "" } },
  ].map(r => JSON.stringify(r)).join("\n"), since);
  expect(matchExecChecks([check(workdir)], { status: "ok", code: "ok", ...claude }, () => null, registered).reasons).toEqual([]);
  expect(matchExecChecks([check(workdir)], { status: "unsupported", code: "unknown", execs: [], texts: [] }, () => null, registered).results[0].status).toBe("unsupported");
});

test("an explicit check location cannot authorize an unrelated directory", () => {
  const outside = "/fake/unrelated";
  expect(match(outside, outside).results).toEqual([]);
});

test("a declared registered task subdirectory still supports per-check locations", () => {
  const root = "/fake/.worktrees/selected", cwd = root + "/app";
  expect(matchExecChecks([check(cwd)], evidence(event(cwd)), () => null, registered, root).results[0]?.status).toBe("matched");
  expect(matchExecChecks([check(cwd)], evidence(event(root)), () => null, registered, root).results).toEqual([]);
});

test("declaring workdir does not authorize cd escapes or symlinks", async () => {
  const { mkdtempSync, mkdirSync, symlinkSync, rmSync } = await import("node:fs");
  const dir = mkdtempSync("/private/tmp/iamceo-declared-cwd-");
  try {
    const root = dir + "/task", outside = dir + "/outside";
    mkdirSync(root); mkdirSync(outside); symlinkSync(outside, root + "/alias");
    expect(matchExecChecks([check(root + "/alias")], evidence(event(root + "/alias")), () => null, root).results).toEqual([]);
    const escaped = "cd ../outside && " + command;
    expect(matchExecChecks([{ ...check(root), command: escaped }], evidence(event(root, { command: escaped })), () => null, root).results).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const [label, actual, declared, shell, accepted] of [
  ["starting directory cannot be disguised by an absolute cd", registered, "/fake/other", `cd ${registered}/tests && bun test`, false],
  ["an outside start is not allowed by a later cd into the project", "/fake/other", "/fake/other", `cd ${registered}/tests && bun test`, false],
  ["a trailing slash is the same starting directory", registered, registered + "/", "bun test", true],
  ["relative cd uses the normalized declared starting directory", registered, registered + "/./", "cd tests && bun test", true],
] as const) test(label, async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { inspectProviderEvidence } = await import("../server/harness-evidence.ts");
  const row = event(actual, { command: shell });
  const result = matchExecChecks([{ ...check(declared), command: shell }], evidence(row), () => null, registered);
  expect(result.results.some(r => r.status === "matched")).toBe(accepted);
  const root = mkdtempSync("/private/tmp/iamceo-starting-workdir-");
  try {
    const path = root + "/synthetic.jsonl";
    writeFileSync(path, JSON.stringify(row) + "\n");
    const diagnostic = inspectProviderEvidence("codex", { path, home: root, root }, since, shell, registered, () => null, null, declared);
    expect(diagnostic.comparison.status === "matched").toBe(accepted);
    expect(diagnostic.events.candidates[0]).toMatchObject({ cwdMatch: accepted ? "match" : "different", proof: accepted ? "ok" : "absent" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
