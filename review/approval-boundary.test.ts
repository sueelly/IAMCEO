// 결재함에서 직원 CLI 승인 창에 답하기(대표 2026-11-17 "터미널 승인하는 거 결재함에서 클릭할 수 있도록 해").
// core 칸은 격리 가짜 소켓(실제 CLI·herdr-core 없음), 오케스트레이터는 실제 SQLite 다. 단계(창 확인·응답 기록·터미널 접수·이후 상태)와
// 낡은 카드·다른 직원/프로젝트·중복·응답 유실·재시작을 본다.
import { testTempDir } from "../tests/fixtures/test-run-dirs";
import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CoreRunner } from "../server/runner/core.ts";
import type { CoreTerminal } from "../server/runner/core-client.ts";
import { parseNativePrompt } from "../server/runner/prompt.ts";
import type { NativePromptAnswer, Runner, RunnerEvent, RunnerMember, SendResult, StartOpts } from "../server/runner/types.ts";
import type { Backend, NativePrompt } from "../shared/types.ts";
import { Bus } from "../server/bus.ts";
import { loadConfig, updateConfigFile } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import { Store } from "../server/store.ts";

const fx = (name: string) => readFileSync(join(import.meta.dir, "../tests/fixtures/native-prompts", name), "utf8");
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

async function coreFixture() {
  const dir = testTempDir("iamceo-inbox-approval-");
  const socketPath = join(dir, "c.sock");
  const opts: StartOpts = { systemPromptFile: join(dir, "rules.md"), mcpConfigFile: join(dir, "mcp.json"), resume: false, projectName: "Test" };
  writeFileSync(opts.systemPromptFile, "rules");
  writeFileSync(opts.mcpConfigFile, JSON.stringify({ mcpServers: { iamceo: { command: "/bin/echo", args: [], env: { IAMCEO_TOKEN: "secret", IAMCEO_URL: "http://localhost:1" } } } }));
  const calls: Request[] = [];
  const terminals = new Map<string, CoreTerminal>();
  let screen = idleScreen;
  let onKeys: ((r: Request) => void) | null = null;
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
        else if (request.method === "terminal.send" || request.method === "terminal.keys") { onKeys?.(request); result = { turn: 1 }; }
        else if (request.method === "terminal.kill") { const t = terminals.get(p.terminal)!; t.state = "finished"; result = t; }
        socket.write(JSON.stringify(result === undefined ? { jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "no", data: { kind: "not_found" } } } : { jsonrpc: "2.0", id: request.id, result }) + "\n");
      }
    });
  });
  await new Promise<void>((r) => server.listen(socketPath, r));
  const runners: CoreRunner[] = [];
  open.push({ server, sockets, runners });
  const newRunner = () => {
    const r = new CoreRunner({ socketPath, claudeBin: "/fake/claude", codexBin: "/fake/codex", claudeHome: join(dir, "ch"), codexHome: join(dir, "xh"), contextHome: dir }, { pollMs: 10000, rpcTimeoutMs: 200, sendTimeoutMs: 200, acceptCheckMs: 120 });
    runners.push(r);
    return r;
  };
  const runner = newRunner();
  const m = member();
  const started = await runner.start(m, opts);
  const terminal = terminals.get(started.paneId!)!;
  const block = (s: string) => { terminal.status = { state: "blocked", kind: "permission" } as CoreTerminal["status"]; screen = s; };
  const writes = () => calls.filter((c) => c.method === "terminal.keys" || c.method === "terminal.send");
  /** 키를 받으면 창이 닫히고 CLI 가 일을 시작한다(실제 CLI 와 같은 모양) */
  const acceptOnKeys = () => { onKeys = () => { terminal.status = { state: "working" } as CoreTerminal["status"]; screen = idleScreen; }; };
  return { runner, newRunner, m, opts, terminal, block, writes, acceptOnKeys, setScreen: (s: string) => { screen = s; } };
}

