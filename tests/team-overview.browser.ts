import { reviewedPlacement } from "./fixtures/reviewed-placement.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
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
    CODEX_HOME: isolated.paths.codexHome,
  };
  writeFileSync(join(isolated.paths.codexHome, "models_cache.json"), JSON.stringify({ models: [
    { slug: "codex-max", display_name: "Codex Max", visibility: "list", supported_reasoning_levels: [{ effort: "max" }], additional_speed_tiers: ["fast"] },
    { slug: "codex-standard", display_name: "Codex Standard", visibility: "list", supported_reasoning_levels: [{ effort: "low" }] },
  ] }));
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
async function open(
  width = 1440,
  at?: string,
  projectId = project.id,
  configure?: (p: Page) => Promise<void>,
) {
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
  await configure?.(p);
  await p.goto(`${base}/#/p/${projectId}/team`);
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
    .locator(".to-next .to-task")
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
      "최근 실행 상태를 확인하지 못했습니다.",
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

let reviewSerial = 0;
function reviewFixture() {
  const id = ++reviewSerial;
  const pr = store.createProject({
    name: `검토 ${id}`,
    cwd: isolated.paths.work,
  });
  let staffSerial = 0;
  const staff = (name = "휴면 담당") =>
    store.createMember({
      projectId: pr.id,
      handle: `review-${id}-${++staffSerial}`,
      name,
      kind: "worker",
      status: "asleep",
      cli: "claude",
    });
  let serial = 0;
  const task = (title: string, parentTaskId?: string) =>
    store.ensureSourceTask({
      projectId: pr.id,
      sourceRef: `review-${id}-${++serial}`,
      title,
      origin: "owner",
      parentTaskId,
    }).task;
  const assign = (m: Member, t: Task) => {
    const d = store.enqueue({
      projectId: pr.id,
      taskId: t.id,
      memberId: m.id,
      kind: "instruction",
      text: t.title,
    });
    return store.markDelivered(d.id);
  };
  const mark = (t: Task, stage: "hold" | "review" | "done") =>
    store.addStageMark({
      projectId: pr.id,
      taskId: t.id,
      stage,
      evidence: "review regression fixture",
      memberId: null,
      who: "대표",
    });
  return { pr, staff, task, assign, mark };
}
test("review: name search includes staff without tasks and searches the unassigned tray", async () => {
  const f = reviewFixture(),
    m = f.staff(),
    a = f.task("검색 대상 미배정"),
    b = f.task("별도 미배정");
  const p = await open(1440, undefined, f.pr.id);
  try {
    await p.getByLabel("직원·업무 검색", { exact: true }).fill(m.name);
    expect(await p.locator(".to-row").count()).toBe(1);
    await p.getByLabel("직원·업무 검색", { exact: true }).fill(a.title);
    await p.locator(`.to-free[data-task-id="${a.id}"]`).waitFor();
    expect(await p.locator(`.to-free[data-task-id="${b.id}"]`).count()).toBe(0);
    await p.getByLabel("미배정 닫기", { exact: true }).click();
    await p.locator(".to-unassigned").waitFor({ state: "hidden" });
    expect(
      await p.getByLabel("직원·업무 검색", { exact: true }).inputValue(),
    ).toBe(a.title);
  } finally {
    await p.close();
  }
}, 20000);
test("review: the review count excludes blocked tasks in the employee detail", async () => {
  const f = reviewFixture(),
    m = f.staff(),
    a = f.task("막힌 업무"),
    b = f.task("검토할 업무");
  f.assign(m, a);
  f.assign(m, b);
  f.mark(a, "hold");
  f.mark(b, "review");
  const p = await open(1440, undefined, f.pr.id);
  try {
    await p
      .locator(".to-checks")
      .getByRole("button", { name: "팀 검토 1", exact: true })
      .click();
    const d = p.getByRole("dialog");
    await d.locator(".tt-item").first().waitFor();
    expect(await d.locator(".tt-item").count()).toBe(1);
    expect(await d.locator(".tt-item").getAttribute("data-task-id")).toBe(b.id);
  } finally {
    await p.close();
  }
}, 20000);
test("review: an open blocked group scope follows live classification changes", async () => {
  const f = reviewFixture(),
    m = f.staff(),
    a = f.task("상위 업무"),
    b = f.task("하위 업무", a.id);
  f.assign(m, a);
  f.assign(m, b);
  f.mark(a, "hold");
  f.mark(b, "review");
  const p = await open(1440, undefined, f.pr.id);
  try {
    await p.getByRole("button", { name: "전체 지도", exact: true }).click();
    await p
      .locator(".map-group-counts")
      .getByRole("button", { name: /막힘/ })
      .click();
    const d = p.getByRole("dialog");
    await d.locator(`.tt-item[data-task-id="${a.id}"]`).waitFor();
    f.mark(a, "done");
    f.mark(b, "hold");
    await d.locator(`.tt-item[data-task-id="${b.id}"]`).waitFor();
    await d
      .locator(`.tt-item[data-task-id="${a.id}"]`)
      .waitFor({ state: "detached" });
  } finally {
    await p.close();
  }
}, 20000);
test("review: an open relation scope replaces obsolete sequence edges after a live reorder", async () => {
  const f = reviewFixture(),
    m = f.staff();
  const tasks = ["선행 A", "중간 B", "후행 C"].map((s) => f.task(s));
  for (const t of tasks) {
    f.task(t.title + " 하위", t.id);
    reviewedPlacement(store, f.assign(m, t));
  }
  const p = await open(1440, undefined, f.pr.id);
  try {
    await p.getByRole("button", { name: "전체 지도", exact: true }).click();
    const links = p.locator(".map-link-count");
    await links.first().click();
    const d = p.getByRole("dialog");
    await d.locator(".map-relations article").first().waitFor();
    const oldText = await d.locator(".map-relations").innerText();
    const oldCount = await d.locator(".map-relations article").count();
    const beforeEdges = store
      .projectState(f.pr.id)
      .workflow!.edges.filter((e) => e.kind === "sequence");
    store.db
      .query(
        "UPDATE deliveries SET rowid = (SELECT MAX(rowid)+1 FROM deliveries) WHERE member_id = ? AND task_id = ?",
      )
      .run(m.id, tasks[1].id);
    expect(
      store
        .projectState(f.pr.id)
        .workflow!.edges.filter((e) => e.kind === "sequence"),
    ).not.toEqual(beforeEdges);
    store.patchMember(m.id, { now: "순서 변경됨" });
    await p.waitForFunction(
      (old) =>
        (document.querySelector(".map-relations") as HTMLElement)?.innerText !==
        old,
      oldText,
      { timeout: 3000 },
    );
    const text = await d.locator(".map-relations").innerText();
    // A-B disappears; B-C reverses. Either selected pair must no longer assert the old direction.
    expect(
      text === oldText &&
        (await d.locator(".map-relations article").count()) === oldCount,
    ).toBe(false);
  } finally {
    await p.close();
  }
}, 20000);
test("review: compact focus return restores the recreated task button and shell scroll", async () => {
  const f = reviewFixture();
  for (let i = 0; i < 11; i++)
    f.assign(f.staff(`복귀 직원 ${i}`), f.task(`복귀 업무 ${i}`));
  const p = await open(390, undefined, f.pr.id);
  try {
    const target = p.locator(".to-row").last().locator(".to-task").first();
    await target.scrollIntoViewIfNeeded();
    await target.focus();
    const nodeId = await target.getAttribute("data-node-id");
    const scroll = await p.locator(".shell__body").evaluate((e) => e.scrollTop);
    expect(scroll).toBeGreaterThan(0);
    await target.press("Shift+F10");
    await p.locator(".map-task[data-center]").waitFor();
    await p.getByRole("button", { name: "← 이전 보기", exact: true }).click();
    await p.waitForFunction(
      (id) => document.activeElement?.getAttribute("data-node-id") === id,
      nodeId,
      { timeout: 3000 },
    );
    expect(
      Math.abs(
        (await p.locator(".shell__body").evaluate((e) => e.scrollTop)) - scroll,
      ),
    ).toBeLessThan(2);
  } finally {
    await p.close();
  }
}, 20000);
test("review: returning from task focus preserves map zoom and pan", async () => {
  const f = reviewFixture(),
    m = f.staff(),
    a = f.task("지도 업무");
  f.task("지도 자식", a.id);
  f.assign(m, a);
  const p = await open(1440, undefined, f.pr.id);
  try {
    await p.getByRole("button", { name: "전체 지도", exact: true }).click();
    await p.getByLabel("지도 확대", { exact: true }).click();
    await p.locator(".map-viewport").press("ArrowRight");
    const before = await p.locator(".map-world").getAttribute("style");
    await p.locator(".map-group-title").click();
    await p.locator(".map-task[data-center]").waitFor();
    await p.getByRole("button", { name: "← 이전 보기", exact: true }).click();
    await p.locator(".map-group").waitFor();
    await p.waitForFunction(
      () => document.querySelector(".map-zoom")?.textContent?.includes("120%"),
      undefined,
      { timeout: 3000 },
    );
    expect(await p.locator(".map-zoom").innerText()).toContain("120%");
    expect(await p.locator(".map-world").getAttribute("style")).toBe(before);
  } finally {
    await p.close();
  }
}, 20000);
test("review: optional workflow absence preserves staff, detail and team actions", async () => {
  const f = reviewFixture();
  f.staff();
  const p = await open(1440, undefined, f.pr.id, async (p) => {
    await p.route("**/api/sync?**", async (route) => {
      const response = await route.fetch(),
        body = await response.json();
      delete body.state.workflow;
      await route.fulfill({ response, json: body });
    });
  });
  try {
    await p
      .getByText("업무 흐름을 확인할 수 없습니다.", { exact: true })
      .waitFor();
    expect(await p.locator(".to-filters .wf-count").count()).toBe(0);
    await p.getByLabel("팀 메뉴", { exact: true }).click();
    await p.getByRole("button", { name: "개발 기억", exact: true }).waitFor();
    await p.getByLabel("팀 메뉴", { exact: true }).click();
    await p.locator(".to-person").click();
    await p.getByRole("dialog").locator(".tm-detail-tabs").waitFor();
  } finally {
    await p.close();
  }
}, 25000);
test("review: crossed group relations remain clickable without overlapping count buttons", async () => {
  const f = reviewFixture(),
    m = f.staff("첫 직원"),
    n = f.staff("둘째 직원");
  const roots = Array.from({ length: 9 }, (_, i) =>
    f.task("교차 묶음 " + i),
  ).sort((a, b) => a.id.localeCompare(b.id));
  for (const r of roots) f.task(r.title + " 자식", r.id);
  f.assign(m, roots[0]);
  reviewedPlacement(store, f.assign(m, roots[4]));
  f.assign(n, roots[1]);
  reviewedPlacement(store, f.assign(n, roots[3]));
  const later = f.staff("셋째 직원");
  f.assign(later, roots[0]);
  reviewedPlacement(store, f.assign(later, roots[6]));
  const p = await open(1440, undefined, f.pr.id);
  try {
    await p.getByRole("button", { name: "전체 지도", exact: true }).click();
    await p.locator(".map-link-count").first().waitFor();
    const boxes = await p.locator(".map-link-count").evaluateAll((es) =>
      es.map((e) => {
        const r = e.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      }),
    );
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i],
          b = boxes[j];
        expect(
          a.right <= b.left ||
            b.right <= a.left ||
            a.bottom <= b.top ||
            b.bottom <= a.top,
        ).toBe(true);
      }
    const overlap = await p.locator(".map-viewport").evaluate((view) => {
      const cards = [...view.querySelectorAll(".map-group")].map((card) =>
        card.getBoundingClientRect(),
      );
      return [...view.querySelectorAll(".map-link-count")].some((button) => {
        const b = button.getBoundingClientRect();
        return cards.some(
          (c) =>
            b.left < c.right &&
            c.left < b.right &&
            b.top < c.bottom &&
            c.top < b.bottom,
        );
      });
    });
    expect(overlap).toBe(false);
    let edgeCount = 0;
    for (let i = 0; i < boxes.length; i++) {
      await p.locator(".map-link-count").nth(i).click();
      await p
        .getByRole("dialog")
        .locator(".map-relations article")
        .first()
        .waitFor();
      edgeCount += await p
        .getByRole("dialog")
        .locator(".map-relations article")
        .count();
      await p.keyboard.press("Escape");
    }
    expect(edgeCount).toBe(3);
  } finally {
    await p.close();
  }
}, 20000);

