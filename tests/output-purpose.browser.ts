import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import { startServer } from "../server/http.ts";
import type { Bus } from "../server/bus.ts";
import { fixture } from "./fixtures/harness-fixture.ts";

setDefaultTimeout(60_000);
const taskName = "IAMCEO 로그인 재개 오류의 입력 수신과 세션 종료 기록을 대조해 운영 서버 재시작 없이 실패 원인을 조사한다";
const reportTitle = "로그인 입력 수신을 확인했고, 원인 진단에는 세션 종료 기록이 더 필요합니다";
const reportBody = "전달 기록 3건의 입력 수신을 확인했습니다. 세션 종료 기록은 아직 확보하지 못했습니다. 운영 서버는 재시작하지 않았습니다.";
const now = ["로그인 재개 오류 조사는 세션 종료 기록 확보를 기다립니다.", "입력 수신 기록 3건은 확인했습니다.", "진단서를 작성했고 조사 범위를 남겼습니다.", "세션 기록이 없어 실패 원인은 미확인입니다.", "담당 직원은 제공받은 기록의 시점을 대조할 예정입니다.", "총괄은 자료 제공 결정을 기다립니다.", "조건: 익명화한 기록이 제공되기 전에는 운영 서버를 재시작하지 않습니다."].join("\n\n");

async function withScreens(check: (page: Page, f: ReturnType<typeof fixture>, base: string, taskId: string, width: number, shot: (name: string) => Promise<void>) => Promise<void>) {
  const f = fixture();
  const task = f.store.saveTask({ projectId: f.project.id, memberId: f.worker.id, who: f.worker.name, title: taskName }).task;
  f.orch.setProjectNow(f.project.id, now);
  f.orch.setMemberStatus(f.worker, "로그인 재개 실패의 입력 수신 기록 3건을 대조했습니다.", "세션 기록이 제공되면 철수가 종료 시점과 재개 요청을 대조합니다.");
  const bus = (f.store as unknown as { bus: Bus }).bus;
  const server = await startServer({ config: f.config, store: f.store, bus, orch: f.orch, delivery: f.orch.deliveryRecovery });
  let browser;
  try {
    browser = await chromium.launch();
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.goto(server.urls[0]! + "/api/health");
      await page.evaluate(code => localStorage.setItem("iamceo.accessCode", code), f.config.accessCode);
      const shot = async (name: string) => {
        expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
        if (process.env.IAMCEO_E2E_SHOTS) {
          mkdirSync(process.env.IAMCEO_E2E_SHOTS, { recursive: true, mode: 0o700 });
          await page.screenshot({ path: join(process.env.IAMCEO_E2E_SHOTS, `${name}-${width}.png`), fullPage: true });
        }
      };
      await check(page, f, server.urls[0]!, task.id, width, shot);
      await page.close();
    }
  } finally {
    await browser?.close();
    await server.stop();
  }
}

