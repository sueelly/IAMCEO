// Agent-A 문서 화면(IAMCEO 화면 부품): 자료를 고르면 칸(iframe) 없이 바로 열리고, 문장 끌어 댓글 · 답글 · 전체 댓글 · 그림 영역 질문 ·
// 수정안 저장 · 판 · 문서 관리 · 다른 자료를 보는 동안 답 알림이 실제 화면에서 돈다.
// 실제 IAMCEO 서버(http.ts)·실제 화면·격리 DB. Agent-A 는 기본이 가짜(tests/fixtures/fake-agent-a-review.ts, 실제 AI 없음)다.
// IAMCEO_AGENT_A_REAL_URL=http://127.0.0.1:<포트> 를 주면 같은 흐름을 실제 Agent-A 서버 코드로 돌린다(그 서버의 답은 같은 규칙의 대역이어야 한다).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { Bus } from "../server/bus.ts";
import { loadConfig, updateConfigFile } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { startServer, type RunningServer } from "../server/http.ts";
import { AgentAClient, AgentAService } from "../server/integrations/agent-a.ts";
import { AgentAReview } from "../server/integrations/agent-a-review.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import type { Runner, RunnerEvent, SendResult } from "../server/runner/types.ts";
import { Store } from "../server/store.ts";
import type { Backend, FileDoc, Project } from "../shared/types.ts";
import { fakeAgentAReview } from "./fixtures/fake-agent-a-review.ts";
import { pngBase64 } from "./fixtures/png.ts";

const CODE = "agent-a-review-test-code";
const REAL = process.env.IAMCEO_AGENT_A_REAL_URL ?? null;
const SHOTS = process.env.IAMCEO_E2E_SHOTS ?? mkdtempSync(join(tmpdir(), "iamceo-aa-review-shots-"));
mkdirSync(SHOTS, { recursive: true });
const MARKDOWN = [
  "이 문서는 Agent-A 화면 시험용입니다.",
  "## 배경",
  "배경 문장 하나. 배경 문장 둘은 조금 더 깁니다.",
  "",
  "- 목록 첫째",
  "- 목록 둘째",
  "## 계획",
  "계획은 세 단계입니다. 단계마다 확인합니다.",
  "",
  "| 단계 | 할 일 |",
  "| --- | --- |",
  "| 1 | 설계 |",
  "| 2 | 구현 |",
  "## 남은 일",
  "남은 일은 시험과 보고입니다. <script>window.__aaHacked = true</script> 꺾쇠 글은 글자로 보여야 합니다.",
].join("\n");

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
let agentA: AgentAService;
let review: AgentAReview;
let browser: Browser;
let base = "";
let project: Project;
let plain: FileDoc;
const fake = REAL ? null : fakeAgentAReview({ answerDelayMs: 500 });
const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));

async function newDoc(title: string): Promise<string> {
  return (await agentA.createDoc(project.id, { title, markdown: MARKDOWN, images: [{ title: "구성도", name: "map.png", mediaType: "image/png", base64: pngBase64(400, 200) }] })).fileId;
}

beforeAll(async () => {
  const home = mkdtempSync(join(tmpdir(), "iamceo-aa-review-web-"));
  const env = { IAMCEO_HOME: home, IAMCEO_PORT: "0" };
  updateConfigFile({ accessCode: CODE, hosts: ["127.0.0.1"] }, env);
  const config = loadConfig(env);
  const bus = new Bus();
  store = new Store(openDb(config.dbPath), bus);
  const runner = new FakeRunner();
  orch = new Orchestrator({ config, store, runners: new Map<Backend, Runner>([["headless", runner]]) });
  agentA = new AgentAService(store, REAL ? new AgentAClient({ baseUrl: REAL, appToken: null, agentToken: null }) : new AgentAClient({ baseUrl: "http://127.0.0.1:4999", appToken: null, agentToken: null }, fake!.transport));
  orch.agentA = agentA;
  review = new AgentAReview(agentA);
  server = await startServer({ config, store, bus, orch, delivery: orch.deliveryRecovery, agentA });
  base = server.urls[0]!;
  orch.setServerUrl(base);
  project = store.createProject({ name: "Agent-A 화면 시험", cwd: home });
  const lead = await orch.ensureConductor(project.id);
  runner.end(lead.id);
  const worker = (await orch.addMember(project.id, { name: "문서 담당", handle: "docs", role: "기획" })).member;
  runner.end(worker.id);
  await settle();
  const task = orch.saveTask(worker, { title: "문서 검토", branch: "docs/review" }).task;
  await orch.recordPost(worker, { kind: "진행", title: "문서 검토 시작", taskId: task.id });
  plain = store.createFile({ projectId: project.id, title: "보통 자료", who: worker.name, memberId: worker.id, summary: "Agent-A 와 이어지지 않은 자료", body: "# 보통 자료\n\n본문", kind: "document", taskId: task.id });
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  agentA?.stop();
  fake?.stop();
  await orch.shutdown();
  await server.stop();
  console.log(`shots: ${SHOTS}${REAL ? " (실제 Agent-A 서버 코드)" : " (가짜 Agent-A)"}`);
});

