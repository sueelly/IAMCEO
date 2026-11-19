import { expect, test } from "bun:test";
import { retirePassiveReports } from "../server/passive-report-deliveries.ts";
import { fixture } from "./fixtures/harness-fixture.ts";
import { defaultTaskId } from "./fixtures/default-task.ts";

test("담당자에게 도착한 직접 지시의 총괄 사본만 종료하고 불확실한 입력과 원본을 보존한다", async () => {
  const f = fixture(), { project, worker, lead, store } = f;
  const msg = await f.orch.sendUserMessage(project.id, { text: "가격표를 확인해 주세요", targetMemberId: worker.id });
  const task = store.requireTask(msg.taskId!);
  const text = `[시스템] 대표가 ${worker.name}에게 직접 지시했습니다 #${msg.id}(작업 #${task.id} '${task.title}'). 이미 ${worker.name}에게 전달했습니다. 같은 일을 다시 시키지 말고, 결과 보고를 기다려 판만 맞추세요.`;
  const copy = (body: string) => store.enqueue({ projectId: project.id, memberId: lead.id, taskId: task.id, kind: "system", wake: false, text: body });
  const safe = copy(text), attempted = copy(text), different = copy(text + " 그리고 목록을 새로 확인하세요.");
  store.setDeliveryStatus(attempted.id, "queued", { attempt: true });
  const original = store.listDeliveries(project.id).find(d => d.kind === "user_message" && d.refId === msg.id)!;
  const before = store.requireDelivery(original.id);
  retirePassiveReports(store);
  retirePassiveReports(store);
  expect(store.requireDelivery(safe.id)).toMatchObject({ status: "failed", attempts: 0, deliveredAt: null });
  expect(store.getDeliveryRecovery(safe.id)?.phase).toBe("stopped");
  expect(store.requireDelivery(attempted.id).status).toBe("queued");
  expect(store.requireDelivery(different.id).status).toBe("queued");
  expect(store.requireDelivery(original.id)).toEqual(before);
  expect(store.requireMessage(msg.id).body).toBe("가격표를 확인해 주세요");
});

test("검수 레코드가 정확히 연결된 완료 사본은 검수 결과와 원문을 보존하고 총괄 큐에서 정리한다", () => {
  const { store, project, worker, lead } = fixture();
  const taskId = defaultTaskId(store, project.id);
  const mark = store.addStageMark({ projectId: project.id, taskId, stage: "done", memberId: null, who: "하네스", evidence: "검증 기록" });
  const report = (title: string) => {
    const msg = store.createMessage({ projectId: project.id, taskId, kind: "완료", memberId: worker.id, who: worker.name, title });
    store.saveReportReferences(project.id, { sourceMessageId: msg.id, authoredAt: msg.at, sequence: 1, decisionIds: [], fileIds: [], correctsMessageId: null });
    const delivery = store.enqueue({ projectId: project.id, memberId: lead.id, taskId, kind: "report", refType: "message", refId: msg.id, text: title, wake: false });
    return { msg, delivery };
  };
  const tracked = report("담당 검수로 접수"), missing = report("검수 연결 없음");
  store.db.query("INSERT INTO task_completion_reviews (report_id,task_id,contract_task_id,contract_rev,mark_id,status,completed_at) VALUES(?,?,?,1,?,'pending',?)")
    .run(tracked.msg.id, taskId, taskId, mark.id, tracked.msg.at);
  retirePassiveReports(store);
  expect(store.requireDelivery(tracked.delivery.id).status).toBe("failed");
  expect(store.requireDelivery(missing.delivery.id).status).toBe("queued");
  expect(store.requireMessage(tracked.msg.id).title).toBe("담당 검수로 접수");
  expect(store.db.query("SELECT status FROM task_completion_reviews WHERE report_id=?").get(tracked.msg.id)).toEqual({ status: "pending" });
});

