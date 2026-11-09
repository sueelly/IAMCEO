// Browser → real HTTP/SQLite → response rendering, with no real CLI processes.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../server/bus";
import { loadConfig, updateConfigFile } from "../server/config";
import { openDb } from "../server/db";
import { startServer, type RunningServer } from "../server/http";
import { Store } from "../server/store";
import type { OrchestratorApi } from "../server/orchestrator-api";
import type { Message, SendMessageReq } from "../shared/types";

const root = mkdtempSync("/private/tmp/iamceo-web-native-browser-");
const code = "isolated-browser-code";
let server: RunningServer, browser: Browser, store: Store, bus: Bus, projectId: string, base: string;
const contexts: BrowserContext[] = [];
const posts: SendMessageReq[] = [];
let suppressNextAcknowledgement = false;
const errors: string[] = [];
const headers = { Authorization: `Bearer ${code}` };
const artifactRoot = process.env.IAMCEO_WEB_PARITY_ARTIFACTS ?? root;

beforeAll(async () => {
  const home = join(root, "home"); mkdirSync(home);
  const projectPath = join(root, "project"); mkdirSync(projectPath);
  const env = { IAMCEO_HOME: home, IAMCEO_PORT: "0", IAMCEO_CORE_BIN: "/usr/bin/false", IAMCEO_CODEX_BIN: "/usr/bin/false", IAMCEO_CLAUDE_BIN: "/usr/bin/false", IAMCEO_CORE_SOCKET: join(root, "core.sock"), IAMCEO_HERDR_SOCKET: join(root, "herdr.sock") };
  updateConfigFile({ accessCode: code, hosts: ["127.0.0.1"] }, env);
  const config = loadConfig(env); bus = new Bus(); store = new Store(openDb(config.dbPath), bus);
  projectId = store.createProject({ name: "웹 동작 검증", cwd: projectPath }).id;
  store.createMember({ projectId, kind: "conductor", handle: "chief", name: "검증 총괄", status: "idle", backend: "core", paneId: "fixture-terminal", sessionId: "11111111-1111-4111-8111-111111111111", cli: "codex" });
  const methods = {
    herdrInfo: async () => ({ installed: false, running: false, version: null, protocol: null, compatible: false, warning: "isolated fixture" }),
    runtimeInfo: async () => ({ backend: "core", core: { installed: true, available: true, version: "fixture", detail: null }, providers: { codex: { installed: true }, claude: { installed: true } } }),
    refreshConnection: async () => {}, cliCommand: () => "fixture-cli",
    sendUserMessage: async (id: string, req: SendMessageReq) => {
      posts.push(structuredClone(req));
      const emit = bus.emit;
      if (suppressNextAcknowledgement) { suppressNextAcknowledgement = false; bus.emit = () => {}; }
      try { return store.getMessage(req.id!) ?? store.createMessage({ id: req.id, projectId: id, kind: "나", mine: true, who: "나", body: req.text, targetMemberId: req.targetMemberId, delivery: "queued" }); }
      finally { bus.emit = emit; }
    },
    updateSettingsV2: async (patch: any, precondition: { expectedRevision: number }) => store.patchSettingsCas(patch, precondition.expectedRevision),
    patchMemberConfigV2: async (id: string, patch: any, precondition: { expectedRevision: number }) => store.patchMemberCas(id, patch, precondition.expectedRevision),
    setTodoDoneV2: async (id: string, req: { done: boolean }, precondition: { expectedRevision: number }) => store.setTodoDoneCas(id, req.done, precondition.expectedRevision),
    operation: async () => { throw new Error("fixture operation not used"); },
    freshMemberSessionV2: async () => { throw new Error("fixture fresh session not used"); },
    terminalControlV2: async () => { throw new Error("fixture terminal not used"); },
  };
  const orch = new Proxy(methods, { get(target, key) {
    if (key in target) return Reflect.get(target, key);
    return () => { throw new Error(`Unexpected fixture action: ${String(key)}`); };
  } }) as unknown as OrchestratorApi;
  server = await startServer({ config, store, bus, orch });
  if (server.port === 7878) throw new Error("Refusing production port");
  base = `http://127.0.0.1:${server.port}`;
  browser = await chromium.launch({ headless: true });
  console.log(`Isolated browser fixture: ${base}, evidence: ${artifactRoot}`);
}, 30000);

