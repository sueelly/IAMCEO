import { afterAll, expect, test, spyOn } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync, writeFileSync, appendFileSync, symlinkSync, linkSync, renameSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fixture } from "./fixtures/harness-fixture.ts";

const q1 = "const missing = [...exec.reasons, ...verified.reasons];";
const q2 = 'quoteMatched, sourceRead, semanticReview: "required" };';
const q3 = "| Codex·Antigravity 훅 | 연결하지 않음 | 이번 범위 밖 |";
const command = "git rev-parse HEAD", observations: unknown[] = [];
const id = (reply: {text:string}, prefix = "tk") => reply.text.match(new RegExp(`#(${prefix}_[\\w-]+)`))![1]!;
afterAll(() => { const path = join(import.meta.dir, "../.pumasi/source-evidence-20261115/evidence/observations.json"); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify({ syntheticOnly: true, liveSecretaryCalled: false, observations }, null, 2)); });
async function setup() {
  const f = fixture(), member = f.make("source", "가짜 조사", "worker", "codex");
  const task = id(await f.tool(f.lead, "task", { title: "원 출처 대조", contract: { kind: "research", goal: "원 주장·출처를 유지한다", acceptance: ["열람·인용만 대조", "미열람 단독 거절", "정상 실행 보존"], checks: ["source", "fact", "unverified", "behavior"] } }));
  const sources = ["server/orchestrator.ts", "server/harness-evidence.ts"];
  for (const [i, source] of sources.entries()) { const path = join(f.project.cwd, source); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `// synthetic public code\n${i ? "return { verified: false, " + q2 : q1}\n// observed fragment only\n`); }
  const peer = id(await f.tool(f.worker2, "file", { task_id: task, title: "기존 권한 설명", content: q3 }), "f");
  const peerReport=id(await f.tool(f.worker2,"post",{task_id:task,kind:"진행",title:"기존 권한 설명",file_ids:[peer]}),"msg");
  const peerRead=await f.tool(member,"post",{report_id:peerReport});expect(peerRead.text).toContain(q3);
  observations.push({label:"peer-source-read",source:peer,response:peerRead});
  const claims = [
    { text: "완료 관문은 실행 검사와 조사 주장 대조의 누락 사유를 합쳐 거절한다.", basis: "fact", source: join(f.project.cwd, sources[0]!), quote: q1, criterion: 1 },
    { text: "현재 출처 대조는 인용 존재·열람 관찰과 주장 의미의 검증을 구분하며, 관찰 결과의 verified는 false이고 semanticReview는 required다.", basis: "fact", source: join(f.project.cwd, sources[1]!), quote: q2, criterion: 1 },
    { text: "완료 관문과 실행 전 제한은 별개다. Claude 훅의 거절 사례를 Codex의 같은 실행 차단으로 확대해서는 안 된다.", basis: "interpretation", source: peer, quote: q3, criterion: 1 }];
  const at = new Date().toISOString(), log = join(f.isolated.paths.codexHome, "sessions/fake/rollout-source.jsonl"); mkdirSync(dirname(log), { recursive: true });
  const rows = [{ type: "session_meta", timestamp: at, payload: { id: member.sessionId, cwd: member.cwd } }, { type: "event_msg", timestamp: at, payload: { type: "item_completed", thread_id: member.sessionId, item: { id: "FAKE_SOURCE_EXEC", type: "CommandExecution", command, cwd: member.cwd, status: "completed", exit_code: 0, aggregated_output: "FAKE_HEAD" } } }];
  writeFileSync(log, rows.map(v => JSON.stringify(v)).join("\n") + "\n");
  const checks = [{name:"출처",kind:"source",result:"pass",evidence:"실제 조각 대조",criterion:1},{name:"구분",kind:"fact",result:"pass",evidence:"의미 별도",criterion:1},{name:"미확인",kind:"unverified",result:"pass",evidence:"가짜 격리 범위",criterion:2},{name:"실행",kind:"behavior",result:"pass",evidence:"정상 가짜 제공자 기록",command,criterion:3}];
  const read = async (i: number, extra: Record<string,unknown> = {}, caller = member) => {
    const args = { task_id: task, contract_rev: 1, source: sources[i], start_line: 2, end_line: 2, ...extra };
    const response = await f.tool(caller, "code_read", args); observations.push({ label: "read", args, response }); return response;
  };
  const submit = async (changed = claims) => { const args = { task_id: task, contract_rev: 1, kind: "완료", title: "원 주장 조사", checks, claims: changed, unverified: [] }; const response = await f.tool(member, "post", args); observations.push({ label: "completion", args, response }); return response; };
  return { ...f, member, task, sources, claims, checks, read, submit, log, rows };
}
test("원 코드 두 출처의 실제 조각과 원인용으로 정상 완료가 저장된다", async () => {
  const s = await setup();
  for (let i=0;i<2;i++) expect((await s.read(i)).isError).toBeUndefined();
  const done = await s.submit(); expect(done.isError).toBeUndefined();
  const report = s.store.getReportHarness(id(done,"msg"))!;
  expect(report.checks.find(c=>c.kind==="behavior")).toMatchObject({execStatus:"matched",execExit:0});
  for (const claim of report.claims.slice(0,2)) expect(claim).toMatchObject({quoteMatched:true,sourceRead:true,verified:false,semanticReview:"required"});
  const trace=await s.tool(s.member,"task_trace",{task_id:s.task}),publicReport=await s.tool(s.worker2,"post",{report_id:id(done,"msg")});
  observations.push({label:"stored-normal",harness:report,trace,publicReport});
});
test("다른 조건이 정상인 미열람 출처 하나만 거절하고 실제 읽기 뒤 수용한다", async () => {
  const s = await setup(); expect((await s.read(0)).isError).toBeUndefined();
  const refused = await s.submit(); expect(refused.isError).toBe(true);
  expect(refused.text).toContain("주장 2"); expect(refused.text).not.toContain("주장 1"); expect(refused.text).not.toContain("명령 자리");
  expect((await s.read(1)).isError).toBeUndefined(); expect((await s.submit()).isError).toBeUndefined();
});
test("원 세 주장이 정상인 상태에서 README 미열람 해석 하나만 거절한다",async()=>{
  const s=await setup();for(let i=0;i<2;i++)expect((await s.read(i)).isError).toBeUndefined();
  const source=join(s.project.cwd,"README.md");writeFileSync(source,"# Synthetic documentation\n권한 제한 설명은 별도 검토합니다.\n");
  const claims=[...s.claims,{text:"검증용 미열람 해석: README의 권한 제한 설명이 충분한지는 원문 검토가 더 필요하다.",basis:"interpretation",source,quote:"",criterion:2}];
  const rejected=await s.submit(claims);expect(rejected.isError).toBe(true);expect(rejected.text).toContain("주장 4");
  for(const i of [1,2,3])expect(rejected.text).not.toContain("주장 "+i);
  const normal=await s.submit();expect(normal.isError).toBeUndefined();
  observations.push({label:"readme-unread-only",claims,rejected,normal,harness:s.store.getReportHarness(id(normal,"msg"))});
});
test("셸 stdout과 자기 자료의 두 원인용만으로 열람을 만들 수 없다", async () => {
  const s=await setup(); (s.rows[1]!.payload as any).item.aggregated_output=s.claims.map(c=>c.source+"\n"+c.quote).join("\n");
  writeFileSync(s.log,s.rows.map(r=>JSON.stringify(r)).join("\n")+"\n");
  await s.tool(s.member,"file",{task_id:s.task,title:"자기 인용",content:q1+"\n"+q2});
  const response=await s.submit();expect(response.isError).toBe(true);expect(response.text).toContain("주장 1");expect(response.text).toContain("주장 2");expect(response.text).not.toContain("명령 자리");
});

