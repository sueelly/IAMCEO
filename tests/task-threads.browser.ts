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
// 칩 글: 업무 제목만. '전체'는 제목 칸이 없다.
const chipTitles = (page: Page) => page.locator(".cmp-task").evaluateAll((els) => els.map((e) => (e.querySelector(".cmp-task__title") ?? e).textContent));
/** 대표 2026-11-13·14: 업무 칩에 맡은 직원 이름을 띄우지 않는다. 칩 글은 제목과 같아야 한다. */
const chipNoWorker = async (page: Page) => {
  await expect(page.locator(".cmp-task__who").count()).resolves.toBe(0);
  const texts = await page.locator(".cmp-task").evaluateAll((els) => els.map((e) => [e.textContent?.trim(), (e.querySelector(".cmp-task__title") ?? e).textContent?.trim()]));
  for (const [all, title] of texts) expect(all).toBe(title);
};
const rows = (page: Page) => page.locator(".th-list .th-row");
/** 업무 고르기: 한 줄에 보이는 칩이면 누르고, 가려졌으면 '+N'으로 전체 목록을 열어 고른다(대표 2026-11-14). */
async function selectTask(page: Page, name: string, how: "click" | "tap" = "click") {
  const c = chip(page, name);
  if ((await c.getAttribute("aria-hidden")) !== "true") return how === "tap" ? c.tap() : c.click();
  const more = page.locator(".cmp-task--more");
  await (how === "tap" ? more.tap() : more.click());
  const item = page.locator(".cmp-menu--tasks .cmp-menu__item", { hasText: name });
  await (how === "tap" ? item.tap() : item.click());
}
/** 한 줄에 보이는 칩(가려지지 않은 것)이 줄 안에 다 들어가 있고, 이름이 잘리지 않았는지 */
const lineState = (page: Page) => page.evaluate(() => {
  const row = document.querySelector<HTMLElement>(".cmp-tasks")!;
  const box = row.getBoundingClientRect();
  const shown = [...row.querySelectorAll<HTMLElement>(".cmp-task")].filter((c) => c.getAttribute("aria-hidden") !== "true");
  return {
    overflowX: getComputedStyle(row).overflowX,
    scrolls: row.scrollWidth > row.clientWidth + 1,
    inside: shown.every((c) => { const r = c.getBoundingClientRect(); return r.left >= box.left - 1 && r.right <= box.right + 1 && r.top >= box.top - 1 && r.bottom <= box.bottom + 1; }),
    cut: shown.filter((c) => c.scrollWidth > c.clientWidth + 1).map((c) => c.textContent),
    shown: shown.length,
    hidden: row.querySelectorAll('.cmp-task[aria-hidden="true"]').length,
  };
});
const listText = (page: Page) => page.locator(".th-list").innerText();

