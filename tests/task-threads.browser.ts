// 웹 대화의 작업 고르기: 직원 선택 옆에 작업이 최신순으로 가로로 놓이고, 고르면 그 작업 대화만 보이며, 보낸 글은 보낸 순간의 작업에 남는다.
// 실제 서버(http.ts)·실제 화면·격리 DB. 실제 CLI·세션은 없고, 직원 보고는 서버의 같은 도구 처리기(recordPost)로 남긴다.
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
import type { Backend, Member, Project, Task } from "../shared/types.ts";

const CODE = "task-thread-test-code";
const SHOTS = process.env.IAMCEO_E2E_SHOTS ?? mkdtempSync(join(tmpdir(), "iamceo-task-shots-"));
mkdirSync(SHOTS, { recursive: true });

class FakeRunner implements Runner {
  readonly kind: Backend = "headless";
  sent: { memberId: string; text: string }[] = [];
  busy = new Set<string>();
  private cb: (e: RunnerEvent) => void = () => {};
  async available() { return { ok: true }; }
  async start() { return { sessionId: crypto.randomUUID(), paneId: null }; }
  async send(m: { id: string }, text: string): Promise<SendResult> { this.sent.push({ memberId: m.id, text }); this.busy.add(m.id); return { ok: true }; }
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
let runner: FakeRunner;
let browser: Browser;
let base = "";
let project: Project;
let pay: Member;
let search: Member;
let taskPay: Task;
let taskSearch: Task;
const extra: Task[] = [];
const settle = () => new Promise((r) => setTimeout(r, 50));
/** 화면의 낙관적 줄이 먼저 보일 수 있다. 서버에 저장될 때까지 기다린다. */
async function stored(body: string) {
  for (let i = 0; i < 100; i++) {
    const m = store.listMessages(project.id).find((x) => x.body === body);
    if (m) return m;
    await settle();
  }
  throw new Error(`저장되지 않음: ${body}`);
}

beforeAll(async () => {
  const home = mkdtempSync(join(tmpdir(), "iamceo-task-web-"));
  const env = { IAMCEO_HOME: home, IAMCEO_PORT: "0" };
  updateConfigFile({ accessCode: CODE, hosts: ["127.0.0.1"] }, env);
  const config = loadConfig(env);
  const bus = new Bus();
  store = new Store(openDb(config.dbPath), bus);
  runner = new FakeRunner();
  orch = new Orchestrator({ config, store, runners: new Map<Backend, Runner>([["headless", runner]]) });
  server = await startServer({ config, store, bus, orch, delivery: orch.deliveryRecovery });
  base = server.urls[0]!;
  orch.setServerUrl(base);
  project = store.createProject({ name: "작업별 대화 시험", cwd: home });
  const lead = await orch.ensureConductor(project.id);
  runner.end(lead.id);
  pay = (await orch.addMember(project.id, { name: "결제 연동", handle: "pay", role: "개발" })).member;
  search = (await orch.addMember(project.id, { name: "검색 개선", handle: "search", role: "개발" })).member;
  runner.end(pay.id);
  runner.end(search.id);
  await settle();
  // 작업이 생기기 전의 옛 대화
  store.createMessage({ projectId: project.id, mine: true, who: "나", kind: "나", body: "작업 전의 옛 지시" });
  store.createMessage({ projectId: project.id, memberId: lead.id, who: lead.name, kind: "답변", body: "옛 답변" });
  taskPay = orch.saveTask(pay, { title: "환불 기능", branch: "feat/refund", worktree: "/repo/.claude/worktrees/refund" }).task;
  await settle();
  taskSearch = orch.saveTask(search, { title: "검색 속도", branch: "feat/search-speed", worktree: "/repo/.claude/worktrees/search" }).task;
  await orch.recordPost(pay, { kind: "진행", title: "환불 설계 시작", taskId: taskPay.id });
  await orch.recordPost(search, { kind: "진행", title: "검색 색인 점검", taskId: taskSearch.id });
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await orch.shutdown();
  await server.stop();
  console.log(`shots: ${SHOTS}`);
});

async function openThread(page: Page) {
  await page.goto(`${base}/api/health`);
  await page.evaluate((code) => localStorage.setItem("iamceo.accessCode", code), CODE);
  await page.goto(`${base}/#/p/${encodeURIComponent(project.id)}/thread`);
  try { await page.locator(".cmp-tasks").waitFor({ timeout: 20_000 }); }
  catch (e) { await page.screenshot({ path: join(SHOTS, "fail.png"), fullPage: true }); console.log(await page.locator("body").innerText()); throw e; }
}
const chips = (page: Page) => page.locator(".cmp-task");
const chip = (page: Page, name: string) => page.locator(".cmp-task", { hasText: name });
const rows = (page: Page) => page.locator(".th-list .th-row");
const listText = (page: Page) => page.locator(".th-list").innerText();

describe("웹 작업별 대화", () => {
  test("전체·작업 고르기, 보낸 뒤 작업을 옮겨도 늦은 보고는 원래 작업, 새로고침 유지, 직원 선택과 함께 동작", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await openThread(page);
    // '전체'가 기본이고, 작업은 최신 등록부터
    await expect(chips(page).allInnerTexts()).resolves.toEqual(["전체", "검색 속도", "환불 기능"]);
    await expect(chip(page, "전체").getAttribute("aria-pressed")).resolves.toBe("true");
    // 전체: 옛 글과 두 작업 글이 모두 보이고, 작업 글에는 작업 표지가 붙는다
    let text = await listText(page);
    for (const s of ["작업 전의 옛 지시", "옛 답변", "환불 설계 시작", "검색 색인 점검"]) expect(text).toContain(s);
    await expect(page.locator(".th-card__task", { hasText: "환불 기능" }).count()).resolves.toBe(1);
    await page.screenshot({ path: join(SHOTS, "1-all.png") });

    // 환불 작업 고르기: 그 작업 글만, 받는 사람은 등록한 직원
    await chip(page, "환불 기능").click();
    await page.locator(".th-task").waitFor();
    await expect(page.locator(".th-task").innerText()).resolves.toContain("feat/refund");
    await expect(page.locator(".cmp-chip--target").innerText()).resolves.toBe("@결제 연동");
    await page.waitForFunction(() => document.querySelector(".th-list")?.textContent?.includes("환불 설계 시작") && !document.querySelector(".th-list")?.textContent?.includes("검색 색인"));
    text = await listText(page);
    expect(text).not.toContain("작업 전의 옛 지시");
    expect(text).not.toContain("검색 색인 점검");
    await page.screenshot({ path: join(SHOTS, "2-refund.png") });

    // 이 작업에서 보낸다
    await page.getByLabel("입력칸").fill("부분 환불도 넣어 주세요");
    await page.getByLabel("입력칸").press("Enter");
    await page.waitForFunction(() => document.querySelector(".th-list")?.textContent?.includes("부분 환불도 넣어 주세요"));
    const sent = await stored("부분 환불도 넣어 주세요");
    expect(sent).toMatchObject({ taskId: taskPay.id, targetMemberId: pay.id });
    await settle();
    expect(runner.sent.find((s) => s.text.includes("부분 환불도 넣어 주세요"))!.text).toContain(`작업 #${taskPay.id} '환불 기능' · 브랜치 'feat/refund'`);
    // 보낸 뒤에도 이 작업이 골라져 있다
    await expect(chip(page, "환불 기능").getAttribute("aria-pressed")).resolves.toBe("true");

    // 곧바로 검색 작업으로 옮긴다. 그 사이 결제 직원의 늦은 보고(받은 글의 작업 줄대로 환불 작업을 밝힘)가 온다
    await chip(page, "검색 속도").click();
    await expect(page.locator(".cmp-chip--target").innerText()).resolves.toBe("@검색 개선");
    await orch.recordPost(store.requireMember(pay.id), { kind: "완료", title: "부분 환불 넣음", taskId: taskPay.id });
    // 작업을 밝히지 않은 늦은 보고는 받지 않는다(어느 작업에도, 화면에서 보고 있는 검색 작업에도 붙지 않는다)
    await expect(orch.recordPost(store.requireMember(pay.id), { kind: "알림", title: "작업 없는 늦은 글" })).rejects.toThrow("task_id");
    expect(store.listMessages(project.id).find((m) => m.title.endsWith("부분 환불 넣음"))!.taskId).toBe(taskPay.id);
    await settle();
    await page.waitForTimeout(300);
    text = await listText(page);
    expect(text).toContain("검색 색인 점검");
    expect(text).not.toContain("부분 환불");
    await page.screenshot({ path: join(SHOTS, "3-search-after-switch.png") });

    // 새로고침해도 고른 작업(검색)이 남고, 그 작업 대화만 보인다
    await page.reload();
    await page.locator(".th-task").waitFor({ timeout: 20_000 });
    await expect(chip(page, "검색 속도").getAttribute("aria-pressed")).resolves.toBe("true");
    await page.waitForFunction(() => document.querySelector(".th-list")?.textContent?.includes("검색 색인 점검"));
    expect(await listText(page)).not.toContain("환불");

    // 환불로 돌아가면 늦은 보고가 거기에 있다
    await chip(page, "환불 기능").click();
    await page.waitForFunction(() => document.querySelector(".th-list")?.textContent?.includes("부분 환불 넣음"));

    // 작업을 골라 둔 동안에도 다른 작업으로 바로 옮길 수 있게 모든 작업이 보인다
    await expect(chips(page).allInnerTexts()).resolves.toEqual(["전체", "검색 속도", "환불 기능"]);
    // 직원 선택과 함께: 대상을 검색 직원으로 바꾸면 환불 작업 선택이 풀리고 검색 직원의 작업만 남는다
    await page.locator(".cmp-chip--target").click();
    await page.locator(".cmp-menu__item", { hasText: "검색 개선" }).click();
    await expect(chips(page).allInnerTexts()).resolves.toEqual(["전체", "검색 속도"]);
    await expect(chip(page, "전체").getAttribute("aria-pressed")).resolves.toBe("true");
    // 총괄로 돌리면 모든 작업이 다시 보인다
    await page.locator(".cmp-chip--target").click();
    await page.locator(".cmp-menu__item").first().click();
    await expect(chips(page).allInnerTexts()).resolves.toEqual(["전체", "검색 속도", "환불 기능"]);
    // 작업을 고른 뒤 '전체'를 누르면 작업도 받는 사람도 기본으로 돌아온다
    await chip(page, "검색 속도").click();
    await expect(page.locator(".cmp-chip--target").innerText()).resolves.toBe("@검색 개선");
    await chip(page, "전체").click();
    await expect(page.locator(".cmp-chip--target").innerText()).resolves.toBe("총괄");
    await expect(page.locator(".th-task").count()).resolves.toBe(0);
    await page.waitForFunction(() => document.querySelector(".th-list")?.textContent?.includes("작업 전의 옛 지시"));
    text = await listText(page);
    for (const s of ["작업 전의 옛 지시", "부분 환불 넣음", "검색 색인 점검"]) expect(text).toContain(s);

    // 전체에서 보낸 글은 작업이 없다(직전 작업에 붙지 않는다)
    await page.getByLabel("입력칸").fill("@pay 오늘 일정 알려 주세요");
    await page.getByLabel("입력칸").press("Enter");
    await page.waitForFunction(() => document.querySelector(".th-list")?.textContent?.includes("오늘 일정 알려 주세요"));
    expect(await stored("오늘 일정 알려 주세요")).toMatchObject({ taskId: null, targetMemberId: pay.id });
    await page.close();
  }, 120_000);

  test("폰 폭: 작업이 많으면 가로로 밀어 고르고, 입력칸도 쓸 수 있다", async () => {
    for (let i = 1; i <= 7; i++) {
      extra.push(orch.saveTask(i % 2 ? pay : search, { title: `추가 작업 ${i}번 제목이 조금 길다`, branch: `feat/extra-${i}` }).task);
      await settle();
    }
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    await openThread(page);
    const strip = page.locator(".cmp-tasks");
    const box = await strip.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth, overflowX: getComputedStyle(el).overflowX }));
    expect(box.scroll).toBeGreaterThan(box.client);
    expect(box.overflowX).toBe("auto");
    // 페이지 자체는 가로로 넘치지 않는다
    await expect(page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).resolves.toBe(true);
    await expect(chips(page).first().innerText()).resolves.toBe("전체");
    await expect(chips(page).nth(1).innerText()).resolves.toBe("추가 작업 7번 제목이 조금 길다");
    await page.screenshot({ path: join(SHOTS, "4-phone-start.png") });
    // 맨 끝(가장 오래된 환불 기능)까지 밀어서 고른다
    await strip.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
    await chip(page, "환불 기능").click();
    await page.locator(".th-task").waitFor();
    await page.waitForFunction(() => document.querySelector(".th-list")?.textContent?.includes("부분 환불 넣음"));
    await expect(page.getByLabel("입력칸").isVisible()).resolves.toBe(true);
    await expect(page.locator(".cmp-chip--target").isVisible()).resolves.toBe(true);
    await page.getByLabel("입력칸").fill("폰에서 보냄");
    await page.getByRole("button", { name: "보내기" }).click();
    await page.waitForFunction(() => document.querySelector(".th-list")?.textContent?.includes("폰에서 보냄"));
    expect((await stored("폰에서 보냄")).taskId).toBe(taskPay.id);
    await page.screenshot({ path: join(SHOTS, "5-phone-refund.png") });
    await page.close();
  }, 90_000);
});
