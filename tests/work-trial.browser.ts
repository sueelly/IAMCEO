// 업무 체험판을 실제 브라우저로 따라간다(A1~A8 화면 경로). 체험판 서버·임시 DB·테스트 실행기만 쓴다.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { WorkService } from "../server/work.ts";
import { startWorkServer, type WorkServer } from "../server/work-http.ts";

const CODE = "trial-browser-code";
const SHOTS = process.env.IAMCEO_E2E_SHOTS ?? mkdtempSync(join(tmpdir(), "work-trial-shots-"));
mkdirSync(SHOTS, { recursive: true });
let service: WorkService;
let server: WorkServer;
let browser: Browser;
const outside: string[] = [];

beforeAll(async () => {
  service = new WorkService({ dbPath: join(mkdtempSync(join(tmpdir(), "work-trial-web-")), "w.db"), delayMs: 300 });
  server = await startWorkServer({ service, accessCode: CODE, port: 0 });
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
  await server?.stop();
  service?.close();
  console.log(`shots: ${SHOTS}`);
});

async function page(width = 1280, height = 900): Promise<Page> {
  const p = await browser.newPage({ viewport: { width, height } });
  p.on("request", (r) => { if (!r.url().startsWith(server.url) && !r.url().startsWith("data:")) outside.push(r.url()); });
  return p;
}
const nav = (p: Page, name: RegExp | string) => p.getByRole("navigation").getByRole("link", { name });
const task = (p: Page, title: string) => p.locator(".task", { hasText: title });
async function count(p: Page, sel: string, n: number) {
  const end = Date.now() + 10_000;
  while ((await p.locator(sel).count()) !== n) { if (Date.now() > end) throw new Error(`${sel} 개수 ${await p.locator(sel).count()} ≠ ${n}`); await Bun.sleep(50); }
}
const shot = (p: Page, name: string) => p.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });

