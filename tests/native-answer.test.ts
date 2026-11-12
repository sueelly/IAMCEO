// 대화에서 직원 CLI 창에 직접 답하기: core 칸(격리 가짜 소켓)과 orchestrator 영수증·귀속 검사.
import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreRunner } from "../server/runner/core.ts";
import type { CoreTerminal } from "../server/runner/core-client.ts";
import type { NativePromptAnswer, Runner, RunnerEvent, RunnerMember, SendResult, StartOpts } from "../server/runner/types.ts";
import type { Backend, NativePrompt } from "../shared/types.ts";
import { Bus } from "../server/bus.ts";
import { loadConfig, updateConfigFile } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import { Store } from "../server/store.ts";

const fx = (name: string) => readFileSync(join(import.meta.dir, "fixtures/native-prompts", name), "utf8");
const methods = ["terminal.run", "terminal.list", "terminal.get", "terminal.read", "terminal.send", "terminal.interrupt", "terminal.kill", "terminal.keys"];
const idleScreen = `prior output\n${"─".repeat(30)}\n❯ \n${"─".repeat(30)}\n`;
const member = (extra: Partial<RunnerMember> = {}): RunnerMember => ({ id: "member-one", sessionGeneration: 1, projectId: "project-one", cli: "claude", handle: "worker", name: "Worker", cwd: "/tmp", sessionId: null, paneId: null, model: null, effort: null, subagentModel: null, permissionMode: "default", kind: "worker", ...extra });
interface Request { id: string; method: string; params: Record<string, any> }
const open: { server: Server; sockets: Set<Socket>; runners: CoreRunner[] }[] = [];
afterEach(async () => {
  for (const f of open.splice(0)) {
    await Promise.all(f.runners.map((r) => r.shutdown()));
    for (const s of f.sockets) s.destroy();
    await new Promise<void>((r) => f.server.close(() => r()));
  }
});

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "iamceo-native-answer-"));
  const socketPath = join(dir, "c.sock");
  const opts: StartOpts = { systemPromptFile: join(dir, "rules.md"), mcpConfigFile: join(dir, "mcp.json"), resume: false, projectName: "Test" };
  writeFileSync(opts.systemPromptFile, "rules");
  writeFileSync(opts.mcpConfigFile, JSON.stringify({ mcpServers: { iamceo: { command: "/bin/echo", args: [], env: { IAMCEO_TOKEN: "secret", IAMCEO_URL: "http://localhost:1" } } } }));
  const calls: Request[] = [];
  const terminals = new Map<string, CoreTerminal>();
  let screen = idleScreen;
  let onWrite: ((r: Request) => void) | null = null;
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const nl = buffer.indexOf("\n"); const request = JSON.parse(buffer.slice(0, nl)) as Request; buffer = buffer.slice(nl + 1); calls.push(request);
        const p = request.params; let result: unknown;
        if (request.method === "hello") result = { generation: 1, version: "test", methods, features: [] };
        else if (request.method === "terminal.list") result = { terminals: [...terminals.values()].filter((t) => Object.entries(p.labels || {}).every(([k, v]) => t.labels[k] === v)) };
        else if (request.method === "terminal.run") {
          const t: CoreTerminal = { address: `t${terminals.size + 1}`, argv: p.argv, cwd: p.cwd, labels: p.labels, state: "live", cols: 200, rows: 120, turn: 0, status: { state: "idle", app: "claude-code" }, reported: true };
          terminals.set(t.address, t); result = t;
        } else if (request.method === "terminal.get") result = terminals.get(p.terminal);
        else if (request.method === "terminal.read") result = { text: screen, complete: true, how: "screen" };
        else if (request.method === "terminal.send" || request.method === "terminal.keys") { onWrite?.(request); result = { status: "working", turn: 1, started: true }; }
        else if (request.method === "terminal.kill") { const t = terminals.get(p.terminal)!; t.state = "finished"; result = t; }
        socket.write(JSON.stringify(result === undefined ? { jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "no", data: { kind: "not_found" } } } : { jsonrpc: "2.0", id: request.id, result }) + "\n");
      }
    });
  });
  await new Promise<void>((r) => server.listen(socketPath, r));
  const runners: CoreRunner[] = [];
  open.push({ server, sockets, runners });
  const runner = new CoreRunner({ socketPath, claudeBin: "/fake/claude", codexBin: "/fake/codex", claudeHome: join(dir, "ch"), codexHome: join(dir, "xh"), contextHome: dir }, { pollMs: 10000, rpcTimeoutMs: 200, sendTimeoutMs: 200 });
  runners.push(runner);
  const m = member();
  const started = await runner.start(m, opts);
  const terminal = terminals.get(started.paneId!)!;
  const block = (s: string) => { terminal.status = { state: "blocked", kind: "selection" } as CoreTerminal["status"]; screen = s; };
  const writes = () => calls.filter((c) => c.method === "terminal.keys" || c.method === "terminal.send");
  return { runner, m, terminal, block, writes, setScreen: (s: string) => { screen = s; }, setOnWrite: (f: typeof onWrite) => { onWrite = f; } };
}

