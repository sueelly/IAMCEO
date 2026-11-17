import { afterEach, expect, test } from 'bun:test';
import { backgroundWait } from '../server/runner/herdr.ts';
import { composer, createQueueStatusFixture } from './fixtures/queue-status-runtime.ts';

const closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
async function fixture() { const f = await createQueueStatusFixture(); closes.push(f.stop); return f; }
async function until(read: () => boolean) {
  for (let i = 0; i < 200 && !read(); i++) await Bun.sleep(5);
  expect(read()).toBe(true);
}
const footer = (counts: string) => `  ⏵⏵ bypass permissions on · ${counts}`;
const plain = 'Documentation example: 1 shell, 2 monitors are words, no job is running.';

test('modern task counts require complete footer fields and keep zero counts out of the label', () => {
  for (const [line, expected] of [
    [footer('1 shell, 2 monitors'), '1 shell, 2 monitors'],
    [footer('10 shells'), '10 shells'],
    [footer('0 shells, 2 monitors'), '2 monitors'],
    [footer('1 shell, 0 monitors'), '1 shell'],
    ['  ⏵⏵ bypass permissions on (shift+tab to cycle) · 1 shell, 2 monitors', '1 shell, 2 monitors'],
    [footer('0 shells, 0 monitors'), null],
  ] as const) expect(backgroundWait(composer(line))).toBe(expected);
  expect(backgroundWait(composer('  ◯ regression  ▰▰▰▱'))).toBe('regression');
});

test('shell-like prose below the composer cannot become a background label', () => {
  for (const line of [
    plain,
    '1 shell, 2 monitors',
    'Documentation example · 1 shell, 2 monitors',
    footer('1 shell, 2 monitors are words, no job is running.'),
    footer('Documentation example: 1 shell, 2 monitors'),
    '⏵⏵ Documentation example · 1 shell, 2 monitors',
  ]) expect(backgroundWait(composer(line))).toBeNull();
});

test('plain footer prose leaves the original ended and creates one required report followup', async () => {
  const f = await fixture();
  const original = f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, kind: 'instruction', text: 'Unreported original with plain footer', wake: true });
  await f.orch.pump(f.member.id);
  const run = f.store.listPendingExecutions().find(r => r.deliveryIds.includes(original.id))!;
  f.setScreen(composer(plain)); f.done();
  await until(() => f.writes.length === 2);
  expect(f.store.getExecutionJournal(run.runId)?.phase).toBe('ended');
  expect(f.store.listDeliveries().filter(d => d.text.includes('보고 보완'))).toHaveLength(1);
  expect(f.writes.filter(w => w.text.includes('Unreported original with plain footer'))).toHaveLength(1);
  f.done(); await Bun.sleep(80);
  expect(f.writes).toHaveLength(2);
});

test('a read failure preserves observed background until a complete zero-count footer clears it', async () => {
  const f = await fixture();
  f.setScreen(composer(footer('1 shell, 2 monitors')));
  await until(() => f.store.requireMember(f.member.id).status === 'working');
  f.setReadFailure(true); f.setScreen(composer(footer('0 shells, 0 monitors')));
  await Bun.sleep(70);
  expect(f.store.requireMember(f.member.id).status).toBe('working');
  f.setReadFailure(false);
  await until(() => f.store.requireMember(f.member.id).status === 'idle');
  expect(f.writes).toHaveLength(0);
});

test('a genuine count footer is published before its original turn ends', async () => {
  const f = await fixture();
  const events: { type: string; label?: string | null }[] = [];
  const runner = f.runner as unknown as { event(track: unknown, event: { type: string; label?: string | null }): void };
  const emit = runner.event.bind(runner);
  runner.event = (track, event) => { events.push(event); emit(track, event); };
  f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, kind: 'instruction', text: 'Original for background event order', wake: true });
  await f.orch.pump(f.member.id);
  f.setScreen(composer(footer('1 shell, 2 monitors'))); f.done();
  await until(() => events.some(e => e.type === 'turn_end'));
  const background = events.findIndex(e => e.type === 'background' && !!e.label);
  expect(background).toBeGreaterThanOrEqual(0);
  expect(events.findIndex(e => e.type === 'turn_end')).toBeGreaterThan(background);
  expect(f.store.requireMember(f.member.id).status).toBe('working');
  expect(f.writes).toHaveLength(1);
});
