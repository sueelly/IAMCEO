import { expect, test } from "bun:test";
import { chromium } from "playwright";
import type { Bus } from "../server/bus";
import { startServer } from "../server/http";
import { fixture } from "./fixtures/harness-fixture";

test("대표가 팀에서 직원 진행사항을 실시간으로 읽고 새로고침과 모바일 접속 뒤에도 같은 기록을 본다", async () => {
  const f = fixture();
  const task = f.store.saveTask({ projectId: f.project.id, memberId: f.worker.id, who: f.worker.name, title: "회차 서술 검수" }).task;
  const other = f.store.createProject({ name: "다른 팀", cwd: f.isolated.paths.work });
  const bus = (f.store as unknown as { bus: Bus }).bus;
  const server = await startServer({ config: f.config, store: f.store, bus, orch: f.orch });
  const browser = await chromium.launch();
  const snapshots = Promise.withResolvers<void>();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(5000);
    await page.addInitScript(code => localStorage.setItem("iamceo.accessCode", code), f.config.accessCode);
    const team = server.urls[0] + "/#/p/" + f.project.id + "/team";
    await page.goto(team);
    const entry = page.getByRole("link", { name: "진행사항", exact: true });
    await entry.click();
    const feed = page.getByRole("dialog", { name: "진행사항" });
    await feed.getByText("아직 등록된 진행사항이 없습니다.").waitFor();
    expect(page.url()).toBe(team + "/progress");
    await page.locator(".wf-connection").waitFor({ state: "hidden" });

    // Hold snapshot reads until the open socket has displayed the worker's update.
    await page.route("**/api/sync?**", async route => {
      await snapshots.promise;
      await route.continue();
    });
    const title = "회차에 연결된 씬 두 개를 확인했습니다";
    const body = "다음 회차에 등장하는 인물의 관점을 대조합니다.";
    await f.orch.recordPost(f.worker, { kind: "진행", title, body, taskId: task.id });
    const row = feed.getByRole("listitem").filter({ hasText: title });
    await row.getByRole("heading", { name: title }).waitFor();
    expect(await row.innerText()).toContain(task.title);
    expect(await row.innerText()).toContain(f.worker.name);
    expect(await row.locator("time").getAttribute("datetime")).toBeTruthy();
    expect(await row.getByText(body).isVisible()).toBe(true);

    const combined = f.store.saveTask({ projectId: f.project.id, memberId: f.worker.id, who: f.worker.name, title: "서술 통합 검수" }).task;
    f.store.markTaskMerged(task.id, combined.id, "대표");
    await row.getByText(combined.title, { exact: true }).waitFor();

    snapshots.resolve();
    await page.unrouteAll({ behavior: "wait" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await row.getByText(body).waitFor();
    expect(await row.getByText(combined.title, { exact: true }).isVisible()).toBe(true);
    expect(await feed.getByRole("listitem").count()).toBe(1);
    expect(await feed.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await feed.getByRole("button", { name: "닫기" }).click();
    await entry.waitFor();
    expect(page.url()).toBe(team);
    await page.goto(server.urls[0] + "/#/p/" + other.id + "/team/progress");
    await feed.getByText("아직 등록된 진행사항이 없습니다.").waitFor();
    expect(await feed.getByText(title).count()).toBe(0);
  } finally {
    snapshots.resolve();
    await browser.close();
    await server.stop();
  }
}, 30_000);
