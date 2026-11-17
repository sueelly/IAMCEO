import { afterEach, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { composer, createQueueStatusFixture } from './fixtures/queue-status-runtime.ts';
import type { AnswerNativePromptReq } from '../shared/types.ts';

const footer = '  ⏵⏵ bypass permissions on · 1 shell, 2 monitors';
const permission = readFileSync(join(import.meta.dir, 'fixtures/native-prompts/claude-bash-permission.txt'), 'utf8');
const closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
async function until(read: () => boolean, ms = 2000) { const end = Date.now() + ms; while (!read() && Date.now() < end) await Bun.sleep(5); expect(read()).toBe(true); }
async function fixture() {
  const f = await createQueueStatusFixture(1); closes.push(f.stop);
  const task = f.orch.saveTask(f.member, { title: 'Approval and background integration' }).task;
  const original = f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, taskId: task.id, kind: 'instruction', text: 'CROSS_ORIGINAL', wake: true });
  await f.orch.pump(f.member.id);
  const run = f.store.listPendingExecutions().find(r => r.deliveryIds.includes(original.id))!;
  const terminal = f.terminals.get(f.store.requireMember(f.member.id).paneId!)!;
  terminal.status = { state: 'blocked', kind: 'permission', app: 'claude-code' };
  f.setScreen(permission);
  await until(() => f.store.requireMember(f.member.id).status === 'blocked');
  const card = await f.orch.memberNativePrompt(f.member.id);
  expect(card.context).not.toBeNull();
  const req: AnswerNativePromptReq = { ...card.context!, operationId: crypto.randomUUID(), option: 1, via: 'inbox' };
  return { ...f, task, original, run, req };
}
const reportCount = (f: Awaited<ReturnType<typeof fixture>>) => f.store.listDeliveries().filter(d => d.text.includes('보고 보완')).length;
function finish(f: Awaited<ReturnType<typeof fixture>>, text = footer) { f.setOnKeys(() => { f.setScreen(composer(text)); f.done(); }); }

test('approved foreground ends with background before turn_end, one receipt, and normal zero-work release', async () => {
  const f = await fixture();
  const events: { type: string; label?: string | null }[] = [];
  const runner = f.runner as unknown as { event(track: unknown, event: { type: string; label?: string | null }): void };
  const emit = runner.event.bind(runner); runner.event = (track, e) => { events.push(e); emit(track, e); };
  const againCard = await f.orch.memberNativePrompt(f.member.id);
  expect(againCard.context?.observedAt).toBe((await f.orch.memberNativePrompt(f.member.id)).context?.observedAt);
  finish(f);
  const receipt = await f.orch.answerNativePrompt(f.member.id, f.req);
  expect(receipt).toMatchObject({ status: 'answered', terminal: 'accepted', after: 'idle' });
  await until(() => f.store.getExecutionJournal(f.run.runId)?.phase === 'ended');
  const bg = events.findIndex(e => e.type === 'background' && !!e.label), end = events.findIndex(e => e.type === 'turn_end');
  expect(bg).toBeGreaterThanOrEqual(0); expect(end).toBeGreaterThan(bg);
  expect(f.store.requireMember(f.member.id).status).toBe('working');
  expect(await f.orch.answerNativePrompt(f.member.id, f.req)).toEqual(receipt);
  expect(f.keys).toHaveLength(1); expect(f.writes).toHaveLength(1); expect(reportCount(f)).toBe(0);
  writeFileSync(join(f.dir, 'integration-cross.json'), JSON.stringify({ originalId: f.original.id, run: f.store.getExecutionJournal(f.run.runId), receipt, events, originalInputs: f.writes.length, approvalInputs: f.keys.length, reportFollowups: reportCount(f), memberStatus: f.store.requireMember(f.member.id).status }, null, 2));
  f.setScreen(composer('  ⏵⏵ bypass permissions on · 0 shells, 0 monitors'));
  await until(() => f.store.requireMember(f.member.id).status === 'idle');
  expect(f.writes).toHaveLength(1); expect(f.keys).toHaveLength(1);
});

test('approval release admits the queued next original once without consuming a slot for background', async () => {
  const f = await fixture();
  const next = f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, taskId: f.task.id, kind: 'instruction', text: 'CROSS_NEXT', wake: true });
  await f.orch.pump(f.member.id);
  expect(f.store.requireDelivery(next.id).status).toBe('held'); expect(f.writes).toHaveLength(1);
  finish(f); await f.orch.answerNativePrompt(f.member.id, f.req);
  const before = { at: new Date().toISOString(), delivery: f.store.requireDelivery(next.id), retry: f.store.getDeliveryRetry(next.id) };
  // checkAccepted still owns the input mutex when turn_end first wakes the pump.
  // The normal busy-input retry is 5s; observe it without changing that default.
  await until(() => f.store.requireDelivery(next.id).status === 'delivered', 7000);
  expect(f.store.getExecutionJournal(f.run.runId)?.phase).toBe('ended');
  expect(f.writes.filter(w => w.text.includes('CROSS_ORIGINAL'))).toHaveLength(1);
  expect(f.writes.filter(w => w.text.includes('CROSS_NEXT'))).toHaveLength(1);
  expect(f.keys).toHaveLength(1); expect(reportCount(f)).toBe(0);
  writeFileSync(join(f.dir, 'integration-next.json'), JSON.stringify({ before, after: { at: new Date().toISOString(), delivery: f.store.requireDelivery(next.id) }, writes: f.writes, keys: f.keys }, null, 2));
}, 15000);

