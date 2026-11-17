import { test,expect } from 'bun:test';
import {fixture,until} from '../tests/fixtures/harness-fixture';
import {workRows} from '../web/src/lib/task-list';
let seq=0;
const task=async(f:any,contract?:any)=>(await f.tool(f.lead,'task',{title:'현재 실행 '+(++seq),...(contract?{contract}:{})})).text.match(/#(tk_[\w-]+)/)![1];
const post=(f:any,t:string,args:any)=>f.tool(f.worker,'post',{task_id:t,title:'격리 보고',...args});
const stage=(f:any,t:string,s:string)=>f.tool(f.lead,'task_stage',{task_id:t,stage:s,evidence:'고정 근거 0123abcd'});
test('live receipt without a progress report is visible; ended old note never implies working',async()=>{
 const f=fixture(),t=await task(f);await f.orch.assign(f.project.id,f.worker.handle,{text:'원 업무',taskId:t});
 const originalRun=f.store.requireMember(f.worker.id).executionState!.runId;
 expect(f.store.taskProgress(t).stage).not.toBe('new');expect(f.store.taskProgress(t).execution?.inputReceivedAt).toBeTruthy();
 await post(f,t,{kind:'진행',title:'조사 중'});f.runner.end(f.store.requireMember(f.worker.id));await until('원 실행 종료',()=>f.store.getExecutionJournal(originalRun)?.phase==='ended');
 expect(f.store.taskProgress(t).stage).not.toBe('working');expect(f.store.getExecutionJournal(originalRun)?.phase).toBe('ended');
 expect(f.runner.to(f.worker).filter((x:string)=>x.startsWith('[총괄]')&&x.includes('원 업무'))).toHaveLength(1);
});
test('background before turn_end remains working then clears with one event source',async()=>{
 const f=fixture(),t=await task(f);await f.orch.assign(f.project.id,f.worker.handle,{text:'회귀',taskId:t});
 f.runner.callback({type:'background',memberId:f.worker.id,label:'회귀 shell1',terminalId:f.worker.paneId,sessionGeneration:0});f.runner.end(f.worker);
 await until('종료',()=>f.store.requireMember(f.worker.id).executionState?.phase==='ended');
 expect(f.store.taskProgress(t)).toMatchObject({stage:'working',execution:{phase:'ended',background:'회귀 shell1'}});
 f.runner.callback({type:'background',memberId:f.worker.id,label:null,terminalId:f.worker.paneId,sessionGeneration:0});
 await until('뒤 작업 끝',()=>f.store.requireMember(f.worker.id).status==='idle');expect(f.store.taskProgress(t).stage).not.toBe('working');
});
test('a new contract and corrected completion invalidate old done mark and notice; documents still finish',async()=>{
 const f=fixture(),t=await task(f);await post(f,t,{kind:'완료',title:'문서 납품'});expect(f.store.taskProgress(t).stage).toBe('done');
 await f.tool(f.lead,'task',{task_id:t,contract:{kind:'coding',goal:'새 구현 주기',acceptance:['새 결과'],checks:['behavior']}});
 expect(f.store.taskProgress(t).stage).not.toBe('done');expect(f.store.taskProgress(t).notice).toBeNull();
 const d=await task(f);const r=await post(f,d,{kind:'완료',title:'원 납품'}),id=r.text.match(/#(msg_[\w-]+)/)![1];
 await post(f,d,{kind:'알림',title:'납품 철회',corrects_message_id:id});expect(f.store.taskProgress(d).stage).not.toBe('done');
});
test('done followed by a new owner cycle requires a new completion notice, not old terminal reuse',async()=>{
 const f=fixture(),t=await task(f);await post(f,t,{kind:'완료',title:'첫 결과'});const n=f.store.taskProgress(t).notice.id;
 await f.tool(f.worker,'todo',{task_id:t,title:'새 입력 확인'});const td=f.store.listTodos(f.project.id)[0];await f.orch.setTodoDone(td.id,true);
 expect(f.store.taskProgress(t).stage).not.toBe('done');await post(f,t,{kind:'완료',title:'새 조건까지 확인'});
 expect(f.store.taskProgress(t).stage).toBe('done');expect(f.store.taskProgress(t).notice.id).not.toBe(n);
});
test('manual doing memo without actual run is retained but not represented as executing',async()=>{
 const f=fixture();const w=f.store.upsertWork({projectId:f.project.id,title:'옛 조사 메모',who:'철수',sec:'doing'});
 const rows=workRows([w],f.store.listTasks(f.project.id),Date.now());expect(rows).toHaveLength(1);expect(rows[0].sec).not.toBe('doing');
});
test('owner direct original remains admissible while prequeued automatic instructions are loop fenced',async()=>{
 const f=fixture(),t=await task(f);for(let i=0;i<3;i++)await post(f,t,{kind:'막힘',checks:[{kind:'behavior',name:'원 실패',result:'fail',evidence:'원인'}]});
 const blocked=f.store.enqueue({projectId:f.project.id,memberId:f.worker2.id,taskId:t,kind:'instruction',text:'자동 반복',wake:true});
 f.store.enqueue({projectId:f.project.id,memberId:f.worker2.id,taskId:t,kind:'user_message',text:'[대표 직접] 새 판단',wake:true});await f.orch.pump(f.worker2.id);
 expect(f.runner.to(f.worker2).filter((s:string)=>s.includes('새 판단'))).toHaveLength(1);expect(f.runner.to(f.worker2).some((s:string)=>s.includes('자동 반복'))).toBe(false);expect(f.store.requireDelivery(blocked.id).status).toBe('queued');
});
test('new contract stage revision outruns old delivered response, so late response cannot overwrite it',async()=>{
 const f=fixture(),t=await task(f);await post(f,t,{kind:'완료',title:'문서 첫 완료'});const old=f.store.taskWithProgress(t);
 await f.tool(f.lead,'task',{task_id:t,contract:{kind:'coding',goal:'새 계약',acceptance:['실행'],checks:['behavior']}});const current=f.store.taskWithProgress(t);
 expect(current.progress.rev>old.progress.rev).toBe(true);
});
test('new unknown original input after done opens a protected cycle, and reopen cannot reuse previous completion',async()=>{
 const f=fixture(),t=await task(f);await post(f,t,{kind:'완료',title:'첫 완료'});
 f.store.enqueue({projectId:f.project.id,memberId:f.worker2.id,taskId:t,kind:'instruction',text:'새 원 입력',status:'held',holdReason:'delivery_unknown',wake:true});
 expect(f.store.taskProgress(t).stage).toBe('held');expect(f.store.taskProgress(t).notice).toBeNull();
 const other=await task(f,{kind:'coding',goal:'단계',acceptance:['구현'],checks:['behavior']});f.ran(f.worker,'bun test review');
 await post(f,other,{kind:'완료',contract_rev:1,checks:[{kind:'behavior',name:'검증',result:'pass',criterion:1,evidence:'실행',command:'bun test review'}]});await stage(f,other,'merged');await stage(f,other,'applied');await stage(f,other,'done');await stage(f,other,'reopen');
 expect((await stage(f,other,'done')).isError).toBe(true);
});
test('an active background task cannot auto-complete; zero background finalizes same completion once',async()=>{
 const f=fixture(),t=await task(f);await f.orch.assign(f.project.id,f.worker.handle,{text:'문서와 뒤 작업',taskId:t});
 f.runner.callback({type:'background',memberId:f.worker.id,label:'뒤 검증',terminalId:f.worker.paneId,sessionGeneration:0});
 await post(f,t,{kind:'완료',title:'문서 납품'});expect(f.store.taskProgress(t).stage).not.toBe('done');f.runner.end(f.worker);
 await until('원 실행 끝',()=>f.store.requireMember(f.worker.id).executionState?.phase==='ended');expect(f.store.taskProgress(t).stage).not.toBe('done');
 f.runner.callback({type:'background',memberId:f.worker.id,label:null,terminalId:f.worker.paneId,sessionGeneration:0});
 await until('정상 완료 알림',()=>f.store.taskProgress(t).stage==='done');expect(f.store.db.query('SELECT COUNT(*) AS n FROM task_notices WHERE task_id=?').get(t).n).toBe(1);
});
