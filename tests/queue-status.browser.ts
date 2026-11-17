// Real HTTP, CoreRunner, Orchestrator and Chromium; isolated core RPC peer, no model calls.
import { expect, test } from 'bun:test';
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from '../server/http.ts';
import { composer, createQueueStatusFixture } from './fixtures/queue-status-runtime.ts';

for (const [name, width, height] of [['desktop', 1440, 1000], ['narrow', 390, 844]] as const) {
  test(`background regression stays working in server response and ${name} team screen`, async () => {
    const f = await createQueueStatusFixture();
    const server = await startServer({ config: f.config, bus: f.bus, store: f.store, orch: f.orch, delivery: f.orch.deliveryRecovery, detectHosts: () => [] });
    const base = `http://127.0.0.1:${server.port}`;
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    try {
      await page.addInitScript(code => localStorage.setItem('iamceo.accessCode', code), f.config.accessCode);
      const original = f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, kind: 'instruction', text: 'Run isolated regression', wake: true });
      await f.orch.pump(f.member.id);
      f.setScreen(composer('  ⏵⏵ bypass permissions on · 1 shell, 2 monitors')); f.done();
      await page.goto(`${base}/#/p/${f.project.id}/team/${f.member.id}`);
      await page.locator('.tm-status').filter({ hasText: '일하는 중' }).first().waitFor({ timeout: 15_000 });
      const response = await fetch(`${base}/api/members/${f.member.id}`, { headers: { Authorization: `Bearer ${f.config.accessCode}` } });
      expect(response.status).toBe(200);
      const member = await response.json(); expect(member.status).toBe('working'); expect(member.blockedReason).toBeNull();
      expect(f.store.listOpenDecisions(f.project.id)).toHaveLength(0);
      expect(f.store.requireDelivery(original.id).status).toBe('delivered');
      expect(f.writes).toHaveLength(1);
      expect(await page.getByText('승인 창 앞에서 멈췄습니다.', { exact: false }).count()).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const root = resolve('evidence/screens'); mkdirSync(root, { recursive: true });
      await page.screenshot({ path: `${root}/${name}-background.png`, fullPage: true });
      writeFileSync(`${root}/${name}-state.json`, JSON.stringify({ member: { status: member.status, blockedReason: member.blockedReason, executionState: member.executionState }, viewport: { width, height }, originalId: original.id, writes: f.writes.length, pageErrors: errors }, null, 2));
      f.setScreen(composer());
      await page.locator('.tm-status').filter({ hasText: '대기' }).first().waitFor({ timeout: 15_000 });
      expect(errors).toHaveLength(0);
    } finally { await context.close(); await browser.close(); await server.stop(); await f.stop(); }
  }, 30_000);
}

for (const [name, width, height] of [['desktop', 1440, 1000], ['narrow', 390, 844]] as const) {
  test(`capacity and quota have distinct live reasons and retry controls on ${name}`, async () => {
    const f = await createQueueStatusFixture(1);
    const server = await startServer({ config: f.config, bus: f.bus, store: f.store, orch: f.orch, delivery: f.orch.deliveryRecovery, detectHosts: () => [] });
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width, height } });
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    try {
      await f.orch.sendUserMessage(f.project.id, { targetMemberId: f.member.id, text: 'Occupy capacity' });
      const second = await f.orch.createMember(f.project.id, { name: 'Capacity waiter', cli: 'claude' });
      const queued = f.store.enqueue({ projectId: f.project.id, memberId: second.id, kind: 'instruction', text: 'Keep this queued', wake: true });
      await f.orch.pump(second.id);
      await page.addInitScript(code => localStorage.setItem('iamceo.accessCode', code), f.config.accessCode);
      const base = `http://127.0.0.1:${server.port}`;
      await page.goto(`${base}/#/p/${f.project.id}/team/${second.id}`);
      await page.locator('.tm-detail .tm-status').filter({ hasText: '실행 자리 대기' }).waitFor({ timeout: 15_000 });
      expect(await page.locator('.tm-detail .tm-facts').textContent()).toContain('전체 실행 1/1개가 사용 중');
      expect(f.store.requireDelivery(queued.id)).toMatchObject({ status: 'queued', attempts: 0 });
      const terminal = f.terminals.get(f.store.requireMember(f.member.id).paneId!)!;
      terminal.turn = (terminal.turn ?? 0) + 1;
      terminal.status = { state: 'error', app: 'claude-code', msg: "You've hit your weekly limit · resets 7am (Asia/Seoul)" };
      await page.goto(`${base}/#/p/${f.project.id}/team/${f.member.id}`);
      await page.locator('.tm-detail .tm-status').filter({ hasText: '사용량 한도' }).waitFor({ timeout: 15_000 });
      await page.getByRole('button', { name: '다시 확인', exact: true }).waitFor();
      expect(await page.locator('.tm-detail .tm-error').textContent()).toContain('weekly limit');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(errors).toHaveLength(0);
    } finally { await browser.close(); await server.stop(); await f.stop(); }
  }, 30_000);
}
