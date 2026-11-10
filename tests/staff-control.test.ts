// 총괄의 직원 관리(effort 를 넣은 추가·설정 바꾸기·새 세션 열기)와 터미널 조작(읽기·글·키)을 가짜 core 실행기로 본다.
// 가짜 실행기는 실제 PTY 가 아니다. 조작권은 실제 store(terminal_leases)에 저장해 서버의 세대·조작권·입력 순번 검사를 그대로 거친다.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Backend, Member } from "../shared/types.ts";
import { Bus } from "../server/bus.ts";
import { loadConfig, updateConfigFile } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { startServer } from "../server/http.ts";
import type { AgentToolDef, AgentToolResult } from "../server/orchestrator-api.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import { CoreError } from "../server/runner/core-client.ts";
import type { Runner, RunnerEvent, RunnerMember, SendResult, TerminalControlAction, TerminalControlResult } from "../server/runner/types.ts";
import { Store } from "../server/store.ts";

class FakeCore implements Runner {
  readonly kind: Backend = "core";
  busy = new Set<string>();
  typed: { memberId: string; action: string; text?: string; key?: string }[] = [];
  failNextInput: "refuse" | "uncertain" | null = null;
  started: string[] = [];
  private cb: (e: RunnerEvent) => void = () => {};
  constructor(private readonly store: () => Store) {}
  async available() { return { ok: true }; }
  async start(m: { id: string }) { this.started.push(m.id); return { sessionId: crypto.randomUUID(), paneId: `t-${m.id}` }; }
  async send(m: { id: string }): Promise<SendResult> { this.busy.add(m.id); return { ok: true }; }
  isBusy(id: string) { return this.busy.has(id); }
  async compact(): Promise<SendResult> { return { ok: true }; }
  async setParallel(): Promise<SendResult> { return { ok: true }; }
  async interrupt() {}
  async stop(m: { id: string }) { this.busy.delete(m.id); }
  async screen(m: { id: string }) { return `화면 ${m.id}\n❯ `; }
  on(cb: (e: RunnerEvent) => void) { this.cb = cb; }
  async shutdown() {}
  end(memberId: string) { this.busy.delete(memberId); this.cb({ type: "turn_end", memberId, finalText: "", isError: false }); }
  async terminalControl(m: RunnerMember, action: TerminalControlAction): Promise<TerminalControlResult> {
    const store = this.store();
    const lease = store.inputState(m.id).lease;
    if (action.action === "claim") {
      if (lease && lease.claimId !== action.leaseId && lease.leaseId !== action.leaseId) throw new CoreError("conflict", "Another terminal control lease is active");
      const next = { memberId: m.id, claimId: action.leaseId ?? crypto.randomUUID(), leaseId: lease?.leaseId ?? crypto.randomUUID(), identity: { terminalId: m.paneId ?? null, sessionId: m.sessionId ?? null, sessionGeneration: m.sessionGeneration ?? 0, process: null }, expiresAt: Date.now() + 60_000, lastInputSequence: lease?.lastInputSequence ?? 0 };
      store.saveLease(next);
      return { leaseId: next.leaseId, expiresAt: next.expiresAt };
    }
    if (action.action === "release") { if (lease) store.removeLease(m.id, lease.claimId); return {}; }
    if (!lease || action.leaseId !== lease.leaseId) throw new CoreError("conflict", "A matching active terminal control lease is required");
    if (action.action === "input" && this.failNextInput) {
      const mode = this.failNextInput; this.failNextInput = null;
      if (mode === "refuse") throw new CoreError("invalid_params", "refused");
      const e = new CoreError("timeout", "lost"); (e as { uncertain?: boolean }).uncertain = true; throw e;
    }
    store.saveLease({ ...lease, lastInputSequence: lease.lastInputSequence + 1 });
    this.typed.push({ memberId: m.id, action: action.action, text: action.text, key: action.key });
    return { leaseId: lease.leaseId, expiresAt: lease.expiresAt };
  }
  terminalLease(memberId: string) { return this.store().inputState(memberId).lease; }
}

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => { for (const c of cleanups) await c(); });
const settle = () => new Promise((r) => setTimeout(r, 30));