describe("core: 대화에서 창에 답하기", () => {
  test("막힌 질문 창을 읽고, 고른 줄까지 화살표 + Enter 한 번만 보낸다. 같은 창에는 다시 넣지 않는다", async () => {
    const f = await fixture();
    f.block(fx("codex-mcp-approval.txt"));
    const read = (await f.runner.nativePrompt!(f.m))!;
    expect(read.prompt.question).toBe('Allow the iamceo MCP server to run tool "status"?');
    expect(read.promptKey).toMatch(/^1:0:\d+:[0-9a-f]{24}$/);
    const r = await f.runner.answerNativePrompt!(f.m, read.promptKey, 2);
    expect(r).toMatchObject({ ok: true, chosen: { n: 2, label: "Allow for this session" } });
    expect(f.writes().map((c) => [c.method, c.params.keys ?? c.params.text])).toEqual([["terminal.keys", ["down", "enter"]]]);
    // 응답을 잃고 같은 창 키로 다시 와도 넣지 않는다
    expect(await f.runner.answerNativePrompt!(f.m, read.promptKey, 2)).toMatchObject({ ok: false, reason: "already" });
    expect(await f.runner.nativePrompt!(f.m)).toBeNull();
    expect(f.writes()).toHaveLength(1);
  });

  test("자유 응답: 그 줄로 옮긴 뒤 글을 한 번 붙여 넣어 낸다(Enter 를 따로 누르지 않는다)", async () => {
    const f = await fixture();
    f.block(fx("claude-ask-free.txt").replace("❯ 4. Type something.", "  4. Type something.").replace("  1. 사과", "❯ 1. 사과"));
    const read = (await f.runner.nativePrompt!(f.m))!;
    expect(read.prompt.selected).toBe(0);
    expect(await f.runner.answerNativePrompt!(f.m, read.promptKey, 1, "귤")).toMatchObject({ ok: false, reason: "no_option" });
    expect(await f.runner.answerNativePrompt!(f.m, read.promptKey, 4)).toMatchObject({ ok: false, reason: "needs_text" });
    expect(f.writes()).toHaveLength(0);
    expect(await f.runner.answerNativePrompt!(f.m, read.promptKey, 4, "  귤 ")).toMatchObject({ ok: true });
    expect(f.writes().map((c) => [c.method, c.params.keys ?? c.params.text, c.params.force ?? null])).toEqual([["terminal.keys", ["down", "down", "down"], null], ["terminal.send", "귤", true]]);
  });

  test("창이 바뀌었거나, 확실히 읽지 못했거나, 막힘이 아니면 넣지 않는다", async () => {
    const f = await fixture();
    f.block(fx("claude-bash-permission.txt"));
    const read = (await f.runner.nativePrompt!(f.m))!;
    f.setScreen(fx("claude-bash-permission.txt").replaceAll("touch probe-claude.txt", "rm -rf probe"));
    expect(await f.runner.answerNativePrompt!(f.m, read.promptKey, 1)).toMatchObject({ ok: false, reason: "changed" });
    f.setScreen("  ❯ 하나\n  ❯ 둘\n\n  Enter to confirm · Esc to cancel");
    const limited = (await f.runner.nativePrompt!(f.m))!;
    expect(limited.prompt.limited).toBe(true);
    expect(await f.runner.answerNativePrompt!(f.m, limited.promptKey, 1)).toMatchObject({ ok: false, reason: "unrecognized" });
    f.terminal.status = { state: "idle" } as CoreTerminal["status"]; f.setScreen(idleScreen);
    expect(await f.runner.nativePrompt!(f.m)).toBeNull();
    expect(await f.runner.answerNativePrompt!(f.m, read.promptKey, 1)).toMatchObject({ ok: false, reason: "not_blocked" });
    expect(f.writes()).toHaveLength(0);
  });

  test("동시에 두 번 눌러도 칸에는 한 번만 들어간다", async () => {
    const f = await fixture();
    f.block(fx("agy-run-permission.txt"));
    const read = (await f.runner.nativePrompt!(f.m))!;
    const both = await Promise.all([f.runner.answerNativePrompt!(f.m, read.promptKey, 1), f.runner.answerNativePrompt!(f.m, read.promptKey, 1)]);
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    expect(both.find((r) => !r.ok)).toMatchObject({ ok: false });
    expect(f.writes()).toHaveLength(1);
  });

  test("답한 뒤 같은 내용의 창이 새로 뜨면(막힘이 풀렸다 다시) 새 창으로 센다", async () => {
    const f = await fixture();
    f.block(fx("codex-mcp-approval.txt"));
    const first = (await f.runner.nativePrompt!(f.m))!;
    expect(await f.runner.answerNativePrompt!(f.m, first.promptKey, 1)).toMatchObject({ ok: true });
    f.terminal.status = { state: "working" } as CoreTerminal["status"]; f.setScreen(idleScreen);
    expect(await f.runner.nativePrompt!(f.m)).toBeNull();
    f.block(fx("codex-mcp-approval.txt"));
    const again = (await f.runner.nativePrompt!(f.m))!;
    expect(again.promptKey).not.toBe(first.promptKey);
    expect(await f.runner.answerNativePrompt!(f.m, again.promptKey, 1)).toMatchObject({ ok: true });
    expect(f.writes()).toHaveLength(2);
  });
});

