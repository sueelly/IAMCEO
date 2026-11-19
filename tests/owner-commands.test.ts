import { afterEach, expect, test } from "bun:test";
import { Bus } from "../server/bus.ts";
import { openDb } from "../server/db.ts";
import { Store } from "../server/store.ts";
import { ownerCommandItem, ownerCommandPage } from "../server/owner-commands.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });
function fixture() {
  const db = openDb(":memory:"), store = new Store(db, new Bus());
  cleanups.push(() => db.close());
  const project = store.createProject({ name: "대표 업무", cwd: "/tmp" });
  const staff = (handle: string) => store.createMember({ projectId: project.id, handle, name: handle, kind: "worker", status: "idle", backend: "core", paneId: "pane-" + handle, sessionId: "session-" + handle });
  const worker = staff("worker");
  const message = (body: string) => store.createMessage({ projectId: project.id, mine: true, kind: "나", body });
  function order(body: string) {
    const msg = message(body);
    store.registerOwnerCommand(msg.id);
    return msg;
  }
  function receive(member: typeof worker, deliveryIds: string[]) {
    const at = new Date().toISOString();
    for (const id of deliveryIds) store.setDeliveryStatus(id, "delivered");
    const run = { runId: crypto.randomUUID(), projectId: project.id, memberId: member.id,
      identity: { terminalId: member.paneId, sessionId: member.sessionId, sessionGeneration: 0, process: null },
      deliveryIds, turn: 1, phase: "running" as const, createdAt: at, updatedAt: at, inputReceivedAt: at, startedAt: at, lastProgressAt: null,
      endedAt: null, result: null, reason: null, exitCode: null, interruptionNotifiedAt: null, reportRequestedAt: null };
    store.saveExecutionJournal(run);
    return run;
  }
  const input = (member: typeof worker, refId: string) => store.enqueue({ projectId: project.id, memberId: member.id, kind: "user_message", text: "요청", refType: "message", refId });
  function report(member: typeof worker, kind: "답변" | "막힘" | "완료", corrects?: string, files: string[] = [], taskId?: string) {
    const msg = store.createMessage({ projectId: project.id, memberId: member.id, kind, title: kind + " 결과", taskId });
    store.saveReportReferences(project.id, { sourceMessageId: msg.id, fileIds: files, decisionIds: [], authoredAt: msg.at, sequence: 1, correctsMessageId: corrects ?? null });
    return msg;
  }
  return { store, project, staff, worker, message, order, input, receive, report };
}
test("one command follows its delivered delegation, decision, report, files and correction", () => {
  const f = fixture(), w = f.staff("assignee"), cmd = f.order("결과를 찾아줘");
  f.receive(f.worker, [f.input(f.worker, cmd.id).id]);
  const assigned = f.store.enqueue({ projectId: f.project.id, memberId: w.id, kind: "instruction", text: "결과 확인" });
  f.store.noteDelegation(f.worker.id, assigned, false);
  f.receive(w, [assigned.id]);
  const file = f.store.createFile({ projectId: f.project.id, memberId: w.id, title: "검사 결과", kind: "document", body: "비목록 본문" });
  const msg = f.report(w, "답변", undefined, [file.id]);
  expect(ownerCommandItem(f.store, f.project.id, cmd.id)).toMatchObject({ kind: "command", stage: "result", result: { messageId: msg.id, fileIds: [file.id] } });
  const decision = f.store.createDecision({ projectId: f.project.id, memberId: w.id, who: w.name, title: "경로 선택" });
  f.store.recordReportClosure({ memberId: w.id, kind: "question", refType: "decision", refId: decision.id });
  expect(ownerCommandItem(f.store, f.project.id, cmd.id)).toMatchObject({ stage: "owner", questions: [{ id: decision.id, kind: "decision" }] });
  f.store.db.query("UPDATE decisions SET status='closed' WHERE id=?").run(decision.id);
  const fixed = f.report(w, "막힘", msg.id);
  expect(ownerCommandItem(f.store, f.project.id, cmd.id)).toMatchObject({ stage: "waiting", result: { messageId: fixed.id }, questions: [] });
});
test("mixed commands, unrelated unregistered input and unreceived runs never claim a specific result", () => {
  for (const mode of ["mixed", "passive", "unregistered", "unreceived"]) {
    const f = fixture(), a = f.order("첫 명령"), b = mode === "unregistered" ? f.message("예전 입력") : f.order("둘째 명령");
    const run = f.receive(f.worker, mode === "unreceived" ? [f.input(f.worker, a.id).id] : [f.input(f.worker, a.id).id, f.input(f.worker, b.id).id]);
    if (mode === "passive") f.store.db.query("UPDATE deliveries SET wake=0 WHERE id=?").run(run.deliveryIds[1]!);
    if (mode === "unreceived") f.store.saveExecutionJournal({ ...run, phase: "starting", inputReceivedAt: null, startedAt: null, turn: null });
    f.report(f.worker, "답변");
    expect(ownerCommandItem(f.store, f.project.id, a.id).result).toBeNull();
    if (mode === "mixed") expect(ownerCommandItem(f.store, f.project.id, b.id).result).toBeNull();
  }
});
test("project-scoped commands use a stable cursor, exclude casual chat and reject cross-project reads", () => {
  const f = fixture(); f.message("일반 대화");
  const older = f.order("첫 명령"), newer = f.order("둘째 명령");
  const other = f.store.createProject({ name: "다른 곳", cwd: "/tmp" });
  const page = ownerCommandPage(f.store, f.project.id, 1);
  expect(page.items.map(x => x.id)).toEqual([newer.id]);
  expect(ownerCommandPage(f.store, f.project.id, 1, page.nextCursor!).items.map(x => x.id)).toEqual([older.id]);
  expect(() => ownerCommandPage(f.store, other.id, 1, page.nextCursor!)).toThrow();
  expect(() => ownerCommandItem(f.store, other.id, newer.id)).toThrow();
  expect(ownerCommandPage(f.store, other.id, 20).items).toEqual([]);
});