test("review: an open participant list follows new live assignments", async () => {
  const f = reviewFixture(),
    a = f.task("참여 업무");
  f.task("참여 하위", a.id);
  for (let i = 0; i < 4; i++) f.assign(f.staff("참여 직원 " + i), a);
  const p = await open(1440, undefined, f.pr.id);
  try {
    await p.getByRole("button", { name: "전체 지도", exact: true }).click();
    await p.locator(".map-group .more-members").click();
    const d = p.getByRole("dialog");
    await d.locator(".map-member-list button").first().waitFor();
    expect(await d.locator(".map-member-list button").count()).toBe(4);
    f.assign(f.staff("새 참여 직원"), a);
    await d
      .getByRole("button", { name: "새 참여 직원", exact: true })
      .waitFor();
    expect(await d.locator(".map-member-list button").count()).toBe(5);
  } finally {
    await p.close();
  }
}, 20000);
test("review: map focus returns to the same group list and expanded task", async () => {
  const f = reviewFixture(),
    m = f.staff(),
    a = f.task("목록 상위");
  f.task("목록 하위", a.id);
  f.assign(m, a);
  const p = await open(1440, undefined, f.pr.id);
  try {
    await p.getByRole("button", { name: "전체 지도", exact: true }).click();
    await p.locator(".map-group-top button").click();
    const d = p.getByRole("dialog"),
      t = d.locator(`.tt-item[data-task-id="${a.id}"] .tt-title`);
    await t.click();
    await t.press("Shift+F10");
    await p.locator(".map-task[data-center]").waitFor();
    await p.getByRole("button", { name: "← 이전 보기", exact: true }).click();
    await d
      .locator(`.tt-item[data-task-id="${a.id}"][data-expanded]`)
      .waitFor();
    await p.waitForFunction(
      (id) =>
        document.activeElement
          ?.closest(".tt-item")
          ?.getAttribute("data-task-id") === id,
      a.id,
      { timeout: 3000 },
    );
  } finally {
    await p.close();
  }
}, 20000);


