// Actual HTTP/Store/web with isolated FakeRunner receipts. No real CLI/model/operating input.
import { test, expect } from 'bun:test';
import { fixture, until } from '../tests/fixtures/harness-fixture';
import { startServer } from '../server/http';
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
test('HTTP and both widths keep repair recipient, original receipt and background ownership on the same IDs', async () => {
  const f=fixture(), folder=process.env.IAMCEO_E2E_SHOTS!;mkdirSync(folder,{recursive:true});
  const server=await startServer({config:f.config,store:f.store,bus:(f.store as any).bus,orch:f.orch,delivery:f.orch.deliveryRecovery}), base=server.urls[0]!;f.orch.setServerUrl(base);
  const browser=await chromium.launch(), records:any[]=[], events:any[]=[];
  (f.store as any).bus.subscribe((e:any)=>{if(e.type==='task')events.push({at:new Date().toISOString(),taskId:e.task.id,progress:e.task.progress})});
  const task=async(title:string,parent?:string)=>(await f.tool(f.lead,'task',{title,...(parent?{parent_task_id:parent}:{})})).text.match(/#(tk_[\w-]+)/)![1];
  const run=(m:any,turn=0)=>f.runner.callback({type:'status',memberId:m.id,status:'working',terminalId:f.store.requireMember(m.id).paneId,sessionGeneration:0,turn});
  const bg=(m:any,label:string|null,turn=0)=>f.runner.callback({type:'background',memberId:m.id,label,terminalId:f.store.requireMember(m.id).paneId,sessionGeneration:0,turn});
  const snapshot=async(name:string,ids:string[])=>{
    const r=await fetch(base+'/api/projects/'+f.project.id+'/state',{headers:{authorization:'Bearer '+f.config.accessCode}}),s:any=await r.json();expect(r.status).toBe(200);
    const tasks=s.tasks.filter((t:any)=>ids.includes(t.id)),members=s.members.map((m:any)=>({id:m.id,status:m.status,executionState:m.executionState}));
    records.push({name,at:new Date().toISOString(),status:r.status,tasks,members,workflow:s.workflow,inputs:f.runner.sent,deliveries:f.store.listDeliveries().filter(d=>d.taskId&&ids.includes(d.taskId)).map(d=>({id:d.id,memberId:d.memberId,taskId:d.taskId,status:d.status}))});return tasks;
  };
  try {
    const t=(await f.tool(f.lead,'task',{title:'작성자에게만 구현 보완',contract:{kind:'coding',goal:'같은 원 소관의 보완',acceptance:['검토자 입력 보호'],checks:['behavior']}})).text.match(/#(tk_[\w-]+)/)![1];
    await f.orch.assign(f.project.id,f.worker.handle,{text:'승인된 원 구현 입력',taskId:t,purpose:'implementation'},f.lead);
    await f.tool(f.worker,'post',{task_id:t,kind:'막힘',title:'구현 납품, 후속 확인 전',checks:[{kind:'real',name:'실제 적용',result:'not_run',evidence:'아직 적용 전'}]});
    f.runner.end(f.worker);await until('원 작성자 끝',()=>f.store.requireMember(f.worker.id).executionState?.phase==='ended');
    await f.tool(f.lead,'task_stage',{task_id:t,stage:'review',evidence:'독립 읽기 검토'});
    await f.orch.assign(f.project.id,f.worker2.handle,{text:'독립 읽기 원 입력',taskId:t,purpose:'review'},f.lead);
    const op={operationId:crypto.randomUUID()},args={task_id:t,kind:'막힘',title:'독립 원 반례 실패',checks:[{kind:'behavior',name:'소관 반례',result:'fail',evidence:'격리 실패'}]};
    await f.orch.handleAgentOperation(f.store.requireMember(f.worker2.id),'post',args,op);await f.orch.handleAgentOperation(f.store.requireMember(f.worker2.id),'post',args,op);
    await until('작성자 후속 수신',()=>f.runner.to(f.worker).length===2);
    const repairRows=f.store.db.query("SELECT d.id,d.member_id,d.status FROM deliveries d JOIN messages m ON m.id=d.ref_id WHERE m.title='기존 업무 보완 후속'").all();
    expect(repairRows).toHaveLength(1);expect(repairRows[0].member_id).toBe(f.worker.id);expect(f.runner.to(f.worker2)).toHaveLength(1);expect(f.runner.to(f.worker).filter(s=>s.includes('승인된 원 구현 입력'))).toHaveLength(1);
    expect(f.store.requireMember(f.worker.id).executionState?.inputReceivedAt).toBeTruthy();
    const repaired=await snapshot('repair-received',[t]);expect(repaired[0].progress.owner).toBe('철수');expect(repaired[0].progress.next).toContain('철수가 고칠 차례');
    for(const width of [1280,390]){
      const p=await browser.newPage({viewport:{width,height:1000}});await p.goto(base+'/api/health');await p.evaluate(c=>localStorage.setItem('iamceo.accessCode',c),f.config.accessCode);await p.goto(`${base}/#/p/${f.project.id}/team`);
      const row=p.locator('.tm-wi').filter({hasText:'작성자에게만 구현 보완'});await row.waitFor();expect(await row.innerText()).toContain('철수가 고칠 차례');await row.scrollIntoViewIfNeeded();await p.screenshot({path:join(folder,`repair-owned-${width}.png`)});expect(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);await p.close();
    }
  } finally {writeFileSync(join(process.env.REVIEW_STAGE!,'repair-http-screen.json'),JSON.stringify({records,events},null,2));await browser.close();await server.stop()}
},90000);

test('HTTP and both widths preserve A background after the admitted related B receipt', async () => {
  const f=fixture(), folder=process.env.IAMCEO_E2E_SHOTS!;mkdirSync(folder,{recursive:true});
  const server=await startServer({config:f.config,store:f.store,bus:(f.store as any).bus,orch:f.orch,delivery:f.orch.deliveryRecovery}), base=server.urls[0]!;f.orch.setServerUrl(base);
  const browser=await chromium.launch(), records:any[]=[], events:any[]=[];
  (f.store as any).bus.subscribe((e:any)=>{if(e.type==='task')events.push({at:new Date().toISOString(),taskId:e.task.id,progress:e.task.progress})});
  const task=async(title:string,parent?:string)=>(await f.tool(f.lead,'task',{title,...(parent?{parent_task_id:parent}:{})})).text.match(/#(tk_[\w-]+)/)![1];
  const run=(m:any,turn=0)=>f.runner.callback({type:'status',memberId:m.id,status:'working',terminalId:f.store.requireMember(m.id).paneId,sessionGeneration:0,turn});
  const bg=(m:any,label:string|null,turn=0)=>f.runner.callback({type:'background',memberId:m.id,label,terminalId:f.store.requireMember(m.id).paneId,sessionGeneration:0,turn});
  const snapshot=async(name:string,ids:string[])=>{
    const r=await fetch(base+'/api/projects/'+f.project.id+'/state',{headers:{authorization:'Bearer '+f.config.accessCode}}),s:any=await r.json();expect(r.status).toBe(200);
    const tasks=s.tasks.filter((t:any)=>ids.includes(t.id)),members=s.members.map((m:any)=>({id:m.id,status:m.status,executionState:m.executionState}));
    records.push({name,at:new Date().toISOString(),status:r.status,tasks,members,workflow:s.workflow,inputs:f.runner.sent,deliveries:f.store.listDeliveries().filter(d=>d.taskId&&ids.includes(d.taskId)).map(d=>({id:d.id,memberId:d.memberId,taskId:d.taskId,status:d.status}))});return tasks;
  };
  try {
    // Separate worker and same-window derived continuation. Unrelated queued work is not admitted.
    const m=f.make('w3','민수','worker');let turn=0;const send=f.runner.send.bind(f.runner);f.runner.send=async(...a:any[])=>({...await send(...a),turn:a[0].id===m.id?turn++:0});
    const a=await task('앞 턴이 끝난 뒤 작업 A'),b=await task('같은 흐름의 새 앞 작업 B',a);
    await f.orch.assign(f.project.id,m.handle,{text:'배경 A 원 입력',taskId:a},f.lead);run(m);bg(m,'A shell1');await f.tool(m,'post',{task_id:a,kind:'진행',title:'뒤 검증 대기'});f.runner.end(m);await until('A 앞 턴 끝',()=>f.store.requireMember(m.id).executionState?.phase==='ended');
    await f.orch.assign(f.project.id,m.handle,{text:'앞 B 원 입력',taskId:b},f.lead);run(m,1);await until('B 실행',()=>f.store.requireMember(m.id).executionState?.phase==='running');
    const live=await snapshot('A-background-B-running',[a,b]);expect(live.find((t:any)=>t.id===a).progress.execution.background).toBe('A shell1');expect(live.find((t:any)=>t.id===b).progress.execution.background).toBeNull();
    for(const width of [1280,390]){
      const p=await browser.newPage({viewport:{width,height:1000}});await p.goto(base+'/api/health');await p.evaluate(c=>localStorage.setItem('iamceo.accessCode',c),f.config.accessCode);await p.goto(`${base}/#/p/${f.project.id}/team`);
      const row=p.locator('.tm-wi').filter({hasText:'앞 턴이 끝난 뒤 작업 A'});await row.waitFor();expect(await row.innerText()).toContain('뒤 작업: A shell1');expect(await p.locator('.tm-wi').filter({hasText:'같은 흐름의 새 앞 작업 B'}).innerText()).not.toContain('A shell1');await row.scrollIntoViewIfNeeded();await p.screenshot({path:join(folder,`background-owned-${width}.png`)});expect(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);await p.close();
    }
    bg(m,null,1);await until('A만 뒤 작업 해소',()=>f.store.taskProgress(a).execution?.background===null);expect(f.store.taskProgress(b).stage).toBe('working');await snapshot('A-zero-B-still-running',[a,b]);
    expect(f.runner.to(m).filter(s=>s.includes('배경 A 원 입력'))).toHaveLength(1);expect(f.runner.to(m).filter(s=>s.includes('앞 B 원 입력'))).toHaveLength(1);
  } finally {writeFileSync(join(process.env.REVIEW_STAGE!,'background-http-screen.json'),JSON.stringify({records,events},null,2));await browser.close();await server.stop()}
},90000);
