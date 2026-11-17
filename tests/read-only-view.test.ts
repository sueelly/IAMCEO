import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../server/bus.ts";
import { loadConfig, updateConfigFile, type Config } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { Store } from "../server/store.ts";
import { startReadOnlyView } from "../server/read-only-view.ts";

const code = "123456"; // Existing snapshots may use a shorter code than today's generated default.
let home: string, config: Config, view: Awaited<ReturnType<typeof startReadOnlyView>>, origin: string;
let before: string, filePath: string;
let memberId: string;
const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const request = (path: string, method = "GET", auth = true) => fetch(origin + path, {
  method, headers: auth ? { Authorization: `Bearer ${code}`, "Content-Type": "application/json" } : {},
  ...(method === "POST" || method === "PATCH" ? { body: "{}" } : {}),
});

beforeAll(async () => {
  home = mkdtempSync(join(import.meta.dir, ".readonly-fixture-"));
  updateConfigFile({ accessCode: code, hosts: ["127.0.0.1"] }, { IAMCEO_HOME: home });
  config = loadConfig({ IAMCEO_HOME: home, IAMCEO_PORT: "0" });
  const db = openDb(config.dbPath); const store = new Store(db, new Bus());
  store.createProject({ id: "p_view", name: "조회 프로젝트", cwd: home });
  memberId = store.createMember({ projectId: "p_view", handle: "lead", name: "조회 직원", kind: "conductor" }).id;
  store.createMessage({ id: "msg_view", projectId: "p_view", kind: "나", mine: true, who: "나", body: "보존한 대화" });
  filePath = join(config.uploadsDir, "fixture.txt"); writeFileSync(filePath, "attachment");
  store.createAttachment({ id: "a_view", name: "fixture.txt", mime: "text/plain", size: 10, path: filePath });
  db.exec("UPDATE projects SET runner_enabled=0");
  db.exec("INSERT OR REPLACE INTO settings(key,value) VALUES('restoreReconciliation', '{\"outboundEnabled\":false,\"reconciliationRequired\":true}')");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); db.exec("PRAGMA journal_mode=DELETE"); db.close();
  before = digest(config.dbPath);
  view = await startReadOnlyView(config, "readonly-test-build"); origin = `http://127.0.0.1:${view.server.port}`;
});
afterAll(async () => { await view?.stop(); /* Preserve this isolated test directory for review. */ });

test("restored fenced data is readable with normal authentication", async () => {
  expect((await request("/api/bootstrap", "GET", false)).status).toBe(401);
  const bootstrap = await (await request("/api/bootstrap")).json();
  expect(bootstrap.projects.map((p: { id: string }) => p.id)).toContain("p_view");
  expect((await request("/api/projects/p_view/state")).status).toBe(200);
  expect((await request("/api/projects/p_view/files/page")).status).toBe(200);
  expect((await request("/api/files/missing")).status).toBe(404);
  expect(JSON.stringify(await (await request("/api/projects/p_view/messages")).json())).toContain("보존한 대화");
  const ready = await (await request("/api/readiness")).json();
  expect(ready.daemon.readOnly).toBe(true); expect(ready.daemon.buildId).toBe("readonly-test-build");
  expect(ready.core.available).toBe(false);
  expect(await (await request(`/api/members/${memberId}/prompt`)).json()).toEqual({ prompt: null, context: null });
  expect(await (await request(`/api/members/${memberId}/approval`)).json()).toEqual({ approval: null });
  expect((await request(`/api/members/${memberId}/activity`)).status).toBe(200);
});

test("mutations, external filesystem, pairing, agents and terminal are refused", async () => {
  for (const [method, path] of [
    ["POST", "/api/projects/p_view/messages"], ["PATCH", "/api/projects/p_view"],
    ["POST", "/api/decisions/d_view/answer"], ["POST", "/api/auth/rotate"],
    ["GET", "/api/members/m_view/terminal/stream"], ["GET", "/api/members/m_view/screen"],
    ["GET", "/api/folders"], ["GET", "/api/github/repos"], ["GET", "/api/projects/p_view/local-file"],
    ["POST", "/pair/claim"], ["POST", "/agent/join"], ["GET", "/agent/tools"], ["POST", "/"],
  ]) {
    const response = await request(path, method); expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("READ_ONLY");
  }
  expect((await request("/api/projects/p_view/messages", "POST", false)).status).toBe(401);
});

test("attachment and realtime cookies work without permitting persistent writes", async () => {
  for (const path of ["/api/files-session", "/api/realtime-session"]) {
    const response = await request(path, "POST"); expect(response.status).toBe(204);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect((await request(path, "DELETE")).status).toBe(204);
  }
  expect((await request("/files/a_view/fixture.txt", "GET", false)).status).toBe(401);
  expect(await (await request("/files/a_view/fixture.txt")).text()).toBe("attachment");
  expect(() => view.store.db.exec("UPDATE projects SET runner_enabled=1")).toThrow();
  expect(digest(config.dbPath)).toBe(before);
  expect(readFileSync(filePath, "utf8")).toBe("attachment");
  expect(view.store.db.query("SELECT 1 FROM projects WHERE runner_enabled != 0").get()).toBeNull();
  expect(JSON.parse((view.store.db.query("SELECT value FROM settings WHERE key='restoreReconciliation'").get() as { value: string }).value).outboundEnabled).toBe(false);
});

test("realtime uses the normal authenticated session and accepts no commands", async () => {
  const response = await request("/api/realtime-session", "POST");
  const cookie = response.headers.get("set-cookie")!.split(";")[0];
  const hello = await new Promise<{ type: string }>((resolve, reject) => {
    const Socket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
    const ws = new Socket(origin.replace("http:", "ws:") + "/ws?v=2", { headers: { Cookie: cookie } });
    const timer = setTimeout(() => { ws.close(); reject(new Error("Realtime hello timeout")); }, 2000);
    ws.onmessage = event => { clearTimeout(timer); const value = JSON.parse(String(event.data));
      ws.send(JSON.stringify({ type: "terminal.input", text: "must never execute" })); ws.close(); resolve(value); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("Realtime connection failed")); };
  });
  expect(hello.type).toBe("hello"); expect(digest(config.dbPath)).toBe(before);
});

test("standalone entry preserves a short existing access code", async () => {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port; listener.stop(true);
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../bin/iamceo-view.ts")], {
    env: { ...process.env, IAMCEO_VIEW_HOME: home, IAMCEO_VIEW_PORT: String(port) }, stdout: "pipe", stderr: "pipe",
  });
  try {
    let response: Response | undefined;
    for (let i = 0; i < 50; i++) {
      try { response = await fetch(`http://127.0.0.1:${port}/api/readiness`, { headers: { Authorization: `Bearer ${code}` } }); break; }
      catch { if (child.exitCode !== null) throw new Error("Snapshot viewer entry exited"); await Bun.sleep(20); }
    }
    expect(response?.status).toBe(200);
    expect((await response!.json()).daemon.readOnly).toBe(true);
  } finally { child.kill("SIGTERM"); await child.exited; }
  expect(digest(config.dbPath)).toBe(before);
});
