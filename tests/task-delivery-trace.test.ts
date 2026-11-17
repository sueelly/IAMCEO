import { expect, test } from 'bun:test';
import { fixture } from './fixtures/harness-fixture.ts';

test('task trace shows recent and unsettled originals outside its first sixty deliveries without changing input state', async () => {
  const f = fixture();
  const task = f.orch.saveTask(f.worker, { title: 'Trace active delivery boundary' }).task;
  const oldHeld = f.store.enqueue({ projectId:f.project.id,memberId:f.worker.id,taskId:task.id,kind:'instruction',text:'private old draft',wake:true });
  f.store.markHeld(oldHeld.id,'delivery_unknown');
  for(let i=0;i<75;i++) {
    const d=f.store.enqueue({projectId:f.project.id,memberId:f.worker.id,taskId:task.id,kind:'system',text:`private historic ${i}`,wake:false});
    f.store.markDelivered(d.id);
  }
  const latest=f.store.enqueue({projectId:f.project.id,memberId:f.worker2.id,taskId:task.id,kind:'instruction',text:'private latest original',wake:true});
  const notice=f.store.enqueue({projectId:f.project.id,memberId:f.worker2.id,taskId:task.id,kind:'system',text:'private quiet notice',wake:false});
  const before = f.store.db.query<{n:number},[]>('SELECT total_changes() AS n').get()!.n;
  const result=await f.tool(f.worker,'task_trace',{task_id:task.id});
  expect(result.isError).not.toBe(true);
  const trace=JSON.parse(result.text);
  expect(trace.recentDeliveries ?? trace.deliveries).toEqual(expect.arrayContaining([expect.objectContaining({id:latest.id})]));
  expect(trace.unsettledDeliveries.map((d:{id:string})=>d.id)).toEqual([oldHeld.id,latest.id,notice.id]);
  expect(trace.deliveryCoverage).toMatchObject({ total:78, returned:60, truncated:true, unsettledTotal:3, unsettledReturned:3, unsettledTruncated:false, pendingWake:2, pendingNotice:1 });
  expect(trace.unsettledDeliveries.find((d:{id:string})=>d.id===oldHeld.id)).toMatchObject({status:'held',holdReason:'delivery_unknown',wake:true});
  expect(f.store.db.query<{n:number},[]>('SELECT total_changes() AS n').get()!.n).toBe(before);
  expect(f.runner.sent).toHaveLength(0);
  expect(trace.unsettledDeliveries.find((d:{id:string})=>d.id===oldHeld.id).execution).toBeNull();
  expect(f.store.requireDelivery(oldHeld.id)).toMatchObject({status:'held',holdReason:'delivery_unknown',attempts:0});
  expect(JSON.stringify(trace)).not.toContain('private ');
});

test('trace distinguishes transport delivery from an actual recorded input receipt and does not expose execution identity', async () => {
  const f=fixture(); const task=f.orch.saveTask(f.worker,{title:'Receipt metadata'}).task;
  const d=f.store.enqueue({projectId:f.project.id,memberId:f.worker.id,taskId:task.id,kind:'instruction',text:'SECRET_PROMPT',wake:true});
  await f.orch.pump(f.worker.id);
  const run=f.store.listPendingExecutions().find(r=>r.deliveryIds.includes(d.id))!;
  const received='2026-11-17T03:41:00.000Z',started='2026-11-17T03:41:00.050Z';
  f.store.saveExecutionJournal({...run,phase:'running',inputReceivedAt:received,startedAt:started,lastProgressAt:started,identity:{...run.identity,sessionId:'SECRET_NATIVE_SESSION',process:{pid:123,startedAt:'SECRET_PROCESS_IDENTITY'}}});
  const withoutRun=f.store.enqueue({projectId:f.project.id,memberId:f.worker2.id,taskId:task.id,kind:'system',text:'SECRET_NOTICE',wake:false});
  f.store.markDelivered(withoutRun.id);
  const trace=JSON.parse((await f.tool(f.worker,'task_trace',{task_id:task.id})).text);
  expect(trace.recentDeliveries.find((x:{id:string})=>x.id===withoutRun.id)).toMatchObject({status:'delivered',deliveredAt:expect.any(String),execution:null});
  const item=(trace.recentDeliveries ?? trace.deliveries).find((x:{id:string})=>x.id===d.id);
  expect(item).toMatchObject({id:d.id,status:'delivered',execution:{runId:run.runId,phase:'running',inputReceivedAt:received,startedAt:started,deliveryIds:[d.id]}});
  expect(JSON.stringify(trace)).not.toContain('SECRET_');
});

test('trace reports a bounded unsettled sample and all-row counts, and keeps cross-project reads refused', async () => {
  const f=fixture();const task=f.orch.saveTask(f.worker,{title:'Many quiet held notices'}).task;
  for(let i=0;i<65;i++) {
    const d=f.store.enqueue({projectId:f.project.id,memberId:f.worker.id,taskId:task.id,kind:'system',text:'silent',wake:false});
    f.store.markHeld(d.id,'asleep');
  }
  const trace=JSON.parse((await f.tool(f.worker,'task_trace',{task_id:task.id})).text);
  expect(trace.unsettledDeliveries).toHaveLength(60);
  expect(trace.deliveryCoverage).toMatchObject({total:65,unsettledTotal:65,unsettledReturned:60,unsettledTruncated:true,pendingWake:0,pendingNotice:65});
  const other=f.store.createProject({name:'Other project',cwd:f.project.cwd});
  const outsider=f.store.createMember({projectId:other.id,name:'Outside',handle:'outside',kind:'worker',origin:'manual',status:'idle'});
  expect((await f.tool(outsider,'task_trace',{task_id:task.id})).isError).toBe(true);
});
