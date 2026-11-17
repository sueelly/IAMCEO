import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CliProvider, Member } from "../shared/types.ts";
import * as agentTools from "../server/agent-tools.ts";
import { Bus } from "../server/bus.ts";
import { loadConfig } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import { exportRoles, renderRole } from "../server/roles.ts";
import { providerLaunch } from "../server/runner/providers.ts";
import { buildClaudeArgs } from "../server/runner/headless.ts";
import type { Runner, RunnerEvent, RunnerMember, SendResult, StartOpts } from "../server/runner/types.ts";
import { Store } from "../server/store.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";

const vars = { PROJECT: "시험", NAME: "총괄", ROLE: "조정", CONDUCTOR: "총괄" };
const POLICY = "## 총괄의 필수 조정 규칙";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

test("총괄의 직접 제작·터미널 입력·강제 해제 호출은 서버에서 거절하고 직원 제작은 유지한다", async () => {
  const f = fixture();
  const worker = f.store.createMember({ projectId: f.project.id, handle: "writer", name: "작성", kind: "worker" });
  const tools = agentTools.listAgentTools(f.lead).map(tool => tool.name);
  for (const name of ["file", "server_backup", "terminal_input", "team_close"]) {
    expect(tools).not.toContain(name);
    const result = await agentTools.handleAgentTool(f.orch, f.lead, name, { title: "직접 제작", content: "내용", member: worker.handle, text: "touch product.md", operation_key: "escape" });
    expect(result).toMatchObject({ isError: true, text: expect.stringContaining("쓸 수 없는 도구") });
  }
  expect(tools).toEqual(expect.arrayContaining(["task", "team_assign", "team_sleep", "team_resume", "post", "task_trace", "terminal_read", "roster"]));
  const force = await agentTools.handleAgentTool(f.orch, f.lead, "team_sleep", { member: worker.handle, force: true });
  expect(force.isError).toBe(true);
  expect(f.store.requireMember(worker.id)).toMatchObject({ status: worker.status, origin: worker.origin });
  expect(agentTools.listAgentTools(worker).map(tool => tool.name)).toContain("file");
  const { task } = f.store.saveTask({ projectId: f.project.id, title: "직원 자료", memberId: worker.id, who: worker.name });
  const published = await agentTools.handleAgentTool(f.orch, worker, "file", { title: "직원 제작", content: "직원이 작성한 자료", task_id: task.id });
  expect(published.isError, published.text).toBeUndefined();
});

