// Actual HTTP/snapshot/UI exercise in an owned DB. No CLI, worker, live socket or approval is used.
import { reviewedPlacement } from "./fixtures/reviewed-placement.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page, type WebSocketRoute } from "playwright";
import { Bus } from "../server/bus.ts";
import { loadConfig, updateConfigFile } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { startServer, type RunningServer } from "../server/http.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import { Store, type ExecutionJournal } from "../server/store.ts";
import { TaskContinuationCoordinator } from "../server/task-continuation.ts";
import type { Member, Project, Task } from "../shared/types.ts";

const CODE = "workflow-fixture-code";
const SHOTS = process.env.IAMCEO_E2E_SHOTS ?? mkdtempSync(join(tmpdir(), "iamceo-workflow-shots-"));
mkdirSync(SHOTS, { recursive: true });
let home: string, server: RunningServer, orch: Orchestrator, store: Store, browser: Browser, base: string;
let project: Project, registrar: Member, worker: Member, reviewer: Member;
let done: Task, current: Task, next: Task, derived: Task, unassigned: Task;
let currentDeliveryId: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "iamceo-workflow-web-"));
  const env = { IAMCEO_HOME: home, IAMCEO_PORT: "0", IAMCEO_ENABLE_CLI: "false" };
  updateConfigFile({ accessCode: CODE, hosts: ["127.0.0.1"], claudeBin: "/bin/false" }, env);
  const config = loadConfig(env), bus = new Bus();
  store = new Store(openDb(config.dbPath), bus);
  orch = new Orchestrator({ config, store, runners: new Map() });
  project = store.createProject({ name: "업무 흐름 시험", cwd: home });
  registrar = store.createMember({ projectId: project.id, handle: "lead", name: "총괄", kind: "conductor" });
  worker = store.createMember({ projectId: project.id, handle: "builder", name: "개발 담당", kind: "worker" });
  reviewer = store.createMember({ projectId: project.id, handle: "reviewer", name: "검토 담당", kind: "worker" });
  const task = (title: string, parentTaskId?: string) => store.saveTask({ projectId: project.id, memberId: registrar.id, who: registrar.name, title, parentTaskId }).task;
  done = task("요구사항 정리"); current = task("결제 화면 구현"); next = task("접근성 검사"); derived = task("결제 독립 검토", current.id); unassigned = task("차기 운영 검토");
  const assign = (task: Task, member: Member, delivered = false) => {
    const d = store.enqueue({ projectId: project.id, memberId: member.id, kind: "instruction", text: task.title, taskId: task.id });
    if (delivered) store.markDelivered(d.id);
    return d;
  };
  assign(done, worker, true);
  store.addStageMark({ projectId: project.id, taskId: done.id, stage: "done", evidence: "확인 완료", memberId: registrar.id, who: registrar.name });
  currentDeliveryId = assign(current, worker, true).id; reviewedPlacement(store, assign(next, worker)); assign(derived, reviewer); assign(current, reviewer);
  store.createMessage({ projectId: project.id, taskId: current.id, mine: true, who: "대표", kind: "나", title: "", body: "결제 화면에 접근 가능한 확인 버튼을 추가해 주세요.", targetMemberId: worker.id });
  store.createMessage({ projectId: project.id, taskId: current.id, memberId: worker.id, who: worker.name, kind: "진행", title: "결제 버튼 구현 중", body: "키보드 초점 이동을 검사하고 있습니다." });
  server = await startServer({ config, store, bus, orch, delivery: orch.deliveryRecovery });
  base = server.urls[0]!;
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await orch?.shutdown();
  await server?.stop();
  store?.db.close();
  if (home) rmSync(home, { recursive: true, force: true });
  console.log(`workflow screenshots: ${SHOTS}`);
});

