import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { fixture } from "./fixtures/harness-fixture.ts";
import { previewWorkflowAssignment, commitWorkflowAssignment, workflowHandoffText } from "../server/workflow-assignment.ts";
import { Store } from "../server/store.ts";
import { Bus } from "../server/bus.ts";
import { startServer } from "../server/http.ts";
import { TaskContinuationCoordinator } from "../server/task-continuation.ts";

function setup() {
  const f = fixture();
  for (const member of [f.worker, f.worker2, f.lead]) f.store.patchMember(member.id, { statusObservation: { source:"core", observedAt:new Date().toISOString(), freshness:"fresh", ownership:"verified", consecutiveFailures:0, error:null } });
  const task = f.store.ensureSourceTask({ projectId: f.project.id, sourceRef: randomUUID(), title: "연결 집중 보기", origin: "owner" }).task;
  const source = f.store.createMessage({ projectId: f.project.id, taskId: task.id, mine: true, who: "대표", kind: "나", title: "", body: "관련 업무만 표시하고 기존 승인을 유지하세요" });
  f.store.saveTaskContract(task.id, { kind: "coding", goal: "연결된 업무만 표시", acceptance: ["관계 없는 노드는 숨긴다"], scope: "웹", inputs: ["업무 관계 기록"], outputs: ["연결 업무 화면"], constraints: ["기존 승인을 보존한다"], exclusions: ["승인 자동 응답"], forbidden: ["승인 자동 응답 금지"], evidence: ["브라우저 검사"] }, { author: "대표", authorKind: "owner", authorMemberId: null, sourceMessageId: source.id });
  const preview = () => previewWorkflowAssignment(f.store, f.project.id, task.id, f.worker.id);
  const request = () => ({ operationId: randomUUID(), memberId: f.worker.id, revision: preview().revision });
  return { ...f, task, source, preview, request };
}

test("preview includes old original instructions and confirmed constraints without execution", () => {
  const f = setup();
  for (let i=0;i<65;i++) f.store.createMessage({ projectId: f.project.id, taskId: f.task.id, mine: false, who: "직원", kind: "진행", title: `보고 ${i}`, body: "검사 중" });
  const before = f.store.listDeliveries();
  const p = f.preview();
  expect(p.blockers).toEqual([]);
  expect(p.originals.some(m=>m.id===f.source.id && m.body===f.source.body)).toBe(true);
  expect(p.contract?.forbidden).toContain("승인 자동 응답 금지");
  expect(p.omitted.reports).toBe(55);
  expect(f.store.listDeliveries()).toEqual(before);
  expect(f.runner.sent).toHaveLength(0);
});

test("same operation survives a new Store and never queues twice; a different request conflicts", () => {
  const f = setup(), req = f.request();
  const first = commitWorkflowAssignment(f.store, f.project.id, f.task.id, req);
  const reopened = new Store(f.store.db, new Bus());
  expect(commitWorkflowAssignment(reopened, f.project.id, f.task.id, req)).toEqual(first);
  expect(f.store.listDeliveries().filter(d=>d.taskId===f.task.id)).toHaveLength(1);
  expect(()=>commitWorkflowAssignment(f.store, f.project.id, f.task.id, {...req, memberId:f.worker2.id})).toThrow();
  expect(()=>commitWorkflowAssignment(f.store, f.project.id, f.task.id, {...req,operationId:randomUUID()})).toThrow();
  const text = f.store.requireDelivery(first.deliveryId).text;
  expect(text).toContain(f.source.id);expect(text).toContain(f.task.id);expect(text).toContain("승인 자동 응답 금지");
  expect(text).toContain("계약 r1");expect(f.store.getTaskContract(f.task.id)?.rev).toBe(1);
});

test.each(["contract","queue","generation","original"])("review conflicts when %s changes before confirmation", change => {
  const f = setup(), req = f.request();
  if(change==="contract") f.store.saveTaskContract(f.task.id,{kind:"coding",goal:"바뀐 조건",acceptance:["새 검증"]},{author:"대표",authorKind:"owner",authorMemberId:null});
  if(change==="queue") f.store.enqueue({projectId:f.project.id,memberId:f.worker.id,kind:"instruction",text:"다른 업무",taskId:null});
  if(change==="generation") f.store.db.query("UPDATE members SET session_generation=session_generation+1 WHERE id=?").run(f.worker.id);
  if(change==="original") f.store.createMessage({projectId:f.project.id,taskId:f.task.id,mine:true,who:"대표",kind:"나",title:"",body:"추가 제한"});
  expect(()=>commitWorkflowAssignment(f.store,f.project.id,f.task.id,req)).toThrow();
  expect(f.store.listDeliveries().filter(d=>d.taskId===f.task.id)).toHaveLength(0);
});