afterAll(async () => {
  for (const context of contexts) await context.close().catch(() => {});
  await browser?.close().catch(() => {});
  await server?.stop();
  store?.db.close();
});

async function pageFor() {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  contexts.push(context);
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${base}/#/p/${projectId}/thread`);
  await page.getByLabel("접속 코드").fill(code);
  await page.getByRole("button", { name: "들어가기", exact: true }).click();
  await page.getByRole("textbox", { name: "입력칸" }).waitFor({ state: "visible", timeout: 15000 });
  return { context, page };
}
async function visible(page: Page, value: boolean) {
  await page.evaluate(value => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: value ? "visible" : "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  }, value);
}
async function until(predicate: () => boolean, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > deadline) throw new Error("fixture condition timed out"); await Bun.sleep(20); }
}

test("browser v2 login pauses hidden communication and restores a >200 message gap", async () => {
  store.createMessage({ projectId, kind: "알림", who: "총괄", body: "복귀 이전 대화" });
  const { page, context } = await pageFor();
  const sockets: string[] = [], syncReads: number[] = [];
  page.on("websocket", socket => sockets.push(socket.url()));
  page.on("request", request => { if (new URL(request.url()).pathname === "/api/sync") syncReads.push(Date.now()); });
  await visible(page, false);
  await Bun.sleep(600);
  const paused = syncReads.length;
  for (let i = 0; i < 240; i++) store.createMessage({ projectId, kind: "알림", who: "총괄", body: `복귀 누락 복구 ${i}` });
  await Bun.sleep(700);
  expect(syncReads.length).toBe(paused);
  // A fresh live row arrives after reconnect but before the delayed snapshot
  // starts reading history. It must not be mistaken for a contiguous anchor.
  let holdSnapshot = true;
  await page.route("**/api/sync?*", async route => {
    const response = await route.fetch();
    const body = await response.body();
    if (holdSnapshot) { holdSnapshot = false; await Bun.sleep(650); }
    await route.fulfill({ status: response.status(), headers: response.headers(), body });
  });
  const hello = page.waitForEvent("websocket").then(socket => new Promise<void>(resolve => {
    socket.on("framereceived", frame => {
      try { if (JSON.parse(String(frame.payload)).type === "hello") resolve(); } catch {}
    });
  }));
  await visible(page, true);
  await hello;
  store.createMessage({ projectId, kind: "알림", who: "총괄", body: "복귀 직후 새 실시간 글" });
  await page.getByText("복귀 누락 복구 239", { exact: true }).waitFor({ state: "attached", timeout: 10000 });
  await page.getByText("복귀 누락 복구 0", { exact: true }).waitFor({ state: "attached", timeout: 10000 });
  await page.getByText("복귀 이전 대화", { exact: true }).waitFor({ state: "attached", timeout: 10000 });
  expect(sockets.length).toBeGreaterThan(0);
  expect(sockets.every(url => new URL(url).search === "?v=2")).toBe(true);
  await page.screenshot({ path: join(artifactRoot, "web-native-mobile-recovery.png"), fullPage: true });
  await page.unrouteAll({ behavior: "wait" });
  expect(errors).toEqual([]);
  await context.close(); contexts.splice(contexts.indexOf(context), 1);
}, 30000);

test("lost send acknowledgement survives reload without a duplicate POST or losing a newer draft", async () => {
  const { page, context } = await pageFor();
  let drop = true;
  await page.route("**/api/projects/*/messages", async route => {
    if (route.request().method() !== "POST" || !drop) return route.continue();
    drop = false;
    await route.fetch();
    await route.abort("failed");
  });
  await page.route("**/api/messages/*", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "fixture acknowledgement unavailable" }) }));
  const input = page.getByRole("textbox", { name: "입력칸" });
  const before = posts.length;
  suppressNextAcknowledgement = true;
  await input.fill("응답 유실 검증 메시지");
  await page.getByRole("button", { name: "보내기", exact: true }).click();
  await until(() => posts.length === before + 1);
  await input.fill("새로 작성 중인 글은 유지");
  await page.getByRole("button", { name: "같은 내용 재시도", exact: true }).waitFor({ state: "visible", timeout: 8000 });
  await page.unroute("**/api/messages/*");
  await page.reload();
  const restored = page.getByRole("textbox", { name: "입력칸" });
  await restored.waitFor({ state: "visible", timeout: 15000 });
  expect(await restored.inputValue()).toBe("새로 작성 중인 글은 유지");
  await page.getByRole("button", { name: "같은 내용 재시도", exact: true }).waitFor({ state: "detached", timeout: 8000 });
  expect(posts.length).toBe(before + 1);
  const messages = store.projectState(projectId).messages;
  expect(messages.filter(message => message.id === posts[before].id)).toHaveLength(1);
  expect(errors).toEqual([]);
  await page.screenshot({ path: join(artifactRoot, "web-native-mobile-send-recovery.png"), fullPage: true });
  await context.close(); contexts.splice(contexts.indexOf(context), 1);
}, 30000);