test("an explicit status response answers only its original command independently of the task", () => {
  const f = fixture(), command = f.order("현재 상태"), other = f.order("두 번째");
  const msg = f.store.createMessage({ projectId: f.project.id, kind: "답변", title: "검수 2건 대기", aboutMessageId: command.id });
  expect(() => f.store.recordOwnerCommandAnswer(other.id, msg.id)).toThrow();
  f.store.recordOwnerCommandAnswer(command.id, msg.id);
  expect(ownerCommandItem(f.store, f.project.id, command.id)).toMatchObject({ stage: "result", detail: "현재 상태를 조회해 답변했습니다.", result: { messageId: msg.id } });
  expect(ownerCommandItem(f.store, f.project.id, other.id).result).toBeNull();
});

test("legacy work and exact command results follow reopening and replacement reports", () => {
  const f = fixture();
  const task = f.store.saveTask({ projectId: f.project.id, memberId: f.worker.id, who: f.worker.name, title: "기존 작업" }).task;
  const command = f.store.createMessage({ projectId: f.project.id, mine: true, kind: "나", body: "검증 결과", taskId: task.id });
  f.store.registerOwnerCommand(command.id);
  f.store.db.query("INSERT INTO owner_command_legacy_tasks VALUES(?,?,?)").run(task.id, task.projectId, task.createdAt);
  f.receive(f.worker,[f.input(f.worker,command.id).id]);
  const result = f.report(f.worker, "완료", undefined, [], task.id);
  const mark = (stage: "done" | "reopen") => f.store.addStageMark({ projectId: f.project.id, taskId: task.id, stage, evidence: "담당자가 대조", memberId: f.worker.id, who: f.worker.name });
  mark("done");
  for (const id of [task.id,command.id]) expect(ownerCommandItem(f.store,f.project.id,id)).toMatchObject({stage:"result",result:{messageId:result.id}});
  mark("reopen");
  for (const id of [task.id,command.id]) expect(ownerCommandItem(f.store,f.project.id,id).stage).not.toBe("result");
  const correction = f.report(f.worker,"막힘",result.id,[],task.id);
  for (const id of [task.id,command.id]) expect(ownerCommandItem(f.store,f.project.id,id)).toMatchObject({stage:"waiting",result:{messageId:correction.id}});
});

test("a merge or applied stage does not promote an outstanding report to verified completion", () => {
  const f = fixture();
  const task = f.store.saveTask({ projectId: f.project.id, memberId: f.worker.id, who: f.worker.name, title: "통합 후 확인" }).task;
  const cmd = f.store.createMessage({ projectId: f.project.id, mine: true, kind: "나", body: "통합 요청", taskId: task.id });
  f.store.registerOwnerCommand(cmd.id);
  f.receive(f.worker, [f.input(f.worker,cmd.id).id]);
  f.report(f.worker,"완료",undefined,[],task.id);
  for (const stage of ["merged","applied"] as const) {
    f.store.addStageMark({ projectId: f.project.id, taskId: task.id, stage, evidence: "현재 판", memberId: f.worker.id, who: f.worker.name });
    expect(ownerCommandItem(f.store,f.project.id,cmd.id).stage).not.toBe("result");
  }
});

