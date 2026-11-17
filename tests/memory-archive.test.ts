import { afterEach, expect, spyOn, test } from "bun:test";
import { Bus } from "../server/bus.ts";
import { openDb } from "../server/db.ts";
import { Store } from "../server/store.ts";
import { DevMemory, memoryProjectId } from "../server/integrations/dev-memory.ts";
import { MemoryArchive, MEMORY_ARCHIVE_SCHEMA } from "../server/integrations/memory-archive.ts";
import { MemoryFeedback } from "../server/integrations/memory-feedback.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
function setup(options: { batchSize?: number; secrets?: string[] } = {}) {
  const bus = new Bus(), db = openDb(":memory:"), store = new Store(db, bus);
  if (!db.query("SELECT 1 FROM sqlite_master WHERE name='memory_archive_sources'").get()) db.exec(MEMORY_ARCHIVE_SCHEMA);
  const project = store.createProject({ name: "원문 보관", cwd: "/fixture" });
  const memory = new DevMemory({ baseUrl: "http://127.0.0.1:1", keyFile: "/never-read", projects: [] }, async () => { throw new Error("archive must only enqueue; no gateway calls"); });
  memory.setProjectGate(id => store.getProject(id)?.memory?.on ?? false);
  const subscriptions = { opened: 0, active: 0 };
  const make = () => new MemoryArchive(store, memory, () => options.secrets ?? [], { batchSize: options.batchSize, intervalMs: 60_000, subscribe: listener => {
    subscriptions.opened++; subscriptions.active++;
    const close = bus.subscribe(listener);
    return () => { subscriptions.active--; close(); };
  } });
  const archive = make();
  cleanups.push(async () => { await archive.stop(); db.close(); });
  const uploads = (type?: string, id?: string) => store.listMemoryUploads().filter(r => (!type || r.refType === `archive_${type}`) && (!id || r.refId === id));
  return { bus, db, store, project, archive, make, uploads, memory, subscriptions };
}

async function until(ready: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!ready() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  expect(ready()).toBe(true);
}

test("역사 대화의 동일 시각 501건을 빠짐없이 보관하고 대표와 AI 출처를 구별한다", async () => {
  const f = setup({ batchSize: 32 });
  const ids: string[] = [];
  f.store.transaction(() => {
    for (let n = 0; n < 501; n++) ids.push(f.store.createMessage({ projectId: f.project.id, mine: n % 2 === 0, who: n % 2 === 0 ? "대표" : "직원", kind: n % 2 === 0 ? "나" : "진행", body: `원문-${n}` }).id);
    f.db.query("UPDATE messages SET at='2026-11-18T00:00:00.000Z' WHERE project_id=?").run(f.project.id);
  });
  let yielded = false; setTimeout(() => { yielded = true; }, 0);
  await f.archive.reconcile();
  expect(yielded).toBe(true);
  const records = f.uploads("message");
  expect(records).toHaveLength(501);
  expect(new Set(records.map(r => r.refId))).toEqual(new Set(ids));
  const owner = JSON.parse(records.find(r => r.refId === ids[0])!.body), agent = JSON.parse(records.find(r => r.refId === ids[1])!.body);
  expect(owner.kind).toBe("outcome"); expect(agent.kind).toBe("outcome");
  expect(owner.content).toContain('"mine": true'); expect(agent.content).toContain('"mine": false');
  expect(owner.content).toContain("2026-11-18T00:00:00.000Z");
  expect(owner.event_id).toStartWith("iamceo-archive-");
  expect(owner.source).toMatchObject({ service: "iamceo", item_id: ids[0] });
});

test("같은 원문은 재시작 후에도 하나이며 수정과 원래 내용으로의 복귀는 각각 새 버전이다", async () => {
  const f = setup(), m = f.store.createMessage({ projectId: f.project.id, mine: true, kind: "나", body: "처음 원문" });
  await f.archive.reconcile(); await f.archive.reconcile();
  const again = f.make(); await again.reconcile(); await again.stop();
  expect(f.uploads("message", m.id)).toHaveLength(1);
  f.db.query("UPDATE messages SET body=? WHERE id=?").run("수정 원문", m.id);
  await f.archive.reconcile();
  f.db.query("UPDATE messages SET body=? WHERE id=?").run("처음 원문", m.id);
  await f.archive.reconcile();
  const records = f.uploads("message", m.id);
  expect(records).toHaveLength(3); expect(new Set(records.map(r => r.eventId)).size).toBe(3);
  expect(f.db.query("SELECT version FROM memory_archive_sources WHERE source_type='message' AND source_id=?").get(m.id)).toEqual({ version: 3 });
});