test("settings save keeps its reviewed revision and preserves edits on another-device conflict", async () => {
  const { page, context } = await pageFor();
  await page.goto(`${base}/#/settings`);
  const checkbox = page.getByRole("checkbox", { name: /맥 알림/ });
  await checkbox.waitFor({ state: "visible" });
  const original = store.getSettings().notifyMac;
  await checkbox.setChecked(!original);
  const reviewed = store.settingsRevision();
  store.patchSettings({ boardTidyHours: store.getSettings().boardTidyHours + 1 });
  await Bun.sleep(800);
  const request = page.waitForRequest(req => req.method() === "PUT" && new URL(req.url()).pathname === "/api/settings");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  const sent = await request;
  expect(sent.headers()["if-match"]).toBe(`"${reviewed}"`);
  expect(sent.headers()["x-iamceo-contract"]).toBe("2");
  await page.getByRole("alert").filter({ hasText: /변경|검토/ }).first().waitFor({ state: "visible" });
  expect(store.getSettings().notifyMac).toBe(original);
  expect(await checkbox.isChecked()).toBe(!original);
  const latestRevision = store.settingsRevision();
  const latestTidy = store.getSettings().boardTidyHours;
  await page.getByRole("button", { name: "현재 값 확인했습니다", exact: true }).click();
  const retry = page.waitForRequest(req => req.method() === "PUT" && new URL(req.url()).pathname === "/api/settings");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  expect((await retry).headers()["if-match"]).toBe(`"${latestRevision}"`);
  await until(() => store.getSettings().notifyMac === !original);
  expect(store.getSettings().boardTidyHours).toBe(latestTidy);
  expect(errors).toEqual([]);
  await page.screenshot({ path: join(artifactRoot, "web-native-mobile-conflict.png"), fullPage: true });
  await context.close(); contexts.splice(contexts.indexOf(context), 1);
}, 30000);

test("another tab cannot erase an uncertain transmission while editing its own draft", async () => {
  const { page, context } = await pageFor();
  const other = await context.newPage();
  await other.goto(`${base}/#/p/${projectId}/thread`);
  await other.getByRole("textbox", { name: "입력칸" }).waitFor({ state: "visible" });
  // Both tabs cache their initial draft state before this send starts.
  await page.route("**/api/projects/*/messages", async route => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fetch(); await route.abort("failed");
  });
  await page.route("**/api/messages/*", route => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"fixture lost acknowledgement"}' }));
  const before = posts.length;
  suppressNextAcknowledgement = true;
  await page.getByRole("textbox", { name: "입력칸" }).fill("다른 탭이 지우면 안 되는 전송 기록");
  await page.getByRole("button", { name: "보내기", exact: true }).click();
  await until(() => posts.length === before + 1);
  await page.getByRole("button", { name: "같은 내용 재시도", exact: true }).waitFor({ state: "visible" });
  await other.getByRole("textbox", { name: "입력칸" }).fill("다른 탭에서 새로 작성한 글");
  await page.reload();
  await page.getByRole("textbox", { name: "입력칸" }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "같은 내용 재시도", exact: true }).waitFor({ state: "visible" });
  expect(posts.length).toBe(before + 1);
  await page.unroute("**/api/messages/*");
  await page.getByRole("button", { name: "다시 확인", exact: true }).click();
  await page.getByRole("button", { name: "같은 내용 재시도", exact: true }).waitFor({ state: "detached" });
  expect(posts.length).toBe(before + 1);
  expect(errors).toEqual([]);
  await context.close(); contexts.splice(contexts.indexOf(context), 1);
}, 30000);

