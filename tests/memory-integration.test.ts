import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../server/bus.ts";
import { loadConfig } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { Store } from "../server/store.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import { DevMemory } from "../server/integrations/dev-memory.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";
import { FakeRunner } from "./fixtures/harness-fixture.ts";
import type { Delivery, Member } from "../shared/types.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
function fixture(accessCode?: string) {
  const isolated = createIsolatedRuntime(), config = loadConfig({ IAMCEO_HOME: isolated.paths.iamceoHome, IAMCEO_PORT: "0" });
  if (accessCode) config.accessCode = accessCode;
  const db = openDb(config.dbPath), store = new Store(db, new Bus());
  const project = store.createProject({ name: "기억 자동 보관", cwd: isolated.paths.work });
  const keyFile = join(isolated.paths.home, "memory-key"); writeFileSync(keyFile, "fixture-memory-key", { mode: 0o600 });
  const calls: { path: string; body: any }[] = [];
  let badAck = false, down = false;
  let contextWait: Promise<void> | null = null;
  const experience = { id: "exp-prior", project_id: `iamceo-${project.id}`, event_id: "prior", kind: "lesson", summary: "원문을 보존한다", content: "원문과 해석을 구분한다", source: { task_id: "previous-task", service: "iamceo" } };
  const memory = new DevMemory({ baseUrl: "http://127.0.0.1:1", keyFile, projects: [project.id] }, async (url, init) => {
    const path = new URL(url).pathname, body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ path, body });
    if (path === "/healthz") return Response.json({ ok: true });
    if (down) return Response.json({ error: "unavailable" }, { status: 503 });
    if (path === "/v1/context") { await contextWait; return Response.json({ experiences: [experience], semantic_index: "available" }); }
    if (path === "/v1/feedback") return Response.json({ ...experience, feedback: { [body.feedback.outcome]: 1 } });
    return Response.json(badAck ? {} : { ...body?.experience, id: `exp-${calls.length}`, project_id: body?.project_id }, { status: 201 });
  });
  const runner = new FakeRunner(), orch = new Orchestrator({ config, store, devMemory: memory, runners: new Map([["core", runner]]), providerHomes: isolated.providerHomes, timings: { tickMs: 60000, healthMs: 60000 } });
  const member = store.createMember({ projectId: project.id, handle: "worker", name: "담당", kind: "worker", origin: "runner", backend: "core", status: "idle", cwd: isolated.paths.work });
  const task = store.ensureSourceTask({ projectId: project.id, sourceRef: "owner-request", title: "자동 보관 구현", origin: "owner" }).task;
  const tool = (name: string, args: Record<string, unknown>) => orch.handleAgentTool(store.requireMember(member.id), name, args);
  cleanups.push(async () => { await orch.shutdown(); db.close(); await isolated.stop(); });
  return { store, project, memory, calls, member, task, orch, tool, badAck: () => { badAck = true; }, down: () => { down = true; }, holdContext: (wait: Promise<void>) => { contextWait = wait; } };
}

// Exercise the same pre-delivery boundary used for a real runner batch.
const attach = (orch: Orchestrator, member: Member, pending: Delivery[]) =>
  (orch as unknown as { attachMemoryContext(member: Member, pending: Delivery[]): Promise<void> }).attachMemoryContext(member, pending);

test("웹 종료 뒤 도착한 검색 응답은 원본 DB와 피드백에 새 기록을 쓰지 않는다", async () => {
  const f = fixture();
  let release!: () => void;
  f.holdContext(new Promise<void>(resolve => { release = resolve; }));
  const input = f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, taskId: f.task.id, kind: "instruction", text: "원문 보관과 피드백을 연결해 주세요" });
  const waiting = attach(f.orch, f.member, [input]);
  await f.orch.shutdown();
  release(); await waiting;
  expect(f.store.listMemorySearches(f.project.id)).toHaveLength(0);
  expect(f.store.db.query("SELECT id FROM memory_feedback_exposures").all()).toHaveLength(0);
});