test("긴 한국어와 이모지 자료는 원문 전체를 순서대로 분할하고 첨부는 참조만 보관한다", async () => {
  const f = setup(), body = "끝까지 보존🙂\n".repeat(6000);
  const attachment = { id: "a", name: "원본.pdf", mime: "application/pdf", size: 42, path: "/fixture/original.pdf", url: "/files/a/original.pdf", isImage: false };
  const doc = f.store.createFile({ projectId: f.project.id, title: "긴 자료", body, kind: "artifact", html: "<p>별도 HTML 원문</p>", attachments: [attachment] });
  const message = f.store.createMessage({ projectId: f.project.id, mine: true, kind: "나", body: "첨부를 검토해주세요", attachments: [attachment] });
  await f.archive.reconcile();
  const parts = f.uploads("file", doc.id).map(r => JSON.parse(r.body));
  expect(parts.length).toBeGreaterThan(1);
  const order = (p: { evidence: { kind: string; text: string }[] }) => JSON.parse(p.evidence.find(e => e.kind === "archive_part")!.text);
  parts.sort((a, b) => order(a).index - order(b).index);
  expect(parts.map(order).map(p => p.index)).toEqual(Array.from({ length: parts.length }, (_, n) => n + 1));
  expect(parts.every(p => order(p).count === parts.length && p.capture === "excerpt")).toBe(true);
  expect(parts.every(p => p.content.length <= 18000)).toBe(true);
  const joined = parts.map(p => p.content.split("\n--- 원문 JSON ---\n")[1]).join("");
  const value = JSON.parse(joined);
  expect(value.record.body).toBe(body); expect(value.html).toBe("<p>별도 HTML 원문</p>");
  expect(value.record.attachments[0]).toMatchObject({ id: "a", size: 42, url: "/files/a/original.pdf" });
  expect(parts[0].content).toContain("첨부 바이너리는 포함하지 않음");
  const messageValue = JSON.parse(JSON.parse(f.uploads("message", message.id)[0]!.body).content.split("\n--- 원문 JSON ---\n")[1]);
  expect(messageValue.record.attachments).toEqual([attachment]);
});

test("꺼진 프로젝트는 보관하지 않고 다시 켜면 원본을 보완하며 실패한 옛 전송도 새 보관을 막지 않는다", async () => {
  const f = setup(), m = f.store.createMessage({ projectId: f.project.id, mine: true, kind: "나", body: "연결 복구 후 보관" });
  f.store.setProjectMemory(f.project.id, false); await f.archive.reconcile(); expect(f.uploads()).toHaveLength(0);
  f.store.setProjectMemory(f.project.id, true); await f.archive.reconcile();
  const first = f.uploads("message", m.id)[0]!;
  f.store.settleMemoryUpload(first.eventId, { status: "rejected", attempts: 6, lastError: "이전 일시 오류" });
  const newer = f.store.createMessage({ projectId: f.project.id, mine: true, kind: "나", body: "다음 원문" });
  await f.archive.reconcile();
  expect(f.uploads("message", newer.id)).toHaveLength(1);
  expect(f.store.getMemoryUpload(first.eventId)).toMatchObject({ status: "rejected", attempts: 6 });
});