async function open(page: Page, tab = "thread") {
  await page.addInitScript((code) => localStorage.setItem("iamceo.accessCode", code), CODE);
  await page.goto(`${base}/#/p/${project.id}/${tab}`);
  if (tab === "team") { await page.locator(".to-row").first().waitFor(); return; }
  await openFlow(page);
}
async function openFlow(page: Page) {
  const chip = page.locator('.cmp-task[data-id]:not([aria-hidden="true"])').first();
  await chip.waitFor({timeout:20000});await chip.click();
  await page.getByRole("button", {name:"업무 흐름",exact:true}).click();await page.locator('.wf-node').first().waitFor();
}
const node = (page: Page, taskId: string, memberId: string | null) => page.locator(`.wf-node[data-task-id="${taskId}"][data-member-id="${memberId ?? "unassigned"}"]`);

test("업무 흐름에서 대표 응답과 팀 처리를 거르고 실제 요청이 닫히면 건수가 갱신된다", async () => {
  const member = store.createMember({ projectId: project.id, handle: "review-scope", name: "별도 검수 담당", kind: "worker" });
  const request = store.ensureSourceTask({ projectId: project.id, sourceRef: "board-owner-response", title: "인증 기록 변경", origin: "owner" }).task;
  const child = store.ensureSourceTask({ projectId: project.id, sourceRef: "board-waiting-on-owner", parentTaskId: request.id,
    title: "상위 인증 변경 후 검사", origin: "owner" }).task;
  const team = store.ensureSourceTask({ projectId: project.id, sourceRef: "board-team-review", title: "검수 결과 점검", origin: "owner" }).task;
  const todo = store.createTodo({ projectId: project.id, taskId: request.id, memberId: member.id, title: "도메인 기록 변경" });
  const d = store.enqueue({ projectId: project.id, taskId: team.id, memberId: member.id, kind: "instruction", text: team.title });
  store.markDelivered(d.id);
  store.enqueue({ projectId: project.id, taskId: child.id, memberId: member.id, kind: "instruction", text: child.title });
  store.addStageMark({ projectId: project.id, taskId: team.id, stage: "review", evidence: "직원 검수 대기", memberId: member.id, who: member.name });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const operator = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  try {
    await open(page);
    await node(page, child.id, member.id).waitFor();
    expect(await node(page, child.id, member.id).textContent()).toContain("선행 응답 대기");
    const filters = page.getByRole("navigation", { name: "업무 상태" });
    await filters.getByRole("button", { name: /^대표 응답/ }).click();
    await node(page, request.id, null).waitFor();
    expect(await node(page, team.id, member.id).count()).toBe(0);
    expect(await node(page, child.id, member.id).count()).toBe(0);
    const before = Number(await filters.getByRole("button", { name: /^대표 응답/ }).locator(".wf-count").textContent());
    await open(operator);
    await node(operator, request.id, null).click();
    const homeHash = `#/p/${project.id}/home/${todo.id}`;
    const link = operator.getByRole("dialog").locator(`a[href="${homeHash}"]`);
    expect(await link.count()).toBe(1);
    await link.click();
    await operator.waitForURL(url => url.hash === homeHash);
    await operator.getByRole("heading", { name: "내가 할 일", exact: true }).waitFor();
    const checkbox = operator.getByRole("checkbox", { name: todo.title + " 했음", exact: true });
    expect(await checkbox.getAttribute("aria-checked")).toBe("false");
    await checkbox.click();
    await node(page, request.id, null).waitFor({ state: "detached" });
    expect(store.getTodo(todo.id)?.done).toBe(true);
    expect(Number(await filters.getByRole("button", { name: /^대표 응답/ }).locator(".wf-count").textContent())).toBe(before - 1);
    await filters.getByRole("button", { name: /^팀 처리/ }).click();
    await node(page, team.id, member.id).waitFor();
    expect(store.requireDelivery(d.id).status).toBe("delivered");
  } finally { await operator.close(); await page.close(); }
}, 60_000);

