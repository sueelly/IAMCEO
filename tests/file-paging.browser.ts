import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { Bus } from "../server/bus";
import { loadConfig, updateConfigFile } from "../server/config";
import { openDb } from "../server/db";
import { startServer, type RunningServer } from "../server/http";
import { Orchestrator } from "../server/orchestrator";
import { Store } from "../server/store";
import type { Runner } from "../server/runner/types";
import type { FileDoc, Project, Task } from "../shared/types";

const code = "isolated-file-page-test";

test("startup uses one state/history read and reconciles messages sent before its socket opens", async () => {
  const page = await browser.newPage();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/realtime-session", async route => { await gate; await route.continue().catch(() => {}); });
  const reads: string[] = [];
  page.on("request", request => { if (request.url().includes("/api/")) reads.push(request.url()); });
  await page.route("**/messages/page?*", route => route.abort());
  try {
    await page.addInitScript(value => localStorage.setItem("iamceo.accessCode", value), code);
    await page.goto(`${base}/#/p/${project.id}/thread`);
    await page.locator(".shell").waitFor({ timeout: 2000 });
    expect(reads.some(path => path.includes("/api/sync?") && path.includes("history=50"))).toBe(true);
    expect(reads.filter(path => path.includes("/messages/page?"))).toHaveLength(0);
    store.createMessage({ projectId: project.id, kind: "진행", body: "handoff-tail-proof" });
    release();
    await page.getByText("handoff-tail-proof", { exact: true }).waitFor({ timeout: 10_000 });
    expect(reads.filter(path => path.includes("/messages/page?"))).toHaveLength(0);
  } finally { release(); await page.close(); }
}, 20_000);

test("first screen opens while runtime diagnostics are delayed", async () => {
  const page = await browser.newPage();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let requested = false;
  await page.route("**/api/runtime", async route => {
    requested = true;
    await gate;
    await route.continue().catch(() => {});
  });
  try {
    await page.addInitScript(value => localStorage.setItem("iamceo.accessCode", value), code);
    await page.goto(`${base}/#/p/${project.id}/home`);
    await page.locator(".shell").waitFor({ timeout: 2000 });
    expect(requested).toBe(true);
    expect(await page.locator(".splash").count()).toBe(0);
    expect(await page.locator("body").innerText()).toContain("작은 목록");
  } finally {
    release();
    await page.close();
  }
});
let store: Store, server: RunningServer, orch: Orchestrator, browser: Browser, project: Project;
let base = "";
let files: FileDoc[];
let even: Task, odd: Task;
beforeAll(async () => {
  const home = mkdtempSync(join(tmpdir(), "iamceo-files-page-"));
  const env = { IAMCEO_HOME: home, IAMCEO_PORT: "0" };
  updateConfigFile({ accessCode: code, hosts: ["127.0.0.1"] }, env);
  const config = loadConfig(env), bus = new Bus();
  store = new Store(openDb(config.dbPath), bus);
  const runner: Runner = { kind: "headless", available: async () => ({ ok: true }), start: async () => ({ sessionId: crypto.randomUUID(), paneId: null }),
    send: async () => ({ ok: true }), isBusy: () => false, compact: async () => ({ ok: true }), setParallel: async () => ({ ok: true }),
    interrupt: async () => {}, stop: async () => {}, screen: async () => "", on: () => {}, shutdown: async () => {} };
  orch = new Orchestrator({ config, store, runners: new Map([["headless", runner]]) });
  server = await startServer({ config, store, bus, orch }); base = server.urls[0]!;
  project = store.createProject({ name: "작은 목록", cwd: home });
  orch.setServerUrl(base);
  await orch.ensureConductor(project.id);
  const member = store.createMember({ projectId: project.id, name: "담당", handle: "worker", kind: "worker" });
  even = store.saveTask({ projectId: project.id, memberId: member.id, who: "담당", title: "짝수 업무" }).task;
  odd = store.saveTask({ projectId: project.id, memberId: member.id, who: "담당", title: "홀수 업무" }).task;
  store.createMessage({ projectId: project.id, kind: "진행", taskId: even.id, body: "짝수" });
  store.createMessage({ projectId: project.id, kind: "진행", taskId: odd.id, body: "홀수" });
  files = Array.from({ length: 45 }, (_, i) => store.createFile({ projectId: project.id, title: `목록 ${i}`, kind: "document", taskId: i % 2 ? odd.id : even.id, body: `본문 ${i}\n` + "detail-only-canary".repeat(4000) }));
  for (let i = 0; i < 120; i++) store.createMessage({ projectId: project.id, kind: "진행", body: `대화 ${i}` });
  browser = await chromium.launch();
});
afterAll(async () => { await browser?.close(); await orch?.shutdown(); await server?.stop(); store?.db.close(); });
async function open(page: Page, sub = "", projectId = project.id) {
  await page.goto(base + "/api/health");
  await page.evaluate(c => localStorage.setItem("iamceo.accessCode", c), code);
  await page.goto(`${base}/#/p/${projectId}/files${sub ? "/" + sub : ""}`);
}
async function count(page: Page, n: number) {
  await page.waitForFunction(n => document.querySelectorAll(".fl-list .fl-row").length === n, n);
}
test("list transfers only 20 summaries, scroll appends 20, old direct links load only their detail", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  const pages: number[] = [], details: string[] = [], history: number[] = [];
  page.on("response", async r => {
    const url = new URL(r.url());
    if (url.pathname.endsWith("/files/page")) {
      const data = await r.json(); pages.push(data.items.length);
      expect(data.items.every((f: object) => !("body" in f))).toBe(true);
    }
    if (/\/api\/files\/[^/]+$/.test(url.pathname)) details.push(url.pathname.split("/").at(-1)!);
    if (url.pathname.endsWith("/messages/page")) history.push(Number(url.searchParams.get("limit")));
    if (url.pathname === "/api/sync" && url.searchParams.has("history")) history.push((await r.json()).history.items.length);
  });
  try {
    await open(page); await page.locator(".fl-row").first().waitFor({ timeout: 10000 }); expect(await page.locator(".fl-row").count()).toBe(20);
    expect(pages).toEqual([20]); expect(history.length).toBeGreaterThan(0); expect(history.every(n => n === 50)).toBe(true);
    await page.locator(".fl-doc__title").waitFor();
    expect(details).toEqual([files[44]!.id]);
    await page.locator(".fl-list").evaluate(e => { e.scrollTop = e.scrollHeight; });
    await count(page, 40);
    const ids = await page.locator(".fl-row").evaluateAll(rows => rows.map(row => row.getAttribute("href")));
    expect(new Set(ids).size).toBe(40);
    await page.evaluate(hash => { location.hash = hash; }, `#/p/${project.id}/files/${files[0]!.id}`);
    await page.waitForFunction(() => document.querySelector(".fl-doc__title")?.textContent === "목록 0");
    expect(await page.locator(".fl-doc").innerText()).toContain("본문 0");
    expect(details).toEqual([files[44]!.id, files[0]!.id]);
    expect(pages.every(n => n <= 20)).toBe(true);
  } catch (error) { console.log((await page.locator("body").innerText()).slice(0, 1200)); throw error; } finally { await page.close(); }
}, 60_000);

