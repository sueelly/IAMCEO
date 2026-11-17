import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../server/bus.ts";
import { openDb } from "../server/db.ts";
import { Store } from "../server/store.ts";
import { DevMemory, memoryProjectId, type Experience } from "../server/integrations/dev-memory.ts";
import { MEMORY_FEEDBACK_SCHEMA, MemoryFeedback } from "../server/integrations/memory-feedback.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); });
const KEY = "feedback-fixture-key-not-a-real-credential";

function fixture() {
  const isolated = createIsolatedRuntime(), path = join(isolated.paths.iamceoHome, "feedback.db");
  let db = openDb(path), store = new Store(db, new Bus());
  db.exec(MEMORY_FEEDBACK_SCHEMA);
  const project = store.createProject({ name: "기억 활용", cwd: isolated.paths.work });
  const other = store.createProject({ name: "다른 프로젝트", cwd: isolated.paths.work });
  const worker = store.createMember({ projectId: project.id, handle: "worker", name: "담당", kind: "worker", origin: "runner", status: "idle" });
  const peer = store.createMember({ projectId: project.id, handle: "peer", name: "다른 담당", kind: "worker", origin: "runner", status: "idle" });
  const task = store.ensureSourceTask({ projectId: project.id, sourceRef: "current", title: "현재 업무", origin: "owner" }).task;
  const nextTask = store.ensureSourceTask({ projectId: project.id, sourceRef: "next", title: "다음 업무", origin: "owner" }).task;
  const foreignTask = store.ensureSourceTask({ projectId: other.id, sourceRef: "foreign", title: "다른 범위", origin: "owner" }).task;
  const records = new Map<string, Experience>(), votes = new Map<string, string>(), calls: any[] = [];
  let failures = 0, lost = 0, ack = "normal", clock = Date.parse("2026-11-18T00:00:00Z"), beforeReply: (() => Promise<void>) | null = null;
  const gateway = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    if (new URL(req.url).pathname !== "/v1/feedback") return new Response(null, { status: 404 });
    if (req.headers.get("authorization") !== `Bearer ${KEY}`) return new Response(null, { status: 401 });
    const body = await req.json() as any; calls.push(body);
    if (failures-- > 0) return Response.json({ error: "temporary" }, { status: 503 });
    if (ack === "reject") return Response.json({ error: "invalid_memory_request" }, { status: 400 });
    const record = records.get(body.id);
    if (!record || record.project_id !== body.project_id || record.source.task_id === body.feedback.task_id) return new Response(null, { status: 400 });
    const key = `${body.id}/${body.feedback.task_id}/${body.feedback.turn_id}`;
    if (!votes.has(key)) votes.set(key, body.feedback.outcome);
    await beforeReply?.();
    if (lost-- > 0) return new Response("lost acknowledgement", { status: 502 });
    if (ack === "empty") return Response.json({});
    const counts: Record<string, number> = {};
    for (const [id, outcome] of votes) if (id.startsWith(body.id + "/")) counts[outcome] = (counts[outcome] ?? 0) + 1;
    return Response.json({ ...record, id: ack === "wrong-id" ? "exp-wrong" : record.id,
      project_id: ack === "wrong-project" ? "iamceo-other" : record.project_id,
      feedback: ack === "missing-vote" ? {} : counts });
  } });
  const keyFile = join(isolated.paths.iamceoHome, "memory-key"); writeFileSync(keyFile, KEY, { mode: 0o600 });
  const memory = new DevMemory({ baseUrl: `http://127.0.0.1:${gateway.port}`, keyFile, projects: [project.id, other.id] });
  memory.setProjectGate(id => store.getProject(id)?.memory?.on ?? false);
  const components: MemoryFeedback[] = [];
  const make = () => { const component = new MemoryFeedback(store, memory, { now: () => clock, retryMs: 10 }); components.push(component); return component; };
  const feedback = make();
  const experience = (id = "exp-earlier", sourceTaskId = "tk_previous", projectId = project.id): Experience => {
    const value: Experience = { id, project_id: memoryProjectId(projectId), event_id: "record-" + id, kind: "lesson",
      summary: "같은 입력을 중복 전송하지 않은 검증", content: "이전 업무에서 직접 확인한 결과입니다.", source: { task_id: sourceTaskId, service: "iamceo" } };
    records.set(id, value); return value;
  };
  const row = (id = "exp-earlier") => store.db.query<any, [string]>("SELECT * FROM memory_feedback_exposures WHERE experience_id=?").get(id)!;
  cleanup.push(async () => { for (const c of components) await c.stop(); await gateway.stop(true); db.close(); await isolated.stop(); });
  return { isolated, project, other, worker, peer, task, nextTask, foreignTask, feedback, memory, records, votes, calls,
    get store() { return store; }, experience, row, make,
    fail(n: number) { failures = n; }, lose(n: number) { lost = n; }, ack(value: string) { ack = value; },
    advance(ms = 60_000) { clock += ms; }, beforeReply(fn: () => Promise<void>) { beforeReply = fn; },
    async reopen() { for (const c of components) await c.stop(); db.close(); db = openDb(path); store = new Store(db, new Bus()); return make(); } };
}

