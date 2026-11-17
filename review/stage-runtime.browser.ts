// Actual HTTP/Store/Orchestrator/web; every input and execution is an isolated FakeRunner.
import {test,expect,setDefaultTimeout} from 'bun:test';
import {mkdirSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
import {chromium,type Page} from 'playwright';import {startServer} from '../server/http';
import {fixture,until} from '../tests/fixtures/harness-fixture';
setDefaultTimeout(120000);
test('same original receipt, foreground/background, delivery/review/application, interruption and two-tab completion agree live at 1280/390',async()=>{
 const f=fixture(),folder=process.env.IAMCEO_E2E_SHOTS!;mkdirSync(folder,{recursive:true});
 const task=(await f.tool(f.lead,'task',{title:'원 업무 수신부터 완료까지',contract:{kind:'coding',goal:'실행과 완료 연결',acceptance:['원 업무의 현재 단계'],checks:['behavior']}})).text.match(/#(tk_[\w-]+)/)![1];
 const events:any[]=[],observed:any[]=[];(f.store as any).bus.subscribe((e:any)=>{if(e.type==='task'&&e.task.id===task)events.push({at:new Date().toISOString(),stage:e.task.progress?.stage,execution:e.task.progress?.execution})});
 await f.tool(f.worker,'status',{now:'예전에 조사하던 내용',next:'검증 뒤 독립 확인'});
 const server=await startServer({config:f.config,store:f.store,bus:(f.store as any).bus,orch:f.orch,delivery:f.orch.deliveryRecovery});const base=server.urls[0]!;f.orch.setServerUrl(base);
 const browser=await chromium.launch(),pages:Page[]=[];
 try{
  for(const width of [1280,390]){const p=await browser.newPage({viewport:{width,height:900}});pages.push(p);await p.goto(base+'/api/health');await p.evaluate(c=>localStorage.setItem('iamceo.accessCode',c),f.config.accessCode);await p.goto(`${base}/#/p/${f.project.id}/team`);await p.locator('.tm').waitFor();}
  const row=(p:Page)=>p.locator('.tm-wi').filter({hasText:'원 업무 수신부터 완료까지'});
  const capture=async(name:string,stage:string)=>{for(const p of pages){if(name==='foreground-ended-bgworking'){await row(p).filter({hasText:'뒤 작업: 회귀 shell1'}).waitFor();expect(await p.locator('.tm-card').filter({hasText:'철수'}).innerText()).toContain('마지막 일');}await p.waitForFunction(({title,stage})=>Array.from(document.querySelectorAll('.tm-wi')).some(x=>x.textContent?.includes(title)&&x.getAttribute('data-stage')===stage),{title:'원 업무 수신부터 완료까지',stage});await p.screenshot({path:join(folder,`${name}-${p.viewportSize()!.width}.png`),fullPage:true});}
   const data=await pages[0]!.evaluate(async pid=>{const r=await fetch('/api/sync?projectId='+pid+'&view=compact',{headers:{Authorization:'Bearer '+localStorage.getItem('iamceo.accessCode')}});return {status:r.status,body:await r.json()}},f.project.id);
   expect(data.status).toBe(200);const current=data.body.state.tasks.find((t:any)=>t.id===task);expect(current.progress.stage).toBe(stage);observed.push({name,status:data.status,task:current,member:data.body.state.members.find((m:any)=>m.id===f.worker.id)});
  };
  await f.orch.assign(f.project.id,f.worker.handle,{text:'원 입력 딱 한 번',taskId:task},f.lead);const original=f.store.requireMember(f.worker.id).executionState!;expect(original.inputReceivedAt).toBeTruthy();
  f.runner.callback({type:'status',memberId:f.worker.id,status:'working',terminalId:f.worker.paneId,sessionGeneration:0,turn:0});await until('진행 중',()=>f.store.taskProgress(task).stage==='working');await capture('running','working');
  f.runner.callback({type:'background',memberId:f.worker.id,label:'회귀 shell1',terminalId:f.worker.paneId,sessionGeneration:0});
  f.ran(f.worker,'bun test owned-stage');await f.tool(f.worker,'post',{task_id:task,kind:'완료',title:'검증한 구현 납품',contract_rev:1,checks:[{kind:'behavior',name:'원 동작',result:'pass',criterion:1,evidence:'격리 대역 실행',command:'bun test owned-stage'}]});
  f.runner.end(f.worker);await until('앞 실행 종료',()=>f.store.getExecutionJournal(original.runId)?.phase==='ended');await capture('foreground-ended-bgworking','working');expect(f.store.taskProgress(task).execution?.background).toBe('회귀 shell1');
  f.runner.callback({type:'background',memberId:f.worker.id,label:null,terminalId:f.worker.paneId,sessionGeneration:0});await until('납품',()=>f.store.taskProgress(task).stage==='delivered');await capture('delivered','delivered');
  const stage=(s:string)=>f.tool(f.lead,'task_stage',{task_id:task,stage:s,evidence:'격리 고정 근거 0123abcd'});
  await stage('review');await capture('review','review');await stage('merged');expect((await stage('done')).isError).toBe(true);expect(f.store.taskProgress(task).notice).toBeNull();await capture('merged-unapplied','merged');
  await stage('applied');expect((await stage('done')).isError).toBeUndefined();const notice=f.store.taskProgress(task).notice!;expect(notice).toBeTruthy();
  for(const p of pages){await p.goto(`${base}/#/p/${f.project.id}/inbox`);await p.locator('.ibx-notice').waitFor();await p.screenshot({path:join(folder,`done-notice-${p.viewportSize()!.width}.png`),fullPage:true});expect(await p.locator('.ibx-notice').innerText()).toContain('원 업무 수신부터 완료까지 완료');}
  await pages[1]!.locator('.ibx-notice__seen').click();for(const p of pages)await p.locator('.ibx-notice').waitFor({state:'detached'});await stage('done');expect(f.store.db.query('SELECT COUNT(*) AS n,COUNT(seen_at) AS seen FROM task_notices WHERE task_id=?').get(task)).toEqual({n:1,seen:1});
  expect(f.runner.to(f.worker).filter(s=>s.includes('원 입력 딱 한 번'))).toHaveLength(1);
  const stopped=(await f.tool(f.lead,'task',{title:'중단 뒤 옛 메모'})).text.match(/#(tk_[\w-]+)/)![1];await f.tool(f.worker2,'status',{now:'옛 실행 메모',next:'기존 결과 확인'});await f.orch.assign(f.project.id,f.worker2.handle,{text:'중단할 격리 원 입력',taskId:stopped},f.lead);await f.orch.stopMember(f.worker2.id,{by:'user'});f.runner.end(f.worker2);await until('중단',()=>f.store.requireMember(f.worker2.id).executionState?.phase==='interrupted');
  for(const p of pages){await p.goto(`${base}/#/p/${f.project.id}/team`);await p.locator('.tm-wi').filter({hasText:'중단 뒤 옛 메모'}).waitFor();expect(await p.locator('.tm-wi').filter({hasText:'중단 뒤 옛 메모'}).getAttribute('data-stage')).not.toBe('working');const card=p.locator('.tm-card').filter({hasText:'영희'});expect(await card.innerText()).toContain('마지막 일');await p.screenshot({path:join(folder,`interrupted-${p.viewportSize()!.width}.png`),fullPage:true});expect(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);}
  observed.push({name:'interrupted',task:f.store.taskWithProgress(stopped),originalCount:f.runner.to(f.worker2).filter(s=>s.includes('중단할 격리 원 입력')).length});
 }finally{writeFileSync(join(process.env.REVIEW_STAGE!,'runtime-observed.json'),JSON.stringify({task,events,observed},null,2));await browser.close();await server.stop();console.log('shots: '+folder);}
});