async function setup() {
  const home = mkdtempSync(join(tmpdir(), "iamceo-staff-"));
  const env = { IAMCEO_HOME: home, IAMCEO_PORT: "0" };
  updateConfigFile({ accessCode: "code", hosts: ["127.0.0.1"] }, env);
  const config = loadConfig(env);
  const bus = new Bus();
  const store = new Store(openDb(config.dbPath), bus);
  const runner = new FakeCore(() => store);
  const orch = new Orchestrator({ config, store, runners: new Map<Backend, Runner>([["core", runner]]) });
  const server = await startServer({ config, store, bus, orch });
  const url = server.urls[0]!;
  orch.setServerUrl(url);
  cleanups.push(async () => { await orch.shutdown(); await server.stop(); });
  const project = store.createProject({ name: "직원 관리", cwd: home });
  store.setChiefCli(project.id, "claude");
  const lead = await orch.ensureConductor(project.id);
  runner.end(lead.id);
  await settle();
  const call = async (member: Member, name: string, args: Record<string, unknown> = {}): Promise<AgentToolResult> => {
    const res = await fetch(`${url}/agent/tool`, { method: "POST", headers: { Authorization: `Bearer ${store.getMemberToken(member.id)}`, "Content-Type": "application/json" }, body: JSON.stringify({ name, args }) });
    return (await res.json()) as AgentToolResult;
  };
  const tools = async (member: Member) => ((await (await fetch(`${url}/agent/tools`, { headers: { Authorization: `Bearer ${store.getMemberToken(member.id)}` } })).json()) as AgentToolDef[]).map((t) => t.name);
  const add = async (args: Record<string, unknown>) => {
    const res = await call(lead, "team_add", args);
    const m = store.listMembers(project.id).find((x) => x.name === args.name);
    if (m) { runner.end(m.id); await settle(); }
    return { res, member: m ? store.requireMember(m.id) : null };
  };
  return { url, store, orch, runner, project, lead, call, tools, add };
}

describe("총괄의 직원 관리", () => {
  test("Claude·Codex·Antigravity 직원을 한 프로젝트에 여럿 두고, effort 를 처음부터 정한다. 지원하지 않는 값은 거절한다", async () => {
    const t = await setup();
    const a = await t.add({ name: "구현 1", role: "구현", cli: "claude", effort: "xhigh" });
    expect(a.res.isError).toBeFalsy();
    expect(a.member).toMatchObject({ cli: "claude", effortOverride: "xhigh" });
    const b = await t.add({ name: "구현 2", role: "구현", cli: "claude", effort: "high" });
    expect(b.member).toMatchObject({ cli: "claude", effortOverride: "high" });
    const c = await t.add({ name: "검토", role: "검토", cli: "codex", effort: "minimal" });
    expect(c.member).toMatchObject({ cli: "codex", effortOverride: "minimal" });
    const g = await t.add({ name: "자료 조사", role: "조사", cli: "antigravity" });
    expect(g.member).toMatchObject({ cli: "antigravity", effortOverride: null });
    expect((await t.add({ name: "잘못 1", role: "x", cli: "claude", effort: "minimal" })).res.text).toContain("지원하지 않는 effort");
    expect((await t.add({ name: "잘못 2", role: "x", cli: "antigravity", effort: "high" })).res.text).toContain("Antigravity 는 effort 를 따로 받지 않습니다");
    expect((await t.add({ name: "잘못 3", role: "x", cli: "gemini" })).res.isError).toBe(true);
    expect(t.store.listMembers(t.project.id).filter((m) => m.name.startsWith("잘못"))).toHaveLength(0);
  });

  test("team_config 는 대표 설정과 같은 저장을 쓰고, CLI 를 바꿔 맞지 않게 되는 값을 몰래 비우지 않는다", async () => {
    const t = await setup();
    const w = (await t.add({ name: "구현", role: "구현", cli: "claude" })).member!;
    const set = await t.call(t.lead, "team_config", { member: w.handle, effort: "max" });
    expect(set.isError).toBeFalsy();
    expect(set.text).toContain("effort max");
    expect(t.store.requireMember(w.id).effortOverride).toBe("max");
    const switching = await t.call(t.lead, "team_config", { member: w.handle, cli: "codex" }); // codex 에는 max 가 없다
    expect(switching.isError).toBe(true);
    expect(switching.text).toContain("effort(max)");
    expect(t.store.requireMember(w.id)).toMatchObject({ cli: "claude", effortOverride: "max" });
    const ok = await t.call(t.lead, "team_config", { member: w.handle, cli: "codex", effort: "high" });
    expect(ok.isError).toBeFalsy();
    expect(t.store.requireMember(w.id)).toMatchObject({ cli: "codex", effortOverride: "high" });
    expect((await t.call(t.lead, "team_config", { member: w.handle, effort: "turbo" })).isError).toBe(true);
    expect((await t.call(t.lead, "team_config", { member: t.lead.handle, effort: "high" })).isError).toBe(true); // 자기 자신은 못 바꾼다
  });

  test("새 관리·터미널 도구는 총괄에게만 보이고, 기록 없는 세션은 fresh 로 새로 연다", async () => {
    const t = await setup();
    const w = (await t.add({ name: "구현", role: "구현", cli: "claude" })).member!;
    expect(await t.tools(t.lead)).toEqual(expect.arrayContaining(["team_config", "terminal_read", "terminal_input", "team_resume"]));
    expect((await t.tools(w)).some((n) => ["team_config", "terminal_read", "terminal_input"].includes(n))).toBe(false);
    expect((await t.call(w, "terminal_input", { member: t.lead.handle, text: "x", operation_key: "a" })).text).toContain("쓸 수 없는 도구");
    await t.orch.sleepMember(w.id, { force: true });
    const before = t.runner.started.length;
    const fresh = await t.call(t.lead, "team_resume", { member: w.handle, fresh: true });
    expect(fresh.isError).toBeFalsy();
    expect(fresh.text).toContain("새 세션으로 열었습니다");
    expect(t.runner.started.length).toBe(before + 1);
  });
});

