import { test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "../../../tests/fixtures/harness-fixture.ts";
import { listAgentTools } from "../../../server/agent-tools.ts";

test("synthetic designated review permits evidence and read-post while rejecting unauthorized roles and writes", async () => {
  const f = fixture();
  const reviewer = f.store.ensureFinalReviewer(f.project.id)!;
  const source = f.orch.saveTask(f.lead, { title: "합성 검수 대상", contract: {
    kind: "other", goal: "합성 문서 검증", scope: "이 fixture",
    inputs: ["합성 요청"], outputs: ["합성 결과"], constraints: [], exclusions: ["운영 조작"],
    acceptance: ["합성 결과의 근거를 읽을 수 있다"], checks: []
  }}).task;
  const report = await f.orch.recordPost(f.worker, { taskId: source.id, kind: "완료", title: "합성 근거",
    contractRev: 1, checks: [{name:"합성 대조",kind:"other",result:"pass",criterion:1,evidence:"합성 자료만 대조"}] });
  const tools = listAgentTools(reviewer);
  expect(tools.map(t => t.name).sort()).toEqual(["post","status","task_review","task_review_evidence","task_trace"].sort());
  expect(tools.every(t => !("annotations" in t))).toBe(true);
  const ordinaryRead = await f.tool(f.worker,"post",{report_id:report.id});
  const reviewerRead = await f.tool(reviewer,"post",{report_id:report.id});
  expect(ordinaryRead.isError).toBeUndefined(); expect(reviewerRead.isError).toBeUndefined();
  const before = f.store.db.query("SELECT evidence_reader_id FROM task_completion_reviews WHERE report_id=?").get(report.id) as {evidence_reader_id:string|null};
  expect(before.evidence_reader_id).toBeNull();
  const unauthorized = await f.tool(f.worker,"task_review_evidence",{task_id:source.id,report_id:report.id});
  expect(unauthorized.isError).toBe(true); expect(unauthorized.text).toContain("쓸 수 없는 도구");
  const noEvidenceDecision = await f.tool(reviewer,"task_review",{task_id:source.id,report_id:report.id,result:"confirmed",evidence:"아직 증거를 읽지 않은 합성 요청"});
  expect(noEvidenceDecision.isError).toBe(true);
  const evidence = await f.tool(reviewer,"task_review_evidence",{task_id:source.id,report_id:report.id});
  expect(evidence.isError,evidence.text).toBeUndefined();
  const after = f.store.db.query("SELECT evidence_reader_id FROM task_completion_reviews WHERE report_id=?").get(report.id) as {evidence_reader_id:string|null};
  expect(after.evidence_reader_id).toBe(reviewer.id);
  const wrongTarget = await f.tool(reviewer,"task_review_evidence",{task_id:source.id,report_id:"msg_nonexistent_fixture"});
  expect(wrongTarget.isError).toBe(true);
  const beforePosts = f.store.listMessages(f.project.id).length;
  const forbiddenPost = await f.tool(reviewer,"post",{task_id:source.id,kind:"알림",title:"허용되지 않는 합성 보고",body:"금지 경계"});
  expect(forbiddenPost.isError).toBe(true);
  expect(forbiddenPost.text).toContain("최종 검수 직원은 보고를 조회하거나 task_review로");
  expect(f.store.listMessages(f.project.id).length).toBe(beforePosts);
  const forbiddenFile = await f.tool(reviewer,"file",{task_id:source.id,title:"금지",content:"쓰지 않음"});
  expect(forbiddenFile.isError).toBe(true); expect(forbiddenFile.text).toContain("쓸 수 없는 도구");
  const validDecision = await f.tool(reviewer,"task_review",{task_id:source.id,report_id:report.id,result:"confirmed",evidence:"격리된 합성 계약·근거만 검토했습니다"});
  expect(validDecision.isError,validDecision.text).toBeUndefined();
  const humanTask = f.orch.saveTask(f.lead, { title: "합성 사람 승인 보호", contract: {
    kind: "other", goal: "사람 판단 보존", scope: "이 fixture", inputs: ["합성 요청"],
    outputs: ["보호 확인"], constraints: [], exclusions: ["운영 조작"], acceptance: ["사람 판단은 열려 있다"], checks: []
  }}).task;
  const humanReport = await f.orch.recordPost(f.worker, { taskId: humanTask.id, kind: "완료", title: "합성 납품",
    contractRev: 1, checks: [{name:"합성 확인",kind:"other",result:"pass",criterion:1,evidence:"격리 대조"}] });
  const readBeforeDecision = await f.tool(reviewer,"task_review_evidence",{task_id:humanTask.id,report_id:humanReport.id});
  expect(readBeforeDecision.isError).toBeUndefined();
  const decision = f.store.createDecision({projectId:f.project.id,taskId:humanTask.id,memberId:f.worker.id,who:f.worker.name,title:"합성 사람 판단 필요"});
  const blockedHumanReview = await f.tool(reviewer,"task_review",{task_id:humanTask.id,report_id:humanReport.id,result:"confirmed",evidence:"열린 사람 결재를 넘을 수 없어야 함"});
  expect(blockedHumanReview.isError).toBe(true);
  expect(f.store.listOpenDecisions(f.project.id).some(d=>d.id===decision.id)).toBe(true);
  const result = {
    syntheticOnly:true, tools:tools.map(t=>t.name), annotationsPresent:false,
    ordinaryPostRead:{ok:!ordinaryRead.isError}, designatedPostRead:{ok:!reviewerRead.isError},
    unauthorizedEvidence:{error:unauthorized.text}, missingEvidenceDecision:{error:noEvidenceDecision.text},
    designatedEvidence:{ok:!evidence.isError,evidenceReaderUpdated:true},
    wrongTarget:{error:wrongTarget.text}, forbiddenPost:{error:forbiddenPost.text,noNewPosts:true},
    forbiddenFile:{error:forbiddenFile.text}, designatedDecision:{ok:!validDecision.isError},
    humanApproval:{reviewDenied:!!blockedHumanReview.isError,decisionStillOpen:true,error:blockedHumanReview.text},
    liveCalls:0
  };
  writeFileSync(join(import.meta.dir,"synthetic-server-results.json"),JSON.stringify(result,null,2)+"\n");
});