test("새 검색에 받은 타 업무 기억만 해당 직원·현재 업무의 미평가 항목으로 남긴다", () => {
  const f = fixture(), old = f.experience(), own = f.experience("exp-own", f.task.id), foreign = f.experience("exp-foreign", "tk_previous", f.other.id);
  f.store.recordMemorySearch({ projectId: f.project.id, memberId: f.worker.id, taskId: f.task.id, trigger: "tool", queryHash: "old", status: "ok", resultIds: ["exp-historical"], block: null, detail: null });
  expect(f.feedback.pending(f.worker, f.task.id)).toEqual([]);
  expect(f.feedback.register(f.worker, f.task.id, [old, own, foreign])).toBe(1);
  expect(f.feedback.register(f.worker, f.task.id, [old])).toBe(0);
  expect(f.feedback.pending(f.worker, f.task.id)).toMatchObject([{ id: old.id, summary: old.summary, sourceTaskId: "tk_previous" }]);
  expect(f.feedback.pending(f.peer, f.task.id)).toEqual([]);
  expect(f.feedback.pending(f.worker, f.nextTask.id)).toEqual([]);
  expect(f.feedback.pending(f.worker, null)).toEqual([]);
});

test("자동 기억은 입력 전달 영수증 전에는 평가를 요구하지 않고 재시작 뒤 전달되면 활성화한다", async () => {
  const f = fixture(), memory = f.experience();
  const first = f.store.enqueue({ projectId: f.project.id, memberId: f.worker.id, taskId: f.task.id, kind: "instruction", text: "현재 업무" });
  const second = f.store.enqueue({ projectId: f.project.id, memberId: f.worker.id, taskId: f.task.id, kind: "instruction", text: "현재 업무 이어서" });
  expect(f.feedback.register(f.worker, f.task.id, [memory], { deliveryIds: [first.id] })).toBe(1);
  expect(f.feedback.register(f.worker, f.task.id, [memory], { deliveryIds: [second.id] })).toBe(0);
  expect(f.feedback.pending(f.worker, f.task.id)).toEqual([]);
  expect(f.feedback.status()).toMatchObject({ unassessed: 0, awaitingDelivery: 1 });
  expect(() => f.feedback.assess(f.worker, f.task.id, memory.id, "not_used", "아직 전달받지 못했습니다")).toThrow();
  const restarted = await f.reopen();
  expect(restarted.pending(f.worker, f.task.id)).toEqual([]);
  f.store.markDelivered(second.id);
  expect(restarted.pending(f.worker, f.task.id)).toMatchObject([{ id: memory.id }]);
  expect(restarted.status()).toMatchObject({ unassessed: 1, awaitingDelivery: 0 });
  restarted.assess(f.worker, f.task.id, memory.id, "not_used", "받았으나 이번 조건에 해당하지 않았습니다");
  expect(f.calls).toEqual([]);
});