test.each(["proposal","held","stopped","assigned","done","archived","manual","offline","loop","hold","unknown"])("%s cannot be bypassed by assigning the task", condition => {
  const f=setup();
  if(condition==="proposal"){f.store.db.query("DELETE FROM task_contracts WHERE task_id=?").run(f.task.id);f.store.saveTaskContract(f.task.id,{kind:"coding",goal:"제안",acceptance:["검토 필요"]},{author:f.worker.name,authorKind:"worker",authorMemberId:f.worker.id});}
  if(["held","stopped","assigned"].includes(condition)){
    const d=f.store.enqueue({projectId:f.project.id,memberId:f.worker2.id,taskId:f.task.id,kind:"instruction",text:"기존 입력",status:condition==="held"?"held":"queued",holdReason:condition==="held"?"delivery_unknown":null});
    if(condition==="stopped")f.store.db.query("UPDATE delivery_recovery SET phase='stopped' WHERE delivery_id=?").run(d.id);
  }
  if(condition==="done")f.store.addStageMark({projectId:f.project.id,taskId:f.task.id,stage:"done",evidence:"완료 확인",who:f.lead.name,memberId:f.lead.id});
  if(condition==="archived")f.store.patchProject(f.project.id,{archived:true});
  if(condition==="manual")f.store.patchMember(f.worker.id,{origin:"manual"});
  if(condition==="offline")f.store.patchMember(f.worker.id,{status:"offline"});
  if(condition==="unknown")f.store.patchMember(f.worker.id,{status:"blocked",blockedReason:"status_unknown"});
  if(condition==="hold")f.store.addStageMark({projectId:f.project.id,taskId:f.task.id,stage:"hold",evidence:"대표 확인 뒤 재개",who:f.lead.name,memberId:f.lead.id});
  if(condition==="loop"){const at=new Date().toISOString();f.store.saveTaskWatch(f.project.id,f.task.id,{startedAt:at,attempts:3,same:3,fingerprint:"repeat",lastProgressAt:at,trippedAt:at,reason:"반복 실패",history:[],updatedAt:at});}
  const p=f.preview(), before=f.store.listDeliveries();
  expect(p.blockers.length).toBeGreaterThan(0);
  expect(()=>commitWorkflowAssignment(f.store,f.project.id,f.task.id,{operationId:randomUUID(),memberId:f.worker.id,revision:p.revision})).toThrow();
  expect(f.store.listDeliveries()).toEqual(before);
});

test("foreign project references and task scope are rejected", () => {
  const f=setup(), other=f.store.createProject({name:"별도 프로젝트",cwd:f.project.cwd});
  const foreign=f.store.createMember({projectId:other.id,handle:"foreign",name:"다른 직원",kind:"worker"});
  expect(()=>previewWorkflowAssignment(f.store,f.project.id,f.task.id,foreign.id)).toThrow();
  expect(()=>previewWorkflowAssignment(f.store,other.id,f.task.id,f.worker.id)).toThrow();
  f.store.createMessage({projectId:other.id,mine:true,who:"대표",kind:"나",title:"",body:"다른 프로젝트 비공개 원문"});
  expect(JSON.stringify(f.preview())).not.toContain("다른 프로젝트 비공개 원문");
});

test("orchestrator sends the reviewed context through the existing runner once", async () => {
  const f=setup(),req=f.request();
  await f.orch.assignWorkflow(f.project.id,f.task.id,req);
  expect(f.runner.to(f.worker)).toHaveLength(1);
  expect(f.runner.to(f.worker)[0]).toContain(f.source.body);
  expect(f.runner.to(f.worker)[0]).toContain("승인 자동 응답 금지");
  await f.orch.assignWorkflow(f.project.id,f.task.id,req);
  expect(f.runner.to(f.worker)).toHaveLength(1);
});

test("transaction rollback removes both queued delivery and assignment evidence", () => {
  const f=setup(),req=f.request();
  f.store.db.exec("CREATE TEMP TRIGGER reject_assignment BEFORE INSERT ON workflow_assignment_receipts BEGIN SELECT RAISE(ABORT, 'fixture rejected receipt'); END");
  const before=f.store.listMessages(f.project.id).length;
  expect(()=>commitWorkflowAssignment(f.store,f.project.id,f.task.id,req)).toThrow("fixture rejected receipt");
  expect(f.store.listDeliveries().filter(d=>d.taskId===f.task.id)).toHaveLength(0);
  expect(f.store.listMessages(f.project.id)).toHaveLength(before);
});

