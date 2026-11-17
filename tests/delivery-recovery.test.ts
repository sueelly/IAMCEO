import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Bus } from "../server/bus.ts";
import { openDb } from "../server/db.ts";
import { DeliveryRecovery } from "../server/delivery-recovery.ts";
import { ApiError, Store } from "../server/store.ts";
import type { DeliveryDispatch } from "../server/service-contracts.ts";
import type { DeliveryBaseline, DeliveryInspection, DeliveryProbe, DeliveryRepair, RunnerMember, SendResult } from "../server/runner/types.ts";
import type { Delivery, WsEvent } from "../shared/types.ts";

// Memory SQLite + fake adapter: no config/provider homes, sockets, processes or live HTTP.
const cleanup: (() => void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) close(); });

function setup() {
  const db = openDb(":memory:");
  cleanup.push(() => db.close());
  const bus = new Bus();
  const events: WsEvent[] = [];
  bus.subscribe(event => events.push(event));
  const store = new Store(db, bus);
  const project = store.createProject({ name: "복구 시험", cwd: "/private/tmp/iamceo-fake-work" });
  let time = Date.now();
  let random = 0;
  const makeMember = (handle = "worker") => store.createMember({ projectId: project.id, handle, name: handle, kind: "worker", backend: "core", paneId: `terminal-${handle}`, sessionId: `session-${handle}` });
  const member = makeMember();
  const r = (id: string) => store.getDeliveryRecovery(id)!;
  const calls: string[] = [];
  const writes: DeliveryRepair[] = [];
  let service: DeliveryRecovery;
  let finalHook = (_request: DeliveryRepair) => {};
  let inspect = async (_member: RunnerMember, query: DeliveryProbe): Promise<DeliveryInspection> => observation(query);
  let result: SendResult = { ok: false, reason: "error", retryable: false, deliveryEffect: "unknown" };
  function observation(query: DeliveryProbe, patch: Partial<DeliveryInspection> = {}): DeliveryInspection {
    return { finding: "unknown", evidence: [{ source: "claude_log", verdict: "unknown", location: "none", code: "partial_log", complete: false, checkedAt: new Date(time).toISOString() }], receivedDeliveryIds: [], quiescence: "unresolved",
      snapshot: { identity: query.identity, observedAt: new Date(time).toISOString(), turn: 1, inputEpoch: 1, ownership: "verified", status: "idle", blockedReason: null, leaseActive: false, mutation: "none", composer: "empty", originalWrite: "unresolved", externalInput: false }, ...patch };
  }
  function absent(query: DeliveryProbe): DeliveryInspection {
    const value = observation(query, { finding: "not_received", quiescence: "settled", evidence: [{ source: "transport", verdict: "absent", location: "none", code: "not_written", complete: true, checkedAt: new Date(time).toISOString() }] });
    value.snapshot!.originalWrite = "settled";
    return value;
  }
  const runner = {
    inspectDelivery: async (member: RunnerMember, query: DeliveryProbe) => { calls.push(member.id); return inspect(member, query); },
    repairDelivery: async (member: RunnerMember, request: DeliveryRepair): Promise<SendResult> => {
      const dispatch = service.repair.load(member.id, request);
      if (!dispatch) return { ok: false, reason: "busy", retryable: true, deliveryEffect: "not_written" };
      // Model the adapter's mandatory final read under the same input mutex.
      const final = await inspect(member, dispatch);
      if (final.receivedDeliveryIds.length || final.snapshot?.leaseActive || final.snapshot?.composer === "different") return { ok: false, reason: "busy", retryable: true, deliveryEffect: "not_written" };
      finalHook(request);
      if (!service.repair.prepare(member.id, request, dispatch)) return { ok: false, reason: "busy", retryable: true, deliveryEffect: "not_written" };
      writes.push(request);
      return result.ok ? { ...result, receipt: { dispatchId: request.dispatchId, receivedAt: new Date(time).toISOString(), source: "transport" } } : result;
    },
  };
  function restart() { service = new DeliveryRecovery({ store, runner: () => runner, now: () => time, random: () => random }); return service; }
  restart();
  function enqueue(target = member, text = "지시"): Delivery {
    return store.enqueue({ projectId: project.id, memberId: target.id, kind: "instruction", text });
  }
  function envelope(ds: Delivery[], effect: "unknown" | "not_written" = "unknown", executionContracts?: DeliveryBaseline["executionContracts"]): DeliveryDispatch {
    const target = store.requireMember(ds[0].memberId);
    const dispatch = service.prepareDispatch(ds.map(d => d.id), { terminalId: target.paneId, sessionId: target.sessionId, sessionGeneration: store.memberRevisions(target.id).sessionGeneration, process: null }, { serverEpoch: "test-epoch", turn: 0, inputEpoch: 0, logs: [], capturedAt: new Date(time).toISOString(), executionContracts });
    service.recordResult(dispatch.dispatchId, { ok: false, reason: "error", retryable: false, deliveryEffect: effect });
    return dispatch;
  }
  async function due(id: string) { time = Date.parse(r(id).nextCheckAt!); await service.tick(); }
  return { db, store, bus, project, member, makeMember, enqueue, envelope, r, calls, writes, events, observation, absent, due, restart,
    get service() { return service; }, get now() { return time; }, set now(value: number) { time = value; },
    set inspect(value: typeof inspect) { inspect = value; }, set result(value: SendResult) { result = value; },
    set finalHook(value: typeof finalHook) { finalHook = value; }, set random(value: number) { random = value; } };
}

async function errorStatus(work: Promise<unknown>, status: number) {
  try { await work; throw new Error("expected ApiError"); }
  catch (error) { expect(error).toBeInstanceOf(ApiError); expect((error as ApiError).status).toBe(status); }
}

// Model accumulated, settled history without sending input or repeatedly running admission.
function settledHistory(f: ReturnType<typeof setup>, count: number) {
  const seed = f.envelope([f.enqueue()]);
  f.store.updateDispatch(seed.dispatchId, "unknown", "accepted");
  f.store.markDelivered(seed.items[0].deliveryId);
  f.store.updateDeliveryRecovery(seed.items[0].deliveryId, f.r(seed.items[0].deliveryId).version, { phase: "resolved" });
  for (let i = 1; i < count; i++) {
    const d = f.enqueue();
    f.store.saveDispatch({ ...seed, dispatchId: `history-${i}`, bundleMarker: `bundle-${i}`, transportState: "accepted",
      items: [{ deliveryId: d.id, ordinal: 0, sourceRevision: null }], markers: [{ deliveryId: d.id, marker: `marker-${i}` }] });
    f.store.markDelivered(d.id);
    f.store.updateDeliveryRecovery(d.id, f.r(d.id).version, { phase: "resolved" });
  }
}