test("다른 업무·직원의 입력과 미분류 업무는 자동 기억 수신을 증명하지 않는다", () => {
  const f = fixture(), memory = f.experience();
  const own = f.store.enqueue({ projectId: f.project.id, memberId: f.worker.id, taskId: f.task.id, kind: "instruction", text: "현재 업무" });
  const next = f.store.enqueue({ projectId: f.project.id, memberId: f.worker.id, taskId: f.nextTask.id, kind: "instruction", text: "다음 업무" });
  const peer = f.store.enqueue({ projectId: f.project.id, memberId: f.peer.id, taskId: f.task.id, kind: "instruction", text: "다른 직원 업무" });
  for (const d of [own, next, peer]) f.store.markDelivered(d.id);
  expect(f.feedback.register(f.worker, f.task.id, [memory], { deliveryIds: [next.id, peer.id, "missing"] })).toBe(0);
  expect(f.feedback.register(f.worker, null, [memory], { deliveryIds: [own.id] })).toBe(0);
  expect(f.feedback.pending(f.worker, null)).toEqual([]);
});

test("첫 입력을 취소했어도 같은 업무의 캐시 재전달 영수증으로 기존 노출을 활성화한다", async () => {
  const f = fixture(), memory = f.experience();
  const source = f.store.createMessage({ projectId: f.project.id, taskId: f.task.id, kind: "진행", mine: true, body: "최초 지시" });
  const first = f.store.enqueue({ projectId: f.project.id, memberId: f.worker.id, taskId: f.task.id, kind: "user_message", text: "최초 지시", refType: "message", refId: source.id });
  f.feedback.register(f.worker, f.task.id, [memory], { deliveryIds: [first.id] });
  expect(f.store.cancelPendingFor("message", source.id)).toBe(1);
  const cached = f.store.enqueue({ projectId: f.project.id, memberId: f.worker.id, taskId: f.task.id, kind: "instruction", text: "같은 검색 결과 재사용" });
  expect(f.feedback.registerCached(f.worker, f.task.id, [memory.id], [cached.id])).toBe(true);
  expect(f.feedback.pending(f.worker, f.task.id)).toEqual([]);
  const restarted = await f.reopen(); f.store.markDelivered(cached.id);
  expect(restarted.pending(f.worker, f.task.id)).toMatchObject([{ id: memory.id }]);
});

test("캐시는 이전 범위의 검색을 새 평가로 복원하지 않고 하나라도 출처가 없으면 변경하지 않는다", () => {
  const f = fixture(), memory = f.experience();
  const first = f.store.enqueue({ projectId: f.project.id, memberId: f.worker.id, taskId: f.task.id, kind: "instruction", text: "현재 입력" });
  const next = f.store.enqueue({ projectId: f.project.id, memberId: f.worker.id, taskId: f.task.id, kind: "instruction", text: "캐시 입력" });
  f.feedback.register(f.worker, f.task.id, [memory], { deliveryIds: [first.id] });
  expect(f.feedback.registerCached(f.worker, f.task.id, [memory.id, "exp-history"], [next.id])).toBe(false);
  expect(JSON.parse(f.row().delivery_ids_json)).toEqual([first.id]);
  expect(f.feedback.registerCached(f.worker, f.nextTask.id, [memory.id], [next.id])).toBe(false);
  expect(f.feedback.registerCached(f.peer, f.task.id, [memory.id], [next.id])).toBe(false);
  expect(f.feedback.registerCached(f.worker, null, [memory.id], [next.id])).toBe(false);
  f.store.markDelivered(next.id);
  expect(f.feedback.pending(f.worker, f.task.id)).toEqual([]);
  expect(f.feedback.status()).toMatchObject({ awaitingDelivery: 1, unassessed: 0 });
  expect(f.feedback.registerCached(f.worker, f.task.id, [], [next.id])).toBe(true);
});

test("전달 전에 다른 업무로 재분류한 입력은 이전 업무의 자동 기억을 활성화하지 않는다", () => {
  const f = fixture(), memory = f.experience();
  const input = f.store.enqueue({ projectId: f.project.id, memberId: f.worker.id, taskId: f.task.id, kind: "instruction", text: "업무" });
  f.feedback.register(f.worker, f.task.id, [memory], { deliveryIds: [input.id] });
  // The classification transaction can move a queued envelope before transport.
  f.store.db.query("UPDATE deliveries SET task_id=? WHERE id=?").run(f.nextTask.id, input.id);
  f.store.markDelivered(input.id);
  expect(f.feedback.pending(f.worker, f.task.id)).toEqual([]);
  expect(f.feedback.status()).toMatchObject({ unassessed: 0, awaitingDelivery: 1 });
  expect(f.feedback.register(f.worker, f.task.id, [memory])).toBe(0);
  expect(f.feedback.pending(f.worker, f.task.id)).toMatchObject([{ id: memory.id }]);
});

