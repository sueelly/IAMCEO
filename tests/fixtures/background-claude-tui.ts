// Interactive protocol stand-in. No model calls; only fixture-owned output and control files.
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const dir = process.env.IAMCEO_BACKGROUND_FIXTURE;
if (!dir?.startsWith('/private/tmp/iqbg-')) throw new Error('Explicit isolated fixture required');
const args = process.argv.slice(2);
const session = args[args.indexOf('--session-id') + 1];
if (!session || !process.env.CLAUDE_CONFIG_DIR) throw new Error('Explicit fake session required');
const root = join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
mkdirSync(root, { recursive: true });
const transcript = join(root, `${session}.jsonl`);
const record = (value: unknown) => appendFileSync(transcript, JSON.stringify(value)+'\n');
let input = '', busy = false, background = false;
const osc = (state: string) => process.stdout.write(`\x1b]7501;state=${state}\x07`);
function paint() {
  const text = `Isolated fake CLI: no model\n✻ Worked for 1s · done\n${'─'.repeat(100)}\n❯ ${input}\n${'─'.repeat(100)}\n  ⏵⏵ bypass permissions on${background ? ' · 1 shell, 2 monitors' : ''}\n`;
  process.stdout.write(`\x1b[2J\x1b[H${text.replace(/\n/g, '\r\n')}`);
}
function submit() {
  if (!input.trim()) return;
  const text = input; input = ''; busy = true; osc('working');
  appendFileSync(join(dir!, 'received.jsonl'), JSON.stringify({ text, at: new Date().toISOString() })+'\n');
  record({ type: 'user', sessionId: session, cwd: process.cwd(), isSidechain: false, message: { role: 'user', content: text }, timestamp: new Date().toISOString() });
  setTimeout(() => {
    busy = false; background = true;
    record({ type: 'assistant', sessionId: session, isSidechain: false, message: { role: 'assistant', content: [{type:'text', text:'Waiting for isolated background results'}], stop_reason:'end_turn' } });
    paint(); osc('idle');
  }, 500);
}
process.stdin.setRawMode?.(true); process.stdin.setEncoding('utf8');
process.stdout.write('\x1b[?2004h');
process.stdin.on('data', (chunk: string) => {
  for (const m of chunk.matchAll(/\x1b\[200~([\s\S]*?)\x1b\[201~|\x1b\[[0-9;]*[A-Za-z~]|\x1b|[\s\S]/g)) {
    if (busy) continue;
    if (m[1] !== undefined) input += m[1];
    else if (m[0] === '\r' || m[0] === '\n') submit();
    else if (!m[0].startsWith('\x1b')) input += m[0];
  }
  if (!busy) paint();
});
setInterval(() => {
  if (background && existsSync(join(dir!, 'clear'))) { background = false; paint(); }
}, 50);
paint(); osc('idle');