describe("완료 기록이 쌓여도 서버 요청을 막지 않는다", () => {
  test("알림 집계는 완료된 전달의 재시도 정보를 반복해서 읽지 않는다", () => {
    const f = setup();
    settledHistory(f, 80);
    f.enqueue();
    let reads = 0;
    const read = f.store.getDeliveryRetry.bind(f.store);
    f.store.getDeliveryRetry = id => { reads++; return read(id); };
    expect(f.service.notices(f.project.id).members[0].undeliveredCount).toBe(1);
    expect(reads).toBeLessThanOrEqual(1);
  });

  test("입력 허가는 완료 전달을 모두 다시 읽지 않고 논리·물리 차단을 보존한다", () => {
    const f = setup();
    settledHistory(f, 80);
    let reads = 0;
    const get = f.store.getDelivery.bind(f.store);
    f.store.getDelivery = id => { reads++; return get(id); };
    expect(f.service.fenced(f.member.id)).toBe(false);
    expect(reads).toBeLessThan(2);
    const d = f.store.listDeliveries()[0];
    f.store.updateDeliveryRecovery(d.id, f.r(d.id).version, { phase: "checking" });
    expect(f.service.fenced(f.member.id)).toBe(true);
    f.store.updateDeliveryRecovery(d.id, f.r(d.id).version, { phase: "stopped" });
    expect(f.service.fenced(f.member.id)).toBe(false);
    const dispatch = f.store.listDispatches(f.member.id)[0];
    f.store.updateDispatch(dispatch.dispatchId, "accepted", "unknown");
    expect(f.service.fenced(f.member.id)).toBe(true);
  });

  test("복구 검사는 완료 봉투를 반복해서 읽지 않고 HTTP 타이머에 실행 기회를 준다", async () => {
    const f = setup();
    settledHistory(f, 80);
    let reads = 0;
    const get = f.store.getDispatch.bind(f.store);
    f.store.getDispatch = id => { reads++; return get(id); };
    let timerRan = false;
    const timer = setTimeout(() => { timerRan = true; }, 0);
    try {
      await f.service.tick();
      expect(timerRan).toBe(true);
      expect(reads).toBeLessThanOrEqual(80);
      expect(f.calls).toHaveLength(0);
      expect(f.writes).toHaveLength(0);
      expect(f.store.listDeliveries().every(d => d.status === "delivered")).toBe(true);
    } finally { clearTimeout(timer); }
  });

  test("입력 fence는 미확정 physical/logical 봉투만 읽고 과거 세대의 미확정 입력도 보존한다", () => {
    const f = setup();
    settledHistory(f, 40);
    const dispatches = f.store.listDispatches(f.member.id);
    const physical = dispatches[0], logical = dispatches[1];
    f.store.updateDispatch(physical.dispatchId, "accepted", "unknown");
    f.store.updateDeliveryRecovery(physical.items[0].deliveryId, f.r(physical.items[0].deliveryId).version, { phase: "stopped" });
    f.store.updateDeliveryRecovery(logical.items[0].deliveryId, f.r(logical.items[0].deliveryId).version, { phase: "checking" });
    f.db.query("UPDATE members SET session_generation = session_generation + 1 WHERE id = ?").run(f.member.id);
    let reads = 0;
    const get = f.store.getDispatch.bind(f.store);
    f.store.getDispatch = id => { reads++; return get(id); };
    expect(f.store.inputState(f.member.id).unresolvedDispatches.map(d => d.dispatchId)).toEqual([physical.dispatchId, logical.dispatchId]);
    expect(reads).toBeLessThanOrEqual(2);
  });

  test("검사 도중 취소된 지시를 다시 읽거나 전달하지 않는다", async () => {
    const f = setup();
    settledHistory(f, 60);
    const m = f.store.createMessage({ projectId: f.project.id, mine: true, kind: "나", body: "취소할 지시" });
    const d = f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, kind: "user_message", text: m.body, refType: "message", refId: m.id });
    const timer = setTimeout(() => { f.store.cancelPendingFor("message", m.id); }, 0);
    try {
      await f.service.tick();
      expect(f.store.getDelivery(d.id)).toBeNull();
      expect(f.calls).toHaveLength(0);
      expect(f.writes).toHaveLength(0);
    } finally { clearTimeout(timer); }
  });

  test("이미 고른 복구 대상도 검사 도중 직원이 삭제되면 건너뛴다", async () => {
    const f = setup();
    f.store.setDeliveryStatus(f.enqueue().id, "failed");
    settledHistory(f, 60);
    const timer = setTimeout(() => { f.store.removeMember(f.member.id); }, 0);
    try {
      await f.service.tick();
      expect(f.store.getMember(f.member.id)).toBeNull();
      expect(f.calls).toHaveLength(0);
      expect(f.writes).toHaveLength(0);
    } finally { clearTimeout(timer); }
  });
});