test("받은 뒤 업무를 합쳐도 미평가 기억을 이어 찾고 원래 출처와 전송 ID를 보존한다", async () => {
  const f = fixture(), memory = f.experience();
  f.feedback.register(f.worker, f.task.id, [memory]);
  const original = f.row();
  f.store.markTaskMerged(f.task.id, f.nextTask.id, "fixture");
  expect(f.feedback.pending(f.worker, f.nextTask.id)).toMatchObject([{ id: memory.id, sourceTaskId: memory.source.task_id }]);
  expect(f.feedback.register(f.worker, f.nextTask.id, [memory])).toBe(0);
  const assessed = f.feedback.assess(f.worker, f.nextTask.id, memory.id, "helped", "합친 업무의 검증에도 적용했습니다");
  expect(assessed.id).toBe(original.id);
  expect(f.row()).toMatchObject({ task_id: f.task.id, scope: f.task.id, source_task_id: memory.source.task_id });
  expect(f.feedback.pending(f.worker, f.task.id)).toEqual([]);
  expect(f.feedback.pending(f.worker, f.nextTask.id)).toEqual([]);
  await f.feedback.flush();
  expect(f.calls[0].feedback).toMatchObject({ task_id: f.task.id, turn_id: original.id });
  expect(f.votes.size).toBe(1);
});

test("합친 업무 자체의 기억은 원래 ID가 달라도 새 평가를 만들지 않는다", () => {
  const f = fixture(), memory = f.experience("exp-merged-self", f.nextTask.id);
  f.feedback.register(f.worker, f.task.id, [memory]);
  f.store.markTaskMerged(f.task.id, f.nextTask.id, "fixture");
  expect(f.feedback.pending(f.worker, f.nextTask.id)).toEqual([]);
  expect(f.feedback.pending(f.worker, f.task.id)).toEqual([]);
  expect(f.feedback.status()).toMatchObject({ unassessed: 0, awaitingDelivery: 0 });
  expect(() => f.feedback.assess(f.worker, f.nextTask.id, memory.id, "helped", "자기 업무이므로 평가하면 안 됩니다")).toThrow();
  expect(f.feedback.register(f.worker, f.nextTask.id, [f.experience("exp-old-self", f.task.id)])).toBe(0);
  expect(f.row(memory.id)).toMatchObject({ task_id: f.task.id, source_task_id: f.nextTask.id, status: "unassessed" });
  expect(f.calls).toEqual([]);
});

test("합치기 전 두 업무에서 받은 같은 기억은 한 번 평가하고 중복 투표하지 않는다", async () => {
  const f = fixture(), memory = f.experience();
  f.feedback.register(f.worker, f.task.id, [memory]);
  f.feedback.register(f.worker, f.nextTask.id, [memory]);
  f.store.markTaskMerged(f.task.id, f.nextTask.id, "fixture");
  expect(f.feedback.pending(f.worker, f.nextTask.id)).toHaveLength(1);
  const first = f.feedback.assess(f.worker, f.nextTask.id, memory.id, "helped", "같은 기억을 통합 검증에 적용했습니다");
  expect(f.feedback.assess(f.worker, f.task.id, memory.id, "helped", "같은 기억을 통합 검증에 적용했습니다").id).toBe(first.id);
  expect(() => f.feedback.assess(f.worker, f.nextTask.id, memory.id, "contradicted", "이전 평가를 덮을 수 없습니다")).toThrow();
  expect(f.feedback.pending(f.worker, f.nextTask.id)).toEqual([]);
  expect(f.feedback.status()).toMatchObject({ unassessed: 0, awaitingDelivery: 0, pending: 1 });
  await f.feedback.flush();
  expect(f.calls).toHaveLength(1); expect(f.votes.size).toBe(1);
  expect(f.store.db.query<{ count: number }, []>("SELECT COUNT(*) count FROM memory_feedback_exposures").get()!.count).toBe(2);
});

