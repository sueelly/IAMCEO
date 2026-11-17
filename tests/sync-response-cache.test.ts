import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, } from "node:fs";
import { join } from "node:path";
import { Bus } from "../server/bus";
import { loadConfig, updateConfigFile } from "../server/config";
import { openDb } from "../server/db";
import { startServer } from "../server/http";
import { Store } from "../server/store";
import type { OrchestratorApi } from "../server/orchestrator-api";

const stops: (() => Promise<void>)[] = [];
afterEach(async () => { for (const stop of stops.splice(0)) await stop(); });
async function fixture() {
  const root = mkdtempSync("/private/tmp/iamceo-sync-cache-");
  updateConfigFile({ accessCode: "isolated-sync-cache", hosts: ["127.0.0.1"] }, { IAMCEO_HOME: root });
  const config = loadConfig({ IAMCEO_HOME: root, IAMCEO_PORT: "0" });
  const db = openDb(config.dbPath), bus = new Bus(), store = new Store(db, bus);
  const project = store.createProject({ name: "fixture", cwd: root });
  const orch = { cliCommand: () => "/fixture/iamceo", herdrInfo: async () => ({ installed: false, running: false, version: null, protocol: null, compatible: false, warning: null }) } as unknown as OrchestratorApi;
  const server = await startServer({ config, store, bus, orch });
  const builds = spyOn(store, "projectState");
  stops.push(async () => { builds.mockRestore(); await server.stop(); db.close(); /* Preserve this isolated test directory for review. */ });
  async function sync(opts: { host?: string; projectId?: string; compact?: boolean; auth?: boolean } = {}) {
    const query = new URLSearchParams({ projectId: opts.projectId ?? project.id });
    if (opts.compact !== false) query.set("view", "compact");
    return fetch(`http://127.0.0.1:${server.port}/api/sync?${query}`, { headers: {
      Host: opts.host ?? "mini.tail1234.ts.net:14443", ...(opts.auth === false ? {} : { Authorization: "Bearer isolated-sync-cache" }),
    } });
  }
  return { config, db, bus, store, project, builds, sync, server };
}

test("concurrent compact readers reuse built bytes; legacy reads and unauthenticated requests remain separate", async () => {
  const f = await fixture();
  const all = await Promise.all(Array.from({ length: 8 }, async () => (await f.sync()).json()));
  expect(all[0]).toMatchObject({ projectStatus: "ok", state: { project: { id: f.project.id } } });
  for (const body of all) expect(body).toEqual(all[0]);
  expect(f.builds).toHaveBeenCalledTimes(1);
  expect((await f.sync()).headers.get("cache-control")).toBe("no-store");
  const before = f.builds.mock.calls.length;
  expect((await f.sync({ auth: false })).status).toBe(401);
  expect(f.builds.mock.calls.length).toBe(before);
  await (await f.sync({ compact: false })).arrayBuffer();
  await (await f.sync({ compact: false })).arrayBuffer();
  expect(f.builds.mock.calls.length).toBe(before + 2);
});

test("database changes invalidate compact cache even without an event, including another SQLite connection", async () => {
  const f = await fixture();
  await (await f.sync()).json(); const seq = f.bus.seq;
  f.db.query("UPDATE projects SET now = ? WHERE id = ?").run("changed without event", f.project.id);
  expect(f.bus.seq).toBe(seq);
  expect((await (await f.sync()).json()).state.project.now).toBe("changed without event");
  const external = new Database(f.config.dbPath);
  try { external.query("UPDATE projects SET now = ? WHERE id = ?").run("changed externally", f.project.id); }
  finally { external.close(); }
  expect((await (await f.sync()).json()).state.project.now).toBe("changed externally");
  f.store.patchProject(f.project.id, { now: "changed with event" });
  expect((await (await f.sync()).json()).state.project.now).toBe("changed with event");
  expect(f.builds).toHaveBeenCalledTimes(4);
});

test("cache partitions projects and current incoming/managed terminal addresses", async () => {
  const f = await fixture();
  expect((await (await f.sync()).json()).bootstrap.connection.ssh.host).toBe("mini.tail1234.ts.net");
  expect((await (await f.sync({ host: "other.tail1234.ts.net:14443" })).json()).bootstrap.connection.ssh.host).toBe("other.tail1234.ts.net");
  const patch = await fetch(`http://127.0.0.1:${f.server.port}/api/connection`, { method: "PATCH", headers: { Authorization: "Bearer isolated-sync-cache", "Content-Type": "application/json" }, body: JSON.stringify({ sshUser: "operator" }) });
  expect(patch.status).toBe(200);
  expect((await (await f.sync()).json()).bootstrap.connection.ssh.user).toBe("operator");
  const p = f.store.createProject({ name: "second", cwd: f.config.home });
  expect((await (await f.sync({ projectId: p.id })).json()).state.project.id).toBe(p.id);
});

test("event-only changes invalidate reuse, frequent reads expire, and malformed requests cannot hit", async () => {
  const f = await fixture();
  const initial = await (await f.sync()).json();
  f.bus.emit({ type: "project", project: f.store.requireProject(f.project.id) });
  const next = await (await f.sync()).json();
  expect(next.cursor.seq).toBe(initial.cursor.seq + 1);
  expect(f.builds).toHaveBeenCalledTimes(2);
  await Bun.sleep(280);
  await (await f.sync()).json();
  expect(f.builds).toHaveBeenCalledTimes(3);
  const malformed = await fetch(`http://127.0.0.1:${f.server.port}/api/sync?projectId=${f.project.id}&view=compact&unexpected=1`, { headers: { Authorization: "Bearer isolated-sync-cache" } });
  expect(malformed.status).toBe(400);
  expect(f.builds).toHaveBeenCalledTimes(3);
});

test("a cached response remains inaccessible after access-code rotation", async () => {
  const f = await fixture();
  await (await f.sync()).json();
  const rotated = await fetch(`http://127.0.0.1:${f.server.port}/api/auth/rotate`, { method: "POST", headers: { Authorization: "Bearer isolated-sync-cache", "Content-Type": "application/json" }, body: "{}" });
  expect(rotated.status).toBe(200);
  expect((await f.sync()).status).toBe(401);
  const response = await fetch(`http://127.0.0.1:${f.server.port}/api/sync?projectId=${f.project.id}&view=compact`, { headers: { Authorization: `Bearer ${f.config.accessCode}`, Host: "mini.tail1234.ts.net:14443" } });
  expect(response.status).toBe(200);
  expect((await response.json()).state.project.id).toBe(f.project.id);
  expect(f.builds).toHaveBeenCalledTimes(2);
});
