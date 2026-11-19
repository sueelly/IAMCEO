// 자료 화면의 업무 거르기(대표 2026-11-16): 입력칸에서 고른 업무가 자료 목록에도 걸린다.
// 실제 서버(http.ts)·실제 화면·격리 DB. 실제 CLI·세션은 없고, 자료와 보고는 서버 저장소·도구 처리기로 남긴다.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { Bus } from "../server/bus.ts";
import { loadConfig, updateConfigFile } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { startServer, type RunningServer } from "../server/http.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import type { Runner, RunnerEvent, SendResult } from "../server/runner/types.ts";
import { Store } from "../server/store.ts";
import type { Backend, FileDoc, Member, Project, Task } from "../shared/types.ts";

const CODE = "files-task-test-code";
const SHOTS = process.env.IAMCEO_E2E_SHOTS ?? mkdtempSync(join(tmpdir(), "iamceo-files-task-shots-"));
mkdirSync(SHOTS, { recursive: true });

class FakeRunner implements Runner {
  readonly kind: Backend = "headless";
  busy = new Set<string>();
  private cb: (e: RunnerEvent) => void = () => {};
  async available() { return { ok: true }; }
  async start() { return { sessionId: crypto.randomUUID(), paneId: null }; }
  async send(m: { id: string }): Promise<SendResult> { this.busy.add(m.id); return { ok: true }; }
  isBusy(id: string) { return this.busy.has(id); }
  async compact(): Promise<SendResult> { return { ok: true }; }
  async setParallel(): Promise<SendResult> { return { ok: true }; }
  async interrupt() {}
  async stop(m: { id: string }) { this.busy.delete(m.id); }
  async screen() { return ""; }
  on(cb: (e: RunnerEvent) => void) { this.cb = cb; }
  async shutdown() {}
  end(memberId: string) { this.busy.delete(memberId); this.cb({ type: "turn_end", memberId, finalText: "", isError: false }); }
}

let server: RunningServer;
let orch: Orchestrator;
let store: Store;
let browser: Browser;
let base = "";
let project: Project;
let pay: Member;
let search: Member;
let taskPay: Task;
let taskSearch: Task;
let taskEmpty: Task;
let fOld: FileDoc;
let fRefundDoc: FileDoc;
let fRefundFlow: FileDoc;
let fSearch: FileDoc;
const settle = () => new Promise((r) => setTimeout(r, 50));