async function open(page: Page, fileId: string) {
  await page.goto(`${base}/api/health`);
  await page.evaluate((code) => localStorage.setItem("iamceo.accessCode", code), CODE);
  await page.goto(`${base}/#/p/${encodeURIComponent(project.id)}/files/${encodeURIComponent(fileId)}`);
  try { await page.locator(".aar-doc").waitFor({ timeout: 25_000 }); }
  catch (e) { await page.screenshot({ path: join(SHOTS, "fail-open.png"), fullPage: true }); console.log(await page.locator("body").innerText()); throw e; }
}
const shot = (page: Page, name: string) => page.screenshot({ path: join(SHOTS, `${name}.png`) });
/** 앞선 부드러운 스크롤(목차·댓글 고르기)이 끝날 때까지 기다린다. 끝나기 전에 옮기면 그 스크롤이 다시 덮어쓴다. */
async function scrollSettled(page: Page) {
  let last = "";
  let same = 0;
  for (let i = 0; i < 80 && same < 4; i++) {
    const now = await page.evaluate(() => `${document.querySelector(".aar-scroll")?.scrollTop ?? 0}:${document.querySelector("[data-scroll-root]")?.scrollTop ?? 0}:${window.scrollY}`);
    same = now === last ? same + 1 : 0;
    last = now;
    await page.waitForTimeout(100);
  }
}
/** 본문에서 글이 든 자리. 먼저 그 글이 보이게 옮기고(부드러운 스크롤이 끝난 뒤) 자리를 잰다. */
async function rectOf(page: Page, text: string) {
  await scrollSettled(page);
  const find = `(needle) => {
    const root = document.querySelector(".aar-doc");
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.textContent.indexOf(needle);
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + needle.length);
      return r;
    }
    return null;
  }`;
  const found = await page.evaluate(`(${find})(${JSON.stringify(text)})?.startContainer.parentElement.scrollIntoView({ block: "center", behavior: "instant" }) ?? null, Boolean((${find})(${JSON.stringify(text)}))`);
  if (!found) throw new Error(`본문에 없는 글: ${text}`);
  // 앞선 부드러운 스크롤(목차·댓글 고르기)이 끝나 자리가 멈출 때까지 기다린다
  let last = "";
  let same = 0;
  for (let i = 0; i < 60; i++) {
    const now = await page.evaluate(`(() => { const b = (${find})(${JSON.stringify(text)}).getBoundingClientRect(); return JSON.stringify({ x0: b.left + 1, x1: b.right - 1, y: b.top + b.height / 2 }); })()`) as string;
    same = now === last ? same + 1 : 0;
    // 세 번 이어서 같아야 멈춘 것으로 본다(부드러운 스크롤은 시작이 늦을 수 있다)
    if (same >= 3) return JSON.parse(now) as { x0: number; x1: number; y: number };
    last = now;
    await page.waitForTimeout(100);
  }
  throw new Error(`자리가 멈추지 않음: ${text}`);
}
/** 본문에서 글을 마우스로 끌어 고른다(실제 선택). */
async function dragSelect(page: Page, text: string) {
  const box = await rectOf(page, text);
  await page.mouse.move(box.x0, box.y);
  await page.mouse.down();
  await page.mouse.move(box.x1, box.y, { steps: 10 });
  await page.mouse.up();
}
const pane = (page: Page) => page.locator(".aar-pane");
/** 고른 글에 댓글을 달고 그 댓글을 연 채로 둔다. */
async function quoteComment(page: Page, quote: string, text: string) {
  await dragSelect(page, quote);
  try {
    await page.locator(".aar-pick").click({ timeout: 8_000 });
    await pane(page).locator(".aar-quote").waitFor({ timeout: 8_000 });
  } catch (e) { await shot(page, "fail-quote"); console.log("고른 글:", await page.evaluate(() => window.getSelection()?.toString())); throw e; }
  await expect(pane(page).locator(".aar-quote").innerText()).resolves.toBe(quote);
  await pane(page).getByLabel("댓글", { exact: true }).fill(text);
  await pane(page).getByLabel("댓글", { exact: true }).press("Enter");
  await pane(page).locator(".aar-msg").first().waitFor();
}
const answers = (page: Page) => pane(page).locator(".aar-msg[data-ai]");
/** 마지막 답이 다 써질 때까지 기다린다. */
async function answered(page: Page, count: number, includes: string) {
  try {
    await page.waitForFunction(([n, s]) => {
      const list = [...document.querySelectorAll(".aar-pane .aar-msg[data-ai]")];
      return list.length === n && !document.querySelector(".aar-pane .aar-msg__writing") && (list[list.length - 1]?.textContent ?? "").includes(s as string);
    }, [count, includes] as const, { timeout: 20_000 });
  } catch (e) { await shot(page, "fail-answer"); console.log(await pane(page).innerText()); throw e; }
}
const docText = (page: Page) => page.locator(".aar-doc").innerText();