test("합쳐진 옛 업무의 전달 영수증은 현재 업무에서도 유효하며 캐시는 새 노출을 만들지 않는다", () => {
  const f = fixture(), memory = f.experience();
  const first = f.store.enqueue({ projectId: f.project.id, memberId: f.worker.id, taskId: f.task.id, kind: "instruction", text: "옛 업무 입력" });
  f.feedback.register(f.worker, f.task.id, [memory], { deliveryIds: [first.id] });
  f.store.markTaskMerged(f.task.id, f.nextTask.id, "fixture");
  const second = f.store.enqueue({ projectId: f.project.id, memberId: f.worker.id, taskId: f.nextTask.id, kind: "instruction", text: "합친 뒤 입력" });
  expect(f.feedback.registerCached(f.worker, f.nextTask.id, [memory.id], [second.id])).toBe(true);
  expect(f.feedback.pending(f.worker, f.nextTask.id)).toEqual([]);
  f.store.markDelivered(second.id);
  expect(f.feedback.pending(f.worker, f.nextTask.id)).toMatchObject([{ id: memory.id }]);
  const fresh = f.experience("exp-after-merge");
  expect(f.feedback.register(f.worker, f.nextTask.id, [fresh], { deliveryIds: [first.id] })).toBe(1);
  expect(f.feedback.pending(f.worker, f.nextTask.id)).toHaveLength(1);
  f.store.markDelivered(first.id);
  expect(f.feedback.pending(f.worker, f.nextTask.id)).toHaveLength(2);
  expect(f.row(fresh.id)).toMatchObject({ task_id: f.nextTask.id, source_task_id: fresh.source.task_id });
});

test("사용하지 않았다는 명시 평가는 로컬에 남기고 긍정·부정 투표로 전송하지 않는다", async () => {
  const f = fixture(); f.feedback.register(f.worker, f.task.id, [f.experience()]);
  const assessment = f.feedback.assess(f.worker, f.task.id, "exp-earlier", "not_used", "이번 변경에는 해당 조건이 없어 적용하지 않았습니다");
  expect(assessment).toMatchObject({ outcome: "not_used", status: "not_used" });
  expect(f.feedback.pending(f.worker, f.task.id)).toEqual([]);
  await f.feedback.flush();
  expect(f.calls).toEqual([]); expect(f.votes.size).toBe(0);
  expect(f.feedback.status()).toMatchObject({ notUsed: 1, pending: 0, sent: 0, unassessed: 0 });
});

test("직원의 명시 평가만 영속 큐에 넣고 해당 기억·프로젝트의 영수증 뒤에 전송 완료한다", async () => {
  const f = fixture(); f.feedback.register(f.worker, f.task.id, [f.experience()]);
  expect(f.feedback.status()).toMatchObject({ unassessed: 1, pending: 0 });
  const assessment = f.feedback.assess(f.worker, f.task.id, "exp-earlier", "helped", "중복 입력 회귀 검사를 구성할 때 적용했습니다");
  expect(assessment).toMatchObject({ status: "pending", attempts: 0 });
  expect(f.calls).toHaveLength(0);
  await f.feedback.flush();
  expect(f.calls).toEqual([{ project_id: memoryProjectId(f.project.id), id: "exp-earlier", feedback: { task_id: f.task.id, turn_id: assessment.id, outcome: "helped" } }]);
  expect(f.row()).toMatchObject({ status: "sent", attempts: 1, reason: "중복 입력 회귀 검사를 구성할 때 적용했습니다", last_error: null });
  expect(f.votes.size).toBe(1); expect(f.feedback.status(f.project.id)).toMatchObject({ sent: 1, pending: 0 });
});