beforeAll(async () => {
  const home = mkdtempSync(join(tmpdir(), "iamceo-files-task-web-"));
  const env = { IAMCEO_HOME: home, IAMCEO_PORT: "0" };
  updateConfigFile({ accessCode: CODE, hosts: ["127.0.0.1"] }, env);
  const config = loadConfig(env);
  const bus = new Bus();
  store = new Store(openDb(config.dbPath), bus);
  const runner = new FakeRunner();
  orch = new Orchestrator({ config, store, runners: new Map<Backend, Runner>([["headless", runner]]) });
  server = await startServer({ config, store, bus, orch, delivery: orch.deliveryRecovery });
  base = server.urls[0]!;
  orch.setServerUrl(base);
  project = store.createProject({ name: "업무별 자료 시험", cwd: home });
  const lead = await orch.ensureConductor(project.id);
  runner.end(lead.id);
  pay = (await orch.addMember(project.id, { name: "결제 연동", handle: "pay", role: "개발" })).member;
  search = (await orch.addMember(project.id, { name: "검색 개선", handle: "search", role: "개발" })).member;
  runner.end(pay.id);
  runner.end(search.id);
  await settle();
  // 업무가 생기기 전의 옛 자료(업무 없음)
  fOld = store.createFile({ projectId: project.id, title: "옛 회의록", who: lead.name, memberId: lead.id, summary: "업무가 붙기 전 자료", body: "# 옛 회의록\n\n업무 없는 자료", kind: "document" });
  taskPay = orch.saveTask(pay, { title: "환불 기능", branch: "feat/refund" }).task;
  await settle();
  taskSearch = orch.saveTask(search, { title: "검색 속도", branch: "feat/search-speed" }).task;
  await settle();
  taskEmpty = orch.saveTask(search, { title: "문서 정리", branch: "docs/tidy" }).task;
  // 글이 없는 업무는 칩에서 빠지므로 업무마다 보고 하나를 남긴다
  // 기존 대화에 남은 진행 글도 업무별로 조회할 수 있다.
  store.createMessage({ projectId: pay.projectId, memberId: pay.id, who: pay.name, kind: "진행", title: "환불 설계 시작", taskId: taskPay.id });
  store.createMessage({ projectId: search.projectId, memberId: search.id, who: search.name, kind: "진행", title: "검색 색인 점검", taskId: taskSearch.id });
  store.createMessage({ projectId: search.projectId, memberId: search.id, who: search.name, kind: "진행", title: "문서 정리 시작", taskId: taskEmpty.id });
  fRefundDoc = store.createFile({ projectId: project.id, title: "환불 설계서", who: pay.name, memberId: pay.id, summary: "부분 환불 포함", body: "# 환불 설계서\n\n부분 환불 규칙", kind: "document", taskId: taskPay.id });
  fSearch = store.createFile({ projectId: project.id, title: "검색 색인 보고", who: search.name, memberId: search.id, summary: "색인 3종 점검", body: "# 검색 색인 보고\n\n색인 점검 결과", kind: "document", taskId: taskSearch.id });
  fRefundFlow = store.createFile({ projectId: project.id, title: "환불 흐름 그림", who: pay.name, memberId: pay.id, summary: "요청부터 입금까지", kind: "artifact", html: "<main class=\"page\"><h1>환불 흐름</h1><p>요청 → 승인 → 입금</p></main>", taskId: taskPay.id });
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await orch.shutdown();
  await server.stop();
  console.log(`shots: ${SHOTS}`);
});

async function openFiles(page: Page, sub = "") {
  await page.goto(`${base}/api/health`);
  await page.evaluate((code) => localStorage.setItem("iamceo.accessCode", code), CODE);
  await page.goto(`${base}/#/p/${encodeURIComponent(project.id)}/files${sub ? `/${sub}` : ""}`);
  try { await page.locator(".cmp-tasks").waitFor({ timeout: 20_000 }); await page.locator(".fl").waitFor({ timeout: 20_000 }); }
  catch (e) { await page.screenshot({ path: join(SHOTS, "fail.png"), fullPage: true }); console.log(await page.locator("body").innerText()); throw e; }
}
const go = (page: Page, tail: string) => page.evaluate((hash) => { location.hash = hash; }, `#/p/${encodeURIComponent(project.id)}/${tail}`);
const chip = (page: Page, name: string) => page.locator(".cmp-task", { hasText: name });
/** 업무 고르기: 한 줄에 보이는 칩이면 누르고, 가려졌으면 '+N'으로 전체 목록을 열어 고른다. */
async function selectTask(page: Page, name: string, how: "click" | "tap" = "click") {
  const c = chip(page, name);
  if ((await c.getAttribute("aria-hidden")) !== "true") return how === "tap" ? c.tap() : c.click();
  const more = page.locator(".cmp-task--more");
  await (how === "tap" ? more.tap() : more.click());
  const item = page.locator(".cmp-menu--tasks .cmp-menu__item", { hasText: name });
  await (how === "tap" ? item.tap() : item.click());
}
const titles = (page: Page) => page.locator(".fl-list .fl-row__title").allInnerTexts();
/** 목록이 기대한 제목들로 바뀔 때까지 기다린다. */
async function listIs(page: Page, expected: string[]) {
  try { await page.waitForFunction((want) => JSON.stringify([...document.querySelectorAll(".fl-list .fl-row__title")].map((e) => e.textContent)) === JSON.stringify(want), expected, { timeout: 10_000 }); }
  catch (e) { console.log("목록:", await titles(page)); throw e; }
}
const kindChips = (page: Page) => page.locator(".fl-chip").allInnerTexts().then((a) => a.map((t) => t.replace(/\s+/g, " ").trim()));
const readerTitle = (page: Page) => page.locator(".fl-doc__title").innerText();

