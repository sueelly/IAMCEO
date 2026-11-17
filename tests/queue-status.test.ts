import { afterEach, expect, test } from 'bun:test';
import { composer, createQueueStatusFixture } from './fixtures/queue-status-runtime.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function until(read: () => boolean) {
  for (let i = 0; i < 150 && !read(); i++) await Bun.sleep(5);
  expect(read()).toBe(true);
}
async function fixture(maxConcurrentTurns = 2) {
  const f = await createQueueStatusFixture(maxConcurrentTurns); cleanups.push(f.stop); return f;
}

test('a finished CLI with live shells and monitors stays working, then settles when they finish', async () => {
  const f = await fixture();
  const original = f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, kind: 'instruction', text: 'Run regression', wake: true });
  await f.orch.pump(f.member.id);
  f.setScreen(composer('  ⏵⏵ bypass permissions on · 1 shell, 2 monitors'));
  f.done();
  await until(() => f.store.listActivity(f.member.id).some(a => a.kind === 'turn_end'));
  expect(f.store.requireDelivery(original.id).status).toBe('delivered');
  expect(f.store.requireMember(f.member.id).status).toBe('working');
  expect(f.writes).toHaveLength(1);
  expect(f.store.listDeliveries().some(d => d.text.includes('보고 보완'))).toBe(false);
  f.setScreen(composer('  ⏵⏵ bypass permissions on'));
  await until(() => f.store.requireMember(f.member.id).status === 'idle');
});

test('background-only work does not consume a CLI slot or duplicate its original delivery', async () => {
  const f = await fixture(1);
  const first = f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, kind: 'instruction', text: 'First original', wake: true });
  await f.orch.pump(f.member.id);
  const next = f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, kind: 'instruction', text: 'Independent next original', wake: true });
  await f.orch.pump(f.member.id);
  expect(f.writes).toHaveLength(1);
  f.setScreen(composer('  ⏵⏵ bypass permissions on · 1 shell, 2 monitors')); f.done();
  await until(() => f.store.listActivity(f.member.id).some(a => a.kind === 'turn_end'));
  expect(f.store.requireDelivery(first.id).status).toBe('delivered');
  await until(() => f.store.requireDelivery(next.id).status === 'delivered');
  expect(f.writes).toHaveLength(2);
  expect(f.writes.some(w => w.text.includes('보고 보완'))).toBe(false);
  expect(f.writes.filter(w => w.text.includes('First original'))).toHaveLength(1);
});


test('a partial or unrecognized screen does not erase observed background work', async () => {
  const f = await fixture();
  f.setScreen(composer('  ⏵⏵ bypass permissions on · 1 shell, 2 monitors'));
  await until(() => f.store.requireMember(f.member.id).status === 'working');
  f.setScreen(composer(), false);
  await Bun.sleep(60);
  expect(f.store.requireMember(f.member.id).status).toBe('working');
  f.setScreen('screen unavailable');
  await Bun.sleep(60);
  expect(f.store.requireMember(f.member.id).status).toBe('working');
  expect(f.writes).toHaveLength(0);
  f.setScreen(composer());
  await until(() => f.store.requireMember(f.member.id).status === 'idle');
});

test('permission dialogs with a shell footer remain blocked and preserve the original queue', async () => {
  const f = await fixture();
  f.setScreen(composer('  ⏵⏵ bypass permissions on · 1 shell, 2 monitors'));
  const terminal = f.terminals.get(f.member.paneId!)!;
  terminal.status = { state: 'blocked', kind: 'permission', app: 'claude-code' };
  await until(() => f.store.requireMember(f.member.id).status === 'blocked');
  const original = f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, kind: 'instruction', text: 'Do not approve or replay', wake: true });
  await f.orch.pump(f.member.id);
  expect(f.store.requireDelivery(original.id)).toMatchObject({ status: 'held', holdReason: 'blocked', attempts: 0 });
  expect(f.writes).toHaveLength(0);
});

test('quoted shell counts above a ready composer are not current background work', async () => {
  const f = await fixture();
  f.setScreen('old output: 1 shell, 2 monitors\n' + composer());
  await Bun.sleep(60);
  expect(f.store.requireMember(f.member.id).status).toBe('idle');
  expect(f.writes).toHaveLength(0);
});


test('ending a background-producing turn automatically releases its slot to another queued member', async () => {
  const f = await fixture(1);
  const other = await f.orch.createMember(f.project.id, { name: 'Other fixture worker', cli: 'claude' });
  f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, kind: 'instruction', text: 'First regression', wake: true });
  await f.orch.pump(f.member.id);
  const queued = f.store.enqueue({ projectId: f.project.id, memberId: other.id, kind: 'instruction', text: 'Other original work', wake: true });
  await f.orch.pump(other.id);
  expect(f.writes).toHaveLength(1);
  f.setScreen(composer('  ⏵⏵ bypass permissions on · 1 shell, 2 monitors')); f.done();
  await until(() => f.store.requireDelivery(queued.id).status === 'delivered');
  expect(f.writes).toHaveLength(2);
  expect(f.writes[1].terminal).toBe(other.paneId!);
  expect(f.writes[1].text).toContain('Other original work');
});

test('a quiet turn with no background still receives one bounded missing-report followup', async () => {
  const f = await fixture();
  f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, kind: 'instruction', text: 'Unreported original', wake: true });
  await f.orch.pump(f.member.id); f.done();
  await until(() => f.writes.length === 2);
  expect(f.writes[1].text).toContain('보고 보완');
  f.done(); await Bun.sleep(80);
  expect(f.writes).toHaveLength(2);
});