test("Codex model, Max and Fast are selected and saved in a single reviewed write", async () => {
  const m = store.createMember({ projectId: project.id, name: "Codex 직원", handle: "codex-options", kind: "worker", cli: "codex", status: "asleep" });
  const p = await open(390);
  try {
    await p.locator(`[data-member-id="${m.id}"] .to-person`).click();
    const detail = p.getByRole("dialog");
    await detail.locator(".tm-detail-tabs").getByRole("button", { name: "실행·설정", exact: true }).click();
    const model = detail.getByRole("combobox", { name: "모델", exact: true });
    const effort = detail.getByRole("combobox", { name: "effort", exact: true });
    const speed = detail.getByRole("combobox", { name: "속도", exact: true });
    await model.selectOption("codex-max");
    await effort.selectOption("max");
    await speed.selectOption("fast");
    const save = detail.getByRole("button", { name: "설정 저장", exact: true });
    const submitted = p.waitForResponse(r => r.url().endsWith(`/api/members/${m.id}`) && r.request().method() === "PATCH");
    await save.click();
    const response = await submitted;
    expect(response.status()).toBe(200);
    expect(response.request().postDataJSON()).toEqual({ modelOverride: "codex-max", effortOverride: "max", codexSpeed: "fast" });
    expect(store.requireMember(m.id)).toMatchObject({ modelOverride: "codex-max", effortOverride: "max", codexSpeed: "fast", status: "asleep" });
    await model.selectOption("codex-standard");
    expect(await effort.inputValue()).toBe("");
    expect(await speed.inputValue()).toBe("standard");
    expect(await speed.locator('option[value="fast"]').evaluate((option: HTMLOptionElement) => option.disabled)).toBe(true);
  } finally { await p.close(); store.removeMember(m.id); }
}, 20000);