test("읽은 줄 밖의 같은 파일 인용과 실제 조각의 다른 인용은 거절한다", async () => {
  const s=await setup();expect((await s.read(0,{start_line:1,end_line:1})).isError).toBeUndefined();expect((await s.read(1)).isError).toBeUndefined();
  expect((await s.submit()).isError).toBe(true);
  expect((await s.read(0)).isError).toBeUndefined();
  const changed=structuredClone(s.claims);changed[0]!.quote="const missing = ['FAKE_UNREAD_QUOTE'];";
  expect((await s.submit(changed)).isError).toBe(true);expect((await s.submit()).isError).toBeUndefined();
});
test("다른 출처의 같은 문구를 원 출처 열람으로 빌리지 않는다", async () => {
  const s=await setup();appendFileSync(join(s.project.cwd,s.sources[1]!),q1+"\n");
  expect((await s.read(1,{start_line:1,end_line:4})).isError).toBeUndefined();
  const r=await s.submit();expect(r.isError).toBe(true);expect(r.text).toContain("주장 1");expect(r.text).not.toContain("주장 2");
});
test("다른 직원과 같은 프로젝트의 다른 업무 관찰은 승계하지 않는다", async () => {
  const s=await setup();for(let i=0;i<2;i++)expect((await s.read(i,{},s.worker2)).isError).toBeUndefined();
  expect((await s.submit()).isError).toBe(true);
  const other=id(await s.tool(s.lead,"task",{title:"다른 조사",contract:{kind:"research",goal:"다른 업무",acceptance:["별개"]}}));
  for(let i=0;i<2;i++)expect((await s.read(i,{task_id:other})).isError).toBeUndefined();
  expect((await s.submit()).isError).toBe(true);
});
test("다른 프로젝트의 업무를 지정한 읽기는 거절한다", async () => {
  const s=await setup(), project=s.store.createProject({name:"다른 가짜 프로젝트",cwd:s.project.cwd});
  const outsider=s.store.createMember({projectId:project.id,handle:"outside",name:"다른 직원",kind:"worker",cwd:s.project.cwd,status:"idle",cli:"codex"});
  const response=await s.read(0,{},outsider);expect(response.isError).toBe(true);
  expect(s.store.db.query("SELECT count(*) n FROM agent_operation_receipts WHERE tool_name='server_code_read_v1'").get()).toEqual({n:0});
});
test("새 확정 판은 옛 읽기를 받지 않고 새 판의 실제 읽기 뒤 정상 수용한다", async () => {
  const s=await setup();for(let i=0;i<2;i++)expect((await s.read(i)).isError).toBeUndefined();
  await s.tool(s.lead,"task",{task_id:s.task,contract:{kind:"research",goal:"새 판",acceptance:["열람","범위","실행"],checks:["source","fact","unverified","behavior"]}});
  expect((await s.read(0)).isError).toBe(true);
  const args={task_id:s.task,contract_rev:2,kind:"완료",title:"새 판",claims:s.claims,checks:s.checks,unverified:[]};
  expect((await s.tool(s.member,"post",args)).isError).toBe(true);
  // 새 판 이후의 정상 실행도 새로 남겨야 출처만의 차이를 볼 수 있다.
  const rows=structuredClone(s.rows);for(const row of rows)row.timestamp=new Date().toISOString();(rows[1]!.payload as any).item.id="FAKE_REV2_EXEC";writeFileSync(s.log,rows.map(v=>JSON.stringify(v)).join("\n")+"\n");
  for(let i=0;i<2;i++)expect((await s.read(i,{contract_rev:2})).isError).toBeUndefined();
  expect((await s.tool(s.member,"post",args)).isError).toBeUndefined();
});
test("확인 전 직원 계약으로는 읽기 관찰을 만들지 못한다", async () => {
  const s=await setup(),task=id(await s.tool(s.member,"task",{title:"확인 전",contract:{kind:"research",goal:"확인 전",acceptance:["확인 필요"]}}));
  expect((await s.read(0,{task_id:task})).isError).toBe(true);
});
test("읽힌 snapshot과 이후 파일 변경을 구분하고 새 내용은 다시 읽기 전 거절한다", async () => {
  const s=await setup(),a=await s.read(0);expect(a.isError).toBeUndefined();expect((await s.read(1)).isError).toBeUndefined();
  const observed=JSON.parse(a.text),newQuote="const missing = [...verified.reasons, ...exec.reasons];";
  writeFileSync(join(s.project.cwd,s.sources[0]!),newQuote+"\n");
  const before=await s.submit();expect(before.isError).toBeUndefined();expect(s.store.getReportHarness(id(before,"msg"))!.claims[0]!.via).toContain(observed.snapshotSha256);
  const changed=structuredClone(s.claims);changed[0]!.quote=newQuote;expect((await s.submit(changed)).isError).toBe(true);
  expect((await s.read(0,{start_line:1,end_line:1})).isError).toBeUndefined();expect((await s.submit(changed)).isError).toBeUndefined();
});
for(const source of ["../server/orchestrator.ts","/fake/outside/server/orchestrator.ts",".env",".env.local","id_ed25519","iamceo.db","https://example.invalid/a","server/../server/orchestrator.ts","server\\orchestrator.ts"])
test(`열람 입력: 허용 두 파일 밖 ${source}를 거절한다`,async()=>{const s=await setup(),r=await s.read(0,{source});expect(r.isError).toBe(true);expect(s.store.db.query("SELECT count(*) n FROM agent_operation_receipts WHERE tool_name='server_code_read_v1'").get()).toEqual({n:0});});
for(const extra of [{start_line:0},{end_line:1},{end_line:100},{start_line:9,end_line:9},{start_line:1.5},{source:"server/orchestrator.ts\0"},{path:"FAKE_PRIVATE_ARGUMENT"},{session_id:"FAKE_PRIVATE_ARGUMENT"},{text:"FAKE_PRIVATE_ARGUMENT"}])
test("잘못된 범위·자유 인자는 내용을 내보내지 않고 거절한다",async()=>{const s=await setup(),r=await s.read(0,extra);expect(r.isError).toBe(true);expect(r.text).not.toContain("FAKE_PRIVATE_ARGUMENT");});
for(const shape of ["leaf-symlink","leaf-symlink-inside","parent-symlink","parent-symlink-inside","hard-link","directory"])
test(`파일 경계: ${shape}로 외부/비밀을 읽지 않는다`,async()=>{
  const s=await setup(),path=join(s.project.cwd,s.sources[0]!),outside=join(s.isolated.paths.temp,"FAKE_PRIVATE_SOURCE");writeFileSync(outside,"API_KEY=FAKE_OUTSIDE_CREDENTIAL\n");
  if(shape.startsWith("parent-symlink")){const saved=join(s.project.cwd,"saved-server");renameSync(dirname(path),saved);writeFileSync(join(s.isolated.paths.temp,"orchestrator.ts"),"API_KEY=FAKE_OUTSIDE_CREDENTIAL\n");symlinkSync(shape.endsWith("inside")?saved:s.isolated.paths.temp,dirname(path));}
  else {renameSync(path,path+".preserved");if(shape.startsWith("leaf-symlink"))symlinkSync(shape.endsWith("inside")?path+".preserved":outside,path);else if(shape==="hard-link")linkSync(outside,path);else mkdirSync(path);}
  const r=await s.read(0);expect(r.isError).toBe(true);expect(r.text).not.toContain("FAKE_OUTSIDE_CREDENTIAL");
});
for(const text of ["API_KEY=FAKE_ONLY_CREDENTIAL\n","--user name:\u00a0FAKE_ONLY_CREDENTIAL\n","-H 'Authori'\"zation: Bearer FAKE_ONLY_CREDENTIAL\"\n","https://name:FAKE_ONLY_CREDENTIAL@example.invalid\n"])
test("알려진 민감 표기가 있는 코드 조각은 보관/응답 전에 거절한다",async()=>{
  const s=await setup();writeFileSync(join(s.project.cwd,s.sources[0]!),text);const r=await s.read(0,{start_line:1,end_line:1});expect(r.isError).toBe(true);expect(r.text).not.toContain("FAKE_ONLY_CREDENTIAL");
  const stored=s.store.db.query("SELECT result_json FROM agent_operation_receipts").all();expect(JSON.stringify(stored)).not.toContain("FAKE_ONLY_CREDENTIAL");
});
for(const bytes of [Buffer.from([0xff,0xfe,0x61]),Buffer.from("fake\0text"),Buffer.from("x".repeat(2*1024*1024+1)),Buffer.from("x".repeat(16385))])
test("비텍스트·파일/조각 한도 초과는 부분 성공을 만들지 않는다",async()=>{const s=await setup();writeFileSync(join(s.project.cwd,s.sources[0]!),bytes);const r=await s.read(0,{start_line:1,end_line:1});expect(r.isError).toBe(true);expect(s.store.db.query("SELECT count(*) n FROM agent_operation_receipts WHERE tool_name='server_code_read_v1'").get()).toEqual({n:0});});