test("허용되는 짧은 접속 코드도 원문 보관과 피드백에서 유출하지 않는다", async () => {
  const f = fixture("827531");
  const message = f.store.createMessage({ projectId: f.project.id, mine: true, who: "대표", kind: "나", body: "임시 접속값은 827531 입니다" });
  await f.orch.memoryArchive!.reconcile();
  const record = f.store.listMemoryUploads().find(row => row.refType === "archive_message" && row.refId === message.id)!;
  expect(record.body).not.toContain("827531");
  expect(record.body).toContain("가림");
  await f.tool("memory_search", { query: "자동 보관과 접속 설정", task_id: f.task.id });
  const rejected = await f.tool("memory_feedback", { id: "exp-prior", task_id: f.task.id, outcome: "not_used", reason: "접속값 827531 때문입니다" });
  expect(rejected.isError).toBe(true);
  expect(f.orch.memoryServiceInfo().feedback?.notUsed).toBe(0);
});

test("합쳐진 업무 ID로 검색과 평가를 해도 현재 업무의 완료 보고에 같은 기준을 적용한다", async () => {
  const f = fixture();
  const current = f.store.ensureSourceTask({ projectId: f.project.id, sourceRef: "merged-current", title: "합친 업무", origin: "owner" }).task;
  f.store.markTaskMerged(f.task.id, current.id, "fixture");
  expect((await f.tool("memory_search", { query: "원문과 해석을 구분", task_id: f.task.id })).isError).toBeFalsy();
  expect(f.calls.find(call => call.path === "/v1/context")!.body.task_id).toBe(current.id);
  const report = { kind: "막힘", title: "합친 업무 확인", body: "원문을 확인합니다", task_id: f.task.id };
  expect((await f.tool("post", report)).text).toContain("memory_feedback");
  expect((await f.tool("memory_feedback", { id: "exp-prior", task_id: f.task.id, outcome: "not_used", reason: "이번 보고는 추가 원문 요청이라 적용하지 않았습니다" })).isError).toBeFalsy();
  expect((await f.tool("post", report)).isError).toBeFalsy();
});

test("여러 업무가 함께 전달되어도 기억 활용 평가는 실제 전달된 업무에만 귀속된다", async () => {
  const f = fixture();
  const next = f.store.ensureSourceTask({ projectId: f.project.id, sourceRef: "next-request", title: "다음 원문 확인", origin: "owner" }).task;
  const first = f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, taskId: f.task.id, kind: "instruction", text: "대표 원문과 해석을 구분하는 보관을 구현해 주세요" });
  const second = f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, taskId: next.id, kind: "instruction", text: "다음 업무에서도 원문과 해석을 구분해 주세요" });
  await attach(f.orch, f.member, [first, second]);
  expect(f.orch.memoryFeedback!.pending(f.member, f.task.id)).toHaveLength(0);
  f.store.markDelivered(first.id);
  expect(f.orch.memoryFeedback!.pending(f.member, f.task.id).map(item => item.id)).toEqual(["exp-prior"]);
  expect(f.orch.memoryFeedback!.pending(f.member, next.id)).toHaveLength(0);
  expect(f.orch.memoryFeedback!.pending(f.member, null)).toHaveLength(0);
  f.store.markDelivered(second.id);
  expect(f.orch.memoryFeedback!.pending(f.member, next.id)).toHaveLength(1);
});

test("검색 안내 저장이 실패하면 전달되지 않은 기억을 평가하라고 요구하지 않는다", async () => {
  const f = fixture();
  const input = f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, taskId: f.task.id, kind: "instruction", text: "대표 원문과 해석을 구분해서 자동 보관해 주세요" });
  const original = f.store.recordMemorySearch;
  f.store.recordMemorySearch = () => { throw new Error("fixture: notice transaction failed"); };
  try { await attach(f.orch, f.member, [input]); }
  finally { f.store.recordMemorySearch = original; }
  f.store.markDelivered(input.id);
  expect(f.orch.memoryFeedback!.pending(f.member, f.task.id)).toHaveLength(0);
});

test("피드백은 전송 장애 중에도 먼저 저장되어 보고를 허용하고 자동 보관한다", async () => {
  const f = fixture();
  await f.tool("memory_search", { query: "원문과 해석을 구분", task_id: f.task.id });
  f.down();
  const response = await f.tool("memory_feedback", { id: "exp-prior", task_id: f.task.id, outcome: "did_not_help", reason: "검색된 기록이 이번 저장 영수증 오류의 재현 근거를 제공하지 않았습니다" });
  expect(response.isError).toBeFalsy();
  await f.orch.memoryFeedback!.flush();
  expect(f.orch.memoryServiceInfo().feedback?.pending).toBe(1);
  expect((await f.tool("post", { kind: "막힘", title: "영수증 확인", body: "별도 근거가 필요합니다", task_id: f.task.id })).isError).toBeFalsy();
  await f.orch.memoryArchive!.reconcile();
  const archived = f.store.listMemoryUploads().filter(row => row.refType === "archive_memory_feedback");
  expect(archived).toHaveLength(1);
  expect(archived[0]!.body).toContain("재현 근거를 제공하지 않았습니다");
});