test("team owner response count includes direct decisions and unassigned owner todos, excluding staff work", async () => {
  const f = reviewFixture(), m = f.staff("검토 직원"), second = f.staff("공동 담당"), review = f.task("직원이 검수할 결과"), hold = f.task("보류한 작업");
  const decision = f.task("대표가 정할 대상"), todo = f.task("대표가 전달할 자료");
  for (const t of [review, hold, decision]) f.assign(m, t);
  f.assign(second, decision);
  f.mark(review, "review");
  f.mark(hold, "hold");
  store.createDecision({ projectId: f.pr.id, taskId: decision.id, memberId: m.id, who: m.name, title: "대상을 골라 주세요" });
  const requested = store.createTodo({ projectId: f.pr.id, taskId: todo.id, title: "자료를 전달해 주세요" });
  const p = await open(1440, undefined, f.pr.id);
  try {
    const filters = p.getByRole("navigation", { name: "업무 상태", exact: true });
    const count = (label: string) => filters.locator("button").filter({ hasText: label }).locator(".wf-count");
    expect(await count("대표 응답").allTextContents()).toEqual(["2"]);
    expect(await count("팀 처리").allTextContents()).toEqual(["2"]);
    await filters.getByRole("button", { name: /^대표 응답/ }).click();
    const list = p.getByRole("region", { name: "대표 응답 업무" });
    expect(await list.locator(".tt-item").count()).toBe(2);
    expect(await list.locator(`.tt-item[data-task-id="${decision.id}"]`).count()).toBe(1);
    expect(await list.locator(`.tt-item[data-task-id="${todo.id}"] .tt-title strong`).textContent()).toBe(requested.title);
    await list.locator(`.tt-item[data-task-id="${todo.id}"] .tt-title`).click();
    const todoLink = list.getByRole("link", { name: /내 할 일 열기/ });
    expect(await todoLink.getAttribute("href")).toBe(`#/p/${f.pr.id}/home/${requested.id}`);
    await todoLink.click();
    const target = p.locator(`.hm-todo[data-todo="${requested.id}"]`);
    await target.getByRole("button", { name: requested.title }).waitFor();
    await p.waitForFunction(id => document.activeElement?.closest("[data-todo]")?.getAttribute("data-todo") === id, requested.id);
    expect(await target.getByRole("checkbox").getAttribute("aria-checked")).toBe("false");
    expect(store.requireTodo(requested.id).done).toBe(false);
    await p.goBack();
    await filters.getByRole("button", { name: /^전체/ }).click();
    await p.locator(`.to-row[data-member-id="${m.id}"] .to-checks`).getByRole("button", { name: /^대표 응답/ }).click();
    const dialog = p.getByRole("dialog");
    await dialog.locator(`.tt-item[data-task-id="${decision.id}"]`).waitFor();
    expect(await dialog.locator(".tt-item").count()).toBe(1);
    await dialog.getByRole("navigation", { name: "직원 업무 상태" }).getByRole("button", { name: /^팀 처리/ }).click();
    expect(await dialog.locator(".tt-item").count()).toBe(2);
  } finally { await p.close(); }
}, 30000);

