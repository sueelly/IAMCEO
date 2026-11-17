import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { Bus } from "../server/bus";
import { loadConfig, updateConfigFile } from "../server/config";
import { openDb } from "../server/db";
import { startServer, type RunningServer } from "../server/http";
import { Store } from "../server/store";
import type { OrchestratorApi } from "../server/orchestrator-api";
import { cliCommand } from "../server/orchestrator";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture() {
  const home = mkdtempSync(join(tmpdir(), "iamceo-connections-"));
  updateConfigFile({ accessCode: "isolated-connection-code", hosts: ["127.0.0.1"] }, { IAMCEO_HOME: home });
  const config = loadConfig({ IAMCEO_HOME: home, IAMCEO_PORT: "0" });
  const bus = new Bus(), store = new Store(openDb(config.dbPath), bus);
  const orch = {
    herdrInfo: async () => ({ installed: false, running: false, version: null, protocol: null, compatible: false, warning: null }),
    cliCommand: () => "/fixture/current/iamceo",
  } as unknown as OrchestratorApi;
  const server: RunningServer = await startServer({ config, store, bus, orch });
  cleanups.push(async () => { await server.stop(); store.db.close(); rmSync(home, { recursive: true, force: true }); });
  async function request(path: string, host: string, patch?: unknown, auth = true) {
    return fetch(`http://127.0.0.1:${server.port}${path}`, {
      method: patch === undefined ? "GET" : "PATCH",
      headers: { Host: host, ...(auth ? { Authorization: "Bearer isolated-connection-code" } : {}), "Content-Type": "application/json" },
      body: patch === undefined ? undefined : JSON.stringify(patch),
    });
  }
  return { home, request, port: server.port };
}

test("connection discovery follows the incoming Tailnet hostname, not the proxy loopback", async () => {
  const f = await fixture();
  const first = await f.request("/api/connection", "old-mini.tail1234.ts.net:14443");
  expect(first.status).toBe(200);
  const descriptor = await first.json();
  expect(descriptor).toEqual({ home: f.home, port: f.port, cli: "/fixture/current/iamceo", ssh: { host: "old-mini.tail1234.ts.net", user: userInfo().username, port: 22 } });
  const next = await (await f.request("/api/connection", "new-mini.tail1234.ts.net:15443")).json();
  expect(next.ssh.host).toBe("new-mini.tail1234.ts.net");
  for (const path of ["/api/bootstrap", "/api/sync?projectId=hq"]) {
    const body = await (await f.request(path, "new-mini.tail1234.ts.net:15443")).json();
    expect((body.bootstrap ?? body).connection).toEqual(next);
  }
  expect(JSON.stringify(descriptor)).not.toContain("isolated-connection-code");
});

test("managed overrides update without restart, merge atomically and clear to automatic", async () => {
  const f = await fixture(), host = "mini.tail1234.ts.net:14443";
  expect((await f.request("/api/connection", host, { sshHost: "ssh-mini.tail1234.ts.net", sshUser: "operator", sshPort: 2222 })).status).toBe(200);
  expect((await f.request("/api/connection", host, { sshPort: 2223 })).status).toBe(200);
  expect((await (await f.request("/api/connection", host)).json()).ssh).toEqual({ host: "ssh-mini.tail1234.ts.net", user: "operator", port: 2223 });
  const cleared = await f.request("/api/connection", host, { sshHost: null });
  expect(cleared.status).toBe(200);
  expect((await cleared.json()).ssh).toEqual({ host: "mini.tail1234.ts.net", user: "operator", port: 2223 });
  const saved = JSON.parse(readFileSync(join(f.home, "config.json"), "utf8"));
  expect(saved.connection).toEqual({ sshUser: "operator", sshPort: 2223 });
  expect(saved.accessCode).toBe("isolated-connection-code");
  expect(saved.hosts).toEqual(["127.0.0.1"]);
});

test("connection management requires authentication and refuses executable or malformed settings", async () => {
  const f = await fixture(), host = "mini.tail1234.ts.net:14443";
  expect((await f.request("/api/connection", host, undefined, false)).status).toBe(401);
  expect((await f.request("/api/connection", host, { sshUser: "operator" }, false)).status).toBe(401);
  for (const patch of [{ sshHost: "-oProxyCommand=touch /tmp/no" }, { sshHost: "$(touch /tmp/no)" }, { sshHost: "a\nb" }, { sshUser: "a@b" }, { sshPort: 0 }, { sshPort: 65536 }, { sshPort: 22.5 }, { sshHost: "" }, { cli: "evil" }, {}]) {
    expect((await f.request("/api/connection", host, patch)).status).toBe(400);
  }
  expect(JSON.parse(readFileSync(join(f.home, "config.json"), "utf8")).connection).toBeUndefined();
});

test("connection CLI manages the active server and clears individual overrides with auto", async () => {
  const f = await fixture();
  async function cli(args: string[]) {
    const p = Bun.spawn([process.execPath, join(import.meta.dir, "../bin/iamceo.ts"), "connection", ...args], {
      env: { ...process.env, IAMCEO_HOME: f.home, IAMCEO_PORT: String(f.port) }, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { stdout, stderr, code };
  }
  const result = await cli(["--ssh-host", "managed.tail1234.ts.net", "--ssh-user", "operator", "--ssh-port", "2222"]);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout).ssh).toEqual({ host: "managed.tail1234.ts.net", user: "operator", port: 2222 });
  expect((await cli(["--ssh-host", "auto"])).code).toBe(0);
  expect((await (await f.request("/api/connection", "current.tail1234.ts.net:14443")).json()).ssh).toEqual({ host: "current.tail1234.ts.net", user: "operator", port: 2222 });
  expect((await cli(["--ssh-port", "invalid"])).code).toBe(1);
  expect(JSON.parse((await cli([])).stdout).ssh.port).toBe(2222);
  expect(result.stdout).not.toContain("isolated-connection-code");
});

test("the daemon CLI descriptor does not select a stale installation from PATH", () => {
  const which = spyOn(Bun, "which").mockImplementation(() => "/old/server/iamceo");
  try { expect(cliCommand()).toContain(process.execPath); }
  finally { which.mockRestore(); }
});
