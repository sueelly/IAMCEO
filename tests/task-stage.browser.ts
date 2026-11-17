// 업무 단계 화면(대표 2026-11-17 #4aab3546): 팀 아래 일 목록·대화의 업무 줄·결재함 완료 알림을 PC 1280·폰 390 으로 찍는다.
// 실제 서버(http.ts)·실제 Store·Orchestrator·실제 웹 화면·격리 DB. 실행기는 가짜(실제 CLI·모델 없음).
// 같은 파일을 기준 메인에서도 돌린다: 자료 만들기는 옛 서버에도 있는 길만 쓰고(옛 서버가 거절하는 task_id 연결은 빼고 다시 부른다),
// 모든 화면을 먼저 찍은 뒤 판정한다. 그래서 고치기 전에는 찍은 뒤 실패하고, 고친 뒤에는 통과한다.
import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import { startServer } from "../server/http.ts";
import type { Bus } from "../server/bus.ts";
import { fixture } from "./fixtures/harness-fixture.ts";

setDefaultTimeout(120_000);
const id = (r: { text: string }, prefix = "tk") => r.text.match(new RegExp(`#(${prefix}_[\\w-]+)`))![1]!;
const check = (kind: string, result: "pass" | "fail" | "not_run", name = kind) =>
  ({ kind, name, result, evidence: `${name} ${result}`, criterion: 1, ...(result === "pass" ? { command: `bun test ${name}` } : {}) });
const ONE = { kind: "coding", goal: "단계가 이어진다", acceptance: ["대화와 목록이 같은 단계"], checks: ["behavior"] };

