// 웹의 멈춤·'멈추고 이 글로 이어가기': 받는 사람이 일하는 중이면 입력칸 위에 무엇이 멈추는지(직원·실행·작업)와 두 버튼이 보이고,
// 이어가기는 글을 먼저 대기열에 고정한 뒤 멈추며, 멈춘 턴이 끝난 뒤 한 번만 전달된다.
// 실제 서버(http.ts)·실제 화면·격리 DB. CLI 는 가짜 core 실행기다(실제 CLI 의 멈춤 키 반응은 보지 않는다).
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
import type { Runner, RunnerEvent, RunnerMember, SendResult } from "../server/runner/types.ts";
import { Store } from "../server/store.ts";
import type { Backend, Member, Project } from "../shared/types.ts";

const CODE = "stop-follow-up-code";
const SHOTS = process.env.IAMCEO_E2E_SHOTS ?? mkdtempSync(join(tmpdir(), "iamceo-stop-shots-"));
mkdirSync(SHOTS, { recursive: true });

class FakeCore implements Runner {
  readonly kind = "core" as const;
  callback: (e: RunnerEvent) => void = () => {};
  sent: { memberId: string; text: string }[] = [];
  busy = new Set<string>();
  interrupts = 0;
  gate: Promise<void> | null = null;
  async available() { return { ok: true }; }
  async start(): Promise<never> { throw new Error("CLI 를 띄우지 않는다"); }
  async send(m: RunnerMember, text: string): Promise<SendResult> { this.sent.push({ memberId: m.id, text }); this.busy.add(m.id); return { ok: true }; }
  async compact(): Promise<SendResult> { return { ok: true }; }
  isBusy(id: string) { return this.busy.has(id); }
  async setParallel(): Promise<SendResult> { return { ok: true }; }
  async interrupt() { this.interrupts++; if (this.gate) await this.gate; }
  async stop() {}
  async screen() { return ""; }
  on(callback: (e: RunnerEvent) => void) { this.callback = callback; }
  async shutdown() {}
}

let server: RunningServer;
let orch: Orchestrator;
let store: Store;
let fake: FakeCore;
let browser: Browser;
let base = "";
let project: Project;
let lead: Member;
const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));
const observation = () => ({ source: "core" as const, observedAt: new Date().toISOString(), freshness: "fresh" as const, ownership: "verified" as const, consecutiveFailures: 0, error: null });
async function until(what: string, ok: () => boolean) {
  for (let i = 0; i < 200; i++) { if (ok()) return; await settle(20); }
  throw new Error(`기다리다 끝남: ${what}`);
}
async function startWork(id: string, text: string) {
  store.enqueue({ projectId: project.id, memberId: id, kind: "instruction", text });
  await orch.pump(id);
  await until("전달", () => fake.sent.some((s) => s.memberId === id && s.text.includes(text)));
  fake.callback({ type: "status", memberId: id, status: "working", observation: observation() });
  await until("일하는 중", () => store.requireMember(id).status === "working");
}
async function endTurn(id: string, turn: number) {
  fake.busy.delete(id);
  fake.callback({ type: "turn_end", memberId: id, terminalId: store.requireMember(id).paneId, turn, finalText: "", isError: false });
  await settle(10);
  fake.callback({ type: "status", memberId: id, status: "idle", observation: observation() });
}

beforeAll(async () => {
  const home = mkdtempSync(join(tmpdir(), "iamceo-stop-web-"));
  const env = { IAMCEO_HOME: home, IAMCEO_PORT: "0" };
  updateConfigFile({ accessCode: CODE, hosts: ["127.0.0.1"] }, env);
  const config = loadConfig(env);
  const bus = new Bus();
  store = new Store(openDb(config.dbPath), bus);
  fake = new FakeCore();
  orch = new Orchestrator({ config, store, runners: new Map<Backend, Runner>([["core", fake]]), timings: { tickMs: 60_000, healthMs: 60_000, retryMs: 5 } });
  server = await startServer({ config, store, bus, orch, delivery: orch.deliveryRecovery });
  base = server.urls[0]!;
  orch.setServerUrl(base);
  project = store.createProject({ name: "멈춤 시험", cwd: home, runnerEnabled: true });
  lead = store.createMember({ projectId: project.id, handle: "lead", name: "총괄", kind: "conductor", origin: "runner", backend: "core", status: "idle", paneId: "t-lead", sessionId: "s-lead" });
  store.ensureContextState(lead.id);
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await orch.shutdown();
  await server.stop();
  console.log(`shots: ${SHOTS}`);
});