test("authenticated HTTP preview and receipt are read-only; strict assignment saves once", async () => {
  const f=setup();
  // Keep the fake employee busy, so this test observes the queue without starting a turn.
  f.runner.busy.add(f.worker.id);
  const server=await startServer({config:f.config,store:f.store,bus:new Bus(),orch:f.orch});
  try{
    const path=`${server.urls[0]}/api/projects/${f.project.id}/workflow/tasks/${f.task.id}/assignment`;
    const headers={Authorization:`Bearer ${f.config.accessCode}`,"Content-Type":"application/json"};
    expect((await fetch(path+`?memberId=${f.worker.id}`)).status).toBe(401);
    const response=await fetch(path+`?memberId=${f.worker.id}`,{headers});expect(response.status).toBe(200);
    const p=await response.json();expect(f.runner.sent).toHaveLength(0);
    const req={operationId:randomUUID(),memberId:f.worker.id,revision:p.revision};
    expect((await fetch(path,{method:"POST",headers,body:JSON.stringify({...req,urgent:true})})).status).toBe(400);
    const posted=await fetch(path,{method:"POST",headers,body:JSON.stringify(req)});expect(posted.status).toBe(200);
    const result=await posted.json();
    const receipt=await fetch(`${server.urls[0]}/api/projects/${f.project.id}/workflow/assignments/${req.operationId}`,{headers});
    expect(await receipt.json()).toEqual(result);expect(f.runner.sent).toHaveLength(0);
  }finally{await server.stop()}
});

test("reviewed derived placement and prerequisites match the worker's committed queue", () => {
  const f=setup();
  const parent=f.store.ensureSourceTask({projectId:f.project.id,sourceRef:randomUUID(),title:"진행 중인 부모",origin:"owner"}).task;
  const other=f.store.ensureSourceTask({projectId:f.project.id,sourceRef:randomUUID(),title:"무관한 다음 업무",origin:"owner"}).task;
  const delivered=f.store.enqueue({projectId:f.project.id,memberId:f.worker.id,taskId:parent.id,kind:"instruction",text:"부모"});f.store.markDelivered(delivered.id);
  f.store.enqueue({projectId:f.project.id,memberId:f.worker.id,taskId:other.id,kind:"instruction",text:"다음"});
  f.store.db.query("UPDATE tasks SET parent_task_id=? WHERE id=?").run(parent.id,f.task.id);
  const p=f.preview();expect(p.position).toBe(2);expect(p.startCondition).not.toContain("앞선 업무 완료 후");
  commitWorkflowAssignment(f.store,f.project.id,f.task.id,{operationId:randomUUID(),memberId:f.worker.id,revision:p.revision});
  const row=f.store.projectWorkflow(f.project.id).nodes.filter(n=>n.memberId===f.worker.id);
  expect(row.map(n=>n.taskId)).toEqual([parent.id,f.task.id,other.id]);expect(f.store.taskSequenceBlocker(f.worker.id,f.task.id)).toBeNull();
});

test("conductor preview does not promise worker-style predecessor completion", () => {
  const f=setup(),other=f.store.ensureSourceTask({projectId:f.project.id,sourceRef:randomUUID(),title:"총괄의 앞선 업무",origin:"owner"}).task;
  f.store.enqueue({projectId:f.project.id,memberId:f.lead.id,taskId:other.id,kind:"instruction",text:"앞선 입력"});
  const p=previewWorkflowAssignment(f.store,f.project.id,f.task.id,f.lead.id);
  expect(p.startCondition).not.toContain("앞선 업무 완료 후");expect(p.startCondition).toContain("총괄");
});

