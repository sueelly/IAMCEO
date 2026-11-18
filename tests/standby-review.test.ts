import { expect, test } from "bun:test";
import { checkCompletionReviews, latestCompletionReview, completionReviewAllowsDelivery } from "../server/task-completion.ts";
import { listAgentTools } from "../server/agent-tools.ts";
import { fixture } from "./fixtures/harness-fixture.ts";

const terms = { kind: "other" as const, goal: "인계 대조", scope: "지정 문서", inputs: ["요청"], outputs: ["검증 보고"],
  constraints: [], exclusions: [], acceptance: ["원문과 결과가 일치한다"], checks: [] };
function scenario() {
  const f = fixture(), primary = f.store.ensureFinalReviewer(f.project.id)!;
  const add = async (name: string) => {
    const task = f.orch.saveTask(f.lead, { title: name, contract: terms }).task;
    const report = await f.orch.recordPost(f.worker, { taskId: task.id, kind:"완료", title: name+" 대조", contractRev:1,
      checks:[{name:"대조",kind:"other",result:"pass",evidence:"원문과 결과를 대조했습니다",criterion:1}] });
    return {task_id:task.id, report_id:report.id};
  };
  const schedule = () => checkCompletionReviews(f.store, Date.now()+60000, 1000);
  const bind = (item:{task_id:string}) => f.store.requireDelivery(latestCompletionReview(f.store,item.task_id)!.delivery_id!);
  const fence = (id:string) => {
    f.store.db.query("UPDATE delivery_recovery SET phase='needs_owner',reason='complete_range_without_marker' WHERE delivery_id=?").run(id);
  };
  return {...f,primary,add,schedule,bind,fence};
}

test("a fresh standby takes disjoint new or provably unsubmitted reviews while the primary keeps its uncertain receipt",async()=>{
  const f=scenario();
  const old=await f.add("이전 계약"), oldest=f.schedule()[0]!;
  const queued=await f.add("제출 전 계약"), untouched=f.schedule()[0]!;
  expect(untouched.memberId).toBe(f.primary.id);
  const newest=await f.add("새 계약");
  f.fence(oldest.id);
  f.schedule();
  const standby=f.store.requireMember(f.bind(queued).memberId);
  expect(standby.id).not.toBe(f.primary.id);
  expect(standby).toMatchObject({finalReviewer:true,standbyReviewer:true});
  expect(f.store.getFinalReviewer(f.project.id)?.id).toBe(f.primary.id);
  expect(f.bind(old).id).toBe(oldest.id);
  expect(f.store.getDeliveryRecovery(oldest.id)?.phase).toBe("needs_owner");
  expect(f.bind(newest).memberId).toBe(standby.id);
  expect(f.store.requireDelivery(untouched.id).status).toBe("failed");
  expect(completionReviewAllowsDelivery(f.store,untouched)).toBe(false);
  expect(listAgentTools(standby).map(x=>x.name)).toEqual(listAgentTools(f.primary).map(x=>x.name));
  for (const [actor,forbidden] of [[standby,old],[f.primary,queued]] as const){
    expect((await f.tool(actor,"task_review_evidence",forbidden)).isError).toBe(true);
    expect((await f.tool(actor,"post",{report_id:forbidden.report_id})).isError).toBe(true);
    expect((await f.tool(actor,"task_trace",{task_id:forbidden.task_id})).isError).toBe(true);
    expect((await f.tool(actor,"task_review",{...forbidden,result:"changes_requested",evidence:"검수 확인",repair_title:"오류 수정"})).isError).toBe(true);
  }
  f.store.db.query("UPDATE delivery_recovery SET phase='resolved' WHERE delivery_id=?").run(oldest.id);
  f.schedule();
  expect(f.bind(queued).memberId).toBe(standby.id);
  const read=await f.tool(standby,"task_review_evidence",queued);
  expect(read.isError,read.text).toBeUndefined();
  const verdict={...queued,result:"confirmed",evidence:"지정 문서의 근거 확인"};
  expect((await f.tool(standby,"task_review",verdict)).isError).toBeUndefined();
  expect((await f.tool(standby,"task_review",verdict)).isError).toBeUndefined();
  expect(f.store.listMembers(f.project.id).filter(m=>m.finalReviewer)).toHaveLength(2);
});

