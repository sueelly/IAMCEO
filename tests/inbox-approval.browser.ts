// 결재함 '승인 대기'에서 core 직원 CLI 의 승인 창에 답하기(대표 2026-11-17 "터미널 승인하는 거 결재함에서 클릭할 수 있도록 해").
// 실제 서버(http.ts)·실제 CoreRunner·실제 화면·격리 DB. core 는 격리 가짜 소켓이고 실제 CLI·모델은 없다(창 글은 Claude Code 2.1.322 실측 캡처).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { Bus } from "../server/bus.ts";
import { loadConfig, updateConfigFile } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { startServer, type RunningServer } from "../server/http.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import { CoreRunner } from "../server/runner/core.ts";
import type { CoreTerminal } from "../server/runner/core-client.ts";
import { transcriptPath } from "../server/runner/transcript.ts";
import { Store } from "../server/store.ts";
import type { Member, Project, Task } from "../shared/types.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";

setDefaultTimeout(60_000);
const runtime = createIsolatedRuntime();
const SHOTS = process.env.IAMCEO_E2E_SHOTS ?? join(runtime.dir, "shots");
mkdirSync(SHOTS, { recursive: true });
const fx = (name: string) => readFileSync(join(import.meta.dir, "fixtures/native-prompts", name), "utf8");
const BASH = fx("claude-bash-permission.txt");
const composer = (text = "") => `${text}\n${"─".repeat(40)}\n❯ \n${"─".repeat(40)}\n`;

interface Holder { terminal: CoreTerminal; screen: string; onKeys: ((keys: string[]) => void) | null }
const holders = new Map<string, Holder>();
const calls: { method: string; params: Record<string, any> }[] = [];
const sockets = new Set<Socket>();
let peer: Server;
let server: RunningServer;
let orch: Orchestrator;
let store: Store;
let browser: Browser;
let base = "";
let code = "";
let project: Project;
let pay: Member;
let task: Task;
const keys = () => calls.filter((c) => c.method === "terminal.keys" || (c.method === "terminal.send" && c.params.force));
const holderOf = (m: Member) => holders.get(store.requireMember(m.id).paneId!)!;
const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));

/** 직원 칸을 승인 창 앞에 세운다. 키를 받으면 accept 대로 움직인다. */
function block(m: Member, screen: string, onKeys: Holder["onKeys"] = null) {
  const h = holderOf(m);
  h.terminal.status = { state: "blocked", kind: "permission" } as CoreTerminal["status"];
  h.screen = screen;
  h.onKeys = onKeys;
}
/** 실제 CLI 처럼: 창이 닫히고 일하다가 잠시 뒤 턴을 끝낸다. 출력 줄을 화면에 남긴다. */
const runsThen = (m: Member, output: string, report = false) => () => {
  const h = holderOf(m);
  h.terminal.status = { state: "working" } as CoreTerminal["status"];
  h.screen = composer(`⏺ Bash(touch probe-claude.txt && ls -l probe-claude.txt)\n  ⎿  Running…`);
  // 직원이 결과를 보고한 뒤 턴을 끝낸다(보고 없이 끝나면 서버가 보고 보완을 보내 다시 일하게 된다)
  setTimeout(async () => {
    if (report) {
      const path = join(runtime.paths.work, "probe-claude.txt");
      writeFileSync(path, "");
      expect(statSync(path).size).toBe(0);
      await orch.recordPost(store.requireMember(m.id), { kind: "완료", title: "시험 파일을 만들었습니다", taskId: task.id, contractRev: 1,
        checks: [{ kind: "real", name: "승인한 시험 파일 확인", result: "pass", criterion: 1, evidence: "격리 작업 폴더의 probe-claude.txt가 빈 파일이다" }] });
    }
    h.terminal.status = { state: "idle" } as CoreTerminal["status"]; h.terminal.turn = (h.terminal.turn ?? 0) + 1; h.screen = composer(output);
  }, 600);
};
const idle = (m: Member) => { const h = holderOf(m); h.terminal.status = { state: "idle" } as CoreTerminal["status"]; h.screen = composer(); h.onKeys = null; };