describe("Agent-A 문서 화면", () => {
  test("데스크톱: 자료를 고르면 칸 없이 바로 열리고, 문장 댓글 → 답 → 답글 → 전체 댓글이 돈다", async () => {
    const fileId = await newDoc("첫 문서");
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    // 보통 자료에서 시작해 목록에서 Agent-A 자료를 고른다(주소 입력·실행 단추 없이)
    await page.goto(`${base}/api/health`);
    await page.evaluate((code) => localStorage.setItem("iamceo.accessCode", code), CODE);
    await page.goto(`${base}/#/p/${encodeURIComponent(project.id)}/files/${encodeURIComponent(plain.id)}`);
    await page.locator(".fl-row", { hasText: "첫 문서" }).click();
    await page.locator(".aar-doc").waitFor({ timeout: 25_000 });
    // 칸(iframe)도 '실행' 단추도 없다. Agent-A 앱 주소로 가는 요청도 없다
    await expect(page.locator("iframe").count()).resolves.toBe(0);
    await expect(page.getByRole("button", { name: "실행" }).count()).resolves.toBe(0);
    await expect(page.locator(".fl-doc[data-agent-a]").count()).resolves.toBe(1);
    // Agent-A 앱을 대신 전해 주던 길과 입장권은 서버에서 없어졌다: 입장권 발급은 404 이고,
    // 옛 경로는 아무 뜻 없는 주소와 똑같이 IAMCEO 화면 틀만 돌려준다(Agent-A 의 응답이 아니다).
    const auth = { Authorization: `Bearer ${CODE}` };
    const ticket = await fetch(`${base}/api/agent-a/ui-session`, { method: "POST", headers: auth });
    expect(ticket.status).toBe(404);
    const [old, any] = await Promise.all([fetch(`${base}/agent-a-ui/s/${"a".repeat(43)}/api/config`, { headers: auth }), fetch(`${base}/no-such-path/api/config`, { headers: auth })]);
    const [oldBody, anyBody] = await Promise.all([old.text(), any.text()]);
    expect(oldBody).not.toContain("adapter_enabled");
    expect([old.status, old.headers.get("content-type"), oldBody]).toEqual([any.status, any.headers.get("content-type"), anyBody]);
    // 본문이 IAMCEO 글꼴·마크다운으로 그려진다: 머리말·목록·표·그림
    const text = await docText(page);
    for (const s of ["배경", "배경 문장 하나.", "목록 둘째", "설계", "남은 일"]) expect(text).toContain(s);
    await expect(page.locator(".aar-doc table").count()).resolves.toBe(1);
    await page.locator(".aar-fig__img").waitFor();
    // 문서 글의 꺾쇠는 글자다(스크립트로 돌지 않는다)
    expect(text).toContain("<script>window.__aaHacked = true</script>");
    await expect(page.evaluate(() => (window as unknown as { __aaHacked?: boolean }).__aaHacked)).resolves.toBeUndefined();
    const font = await page.evaluate(() => [getComputedStyle(document.querySelector(".aar-md")!).fontFamily, getComputedStyle(document.body).fontFamily]);
    expect(font[0]).toBe(font[1]);
    // 처음에는 목차가 닫혀 있고 자료 목록·프로젝트 패널이 접혀 본문이 넓다. 댓글 칸은 본문 옆에 펴져 있다
    await expect(page.locator(".aar-toc").count()).resolves.toBe(0);
    await expect(page.locator(".fl--desk[data-focus]").count()).resolves.toBe(1);
    await expect(page.locator(".aar-side .aar-pane").count()).resolves.toBe(1);
    await expect(page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).resolves.toBe(true);
    await shot(page, "1-desk-open");

    // 목차: 눌러 열고, 머리말로 옮기고, 다시 닫는다
    await page.getByRole("button", { name: "목차", exact: true }).click();
    // 머리말 앞의 글은 문서 제목을 이름으로 한 첫 블록이 되고, 그림 블록은 글 블록 뒤에 온다(Agent-A 정본의 블록 차례)
    await expect(page.locator(".aar-toc li").allInnerTexts()).resolves.toEqual(["첫 문서", "첫 문서", "배경", "계획", "남은 일", "구성도"]);
    await page.locator(".aar-toc button", { hasText: "남은 일" }).click();
    await page.getByRole("button", { name: "목차", exact: true }).click();
    await expect(page.locator(".aar-toc").count()).resolves.toBe(0);

    // 문장을 끌어 고르면 '댓글' 단추가 뜬다 → 댓글 → Agent-A 답
    await quoteComment(page, "배경 문장 하나.", "이 문장은 무슨 뜻인가요?");
    await expect(pane(page).locator(".aar-msg").first().innerText()).resolves.toContain("이 문장은 무슨 뜻인가요?");
    await answered(page, 1, "시험 답: 이 문장은 무슨 뜻인가요?");
    // 댓글이 달린 문장이 본문에서 칠해진다(본문 DOM 은 그대로)
    await expect(page.evaluate(() => (CSS.highlights.get("aa-quote")?.size ?? 0) + (CSS.highlights.get("aa-quote-active")?.size ?? 0))).resolves.toBeGreaterThanOrEqual(1);
    await expect(page.locator(".aar-doc mark").count()).resolves.toBe(0);
    await shot(page, "2-desk-thread");

    // 답글(대댓글)
    await pane(page).getByLabel("답글", { exact: true }).fill("한 줄로 다시 설명해 주세요");
    await pane(page).getByLabel("답글", { exact: true }).press("Enter");
    await answered(page, 2, "시험 답: 한 줄로 다시 설명해 주세요");
    await expect(pane(page).getByLabel("답글", { exact: true }).inputValue()).resolves.toBe("");

    // 목록으로 → 전체 댓글
    await pane(page).getByRole("button", { name: "댓글 목록으로" }).click();
    await expect(pane(page).locator(".aar-row").count()).resolves.toBe(1);
    await expect(pane(page).locator(".aar-row").first().innerText()).resolves.toContain("글 4");
    await pane(page).getByRole("button", { name: "전체 댓글" }).click();
    await pane(page).getByLabel("댓글", { exact: true }).fill("문서 전체가 너무 길지 않나요?");
    await pane(page).getByLabel("댓글", { exact: true }).press("Enter");
    await answered(page, 1, "시험 답: 문서 전체가 너무 길지 않나요?");
    await pane(page).getByRole("button", { name: "댓글 목록으로" }).click();
    await expect(pane(page).locator(".aar-row .aa-tag").allInnerTexts()).resolves.toEqual(["전체", "문장"]);
    // 본문에서 칠해진 문장을 누르면 그 댓글이 열린다
    const at = await page.evaluate(() => {
      const range = [...(CSS.highlights.get("aa-quote") ?? [])][0] as Range;
      range.startContainer.parentElement!.scrollIntoView({ block: "center" });
      const b = range.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    });
    await page.mouse.click(at.x, at.y);
    await expect(pane(page).locator(".aar-quote").innerText()).resolves.toBe("배경 문장 하나.");

    // 새로고침: 같은 자료가 다시 바로 열리고 댓글이 남아 있다. 목차는 다시 닫혀 있다
    await page.reload();
    await page.locator(".aar-doc").waitFor({ timeout: 25_000 });
    await page.waitForFunction(() => document.querySelectorAll(".aar-pane .aar-row").length === 2);
    await expect(page.locator("iframe").count()).resolves.toBe(0);
    await expect(page.locator(".aar-toc").count()).resolves.toBe(0);
    expect(errors).toEqual([]);
    await page.close();
  }, 120_000);

  test("데스크톱: 그림 영역 질문, 답 실패와 다시 요청, 완료·갈라 내기·지우기", async () => {
    const fileId = await newDoc("그림 문서");
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await open(page, fileId);
    // 그림 위에서 끌어 영역을 고른다
    await page.locator(".aar-fig__img").waitFor();
    await page.locator(".aar-fig").scrollIntoViewIfNeeded();
    await page.getByRole("button", { name: "영역 골라 질문" }).click();
    const box = (await page.locator(".aar-fig__layer").boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.7, { steps: 8 });
    await page.mouse.up();
    await expect(pane(page).locator(".aar-pane__head strong").innerText()).resolves.toBe("그림 영역에 질문");
    await expect(page.locator(".aar-fig__draft").count()).resolves.toBe(1);
    await shot(page, "3-desk-region");
    await pane(page).getByLabel("댓글", { exact: true }).fill("이 영역은 무엇을 뜻하나요?");
    await pane(page).getByLabel("댓글", { exact: true }).press("Enter");
    await answered(page, 1, "시험 답: 이 영역은 무엇을 뜻하나요?");
    // 영역이 그림 위에 남고, 그림 픽셀 기준으로 저장됐다(400x200 그림의 10~50% · 20~70%)
    await expect(page.locator(".aar-fig__mark").count()).resolves.toBe(1);
    const stored = (await review.comments(fileId, (await review.open(fileId)).sessionId, null))!.annotations.find((a) => a.region)!.region!;
    expect(stored).toMatchObject({ naturalWidth: 400, naturalHeight: 200 });
    expect(Math.abs(stored.box.x - 40)).toBeLessThanOrEqual(3);
    expect(Math.abs(stored.box.y - 40)).toBeLessThanOrEqual(3);
    expect(Math.abs(stored.box.w - 160)).toBeLessThanOrEqual(5);
    expect(Math.abs(stored.box.h - 100)).toBeLessThanOrEqual(5);
    await pane(page).getByRole("button", { name: "댓글 목록으로" }).click();
    await page.locator(".aar-fig__mark").click();
    await expect(pane(page).locator(".aar-pane__head strong").innerText()).resolves.toBe("그림 영역 댓글");

    // 답 실패 → 오류 코드와 '다시 요청' → 다시 답
    await pane(page).getByRole("button", { name: "댓글 목록으로" }).click();
    await quoteComment(page, "계획은 세 단계입니다.", "이 답은 실패 시험입니다");
    await pane(page).locator(".aar-msg__error").waitFor({ timeout: 20_000 });
    await expect(pane(page).locator(".aar-msg__error code").innerText()).resolves.toMatch(/\S+/);
    await pane(page).getByRole("button", { name: "다시 요청" }).click();
    await page.waitForFunction(() => [...document.querySelectorAll(".aar-pane .aar-msg[data-ai]")].some((m) => m.textContent?.includes("다시 답")), null, { timeout: 20_000 });
    await expect(pane(page).getByRole("button", { name: "다시 요청" }).count()).resolves.toBe(0);

    // 완료 → 목록 아래 '끝난 댓글'로 가고, 다시 열 수 있다
    await pane(page).getByRole("button", { name: "완료", exact: true }).click();
    await pane(page).getByRole("button", { name: "다시 열기" }).waitFor();
    await pane(page).getByRole("button", { name: "댓글 목록으로" }).click();
    await expect(pane(page).getByRole("button", { name: /끝난 댓글/ }).innerText()).resolves.toContain("1");
    await pane(page).getByRole("button", { name: /끝난 댓글/ }).click();
    await pane(page).locator(".aar-row", { hasText: "이 답은 실패 시험입니다" }).click();
    await pane(page).getByRole("button", { name: "다시 열기" }).click();
    await pane(page).getByRole("button", { name: "완료", exact: true }).waitFor();
    // 다른 조건으로 질문: 갈라 낸 새 댓글이 열린다
    await pane(page).getByRole("button", { name: "다른 조건으로 질문" }).click();
    await pane(page).locator(".aar-note", { hasText: "갈라 낸 질문" }).waitFor();
    // 지우기: 한 번 더 눌러야 지워진다
    await pane(page).getByRole("button", { name: "지우기" }).click();
    await expect(pane(page).getByRole("button", { name: "한 번 더 눌러 지우기" }).count()).resolves.toBe(1);
    await page.waitForTimeout(700);
    await pane(page).getByRole("button", { name: "한 번 더 눌러 지우기" }).click();
    await page.waitForFunction(() => document.querySelectorAll(".aar-pane .aar-row").length === 2);
    await page.close();
  }, 120_000);

  test("데스크톱: 수정안 저장 → 새 정본 → 판 보기 → 문서 관리(되살리기·직접 고치기)", async () => {
    const fileId = await newDoc("수정안 문서");
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await open(page, fileId);
    await expect(page.locator(".aar-bar__state").innerText()).resolves.toBe("정본 판 1");
    await quoteComment(page, "계획은 세 단계입니다.", "이 문장을 고쳐 주세요");
    await pane(page).locator(".aar-proposal").waitFor({ timeout: 20_000 });
    await expect(pane(page).locator(".aar-proposal .badge").innerText()).resolves.toBe("저장 전");
    await expect(pane(page).locator(".aar-proposal__after").innerText()).resolves.toContain("계획은 세 단계입니다. (고침)");
    await pane(page).locator(".aar-proposal__compare summary").click();
    await expect(pane(page).locator(".aar-proposal__compare ins").innerText()).resolves.toContain("(고침)");
    await shot(page, "4-desk-proposal");
    // 목록에는 '수정안' 표시와 '내 차례'가 뜬다
    await pane(page).getByRole("button", { name: "댓글 목록으로" }).click();
    await expect(pane(page).locator(".aar-turn__row").count()).resolves.toBe(1);
    await pane(page).locator(".aar-turn__row").click();
    // 정본에 저장 → 새 본문이 열리고 판이 올라간다. 옛 댓글은 그 판에 남는다
    await pane(page).getByRole("button", { name: "정본에 저장" }).click();
    await page.waitForFunction(() => document.querySelector(".aar-bar__state")?.textContent === "정본 판 2", null, { timeout: 20_000 });
    await expect(page.locator(".aar-banner").first().innerText()).resolves.toContain("수정안을 정본에 저장했습니다(판 2)");
    expect(await docText(page)).toContain("계획은 세 단계입니다. (고침)");
    await page.locator(".aar-banner", { hasText: "다른 판에 남은 댓글이 1개" }).waitFor();
    await expect(pane(page).locator(".aar-row").count()).resolves.toBe(0);
    await shot(page, "5-desk-applied");

    // 판: 과거 판 본문 보기 → 지금 정본 보기
    await page.getByRole("button", { name: "판", exact: true }).click();
    const dialog = page.locator("dialog[open]");
    await dialog.locator('[aria-label="검토 판"] li').first().waitFor();
    await expect(dialog.locator('[aria-label="검토 판"] li').count()).resolves.toBe(2);
    await dialog.getByRole("button", { name: "본문 보기" }).click();
    await page.locator(".aar-banner", { hasText: "과거 판 1의 본문입니다." }).waitFor();
    expect(await docText(page)).not.toContain("(고침)");
    await expect(page.locator(".aar-pick").count()).resolves.toBe(0);
    await page.getByRole("button", { name: "지금 정본 보기" }).click();
    await page.waitForFunction(() => document.querySelector(".aar-doc")?.textContent?.includes("(고침)"));
    // 다른 판의 댓글: 그 판에서 열면 그때 본문과 댓글이 보인다
    await page.getByRole("button", { name: "판", exact: true }).click();
    await dialog.locator('[aria-label="다른 판의 댓글"] li').first().waitFor();
    await dialog.getByRole("button", { name: "그 판에서 열기" }).click();
    await page.locator(".aar-banner", { hasText: "과거 판의 검토를 보고 있습니다." }).waitFor();
    // 수정안을 저장한 댓글은 끝난 댓글이다(목록 아래에 접혀 있다)
    await pane(page).getByRole("button", { name: /끝난 댓글/ }).click();
    await expect(pane(page).locator(".aar-row").count()).resolves.toBe(1);
    expect(await docText(page)).not.toContain("(고침)");
    await pane(page).locator(".aar-row").click();
    await expect(pane(page).locator(".aar-proposal .badge").innerText()).resolves.toMatch(/저장됨|저장 뒤 다시 바뀜/);
    await page.getByRole("button", { name: "지금 정본 보기" }).click();
    await page.waitForFunction(() => document.querySelector(".aar-bar__state")?.textContent === "정본 판 2");

    // 문서 관리: 수정안 목록, 정본의 이전 판 되살리기, 직접 고치기, 판 이력
    await page.getByRole("button", { name: /^문서 관리/ }).click();
    await dialog.getByRole("button", { name: /^저장됨/ }).click();
    await expect(dialog.locator(".aar-proposal").count()).resolves.toBe(1);
    await dialog.getByRole("button", { name: "정본", exact: true }).click();
    const plan = dialog.locator(".aar-card", { hasText: "계획" });
    await expect(plan.locator(".aar-card__meta").first().innerText()).resolves.toBe("판 2");
    await plan.locator("summary").click();
    await plan.getByRole("button", { name: "판 1 내용으로 되살리기" }).click();
    await page.waitForTimeout(700);
    await plan.getByRole("button", { name: "한 번 더 눌러 되살리기" }).click();
    await dialog.locator(".aar-note", { hasText: "되살렸습니다(판 3)" }).waitFor({ timeout: 20_000 });
    await expect(plan.locator(".aar-card__meta").first().innerText()).resolves.toBe("판 3");
    await plan.getByRole("button", { name: "직접 고치기" }).click();
    await plan.locator("textarea").fill("계획은 네 단계로 바꿉니다.");
    await plan.getByRole("button", { name: "정본에 저장" }).click();
    await dialog.locator(".aar-note", { hasText: "정본에 저장했습니다(판 4)" }).waitFor({ timeout: 20_000 });
    await dialog.getByRole("button", { name: "판 이력" }).click();
    await expect(dialog.locator('[aria-label="정본 판 이력"] li').count()).resolves.toBe(4);
    await shot(page, "6-desk-manage");
    await dialog.getByRole("button", { name: "닫기" }).click();
    await page.waitForFunction(() => document.querySelector(".aar-bar__state")?.textContent === "정본 판 4");
    expect(await docText(page)).toContain("계획은 네 단계로 바꿉니다.");
    await page.close();
  }, 150_000);

  test("다른 자료를 보는 동안 답이 오면 알리고, 눌러 가면 '내 차례'에 그 답이 있다", async () => {
    const fileId = await newDoc("알림 문서");
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`${base}/api/health`);
    await page.evaluate((code) => localStorage.setItem("iamceo.accessCode", code), CODE);
    await page.goto(`${base}/#/p/${encodeURIComponent(project.id)}/files/${encodeURIComponent(plain.id)}`);
    await page.locator(".fl-doc__title", { hasText: "보통 자료" }).waitFor({ timeout: 25_000 });
    // 서버의 답 알림은 '처음 본 답'은 기준으로만 삼는다. 먼저 한 번 훑어 기준을 만든다
    await agentA.watchComments();
    const { sessionId } = await review.open(fileId);
    await review.addComment(fileId, sessionId, { id: `notice-${Date.now()}`, kind: "global", text: "다른 자료를 보는 동안 묻습니다" });
    for (let i = 0; i < 40 && !(await page.locator(".aa-notice").count()); i++) {
      await agentA.watchComments();
      await page.waitForTimeout(500);
    }
    await expect(page.locator(".aa-notice").innerText()).resolves.toContain("‘알림 문서’ 댓글에 답이 왔습니다".replace(/[‘’]/g, "'"));
    await shot(page, "7-desk-notice");
    // 대화에도 알림 글이 남는다
    expect(store.listMessages(project.id).some((m) => m.title === "'알림 문서' 댓글에 답이 왔습니다")).toBe(true);
    await page.locator(".aa-notice").getByRole("link", { name: "자료 열기" }).click();
    await page.locator(".aar-doc").waitFor({ timeout: 25_000 });
    await pane(page).locator(".aar-turn__row").waitFor({ timeout: 20_000 });
    await pane(page).locator(".aar-turn__row").click();
    await expect(answers(page).last().innerText()).resolves.toContain("시험 답: 다른 자료를 보는 동안 묻습니다");
    // 읽었으니 '내 차례'에서 빠진다
    await pane(page).getByRole("button", { name: "댓글 목록으로" }).click();
    await expect(pane(page).locator(".aar-turn__row").count()).resolves.toBe(0);
    // 입력칸의 업무 고르기는 그대로 쓴다(자료는 닫히지 않는다)
    await page.locator(".cmp-task", { hasText: "문서 검토" }).click();
    await expect(page.locator(".cmp-task", { hasText: "문서 검토" }).getAttribute("aria-pressed")).resolves.toBe("true");
    await expect(page.locator(".aar-doc").count()).resolves.toBe(1);
    await page.close();
  }, 120_000);

  test("폰 폭: 목록 → 자료 → 본문·댓글 판·목차 판이 넘치지 않고, 고른 글에 댓글을 단다", async () => {
    const fileId = await newDoc("폰 문서");
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    await page.goto(`${base}/api/health`);
    await page.evaluate((code) => localStorage.setItem("iamceo.accessCode", code), CODE);
    await page.goto(`${base}/#/p/${encodeURIComponent(project.id)}/files`);
    await page.locator(".fl-row", { hasText: "폰 문서" }).tap();
    await page.locator(".aar-doc").waitFor({ timeout: 25_000 });
    await expect(page.locator("iframe").count()).resolves.toBe(0);
    await page.locator(".aar-fig__img").waitFor();
    await expect(page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).resolves.toBe(true);
    // 폰에서는 본문이 먼저 보이고 댓글·목차는 판으로 연다
    await expect(page.locator("dialog[open]").count()).resolves.toBe(0);
    await shot(page, "8-phone-open");
    await page.getByRole("button", { name: "목차", exact: true }).tap();
    await page.locator("dialog[open] .aar-toc__list button", { hasText: "계획" }).tap();
    await expect(page.locator("dialog[open]").count()).resolves.toBe(0);
    // 글을 고르면(폰의 길게 눌러 고르기와 같은 선택) '댓글' 단추가 뜬다
    await page.evaluate(() => {
      const root = document.querySelector(".aar-doc")!;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const i = n.textContent!.indexOf("단계마다 확인합니다.");
        if (i < 0) continue;
        n.parentElement!.scrollIntoView({ block: "center" });
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + "단계마다 확인합니다.".length);
        const sel = window.getSelection()!;
        sel.removeAllRanges();
        sel.addRange(r);
        return;
      }
    });
    await page.locator(".aar-pick").waitFor();
    const pick = (await page.locator(".aar-pick").boundingBox())!;
    expect(pick.x).toBeGreaterThanOrEqual(0);
    expect(pick.x + pick.width).toBeLessThanOrEqual(390);
    expect(pick.height).toBeGreaterThanOrEqual(44);
    await page.locator(".aar-pick").tap();
    const sheet = page.locator("dialog[open]");
    await expect(sheet.locator(".aar-quote").innerText()).resolves.toBe("단계마다 확인합니다.");
    await sheet.getByLabel("댓글", { exact: true }).fill("폰에서 묻습니다");
    await shot(page, "9-phone-compose");
    await sheet.getByRole("button", { name: "보내기" }).tap();
    await answered(page, 1, "시험 답: 폰에서 묻습니다");
    await expect(page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).resolves.toBe(true);
    const panel = (await sheet.locator(".dialog__panel").boundingBox())!;
    expect(panel.x).toBeGreaterThanOrEqual(0);
    expect(panel.x + panel.width).toBeLessThanOrEqual(390);
    await shot(page, "10-phone-thread");
    await sheet.getByRole("button", { name: "닫기" }).tap();
    await expect(page.locator(".aar-bar__comments").innerText()).resolves.toContain("1");
    // 뒤로 → 자료 목록
    await page.locator(".fl-back").tap();
    await page.locator(".fl-row", { hasText: "폰 문서" }).waitFor();
    await page.close();
  }, 120_000);
});
