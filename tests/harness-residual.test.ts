// 독립 재검토의 남은 F1/F5: 실제 셸 출력 + 실제 post 도구 + 격리 DB 경계.
import { test, expect } from 'bun:test';
import { fixture, writeExec } from './fixtures/harness-fixture.ts';
import { redactHarnessText } from '../server/harness-redaction.ts';
const ONE={kind:'coding',goal:'명령 의미와 인증 경계를 유지한다',acceptance:['현재 명령이 실제로 통과한다'],checks:['behavior']};
const id=(r:{text:string})=>r.text.match(/#(tk_[\w-]+)/)![1]!;
const checks=(command:string)=>[{name:' 동작\t 검사 ',kind:'behavior',result:'pass',evidence:'실행\n 결과',command,criterion:1}];
const done=(f:ReturnType<typeof fixture>,task:string,command:string)=>f.tool(f.worker,'post',{task_id:task,kind:'완료',title:'격리 확인',contract_rev:1,checks:checks(command)});
async function actual(f:ReturnType<typeof fixture>,command:string){
  const p=Bun.spawn(['/bin/bash','-c',command],{cwd:f.worker.cwd,env:{PATH:'/opt/homebrew/bin:/usr/bin:/bin'},stdout:'pipe',stderr:'pipe'});
  const [out,err,exit]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
  writeExec(f.isolated.paths.claudeHome,f.worker,command,exit,out+err);
  return {out,exit};
}
test('F1 잔여: 앞 성공과 인용문 공백만 다른 실제 실패를 post에서 거절한다',async()=>{
  const f=fixture(),task=id(await f.tool(f.lead,'task',{title:'인용문 공백 실패',contract:ONE}));
  const good=process.execPath+" -e 'process.exit(\"a b\" === \"a b\" ? 0 : 1)'";
  const bad=process.execPath+" -e 'process.exit(\"a  b\" === \"a b\" ? 0 : 1)'";
  expect((await actual(f,good)).exit).toBe(0);expect((await actual(f,bad)).exit).toBe(1);
  const refused=await done(f,task,bad);expect(refused.isError).toBe(true);
  expect((await done(f,task,good)).isError).toBeUndefined();
});
for(const [name,arg] of [['다중 공백',"'x  y'"],['탭',"'x\ty'"],['줄바꿈',"'x\ny'"],['인용 조각',"'x '"+'" y"'],['바깥 공백',"x  \n"],['제로폭 문자',"'x\u200by'"]] as const)test(`F1 잔여: ${name} 명령의 성공과 원문을 보존한다`,async()=>{
  const f=fixture(),task=id(await f.tool(f.lead,'task',{title:'명령 원문 보존',contract:ONE}));
  const command="/usr/bin/printf '%s' "+arg;
  expect((await actual(f,command)).exit).toBe(0);
  const result=await done(f,task,command);expect(result.isError).toBeUndefined();
  const message=result.text.match(/#(msg_[\w-]+)/)![1]!;
  expect(f.store.getReportHarness(message)!.checks[0]).toMatchObject({command,name:'동작 검사',evidence:'실행 결과'});
  writeExec(f.isolated.paths.claudeHome,f.worker,command,1,'의도한 마지막 실패 기록');
  expect((await done(f,task,command)).isError).toBe(true);
});

const marker='FAKEONLY_RESIDUAL_AUTH';
const authForms=[
  ['보통 헤더',"'Authorization: Bearer "+marker+"'",'Authorization: Bearer '+marker],
  ['이어붙인 헤더',"'Authorization: Bearer '\""+marker+'"','Authorization: Bearer '+marker],
  ['역슬래시 공백 헤더','Authorization:\\ Bearer\\ '+marker,'Authorization: Bearer '+marker],
  ['헤더 이름의 인용 조각','Authoriza"tion:"\\ Bearer\\ '+marker,'Authorization: Bearer '+marker],
  ['사용자명만 있는 URL',"'https://"+marker+"@example.invalid/path'",'https://'+marker+'@example.invalid/path'],
  ['사용자명과 암호 URL',"'https://name:"+marker+"@example.invalid/path'",'https://name:'+marker+'@example.invalid/path'],
  ['user 인자','--user name:'+marker,'--username:'+marker],
  ['user 인라인 인자',"'--us'"+'er=name:'+marker,'--user=name:'+marker],
] as const;
for(const [name,args,expected] of authForms)test(`F5 잔여: ${name}을 셸에서 확인하고 보관·기존·직원 조회·거절에서 가린다`,async()=>{
  const f=fixture(),task=id(await f.tool(f.lead,'task',{title:'인증 경계',contract:ONE}));
  const command="/usr/bin/printf '%s' "+args;
  const run=await actual(f,command);expect(run).toEqual({out:expected,exit:0});
  const result=await done(f,task,command);expect(result.isError).toBeUndefined();
  const message=result.text.match(/#(msg_[\w-]+)/)![1]!;
  const stored=f.store.db.query('SELECT command,exec_command FROM report_checks WHERE message_id=?').all(message);
  expect(JSON.stringify(stored)).not.toContain(marker);
  const peers=async()=>[await f.tool(f.worker2,'post',{report_id:message}),await f.tool(f.worker2,'task_trace',{task_id:task}),f.store.getReportHarness(message),f.store.latestTaskChecks(task)];
  expect(JSON.stringify(await peers())).not.toContain(marker);
  f.store.db.run('UPDATE report_checks SET command=?,exec_command=? WHERE message_id=?',[command,command,message]);
  expect(JSON.stringify(await peers())).not.toContain(marker);
  const other=id(await f.tool(f.lead,'task',{title:'거절 경계',contract:ONE}));
  const refused=await done(f,other,command+' --never-executed');
  expect(refused.isError).toBe(true);expect(refused.text).not.toContain(marker);
  expect(JSON.stringify(f.store.listHarnessFindings(f.project.id))).not.toContain(marker);
});
test('F5 잔여: 긴 인자와 인증 인자 값 불일치도 같은 가림 경계를 쓴다',async()=>{
  const f=fixture(),task=id(await f.tool(f.lead,'task',{title:'긴 인증값',contract:ONE}));
  f.ran(f.worker,'bun test different');
  for(const args of ["'Authorization: Bearer '\""+marker+'x'.repeat(150)+'"','Authorization:\\ Bearer\\ '+marker+'x'.repeat(150)]){
    const refused=await done(f,task,'bun test missing --header '+args);
    expect(refused.isError).toBe(true);expect(refused.text).not.toContain(marker);
    expect(JSON.stringify(f.store.listHarnessFindings(f.project.id))).not.toContain(marker);
  }
  f.ran(f.worker,"bun test behavior --header 'Authorization: Bearer DIFFERENT_FAKE_VALUE'");
  const mismatch=await done(f,task,"bun test behavior --header 'Authorization: Bearer '\""+marker+'"');
  expect(mismatch.isError).toBe(true);expect(mismatch.text).not.toContain(marker);
});
test('F5 잔여: 보통 설명과 비인증 URL·헤더는 보존한다',()=>{
  for(const text of ['검사 결과 12 pass 0 fail','bun test behavior --filter normal',"/usr/bin/printf '%s' 'Content-Type: application/json'",'https://example.invalid/path'])expect(redactHarnessText(text)).toBe(text);
});
