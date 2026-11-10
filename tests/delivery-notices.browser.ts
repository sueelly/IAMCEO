// 웹 팀 화면의 전달 알림: 입력 전 거절 한도에 걸린 지시가 보이고, 대표 인증으로 '다시 확인'을 한 번 누르면
// 같은 전달(ID·표지·원문)을 한 번 더 보낼 차례가 되며 목록이 갱신된다. 실제 서버(http.ts)·실제 화면·격리 DB. 실제 CLI·세션은 없다.
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
import { Store } from "../server/store.ts";
import type { DeliveryDispatch } from "../server/service-contracts.ts";
import type { Delivery, Member, Project } from "../shared/types.ts";

const CODE = "delivery-notice-test-code";
const SHOTS = process.env.IAMCEO_E2E_SHOTS ?? mkdtempSync(join(tmpdir(), "iamceo-delivery-shots-"));
mkdirSync(SHOTS, { recursive: true });

let server: RunningServer;
let orch: Orchestrator;
let store: Store;
let browser: Browser;
let base = "";
let project: Project;
let member: Member;
const seeded: { d: Delivery; first: DeliveryDispatch; last: DeliveryDispatch }[] = [];

function identity(m: Member) {
  return { terminalId: m.paneId, sessionId: m.sessionId, sessionGeneration: store.memberRevisions(m.id).sessionGeneration, process: null };
}
const baseline = () => ({ serverEpoch: "test-epoch", turn: 0, inputEpoch: 0, logs: [], capturedAt: new Date().toISOString() });

/** The same state as the live rows: five pre-write refusals, automatic retry stopped (rejected_limit). */
function exhausted(text: string) {
  const d = store.enqueue({ projectId: project.id, memberId: member.id, kind: "instruction", text });
  const svc = orch.deliveryRecovery;
  const first = svc.prepareDispatch([d.id], identity(member), baseline());
  let last = first;
  for (let i = 0; i < 5; i++) {
    svc.recordResult(last.dispatchId, { ok: false, reason: "busy", retryable: true, deliveryEffect: "rejected" });
    if (i < 4) last = svc.prepareDispatch([d.id], identity(member), baseline());
  }
  expect(store.getDeliveryRetry(d.id).retryReason).toBe("rejected_limit");
  expect(store.requireDelivery(d.id)).toMatchObject({ status: "held", holdReason: "input_busy" });
  return { d, first, last };
}

beforeAll(async () => {
  const home = mkdtempSync(join(tmpdir(), "iamceo-delivery-web-"));
  const env = { IAMCEO_HOME: home, IAMCEO_PORT: "0" };
  updateConfigFile({ accessCode: CODE, hosts: ["127.0.0.1"], claudeBin: "/bin/false" }, env);
  const config = loadConfig(env);
  const bus = new Bus();
  store = new Store(openDb(config.dbPath), bus);
  orch = new Orchestrator({ config, store, runners: new Map() });
  server = await startServer({ config, store, bus, orch, delivery: orch.deliveryRecovery });
  base = server.urls[0]!;
  project = store.createProject({ name: "전달 알림 시험", cwd: home });
  member = store.createMember({ projectId: project.id, handle: "elite", name: "엘리트사원 클로드", kind: "worker", backend: "core", paneId: "terminal-elite", sessionId: "session-elite" });
  seeded.push(exhausted("체험판 지시 첫째 원문"), exhausted("체험판 지시 둘째 원문"));
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await orch.shutdown();
  await server.stop();
});

async function openMember(page: Page) {
  await page.goto(`${base}/api/health`);
  await page.evaluate((code) => localStorage.setItem("iamceo.accessCode", code), CODE);
  await page.goto(`${base}/#/p/${encodeURIComponent(project.id)}/team/${encodeURIComponent(member.id)}`);
  try { await page.locator(".tm-delivery").waitFor({ timeout: 20_000 }); }
  catch (e) { await page.screenshot({ path: join(SHOTS, "fail.png"), fullPage: true }); console.log(await page.locator("body").innerText()); throw e; }
}
const item = (page: Page, id: string) => page.locator(`.tm-delivery__item[data-delivery-id="${id}"]`);