test("직원별 실제 배정 순서와 파생 관계를 표시하고 노드에서 지시·보고와 업무 대화를 연다", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await open(page);
  // RED: before WorkFlow is added, Team has only status cards and no workflow region.
  expect(await page.getByRole("region", { name: "업무 흐름", exact: true }).count()).toBe(1);
  const row = page.locator(`.wf-row[data-member-id="${worker.id}"]`);
  expect(await row.locator(".wf-node").evaluateAll((els) => els.map((el) => el.getAttribute("data-task-id")))).toEqual([done.id, current.id, next.id]);
  expect(await page.locator(`.wf-row[data-member-id="${registrar.id}"] .wf-node`).count()).toBe(0);
  expect(await page.locator(`.wf-node[data-task-id="${current.id}"]`).count()).toBe(2);
  expect(await node(page, unassigned.id, null).count()).toBe(1);
  expect(await node(page, done.id, worker.id).getAttribute("data-state")).toBe("done");
  expect(await node(page, current.id, worker.id).getAttribute("data-current")).toBe("true");
  expect(await page.locator(".wf-edge").count()).toBe(0);
  await page.getByRole("button", { name: "연결 지도", exact: true }).click();
  await page.locator('.wf-edge[data-kind="derived"]').first().waitFor();
  expect(await page.locator('.wf-edge[data-kind="sequence"]').count()).toBeGreaterThan(0);
  await page.locator(".wf-connection").waitFor({ state: "hidden" });
  await page.screenshot({ animations: "disabled", path: join(SHOTS, "workflow-desktop.png"), fullPage: true });
  await node(page, current.id, worker.id).click();
  const detail = page.getByRole("dialog", { name: current.title, exact: true });
  await detail.getByText("결제 화면에 접근 가능한 확인 버튼을 추가해 주세요.", { exact: true }).waitFor();
  expect(await detail.getByText("키보드 초점 이동을 검사하고 있습니다.", { exact: true }).count()).toBe(1);
  await detail.getByRole("link", { name: "업무 대화" }).click();
  await page.locator(".th-task").waitFor();
  expect(await page.locator(".th-task").textContent()).toContain(current.title);
  if(await page.getByRole("button", { name: "업무 흐름", exact: true }).getAttribute("aria-expanded") === "false") await page.getByRole("button", { name: "업무 흐름", exact: true }).click();
  expect(await page.getByRole("region", { name: "업무 흐름", exact: true }).count()).toBe(1);
  await node(page, current.id, reviewer.id).click();
  expect(await page.getByRole("dialog", { name: current.title, exact: true }).isVisible()).toBe(true);
  await page.screenshot({ animations: "disabled", path: join(SHOTS, "workflow-thread-detail.png"), fullPage: true });
  await page.close();
}, 60_000);

