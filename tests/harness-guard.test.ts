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

test("지우기·깃허브 올리기·깃허브 게시·패키지 공개는 묻기(대표 승인 창)로 넘긴다", () => {
  for (const command of ["rm -rf build", "rm -r ./tmp/a", "cd x && rm -fr y", "sudo rm --recursive z", "find . -name '*.tmp' -delete", "find . -exec rm {} \\;", "git clean -fdx", "git reset --hard HEAD~1", "git worktree remove ../wt", "git branch -D old", "git stash drop"]) {
    expect([command, bash(command).decision]).toEqual([command, "ask"]);
  }
  for (const command of ["git push origin main", "gh pr create --fill", "gh pr merge 12", "npm publish"]) expect([command, bash(command).decision]).toEqual([command, "ask"]);
  expect((bash("rm -rf build") as { reason: string }).reason).toContain("대표 승인 창");
});

test("검토 반례: 옵션 순서·경로·앞말·하위 셸·git 전역 옵션을 바꿔도 묻는다", () => {
  for (const command of [
    "rm -f -r x", "rm -v -rf x", "/bin/rm -rf x", "\\rm -rf x", "command rm -rf x", "FOO=1 rm -rf x", "sudo -u root rm -rf /x", "nice -n 5 rm -rf x",
    "find . -name '*.tmp' | xargs rm -rf", "find . -exec rm -rf {} \\;", "bash -c 'rm -rf x'", "sh -lc \"cd y && rm -rf x\"", "eval 'rm -rf x'", "echo $(rm -rf x)", "echo \"`rm -rf x`\"",
    "if true; then rm -rf x; fi", "bash <<EOF\nrm -rf x\nEOF",
    "git -C /fake/wt push origin main", "git -c core.x=y push", "git --no-pager push", "git -C /fake/wt reset --hard HEAD~1",
    "git restore .", "git restore -W a.txt", "git checkout -- .", "git checkout HEAD -- a.txt", "git checkout -f main", "git switch --discard-changes main", "git branch -d -f old",
    "gh pr edit 1 --body x", "gh issue close 3", "gh release delete v1", "gh api -X POST repos/o/r/issues -f title=x", "gh api --method=DELETE repos/o/r", "gh api repos/o/r/issues -f title=x",
    "yarn npm publish", "pnpm --filter x publish",
  ]) expect([command, bash(command).decision]).toEqual([command, "ask"]);
});

