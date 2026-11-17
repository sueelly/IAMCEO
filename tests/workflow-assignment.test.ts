import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { fixture } from "./fixtures/harness-fixture.ts";
import { previewWorkflowAssignment, commitWorkflowAssignment } from "../server/workflow-assignment.ts";
import { Store } from "../server/store.ts";
import { Bus } from "../server/bus.ts";
import { startServer } from "../server/http.ts";

function setup() {
  const f = fixture();
  const task = f.store.ensureSourceTask({ projectId: f.project.id, sourceRef: randomUUID(), title: "연결 집중 보기", origin: "owner" }).task;
  const source = f.store.createMessage({ projectId: f.project.id, taskId: task.id, mine: true, who: "대표", kind: "나", title: "", body: "관련 업무만 표시하고 기존 승인을 유지하세요" });
  f.store.saveTaskContract(task.id, { kind: "coding", goal: "연결된 업무만 표시", acceptance: ["관계 없는 노드는 숨긴다"], scope: "웹", forbidden: ["승인 자동 응답 금지"], evidence: ["브라우저 검사"] }, { author: "대표", authorKind: "owner", authorMemberId: null, sourceMessageId: source.id });
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