describe("영속 확인과 안전 fence", () => {
  test("주 세션 수신은 실패 표시와 메시지만 원자 정정하고 활동은 한 번이다", async () => {
    const f = setup();
    const message = f.store.createMessage({ projectId: f.project.id, mine: true, kind: "나", body: "대표 지시", targetMemberId: f.member.id, delivery: "failed" });
    const d = f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, kind: "user_message", text: message.body, refType: "message", refId: message.id });
    const dispatch = f.envelope([d]);
    f.inspect = async (_m, q) => f.observation(q, { finding: "received", receivedDeliveryIds: [d.id], quiescence: "settled" });
    await f.service.tick();
    expect(f.store.requireDelivery(d.id).status).toBe("delivered");
    expect(f.store.requireMessage(message.id).delivery).toBe("delivered");
    expect(f.r(d.id).phase).toBe("resolved");
    f.service.recordResult(dispatch.dispatchId, { ok: false, reason: "error", retryable: false, deliveryEffect: "unknown" });
    await f.service.tick();
    expect(f.store.requireDelivery(d.id).status).toBe("delivered");
    expect(f.store.listActivity(f.member.id)).toHaveLength(1);
    expect(f.writes).toHaveLength(0);
  });

  test("확인 간격 1/3/10/30/60초와 2분 예산은 재시작에도 남는다", async () => {
    const f = setup(); const d = f.enqueue(); f.envelope([d]);
    for (const delay of [1_000, 3_000, 10_000, 30_000, 60_000, 60_000]) {
      await f.service.tick();
      expect(Date.parse(f.r(d.id).nextCheckAt!) - f.now).toBe(delay);
      f.now += delay;
    }
    f.restart(); await f.service.tick();
    expect(f.r(d.id).activeCheckMs).toBe(120_000);
    expect(f.r(d.id).phase).toBe("needs_owner");
    expect(f.writes).toHaveLength(0);
    const op = { operationId: randomUUID(), expectedVersion: f.r(d.id).version, action: "recheck" as const };
    await f.service.recover(d.id, op);
    expect(f.r(d.id).activeCheckMs).toBe(120_000);
    expect(f.r(d.id).phase).toBe("needs_owner");
  });

  test("시계 역행은 예산을 줄이지 않고 큰 진행은 상한으로 제한한다", async () => {
    const f = setup(); const d = f.enqueue(); f.envelope([d]); await f.service.tick(); await f.due(d.id);
    const active = f.r(d.id).activeCheckMs;
    f.now -= 60_000;
    await f.service.recover(d.id, { operationId: randomUUID(), expectedVersion: f.r(d.id).version, action: "recheck" });
    await f.service.tick(); expect(f.r(d.id).activeCheckMs).toBe(active);
    f.now += 10_000_000; await f.service.tick();
    expect(f.r(d.id).activeCheckMs).toBe(120_000);
    expect(f.r(d.id).phase).toBe("needs_owner");
  });

  test.each(["working", "blocked"] as const)("%s 대기는 예산에서 제외하고 후속 urgent도 막는다", async status => {
    const f = setup(); const d = f.enqueue(); f.envelope([d]);
    const later = f.enqueue(); f.store.setDeliveryStatus(later.id, "queued");
    f.inspect = async (_m, q) => { const x = f.observation(q, { finding: "wait" }); x.snapshot!.status = status; return x; };
    await f.service.tick(); f.now += 1_000_000; await f.service.tick();
    expect(f.r(d.id).activeCheckMs).toBe(0);
    expect(f.r(d.id).phase).toBe("waiting");
    expect(f.service.fenced(f.member.id)).toBe(true);
    expect(f.service.notices(f.project.id).members[0].waitingBehindCount).toBe(1);
    f.inspect = async (_m, q) => f.observation(q);
    await f.due(d.id); expect(f.r(d.id).activeCheckMs).toBe(0);
  });

  test("유효 lease는 기록 스캔 0회이며 만료/해제 뒤 예산을 소모하지 않는다", async () => {
    const f = setup(); const d = f.enqueue(); const dispatch = f.envelope([d]);
    f.store.saveLease({ memberId: f.member.id, claimId: "claim", leaseId: "lease", identity: dispatch.identity, expiresAt: Date.now() + 60_000, lastInputSequence: 0 });
    await f.service.tick(); f.now += 1_000_000; await f.service.tick();
    expect(f.calls).toHaveLength(0); expect(f.r(d.id).activeCheckMs).toBe(0);
    f.store.removeLease(f.member.id, "claim"); await f.due(d.id);
    expect(f.calls).toHaveLength(1); expect(f.r(d.id).activeCheckMs).toBe(0);
  });

  test("중복 tick은 합치며 다른 직원은 느린 기록 조회와 독립적으로 진행한다", async () => {
    const f = setup(); const a = f.enqueue(); f.envelope([a]); const other = f.makeMember("other"); const b = f.enqueue(other); f.envelope([b]);
    let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
    f.inspect = async (m, q) => { if (m.id === f.member.id) await blocked; return f.observation(q, { finding: "received", receivedDeliveryIds: q.markers.map(x => x.deliveryId) }); };
    const first = f.service.tick(); const second = f.service.tick(); expect(first).toBe(second);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.store.requireDelivery(b.id).status).toBe("delivered");
    expect(f.store.requireDelivery(a.id).status).toBe("held");
    release(); await first; expect(f.calls).toHaveLength(2);
  });

  test("수신 기록과 같은 중복 초안은 delivered와 별도 fence를 유지한다", async () => {
    const f = setup(); const d = f.enqueue(); f.envelope([d]);
    f.inspect = async (_m, q) => { const x = f.observation(q, { finding: "received", receivedDeliveryIds: [d.id] }); x.snapshot!.composer = "matches"; return x; };
    await f.service.tick();
    const summary = f.service.notices(f.project.id).members[0];
    expect(summary).toMatchObject({ unknownCount: 0, undeliveredCount: 0, needsOwnerCount: 1 });
    expect(f.r(d.id).reason).toBe("duplicate_draft"); expect(f.service.fenced(f.member.id)).toBe(true);
    await errorStatus(f.service.recover(d.id, { operationId: randomUUID(), expectedVersion: f.r(d.id).version, action: "stop_retry" }), 409);
    f.inspect = async (_m, q) => f.observation(q);
    await f.due(d.id); expect(f.r(d.id).phase).toBe("resolved"); expect(f.writes).toHaveLength(0);
  });

  test("unknown은 빈 화면과 시간 경과만으로 재전송하지 않는다", async () => {
    const f = setup(); const d = f.enqueue(); f.envelope([d]);
    f.inspect = async (_m, q) => { const x = f.absent(q); x.snapshot!.originalWrite = "unresolved"; x.quiescence = "unresolved"; return x; };
    await f.service.tick(); f.now += 200_000; await f.service.tick();
    expect(f.writes).toHaveLength(0); expect(f.service.fenced(f.member.id)).toBe(true);
  });
});