test("one owner task exposes its inbox and each employee's separate terminal response", async () => {
  const f = reviewFixture(), first = f.staff("첫 담당"), second = f.staff("둘째 담당"), task = f.task("공동 승인 작업");
  f.assign(first, task);
  f.assign(second, task);
  const decision = store.createDecision({ projectId: f.pr.id, taskId: task.id, memberId: first.id, who: first.name, title: "작업 범위 결정" });
  const todo = store.createTodo({ projectId: f.pr.id, taskId: task.id, title: "승인에 필요한 원본 전달" });
  const p = await open(1440, undefined, f.pr.id, async page => {
    await page.route("**/api/sync?**", async route => {
      const response = await route.fetch(), body = await response.json();
      for (const node of body.state.workflow.nodes) {
        if (node.taskId === task.id) node.additionalOwnerActions = [...(node.additionalOwnerActions ?? []), { label: "승인 창 열기", tab: "team", sub: node.memberId }];
      }
      await route.fulfill({ response, json: body });
    });
  });
  try {
    const filters = p.getByRole("navigation", { name: "업무 상태", exact: true });
    await filters.getByRole("button", { name: /^대표 응답/ }).click();
    const list = p.getByRole("region", { name: "대표 응답 업무" });
    expect(await list.locator(".tt-item").count()).toBe(1);
    await list.locator(".tt-title").click();
    const actions = list.locator("a.wf-action");
    expect(await list.locator(`a.wf-action[href$="/inbox/${decision.id}"]`).count()).toBe(1);
    expect(await list.locator(`a.wf-action[href$="/home/${todo.id}"]`).count()).toBe(1);
    expect(await actions.filter({ hasText: "승인 창 열기" }).count()).toBe(2);
    for (const m of [first, second]) expect(await list.locator(`a.wf-action[href$="/team/${m.id}"]`).count()).toBe(1);
    await filters.getByRole("button", { name: /^전체/ }).click();
    await p.locator(`.to-row[data-member-id="${first.id}"] .to-checks`).getByRole("button", { name: /^대표 응답/ }).click();
    const dialog = p.getByRole("dialog");
    await dialog.locator(".tt-title").click();
    expect(await dialog.locator(`a.wf-action[href$="/team/${first.id}"]`).count()).toBe(1);
    expect(await dialog.locator(`a.wf-action[href$="/home/${todo.id}"]`).count()).toBe(1);
    const inbox = dialog.getByRole("link", { name: /결재 열기/ });
    expect(await inbox.getAttribute("href")).toBe(`#/p/${f.pr.id}/inbox/${decision.id}`);
    await inbox.click();
    await p.locator(`[data-decision="${decision.id}"]`).waitFor();
    expect(store.requireDecision(decision.id).status).toBe("open");
  } finally { await p.close(); }
}, 30000);