describe("터미널 조작(총괄 도구·대표 화면 공통 경로)", () => {
  test("글+Enter 를 조작권 안에서 넣고 놓으며, 같은 operation 은 두 번 넣지 않는다", async () => {
    const t = await setup();
    const w = (await t.add({ name: "구현", role: "구현", cli: "claude" })).member!;
    const read = JSON.parse((await t.call(t.lead, "terminal_read", { member: w.handle })).text);
    expect(read).toMatchObject({ member: w.handle, status: "idle", controlHeld: null });
    expect(read.screen).toContain("❯");
    const r1 = await t.call(t.lead, "terminal_input", { member: w.handle, text: "/model", submit: true, operation_key: "op1" });
    expect(r1.isError).toBeFalsy();
    expect(t.runner.typed.filter((x) => x.memberId === w.id)).toEqual([{ memberId: w.id, action: "input", text: "/model", key: undefined }, { memberId: w.id, action: "key", text: undefined, key: "enter" }]);
    expect(t.store.inputState(w.id).lease).toBeNull(); // 놓았다
    const r2 = await t.call(t.lead, "terminal_input", { member: w.handle, text: "/model", submit: true, operation_key: "op1" });
    expect(r2.text).toContain("넣었습니다");
    expect(t.runner.typed.filter((x) => x.memberId === w.id)).toHaveLength(2);
    // 대표 화면 경로도 같은 조작을 쓴다
    const res = await fetch(`${t.url}/api/members/${w.id}/terminal/send`, { method: "POST", headers: { Authorization: "Bearer code", "Content-Type": "application/json" }, body: JSON.stringify({ operationId: "web-1", key: "esc" }) });
    expect(await res.json()).toMatchObject({ status: "applied" });
    expect(t.runner.typed.at(-1)).toMatchObject({ memberId: w.id, action: "key", key: "esc" });
    const bad = await fetch(`${t.url}/api/members/${w.id}/terminal/send`, { method: "POST", headers: { Authorization: "Bearer code", "Content-Type": "application/json" }, body: JSON.stringify({ operationId: "web-2", key: "f13" }) });
    expect(bad.status).toBe(400);
  });

  test("일하는 중에는 글을 넣지 않고 키만, 결과가 불명확하면 먼저 읽으라고 한다, 다른 조작권이 있으면 거절한다", async () => {
    const t = await setup();
    const w = (await t.add({ name: "구현", role: "구현", cli: "claude" })).member!;
    t.store.patchMember(w.id, { status: "working" });
    const blocked = await t.call(t.lead, "terminal_input", { member: w.handle, text: "hello", operation_key: "w1" });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toContain("일하는 중이라 글을 넣지 않습니다");
    expect((await t.call(t.lead, "terminal_input", { member: w.handle, key: "esc", operation_key: "w2" })).isError).toBeFalsy();
    t.store.patchMember(w.id, { status: "idle" });

    t.runner.failNextInput = "uncertain";
    const unknown = await t.call(t.lead, "terminal_input", { member: w.handle, text: "x", operation_key: "u1" });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain("terminal_read 로 먼저 확인");

    // 대표가 화면에서 조작권을 쥔 채이면 총괄은 넣지 못한다
    await t.orch.terminalControlV2(w.id, { operationId: "rep-claim", expectedSessionGeneration: t.store.memberRevisions(w.id).sessionGeneration, claimId: "rep-hold", action: "claim" });
    const held = await t.call(t.lead, "terminal_input", { member: w.handle, text: "y", operation_key: "h1" });
    expect(held.isError).toBe(true);
    expect(t.runner.typed.filter((x) => x.text === "y")).toHaveLength(0);
  });
});