test("structured failure and its correction survive newer routine reports and affect the review digest", () => {
  const f=setup();
  const parent=f.store.ensureSourceTask({projectId:f.project.id,sourceRef:randomUUID(),title:"검사했던 원래 업무",origin:"owner"}).task;
  f.store.db.query("UPDATE tasks SET parent_task_id=? WHERE id=?").run(parent.id,f.task.id);
  const failed=f.store.createMessage({projectId:f.project.id,taskId:parent.id,memberId:f.worker2.id,who:f.worker2.name,mine:false,kind:"막힘",title:"보완",body:""});
  f.store.recordReportChecks(failed,f.worker2,[{kind:"behavior",name:"중단 입력",result:"fail",command:"bun test stop-unique",evidence:"UNIQUE_LEFTOVER_INPUT",criterion:1}],{contractTaskId:f.task.id,contractRev:1,evidenceStatus:"missing",reviewNeeded:"실행 대조 필요"});
  const corrected=f.store.createMessage({projectId:f.project.id,taskId:parent.id,memberId:f.worker2.id,who:f.worker2.name,mine:false,kind:"막힘",title:"정정",body:"재현 조건을 정정합니다"});
  f.store.saveReportReferences(f.project.id,{sourceMessageId:corrected.id,fileIds:[],decisionIds:[],authoredAt:corrected.at,sequence:0,correctsMessageId:failed.id});
  for(let i=0;i<15;i++)f.store.createMessage({projectId:f.project.id,taskId:f.task.id,mine:false,who:"직원",kind:"진행",body:"계속 확인 중"});
  const p=f.preview(),text=workflowHandoffText(p);expect(p.blockers).toEqual([]);expect(JSON.stringify(p)).toContain("UNIQUE_LEFTOVER_INPUT");expect(text).toContain("bun test stop-unique");expect(text).toContain(corrected.id);expect(text).toContain(failed.id);expect(text).toContain("실행 대조 필요");
  f.store.db.query("UPDATE report_checks SET evidence=? WHERE message_id=?").run("CHANGED_FAILURE",failed.id);
  expect(()=>commitWorkflowAssignment(f.store,f.project.id,f.task.id,{operationId:randomUUID(),memberId:f.worker.id,revision:p.revision})).toThrow();
});

test.each(["missing","stale","expired","conflict"])("%s target observation cannot accept a reviewed assignment", condition => {
  const f=setup();const observation={source:"core" as const,observedAt:new Date().toISOString(),freshness:"fresh" as const,ownership:"verified" as const,consecutiveFailures:0,error:null};
  const req=f.request();
  f.store.patchMember(f.worker.id,{statusObservation:condition==="missing"?null:{...observation,...(condition==="stale"?{freshness:"stale" as const}:{}),...(condition==="expired"?{observedAt:new Date(Date.now()-91_000).toISOString()}:{}),...(condition==="conflict"?{ownership:"conflict" as const}:{})}});
  expect(f.preview().blockers.length).toBeGreaterThan(0);expect(()=>commitWorkflowAssignment(f.store,f.project.id,f.task.id,req)).toThrow();
  expect(f.store.listDeliveries().filter(d=>d.taskId===f.task.id)).toHaveLength(0);
});

test("a fresh verified heartbeat does not invalidate an unchanged review", () => {
  const f=setup(),p=f.preview();f.store.patchMember(f.worker.id,{statusObservation:{source:"core",observedAt:new Date().toISOString(),freshness:"fresh",ownership:"verified",consecutiveFailures:0,error:null}});
  expect(f.preview().revision).toBe(p.revision);
});

test("an inherited owner stop cannot be bypassed by assigning an unassigned child", () => {
  const f=setup(),parent=f.store.ensureSourceTask({projectId:f.project.id,sourceRef:randomUUID(),title:"중단된 부모",origin:"owner"}).task;
  f.store.db.query("UPDATE tasks SET parent_task_id=? WHERE id=?").run(parent.id,f.task.id);
  const req=f.request();new TaskContinuationCoordinator(f.store,{intervalMs:30_000,sameLimit:3}).pause([parent.id],"owner-stop","대표가 중단했습니다");
  expect(f.preview().blockers.some(b=>b.includes("중단"))).toBe(true);
  expect(()=>commitWorkflowAssignment(f.store,f.project.id,f.task.id,req)).toThrow();
  expect(f.store.listDeliveries().filter(d=>d.taskId===f.task.id)).toHaveLength(0);
});

test("report and board assignees are not treated as unassigned by the assignment API", () => {
  for(const evidence of ["report","board"]){
    const f=setup();
    if(evidence==="report")f.store.createMessage({projectId:f.project.id,taskId:f.task.id,memberId:f.worker2.id,who:f.worker2.name,mine:false,kind:"진행",body:"이 업무를 수행 중입니다"});
    else f.store.upsertWork({projectId:f.project.id,taskId:f.task.id,title:f.task.title,sec:"doing",who:f.worker2.name});
    const p=f.preview();expect(p.blockers.some(b=>b.includes("이미 배정"))).toBe(true);
    expect(()=>commitWorkflowAssignment(f.store,f.project.id,f.task.id,{operationId:randomUUID(),memberId:f.worker.id,revision:p.revision})).toThrow();
  }
});