test("mobile list does not fetch a document body before it is opened", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true });
  const details: string[] = [];
  page.on("request", r => { if (/\/api\/files\/[^/]+$/.test(new URL(r.url()).pathname)) details.push(r.url()); });
  try { await open(page); await count(page, 20); expect(details).toEqual([]); }
  finally { await page.close(); }
}, 60_000);

test("a late task response cannot replace the new task and live additions keep older pages", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  page.setDefaultTimeout(5000);
  let started!: () => void, finished!: () => void;
  const slowStarted = new Promise<void>(r => { started = r; });
  const slowFinished = new Promise<void>(r => { finished = r; });
  await page.route("**/files/page?*", async route => {
    if (new URL(route.request().url()).searchParams.get("taskId") !== even.id) return route.continue();
    started();
    try { const response = await route.fetch(); await new Promise(r => setTimeout(r, 350)); await route.fulfill({ response }); }
    catch { /* Switching scopes may abort this intercepted read. */ }
    finally { finished(); }
  });
  try {
    await open(page); await count(page, 20);
    await page.locator(".cmp-task", { hasText: "짝수 업무" }).click(); await slowStarted;
    await page.locator(".cmp-task", { hasText: "홀수 업무" }).click();
    await page.waitForFunction(() => document.querySelector(".fl-row__title")?.textContent === "목록 43");
    await slowFinished;
    expect((await page.locator(".fl-row__title").allInnerTexts()).every(t => Number(t.split(" ")[1]) % 2 === 1)).toBe(true);
    await page.locator(".fl-list").evaluate(e => { e.scrollTop = e.scrollHeight; }); await count(page, 22);
    store.createFile({ projectId: project.id, title: "새 홀수 자료", kind: "document", taskId: odd.id, body: "new" });
    await page.waitForFunction(() => document.querySelector(".fl-row__title")?.textContent === "새 홀수 자료");
    await count(page, 23);
    expect(await page.locator(".fl-row__title").last().innerText()).toBe("목록 1");
  } catch (error) { console.log("tasks", store.listTasks(project.id).map(t => [t.title,t.lastMessageAt])); console.log((await page.locator("body").innerText()).slice(0,1400)); throw error; } finally { await page.close(); }
}, 60_000);

test("an initial file request failure can be retried without reloading the project", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  let fail = true;
  await page.route("**/files/page?*", route => {
    if (!fail) return route.continue();
    fail = false; return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "목록 일시 오류" }) });
  });
  try {
    await open(page);
    await page.getByRole("alert").filter({ hasText: "목록 일시 오류" }).waitFor();
    await page.getByRole("button", { name: "다시 불러오기" }).click(); await count(page, 20);
  } finally { await page.close(); }
}, 60_000);

