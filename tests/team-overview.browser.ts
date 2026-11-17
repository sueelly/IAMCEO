import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
const SHOTS = join(
  import.meta.dir,
  "../.superpowers/sdd/2026-11-18-team-overview-production/screenshots",
);
import { Bus } from "../server/bus";
import { loadConfig, updateConfigFile } from "../server/config";
import { openDb } from "../server/db";
import { Store } from "../server/store";
import { Orchestrator } from "../server/orchestrator";
import { startServer, type RunningServer } from "../server/http";
import { FakeRunner } from "./fixtures/harness-fixture";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime";
import type { Member, Project, Task } from "../shared/types";
let isolated: ReturnType<typeof createIsolatedRuntime>,
  store: Store,
  orch: Orchestrator,
  server: RunningServer,
  browser: Browser,
  base: string,
  project: Project,
  other: Project,
  root: Task;
const members: Member[] = [],
  CODE = "team-overview-test";
beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  isolated = createIsolatedRuntime();
  const env = {
    IAMCEO_HOME: isolated.paths.iamceoHome,
    IAMCEO_PORT: "0",
    IAMCEO_ENABLE_CLI: "false",
  };
  updateConfigFile({ accessCode: CODE, hosts: ["127.0.0.1"] }, env);
  const config = loadConfig(env),
    bus = new Bus(),
    runner = new FakeRunner();
  store = new Store(openDb(config.dbPath), bus);
  orch = new Orchestrator({
    config,
    store,
    runners: new Map([["core", runner]]),
    providerHomes: isolated.providerHomes,
  });
  project = store.createProject({ name: "큰 팀", cwd: isolated.paths.work });
  other = store.createProject({ name: "빈 팀", cwd: isolated.paths.work });
  root = store.ensureSourceTask({
    projectId: project.id,
    sourceRef: "map-root",
    title: "집필 실험실 통합",
    origin: "owner",
  }).task;
  for (let i = 0; i < 11; i++) {
    const m = store.createMember({
      projectId: project.id,
      handle: `staff${i}`,
      cli: "claude",
      name: `직원 ${i}`,
      kind: i === 0 ? "conductor" : "worker",
      status: i === 10 ? "asleep" : "idle",
      origin: "runner",
      backend: "core",
      cwd: isolated.paths.work,
      paneId: `pane${i}`,
      sessionId: `session${i}`,
    });
    members.push(m);
    runner.busy.add(m.id);
    for (let j = 0; j < 10; j++) {
      const task =
        j === 0
          ? root
          : store.ensureSourceTask({
              projectId: project.id,
              sourceRef: `task-${i}-${j}`,
              title: `직원 ${i} 구현 업무 ${j}`,
              origin: "owner",
              parentTaskId: root.id,
            }).task;
      const d = store.enqueue({
        projectId: project.id,
        taskId: task.id,
        memberId: m.id,
        kind: "instruction",
        text: task.title,
      });
      store.markDelivered(d.id);
    }
  }
  store.ensureSourceTask({
    projectId: project.id,
    sourceRef: "free",
    title: "미배정 업무",
    origin: "owner",
  });
  server = await startServer({ config, store, bus, orch });
  base = server.urls[0]!;
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
  await orch?.shutdown();
  await server?.stop();
  store?.db.close();
  await isolated?.stop();
});
async function open(width = 1440, at?: string) {
  const p = await browser.newPage({
    viewport: { width, height: 1000 },
    reducedMotion: "reduce",
  });
  p.setDefaultTimeout(5000);
  if (at) await p.clock.install({ time: new Date(at) });
  p.on("pageerror", (e) => console.log("BROWSER_ERROR", e.message));
  await p.addInitScript(
    (code) => localStorage.setItem("iamceo.accessCode", code),
    CODE,
  );
  await p.goto(`${base}/#/p/${project.id}/team`);
  try {
    await p.locator(".to-row").first().waitFor({ timeout: 15000 });
  } catch (e) {
    console.log("TEAM_BODY", await p.locator("body").innerText());
    throw e;
  }
  await p.locator(".wf-connection").waitFor({ state: "hidden" });
  return p;
}
test("eleven staff remain compact and employee/task entry share the real protected employee dialog", async () => {
  const p = await open();
  expect(await p.locator(".to-row").count()).toBe(11);
  expect(await p.locator(".tm-grid,.tm-asleep").count()).toBe(0);
  await p.screenshot({ path: join(SHOTS, "team-1440.png"), fullPage: true });
  const heights = await p
    .locator(".to-row")
    .evaluateAll((es) => es.map((e) => e.getBoundingClientRect().height));
  expect(Math.max(...heights)).toBeLessThanOrEqual(70);
  await p.locator(".to-person").nth(1).click();
  const d = p.getByRole("dialog");
  await d
    .locator('.tm-detail-tabs [aria-pressed="true"]')
    .getByText("요약", { exact: true })
    .waitFor();
  expect(await d.locator(".tm-send").count()).toBe(1);
  await d.locator(".tm-send__input").fill("보존할 직접 지시 초안");
  await d
    .locator(".tm-detail-tabs")
    .getByRole("button", { name: /^업무/ })
    .click();
  expect(await d.locator(".tt-item").count()).toBe(10);
  await d
    .locator(".tm-detail-tabs")
    .getByRole("button", { name: "실행·설정", exact: true })
    .click();
  expect(
    await d.getByRole("button", { name: "새 세션으로 이어가기" }).isVisible(),
  ).toBe(true);
  await d
    .locator(".tm-detail-tabs")
    .getByRole("button", { name: /^업무/ })
    .click();
  await d.locator(".tt-title").nth(3).click();
  const selected = await d
    .locator(".tt-item[data-expanded]")
    .getAttribute("data-task-id");
  await d.getByRole("button", { name: "연결만 보기", exact: true }).click();
  await p.locator(".map-task[data-center]").waitFor();
  await p.getByRole("button", { name: "← 직원 상세", exact: true }).click();
  await d.locator(".tt-item[data-expanded]").waitFor();
  expect(
    await d.locator(".tt-item[data-expanded]").getAttribute("data-task-id"),
  ).toBe(selected);
  expect(await d.locator(".tm-send__input").inputValue()).toBe(
    "보존할 직접 지시 초안",
  );
  await d.screenshot({ path: join(SHOTS, "employee.png") });
  await p.keyboard.press("Escape");
  await p.waitForFunction(
    () => document.activeElement === document.querySelectorAll(".to-person")[1],
  );
  expect(
    await p
      .locator(".to-person")
      .nth(1)
      .evaluate((e) => document.activeElement === e),
  ).toBe(true);
  await p
    .locator(".to-row")
    .nth(1)
    .getByRole("button", { name: /확인 필요/ })
    .first()
    .click();
  expect(
    await d.locator('.tm-detail-tabs [aria-pressed="true"]').textContent(),
  ).toContain("업무");
  await p.close();
}, 30000);
test("map preserves source identities, all participants, source relations and omitted task access", async () => {
  const p = await open();
  await p.getByRole("button", { name: "전체 지도", exact: true }).click();
  await p.locator(".map-group").first().waitFor();
  expect(await p.locator(".map-group").count()).toBe(2);
  await p.screenshot({ path: join(SHOTS, "map-1440.png") });
  expect(await p.locator(".map-total").textContent()).toContain("101개 업무");
  await p.locator(`[data-group-id="${root.id}"] .map-group-top button`).click();
  expect(await p.getByRole("dialog").locator(".tt-item").count()).toBe(100);
  await p.keyboard.press("Escape");
  await p.locator(`[data-group-id="${root.id}"] .more-members`).click();
  expect(await p.locator(".map-member-list button").count()).toBe(11);
  await p.keyboard.press("Escape");
  await p.locator(`[data-group-id="${root.id}"] .map-group-title`).click();
  await p.locator(".map-task[data-center]").waitFor();
  expect(await p.locator(".map-more").count()).toBeGreaterThan(0);
  await p.locator(".map-more").last().click();
  expect(await p.getByRole("dialog").locator(".tt-item").count()).toBe(99);
  await p.keyboard.press("Escape");
  await p.getByRole("button", { name: "지도 확대", exact: true }).click();
  expect(await p.locator(".map-zoom>span").textContent()).toBe("120%");
  await p.getByRole("button", { name: "맞춤", exact: true }).click();
  await p.locator(".map-breadcrumb button").click();
  await p.getByLabel("직원·업무 검색", { exact: true }).fill("직원 10");
  expect(await p.locator(".map-total").textContent()).toContain("10개 업무");
  await p.close();
}, 30000);
test("mobile, route changes and empty teams retain accessible entry paths", async () => {
  const p = await open(390);
  await p.screenshot({ path: join(SHOTS, "team-390.png"), fullPage: true });
  expect(
    await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await p.locator(".to-person").last().click();
  await p.getByRole("dialog").locator(".tm-detail-tabs").waitFor();
  expect(await p.getByRole("dialog").locator(".tm-detail-tabs").count()).toBe(
    1,
  );
  await p.keyboard.press("Escape");
  await p.getByRole("button", { name: "전체 지도", exact: true }).click();
  await p.locator(".map-mobile-list button").first().waitFor();
  expect(
    await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await p.getByLabel("팀 메뉴", { exact: true }).click();
  await p.getByRole("button", { name: "진행판 기록", exact: true }).click();
  await p.getByRole("dialog").waitFor();
  await p.evaluate((id) => (location.hash = `#/p/${id}/team`), other.id);
  await p.getByRole("dialog").waitFor({ state: "hidden" });
  await p.getByRole("button", { name: /총괄.*시작/ }).waitFor();
  await p.close();
}, 30000);

test("unassigned completion remains accessible from the done filter and live task/member removal is safe", async () => {
  const t = store.ensureSourceTask({
    projectId: project.id,
    sourceRef: "unowned-done",
    title: "담당 기록 없는 완료",
    origin: "owner",
  }).task;
  store.addStageMark({
    projectId: project.id,
    taskId: t.id,
    stage: "done",
    evidence: "fixture verified",
    memberId: null,
    who: "대표",
  });
  const p = await open();
  await p.locator(".to-filters").getByRole("button", { name: /^완료/ }).click();
  await p.locator(`[data-task-id="${t.id}"]`).first().waitFor();
  await p.locator(".to-person", { hasText: "담당 기록 없음" }).click();
  await p.getByRole("dialog").getByText(t.title, { exact: true }).waitFor();
  await p.keyboard.press("Escape");
  await p.locator(".to-filters").getByRole("button", { name: /^전체/ }).click();
  const ghost = store.createMember({
    projectId: project.id,
    handle: "removed-member",
    name: "사라질 직원",
    kind: "worker",
  });
  await p.locator(`[data-member-id="${ghost.id}"] .to-person`).click();
  await p.getByRole("dialog").waitFor();
  store.removeMember(ghost.id);
  await p.getByRole("dialog").waitFor({ state: "hidden" });
  expect(await p.evaluate(() => location.hash)).not.toContain(ghost.id);
  await p.getByRole("button", { name: "전체 지도", exact: true }).click();
  await p.locator(`[data-group-id="${root.id}"] .map-group-title`).click();
  await p.locator(".map-task[data-center]").waitFor();
  store.markTaskMerged(root.id, t.id, "fixture");
  await p
    .getByText("선택한 업무의 흐름이 변경되었습니다.", { exact: true })
    .waitFor();
  await p
    .getByRole("button", { name: "전체 지도", exact: true })
    .last()
    .click();
  await p.locator(".map-viewport").waitFor();
  await p.close();
}, 30000);
test("more than six groups fit inside the map without losing their full task lists", async () => {
  for (let i = 0; i < 10; i++) {
    const r = store.ensureSourceTask({
      projectId: project.id,
      sourceRef: `many-root-${i}`,
      title: `추가 묶음 ${i}`,
      origin: "owner",
    }).task;
    store.ensureSourceTask({
      projectId: project.id,
      sourceRef: `many-child-${i}`,
      title: `추가 자식 ${i}`,
      origin: "owner",
      parentTaskId: r.id,
    });
  }
  const p = await open();
  await p.getByRole("button", { name: "전체 지도", exact: true }).click();
  await p.locator(".map-group").first().waitFor();
  expect(await p.locator(".map-group").count()).toBeGreaterThan(6);
  await p.waitForFunction(() => {
    const v = document.querySelector(".map-viewport")!.getBoundingClientRect();
    return [...document.querySelectorAll(".map-group")].every((e) => {
      const b = e.getBoundingClientRect();
      return (
        b.top >= v.top - 1 &&
        b.bottom <= v.bottom + 1 &&
        b.left >= v.left - 1 &&
        b.right <= v.right + 1
      );
    });
  });
  await p.locator(".map-group").last().locator(".map-group-top button").click();
  await p.getByRole("dialog").locator(".tt-item").first().waitFor();
  expect(
    await p.getByRole("dialog").locator(".tt-item").count(),
  ).toBeGreaterThan(0);
  await p.close();
}, 30000);

test("execution freshness expires in the compact row and shared employee task detail", async () => {
  const member = members[1],
    task = store.ensureSourceTask({
      projectId: project.id,
      sourceRef: "expiry",
      title: "관측 만료 업무",
      origin: "owner",
    }).task;
  const delivery = store.enqueue({
    projectId: project.id,
    taskId: task.id,
    memberId: member.id,
    kind: "instruction",
    text: task.title,
  });
  store.markDelivered(delivery.id);
  const at = new Date().toISOString();
  store.saveExecutionJournal({
    runId: "team-expiry",
    memberId: member.id,
    projectId: project.id,
    identity: {
      terminalId: null,
      sessionId: member.sessionId,
      sessionGeneration: store.memberRevisions(member.id).sessionGeneration,
      process: null,
    },
    turn: 1,
    deliveryIds: [delivery.id],
    phase: "running",
    inputReceivedAt: at,
    startedAt: at,
    lastProgressAt: at,
    endedAt: null,
    result: null,
    reason: null,
    exitCode: null,
    interruptionNotifiedAt: null,
    reportRequestedAt: null,
    createdAt: at,
    updatedAt: at,
  });
  store.patchMember(member.id, {
    status: "working",
    statusObservation: {
      source: "core",
      observedAt: at,
      freshness: "fresh",
      ownership: "verified",
      consecutiveFailures: 0,
      error: null,
    },
  });
  const p = await open(1440, at),
    row = p.locator(`[data-member-id="${member.id}"]`);
  await row.locator(".to-state[data-state=running]").waitFor();
  await p.clock.runFor(90001);
  await row.locator(".to-state[data-state=unknown]").waitFor();
  expect(await row.locator(".to-state[data-state=running]").count()).toBe(0);
  await row.locator(".to-task").first().click();
  await p
    .getByRole("dialog")
    .getByText(
      "최근 실행 상태를 확인하지 못했습니다. 직원 화면에서 확인해 주세요.",
      { exact: true },
    )
    .waitFor();
  await p.close();
}, 30000);

test("runtime settings retain drafts across tabs and manual removal keeps its deliberate confirmation", async () => {
  const m = store.createMember({
      projectId: project.id,
      handle: "settings",
      name: "설정 직원",
      kind: "worker",
      cli: "claude",
      origin: "runner",
      backend: "core",
      status: "idle",
      cwd: isolated.paths.work,
      paneId: "settings-pane",
      sessionId: "settings-session",
    }),
    p = await open();
  await p.locator(`[data-member-id="${m.id}"] .to-person`).click();
  const d = p.getByRole("dialog");
  await d
    .locator(".tm-detail-tabs")
    .getByRole("button", { name: "실행·설정", exact: true })
    .click();
  const input = d.getByLabel("모델", { exact: true });
  await input.fill("haiku");
  await d
    .locator(".tm-detail-tabs")
    .getByRole("button", { name: "요약", exact: true })
    .click();
  await d
    .locator(".tm-detail-tabs")
    .getByRole("button", { name: "실행·설정", exact: true })
    .click();
  expect(await input.inputValue()).toBe("haiku");
  const saved = p.waitForResponse(
    (r) => r.url().includes(m.id) && r.request().method() === "PATCH",
  );
  await d.getByRole("button", { name: "모델 저장", exact: true }).click();
  const response = await saved;
  expect({
    status: response.status(),
    body: response.ok() ? "" : await response.text(),
  }).toEqual({ status: 200, body: "" });
  expect(store.requireMember(m.id).modelOverride).toBe("haiku");
  await p.keyboard.press("Escape");
  const manual = store.createMember({
    projectId: project.id,
    handle: "manual",
    name: "수동 직원",
    kind: "worker",
    origin: "manual",
  });
  await p.locator(`[data-member-id="${manual.id}"] .to-person`).click();
  await d
    .locator(".tm-detail-tabs")
    .getByRole("button", { name: "실행·설정", exact: true })
    .click();
  await d
    .getByRole("button", { name: "명부에서 빼기", exact: true })
    .dblclick();
  expect(store.getMember(manual.id)).not.toBeNull();
  await p.waitForTimeout(650);
  await d
    .getByRole("button", { name: "한 번 더 누르면 뺍니다", exact: true })
    .click();
  await d.waitFor({ state: "hidden" });
  expect(store.getMember(manual.id)).toBeNull();
  await p.close();
}, 30000);