describe("자동 재전송과 제출 복구", () => {
  test("같은 delivery/표식으로 2/10/30초 backoff, 최초 외 최대 3회, 재시작 상한", async () => {
    const f = setup(); const d = f.enqueue(); const dispatch = f.envelope([d]);
    f.inspect = async (_m, q) => f.absent(q);
    for (const delay of [2_000, 10_000, 30_000]) {
      await f.service.tick(); expect(Date.parse(f.r(d.id).nextCheckAt!) - f.now).toBe(delay);
      f.restart(); f.now += delay - 1; await f.service.tick();
      const count = f.writes.length; f.now++; await f.service.tick(); expect(f.writes).toHaveLength(count + 1);
    }
    await f.service.tick();
    expect(f.r(d.id)).toMatchObject({ autoAttempts: 3, phase: "needs_owner", reason: "retry_exhausted" });
    expect(f.store.listDeliveries()).toHaveLength(1);
    expect(f.store.getDispatch(dispatch.dispatchId)!.markers).toEqual(dispatch.markers);
    expect(f.writes.every(w => w.dispatchId !== dispatch.dispatchId && w.action === "resend")).toBe(true);
    expect(new Set(f.writes.map(w => w.dispatchId)).size).toBe(3);
    for (const write of f.writes) expect(f.store.getDispatch(write.dispatchId)!.markers).toEqual(dispatch.markers);
    f.restart(); f.now += 120_000; await f.service.tick(); expect(f.writes).toHaveLength(3);
  });

  test("jitter는 0~20%이고 GET이 재시도 예약을 바꾸지 않는다", async () => {
    const f = setup(); f.random = 1; const d = f.enqueue(); f.envelope([d]); f.inspect = async (_m, q) => f.absent(q);
    await f.service.tick(); expect(Date.parse(f.r(d.id).nextCheckAt!) - f.now).toBe(2_400);
    const before = f.r(d.id); const count = f.events.length;
    f.service.notices(f.project.id); f.service.memberNotices(f.member.id);
    expect(f.r(d.id)).toEqual(before); expect(f.events).toHaveLength(count);
  });

  test("옛 시도의 늦은 실패는 새 봉투의 unknown 물리 입력 fence를 해제하지 않는다", async () => {
    const f = setup(); const d = f.enqueue(); const original = f.envelope([d]);
    f.inspect = async (_m, q) => f.absent(q); f.result = { ok: false, reason: "error", retryable: false, deliveryEffect: "unknown" };
    await f.service.tick(); await f.due(d.id);
    const attempt = f.store.getDispatch(f.writes[0].dispatchId)!;
    expect(attempt.dispatchId).not.toBe(original.dispatchId); expect(attempt.transportState).toBe("unknown");
    const version = f.r(d.id).version;
    f.service.recordResult(original.dispatchId, { ok: false, reason: "down", retryable: true, deliveryEffect: "not_written" });
    expect(f.store.getDispatch(attempt.dispatchId)!.transportState).toBe("unknown"); expect(f.r(d.id).version).toBe(version);
    f.inspect = async (_m, q) => f.observation(q); await f.service.tick();
    expect(f.service.fenced(f.member.id)).toBe(true); expect(f.writes).toHaveLength(1);
  });

  test("재전송 직전 수신을 발견하면 입력하지 않고 다음 확인에서 정정한다", async () => {
    const f = setup(); const d = f.enqueue(); f.envelope([d]);
    let scans = 0;
    f.inspect = async (_m, q) => ++scans >= 3 ? f.observation(q, { finding: "received", receivedDeliveryIds: [d.id] }) : f.absent(q);
    await f.service.tick(); await f.due(d.id); expect(f.writes).toHaveLength(0);
    await f.due(d.id); expect(f.store.requireDelivery(d.id).status).toBe("delivered");
  });

  test("봉투의 전체 일치 초안은 Enter 1회만 하고 응답 유실에도 반복하지 않는다", async () => {
    const f = setup(); const d = f.enqueue(); const dispatch = f.envelope([d]);
    f.inspect = async (_m, q) => { const x = f.absent(q); x.finding = "draft_only"; x.snapshot!.composer = "matches"; x.snapshot!.originalWrite = "settled"; return x; };
    f.result = { ok: false, reason: "error", retryable: false, deliveryEffect: "unknown" };
    await f.service.tick();
    expect(f.writes.map(x => x.action)).toEqual(["submit_only"]);
    expect(f.store.getDispatch(dispatch.dispatchId)!.submitAttempts).toBe(1);
    expect(f.store.requireDelivery(d.id).status).toBe("held");
    f.restart(); await f.service.tick(); f.now += 120_000; await f.service.tick();
    expect(f.writes).toHaveLength(1); expect(f.r(d.id).autoAttempts).toBe(0);
  });

  test.each(["different", "unknown"] as const)("잘림/수정/placeholder composer=%s에는 Enter가 없다", async composer => {
    const f = setup(); const d = f.enqueue(); f.envelope([d]);
    f.inspect = async (_m, q) => { const x = f.absent(q); x.finding = "draft_only"; x.snapshot!.composer = composer; return x; };
    await f.service.tick(); expect(f.writes).toHaveLength(0);
  });

  test("CLI 기록으로 모든 항목의 제출이 확인된 write_started 봉투는 수락으로 확정해 대기열 fence 를 푼다", async () => {
    // Real 2026-11-07 run: kill -9 mid-send left write_started; the log proved receipt, yet the envelope fenced the member forever.
    const f = setup(); const d = f.enqueue(); const dispatch = f.envelope([d]);
    const logReceipt = [{ source: "claude_log" as const, verdict: "present" as const, location: "received_input" as const, code: "marker_in_user_input", complete: true, checkedAt: new Date(f.now).toISOString() }];
    f.inspect = async (_m, q) => f.observation(q, { finding: "received", receivedDeliveryIds: [d.id], evidence: logReceipt });
    await f.service.tick();
    expect(f.r(d.id).phase).toBe("resolved");
    expect(f.service.fenced(f.member.id)).toBe(false);
    expect(f.store.getDispatch(dispatch.dispatchId)?.transportState).toBe("accepted");
    expect(f.writes).toHaveLength(0);
  });

  test("기록 증거 없이 수신만 표시된 write_started 봉투는 그대로 fence 로 남는다", async () => {
    const f = setup(); const a = f.enqueue(); const b = f.enqueue(); const dispatch = f.envelope([a, b]);
    const logReceipt = [{ source: "claude_log" as const, verdict: "present" as const, location: "received_input" as const, code: "marker_in_user_input", complete: true, checkedAt: new Date(f.now).toISOString() }];
    f.inspect = async (_m, q) => f.observation(q, { finding: "received", receivedDeliveryIds: [a.id], evidence: logReceipt });
    await f.service.tick();
    expect(f.service.fenced(f.member.id)).toBe(true);
    expect(f.store.getDispatch(dispatch.dispatchId)?.transportState).not.toBe("accepted");
  });

  test("부분 묶음 수신은 나머지만 새 봉투로 보내고 개별 표식은 보존한다", async () => {
    const f = setup(); const a = f.enqueue(); const b = f.enqueue(); const original = f.envelope([a, b]);
    let first = true;
    f.inspect = async (_m, q) => { if (first) { first = false; return f.observation(q, { finding: "received", receivedDeliveryIds: [a.id] }); } return f.absent(q); };
    await f.service.tick(); expect(f.r(a.id).phase).toBe("resolved"); expect(f.service.fenced(f.member.id)).toBe(true);
    f.result = { ok: true, started: false };
    await f.due(b.id); await f.due(b.id);
    expect(f.writes).toHaveLength(1);
    const retry = f.store.getDispatch(f.writes[0].dispatchId)!;
    expect(retry.items.map(x => x.deliveryId)).toEqual([b.id]);
    expect(retry.markers[0]).toEqual(original.markers[1]);
    expect(retry.wireText).not.toContain(original.markers[0].marker);
    expect(f.store.requireDelivery(b.id).status).toBe("delivered");
  });

  test("부분 묶음 재전송은 미수신 업무의 저장된 계약 문맥만 보존한다", async () => {
    const f = setup();
    const taskA = f.store.saveTask({ projectId: f.project.id, memberId: f.member.id, who: "대표", title: "첫 업무" }).task;
    const taskB = f.store.saveTask({ projectId: f.project.id, memberId: f.member.id, who: "대표", title: "둘째 업무" }).task;
    const a = f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, kind: "instruction", text: "첫 원문", taskId: taskA.id });
    const b = f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, kind: "instruction", text: "둘째 원문", taskId: taskB.id });
    const contexts = [
      { taskId: taskA.id, contractTaskId: taskA.id, rev: 1, context: "첫 업무 계약의 독립 문맥" },
      { taskId: taskB.id, contractTaskId: taskB.id, rev: 2, context: "둘째 업무 계약의 독립 문맥" },
    ];
    const original = f.envelope([a, b], "unknown", contexts);
    let first = true;
    f.inspect = async (_m, q) => { if (first) { first = false; return f.observation(q, { finding: "received", receivedDeliveryIds: [a.id] }); } return f.absent(q); };
    await f.service.tick();
    f.result = { ok: true, started: false };
    await f.due(b.id); await f.due(b.id);
    const retry = f.store.getDispatch(f.writes[0]!.dispatchId)!;
    expect(retry.items.map(item => item.deliveryId)).toEqual([b.id]);
    expect(retry.baseline.executionContracts).toEqual([contexts[1]!]);
    expect(retry.wireText).toContain("둘째 업무 계약의 독립 문맥");
    expect(retry.wireText).not.toContain("첫 업무 계약의 독립 문맥");
    expect(f.store.getDispatch(original.dispatchId)?.baseline.executionContracts).toEqual(contexts);
    expect(retry.items[0]!.sourceRevision).toBe(original.items[1]!.sourceRevision);
  });

  test("원본 취소가 최종 prepare 직전에 발생해도 쓰기는 0회다", async () => {
    const f = setup(); const todo = f.store.createTodo({ projectId: f.project.id, title: "할 일" }); f.store.setTodoDone(todo.id, true);
    const d = f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, kind: "todo_done", text: "완료", refType: "todo", refId: todo.id }); f.envelope([d]);
    f.inspect = async (_m, q) => f.absent(q); await f.service.tick();
    f.finalHook = () => { f.store.setTodoDone(todo.id, false); };
    await f.due(d.id); expect(f.writes).toHaveLength(0);
    await f.due(d.id); expect(f.r(d.id).reason).toBe("source_changed");
    expect(f.store.requireTodo(todo.id).done).toBe(false);
  });

  test("lease claim/보관이 최종 prepare 직전에 생기면 입력을 차단한다", async () => {
    const f = setup(); const d = f.enqueue(); const dispatch = f.envelope([d]); f.inspect = async (_m, q) => f.absent(q); await f.service.tick();
    f.finalHook = () => f.store.saveLease({ memberId: f.member.id, claimId: "late", leaseId: "lease", identity: dispatch.identity, expiresAt: Date.now() + 60_000, lastInputSequence: 0 });
    await f.due(d.id); expect(f.writes).toHaveLength(0); expect(f.r(d.id).autoAttempts).toBe(0);
  });

  test("서로 다른 복수 unknown 중 하나의 repair는 다른 fence를 우회하지 않는다", async () => {
    const f = setup(); const a = f.enqueue(); const b = f.enqueue(); const first = f.envelope([a]);
    // Simulate an inherited second in-flight envelope, which the new admission would refuse.
    const second: DeliveryDispatch = { ...first, dispatchId: randomUUID(), bundleMarker: "#iamceo_b_second", markers: [{ deliveryId: b.id, marker: "#iamceo_second" }], items: [{ deliveryId: b.id, ordinal: 0, sourceRevision: f.service.sourceRevision(b) }], transportState: "unknown" };
    f.store.saveDispatch(second); f.service.beginRecovery(b.id);
    f.inspect = async (_m, q) => f.absent(q); await f.service.tick(); f.now += 2_000; await f.service.tick();
    expect(f.writes).toHaveLength(0); expect(f.service.fenced(f.member.id)).toBe(true);
  });
});

