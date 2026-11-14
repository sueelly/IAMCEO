// 인증 인자 경계: JS 공백 분류를 기대값으로 쓰지 않고 실제 무해 셸 argv와 비교한다.
import { test, expect } from 'bun:test';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, writeExec } from './fixtures/harness-fixture.ts';
import { redactHarnessText } from '../server/harness-redaction.ts';
const ONE={kind:'coding',goal:'인증 인자의 실제 경계를 가린다',acceptance:['인자 전체를 가린다'],checks:['behavior']};
const id=(r:{text:string})=>r.text.match(/#(tk_[\w-]+)/)![1]!;
const marker='FAKEONLY_LITERAL_ARG';
const q=(s:string)=>"'"+s.replaceAll("'","'\\''")+"'";
const dump=q(process.execPath)+" -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' --";
const done=(f:ReturnType<typeof fixture>,task:string,command:string)=>f.tool(f.worker,'post',{task_id:task,kind:'완료',title:'인자 경계 확인',contract_rev:1,checks:[{name:'인자',kind:'behavior',result:'pass',evidence:'실제 셸 결과',criterion:1,command}]});
async function run(cwd:string,command:string,shell='/bin/bash'){
  const p=Bun.spawn([shell,'-c',command],{cwd,env:{PATH:'/opt/homebrew/bin:/usr/bin:/bin',LANG:'en_US.UTF-8',HOME:cwd,ZDOTDIR:cwd,TMPDIR:cwd,XDG_CONFIG_HOME:cwd},stdin:'ignore',stdout:'pipe',stderr:'pipe'});
  const [out,err,exit]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
  return {out,err,exit};
}
const contentCharacters:[string,string][]=[
  ['SOH','\u0001'],['VT','\u000b'],['FF','\u000c'],['CR','\u000d'],['ESC','\u001b'],['DEL','\u007f'],
  ['NEL','\u0085'],['NBSP','\u00a0'],['OGHAM','\u1680'],
  ...Array.from({length:11},(_,i)=>['U+'+(0x2000+i).toString(16).toUpperCase(),String.fromCodePoint(0x2000+i)] as [string,string]),
  ['ZWSP','\u200b'],['LINE SEPARATOR','\u2028'],['PARAGRAPH SEPARATOR','\u2029'],['NARROW NBSP','\u202f'],['MEDIUM SPACE','\u205f'],['IDEOGRAPHIC SPACE','\u3000'],['BOM','\ufeff'],
];
test('인증 경계: 비ASCII 공백과 제어문자는 실제 Bash·sh·zsh에서 인자 내용으로 유지된다',async()=>{
  const f=fixture();const leaks:string[]=[];
  for(const shell of ['/bin/bash','/bin/sh','/bin/zsh'])for(const [name,c] of contentCharacters){
    const value='name:'+c+marker;
    const command=dump+' --user '+value+' --user '+q(value)+' --token '+value+' --token '+q(value);
    const actual=await run(f.worker.cwd,command,shell);expect(actual.exit).toBe(0);
    expect(JSON.parse(actual.out)).toEqual(['--user',value,'--user',value,'--token',value,'--token',value]);
    if(redactHarnessText(command).includes(marker))leaks.push(shell+':'+name);
  }
  expect(leaks).toEqual([]);
});
test('인증 경계: ASCII 구분·줄바꿈·인용·역슬래시는 실제 셸과 구별한다',async()=>{
  const f=fixture();
  for(const shell of ['/bin/bash','/bin/sh','/bin/zsh']){
    for(const c of [' ','\t']){
      const actual=await run(f.worker.cwd,dump+' left'+c+'right',shell);
      expect(actual.exit).toBe(0);expect(JSON.parse(actual.out)).toEqual(['left','right']);
      const quoted=await run(f.worker.cwd,dump+' '+q('left'+c+'right'),shell);
      expect(quoted.exit).toBe(0);expect(JSON.parse(quoted.out)).toEqual(['left'+c+'right']);
    }
    const lines=await run(f.worker.cwd,dump+' first\n'+dump+' second',shell);
    expect(lines.exit).toBe(0);expect(lines.out).toBe('["first"]["second"]');
    const quoted=await run(f.worker.cwd,dump+' '+q('left\nright'),shell);
    expect(quoted.exit).toBe(0);expect(JSON.parse(quoted.out)).toEqual(['left\nright']);
    const escaped=await run(f.worker.cwd,dump+' left\\ right left\\\nright',shell);
    expect(escaped.exit).toBe(0);expect(JSON.parse(escaped.out)).toEqual(['left right','leftright']);
  }
  // NUL은 POSIX argv 자체에 넣을 수 없다. 이를 삭제하거나 다른 문자로 바꾸어 실행하지 않는다.
  expect(()=>Bun.spawn(['/bin/bash','-c','printf '+String.fromCharCode(0)],{cwd:f.worker.cwd,env:{PATH:'/usr/bin:/bin'}})).toThrow();
});

async function checkSurfaces(flag:string,value:string,quoted=false){
  const f=fixture(),task=id(await f.tool(f.lead,'task',{title:'인자 전체 가림',contract:ONE}));
  const command=dump+' '+flag+' '+(quoted?q(value):value);
  const actual=await run(f.worker.cwd,command);expect(actual.exit).toBe(0);expect(JSON.parse(actual.out)).toEqual([flag,value]);
  writeExec(f.isolated.paths.claudeHome,f.worker,command,actual.exit,actual.out);
  const result=await done(f,task,command);expect(result.isError).toBeUndefined();
  const message=result.text.match(/#(msg_[\w-]+)/)![1]!;
  expect(JSON.stringify(f.store.db.query('SELECT command,exec_command FROM report_checks WHERE message_id=?').all(message))).not.toContain(marker);
  const read=async()=>[f.store.getReportHarness(message),f.store.latestTaskChecks(task),await f.tool(f.worker2,'post',{report_id:message}),await f.tool(f.worker2,'task_trace',{task_id:task})];
  expect(JSON.stringify(await read())).not.toContain(marker);
  f.store.db.run('UPDATE report_checks SET command=?,exec_command=? WHERE message_id=?',[command,command,message]);
  expect(JSON.stringify(await read())).not.toContain(marker);
  const refused=await done(f,task,command+' never-executed');
  expect(refused.isError).toBe(true);expect(refused.text).not.toContain(marker);expect(JSON.stringify(f.store.listHarnessFindings(f.project.id))).not.toContain(marker);
}
for(const flag of ['--user','--token'])for(const quoted of [false,true])test(`인증 경계: ${flag} NBSP ${quoted?'인용':'비인용'}의 새 보관·기존·직원·오류·후보`,()=>checkSurfaces(flag,'name:\u00a0'+marker,quoted));
for(const [name,c] of contentCharacters.filter(([n])=>['VT','FF','CR','NEL','LINE SEPARATOR','PARAGRAPH SEPARATOR','BOM'].includes(n)))test(`인증 경계: ${name} 인자 전체를 모든 공개 경계에서 가린다`,()=>checkSurfaces('--token','name:'+c+marker));
for(const flag of ['-su','-sU'])test(`인증 경계: 묶인 짧은 옵션 ${flag}의 뒤 값도 모두 가린다`,()=>checkSurfaces(flag,'name:\u00a0'+marker));
test('인증 경계: curl의 -su는 -s와 -u의 결합이며 인증값을 받는다',async()=>{
  const f=fixture(),source=join(f.worker.cwd,'empty-source');writeFileSync(source,'');
  // 네트워크가 아닌 격리 파일만 읽는다. curl 자체의 옵션 분석 결과를 생성한 C 코드로 확인한다.
  const value='name:'+marker;
  for(const [flag,option] of [['-su','CURLOPT_USERPWD'],['-sU','CURLOPT_PROXYUSERPWD']] as const){
    const generated=join(f.worker.cwd,'curl'+flag+'.c');
    const p=Bun.spawn(['/usr/bin/curl','-q',flag,value,'--libcurl',generated,'--output',join(f.worker.cwd,'curl-output'+flag),'file://'+source],{cwd:f.worker.cwd,env:{PATH:'/usr/bin:/bin',HOME:f.isolated.paths.home,CURL_HOME:f.isolated.paths.home},stdin:'ignore',stdout:'pipe',stderr:'pipe'});
    const [out,err,exit]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
    expect(exit).toBe(0);expect(out).toBe('');expect(err).toBe('');
    const code=readFileSync(generated,'utf8');expect(code).toContain(option);expect(code).toContain(value);
  }
});
test('인증 경계: 묶인 옵션의 인라인 값·긴 값도 가리며 원문 불일치는 거절한다',async()=>{
  const f=fixture(),task=id(await f.tool(f.lead,'task',{title:'긴 인증 인자',contract:ONE}));
  f.ran(f.worker,'bun test different');
  for(const arg of ['-suname:\u00a0'+marker,'-sUname:\u00a0'+marker,'--token name:\u00a0'+marker+'x'.repeat(170)]){
    const command='bun test missing '+arg;
    expect(redactHarnessText(command)).not.toContain(marker);
    const refused=await done(f,task,command);expect(refused.isError).toBe(true);expect(refused.text).not.toContain(marker);
    expect(JSON.stringify(f.store.listHarnessFindings(f.project.id))).not.toContain(marker);
  }
  f.ran(f.worker,'bun test behavior --token '+q('name:\u00a0DIFFERENT_FAKE'));
  expect((await done(f,task,'bun test behavior --token '+q('name:\u00a0'+marker))).isError).toBe(true);
});
test('인증 경계: 비인증 URL·헤더·설명의 비ASCII 문자와 보통 인자는 유지한다',()=>{
  for(const text of ['https://example.invalid/path',"printf '%s' 'Content-Type: application/json'",'정상\u00a0설명','printf x\u2003y','bun test behavior -s ordinary'])expect(redactHarnessText(text)).toBe(text);
});