describe("core: 결재함 답의 터미널 접수 확인", () => {
  test("키를 넣은 뒤 창이 닫히면 접수로, 그 뒤 상태(일하는 중)를 함께 돌려준다. 창을 처음 본 시각은 다시 읽어도 같다", async () => {
    const f = await coreFixture();
    f.block(fx("claude-bash-permission.txt"));
    const first = (await f.runner.nativePrompt!(f.m))!;
    await Bun.sleep(5);
    const again = (await f.runner.nativePrompt!(f.m))!;
    expect(again.promptKey).toBe(first.promptKey);
    expect(again.observedAt).toBe(first.observedAt);
    f.acceptOnKeys();
    const r = await f.runner.answerNativePrompt!(f.m, first.promptKey, 1);
    expect(r).toMatchObject({ ok: true, chosen: { n: 1 }, terminal: "accepted", after: "working" });
    expect(f.writes()).toHaveLength(1);
  });

  test("키를 넣었는데 창이 그대로면 '확인 필요'로 두고, 같은 창에 다시 넣지 않는다", async () => {
    const f = await coreFixture();
    f.block(fx("claude-bash-permission.txt"));
    const read = (await f.runner.nativePrompt!(f.m))!;
    const r = await f.runner.answerNativePrompt!(f.m, read.promptKey, 1);
    expect(r).toMatchObject({ ok: true, terminal: "unconfirmed" });
    expect(await f.runner.answerNativePrompt!(f.m, read.promptKey, 1)).toMatchObject({ ok: false, reason: "already" });
    expect(f.writes()).toHaveLength(1);
  });

  test("실행기를 다시 띄우면 그 전에 읽은 창 차례로는 넣지 않는다(서버 재시작 전 카드)", async () => {
    const f = await coreFixture();
    f.block(fx("codex-mcp-approval.txt"));
    const before = (await f.runner.nativePrompt!(f.m))!;
    await f.runner.shutdown();
    const next = f.newRunner();
    await next.start(f.m, { ...f.opts, resume: true });
    const now = (await next.nativePrompt!(f.m))!;
    expect(now.prompt.fingerprint).toBe(before.prompt.fingerprint);
    expect(now.promptKey).not.toBe(before.promptKey);
    expect(await next.answerNativePrompt!(f.m, before.promptKey, 1)).toMatchObject({ ok: false, reason: "changed" });
    expect(f.writes()).toHaveLength(0);
  });
});

/** 창 하나를 가진 가짜 실행기. 답은 기록만 한다. */
class PromptRunner implements Runner {
  readonly kind: Backend = "headless";
  prompt: { prompt: NativePrompt; promptKey: string; observedAt: string } | null = null;
  answers: { promptKey: string; option: number }[] = [];
  result: NativePromptAnswer | null = null;
  throws: Error | null = null;
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
  async answerNativePrompt(_m: RunnerMember, promptKey: string, option: number): Promise<NativePromptAnswer> {
    this.answers.push({ promptKey, option });
    if (this.throws) throw this.throws;
    return this.result ?? { ok: true, prompt: this.prompt!.prompt, chosen: this.prompt!.prompt.options.find((o) => o.n === option)!, terminal: "accepted", after: "working" };
  }
}

async function orchSetup(screen = fx("claude-bash-permission.txt"), provider: "claude" | "codex" = "claude") {
  const home = testTempDir("iamceo-inbox-orch-");
  const env = { IAMCEO_HOME: home, IAMCEO_PORT: "0" };
  updateConfigFile({ accessCode: "access-code-for-test-0001", hosts: ["127.0.0.1"] }, env);
  const config = loadConfig(env);
  const db = openDb(config.dbPath);
  const store = new Store(db, new Bus());
  const runner = new PromptRunner();
  const orch = new Orchestrator({ config, store, runners: new Map<Backend, Runner>([["headless", runner]]) });
  const project = store.createProject({ name: "시험", cwd: home });
  const other = store.createProject({ name: "다른", cwd: home });
  const w = store.createMember({ projectId: project.id, kind: "worker", name: "결제", handle: "pay", role: "개발", backend: "headless" } as never);
  const w2 = store.createMember({ projectId: project.id, kind: "worker", name: "검색", handle: "search", role: "개발", backend: "headless" } as never);
  for (const id of [w.id, w2.id]) store.patchMember(id, { status: "blocked", blockedReason: "permission" });
  runner.prompt = { prompt: parseNativePrompt(screen, provider)!, promptKey: "boot:0:0:1:abc", observedAt: "2026-11-17T03:00:00.000Z" };
  const reopen = () => new Orchestrator({ config, store, runners: new Map<Backend, Runner>([["headless", runner]]) });
  return { orch, reopen, store, runner, project, other, w, w2, config };
}
const ask = (t: Awaited<ReturnType<typeof orchSetup>>, extra: Record<string, unknown> = {}) =>
  ({ operationId: "op-1", projectId: t.project.id, memberId: t.w.id, promptId: "boot:0:0:1:abc", generation: 0, executionId: null, option: 1, ...extra }) as never;

test('independent in-flight same operation different choice must conflict',async()=>{
 const t=await orchSetup();
 const first=t.orch.answerNativePrompt(t.w.id,ask(t));
 const other=await t.orch.answerNativePrompt(t.w.id,ask(t,{option:2})).then(value=>({status:200,value}),e=>({status:e.status,error:e.message}));
 const normal=await first;writeFileSync(join(process.env.REVIEW_STAGE!,'inflight-different-choice.json'),JSON.stringify({normal,other,inputs:t.runner.answers},null,2));
 await t.orch.shutdown();expect(normal.option).toBe(1);expect(t.runner.answers).toHaveLength(1);expect(other.status).toBe(409);
});
test('independent in-flight same operation same choice reuses receipt once',async()=>{
 const t=await orchSetup();const a=t.orch.answerNativePrompt(t.w.id,ask(t)),b=t.orch.answerNativePrompt(t.w.id,ask(t));expect(await b).toEqual(await a);expect(t.runner.answers).toHaveLength(1);await t.orch.shutdown();
});