test("if both review sessions are fenced, no third employee or duplicate transfer is created",async()=>{
  const f=scenario(), first=await f.add("기본 담당");
  f.schedule(); f.fence(f.bind(first).id);
  const second=await f.add("예비 담당");
  f.schedule(); const standbyDelivery=f.bind(second);
  expect(standbyDelivery.memberId).not.toBe(f.primary.id);
  f.fence(standbyDelivery.id);
  const third=await f.add("두 보류 뒤의 계약");
  const attention=f.schedule();
  expect(attention.filter(d=>d.memberId===f.lead.id)).toHaveLength(1);
  expect(f.schedule()).toHaveLength(0);
  expect(f.store.listMembers(f.project.id).filter(m=>m.finalReviewer)).toHaveLength(2);
  expect(latestCompletionReview(f.store,third.task_id)?.delivery_id).toBeNull();
  expect(f.bind(second).id).toBe(standbyDelivery.id);
});

test("two queued primary batches move immediately without charging another attempt, while a related case stays primary",async()=>{
  const f=scenario();
  const old=await f.add("원 검수"), prior=f.schedule()[0]!;
  const first=[];
  for(let i=0;i<8;i++) first.push(await f.add("첫 묶음 "+i));
  const batch1=f.schedule()[0]!;
  const last=await f.add("둘째 묶음"), related=await f.add("원 검수의 파생");
  const batch2=f.schedule()[0]!;
  // Existing task lineage from a restored queue, before any transport write.
  f.store.db.query("UPDATE tasks SET parent_task_id=? WHERE id=?").run(old.task_id,related.task_id);
  f.fence(prior.id);
  f.schedule();
  const moved=[...first,last], standby=f.bind(first[0]!).memberId;
  expect(standby).not.toBe(f.primary.id);
  for(const c of moved) {
    expect(f.bind(c).memberId).toBe(standby);
    expect(latestCompletionReview(f.store,c.task_id)?.review_dispatch_count).toBe(1);
  }
  const retained=f.bind(related);
  expect(retained.memberId).toBe(f.primary.id);
  expect(retained.id).not.toBe(batch2.id);
  expect(retained.text).not.toContain(last.report_id);
  expect(f.bind(last).text).not.toContain(related.report_id);
  expect(f.store.requireDelivery(batch1.id).status).toBe("failed");
  expect(f.store.requireDelivery(batch2.id).status).toBe("failed");
  expect(f.bind(old).id).toBe(prior.id);
  expect(f.schedule()).toHaveLength(0);
});

test("a fenced standby returns untouched independent batches to a recovered primary and keeps its own protected family",async()=>{
  const f=scenario(), old=await f.add("원 담당 확인");
  f.schedule(); f.fence(f.bind(old).id);
  const risky=await f.add("예비 담당 확인");
  f.schedule(); const risk=f.bind(risky);
  const waiting=await f.add("예비 미제출");
  f.schedule(); const unsent=f.bind(waiting);
  expect(unsent.memberId).toBe(risk.memberId);
  f.fence(risk.id);
  f.store.db.query("UPDATE delivery_recovery SET phase='resolved' WHERE delivery_id=?").run(f.bind(old).id);
  const related=await f.add("예비 수신 불명 업무의 파생");
  f.store.db.query("UPDATE tasks SET parent_task_id=? WHERE id=?").run(risky.task_id,related.task_id);
  const fresh=await f.add("별도 입고 검증");
  f.schedule();
  expect(f.bind(waiting).memberId).toBe(f.primary.id);
  expect(f.bind(fresh).memberId).toBe(f.primary.id);
  expect(f.bind(risky).id).toBe(risk.id);
  expect(latestCompletionReview(f.store,related.task_id)?.delivery_id).toBeNull();
  expect(f.store.requireDelivery(unsent.id).status).toBe("failed");
  expect((await f.tool(f.primary,"task_review_evidence",related)).isError).toBe(true);
});

test("a migrated zero-count current queue cannot erase prior delivery of that same review",async()=>{
  const f=scenario(), hold=await f.add("원 수신 미확인"), blocked=f.schedule()[0]!;
  const legacy=await f.add("과거 확인 요청"), prior=f.schedule()[0]!;
  f.store.markDelivered(prior.id);
  const queued=f.store.enqueue({projectId:f.project.id,memberId:f.primary.id,taskId:legacy.task_id,kind:"system",text:prior.text,wake:true});
  f.store.db.query("UPDATE task_completion_reviews SET delivery_id=?,review_dispatch_count=0 WHERE task_id=? AND report_id=?")
    .run(queued.id,legacy.task_id,legacy.report_id);
  f.fence(blocked.id);
  f.schedule();
  expect(f.bind(legacy).id).toBe(queued.id);
  expect(f.store.requireDelivery(prior.id).status).toBe("delivered");
  expect(f.store.listMembers(f.project.id).filter(m=>m.standbyReviewer)).toHaveLength(0);
  expect(f.bind(hold).id).toBe(blocked.id);
});