/** 창 하나를 가진 가짜 실행기. 답은 기록만 한다. */
class PromptRunner implements Runner {
  readonly kind: Backend = "headless";
  prompt: { prompt: NativePrompt; promptKey: string } | null = null;
  answers: { promptKey: string; option: number; text?: string }[] = [];
  result: NativePromptAnswer | null = null;
  gate: Promise<void> = Promise.resolve();
  private cb: (e: RunnerEvent) => void = () => {};
  async available() { return { ok: true }; }
  async start() { return { sessionId: crypto.randomUUID(), paneId: null }; }
  async send(): Promise<SendResult> { return { ok: true }; }
  isBusy() { return false; }
  async compact(): Promise<SendResult> { return { ok: true }; }
  async setParallel(): Promise<SendResult> { return { ok: true }; }
  async interrupt() {}
  async stop() {}
  async screen() { return ""; }
  on(cb: (e: RunnerEvent) => void) { this.cb = cb; }
  async shutdown() {}
  async nativePrompt() { return this.prompt; }
  async answerNativePrompt(_m: RunnerMember, promptKey: string, option: number, text?: string): Promise<NativePromptAnswer> {
    await this.gate;
    this.answers.push({ promptKey, option, ...(text ? { text } : {}) });
    return this.result ?? { ok: true, prompt: this.prompt!.prompt, chosen: this.prompt!.prompt.options.find((o) => o.n === option)! };
  }
}