test("미노출 기억·다른 직원·다른 업무·다른 프로젝트로 평가 범위를 넓히지 않는다", () => {
  const f = fixture(); f.feedback.register(f.worker, f.task.id, [f.experience()]);
  for (const [member, task, id] of [[f.worker, f.task.id, "exp-unseen"], [f.peer, f.task.id, "exp-earlier"], [f.worker, f.nextTask.id, "exp-earlier"], [f.worker, f.foreignTask.id, "exp-earlier"]] as const) {
    expect(() => f.feedback.assess(member, task, id, "helped", "관찰한 적용 결과")).toThrow();
  }
  expect(() => f.feedback.assess({ ...f.worker, projectId: f.other.id }, f.task.id, "exp-earlier", "helped", "관찰한 적용 결과")).toThrow();
  expect(f.row().status).toBe("unassessed"); expect(f.calls).toEqual([]);
});

test("같은 평가 재요청은 한 행이고 다른 평가나 근거로 앞 판단을 덮지 않는다", async () => {
  const f = fixture(); f.feedback.register(f.worker, f.task.id, [f.experience()]);
  const first = f.feedback.assess(f.worker, f.task.id, "exp-earlier", "did_not_help", "이번 문제의 조건과 달랐습니다");
  expect(f.feedback.assess(f.worker, f.task.id, "exp-earlier", "did_not_help", "이번 문제의 조건과 달랐습니다").id).toBe(first.id);
  expect(() => f.feedback.assess(f.worker, f.task.id, "exp-earlier", "helped", "생각이 바뀌었습니다")).toThrow();
  expect(() => f.feedback.assess(f.worker, f.task.id, "exp-earlier", "did_not_help", "다른 설명")).toThrow();
  await f.feedback.flush(); await f.feedback.flush(); expect(f.calls).toHaveLength(1);
  expect(f.row()).toMatchObject({ outcome: "did_not_help", reason: "이번 문제의 조건과 달랐습니다" });
});

test("네트워크 실패 뒤 DB를 다시 열어도 평가와 시도 수를 유지하며 같은 ID로 재전송한다", async () => {
  const f = fixture(); f.feedback.register(f.worker, f.task.id, [f.experience()]);
  f.feedback.assess(f.worker, f.task.id, "exp-earlier", "contradicted", "현재의 동일 조건 검사에서 결과가 달랐습니다");
  f.fail(1); await f.feedback.flush();
  expect(f.row()).toMatchObject({ status: "pending", attempts: 1 });
  const restarted = await f.reopen(); await restarted.flush(); expect(f.calls).toHaveLength(1);
  f.advance(); await restarted.flush();
  expect(f.row()).toMatchObject({ status: "sent", attempts: 2 });
  expect(f.calls[1]).toEqual(f.calls[0]); expect(f.votes.size).toBe(1);
});

test("여섯 번을 넘긴 일시 장애도 기록을 포기하지 않고 지연 간격을 두고 다시 보낸다", async () => {
  const f = fixture(); f.feedback.register(f.worker, f.task.id, [f.experience()]);
  f.feedback.assess(f.worker, f.task.id, "exp-earlier", "helped", "재시도 경계를 정하는 데 사용했습니다");
  f.fail(8);
  for (let i = 0; i < 8; i++) { f.advance(3_600_000); await f.feedback.flush(); }
  expect(f.row()).toMatchObject({ status: "pending", attempts: 8 });
  expect(f.feedback.status()).toMatchObject({ pending: 1, rejected: 0 });
  f.advance(3_600_000); await f.feedback.flush(); expect(f.row()).toMatchObject({ status: "sent", attempts: 9 });
});

test("저장 뒤 응답이 유실되어도 동일 작업·턴을 재사용해 원격 투표를 중복하지 않는다", async () => {
  const f = fixture(); f.feedback.register(f.worker, f.task.id, [f.experience()]);
  f.feedback.assess(f.worker, f.task.id, "exp-earlier", "helped", "같은 조건의 검증을 추가했습니다");
  f.lose(1); await f.feedback.flush(); expect(f.votes.size).toBe(1); expect(f.row().status).toBe("pending");
  f.advance(); await f.feedback.flush(); expect(f.votes.size).toBe(1); expect(f.row()).toMatchObject({ status: "sent", attempts: 2 });
  expect(f.calls[0]).toEqual(f.calls[1]);
});

