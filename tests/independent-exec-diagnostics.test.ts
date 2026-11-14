import {afterAll,expect,test} from "bun:test";
import {mkdirSync,writeFileSync} from "node:fs";
import {dirname,join} from "node:path";
import {fixture} from "./fixtures/harness-fixture.ts";
import {transcriptPath} from "../server/runner/transcript.ts";
const observations:any[]=[];
afterAll(()=>{const p=join(import.meta.dir,"../.pumasi/independent/observations.json");mkdirSync(dirname(p),{recursive:true});writeFileSync(p,JSON.stringify({syntheticOnly:true,liveDiagnosisExecuted:false,observations},null,2));});
const id=(r:any,p="tk")=>r.text.match(new RegExp("#("+p+"_[\\w-]+)"))![1];
const wanted="git rev-parse HEAD";
async function setup(cli:"codex"|"claude"="codex"){
 const f=fixture(), member=f.make("diagnosed","가짜 대상","worker",cli);
 const task=id(await f.tool(f.lead,"task",{title:"독립 관찰 대조",contract:{kind:"coding",goal:"관찰 정확성",acceptance:["관찰한 것만 반환"],checks:["behavior"]}}));
 const posted=await f.tool(member,"post",{task_id:task,kind:"막힘",title:"가짜 실패 검사",contract_rev:1,checks:[{kind:"behavior",result:"fail",name:"실행",command:wanted,evidence:"대조불가",criterion:1}]});
 const report=id(posted,"msg"), args={task_id:task,report_id:report,check_index:0};
 const file=cli==="codex"?join(f.isolated.paths.codexHome,"sessions/fake/rollout-one.jsonl"):transcriptPath(member.cwd,member.sessionId!,f.isolated.paths.claudeHome);
 const at=new Date(Date.now()+5).toISOString();
 const meta={type:"session_meta",timestamp:at,payload:{id:member.sessionId,cwd:member.cwd}};
 const event=(type:string,command:any,extra:any={})=>({type:"event_msg",timestamp:at,payload:{type,call_id:"FAKE_DUPLICATE_CALL",command,cwd:member.cwd,...extra}});
 const query=async(label:string,rows:any[])=>{mkdirSync(dirname(file),{recursive:true});writeFileSync(file,[...(cli==="codex"?[meta]:[]),...rows].map(r=>JSON.stringify(r)).join("\n")+"\n");const response=await f.tool(member,"exec_diagnose",args);expect(response.isError).toBeUndefined();const data=JSON.parse(response.text);observations.push({label,args,rows,response,data});return data;};
 return {...f,member,at,event,query};
}
test("D1 최소 반례: begin 없는 exec_command_end를 paired로 꾸미지 않는다",async()=>{
 const s=await setup();const d=await s.query("end-only",[s.event("exec_command_end",["git","rev-parse","HEAD"],{exit_code:0})]);
 expect(d.events.candidates[0].pair).not.toBe("paired");
});
test("D1 정상군: 실제 begin과 end가 같은 호출이면 paired를 보존한다",async()=>{
 const s=await setup();const d=await s.query("begin-and-end",[s.event("exec_command_begin",["git","rev-parse","HEAD"]),s.event("exec_command_end",undefined,{exit_code:0})]);
 expect(d.events.candidates[0]).toMatchObject({pair:"paired",commandMatch:true,parserSupported:false,parsedExit:null});
});
test("D1 중복 반례: 다른 명령의 중복 begin에 원 명령 결과를 붙이지 않는다",async()=>{
 const s=await setup();const d=await s.query("conflicting-duplicate-begin",[
 s.event("exec_command_begin",["git","rev-parse","HEAD"]),
 s.event("exec_command_begin",["printf","different-command"]),
 s.event("exec_command_end",undefined,{exit_code:1})
 ]);
 expect(d.events.candidates.some((c:any)=>c.commandMatch===true&&c.pair==="paired")).toBe(false);
});
test("D1 정상군: 다른 ID의 결과는 대상 호출 결과로 붙이지 않는다",async()=>{
 const s=await setup();const end=s.event("exec_command_end",undefined,{exit_code:0});end.payload.call_id="FAKE_OTHER_CALL";
 const d=await s.query("different-ids",[s.event("exec_command_begin",["git","rev-parse","HEAD"]),end]);
 expect(d.events.candidates[0].pair).toBe("missing_result");expect(d.events.orphanResults).toBe(1);
});
test("D2 최소 반례: 계약 전 중복 ID에 현재 파서 포함 표시를 빌려주지 않는다",async()=>{
 const s=await setup();
 const row=(timestamp:string)=>({type:"event_msg",timestamp,payload:{type:"item_completed",thread_id:s.member.sessionId,item:{id:"FAKE_DUPLICATE",type:"CommandExecution",command:["git","rev-parse","HEAD"],cwd:s.member.cwd,status:"completed",exit_code:0}}});
 const d=await s.query("same-id-across-contract",[row(s.at),row("2000-01-01T00:00:00Z")]);
 expect(d.events.candidates[0].contractTime).toBe("before");
 expect(d.events.candidates[0].inCurrentParser).toBe(false);
});
test("D3 최소 반례: Claude 충돌 숫자를 종료0 하나로 요약하지 않는다",async()=>{
 const s=await setup("claude");
 const rows=[{type:"assistant",timestamp:s.at,cwd:s.member.cwd,message:{content:[{type:"tool_use",id:"FAKE_CALL",name:"Bash",input:{command:wanted}}]}},
 {type:"user",timestamp:s.at,message:{content:[{type:"tool_result",tool_use_id:"FAKE_CALL",is_error:false,content:""}]},toolUseResult:{stdout:"",stderr:"",interrupted:false,exitCode:0,exit_code:1}}];
 const d=await s.query("conflicting-numeric-fields",rows);
 expect(d.events.candidates[0].parsedExit).toBeNull();
 expect(d.events.candidates[0].numericExit).not.toBe(0);
});
test("D3 정상군: Claude 단일 숫자0과 구조 추정을 구별해서 보존한다",async()=>{
 const s=await setup("claude");
 const rows=[{type:"assistant",timestamp:s.at,cwd:s.member.cwd,message:{content:[{type:"tool_use",id:"FAKE_CALL",name:"Bash",input:{command:wanted}}]}},
 {type:"user",timestamp:s.at,message:{content:[{type:"tool_result",tool_use_id:"FAKE_CALL",is_error:false,content:""}]},toolUseResult:{stdout:"",stderr:"",interrupted:false,exitCode:0}}];
 const d=await s.query("single-numeric-zero",rows);
 expect(d.events.candidates[0]).toMatchObject({numericExit:0,parsedExit:0});
});