describe("원본 판, operation과 읽기 집계", () => {
  test("쓰기 전 봉투 저장 뒤 crash는 prepared를 미전달로 추정하지 않는다", async () => {
    const f = setup(); const d = f.enqueue();
    f.service.prepareDispatch([d.id], { terminalId: f.member.paneId, sessionId: f.member.sessionId, sessionGeneration: f.store.memberRevisions(f.member.id).sessionGeneration, process: null }, { serverEpoch: "epoch", turn: 0, inputEpoch: 0, logs: [], capturedAt: new Date(f.now).toISOString() });
    f.restart(); await f.service.tick();
    expect(f.calls).toHaveLength(1); expect(f.r(d.id).phase).toBe("checking");
    expect(f.service.fenced(f.member.id)).toBe(true); expect(f.writes).toHaveLength(0);
  });

  test("started:false의 검증된 ACK는 받음이며 receipt 없는 ok는 unknown이다", async () => {
    const f = setup(); const a = f.enqueue(); const dispatch = f.envelope([a]);
    f.service.recordResult(dispatch.dispatchId, { ok: true, started: false, receipt: { dispatchId: dispatch.dispatchId, receivedAt: new Date(f.now).toISOString(), source: "transport" } });
    expect(f.r(a.id).phase).toBe("resolved"); expect(f.service.fenced(f.member.id)).toBe(false);
    const b = f.enqueue(); const unverified = f.envelope([b]);
    f.service.recordResult(unverified.dispatchId, { ok: true });
    expect(f.r(b.id).phase).toBe("checking"); expect(f.store.requireDelivery(b.id).status).toBe("held");
  });

  test("중지 뒤에도 원래 RPC의 settled 관측만으로 물리 fence를 해제한다", async () => {
    const f = setup(); const d = f.enqueue(); f.envelope([d]);
    await f.service.tick(); f.now += 120_000; await f.service.tick();
    await f.service.recover(d.id, { operationId: randomUUID(), expectedVersion: f.r(d.id).version, action: "stop_retry" });
    expect(f.service.fenced(f.member.id)).toBe(true);
    f.inspect = async (_m, q) => { const x = f.observation(q, { quiescence: "settled" }); x.snapshot!.originalWrite = "settled"; return x; };
    f.now += 60_000; await f.service.tick();
    expect(f.service.fenced(f.member.id)).toBe(false); expect(f.r(d.id).phase).toBe("stopped");
    expect(f.store.requireDelivery(d.id).status).toBe("failed"); expect(f.writes).toHaveLength(0);
  });

  test("같은 delivery의 옛 unknown은 나중 봉투의 확정 미전달로 덮지 않는다", async () => {
    const f = setup(); const d = f.enqueue(); const old = f.envelope([d]);
    const later: DeliveryDispatch = { ...old, dispatchId: randomUUID(), bundleMarker: "#iamceo_b_later", transportState: "rejected" };
    f.store.saveDispatch(later);
    f.inspect = async (_m, q) => q.dispatchId === old.dispatchId ? f.observation(q) : f.absent(q);
    await f.service.tick();
    expect(f.r(d.id)).toMatchObject({ phase: "resolved", reason: "not_received" });
    expect(f.writes).toHaveLength(0); expect(f.service.fenced(f.member.id)).toBe(true);
    f.inspect = async (_m, q) => f.absent(q);
    f.now += 60_000; await f.service.tick();
    expect(f.store.getDispatch(old.dispatchId)!.transportState).toBe("accepted");
  });

  test("위험 동의도 원래 쓰기 미종료는 우회하지 않고 안전한 unknown만 1회 요청한다", async () => {
    const f = setup(); const d = f.enqueue(); f.envelope([d]);
    f.store.updateDeliveryRecovery(d.id, f.r(d.id).version, { phase: "needs_owner", reason: "log_missing" });
    await f.service.recover(d.id, { operationId: randomUUID(), expectedVersion: f.r(d.id).version, action: "retry_with_risk", acceptDuplicateRisk: true });
    await f.service.tick(); expect(f.writes).toHaveLength(0);
    f.inspect = async (_m, q) => { const x = f.absent(q); x.finding = "unknown"; x.snapshot!.originalWrite = "settled"; return x; };
    await f.due(d.id); expect(f.writes).toHaveLength(1);
    await f.service.tick(); expect(f.writes).toHaveLength(1);
  });

  test("현재 답의 수신은 decision/delivery/recovery/활동을 같은 commit에서 정정한다", async () => {
    const f = setup();
    const decision = f.store.createDecision({ projectId: f.project.id, memberId: f.member.id, who: "직원", title: "질문" });
    f.store.answerDecision(decision.id, { note: "답" });
    const d = f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, kind: "answer", text: "답", refType: "decision", refId: decision.id });
    f.envelope([d]);
    let consistent = true;
    f.bus.subscribe(() => {
      consistent &&= f.store.requireDecision(decision.id).status === "delivered" && f.store.requireDelivery(d.id).status === "delivered" && f.r(d.id).phase === "resolved" && f.store.listActivity(f.member.id).length === 1;
    });
    f.inspect = async (_m, q) => f.observation(q, { finding: "received", receivedDeliveryIds: [d.id] });
    await f.service.tick();
    expect(f.store.requireDecision(decision.id).status).toBe("delivered");
    expect(consistent).toBe(true); expect(f.store.listActivity(f.member.id)).toHaveLength(1);
  });

  test("기록 정정 transaction이 실패하면 DB/활동/방송 모두 rollback한다", () => {
    const f = setup(); const d = f.enqueue(); const dispatch = f.envelope([d]); const before = f.r(d.id); const count = f.events.length;
    const service = new DeliveryRecovery({ store: new Proxy(f.store, { get(target, key) { if (key === "appendActivity") return () => { throw new Error("storage full"); }; const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value; } }), runner: () => null });
    expect(() => service.recordResult(dispatch.dispatchId, { ok: true, receipt: { dispatchId: dispatch.dispatchId, receivedAt: new Date(f.now).toISOString(), source: "transport" } })).toThrow("storage full");
    expect(f.r(d.id)).toEqual(before); expect(f.store.requireDelivery(d.id).status).toBe("held"); expect(f.store.listActivity(f.member.id)).toHaveLength(0); expect(f.events).toHaveLength(count);
  });

  test("수신자 생략 대표 메시지도 실제 delivery 대상과 불변 원문으로 봉투를 만든다", () => {
    const f = setup(); const m = f.store.createMessage({ projectId: f.project.id, mine: true, kind: "나", body: "총괄에게", delivery: "queued" });
    const d = f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, kind: "user_message", text: "총괄에게", refType: "message", refId: m.id });
    expect(f.envelope([d]).items[0].sourceRevision).not.toBeNull();
  });

  test("중지 operation은 version 검사 전에 멱등 응답하며 물리 fence는 보존한다", async () => {
    const f = setup(); const d = f.enqueue(); const dispatch = f.envelope([d]);
    f.now += 1_000; await f.service.tick(); f.now += 120_000; await f.service.tick();
    const request = { operationId: randomUUID(), expectedVersion: f.r(d.id).version, action: "stop_retry" as const };
    const result = await f.service.recover(d.id, request);
    expect(await f.service.recover(d.id, request)).toEqual(result);
    expect(f.r(d.id).phase).toBe("stopped"); expect(f.service.notices(f.project.id).members[0].unknownCount).toBe(0);
    expect(f.service.fenced(f.member.id)).toBe(true); expect(f.store.getDispatch(dispatch.dispatchId)!.transportState).toBe("unknown");
    await errorStatus(f.service.recover(d.id, { ...request, action: "recheck" }), 409);
    f.service.recordResult(dispatch.dispatchId, { ok: false, reason: "down", retryable: false, deliveryEffect: "not_written" });
    expect(f.service.fenced(f.member.id)).toBe(false);
    expect(f.r(d.id).phase).toBe("stopped");
  });

  test("위험 동의는 상한을 초기화하지 않고 새 쓰기 한 번만 허용한다", async () => {
    const f = setup(); const d = f.enqueue(); f.envelope([d]);
    f.store.updateDeliveryRecovery(d.id, f.r(d.id).version, { phase: "needs_owner", reason: "retry_exhausted", autoAttempts: 3 });
    const request = { operationId: randomUUID(), expectedVersion: f.r(d.id).version, action: "retry_with_risk" as const, acceptDuplicateRisk: true as const };
    const result = await f.service.recover(d.id, request); expect(await f.service.recover(d.id, request)).toEqual(result);
    f.inspect = async (_m, q) => f.absent(q); await f.service.tick();
    expect(f.writes).toHaveLength(1); expect(f.r(d.id).autoAttempts).toBe(4);
    await f.service.tick(); expect(f.r(d.id).phase).toBe("needs_owner"); expect(f.writes).toHaveLength(1);
    expect(await f.service.recover(d.id, request)).toEqual(result);
  });

  test("실제 schema는 잘못된 operation/version/위험 동의와 추가 키를 거절한다", async () => {
    const f = setup(); const d = f.enqueue(); f.envelope([d]);
    for (const request of [
      { operationId: "bad", expectedVersion: 1, action: "recheck" },
      { operationId: randomUUID(), expectedVersion: 0, action: "recheck" },
      { operationId: randomUUID(), expectedVersion: 1, action: "retry_with_risk" },
      { operationId: randomUUID(), expectedVersion: 1, action: "recheck", acceptDuplicateRisk: true },
      { operationId: randomUUID(), expectedVersion: 1, action: "confirm_received" },
    ]) await errorStatus(f.service.recover(d.id, request as never), 400);
    await errorStatus(f.service.recover(d.id, { operationId: randomUUID(), expectedVersion: f.r(d.id).version - 1, action: "recheck" }), 409);
  });

  test("오래된 결재 수신은 새 답/닫힘 판을 덮지 않고 delivery만 정정한다", async () => {
    const f = setup(); const decision = f.store.createDecision({ projectId: f.project.id, memberId: f.member.id, who: "직원", title: "질문" });
    f.store.answerDecision(decision.id, { note: "답" });
    const d = f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, kind: "answer", text: "답", refType: "decision", refId: decision.id }); f.envelope([d]);
    f.store.setDecisionStatus(decision.id, "closed"); const closed = f.store.requireDecision(decision.id);
    f.inspect = async (_m, q) => f.observation(q, { finding: "received", receivedDeliveryIds: [d.id] }); await f.service.tick();
    expect(f.store.requireDecision(decision.id)).toEqual(closed); expect(f.store.requireDelivery(d.id).status).toBe("delivered");
  });

  test("보관/세대 변경이 조회 도중 발생하면 옛 관측을 적용하지 않는다", async () => {
    const f = setup(); const d = f.enqueue(); f.envelope([d]);
    f.inspect = async (_m, q) => { f.store.patchProject(f.project.id, { archived: true }); return f.observation(q, { finding: "received", receivedDeliveryIds: [d.id] }); };
    await f.service.tick(); expect(f.store.requireDelivery(d.id).status).toBe("held");
    expect(() => f.service.notices(f.project.id)).toThrow(ApiError);
    await errorStatus(f.service.recover(d.id, { operationId: randomUUID(), expectedVersion: f.r(d.id).version, action: "recheck" }), 404);
  });

  test("500건 밖 virtual failed도 집계하며 수신자 null을 총괄에게 추측 배정하지 않는다", () => {
    const f = setup();
    const old = f.store.createMessage({ id: "old-가", projectId: f.project.id, mine: true, kind: "나", body: "a".repeat(200), targetMemberId: f.member.id, delivery: "failed" });
    f.store.createMessage({ id: "unassigned", projectId: f.project.id, mine: true, kind: "나", body: "누구에게", delivery: "failed" });
    for (let i = 0; i < 510; i++) f.store.createMessage({ projectId: f.project.id, kind: "진행", body: "tail" });
    const snapshots = f.events.length;
    const result = f.service.notices(f.project.id); expect(result.members[0]).toMatchObject({ unknownCount: 1, needsOwnerCount: 1 });
    expect(result.unassigned).toEqual({ undeliveredCount: 0, unknownCount: 1, needsOwnerCount: 1 });
    const item = f.service.memberNotices(f.member.id).items[0];
    expect(item).toMatchObject({ id: `message:${old.id}`, version: 0, deliveryId: null, allowedActions: [] }); expect(item.preview).toHaveLength(160);
    expect(f.calls).toHaveLength(0); expect(f.events).toHaveLength(snapshots);
    const actual = f.service.materializeLegacyMessage(old.id); expect(f.service.materializeLegacyMessage(old.id).id).toBe(actual.id);
    expect(f.r(actual.id).marker).toBeNull(); expect(f.r(actual.id).phase).toBe("checking");
    expect(f.service.memberNotices(f.member.id).items).toHaveLength(1);
    expect(() => f.service.materializeLegacyMessage("unassigned")).toThrow(ApiError);
  });

  test("같은 원본 판의 옛 확정 failed만 합치고 unknown과 새 operation은 독립이다", () => {
    const f = setup(); const m = f.store.createMessage({ projectId: f.project.id, mine: true, kind: "나", body: "원본", targetMemberId: f.member.id, delivery: "failed" });
    const make = () => f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, kind: "user_message", text: "원본", refType: "message", refId: m.id, sourceRevision: "same" });
    const old = make(); f.store.markFailed(old.id, "실패"); f.store.updateDeliveryRecovery(old.id, f.r(old.id).version, { phase: "needs_owner", reason: "retry_exhausted" });
    const unknown = make(); f.store.markHeld(unknown.id, "delivery_unknown"); f.service.beginRecovery(unknown.id);
    const success = make(); f.store.markDelivered(success.id); f.store.updateDeliveryRecovery(success.id, f.r(success.id).version, { phase: "resolved" });
    expect(f.service.memberNotices(f.member.id).items.map(x => x.id)).toEqual([unknown.id]);
  });

  test("상세 cursor는 BINARY keyset, 같은 시각/Unicode/경계 삭제에도 summary는 전체다", () => {
    const f = setup();
    for (const id of ["é", "z", "가", "a", "😀"]) f.store.createMessage({ id, at: "2026-01-01T00:00:00.000Z", projectId: f.project.id, mine: true, kind: "나", body: id, targetMemberId: f.member.id, delivery: "failed" });
    const seen: string[] = []; let before: string | undefined;
    do {
      const page = f.service.memberNotices(f.member.id, { limit: 2, before }); expect(page.summary.unknownCount).toBe(5);
      seen.push(...page.items.map(x => x.id)); before = page.nextBefore ?? undefined;
    } while (before);
    const expected = ["é", "z", "가", "a", "😀"].map(id => `message:${id}`).sort((a, b) => Buffer.compare(Buffer.from(b), Buffer.from(a)));
    expect(seen).toEqual(expected); expect(new Set(seen).size).toBe(5);
    const other = f.makeMember("other"); const cursor = f.service.memberNotices(f.member.id, { limit: 1 }).nextBefore!;
    expect(() => f.service.memberNotices(other.id, { before: cursor })).toThrow(ApiError);
    for (const limit of [0, -1, 101, 1.5, NaN]) expect(() => f.service.memberNotices(f.member.id, { limit })).toThrow(ApiError);
    for (const before of ["", "!", "e30", "e30="]) expect(() => f.service.memberNotices(f.member.id, { before })).toThrow(ApiError);
  });

  test("shutdown은 진행 조회를 기다리고 늦은 관측/후속 입력을 적용하지 않는다", async () => {
    const f = setup(); const d = f.enqueue(); f.envelope([d]); let release!: () => void;
    f.inspect = async (_m, q) => { await new Promise<void>(resolve => { release = resolve; }); return f.observation(q, { finding: "received", receivedDeliveryIds: [d.id] }); };
    const tick = f.service.tick(); const closing = f.service.shutdown(); release(); await tick; await closing;
    expect(f.store.requireDelivery(d.id).status).toBe("held"); await f.service.tick(); expect(f.calls).toHaveLength(1); expect(f.writes).toHaveLength(0);
  });
});

