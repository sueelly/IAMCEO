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
// 칩 글: 작업 제목만(맡은 사람 표시는 따로 본다). '전체'는 제목 칸이 없다.
const chipTitles = (page: Page) => page.locator(".cmp-task").evaluateAll((els) => els.map((e) => (e.querySelector(".cmp-task__title") ?? e).textContent));
const chipWho = (page: Page) => page.locator(".cmp-task__who").allInnerTexts();
const rows = (page: Page) => page.locator(".th-list .th-row");
const listText = (page: Page) => page.locator(".th-list").innerText();

describe("웹 작업별 대화", () => {
  test("전체·작업 고르기, 보낸 뒤 작업을 옮겨도 늦은 보고는 원래 작업, 새로고침 유지, 직원 선택과 함께 동작", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await openThread(page);
    // '전체'가 기본이고, 작업은 최신 등록부터
    await expect(chipTitles(page)).resolves.toEqual(["전체", "검색 속도", "환불 기능"]);
    // 총괄에게 보낼 때는 칩마다 맡은 직원이 보인다
    await expect(chipWho(page)).resolves.toEqual(["검색 개선", "결제 연동"]);
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
    await expect(chipTitles(page)).resolves.toEqual(["전체", "검색 속도", "환불 기능"]);
    // 직원 선택과 함께: 대상을 검색 직원으로 바꾸면 환불 작업 선택이 풀리고 검색 직원의 작업만 남는다
    await page.locator(".cmp-chip--target").click();
    await page.locator(".cmp-menu__item", { hasText: "검색 개선" }).click();
    await expect(chipTitles(page)).resolves.toEqual(["전체", "검색 속도"]);
    // 한 직원의 작업만 보일 때는 맡은 사람을 되풀이하지 않는다
    await expect(chipWho(page)).resolves.toEqual([]);
    await expect(chip(page, "전체").getAttribute("aria-pressed")).resolves.toBe("true");
    // 총괄로 돌리면 모든 작업이 다시 보인다
    await page.locator(".cmp-chip--target").click();
    await page.locator(".cmp-menu__item").first().click();
    await expect(chipTitles(page)).resolves.toEqual(["전체", "검색 속도", "환불 기능"]);
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
    await expect(chips(page).nth(1).locator(".cmp-task__title").innerText()).resolves.toBe("추가 작업 7번 제목이 조금 길다");
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

  test("대화 글의 작업 표지를 누르면 그 작업 글만 보이고, 입력칸의 작업·받는 사람도 같이 바뀐다", async () => {
    const report = (m: Member, title: string, taskId: string | null) =>
      store.createMessage({ projectId: project.id, memberId: m.id, who: m.name, kind: "진행", title, body: "", taskId });
    // 전체 첫 화면(최근 200개)에 들지 않는 옛 작업 글
    report(pay, "환불 아주 옛 보고", taskPay.id);
    for (let i = 1; i <= 180; i++) store.createMessage({ projectId: project.id, mine: true, who: "나", kind: "나", body: `전체 글 ${i}` });
    report(search, "검색 중간 보고", taskSearch.id);
    for (let i = 181; i <= 200; i++) store.createMessage({ projectId: project.id, mine: true, who: "나", kind: "나", body: `전체 글 ${i}` });
    report(pay, "환불 기준 보고", taskPay.id);
    for (let i = 1; i <= 40; i++) report(pay, `환불 진행 ${i}`, taskPay.id);
    report(pay, "마지막 환불 보고", taskPay.id);
    // 진행판에서 끝낸 일의 작업: 칩에는 없지만 글의 표지로 지난 대화를 볼 수 있다
    const work = store.upsertWork({ projectId: project.id, sec: "doing", title: "끝난 일", who: "작업 실행 체계" });
    const doneTask = Store.workTaskId(work.id);
    store.createMessage({ projectId: project.id, who: "작업 실행 체계", kind: "완료", title: "끝난 일 보고", body: "", taskId: doneTask });
    store.upsertWork({ projectId: project.id, id: work.id, sec: "done", title: "끝난 일" });
    const empty = orch.saveTask(search, { title: "빈 작업", branch: "feat/empty" }).task;
    await settle();

    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await openThread(page);
    const label = (row: string) => page.locator(".th-row", { hasText: row }).locator(".th-card__task");
    /** 누른 글이 대화 칸 안에 보이는지(스크롤 밖이 아닌지) */
    const inView = (text: string) => page.evaluate((t) => {
      const root = document.querySelector<HTMLElement>("[data-scroll-root]")!;
      const row = [...document.querySelectorAll<HTMLElement>(".th-list .th-row")].find((r) => r.textContent?.includes(t));
      if (!row) return false;
      const a = root.getBoundingClientRect(), b = row.getBoundingClientRect();
      return b.top >= a.top - 1 && b.bottom <= a.bottom + 1;
    }, text);
    await expect(chip(page, "전체").getAttribute("aria-pressed")).resolves.toBe("true");
    await page.waitForFunction(() => document.querySelector(".th-list")?.textContent?.includes("끝난 일 보고"));
    let text = await listText(page);
    expect(text).not.toContain("환불 아주 옛 보고");
    // 작업이 없는 글(옛 글)에는 표지를 달지 않는다
    await expect(page.locator(".th-row", { hasText: "전체 글 200" }).locator(".th-card__task, .th-mine__task").count()).resolves.toBe(0);
    await expect(chip(page, "끝난 일").count()).resolves.toBe(0);
    await page.screenshot({ path: join(SHOTS, "6-all-before-click.png") });

    // 1) 중간의 검색 보고 표지를 누른다 → 검색 작업 글만, 받는 사람은 검색 직원, 첫 화면 밖의 옛 검색 글도 서버에서 받아 온다
    await label("검색 중간 보고").scrollIntoViewIfNeeded();
    await label("검색 중간 보고").click();
    await page.locator(".th-task", { hasText: "검색 속도" }).waitFor();
    await expect(chip(page, "검색 속도").getAttribute("aria-pressed")).resolves.toBe("true");
    await expect(page.locator(".cmp-chip--target").innerText()).resolves.toBe("@검색 개선");
    await page.waitForFunction(() => document.querySelector(".th-list")?.textContent?.includes("검색 색인 점검"));
    text = await listText(page);
    expect(text).toContain("검색 중간 보고");
    for (const s of ["전체 글", "환불", "작업 전의 옛 지시"]) expect(text).not.toContain(s);
    await expect(inView("검색 중간 보고")).resolves.toBe(true);
    await page.screenshot({ path: join(SHOTS, "7-search-from-label.png") });

    // 새로고침해도 표지로 고른 작업이 남는다
    await page.reload();
    await page.locator(".th-task", { hasText: "검색 속도" }).waitFor({ timeout: 20_000 });
    await expect(chip(page, "검색 속도").getAttribute("aria-pressed")).resolves.toBe("true");

    // 2) '전체'로 돌아온다(입력칸 위 칩, 기존 길)
    await chip(page, "전체").click();
    await expect(page.locator(".th-task").count()).resolves.toBe(0);
    await expect(page.locator(".cmp-chip--target").innerText()).resolves.toBe("총괄");
    await page.waitForFunction(() => document.querySelector(".th-list")?.textContent?.includes("전체 글 200"));

    // 3) 환불 기준 보고(뒤에 같은 작업 글 40개)의 표지를 누르면 맨 아래가 아니라 그 글을 보인다
    await label("환불 기준 보고").scrollIntoViewIfNeeded();
    await label("환불 기준 보고").click();
    await page.locator(".th-task", { hasText: "환불 기능" }).waitFor();
    await page.waitForFunction(() => document.querySelector(".th-list")?.textContent?.includes("환불 아주 옛 보고"));
    await page.waitForTimeout(300);
    await expect(inView("환불 기준 보고")).resolves.toBe(true);
    await expect(inView("환불 진행 40")).resolves.toBe(false);
    await expect(page.locator(".cmp-chip--target").innerText()).resolves.toBe("@결제 연동");
    // 작업이 많아 칩 목록이 밀려 있어도 고른 칩이 보인다
    await expect(page.evaluate(() => {
      const strip = document.querySelector(".cmp-tasks")!.getBoundingClientRect();
      const on = document.querySelector('.cmp-task[aria-pressed="true"]')!.getBoundingClientRect();
      return on.left >= strip.left - 1 && on.right <= strip.right + 1;
    })).resolves.toBe(true);
    text = await listText(page);
    expect(text).not.toContain("전체 글");
    expect(text).not.toContain("검색");
    await page.screenshot({ path: join(SHOTS, "8-refund-from-label.png") });

    // 4) 같은 작업으로 보낸다 → 이 작업·결제 직원에게 남는다
    await page.getByLabel("입력칸").fill("기준 보고를 보고 보냄");
    await page.getByLabel("입력칸").press("Enter");
    await page.waitForFunction(() => document.querySelector(".th-list")?.textContent?.includes("기준 보고를 보고 보냄"));
    expect(await stored("기준 보고를 보고 보냄")).toMatchObject({ taskId: taskPay.id, targetMemberId: pay.id });

    // 5) 전체에서 내가 보낸 글의 작업 표지도 누를 수 있다
    await chip(page, "전체").click();
    const mine = page.locator(".th-row--mine", { hasText: "기준 보고를 보고 보냄" }).locator(".th-mine__task");
    await expect(mine.innerText()).resolves.toBe("작업 환불 기능");
    await mine.click();
    await page.locator(".th-task", { hasText: "환불 기능" }).waitFor();
    await expect(chip(page, "환불 기능").getAttribute("aria-pressed")).resolves.toBe("true");
    await chip(page, "전체").click();

    // 6) 끝낸 일의 작업: 칩에 없어도 표지로 지난 대화를 보고, '전체'로 돌아오면 칩도 다시 숨는다
    await label("끝난 일 보고").click();
    await page.locator(".th-task", { hasText: "끝난 일" }).waitFor();
    await expect(chip(page, "끝난 일").getAttribute("aria-pressed")).resolves.toBe("true");
    await expect(page.locator(".cmp-chip--target").innerText()).resolves.toBe("총괄");
    await page.waitForFunction(() => document.querySelector(".th-list")?.textContent?.includes("끝난 일 보고"));
    expect(await listText(page)).not.toContain("전체 글");
    await page.screenshot({ path: join(SHOTS, "9-done-task-from-label.png") });
    await chip(page, "전체").click();
    await expect(chip(page, "끝난 일").count()).resolves.toBe(0);

    // 7) 빈 작업은 칩으로 고르면 빈 안내가 보인다(글이 없어 대화에 표지가 없다)
    await chip(page, "빈 작업").click();
    await page.getByText("이 작업의 대화가 아직 없습니다").waitFor();
    expect(empty.id).toBeTruthy();
    await chip(page, "전체").click();
    await page.close();

    // 8) 저장된 선택이 없는 작업(다른 서버의 작업 등)을 가리키면 '전체'로 보이고, 보낸 글도 작업 없이 남는다
    const stale = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await stale.goto(`${base}/api/health`);
    await stale.evaluate(({ code, key }) => {
      localStorage.setItem("iamceo.accessCode", code);
      localStorage.setItem(key, JSON.stringify({ version: 2, draft: { text: "남은 초안", targetId: null, uploads: [], error: null, taskId: "tk_ghost_none" }, revision: "r-stale" }));
    }, { code: CODE, key: `iamceo.draft.host.${encodeURIComponent(base.replace(/\/$/, ""))}.${encodeURIComponent(project.id)}` });
    await stale.goto(`${base}/#/p/${encodeURIComponent(project.id)}/thread`);
    await stale.locator(".cmp-tasks").waitFor({ timeout: 20_000 });
    await expect(chip(stale, "전체").getAttribute("aria-pressed")).resolves.toBe("true");
    await expect(stale.locator(".th-task").count()).resolves.toBe(0);
    // 저장된 초안을 실제로 읽었는지(열쇠가 맞는지) 본다
    await expect(stale.getByLabel("입력칸").inputValue()).resolves.toBe("남은 초안");
    await stale.getByLabel("입력칸").fill("없는 작업에서 보냄");
    await stale.getByLabel("입력칸").press("Enter");
    expect((await stored("없는 작업에서 보냄")).taskId).toBeNull();
    await stale.close();

    // 9) 폰 폭: 표지를 손가락으로 눌러 옮기고, 페이지가 가로로 넘치지 않는다
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    await openThread(phone);
    const pl = phone.locator(".th-row", { hasText: "환불 진행 40" }).locator(".th-card__task");
    await pl.scrollIntoViewIfNeeded();
    await phone.screenshot({ path: join(SHOTS, "10-phone-before-tap.png") });
    await pl.tap();
    await phone.locator(".th-task", { hasText: "환불 기능" }).waitFor();
    await expect(phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).resolves.toBe(true);
    await phone.screenshot({ path: join(SHOTS, "11-phone-after-tap.png") });
    await phone.close();
  }, 120_000);

  // 대표: "총괄에서는 잘 뜨는데 각 직원별로는 몇 개만 뜨네? 통일시켜" — 진행판에서 총괄이 만든 작업도 담당 직원 칩에서 보인다.
  test("진행판 작업: 담당 직원을 고르면 그 작업도 보이고, 고르면 그 직원에게 그 작업으로 보낸다", async () => {
    const item = store.upsertWork({ projectId: project.id, sec: "doing", title: "환불 정산 확인", who: "총괄·결제 연동" });
    await settle();
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await openThread(page);
    await chip(page, "전체").click();
    await page.locator(".cmp-chip--target").click();
    await page.locator(".cmp-menu__item").first().click();
    // 총괄 쪽: 진행판 작업에도 맡은 직원 이름이 붙는다
    await expect(chip(page, "환불 정산 확인").locator(".cmp-task__who").innerText()).resolves.toBe("결제 연동");
    // 결제 연동을 고르면 그 직원이 등록한 작업과 진행판 담당 작업이 함께 보인다
    await page.locator(".cmp-chip--target").click();
    await page.locator(".cmp-menu__item", { hasText: "결제 연동" }).click();
    const titles = await chipTitles(page);
    expect(titles).toContain("환불 정산 확인");
    expect(titles).toContain("환불 기능");
    expect(titles).not.toContain("검색 속도");
    await page.screenshot({ path: join(SHOTS, "6-worker-chips.png") });
    // 그 작업을 고르면 받는 사람은 그대로 결제 연동
    await chip(page, "환불 정산 확인").click();
    await expect(page.locator(".cmp-chip--target").innerText()).resolves.toBe("@결제 연동");
    await page.getByLabel("입력칸").fill("정산 숫자 확인해 주세요");
    await page.getByLabel("입력칸").press("Enter");
    await page.waitForFunction(() => document.querySelector(".th-list")?.textContent?.includes("정산 숫자 확인해 주세요"));
    expect(await stored("정산 숫자 확인해 주세요")).toMatchObject({ taskId: `tk_${item.id}`, targetMemberId: pay.id });
    // 총괄로 바꿔도 진행판 작업은 남는다(총괄도 그 작업의 담당)
    await page.locator(".cmp-chip--target").click();
    await page.locator(".cmp-menu__item").first().click();
    await expect(chip(page, "환불 정산 확인").getAttribute("aria-pressed")).resolves.toBe("true");
    // 담당이 아닌 직원을 고르면 작업 선택이 풀린다
    await page.locator(".cmp-chip--target").click();
    await page.locator(".cmp-menu__item", { hasText: "검색 개선" }).click();
    await expect(chip(page, "전체").getAttribute("aria-pressed")).resolves.toBe("true");
    await page.close();
  }, 90_000);
});