test("새 평가의 영수증은 과거 직접 평가와 충돌하지 않으면서 재시도 ID를 유지한다", async () => {
  const f = fixture(); f.feedback.register(f.worker, f.task.id, [f.experience()]);
  const legacy = `exp-earlier/${f.task.id}/iamceo-${f.worker.id}`;
  f.votes.set(legacy, "contradicted");
  const assessment = f.feedback.assess(f.worker, f.task.id, "exp-earlier", "helped", "새 조건에서 실제로 적용한 결과입니다");
  await f.feedback.flush();
  expect(f.row()).toMatchObject({ status: "sent", attempts: 1 });
  expect(f.calls[0].feedback.turn_id).toBe(assessment.id);
  expect(f.votes.get(legacy)).toBe("contradicted");
  expect(f.votes.size).toBe(2);
});

for (const ack of ["empty", "wrong-id", "wrong-project", "missing-vote"]) {
  test(`HTTP 200이어도 ${ack} 응답은 해당 평가의 전송 완료 근거가 아니다`, async () => {
    const f = fixture(); f.feedback.register(f.worker, f.task.id, [f.experience()]);
    f.feedback.assess(f.worker, f.task.id, "exp-earlier", "helped", "도움이 된 조건을 검증했습니다");
    f.ack(ack); await f.feedback.flush(); expect(f.row()).toMatchObject({ status: "pending", attempts: 1 });
    expect(f.row().last_error).toContain("영수증");
    f.ack("normal"); f.advance(); await f.feedback.flush(); expect(f.row().status).toBe("sent");
  });
}

test("영구 거절은 성공으로 표시하지 않고 진단에 남긴다", async () => {
  const f = fixture(); f.feedback.register(f.worker, f.task.id, [f.experience()]);
  f.feedback.assess(f.worker, f.task.id, "exp-earlier", "helped", "실행 결과에 적용했습니다");
  f.ack("reject"); await f.feedback.flush(); f.advance(); await f.feedback.flush();
  expect(f.calls).toHaveLength(1); expect(f.row().status).toBe("rejected");
  expect(f.feedback.status()).toMatchObject({ sent: 0, rejected: 1 }); expect(f.feedback.status().lastError).toContain("400");
});

test("프로젝트 연결을 끄면 기존 평가는 보관하고 전송하지 않으며 다시 켜면 이어 보낸다", async () => {
  const f = fixture(); f.feedback.register(f.worker, f.task.id, [f.experience()]);
  f.feedback.assess(f.worker, f.task.id, "exp-earlier", "helped", "현재 기준에 적용했습니다");
  f.store.setProjectMemory(f.project.id, false); await f.feedback.flush();
  expect(f.calls).toEqual([]); expect(f.row()).toMatchObject({ attempts: 0, status: "pending" });
  expect(f.feedback.register(f.worker, f.task.id, [f.experience("exp-another")])).toBe(0);
  f.store.setProjectMemory(f.project.id, true); await f.feedback.flush(); expect(f.row().status).toBe("sent");
});

test("꺼진 프로젝트의 오래된 대기열이 다른 프로젝트의 평가 전송을 막지 않는다", async () => {
  const f = fixture();
  const older = Array.from({ length: 26 }, (_, n) => f.experience(`exp-disabled-${n}`));
  f.feedback.register(f.worker, f.task.id, older);
  for (const item of older) f.feedback.assess(f.worker, f.task.id, item.id, "helped", "해당 조건의 검증에 적용했습니다");
  f.store.setProjectMemory(f.project.id, false);
  const worker = f.store.createMember({ projectId: f.other.id, handle: "enabled", name: "연결된 담당", kind: "worker", origin: "runner", status: "idle" });
  const current = f.experience("exp-enabled", "prior-task", f.other.id);
  f.feedback.register(worker, f.foreignTask.id, [current]);
  f.feedback.assess(worker, f.foreignTask.id, current.id, "helped", "검증에 적용했습니다");
  await f.feedback.flush();
  expect(f.calls.map(call => call.id)).toEqual([current.id]);
  expect(f.feedback.status(f.other.id)).toMatchObject({ sent: 1, pending: 0 });
  expect(f.feedback.status(f.project.id)).toMatchObject({ pending: 26, sent: 0 });
});