test("deleting a loaded page boundary keeps all surviving files after the final page", async () => {
  const p = store.createProject({ name: "삭제 경계", cwd: project.cwd, runnerEnabled: false });
  const docs = Array.from({ length: 45 }, (_, i) => store.createFile({ projectId: p.id, title: `삭제 ${i}`, kind: "document", body: "body" }));
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  try {
    await open(page, "", p.id); await count(page, 20);
    await page.locator(".fl-list").evaluate(e => { e.scrollTop = e.scrollHeight; }); await count(page, 40);
    store.db.query("DELETE FROM files WHERE id = ?").run(docs[5]!.id);
    await page.locator(".fl-list").evaluate(e => { e.scrollTop = e.scrollHeight; });
    await page.waitForFunction(() => document.querySelectorAll(".fl-row").length !== 40);
    expect(await page.locator(".fl-row").count()).toBe(44);
    expect(await page.locator(".fl-row__title").first().innerText()).toBe("삭제 44");
    expect(await page.locator(".fl-row__title").last().innerText()).toBe("삭제 0");
  } finally { await page.close(); }
}, 60_000);

test("a full page of live arrivals preserves the previously read interval", async () => {
  const p = store.createProject({ name: "일괄 추가", cwd: project.cwd, runnerEnabled: false });
  for (let i = 0; i < 60; i++) store.createFile({ projectId: p.id, title: `일괄 ${i}`, kind: "document", body: "body" });
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  try {
    await open(page, "", p.id); await count(page, 20);
    await page.locator(".fl-list").evaluate(e => { e.scrollTop = e.scrollHeight; }); await count(page, 40);
    const anchor = await page.locator(".fl-list").evaluate(root => {
      const box = root.getBoundingClientRect();
      const row = [...root.querySelectorAll<HTMLAnchorElement>(".fl-row")].find(row => row.getBoundingClientRect().top >= box.top)!;
      return { href: row.getAttribute("href"), offset: row.getBoundingClientRect().top - box.top };
    });
    store.transaction(() => { for (let i = 0; i < 20; i++) store.createFile({ projectId: p.id, title: `신규 ${i}`, kind: "document", body: "new" }); });
    await page.waitForFunction(() => document.querySelector(".fl-row__title")?.textContent === "신규 19");
    expect(await page.locator(".fl-row__title", { hasText: /^일괄 20$/ }).count()).toBe(1);
    expect(await page.locator(".fl-row").count()).toBeGreaterThanOrEqual(60);
    const offset = await page.locator(".fl-list").evaluate((root, href) => {
      const row = [...root.querySelectorAll<HTMLAnchorElement>(".fl-row")].find(row => row.getAttribute("href") === href)!;
      return row.getBoundingClientRect().top - root.getBoundingClientRect().top;
    }, anchor.href);
    expect(Math.abs(offset - anchor.offset)).toBeLessThan(3);
  } finally { await page.close(); }
}, 60_000);

test("moving an old file into an exhausted task updates the list and open reader", async () => {
  const p = store.createProject({ name: "옛 자료 이동", cwd: project.cwd });
  const lead = await orch.ensureConductor(p.id);
  const a = store.saveTask({ projectId: p.id, memberId: lead.id, who: "담당", title: "목표 업무" }).task;
  const b = store.saveTask({ projectId: p.id, memberId: lead.id, who: "담당", title: "원래 업무" }).task;
  for (const task of [a, b]) store.createMessage({ projectId: p.id, kind: "진행", taskId: task.id, body: task.title });
  const old = store.createFile({ projectId: p.id, title: "옮길 옛 자료", kind: "document", body: "old", taskId: b.id });
  for (let i = 0; i < 40; i++) store.createFile({ projectId: p.id, title: `목표 ${i}`, kind: "document", body: "body", taskId: a.id });
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  try {
    await open(page, old.id, p.id);
    await page.locator(".cmp-task", { hasText: "목표 업무" }).click(); await count(page, 20);
    await page.locator(".fl-list").evaluate(e => { e.scrollTop = e.scrollHeight; }); await count(page, 40);
    await page.locator(".fl-doc__task", { hasText: "원래 업무" }).waitFor();
    const refreshed = page.waitForResponse(r => r.url().includes("/files/page?") && r.url().includes(a.id));
    store.moveRecordTask({ projectId: p.id, refType: "file", refId: old.id, from: b.id, to: a.id, basis: "classify", actor: "시험" });
    await refreshed;
    await count(page, 41);
    expect(await page.locator(".fl-row").count()).toBe(41);
    expect(await page.locator(".fl-row__title", { hasText: "옮길 옛 자료" }).count()).toBe(1);
    expect(await page.locator(".fl-doc__task").count()).toBe(0);
  } finally { await page.close(); }
}, 60_000);