test("MCP operation의 새 성공/재요청과 공통 거절 요청 보관을 분리한다",async()=>{
  const s=await setup(),args={task_id:s.task,contract_rev:1,source:s.sources[0],start_line:2,end_line:2};
  const first=await s.orch.handleAgentOperation(s.member,"code_read",args,{operationId:"source-read-one"});expect(first.isError).toBeUndefined();
  const before=s.store.db.query("SELECT count(*) n FROM agent_operation_receipts").get();
  writeFileSync(join(s.project.cwd,s.sources[0]!),"changed\n");
  const again=await s.orch.handleAgentOperation(s.member,"code_read",args,{operationId:"source-read-one"});expect(again).toEqual(first);expect(s.store.db.query("SELECT count(*) n FROM agent_operation_receipts").get()).toEqual(before);
  const marker="FAKE_REJECTED_REQUEST_ONLY",bad={...args,path:marker};const rejected=await s.orch.handleAgentOperation(s.member,"code_read",bad,{operationId:"source-read-reject"});expect(rejected.isError).toBe(true);expect(rejected.text).not.toContain(marker);
  const receipt=s.store.db.query("SELECT request_json,result_json FROM agent_operation_receipts WHERE operation_id='agent-result:source-read-reject'").get() as any;expect(receipt.request_json).toContain(marker);expect(receipt.result_json).not.toContain(marker);
  observations.push({label:"operation",args,first,again,rejected,requestRetained:true});
});

