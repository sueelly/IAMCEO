// Claude 직원 PreToolUse 훅 판정. 실제 비밀 파일·다른 프로젝트 파일·외부 서비스에는 아무것도 하지 않는다.
// 판정은 가짜 홈·가짜 IAMCEO 폴더 경로의 글자만 본다. 훅 진입 파일은 실제 프로세스로 띄워 입출력을 확인한다.
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { guardDecision, hookOutput } from "../server/harness-guard.ts";
import { Bus } from "../server/bus.ts";
import { loadConfig } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { guardCommand, Orchestrator } from "../server/orchestrator.ts";
import { Store } from "../server/store.ts";
import type { Member, Project } from "../shared/types.ts";
import type { StartOpts } from "../server/runner/types.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";

const ctx = { iamceoHome: "/fake/iamceo-home", userHome: "/fake/home" };
const bash = (command: string) => guardDecision({ tool_name: "Bash", tool_input: { command }, cwd: "/fake/home/work" }, ctx);
const file = (tool: string, path: string) => guardDecision({ tool_name: tool, tool_input: { file_path: path }, cwd: "/fake/home/work" }, ctx);

test("지우기·깃허브 올리기·외부 게시는 묻기(대표 승인 창)로 넘긴다", () => {
  for (const command of ["rm -rf build", "rm -r ./tmp/a", "cd x && rm -fr y", "sudo rm --recursive z", "find . -name '*.tmp' -delete", "find . -exec rm {} \\;", "git clean -fdx", "git reset --hard HEAD~1", "git worktree remove ../wt", "git branch -D old", "git stash drop"]) {
    expect([command, bash(command).decision]).toEqual([command, "ask"]);
  }
  for (const command of ["git push origin main", "gh pr create --fill", "gh pr merge 12", "npm publish"]) expect([command, bash(command).decision]).toEqual([command, "ask"]);
  expect((bash("rm -rf build") as { reason: string }).reason).toContain("대표 승인 창");
});

test("비밀 파일·키체인은 거절한다. ~ · $HOME · 절대 경로 표기와 파일 도구 경로를 모두 본다", () => {
  for (const command of ["cat ~/.config/iamceo/dev-memory-api-key", "cat $HOME/.ssh/id_ed25519", "cat /fake/home/.netrc", "jq . /fake/iamceo-home/config.json", "cat /fake/iamceo-home/run/m_x.mcp.json", "security find-generic-password -s x -w", "grep token ${HOME}/.codex/auth.json"]) {
    expect([command, bash(command).decision]).toEqual([command, "deny"]);
  }
  expect(file("Read", "/fake/home/.ssh/config").decision).toBe("deny");
  expect(file("Read", "~/.config/iamceo/access-code").decision).toBe("deny");
  expect(file("Edit", "/fake/iamceo-home/config.json").decision).toBe("deny");
  expect(file("Write", "../.aws/credentials").decision).toBe("deny"); // cwd 기준 상대 경로
});

test("보통 일은 막지 않는다(허용이면 훅이 아무것도 내지 않아 다른 권한 판정이 그대로다)", () => {
  for (const command of ["bun test tests/harness.test.ts", "git commit -m 'x'", "ls -la", "rm a.txt", "rmdir empty", "git status", "sqlite3 'file:/fake/iamceo-home/iamceo.db?mode=ro' 'select 1'", "cat .mcp.json", "echo done"]) {
    expect([command, bash(command).decision]).toEqual([command, "allow"]);
  }
  expect(file("Read", "/fake/home/work/server/store.ts").decision).toBe("allow");
  expect(file("Read", "/fake/home/.claude/projects/x/memory/MEMORY.md").decision).toBe("allow");
  expect(hookOutput({ decision: "allow" })).toBeNull();
  expect(JSON.parse(hookOutput(bash("git push"))!)).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: expect.stringContaining("깃허브에 올리기") } });
});

test("한계: 명령 글자에 드러나지 않는 지우기는 막지 못한다(스크립트 안의 삭제)", () => {
  expect(bash("python3 -c \"import shutil; shutil.rmtree('x')\"").decision).toBe("allow");
  expect(bash("bun scripts/cleanup.ts").decision).toBe("allow");
});

test("훅 진입 파일: 실제 프로세스가 stdin JSON 을 읽어 Claude 훅 형식으로 낸다. 읽지 못하면 막지 않는다", async () => {
  const run = async (stdin: string) => {
    const proc = Bun.spawn([process.execPath, resolve(import.meta.dir, "..", "bin", "iamceo-guard.ts"), "--home", "/fake/iamceo-home"], { stdin: new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe" });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { out: out.trim(), code };
  };
  const denied = await run(JSON.stringify({ tool_name: "Bash", tool_input: { command: "cat /fake/iamceo-home/config.json" }, cwd: "/tmp" }));
  expect(denied.code).toBe(0);
  expect(JSON.parse(denied.out).hookSpecificOutput.permissionDecision).toBe("deny");
  expect(await run(JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" }, cwd: "/tmp" }))).toEqual({ out: "", code: 0 });
  expect(await run("not json")).toEqual({ out: "", code: 0 });
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

test("IAMCEO 가 띄우는 Claude 세션의 설정 파일에만 훅이 들어간다. Codex·Antigravity 는 설정 파일이 없다", async () => {
  const isolated = createIsolatedRuntime();
  const config = loadConfig({ IAMCEO_HOME: isolated.paths.iamceoHome, IAMCEO_PORT: "0", IAMCEO_CORE_SOCKET: isolated.socketPath, IAMCEO_CORE_BIN: isolated.bins.coreBin, IAMCEO_CLAUDE_BIN: isolated.bins.claudeBin, IAMCEO_CODEX_BIN: isolated.bins.codexBin });
  const db = openDb(config.dbPath);
  const store = new Store(db, new Bus());
  const orch = new Orchestrator({ config, store, runners: new Map(), timings: { tickMs: 60_000, healthMs: 60_000, turnErrorRetryMs: 1000 } });
  cleanups.push(async () => { await orch.shutdown(); db.close(); await isolated.stop(); });
  const project = store.createProject({ name: "훅", cwd: isolated.paths.work });
  const member = store.createMember({ projectId: project.id, handle: "w1", name: "철수", kind: "worker", origin: "runner", backend: "core", status: "idle", cwd: isolated.paths.work, cli: "claude" });
  const write = (m: Member) => (orch as unknown as { writeRunFiles(m: Member, p: Project): StartOpts }).writeRunFiles(m, project);
  const settings = JSON.parse(readFileSync(write(member).settingsFile!, "utf8"));
  expect(settings.hooks.PreToolUse).toEqual([{ matcher: "Bash|Read|Write|Edit|MultiEdit|NotebookEdit|Grep|Glob", hooks: [{ type: "command", command: guardCommand(config.home), timeout: 10 }] }]);
  expect(guardCommand(config.home)).toContain("iamceo-guard.ts");
  expect(guardCommand(config.home)).toContain("--home");
  expect(write({ ...member, cli: "codex" }).settingsFile).toBeUndefined();
  expect(write({ ...member, cli: "antigravity" }).settingsFile).toBeUndefined();
});
