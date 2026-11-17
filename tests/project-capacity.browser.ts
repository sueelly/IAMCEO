// Real HTTP, SQLite, React and Chromium. Fixture owns every path and opens no provider session.
import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../server/bus.ts";
import { loadConfig, updateConfigFile } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { startServer } from "../server/http.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import { Store } from "../server/store.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";

for (const [name, width, height] of [["desktop", 1440, 1000], ["narrow", 390, 844]] as const) {
  test(`project and global concurrency limits save, reload and retain conflict drafts at ${name} width`, async () => {
    const isolated = createIsolatedRuntime();
    const env = { IAMCEO_HOME: isolated.paths.iamceoHome, IAMCEO_PORT: "0", IAMCEO_CORE_SOCKET: isolated.socketPath,
      IAMCEO_HERDR_SOCKET: isolated.herdrSocketPath, IAMCEO_CORE_BIN: isolated.bins.coreBin,
      IAMCEO_CLAUDE_BIN: isolated.bins.claudeBin, IAMCEO_CODEX_BIN: isolated.bins.codexBin };
    updateConfigFile({ accessCode: "capacity-browser-fixture", hosts: ["127.0.0.1"] }, env);
    const config = loadConfig(env), bus = new Bus(), db = openDb(config.dbPath), store = new Store(db, bus);
    store.patchSettings({ maxConcurrentTurns: 9, boardTidyHours: 0 });
    const project = store.createProject({ name: "동시 실행 시험", cwd: isolated.paths.work });
    const orch = new Orchestrator({ config, store, runners: new Map(), providerHomes: isolated.providerHomes, timings: { tickMs: 60_000, healthMs: 60_000 } });
    let server = await startServer({ config, bus, store, orch, delivery: orch.deliveryRecovery, detectHosts: () => [], folderHome: isolated.paths.home });
    while (server.port === 7878) { await server.stop(); server = await startServer({ config, bus, store, orch, delivery: orch.deliveryRecovery, detectHosts: () => [], folderHome: isolated.paths.home }); }
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage();
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    page.setDefaultTimeout(5000);
    try {
      await page.addInitScript(code => localStorage.setItem("iamceo.accessCode", code), config.accessCode);
      await page.goto(`http://127.0.0.1:${server.port}/#/settings`);
      await page.locator(".st-pjs").waitFor();
      expect(await page.getByLabel("전체 동시 실행", { exact: false }).count()).toBe(1);
      expect(await page.getByLabel("전체 동시 실행", { exact: false }).inputValue()).toBe("9");
      const row = page.locator(`[data-project="${project.id}"]`);
      await row.getByRole("button", { name: `${project.name} 고치기` }).click();
      await row.getByLabel("동시 실행", { exact: true }).selectOption("custom");
      const cap = row.getByLabel("프로젝트 동시 실행 상한");
      await cap.fill("65"); await row.getByRole("button", { name: "저장", exact: true }).click();
      expect(await row.getByRole("alert").textContent()).toContain("1부터 64까지");
      expect(store.requireProject(project.id).maxConcurrentTurns).toBeNull();
      await cap.fill("2"); await row.getByRole("button", { name: "저장", exact: true }).click();
      await row.getByRole("button", { name: `${project.name} 고치기` }).waitFor();
      expect(store.requireProject(project.id).maxConcurrentTurns).toBe(2);
      await page.reload(); await row.getByRole("button", { name: `${project.name} 고치기` }).click();
      expect(await row.getByLabel("프로젝트 동시 실행 상한").inputValue()).toBe("2");
      expect(await page.getByLabel("전체 동시 실행", { exact: false }).inputValue()).toBe("9");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const shotRoot = process.env.IAMCEO_CAPACITY_SHOTS;
      if (shotRoot) { mkdirSync(shotRoot, { recursive: true, mode: 0o700 }); await page.screenshot({ path: join(shotRoot, `capacity-${name}.png`), fullPage: true }); }
      // Editing only the name must preserve another client's newly saved cap.
      const changedCap = page.waitForResponse(async response => {
        if (!response.url().includes("/api/sync?") || response.status() !== 200) return false;
        const snapshot = await response.json();
        return snapshot.bootstrap?.projects?.some((value: { id: string; maxConcurrentTurns: number | null }) => value.id === project.id && value.maxConcurrentTurns === 1);
      });
      await orch.patchProject(project.id, { maxConcurrentTurns: 1 });
      await changedCap;
      await page.evaluate(() => new Promise(requestAnimationFrame));
      const renamed = `${project.name} 이름 수정`;
      await row.getByLabel("이름", { exact: true }).fill(renamed);
      const nameSave = page.waitForRequest(request => request.method() === "PATCH" && request.url().endsWith(`/api/projects/${project.id}`));
      await row.getByRole("button", { name: "저장", exact: true }).click();
      expect((await nameSave).postDataJSON()).toEqual({ name: renamed });
      await row.getByRole("button", { name: `${renamed} 고치기` }).waitFor();
      expect(store.requireProject(project.id).maxConcurrentTurns).toBe(1);
      await row.getByRole("button", { name: `${renamed} 고치기` }).click();
      expect(await row.getByLabel("프로젝트 동시 실행 상한").inputValue()).toBe("1");
      await row.getByLabel("동시 실행", { exact: true }).selectOption("inherit");
      await row.getByRole("button", { name: "저장", exact: true }).click();
      await row.getByRole("button", { name: `${renamed} 고치기` }).waitFor();
      expect(store.requireProject(project.id).maxConcurrentTurns).toBeNull();
      await page.getByLabel("전체 동시 실행", { exact: false }).fill("10");
      await orch.updateSettings({ maxConcurrentTurns: 8 });
      await page.locator(".st-bar").getByRole("button", { name: "저장", exact: true }).click();
      await page.getByRole("region", { name: "바뀐 설정 검토" }).waitFor();
      expect(await page.getByLabel("전체 동시 실행", { exact: false }).inputValue()).toBe("10");
      expect(store.getSettings().maxConcurrentTurns).toBe(8);
      await page.getByRole("button", { name: "현재 값 확인했습니다" }).click();
      await page.locator(".st-bar").getByRole("button", { name: "저장", exact: true }).click();
      await page.locator(".st-bar__ok").waitFor();
      expect(store.getSettings().maxConcurrentTurns).toBe(10);
      await page.reload();
      await page.getByLabel("전체 동시 실행", { exact: false }).waitFor();
      expect(await page.getByLabel("전체 동시 실행", { exact: false }).inputValue()).toBe("10");
      expect(errors).toEqual([]);
    } finally { await context.close(); await browser.close(); await server.stop(); await orch.shutdown(); db.close(); await isolated.stop(); }
  }, 30_000);
}