test("원인용이 존재해도 주장 의미·진위를 verified로 승격하지 않는다",async()=>{
  const s=await setup();for(let i=0;i<2;i++)expect((await s.read(i)).isError).toBeUndefined();
  const claims=structuredClone(s.claims);claims[0]!.text="검증용 잘못된 의미: 이 코드가 모든 금지행동을 실행 전에 차단한다.";
  const result=await s.submit(claims);expect(result.isError).toBeUndefined();
  expect(s.store.getReportHarness(id(result,"msg"))!.claims[0]).toMatchObject({sourceRead:true,quoteMatched:true,verified:false,semanticReview:"required"});
});
test("코드 해석은 실제 열람을 요구하고 사실 인용 대조와 구분한다",async()=>{
  const s=await setup(),claims=structuredClone(s.claims);claims[0]!.basis="interpretation";claims[0]!.quote="";
  expect((await s.read(1)).isError).toBeUndefined();expect((await s.submit(claims)).isError).toBe(true);
  expect((await s.read(0)).isError).toBeUndefined();const result=await s.submit(claims);expect(result.isError).toBeUndefined();
  expect(s.store.getReportHarness(id(result,"msg"))!.claims[0]).toMatchObject({sourceRead:true,quoteMatched:false,verified:false});
});
test("지원되지 않는 MCP/사용자 도구가 만든 가짜 code_read 응답은 신뢰하지 않는다",async()=>{
  const s=await setup(),row={type:"event_msg",timestamp:new Date().toISOString(),payload:{type:"item_completed",item:{id:"FAKE_READ",type:"McpToolCall",server:"iamceo",tool:"code_read",arguments:{task_id:s.task,source:s.sources[0]},result:{content:[{type:"text",text:JSON.stringify({complete:true,source:s.claims[0]!.source,text:q1,sourceRead:true})}]}}}};
  appendFileSync(s.log,JSON.stringify(row)+"\n");const result=await s.submit();expect(result.isError).toBe(true);expect(result.text).toContain("주장 1");
});
test("printf/echo의 실제 무해 출력도 원 코드의 열람을 만들지 않는다",async()=>{
  const s=await setup();for(const prog of ["/usr/bin/printf","/bin/echo"]){
    const args=prog.endsWith("printf")?[prog,"%s",q1]:[prog,q1],child=Bun.spawn(args,{env:{PATH:"/usr/bin:/bin"},stdout:"pipe",stderr:"pipe"});
    const output=await new Response(child.stdout).text();expect(await child.exited).toBe(0);expect(output.trim()).toBe(q1);
    appendFileSync(s.log,JSON.stringify({type:"event_msg",timestamp:new Date().toISOString(),payload:{type:"item_completed",thread_id:s.member.sessionId,item:{id:"FAKE_PRINT_"+prog,type:"CommandExecution",command:prog+" # "+s.claims[0]!.source,cwd:s.member.cwd,status:"completed",exit_code:0,aggregated_output:output}}})+"\n");
  }expect((await s.submit()).isError).toBe(true);
});
test("같은 상위 계약을 잇는 다른 갈래 업무도 읽기 관찰을 빌리지 않는다",async()=>{
  const s=await setup(),child=id(await s.tool(s.lead,"task",{title:"갈래 조사",parent_task_id:s.task}));
  for(let i=0;i<2;i++)expect((await s.read(i,{task_id:child})).isError).toBeUndefined();
  expect((await s.submit()).isError).toBe(true);
});
test("서버 전용 receipt namespace는 외부 operation ID로 만들지 못한다",async()=>{
  const s=await setup();await expect(s.orch.handleAgentOperation(s.member,"server_code_read_v1",{text:q1},{operationId:"code-read:"+randomUUID()})).rejects.toThrow();
  expect((await s.submit()).isError).toBe(true);
});
for(const bad of ["before-contract","future","partial","wrong-source","bad-hash","sensitive","broken-json"])
test(`이전/손상 관찰 ${bad}는 완료 근거로 승격하지 않는다`,async()=>{
  const s=await setup(),read=await s.read(0);expect(read.isError).toBeUndefined();expect((await s.read(1)).isError).toBeUndefined();
  const o=JSON.parse(read.text),where=o.id;
  if(bad==="before-contract")o.observedAt="2000-01-01T00:00:00Z";
  if(bad==="future")o.observedAt="2099-01-01T00:00:00Z";
  if(bad==="partial")o.complete=false;
  if(bad==="wrong-source")o.source=s.claims[1]!.source;
  if(bad==="bad-hash")o.fragmentSha256="0".repeat(64);
  if(bad==="sensitive"){o.text="API_KEY=FAKE_OLD_OBSERVATION_SECRET";o.fragmentSha256=createHash("sha256").update(o.text).digest("hex");}
  s.store.db.query("UPDATE agent_operation_receipts SET result_json=? WHERE operation_id=?").run(bad==="broken-json"?"{":JSON.stringify(o),where);
  const response=await s.submit();expect(response.isError).toBe(true);expect(response.text).toContain("주장 1");expect(response.text).not.toContain("FAKE_OLD_OBSERVATION_SECRET");
});