describe("자료 화면의 업무 거르기", () => {
  test("데스크톱: 입력칸에서 고른 업무의 자료만 보이고, 대화 화면과 같은 선택을 쓴다", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await openFiles(page);
    // '전체': 업무 없는 옛 자료까지 모두, 최신 먼저. 업무 줄은 없다
    await expect(chip(page, "전체").getAttribute("aria-pressed")).resolves.toBe("true");
    await listIs(page, ["환불 흐름 그림", "검색 색인 보고", "환불 설계서", "옛 회의록"]);
    await expect(page.locator(".fl-task").count()).resolves.toBe(0);
    await expect(kindChips(page)).resolves.toEqual(["전체 4", "문서 3", "아티팩트 1"]);
    // 전체에서는 읽는 자료가 어느 업무의 것인지 보인다
    await expect(readerTitle(page)).resolves.toBe("환불 흐름 그림");
    await expect(page.locator(".fl-doc__task").innerText()).resolves.toBe("환불 기능");
    await page.screenshot({ path: join(SHOTS, "1-all.png") });

    // 1) 업무(환불)를 고르면 그 업무의 자료만 남고, 종류 칩의 수도 그 업무 것이다
    await selectTask(page, "환불 기능");
    await listIs(page, ["환불 흐름 그림", "환불 설계서"]);
    await expect(page.locator(".fl-task").innerText()).resolves.toContain("환불 기능");
    await expect(kindChips(page)).resolves.toEqual(["전체 2", "문서 1", "아티팩트 1"]);
    await expect(page.locator(".fl-list").getAttribute("aria-label")).resolves.toBe("자료 목록: 업무 환불 기능");
    // 같은 업무의 자료에는 업무 표지를 되풀이하지 않는다
    await expect(page.locator(".fl-doc__task").count()).resolves.toBe(0);
    await page.screenshot({ path: join(SHOTS, "2-refund.png") });
    // 종류로 한 번 더 거를 수 있다
    await page.locator(".fl-chip", { hasText: "문서" }).click();
    await listIs(page, ["환불 설계서"]);
    await expect(readerTitle(page)).resolves.toBe("환불 설계서");

    // 2) 대화 화면도 같은 업무를 보고 있고, 돌아와도 자료는 그 업무 그대로다
    await go(page, "thread");
    await page.locator(".th-task").waitFor();
    await expect(page.locator(".th-task").innerText()).resolves.toContain("환불 기능");
    await go(page, "files");
    await page.locator(".fl-task").waitFor();
    await expect(page.locator(".fl-task").innerText()).resolves.toContain("환불 기능");
    await expect(titles(page)).resolves.not.toContain("검색 색인 보고");

    // 3) 다른 업무(검색)로 바꾸면 목록과 읽는 자료가 그 업무로 바뀐다. 거르던 종류가 그 업무에 없어도 빈 화면이 되지 않는다
    await selectTask(page, "검색 속도");
    await listIs(page, ["검색 색인 보고"]);
    await expect(readerTitle(page)).resolves.toBe("검색 색인 보고");
    await expect(page.locator(".fl-chip").count()).resolves.toBe(0);

    // 4) 보고 있는 업무가 아닌 업무에 새 자료가 올라와도 목록에 끼지 않고, 보고 있는 업무의 새 자료는 맨 위에 붙는다
    store.createFile({ projectId: project.id, title: "환불 시험 결과", who: pay.name, memberId: pay.id, body: "통과", kind: "document", taskId: taskPay.id });
    const added = store.createFile({ projectId: project.id, title: "검색 속도 측정", who: search.name, memberId: search.id, body: "측정", kind: "document", taskId: taskSearch.id });
    await listIs(page, ["검색 속도 측정", "검색 색인 보고"]);

    // 5) 총괄이 자료의 업무를 옮기면 목록에서도 따라 움직인다
    expect(store.moveRecordTask({ projectId: project.id, refType: "file", refId: added.id, from: taskSearch.id, to: taskPay.id, basis: "classify", actor: "시험" })).toBe(true);
    await listIs(page, ["검색 색인 보고"]);
    expect(store.moveRecordTask({ projectId: project.id, refType: "file", refId: added.id, from: taskPay.id, to: taskSearch.id, basis: "classify", actor: "시험" })).toBe(true);
    await listIs(page, ["검색 속도 측정", "검색 색인 보고"]);

    // 6) 새로고침해도 고른 업무가 남아 자료도 그 업무만 보인다
    await page.reload();
    await page.locator(".fl-task").waitFor({ timeout: 20_000 });
    await expect(chip(page, "검색 속도").getAttribute("aria-pressed")).resolves.toBe("true");
    await listIs(page, ["검색 속도 측정", "검색 색인 보고"]);

    // 7) '전체'로 돌아오면 모두 보인다. 업무 없는 옛 자료에는 업무 표지가 없다
    await selectTask(page, "전체");
    await listIs(page, ["검색 속도 측정", "환불 시험 결과", "환불 흐름 그림", "검색 색인 보고", "환불 설계서", "옛 회의록"]);
    await expect(page.locator(".fl-task").count()).resolves.toBe(0);
    await page.locator(".fl-row", { hasText: "옛 회의록" }).click();
    await page.waitForFunction(() => document.querySelector(".fl-doc__title")?.textContent === "옛 회의록");
    await expect(page.locator(".fl-doc__task").count()).resolves.toBe(0);
    await page.close();
  }, 90_000);

  test("데스크톱: 링크로 연 다른 업무의 자료는 그대로 열리고, 업무 표지를 누르면 그 업무의 자료만 본다", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await openFiles(page);
    await selectTask(page, "검색 속도");
    await page.locator(".fl-task").waitFor();
    // 대화·결재의 링크처럼 다른 업무(환불)의 자료 주소로 간다
    await go(page, `files/${fRefundDoc.id}`);
    await page.waitForFunction(() => document.querySelector(".fl-doc__title")?.textContent === "환불 설계서");
    // 목록은 고른 업무(검색) 그대로이고, 열린 자료는 목록에 없으니 고른 줄도 없다
    await expect(titles(page)).resolves.not.toContain("환불 설계서");
    await expect(page.locator(".fl-row[aria-current]").count()).resolves.toBe(0);
    await expect(page.locator(".fl-doc__task").innerText()).resolves.toBe("환불 기능");
    await expect(page.locator(".fl-doc__task").getAttribute("title")).resolves.toBe("업무 환불 기능의 자료만 보기");
    await page.screenshot({ path: join(SHOTS, "3-linked-other-task.png") });
    // 표지를 누르면 입력칸의 업무도 같이 바뀌고(대화의 업무 표지와 같은 길), 목록에서 그 자료가 골라져 있다
    await page.locator(".fl-doc__task").click();
    await page.waitForFunction(() => document.querySelector(".fl-task")?.textContent?.includes("환불 기능"));
    await expect(chip(page, "환불 기능").getAttribute("aria-pressed")).resolves.toBe("true");
    await expect(page.locator(".fl-row[aria-current] .fl-row__title").innerText()).resolves.toBe("환불 설계서");
    await expect(page.locator(".fl-doc__task").count()).resolves.toBe(0);
    await expect(readerTitle(page)).resolves.toBe("환불 설계서");
    await page.close();
  }, 60_000);

  test("데스크톱: 자료가 없는 업무는 안내를 보이고, 열어 둔 자료는 닫지 않는다", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await openFiles(page);
    await selectTask(page, "문서 정리");
    await page.locator(".empty__title").waitFor();
    await expect(page.locator(".empty__title").innerText()).resolves.toBe("이 업무에 올린 자료가 없습니다");
    await expect(page.locator(".empty__body").innerText()).resolves.toBe("모든 자료는 입력칸 위 ‘전체’에서 봅니다.");
    await expect(page.locator(".fl-task").innerText()).resolves.toContain("문서 정리");
    await expect(page.locator(".fl-list").count()).resolves.toBe(0);
    await expect(page.locator(".fl-doc").count()).resolves.toBe(0);
    await page.screenshot({ path: join(SHOTS, "4-empty-task.png") });
    // 그 업무에 자료가 올라오면 바로 보인다
    const fresh = store.createFile({ projectId: project.id, title: "문서 목차", who: search.name, memberId: search.id, body: "목차", kind: "document", taskId: taskEmpty.id });
    await listIs(page, ["문서 목차"]);
    await expect(readerTitle(page)).resolves.toBe("문서 목차");
    expect(store.moveRecordTask({ projectId: project.id, refType: "file", refId: fresh.id, from: taskEmpty.id, to: taskSearch.id, basis: "classify", actor: "시험" })).toBe(true);
    await page.locator(".empty__title").waitFor();
    // 자료를 읽는 중에 자료 없는 업무로 바꿔도 읽던 자료는 남는다(목록 칸에 안내만 뜬다)
    await selectTask(page, "전체");
    await page.locator(".fl-row", { hasText: "검색 색인 보고" }).click();
    await page.waitForFunction(() => document.querySelector(".fl-doc__title")?.textContent === "검색 색인 보고");
    await selectTask(page, "문서 정리");
    await page.locator(".fl-none").waitFor();
    await expect(page.locator(".fl-none").innerText()).resolves.toBe("이 업무에 올린 자료가 없습니다.");
    await expect(readerTitle(page)).resolves.toBe("검색 색인 보고");
    await expect(page.locator(".fl-doc__task").innerText()).resolves.toBe("검색 속도");
    await page.close();
  }, 60_000);

  test("폰: 목록에서 업무를 고르면 그 업무의 자료만 보이고, 상세에서 돌아와도 유지된다", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    await openFiles(page);
    await expect(titles(page)).resolves.toContain("옛 회의록");
    await selectTask(page, "환불 기능", "tap");
    await page.locator(".fl-task").waitFor();
    const got = await titles(page);
    expect(got).toContain("환불 설계서");
    expect(got).toContain("환불 흐름 그림");
    expect(got).not.toContain("검색 색인 보고");
    expect(got).not.toContain("옛 회의록");
    // 업무 줄이 화면 폭을 넘지 않는다
    await expect(page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).resolves.toBe(true);
    const bar = await page.locator(".fl-task").boundingBox();
    expect(bar!.x).toBeGreaterThanOrEqual(0);
    expect(bar!.x + bar!.width).toBeLessThanOrEqual(390);
    await page.screenshot({ path: join(SHOTS, "5-phone-refund.png") });
    // 상세로 갔다가 돌아와도 같은 업무의 목록이다
    await page.locator(".fl-row", { hasText: "환불 설계서" }).tap();
    await page.locator(".fl-back").waitFor();
    await expect(readerTitle(page)).resolves.toBe("환불 설계서");
    await expect(page.locator(".fl-doc__task").count()).resolves.toBe(0);
    await page.locator(".fl-back").tap();
    await page.locator(".fl-task").waitFor();
    await expect(titles(page)).resolves.not.toContain("검색 색인 보고");
    // 자료가 없는 업무
    await selectTask(page, "문서 정리", "tap");
    await page.locator(".empty__title").waitFor();
    await expect(page.locator(".empty__title").innerText()).resolves.toBe("이 업무에 올린 자료가 없습니다");
    await page.screenshot({ path: join(SHOTS, "6-phone-empty.png") });
    await selectTask(page, "전체", "tap");
    await page.locator(".fl-list").waitFor();
    await expect(titles(page)).resolves.toContain("옛 회의록");
    await page.close();
  }, 60_000);
});