test("a delivery in another project cannot inherit a command from a foreign report reference", () => {
  const f=fixture(), command=f.order("원 프로젝트");
  f.receive(f.worker,[f.input(f.worker,command.id).id]);
  const source=f.report(f.worker,"답변");
  const project=f.store.createProject({name:"다른 곳",cwd:"/tmp"}), other=f.store.createMember({projectId:project.id,handle:"other",name:"다른 직원",kind:"worker",backend:"core",status:"idle",paneId:"else",sessionId:"else"});
  const local=f.store.createMessage({projectId:project.id,mine:true,kind:"나",body:"다른 명령"}); f.store.registerOwnerCommand(local.id);
  const d=f.store.enqueue({projectId:project.id,memberId:other.id,kind:"report",refType:"message",refId:source.id,text:"다른 프로젝트 보고"});
  f.store.setDeliveryStatus(d.id,"delivered");
  f.store.saveExecutionJournal({...f.store.listPendingExecutions()[0]!,runId:crypto.randomUUID(),projectId:project.id,memberId:other.id,
    identity:{sessionId:other.sessionId,terminalId:other.paneId,sessionGeneration:0,process:null},deliveryIds:[d.id]});
  const report=f.store.createMessage({projectId:project.id,memberId:other.id,kind:"답변",title:"타 프로젝트"});
  f.store.saveReportReferences(project.id,{sourceMessageId:report.id,fileIds:[],decisionIds:[],authoredAt:report.at,sequence:1,correctsMessageId:null});
  expect(f.store.db.query("SELECT command_id FROM owner_command_evidence WHERE ref_type='message' AND ref_id=?").get(report.id)).toBeNull();
});

test("main and application evidence belongs to the command, remains separate from completion and honors reopen", () => {
  const f = fixture();
  const task = f.store.saveTask({ projectId: f.project.id, memberId: f.worker.id, who: f.worker.name, title: "반영 대조" }).task;
  const order = (body: string) => {
    const m = f.store.createMessage({ projectId: f.project.id, mine: true, kind: "나", body, taskId: task.id });
    f.store.registerOwnerCommand(m.id);
    return m;
  };
  const first = order("첫 명령"), other = order("같은 업무의 별개 명령");
  f.receive(f.worker, [f.input(f.worker, first.id).id]);
  const appliedFile = f.store.createFile({ projectId: task.projectId, title: "운영 점검 영수증", kind: "document", body: "검증 기록", taskId: task.id });
  const report = f.report(f.worker, "완료", undefined, [appliedFile.id], task.id);
  const mark = (stage: "done" | "merged" | "applied" | "reopen", evidence: string) => f.store.addStageMark({
    projectId: task.projectId, taskId: task.id, stage, evidence, memberId: f.worker.id, who: f.worker.name,
  });
  const done = mark("done", "검수 시작");
  const main = "c".repeat(40), base = "b".repeat(40);
  const integration = f.store.createMessage({ projectId: task.projectId, memberId: f.worker.id, kind: "완료", title: "원격 main 확인", taskId: task.id });
  mark("merged", "임의의 main 메모");
  mark("applied", "화면 확인, 관련 첨부 없음");
  const milestones = (id: string) => ownerCommandItem(f.store, task.projectId, id).milestones;
  expect(milestones(first.id)).toEqual([]);
  f.store.db.query(`INSERT INTO task_completion_reviews(task_id,report_id,contract_task_id,contract_rev,mark_id,status,completed_at,
    reviewed_at,reviewed_commit,main_base,main_commit,integration_report_id) VALUES(?,?,?,1,?,'confirmed',?,?,?,?,?,?)`)
    .run(task.id,report.id,task.id,done.id,report.at,report.at,"a".repeat(40),base,main,integration.id);
  mark("applied", "운영 접근 대조 " + appliedFile.id);
  const evidence = milestones(first.id)!;
  expect(evidence).toHaveLength(2);
  expect(evidence.find(m => m.kind === "main")).toMatchObject({ messageId: integration.id, commit: main, at: integration.at });
  expect(evidence.find(m => m.kind === "application")).toMatchObject({ fileIds: [appliedFile.id], actor: f.worker.name });
  expect(evidence.map(m => m.at)).toEqual(evidence.map(m => m.at).sort());
  expect(milestones(other.id)).toEqual([]);
  mark("reopen", "새 조건으로 재검수");
  expect(milestones(first.id)).toEqual([]);
});