test("보호된 서버 데이터 root가 프로젝트 경로가 되어도 코드 읽기를 열지 않는다",async()=>{
  const s=await setup();s.store.db.query("UPDATE projects SET cwd=? WHERE id=?").run(s.isolated.paths.iamceoHome,s.project.id);
  const path=join(s.isolated.paths.iamceoHome,s.sources[0]!);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,"FAKE_PROTECTED_SERVER_CONTENT\n");
  const r=await s.read(0,{start_line:1,end_line:1});expect(r.isError).toBe(true);expect(r.text).not.toContain("FAKE_PROTECTED_SERVER_CONTENT");
});
test("프로젝트 root 자체가 링크면 읽기 관찰을 만들지 않는다",async()=>{
  const s=await setup(),alias=join(s.isolated.paths.temp,"project-link");symlinkSync(s.project.cwd,alias);
  s.store.db.query("UPDATE projects SET cwd=? WHERE id=?").run(alias,s.project.id);expect((await s.read(0)).isError).toBe(true);
});
for(const mode of ["short-read","changed-during-read"])
test(`실제 읽기 경계 ${mode}는 성공/부분 receipt를 남기지 않는다`,async()=>{
  const s=await setup(),path=join(s.project.cwd,s.sources[0]!),original=fs.readSync;let called=false;
  const mock=spyOn(fs,"readSync").mockImplementation(((...args:any[])=>{called=true;if(mode==="short-read")return 0;appendFileSync(path,"// changed\n");return (original as any)(...args);}) as any);
  let result;try{result=await s.read(0);}finally{mock.mockRestore();}
  expect(called).toBe(true);expect(result!.isError).toBe(true);expect(s.store.db.query("SELECT count(*) n FROM agent_operation_receipts WHERE tool_name='server_code_read_v1'").get()).toEqual({n:0});
});
test("계약별 관찰128 한도에서 정상 마지막 읽기는 보존하고 초과는 거절한다",async()=>{
  const s=await setup(),read=await s.read(0);expect(read.isError).toBeUndefined();const observation=JSON.parse(read.text);
  const saved=s.store.db.query("SELECT request_json FROM agent_operation_receipts WHERE operation_id=?").get(observation.id) as any,scope=JSON.parse(saved.request_json);
  for(let i=1;i<127;i++)s.store.saveCodeRead(scope,{...observation,id:"code-read:"+randomUUID()});
  expect((await s.read(0)).isError).toBeUndefined();const refused=await s.read(0);expect(refused.isError).toBe(true);expect(refused.text).toContain("한도");
});
test("한글·BOM·CRLF·마지막 개행 없는 정상 조각과 snapshot을 보존한다",async()=>{
  const s=await setup(),text="\uFEFF// 가짜 공개 코드\r\n"+q1;writeFileSync(join(s.project.cwd,s.sources[0]!),text);
  const r=await s.read(0);expect(r.isError).toBeUndefined();const data=JSON.parse(r.text);expect(data.text).toBe(q1);expect(data.snapshotSha256).toBe(createHash("sha256").update(text).digest("hex"));
  expect((await s.read(1)).isError).toBeUndefined();expect((await s.submit()).isError).toBeUndefined();
});
test("현재 승인 코드의 격리 사본에서도 원 두 인용과 verified=false 맥락을 보존한다",async()=>{
  const s=await setup();
  for(let i=0;i<2;i++){
    const actual=readFileSync(new URL("../"+s.sources[i],import.meta.url),"utf8"),quote=i?q2:q1,line=actual.split("\n").findIndex(l=>l.includes(quote))+1;
    expect(line).toBeGreaterThan(0);writeFileSync(join(s.project.cwd,s.sources[i]!),actual);
    const read=await s.read(i,{start_line:i?line-1:line,end_line:line});expect(read.isError).toBeUndefined();expect(JSON.parse(read.text).text).toContain(quote);
    if(i===1)expect(JSON.parse(read.text).text).toContain("verified: false");
  }
  expect((await s.submit()).isError).toBeUndefined();
});
test("실제 도구 목록은 고정 두 코드와 다섯 인자만 공개한다",async()=>{
  const {listAgentTools}=await import("../server/agent-tools.ts"),s=await setup();
  const tool=listAgentTools(s.member).find(t=>t.name==="code_read")!;expect(tool).toBeTruthy();const schema=tool.inputSchema as any;
  expect(Object.keys(schema.properties).sort()).toEqual(["contract_rev","end_line","source","start_line","task_id"]);
  expect(schema.additionalProperties).toBe(false);expect(schema.properties.source.enum).toEqual(s.sources);
});
test("열람은 성공 관찰만 보관하며 계약·완료·보고·실행기와 파일을 바꾸지 않는다",async()=>{
  const s=await setup(),path=join(s.project.cwd,s.sources[0]!),beforeFile=readFileSync(path),beforeRunner=structuredClone(s.runner.sent);
  const tables=["tasks","task_contracts","messages","report_harness","report_claims","report_checks","harness_exec_refs"];
  const counts=()=>Object.fromEntries(tables.map(t=>[t,s.store.db.query(`SELECT count(*) n FROM ${t}`).get()]));const before=counts();
  const r=await s.read(0);expect(r.isError).toBeUndefined();expect(counts()).toEqual(before);expect(readFileSync(path)).toEqual(beforeFile);expect(s.runner.sent).toEqual(beforeRunner);
  const trace=await s.tool(s.member,"task_trace",{task_id:s.task});expect(JSON.parse(trace.text).currentCompletion.eligible).toBe(false);
  observations.push({label:"read-domain-unchanged",response:r,trace});
});
test("80줄·16KiB 조각·2MiB 파일의 정상 경계는 잘라내지 않고 읽는다",async()=>{
  const s=await setup(),path=join(s.project.cwd,s.sources[0]!);
  writeFileSync(path,"// x\n".repeat(79)+q1+"\n");const lines=await s.read(0,{start_line:1,end_line:80});expect(lines.isError).toBeUndefined();expect(JSON.parse(lines.text).text).toContain(q1);expect((await s.read(0,{start_line:1,end_line:81})).isError).toBe(true);
  writeFileSync(path,q1+"x".repeat(16*1024-q1.length));const fragment=await s.read(0,{start_line:1,end_line:1});expect(fragment.isError).toBeUndefined();expect(Buffer.byteLength(JSON.parse(fragment.text).text)).toBe(16*1024);
  writeFileSync(path,q1+"\n"+"x".repeat(2*1024*1024-q1.length-1));const file=await s.read(0,{start_line:1,end_line:1});expect(file.isError).toBeUndefined();expect(JSON.parse(file.text).text).toBe(q1+"\n");
});