describe("업무 체험판 화면", () => {
  test("PC: 접수·탐색·후속 지시·내 차례·교체·재개·협업·Hindsight", async () => {
    const p = await page();
    await p.goto(`${server.url}/#code=${CODE}`);
    await p.getByText("로컬 체험판").waitFor();
    await p.getByText("외부 모델 호출 0건").waitFor();
    await count(p, ".task", 5);
    expect(p.url()).not.toContain(CODE); // 코드는 주소에서 지운다
    await shot(p, "01-all");

    // A2 탐색
    await nav(p, /체험 프로젝트/).click();
    await count(p, ".task", 3);
    await nav(p, /본사 일반업무/).click();
    await count(p, ".task", 2);
    await nav(p, /출시 준비/).click();
    await count(p, ".task", 3);
    await p.getByText("총괄 종합").waitFor();
    await p.getByText("선행 결과를 기다리는 중").waitFor();
    await shot(p, "02-goal");

    // 새 업무(역할 선택 없이)
    await p.getByRole("button", { name: "+ 새 업무" }).click();
    await p.getByLabel("업무 제목").fill("협력사 미팅 일정 조율");
    await p.getByLabel("첫 지시").fill("다음 주 가능한 시간을 정리해 주세요");
    await p.getByRole("button", { name: "접수" }).click();
    await p.getByRole("heading", { name: /협력사 미팅 일정 조율/ }).waitFor();
    await p.getByText("새 업무를 접수했습니다").waitFor({ timeout: 10_000 });
    await p.reload();
    await p.getByRole("heading", { name: /협력사 미팅 일정 조율/ }).waitFor();

    // A3: 느린 지시를 보내고 바로 다른 업무로 옮겨 보낸다
    await p.goto(`${server.url}/#/all`);
    await task(p, "대화 구조 검토").click();
    await p.getByLabel("대화 구조 검토에 보낼 지시").fill("둘째 안을 보강해 주세요. 천천히");
    await p.getByRole("button", { name: "보내기" }).click();
    await p.goto(`${server.url}/#/all`);
    await task(p, "출장 동선 조사").click();
    await p.getByLabel("출장 동선 조사에 보낼 지시").fill("숙소도 같이 봐 주세요");
    await p.getByRole("button", { name: "보내기" }).click();
    await p.getByText("후속 지시를 받았습니다: \"숙소도 같이 봐 주세요\"").waitFor({ timeout: 10_000 });
    await Bun.sleep(1500);
    await expect(p.locator(".thread").textContent()).resolves.not.toContain("보강");
    await p.goto(`${server.url}/#/all`);
    await task(p, "대화 구조 검토").click();
    await p.getByRole("button", { name: "대화 구조 검토 — 둘째 안 보강" }).waitFor({ timeout: 10_000 });
    await shot(p, "03-structure");

    // A4: 내 차례에서 답하고 결과 자료로 돌아간다
    await nav(p, /^내 차례/).click();
    const quoteCard = p.locator(".decision--open", { hasText: "견적 조건을 골라 주세요" });
    await quoteCard.getByRole("link", { name: "견적 비교" }).waitFor();
    await shot(p, "04-inbox");
    await quoteCard.getByRole("button", { name: "가격 우선" }).click();
    await p.locator(".decision", { hasText: "견적 조건을 골라 주세요" }).getByText("답함").waitFor();
    await p.locator(".decision", { hasText: "견적 조건을 골라 주세요" }).getByRole("link", { name: "견적 비교" }).click();
    await p.getByRole("button", { name: "견적 비교표 — 가격 우선" }).click({ timeout: 10_000 });
    await p.getByRole("dialog").getByText("출처 업무").waitFor();
    await p.getByRole("dialog").getByRole("button", { name: "닫기" }).click();

    // A6: 담당 역할·모델 교체 → 새 실행, 완료 → 재개
    await p.getByLabel("담당 역할").selectOption({ label: "조사" });
    await p.getByText(/담당 역할을 '구매' → '조사'로/).waitFor();
    await p.getByLabel("모델(테스트)").selectOption("테스트-정밀");
    await p.locator(".run", { hasText: "모델 변경" }).getByText("지금 실행").waitFor();
    await count(p, ".run", 3);
    await p.getByRole("button", { name: "완료" }).click();
    await p.getByRole("heading", { name: /견적 비교/ }).getByText("완료").waitFor();
    await p.getByRole("button", { name: "재개" }).click();
    await p.getByText("완료된 업무를 다시 열었습니다").waitFor();
    await shot(p, "05-quote");

    // A7: 구조 검토 완료 → 소개 글이 이어지고 협업 질의·답이 남는다
    await p.goto(`${server.url}/#/all`);
    await task(p, "대화 구조 검토").click();
    await p.getByRole("button", { name: "완료" }).click();
    await p.goto(`${server.url}/#/all`);
    await task(p, "소개 글 작성").click();
    await p.getByRole("button", { name: "소개 글 초안" }).waitFor({ timeout: 15_000 });
    await p.locator(".msg--collab_q").first().waitFor();
    await p.locator(".msg--collab_a").first().waitFor();
    await shot(p, "06-intro");

    // A8: Hindsight 는 연결 전, 완료된 업무의 기록이 '연결 전'으로 남는다
    await nav(p, "Hindsight 연결").click();
    await p.getByText("연결 전(미설정) · 외부 호출 없음").waitFor();
    await expect(p.locator(".tbl tbody tr").count()).resolves.toBeGreaterThanOrEqual(4);
    await shot(p, "07-hindsight");
    expect(outside).toEqual([]);
    await p.close();
  }, 180_000);

  test("폰 폭: 메뉴·업무 대화·입력칸을 쓸 수 있다", async () => {
    const p = await page(390, 844);
    await p.goto(`${server.url}/#/all`);
    await p.evaluate((c) => localStorage.setItem("iamceo.trial.code", c), CODE);
    await p.reload();
    await p.locator(".task").first().waitFor();
    await p.getByRole("button", { name: "메뉴" }).click();
    await nav(p, /본사 일반업무/).click();
    await task(p, "출장 동선 조사").click();
    const box = await p.getByLabel("출장 동선 조사에 보낼 지시").boundingBox();
    expect(box && box.width > 200).toBe(true);
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await shot(p, "08-phone-task");
    await p.close();
  }, 60_000);

  test("A1: 체험판 코드가 없으면 API 가 막힌다", async () => {
    expect((await fetch(`${server.url}/api/state`)).status).toBe(401);
    expect((await fetch(`${server.url}/api/state`, { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await fetch(`${server.url}/api/health`)).status).toBe(200);
  });
});
