// Exercise the real task, workflow, thread and inbox routes in an isolated project.
import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import type { Bus } from "../server/bus.ts";
import type { ContractInput } from "../server/harness.ts";
import { startServer } from "../server/http.ts";
import { fixture } from "./fixtures/harness-fixture.ts";

test("업무 흐름과 대화가 팀 점검·보류 사유와 대표 할 일을 구분하고 완료 알림을 한 번 확인한다 (PC·390)", async () => {
  const f = fixture(), projectId = f.project.id;
  const shots = process.env.IAMCEO_E2E_SHOTS ?? join(f.isolated.dir, "shots");
  mkdirSync(shots, { recursive: true });
  const coding: ContractInput = { kind: "coding", goal: "결제 결과를 검증한다", acceptance: ["요청한 결제 흐름을 검증한다"], checks: ["behavior"] };
  const pay = f.orch.saveTask(f.lead, { title: "결제 화면 고치기", contract: coding }).task;
  const merge = f.orch.saveTask(f.lead, { title: "통합 뒤 회귀 확인", contract: coding }).task;
  const old = f.orch.saveTask(f.lead, { title: "옛 입력 확인" }).task;
  const hold = f.orch.saveTask(f.lead, { title: "자료 대조 보류" }).task;
  const login = f.orch.saveTask(f.lead, { title: "맥미니 로그인 확인" }).task;
  const doc = f.orch.saveTask(f.lead, { title: "운영 문서 정리", contract: {
    kind: "other", goal: "운영 인계 절차를 확정한다", inputs: ["운영 문서와 기존 인계 사례"],
    outputs: ["담당과 다음 행동을 명시한 인계 절차"], scope: "운영 인계 문서", exclusions: [], constraints: [],
    acceptance: ["담당과 다음 행동이 원래 인계 내용과 일치한다"], checks: [],
  } }).task;
  async function post(member: typeof f.worker, taskId: string, kind: string, title: string, result: string, name: string, isDocument = false) {
    const evidence = isDocument ? "실제 인계 문서의 담당과 다음 행동을 원래 인계 사례와 대조했습니다." : name + " " + result;
    const report = await f.tool(member, "post", { task_id: taskId, kind, title, body: evidence, contract_rev: 1,
      checks: [{ kind: isDocument ? "other" : "behavior", name, result, criterion: 1, evidence,
        ...(result === "pass" && !isDocument ? { command: "bun test behavior" } : {}) }] });
    expect(report.isError, report.text).toBeUndefined();
  }
  f.ran(f.worker, "bun test behavior");
  await post(f.worker, pay.id, "완료", "결제 화면 납품", "pass", "결제 동작");
  await post(f.worker2, pay.id, "막힘", "환불 반례 확인", "fail", "환불 반례");
  await post(f.worker2, merge.id, "막힘", "통합 뒤 회귀만 남음", "not_run", "통합 뒤 회귀");
  const todo = f.store.createTodo({ projectId, taskId: login.id, title: "맥미니에서 Codex 로그인" });
  const suspended = "원본 인계 자료를 받아 두 판의 차이를 대조할 때까지 보류";
  f.orch.markTaskStage(f.lead, { taskId: hold.id, stage: "hold", evidence: suspended });
  const held = f.store.enqueue({ projectId, memberId: f.worker2.id, kind: "instruction", text: "보호된 옛 입력", status: "held", holdReason: "delivery_unknown", taskId: old.id });
  await post(f.worker, doc.id, "완료", "운영 인계 원문 대조 완료", "pass", "인계 문서 확인", true);
  f.orch.setWork(projectId, { sec: "doing", title: pay.title, who: f.worker.name, taskId: pay.id });
  const planned = f.orch.setWork(projectId, { sec: "next", title: "다음 주 계획", who: f.lead.name });
  const completed = f.store.taskProgress(doc.id);
  expect(completed).toMatchObject({ stage: "done", finalReview: { status: "pending", contractRev: 1 } });
  const noticeId = completed.notice!.id;
  const fix = "총괄이 수정 범위를 조정합니다 · 수정 담당 철수 · 실패 1건(환불 반례)";
  expect(f.store.taskProgress(pay.id).next).toBe(fix);
  expect(f.store.taskProgress(merge.id).stage).toBe("confirm");

  const server = await startServer({ config: f.config, store: f.store, bus: (f.store as unknown as { bus: Bus }).bus,
    orch: f.orch, delivery: f.orch.deliveryRecovery });
  const base = server.urls[0]!;
  f.orch.setServerUrl(base);
  const browser = await chromium.launch();
  try {
    for (const [width, tag] of [[1280, "pc"], [390, "390"]] as const) {
      const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 900 } });
      page.setDefaultTimeout(7000);
      try {
        await page.addInitScript(code => localStorage.setItem("iamceo.accessCode", code), f.config.accessCode);
        const open = (tab: string) => page.goto(`${base}/#/p/${projectId}/${tab}`);
        await open("team");
        const filters = page.getByRole("navigation", { name: "업무 상태" });
        const owner = filters.getByRole("button", { name: /^대표 응답/ });
        await owner.waitFor();
        expect(await owner.locator(".wf-count").innerText()).toBe("1");
        await owner.click();
        const requests = page.getByRole("region", { name: "대표 응답 업무" });
        const request = requests.locator(`.tt-item[data-task-id="${login.id}"]`);
        await request.waitFor();
        expect(await requests.locator(".tt-item").count()).toBe(1);
        await request.locator(".tt-title").click();
        expect(await request.getByRole("link", { name: /내 할 일 열기/ }).getAttribute("href")).toBe(`#/p/${projectId}/home/${todo.id}`);
        await page.screenshot({ path: join(shots, `team-${tag}.png`) });

        await open("thread");
        await page.locator('.cmp-task[data-id]:not([aria-hidden="true"])').first().click();
        const toggle = page.getByRole("button", { name: "업무 흐름", exact: true });
        await toggle.click();
        const detail = async (task: typeof pay) => {
          await page.locator(`.wf-node[data-task-id="${task.id}"]`).first().click();
          const dialog = page.getByRole("dialog", { name: task.title, exact: true });
          await dialog.waitFor();
          return dialog;
        };
        const plan = page.locator(".wf-node").filter({ hasText: planned.title });
        await plan.waitFor();
        expect(await plan.count()).toBe(1);
        expect(await page.locator(".wf-node").filter({ hasText: pay.title }).evaluateAll(nodes =>
          [...new Set(nodes.map(node => node.getAttribute("data-task-id")))])).toEqual([pay.id]);
        let dialog = await detail(hold);
        expect((await dialog.innerText()).split(suspended).length - 1).toBe(1);
        expect(await dialog.locator(".wf-detail__reason").innerText()).toContain(suspended);
        await page.keyboard.press("Escape");
        dialog = await detail(old);
        expect(await dialog.locator(".wf-detail__facts").innerText()).toContain("수신·처리 불확실");
        expect(await dialog.locator(".wf-detail__facts").innerText()).toContain("자동으로 다시 보내지 않습니다");
        await page.keyboard.press("Escape");
        dialog = await detail(pay);
        expect(await dialog.innerText()).toContain(fix);
        await dialog.getByRole("link", { name: /업무 대화/ }).click();
        const payThread = page.locator(".th-task").filter({ hasText: pay.title });
        await payThread.waitFor();
        expect(await payThread.innerText()).toContain(fix);
        if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
        dialog = await detail(merge);
        const facts = await dialog.locator(".wf-detail__facts").innerText();
        expect(facts).toContain("팀 확인 대기");
        expect(await dialog.innerText()).toContain("통합 뒤 회귀");
        await dialog.getByRole("link", { name: /업무 대화/ }).click();
        const thread = page.locator(".th-task").filter({ hasText: merge.title });
        await thread.waitFor();
        expect(await thread.innerText()).toContain("팀 확인 대기");
        expect(await thread.innerText()).toContain("통합 뒤 회귀");
        await page.screenshot({ path: join(shots, `thread-${tag}.png`) });

        await open("inbox");
        const inbox = page.getByRole("navigation", { name: "결재 분류" });
        await inbox.waitFor();
        expect(await inbox.getByRole("link", { name: /결재할 항목/ }).innerText()).toMatch(/결재할 항목\s*0/);
        const notice = page.getByRole("article", { name: "운영 문서 정리 수행 완료", exact: true });
        await notice.waitFor();
        expect(await page.getByRole("region", { name: "완료 알림" }).getByRole("article").count()).toBe(1);
        expect(await notice.innerText()).toContain("계약 r1의 완료 조건을 통과했습니다");
        expect(await notice.innerText()).not.toMatch(/#msg_|#tk_/);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: join(shots, `inbox-${tag}.png`) });
        if (tag === "390") {
          const [receipt] = await Promise.all([
            page.waitForResponse(r => r.url().includes(`/task-notices/${noticeId}`) && r.request().method() === "POST"),
            notice.getByRole("button", { name: "확인", exact: true }).click(),
          ]);
          expect(receipt.ok()).toBe(true);
          await notice.waitFor({ state: "detached" });
          await page.reload();
          await inbox.waitFor();
          expect(await page.getByRole("region", { name: "완료 알림" }).count()).toBe(0);
          await page.screenshot({ path: join(shots, "inbox-390-seen.png") });
        }
      } finally { await page.close(); }
    }
  } finally {
    await browser.close();
    await server.stop();
  }
  expect(f.store.db.query("SELECT COUNT(*) AS n, COUNT(seen_at) AS seen FROM task_notices").get()).toEqual({ n: 1, seen: 1 });
  expect(f.store.requireTodo(todo.id).done).toBe(false);
  expect(f.store.requireDelivery(held.id)).toMatchObject({ status: "held", attempts: 0 });
  expect(f.runner.to(f.worker2).some(text => text.includes("보호된 옛 입력"))).toBe(false);
}, 90_000);