beforeAll(async () => {
  const methods = ["terminal.run", "terminal.list", "terminal.get", "terminal.read", "terminal.send", "terminal.keys", "terminal.kill", "terminal.interrupt"];
  peer = createServer((socket) => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {}); socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n"); const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        const { method, params: p = {} } = request;
        calls.push({ method, params: p });
        let result: unknown;
        const h = holders.get(p.terminal);
        if (method === "hello") result = { generation: 1, version: "inbox-fake", methods, features: [] };
        else if (method === "terminal.list") result = { terminals: [...holders.values()].map((x) => x.terminal) };
        else if (method === "terminal.run") {
          const t: CoreTerminal = { address: `t${holders.size + 1}`, argv: p.argv, cwd: p.cwd, labels: p.labels, state: "live", turn: 0, status: { state: "idle" }, reported: true };
          holders.set(t.address, { terminal: t, screen: composer(), onKeys: null });
          if (p.labels["iamceo.cli"] === "claude") {
            const path = transcriptPath(p.cwd, p.labels["iamceo.session"], runtime.paths.claudeHome);
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, JSON.stringify({ type: "system", sessionId: p.labels["iamceo.session"], cwd: p.cwd, isSidechain: false }) + "\n");
          }
          result = t;
        } else if (!h) result = undefined;
        else if (method === "terminal.get") result = h.terminal;
        else if (method === "terminal.read") result = { text: h.screen, complete: true };
        else if (method === "terminal.send") {
          if (p.force) { h.onKeys?.([p.text]); result = { turn: h.terminal.turn }; }
          else if (h.terminal.status?.state !== "idle") result = undefined;
          else if (/^\/effort ultracode (on|off)$/.test(p.text)) {
            h.screen = composer(`${p.text}\nUltracode ${p.text.endsWith("on") ? "on" : "off"} (this session only)`);
            result = { turn: h.terminal.turn, started: true };
          } else { h.terminal.status = { state: "working" }; result = { turn: h.terminal.turn, started: true }; }
        } else if (method === "terminal.keys") { h.onKeys?.(p.keys); result = { turn: h.terminal.turn }; }
        else if (method === "terminal.interrupt") { h.terminal.status = { state: "idle" }; result = { outcome: "stopped" }; }
        else if (method === "terminal.kill") { h.terminal.state = "finished"; result = h.terminal; }
        socket.write(JSON.stringify(result === undefined ? { jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "refused", data: { kind: "conflict" } } } : { jsonrpc: "2.0", id: request.id, result }) + "\n");
      }
    });
  });
  await new Promise<void>((resolve, reject) => { peer.once("error", reject); peer.listen(runtime.socketPath, resolve); });
  const env = { IAMCEO_HOME: runtime.paths.iamceoHome, IAMCEO_PORT: "0", IAMCEO_CORE_SOCKET: runtime.socketPath, IAMCEO_HERDR_SOCKET: runtime.herdrSocketPath,
    IAMCEO_CORE_BIN: runtime.bins.coreBin, IAMCEO_CLAUDE_BIN: runtime.bins.claudeBin, IAMCEO_CODEX_BIN: runtime.bins.codexBin };
  updateConfigFile({ hosts: ["127.0.0.1"], accessCode: "inbox-approval-fixture-only" }, env);
  const config = loadConfig(env);
  code = config.accessCode;
  const bus = new Bus();
  store = new Store(openDb(config.dbPath), bus);
  store.patchSettings({ boardTidyHours: 0, maxConcurrentTurns: 2 });
  project = store.createProject({ name: "결재함 승인 시험", cwd: runtime.paths.work, chiefCli: "claude" });
  const runner = new CoreRunner(runtime.runnerOptions(runtime.providerHomes), { recoveryStore: store, pollMs: 40, rpcTimeoutMs: 500, sendTimeoutMs: 300, acceptCheckMs: 900 });
  orch = new Orchestrator({ config, store, runners: new Map([["core", runner]]), providerHomes: runtime.providerHomes, timings: { tickMs: 60_000, healthMs: 60_000 } });
  server = await startServer({ config, store, bus, orch, delivery: orch.deliveryRecovery });
  base = server.urls[0]!;
  orch.setServerUrl(base);
  pay = await orch.createMember(project.id, { name: "결제 연동", cli: "claude" });
  task = orch.saveTask(pay, { title: "환불 기능", branch: "feat/refund" }).task;
  await orch.sendUserMessage(project.id, { intent: "execute", text: "환불 기능 시험 파일을 만들어 주세요", targetMemberId: pay.id, taskId: task.id,
    contract: { kind: "other", goal: "승인한 시험 파일을 만든다", inputs: ["대표의 환불 기능 시험 지시"], outputs: ["빈 probe-claude.txt"],
      scope: "격리 폴더에서 시험 파일을 만든다", constraints: [], exclusions: [], acceptance: ["probe-claude.txt가 빈 파일로 생성됐다"], checks: ["real"] } });
  for (let i = 0; i < 100 && !store.listPendingExecutions().some(run => run.memberId === pay.id && run.inputReceivedAt); i++) await settle(40);
  const active = store.listPendingExecutions().find(run => run.memberId === pay.id && run.inputReceivedAt);
  expect(active?.deliveryIds.map(id => store.deliveryTaskId(id))).toEqual([task.id]);
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await orch?.shutdown();
  await server?.stop();
  for (const s of sockets) s.destroy();
  await new Promise<void>((r) => peer.close(() => r()));
  await runtime.stop();
  console.log(`shots: ${SHOTS}`);
});