async function openThread(page: Page) {
  await page.goto(`${base}/api/health`);
  await page.evaluate((code) => localStorage.setItem("iamceo.accessCode", code), CODE);
  await page.goto(`${base}/#/p/${encodeURIComponent(project.id)}/thread`);
  await page.getByLabel("입력칸").waitFor({ timeout: 20_000 });
}

describe("웹 멈춤·이어서 지시", () => {
  test("일하는 총괄: 멈출 대상이 보이고, '멈추고 이 글로 이어가기'는 글을 먼저 고정한 뒤 멈추며 끝난 뒤 한 번 전달한다", async () => {
    await startWork(lead.id, "Agent-A도 목업으로 만들어봐");
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    await openThread(page);
    const bar = page.locator(".cmp-stop");
    await bar.waitFor({ timeout: 10_000 });
    const runId = store.requireMember(lead.id).executionState!.runId;
    await expect(bar.innerText()).resolves.toContain(`총괄 일하는 중 · 실행 ${runId.slice(0, 8)} · 작업: 전체`);
    await page.screenshot({ path: join(SHOTS, "1-working-bar.png") });

    // 이어가기: 멈춤 키가 도는 동안 버튼은 눌리지 않고(겹친 클릭 방지), 글은 이미 대기열에 있다
    let open!: () => void;
    fake.gate = new Promise<void>((r) => { open = r; });
    await page.getByLabel("입력칸").fill("정확히는 Agent-A 고려한 설계안");
    await page.getByRole("button", { name: "멈추고 이 글로 이어가기" }).click();
    await until("글 저장", () => store.listMessages(project.id).some((m) => m.body === "정확히는 Agent-A 고려한 설계안"));
    await page.getByRole("button", { name: "멈추는 중…" }).waitFor();
    await expect(page.getByRole("button", { name: "멈추고 이 글로 이어가기" }).isDisabled()).resolves.toBe(true);
    await page.screenshot({ path: join(SHOTS, "2-stopping.png") });
    const msg = store.listMessages(project.id).find((m) => m.body === "정확히는 Agent-A 고려한 설계안")!;
    expect(store.listDeliveries(project.id).find((d) => d.refId === msg.id)?.status).toBe("queued");
    open();
    fake.gate = null;
    await page.locator(".cmp-stop__result", { hasText: "멈췄습니다" }).waitFor({ timeout: 10_000 });
    await expect(page.locator(".cmp-stop__result").innerText()).resolves.toContain("보낸 글은 입력이 가능해지면 한 번 전달됩니다");
    expect(fake.interrupts).toBe(1);
    expect(fake.sent.some((s) => s.text.includes("정확히는 Agent-A"))).toBe(false);
    await page.screenshot({ path: join(SHOTS, "3-stopped.png") });

    // 멈춘 턴이 끝나면 고정한 글이 한 번만 나가고, 끊긴 일은 다시 나가지 않는다
    await endTurn(lead.id, 1);
    await until("이어서 지시 전달", () => fake.sent.some((s) => s.text.includes("정확히는 Agent-A")));
    await settle(100);
    expect(fake.sent.filter((s) => s.text.includes("정확히는 Agent-A"))).toHaveLength(1);
    expect(fake.sent.filter((s) => s.text.includes("Agent-A도 목업으로"))).toHaveLength(1);
    expect(fake.sent.some((s) => s.text.includes("보고 보완"))).toBe(false);
    expect(store.getExecutionJournal(runId)).toMatchObject({ result: "interrupted", reason: "대표가 멈췄습니다" });
    await page.screenshot({ path: join(SHOTS, "4-delivered.png") });

    // 폰 폭에서도 줄이 잘리지 않는다
    fake.callback({ type: "status", memberId: lead.id, status: "working", observation: observation() });
    await until("다시 일하는 중", () => store.requireMember(lead.id).status === "working");
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await openThread(phone);
    await phone.locator(".cmp-stop").waitFor({ timeout: 10_000 });
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await phone.screenshot({ path: join(SHOTS, "5-phone.png") });
    // '멈춤'만 누르면 글 없이 멈춘다
    await phone.getByRole("button", { name: "멈춤", exact: true }).click();
    await phone.locator(".cmp-stop__result", { hasText: "멈췄습니다" }).waitFor({ timeout: 10_000 });
    expect(fake.interrupts).toBe(2);
    await phone.screenshot({ path: join(SHOTS, "6-phone-stopped.png") });
  }, 90_000);
});
