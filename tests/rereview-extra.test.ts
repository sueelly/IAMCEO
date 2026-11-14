import {afterAll,expect,test} from "bun:test";
import {mkdirSync,writeFileSync} from "node:fs";
import {dirname,join} from "node:path";
import {fixture} from "./fixtures/harness-fixture.ts";
import {transcriptPath} from "../server/runner/transcript.ts";
const observations:any[]=[];
afterAll(()=>{const p=join(import.meta.dir,"../.pumasi/independent/rereview-extra-observations.json");mkdirSync(dirname(p),{recursive:true});writeFileSync(p,JSON.stringify({syntheticOnly:true,liveDiagnosisExecuted:false,observations},null,2));});
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

const completion=(s:any,kind:string,fields:any={})=>({type:"event_msg",timestamp:s.at,payload:{type:kind,thread_id:s.member.sessionId,item:{id:"FAKE_SHARED_ITEM",type:"CommandExecution",command:["git","rev-parse","HEAD"],cwd:s.member.cwd,status:kind==="item_started"?"in_progress":"completed",...(kind==="item_completed"?{exit_code:0}:{}),...fields}}});
test("D1 잔존: CommandExecution 시작/결과의 명령이 다르면 확정 짝을 표시하지 않는다",async()=>{
 const s=await setup();const d=await s.query("command-item-conflicting-command",[completion(s,"item_started",{command:["printf","other"]}),completion(s,"item_completed")]);
 expect(d.events.candidates[0]).toMatchObject({pair:"ambiguous",identityAmbiguous:true});
});
test("D1 잔존: CommandExecution 시작/결과의 위치가 다르면 확정 짝을 표시하지 않는다",async()=>{
 const s=await setup();const d=await s.query("command-item-conflicting-cwd",[completion(s,"item_started",{cwd:"/fake/other"}),completion(s,"item_completed")]);
 expect(d.events.candidates[0]).toMatchObject({pair:"ambiguous",identityAmbiguous:true});
});
test("D1 잔존: CommandExecution 결과 뒤 시작은 정상 결합으로 소급하지 않는다",async()=>{
 const s=await setup();const d=await s.query("command-item-end-before-start",[completion(s,"item_completed"),completion(s,"item_started")]);
 expect(d.events.candidates[0].pair).toBe("ambiguous");
});
test("D1 정상: CommandExecution 실제 시작과 같은 결과의 짝을 보존한다",async()=>{
 const s=await setup();const d=await s.query("command-item-valid-pair",[completion(s,"item_started"),completion(s,"item_completed")]);
 expect(d.events.candidates[0]).toMatchObject({pair:"paired",identityAmbiguous:false,parsedExit:0,inCurrentParser:true});
 expect(JSON.stringify(d)).not.toContain('"origin"');expect(JSON.stringify(d)).not.toContain('"rawRef"');
});
test("범위 관찰:256은 숫자 관찰에서 invalid이며 파서 표시에도 진단 범위가 적용된다",async()=>{
 const s=await setup();const row=completion(s,"item_completed",{exit_code:256,status:"failed"});
 const d=await s.query("out-of-diagnostic-range",[row]);
 const {parseCodexLog}=await import("../server/harness-evidence.ts");
 expect(parseCodexLog(JSON.stringify(row),null).execs[0].exitCode).toBe(256);
 expect(d.events.candidates[0]).toMatchObject({numericExit:null,numericObservation:{status:"invalid",invalidCount:1},parsedExit:null,inCurrentParser:true});
 expect(d.comparison.status).toBe("not_passed");
});