async function openInbox(page: Page) {
  await page.goto(`${base}/api/health`);
  await page.evaluate((c) => localStorage.setItem("iamceo.accessCode", c), code);
  await page.goto(`${base}/#/p/${encodeURIComponent(project.id)}/inbox`);
  await page.locator(".ibx").waitFor({ timeout: 20_000 });
}
const card = (page: Page) => page.locator("article.ibx-approval", { hasText: "결제 연동" });
async function waitBlocked(m: Member) {
  for (let i = 0; i < 100 && store.requireMember(m.id).status !== "blocked"; i++) await settle(30);
  expect(store.requireMember(m.id).status).toBe("blocked");
}
/** n 번 선택지를 고른다(버튼 글에는 승인·거절 표지가 붙는다) */
const opt = (page: Page, n: number) => card(page).locator(".apv-opt").filter({ has: page.locator(".apv-opt__n", { hasText: new RegExp(`^${n}\\.$`) }) });
async function pickAndConfirm(page: Page, n: number) {
  await opt(page, n).click();
  await page.waitForTimeout(700); // CONFIRM_MIN_MS(600): 고른 직후 누름은 확인으로 받지 않는다
}
const noSideScroll = (page: Page) => page.evaluate(() => document.scrollingElement!.scrollWidth <= window.innerWidth + 1);