test("자격 증명은 원문 분할 전에 가리고 정제된 원문만 영속 큐에 둔다", async () => {
  const secret = "fixture-private-credential-78123", shortCode = "Q7b9C2", f = setup({ secrets: [secret, shortCode] });
  const member = f.store.createMember({ projectId: f.project.id, handle: "worker", name: "직원", kind: "worker" });
  const memberToken = f.store.getMemberToken(member.id)!;
  const body = `보존할 설명 ${secret} ${memberToken} ${shortCode}\n` + '"api_key": "fixture-json-credential-67231"\n"비밀번호": "fixture-korean-credential-12488"\n' + "앞".repeat(17995) + " password=fixture-password-90872";
  const m = f.store.createMessage({ projectId: f.project.id, mine: true, kind: "나", body });
  await f.archive.reconcile();
  const all = f.uploads("message", m.id).map(r => r.body).join("");
  for (const token of [secret, shortCode, memberToken, "fixture-json-credential-67231", "fixture-korean-credential-12488", "fixture-password-90872"]) expect(all.includes(token)).toBe(false);
  expect(all).toContain("보존할 설명"); expect(f.store.requireMessage(m.id).body).toBe(body);
});

test("원문과 분할 대기열 저장은 한 거래이며 중간 오류 뒤 다시 온전하게 보관한다", async () => {
  const f = setup(), m = f.store.createMessage({ projectId: f.project.id, mine: true, kind: "나", body: "보관 원문\n".repeat(5000) });
  f.db.exec("CREATE TRIGGER reject_archive_second BEFORE INSERT ON memory_outbox WHEN NEW.body LIKE '%조각: 2/%' BEGIN SELECT RAISE(ABORT,'fixture archive second part'); END");
  await expect(f.archive.reconcile()).rejects.toThrow("fixture archive second part");
  expect(f.uploads("message", m.id)).toHaveLength(0);
  expect(f.db.query("SELECT 1 FROM memory_archive_sources WHERE source_type='message' AND source_id=?").get(m.id)).toBeNull();
  f.db.exec("DROP TRIGGER reject_archive_second");
  await f.archive.reconcile(); expect(f.uploads("message", m.id).length).toBeGreaterThan(1);
});

test("업무와 계약·단계·검사 및 대표 결재·할 일·전달을 출처별로 보관한다", async () => {
  const f = setup(), member = f.store.createMember({ projectId: f.project.id, handle: "worker", name: "직원", kind: "worker" });
  const task = f.store.saveTask({ projectId: f.project.id, memberId: member.id, who: member.name, title: "계약이 있는 업무" }).task;
  const child = f.store.saveTask({ projectId: f.project.id, memberId: member.id, who: member.name, title: "파생 업무" }).task;
  f.store.recordTaskRelation({ projectId: f.project.id, taskId: child.id, fromTaskId: task.id, basis: "derived", actor: member.name, note: "관련된 파생 관계" });
  const contract = f.store.saveTaskContract(task.id, { kind: "other", goal: "원문과 화자 보존", acceptance: ["검사 결과와 결재 답이 연결된다"] }, { author: "대표", authorKind: "owner", authorMemberId: null });
  f.store.addStageMark({ projectId: f.project.id, taskId: task.id, stage: "review", evidence: "독립 검토를 요청함", memberId: member.id, who: member.name });
  const message = f.store.createMessage({ projectId: f.project.id, taskId: task.id, memberId: member.id, who: member.name, kind: "진행", body: "검토 원문" });
  f.store.recordReportChecks(message, member, [{ name: "원문 검사", kind: "other", result: "pass", evidence: "원문과 일치함", criterion: 1 }], { contractTaskId: task.id, contractRev: contract.rev });
  const decision = f.store.createDecision({ projectId: f.project.id, taskId: task.id, memberId: member.id, who: member.name, title: "적용 여부", options: [{ k: "yes", label: "적용" }] });
  f.store.answerDecision(decision.id, { choice: "yes", note: "검토 후 적용하세요" });
  const todo = f.store.createTodo({ projectId: f.project.id, taskId: task.id, who: member.name, title: "확인 필요", detail: "추가 검증" });
  const work = f.store.upsertWork({ projectId: f.project.id, taskId: task.id, sec: "doing", title: "진행판 항목", who: member.name });
  const instruction = f.store.enqueue({ projectId: f.project.id, taskId: task.id, memberId: member.id, kind: "instruction", text: "검토를 시작하세요" });
  const answer = f.store.enqueue({ projectId: f.project.id, taskId: task.id, memberId: member.id, kind: "answer", refType: "decision", refId: decision.id, text: "대표의 결재 응답" });
  const done = f.store.enqueue({ projectId: f.project.id, taskId: task.id, memberId: member.id, kind: "todo_done", refType: "todo", refId: todo.id, text: "대표가 확인함" });
  f.store.enqueue({ projectId: f.project.id, memberId: member.id, kind: "system", text: "검색한 기억을 다시 주입한 내용" });
  await f.archive.reconcile();
  const read = (type: string, id: string) => JSON.parse(JSON.parse(f.uploads(type, id)[0]!.body).content.split("\n--- 원문 JSON ---\n")[1]);
  expect(read("task", task.id)).toMatchObject({ record: { id: task.id, who: member.name }, contracts: [{ goal: contract.goal, authorKind: "owner" }], stages: [{ stage: "review", evidence: "독립 검토를 요청함" }] });
  expect(read("task", child.id)).toMatchObject({ record: { parentTaskId: task.id }, links: [{ from_task_id: task.id, to_task_id: child.id, note: "관련된 파생 관계" }] });
  expect(read("message", message.id).harness.checks).toMatchObject([{ result: "pass", evidence: "원문과 일치함", contractRev: 1 }]);
  expect(read("decision", decision.id).record).toMatchObject({ choice: "yes", note: "검토 후 적용하세요", who: member.name, taskId: task.id });
  expect(read("todo", todo.id).record.detail).toBe("추가 검증");
  expect(read("work", work.id).record.title).toBe("진행판 항목");
  expect(f.uploads("delivery").map(r => r.refId).sort()).toEqual([instruction.id, answer.id, done.id].sort());
  expect(f.uploads().every(r => JSON.parse(r.body).kind === "outcome")).toBe(true);
  f.store.saveTaskContract(task.id, { kind: "other", goal: "수정 계약", acceptance: ["두 번째 판"] }, { author: member.name, authorKind: "worker", authorMemberId: member.id });
  await f.archive.reconcile();
  expect(f.uploads("task", task.id)).toHaveLength(2);
});

