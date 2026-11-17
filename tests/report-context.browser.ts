import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { startServer } from "../server/http.ts";
import type { Bus } from "../server/bus.ts";
import { TaskContinuationCoordinator } from "../server/task-continuation.ts";
import { fixture } from "./fixtures/harness-fixture.ts";

setDefaultTimeout(60_000);
test("자동 결재의 업무·요청·보고·미확인 대상이 데스크톱과 휴대폰 본문에 보인다", async () => {
  const f = fixture();
  const dir = process.env.IAMCEO_E2E_SHOTS ?? join(f.isolated.dir, "report-context");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const task = f.store.ensureSourceTask({ projectId: f.project.id, sourceRef: "context-browser", title: "로그인 재개 오류 조사", origin: "owner" }).task;
  const request = "IAMCEO 로그인 재개 실패의 전달 기록과 세션 기록을 대조해 주세요. 운영 서버를 재시작하지 마세요.";
  const source = f.store.enqueue({ projectId: f.project.id, taskId: task.id, memberId: f.worker.id, kind: "user_message", text: request });
  f.store.markDelivered(source.id);
  f.store.saveTaskContract(task.id, { kind: "research", goal: "로그인 재개 실패 원인을 확인한다", acceptance: ["실패한 전달과 세션의 관계를 확인한다"] }, { author: f.lead.name, authorMemberId: f.lead.id, authorKind: "conductor" });
  const body = "전달 ID dl_login001의 입력 수신은 확인했습니다. 원본 세션의 종료 기록에 접근하지 못해 재개 실패 원인은 아직 미확인입니다.";
  f.store.createMessage({ projectId: f.project.id, taskId: task.id, memberId: f.worker.id, who: f.worker.name, kind: "막힘", title: "로그인 재개 실패의 세션 기록을 찾지 못했습니다", body });
  const coordinator = new TaskContinuationCoordinator(f.store, { intervalMs: 1, sameLimit: 3 });
  let now = Date.now() + 10000;
  for (let i = 0; i < 3; i++) {
    const d = coordinator.check(now, () => true)[0]!; expect(d).toBeDefined();
    f.store.markDelivered(d.id);
    const stamp = new Date(now + 1).toISOString();
    f.store.saveExecutionJournal({ runId: "context:" + d.id, memberId: f.lead.id, projectId: f.project.id,
      identity: { terminalId: f.lead.paneId, sessionId: f.lead.sessionId, sessionGeneration: f.store.memberRevisions(f.lead.id).sessionGeneration, process: null },
      turn: 1, deliveryIds: [d.id], phase: "ended", inputReceivedAt: stamp, startedAt: stamp, lastProgressAt: stamp, endedAt: stamp,
      result: "success", reason: null, exitCode: 0, interruptionNotifiedAt: null, reportRequestedAt: null, createdAt: stamp, updatedAt: stamp });
    now += 10000;
  }
  coordinator.check(now, () => true);
  const decision = f.store.listDecisions(f.project.id).find(d => d.status === "open")!;
  writeFileSync(join(dir, "decision-example.md"), `# 수정된 자동 결재문 예시\n\n격리 검사에서 만든 가상 업무와 보고입니다. 실제 운영 업무의 상태가 아닙니다.\n\n${decision.title}\n\n${decision.detail}\n`);
  const bus = (f.store as unknown as { bus: Bus }).bus;
  const server = await startServer({ config: f.config, store: f.store, bus, orch: f.orch, delivery: f.orch.deliveryRecovery });
  let browser;
  try {
    browser = await chromium.launch();
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.goto(server.urls[0]! + "/api/health");
      await page.evaluate(code => localStorage.setItem("iamceo.accessCode", code), f.config.accessCode);
      await page.goto(`${server.urls[0]}/#/p/${f.project.id}/inbox`);
      const card = page.locator(`[data-decision="${decision.id}"]`);
      await card.waitFor({ timeout: 20000 });
      const text = await card.innerText();
      for (const part of [task.title, request, body, "조정 요청 3회", "실패한 전달과 세션의 관계를 확인한다"]) expect(text).toContain(part);
      expect(await card.locator("details:not([open])").count()).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      await page.screenshot({ path: join(dir, `decision-${width}.png`), fullPage: true });
      await page.close();
    }
    expect(f.store.getDecision(decision.id)?.status).toBe("open");
  } finally {
    await browser?.close();
    await server.stop();
  }
});