test("지금 상황의 마지막 조건까지 펼쳐 보이고 팀에서는 현재 보고와 다음 행동을 구분한다", async () => {
  await withScreens(async (page, f, base, taskId, width, shot) => {
    await page.goto(`${base}/#/p/${f.project.id}/home`);
    const body = page.locator(".hm-now__body");
    await body.waitFor();
    expect(await body.innerText()).toBe(now);
    expect(await body.evaluate(el => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
    expect(await page.getByRole("button", { name: "더 보기", exact: true }).count()).toBe(0);
    await shot("purpose-home");
    await page.goto(`${base}/#/p/${f.project.id}/team`);
    await page.getByLabel("팀 메뉴", { exact: true }).click();
    await page.getByRole("button", { name: "팀 상황", exact: true }).click();
    expect(await page.getByRole("dialog").locator(".md").innerText()).toBe(now);
    await page.keyboard.press("Escape");
    await page.locator(`[data-member-id="${f.worker.id}"] .to-person`).click();
    await page.locator(".tm-detail .tm-facts").waitFor();
    expect(await page.locator(".tm-facts").allInnerTexts()).toContainEqual(expect.stringContaining("세션 기록이 제공되면 철수가 종료 시점과 재개 요청을 대조합니다."));
    await shot("purpose-team");
  });
});

test("결재의 판단 근거와 제한을 선택지보다 먼저 읽고 선택만으로는 결재하지 않는다", async () => {
  await withScreens(async (page, f, base, taskId, width, shot) => {
    const decision = f.store.createDecision({ projectId: f.project.id, taskId, memberId: f.worker.id, who: f.worker.name,
      title: "로그인 오류 진단을 위해 익명화한 세션 기록을 제공할까요?", detail: reportBody + "\n\n제공하면 원인 대조를 이어갑니다. 제공하지 않으면 조사 결과를 미확인 상태로 보관합니다. 제공 범위는 익명화한 종료 기록으로 한정하며 운영 재시작은 승인하지 않습니다.",
      options: [{ k: "provide", label: "익명화한 기록 제공", desc: "세션 종료 시점의 대조를 진행합니다" }, { k: "hold", label: "조사 보류", desc: "원인을 미확인 상태로 보관합니다" }] });
    await page.goto(`${base}/#/p/${f.project.id}/inbox`);
    const card = page.locator(`[data-decision="${decision.id}"]`);
    await card.waitFor();
    const detail = await card.locator(".ibx-detail").boundingBox();
    const options = await card.locator(".ibx-opts").boundingBox();
    expect(detail!.y + detail!.height).toBeLessThanOrEqual(options!.y);
    expect(await card.locator(".ibx-detail").innerText()).toContain("운영 재시작은 승인하지 않습니다.");
    await card.getByRole("button", { name: "익명화한 기록 제공" }).click();
    expect(f.store.getDecision(decision.id)?.status).toBe("open");
    await shot("purpose-inbox");
  });
});

test("보고는 결과와 근거, 자료는 이름·용도·사용 본문, 업무는 전체 목표를 보여 준다", async () => {
  await withScreens(async (page, f, base, taskId, width, shot) => {
    const report = f.store.createMessage({ projectId: f.project.id, taskId, memberId: f.worker.id, who: f.worker.name, kind: "막힘", title: reportTitle, body: reportBody });
    const file = f.store.createFile({ projectId: f.project.id, taskId, who: f.worker.name, title: "로그인 재개 오류 진단서", summary: "입력 수신 확인 결과와 추가로 필요한 기록을 정리했습니다. 원인과 운영 적용은 미확인입니다.", kind: "artifact", html: "<!doctype html><html lang='ko'><meta charset='utf-8'><title>로그인 재개 오류 진단서</title><body><main><h1>확인한 범위</h1><p>입력 수신 기록 3건을 확인했습니다.</p><h2>진단을 이어가기 위한 조건</h2><p>익명화한 세션 종료 기록이 필요합니다. 운영 서버를 재시작하지 않습니다.</p></main></body></html>" });
    await page.goto(`${base}/#/p/${f.project.id}/thread`);
    const row = page.locator(`[data-mid="${report.id}"]`);
    await row.waitFor();
    expect(await row.locator(".th-card__title").innerText()).toBe(reportTitle);
    expect(await row.locator(".th-md").innerText()).toBe(reportBody);
    expect(await row.locator(".th-card__task").getAttribute("title")).toContain(taskName);
    await shot("purpose-report");
    await page.goto(`${base}/#/p/${f.project.id}/files/${file.id}`);
    await page.locator(".fl-doc__title").waitFor();
    expect(await page.locator(".fl-doc__title").innerText()).toBe(file.title);
    expect(await page.locator(".fl-doc__summary").innerText()).toBe(file.summary);
    const frame = page.frameLocator("iframe.afr-frame");
    await frame.getByRole("heading", { name: "진단을 이어가기 위한 조건" }).waitFor();
    expect(await frame.locator("body").innerText()).toContain("운영 서버를 재시작하지 않습니다.");
    await shot("purpose-artifact");
  });
});