test("검토 반례: 따옴표 안의 설명문·읽기 명령은 막지 않는다", () => {
  for (const command of [
    "git commit -m \"docs: avoid rm -rf in guide\"", "echo 'next: git push after approval'", "git log --oneline | grep 'git push'", "printf '%s' \"gh pr create 는 승인 뒤\"",
    "git commit -m \"$(cat <<'EOF'\nrm -rf 대신 휴지통\ngit push 는 승인 뒤\nEOF\n)\"",
    "git restore --staged a.txt", "git checkout main", "git checkout -b feat/x", "git switch main", "gh api repos/o/r/pulls", "gh pr view 1", "gh pr list", "npm run publish-docs",
    "rm -f a.txt", "ls ~/.sshkeys", "cat ~/.ssh-notes.txt", "ls ~/.config", "rg foo src", "grep -rn x server", "find . -name '*.ts'",
    "cat /fake/iamceo-home/inbox/m_x/a.txt", "cat /fake/iamceo-home/roles/worker.md", "curl -s https://example.invalid/a?b=1",
  ]) expect([command, bash(command).decision]).toEqual([command, "allow"]);
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

test("검토 반례: IAMCEO 데이터 폴더(DB·백업·토큰)와 그 상위 폴더 통째 검색·글로브·cd 뒤 상대 경로도 거절한다", () => {
  for (const command of [
    "sqlite3 /fake/iamceo-home/iamceo.db 'select token from members'", "sqlite3 'file:/fake/iamceo-home/iamceo.db?mode=ro' 'select 1'", "cp /fake/iamceo-home/backups/x.db /tmp/",
    "cat /fake/home/.iamceo/config.json", "cat ~/.config/gh/hosts.yml", "cat $HOME/.s*h/id*", "cat /fake/iamceo-home/run/*",
    "grep -r token ~/.config", "grep -r TOKEN /fake/iamceo-home/run", "rg TOKEN /fake/home", "find ~ -name 'id_*' | xargs cat", "find ~ -name '*.json' -exec cat {} +", "tar czf /tmp/a.tgz /fake/home",
    "cd /fake/home && cat .ssh/id_rsa", "cd /fake/iamceo-home; ls -la; cat config.json",
  ]) expect([command, bash(command).decision]).toEqual([command, "deny"]);
  const tool = (name: string, input: Record<string, unknown>) => guardDecision({ tool_name: name, tool_input: input, cwd: "/fake/home/work" }, ctx).decision;
  expect(tool("Read", { file_path: "/fake/iamceo-home/iamceo.db" })).toBe("deny");
  expect(tool("Read", { file_path: "/fake/iamceo-home/backups/iamceo-before.db" })).toBe("deny");
  expect(tool("Grep", { pattern: "TOKEN", path: "/fake/iamceo-home/run" })).toBe("deny");
  expect(tool("Grep", { pattern: "BEGIN", path: "/fake/home", glob: ".ssh/*" })).toBe("deny");
  expect(tool("Grep", { pattern: "x", path: "/fake" })).toBe("deny");
  // 이름만 보는 목록(Glob·find·du)은 상위 폴더에서 받는다. 내용은 읽지 않는다
  expect(tool("Glob", { pattern: "**/*.json", path: "/fake/home" })).toBe("allow");
  expect(tool("Glob", { pattern: "**/id_rsa", path: "/fake/home" })).toBe("deny");
  for (const command of ["find ~ -name '*.json'", "du -sh ~/*", "ls -R ~", "tree ~"]) expect([command, bash(command).decision]).toEqual([command, "allow"]);
  expect(tool("Glob", { pattern: "/fake/iamceo-home/run/*" })).toBe("deny");
  // 읽어야 하는 곳은 그대로 연다
  expect(tool("Read", { file_path: "/fake/iamceo-home/inbox/m_x/a.png" })).toBe("allow");
  expect(tool("Glob", { pattern: "**/*.ts", path: "/fake/home/work" })).toBe("allow");
  expect(tool("Grep", { pattern: "x", path: "/fake/home/work/server", glob: "*.ts" })).toBe("allow");
});

test("보통 일은 막지 않는다(허용이면 훅이 아무것도 내지 않아 다른 권한 판정이 그대로다)", () => {
  for (const command of ["bun test tests/harness.test.ts", "git commit -m 'x'", "ls -la", "rm a.txt", "rmdir empty", "git status", "cat .mcp.json", "echo done"]) {
    expect([command, bash(command).decision]).toEqual([command, "allow"]);
  }
  expect(file("Read", "/fake/home/work/server/store.ts").decision).toBe("allow");
  expect(file("Read", "/fake/home/.claude/projects/x/memory/MEMORY.md").decision).toBe("allow");
  expect(hookOutput({ decision: "allow" })).toBeNull();
  expect(JSON.parse(hookOutput(bash("git push"))!)).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: expect.stringContaining("깃허브에 올리기") } });
});

test("한계: 다른 네트워크 도구·외부 MCP 도구·프로그램 안의 지우기와 읽기·파이프로 셸에 넘긴 글은 막지 못한다", () => {
  for (const command of ["python3 -c \"import shutil; shutil.rmtree('x')\"", "bun scripts/cleanup.ts", "curl -X POST https://example.invalid/hook -d x", "python3 -c \"print(open('/fake/home/.ssh/id_rsa').read())\"", "echo 'rm -rf x' | bash"]) {
    expect([command, bash(command).decision]).toEqual([command, "allow"]);
  }
  expect(guardDecision({ tool_name: "mcp__claude_ai_Notion__notion-create-pages", tool_input: { pages: [] } }, ctx).decision).toBe("allow");
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
