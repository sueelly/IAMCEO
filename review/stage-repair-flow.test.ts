import{test,expect}from'bun:test';import{fixture,until}from'../tests/fixtures/harness-fixture';
let seq=0;
const contract={kind:'coding',goal:'기존 승인 범위 보완',acceptance:['정상 결과'],checks:['behavior']};
const newTask=async(f:any)=>(await f.tool(f.lead,'task',{title:'보완 연결 '+(++seq),contract})).text.match(/#(tk_[\w-]+)/)![1];
const failed=(t:string)=>({task_id:t,contract_rev:1,kind:'막힘',title:'원 기술 실패',checks:[{kind:'behavior',name:'저장 실패',result:'fail',criterion:1,evidence:'같은 원인'}]});
const repairs=(f:any)=>f.store.db.query("SELECT m.task_id,m.about_message_id AS source_message_id,d.id AS delivery_id FROM messages m JOIN deliveries d ON d.ref_type='message' AND d.ref_id=m.id WHERE m.kind='시스템' AND m.title='기존 업무 보완 후속' AND d.kind='instruction'").all();
test('received approved work failure schedules one new corrective instruction, not a replay, and keeps verification/review owner',async()=>{
 const f=fixture(),t=await newTask(f);await f.orch.assign(f.project.id,f.worker.handle,{text:'원 지시 본문',taskId:t},f.lead);
 const op={operationId:crypto.randomUUID()},args=failed(t),r=await f.orch.handleAgentOperation(f.store.requireMember(f.worker.id),'post',args,op);await f.orch.handleAgentOperation(f.store.requireMember(f.worker.id),'post',args,op);
 const rows=repairs(f);expect(rows).toHaveLength(1);expect(rows[0].task_id).toBe(t);const repair=f.store.requireDelivery(rows[0].delivery_id);
 expect(repair.text).toContain('보완');expect(repair.text).toContain('검증');expect(repair.text).toContain('독립 검토');expect(repair.text).not.toContain('원 지시 본문');expect(f.runner.to(f.worker)).toHaveLength(1);
 f.runner.end(f.worker);await until('다음 보완',()=>f.runner.to(f.worker).some((s:string)=>s.includes(rows[0].source_message_id)));
 expect(f.runner.to(f.worker).filter((s:string)=>s.includes('원 지시 본문'))).toHaveLength(1);expect(repairs(f)).toHaveLength(1);
});
test('unknown, owner question and explicit interruption never schedule a corrective replay',async()=>{
 for(const guard of ['unknown','owner','stop']){
  const f=fixture(),t=await newTask(f);await f.orch.assign(f.project.id,f.worker.handle,{text:'기존 지시',taskId:t},f.lead);
  if(guard==='unknown')f.store.enqueue({projectId:f.project.id,memberId:f.worker2.id,kind:'instruction',text:'수신 모름',status:'held',holdReason:'delivery_unknown',taskId:t});
  if(guard==='owner')await f.tool(f.worker,'todo',{task_id:t,title:'대표 로그인'});
  if(guard==='stop'){await f.orch.stopMember(f.worker.id,{by:'user'});f.runner.end(f.worker);await until('중단 확인',()=>f.store.requireMember(f.worker.id).executionState?.phase==='interrupted')}
  await f.tool(f.worker,'post',failed(t));expect(repairs(f)).toHaveLength(0);
 }
});
test('an unassigned report cannot create a new paid execution or new responsibility',async()=>{const f=fixture(),t=await newTask(f);await f.tool(f.worker,'post',failed(t));expect(repairs(f)).toHaveLength(0);expect(f.runner.to(f.worker)).toHaveLength(0)});

test('loop stop fences queued worker system followups as well as instructions, while conductor receives one notice',async()=>{
 const f=fixture(),t=await newTask(f);const d=f.store.enqueue({projectId:f.project.id,memberId:f.worker2.id,taskId:t,kind:'system',text:'자동 보고 보완 원문',wake:true});
 for(let i=0;i<3;i++)await f.tool(f.worker,'post',failed(t));await f.orch.pump(f.worker2.id);
 expect(f.runner.to(f.worker2).some((s:string)=>s.includes('자동 보고 보완 원문'))).toBe(false);expect(f.store.requireDelivery(d.id).status).toBe('queued');
 expect(f.store.db.query("SELECT COUNT(*) AS n FROM deliveries WHERE member_id=? AND kind='system' AND text LIKE '%반복 감시%'").get(f.lead.id).n).toBe(1);
});
test('queued corrective input is fenced after source correction and after contract replacement',async()=>{
 for(const guard of ['correction','contract']){const f=fixture(),t=await newTask(f);await f.orch.assign(f.project.id,f.worker.handle,{text:'원 입력',taskId:t},f.lead);
 const r=await f.tool(f.worker,'post',failed(t)),source=r.text.match(/#(msg_[\w-]+)/)![1];expect(repairs(f)).toHaveLength(1);
 if(guard==='correction')await f.tool(f.worker,'post',{task_id:t,kind:'알림',title:'실패 보고 철회',corrects_message_id:source});
 else await f.tool(f.lead,'task',{task_id:t,contract:{...contract,goal:'다음 계약'}});
 f.runner.end(f.worker);await until('원 실행 종료',()=>f.store.requireMember(f.worker.id).executionState?.phase==='ended');
 expect(f.runner.to(f.worker).some((s:string)=>s.includes('기존 승인 업무'))).toBe(false);expect(f.store.requireDelivery(repairs(f)[0].delivery_id).status).toBe('queued');
 }
});
