// Real isolated herdr-core and actual IAMCEO source; fake interactive CLI, no model calls.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Bus } from '../../server/bus.ts';
import { loadConfig } from '../../server/config.ts';
import { openDb } from '../../server/db.ts';
import { Store } from '../../server/store.ts';
import { Orchestrator } from '../../server/orchestrator.ts';
import { CoreRunner } from '../../server/runner/core.ts';
if (process.env.IAMCEO_E2E_CORE !== '1' || !process.env.IAMCEO_CORE_BIN) throw new Error('Explicit isolated core test opt-in required');
const coreBin = process.env.IAMCEO_CORE_BIN;
const dir = mkdtempSync('/private/tmp/iqbg-');
const parts = Object.fromEntries(['state','config','cache','work','claude','codex','home','context'].map(k => [k, join(dir,k)]));
for (const path of Object.values(parts)) mkdirSync(path);
const session = `iqbg${Date.now().toString(36)}`;
const socket = join(parts.state!, 'herdr-core', session, `${session}.sock`);
const coreEnv = Object.fromEntries(Object.entries(process.env).filter(([k,v]) => v !== undefined && !/^(HC_|HERDR_|IAMCEO_TOKEN$|IAMCEO_URL$)/.test(k))) as Record<string,string>;
Object.assign(coreEnv, { HC_SESSION: session, HC_SOCKET: socket, XDG_STATE_HOME: parts.state, XDG_CONFIG_HOME: parts.config, XDG_CACHE_HOME: parts.cache });
const hc = (...args: string[]) => spawnSync(coreBin, args, { env: coreEnv, encoding: 'utf8', timeout: 30_000 });
const version = hc('--version').stdout.trim();
const start = hc('server','start','--json');
let stopped = false;
process.on('exit', () => { if (!stopped && start.status === 0) hc('server','stop','--json'); });
if (start.status !== 0 || !existsSync(socket)) throw new Error(`Isolated core start failed: ${start.stderr}`);
const inventory = JSON.parse(hc('server','status','--json').stdout);
if (inventory.live !== 0) throw new Error('Refusing nonempty core');
const fake = join(dir, 'fake-claude');
writeFileSync(fake, `#!/bin/sh\nIAMCEO_BACKGROUND_FIXTURE='${dir}' exec '${process.execPath}' '${resolve('tests/fixtures/background-claude-tui.ts')}' "$@"\n`, { mode: 0o700 });
const config = loadConfig({ IAMCEO_HOME: parts.home, IAMCEO_PORT: '0', IAMCEO_CORE_SOCKET: socket, IAMCEO_CORE_BIN: coreBin, IAMCEO_CLAUDE_BIN: fake, IAMCEO_CODEX_BIN: '/usr/bin/false' });
const bus = new Bus(); const store = new Store(openDb(config.dbPath), bus);
store.patchSettings({ maxConcurrentTurns: 1, boardTidyHours: 0 });
const project = store.createProject({ name: 'Isolated background roundtrip', cwd: parts.work!, chiefCli: 'claude' });
const runner = new CoreRunner({ socketPath: socket, coreBin, claudeBin: fake, codexBin: '/usr/bin/false', claudeHome: parts.claude, codexHome: parts.codex, contextHome: parts.context }, { recoveryStore: store, pollMs: 50 });
const orch = new Orchestrator({ config, store, runners: new Map([['core',runner]]), providerHomes: {claudeHome:parts.claude!,codexHome:parts.codex!}, timings: { tickMs:60_000,healthMs:60_000 } });
orch.setServerUrl('http://127.0.0.1:1');
const checks: { name: string; pass: boolean }[] = [];
const check = (name: string, pass: boolean) => { checks.push({ name, pass }); if (!pass) throw new Error(name); };
async function until(read:()=>boolean) { for(let i=0;i<300&&!read();i++) await Bun.sleep(20); check('condition eventually observed',read()); }
let failure: string | null = null;
try {
  const member = await orch.createMember(project.id,{name:'Isolated fake worker',cli:'claude'});
  const first = store.enqueue({projectId:project.id,memberId:member.id,kind:'instruction',text:'FIRST_ORIGINAL',wake:true});
  await orch.pump(member.id);
  await until(()=>store.requireDelivery(first.id).status==='delivered');
  const next = store.enqueue({projectId:project.id,memberId:member.id,kind:'instruction',text:'NEXT_ORIGINAL',wake:true});
  await orch.pump(member.id);
  await until(()=>store.requireDelivery(next.id).status==='delivered' && store.listPendingExecutions().length===0);
  check('both original deliveries are received',store.requireDelivery(first.id).status==='delivered'&&store.requireDelivery(next.id).status==='delivered');
  check('background-only member stays working',store.requireMember(member.id).status==='working');
  const received=readFileSync(join(dir,'received.jsonl'),'utf8').trim().split('\n').map(s=>JSON.parse(s));
  check('each original is received once',received.length===2&&received.filter(r=>r.text.includes('FIRST_ORIGINAL')).length===1&&received.filter(r=>r.text.includes('NEXT_ORIGINAL')).length===1);
  check('no missing-report turn is inserted while waiting',!store.listDeliveries().some(d=>d.text.includes('보고 보완')));
  writeFileSync(join(dir,'before-clear.json'),JSON.stringify({member:store.requireMember(member.id),deliveries:store.listDeliveries(),received},null,2));
  writeFileSync(join(dir,'clear'),'clear'); await until(()=>store.requireMember(member.id).status==='idle');
  check('completed background settles without new input',readFileSync(join(dir,'received.jsonl'),'utf8').trim().split('\n').length===2);
} catch(error) { failure=String(error); }
finally {
  await orch.shutdown(); store.db.close(); const stop=hc('server','stop','--json'); stopped = true;
  const result={kind:'real-core-fake-cli-isolated',version,dir,socket,checks,failure,stopExit:stop.status};
  writeFileSync(resolve('evidence/real-core-background.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
  if(failure||stop.status!==0) process.exitCode=1;
}
