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
import type { AgentAReviewDiagramAnchor } from "../shared/agent-a.ts";
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
/** 가짜 Agent-A 가 응답한 뒤에 끼어드는 고리. 던지면 IAMCEO 서버는 그 응답을 받지 못한 것이 된다(저장은 됐는데 응답만 잃는 경우). */
const afterFake: { run?: (input: string, init: RequestInit, res: Response) => void } = {};
const fakeTransport = async (input: string, init: RequestInit): Promise<Response> => {
  const res = await fake!.transport(input, init);
  afterFake.run?.(input, init, res);
  return res;
};
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
  agentA = new AgentAService(store, REAL ? new AgentAClient({ baseUrl: REAL, appToken: null, agentToken: null }) : new AgentAClient({ baseUrl: "http://127.0.0.1:4999", appToken: null, agentToken: null }, fakeTransport));
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
const DIAGRAM_MARKDOWN = ["도식이 있는 문서입니다.", "", "## 흐름", "", "```mermaid", "graph TD", "  A[시작] --> B[검토]", "  B -->|통과| C[끝]", "```", "", "끝 문장입니다. 검토와 통과는 본문에도 나오는 낱말입니다."].join("\n");
/** 도식(노드 셋·선 둘)과 그림 하나가 든 문서. */
async function newDiagramDoc(title: string): Promise<string> {
  return (await agentA.createDoc(project.id, { title, markdown: DIAGRAM_MARKDOWN, images: [{ title: "구성도", name: "map.png", mediaType: "image/png", base64: pngBase64(400, 200) }] })).fileId;
}
/** 문서의 도식이 모두 그려져(그림이 실제 크기로 열려) 누를 수 있을 때까지 기다린다. */
async function drawn(page: Page) {
  try {
    await page.waitForFunction(() => {
      const list = [...document.querySelectorAll(".aar-diagram")];
      return list.length > 0 && list.every((d) => d.getAttribute("data-state") === "drawn" && [...d.querySelectorAll("img")].every((img) => img.complete && img.naturalWidth > 20));
    }, null, { timeout: 60_000 });
  } catch (e) { await shot(page, "fail-diagram"); console.log(await page.locator(".aar-diagram").allInnerTexts()); throw e; }
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
    await expect(plan.locator(".aar-card__meta").first().innerText()).resolves.toBe("글 · 판 2");
    await plan.locator("summary").click();
    await plan.getByRole("button", { name: "판 1 내용으로 되살리기" }).click();
    await page.waitForTimeout(700);
    await plan.getByRole("button", { name: "한 번 더 눌러 되살리기" }).click();
    await dialog.locator(".aar-note", { hasText: "되살렸습니다(판 3)" }).waitFor({ timeout: 20_000 });
    await expect(plan.locator(".aar-card__meta").first().innerText()).resolves.toBe("글 · 판 3");
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

  // ---- R3: 도식의 한 부분에 댓글, 그림 영역의 '좋아요' 라벨(원래 Agent-A 화면의 두 기능) ----
  test("데스크톱: 도식의 한 부분을 눌러 댓글을 달고 번호 표시로 다시 연다. 선과 도식 전체에도 달고, 다시 열어도 남는다", async () => {
    const fileId = await newDiagramDoc("도식 댓글 문서");
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await open(page, fileId);
    const fence = (await review.open(fileId)).markdown.split("\n").indexOf("```mermaid") + 1;
    expect(fence).toBeGreaterThan(0);
    const diagram = page.locator(".aar-diagram");
    await drawn(page);
    // 그려진 도식에서 누를 수 있는 부분: 노드 셋과 선 둘
    const partsOf = () => diagram.locator(".aar-diagram__part").evaluateAll((list) => [...new Set(list.map((b) => `${b.getAttribute("data-kind")}:${b.getAttribute("data-part")}`))].sort());
    await expect(partsOf()).resolves.toEqual(["edge:A→B", "edge:B→C", "node:A", "node:B", "node:C"]);
    const stored = async () => (await review.comments(fileId, (await review.open(fileId)).sessionId, null))!.annotations.filter((a) => !a.ai).map((a) => [a.text, a.quote, a.diagram]);

    // 노드: 누르면 그 부분에 댓글을 쓰는 칸이 열리고, 고른 부분이 도식 위에 표시된다
    await diagram.locator('.aar-diagram__part[data-kind="node"][data-part="B"]').first().click();
    await expect(pane(page).locator(".aar-pane__head strong").innerText()).resolves.toBe("도식 부분에 댓글");
    await expect(pane(page).locator(".aar-quote").innerText()).resolves.toBe("검토");
    await expect(diagram.locator(".aar-diagram__draft").count()).resolves.toBe(1);
    await shot(page, "28-desk-diagram-part");
    await pane(page).getByLabel("댓글", { exact: true }).fill("이 단계는 누가 하나요?");
    await pane(page).getByLabel("댓글", { exact: true }).press("Enter");
    await answered(page, 1, "시험 답: 이 단계는 누가 하나요?");
    await expect(pane(page).locator(".aar-pane__head strong").innerText()).resolves.toBe("도식 댓글");
    await expect(diagram.locator(".aar-diagram__mark").count()).resolves.toBe(1);
    await expect(diagram.locator(".aar-diagram__draft").count()).resolves.toBe(0);
    const node: AgentAReviewDiagramAnchor = { v: 1, family: "flowchart", kind: "node", id: "B", label: "검토", sourceLine: [fence + 2, fence + 2] };
    await expect(stored()).resolves.toEqual([["이 단계는 누가 하나요?", "검토", node]]);
    // 번호 표시는 그 노드 위에 있다(노드 단추와 겹친다)
    const overlap = await diagram.evaluate((root) => {
      const mark = root.querySelector(".aar-diagram__mark")!.getBoundingClientRect();
      const part = root.querySelector('.aar-diagram__part[data-kind="node"][data-part="B"]')!.getBoundingClientRect();
      return mark.left < part.right && mark.right > part.left && mark.top < part.bottom && mark.bottom > part.top;
    });
    expect(overlap).toBe(true);
    // 목록으로 갔다가 번호 표시를 누르면 그 댓글이 열린다
    await pane(page).getByRole("button", { name: "댓글 목록으로" }).click();
    await pane(page).locator(".aar-row .aa-tag", { hasText: "도식" }).waitFor();
    await diagram.getByRole("button", { name: "도식 댓글 1 열기" }).click();
    await expect(pane(page).locator(".aar-pane__head strong").innerText()).resolves.toBe("도식 댓글");
    await expect(pane(page).locator(".aar-msg").first().innerText()).resolves.toContain("이 단계는 누가 하나요?");
    await expect(diagram.locator(".aar-diagram__mark[data-active]").count()).resolves.toBe(1);

    // 선: 선에 붙은 글(통과)을 눌러도 그 선이다
    await pane(page).getByRole("button", { name: "댓글 목록으로" }).click();
    await diagram.locator('.aar-diagram__part[data-kind="edge"][data-part="B→C"]').first().click();
    await expect(pane(page).locator(".aar-quote").innerText()).resolves.toBe("통과");
    await pane(page).getByLabel("댓글", { exact: true }).fill("통과 기준이 뭔가요?");
    await pane(page).getByLabel("댓글", { exact: true }).press("Enter");
    await answered(page, 1, "시험 답: 통과 기준이 뭔가요?");
    // 도식 전체: 부분이 없는 자리를 누른다
    await pane(page).getByRole("button", { name: "댓글 목록으로" }).click();
    const layer = (await diagram.locator(".aar-diagram__layer").boundingBox())!;
    await page.mouse.click(layer.x + 3, layer.y + 3);
    await expect(pane(page).locator(".aar-pane__head strong").innerText()).resolves.toBe("도식 전체에 댓글");
    await expect(pane(page).locator(".aar-quote").innerText()).resolves.toBe("graph TD");
    await pane(page).getByLabel("댓글", { exact: true }).fill("도식이 너무 단순합니다");
    await pane(page).getByLabel("댓글", { exact: true }).press("Enter");
    await answered(page, 1, "시험 답: 도식이 너무 단순합니다");
    const edge: AgentAReviewDiagramAnchor = { v: 1, family: "flowchart", kind: "edge", from: "B", to: "C", label: "통과", sourceLine: [fence + 3, fence + 3] };
    const whole: AgentAReviewDiagramAnchor = { v: 1, family: "flowchart", kind: "diagram", label: "graph TD", sourceLine: [fence + 1, fence + 3] };
    await expect(stored()).resolves.toEqual([["이 단계는 누가 하나요?", "검토", node], ["통과 기준이 뭔가요?", "통과", edge], ["도식이 너무 단순합니다", "graph TD", whole]]);
    await expect(diagram.locator(".aar-diagram__mark").count()).resolves.toBe(3);
    await shot(page, "29-desk-diagram-marks");
    // 도식 댓글은 본문의 같은 낱말(검토·통과)을 칠하지 않는다: 원문 칸의 글은 도식 부분의 글이지 본문 문장이 아니다
    await expect(page.evaluate(() => ["aa-quote", "aa-quote-done", "aa-quote-active"].reduce((n, name) => n + (CSS.highlights.get(name)?.size ?? 0), 0))).resolves.toBe(0);
    // 틀린 자리(이름 없는 노드)를 서버 길로 직접 보내면 거절하고 아무것도 쓰지 않는다
    const direct = await fetch(`${base}/api/agent-a/docs/${fileId}/review/comments`, { method: "POST", headers: { Authorization: `Bearer ${CODE}`, "Content-Type": "application/json" },
      body: JSON.stringify({ session: await sessionOf(page), id: "direct-diagram-1", kind: "comment", text: "직접 보낸 도식 댓글", diagram: { v: 1, family: "flowchart", kind: "node", label: "검토", sourceLine: null } }) });
    expect([direct.status, ((await direct.json()) as { code?: string }).code]).toEqual([400, "AGENT_A_INVALID_DIAGRAM_ANCHOR"]);
    await expect(stored()).resolves.toHaveLength(3);

    // 원문을 보는 동안에는 표시가 없고, 그림으로 돌아오면 다시 보인다
    await diagram.getByRole("button", { name: "원문 보기" }).click();
    await expect(diagram.locator(".aar-diagram__mark, .aar-diagram__part").count()).resolves.toBe(0);
    await diagram.getByRole("button", { name: "그림 보기" }).click();
    await expect(diagram.locator(".aar-diagram__mark").count()).resolves.toBe(3);
    // 다시 열어도(새로고침) 표시 셋이 제자리에 남고, 눌러 다시 읽는다
    await page.reload();
    await page.locator(".aar-doc").waitFor({ timeout: 25_000 });
    await drawn(page);
    await page.waitForFunction(() => document.querySelectorAll(".aar-diagram__mark").length === 3, null, { timeout: 20_000 });
    await diagram.getByRole("button", { name: "도식 댓글 2 열기" }).click();
    await expect(pane(page).locator(".aar-msg").first().innerText()).resolves.toContain("통과 기준이 뭔가요?");
    await expect(pane(page).locator(".aar-quote").innerText()).resolves.toBe("통과");
    // 도식은 여전히 그림으로만 보인다: 본문에 svg·칸·스크립트를 끼우지 않고, 그리는 칸은 격리된 하나뿐이다
    await expect(page.locator(".aar-doc svg, .aar-doc iframe, .aar-doc script, .aar-doc foreignObject").count()).resolves.toBe(0);
    await expect(page.locator("iframe").evaluateAll((list) => list.map((f) => [f.getAttribute("src"), f.getAttribute("sandbox")]))).resolves.toEqual([["/vendor/diagram-frame", "allow-scripts"]]);
    await expect(page.evaluate(() => "mermaid" in window)).resolves.toBe(false);
    expect(errors).toEqual([]);
    await page.close();
  }, 180_000);

  test("데스크톱: 그림 영역에 '좋아요' 라벨을 한 번 눌러 붙인다. 글을 쓰면 눌리지 않고, 다시 열어도 영역과 라벨이 남는다", async () => {
    const fileId = await newDoc("영역 라벨 문서");
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await open(page, fileId);
    await page.locator(".aar-fig__img").waitFor();
    await page.locator(".aar-fig").scrollIntoViewIfNeeded();
    const draw = async () => {
      await page.getByRole("button", { name: "영역 골라 질문" }).click();
      const box = (await page.locator(".aar-fig__layer").boundingBox())!;
      await page.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.7, { steps: 8 });
      await page.mouse.up();
      await expect(pane(page).locator(".aar-pane__head strong").innerText()).resolves.toBe("그림 영역에 질문");
    };
    await draw();
    const good = pane(page).getByRole("button", { name: "좋아요 라벨 붙이기" });
    await expect(good.innerText()).resolves.toBe("👍");
    // 글을 쓰면 눌리지 않는다(쓰던 글을 버리지 않는다). 지우면 다시 눌린다.
    await pane(page).getByLabel("댓글", { exact: true }).fill("쓰던 질문");
    await expect(good.isDisabled()).resolves.toBe(true);
    await pane(page).getByLabel("댓글", { exact: true }).fill("");
    await expect(good.isDisabled()).resolves.toBe(false);
    await shot(page, "30-desk-region-label");
    await good.click();
    await page.locator(".aar-banner", { hasText: "라벨 ‘👍 좋아요’을(를) 붙였습니다." }).waitFor({ timeout: 15_000 });
    // 영역이 그림 위에 번호로 남고, 댓글 목록에는 라벨로 보인다
    await page.waitForFunction(() => document.querySelectorAll(".aar-fig__mark").length === 1 && !document.querySelector(".aar-fig__draft"), null, { timeout: 15_000 });
    await pane(page).locator(".aar-row .aar-label", { hasText: "👍 좋아요" }).waitFor({ timeout: 15_000 });
    const sessionId = (await review.open(fileId)).sessionId;
    const saved = (await review.comments(fileId, sessionId, null))!.annotations.filter((a) => !a.ai);
    expect(saved.map((a) => [a.text, a.label, a.labelTip, a.quote, a.diagram])).toEqual([["👍 좋아요", true, null, "", null]]);
    expect(saved[0]!.region).toMatchObject({ naturalWidth: 400, naturalHeight: 200 });
    expect(Math.abs(saved[0]!.region!.box.x - 40)).toBeLessThanOrEqual(3);
    expect(Math.abs(saved[0]!.region!.box.w - 160)).toBeLessThanOrEqual(5);
    // 다시 열어도 남는다: 영역 표시를 누르면 라벨 댓글이 열린다
    await page.reload();
    await page.locator(".aar-doc").waitFor({ timeout: 25_000 });
    await page.locator(".aar-fig__mark").waitFor({ timeout: 20_000 });
    await page.locator(".aar-fig__mark").click();
    await expect(pane(page).locator(".aar-pane__head strong").innerText()).resolves.toBe("라벨 댓글");
    await expect(pane(page).locator(".aar-msg .aar-label").first().innerText()).resolves.toBe("👍 좋아요");
    // 보통 질문은 그대로 된다(라벨이 질문 길을 바꾸지 않았다)
    await pane(page).getByRole("button", { name: "댓글 목록으로" }).click();
    await draw();
    await pane(page).getByLabel("댓글", { exact: true }).fill("이 영역은 무엇을 뜻하나요?");
    await pane(page).getByLabel("댓글", { exact: true }).press("Enter");
    await answered(page, 1, "시험 답: 이 영역은 무엇을 뜻하나요?");
    const after = (await review.comments(fileId, sessionId, null))!.annotations.filter((a) => !a.ai);
    expect(after.map((a) => [a.text, a.label, Boolean(a.region)])).toEqual([["👍 좋아요", true, true], ["이 영역은 무엇을 뜻하나요?", false, true]]);
    await page.close();
  }, 150_000);

  test("폰 폭: 도식 부분 댓글과 그림 영역의 '좋아요' 라벨이 댓글 판에서 돌고, 넘치지 않는다", async () => {
    const fileId = await newDiagramDoc("폰 도식 문서");
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    await open(page, fileId);
    const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    const fence = (await review.open(fileId)).markdown.split("\n").indexOf("```mermaid") + 1;
    await drawn(page);
    await expect(fits()).resolves.toBe(true);
    const diagram = page.locator(".aar-diagram");
    await diagram.scrollIntoViewIfNeeded();
    // 도식의 노드를 손끝으로 누르면 댓글 판이 열린다
    await diagram.locator('.aar-diagram__part[data-kind="node"][data-part="C"]').first().tap();
    const sheet = page.locator("dialog[open]");
    await expect(sheet.locator(".aar-pane__head strong").innerText()).resolves.toBe("도식 부분에 댓글");
    await expect(sheet.locator(".aar-quote").innerText()).resolves.toBe("끝");
    await sheet.getByLabel("댓글", { exact: true }).fill("폰에서 도식에 묻습니다");
    await shot(page, "31-phone-diagram-compose");
    await sheet.getByRole("button", { name: "보내기" }).tap();
    await answered(page, 1, "시험 답: 폰에서 도식에 묻습니다");
    await expect(fits()).resolves.toBe(true);
    await sheet.getByRole("button", { name: "닫기" }).tap();
    await expect(diagram.locator(".aar-diagram__mark").count()).resolves.toBe(1);
    const mark = (await diagram.locator(".aar-diagram__mark").boundingBox())!;
    expect(mark.x).toBeGreaterThanOrEqual(0);
    expect(mark.x + mark.width).toBeLessThanOrEqual(390);
    await shot(page, "32-phone-diagram-mark");
    // 그림 영역: 끌어 고른 뒤 '좋아요' 한 번
    await page.locator(".aar-fig").scrollIntoViewIfNeeded();
    await page.getByRole("button", { name: "영역 골라 질문" }).tap();
    const box = (await page.locator(".aar-fig__layer").boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.8, { steps: 8 });
    await page.mouse.up();
    await expect(sheet.locator(".aar-pane__head strong").innerText()).resolves.toBe("그림 영역에 질문");
    const good = sheet.getByRole("button", { name: "좋아요 라벨 붙이기" });
    const at = (await good.boundingBox())!;
    expect(Math.min(at.width, at.height)).toBeGreaterThanOrEqual(44);
    expect(at.x + at.width).toBeLessThanOrEqual(390);
    // 판이 다 올라온 뒤에는 단추가 화면 안에 있다
    await page.waitForFunction(() => { const b = document.querySelector(".aar-good")?.getBoundingClientRect(); return Boolean(b && b.top >= 0 && b.bottom <= window.innerHeight); }, null, { timeout: 10_000 });
    await shot(page, "33-phone-region-label");
    await good.tap();
    await page.waitForFunction(() => document.querySelectorAll(".aar-fig__mark").length === 1, null, { timeout: 15_000 });
    await expect(fits()).resolves.toBe(true);
    const saved = (await review.comments(fileId, (await review.open(fileId)).sessionId, null))!.annotations.filter((a) => !a.ai);
    expect(saved.map((a) => [a.text, a.label, Boolean(a.region), a.diagram])).toEqual([
      ["폰에서 도식에 묻습니다", false, false, { v: 1, family: "flowchart", kind: "node", id: "C", label: "끝", sourceLine: [fence + 3, fence + 3] }],
      ["👍 좋아요", true, true, null],
    ]);
    await page.close();
  }, 150_000);
});