test.each(["report", "board"])("a %s-only ancestor cannot invert the displayed execution order", evidence => {
  const f=setup(),parent=f.store.ensureSourceTask({projectId:f.project.id,sourceRef:randomUUID(),title:"기록으로 연결된 부모",origin:"owner"}).task;
  const child=f.store.ensureSourceTask({projectId:f.project.id,sourceRef:randomUUID(),title:"먼저 배정된 파생 업무",origin:"owner",parentTaskId:parent.id}).task;
  if(evidence==="report")f.store.createMessage({projectId:f.project.id,taskId:parent.id,memberId:f.worker.id,who:f.worker.name,mine:false,kind:"진행",body:"부모 업무 기록"});
  else f.store.upsertWork({projectId:f.project.id,taskId:parent.id,title:parent.title,sec:"doing",who:f.worker.name});
  f.store.enqueue({projectId:f.project.id,memberId:f.worker.id,taskId:child.id,kind:"instruction",text:"먼저 진행"});
  const preview=f.preview();
  expect(preview.startCondition).toContain(child.title);
  commitWorkflowAssignment(f.store,f.project.id,f.task.id,{operationId:randomUUID(),memberId:f.worker.id,revision:preview.revision});
  const row=f.store.projectWorkflow(f.project.id).nodes.filter(n=>n.memberId===f.worker.id&&n.state!=="done");
  expect(row.filter(n=>n.assignmentSource==="delivery").map(n=>n.taskId)).toEqual([child.id,f.task.id]);
  expect(row.find(n=>n.taskId===child.id)).toMatchObject({current:true,label:"전달 대기"});
  expect(row.find(n=>n.taskId===f.task.id)).toMatchObject({current:false,label:"선행 업무 대기"});
  expect(preview.position).toBe(row.findIndex(n=>n.taskId===f.task.id)+1);
  expect(f.store.taskSequenceBlocker(f.worker.id,child.id)).toBeNull();
  expect(f.store.taskSequenceBlocker(f.worker.id,f.task.id)?.taskId).toBe(child.id);
});

test("assignment preview counts unfinished historical deliveries that remain on the board", () => {
  const f=setup(),previous=f.store.ensureSourceTask({projectId:f.project.id,sourceRef:randomUUID(),title:"완료 확인이 남은 이전 입력",origin:"owner"}).task;
  const d=f.store.enqueue({projectId:f.project.id,memberId:f.worker.id,taskId:previous.id,kind:"instruction",text:"옛 지시"});
  f.store.markDelivered(d.id);f.store.db.query("DELETE FROM task_sequence WHERE task_id=?").run(previous.id);
  const preview=f.preview();
  commitWorkflowAssignment(f.store,f.project.id,f.task.id,{operationId:randomUUID(),memberId:f.worker.id,revision:preview.revision});
  const row=f.store.projectWorkflow(f.project.id).nodes.filter(n=>n.memberId===f.worker.id&&n.state!=="done");
  expect(preview.position).toBe(2);
  expect(preview.position).toBe(row.findIndex(n=>n.taskId===f.task.id)+1);
  expect(f.store.taskSequenceBlocker(f.worker.id,f.task.id)).toBeNull();
});


test("a failed descendant requires conductor intervention before assigning its parent from the workflow board", async () => {
  const f = setup();
  const reviewed = f.request();
  const child = f.store.saveTask({ projectId: f.project.id, memberId: f.lead.id, who: f.lead.name, title: "파생 검증", parentTaskId: f.task.id }).task;
  for (let i = 0; i < 3; i++) {
    expect((await f.tool(f.worker, "post", { task_id: child.id, kind: "막힘", title: `파생 검증 실패 ${i + 1}`, contract_rev: 1,
      checks: [{ kind: "behavior", name: "같은 파생 검증", result: "fail", evidence: "동일 조건 재현", criterion: 1 }] })).isError).toBeUndefined();
  }
  expect(f.store.pendingTaskFailureDecision(f.task.id)).toBeNull();
  const intervention = f.store.pendingTaskIntervention(f.task.id)!;
  expect(intervention).not.toBeNull();
  const preview = f.preview();
  expect(preview.revision).not.toBe(reviewed.revision);
  expect(() => commitWorkflowAssignment(f.store, f.project.id, f.task.id, reviewed)).toThrow();
  expect(preview.blockers.join(" ")).toContain(intervention.taskId);
  expect(() => commitWorkflowAssignment(f.store, f.project.id, f.task.id, { operationId: randomUUID(), memberId: f.worker.id, revision: preview.revision })).toThrow();
  expect(f.store.listTaskDeliveries(f.task.id).filter(d => d.memberId === f.worker.id)).toHaveLength(0);
});