test("평가 저장을 감싼 보고 거래가 취소되면 평가도 취소되고 전송하지 않는다", async () => {
  const f = fixture(); f.feedback.register(f.worker, f.task.id, [f.experience()]);
  expect(() => f.store.transaction(() => {
    f.feedback.assess(f.worker, f.task.id, "exp-earlier", "helped", "실제 검증에 적용했습니다");
    throw new Error("report rejected");
  })).toThrow("report rejected");
  await f.feedback.flush(); expect(f.row().status).toBe("unassessed"); expect(f.calls).toEqual([]);
});

test("근거 없는 평가를 받지 않고 비밀이 든 근거를 저장하지 않는다", () => {
  const f = fixture(), memory = f.experience(); memory.summary = `검증 기록 ${KEY}`;
  f.feedback.register(f.worker, f.task.id, [memory]);
  expect(f.feedback.pending(f.worker, f.task.id)[0]!.summary).not.toContain(KEY);
  for (const reason of ["", "  ", `API 연결 ${KEY}`]) expect(() => f.feedback.assess(f.worker, f.task.id, memory.id, "helped", reason)).toThrow();
  expect(f.row().status).toBe("unassessed");
});

test("전송 중 종료하면 진행 요청의 영수증을 마친 뒤 나머지 평가는 다음 실행에 남긴다", async () => {
  const f = fixture(); f.feedback.register(f.worker, f.task.id, [f.experience(), f.experience("exp-next")]);
  for (const id of ["exp-earlier", "exp-next"]) f.feedback.assess(f.worker, f.task.id, id, "helped", "확인한 조건에 적용했습니다");
  let release!: () => void, seen!: () => void;
  const entered = new Promise<void>(resolve => { seen = resolve; }), hold = new Promise<void>(resolve => { release = resolve; });
  f.beforeReply(async () => { seen(); await hold; });
  const running = f.feedback.flush(); await entered;
  const stopping = f.feedback.stop(); release(); await stopping; await running;
  expect(f.calls).toHaveLength(1); expect(f.feedback.status()).toMatchObject({ sent: 1, pending: 1 });
});

test("겹친 전송 루프는 같은 평가를 동시에 보내지 않는다", async () => {
  const f = fixture(); f.feedback.register(f.worker, f.task.id, [f.experience()]);
  f.feedback.assess(f.worker, f.task.id, "exp-earlier", "helped", "같은 입력을 한 번 전달하도록 적용했습니다");
  let release!: () => void, seen!: () => void;
  const entered = new Promise<void>(resolve => { seen = resolve; }), hold = new Promise<void>(resolve => { release = resolve; });
  f.beforeReply(async () => { seen(); await hold; });
  const first = f.feedback.flush(); await entered;
  const overlapping = f.feedback.flush();
  expect(overlapping).toBe(first);
  await f.make().flush();
  expect(f.calls).toHaveLength(1);
  release(); await Promise.all([first, overlapping]);
  expect(f.row()).toMatchObject({ status: "sent", attempts: 1 });
});

test("재시작한 주기 전송은 남은 평가를 다시 보내고 종료 뒤에는 새 요청을 시작하지 않는다", async () => {
  const f = fixture(); f.feedback.register(f.worker, f.task.id, [f.experience()]);
  f.feedback.assess(f.worker, f.task.id, "exp-earlier", "helped", "장애 복구 조건에 적용했습니다");
  f.fail(1); await f.feedback.flush();
  const restarted = await f.reopen(); f.advance(); restarted.start(5);
  const until = Date.now() + 1_000;
  while (f.row().status !== "sent" && Date.now() < until) await Bun.sleep(5);
  expect(f.row()).toMatchObject({ status: "sent", attempts: 2 });
  await restarted.stop();
  restarted.register(f.worker, f.task.id, [f.experience("exp-after-stop")]);
  restarted.assess(f.worker, f.task.id, "exp-after-stop", "helped", "새 조건에 적용했습니다");
  await restarted.flush(); await Bun.sleep(15);
  expect(f.calls).toHaveLength(2); expect(f.row("exp-after-stop").status).toBe("pending");
});