test("employee-detail direct send survives lost acknowledgement and reload with its original ID", async () => {
  const { page, context } = await pageFor();
  const member = store.getConductor(projectId)!;
  await page.goto(`${base}/#/p/${projectId}/team/${member.id}`);
  const form = page.locator("form.tm-send");
  const input = form.getByRole("textbox", { name: /직접 지시/ });
  await input.waitFor({ state: "visible" });
  await page.route("**/api/projects/*/messages", async route => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fetch(); await route.abort("failed");
  });
  await page.route("**/api/messages/*", route => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"fixture lost acknowledgement"}' }));
  const before = posts.length;
  suppressNextAcknowledgement = true;
  await input.fill("직원 상세에서 보낸 복구 검증 지시");
  await form.getByRole("button", { name: "보내기", exact: true }).click();
  await until(() => posts.length === before + 1);
  await input.fill("다음 직접 지시는 그대로 유지");
  await form.getByRole("button", { name: "같은 내용 재시도", exact: true }).waitFor({ state: "visible" });
  await page.reload();
  const restored = page.locator("form.tm-send").getByRole("textbox", { name: /직접 지시/ });
  await restored.waitFor({ state: "visible" });
  expect(await restored.inputValue()).toBe("다음 직접 지시는 그대로 유지");
  await form.getByRole("button", { name: "같은 내용 재시도", exact: true }).waitFor({ state: "visible" });
  await page.unroute("**/api/messages/*");
  await form.getByRole("button", { name: "다시 확인", exact: true }).click();
  await form.getByRole("button", { name: "같은 내용 재시도", exact: true }).waitFor({ state: "detached" });
  expect(posts.length).toBe(before + 1);
  expect(await restored.inputValue()).toBe("다음 직접 지시는 그대로 유지");
  expect(errors).toEqual([]);
  await context.close(); contexts.splice(contexts.indexOf(context), 1);
}, 30000);

test("access-code rotation retains unsent draft and uncertain attempt through reauthentication", async () => {
  const { page, context } = await pageFor();
  await page.route("**/api/projects/*/messages", async route => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fetch(); await route.abort("failed");
  });
  await page.route("**/api/messages/*", route => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"fixture lost acknowledgement"}' }));
  const before = posts.length;
  suppressNextAcknowledgement = true;
  await page.getByRole("textbox", { name: "입력칸" }).fill("코드 변경 전 응답을 잃은 메시지");
  await page.getByRole("button", { name: "보내기", exact: true }).click();
  await until(() => posts.length === before + 1);
  await page.getByRole("button", { name: "같은 내용 재시도", exact: true }).waitFor({ state: "visible" });
  await page.getByRole("textbox", { name: "입력칸" }).fill("다시 로그인해도 남아야 하는 초안");
  const rotated = await fetch(`${base}/api/auth/rotate`, { method: "POST", headers, body: "{}" });
  expect(rotated.status).toBe(200);
  const nextCode = (await rotated.json() as { accessCode: string }).accessCode;
  await page.getByLabel("접속 코드").waitFor({ state: "visible", timeout: 15000 });
  await page.getByLabel("접속 코드").fill(nextCode);
  await page.getByRole("button", { name: "들어가기", exact: true }).click();
  const restored = page.getByRole("textbox", { name: "입력칸" });
  await restored.waitFor({ state: "visible", timeout: 15000 });
  expect(await restored.inputValue()).toBe("다시 로그인해도 남아야 하는 초안");
  await page.getByRole("button", { name: "같은 내용 재시도", exact: true }).waitFor({ state: "visible" });
  await page.unroute("**/api/messages/*");
  await page.getByRole("button", { name: "다시 확인", exact: true }).click();
  await page.getByRole("button", { name: "같은 내용 재시도", exact: true }).waitFor({ state: "detached" });
  expect(await restored.inputValue()).toBe("다시 로그인해도 남아야 하는 초안");
  expect(posts.length).toBe(before + 1);
  expect(errors).toEqual([]);
  await context.close(); contexts.splice(contexts.indexOf(context), 1);
}, 40000);
