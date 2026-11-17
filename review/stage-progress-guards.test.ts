import{test,expect}from'bun:test';import{fixture}from'../tests/fixtures/harness-fixture';import{watchOnReport,type ReportFact}from'../server/task-progress';
test('only a strict reduction in recorded original failure keys is progress; renamed or exchanged failures are not',()=>{
 const at=(m:number)=>new Date(Date.UTC(2026,10,17,0,m)).toISOString();
 const report=(m:number,keys:string[]):ReportFact=>({id:'r'+m,seq:m,at:at(m),kind:'막힘',memberId:'w',who:'직원',authorKind:'worker',failed:keys.map(k=>'보이는 이름'+m+k),failureKeys:keys,notRun:[],checks:keys.length,passed:false});
 const first=watchOnReport(null,report(0,['A','B'])).next!;
 const renamed=watchOnReport(first,report(60,['A','B'])).next!;expect(renamed.lastProgressAt).toBe(at(0));
 const fixed=watchOnReport(renamed,report(61,['B'])).next!;expect(fixed.lastProgressAt).toBe(at(61));
 const changed=watchOnReport(fixed,report(119,['C'])).next!;expect(changed.lastProgressAt).toBe(at(61));
});
test('a branch with no binding contract cannot claim applied completion on merge alone',async()=>{
 const f=fixture(),t=(await f.tool(f.lead,'task',{title:'계약 없는 코드 작업',branch:'fix-approved-code'})).text.match(/#(tk_[\w-]+)/)![1];
 await f.tool(f.worker,'post',{task_id:t,kind:'완료',title:'코드 납품'});const stage=(s:string)=>f.tool(f.lead,'task_stage',{task_id:t,stage:s,evidence:'고정 근거 1234abcd'});
 await stage('merged');expect((await stage('done')).isError).toBe(true);await stage('applied');expect((await stage('done')).isError).toBeUndefined();
});
