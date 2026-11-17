import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../server/bus";
import { loadConfig, updateConfigFile } from "../server/config";
import { openDb } from "../server/db";
import { startServer } from "../server/http";
import type { OrchestratorApi } from "../server/orchestrator-api";
import { Store } from "../server/store";

test("Team copies freshly managed SSH settings and never copies stale text after a lookup failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "iamceo-terminal-browser-"));
  const env = { IAMCEO_HOME: root, IAMCEO_PORT: "0" };
  updateConfigFile({ accessCode: "isolated-browser-connection", hosts: ["127.0.0.1"] }, env);
  const config = loadConfig(env), bus = new Bus(), store = new Store(openDb(config.dbPath), bus);
  const project = store.createProject({ name: "Terminal copy fixture", cwd: root });
  const member = store.createMember({ projectId: project.id, kind: "conductor", handle: "chief", name: "Fixture chief", status: "idle", backend: "core", paneId: "fixture-owned-terminal", sessionId: "11111111-1111-4111-8111-111111111111", cli: "codex" });
  const orch = {
    herdrInfo: async () => ({ installed: false, running: false, version: null, protocol: null, compatible: false, warning: null }),
    runtimeInfo: async () => ({ backend: "core", core: { installed: true, available: true, version: "fixture", detail: null }, providers: { codex: { installed: true }, claude: { installed: true } } }),
    cliCommand: () => "/fixture/current/iamceo", memberScreen: async () => "fixture terminal",
  } as unknown as OrchestratorApi;
  const server = await startServer({ config, store, bus, orch });
  const browser = await chromium.launch({ headless: true });
  try {
    const origin = "https://mini.tail1234.ts.net";
    const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"], viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(() => localStorage.setItem("iamceo.accessCode", "isolated-browser-connection"));
    let connectionReads = 0, refuseConnection = false;
    let pendingConnection: Promise<void> | null = null;
    await context.route(origin + "/**", async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.pathname === "/api/connection") {
        connectionReads++;
        if (pendingConnection) await pendingConnection;
        if (refuseConnection) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "connection lookup unavailable" }) });
      }
      const headers = { ...request.headers(), host: "mini.tail1234.ts.net" };
      const response = await fetch(`http://127.0.0.1:${server.port}${url.pathname}${url.search}`, { method: request.method(), headers, body: request.postData() ?? undefined });
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
    });
    const page = await context.newPage(), errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${origin}/#/p/${project.id}/team/${member.id}`);
    await page.locator(".tm-detail-tabs").getByRole("button", { name: "실행·설정", exact: true }).click();
    const copy = page.getByRole("button", { name: "터미널로 열기 명령 복사" });
    await copy.waitFor({ state: "visible", timeout: 15000 });
    const patch = await fetch(`http://127.0.0.1:${server.port}/api/connection`, { method: "PATCH", headers: { Authorization: "Bearer isolated-browser-connection", "Content-Type": "application/json" }, body: JSON.stringify({ sshHost: "renamed.tail1234.ts.net", sshUser: "operator", sshPort: 2222 }) });
    expect(patch.status).toBe(200);
    await copy.click();
    await page.waitForFunction(() => document.querySelector('[aria-label="터미널로 열기 명령 복사"]')?.textContent === "복사함");
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toContain("ssh -t -p 2222 -- operator@renamed.tail1234.ts.net");
    expect(clipboard).toContain("IAMCEO_HOME="); expect(clipboard).toContain(root);
    expect(clipboard).toContain(`/fixture/current/iamceo attach ${member.id}`);
    expect(await page.locator(".tm-copy__cmd").innerText()).toBe(clipboard);
    expect(connectionReads).toBe(1);
    let releaseConnection!: () => void;
    pendingConnection = new Promise<void>(resolve => { releaseConnection = resolve; });
    await copy.click();
    await Bun.sleep(2150); // Let the previous success-reset timer fire during this request.
    const remainedDisabled = await copy.isDisabled();
    pendingConnection = null; releaseConnection();
    expect(remainedDisabled).toBe(true);
    await page.waitForFunction(() => document.querySelector('[aria-label="터미널로 열기 명령 복사"]')?.textContent === "복사함");
    refuseConnection = true;
    await page.evaluate(() => navigator.clipboard.writeText("preserve clipboard"));
    await copy.click();
    await page.getByRole("alert").filter({ hasText: "connection lookup unavailable" }).waitFor({ timeout: 8000 });
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("preserve clipboard");
    expect(connectionReads).toBe(3); expect(errors).toEqual([]);
    await context.close();
  } finally { await browser.close(); await server.stop(); store.db.close(); rmSync(root, { recursive: true, force: true }); }
}, 30000);