describe("결재함에서 직원 CLI 승인 창에 답하기", () => {
  test("데스크톱: 직원·업무·창 글·선택지와 고르면 생기는 일을 보고, 승인하면 한 번 들어가 단계가 나뉘어 보인다", async () => {
    block(pay, BASH, runsThen(pay, "⏺ Bash(touch probe-claude.txt && ls -l probe-claude.txt)\n  ⎿  -rw-r--r--  1 me  staff  0 Nov 17 12:00 probe-claude.txt", true));
    await waitBlocked(pay);
    const prompt = await orch.memberNativePrompt(pay.id);
    expect(prompt.context?.taskId).toBe(task.id);
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await openInbox(page);
    const c = card(page);
    await c.locator(".apv-opt").first().waitFor({ timeout: 10_000 });
    const text = await c.innerText();
    for (const part of ["결제 연동", "권한 승인에 답을 기다립니다", "Claude", "업무: 환불 기능", "Bash command", "touch probe-claude.txt && ls -l probe-claude.txt", "Do you want to proceed?", "1.", "Yes", "4.", "No", "승인", "거절", "이후에도 적용"]) expect(text).toContain(part);
    expect(text).not.toContain("여기서 답할 수 없는 창입니다");
    expect(text).not.toContain("새 업무 지시가 아니며"); // 결재함에서는 배치로 아는 안내문을 늘어놓지 않는다
    await page.screenshot({ path: join(SHOTS, "1-inbox-desktop.png") });
    await pickAndConfirm(page, 1);
    await expect(c.locator(".apv-confirm__hint").innerText()).resolves.toBe("승인을 고릅니다. 직원 CLI가 위 내용을 이번 한 번 실행합니다.");
    await page.screenshot({ path: join(SHOTS, "2-inbox-picked.png") });
    const before = keys().length;
    await c.locator(".apv-confirm__go").click();
    await c.locator(".npc-stages").waitFor({ timeout: 10_000 });
    expect(keys().slice(before).map((k) => k.params.keys ?? k.params.text)).toEqual([["enter"]]);
    const stages = await c.locator(".npc-stages").innerText();
    expect(stages).toContain("창 확인");
    expect(stages).toContain("응답 기록");
    expect(stages).toContain("터미널 접수");
    expect(stages).toContain("받음 · 창이 닫혔습니다");
    // 넷째 칸은 넣은 뒤 CLI 상태만 보인다. 명령의 종료·출력을 안다고 쓰지 않는다
    expect(await c.locator(".npc-stages li > span:first-child").allInnerTexts()).toEqual(["창 확인", "응답 기록", "터미널 접수", "CLI 상태"]);
    expect(await c.locator(".npc-result").innerText()).toContain("답했습니다 · 'Yes' 을 골랐습니다");
    await page.screenshot({ path: join(SHOTS, "3-inbox-answered.png") });
    // 턴이 끝나면 CLI 상태 칸이 그 상태로 바뀐다(명령 출력은 직원 보고·팀 화면에 있다)
    await page.waitForFunction(() => document.querySelector(".npc-stages")?.textContent?.includes("턴이 끝났습니다 · 명령 결과는 직원 보고에서 보세요"), null, { timeout: 10_000 });
    await page.screenshot({ path: join(SHOTS, "4-inbox-after.png") });
    // 대화에 시스템 한 줄: 결재함에서 답했다
    expect(store.listMessages(project.id).some((m) => m.kind === "시스템" && m.body.includes("결제 연동의 권한 창에 대표가 결재함에서 답함 — 1번 'Yes'"))).toBe(true);
    await page.close();
  });

  test("거절: 고르면 하지 않는다고 보이고, 그 줄까지 옮겨 한 번 넣는다", async () => {
    block(pay, BASH, () => { const h = holderOf(pay); h.terminal.status = { state: "idle" } as CoreTerminal["status"]; h.screen = composer("  ⎿  Interrupted · What should Claude do instead?"); });
    await waitBlocked(pay);
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await openInbox(page);
    const c = card(page);
    await c.locator(".apv-opt").first().waitFor({ timeout: 10_000 });
    await pickAndConfirm(page, 4);
    await expect(c.locator(".apv-confirm__hint").innerText()).resolves.toBe("거절을 고릅니다. 직원 CLI는 이 일을 하지 않습니다.");
    await expect(c.locator(".apv-confirm__go").innerText()).resolves.toBe("거절 확인");
    const before = keys().length;
    await c.locator(".apv-confirm__go").click();
    await c.locator(".npc-stages").waitFor({ timeout: 10_000 });
    expect(keys().slice(before).map((k) => k.params.keys)).toEqual([["down", "down", "down", "enter"]]);
    await expect(c.locator(".npc-stages").innerText()).resolves.toContain("거절을 넣음 · 턴이 끝났습니다");
    await page.screenshot({ path: join(SHOTS, "5-inbox-rejected.png") });
    await page.close();
  });

  test("낡은 카드: 보던 창이 바뀌었으면 넣지 않고 지금 창을 다시 보인다", async () => {
    idle(pay); await settle(150);
    block(pay, BASH, runsThen(pay, "done"));
    await waitBlocked(pay);
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await openInbox(page);
    const c = card(page);
    await c.locator(".apv-opt").first().waitFor({ timeout: 10_000 });
    holderOf(pay).screen = BASH.replaceAll("touch probe-claude.txt && ls -l probe-claude.txt", "rm -rf build-cache");
    await pickAndConfirm(page, 1);
    const before = keys().length;
    await c.locator(".apv-confirm__go").click();
    await page.waitForFunction(() => document.querySelector(".npc-result")?.textContent?.includes("창이 바뀌어 넣지 않았습니다"), null, { timeout: 10_000 });
    expect(keys().length).toBe(before);
    await expect(c.locator(".npc-stages").innerText()).resolves.toContain("넣지 않음");
    // 잠시 뒤 지금 창(바뀐 명령)을 다시 읽어 보인다
    await page.waitForFunction(() => document.querySelector("article.ibx-approval .apv-body")?.textContent?.includes("rm -rf build-cache"), null, { timeout: 10_000 });
    await expect(c.locator(".apv-error").first().innerText()).resolves.toBe("보던 창이 바뀌어 고른 답을 넣지 않았습니다. 지금 창을 보고 다시 고르세요.");
    expect(await c.locator(".apv-confirm").count()).toBe(0); // 고른 것은 지웠다
    await page.screenshot({ path: join(SHOTS, "6-inbox-stale.png") });
    await page.close();
  });

  test("두 탭에서 같은 창을 눌러도, 응답을 잃고 다시 받아도 한 번만 들어간다", async () => {
    idle(pay); await settle(150);
    // 키를 받아도 창이 그대로인 CLI: 서버는 '확인 필요'로 두고 다시 넣지 않는다
    block(pay, BASH, null);
    await waitBlocked(pay);
    const a = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const b = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await openInbox(a); await openInbox(b);
    for (const p of [a, b]) await card(p).locator(".apv-opt").first().waitFor({ timeout: 10_000 });
    // a 의 첫 응답은 서버가 처리한 뒤 잃는다(브라우저에는 오류). 같은 id 로만 다시 받는다.
    let dropped = 0;
    const bodies: string[] = [];
    await a.route("**/prompt/answer", async (route) => { bodies.push(route.request().postData() ?? ""); if (!dropped++) { await route.fetch(); await route.abort("connectionreset"); } else await route.continue(); });
    await pickAndConfirm(a, 1);
    await pickAndConfirm(b, 1);
    const before = keys().length;
    await card(a).locator(".apv-confirm__go").click();
    await card(a).locator(".apv-error, .npc-result").first().waitFor({ timeout: 10_000 });
    if (await card(a).locator(".apv-error").count()) {
      expect(await card(a).locator(".apv-error").innerText()).toContain("같은 답의 결과만 받아 옵니다");
      await a.screenshot({ path: join(SHOTS, "10-inbox-lost-response.png") });
      await card(a).locator(".apv-reread").first().click();
    }
    await card(a).locator(".npc-result").waitFor({ timeout: 10_000 });
    expect(bodies.length).toBe(2);
    expect(JSON.parse(bodies[1]!).operationId).toBe(JSON.parse(bodies[0]!).operationId);
    await expect(card(a).locator(".npc-result").innerText()).resolves.toBe("'Yes' 을 넣었지만 창이 그대로입니다. 다시 넣지 않습니다. 팀 화면에서 터미널을 확인하세요");
    await expect(card(a).locator(".npc-stages").innerText()).resolves.toContain("확인 필요 · 넣은 뒤에도 창이 그대로였습니다");
    // b 는 같은 창을 골라 둔 채였다. 다시 읽으면 이미 답한 창이라 선택지가 없고, 그 전에 눌렀어도 서버가 넣지 않는다.
    const bCtx = await b.evaluate(async ([id, c]) => (await (await fetch(`/api/members/${id}/prompt`, { headers: { Authorization: `Bearer ${c}` } })).json()), [pay.id, code] as const);
    expect(bCtx).toMatchObject({ prompt: null, context: null, answered: true });
    await card(b).locator(".apv-reread").first().click();
    await card(b).locator(".apv-wait", { hasText: "이 창에는 이미 답했습니다" }).waitFor({ timeout: 10_000 });
    expect(await card(b).locator(".apv-opt").count()).toBe(0);
    await a.screenshot({ path: join(SHOTS, "11-inbox-unconfirmed.png") });
    await b.screenshot({ path: join(SHOTS, "12-inbox-second-tab.png") });
    expect(keys().length - before).toBe(1);
    await a.close(); await b.close();
  });

  test("폰 폭 390px: 옆으로 밀리지 않고 카드·선택지·확인이 보인다", async () => {
    idle(pay); await settle(150);
    block(pay, BASH, runsThen(pay, "done"));
    await waitBlocked(pay);
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await openInbox(page);
    const c = card(page);
    await c.locator(".apv-opt").first().waitFor({ timeout: 10_000 });
    expect(await noSideScroll(page)).toBe(true);
    await opt(page, 1).tap();
    await page.waitForTimeout(700);
    await c.locator(".apv-confirm__go").waitFor();
    expect(await noSideScroll(page)).toBe(true);
    await page.screenshot({ path: join(SHOTS, "7-inbox-phone.png"), fullPage: true });
    const before = keys().length;
    await c.locator(".apv-confirm__go").tap();
    await c.locator(".npc-stages").waitFor({ timeout: 10_000 });
    expect(keys().length - before).toBe(1);
    expect(await noSideScroll(page)).toBe(true);
    await page.screenshot({ path: join(SHOTS, "8-inbox-phone-answered.png"), fullPage: true });
    await page.close();
  });

  test("읽지 못한 창은 버튼 없이 원문만, 일반 출력·완료는 승인 대기로 보이지 않는다", async () => {
    idle(pay); await settle(150);
    block(pay, "작업 로그\n  ❯ 하나\n  ❯ 둘\n\n  Enter to confirm · Esc to cancel");
    await waitBlocked(pay);
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await openInbox(page);
    const c = card(page);
    await c.locator(".apv-error").waitFor({ timeout: 10_000 });
    expect(await c.locator(".apv-opt").count()).toBe(0);
    expect(await c.innerText()).toContain("선택지를 확실히 읽지 못해 여기서는 답하지 않습니다");
    await page.screenshot({ path: join(SHOTS, "9-inbox-limited.png") });
    // 끝난 칸(일반 출력, 번호 목록이 있어도)은 승인 대기가 아니다
    const h = holderOf(pay);
    h.terminal.status = { state: "idle" } as CoreTerminal["status"];
    h.screen = composer("계획:\n  1. Yes 로 진행\n  2. No 면 멈춤\n완료했습니다");
    await page.waitForFunction(() => !document.querySelector("section[aria-label='승인 대기']"), null, { timeout: 10_000 });
    expect(await page.locator(".ibx").innerText()).not.toContain("승인 대기");
    await page.close();
  });
});