test("현재 업무가 받은 타 업무 기억은 명시적으로 평가하거나 사용하지 않았다고 남긴 뒤 보고한다", async () => {
  const f = fixture();
  expect((await f.tool("memory_search", { query: "원문과 해석을 구분하는 자동 보관", task_id: f.task.id })).isError).toBeFalsy();
  const report = { kind: "막힘", title: "완료 기준 확인", body: "대표 원문 범위를 확인합니다", task_id: f.task.id };
  const refused = await f.tool("post", report);
  expect(refused.isError).toBe(true);
  expect(refused.text).toContain("memory_feedback");
  expect(f.orch.memoryServiceInfo().feedback?.unassessed).toBe(1);
  expect(f.store.listMessages(f.project.id).filter(m => m.title === report.title)).toHaveLength(0);
  const assessed = await f.tool("memory_feedback", { id: "exp-prior", task_id: f.task.id, outcome: "not_used", reason: "이번 보고는 추가 확인 요청이므로 이 기억을 판단에 사용하지 않았습니다" });
  expect(assessed.isError, assessed.text).toBeFalsy();
  expect((await f.tool("post", report)).isError).toBeFalsy();
  expect(f.orch.memoryServiceInfo().feedback?.notUsed).toBe(1);
  expect(f.calls.filter(c => c.path === "/v1/feedback")).toHaveLength(0);
});

test("서버가 원문과 보고를 자동 보관하고 다시 스캔해도 같은 버전을 늘리지 않는다", async () => {
  const f = fixture();
  const owner = f.store.createMessage({ projectId: f.project.id, taskId: f.task.id, mine: true, who: "대표", kind: "나", body: "원문과 시점을 보존해 주세요" });
  await f.orch.memoryArchive!.reconcile();
  const first = f.store.listMemoryUploads(f.project.id).filter(job => job.refType === "archive_message" && job.refId === owner.id);
  expect(first).toHaveLength(1);
  expect(JSON.parse(first[0]!.body).content).toContain(owner.body);
  await f.orch.memoryArchive!.reconcile();
  expect(f.store.listMemoryUploads(f.project.id).filter(job => job.refId === owner.id)).toHaveLength(1);
  await f.memory.flush(f.store);
  expect(f.orch.memoryServiceInfo().uploads?.sent).toBeGreaterThan(0);
});

test("원격 저장 ID가 없는 응답을 전송 성공으로 처리하지 않는다", async () => {
  const f = fixture(); f.badAck();
  f.store.enqueueMemoryUpload({ eventId: "ack-check", projectId: f.project.id, refType: "owner_note", refId: "source", body: JSON.stringify({ event_id: "ack-check", kind: "outcome", summary: "원문", content: "실제 원문", source: { task_id: f.task.id, service: "iamceo" } }) });
  await f.memory.flush(f.store);
  expect(f.store.getMemoryUpload("ack-check")).toMatchObject({ status: "pending", remoteId: null });
});

test("프로젝트가 기억을 끄면 기존 대기열을 거절 처리하거나 시도 횟수를 늘리지 않는다", async () => {
  const f = fixture();
  f.store.enqueueMemoryUpload({ eventId: "off-check", projectId: f.project.id, refType: "owner_note", refId: "source", body: JSON.stringify({ event_id: "off-check", source: { task_id: f.task.id } }) });
  f.store.setProjectMemory(f.project.id, false);
  await f.memory.flush(f.store);
  expect(f.store.getMemoryUpload("off-check")).toMatchObject({ status: "pending", attempts: 0 });
});

test("일시적인 연결 실패가 여섯 번을 넘어도 저장 원문은 다시 보낼 대기열에 남는다", async () => {
  const f = fixture(); f.down();
  f.store.enqueueMemoryUpload({ eventId: "retry-check", projectId: f.project.id, refType: "owner_note", refId: "source", body: JSON.stringify({ event_id: "retry-check", source: { task_id: f.task.id } }) });
  f.store.settleMemoryUpload("retry-check", { status: "pending", attempts: 6, nextAt: new Date(0).toISOString() });
  await f.memory.flush(f.store);
  expect(f.store.getMemoryUpload("retry-check")).toMatchObject({ status: "pending", attempts: 7 });
});