test("a home todo link focuses the requested row and preserves a completed todo", async () => {
  const f = reviewFixture();
  f.staff();
  const pending = store.createTodo({ projectId: f.pr.id, title: "진행 중인 대표 요청" });
  for (let i = 0; i < 24; i++) store.createTodo({ projectId: f.pr.id, title: `다른 요청 ${i + 1}` });
  const completed = store.createTodo({ projectId: f.pr.id, title: "이미 처리한 대표 요청" });
  store.closeTodo(completed.id, { outcome: "done", by: "대표", reason: "처리 완료" });
  const p = await browser.newPage();
  try {
    await p.addInitScript(code => localStorage.setItem("iamceo.accessCode", code), CODE);
    await p.goto(`${base}/#/p/${f.pr.id}/home/${completed.id}`);
    const focused = (id: string) => p.waitForFunction(id => {
      const target = document.activeElement;
      if (!target?.matches(`[data-todo="${id}"] .hm-todo__toggle`)) return false;
      const rect = target.getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= window.innerHeight;
    }, id, { timeout: 4500 });
    await focused(completed.id);
    expect(await p.locator(`[data-todo="${completed.id}"] [role="checkbox"]`).getAttribute("aria-checked")).toBe("true");
    await p.evaluate(hash => { location.hash = hash; }, `#/p/${f.pr.id}/home/${pending.id}`);
    await focused(pending.id);
    expect(store.requireTodo(completed.id).done).toBe(true);
    expect(store.requireTodo(pending.id).done).toBe(false);
  } finally { await p.close(); }
}, 20000);