describe("웹 작업별 대화", () => {
  // 대표 2026-11-13: "업무 선택할 때, 직원까지 함께 선택될 필요는 없는 것 같아" — 업무와 받는 사람은 따로 고른다.
  test("업무와 받는 사람은 따로: 업무A·직원1 → 업무B(직원 유지) → 직원2(업무 유지) → 같은 업무로 보냄, 늦은 보고는 원래 업무, 새로고침 유지", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await openThread(page);
    const target = () => page.locator(".cmp-chip--target").innerText();
    const pickTarget = async (name: string | null) => {
      await page.locator(".cmp-chip--target").click();
      if (name) await page.locator(".cmp-menu__item", { hasText: name }).click();
      else await page.locator(".cmp-menu__item").first().click();
    };
    // '전체'가 기본이고, 업무는 최근 글 순. 칩에는 업무 제목만 있고 직원 이름은 없다
    await expect(chipTitles(page)).resolves.toEqual(["전체", "검색 속도", "환불 기능"]);
    await chipNoWorker(page);
    await expect(page.locator(".th-task").count()).resolves.toBe(0);
    await expect(chip(page, "전체").getAttribute("aria-pressed")).resolves.toBe("true");
    let text = await listText(page);
    for (const s of ["작업 전의 옛 지시", "옛 답변", "환불 설계 시작", "검색 색인 점검"]) expect(text).toContain(s);
    await expect(page.locator(".th-card__task", { hasText: "환불 기능" }).count()).resolves.toBe(1);
    await page.screenshot({ path: join(SHOTS, "1-all.png") });

    // 1) 업무A(환불)를 고르면 그 업무 글만 보이고, 받는 사람은 그대로(총괄)
    await selectTask(page, "환불 기능");
    await page.locator(".th-task").waitFor();
    await expect(page.locator(".th-task").innerText()).resolves.toContain("feat/refund");
    await expect(target()).resolves.toBe("총괄");
    await page.waitForFunction(() => document.querySelector(".th-list")?.textContent?.includes("환불 설계 시작") && !document.querySelector(".th-list")?.textContent?.includes("검색 색인"));
    // 직원1(결제 연동)을 고르면 업무는 그대로 남는다
    await pickTarget("결제 연동");
    await expect(target()).resolves.toBe("@결제 연동");
    await expect(chip(page, "환불 기능").getAttribute("aria-pressed")).resolves.toBe("true");
    // 직원을 골라도 업무 칩 목록은 줄지 않는다
    await expect(chipTitles(page)).resolves.toEqual(["전체", "검색 속도", "환불 기능"]);
    await page.screenshot({ path: join(SHOTS, "2-refund-pay.png") });
    await page.getByLabel("입력칸").fill("부분 환불도 넣어 주세요");
    await page.getByLabel("입력칸").press("Enter");
    await page.waitForFunction(() => document.querySelector(".th-list")?.textContent?.includes("부분 환불도 넣어 주세요"));
    expect(await stored("부분 환불도 넣어 주세요")).toMatchObject({ taskId: taskPay.id, targetMemberId: pay.id });
    await settle();
    expect(runner.sent.find((s) => s.text.includes("부분 환불도 넣어 주세요"))!.text).toContain(`작업 #${taskPay.id} '환불 기능' · 브랜치 'feat/refund'`);
    await expect(chip(page, "환불 기능").getAttribute("aria-pressed")).resolves.toBe("true");

    // 2) 업무B(검색)로 옮겨도 받는 사람(결제 연동)은 그대로. 그 사이 결제 직원의 늦은 보고는 원래 업무(환불)에 붙는다
    await selectTask(page, "검색 속도");
    await expect(target()).resolves.toBe("@결제 연동");
    await orch.recordPost(store.requireMember(pay.id), { kind: "완료", title: "부분 환불 넣음", taskId: taskPay.id });
    // 업무를 밝히지 않은 늦은 보고는 받지 않는다(화면에서 보고 있는 검색 업무에도 붙지 않는다)
    await expect(orch.recordPost(store.requireMember(pay.id), { kind: "알림", title: "작업 없는 늦은 글" })).rejects.toThrow("task_id");
    expect(store.listMessages(project.id).find((m) => m.title.endsWith("부분 환불 넣음"))!.taskId).toBe(taskPay.id);
    await settle();
    await page.waitForTimeout(300);
    text = await listText(page);
    expect(text).toContain("검색 색인 점검");
    expect(text).not.toContain("부분 환불");
    await page.screenshot({ path: join(SHOTS, "3-search-keeps-pay.png") });

    // 새로고침해도 고른 업무(검색)와 받는 사람(결제 연동)이 그대로 남는다
    await page.reload();
    await page.locator(".th-task").waitFor({ timeout: 20_000 });
    await expect(chip(page, "검색 속도").getAttribute("aria-pressed")).resolves.toBe("true");
    await expect(target()).resolves.toBe("@결제 연동");
    await page.waitForFunction(() => document.querySelector(".th-list")?.textContent?.includes("검색 색인 점검"));
    expect(await listText(page)).not.toContain("환불");

    // 3) 직원2(검색 개선)로 바꿔도 업무(검색)는 풀리지 않는다
    await pickTarget("검색 개선");
    await expect(target()).resolves.toBe("@검색 개선");
    await expect(chip(page, "검색 속도").getAttribute("aria-pressed")).resolves.toBe("true");
    await expect(page.locator(".th-task", { hasText: "검색 속도" }).count()).resolves.toBe(1);

    // 4) 같은 업무(환불)를 다른 직원(검색 개선)에게도 보낸다 → 같은 업무 id 로 남는다
    await selectTask(page, "환불 기능");
    await expect(target()).resolves.toBe("@검색 개선");
    await page.waitForFunction(() => document.querySelector(".th-list")?.textContent?.includes("부분 환불 넣음"));
    await page.getByLabel("입력칸").fill("환불 화면의 검색도 봐 주세요");
    await page.getByLabel("입력칸").press("Enter");
    await page.waitForFunction(() => document.querySelector(".th-list")?.textContent?.includes("환불 화면의 검색도 봐 주세요"));
    expect(await stored("환불 화면의 검색도 봐 주세요")).toMatchObject({ taskId: taskPay.id, targetMemberId: search.id });
    await settle();
    expect(runner.sent.find((s) => s.text.includes("환불 화면의 검색도 봐 주세요"))!.text).toContain(`작업 #${taskPay.id} '환불 기능'`);
    await page.screenshot({ path: join(SHOTS, "4-refund-to-search.png") });

    // 5) '전체'로 돌아와도 받는 사람은 그대로, 업무만 풀린다. 전체 글이 다시 보인다
    await chip(page, "전체").click();
    await expect(target()).resolves.toBe("@검색 개선");
    await expect(page.locator(".th-task").count()).resolves.toBe(0);
    await page.waitForFunction(() => document.querySelector(".th-list")?.textContent?.includes("작업 전의 옛 지시"));
    text = await listText(page);
    for (const s of ["작업 전의 옛 지시", "부분 환불 넣음", "검색 색인 점검", "환불 화면의 검색도 봐 주세요"]) expect(text).toContain(s);
    // 총괄로 돌려도 업무 선택(없음)은 그대로
    await pickTarget(null);
    await expect(target()).resolves.toBe("총괄");
    await expect(chip(page, "전체").getAttribute("aria-pressed")).resolves.toBe("true");


    // 전체에서 보낸 글은 직전 작업에 붙지 않고, 서버가 첫 줄로 이름 붙인 새 업무에 붙는다
    await page.getByLabel("입력칸").fill("@pay 오늘 일정 알려 주세요");
    await page.getByLabel("입력칸").press("Enter");
    await page.waitForFunction(() => document.querySelector(".th-list")?.textContent?.includes("오늘 일정 알려 주세요"));
    const fromAll = await stored("오늘 일정 알려 주세요");
    expect(fromAll).toMatchObject({ targetMemberId: pay.id });
    expect([null, taskPay.id, taskSearch.id]).not.toContain(fromAll.taskId);
    expect(store.getTask(fromAll.taskId!)).toMatchObject({ origin: "auto" });
    await page.close();
  }, 120_000);

  test("폰 폭: 업무가 많으면 한 줄에 들어가는 만큼 이름 전체를 보이고, '+N'으로 전체 목록을 열어 고른다. 업무를 둔 채 받는 사람만 바꿔 보낸다", async () => {
    for (let i = 1; i <= 7; i++) {
      const who = i % 2 ? pay : search;
      const t = orch.saveTask(who, { title: `추가 작업 ${i}번 제목이 조금 길다`, branch: `feat/extra-${i}` }).task;
      extra.push(t);
      // 글이 없는 업무는 칩에서 빠지므로, 업무마다 보고 하나를 남긴다
      await orch.recordPost(who, { kind: "진행", title: `추가 작업 ${i}번 시작`, taskId: t.id });
      await settle();
    }
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    await openThread(page);
    // 옆으로 미는 줄이 아니다. 보이는 칩은 줄 안에 다 들어가고, 넘친 업무 수는 '+N'에 보인다
    const line = await lineState(page);
    expect(line.overflowX).toBe("hidden");
    expect(line.scrolls).toBe(false);
    expect(line.inside).toBe(true);
    expect(line.hidden).toBeGreaterThan(0);
    await expect(page.locator(".cmp-task--more").innerText()).resolves.toBe(`+${line.hidden}`);
    // 페이지 자체는 가로로 넘치지 않는다
    await expect(page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).resolves.toBe(true);
    await expect(chips(page).first().innerText()).resolves.toBe("전체");
    await expect(chips(page).nth(1).locator(".cmp-task__title").innerText()).resolves.toBe("추가 작업 7번 제목이 조금 길다");
    await page.screenshot({ path: join(SHOTS, "4-phone-start.png") });
    // '+N'을 누르면 전체 목록이 입력칸 위에 뜬다(최근 글 순, 맨 위는 '전체')
    await page.locator(".cmp-task--more").tap();
    const menu = page.locator(".cmp-menu--tasks");
    await menu.waitFor();
    const names = await menu.locator(".cmp-menu__name").allInnerTexts();
    expect(names[0]).toBe("전체");
    expect(names[1]).toBe("추가 작업 7번 제목이 조금 길다");
    expect(names).toContain("환불 기능");
    expect(names.length).toBe(line.shown + line.hidden);
    const mb = await menu.boundingBox();
    const ib = await page.getByLabel("입력칸").boundingBox();
    expect(mb!.y + mb!.height).toBeLessThanOrEqual(ib!.y);
    await page.screenshot({ path: join(SHOTS, "4b-phone-list.png") });
    await menu.locator(".cmp-menu__item", { hasText: "환불 기능" }).tap();
    await expect(menu.count()).resolves.toBe(0);
    // 고른 업무는 가려져 있었어도 줄 앞으로 와서 보인다
    await expect(chip(page, "환불 기능").getAttribute("aria-hidden")).resolves.toBeNull();
    await page.locator(".th-task").waitFor();
    await page.waitForFunction(() => document.querySelector(".th-list")?.textContent?.includes("부분 환불 넣음"));
    await expect(page.getByLabel("입력칸").isVisible()).resolves.toBe(true);
    await expect(page.locator(".cmp-chip--target").isVisible()).resolves.toBe(true);
    // 폰에서도 업무를 골라 둔 채 받는 사람만 바꾼다
    await expect(page.locator(".cmp-chip--target").innerText()).resolves.toBe("총괄");
    await page.locator(".cmp-chip--target").tap();
    await page.locator(".cmp-menu__item", { hasText: "결제 연동" }).tap();
    await expect(chip(page, "환불 기능").getAttribute("aria-pressed")).resolves.toBe("true");
    await page.getByLabel("입력칸").fill("폰에서 보냄");
    await page.getByRole("button", { name: "보내기" }).click();
    await page.waitForFunction(() => document.querySelector(".th-list")?.textContent?.includes("폰에서 보냄"));
    expect(await stored("폰에서 보냄")).toMatchObject({ taskId: taskPay.id, targetMemberId: pay.id });
    await page.screenshot({ path: join(SHOTS, "5-phone-refund.png") });
    await page.close();
  }, 90_000);

  test("대화 글의 업무 이름을 누르면 그 업무 글만 보이고 입력칸 업무도 바뀐다. 받는 사람은 그대로, 끝낸 업무도 이어서 보낸다", async () => {
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
    // 끝낸 일의 업무: 대화가 있으니 칩에도 남고, 글의 표지로도 지난 대화를 볼 수 있다
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
    await expect(chip(page, "끝난 일").count()).resolves.toBe(1);
    // 글이 하나도 없는 업무는 눌러도 빈 화면이라 칩에서 뺀다
    await expect(chip(page, "빈 작업").count()).resolves.toBe(0);
    await chipNoWorker(page);
    await page.screenshot({ path: join(SHOTS, "6-all-before-click.png") });

    // 1) 중간의 검색 보고 표지를 누른다 → 검색 업무 글만, 받는 사람은 그대로(총괄), 첫 화면 밖의 옛 검색 글도 서버에서 받아 온다
    await label("검색 중간 보고").scrollIntoViewIfNeeded();
    await label("검색 중간 보고").click();
    await page.locator(".th-task", { hasText: "검색 속도" }).waitFor();
    await expect(chip(page, "검색 속도").getAttribute("aria-pressed")).resolves.toBe("true");
    await expect(page.locator(".cmp-chip--target").innerText()).resolves.toBe("총괄");
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
    await expect(page.locator(".cmp-chip--target").innerText()).resolves.toBe("총괄");
    // 업무가 많아 줄에서 가려진 업무여도 고른 칩은 줄 안에 보인다
    await page.waitForFunction(() => {
      const strip = document.querySelector(".cmp-tasks")!.getBoundingClientRect();
      const on = document.querySelector('.cmp-task[aria-pressed="true"]')!.getBoundingClientRect();
      return on.left >= strip.left - 1 && on.right <= strip.right + 1 && on.top >= strip.top - 1 && on.bottom <= strip.bottom + 1;
    });
    text = await listText(page);
    expect(text).not.toContain("전체 글");
    expect(text).not.toContain("검색 색인");
    expect(text).not.toContain("검색 중간 보고");
    await page.screenshot({ path: join(SHOTS, "8-refund-from-label.png") });

    // 4) 받는 사람을 결제 직원으로 고르고 같은 업무로 보낸다 → 이 업무·결제 직원에게 남는다
    await page.locator(".cmp-chip--target").click();
    await page.locator(".cmp-menu__item", { hasText: "결제 연동" }).click();
    await expect(chip(page, "환불 기능").getAttribute("aria-pressed")).resolves.toBe("true");
    await page.getByLabel("입력칸").fill("기준 보고를 보고 보냄");
    await page.getByLabel("입력칸").press("Enter");
    await page.waitForFunction(() => document.querySelector(".th-list")?.textContent?.includes("기준 보고를 보고 보냄"));
    expect(await stored("기준 보고를 보고 보냄")).toMatchObject({ taskId: taskPay.id, targetMemberId: pay.id });

    // 5) 전체에서 내가 보낸 글의 작업 표지도 누를 수 있다
    await chip(page, "전체").click();
    const mine = page.locator(".th-row--mine", { hasText: "기준 보고를 보고 보냄" }).locator(".th-mine__task");
    await expect(mine.innerText()).resolves.toBe("업무 환불 기능");
    await mine.click();
    await page.locator(".th-task", { hasText: "환불 기능" }).waitFor();
    await expect(chip(page, "환불 기능").getAttribute("aria-pressed")).resolves.toBe("true");
    await chip(page, "전체").click();

    // 6) 끝낸 일의 업무: 표지로 지난 대화를 보고, 받는 사람(결제 연동)은 그대로 둔 채 이어서 보낸다. '전체'로 돌아와도 칩은 남는다
    await label("끝난 일 보고").click();
    await page.locator(".th-task", { hasText: "끝난 일" }).waitFor();
    await expect(chip(page, "끝난 일").getAttribute("aria-pressed")).resolves.toBe("true");
    await expect(page.locator(".cmp-chip--target").innerText()).resolves.toBe("@결제 연동");
    await page.waitForFunction(() => document.querySelector(".th-list")?.textContent?.includes("끝난 일 보고"));
    expect(await listText(page)).not.toContain("전체 글");
    await page.getByLabel("입력칸").fill("끝난 일 후속 확인 부탁");
    await page.getByLabel("입력칸").press("Enter");
    await page.waitForFunction(() => document.querySelector(".th-list")?.textContent?.includes("끝난 일 후속 확인 부탁"));
    expect(await stored("끝난 일 후속 확인 부탁")).toMatchObject({ taskId: doneTask, targetMemberId: pay.id });
    await page.screenshot({ path: join(SHOTS, "9-done-task-from-label.png") });
    await chip(page, "전체").click();
    await expect(chip(page, "끝난 일").count()).resolves.toBe(1);
    // 칩으로 눌러도 지난 대화가 보인다
    await selectTask(page, "끝난 일");
    await page.waitForFunction(() => document.querySelector(".th-list")?.textContent?.includes("끝난 일 보고"));
    await chip(page, "전체").click();

    // 7) 빈 업무는 칩에 없다. 저장된 선택이 빈 업무를 가리키면 그 칩만 남기고 빈 안내를 보인다
    await expect(chip(page, "빈 작업").count()).resolves.toBe(0);
    await page.close();
    const kept = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await kept.goto(`${base}/api/health`);
    await kept.evaluate(({ code, key, taskId }) => {
      localStorage.setItem("iamceo.accessCode", code);
      localStorage.setItem(key, JSON.stringify({ version: 2, draft: { text: "", targetId: null, uploads: [], error: null, taskId }, revision: "r-empty" }));
    }, { code: CODE, key: `iamceo.draft.host.${encodeURIComponent(base.replace(/\/$/, ""))}.${encodeURIComponent(project.id)}`, taskId: empty.id });
    await kept.goto(`${base}/#/p/${encodeURIComponent(project.id)}/thread`);
    await kept.locator(".cmp-tasks").waitFor({ timeout: 20_000 });
    await expect(chip(kept, "빈 작업").getAttribute("aria-pressed")).resolves.toBe("true");
    await kept.getByText("이 업무의 대화가 아직 없습니다").waitFor();
    await chip(kept, "전체").click();
    await expect(chip(kept, "빈 작업").count()).resolves.toBe(0);
    await kept.close();

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
    // 없는 작업은 고르지 않은 것과 같다: 첫 줄 이름의 새 업무에 붙는다
    const ghost = await stored("없는 작업에서 보냄");
    expect(ghost.taskId).not.toBeNull();
    expect(store.getTask(ghost.taskId!)).toMatchObject({ origin: "auto", title: "없는 작업에서 보냄" });
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

  // 업무에는 여러 직원이 붙는다. 칩에 직원 이름은 없고, 직원을 골라도 칩이 줄지 않으며, 맡지 않은 직원에게도 그 업무로 보낼 수 있다.
  test("일 목록 업무: 계획만 있는 일은 칩에 없고, 글이 생기면 나타난다. 여러 직원이 쓴 업무도 칩은 하나이며 직원 이름이 없다", async () => {
    const item = store.upsertWork({ projectId: project.id, sec: "doing", title: "환불 정산 확인", who: "총괄·결제 연동" });
    await settle();
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await openThread(page);
    // 진행판 계획만 있고 글이 없는 일은 눌러도 빈 화면이라 칩이 없다
    await expect(chip(page, "환불 정산 확인").count()).resolves.toBe(0);
    // 두 직원과 총괄이 같은 업무에 글을 쓴다 → 칩은 하나, 세 글이 모두 보인다
    const lead = store.listMembers(project.id).find((m) => m.kind === "conductor")!;
    await orch.recordPost(store.requireMember(lead.id), { kind: "진행", title: "정산 확인 맡김", taskId: `tk_${item.id}` });
    await orch.recordPost(pay, { kind: "진행", title: "정산 숫자 뽑는 중", taskId: `tk_${item.id}` });
    await orch.recordPost(search, { kind: "알림", title: "정산 검색 조건 확인", taskId: `tk_${item.id}` });
    await settle();
    await chip(page, "환불 정산 확인").waitFor();
    await expect(chip(page, "환불 정산 확인").count()).resolves.toBe(1);
    await expect(chip(page, "환불 정산 확인").innerText()).resolves.toBe("환불 정산 확인");
    await chipNoWorker(page);
    const all = await chipTitles(page);
    // 결제 연동을 골라도 칩 목록은 같다
    await page.locator(".cmp-chip--target").click();
    await page.locator(".cmp-menu__item", { hasText: "결제 연동" }).click();
    await expect(chipTitles(page)).resolves.toEqual(all);
    await page.screenshot({ path: join(SHOTS, "6-worker-chips.png") });
    await selectTask(page, "환불 정산 확인");
    await page.waitForFunction(() => ["정산 확인 맡김", "정산 숫자 뽑는 중", "정산 검색 조건 확인"].every((t) => document.querySelector(".th-list")?.textContent?.includes(t)));
    // 업무 머리에도 직원 이름이 없다
    const head = await page.locator(".th-task").innerText();
    for (const n of ["결제 연동", "검색 개선"]) expect(head).not.toContain(n);
    await chip(page, "전체").click();
    // 업무를 골라도 받는 사람은 결제 연동 그대로
    await selectTask(page, "환불 정산 확인");
    await expect(page.locator(".cmp-chip--target").innerText()).resolves.toBe("@결제 연동");
    await page.getByLabel("입력칸").fill("정산 숫자 확인해 주세요");
    await page.getByLabel("입력칸").press("Enter");
    await page.waitForFunction(() => document.querySelector(".th-list")?.textContent?.includes("정산 숫자 확인해 주세요"));
    expect(await stored("정산 숫자 확인해 주세요")).toMatchObject({ taskId: `tk_${item.id}`, targetMemberId: pay.id });
    // 맡지 않은 직원(검색 개선)으로 바꿔도 업무는 남고, 그 직원에게 같은 업무로 간다
    await page.locator(".cmp-chip--target").click();
    await page.locator(".cmp-menu__item", { hasText: "검색 개선" }).click();
    await expect(chip(page, "환불 정산 확인").getAttribute("aria-pressed")).resolves.toBe("true");
    await page.getByLabel("입력칸").fill("정산 화면 검색도 봐 주세요");
    await page.getByLabel("입력칸").press("Enter");
    await page.waitForFunction(() => document.querySelector(".th-list")?.textContent?.includes("정산 화면 검색도 봐 주세요"));
    expect(await stored("정산 화면 검색도 봐 주세요")).toMatchObject({ taskId: `tk_${item.id}`, targetMemberId: search.id });
    await page.close();
  }, 90_000);
  // 대표 2026-11-14: "직원 선택하는 것처럼 만들자 … 마우스 호버하고 1초 후에 전체 리스트가 위에 떠서 거기서 스크롤 … 최신 업데이트 순 … 직원 선택도 그렇게 … '/'을 누르면 작업 리스트"
  test("PC: 업무 줄에 1초 올려 두면 최근 순 전체 목록이 위에 뜨고, 받는 사람 칩도 같다. 입력칸의 '/'로 업무를 골라 보낸다", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await openThread(page);
    const line = await lineState(page);
    expect(line.scrolls).toBe(false);
    expect(line.inside).toBe(true);
    // 줄에 보이는 칩은 이름이 잘리지 않는다
    expect(line.cut).toEqual([]);
    expect(line.hidden).toBeGreaterThan(0);
    const menu = page.locator(".cmp-menu--tasks");
    // 1) 업무 줄에 마우스를 올려도 1초 전에는 뜨지 않는다
    const bar = await page.locator(".cmp-tasks").boundingBox();
    await page.mouse.move(bar!.x + bar!.width - 20, bar!.y + bar!.height / 2);
    await page.waitForTimeout(500);
    await expect(menu.count()).resolves.toBe(0);
    await menu.waitFor({ timeout: 1500 });
    const names = await menu.locator(".cmp-menu__name").allInnerTexts();
    const chipOrder = (await chipTitles(page)).map((t) => t?.trim());
    expect(names).toEqual(chipOrder.slice(0, 1).concat(names.slice(1)));
    expect(names.length).toBe(line.shown + line.hidden);
    // 순서는 서버가 아는 마지막 글 시각 순(최근 먼저)
    const latest = (title: string) => {
      const t = store.listTasks(project.id).find((x) => x.title === title)!;
      return store.listMessages(project.id).filter((m) => m.taskId === t.id).reduce((a, m) => (m.at > a ? m.at : a), "");
    };
    const times = names.slice(1).map(latest);
    expect([...times].sort().reverse()).toEqual(times);
    // 목록은 입력칸 위에 뜨고, 길면 그 안에서 스크롤한다
    const box = await menu.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight, oy: getComputedStyle(el).overflowY, bottom: el.getBoundingClientRect().bottom }));
    expect(box.oy).toBe("auto");
    const ib = await page.getByLabel("입력칸").boundingBox();
    expect(box.bottom).toBeLessThanOrEqual(ib!.y);
    await page.screenshot({ path: join(SHOTS, "12-hover-task-list.png") });
    // 마우스를 목록으로 옮겨도 닫히지 않고, 목록 안에서 스크롤해 맨 아래 업무를 고른다
    const mb = await menu.boundingBox();
    await page.mouse.move(mb!.x + mb!.width / 2, mb!.y + 20, { steps: 4 });
    await page.mouse.wheel(0, 2000);
    await page.waitForTimeout(400);
    await expect(menu.count()).resolves.toBe(1);
    const lastName = names[names.length - 1]!;
    await menu.locator(".cmp-menu__item", { hasText: lastName }).click();
    await expect(menu.count()).resolves.toBe(0);
    await expect(chip(page, lastName).getAttribute("aria-pressed")).resolves.toBe("true");
    await expect(chip(page, lastName).getAttribute("aria-hidden")).resolves.toBeNull();
    // 마우스를 치우면 hover 로 연 목록은 닫힌다
    await page.mouse.move(bar!.x + bar!.width - 20, bar!.y + bar!.height / 2);
    await menu.waitFor({ timeout: 2000 });
    await page.mouse.move(640, 200);
    await menu.waitFor({ state: "detached", timeout: 2000 });
    await chip(page, "전체").click();

    // 2) 받는 사람 칩도 1초 올려 두면 직원 목록이 뜬다
    const tb = await page.locator(".cmp-chip--target").boundingBox();
    await page.mouse.move(tb!.x + tb!.width / 2, tb!.y + tb!.height / 2);
    await page.waitForTimeout(500);
    await expect(page.locator(".cmp-menu").count()).resolves.toBe(0);
    await page.locator(".cmp-menu", { hasText: "결제 연동" }).waitFor({ timeout: 1500 });
    await page.screenshot({ path: join(SHOTS, "13-hover-target-list.png") });
    await page.locator(".cmp-menu__item", { hasText: "검색 개선" }).click();
    await expect(page.locator(".cmp-chip--target").innerText()).resolves.toBe("@검색 개선");
    await page.mouse.move(640, 200);

    // 3) 입력칸에서 '/'를 치면 업무 목록이 뜨고, 친 글로 거른다. Enter 로 고르면 '/글'은 지워지고 업무가 바뀐다
    const input = page.getByLabel("입력칸");
    await input.click();
    await input.pressSequentially("정산 건 /");
    await menu.waitFor();
    await expect(menu.locator(".cmp-menu__name").first().innerText()).resolves.toBe("전체");
    await input.pressSequentially("정산");
    await expect(menu.locator(".cmp-menu__name").allInnerTexts()).resolves.toEqual(["환불 정산 확인"]);
    await page.screenshot({ path: join(SHOTS, "14-slash-filter.png") });
    await input.press("Enter");
    await expect(menu.count()).resolves.toBe(0);
    await expect(input.inputValue()).resolves.toBe("정산 건 ");
    await expect(chip(page, "환불 정산 확인").getAttribute("aria-pressed")).resolves.toBe("true");
    await expect(page.locator(".cmp-chip--target").innerText()).resolves.toBe("@검색 개선");
    await input.pressSequentially("다시 봐 주세요");
    await input.press("Enter");
    const sent = await stored("정산 건 다시 봐 주세요");
    expect(sent.taskId).toBe(store.listTasks(project.id).find((t) => t.title === "환불 정산 확인")!.id);
    expect(sent.targetMemberId).toBe(search.id);
    // 글자 뒤의 '/'(주소·나눗셈)는 목록을 띄우지 않고, Esc 로 닫은 '/'는 그대로 글로 보낸다
    await input.pressSequentially("a/b 그리고 /");
    await menu.waitFor();
    await input.press("Escape");
    await expect(menu.count()).resolves.toBe(0);
    await expect(input.inputValue()).resolves.toBe("a/b 그리고 /");
    await input.fill("https://example.com/a");
    await expect(menu.count()).resolves.toBe(0);
    await input.fill("");
    await page.close();
  }, 90_000);
});