test("명시적으로 재개된 감시의 옛 알림은 수신 불명 이력을 보존하고 재전송만 종료한다", () => {
  const { store, project, lead } = fixture(), taskId = defaultTaskId(store, project.id), task = store.requireTask(taskId);
  const started = "2026-01-01T00:00:00.000Z";
  store.saveTaskWatch(project.id, taskId, { startedAt: started, attempts: 3, same: 1, fingerprint: "new", lastProgressAt: started,
    trippedAt: null, reason: null, updatedAt: started, history: [] });
  const text = `[시스템] 반복 감시: 업무 #${taskId} '${task.title}'의 막힘이 진척 없이 120분(2번 시도). 이 업무의 자동 반복을 멈췄습니다. 같은 실패의 막힘은 더는 총괄을 깨우지 않습니다.\n- 시작 ${started} · 시도 2번`;
  const notice = store.enqueue({ projectId: project.id, memberId: lead.id, taskId, kind: "system", text });
  store.db.query("UPDATE deliveries SET created_at=? WHERE id=?").run(started, notice.id);
  const evidence = [{ source: "transport" as const, verdict: "unknown" as const, code: "legacy_unknown", location: "none" as const,
    complete: false, checkedAt: started }];
  const observed = store.updateDeliveryRecovery(notice.id, 1, { checkCount: 2, activeCheckMs: 10, evidence, lastCheckedAt: started });
  retirePassiveReports(store);
  expect(store.requireDelivery(notice.id).status).toBe("queued");
  store.addStageMark({ projectId: project.id, taskId, stage: "reopen", evidence: "변경된 입력으로 다시 시작", memberId: lead.id, who: lead.name });
  retirePassiveReports(store);
  expect(store.getDeliveryRecovery(notice.id)).toMatchObject({ phase: "stopped", activeCheckMs: 10, version: observed.version + 1, checkCount: 2, evidence });
  expect(store.requireDelivery(notice.id)).toMatchObject({ status: "failed", attempts: 0, deliveredAt: null, text });
  expect(store.requireDelivery(notice.id).lastError).toContain("과거 수신 여부는 미확정");
});

test("대표가 인용한 이전 막힘은 같은 담당자의 후속 실행·보고와 연결하고 별개 조건은 보존한다", () => {
  const { store, project, lead, worker } = fixture(), taskId = defaultTaskId(store, project.id);
  const stamp = (minute: number) => new Date(1700000000000 + minute * 60000).toISOString();
  const blocked = (title: string, minute: number) => {
    const msg = store.createMessage({ projectId: project.id, taskId, memberId: worker.id, who: worker.name, kind: "막힘", title, at: stamp(minute) });
    store.saveReportReferences(project.id, { sourceMessageId: msg.id, authoredAt: msg.at, sequence: 1, decisionIds: [], fileIds: [], correctsMessageId: null });
    const delivery = store.enqueue({ projectId: project.id, memberId: lead.id, taskId, kind: "report", refType: "message", refId: msg.id, text: title });
    return { msg, delivery };
  };
  const before = blocked("release 영수증과 권한 확인 필요", 1), separate = blocked("개별 단말 실측 필요", 1);
  const cmd = store.createMessage({ projectId: project.id, taskId, mine: true, kind: "나", body: `이전 보고 #${before.msg.id}의 영수증을 대조해 주세요`,
    targetMemberId: worker.id, targetName: worker.name, at: stamp(2), delivery: "delivered" });
  const request = store.enqueue({ projectId: project.id, memberId: worker.id, taskId, kind: "user_message", text: cmd.body, refId: cmd.id, refType: "message" });
  store.markDelivered(request.id);
  const latest = blocked("영수증 대조 완료, 권한 확인 대기", 3);
  retirePassiveReports(store);
  expect(store.requireDelivery(before.delivery.id).status).toBe("queued");
  const runId = "review-run";
  store.db.query("INSERT INTO report_harness(message_id,task_id,member_id,run_id,at) VALUES(?,?,?,?,?)")
    .run(latest.msg.id,taskId,worker.id,runId,stamp(3));
  store.saveExecutionJournal({ runId, memberId: worker.id, projectId: project.id,
    identity: { terminalId: worker.paneId, sessionId: worker.sessionId, sessionGeneration: 0, process: null },
    turn: 1, deliveryIds: [request.id], phase: "ended", inputReceivedAt: stamp(2), startedAt: stamp(2), lastProgressAt: stamp(3), endedAt: stamp(4),
    result: "success", reason: null, exitCode: 0, interruptionNotifiedAt: null, reportRequestedAt: null, createdAt: stamp(2), updatedAt: stamp(4) });
  expect(store.requireDelivery(before.delivery.id).status).toBe("failed");
  expect(store.requireDelivery(latest.delivery.id).text).toContain("#" + before.msg.id);
  expect(store.requireDelivery(latest.delivery.id).status).toBe("queued");
  expect(store.requireDelivery(separate.delivery.id).status).toBe("queued");
  expect(store.requireMessage(before.msg.id)).toEqual(before.msg);
});