test("explicit source selection validates current session, received task and original correction", () => {
  for (const mode of ["other task","old session","old generation","uncertain input","conflicting correction","outside turn"]) {
    const f = fixture(), a = f.order("원래 명령"), b = f.order("다른 명령");
    const task = (title: string) => f.store.saveTask({ projectId: f.project.id, memberId: f.worker.id, who: f.worker.name, title }).task;
    const original = task("원 업무"), other = task("다른 업무");
    const d = f.store.enqueue({projectId:f.project.id,memberId:f.worker.id,taskId:original.id,kind:"user_message",refType:"message",refId:a.id,text:a.body});
    const run = f.receive(f.worker, [d.id]);
    if (mode === "old session") f.store.saveExecutionJournal({...run,identity:{...run.identity,sessionId:"previous"}});
    if (mode === "old generation") f.store.db.query("UPDATE members SET session_generation=session_generation+1 WHERE id=?").run(f.worker.id);
    if (mode === "uncertain input") f.store.setDeliveryStatus(d.id,"held",{holdReason:"delivery_unknown"});
    const msg = f.store.createMessage({projectId:f.project.id,memberId:f.worker.id,kind:"진행",title:"대조",taskId:mode==="other task"?other.id:original.id});
    const prior = mode === "conflicting correction" ? f.message("이전 다른 글") : null;
    expect(() => f.store.saveReportReferences(f.project.id, { sourceMessageId:msg.id,fileIds:[],decisionIds:[],authoredAt:msg.at,sequence:2,
      correctsMessageId:prior?.id ?? null },mode==="outside turn"?b.id:a.id)).toThrow();
    expect(f.store.getReportReferences(f.project.id,msg.id)).toBeNull();
  }
});

test("a common quote in two received commands does not assign a specific command to the child", () => {
  const f = fixture(), other = f.staff("child");
  const a = f.order("공통 지시 문구, 첫 업무"), b = f.order("공통 지시 문구, 둘째 업무");
  f.receive(f.worker,[f.input(f.worker,a.id).id,f.input(f.worker,b.id).id]);
  const assigned = f.store.enqueue({ projectId: f.project.id, memberId: other.id, text:"공통 문구", kind:"instruction" });
  f.store.noteDelegation(f.worker.id,assigned,false,{id:b.id,matchesQuote: text=>text.includes("공통 지시 문구")});
  f.receive(other,[assigned.id]); f.report(other,"답변");
  for (const id of [a.id,b.id]) expect(ownerCommandItem(f.store,f.project.id,id).result).toBeNull();
});

test("a delayed explicit correction uses its own ended run receipt only in the same session and task", () => {
  const f = fixture(), a = f.order("수신 확인 후 회신");
  const task = f.store.saveTask({ projectId:f.project.id,memberId:f.worker.id,who:f.worker.name,title:"지연 회신" }).task;
  const d = f.store.enqueue({projectId:f.project.id,memberId:f.worker.id,kind:"user_message",refType:"message",refId:a.id,taskId:task.id,text:a.body});
  const run=f.receive(f.worker,[d.id]);
  const first=f.report(f.worker,"완료",undefined,[],task.id);
  f.store.saveExecutionJournal({...run,phase:"ended",result:"success",endedAt:run.updatedAt});
  const update=f.store.createMessage({projectId:f.project.id,memberId:f.worker.id,kind:"막힘",title:"정정",taskId:task.id});
  f.store.saveReportReferences(f.project.id,{sourceMessageId:update.id,fileIds:[],decisionIds:[],authoredAt:update.at,sequence:2,correctsMessageId:first.id},a.id);
  expect(ownerCommandItem(f.store,f.project.id,a.id)).toMatchObject({stage:"waiting",result:{messageId:update.id}});
});

test("이전 업무와 새 명령에서 미전송 대표 입력은 진행 대신 실제 수신 대기로 보인다", () => {
  const f = fixture(), pr = f.project.id;
  const task = f.store.ensureSourceTask({projectId:pr,sourceRef:"legacy-receipt",title:"진척 확인",origin:"owner"}).task;
  f.store.db.query("INSERT INTO owner_command_legacy_tasks(task_id,project_id,created_at) VALUES(?,?,?)").run(task.id,pr,task.createdAt);
  const msg = f.store.createMessage({projectId:pr,taskId:task.id,mine:true,kind:"나",body:"확인해 줘",delivery:"queued"});
  f.input(f.worker,msg.id);
  expect(ownerCommandItem(f.store,pr,task.id)).toMatchObject({stage:"waiting",detail:expect.stringContaining("전달 대기")});
  f.store.registerOwnerCommand(msg.id);
  f.store.db.query(`INSERT INTO delivery_dispatches(id,project_id,member_id,bundle_marker,cli,backend,generation,terminal_identity_json,
    baseline_json,wire_text,wire_sha256,transport_state,created_at,updated_at) VALUES('prior',?,?,'marker','codex','core',0,'{}','{}','old','sha','write_started',?,?)`).run(pr,f.worker.id,msg.at,msg.at);
  expect(ownerCommandItem(f.store,pr,msg.id)).toMatchObject({stage:"waiting",detail:expect.stringContaining("이전 입력의 수신 여부")});
  expect(f.store.listDeliveries(pr)[0]?.attempts).toBe(0);
});
