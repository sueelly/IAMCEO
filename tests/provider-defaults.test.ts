import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { Bus } from "../server/bus.ts";
import { loadConfig } from "../server/config.ts";
import { MIGRATIONS, openDb } from "../server/db.ts";
import { handleAgentTool } from "../server/agent-tools.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import type { Runner, RunnerMember, SendResult } from "../server/runner/types.ts";
import { Store } from "../server/store.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";

// Only the external process boundary is fake. Real Store/Orchestrator/MCP code
// chooses, validates, persists and passes the provider to this in-memory runner.
class MemoryRunner implements Runner {
  readonly kind = "headless" as const;
  started: RunnerMember[] = [];
  async available() { return { ok: true }; }
  async start(member: RunnerMember) { this.started.push(member); return { sessionId: `session-${member.id}`, paneId: null }; }
  async send(): Promise<SendResult> { throw new Error("Unexpected agent input in provider-default tests"); }
  isBusy() { return false; }
  async compact(): Promise<SendResult> { return { ok: true }; }
  async setParallel(): Promise<SendResult> { return { ok: true }; }
  async interrupt() {}
  async stop() {}
  async screen() { return ""; }
  on() {}
  async shutdown() {}
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function fixture() {
  const runtime = createIsolatedRuntime();
  const config = loadConfig(runtime.childEnv());
  const store = new Store(openDb(config.dbPath), new Bus());
  const runner = new MemoryRunner();
  const orch = new Orchestrator({ config, store, runners: new Map([["headless", runner]]), providerHomes: runtime.providerHomes,
    serverUrl: "http://127.0.0.1:1", timings: { healthMs: 60_000, tickMs: 60_000 } });
  cleanups.push(async () => { await orch.shutdown(); store.db.close(); await runtime.stop(); });
  return { runtime, store, runner, orch };
}

describe("new provider defaults", () => {
  test("new headquarters and project chiefs start Codex with CLI model defaults", async () => {
    const f = fixture();
    const hq = await f.orch.ensureConductor("hq");
    const project = await f.orch.createProject({ name: "새 프로젝트", cwd: f.runtime.paths.work, startConductor: true });
    expect(hq.cli).toBe("codex");
    expect(f.store.chiefCli(project.id)).toBe("codex");
    expect(project.chiefCli).toBe("codex");
    expect(f.store.getConductor(project.id)?.cli).toBe("codex");
    expect(f.runner.started.map(member => ({ cli: member.cli, model: member.model, effort: member.effort })))
      .toEqual([{ cli: "codex", model: null, effort: null }, { cli: "codex", model: null, effort: null }]);
  });

  test("Store creation resolves project defaults and honors explicit Claude workers", () => {
    const { store, runtime } = fixture();
    const project = store.createProject({ name: "새 팀", cwd: runtime.paths.work });
    expect(store.chiefCli(project.id)).toBe("codex");
    expect(store.createMember({ projectId: project.id, handle: "default", name: "기본 직원", kind: "worker" }).cli).toBe("codex");
    expect(store.createMember({ projectId: project.id, handle: "explicit", name: "Claude 직원", kind: "worker", cli: "claude" }).cli).toBe("claude");
    const oldChoice = store.createProject({ name: "Claude 팀", cwd: runtime.paths.work, chiefCli: "claude" });
    expect(oldChoice.chiefCli).toBe("claude");
    expect(store.createMember({ projectId: oldChoice.id, handle: "inherited", name: "상속 직원", kind: "worker" }).cli).toBe("claude");
  });

  test.each(["claude", "codex"] as const)("workers inherit the selected %s chief and validate that provider's model", async cli => {
    const f = fixture();
    const project = await f.orch.createProject({ name: "선택한 팀", cwd: f.runtime.paths.work, chiefCli: cli });
    const model = cli === "claude" ? "sonnet" : "gpt-6-luna";
    const noChief = (await f.orch.addMember(project.id, { name: "총괄 전 직원", modelOverride: model })).member;
    expect(noChief.cli).toBe(cli);
    const chief = await f.orch.ensureConductor(project.id);
    expect(chief.cli).toBe(cli);
    const worker = (await f.orch.addMember(project.id, { name: "총괄 후 직원", modelOverride: model })).member;
    expect(worker.cli).toBe(cli);
    expect(worker.modelOverride).toBe(model);
    const explicit = (await f.orch.addMember(project.id, { name: "명시한 직원", cli: "claude", modelOverride: "sonnet" })).member;
    expect(explicit.cli).toBe("claude");
  });

  test("workers follow the actual conductor after its provider differs from the stored project choice", async () => {
    const f = fixture();
    const project = f.store.createProject({ name: "전환한 팀", cwd: f.runtime.paths.work, chiefCli: "codex" });
    f.store.createMember({ projectId: project.id, handle: "chief", name: "기존 총괄", kind: "conductor", cli: "claude" });
    const worker = (await f.orch.addMember(project.id, { name: "새 직원", modelOverride: "sonnet" })).member;
    expect(worker.cli).toBe("claude");
    expect(f.store.createMember({ projectId: project.id, handle: "direct", name: "직접 추가", kind: "worker" }).cli).toBe("claude");
  });

  test("MCP creates Codex projects and inherits their chief for omitted team_add CLI", async () => {
    const f = fixture();
    const root = await f.orch.ensureConductor("hq");
    expect((await handleAgentTool(f.orch, root, "project_create", { name: "MCP 팀", cwd: f.runtime.paths.work })).isError).toBeUndefined();
    const project = f.store.listProjects().find(project => project.name === "MCP 팀")!;
    expect(f.store.chiefCli(project.id)).toBe("codex");
    const chief = await f.orch.ensureConductor(project.id);
    expect((await handleAgentTool(f.orch, chief, "team_add", { name: "MCP 직원", role: "검토", model: "gpt-6-luna" })).isError).toBeUndefined();
    expect(f.store.findMember(project.id, "MCP 직원")?.cli).toBe("codex");
  });

  test("opening an original-schema database preserves implicit Claude chiefs and session identity", () => {
    const runtime = createIsolatedRuntime();
    const path = join(runtime.paths.iamceoHome, "historical.db");
    cleanups.push(() => runtime.stop());
    const old = new Database(path, { create: true });
    old.exec(MIGRATIONS[0]!);
    old.exec("PRAGMA user_version = 1");
    old.exec(`INSERT INTO projects (id,name,is_hq,cwd,backend,permission_mode,runner_enabled,created_at,updated_at)
      VALUES ('hq','본사',1,'/old','herdr','default',1,'old','old');
      INSERT INTO members (id,project_id,handle,name,kind,origin,status,cwd,session_id,pane_id,token,created_at,updated_at)
      VALUES ('legacy','hq','root','기존 본사 AI','root','runner','asleep','/old','claude-session','old-pane','token','old','old');`);
    old.close();
    const store = new Store(openDb(path), new Bus());
    try {
      expect(store.chiefCli("hq")).toBe("claude");
      expect(store.requireMember("legacy")).toMatchObject({ cli: "claude", sessionId: "claude-session", paneId: "old-pane" });
      expect(store.createMember({ projectId: "hq", handle: "worker", name: "상속 직원", kind: "worker" }).cli).toBe("claude");
    } finally { store.db.close(); }
  });
});
