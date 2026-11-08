import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../server/bus.ts";
import { loadConfig } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { createOrchestrator, Orchestrator } from "../server/orchestrator.ts";
import { Store } from "../server/store.ts";
import { DEFAULT_RANKS, memberConfig } from "../shared/types.ts";
import type { Runner } from "../server/runner/types.ts";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(fn => fn())); });
test("new configuration defaults to Codex, allows explicit Claude and rejects unknown providers", () => {
  const home = mkdtempSync(join(tmpdir(), "iamceo-provider-"));
  expect(loadConfig({ IAMCEO_HOME: home }).agentCli).toBe("codex");
  expect(loadConfig({ IAMCEO_HOME: home, IAMCEO_AGENT_CLI: "claude" }).agentCli).toBe("claude");
  expect(() => loadConfig({ IAMCEO_HOME: home, IAMCEO_AGENT_CLI: "invalid" })).toThrow();
});
test("Codex rank defaults never inherit historical Claude model names", () => {
  const home = mkdtempSync(join(tmpdir(), "iamceo-ranks-"));
  const db = openDb(join(home, "state.db")), store = new Store(db, new Bus());
  try {
    store.patchSettings({ ranks: { manager: { model: "opus" }, staff: { model: "sonnet" } } });
    const member = { cli: "codex" as const, kind: "conductor" as const, modelOverride: null, effortOverride: null };
    const initial = store.getSettings();
    expect(memberConfig(member, initial.ranks, initial.codexRanks).model).toBeNull();
    store.patchSettings({ codexRanks: { manager: { model: "codex-test-model" } } });
    const settings = store.getSettings();
    expect(memberConfig(member, settings.ranks, settings.codexRanks).model).toBe("codex-test-model");
    expect(memberConfig({ ...member, cli: "claude" }, settings.ranks, settings.codexRanks).model).toBe("opus");
    expect(settings.codexRanks?.staff.model).toBeNull();
  } finally { db.close(); }
});
test("missing Codex does not disconnect an existing working Claude project", async () => {
  const home = mkdtempSync(join(tmpdir(), "iamceo-health-"));
  const config = loadConfig({ IAMCEO_HOME: home, IAMCEO_AGENT_CLI: "codex", IAMCEO_CODEX_BIN: join(home, "missing-codex"), IAMCEO_CLAUDE_BIN: process.execPath, IAMCEO_HERDR_SOCKET: join(home, "no-herdr.sock") });
  const db = openDb(config.dbPath), store = new Store(db, new Bus());
  store.patchSettings({ backend: "headless" });
  const historical = store.createProject({ name: "기존 Claude", cwd: home });
  const old = store.createMember({ projectId: historical.id, kind: "conductor", handle: "old-chief", name: "기존 총괄", cli: "claude" });
  const fresh = store.createProject({ name: "새 Codex", cwd: home });
  const current = store.createMember({ projectId: fresh.id, kind: "conductor", handle: "new-chief", name: "새 총괄", cli: "codex" });
  const orch = createOrchestrator(config, store);
  cleanup.push(async () => { await orch.shutdown(); db.close(); });
  await orch.refreshConnection();
  expect(store.requireProject(historical.id).connection.ok).toBe(true);
  expect(() => store.requireReachable(historical.id, old)).not.toThrow();
  expect(store.requireProject(fresh.id).connection.ok).toBe(false);
  expect(() => store.requireReachable(fresh.id, current)).toThrow();
});
test("Codex default is recorded for new chiefs/workers while historical Claude sessions stay Claude", async () => {
  const home = mkdtempSync(join(tmpdir(), "iamceo-codex-defaults-"));
  const db = openDb(join(home, "state.db")), store = new Store(db, new Bus());
  store.patchSettings({ backend: "headless" });
  const runner: Runner = { kind: "headless", available: async () => ({ ok: true }), start: async () => ({ sessionId: null, paneId: null }), send: async () => ({ ok: true }), compact: async () => ({ ok: true }), setParallel: async () => ({ ok: true }), isBusy: () => false, interrupt: async () => {}, stop: async () => {}, screen: async () => "", on: () => {}, shutdown: async () => {} };
  const orch = new Orchestrator({ config: { home, rolesDir: join(home, "roles"), port: 12345, agentCli: "codex" }, store, runners: new Map([["headless", runner]]) });
  cleanup.push(async () => { await orch.shutdown(); db.close(); });
  const project = store.createProject({ name: "체험", cwd: home });
  const chief = await orch.ensureConductor(project.id);
  const worker = await orch.addMember(project.id, { name: "직원", role: "확인" });
  expect(chief.cli).toBe("codex");
  expect(worker.member.cli).toBe("codex");
  const old = store.createMember({ projectId: project.id, handle: "old", name: "기존 직원", kind: "worker", sessionId: "019abcde-1234-7123-8123-123456789abc" });
  expect(store.requireMember(old.id).cli).toBe("claude");
});