test("시작은 하나의 구독으로 새 변경을 보관하고 정지 후 구독과 예약 작업을 해제한다", async () => {
  const f = setup();
  f.archive.start(); f.archive.start();
  await until(() => f.uploads("project").length === 1);
  expect(f.subscriptions).toEqual({ opened: 1, active: 1 });
  const first = f.store.createMessage({ projectId: f.project.id, mine: true, kind: "나", body: "시작 후의 새로운 대화" });
  await until(() => f.uploads("message", first.id).length === 1);
  await f.archive.stop(); expect(f.subscriptions.active).toBe(0);
  const next = f.store.createMessage({ projectId: f.project.id, mine: true, kind: "나", body: "정지 동안의 대화" });
  await new Promise(resolve => setTimeout(resolve, 60));
  expect(f.uploads("message", next.id)).toHaveLength(0);
  f.archive.start(); await until(() => f.uploads("message", next.id).length === 1);
  expect(f.uploads("message", first.id)).toHaveLength(1);
});

test("보완 수집 도중 프로젝트를 끄면 멈추고 재개 시 누락만 이어 보관한다", async () => {
  const f = setup({ batchSize: 8 });
  for (let n = 0; n < 40; n++) f.store.createMessage({ projectId: f.project.id, mine: true, kind: "나", body: `변경-${n}` });
  setTimeout(() => f.store.setProjectMemory(f.project.id, false), 0);
  await f.archive.reconcile();
  const partial = f.uploads("message").length;
  expect(partial).toBeGreaterThan(0); expect(partial).toBeLessThan(40);
  f.store.setProjectMemory(f.project.id, true); await f.archive.reconcile();
  expect(f.uploads("message")).toHaveLength(40);
});