test("실행·승인 변화를 받아 갱신하고 연결 단절 때 강조를 멈춘 뒤 재접속한 완료 상태를 표시한다", async () => {
  const at = new Date().toISOString();
  const run: ExecutionJournal = {
    runId: "workflow-browser-run", memberId: worker.id, projectId: project.id,
    identity: { terminalId: null, sessionId: worker.sessionId, sessionGeneration: store.memberRevisions(worker.id).sessionGeneration, process: null },
    turn: 1, deliveryIds: [currentDeliveryId], phase: "running", inputReceivedAt: at, startedAt: at, lastProgressAt: at,
    endedAt: null, result: null, reason: null, exitCode: null, interruptionNotifiedAt: null, reportRequestedAt: null, createdAt: at, updatedAt: at,
  };
  store.saveExecutionJournal(run);
  const observation = { source: "core" as const, observedAt: at, freshness: "fresh" as const, ownership: "verified" as const, consecutiveFailures: 0, error: null };
  store.patchMember(worker.id, { status: "working", statusObservation: observation });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket(/\/ws/, (socket) => { sockets.push(socket); socket.connectToServer(); });
  await open(page);
  const currentNode = node(page, current.id, worker.id);
  await page.waitForFunction((selector) => document.querySelector(selector)?.getAttribute("data-active") === "true", `.wf-node[data-task-id="${current.id}"][data-member-id="${worker.id}"]`);
  expect(await currentNode.getAttribute("data-state")).toBe("running");
  store.appendActivity(worker.id, "tool", "회귀 검사를 실행하고 있습니다");
  await currentNode.getByText("회귀 검사를 실행하고 있습니다", { exact: true }).waitFor();
  await currentNode.click();
  expect(await page.getByRole("dialog").getByText("최근 실행", { exact: true }).count()).toBe(1);
  await page.keyboard.press("Escape");
  await page.screenshot({ animations: "disabled", path: join(SHOTS, "workflow-running.png"), fullPage: true });

  store.patchMember(worker.id, { status: "blocked", blockedReason: "permission", statusObservation: observation });
  await page.waitForFunction((selector) => document.querySelector(selector)?.getAttribute("data-state") === "blocked", `.wf-node[data-task-id="${current.id}"][data-member-id="${worker.id}"]`);
  expect(await currentNode.getAttribute("data-active")).toBeNull();
  await currentNode.click();
  expect(await page.getByRole("dialog").getByRole("link", { name: "직원 확인" }).getAttribute("href")).toContain(`/team/${worker.id}`);
  await page.keyboard.press("Escape");
  store.patchMember(worker.id, { status: "working", blockedReason: null, statusObservation: observation });
  await page.waitForFunction((selector) => document.querySelector(selector)?.getAttribute("data-active") === "true", `.wf-node[data-task-id="${current.id}"][data-member-id="${worker.id}"]`);

  await page.route("**/api/**", (route) => route.abort());
  for (const socket of sockets) socket.close();
  await page.locator(".wf-connection").waitFor();
  expect(await currentNode.getAttribute("data-active")).toBeNull();
  expect(await currentNode.textContent()).toContain("마지막 확인");
  await page.screenshot({ animations: "disabled", path: join(SHOTS, "workflow-offline.png"), fullPage: true });
  const endedAt = new Date().toISOString();
  store.saveExecutionJournal({ ...run, phase: "ended", endedAt, result: "success", updatedAt: endedAt });
  for (const delivery of store.listDeliveries(project.id).filter((d) => d.taskId === current.id)) store.markDelivered(delivery.id);
  store.patchMember(worker.id, { status: "idle", statusObservation: { ...observation, observedAt: endedAt } });
  store.addStageMark({ projectId: project.id, taskId: current.id, stage: "done", evidence: "격리 검사 완료", memberId: registrar.id, who: registrar.name });
  await page.unroute("**/api/**");
  await page.locator(".wf-connection").waitFor({ state: "hidden", timeout: 20_000 });
  await page.waitForFunction((selector) => document.querySelector(selector)?.getAttribute("data-state") === "done", `.wf-node[data-task-id="${current.id}"][data-member-id="${worker.id}"]`);
  expect(await node(page, next.id, worker.id).getAttribute("data-current")).toBe("true");
  await page.locator(".wf-scroll").focus();
  await page.mouse.move(1, 1);
  expect(await currentNode.evaluate((el) => Number(getComputedStyle(el).opacity))).toBeLessThan(1);
  await page.close();
}, 60_000);

test("긴 완료 이력은 최근 세 개부터 보이고 모두 펼치거나 선택한 과거 업무를 확인할 수 있다", async () => {
  const member = store.createMember({ projectId: project.id, handle: "history", name: "이력 담당", kind: "worker" });
  const completed: Task[] = [];
  for (let i = 1; i <= 6; i++) {
    const task = store.ensureSourceTask({ projectId: project.id, sourceRef: `workflow-history-${i}`, title: `끝낸 업무 ${i}`, origin: "owner" }).task;
    completed.push(task);
    const delivery = store.enqueue({ projectId: project.id, memberId: member.id, taskId: task.id, kind: "instruction", text: task.title });
    store.markDelivered(delivery.id);
    store.addStageMark({ projectId: project.id, taskId: task.id, stage: "done", evidence: "이력 시험", memberId: registrar.id, who: registrar.name });
  }
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await open(page);
  const row = page.locator(`.wf-row[data-member-id="${member.id}"]`);
  expect(await row.locator(".wf-node").count()).toBe(3);
  expect(await row.locator(".wf-node").evaluateAll((els) => els.map((el) => el.getAttribute("data-task-id")))).toEqual(completed.slice(3).map((t) => t.id));
  await page.getByRole("button", { name: "완료 모두", exact: true }).click();
  expect(await row.locator(".wf-node").count()).toBe(6);
  await node(page, completed[0].id, member.id).click();
  await page.getByRole("dialog").getByRole("link", { name: "업무 대화" }).click();
  if(await page.getByRole("button", { name: "업무 흐름", exact: true }).getAttribute("aria-expanded") === "false") await page.getByRole("button", { name: "업무 흐름", exact: true }).click();
  expect(await node(page, completed[0].id, member.id).count()).toBe(1);
  await page.getByRole("button", { name: "완료 모두", exact: true }).click();
  expect(await row.locator(".wf-node").count()).toBe(4);
  await page.close();
}, 60_000);

