import { createServer, type Socket } from 'node:net';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Bus } from '../../server/bus.ts';
import { loadConfig } from '../../server/config.ts';
import { openDb } from '../../server/db.ts';
import { Store } from '../../server/store.ts';
import { Orchestrator } from '../../server/orchestrator.ts';
import { CoreRunner } from '../../server/runner/core.ts';
import type { CoreTerminal } from '../../server/runner/core-client.ts';

export const composer = (footer = '') => `result\n✻ Sautéed for 1m 11s · done 12:33 PM\n\n${'─'.repeat(50)}\n❯ \n${'─'.repeat(50)}\n${footer}`;
export async function createQueueStatusFixture(maxConcurrentTurns = 2) {
  const dir = mkdtempSync('/private/tmp/iamceo-queue-status-');
  const socketPath = join(dir, 'c.sock');
  const home = join(dir, 'home'); mkdirSync(home);
  const claudeHome = join(dir, 'claude'); mkdirSync(claudeHome);
  const codexHome = join(dir, 'codex'); mkdirSync(codexHome);
  const config = loadConfig({ IAMCEO_HOME: home, IAMCEO_PORT: '0', IAMCEO_CORE_SOCKET: socketPath,
    IAMCEO_CORE_BIN: '/usr/bin/false', IAMCEO_CLAUDE_BIN: '/usr/bin/false', IAMCEO_CODEX_BIN: '/usr/bin/false' });
  const db = openDb(config.dbPath); const bus = new Bus(); const store = new Store(db, bus);
  store.patchSettings({ maxConcurrentTurns, boardTidyHours: 0 });
  const project = store.createProject({ name: 'Queue status fixture', cwd: dir });
  const terminals = new Map<string, CoreTerminal>(); const sockets = new Set<Socket>();
  const writes: { terminal: string; text: string }[] = [];
  let screen = composer();
  let complete = true;
  let readFailure = false;
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      while (buffer.includes('\n')) {
        const n = buffer.indexOf('\n'); const req = JSON.parse(buffer.slice(0, n)); buffer = buffer.slice(n + 1);
        const p = req.params; let result: unknown;
        if (req.method === 'hello') result = { generation: 1, version: 'isolated', methods: ['terminal.run','terminal.list','terminal.get','terminal.read','terminal.send','terminal.interrupt','terminal.kill','terminal.keys'], features: [] };
        if (req.method === 'terminal.list') result = { terminals: [...terminals.values()] };
        if (req.method === 'terminal.run') {
          result = { address: `t${terminals.size+1}`, argv: p.argv, cwd: p.cwd, labels: p.labels, state: 'live', turn: 0, status: { state: 'idle', app: 'claude-code' }, reported: true };
          terminals.set((result as CoreTerminal).address, result as CoreTerminal);
        }
        if (req.method === 'terminal.get') result = terminals.get(p.terminal);
        if (req.method === 'terminal.read' && readFailure) {
          socket.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32000, message: 'Isolated read failure' } })+'\n');
          continue;
        }
        if (req.method === 'terminal.read') result = { text: screen, complete, how: 'screen' };
        if (req.method === 'terminal.send') {
          const terminal = terminals.get(p.terminal)!;
          if (!terminal || (p.if ? terminal.status?.state !== p.if : !['idle', 'done'].includes(terminal.status?.state ?? ''))) throw new Error('unsafe fixture input');
          writes.push({ terminal: p.terminal, text: p.text });
          result = { turn: terminal.turn, started: true }; terminal.status = { state: 'working', app: 'claude-code' };
        }
        socket.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result })+'\n');
      }
    });
  });
  await new Promise<void>(done => server.listen(socketPath, done));
  const runner = new CoreRunner({ socketPath, claudeBin: '/usr/bin/false', codexBin: '/usr/bin/false', claudeHome, codexHome, contextHome: dir }, { pollMs: 10 });
  const orch = new Orchestrator({ config, store, runners: new Map([['core', runner]]), providerHomes: { claudeHome, codexHome }, timings: { healthMs: 60_000, tickMs: 60_000 } });
  orch.setServerUrl('http://127.0.0.1:1');
  const stop = async () => { await Bun.sleep(50); await orch.shutdown(); for (const socket of sockets) socket.destroy(); await new Promise<void>(done => server.close(() => done())); db.close(); };
  const member = await orch.createMember(project.id, { name: 'Fixture worker', cli: 'claude' });
  return { dir, config, bus, store, orch, project, runner, member, terminals, writes, stop, setScreen(value: string, fullyRead = true) { screen = value; complete = fullyRead; },
    setReadFailure(value: boolean) { readFailure = value; },
    done() { const t = terminals.get(store.requireMember(member.id).paneId!)!; t.turn = (t.turn ?? 0)+1; t.status = { state: 'done', app: 'claude-code' }; } };
}