test("팀 목록·대화·결재함이 같은 업무 단계를 보이고 완료 알림을 한 번 보인다(PC·390)", async () => {
  const f = fixture();
  const SHOTS = process.env.IAMCEO_E2E_SHOTS ?? join(f.isolated.dir, "shots");
  mkdirSync(SHOTS, { recursive: true });
  const t = (title: string, contract?: unknown) => f.tool(f.lead, "task", { title, ...(contract ? { contract } : {}) }).then((r) => id(r));
  // 1) 검토자 반례가 실패한 납품: 고칠 것(철수)
  const pay = await t("결제 화면 고치기", ONE);
  const original = f.store.enqueue({ projectId: f.project.id, memberId: f.worker.id, taskId: pay, kind: "instruction", text: "기존 구현 맡김" });
  f.store.noteDelegation(f.lead.id, original, false); f.store.markDelivered(original.id);
  f.ran(f.worker, "bun test behavior");
  await f.tool(f.worker, "post", { task_id: pay, kind: "완료", title: "결제 화면 납품", contract_rev: 1, checks: [check("behavior", "pass")] });
  await f.tool(f.worker2, "post", { task_id: pay, kind: "막힘", title: "검토 반례 1건 실패", contract_rev: 1, checks: [check("behavior", "fail", "환불 반례")] });
  // 2) 대표 할 일을 기다리는 업무(진행판에 없음)
  const login = await t("맥미니 로그인 확인");
  await f.tool(f.worker, "todo", { title: "맥미니에서 Codex 로그인", task_id: login });
  await f.tool(f.worker, "post", { task_id: login, kind: "막힘", title: "로그인을 기다립니다" });
  // 3) 실행 안 한 검사만 남은 막힘: 확인 대기(결재 0건)
  const merge = await t("통합 뒤 회귀 확인", ONE);
  await f.tool(f.worker2, "post", { task_id: merge, kind: "막힘", title: "통합 뒤 회귀만 남음", contract_rev: 1, checks: [check("behavior", "not_run", "통합 뒤 회귀")] });
  // 4) 계약·브랜치 없는 업무의 완료: 완료 알림
  const doc = await t("운영 문서 정리");
  await f.tool(f.worker, "post", { task_id: doc, kind: "완료", title: "운영 문서를 정리했습니다" });
  // 5) 보호 보류(수신 불확실): 자동 재전송 없음
  const old = await t("옛 입력 확인");
  f.store.enqueue({ projectId: f.project.id, memberId: f.worker2.id, kind: "instruction", text: "보호된 옛 입력", status: "held", holdReason: "delivery_unknown", taskId: old });
  // 진행판: 결제 업무를 가리키는 항목(옛 서버는 task_id 를 거절하므로 없이 다시), 손으로 둔 예정 항목
  const linked = await f.tool(f.lead, "work_set", { sec: "doing", title: "결제 화면 고치기", who: "철수", task_id: pay });
  if (linked.isError) await f.tool(f.lead, "work_set", { sec: "doing", title: "결제 화면 고치기", who: "철수" });
  await f.tool(f.lead, "work_set", { sec: "next", title: "다음 주 계획", who: "총괄" });

  const bus = (f.store as unknown as { bus: Bus }).bus;
  const server = await startServer({ config: f.config, store: f.store, bus, orch: f.orch, delivery: f.orch.deliveryRecovery });
  const base = server.urls[0]!;
  f.orch.setServerUrl(base);
  const browser = await chromium.launch();
  const seen: Record<string, string> = {};
  try {
    const open = async (width: number, tab: string) => {
      const page = await browser.newPage({ viewport: { width, height: width < 500 ? 844 : 900 } });
      await page.goto(`${base}/api/health`);
      await page.evaluate((c) => localStorage.setItem("iamceo.accessCode", c), f.config.accessCode);
      await page.goto(`${base}/#/p/${encodeURIComponent(f.project.id)}/${tab}`);
      // 실시간 연결이 붙은 뒤 찍는다(연결 전의 '서버 끊김' 표시를 화면 근거로 남기지 않는다).
      await page.waitForFunction(() => !document.body.innerText.includes("서버 끊김"), null, { timeout: 8000 }).catch(() => {});
      return page;
    };
    const text = async (page: Page, selector: string) => (await page.locator(selector).count()) ? (await page.locator(selector).first().innerText()) : "";
    for (const [width, tag] of [[1280, "pc"], [390, "390"]] as const) {
      const team = await open(width, "team");
      await team.locator(".tm").waitFor({ timeout: 20_000 });
      await team.locator(".tm-work").waitFor({ timeout: 10_000 }).catch(() => {});
      await team.locator(".tm-work").scrollIntoViewIfNeeded().catch(() => {});
      await team.screenshot({ path: join(SHOTS, `team-${tag}.png`), fullPage: true });
      seen[`team-${tag}`] = await text(team, ".tm-work");
      seen[`card-${tag}`] = await text(team, ".tm-grid");
      await team.close();

      const thread = await open(width, "thread");
      await thread.locator(`.cmp-task[data-id="${pay}"]`).waitFor({ state: "attached", timeout: 20_000 });
      await thread.locator(`.cmp-task[data-id="${pay}"]`).evaluate((b) => (b as HTMLButtonElement).click());
      await thread.locator(".th-task").waitFor({ timeout: 10_000 });
      await thread.waitForTimeout(300);
      await thread.screenshot({ path: join(SHOTS, `thread-${tag}.png`) });
      seen[`thread-${tag}`] = await text(thread, ".th-task");
      await thread.close();

      const inbox = await open(width, "inbox");
      await inbox.locator(".ibx").waitFor({ timeout: 20_000 });
      await inbox.waitForTimeout(300);
      await inbox.screenshot({ path: join(SHOTS, `inbox-${tag}.png`), fullPage: true });
      seen[`inbox-${tag}`] = await text(inbox, ".ibx");
      if (tag === "390") {
        // 다른 화면에서 확인을 누르면 알림이 내려가고 서버에 한 번 남는다.
        const button = inbox.locator(".ibx-notice__seen");
        if (await button.count()) {
          const [response] = await Promise.all([inbox.waitForResponse((r) => r.url().includes("/task-notices/"), { timeout: 10_000 }), button.first().click()]);
          seen.seenStatus = String(response.status());
          if (!response.ok()) seen.seenBody = await response.text();
          await inbox.locator(".ibx-notice").waitFor({ state: "detached", timeout: 10_000 });
          await inbox.screenshot({ path: join(SHOTS, `inbox-${tag}-seen.png`), fullPage: true });
        }
        seen.overflow = String(await inbox.evaluate(() => document.documentElement.scrollWidth > window.innerWidth));
      }
      await inbox.close();
    }
  } finally {
    await browser.close();
    await server.stop();
    console.log(`shots: ${SHOTS}`);
    console.log(JSON.stringify(seen, null, 1));
  }

  // 판정(모두 찍은 뒤)
  for (const tag of ["pc", "390"]) {
    const list = seen[`team-${tag}`]!;
    expect(list).toContain("결제 화면 고치기");
    expect(list).toContain("고칠 것");
    expect(list).toContain("철수가 고칠 차례: 실패 1건(환불 반례)");
    expect(list).toContain("맥미니 로그인 확인");
    expect(list).toContain("대표님 할 일: 맥미니에서 Codex 로그인");
    expect(list).toContain("통합 뒤 회귀 확인");
    expect(list).toContain("확인 대기");
    expect(list).toContain("옛 입력 확인");
    expect(list).toContain("자동으로 다시 보내지 않습니다");
    expect(list).toContain("다음 주 계획");
    expect(list.match(/결제 화면 고치기/g)!.length).toBe(1);
    expect(seen[`card-${tag}`]).toContain("보류 1");
    expect(seen[`thread-${tag}`]).toContain("고칠 것");
    expect(seen[`inbox-${tag}`]).toContain("운영 문서 정리 완료");
    expect(seen[`inbox-${tag}`]).toMatch(/결재할 항목\s*0/);
    expect(seen[`inbox-${tag}`]).not.toMatch(/#msg_|#tk_/);
  }
  expect(seen.overflow).toBe("false");
  const notices = f.store.db.query<{ n: number; seen: number }, []>("SELECT COUNT(*) AS n, COUNT(seen_at) AS seen FROM task_notices").get()!;
  expect(notices).toEqual({ n: 1, seen: 1 });
  expect(f.runner.to(f.worker2).some((x) => x.includes("보호된 옛 입력"))).toBe(false);
});