test('approved plain prose produces one report followup rather than a duplicate original or fake background wait', async () => {
  const f = await fixture();
  finish(f, 'Documentation example: 1 shell, 2 monitors are words, no job is running.');
  const receipt = await f.orch.answerNativePrompt(f.member.id, f.req);
  await until(() => f.writes.length === 2, 7000);
  expect(receipt.terminal).toBe('accepted'); expect(reportCount(f)).toBe(1);
  expect(f.store.getExecutionJournal(f.run.runId)?.phase).toBe('ended');
  expect(f.writes.filter(w => w.text.includes('CROSS_ORIGINAL'))).toHaveLength(1);
  expect(await f.orch.answerNativePrompt(f.member.id, f.req)).toEqual(receipt);
  expect(f.keys).toHaveLength(1); expect(f.writes).toHaveLength(2);
  writeFileSync(join(f.dir, 'integration-report.json'), JSON.stringify({ originalId: f.original.id, originalRun: f.store.getExecutionJournal(f.run.runId), reports: reportCount(f), writes: f.writes, keys: f.keys, receipt }, null, 2));
}, 15000);

test('pending and completed approval requests share one receipt but reject changed content before another key', async () => {
  const f = await fixture(); let release!: () => void;
  f.setKeyGate(new Promise<void>(r => { release = r; })); finish(f);
  const first = f.orch.answerNativePrompt(f.member.id, f.req);
  try {
    await until(() => f.keyRequests() === 1);
    const same = f.orch.answerNativePrompt(f.member.id, f.req);
    for (const change of [{ option: 4 }, { text: 'different' }, { projectId: 'other-project' }, { memberId: 'other-member' }, { promptId: 'stale-window' }, { generation: 99 }, { executionId: 'other-run' }, { via: 'thread' as const }]) {
      await expect(f.orch.answerNativePrompt(f.member.id, { ...f.req, ...change })).rejects.toMatchObject({ status: 409 });
    }
    expect(f.keys).toHaveLength(0); expect(f.writes).toHaveLength(1);
    release(); const receipt = await first; expect(await same).toEqual(receipt);
    await expect(f.orch.answerNativePrompt(f.member.id, { ...f.req, option: 4 })).rejects.toMatchObject({ status: 409 });
    expect(await f.orch.answerNativePrompt(f.member.id, f.req)).toEqual(receipt);
    expect(f.keys).toHaveLength(1);
    expect((await f.orch.answerNativePrompt(f.member.id, { ...f.req, operationId: crypto.randomUUID() })).terminal).toBe('not_sent');
    expect(f.keys).toHaveLength(1);
  } finally { release(); await first; }
});

test('a lost approval reply is retained as unknown and never sends the key again while background is observed', async () => {
  const f = await fixture(); finish(f); f.dropKeyReply();
  const receipt = await f.orch.answerNativePrompt(f.member.id, f.req);
  expect(receipt).toMatchObject({ status: 'unknown', terminal: 'unknown' });
  expect(await f.orch.answerNativePrompt(f.member.id, f.req)).toEqual(receipt);
  await until(() => f.store.requireMember(f.member.id).status === 'working');
  expect(f.keys).toHaveLength(1); expect(f.writes).toHaveLength(1); expect(reportCount(f)).toBe(0);
});

test('task trace while approval is pending keeps IDs, coverage, missing receipt and the pending native receipt unchanged', async () => {
  const f = await fixture(); let release!: () => void;
  const notices = Array.from({ length: 61 }, (_, i) => f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, taskId: f.task.id, kind: 'system', text: `PRIVATE_BODY_${i}`, wake: false }));
  const unlinked = f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, taskId: f.task.id, kind: 'system', text: 'PRIVATE_BODY_UNLINKED', wake: false });
  f.store.markDelivered(unlinked.id);
  f.setKeyGate(new Promise<void>(r => { release = r; })); finish(f);
  const first = f.orch.answerNativePrompt(f.member.id, f.req);
  try {
    await until(() => f.keyRequests() === 1);
    const changes = () => f.store.db.query<{ n: number }, []>('SELECT total_changes() AS n').get()!.n;
    const before = changes(), trace = f.orch.taskTrace(f.member, f.task.id) as {
      deliveryCoverage: Record<string, unknown>; unsettledDeliveries: { id: string }[]; recentDeliveries: { id: string; execution: unknown }[];
    };
    expect(changes()).toBe(before);
    expect(trace.deliveryCoverage).toMatchObject({ total: 63, returned: 60, unsettledTotal: 61, unsettledReturned: 60, unsettledTruncated: true });
    expect(trace.unsettledDeliveries.map(d => d.id)).toEqual(notices.slice(0, 60).map(d => d.id));
    expect(trace.recentDeliveries.find(d => d.id === unlinked.id)?.execution).toBeNull();
    expect(JSON.stringify(trace)).not.toContain('PRIVATE_BODY_');
    expect(f.store.getNativeAnswer({ operationId: f.req.operationId, projectId: f.project.id, memberId: f.member.id, request: f.req })?.pending).toBe(true);
    expect(f.keys).toHaveLength(0); expect(f.writes).toHaveLength(1);
  } finally { release(); await first; }
  expect(f.keys).toHaveLength(1);
});