test("조정 전용 CLI는 권한 우회 설정에서도 직접 제작과 하위 에이전트를 노출하지 않는다", () => {
  const isolated = createIsolatedRuntime(); cleanups.push(() => isolated.stop());
  const opts = { systemPromptFile: join(isolated.paths.configDir, "rules.md"), mcpConfigFile: join(isolated.paths.configDir, "mcp.json"), resume: false, projectName: "조정" };
  writeFileSync(opts.systemPromptFile, "조정 규칙");
  writeFileSync(opts.mcpConfigFile, JSON.stringify({ mcpServers: { iamceo: { command: "/fake/bridge", args: [], env: {} } } }));
  writeFileSync(isolated.bins.codexBin, '#!/bin/sh\nprintf \'[{"name":"external","enabled":true},{"name":"iamceo","enabled":true}]\\n\'\n', { mode: 0o700 });
  const member: RunnerMember = { id: "lead", projectId: "p", handle: "lead", name: "총괄", cli: "claude", kind: "conductor", cwd: isolated.paths.work, sessionId: null, paneId: null, model: null, effort: null, subagentModel: "child", permissionMode: "bypassPermissions" };
  for (const args of [providerLaunch(member, opts, isolated.bins).argv, buildClaudeArgs({ ...member, sessionId: "existing" }, opts, true)]) {
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Glob,Grep");
    expect(args).toContain("--strict-mcp-config");
    expect(args).not.toContain("bypassPermissions");
  }
  for (const resume of [false, true]) {
    const launch = providerLaunch({ ...member, cli: "codex", sessionId: resume ? "existing" : null }, { ...opts, resume }, isolated.bins);
    expect(launch.argv).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(launch.argv).toContain("features.shell_tool=false");
    expect(launch.argv).toContain("features.multi_agent=false");
    expect(launch.argv).toContain("features.plugins=false");
    expect(launch.argv).toContain("features.apps=false");
    expect(launch.argv).toContain("mcp_servers.external.enabled=false");
    expect(launch.argv[launch.argv.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(launch.argv[launch.argv.indexOf("--ask-for-approval") + 1]).toBe("never");
  }
  expect(() => providerLaunch({ ...member, cli: "antigravity" }, opts, { antigravityBin: "/fake/agy" })).toThrow("조정 전용");
  const worker = providerLaunch({ ...member, kind: "worker", cli: "codex" }, opts, isolated.bins);
  expect(worker.argv).toContain("--dangerously-bypass-approvals-and-sandbox");
  expect(worker.argv).toContain("features.multi_agent=true");
  for (const output of ['[{"name":"unsafe.name"}]', 'not json']) {
    writeFileSync(isolated.bins.codexBin, `#!/bin/sh\nprintf '%s\\n' '${output}'\n`, { mode: 0o700 });
    expect(() => providerLaunch({ ...member, cli: "codex" }, opts, isolated.bins)).toThrow("조정 전용 MCP 목록");
  }
});

// A custom role replaces the normal template; it must not remove the mandatory
// responsibility boundary. These exercise the rendered prompt, not source files.
test("맞춤 총괄 템플릿과 내보낸 예시에도 필수 조정 규칙을 한 번 전달한다", () => {
  const isolated = createIsolatedRuntime();
  cleanups.push(() => isolated.stop());
  const rolesDir = isolated.paths.work;
  writeFileSync(join(rolesDir, "conductor.md"), "{{NAME}} 맞춤 승인 규칙: 보고서와 구현을 직접 작성한다.");
  const custom = renderRole("conductor", vars, rolesDir);
  expect(custom).toStartWith("총괄 맞춤 승인 규칙");
  expect(custom.split(POLICY)).toHaveLength(2);
  expect(custom).toContain("사용자 정의 템플릿");
  expect(custom).toContain("제품 설계");
  expect(custom).not.toContain("{{");
  expect(renderRole("worker", vars, rolesDir)).not.toContain(POLICY);
  expect(renderRole("root", vars, rolesDir)).not.toContain(POLICY);

  const example = exportRoles(rolesDir).find(path => path.endsWith("conductor.example.md"))!;
  writeFileSync(join(rolesDir, "conductor.md"), readFileSync(example, "utf8"));
  expect(renderRole("conductor", vars, rolesDir).split(POLICY)).toHaveLength(2);
});

test("지원하는 제공자의 새 세션과 이어 열기에 맞춤 총괄의 필수 조정 규칙을 전달한다", () => {
  const isolated = createIsolatedRuntime();
  cleanups.push(() => isolated.stop());
  writeFileSync(join(isolated.paths.work, "conductor.md"), "{{NAME}} 맞춤 승인 규칙");
  const prompt = renderRole("conductor", vars, isolated.paths.work);
  const systemPromptFile = join(isolated.paths.configDir, "rules.md");
  const mcpConfigFile = join(isolated.paths.configDir, "mcp.json");
  writeFileSync(systemPromptFile, prompt);
  writeFileSync(mcpConfigFile, JSON.stringify({ mcpServers: { iamceo: { command: "/fake/bridge", args: [], env: {} } } }));
  writeFileSync(isolated.bins.codexBin, "#!/bin/sh\nprintf '[]\\n'\n", { mode: 0o700 });
  const bins = { ...isolated.bins, antigravityBin: "/fake/agy", antigravityRoot: join(isolated.paths.configDir, "agy"), antigravityUserRoot: join(isolated.paths.configDir, "no-user") };
  for (const cli of ["claude", "codex"] as const) for (const resume of [false, true]) {
    const sessionId = resume ? "6f1c2b9e-1111-4222-8333-944455556666" : null;
    const member: RunnerMember = { id: `lead-${cli}`, projectId: "project", handle: "lead", name: "총괄", cli, kind: "conductor", cwd: isolated.paths.work,
      sessionId, paneId: null, model: null, effort: null, subagentModel: null, permissionMode: "default" };
    const launch = providerLaunch(member, { systemPromptFile, mcpConfigFile, resume, projectName: "시험" }, bins);
    const received = cli === "claude"
      ? readFileSync(launch.argv[launch.argv.indexOf("--append-system-prompt-file") + 1]!, "utf8")
      : JSON.parse(launch.argv.find(arg => arg.startsWith("developer_instructions="))!.slice("developer_instructions=".length)) as string;
    expect(received).toContain(POLICY);
    expect(received).toContain("총괄 맞춤 승인 규칙");
    expect(launch.argv.includes(cli === "claude" ? "--resume" : cli === "codex" ? "resume" : "--conversation")).toBe(resume);
  }
});

// Only the external runner is replaced. Queueing, signatures, persistence,
// stopping/resuming and generated role files use the real orchestrator/store.
class PolicyRunner implements Runner {
  readonly kind = "core" as const;
  busy = new Set<string>();
  starts: { id: string; resume: boolean; sessionId: string | null; rules: string }[] = [];
  stops: string[] = [];
  failStop = false;
  interrupts: string[] = [];
  beforeStopCheck: (() => void) | null = null;
  sent: { id: string; text: string }[] = [];
  callback: (event: RunnerEvent) => void = () => {};
  async available() { return { ok: true }; }
  async start(member: RunnerMember, opts: StartOpts) {
    this.starts.push({ id: member.id, resume: opts.resume, sessionId: member.sessionId, rules: readFileSync(opts.systemPromptFile, "utf8") });
    return { sessionId: member.sessionId ?? `session-${member.id}`, paneId: `pane-${member.id}-${this.starts.length}` };
  }
  async send(member: RunnerMember, text: string): Promise<SendResult> {
    this.busy.add(member.id); this.sent.push({ id: member.id, text }); return { ok: true, started: true, turn: 0 };
  }
  isBusy(id: string) { return this.busy.has(id); }
  async compact(): Promise<SendResult> { return { ok: true }; }
  async setParallel(): Promise<SendResult> { return { ok: true }; }
  async interrupt(member: RunnerMember) { this.interrupts.push(member.id); }
  async checkStop() { this.beforeStopCheck?.(); }
  async stop(member: RunnerMember) { this.stops.push(member.id); if (this.failStop) throw new Error("fixture stop failed"); this.busy.delete(member.id); }
  async screen() { return ""; }
  async shutdown() {}
  on(callback: (event: RunnerEvent) => void) { this.callback = callback; }
}

function fixture(cli: CliProvider = "codex", origin: Member["origin"] = "runner") {
  const isolated = createIsolatedRuntime();
  const config = loadConfig({ IAMCEO_HOME: isolated.paths.iamceoHome, IAMCEO_PORT: "0", IAMCEO_CORE_SOCKET: isolated.socketPath,
    IAMCEO_CORE_BIN: isolated.bins.coreBin, IAMCEO_CLAUDE_BIN: isolated.bins.claudeBin, IAMCEO_CODEX_BIN: isolated.bins.codexBin });
  const db = openDb(config.dbPath);
  const store = new Store(db, new Bus());
  store.patchSettings({ maxConcurrentTurns: 8, boardTidyHours: 0 });
  const project = store.createProject({ name: "조정 규칙", cwd: isolated.paths.work, memory: false });
  const lead = store.createMember({ projectId: project.id, handle: "lead", name: "총괄", kind: "conductor", origin, backend: "core", cli,
    cwd: project.cwd, sessionId: "6f1c2b9e-1111-4222-8333-944455556666", paneId: "lead-pane", status: "idle" });
  const runner = new PolicyRunner();
  const orch = new Orchestrator({ config, store, runners: new Map([["core", runner]]), agentTools, timings: { tickMs: 60_000, healthMs: 60_000 } });
  const wake = async (text = "[시스템] 판 정리: 기존 업무의 기준과 보고를 확인하세요") => {
    const delivery = store.enqueue({ projectId: project.id, memberId: lead.id, kind: "system", text, wake: true });
    await orch.pump(lead.id);
    return delivery;
  };
  const idle = async () => {
    runner.busy.delete(lead.id);
    const current = store.requireMember(lead.id);
    runner.callback({ type: "turn_end", memberId: lead.id, terminalId: current.paneId,
      sessionGeneration: store.memberRevisions(lead.id).sessionGeneration, turn: 1, finalText: "", isError: false });
    await orch.pump(lead.id);
    for (let n = 0; n < 100 && store.requireMember(lead.id).status === "working"; n++) await Bun.sleep(5);
    expect(store.requireMember(lead.id).status).toBe("idle");
  };
  cleanups.push(async () => { await orch.shutdown(); db.close(); await isolated.stop(); });
  return { config, store, project, lead, runner, orch, wake, idle };
}

for (const cli of ["claude", "codex", "antigravity"] as const) {
  test(`${cli}: 지문 없는 기존 총괄은 다음 입력 전에 같은 대화를 조정 규칙으로 이어 연다`, async () => {
    const f = fixture(cli);
    expect(f.store.getAppliedConfig(f.lead.id)).toBeNull();
    await f.wake();
    expect(f.runner.stops).toEqual([f.lead.id]);
    expect(f.runner.starts).toHaveLength(1);
    expect(f.runner.starts[0]).toMatchObject({ resume: true, sessionId: f.lead.sessionId });
    expect(f.runner.starts[0]!.rules).toContain(POLICY);
    expect(f.runner.sent).toHaveLength(1);
    expect(f.store.requireMember(f.lead.id).sessionId).toBe(f.lead.sessionId);
    await f.idle();
    await f.wake("[시스템] 판 정리: 후속 보고를 확인하세요");
    expect(f.runner.starts).toHaveLength(1); // A stable prompt does not cause a restart loop.
    expect(f.runner.sent).toHaveLength(2);
  });
}

test("도구만 저장한 기존 지문도 역할 글을 다시 받고, 맞춤 역할 변경도 다음 쉬는 틈에 받는다", async () => {
  const f = fixture();
  const oldSignature = createHash("sha256").update(JSON.stringify(agentTools.listAgentTools(f.lead))).digest("hex").slice(0, 16);
  f.store.setAppliedConfig(f.lead.id, { model: null, effort: null, staffModel: null, staffEffort: null, toolsSig: oldSignature });
  await f.wake();
  expect(f.runner.starts).toHaveLength(1);
  expect(f.runner.starts[0]!.rules).toContain(POLICY);
  const applied = f.store.getAppliedConfig(f.lead.id)!.toolsSig;
  await f.idle();
  writeFileSync(join(f.config.rolesDir, "conductor.md"), "승인 규칙: 검토 보고를 먼저 확인한다.");
  await f.wake();
  expect(f.runner.starts).toHaveLength(2);
  expect(f.runner.starts[1]!.rules).toContain("검토 보고를 먼저 확인한다");
  expect(f.runner.starts[1]!.rules).toContain(POLICY);
  expect(f.store.getAppliedConfig(f.lead.id)!.toolsSig).not.toBe(applied);
});

for (const status of ["working", "blocked"] as const) {
  test(`규칙 갱신은 ${status} 총괄을 중단하거나 대기 입력을 보내지 않는다`, async () => {
    const f = fixture();
    f.store.patchMember(f.lead.id, { status });
    if (status === "working") f.runner.busy.add(f.lead.id);
    const delivery = await f.wake();
    expect(f.runner.stops).toHaveLength(0);
    expect(f.runner.starts).toHaveLength(0);
    expect(f.runner.sent).toHaveLength(0);
    expect(f.store.listPending(f.lead.id).some(item => item.id === delivery.id)).toBe(true);
    expect(f.store.requireMember(f.lead.id).status).toBe(status);
    // The existing turn/approval is allowed to finish; its next idle observation
    // then resumes the same conversation with the pending policy and input.
    f.runner.busy.delete(f.lead.id);
    f.runner.callback({ type: "status", memberId: f.lead.id, status: "idle" });
    await f.orch.pump(f.lead.id);
    expect(f.runner.starts).toHaveLength(1);
    expect(f.runner.starts[0]).toMatchObject({ resume: true, sessionId: f.lead.sessionId });
    expect(f.runner.starts[0]!.rules).toContain(POLICY);
    expect(f.runner.sent).toHaveLength(1);
  });
}

test("대표에게 넘겨받은 총괄 세션은 규칙 갱신을 위해 자동으로 닫지 않는다", async () => {
  const f = fixture("codex", "adopted");
  await f.wake();
  expect(f.runner.stops).toHaveLength(0);
  expect(f.runner.starts).toHaveLength(0);
  expect(f.runner.sent).toHaveLength(0);
  expect(f.store.listPending(f.lead.id)).toHaveLength(1);
  expect(f.store.requireMember(f.lead.id).lastError).toContain("조정 전용");
});

test("총괄의 권한 갱신 실패 뒤에도 옛 권한으로 새 입력을 보내지 않는다", async () => {
  const f = fixture(); f.runner.failStop = true;
  await f.wake(); await f.orch.pump(f.lead.id);
  expect(f.runner.sent).toHaveLength(0);
  expect(f.store.listPending(f.lead.id)).toHaveLength(1);
  expect(f.store.requireMember(f.lead.id).lastError).toContain("조정 전용");
});

test("옛 권한으로 일하는 총괄은 긴급 입력도 갱신 뒤까지 보존한다", async () => {
  const f = fixture();
  f.store.patchMember(f.lead.id, { status: "working" }); f.runner.busy.add(f.lead.id);
  const delivery = f.store.enqueue({ projectId: f.project.id, memberId: f.lead.id, kind: "system", text: "긴급 개입", urgent: true, wake: true });
  await f.orch.pump(f.lead.id);
  expect(f.runner.sent).toHaveLength(0);
  expect(f.runner.stops).toHaveLength(0);
  expect(f.store.listPending(f.lead.id).map(d => d.id)).toContain(delivery.id);
});

test("총괄은 뒤 작업·하위 에이전트·승인 대기가 남은 직원을 해제하지 않는다", async () => {
  const f = fixture();
  for (const state of ["background", "subagents", "blocked"] as const) {
    const worker = f.store.createMember({ projectId: f.project.id, handle: state, name: state, kind: "worker", backend: "core", status: "idle", sessionId: `session-${state}`, paneId: `pane-${state}` });
    if (state === "background") {
      f.runner.callback({ type: "background", memberId: worker.id, label: "1 dynamic workflow" });
      await Bun.sleep(10);
    } else if (state === "subagents") f.store.patchMember(worker.id, { subagents: 1 });
    else f.store.patchMember(worker.id, { status: "blocked", blockedReason: "permission" });
    const result = await agentTools.handleAgentTool(f.orch, f.lead, "team_sleep", { member: worker.handle });
    expect(result.isError, `${state}: ${result.text}`).toBe(true);
    expect(f.runner.stops).not.toContain(worker.id);
    expect(f.store.requireMember(worker.id).status).not.toBe("asleep");
  }
});

test("총괄 중단은 승인 창과 사전 확인 중 새로 뜬 승인 창을 보존하고 대표 중단은 유지한다", async () => {
  const f = fixture();
  const worker = f.store.createMember({ projectId: f.project.id, handle: "approval", name: "승인 대기", kind: "worker", backend: "core", status: "blocked", sessionId: "approval-session", paneId: "approval-pane" });
  const blocked = await agentTools.handleAgentTool(f.orch, f.lead, "team_stop", { member: worker.handle });
  expect(blocked.isError).toBe(true);
  expect(f.runner.interrupts).toHaveLength(0);
  f.store.patchMember(worker.id, { status: "working" });
  f.runner.beforeStopCheck = () => { f.store.patchMember(worker.id, { status: "blocked", blockedReason: "permission" }); };
  const raced = await agentTools.handleAgentTool(f.orch, f.lead, "team_stop", { member: worker.handle });
  expect(raced.isError).toBe(true);
  expect(f.runner.interrupts).toHaveLength(0);
  const owner = await f.orch.stopMember(worker.id, { by: "user" });
  expect(owner.outcome).toBe("stopped");
  expect(f.runner.interrupts).toEqual([worker.id]);
});