test.each(["claude", "codex"] as const)("%s delivery recovery resolves provider ranks and subagent model", async cli => {
  const f = setup();
  f.store.patchMember(f.member.id, { cli });
  f.store.patchSettings({ ranks: { lead: { model: "sonnet", effort: "high" }, staff: { model: "haiku" } }, codexRanks: { lead: { model: "gpt-6-luna", effort: "low" }, staff: { model: "gpt-6.1-terra", effort: "minimal" } } });
  const d = f.enqueue(); f.envelope([d]);
  let observed: RunnerMember | undefined;
  f.inspect = async (m, q) => { observed = m; return f.observation(q); };
  await f.service.tick();
  expect(observed).toMatchObject(cli === "codex" ? { model: "gpt-6-luna", effort: "low", subagentModel: "gpt-6.1-terra" } : { model: "sonnet", effort: "high", subagentModel: "haiku" });
});


describe("확정 미기록은 불확실 복구와 분리", () => {
  test.each(["not_written", "rejected"] as const)("%s는 같은 delivery/marker의 일반 봉투로 다시 시도한다", effect => {
    const f = setup(), d = f.enqueue(), old = f.envelope([d]);
    f.service.recordResult(old.dispatchId, { ok: false, reason: "busy", retryable: true, deliveryEffect: effect });
    expect(f.r(d.id)).toMatchObject({ phase: "resolved", reason: "not_received" });
    expect(f.store.requireDelivery(d.id).status).toBe("queued");
    expect(f.service.fenced(f.member.id)).toBe(false);
    const next = f.service.prepareDispatch([d.id], old.identity, old.baseline);
    expect(next.dispatchId).not.toBe(old.dispatchId); expect(next.markers).toEqual(old.markers);
    expect(f.store.getDispatch(old.dispatchId)!.transportState).toBe("rejected");
    expect(f.calls).toHaveLength(0);
  });
  test("identity_changed needs_owner와 재시작도 rejected면 기록 조회 없이 닫는다", async () => {
    const f = setup(), d = f.enqueue(), old = f.envelope([d]);
    f.store.updateDispatch(old.dispatchId, "unknown", "rejected");
    f.store.updateDeliveryRecovery(d.id, f.r(d.id).version, { phase: "needs_owner", reason: "identity_changed", nextCheckAt: new Date(f.now + 60000).toISOString() });
    f.store.patchMember(f.member.id, { paneId: "new-terminal", sessionId: "new-native" });
    f.restart(); await f.service.tick();
    expect(f.r(d.id)).toMatchObject({ phase: "resolved", reason: "not_received" });
    expect(f.store.requireDelivery(d.id).status).toBe("queued"); expect(f.calls).toHaveLength(0);
    expect(f.service.fenced(f.member.id)).toBe(false);
  });
  test("연속 거절 5회는 재시작 뒤에도 보류하고 후속 전달 fence를 만들지 않는다", () => {
    const f = setup(), d = f.enqueue(); let old = f.envelope([d]);
    for (let i = 0; i < 5; i++) {
      f.service.recordResult(old.dispatchId, { ok: false, reason: "busy", retryable: true, deliveryEffect: "rejected" });
      f.restart();
      if (i < 4) old = f.service.prepareDispatch([d.id], old.identity, old.baseline);
    }
    expect(f.store.requireDelivery(d.id)).toMatchObject({ status: "held", holdReason: "input_busy" });
    expect(f.service.memberNotices(f.member.id).items[0].note).toContain("5회");
    expect(() => f.service.prepareDispatch([d.id], old.identity, old.baseline)).toThrow();
    expect(f.service.fenced(f.member.id)).toBe(false);
    const later = f.enqueue(); expect(f.service.prepareDispatch([later.id], old.identity, old.baseline)).toBeDefined();
  });
  test("부재 확정+다른 초안에는 사실을 안내하고 위험 동의 행동을 제공한다", async () => {
    const f = setup(), d = f.enqueue(); f.envelope([d]);
    f.inspect = async (_m, q) => { const x = f.observation(q); x.snapshot!.composer = "different";
      x.evidence = [{ source: "claude_log", verdict: "absent", complete: true, code: "complete_range_without_marker", location: "none", checkedAt: new Date(f.now).toISOString() },
        { source: "core_screen", verdict: "present", complete: true, code: "different", location: "composer", checkedAt: new Date(f.now).toISOString() }]; return x; };
    await f.service.tick(); f.now += 120000; await f.service.tick();
    const item = f.service.memberNotices(f.member.id).items[0];
    expect(item.allowedActions).toContain("retry_with_risk"); expect(item.note).toContain("입력칸에 다른 글");
    await f.service.recover(d.id, { operationId: randomUUID(), expectedVersion: item.version, action: "retry_with_risk", acceptDuplicateRisk: true });
    await f.service.tick(); expect(f.writes).toHaveLength(0); // A consent never bypasses an unresolved write/draft.
  });
});