test("폰에서 흐름을 세로로 재배치하며 키보드로 상세를 닫으면 노드로 초점이 돌아온다", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await open(page);
  await page.locator(".wf-connection").waitFor({ state: "hidden" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.locator(".wf-scroll").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  const currentNode = node(page, next.id, worker.id);
  await currentNode.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("dialog", { name: next.title, exact: true }).waitFor();
  await page.getByRole("dialog", { name: next.title, exact: true }).getByRole("status").waitFor({ state: "hidden" });
  await page.screenshot({ animations: "disabled", path: join(SHOTS, "workflow-phone-detail.png"), fullPage: true });
  await page.keyboard.press("Escape");
  expect(await currentNode.evaluate((el) => document.activeElement === el)).toBe(true);
  await page.locator(".wf-scroll").evaluate((el) => { el.scrollLeft = 0; });
  await page.screenshot({ animations: "disabled", path: join(SHOTS, "workflow-phone.png"), fullPage: true });
  await page.close();
}, 60_000);

test("프로젝트를 바꾼 뒤 늦은 업무 상세 응답이 새 프로젝트에 섞이지 않는다", async () => {
  const other = store.createProject({ name: "다른 흐름", cwd: home });
  const otherTask = store.ensureSourceTask({ projectId: other.id, sourceRef: "workflow-other", title: "다른 프로젝트 업무", origin: "owner" }).task;
  store.createMessage({ projectId: other.id, taskId: otherTask.id, mine: true, who: "대표", kind: "나", title: "", body: "다른 프로젝트에서만 읽는 지시입니다." });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  let release: () => void = () => {};
  const hold = new Promise<void>((resolve) => { release = resolve; });
  let requestSeen: () => void = () => {};
  const seen = new Promise<void>((resolve) => { requestSeen = resolve; });
  await page.route(`**/api/projects/${project.id}/messages/page?**`, async (route) => {
    if (!route.request().url().includes(`taskId=${current.id}`)) return route.continue();
    const response = await route.fetch(); requestSeen(); await hold;
    await route.fulfill({ response }).catch(() => {}); // An unmounted detail aborts this request.
  });
  await open(page);
  await node(page, current.id, worker.id).click();
  await seen;
  await page.keyboard.press("Escape");
  await page.evaluate((id) => { location.hash = `#/p/${id}/thread`; }, other.id);
  await openFlow(page);
  await node(page, otherTask.id, null).waitFor();
  await node(page, otherTask.id, null).click();
  const detail = page.getByRole("dialog", { name: otherTask.title, exact: true });
  await detail.getByText("다른 프로젝트에서만 읽는 지시입니다.", { exact: true }).waitFor();
  release();
  await page.waitForTimeout(100);
  expect(await detail.textContent()).not.toContain("결제 화면에 접근 가능한 확인 버튼");
  expect(await page.getByRole("dialog", { name: current.title, exact: true }).count()).toBe(0);
  await page.close();
}, 60_000);

test("직원 카드가 실제 전달 대기와 조용한 알림을 같은 실행 대기열로 합치지 않는다", async () => {
  const member = store.createMember({ projectId: project.id, handle: "queue", name: "전달 담당", kind: "worker" });
  const task = store.ensureSourceTask({ projectId: project.id, sourceRef: "workflow-queue-label", title: "전달 확인", origin: "owner" }).task;
  store.enqueue({ projectId: project.id, memberId: member.id, taskId: task.id, kind: "instruction", text: "실행할 지시", wake: true });
  store.enqueue({ projectId: project.id, memberId: member.id, taskId: task.id, kind: "report", text: "조용한 참조 알림", wake: false });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  await open(page, "team");
  await page.locator(`[data-member-id="${member.id}"] .to-person`).click();
  const facts = page.locator(".tm-detail .tm-facts");
  await facts.waitFor();
  expect(await facts.textContent()).toContain("전달 대기 1 · 알림 1");
  await page.close();
}, 60_000);

test("최근 스냅샷 밖의 원래 지시는 업무별 이전 페이지에서 읽을 수 있다", async () => {
  const task = store.ensureSourceTask({ projectId: project.id, sourceRef: "workflow-old-instruction", title: "오래된 원문 확인", origin: "owner" }).task;
  store.createMessage({ projectId: project.id, taskId: task.id, mine: true, who: "대표", kind: "나", body: "처음 확정한 지시 원문입니다.", at: "2000-01-01T00:00:00.000Z" });
  for (let i = 1; i <= 60; i++) store.createMessage({ projectId: project.id, taskId: task.id, memberId: worker.id, who: worker.name, kind: "진행", title: `확인 기록 ${i}`, body: `검사 경과 ${i}`, at: new Date(Date.UTC(2000, 0, 1, 0, 0, i)).toISOString() });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  await open(page);
  await node(page, task.id, worker.id).click();
  const detail = page.getByRole("dialog", { name: task.title, exact: true });
  expect(await detail.textContent()).toContain("이 직원이 수행 보고를 남겼습니다");
  const older = detail.getByRole("button", { name: "이전 지시·보고" });
  await older.waitFor();
  expect(await detail.getByText("처음 확정한 지시 원문입니다.", { exact: true }).count()).toBe(0);
  await older.click();
  await detail.getByText("처음 확정한 지시 원문입니다.", { exact: true }).waitFor();
  expect(await older.count()).toBe(0);
  await page.close();
}, 60_000);

test("연결이 살아 있어도 새 관측 없이 90초가 지난 실행 강조와 현재 실행 문구는 남지 않는다", async () => {
  const member = store.createMember({ projectId: project.id, handle: "expired", name: "관측 담당", kind: "worker" });
  const task = store.ensureSourceTask({ projectId: project.id, sourceRef: "workflow-expiry", title: "관측 만료 확인", origin: "owner" }).task;
  const delivery = store.enqueue({ projectId: project.id, memberId: member.id, taskId: task.id, kind: "instruction", text: "관측 확인", wake: true });
  store.markDelivered(delivery.id);
  const at = new Date().toISOString();
  store.saveExecutionJournal({ runId: "workflow-browser-expiry", memberId: member.id, projectId: project.id,
    identity: { terminalId: null, sessionId: member.sessionId, sessionGeneration: store.memberRevisions(member.id).sessionGeneration, process: null },
    turn: 1, deliveryIds: [delivery.id], phase: "running", inputReceivedAt: at, startedAt: at, lastProgressAt: at,
    endedAt: null, result: null, reason: null, exitCode: null, interruptionNotifiedAt: null, reportRequestedAt: null, createdAt: at, updatedAt: at });
  store.patchMember(member.id, { status: "working", statusObservation: { source: "core", observedAt: at, freshness: "fresh", ownership: "verified", consecutiveFailures: 0, error: null } });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  await page.clock.install({ time: new Date(at) });
  await open(page);
  const currentNode = node(page, task.id, member.id);
  await page.waitForFunction((selector) => document.querySelector(selector)?.getAttribute("data-active") === "true", `.wf-node[data-task-id="${task.id}"]`);
  await page.clock.runFor(90_001);
  expect(await currentNode.getAttribute("data-active")).toBeNull();
  expect(await currentNode.textContent()).toContain("실행 상태 미확인");
  expect(await currentNode.textContent()).not.toContain("실행 중");
  await currentNode.click();
  expect(await page.getByRole("dialog").getByRole("link", { name: "직원 확인" }).count()).toBe(1);
  await page.close();
}, 60_000);

test("미완료 과거 배정을 모두 현재에 남기고 보류 입력과 실제 실행을 숨기지 않는다", async () => {
  const member = store.createMember({ projectId: project.id, handle: "legacy", name: "이전 이력 담당", kind: "worker" });
  const old: Task[] = [];
  for (let i = 1; i <= 5; i++) {
    const task = store.ensureSourceTask({ projectId: project.id, sourceRef: `workflow-legacy-${i}`, title: `과거 배정 ${i}`, origin: "owner" }).task;
    old.push(task);
    const delivery = store.enqueue({ projectId: project.id, memberId: member.id, taskId: task.id, kind: "instruction", text: task.title, wake: true });
    store.markDelivered(delivery.id);
  }
  const held = store.ensureSourceTask({ projectId: project.id, sourceRef: "workflow-legacy-held", title: "과거 보호 입력", origin: "owner" }).task;
  store.enqueue({ projectId: project.id, memberId: member.id, taskId: held.id, kind: "instruction", text: "보호 입력", wake: true, status: "held", holdReason: "delivery_unknown" });
  // This fixture represents delivered records predating sequence adoption, without inventing completion.
  store.db.query("DELETE FROM task_sequence WHERE member_id = ?").run(member.id);
  const at = new Date().toISOString();
  const activeDelivery = store.listDeliveries(project.id).find((d) => d.taskId === old[0].id)!;
  store.saveExecutionJournal({ runId: "workflow-browser-legacy", memberId: member.id, projectId: project.id,
    identity: { terminalId: null, sessionId: member.sessionId, sessionGeneration: store.memberRevisions(member.id).sessionGeneration, process: null },
    turn: 1, deliveryIds: [activeDelivery.id], phase: "running", inputReceivedAt: at, startedAt: at, lastProgressAt: at,
    endedAt: null, result: null, reason: null, exitCode: null, interruptionNotifiedAt: null, reportRequestedAt: null, createdAt: at, updatedAt: at });
  store.patchMember(member.id, { status: "working", statusObservation: { source: "core", observedAt: at, freshness: "fresh", ownership: "verified", consecutiveFailures: 0, error: null } });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  await open(page);
  const row = page.locator(`.wf-row[data-member-id="${member.id}"]`);
  expect(await row.locator(".wf-node").count()).toBe(6); // Every unfinished historical occurrence remains visible.
  expect(await row.locator('.wf-node[data-state="done"]').count()).toBe(0);
  expect(await node(page, old[0].id, member.id).count()).toBe(1);
  expect(await node(page, held.id, member.id).count()).toBe(1);
  expect(await node(page, old[1].id, member.id).count()).toBe(1);
  expect(await row.locator(".wf-node").count()).toBe(6);
  await page.close();
}, 60_000);

test("순서 등록 전 미완료 보고는 접히지 않고 복원 입력의 원인과 다음 조치를 상세에서 설명한다", async () => {
  const member = store.createMember({ projectId: project.id, handle: "followup", name: "미완료 확인 담당", kind: "worker" });
  const unfinished: Task[] = [];
  for (let i = 0; i < 5; i++) {
    const task = store.ensureSourceTask({ projectId: project.id, sourceRef: `workflow-open-${i}`, title: `검토가 남은 업무 ${i}`, origin: "owner" }).task;
    unfinished.push(task);
    const d = store.enqueue({ projectId: project.id, memberId: member.id, taskId: task.id, kind: "instruction", text: task.title });
    store.markDelivered(d.id);
    store.createMessage({ projectId: project.id, taskId: task.id, memberId: member.id, who: member.name, kind: "완료", title: "작성자 납품", body: "독립 검토와 최종 완료 확인이 남았습니다" });
  }
  const restored = store.ensureSourceTask({ projectId: project.id, sourceRef: "workflow-restore-reason", title: "복원 입력 확인", origin: "owner" }).task;
  const d = store.enqueue({ projectId: project.id, memberId: member.id, taskId: restored.id, kind: "instruction", text: restored.title, status: "held", holdReason: "delivery_unknown" });
  const recovery = store.getDeliveryRecovery(d.id)!;
  store.updateDeliveryRecovery(d.id, recovery.version, { phase: "stopped", reason: "restore_reconciliation_required" });
  store.db.query("DELETE FROM task_sequence WHERE member_id = ?").run(member.id);
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  await open(page);
  const row = page.locator(`.wf-row[data-member-id="${member.id}"]`);
  expect(await row.locator(".wf-node").count()).toBe(6);
  for (const task of unfinished) expect(await node(page, task.id, member.id).textContent()).toContain("작성자 납품");
  await node(page, restored.id, member.id).click();
  const detail = page.getByRole("dialog", { name: restored.title, exact: true });
  expect(await detail.textContent()).toContain("복원 확인 필요");
  expect(await detail.textContent()).toContain("총괄이 원래 지시와 복원된 기록을 대조");
  expect(await detail.getByRole("link", { name: "업무 대화", exact: true }).count()).toBe(1);
  expect(await detail.getByRole("link", { name: "직원 확인" }).count()).toBe(0);
  expect(store.requireDelivery(d.id).status).toBe("held");
  expect(store.getDeliveryRecovery(d.id)!.phase).toBe("stopped");
  await page.close();
}, 60_000);

test("총괄의 실제 후속 실행과 대표 중단을 표시하고 같은 업무의 새 대표 지시로 중단 표시를 해제한다", async () => {
  const task = store.saveTask({ projectId: project.id, memberId: worker.id, who: worker.name, title: "총괄 후속 실행 표시" }).task;
  store.createMessage({ projectId: project.id, taskId: task.id, memberId: worker.id, who: worker.name, kind: "막힘", title: "통합 확인 필요", body: "검증 조건이 남았습니다" });
  const d = store.enqueue({ projectId: project.id, memberId: registrar.id, taskId: task.id, kind: "system", text: "후속 확인", wake: true });
  store.db.query("INSERT INTO task_continuation_deliveries(delivery_id,task_id,round,created_at) VALUES(?,?,?,?)").run(d.id, task.id, 1, d.createdAt);
  store.markDelivered(d.id);
  const at = new Date().toISOString();
  const run: ExecutionJournal = { runId: "workflow-browser-continuation", memberId: registrar.id, projectId: project.id,
    identity: { terminalId: null, sessionId: registrar.sessionId, sessionGeneration: store.memberRevisions(registrar.id).sessionGeneration, process: null },
    turn: 1, deliveryIds: [d.id], phase: "running", inputReceivedAt: at, startedAt: at, lastProgressAt: at,
    endedAt: null, result: null, reason: null, exitCode: null, interruptionNotifiedAt: null, reportRequestedAt: null, createdAt: at, updatedAt: at };
  store.saveExecutionJournal(run);
  store.patchMember(registrar.id, { status: "working", statusObservation: { source: "core", observedAt: at, freshness: "fresh", ownership: "verified", consecutiveFailures: 0, error: null } });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  await open(page);
  const current = node(page, task.id, registrar.id);
  expect(await current.getAttribute("data-state")).toBe("running");
  expect(await current.getAttribute("data-current")).toBe("true");
  new TaskContinuationCoordinator(store, { intervalMs: 1_000, sameLimit: 3 }).pause([task.id], "browser-stop", "대표가 업무 실행을 중단했습니다");
  store.saveExecutionJournal({ ...run, phase: "ended", endedAt: new Date().toISOString(), result: "interrupted" });
  store.patchMember(registrar.id, { status: "idle" });
  await page.waitForFunction(selector => document.querySelector(selector)?.textContent?.includes("대표가 중단"), `.wf-node[data-task-id="${task.id}"][data-member-id="${registrar.id}"]`);
  await current.click();
  const detail = page.getByRole("dialog", { name: task.title, exact: true });
  expect(await detail.textContent()).toContain("대표가 업무 실행을 중단했습니다");
  expect(await detail.textContent()).toContain("같은 업무에 새 대표 지시");
  await page.keyboard.press("Escape");
  store.enqueue({ projectId: project.id, memberId: registrar.id, taskId: task.id, kind: "user_message", text: "이 업무를 다시 진행해 주세요", wake: true });
  await page.waitForFunction(selector => !document.querySelector(selector)?.textContent?.includes("대표가 중단"), `.wf-node[data-task-id="${task.id}"][data-member-id="${registrar.id}"]`);
  expect(await current.textContent()).not.toContain("대표가 중단");
  await page.close();
}, 60_000);