async function orchSetup() {
  const home = mkdtempSync(join(tmpdir(), "iamceo-native-orch-"));
  const env = { IAMCEO_HOME: home, IAMCEO_PORT: "0" };
  updateConfigFile({ accessCode: "code", hosts: ["127.0.0.1"] }, env);
  const config = loadConfig(env);
  const store = new Store(openDb(config.dbPath), new Bus());
  const runner = new PromptRunner();
  const orch = new Orchestrator({ config, store, runners: new Map<Backend, Runner>([["headless", runner]]) });
  const project = store.createProject({ name: "시험", cwd: home });
  const w = store.createMember({ projectId: project.id, kind: "worker", name: "결제", handle: "pay", role: "개발", backend: "headless" } as never);
  store.patchMember(w.id, { status: "blocked", blockedReason: "permission" });
  const { parseNativePrompt } = await import("../server/runner/prompt.ts");
  runner.prompt = { prompt: parseNativePrompt(fx("codex-mcp-approval.txt"), "codex")!, promptKey: "0:0:1:abc" };
  return { orch, store, runner, project, w };
}

describe("orchestrator: 영수증·귀속", () => {
  test("카드는 귀속을 고정하고, 같은 operationId 는 처음 결과를 돌려주며, 대화에 한 줄 남긴다", async () => {
    const t = await orchSetup();
    const state = await t.orch.memberNativePrompt(t.w.id);
    expect(state.context).toMatchObject({ projectId: t.project.id, memberId: t.w.id, generation: 0, executionId: null, taskId: null, promptId: "0:0:1:abc" });
    const req = { operationId: "op-1", promptId: "0:0:1:abc", generation: 0, executionId: null, option: 1 };
    const [a, b] = await Promise.all([t.orch.answerNativePrompt(t.w.id, req), t.orch.answerNativePrompt(t.w.id, req)]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ status: "answered", option: 1, label: "Allow" });
    expect(await t.orch.answerNativePrompt(t.w.id, req)).toEqual(a);
    expect(t.runner.answers).toHaveLength(1);
    expect(t.store.listMessages(t.project.id).some((m) => m.kind === "시스템" && m.body.includes("결제의 권한 창에 대표가 대화에서 답함 — 1번 'Allow'"))).toBe(true);
    await expect(t.orch.answerNativePrompt(t.w.id, { ...req, promptId: "other" })).rejects.toThrow("operationId");
    await t.orch.shutdown();
  });

  test("세대·실행이 카드와 다르면 넣지 않고, 실행기의 거절은 사람 말로 돌려준다", async () => {
    const t = await orchSetup();
    expect(await t.orch.answerNativePrompt(t.w.id, { operationId: "op-g", promptId: "0:0:1:abc", generation: 7, executionId: null, option: 1 })).toMatchObject({ status: "stale" });
    expect(await t.orch.answerNativePrompt(t.w.id, { operationId: "op-e", promptId: "0:0:1:abc", generation: 0, executionId: "run-x", option: 1 })).toMatchObject({ status: "stale" });
    expect(t.runner.answers).toHaveLength(0);
    t.runner.result = { ok: false, reason: "leased" };
    expect(await t.orch.answerNativePrompt(t.w.id, { operationId: "op-l", promptId: "0:0:1:abc", generation: 0, executionId: null, option: 1 })).toMatchObject({ status: "busy", note: expect.stringContaining("조작 중") });
    t.runner.result = { ok: false, reason: "not_blocked" };
    expect(await t.orch.answerNativePrompt(t.w.id, { operationId: "op-n", promptId: "0:0:1:abc", generation: 0, executionId: null, option: 1 })).toMatchObject({ status: "already_answered" });
    await t.orch.shutdown();
  });
});