test("same native resume can reconcile log receipt after generation change while preserving the old physical fence", async () => {
  const f = setup(), d = f.enqueue(), old = f.envelope([d]);
  // Reopen to the same native session but a different owned terminal/generation.
  f.store.patchMember(f.member.id, { paneId: "resumed-terminal", sessionId: old.identity.sessionId });
  f.inspect = async (_m, q) => {
    const x = f.observation(q, { finding: "received", receivedDeliveryIds: [d.id] });
    x.snapshot!.identity = { ...q.identity, terminalId: "resumed-terminal" }; return x;
  };
  await f.service.tick();
  expect(f.store.requireDelivery(d.id).status).toBe("delivered");
  expect(f.store.getDispatch(old.dispatchId)!.transportState).toBe("unknown");
  expect(f.service.fenced(f.member.id)).toBe(true); expect(f.writes).toHaveLength(0);
});

test("different native session records identity_changed for owner review instead of silently skipping checks", async () => {
  const f = setup(), d = f.enqueue(); f.envelope([d]);
  f.store.patchMember(f.member.id, { paneId: "other", sessionId: "other" });
  f.inspect = async (_m, q) => f.observation(q, { snapshot: null, evidence: [{ source: "transport", verdict: "unknown", location: "none", complete: false, code: "identity_changed", checkedAt: new Date(f.now).toISOString() }] });
  await f.service.tick(); f.now += 120000; await f.service.tick();
  expect(f.r(d.id)).toMatchObject({ phase: "needs_owner", reason: "identity_changed" });
  expect(f.service.memberNotices(f.member.id).items[0].note).toContain("세션이 다시 열려");
  expect(f.writes).toHaveLength(0);
});