test("기억 활용의 명시 평가와 미사용 이유를 중립 원문으로 보관하고 전송 재시도는 새 원문이 아니다", async () => {
  const f = setup(), member = f.store.createMember({ projectId: f.project.id, handle: "worker", name: "직원", kind: "worker" });
  const feedback = new MemoryFeedback(f.store, f.memory, { secrets: () => [] });
  feedback.register(member, null, ["exp-used", "exp-unused", "exp-unassessed"].map(id => ({
    id, project_id: memoryProjectId(f.project.id), event_id: `event-${id}`, kind: "lesson" as const,
    summary: "과거 기억 원문", content: "이전의 검증된 설명", source: { service: "iamceo", task_id: "tk_previous" },
  })));
  const used = feedback.assess(member, null, "exp-used", "helped", "같은 조건이라 검사에 적용했습니다");
  const unused = feedback.assess(member, null, "exp-unused", "not_used", "이번 조건에 해당하지 않았습니다");
  await f.archive.reconcile();
  expect(f.uploads("memory_feedback")).toHaveLength(2);
  const bodies = f.uploads("memory_feedback").map(row => JSON.parse(row.body));
  expect(bodies.every(body => body.kind === "outcome")).toBe(true);
  const value = (id: string) => JSON.parse(bodies.find(body => body.source.item_id === id).content.split("\n--- 원문 JSON ---\n")[1]);
  expect(value(unused.id).record).toMatchObject({ member_id: member.id, experience_id: "exp-unused", outcome: "not_used", reason: unused.reason, assessed_at: unused.assessedAt });
  expect(value(used.id).record).toMatchObject({ outcome: "helped", reason: used.reason });
  expect(value(used.id).record).not.toHaveProperty("status");
  f.db.query("UPDATE memory_feedback_exposures SET attempts=3,status='sent',updated_at=? WHERE id=?").run("2026-11-18T23:00:00Z", used.id);
  await f.archive.reconcile();
  expect(f.uploads("memory_feedback")).toHaveLength(2);
});

test("실시간 한 건과 프로젝트 상태 집계가 오래된 대화 전체를 다시 읽지 않는다", async () => {
  const f = setup({ batchSize: 8 });
  for (let n = 0; n < 120; n++) f.store.createMessage({ projectId: f.project.id, mine: true, kind: "나", body: `오래된 대화 ${n}` });
  f.archive.start();
  await until(() => f.uploads("message").length === 120);
  await f.archive.reconcile();
  const read = spyOn(f.store, "getMessage");
  try {
    for (let n = 0; n < 10; n++) f.bus.emit({ type: "projects", projects: [] });
    const next = f.store.createMessage({ projectId: f.project.id, mine: true, kind: "나", body: "새 대화 한 건" });
    await until(() => f.uploads("message", next.id).length === 1);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(read.mock.calls.length).toBeLessThan(12);
  } finally { read.mockRestore(); }
});

test("DB를 닫고 다시 열어도 보관 지문과 대기열이 남으며 새 대화만 추가한다", async () => {
  const isolated = createIsolatedRuntime(), path = `${isolated.paths.iamceoHome}/archive-restart.sqlite`;
  let db = openDb(path), store = new Store(db, new Bus());
  const project = store.createProject({ name: "재시작 검증", cwd: isolated.paths.work });
  const memory = new DevMemory({ baseUrl: "http://127.0.0.1:1", keyFile: "/never-read", projects: [] }, async () => { throw new Error("No archive network calls"); });
  memory.setProjectGate(id => store.getProject(id)?.memory?.on ?? false);
  let archive = new MemoryArchive(store, memory, () => []);
  cleanups.push(async () => { await archive.stop(); db.close(); await isolated.stop(); });
  const first = store.createMessage({ projectId: project.id, mine: true, kind: "나", body: "재시작 전 원문" });
  await archive.reconcile();
  const firstId = store.listMemoryUploads().find(row => row.refId === first.id)!.eventId;
  await archive.stop(); db.close();
  db = openDb(path); store = new Store(db, new Bus()); archive = new MemoryArchive(store, memory, () => []);
  const next = store.createMessage({ projectId: project.id, mine: true, kind: "나", body: "재시작 뒤 원문" });
  await archive.reconcile();
  const uploads = store.listMemoryUploads().filter(row => row.refType === "archive_message");
  expect(uploads).toHaveLength(2);
  expect(uploads.find(row => row.refId === first.id)!.eventId).toBe(firstId);
  expect(uploads.find(row => row.refId === next.id)).toBeDefined();
});