describe("orchestrator: 결재함 카드 귀속·영수증", () => {
  test("카드는 창을 처음 본 시각을 싣고, 영수증은 응답 기록·터미널 접수·이후 상태를 나눠 싣는다", async () => {
    const t = await orchSetup();
    const state = await t.orch.memberNativePrompt(t.w.id);
    expect(state.context).toMatchObject({ projectId: t.project.id, memberId: t.w.id, promptId: "boot:0:0:1:abc", observedAt: "2026-11-17T03:00:00.000Z" });
    const r = await t.orch.answerNativePrompt(t.w.id, ask(t));
    expect(r).toMatchObject({ status: "answered", option: 1, terminal: "accepted", after: "working", observedAt: "2026-11-17T03:00:00.000Z" });
    expect(typeof r.at).toBe("string");
    await t.orch.shutdown();
  });

  test("다른 직원·다른 프로젝트의 카드는 넣지 않는다", async () => {
    const t = await orchSetup();
    expect(await t.orch.answerNativePrompt(t.w2.id, ask(t, { operationId: "op-x" }))).toMatchObject({ status: "stale", terminal: "not_sent" });
    expect(await t.orch.answerNativePrompt(t.w.id, ask(t, { operationId: "op-y", projectId: t.other.id }))).toMatchObject({ status: "stale", terminal: "not_sent" });
    expect(t.runner.answers).toHaveLength(0);
    await t.orch.shutdown();
  });

  test("같은 operationId 는 서버를 다시 띄운 뒤에도 처음 결과만 돌려주고 다시 넣지 않는다", async () => {
    const t = await orchSetup();
    const first = await t.orch.answerNativePrompt(t.w.id, ask(t));
    await t.orch.shutdown();
    const again = t.reopen();
    expect(await again.answerNativePrompt(t.w.id, ask(t))).toEqual(first);
    expect(t.runner.answers).toHaveLength(1);
    await expect(again.answerNativePrompt(t.w.id, ask(t, { option: 2 }))).rejects.toThrow("operationId");
    await again.shutdown();
  });

  test("넣는 중 결과를 모르면 'unknown' 으로 남기고, 같은 요청을 다시 받아도 넣지 않는다", async () => {
    const t = await orchSetup();
    t.runner.throws = new Error("socket closed after write");
    const r = await t.orch.answerNativePrompt(t.w.id, ask(t));
    expect(r).toMatchObject({ status: "unknown", terminal: "unknown" });
    t.runner.throws = null;
    expect(await t.orch.answerNativePrompt(t.w.id, ask(t))).toEqual(r);
    expect(t.runner.answers).toHaveLength(1);
    await t.orch.shutdown();
  });

  test("서버가 기록만 하고 멈췄던 요청(대기 영수증)은 다시 받아도 넣지 않고 '모름'으로 답한다", async () => {
    const t = await orchSetup();
    t.store.beginNativeAnswer({ operationId: "op-crash", projectId: t.project.id, memberId: t.w.id, request: ask(t, { operationId: "op-crash" }) });
    const r = await t.reopen().answerNativePrompt(t.w.id, ask(t, { operationId: "op-crash" }));
    expect(r).toMatchObject({ status: "unknown", terminal: "unknown" });
    expect(t.runner.answers).toHaveLength(0);
    await t.orch.shutdown();
  });

  test("창 글의 비밀값은 가려 보이고, 답은 원래 창 차례로 넣는다", async () => {
    const token = "sk-live-0123456789abcdefghijklmnop";
    const t = await orchSetup(fx("claude-bash-permission.txt").replace("touch probe-claude.txt", `curl -H "x-key: ${token}" https://example.test && echo access-code-for-test-0001`));
    const state = await t.orch.memberNativePrompt(t.w.id);
    const shown = JSON.stringify(state.prompt);
    expect(shown).not.toContain(token);
    expect(shown).not.toContain("access-code-for-test-0001");
    expect(shown).toContain("[가림");
    expect(state.prompt!.options.map((o) => o.label)).toEqual(t.runner.prompt!.prompt.options.map((o) => o.label));
    expect(await t.orch.answerNativePrompt(t.w.id, ask(t))).toMatchObject({ status: "answered" });
    expect(t.runner.answers).toEqual([{ promptKey: "boot:0:0:1:abc", option: 1 }]);
    await t.orch.shutdown();
  });

  test("core 직원 승인 대기 알림에 창 요약을 싣는다", async () => {
    const t = await orchSetup();
    const sent: [string, string][] = [];
    (t.orch as unknown as { notifyInbox: (a: string, b: string) => void }).notifyInbox = (a, b) => { sent.push([a, b]); };
    await (t.orch as unknown as { notifyBlocked: (m: unknown) => Promise<void> }).notifyBlocked(t.store.requireMember(t.w.id));
    expect(sent).toHaveLength(1);
    expect(sent[0]![1]).toContain("touch probe-claude.txt");
    expect(sent[0]![1]).toContain("결재함");
    await t.orch.shutdown();
  });
});
