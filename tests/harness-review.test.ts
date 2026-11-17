import { BackupManager, createBackup } from '../server/backup.ts';
// 독립 검토의 실제 반례. 네트워크/실제 직원 없이 격리 DB와 가짜 제공자 기록만 사용한다.
import { test, expect } from 'bun:test';
import { writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, writeExec, writeToolResult } from './fixtures/harness-fixture.ts';
import { execProves, verifyClaims, matchExecChecks, parseClaudeLog, parseCodexLog } from '../server/harness-evidence.ts';
const ONE = {kind:'coding', goal:'실패 검사 차단', acceptance:['동작 검사가 통과한다'], checks:['behavior']};
const id = (r: {text:string}) => r.text.match(/#(tk_[\w-]+)/)![1]!;
const checks = (command:string) => [{kind:'behavior', name:'동작', result:'pass', evidence:'실행 결과', command, criterion:1}];
const done = (f:ReturnType<typeof fixture>, task:string, command:string) => f.tool(f.worker,'post',{task_id:task,kind:'완료',title:'검사',contract_rev:1,checks:checks(command)});

test('F1: 실제 실패 시험을 파이프 주석이나 도움말로 바꾸어도 완료가 거절된다', async () => {
  const f=fixture(), task=id(await f.tool(f.lead,'task',{title:'실제 실패',contract:ONE}));
  const path=join(f.worker.cwd,'failure.test.ts');
  writeFileSync(path, "import {test,expect} from 'bun:test';test('intentional',()=>expect(1).toBe(2));\n");
  const want=`'${process.execPath}' test '${path}'`;
  for (const [suffix,prefix,exit] of [['','',1],[' 2>&1 | cat # pipefail','',0],[' 2>&1 | cat','set -o pipefail; ',1],[' --help','',0]] as const) {
    const command=prefix+want+suffix;
    const child=Bun.spawn(['/bin/bash','-c',command],{cwd:f.worker.cwd,env:{PATH:'/usr/bin:/bin'},stdout:'pipe',stderr:'pipe'});
    const [out,err,actual]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
    expect(actual).toBe(exit);
    if (!suffix.includes('--help')) expect(out+err).toContain('1 fail');
    writeExec(f.isolated.paths.claudeHome,f.worker,command,actual,out+err);
    expect((await done(f,task,want)).isError).toBe(true);
  }
});

test('F1: 부가 인자와 다른 작업 위치, 불분명한 셸 상태는 통과 근거가 아니다',()=>{
  for(const command of ['bun test a.test.ts --help','cd /other && bun test a.test.ts','bun test a.test.ts | cat # pipefail','echo pipefail; bun test a.test.ts | cat','set +o pipefail; bun test a.test.ts | cat','! bun test a.test.ts','if false; then bun test a.test.ts; fi','bun test a.test.ts\ntrue']) {
    expect(execProves(command,'bun test a.test.ts')).not.toBe('ok');
  }
  expect(execProves('cd /other && bun test a.test.ts','cd /target && bun test a.test.ts')).not.toBe('ok');
  expect(execProves("printf 'a\nb'", "printf 'a b'")).not.toBe('ok');
  expect(execProves('bun test a.test.ts','bun test a.test.ts')).toBe('ok');
  expect(execProves('set -o pipefail; bun test a.test.ts | cat','bun test a.test.ts')).toBe('ok');
  expect(execProves('cd /target && bun test a.test.ts','cd /target && bun test a.test.ts')).toBe('ok');
});

test('F2: 확인 전 완료는 확인 뒤에도 통과 승계되지 않고 재검사 보고 뒤에만 승계된다',async()=>{
  const f=fixture(), task=id(await f.tool(f.lead,'task',{title:'승계'}));
  await f.tool(f.worker,'task',{task_id:task,contract:ONE});
  expect((await f.tool(f.worker,'post',{task_id:task,kind:'완료',title:'확인 전'})).isError).toBe(true);
  await f.tool(f.lead,'task',{task_id:task,confirm_contract_rev:1});
  expect((await f.tool(f.lead,'post',{task_id:task,kind:'완료',title:'승계 시도'})).isError).toBe(true);
  f.ran(f.worker,'bun test behavior');
  expect((await done(f,task,'bun test behavior')).isError).toBeUndefined();
  expect((await f.tool(f.lead,'post',{task_id:task,kind:'완료',title:'통과 보고 승계'})).isError).toBeUndefined();
});

for(const mode of ['label','required-new','required-old'] as const) test(`F3: ${mode}에서 대기 개정안이 확정 계약을 가리지 않는다`,async()=>{
  const f=fixture();
  if(mode==='required-new'){f.store.patchSettings({harnessMode:'required'});await Bun.sleep(2);}
  const task=id(await f.tool(f.lead,'task',{title:'개정'}));
  if(mode==='required-old')f.store.patchSettings({harnessMode:'required'});
  await f.tool(f.worker,'task',{task_id:task,contract:ONE});
  await f.tool(f.lead,'task',{task_id:task,confirm_contract_rev:1});
  expect((await f.tool(f.worker,'post',{task_id:task,kind:'완료',title:'검사 없음'})).isError).toBe(true);
  await f.tool(f.worker,'task',{task_id:task,contract:{...ONE,checks:[]}});
  expect((await f.tool(f.worker,'post',{task_id:task,kind:'완료',title:'대기 판 우회'})).isError).toBe(true);
  expect((await f.tool(f.lead,'post',{task_id:task,kind:'완료',title:'총괄 대기 판 우회'})).isError).toBe(true);
  f.ran(f.worker,'bun test behavior');
  expect((await done(f,task,'bun test behavior')).isError).toBeUndefined();
  await f.tool(f.lead,'task',{task_id:task,confirm_contract_rev:2});
  expect((await f.tool(f.worker,'post',{task_id:task,kind:'완료',title:'새 기준',contract_rev:2,checks:[{name:'확인',kind:'other',result:'pass',evidence:'수동 확인',criterion:1}]})).isError).toBeUndefined();
});

const source='https://source.example.invalid/report', quote='All safety checks passed.';
const RESEARCH={kind:'research',goal:'출처 대조',acceptance:['주장을 출처와 대조한다']};
const researchChecks=[{name:'출처',kind:'source',result:'pass',evidence:'인용 확인',criterion:1},{name:'구분',kind:'fact',result:'pass',evidence:'해석 구분'}];
test('F4: 실제 printf가 만든 인용문과 주석 URL로 조사 완료를 만들지 못한다',async()=>{
  const f=fixture(),task=id(await f.tool(f.lead,'task',{title:'조작 출처',contract:RESEARCH}));
  const command="printf '\\101ll safety checks passed.' # "+source;
  const child=Bun.spawn(['/bin/bash','-c',command],{cwd:f.worker.cwd,env:{PATH:'/usr/bin:/bin'},stdout:'pipe',stderr:'pipe'});
  const out=await new Response(child.stdout).text();expect(await child.exited).toBe(0);expect(out).toBe(quote);
  writeExec(f.isolated.paths.claudeHome,f.worker,command,0,out);
  expect((await f.tool(f.worker,'post',{task_id:task,kind:'완료',title:'조작 제출',contract_rev:1,checks:researchChecks,unverified:[],claims:[{text:quote,basis:'fact',source,quote,criterion:1}]})).isError).toBe(true);
});
test('F4: 읽기 도구의 다른 인자·다른 URL·오류 출력은 출처 증거가 아니다',()=>{
  const claim={text:quote,basis:'fact' as const,source,quote};
  for(const t of [
    {tool:'Bash',input:JSON.stringify({command:'printf ... # '+source}),text:quote},
    {tool:'WebFetch',input:JSON.stringify({url:'https://other.example.invalid',prompt:source}),text:quote},
    {tool:'WebFetch',input:JSON.stringify({url:source}),text:quote,successful:false},
    {tool:'unknown/read',input:JSON.stringify({url:source}),text:quote},
  ])expect(verifyClaims([claim],{status:'ok',code:'ok',execs:[],texts:[{...t,at:new Date().toISOString()}]},()=>null).reasons.length).toBeGreaterThan(0);
});
test('P2 출처: 인용 존재만 확인하고 주장 의미의 verified 표시는 하지 않는다',()=>{
  const result=verifyClaims([{text:'이번 매출은 1000억원입니다.',basis:'fact',source,quote:'이번 매출은 10억원입니다.'}],{status:'ok',code:'ok',execs:[],texts:[{tool:'WebFetch',input:JSON.stringify({url:source}),text:'이번 매출은 10억원입니다.',at:new Date().toISOString()}]},()=>null);
  expect(result.reasons).toEqual([]);
  expect(result.results[0]).toMatchObject({verified:false,quoteMatched:true,sourceRead:true,semanticReview:'required'});
});
test('P2 출처: 해석도 실제 읽은 출처가 있어야 하며 정상 인용은 범위를 명시해 보고한다',async()=>{
  const f=fixture(),task=id(await f.tool(f.lead,'task',{title:'해석 근거',contract:RESEARCH}));
  const submit=()=>f.tool(f.worker,'post',{task_id:task,kind:'완료',title:'조사',contract_rev:1,checks:researchChecks,unverified:[],claims:[{text:'이 결과는 안전하다는 해석',basis:'interpretation',source}]});
  expect((await submit()).isError).toBe(true);
  writeToolResult(f.isolated.paths.claudeHome,f.worker,'WebFetch',{url:source},quote);
  const result=await submit();expect(result.isError).toBeUndefined();
  const message=result.text.match(/#(msg_[\w-]+)/)![1]!;
  const read=await f.tool(f.worker2,'post',{report_id:message});
  expect(read.text).toContain('주장 의미는 별도 검토');
  expect(f.store.getReportHarness(message)!.claims[0]).toMatchObject({verified:false,sourceRead:true,semanticReview:'required'});
});

test('F5: 보고에서 뺀 실행 명령의 비밀 대입값은 보관과 직원 조회에서 가려진다',async()=>{
  const f=fixture(),task=id(await f.tool(f.lead,'task',{title:'비밀 가림',contract:ONE}));
  const marker='FAKE_ONLY_ASSIGNMENT_MARKER';
  f.ran(f.worker,`API_KEY='${marker}' bun test behavior`);
  const posted=await done(f,task,'bun test behavior');expect(posted.isError).toBeUndefined();
  const message=posted.text.match(/#(msg_[\w-]+)/)![1]!;
  const stored=f.store.db.query('SELECT command, exec_command FROM report_checks WHERE message_id=?').all(message);
  expect(JSON.stringify(stored)).not.toContain(marker);
  expect((await f.tool(f.worker2,'task_trace',{task_id:task})).text).not.toContain(marker);
  expect((await f.tool(f.worker2,'post',{report_id:message})).text).not.toContain(marker);
  expect(f.store.getReportHarness(message)!.checks[0]!.execCommand).toContain('bun test behavior');
  // 이미 보관된 옛 판의 값을 같은 DB에만 심어 반환 경계를 따로 확인한다.
  const old='FAKE_ONLY_LEGACY_MARKER';
  f.store.db.run('UPDATE report_checks SET command=?, exec_command=?, evidence=? WHERE message_id=?',[`API_KEY=${old} bun test behavior`,`API_KEY=${old} bun test behavior`,`token=${old}`,message]);
  for(const value of [f.store.getReportHarness(message),f.store.latestTaskChecks(task),await f.tool(f.worker2,'task_trace',{task_id:task}),await f.tool(f.worker2,'post',{report_id:message})])expect(JSON.stringify(value)).not.toContain(old);
  const other=f.store.createProject({name:'다른 격리 프로젝트',cwd:f.worker.cwd});
  const outsider=f.store.createMember({projectId:other.id,handle:'reader',name:'다른 직원',kind:'worker',origin:'runner',backend:'core',status:'idle',cwd:f.worker.cwd,cli:'claude'});
  expect((await f.tool(outsider,'task_trace',{task_id:task})).isError).toBe(true);
  expect((await f.tool(outsider,'post',{report_id:message})).isError).toBe(true);
});

test('F5: 비밀 인자·헤더·URL을 가리되 가린 문자열로 실행 일치를 판정하지 않는다',async()=>{
  const f=fixture(),task=id(await f.tool(f.lead,'task',{title:'비밀 인자',contract:ONE}));
  for(const args of ["--api-key=FAKE_ONLY_FLAG_MARKER", "--token 'FAKE_ONLY_FLAG_MARKER with spaces'", "--password FAKE_ONLY_FLAG_MARKER", "--header 'Authorization: Bearer FAKE_ONLY_FLAG_MARKER'", "https://name:FAKE_ONLY_FLAG_MARKER@example.invalid/path"]) {
    const command='bun test behavior '+args;
    f.ran(f.worker,command);
    const result=await done(f,task,command);expect(result.isError).toBeUndefined();
    const message=result.text.match(/#(msg_[\w-]+)/)![1]!;
    expect(JSON.stringify(f.store.db.query('SELECT * FROM report_checks WHERE message_id=?').all(message))).not.toContain('FAKE_ONLY_FLAG_MARKER');
    expect((await f.tool(f.worker2,'post',{report_id:message})).text).not.toContain('FAKE_ONLY_FLAG_MARKER');
  }
  f.ran(f.worker,'bun test behavior --token FAKE_ONLY_DIFFERENT');
  const refused=await done(f,task,'bun test behavior --token FAKE_ONLY_UNEXECUTED');
  expect(refused.isError).toBe(true);
  expect(refused.text).not.toContain('FAKE_ONLY_UNEXECUTED');
  expect(JSON.stringify(f.store.listHarnessFindings(f.project.id))).not.toContain('FAKE_ONLY_UNEXECUTED');
});

for(const defect of ['bad','missing','zero'] as const)test(`P2 백업: 최근 명세가 ${defect}여도 새 백업을 막지 않는다`,async()=>{
  const f=fixture(),backupDir=join(f.config.home,'backups');
  const manager=new BackupManager({home:f.config.home,backupDir});f.orch.setBackups(manager);
  // 정상적인 옛 백업의 완전한 명세/설정을 사용한다. 파일 상태 하나만 바꾼다.
  const seed=createBackup({home:f.config.home,backupDir,now:new Date(Date.now()-2*86_400_000)});
  const fakeId=`snapshot-${Date.now()}-${crypto.randomUUID()}`,folder=join(backupDir,fakeId);mkdirSync(folder,{recursive:true});
  const manifest=structuredClone(seed.manifest);manifest.id=fakeId;manifest.createdAt=new Date().toISOString();
  mkdirSync(join(folder,'attachments'));
  for(const config of manifest.configs)copyFileSync(join(seed.directory,config.path),join(folder,config.path));
  if(defect==='bad'){(manifest.verification as any).integrity='bad';copyFileSync(join(seed.directory,'iamceo.db'),join(folder,'iamceo.db'));}
  if(defect==='zero'){writeFileSync(join(folder,'iamceo.db'),'');manifest.database.size=0;manifest.database.sha256='e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';}
  writeFileSync(join(folder,'manifest.json'),JSON.stringify(manifest));
  const response=await f.tool(f.worker,'server_backup',{});expect(response.isError).toBeUndefined();
  const made=JSON.parse(response.text);expect(made.created).toBe(true);expect(made.backup.verified).toBe(true);expect(made.backup.databaseBytes).toBeGreaterThan(0);expect(made.backup.id).not.toBe(fakeId);
  const reuseResponse=await f.tool(f.worker2,'server_backup',{});expect(reuseResponse.isError).toBeUndefined();
  const reused=JSON.parse(reuseResponse.text);
  expect(reused).toMatchObject({created:false,backup:{id:made.backup.id,verified:true}});
});

test('F1: 실제 기록의 작업 위치가 없거나 다르면 성공 종료도 통과시키지 않는다',()=>{
  const at=new Date().toISOString();
  const records=(cwd?:string)=>[
    {type:'assistant',timestamp:at,cwd,message:{content:[{type:'tool_use',id:'cwd',name:'Bash',input:{command:'bun test behavior'}}]}},
    {type:'user',timestamp:at,cwd,message:{content:[{type:'tool_result',tool_use_id:'cwd',content:'ok',is_error:false}]},toolUseResult:{stdout:'ok',stderr:'',interrupted:false}}
  ].map(r=>JSON.stringify(r)).join('\n');
  for(const cwd of [undefined,'/other','/target']){
    const evidence={status:'ok' as const,code:'ok',...parseClaudeLog(records(cwd),null)};
    const result=matchExecChecks(checks('bun test behavior') as any,evidence,()=>null,'/target');
    expect(result.reasons.length===0).toBe(cwd==='/target');
    const codex={status:'ok' as const,code:'ok',...parseCodexLog(JSON.stringify({type:'event_msg',timestamp:at,payload:{type:'item_completed',item:{type:'CommandExecution',id:'cwd',command:['/bin/bash','-c','bun test behavior'],cwd,exit_code:0,status:'completed',aggregated_output:'ok'}}}),null)};
    expect(matchExecChecks(checks('bun test behavior') as any,codex,()=>null,'/target').reasons.length===0).toBe(cwd==='/target');
  }
});
test('F1: 셸 wrapper의 백그라운드 종료를 검사 종료로 보지 않는다',()=>{
  expect(execProves("bash -c 'bun test a.test.ts' &",'bun test a.test.ts')).not.toBe('ok');
  expect(execProves("bash -c 'bun test a.test.ts'",'bun test a.test.ts')).toBe('ok');
});

test('F1: 실제 성공 시험과 명시적 pipefail 성공은 완료 근거로 유지한다',async()=>{
  const f=fixture(),task=id(await f.tool(f.lead,'task',{title:'실제 성공 대조군',contract:ONE}));
  const path=join(f.worker.cwd,'success.test.ts');writeFileSync(path,"import {test,expect} from 'bun:test';test('success',()=>expect(1).toBe(1));\n");
  const want=`'${process.execPath}' test '${path}'`;
  for(const command of [want,'set -o pipefail; '+want+' 2>&1 | cat']){
    const child=Bun.spawn(['/bin/bash','-c',command],{cwd:f.worker.cwd,env:{PATH:'/usr/bin:/bin'},stdout:'pipe',stderr:'pipe'});
    const [out,err,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
    expect(exit).toBe(0);expect(out+err).toContain('1 pass');
    writeExec(f.isolated.paths.claudeHome,f.worker,command,exit,out+err);
    expect((await done(f,task,want)).isError).toBeUndefined();
  }
});
test('F3: 갈래 업무의 확인 전 제안도 부모의 확정 계약을 가리지 않는다',async()=>{
  const f=fixture(),root=id(await f.tool(f.lead,'task',{title:'부모 계약'}));
  await f.tool(f.worker,'task',{task_id:root,contract:ONE});await f.tool(f.lead,'task',{task_id:root,confirm_contract_rev:1});
  const child=id(await f.tool(f.worker,'task',{title:'갈래 제안',parent_task_id:root,contract:{...ONE,checks:[]}}));
  expect((await f.tool(f.worker,'post',{task_id:child,kind:'완료',title:'우회'})).isError).toBe(true);
  f.ran(f.worker,'bun test behavior');expect((await done(f,child,'bun test behavior')).isError).toBeUndefined();
});

test('F5: 긴 비밀 인자도 오류 문구를 자르기 전에 가린다',async()=>{
  const f=fixture(),task=id(await f.tool(f.lead,'task',{title:'긴 비밀 거절',contract:ONE}));
  const first='FAKE_ONLY_LONG_FIRST',second='FAKE_ONLY_LONG_SECOND';
  f.ran(f.worker,'bun test different');
  for(const q of ["'",'"']){
    const refused=await done(f,task,'bun test behavior --token '+q+first+'x'.repeat(100)+' '+second+q);
    expect(refused.isError).toBe(true);
    expect(refused.text).not.toContain(first);expect(refused.text).not.toContain(second);
    expect(JSON.stringify(f.store.listHarnessFindings(f.project.id))).not.toContain(first);
  }
});