describe("거절 한도에 걸린 지시는 대표의 '다시 확인'으로 같은 전달을 한 번 더 보낸다", () => {
  function exhausted() {
    const f = setup(), d = f.enqueue(f.member, "원래 지시 원문"); let old = f.envelope([d]);
    const markers = old.markers;
    for (let i = 0; i < 5; i++) {
      f.service.recordResult(old.dispatchId, { ok: false, reason: "busy", retryable: true, deliveryEffect: "rejected" });
      if (i < 4) old = f.service.prepareDispatch([d.id], old.identity, old.baseline);
    }
    expect(f.store.getDeliveryRetry(d.id).retryReason).toBe("rejected_limit");
    return { f, d, old, markers };
  }
  const recheck = (f: ReturnType<typeof setup>, id: string, operationId: string = randomUUID()) =>
    f.service.recover(id, { operationId, expectedVersion: f.r(id).version, action: "recheck" });

  test("알림은 대표 차례로 보이고 '다시 확인' 하나만 허용한다", () => {
    const { f, d } = exhausted();
    const item = f.service.memberNotices(f.member.id).items.find(x => x.deliveryId === d.id)!;
    expect(item).toMatchObject({ phase: "needs_owner", reason: "not_received", allowedActions: ["recheck"] });
    expect(item.note).toContain("다시 확인");
    expect(f.service.notices(f.project.id).members[0].needsOwnerCount).toBe(1);
  });

  test("한 번 허가하면 같은 ID·표지·원문으로 일반 봉투를 한 번 만든다. 다시 거절되면 또 멈춘다", async () => {
    const { f, d, old, markers } = exhausted();
    const before = f.store.listDispatches(f.member.id).length;
    const op = randomUUID(), version = f.r(d.id).version;
    const result = await recheck(f, d.id, op);
    expect(result).toMatchObject({ deliveryId: d.id, outcome: "check_scheduled" });
    expect(result.committedVersion).toBeGreaterThan(version);
    expect(f.store.requireDelivery(d.id)).toMatchObject({ id: d.id, status: "queued", text: "원래 지시 원문" });
    // The same operation is idempotent and never grants a second attempt.
    expect(await f.service.recover(d.id, { operationId: op, expectedVersion: version, action: "recheck" })).toEqual(result);
    const next = f.service.prepareDispatch([d.id], old.identity, old.baseline);
    expect(next.items.map(i => i.deliveryId)).toEqual([d.id]);
    expect(next.markers).toEqual(markers);
    expect(next.wireText.startsWith("원래 지시 원문\n")).toBe(true);
    expect(f.store.listDispatches(f.member.id).length).toBe(before + 1);
    expect(f.store.listDeliveries(f.project.id).filter(x => x.memberId === f.member.id)).toHaveLength(1);
    f.service.recordResult(next.dispatchId, { ok: false, reason: "busy", retryable: true, deliveryEffect: "rejected" });
    expect(f.store.requireDelivery(d.id)).toMatchObject({ status: "held", holdReason: "input_busy" });
    expect(f.store.getDeliveryRetry(d.id).retryReason).toBe("rejected_limit");
    expect(() => f.service.prepareDispatch([d.id], old.identity, old.baseline)).toThrow();
    expect(f.service.fenced(f.member.id)).toBe(false);
  });

  test("수신이 애매하거나 이미 들어간 전달, 원문이 바뀐 전달, 옛 판 요청에는 허가하지 않는다", async () => {
    // ambiguous: the newest envelope may have been written
    const a = setup(), ad = a.enqueue(); a.envelope([ad], "unknown");
    await recheck(a, ad.id).catch(() => null);
    expect(a.store.getDeliveryRetry(ad.id).retryReason?.startsWith("owner_retry:") ?? false).toBe(false);
    expect(a.store.requireDelivery(ad.id).status).not.toBe("queued");
    expect(() => a.service.prepareDispatch([ad.id], { terminalId: a.member.paneId, sessionId: a.member.sessionId, sessionGeneration: a.store.memberRevisions(a.member.id).sessionGeneration, process: null }, { serverEpoch: "test-epoch", turn: 0, inputEpoch: 0, logs: [], capturedAt: new Date(a.now).toISOString() })).toThrow();
    // delivered
    const { f, d } = exhausted();
    f.store.markDelivered(d.id);
    await errorStatus(recheck(f, d.id), 409);
    expect(f.store.getDeliveryRetry(d.id).retryReason).toBe("rejected_limit");
    // stale version
    const s = exhausted();
    await errorStatus(s.f.service.recover(s.d.id, { operationId: randomUUID(), expectedVersion: s.f.r(s.d.id).version - 1, action: "recheck" }), 409);
    expect(s.f.store.requireDelivery(s.d.id).status).toBe("held");
    // source changed after the refusals
    const c = exhausted();
    c.f.db.run("UPDATE deliveries SET text = ? WHERE id = ?", ["바뀐 원문", c.d.id]);
    await errorStatus(recheck(c.f, c.d.id), 409);
    expect(c.f.store.requireDelivery(c.d.id).status).toBe("held");
  });

  test("한 번 허가된 뒤에도 일반 입력 검사를 그대로 거친다(수동 조작 중이면 봉투를 만들지 않는다)", async () => {
    const { f, d, old } = exhausted();
    await recheck(f, d.id);
    f.store.patchMember(f.member.id, { sessionId: "다른-세션" });
    expect(() => f.service.prepareDispatch([d.id], old.identity, old.baseline)).toThrow();
    expect(f.store.requireDelivery(d.id).status).toBe("queued");
  });
});