// ---- 독립 검토 뒤에 되살린 기능(가짜 Agent-A 로만 돈다: 답 글·AI 표시가 가짜의 규칙이다) ----
const sessionOf = (page: Page) => page.locator(".aar").getAttribute("data-session");
/** 원래 Agent-A 의 다른 창이 초안을 통째로 저장하는 것을 흉내 낸다(IAMCEO 를 거치지 않는다). */
async function otherWindowSaves(sessionId: string, change: Record<string, unknown>) {
  const session = fake!.sessions.find((s) => s.id === sessionId)!;
  const res = await fake!.transport("http://127.0.0.1:4999/api/draft", { method: "POST", headers: { "x-enouv-artifact": session.artifact_id, "x-enouv-review-session": sessionId, "content-type": "application/json" },
    body: JSON.stringify({ draftGeneration: session.draft_generation, annotations: session.draft?.annotations ?? [], globalAttachments: session.draft?.globalAttachments ?? [], ...change }) });
  expect(res.status).toBe(200);
}
const banner = (page: Page, text: string) => page.locator(".aar-banner", { hasText: text }).waitFor({ timeout: 15_000 });
const tool = (page: Page, name: string) => page.locator(".aar-seg__btn", { hasText: new RegExp(`^${name}$`) }).click();

describe.skipIf(Boolean(REAL))("Agent-A 문서 화면: 되살린 기능", () => {
  test("데스크톱: 표시 모드의 삭제 표시, 요소 지정으로 문단을 통째로 골라 댓글·삭제 표시", async () => {
    const fileId = await newDoc("표시 문서");
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await open(page, fileId);
    const state = fake!.artifacts.get(agentA.docOf(fileId).artifactId)!;
    // 표시(기본): 고르면 댓글·삭제 표시·묻기 가운데 고른다
    await expect(page.locator('.aar-seg__btn[aria-pressed="true"]').allInnerTexts()).resolves.toEqual(["끌기", "표시"]);
    await dragSelect(page, "배경 문장 하나.");
    await page.locator(".aar-picks").waitFor({ timeout: 8_000 });
    await expect(page.locator(".aar-picks button").allInnerTexts()).resolves.toEqual(["댓글", "라벨", "삭제 표시", "묻기"]);
    await page.locator(".aar-pick2", { hasText: "삭제 표시" }).click();
    await banner(page, "삭제 표시를 남겼습니다");
    const rows = () => fake!.rows.filter((r) => r.artifact_id === state.id);
    expect(rows().map((r) => [r.annotation.type, r.annotation.originalText, r.state])).toEqual([["DELETION", "배경 문장 하나.", "ignored"]]);
    await pane(page).locator(".aar-row", { hasText: "삭제 표시" }).waitFor();
    // 삭제 표시한 글은 본문에서 줄을 그어 칠한다(본문 DOM 은 그대로)
    await page.waitForFunction(() => (CSS.highlights.get("aa-deletion")?.size ?? 0) === 1);
    await expect(page.locator(".aar-doc del, .aar-doc mark").count()).resolves.toBe(0);
    await shot(page, "9-desk-deletion");

    // 요소 지정 + 댓글: 문단을 누르면 통째로 골라 바로 댓글을 쓴다
    await tool(page, "요소 지정");
    await tool(page, "댓글");
    const para = await rectOf(page, "계획은 세 단계입니다.");
    await page.mouse.click(para.x0 + 6, para.y);
    await pane(page).locator(".aar-quote").waitFor();
    await expect(pane(page).locator(".aar-quote").innerText()).resolves.toBe("계획은 세 단계입니다. 단계마다 확인합니다.");
    await pane(page).getByLabel("댓글", { exact: true }).fill("이 문단을 풀어 주세요");
    await pane(page).getByLabel("댓글", { exact: true }).press("Enter");
    await answered(page, 1, "시험 답: 이 문단을 풀어 주세요");
    expect(rows().at(-1)!.annotation.originalText).toBe("계획은 세 단계입니다. 단계마다 확인합니다.");

    // 요소 지정 + 삭제 표시: 목록 항목을 누르면 바로 삭제 표시가 남는다
    await tool(page, "삭제 표시");
    const item = await rectOf(page, "목록 둘째");
    await page.mouse.click(item.x0 + 4, item.y);
    await page.waitForFunction(() => (CSS.highlights.get("aa-deletion")?.size ?? 0) === 2);
    expect(rows().filter((r) => r.annotation.type === "DELETION").map((r) => r.annotation.originalText)).toEqual(["배경 문장 하나.", "목록 둘째"]);
    // 고른 방법과 동작은 이 브라우저에 남는다
    await page.reload();
    await page.locator(".aar-doc").waitFor({ timeout: 25_000 });
    await expect(page.locator('.aar-seg__btn[aria-pressed="true"]').allInnerTexts()).resolves.toEqual(["요소 지정", "삭제 표시"]);
    expect(state.artifact_revision).toBe(1);
    await page.close();
  }, 120_000);

  test("데스크톱: 댓글에 그림을 붙이고 AI 를 골라 보내면 그 AI 로 답하고, 답글은 다른 AI·추론 수준으로 받는다", async () => {
    const fileId = await newDoc("AI 고르기 문서");
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await open(page, fileId);
    await pane(page).getByRole("button", { name: "전체 댓글" }).click();
    await pane(page).locator('input[aria-label="댓글에 붙일 그림"]').setInputFiles({ name: "shot.png", mimeType: "image/png", buffer: Buffer.from(pngBase64(40, 30), "base64") });
    await pane(page).locator(".aar-attach .aar-thumb img").waitFor({ timeout: 15_000 });
    await pane(page).getByLabel("플랫폼").selectOption("claude-agent-sdk");
    await pane(page).getByLabel("모델").selectOption("claude-test");
    // Claude 시험 모델에는 추론 수준이 없다: 고르는 칸도 없다
    await expect(pane(page).getByLabel("추론 수준").count()).resolves.toBe(0);
    await pane(page).getByLabel("댓글", { exact: true }).fill("그림과 함께 묻습니다");
    await pane(page).getByLabel("댓글", { exact: true }).press("Enter");
    await answered(page, 1, "시험 답: 그림과 함께 묻습니다 [claude-agent-sdk/claude-test]");
    // 붙인 그림은 헤더 인증으로 받아 그린다(주소에 접속 코드가 없다)
    await pane(page).locator(".aar-msg .aar-thumb img").waitFor({ timeout: 15_000 });
    await expect(pane(page).locator(".aar-msg .aar-thumb img").getAttribute("src")).resolves.toMatch(/^blob:/);
    const row = fake!.rows.find((r) => r.annotation.text === "그림과 함께 묻습니다")!;
    expect(row.annotation.images).toEqual([{ path: expect.stringMatching(/^\/assets\/user\/[a-f0-9]{64}\/1$/), name: "shot.png" }]);
    expect(row.annotation.aiSettings).toEqual({ providerId: "claude-agent-sdk", model: "claude-test" });
    // 답글은 다른 AI·추론 수준으로
    await pane(page).getByLabel("플랫폼").selectOption("codex-sdk");
    await pane(page).getByLabel("모델").selectOption("test-model");
    await pane(page).getByLabel("추론 수준").selectOption("high");
    await pane(page).getByLabel("답글", { exact: true }).fill("더 자세히");
    await pane(page).getByLabel("답글", { exact: true }).press("Enter");
    await answered(page, 2, "시험 답: 더 자세히 [codex-sdk/test-model/high]");
    await shot(page, "10-desk-ai-attach");
    await page.close();
  }, 120_000);

  test("데스크톱: 본문을 직접 고쳐 초안으로 두고, 다른 창이 먼저 저장하면 덮지 않는다. 검토 제출은 주석을 분기로 넘긴다", async () => {
    const fileId = await newDoc("초안 문서");
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await open(page, fileId);
    const first = (await sessionOf(page))!;
    const state = fake!.artifacts.get(agentA.docOf(fileId).artifactId)!;
    const draftOf = () => fake!.sessions.find((s) => s.id === first)!.draft;
    await page.getByRole("button", { name: "본문 고치기" }).click();
    const input = page.getByLabel("본문(마크다운)");
    await input.waitFor();
    const canonical = await input.inputValue();
    expect(canonical).toContain("## 배경");
    await input.fill(`${canonical}\n\n덧붙인 문단입니다.`);
    await page.getByRole("button", { name: "초안 저장" }).click();
    await banner(page, "고친 본문을 초안으로 저장했습니다. 정본은 그대로입니다.");
    await page.waitForFunction(() => document.querySelector(".aar-doc")?.textContent?.includes("덧붙인 문단입니다."));
    await expect(page.locator(".aar-bar__state").innerText()).resolves.toContain("직접 편집 초안");
    expect(draftOf().editedMarkdown).toContain("덧붙인 문단입니다.");
    expect(state.artifact_revision).toBe(1);
    await shot(page, "11-desk-draft-saved");

    // 고치는 사이 다른 창이 초안을 저장한다 → 내 저장은 거절되고 그 초안이 남는다. 내 글도 입력칸에 남는다.
    await page.getByRole("button", { name: "본문 고치기" }).click();
    await input.waitFor();
    await otherWindowSaves(first, { editedMarkdown: "다른 창의 본문", globalAttachments: [{ name: "other.png", path: "/assets/other" }] });
    await input.fill("내가 고친 본문");
    await page.getByRole("button", { name: "초안 저장" }).click();
    await page.locator('[aria-label="다른 화면의 초안"]').waitFor({ timeout: 15_000 });
    await page.locator('[aria-label="다른 화면의 초안"]').scrollIntoViewIfNeeded();
    await expect(page.locator(".aar-editor .aar-error").innerText()).resolves.toContain("그사이 다른 화면이 초안을 저장했습니다");
    expect(draftOf()).toMatchObject({ editedMarkdown: "다른 창의 본문", globalAttachments: [{ name: "other.png", path: "/assets/other" }] });
    await expect(input.inputValue()).resolves.toBe("내가 고친 본문");
    await shot(page, "12-desk-draft-conflict");
    await page.getByRole("button", { name: "다른 화면의 초안으로 바꾸기" }).click();
    await expect(input.inputValue()).resolves.toBe("다른 창의 본문");
    await page.getByRole("button", { name: "고치기 그만" }).click();
    await page.locator(".aar-doc").waitFor();

    // 검토 제출: 초안의 주석이 분기의 질문이 되고, 이 검토는 닫힌다. 정본은 그대로다.
    await pane(page).getByRole("button", { name: "전체 댓글" }).click();
    await pane(page).getByLabel("댓글", { exact: true }).fill("제출할 의견입니다");
    await pane(page).getByLabel("댓글", { exact: true }).press("Enter");
    await answered(page, 1, "시험 답: 제출할 의견입니다");
    // 다른 창의 저장에도 내 댓글은 초안에 들어 있다
    expect(draftOf().annotations.map((a: { text: string }) => a.text)).toEqual(["제출할 의견입니다"]);
    expect(draftOf().editedMarkdown).toBe("다른 창의 본문");
    await page.getByRole("button", { name: "검토 제출" }).click();
    const dialog = page.locator("dialog[open]");
    await dialog.getByText("넘길 것: 주석 1개 · 직접 고친 본문 · 붙인 그림 1개").waitFor({ timeout: 15_000 });
    await shot(page, "13-desk-submit");
    await expect(dialog.getByRole("button").allInnerTexts()).resolves.toEqual(expect.arrayContaining(["확인하고 저장", "의견 보내기"]));
    await dialog.getByRole("button", { name: "확인하고 저장" }).click();
    await banner(page, "검토를 제출했습니다. 질문 2개가 분기로 넘어갔습니다. 정본은 그대로입니다.");
    await page.waitForFunction((id) => document.querySelector(".aar")?.getAttribute("data-session") !== id, first);
    expect(state.branches).toHaveLength(2);
    expect(state.feedback.map((f: { state: string }) => f.state)).toEqual(["not_sent", "not_sent"]);
    expect(state.artifact_revision).toBe(1);
    // 머리의 Save 와 같은 결정(approved)으로 남는다
    expect(fake!.sessions.find((s) => s.id === first)!.decision.kind).toBe("approved");
    // 새 검토에는 초안이 없고 정본 본문이다
    expect(await docText(page)).not.toContain("다른 창의 본문");
    await expect(page.locator(".aar-bar__state").innerText()).resolves.not.toContain("직접 편집 초안");
    await page.close();
  }, 150_000);

  // 독립 재검토 R1: Agent-A 가 초안을 저장한 뒤 응답만 끊긴 경우. 다시 누르면 다른 화면의 충돌로 보이지 않고 저장된 것으로 확인된다.
  // between: 응답을 잃은 뒤, 다시 누르기 전에 다른 화면이 새 초안 판에서 검토에 붙인 그림을 저장한다(초안 판이 한 번 더 오른다).
  for (const between of [false, true]) test(between
    ? "데스크톱: 초안 저장의 응답을 잃은 뒤 다른 화면이 그림을 붙여도, '초안 저장'을 다시 누르면 저장된 것으로 확인한다(다시 쓰지 않는다)"
    : "데스크톱: 초안 저장의 응답을 잃어도 '초안 저장'을 다시 누르면 저장된 것으로 확인한다(다시 쓰지 않는다)", async () => {
    const fileId = await newDoc(between ? "응답 유실 뒤 그림 저장 문서" : "응답 유실 문서");
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await open(page, fileId);
    const first = (await sessionOf(page))!;
    const session = () => fake!.sessions.find((s) => s.id === first)!;
    await page.getByRole("button", { name: "본문 고치기" }).click();
    const input = page.getByLabel("본문(마크다운)");
    await input.waitFor();
    const canonical = await input.inputValue();
    await input.fill(`${canonical}\n\n응답을 잃은 저장입니다.`);
    let lost = false;
    afterFake.run = (url, init, res) => {
      if (!lost && init.method === "POST" && new URL(url).pathname === "/api/draft" && res.status === 200) {
        lost = true;
        throw new Error("초안 저장 뒤 응답 유실(시험)");
      }
    };
    try {
      await page.getByRole("button", { name: "초안 저장" }).click();
      await page.locator(".aar-editor .aar-error").waitFor({ timeout: 15_000 });
      await expect(page.locator(".aar-editor .aar-error").innerText()).resolves.toContain("Agent-A 서버에 닿지 않습니다");
      expect(lost).toBe(true);
      // Agent-A 에는 이미 저장돼 있다. 화면은 아직 모른다(입력칸의 글은 그대로다).
      expect(session().draft.editedMarkdown).toContain("응답을 잃은 저장입니다.");
      let revision = session().draft_revision;
      await expect(input.inputValue()).resolves.toContain("응답을 잃은 저장입니다.");
      if (between) {
        // 다른 화면이 IAMCEO 서버 길(HTTP)로 보내는 저장. 화면과 같은 열쇠를 쓰고 요청 id 만 다르다.
        const post = async (path: string, body: unknown) => {
          const res = await fetch(`${base}/api/agent-a/docs/${encodeURIComponent(fileId)}/review/${path}`, { method: "POST", headers: { authorization: `Bearer ${CODE}`, "content-type": "application/json" }, body: JSON.stringify(body) });
          return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
        };
        // 요청 id 가 없는 저장은 서버 길이 받지 않는다
        expect((await post("draft/attachments", { session: first, attachments: [], revision })).status).toBe(400);
        // 다른 화면이 같은 초안 판에서 같은 글을 보내면 충돌이다(그 화면의 요청이 저장된 것이 아니다). 아무것도 바뀌지 않는다.
        const same = await post("draft", { session: first, markdown: session().draft.editedMarkdown, revision: revision - 1, opId: "other-screen-body-001" });
        expect([same.status, same.json?.code]).toEqual([409, "AGENT_A_DRAFT_CONFLICT"]);
        expect(session().draft_revision).toBe(revision);
        // 다른 화면이 지금 초안 판에서 그림을 붙였다. 본문은 그대로 싣는다.
        const up = await review.upload(fileId, first, { name: "other-screen.png", mediaType: "image/png", base64: pngBase64(12, 12) });
        const saved = await post("draft/attachments", { session: first, attachments: [up], revision, opId: "other-screen-attach-01" });
        expect([saved.status, saved.json?.revision]).toEqual([200, revision + 1]);
        expect(session().draft_revision).toBe(revision + 1);
        revision += 1;
        // 방금 쓴 요청 id 에 지금 초안 판·다른 그림 목록을 붙여 보내면 새 저장으로 받지 않는다(독립 재확인 5f7f626). 붙인 그림과 초안 판이 그대로다.
        const reused = await post("draft/attachments", { session: first, attachments: [], revision, opId: "other-screen-attach-01" });
        expect([reused.status, reused.json?.code]).toEqual([409, "AGENT_A_IDEMPOTENCY_CONFLICT"]);
        expect([session().draft_revision, session().draft.globalAttachments]).toEqual([revision, [up]]);
      }
      // 같은 글로 다시 누른다: 다른 화면의 초안(충돌)으로 보이지 않고 저장으로 끝난다. 초안은 다시 쓰이지 않았다.
      await page.getByRole("button", { name: "초안 저장" }).click();
      await banner(page, "고친 본문을 초안으로 저장했습니다. 정본은 그대로입니다.");
      await expect(page.locator('[aria-label="다른 화면의 초안"]').count()).resolves.toBe(0);
      expect(session().draft_revision).toBe(revision);
      expect(session().draft.editedMarkdown).toContain("응답을 잃은 저장입니다.");
      expect(session().draft.globalAttachments).toHaveLength(between ? 1 : 0);
      await page.waitForFunction(() => document.querySelector(".aar-doc")?.textContent?.includes("응답을 잃은 저장입니다."));
      await expect(page.locator(".aar-bar__state").innerText()).resolves.toContain("직접 편집 초안");
    } finally {
      afterFake.run = undefined;
    }
    await page.close();
  }, 120_000);

  test("데스크톱: 문서에 묻기 — 고른 글과 함께 묻고 답이 이어 붙는다. 새 대화와 앞 대화", async () => {
    const fileId = await newDoc("묻기 문서");
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await open(page, fileId);
    const state = fake!.artifacts.get(agentA.docOf(fileId).artifactId)!;
    await dragSelect(page, "배경 문장 둘은 조금 더 깁니다.");
    await page.locator(".aar-pick2", { hasText: "묻기" }).click();
    const chat = page.locator('.aar-pane[aria-label="문서에 묻기"]');
    await chat.waitFor();
    await expect(chat.locator(".aar-pane__foot .aar-note").innerText()).resolves.toContain("배경 문장 둘은 조금 더 깁니다.");
    const ask = async (text: string) => {
      await chat.locator("textarea").fill(text);
      await chat.locator("textarea").press("Enter");
      try {
        await page.waitForFunction((s) => {
          const last = [...document.querySelectorAll('.aar-pane[aria-label="문서에 묻기"] .aar-chat')].at(-1);
          return Boolean(last && !last.querySelector(".aar-msg__writing") && (last.querySelector(".aar-msg[data-ai]")?.textContent ?? "").includes(s));
        }, `문서 답: ${text}`, { timeout: 20_000 });
      } catch (e) { await shot(page, "fail-chat"); console.log(await chat.innerText()); throw e; }
    };
    await ask("요지를 알려 주세요");
    await expect(chat.locator(".aar-chat .aar-quote").innerText()).resolves.toBe("배경 문장 둘은 조금 더 깁니다.");
    const mine = fake!.chats.filter((c) => c.artifact_id === state.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.entries[0]!.question).toMatchObject({ prompt: "요지를 알려 주세요", scope: { kind: "selection", text: "배경 문장 둘은 조금 더 깁니다." } });
    await expect(chat.locator("textarea").inputValue()).resolves.toBe("");
    await shot(page, "14-desk-chat");
    // 묻기는 댓글도 초안도 정본도 만들지 않는다
    expect(fake!.rows.filter((r) => r.artifact_id === state.id)).toHaveLength(0);
    expect(fake!.sessions.find((s) => s.artifact_id === state.id)!.draft).toBeNull();
    // 새 대화 → 앞 대화로 돌아가기. 대화는 문서에 남아 다시 열어도 보인다.
    await chat.getByRole("button", { name: "새 대화", exact: true }).click();
    await chat.getByText("이 문서에 대해 물어보세요").waitFor();
    await ask("둘째 질문입니다");
    await chat.getByRole("button", { name: "앞 대화" }).click();
    await chat.locator('[aria-label="앞 대화"] .aar-row').first().waitFor({ timeout: 15_000 });
    await expect(chat.locator('[aria-label="앞 대화"] .aar-row').count()).resolves.toBe(2);
    await chat.locator('[aria-label="앞 대화"] .aar-row', { hasText: "요지를 알려 주세요" }).click();
    await chat.locator(".aar-chat", { hasText: "문서 답: 요지를 알려 주세요" }).waitFor();
    await page.reload();
    await page.locator(".aar-doc").waitFor({ timeout: 25_000 });
    await pane(page).getByRole("button", { name: "문서에 묻기" }).click();
    await chat.locator(".aar-chat", { hasText: "문서 답: 요지를 알려 주세요" }).waitFor({ timeout: 15_000 });
    // 실패한 답은 오류로 보이고 쓴 글 뒤의 대화는 이어진다
    await chat.locator("textarea").fill("실패하는 질문");
    await chat.locator("textarea").press("Enter");
    await chat.locator(".aar-msg__error", { hasText: "답변을 받지 못했습니다" }).waitFor({ timeout: 15_000 });
    await chat.getByRole("button", { name: "←" }).click().catch(() => chat.locator(".aar-back").click());
    await pane(page).getByRole("button", { name: "전체 댓글" }).waitFor();
    await page.close();
  }, 150_000);

  test("데스크톱: 문서 관리 — 분기를 만들고, 피드백 자료를 준비해 결과를 가져오고, 답변을 채택한다", async () => {
    const fileId = await newDoc("분기 문서");
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await open(page, fileId);
    const state = fake!.artifacts.get(agentA.docOf(fileId).artifactId)!;
    await page.getByRole("button", { name: /문서 관리/ }).click();
    const dialog = page.locator("dialog[open]");
    const tab = (name: string) => dialog.locator(".aar-manage__tabs .fl-chip", { hasText: new RegExp(`^${name}`) }).click();
    await tab("분기");
    await dialog.getByText("저장된 분기가 없습니다.").waitFor();
    await dialog.getByLabel("질문 대상").selectOption({ label: "계획" });
    await dialog.getByLabel("새 질문").fill("세 단계가 무엇인가요?");
    await dialog.getByRole("button", { name: "분기 만들기" }).click();
    await dialog.locator("[data-branch]", { hasText: "세 단계가 무엇인가요?" }).waitFor({ timeout: 15_000 });
    await expect(dialog.locator("[data-branch] .aar-card__meta").first().innerText()).resolves.toBe("열림");
    await expect(dialog.locator("[data-branch]").innerText()).resolves.toContain("대상: 계획");
    // 피드백: 질문을 골라 전송 자료를 준비한다. 자동 연동이 꺼진 Agent-A 라 CLI 실행은 눌리지 않는다.
    await tab("피드백");
    await dialog.locator("[data-feedback] input").check();
    await dialog.getByRole("button", { name: /자료 준비/ }).click();
    await dialog.locator("[data-job]").waitFor({ timeout: 15_000 });
    await expect(dialog.locator("[data-job] .aar-history__title").innerText()).resolves.toContain("준비됨");
    await expect(dialog.getByRole("button", { name: "CLI 실행" }).isDisabled()).resolves.toBe(true);
    await expect(dialog.getByText("자동 연동이 꺼져 있어 수동 교환만 됩니다").count()).resolves.toBe(1);
    await shot(page, "15-desk-feedback");
    // 수동으로 받은 결과를 가져온다 → 답변이 분기에 붙는다
    const job = fake!.jobs.find((j) => j.artifact_id === state.id)!;
    await dialog.getByLabel("응답 JSON").fill(JSON.stringify({ receipt_id: job.id, answers: [{ feedback_id: job.packet.selected_feedback[0].feedback_id, body: "조사·설계·구현입니다." }], proposals: [] }));
    await dialog.getByRole("button", { name: "결과 가져오기" }).click();
    await dialog.getByText("답과 수정안을 저장했습니다.").waitFor({ timeout: 15_000 });
    await expect(dialog.locator("[data-job] .aar-history__title").innerText()).resolves.toContain("완료");
    await tab("분기");
    const answer = dialog.locator('[data-branch] [data-role="assistant"]');
    await expect(answer.locator(".aar-msg__text").innerText()).resolves.toBe("조사·설계·구현입니다.");
    await dialog.getByLabel("판단 사유(선택)").fill("충분함");
    await answer.getByRole("button", { name: "답변 채택" }).click();
    await dialog.getByText("답변을 채택했습니다. 정본은 바뀌지 않습니다.").waitFor({ timeout: 15_000 });
    await expect(answer.locator(".aar-history__title").innerText()).resolves.toContain("채택");
    // 후속 질문과 닫기
    await dialog.locator("[data-branch]").getByLabel("후속 질문").fill("기간도 알려 주세요");
    await dialog.getByRole("button", { name: "후속 질문 저장" }).click();
    await dialog.getByText("후속 질문을 저장했습니다.").waitFor({ timeout: 15_000 });
    await dialog.getByRole("button", { name: "분기 닫기" }).click();
    await dialog.getByText("분기를 닫았습니다. 남은 것: 답 없는 질문 1.").waitFor({ timeout: 15_000 });
    await shot(page, "16-desk-branch");
    expect(state.branches[0]).toMatchObject({ status: "closed", title: "세 단계가 무엇인가요?" });
    expect(state.branches[0].messages.map((m: { role: string; decision?: string }) => [m.role, m.decision])).toEqual([["user", "proposed"], ["assistant", "accepted"], ["user", "proposed"]]);
    expect(state.artifact_revision).toBe(1);
    await page.close();
  }, 150_000);

  test("원래 Agent-A(초안 보존 규약 없음)에서는 새 댓글·본문 고치기·검토 제출·검토 첨부를 막고 까닭을 보인다", async () => {
    const fileId = (await agentA.createDoc(project.id, { title: "막힌 문서", markdown: "원래 Agent-A 에 붙인 문서입니다.\n\n## 흐름\n\n흐름 아래 문장." })).fileId;
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      // 규약을 아는 Agent-A: 쓰기 단추가 보인다
      await open(page, fileId);
      await page.getByRole("button", { name: "본문 고치기" }).waitFor();
      await page.getByRole("button", { name: "검토 첨부" }).waitFor();
      // 원래 Agent-A 로 바뀐 뒤 다시 열면 쓰기가 막힌다
      fake!.setDraftProtocol(1);
      await page.reload();
      await page.locator(".aar-doc").waitFor({ timeout: 25_000 });
      await banner(page, "이 Agent-A 는 초안 보존 규약을 몰라 새 댓글·삭제 표시·본문 고치기·검토 제출을 막았습니다.");
      for (const name of ["본문 고치기", "검토 제출", "검토 첨부", "전체 댓글"]) await expect(page.getByRole("button", { name }).count()).resolves.toBe(0);
      await expect(page.locator(".aar-seg").count()).resolves.toBe(0);
      await dragSelect(page, "흐름 아래 문장.");
      await page.waitForTimeout(300);
      await expect(page.locator(".aar-picks").count()).resolves.toBe(0);
      // 화면을 거치지 않고 서버 길을 직접 불러도 거절한다(쓰기는 Agent-A 에 가지 않는다)
      const before = fake!.calls.length;
      const direct = await fetch(`${base}/api/agent-a/docs/${fileId}/review/comments`, { method: "POST", headers: { Authorization: `Bearer ${CODE}`, "Content-Type": "application/json" },
        body: JSON.stringify({ session: await sessionOf(page), id: "direct-0001", kind: "global", text: "직접 보낸 댓글" }) });
      expect([direct.status, ((await direct.json()) as { code?: string }).code]).toEqual([409, "AGENT_A_UNSUPPORTED"]);
      expect(fake!.calls.slice(before).filter((c) => c.method !== "GET")).toEqual([]);
      // 문서에 묻기는 초안을 건드리지 않으므로 그대로 된다
      await pane(page).getByRole("button", { name: "문서에 묻기" }).click();
      await page.locator('.aar-pane[aria-label="문서에 묻기"] textarea').waitFor();
      await shot(page, "17-desk-unsupported");
    } finally {
      fake!.setDraftProtocol(2);
      await page.close();
    }
  }, 120_000);

  test("데스크톱: 문서 관리 — 요약 고치기 · 검토 표시 · 보관과 다시 꺼내기 · 새 블록(표·그림) · 목표와 제약", async () => {
    const fileId = await newDoc("블록 문서");
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await open(page, fileId);
    const state = fake!.artifacts.get(agentA.docOf(fileId).artifactId)!;
    const blockOf = (title: string) => state.blocks.find((b: { content: { title: string } }) => b.content.title === title);
    await page.getByRole("button", { name: /문서 관리/ }).click();
    const dialog = page.locator("dialog[open]");
    const noted = (text: string) => dialog.locator(".aar-note", { hasText: text }).waitFor({ timeout: 20_000 });
    await dialog.locator(".aar-manage__tabs .fl-chip", { hasText: /^정본/ }).click();
    const card = (title: string) => dialog.locator(`section.aar-card[aria-label="블록 ${title}"]`);
    // 요약 고치기: 제목 아래에 보이는 글. 본문은 그대로 둔다.
    await card("계획").getByRole("button", { name: "직접 고치기" }).click();
    await card("계획").getByLabel("요약").fill("세 단계 요약");
    await card("계획").getByRole("button", { name: "정본에 저장" }).click();
    await noted("정본에 저장했습니다(판 2)");
    await expect(card("계획").locator("[data-summary]").innerText()).resolves.toBe("요약: 세 단계 요약");
    // 가짜 Agent-A 의 상태는 값만 꺼내 본다(견주는 도구가 상태 안의 값을 바꾸지 않게).
    expect(blockOf("계획").content.summary).toBe("세 단계 요약");
    expect(blockOf("계획").content.body).toContain("계획은 세 단계입니다.");
    // 검토 표시: 지금 판을 검토함으로. 본문은 바뀌지 않는다.
    await card("계획").getByRole("button", { name: "검토함으로 표시" }).click();
    await noted("검토함으로 표시했습니다");
    await expect(card("계획").locator(".badge").innerText()).resolves.toBe("검토함");
    await expect(card("계획").getByRole("button", { name: "검토함으로 표시" }).count()).resolves.toBe(0);
    expect(blockOf("계획").reviewed_revision).toBe(2);
    // 보관: 한 번 더 눌러야 한다. 본문에서 빠지고, 이전 판에서 다시 꺼낸다.
    await card("배경").getByRole("button", { name: "보관" }).click();
    await page.waitForTimeout(700);
    await card("배경").getByRole("button", { name: "한 번 더 눌러 보관" }).click();
    await noted("보관했습니다");
    await expect(card("배경").locator(".aar-card__meta").first().innerText()).resolves.toContain("보관됨");
    expect(blockOf("배경").archived).toBe(true);
    await page.waitForFunction(() => !document.querySelector(".aar-doc")?.textContent?.includes("배경 문장 하나"));
    await expect(card("배경").getByRole("button", { name: "직접 고치기" }).count()).resolves.toBe(0);
    await card("배경").locator("summary", { hasText: "이전 판" }).click();
    await card("배경").getByRole("button", { name: "판 1 내용으로 다시 꺼내기" }).click();
    await page.waitForTimeout(700);
    await card("배경").getByRole("button", { name: "한 번 더 눌러 되살리기" }).click();
    await noted("되살렸습니다");
    expect(blockOf("배경").archived).toBe(false);
    await page.waitForFunction(() => document.querySelector(".aar-doc")?.textContent?.includes("배경 문장 하나"));
    // 새 블록(표): 형식이 틀리면 까닭을 보이고 더하지 않는다. 고쳐서 더하면 본문에 표로 보인다.
    await dialog.locator("summary", { hasText: "새 블록 더하기" }).click();
    const form = dialog.locator('[aria-label="새 블록"]');
    await form.getByLabel("블록 제목").fill("비교 표");
    await form.getByLabel("종류").selectOption({ label: "표" });
    await form.getByLabel("넣을 자리").selectOption({ label: "‘계획’ 뒤" });
    await form.getByLabel("본문").fill("표가 아님");
    await form.getByRole("button", { name: "블록 더하기" }).click();
    await dialog.locator(".aar-error", { hasText: "표 본문은 JSON 이어야 합니다" }).waitFor({ timeout: 20_000 });
    await expect(form.getByLabel("블록 제목").inputValue()).resolves.toBe("비교 표");
    await form.getByLabel("본문").fill('{"headers":["항목","값"],"rows":[["기간","2주"]]}');
    await form.getByRole("button", { name: "블록 더하기" }).click();
    await noted("새 블록 ‘비교 표’을(를) 더했습니다");
    await page.waitForFunction(() => [...document.querySelectorAll(".aar-doc td")].some((td) => td.textContent === "2주"));
    const order = state.blocks.filter((b: { archived: boolean }) => !b.archived).map((b: { content: { title: string } }) => b.content.title);
    expect(order[order.indexOf("계획") + 1]).toBe("비교 표");
    // 새 블록(그림): 그림을 골라 더하면 본문에 그림으로 보인다.
    const figures = await page.locator(".aar-doc .aar-fig").count();
    await form.getByLabel("블록 제목").fill("새 그림");
    await form.getByLabel("종류").selectOption({ label: "그림" });
    await form.locator('input[type="file"]').setInputFiles({ name: "new.png", mimeType: "image/png", buffer: Buffer.from(pngBase64(120, 80), "base64") });
    await form.getByLabel("그림 설명(선택)").fill("그림 아래 설명");
    await form.getByRole("button", { name: "블록 더하기" }).click();
    await noted("새 블록 ‘새 그림’을(를) 더했습니다");
    await page.waitForFunction((n) => document.querySelectorAll(".aar-doc .aar-fig").length === n + 1, figures);
    const made = blockOf("새 그림");
    expect([made.kind, made.asset.width, made.asset.height]).toEqual(["image", 120, 80]);
    // 목표와 제약
    await dialog.locator("summary", { hasText: "목표와 제약" }).click();
    await dialog.getByRole("button", { name: "목표와 제약 고치기" }).click();
    const context = dialog.locator('[aria-label="목표와 제약 고치기"]');
    await context.getByLabel("목표").fill("새 목표입니다");
    await context.getByLabel("제약(한 줄에 하나)").fill("첫째 제약\n\n둘째 제약");
    await context.getByRole("button", { name: "목표와 제약 저장" }).click();
    await noted("목표와 제약을 저장했습니다");
    expect([state.goal, state.constraints]).toEqual(["새 목표입니다", ["첫째 제약", "둘째 제약"]]);
    await page.waitForFunction(() => document.querySelector(".aar-doc")?.textContent?.includes("새 목표입니다"));
    await shot(page, "20-desk-blocks");
    await page.close();
  }, 150_000);

  test("데스크톱: 문서 관리 — 읽는 순서를 바꾸고, 배치 보드에서 끌어 옮기고 숫자로 고치고 되돌린다", async () => {
    const fileId = await newDoc("배치 문서");
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await open(page, fileId);
    const state = fake!.artifacts.get(agentA.docOf(fileId).artifactId)!;
    const live = () => state.blocks.filter((b: { archived: boolean }) => !b.archived) as { id: string; content: { title: string }; layout?: { x: number; y: number; width: number; height: number } }[];
    await page.getByRole("button", { name: /문서 관리/ }).click();
    const dialog = page.locator("dialog[open]");
    const noted = (text: string) => dialog.locator(".aar-note", { hasText: text }).waitFor({ timeout: 20_000 });
    await dialog.locator(".aar-manage__tabs .fl-chip", { hasText: /^순서·배치/ }).click();
    const titles = () => dialog.locator(".aar-order__title").allInnerTexts();
    const before = await titles();
    expect(before).toEqual(live().map((b) => b.content.title));
    expect(before.length).toBeGreaterThanOrEqual(4);
    // 순서: 둘째 블록을 위로 올린다. 본문도 그 순서로 다시 열린다.
    await expect(dialog.getByRole("button", { name: `‘${before[0]}’ 위로` }).isDisabled()).resolves.toBe(true);
    await dialog.getByRole("button", { name: `‘${before[1]}’ 위로` }).click();
    await noted("읽는 순서를 바꿨습니다.");
    const swapped = [before[1]!, before[0]!, ...before.slice(2)];
    expect(await titles()).toEqual(swapped);
    expect(live().map((b) => b.content.title)).toEqual(swapped);
    // 배치 보드: 첫 블록을 끌어 옮기면 놓을 때 저장한다.
    const first = dialog.locator(".aar-board__block").first();
    await first.scrollIntoViewIfNeeded();
    const box = (await first.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + Math.min(60, box.height - 8));
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 70, box.y + Math.min(60, box.height - 8) + 50, { steps: 6 });
    await page.mouse.up();
    await noted("배치를 저장했습니다.");
    const moved = live()[0]!.layout!;
    expect(moved.x).toBeGreaterThan(0);
    expect(moved.y).toBeGreaterThan(0);
    expect([moved.width, moved.height]).toEqual([620, 620]);
    // 숫자로 고치기: 둘째 블록의 너비·높이
    await dialog.getByRole("button", { name: new RegExp(`^블록 2 ‘${swapped[1]}’ 고르기`) }).click();
    await dialog.getByLabel("너비").fill("400");
    await dialog.getByLabel("높이").fill("300");
    await dialog.getByRole("button", { name: "배치 저장" }).click();
    await noted("배치를 저장했습니다.");
    expect(live()[1]!.layout).toEqual({ x: 0, y: 650, width: 400, height: 300 });
    await shot(page, "21-desk-board");
    // 방금 배치 되돌리기: 그 전 값(기본 자리)으로 다시 저장한다.
    await dialog.getByRole("button", { name: "방금 배치 되돌리기" }).click();
    await page.waitForFunction(() => !document.querySelector("dialog[open]")?.textContent?.includes("방금 배치 되돌리기"));
    expect(live()[1]!.layout).toEqual({ x: 0, y: 650, width: 620, height: 620 });
    // 블록의 글과 정본 판은 그대로다(배치만 바뀌었다).
    expect(state.artifact_revision).toBe(1);
    await page.close();
  }, 150_000);

  test("데스크톱: 빠른 라벨 — 고른 글에 라벨을 붙인다(목록·라벨 모드·⌥숫자). 라벨을 고치면 이 기기에 남는다", async () => {
    const fileId = await newDoc("라벨 문서");
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await open(page, fileId);
    const state = fake!.artifacts.get(agentA.docOf(fileId).artifactId)!;
    type Stored = { text: string; originalText: string; isQuickLabel?: boolean; quickLabelTip?: string };
    const drafted = () => fake!.sessions.filter((s) => s.artifact_id === state.id).flatMap((s) => (s.draft?.annotations ?? []) as Stored[]);
    // 표시 모드: 뜨는 단추의 '라벨'을 누르면 목록이 뜬다(맨 위는 '좋아요', 맨 아래는 '라벨 고치기')
    await dragSelect(page, "배경 문장 하나.");
    await page.locator(".aar-pick2", { hasText: "라벨" }).click();
    const menu = page.locator('.aar-picks--menu[role="menu"]');
    await menu.waitFor();
    await expect(menu.locator(".aar-label").first().innerText()).resolves.toBe("👍 좋아요");
    await expect(menu.locator('[role="menuitem"]').count()).resolves.toBe(12);
    await menu.getByRole("menuitem", { name: /확인이 필요해요/ }).click();
    await banner(page, "라벨 ‘🔍 확인이 필요해요’을(를) 붙였습니다.");
    await page.waitForFunction(() => document.querySelectorAll(".aar-pane .aar-row .aar-label").length === 1, null, { timeout: 15_000 });
    const first = drafted()[0]!;
    expect([first.text, first.originalText, first.isQuickLabel, first.quickLabelTip]).toEqual(["🔍 확인이 필요해요", "배경 문장 하나.", true, "추측으로 보입니다. 실제 자료를 읽고 확인한 뒤에 진행해 주세요."]);
    // 댓글 목록에 라벨로 보이고, 열면 지침이 보인다
    await pane(page).locator(".aar-row", { hasText: "확인이 필요해요" }).click();
    await expect(pane(page).locator(".aar-pane__head strong").innerText()).resolves.toBe("라벨 댓글");
    await pane(page).getByText("지침: 추측으로 보입니다.").waitFor();
    await pane(page).locator(".aar-back").click();
    // 라벨 모드: 고르면 바로 목록이 뜬다. ⌥2 는 둘째 줄(기본 라벨의 첫째)이다.
    await tool(page, "라벨");
    await dragSelect(page, "계획은 세 단계입니다.");
    await menu.waitFor();
    await page.keyboard.press("Alt+Digit2");
    await banner(page, "라벨 ‘❓ 더 설명해 주세요’을(를) 붙였습니다.");
    expect(drafted().map((a) => a.text)).toEqual(["🔍 확인이 필요해요", "❓ 더 설명해 주세요"]);
    await shot(page, "23-desk-labels");
    // 라벨 고치기: 이름을 바꿔 저장하면 목록에 바로 보이고, 다시 열어도 남는다(이 기기 브라우저)
    await dragSelect(page, "남은 일은 시험과 보고입니다.");
    await menu.getByRole("menuitem", { name: "라벨 고치기…" }).click();
    const editor = page.locator('dialog[open][aria-label="빠른 라벨 고치기"]');
    await editor.locator('[aria-label="라벨 1"]').getByLabel("이름").fill("근거를 보여 주세요");
    await editor.getByRole("button", { name: "라벨 저장" }).click();
    await page.waitForFunction(() => !document.querySelector('dialog[open][aria-label="빠른 라벨 고치기"]'));
    await page.reload();
    await page.locator(".aar-doc").waitFor({ timeout: 25_000 });
    await dragSelect(page, "남은 일은 시험과 보고입니다.");
    await menu.waitFor();
    await expect(menu.locator(".aar-label").nth(1).innerText()).resolves.toBe("❓ 근거를 보여 주세요");
    await menu.getByRole("menuitem", { name: /근거를 보여 주세요/ }).click();
    await banner(page, "라벨 ‘❓ 근거를 보여 주세요’을(를) 붙였습니다.");
    expect(drafted().map((a) => a.text)).toEqual(["🔍 확인이 필요해요", "❓ 더 설명해 주세요", "❓ 근거를 보여 주세요"]);
    // 라벨은 정본을 바꾸지 않는다
    expect(state.artifact_revision).toBe(1);
    await page.close();
  }, 150_000);

  test("데스크톱: 그림 위에 그리기 — 댓글에 붙일 그림에 표시를 그려 바꿔 끼운다. 검토 전체에 그림을 붙이고 빼고 그린다", async () => {
    const fileId = await newDoc("그리기 문서");
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await open(page, fileId);
    const state = fake!.artifacts.get(agentA.docOf(fileId).artifactId)!;
    const png = (name: string, w: number, h: number) => ({ name, mimeType: "image/png", buffer: Buffer.from(pngBase64(w, h), "base64") });
    const draw = page.locator('dialog[open][aria-label="그림 위에 그리기"]');
    const canvas = draw.locator("canvas.aar-draw__canvas");
    const closed = () => page.waitForFunction(() => !document.querySelector('dialog[open][aria-label="그림 위에 그리기"]'), null, { timeout: 20_000 });
    const stroke = async (x0: number, y0: number, x1: number, y1: number) => {
      const box = (await canvas.boundingBox())!;
      await page.mouse.move(box.x + x0 * box.width, box.y + y0 * box.height);
      await page.mouse.down();
      await page.mouse.move(box.x + x1 * box.width, box.y + y1 * box.height, { steps: 8 });
      await page.mouse.up();
    };
    // ── 댓글에 붙일 그림 ──
    await pane(page).getByRole("button", { name: "전체 댓글" }).click();
    await pane(page).locator('input[aria-label="댓글에 붙일 그림"]').setInputFiles(png("shot.png", 600, 360));
    await pane(page).locator(".aar-attach .aar-thumb img").waitFor({ timeout: 15_000 });
    await pane(page).getByRole("button", { name: "shot.png 위에 그리기" }).click();
    await canvas.waitFor({ timeout: 15_000 });
    await expect(draw.getByRole("button", { name: "표시한 그림으로 바꾸기" }).isDisabled()).resolves.toBe(true);
    // 펜, 파란 화살표, 동그라미
    await stroke(0.1, 0.15, 0.6, 0.25);
    await draw.getByRole("button", { name: "화살표" }).click();
    await draw.getByRole("button", { name: "파랑" }).click();
    await draw.getByRole("button", { name: "굵게" }).click();
    await stroke(0.2, 0.8, 0.7, 0.5);
    await draw.getByRole("button", { name: "동그라미" }).click();
    await stroke(0.55, 0.55, 0.9, 0.9);
    await expect(canvas.getAttribute("data-strokes")).resolves.toBe("3");
    await draw.getByRole("button", { name: "되돌리기" }).click();
    await expect(canvas.getAttribute("data-strokes")).resolves.toBe("2");
    await draw.getByRole("button", { name: "다시 하기" }).click();
    await expect(canvas.getAttribute("data-strokes")).resolves.toBe("3");
    // 화살표 가운데(0.45, 0.65)는 파랑으로 칠해졌다
    const pixel = await canvas.evaluate((c: HTMLCanvasElement) => [...c.getContext("2d")!.getImageData(Math.round(c.width * 0.45), Math.round(c.height * 0.65), 1, 1).data].slice(0, 3));
    expect(pixel[2]!).toBeGreaterThan(200);
    expect(pixel[0]!).toBeLessThan(120);
    await shot(page, "24-desk-draw");
    await draw.getByLabel("그림 이름").fill("표시한 화면");
    await draw.getByRole("button", { name: "표시한 그림으로 바꾸기" }).click();
    await closed();
    // 원래 그림 자리에 표시한 그림 하나만 남는다
    await expect(pane(page).locator(".aar-attach .aar-thumb").count()).resolves.toBe(1);
    await expect(pane(page).locator(".aar-attach .aar-thumb__name").innerText()).resolves.toBe("표시한 화면.png");
    await pane(page).getByLabel("댓글", { exact: true }).fill("표시한 그림을 봐 주세요");
    await pane(page).getByLabel("댓글", { exact: true }).press("Enter");
    await answered(page, 1, "시험 답: 표시한 그림을 봐 주세요");
    const sent = fake!.rows.find((r) => r.annotation.text === "표시한 그림을 봐 주세요")!.annotation.images as { name: string; path: string }[];
    expect(sent.map((x) => x.name)).toEqual(["표시한 화면.png"]);
    // ── 검토 전체에 붙이는 그림 ──
    const session = fake!.sessions.find((s) => s.artifact_id === state.id)!;
    const attached = () => ((session.draft?.globalAttachments ?? []) as { name: string; path: string }[]).map((x) => x.name);
    await page.getByRole("button", { name: "검토 첨부" }).click();
    const attach = page.locator('dialog[open][aria-label="검토에 붙인 그림"]');
    const thumbs = (n: number) => page.waitForFunction((count) => document.querySelectorAll('dialog[open][aria-label="검토에 붙인 그림"] .aar-thumb').length === count, n, { timeout: 20_000 });
    await attach.getByText("붙인 그림이 없습니다.").waitFor({ timeout: 15_000 });
    await attach.locator('input[aria-label="검토에 붙일 그림"]').setInputFiles([png("a.png", 300, 200), png("b.png", 320, 200)]);
    await thumbs(2);
    expect(attached()).toEqual(["a.png", "b.png"]);
    // 그사이 다른 창이 초안을 저장했으면 덮지 않고 다시 읽은 목록을 보인다
    session.draft = { ...session.draft, editedMarkdown: "다른 창의 초안" };
    session.draft_revision++;
    await attach.getByRole("button", { name: "a.png 빼기" }).click();
    await attach.locator(".aar-error", { hasText: "그사이 다른 화면이 초안을 저장했습니다" }).waitFor({ timeout: 15_000 });
    expect(attached()).toEqual(["a.png", "b.png"]);
    await attach.getByRole("button", { name: "a.png 빼기" }).click();
    await thumbs(1);
    expect(attached()).toEqual(["b.png"]);
    expect(session.draft.editedMarkdown).toBe("다른 창의 초안");
    // 붙인 그림 위에 그려 바꿔 끼운다
    const before = (session.draft.globalAttachments as { path: string }[])[0]!.path;
    await attach.getByRole("button", { name: "b.png 위에 그리기" }).click();
    await canvas.waitFor({ timeout: 15_000 });
    await stroke(0.2, 0.2, 0.8, 0.8);
    await draw.getByRole("button", { name: "표시한 그림으로 바꾸기" }).click();
    await closed();
    await thumbs(1);
    const after = session.draft.globalAttachments as { name: string; path: string }[];
    expect(after.map((x) => x.name)).toEqual(["b.png"]);
    expect(after[0]!.path).not.toBe(before);
    await attach.getByRole("button", { name: "닫기" }).click();
    await page.getByRole("button", { name: "검토 첨부 1개" }).waitFor();
    // 검토 제출 창에도 붙인 그림 수가 보인다
    await page.getByRole("button", { name: "검토 제출" }).click();
    await page.locator("dialog[open]", { hasText: "붙인 그림 1개" }).waitFor({ timeout: 15_000 });
    await page.close();
  }, 180_000);

  test("데스크톱: 문서에 묻기 — 대화를 갈라 이어 묻고, AI 가 구한 허락에 허용·거절로 답한다", async () => {
    const fileId = await newDoc("가르기 문서");
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await open(page, fileId);
    const state = fake!.artifacts.get(agentA.docOf(fileId).artifactId)!;
    const mine = () => fake!.chats.filter((c) => c.artifact_id === state.id);
    await pane(page).getByRole("button", { name: "문서에 묻기" }).click();
    const chat = page.locator('.aar-pane[aria-label="문서에 묻기"]');
    const answeredWith = (text: string) => page.waitForFunction((s) => {
      const last = [...document.querySelectorAll('.aar-pane[aria-label="문서에 묻기"] .aar-chat')].at(-1);
      return Boolean(last && !last.querySelector(".aar-msg__writing") && (last.querySelector(".aar-msg[data-ai]")?.textContent ?? "").includes(s));
    }, text, { timeout: 20_000 });
    const send = async (text: string) => {
      await chat.locator("textarea").fill(text);
      await chat.locator("textarea").press("Enter");
    };
    await send("첫 질문");
    await answeredWith("문서 답: 첫 질문");
    await send("둘째 질문");
    await answeredWith("문서 답: 둘째 질문");
    // 첫 질문의 답까지 복사해 새 대화로 가른다. 원래 대화는 그대로다.
    await chat.locator(".aar-chat").first().getByRole("button", { name: /의 답까지 복사해 새 대화로/ }).click();
    await chat.locator("[data-branched]").waitFor({ timeout: 15_000 });
    await expect(chat.locator(".aar-chat").count()).resolves.toBe(1);
    expect(mine()).toHaveLength(2);
    expect([mine()[1]!.origin.conversationId, mine()[1]!.origin.point, mine()[1]!.current]).toEqual([mine()[0]!.id, "answer", true]);
    await send("갈라서 묻기");
    await answeredWith("문서 답: 갈라서 묻기");
    expect(mine().map((c) => c.entries.length)).toEqual([2, 2]);
    expect(mine()[1]!.entries.map((e: { question: { prompt: string } }) => e.question.prompt)).toEqual(["첫 질문", "갈라서 묻기"]);
    // 원래 대화로 돌아간다
    await chat.getByRole("button", { name: "원래 대화 보기" }).click();
    await chat.locator(".aar-chat", { hasText: "문서 답: 둘째 질문" }).waitFor({ timeout: 15_000 });
    await expect(chat.locator("[data-branched]").count()).resolves.toBe(0);
    // AI 가 허락을 구하면 답이 멈추고 카드가 뜬다. 허용하면 이어진다.
    await send("권한이 필요한 질문");
    const card = chat.locator("[data-permission]");
    await card.waitFor({ timeout: 15_000 });
    const asked = await card.innerText();
    for (const part of ["AI 가 허락을 구합니다", "Bash", "명령 실행", "ls docs"]) expect(asked).toContain(part);
    await expect(chat.getByRole("button", { name: "답 멈춤" }).count()).resolves.toBe(1);
    await shot(page, "25-desk-permission");
    await card.getByRole("button", { name: "허용" }).click();
    await answeredWith("허락을 받아 확인했습니다. 문서 답: 권한이 필요한 질문");
    await expect(card.count()).resolves.toBe(0);
    // 거절하면 그 도구 없이 답한다
    await send("권한을 거절할 질문");
    await card.waitFor({ timeout: 15_000 });
    await card.getByRole("button", { name: "거절" }).click();
    await answeredWith("허락을 받지 못해 확인하지 않았습니다.");
    await expect(card.count()).resolves.toBe(0);
    // 대화는 정본도 초안도 바꾸지 않는다
    expect(state.artifact_revision).toBe(1);
    expect(fake!.sessions.find((s) => s.artifact_id === state.id)!.draft).toBeNull();
    await page.close();
  }, 150_000);

  test("데스크톱: 본문 고치기의 서식 막대 — 굵게·기울임(단축키)·인용과 미리 보기. 저장하면 초안으로 남는다", async () => {
    const fileId = await newDoc("서식 문서");
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await open(page, fileId);
    const state = fake!.artifacts.get(agentA.docOf(fileId).artifactId)!;
    await page.getByRole("button", { name: "본문 고치기" }).click();
    const input = page.getByLabel("본문(마크다운)");
    await input.waitFor();
    const bar = page.getByRole("toolbar", { name: "서식" });
    const select = (needle: string) => input.evaluate((el, s) => {
      const area = el as HTMLTextAreaElement;
      const at = area.value.indexOf(s);
      area.focus();
      area.setSelectionRange(at, at + s.length);
    }, needle);
    // 굵게: 고른 글을 감싸고, 다시 누르면 벗긴다
    await select("배경 문장 하나.");
    await bar.getByRole("button", { name: "굵게" }).click();
    await expect(input.inputValue()).resolves.toContain("**배경 문장 하나.** 배경 문장 둘은");
    await bar.getByRole("button", { name: "굵게" }).click();
    await expect(input.inputValue()).resolves.toContain("\n배경 문장 하나. 배경 문장 둘은");
    // 단축키로 기울임
    await select("계획은 세 단계입니다.");
    await page.keyboard.press("ControlOrMeta+i");
    await expect(input.inputValue()).resolves.toContain("*계획은 세 단계입니다.* 단계마다 확인합니다.");
    // 인용: 고른 줄 전체에 붙는다
    await select("남은 일은 시험과 보고입니다.");
    await bar.getByRole("button", { name: "인용" }).click();
    await expect(input.inputValue()).resolves.toContain("\n> 남은 일은 시험과 보고입니다.");
    // 미리 보기: 옆에 그려 보인다
    await bar.getByRole("button", { name: "미리 보기" }).click();
    const view = page.getByRole("region", { name: "미리 보기" });
    await expect(view.locator("em").innerText()).resolves.toBe("계획은 세 단계입니다.");
    await expect(view.locator("blockquote").count()).resolves.toBe(1);
    const [a, b] = [(await input.boundingBox())!, (await view.boundingBox())!];
    expect(b.x).toBeGreaterThan(a.x + a.width - 2);
    await shot(page, "27-desk-format");
    await page.getByRole("button", { name: "초안 저장" }).click();
    await banner(page, "고친 본문을 초안으로 저장했습니다.");
    const saved = fake!.sessions.find((s) => s.artifact_id === state.id)!.draft.editedMarkdown as string;
    expect(saved).toContain("*계획은 세 단계입니다.*");
    expect(saved).toContain("> 남은 일은 시험과 보고입니다.");
    expect(state.artifact_revision).toBe(1);
    await page.close();
  }, 120_000);

  test("데스크톱: 도식을 그림으로 그린다(본문에 끼우지 않고 그림으로만). 원문도 보고, 틀린 도식은 원문으로 보인다", async () => {
    const markdown = [
      "도식이 있는 문서입니다.", "", "## 흐름", "", "```mermaid", "graph TD", "  A[시작] --> B[끝]", "```", "",
      "## 틀린 도식", "", "```mermaid", "이것은 도식이 아닙니다 -->> ((", "```", "",
      "## 꾸민 도식", "", "```mermaid", "graph LR", "  X[\"<img src=x onerror='window.__aaHacked=true'>글\"] --> Y[끝]", "```", "", "끝 문장.",
    ].join("\n");
    const fileId = (await agentA.createDoc(project.id, { title: "도식 그림 문서", markdown })).fileId;
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const requested: string[] = [];
    page.on("request", (r) => requested.push(new URL(r.url()).pathname));
    await open(page, fileId);
    const diagrams = page.locator(".aar-diagram");
    await expect(diagrams.count()).resolves.toBe(3);
    await page.waitForFunction(() => [...document.querySelectorAll(".aar-diagram")].every((d) => d.getAttribute("data-state") !== "drawing"), null, { timeout: 60_000 });
    // 첫 도식: 그림으로 그려졌다(이 브라우저 안의 그림 주소)
    await expect(diagrams.nth(0).getAttribute("data-state")).resolves.toBe("drawn");
    await page.waitForFunction(() => {
      const img = document.querySelector<HTMLImageElement>(".aar-diagram img");
      return Boolean(img && img.complete && img.naturalWidth > 20 && img.naturalHeight > 20);
    }, null, { timeout: 20_000 });
    await expect(diagrams.nth(0).locator("img").getAttribute("src")).resolves.toMatch(/^blob:/);
    // 틀린 도식: 원문을 글로 보이고 까닭을 적는다
    await expect(diagrams.nth(1).getAttribute("data-state")).resolves.toBe("failed");
    await expect(diagrams.nth(1).locator(".aar-diagram__code").innerText()).resolves.toContain("이것은 도식이 아닙니다");
    await expect(diagrams.nth(1).innerText()).resolves.toContain("도식을 그리지 못해 원문을 보입니다");
    // 본문에 svg·iframe·script 를 끼우지 않고, 도식 글의 HTML 은 돌지 않는다. 그리는 부품이 남긴 임시 요소도 없다.
    await expect(page.locator(".aar-doc svg, .aar-doc iframe, .aar-doc script, .aar-doc foreignObject").count()).resolves.toBe(0);
    await expect(page.evaluate(() => (window as unknown as { __aaHacked?: boolean }).__aaHacked)).resolves.toBeUndefined();
    await expect(page.locator('[id^="aar-diagram-"], [id^="daar-diagram-"]').count()).resolves.toBe(0);
    // 원문 보기 ↔ 그림 보기
    await diagrams.nth(0).getByRole("button", { name: "원문 보기" }).click();
    await expect(diagrams.nth(0).locator(".aar-diagram__code").innerText()).resolves.toContain("A[시작] --> B[끝]");
    await diagrams.nth(0).getByRole("button", { name: "그림 보기" }).click();
    await diagrams.nth(0).locator("img").waitFor();
    await shot(page, "26-desk-diagram");
    // 그리는 부품은 화면 문서에서 돌지 않는다: 출처 없는 칸(sandbox) 하나에서만 돌고, 화면에는 부품이 없다.
    await expect(page.evaluate(() => "mermaid" in window)).resolves.toBe(false);
    const frames = await page.locator("iframe").evaluateAll((list) => list.map((f) => [f.getAttribute("src"), f.getAttribute("sandbox")]));
    expect(frames).toEqual([["/vendor/diagram-frame", "allow-scripts"]]);
    expect(requested.filter((p) => p.startsWith("/vendor/")).sort()).toEqual(["/vendor/diagram-frame", "/vendor/diagram-frame.js", "/vendor/mermaid.min.js"]);
    // 도식 글에 든 그림 주소(<img src=x>)는 어디에서도 불리지 않았다
    expect(requested.filter((p) => p === "/x" || p.endsWith("/x"))).toEqual([]);
    // 칸의 문서는 스크립트 두 개만 허락하고 나머지(그림·연결·다른 칸)는 막는다
    const frameRes = await fetch(`${base}/vendor/diagram-frame`);
    const csp = frameRes.headers.get("content-security-policy") ?? "";
    for (const part of ["sandbox allow-scripts", "default-src 'none'", "img-src data:", "frame-ancestors 'self'"]) expect(csp).toContain(part);
    expect(csp).not.toContain("allow-same-origin");
    const script = await fetch(`${base}/vendor/mermaid.min.js`, { method: "HEAD" });
    expect([script.status, script.headers.get("content-type")]).toEqual([200, "text/javascript; charset=utf-8"]);
    expect((await fetch(`${base}/vendor/diagram-frame`, { method: "POST" })).status).toBe(405);
    await page.close();
  }, 150_000);

  test("폰 폭: 문서 관리의 순서·배치는 순서만 바꾸고 넘치지 않는다", async () => {
    const fileId = await newDoc("폰 배치 문서");
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    await open(page, fileId);
    const state = fake!.artifacts.get(agentA.docOf(fileId).artifactId)!;
    await page.getByRole("button", { name: /문서 관리/ }).tap();
    const dialog = page.locator("dialog[open]");
    await dialog.locator(".aar-manage__tabs .fl-chip", { hasText: /^순서·배치/ }).tap();
    await dialog.getByText("배치 보드는 넓은 화면에서 씁니다.").waitFor();
    await expect(dialog.locator(".aar-board").count()).resolves.toBe(0);
    const titles = await dialog.locator(".aar-order__title").allInnerTexts();
    await dialog.getByRole("button", { name: `‘${titles[0]}’ 아래로` }).tap();
    await dialog.locator(".aar-note", { hasText: "읽는 순서를 바꿨습니다." }).waitFor({ timeout: 20_000 });
    expect(state.blocks.map((b: { content: { title: string } }) => b.content.title).slice(0, 2)).toEqual([titles[1], titles[0]]);
    await expect(page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).resolves.toBe(true);
    for (const b of await dialog.locator(".aar-order button").all()) {
      const box = (await b.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
    }
    await dialog.locator(".aar-manage__tabs .fl-chip", { hasText: /^정본/ }).tap();
    await dialog.locator("summary", { hasText: "새 블록 더하기" }).tap();
    await expect(page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).resolves.toBe(true);
    await shot(page, "22-phone-order");
    await page.close();
  }, 120_000);

  test("폰 폭: 도구 막대·본문 고치기·문서에 묻기가 넘치지 않는다", async () => {
    const fileId = await newDoc("폰 도구 문서");
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    await open(page, fileId);
    const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    await expect(fits()).resolves.toBe(true);
    await expect(page.locator(".aar-seg__btn").count()).resolves.toBe(6);
    for (const b of await page.locator(".aar-bar button").all()) {
      const box = (await b.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
    }
    await page.getByRole("button", { name: "본문 고치기" }).tap();
    const input = page.getByLabel("본문(마크다운)");
    await input.waitFor();
    const box = (await input.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    await expect(fits()).resolves.toBe(true);
    // 서식 막대와 미리 보기도 좁은 화면에 맞는다
    await page.getByRole("toolbar", { name: "서식" }).getByRole("button", { name: "미리 보기" }).tap();
    await page.getByRole("region", { name: "미리 보기" }).waitFor();
    await expect(fits()).resolves.toBe(true);
    for (const b of await page.getByRole("toolbar", { name: "서식" }).locator("button").all()) {
      const at = (await b.boundingBox())!;
      expect(at.x).toBeGreaterThanOrEqual(0);
      expect(at.x + at.width).toBeLessThanOrEqual(390);
    }
    await shot(page, "18-phone-editor");
    await page.getByRole("button", { name: "고치기 그만" }).tap();
    await page.getByRole("button", { name: "검토 첨부" }).tap();
    await page.locator('dialog[open][aria-label="검토에 붙인 그림"]').getByText("붙인 그림이 없습니다.").waitFor({ timeout: 15_000 });
    await expect(fits()).resolves.toBe(true);
    await page.locator('dialog[open][aria-label="검토에 붙인 그림"]').getByRole("button", { name: "닫기" }).tap();
    await page.locator(".aar-bar__comments").tap();
    await page.locator(".aar-pane").getByRole("button", { name: "문서에 묻기" }).tap();
    await page.locator('.aar-pane[aria-label="문서에 묻기"] textarea').waitFor();
    await expect(fits()).resolves.toBe(true);
    await shot(page, "19-phone-chat");
    await page.close();
  }, 120_000);

  test("데스크톱: 도식 갈래별로 누를 부분을 찾는다(흐름도의 묶음 · 순서도 · 상태도 · 클래스도 · 관계도). 새 댓글이 막힌 때에는 누를 부분이 없다", async () => {
    const markdown = [
      "갈래별 도식입니다.", "",
      "```mermaid", "graph LR", "  subgraph G1 [묶음]", "    A[시작] --> B[끝]", "  end", "  user_login --> check_auth", "```", "",
      "```mermaid", "sequenceDiagram", "  participant U as 대표", "  participant S as 서버", "  U->>S: 요청", "  Note over U,S: 확인 메모", "  loop 반복", "    S-->>U: 응답", "  end", "```", "",
      "```mermaid", "stateDiagram-v2", "  [*] --> Idle", "  Idle --> Busy: 시작", "  Busy --> [*]", "```", "",
      "```mermaid", "classDiagram", "  class Animal", "  class Dog", "  Animal <|-- Dog", "```", "",
      "```mermaid", "erDiagram", "  CUSTOMER ||--o{ ORDER : places", "```", "",
      "```mermaid", "pie title 비율", "  \"가\" : 40", "  \"나\" : 60", "```", "", "끝 문장.",
    ].join("\n");
    const fileId = (await agentA.createDoc(project.id, { title: "도식 갈래 문서", markdown })).fileId;
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await open(page, fileId);
      await drawn(page);
      const diagrams = page.locator(".aar-diagram");
      await expect(diagrams.count()).resolves.toBe(6);
      const partsOf = (i: number) => diagrams.nth(i).locator(".aar-diagram__part").evaluateAll((list) => [...new Set(list.map((b) => `${b.getAttribute("data-kind")}:${b.getAttribute("data-part")}:${b.getAttribute("title")}`))].sort());
      // 흐름도: 노드·선·묶음. 밑줄이 든 이름의 선도 양 끝으로 가른다.
      await expect(partsOf(0)).resolves.toEqual(["cluster:G1:묶음", "edge:A→B:A → B", "edge:user_login→check_auth:user_login → check_auth", "node:A:시작", "node:B:끝", "node:check_auth:check_auth", "node:user_login:user_login"]);
      // 순서도: 참여자는 이름, 메시지·메모·틀은 차례 번호
      await expect(partsOf(1)).resolves.toEqual(["cluster:frame-1:loop [반복]", "edge:msg-1:요청", "edge:msg-2:응답", "node:S:서버", "node:U:대표", "node:note-1:확인 메모"]);
      // 상태도: 상태와 전이(시작·끝 점은 부분이 아니다)
      const state = await partsOf(2);
      expect(state.filter((p) => p.startsWith("node:"))).toEqual(["node:Busy:Busy", "node:Idle:Idle"]);
      expect(state.filter((p) => p.startsWith("edge:")).length).toBe(3);
      expect(state.some((p) => p.endsWith(":시작"))).toBe(true);
      // 클래스도와 관계도
      await expect(partsOf(3)).resolves.toEqual(["edge:Animal→Dog:Animal → Dog", "node:Animal:Animal", "node:Dog:Dog"]);
      await expect(partsOf(4)).resolves.toEqual(["edge:CUSTOMER→ORDER:places", "node:CUSTOMER:CUSTOMER", "node:ORDER:ORDER"]);
      // 부분을 가르지 않는 도식(원그래프)은 도식 전체에만 단다
      await expect(partsOf(5)).resolves.toEqual([]);
      await diagrams.nth(5).scrollIntoViewIfNeeded();
      const layer = (await diagrams.nth(5).locator(".aar-diagram__layer").boundingBox())!;
      await page.mouse.click(layer.x + layer.width / 2, layer.y + layer.height / 2);
      await expect(pane(page).locator(".aar-pane__head strong").innerText()).resolves.toBe("도식 전체에 댓글");
      await expect(pane(page).locator(".aar-quote").innerText()).resolves.toBe("pie title 비율");
      await pane(page).getByRole("button", { name: "댓글 목록으로" }).click();
      // 순서도의 메시지에 단 댓글: 자리는 차례 번호와 글, 문서 줄은 그 메시지 줄이다
      await diagrams.nth(1).scrollIntoViewIfNeeded();
      await diagrams.nth(1).locator('.aar-diagram__part[data-kind="edge"][data-part="msg-2"]').first().click();
      await expect(pane(page).locator(".aar-quote").innerText()).resolves.toBe("응답");
      await pane(page).getByLabel("댓글", { exact: true }).fill("응답은 언제 오나요?");
      await pane(page).getByLabel("댓글", { exact: true }).press("Enter");
      await answered(page, 1, "시험 답: 응답은 언제 오나요?");
      const state2 = fake!.artifacts.get(agentA.docOf(fileId).artifactId)!;
      const stored = fake!.sessions.filter((x) => x.artifact_id === state2.id).flatMap((x) => (x.draft?.annotations ?? []) as { originalText: string; diagramAnchor?: unknown }[]);
      // 문서 줄은 Agent-A 가 돌려준 본문(블록 사이에 빈 줄을 둔다)에서 센다
      const line = (await review.open(fileId)).markdown.split("\n").indexOf("    S-->>U: 응답") + 1;
      expect(line).toBeGreaterThan(0);
      expect(stored.map((a) => [a.originalText, a.diagramAnchor])).toEqual([["응답", { v: 1, family: "sequence", kind: "edge", id: "msg-2", from: "S", to: "U", label: "응답", sourceLine: [line, line] }]]);
      await expect(diagrams.nth(1).locator(".aar-diagram__mark").count()).resolves.toBe(1);
      await shot(page, "34-desk-diagram-families");
      // 원래 화면(다른 창)이 남긴 자리도 그 부분에 표시한다. 이름이 바뀌어 못 찾는 자리는 목록에만 남는다.
      await otherWindowSaves((await sessionOf(page))!, { annotations: [...stored,
        { id: "native-dg-1", blockId: "block-9", type: "COMMENT", text: "원래 화면의 도식 댓글", originalText: "끝", createdA: Date.now(), diagramAnchor: { v: 1, family: "flowchart", kind: "node", id: "B", label: "끝", sourceLine: [6, 6] } },
        { id: "native-dg-2", blockId: "block-9", type: "COMMENT", text: "사라진 부분의 댓글", originalText: "옛 노드", createdA: Date.now(), diagramAnchor: { v: 1, family: "flowchart", kind: "node", id: "Z", label: "옛 노드", sourceLine: null } }] });
      await page.reload();
      await page.locator(".aar-doc").waitFor({ timeout: 25_000 });
      await drawn(page);
      await page.waitForFunction(() => document.querySelectorAll(".aar-diagram__mark").length === 2, null, { timeout: 20_000 });
      await expect(diagrams.nth(0).locator(".aar-diagram__mark").count()).resolves.toBe(1);
      await pane(page).locator(".aar-row", { hasText: "사라진 부분의 댓글" }).waitFor();
      await diagrams.nth(0).locator(".aar-diagram__mark").click();
      await expect(pane(page).locator(".aar-msg").first().innerText()).resolves.toContain("원래 화면의 도식 댓글");
      // 새 댓글이 막힌 때(초안 보존 규약을 모르는 Agent-A): 누를 부분이 없고, 남은 표시는 읽을 수 있다
      fake!.setDraftProtocol(1);
      await page.reload();
      await page.locator(".aar-doc").waitFor({ timeout: 25_000 });
      await drawn(page);
      await page.waitForFunction(() => document.querySelectorAll(".aar-diagram__mark").length === 2, null, { timeout: 20_000 });
      await expect(page.locator(".aar-diagram__part").count()).resolves.toBe(0);
      const blockedLayer = (await diagrams.nth(5).locator(".aar-diagram__img").boundingBox())!;
      await diagrams.nth(5).scrollIntoViewIfNeeded();
      await page.mouse.click(blockedLayer.x + 5, blockedLayer.y + 5);
      await page.waitForTimeout(300);
      await expect(pane(page).locator(".aar-pane__head strong").innerText()).resolves.not.toContain("도식 전체에 댓글");
    } finally {
      fake!.setDraftProtocol(2);
      await page.close();
    }
  }, 240_000);
});