describe("웹 전달 알림과 '다시 확인'", () => {
  test("두 지시가 보이고, 한 번 누르면 같은 전달이 다시 보낼 차례가 되며 목록이 갱신된다", async () => {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    await openMember(page);
    const [a, b] = seeded;
    for (const s of seeded) {
      await expect(item(page, s.d.id).getByRole("button", { name: "다시 확인" }).count()).resolves.toBe(1);
      await expect(item(page, s.d.id).textContent()).resolves.toContain("대표 확인 필요");
    }
    // 메시지가 없는 지시는 원문 대신 종류·ID로 알아본다(서버 preview 정책 그대로).
    await expect(item(page, a!.d.id).textContent()).resolves.toContain(a!.d.id);
    await page.screenshot({ path: join(SHOTS, "1-before.png"), fullPage: true });

    const deliveriesBefore = store.listDeliveries(project.id).length;
    const dispatchesBefore = store.listDispatches(member.id).length;
    await item(page, a!.d.id).getByRole("button", { name: "다시 확인" }).click();
    await page.getByText("다시 확인하도록 요청했습니다").waitFor({ timeout: 10_000 });

    // Same delivery row, same text; one owner grant, no new delivery or dispatch yet.
    const after = store.requireDelivery(a!.d.id);
    expect(after).toMatchObject({ id: a!.d.id, status: "queued", text: "체험판 지시 첫째 원문" });
    expect(store.getDeliveryRetry(a!.d.id).retryReason).toMatch(/^owner_retry:[0-9a-f-]{36}$/);
    expect(store.listDeliveries(project.id).length).toBe(deliveriesBefore);
    expect(store.listDispatches(member.id).length).toBe(dispatchesBefore);
    // The list refreshed: the granted row lost its button; the other row is untouched.
    await expect(item(page, a!.d.id).getByRole("button", { name: "다시 확인" }).count()).resolves.toBe(0);
    await expect(item(page, a!.d.id).textContent()).resolves.toContain("전달 대기");
    await expect(item(page, b!.d.id).getByRole("button", { name: "다시 확인" }).count()).resolves.toBe(1);
    expect(store.requireDelivery(b!.d.id)).toMatchObject({ status: "held" });
    await page.screenshot({ path: join(SHOTS, "2-after.png"), fullPage: true });

    // A second press (a new operation) cannot grant another attempt.
    const second = await page.evaluate(async ({ id, code }) => {
      const notices = await (await fetch(`/api/members/${document.location.hash.split("/").at(-1)}/delivery-notices`, { headers: { Authorization: `Bearer ${code}` } })).json();
      const row = notices.items.find((x: { deliveryId: string }) => x.deliveryId === id);
      const res = await fetch(`/api/deliveries/${id}/recovery`, { method: "POST", headers: { Authorization: `Bearer ${code}`, "Content-Type": "application/json" }, body: JSON.stringify({ operationId: crypto.randomUUID(), expectedVersion: row.version, action: "recheck" }) });
      return res.status;
    }, { id: a!.d.id, code: CODE });
    expect(second).toBe(409);

    // The granted attempt is one ordinary envelope with the original id, marker and text.
    const next = orch.deliveryRecovery.prepareDispatch([a!.d.id], identity(member), baseline());
    expect(next.items.map((i) => i.deliveryId)).toEqual([a!.d.id]);
    expect(next.markers).toEqual(a!.first.markers);
    expect(next.wireText.startsWith("체험판 지시 첫째 원문\n")).toBe(true);
    // Refused again → stopped again, and the web shows the button once more after its poll/reload.
    orch.deliveryRecovery.recordResult(next.dispatchId, { ok: false, reason: "busy", retryable: true, deliveryEffect: "rejected" });
    expect(store.getDeliveryRetry(a!.d.id).retryReason).toBe("rejected_limit");
    expect(() => orch.deliveryRecovery.prepareDispatch([a!.d.id], identity(member), baseline())).toThrow();
    await page.reload();
    await page.locator(".tm-delivery").waitFor({ timeout: 20_000 });
    await expect(item(page, a!.d.id).getByRole("button", { name: "다시 확인" }).count()).resolves.toBe(1);
    await page.close();
  }, 90_000);

  test("접속 코드 없이는 목록도 '다시 확인'도 거부된다", async () => {
    const id = seeded[1]!.d.id;
    const list = await fetch(`${base}/api/members/${member.id}/delivery-notices`);
    expect(list.status).toBe(401);
    const res = await fetch(`${base}/api/deliveries/${id}/recovery`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operationId: crypto.randomUUID(), expectedVersion: 1, action: "recheck" }) });
    expect(res.status).toBe(401);
    expect(store.requireDelivery(id).status).toBe("held");
  });

  test("폰 폭에서도 버튼이 보인다", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await openMember(page);
    await expect(item(page, seeded[1]!.d.id).getByRole("button", { name: "다시 확인" }).isVisible()).resolves.toBe(true);
    await page.screenshot({ path: join(SHOTS, "3-phone.png"), fullPage: true });
    await page.close();
  }, 60_000);
});

afterAll(() => { console.log(`shots: ${SHOTS}`); });
