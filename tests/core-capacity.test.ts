import { expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import type { CoreTerminal } from "../server/runner/core-client.ts";
import { Bus } from "../server/bus.ts";
import { loadConfig } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import { Store } from "../server/store.ts";
import { TaskContinuationCoordinator } from "../server/task-continuation.ts";
import { CoreRunner } from "../server/runner/core.ts";
import { coreRpc } from "../server/runner/core-client.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";
import { startBrowserCore } from "./fixtures/core-browser-harness.ts";

async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(5);
  expect(check()).toBe(true);
}

test("core transport rechecks admission after socket connection before writing any request", async () => {
  const core = await startBrowserCore({ providerTurns: false });
  try {
    let allowed = true;
    const request = coreRpc(core.socketPath, "terminal.send", { terminal: "unused", text: "Must not be written" }, 500, () => allowed);
    allowed = false;
    await expect(request).rejects.toMatchObject({ kind: "admission", uncertain: false, deliveryEffect: "not_written" });
    expect(core.count("terminal.send")).toBe(0);
    expect(await coreRpc(core.socketPath, "hello", {}, 500, () => true)).toMatchObject({ generation: 1 });
  } finally { await core.stop(); }
});

// This peer never executes terminal.run argv or spawns a provider. Paths and provider homes
// must still belong to its explicit runtime; no live discovery or sockets are used.
async function capacityPeer(runtime: ReturnType<typeof createIsolatedRuntime>, startupError?: string) {
  const terminals = new Map<string, CoreTerminal>(), calls: Array<{ method: string; params: Record<string, any>; replied: boolean }> = [];
  const sockets = new Set<Socket>();
  const replies: Array<() => void> = [];
  let holdRead = false;
  const composer = `prior output\n${"─".repeat(30)}\n❯ \n${"─".repeat(30)}\n`;
  const server = createServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", chunk => { buffer += chunk; while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n"), request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      const call = { ...request, replied: false }; calls.push(call); const p = call.params;
      const reply = (result: unknown) => { call.replied = true; socket.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n"); };
      let result: unknown;
      if (request.method === "hello") result = { generation: 1, version: "capacity-fixture", methods: ["terminal.run", "terminal.list", "terminal.get", "terminal.read", "terminal.send", "terminal.interrupt", "terminal.kill"], features: [] };
      else if (request.method === "terminal.list") result = { terminals: [...terminals.values()].filter(t => Object.entries(p.labels || {}).every(([key, value]) => t.labels[key] === value)) };
      else if (request.method === "terminal.run") {
        runtime.assertFakeExecutable(p.argv[0]); runtime.assertOwnedPath(p.cwd);
        expect(p.env.CLAUDE_CONFIG_DIR).toBe(runtime.paths.claudeHome); expect(p.env.CODEX_HOME).toBe(runtime.paths.codexHome);
        const terminal: CoreTerminal = { address: `t${terminals.size + 1}`, argv: p.argv, cwd: p.cwd, labels: p.labels, state: "live", turn: 0, status: { state: "idle", app: "claude-code" }, reported: true };
        if (startupError) terminal.status = { state: "error", app: "claude-code", msg: startupError };
        terminals.set(terminal.address, terminal); result = terminal;
      } else if (request.method === "terminal.get") {
        const terminal = terminals.get(p.terminal);
        if (startupError && terminal) terminal.status = { state: "idle", app: "claude-code" };
        result = terminal;
      }
      else if (request.method === "terminal.read") {
        result = { text: composer, complete: true, how: "screen" };
        if (holdRead) { holdRead = false; replies.push(() => reply(result)); continue; }
      } else if (request.method === "terminal.send") {
        const terminal = terminals.get(p.terminal)!;
        expect(terminal.status?.state).toBe("idle"); terminal.status = { state: "working" }; result = { turn: terminal.turn, started: true };
      } else if (request.method === "terminal.interrupt") result = { outcome: "stopped" };
      else if (request.method === "terminal.kill") { const terminal = terminals.get(p.terminal)!; terminal.state = "finished"; result = terminal; }
      if (result === undefined) socket.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "Unknown isolated fixture operation" } }) + "\n");
      else reply(result);
    } });
  });
  await new Promise<void>(resolve => server.listen(runtime.assertOwnedPath(runtime.socketPath), resolve));
  return { calls, terminals, count: (method: string) => calls.filter(call => call.method === method).length,
    holdNextRead() { holdRead = true; }, releaseReplies() { for (const reply of replies.splice(0)) reply(); },
    async stop() { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

for (const change of ["contract", "owner-stop"] as const) {
  test(`worker continuation rechecks ${change} after core preflight and before physical input`, async () => {
    const runtime = createIsolatedRuntime(), core = await capacityPeer(runtime);
    const config = loadConfig({ IAMCEO_HOME: runtime.paths.iamceoHome, IAMCEO_PORT: "0", IAMCEO_CORE_SOCKET: runtime.socketPath,
      IAMCEO_HERDR_SOCKET: runtime.herdrSocketPath, IAMCEO_CORE_BIN: runtime.bins.coreBin,
      IAMCEO_CLAUDE_BIN: runtime.bins.claudeBin, IAMCEO_CODEX_BIN: runtime.bins.codexBin });
    const db = openDb(config.dbPath), store = new Store(db, new Bus());
    const runner = new CoreRunner(runtime.runnerOptions(runtime.providerHomes), { recoveryStore: store, pollMs: 60_000 });
    const orch = new Orchestrator({ config, store, runners: new Map([["core", runner]]), providerHomes: runtime.providerHomes,
      timings: { tickMs: 60_000, healthMs: 60_000 } });
    try {
      const project = store.createProject({ name: "Continuation preflight", cwd: runtime.paths.work });
      const worker = await orch.createMember(project.id, { name: "Worker", cli: "claude", parallel: false });
      const task = store.saveTask({ projectId: project.id, memberId: worker.id, who: "대표", title: "Approved remaining scope" }).task;
      const contract = { kind: "other" as const, goal: "승인된 범위 확인", acceptance: ["검사 결과 확인"], inputs: ["승인 요청"], outputs: ["검사 결과"], scope: "승인 범위", constraints: [], exclusions: [] };
      store.saveTaskContract(task.id, contract, { author: "대표", authorMemberId: null, authorKind: "owner" });
      const source = store.enqueue({ projectId: project.id, memberId: worker.id, taskId: task.id, kind: "instruction", text: "승인된 범위를 확인하세요" });
      store.markDelivered(source.id);
      core.holdNextRead();
      const [delivery] = orch.checkTaskContinuations(Date.now() + 120_000);
      expect(delivery?.memberId).toBe(worker.id);
      await until(() => core.calls.some(call => call.method === "terminal.read" && !call.replied));
      if (change === "contract") store.saveTaskContract(task.id, { ...contract, goal: "새 범위 확인" }, { author: "대표", authorMemberId: null, authorKind: "owner" });
      else new TaskContinuationCoordinator(store, { intervalMs: 1000, sameLimit: 3 }).pause([task.id], "owner-stop", "대표가 중단했습니다");
      core.releaseReplies();
      await orch.pump(worker.id);
      expect(core.count("terminal.send")).toBe(0);
      expect(store.requireDelivery(delivery!.id).deliveredAt).toBeNull();
    } finally { core.releaseReplies(); await orch.shutdown(); await core.stop(); db.close(); await runtime.stop(); }
  });
}

for (const scope of ["project", "global", "failure", "criteria", "contract_revision", "execution_issue", "legacy_limit", "sequence"] as const) {
  test(`${scope} policy changed during real core preflight prevents physical input and preserves its queue`, async () => {
    const runtime = createIsolatedRuntime();
    const core = await capacityPeer(runtime);
    const config = loadConfig({ IAMCEO_HOME: runtime.paths.iamceoHome, IAMCEO_PORT: "0", IAMCEO_CORE_SOCKET: runtime.socketPath,
      IAMCEO_HERDR_SOCKET: runtime.herdrSocketPath, IAMCEO_CORE_BIN: runtime.bins.coreBin,
      IAMCEO_CLAUDE_BIN: runtime.bins.claudeBin, IAMCEO_CODEX_BIN: runtime.bins.codexBin });
    const db = openDb(config.dbPath), store = new Store(db, new Bus());
    const runner = new CoreRunner(runtime.runnerOptions(runtime.providerHomes), { recoveryStore: store, pollMs: 60_000, rpcTimeoutMs: 5000, sendTimeoutMs: 5000 });
    const orch = new Orchestrator({ config, store, runners: new Map([["core", runner]]), providerHomes: runtime.providerHomes,
      timings: { tickMs: 60_000, healthMs: 60_000, retryMs: 10 } });
    try {
      store.patchSettings({ maxConcurrentTurns: 2, boardTidyHours: 0 });
      const project = store.createProject({ name: "Core capacity", cwd: runtime.paths.work });
      // Count physical work writes; this fixture does not emulate CLI control commands.
      const first = await orch.createMember(project.id, { name: "First", cli: "claude", parallel: false });
      const second = await orch.createMember(project.id, { name: "Second", cli: "claude", parallel: false });
      const lead = ["criteria", "contract_revision"].includes(scope) ? store.createMember({ projectId: project.id, kind: "conductor", handle: "lead", name: "총괄", cwd: project.cwd, origin: "manual" }) : null;
      const execution = { inputs: ["현재 인계 기록"], outputs: ["인계 문서"], scope: "문서 인계", constraints: [], exclusions: [] };
      const task = scope === "failure" || scope === "sequence" ? store.saveTask({ projectId: project.id, memberId: second.id, who: "대표", title: "실패 정책 경합" }).task
        : lead ? orch.saveTask(lead, { title: "기준 정책 경합", contract: { ...execution, kind: "other", goal: "인계 문서를 전달한다", acceptance: ["담당자와 미정 사항을 확인할 수 있다"], checks: [] } }).task : null;
      await orch.assign(project.id, first.handle, { text: "First remains running" });
      core.holdNextRead();
      const secondSend = orch.assign(project.id, second.handle, { text: "Queued during cap change", ...(task ? { taskId: task.id } : {}) }, lead ?? undefined);
      await until(() => core.calls.some(call => call.method === "terminal.read" && !call.replied));
      expect(core.count("terminal.send")).toBe(1);
      if (scope === "project") await orch.patchProject(project.id, { maxConcurrentTurns: 1 });
      else if (scope === "global") await orch.updateSettings({ maxConcurrentTurns: 1 });
      else if (scope === "execution_issue" || scope === "legacy_limit") {
        store.patchMember(second.id, { lastError: "weekly usage limit reached", ...(scope === "execution_issue" ? { executionIssue: {
          kind: "usage_limit" as const, detail: "weekly usage limit reached", at: new Date().toISOString(),
          sessionGeneration: store.memberRevisions(second.id).sessionGeneration, terminalId: second.paneId, exitCode: null,
        } } : {}) });
      }
      else if (scope === "contract_revision") {
        store.saveTaskContract(task!.id, { ...execution, kind: "other", goal: "변경된 인계 범위만 확인한다", acceptance: ["변경된 범위의 검증"], checks: [] },
          { author: "대표", authorMemberId: null, authorKind: "owner" });
      }
      else if (scope === "criteria") {
        const pending = store.listTaskDeliveries(task!.id).find(delivery => delivery.memberId === second.id)!;
        expect(store.unconfirmedDelegatedTask(pending.id)).toBeNull();
        store.db.query("DELETE FROM task_contracts WHERE task_id=?").run(task!.id);
        expect(store.unconfirmedDelegatedTask(pending.id)).toBe(task!.id);
      }
      else if (scope === "sequence") {
        store.addStageMark({ projectId: project.id, taskId: task!.id, stage: "hold", memberId: null, who: "대표", evidence: "Hold during terminal preflight" });
      }
      else {
        const at = new Date().toISOString();
        store.saveTaskWatch(project.id, task!.id, { startedAt: at, attempts: 3, same: 3, fingerprint: "fail:저장 확인", lastProgressAt: at,
          trippedAt: at, reason: "같은 실패 3번", updatedAt: at, history: [] });
        store.ensureTaskFailureNotice(task!.id);
        expect(store.pendingTaskIntervention(task!.id)).not.toBeNull();
        expect(store.pendingTaskFailureDecision(task!.id)).toBeNull();
      }
      core.releaseReplies(); await secondSend;
      expect(core.count("terminal.send")).toBe(1);
      expect(core.terminals.get(first.paneId!)?.status?.state).toBe("working");
      const pending = store.listPending(second.id);
      expect(pending).toHaveLength(1);
      expect(pending[0].text).toContain("Queued during cap change");
      expect(pending[0].status).toBe("queued");
      expect(store.listPendingExecutions().map(run => run.memberId)).toEqual([first.id]);
      expect(runner.occupiesTurnSlot(second.id)).toBe(false);
      expect(store.getDeliveryRecovery(pending[0].id)?.phase).not.toBe("needs_owner");
      if (scope === "project" || scope === "global") {
        if (scope === "project") await orch.patchProject(project.id, { maxConcurrentTurns: 2 });
        else await orch.updateSettings({ maxConcurrentTurns: 2 });
        // The socket peer sees the request before the sender records its receipt.
        await until(() => store.requireDelivery(pending[0].id).status === "delivered");
        expect(core.count("terminal.send")).toBe(2);
      } else if (scope !== "contract_revision") {
        await orch.pump(second.id);
        expect(core.count("terminal.send")).toBe(1);
        expect(store.requireDelivery(pending[0].id).status).toBe("queued");
      }
      expect(core.count("terminal.interrupt")).toBe(0);
      expect(core.count("terminal.keys")).toBe(0);
      expect(core.count("terminal.kill")).toBe(0);
    } finally { core.releaseReplies(); await orch.shutdown(); await core.stop(); db.close(); await runtime.stop(); }
  }, 15_000);
}


test("quota discovered while opening an offline worker fences its input before an attempt is prepared", async () => {
  const runtime = createIsolatedRuntime(), core = await capacityPeer(runtime, "weekly usage limit reached");
  const config = loadConfig({ IAMCEO_HOME: runtime.paths.iamceoHome, IAMCEO_PORT: "0", IAMCEO_CORE_SOCKET: runtime.socketPath,
    IAMCEO_CORE_BIN: runtime.bins.coreBin, IAMCEO_CLAUDE_BIN: runtime.bins.claudeBin, IAMCEO_CODEX_BIN: runtime.bins.codexBin });
  const db = openDb(config.dbPath), store = new Store(db, new Bus());
  const runner = new CoreRunner(runtime.runnerOptions(runtime.providerHomes), { recoveryStore: store, pollMs: 60_000 });
  const orch = new Orchestrator({ config, store, runners: new Map([["core", runner]]), providerHomes: runtime.providerHomes,
    timings: { tickMs: 60_000, healthMs: 60_000 } });
  try {
    const project = store.createProject({ name: "Startup limit", cwd: runtime.paths.work });
    const member = store.createMember({ projectId: project.id, kind: "worker", handle: "worker", name: "Worker", cwd: project.cwd, origin: "runner", cli: "claude", parallel: false });
    store.patchMember(member.id, { status: "offline", backend: "core" });
    const queued = store.enqueue({ projectId: project.id, memberId: member.id, kind: "instruction", text: "Preserve this queued input", wake: true });
    await orch.pump(member.id);
    expect(core.count("terminal.run")).toBe(1);
    expect(core.count("terminal.send")).toBe(0);
    expect(store.requireMember(member.id).executionIssue?.kind).toBe("usage_limit");
    expect(store.requireDelivery(queued.id)).toMatchObject({ status: "queued", attempts: 0 });
  } finally { await orch.shutdown(); await core.stop(); db.close(); await runtime.stop(); }
});
