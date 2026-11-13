// Z(0.2.6): 대표 글의 '답 상태'(채팅의 '답 쓰는 중' 표시). 판정은 서버 한 곳(server/reply-state.ts)이고, 저장소가 근거를 모아
// 모든 메시지 응답과 실시간 'message' 사건에 선택 칸 reply 로 싣는다. 바뀔 때만 다시 낸다.
// 진짜 CLI 는 띄우지 않는다: 실행기는 메모리 속 가짜(턴 시작은 보내기, 턴 끝은 end())다.
import { afterEach, describe, expect, test } from "bun:test";
import { Bus } from "../server/bus.ts";
import { loadConfig } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { startServer } from "../server/http.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import { judgeReply, replySettled, type ReplyFacts, type ReplyRun } from "../server/reply-state.ts";
import type { Runner, RunnerEvent, RunnerMember, SendResult, StartOpts } from "../server/runner/types.ts";
import { Store } from "../server/store.ts";
import { REPLY_STATES, type DeliveryWaitReason, type Member, type Message, type MessageReply } from "../shared/types.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";

// ---- 판정표(저장소 없이) ----
const AT = "2026-11-14T01:00:00.000Z", LATER = "2026-11-14T01:03:00.000Z";
const idle: ReplyFacts["member"] = { status: "idle", blockedReason: null, fenceCode: undefined, observationError: null };
const run = (patch: Partial<ReplyRun> = {}): ReplyRun => ({ runId: "run-1", phase: "running", result: null, createdAt: AT, inputReceivedAt: AT, startedAt: AT, lastProgressAt: null, endedAt: null, ...patch });
const delivered = (patch: Partial<ReplyFacts> = {}): ReplyFacts => ({ memberId: "m1", delivery: { status: "delivered", createdAt: AT, deliveredAt: AT }, member: idle, ...patch });

describe("판정표", () => {
  const pending: [DeliveryWaitReason, MessageReply["state"]][] = [
    ["receipt_check", "checking"], ["member_busy", "behind"], ["next_turn", "behind"], ["waking", "waking"],
    ["approval", "blocked"], ["usage_limit", "blocked"], ["api_outage", "blocked"], ["runner_off", "blocked"], ["manual_control", "blocked"], ["archived", "blocked"],
    ["run_limit", "queued"], ["retry_wait", "queued"], ["unknown", "queued"],
  ];
  for (const [reason, state] of pending) test(`아직 넣지 못한 글: ${reason} → ${state}`, () => {
    expect(judgeReply({ memberId: "m1", delivery: { status: "queued", createdAt: AT, deliveredAt: null }, member: idle, wait: { waitReason: reason, waitingSince: AT } }))
      .toEqual({ state, memberId: "m1", since: AT, reason });
  });

  test("넣는 중이고 사유가 없으면 확인 중, 실패는 싣지 않는다(기존 '실패'·다시 보내기가 맡는다)", () => {
    expect(judgeReply({ memberId: "m1", delivery: { status: "delivering", createdAt: AT, deliveredAt: null }, member: idle })).toMatchObject({ state: "checking", reason: "receipt_check" });
    expect(judgeReply({ memberId: "m1", delivery: { status: "failed", createdAt: AT, deliveredAt: null }, member: idle })).toBeNull();
  });

  test("받았다: 실행 기록이 없으면 전달됨, 받았지만 턴 시작 전이면 전달됨, 턴이 돌면 일하는 중(턴 시작 시각)", () => {
    expect(judgeReply(delivered())).toEqual({ state: "delivered", memberId: "m1", since: AT });
    expect(judgeReply(delivered({ run: run({ phase: "received", startedAt: null }) }))).toMatchObject({ state: "delivered" });
    expect(judgeReply(delivered({ run: run({ startedAt: LATER }) }))).toEqual({ state: "working", memberId: "m1", since: LATER });
  });

  test("턴 도중 승인 창·사용 한도·인터넷·오류로 멈추면 막힘(그 까닭)", () => {
    const blocked = (member: Partial<ReplyFacts["member"]>) => judgeReply(delivered({ run: run({ lastProgressAt: LATER }), member: { ...idle, ...member } }));
    expect(blocked({ status: "blocked", blockedReason: "permission" })).toEqual({ state: "blocked", memberId: "m1", since: LATER, reason: "approval" });
    expect(blocked({ status: "blocked", blockedReason: "usage_limit" })).toMatchObject({ reason: "usage_limit" });
    expect(blocked({ status: "working", fenceCode: "usage_wait" })).toMatchObject({ reason: "usage_limit" });
    expect(blocked({ status: "working", observationError: "network_outage" })).toMatchObject({ reason: "api_outage" });
    expect(blocked({ status: "error" })).toMatchObject({ reason: "error" });
  });

  test("답이 있으면 언제나 답함(답 시각). 턴이 아직 돌아도 같다", () => {
    expect(judgeReply(delivered({ run: run(), reply: { id: "r1", at: LATER } }))).toEqual({ state: "replied", memberId: "m1", since: LATER });
  });

  test("답 없이 끝난 턴: 답 없음. 맡겼으면 답함, 보고 보완을 넣는 중이면 일하는 중, 다음 실행이 돌면 그 실행", () => {
    const ended = run({ phase: "ended", result: "success", endedAt: LATER });
    expect(judgeReply(delivered({ run: ended }))).toEqual({ state: "no_reply", memberId: "m1", since: LATER });
    expect(judgeReply(delivered({ run: ended, delegated: true }))).toMatchObject({ state: "replied" });
    // 이어지는 '일하는 중'은 그 글의 턴이 시작한 때부터 센다(화면의 'N분'이 끊기지 않는다). 막 넣는 중인 다음 실행도 일하는 중이다.
    expect(judgeReply(delivered({ run: ended, awaitingReport: true }))).toEqual({ state: "working", memberId: "m1", since: AT });
    expect(judgeReply(delivered({ run: ended, later: run({ runId: "run-2", createdAt: LATER, startedAt: LATER }) }))).toEqual({ state: "working", memberId: "m1", since: AT });
    expect(judgeReply(delivered({ run: ended, later: run({ runId: "run-2", phase: "starting", createdAt: LATER, inputReceivedAt: null, startedAt: null }) }))).toMatchObject({ state: "working", since: AT });
    expect(judgeReply(delivered({ run: ended, later: run({ runId: "run-2", phase: "ended", result: "success" }) }))).toMatchObject({ state: "no_reply" });
  });

  test("오류·종료로 끊긴 턴: 한도·인터넷이면 막힘, 오류 상태면 오류로 막힘, 이어서 돌면 일하는 중, 아니면 멈춤", () => {
    const broken = run({ phase: "ended", result: "error", endedAt: LATER });
    expect(judgeReply(delivered({ run: broken, member: { ...idle, status: "blocked", blockedReason: "usage_limit" } }))).toMatchObject({ state: "blocked", reason: "usage_limit" });
    expect(judgeReply(delivered({ run: broken, member: { ...idle, status: "error" } }))).toMatchObject({ state: "blocked", reason: "error" });
    expect(judgeReply(delivered({ run: broken, later: run({ runId: "run-2", createdAt: LATER, startedAt: LATER }) }))).toMatchObject({ state: "working" });
    expect(judgeReply(delivered({ run: run({ phase: "interrupted", result: "interrupted", endedAt: LATER }) }))).toEqual({ state: "stopped", memberId: "m1", since: LATER });
  });

  test("굳은 값: 답함은 늘, 답 없음·멈춤은 답 창이 닫힌 뒤에만", () => {
    expect(replySettled({ state: "replied", memberId: "m1", since: AT }, false)).toBe(true);
    expect(replySettled({ state: "no_reply", memberId: "m1", since: AT }, false)).toBe(false);
    expect(replySettled({ state: "no_reply", memberId: "m1", since: AT }, true)).toBe(true);
    expect(replySettled({ state: "working", memberId: "m1", since: AT }, true)).toBe(false);
    expect(REPLY_STATES).toHaveLength(10);
  });
});

// ---- 저장소·전달 펌프와 함께(가짜 실행기) ----
class ReplyRunner implements Runner {
  readonly kind = "core" as const;
  sent: { id: string; text: string }[] = [];
  busy = new Set<string>();
  startGate: (() => Promise<void>) | null = null;
  callback: (event: RunnerEvent) => void = () => {};
  async available() { return { ok: true }; }
  async start(member: RunnerMember, _opts: StartOpts) {
    await this.startGate?.();
    return { sessionId: member.sessionId ?? `native-${member.id}`, paneId: `pane-${member.id}` };
  }
  async send(member: RunnerMember, text: string): Promise<SendResult> {
    this.sent.push({ id: member.id, text }); this.busy.add(member.id);
    return { ok: true, started: true, turn: 0 };
  }
  isBusy(id: string) { return this.busy.has(id); }
  async compact(): Promise<SendResult> { return { ok: true }; }
  async setParallel(): Promise<SendResult> { return { ok: true }; }
  async stop(member: RunnerMember) { this.busy.delete(member.id); }
  async interrupt() {}
  async screen() { return ""; }
  async shutdown() {}
  on(callback: (event: RunnerEvent) => void) { this.callback = callback; }
  /** 그 팀장의 턴이 끝났다(실행기가 본 턴 끝). */
  end(store: Store, id: string, turn: number) {
    const member = store.requireMember(id); this.busy.delete(id);
    this.callback({ type: "turn_end", memberId: id, terminalId: member.paneId, sessionGeneration: store.memberRevisions(id).sessionGeneration, turn, finalText: "", isError: false });
  }
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 300 && !check(); i++) await Bun.sleep(5);
  if (!check()) throw new Error(`기다린 상태가 오지 않았습니다: ${what}`);
}

function fixture() {
  const isolated = createIsolatedRuntime();
  const config = loadConfig({ IAMCEO_HOME: isolated.paths.iamceoHome, IAMCEO_PORT: "0", IAMCEO_CORE_SOCKET: isolated.socketPath, IAMCEO_HERDR_SOCKET: isolated.herdrSocketPath,
    IAMCEO_CORE_BIN: isolated.bins.coreBin, IAMCEO_CLAUDE_BIN: isolated.bins.claudeBin, IAMCEO_CODEX_BIN: isolated.bins.codexBin });
  const db = openDb(config.dbPath), bus = new Bus(), store = new Store(db, bus), runner = new ReplyRunner();
  store.patchSettings({ maxConcurrentTurns: 4, boardTidyHours: 0 });
  const project = store.createProject({ name: "답 상태", cwd: isolated.paths.work });
  const orch = new Orchestrator({ config, store, runners: new Map([["core", runner]]), timings: { tickMs: 60_000, healthMs: 60_000 } });
  let n = 0;
  const member = (kind: Member["kind"] = "worker", cli: Member["cli"] = "claude", status: Member["status"] = "idle") => {
    n++;
    return store.createMember({ projectId: project.id, kind, cli, handle: `member${n}`, name: kind === "worker" ? `담당 ${n}` : "총괄", origin: "runner", backend: "core", status, cwd: project.cwd, sessionId: `native-${n}`, paneId: `pane-${n}` });
  };
  /** 실시간으로 나간 대표 글(글마다 차례대로). */
  const seen = new Map<string, Message[]>();
  bus.subscribe(event => { if (event.type === "message" && event.message.mine) seen.set(event.message.id, [...(seen.get(event.message.id) ?? []), event.message]); });
  const reply = (id: string) => store.requireMessage(id).reply;
  const states = (id: string) => (seen.get(id) ?? []).map(m => m.reply?.state ?? null);
  cleanups.push(async () => { await orch.shutdown(); db.close(); await isolated.stop(); });
  return { config, db, bus, store, runner, project, orch, member, reply, states, seen };
}

/** 같은 글이 연달아 두 번 나가지 않는다(답 상태든 전달 상태든 바뀔 때만 낸다). */
function noRepeats(list: Message[]) {
  for (let i = 1; i < list.length; i++) expect(JSON.stringify(list[i])).not.toBe(JSON.stringify(list[i - 1]));
}

describe("저장소와 실시간", () => {
  test("쉬던 총괄: 보내면 바로 일하는 중, 총괄이 대화에 쓰면 답함. 실시간은 바뀔 때만 낸다", async () => {
    const f = fixture(); const lead = f.member("conductor");
    const sent = await f.orch.sendUserMessage(f.project.id, { text: "결제 연동 상황을 알려 주세요" });
    expect(sent.reply).toMatchObject({ memberId: lead.id });
    await until(() => f.reply(sent.id)?.state === "working", "일하는 중");
    const working = f.reply(sent.id)!;
    expect(working.since).toBe(f.store.listPendingExecutions().find(r => r.memberId === lead.id)!.startedAt!);
    const runId = f.store.listPendingExecutions().find(r => r.memberId === lead.id)!.runId;
    await f.orch.recordPost(f.store.requireMember(lead.id), { kind: "진행", title: "확인했습니다" });
    await until(() => f.reply(sent.id)?.state === "replied", "답함");
    // 진행 글은 최종 보고가 아니라 서버가 보고 보완을 넣고 다음 턴이 돈다. 이미 답했으니 답함 그대로다.
    f.runner.end(f.store, lead.id, 1);
    await until(() => f.store.getExecutionJournal(runId)?.phase === "ended", "턴 끝");
    await until(() => f.runner.sent.some(s => s.text.includes("보고 보완:")), "보고 보완");
    expect(f.reply(sent.id)?.state).toBe("replied");
    expect(f.states(sent.id)).toContain("working");
    expect(f.states(sent.id).at(-1)).toBe("replied");
    noRepeats(f.seen.get(sent.id)!);
  });

  test("Codex 팀장도 같은 근거(실행 기록)로 판정한다. 훅 기록이 없어도 된다", async () => {
    const f = fixture(); f.member("conductor"); const worker = f.member("worker", "codex");
    const sent = await f.orch.sendUserMessage(f.project.id, { text: "결제 버튼을 아래에 고정해 주세요", targetMemberId: worker.id });
    await until(() => f.reply(sent.id)?.state === "working", "일하는 중");
    expect(f.reply(sent.id)?.memberId).toBe(worker.id);
    await f.orch.recordPost(f.store.requireMember(worker.id), { kind: "완료", title: "고정했습니다" });
    await until(() => f.reply(sent.id)?.state === "replied", "답함");
  });

  test("앞 일을 하던 팀장: 앞 일 중에 쓴 글은 답이 아니다. 앞 일이 끝나면 일하는 중, 답 없이 끝나고 보고 보완에도 답이 없으면 답 없음", async () => {
    const f = fixture(); f.member("conductor"); const worker = f.member();
    await f.orch.assign(f.project.id, worker.handle, { text: "앞 일" });
    await until(() => f.runner.busy.has(worker.id), "앞 일 시작");
    const sent = await f.orch.sendUserMessage(f.project.id, { text: "이것도 해 주세요", targetMemberId: worker.id });
    await until(() => f.reply(sent.id)?.state === "behind", "앞 일을 마치는 중");
    expect(f.reply(sent.id)).toMatchObject({ reason: "member_busy", since: f.store.listDeliveries().find(d => d.refId === sent.id)!.createdAt });
    // 앞 일의 보고. 이 글은 아직 들어가지 않았다.
    await f.orch.recordPost(f.store.requireMember(worker.id), { kind: "완료", title: "앞 일을 끝냈습니다" });
    expect(f.reply(sent.id)?.state).toBe("behind");
    f.runner.end(f.store, worker.id, 1);
    await until(() => f.reply(sent.id)?.state === "working", "이 글의 턴");
    // 답 없이 끝남 → 서버가 보고 보완을 넣는다. 그동안 '답 없음'을 띄우지 않는다.
    f.runner.end(f.store, worker.id, 2);
    await until(() => f.runner.sent.some(s => s.text.includes("보고 보완:")), "보고 보완");
    expect(f.reply(sent.id)?.state).toBe("working");
    f.runner.end(f.store, worker.id, 3);
    await until(() => f.reply(sent.id)?.state === "no_reply", "답 없음");
    expect(f.states(sent.id)).not.toContain("replied");
    expect(f.states(sent.id).filter(s => s === "no_reply")).toHaveLength(1);
    noRepeats(f.seen.get(sent.id)!);
  });

  test("보고 보완 턴에서 쓴 글은 그 대표 글의 답이다", async () => {
    const f = fixture(); const lead = f.member("conductor");
    const sent = await f.orch.sendUserMessage(f.project.id, { text: "오늘 계획을 정리해 주세요" });
    await until(() => f.reply(sent.id)?.state === "working", "일하는 중");
    f.runner.end(f.store, lead.id, 1);
    await until(() => f.runner.sent.some(s => s.text.includes("보고 보완:")), "보고 보완");
    await f.orch.recordPost(f.store.requireMember(lead.id), { kind: "완료", title: "계획을 정리했습니다" });
    await until(() => f.reply(sent.id)?.state === "replied", "답함");
  });

  test("한 턴에 함께 받은 두 글은 같은 답을 나눈다", async () => {
    const f = fixture(); f.member("conductor"); const worker = f.member();
    await f.orch.assign(f.project.id, worker.handle, { text: "앞 일" });
    await until(() => f.runner.busy.has(worker.id), "앞 일 시작");
    const a = await f.orch.sendUserMessage(f.project.id, { text: "첫째", targetMemberId: worker.id });
    const b = await f.orch.sendUserMessage(f.project.id, { text: "둘째", targetMemberId: worker.id });
    await until(() => f.reply(a.id)?.state === "behind" && f.reply(b.id)?.state === "behind", "둘 다 앞 일 뒤");
    await f.orch.recordPost(f.store.requireMember(worker.id), { kind: "완료", title: "앞 일 끝" });
    f.runner.end(f.store, worker.id, 1);
    await until(() => f.reply(a.id)?.state === "working" && f.reply(b.id)?.state === "working", "함께 받은 턴");
    const runs = f.store.listPendingExecutions().filter(r => r.memberId === worker.id);
    expect(runs).toHaveLength(1);
    await f.orch.recordPost(f.store.requireMember(worker.id), { kind: "진행", title: "둘 다 하겠습니다" });
    await until(() => f.reply(a.id)?.state === "replied" && f.reply(b.id)?.state === "replied", "둘 다 답함");
  });

  test("답 창: 다음 대표 글을 받은 뒤 쓴 글은 앞 글의 답이 아니다(앞 글은 답 없음 그대로)", async () => {
    const f = fixture(); const lead = f.member("conductor");
    const first = await f.orch.sendUserMessage(f.project.id, { text: "첫 지시" });
    await until(() => f.reply(first.id)?.state === "working", "첫 턴");
    f.runner.end(f.store, lead.id, 1);
    await until(() => f.runner.sent.some(s => s.text.includes("보고 보완:")), "보고 보완");
    f.runner.end(f.store, lead.id, 2);
    await until(() => f.reply(first.id)?.state === "no_reply", "첫 글 답 없음");
    const second = await f.orch.sendUserMessage(f.project.id, { text: "둘째 지시" });
    await until(() => f.reply(second.id)?.state === "working", "둘째 턴");
    await f.orch.recordPost(f.store.requireMember(lead.id), { kind: "진행", title: "둘째를 하겠습니다" });
    await until(() => f.reply(second.id)?.state === "replied", "둘째 답함");
    expect(f.reply(first.id)?.state).toBe("no_reply");
    // 서버가 다시 떠도(새 저장소) 같은 판정이다. DB 의 기록만으로 정한다.
    const restarted = new Store(f.db, new Bus());
    expect(restarted.requireMessage(first.id).reply).toEqual(f.reply(first.id));
    expect(restarted.requireMessage(second.id).reply).toEqual(f.reply(second.id));
  });

  test("턴 도중 승인 창 앞에 서면 막힘, 풀리면 다시 일하는 중. 바뀔 때마다 실시간으로 나간다", async () => {
    const f = fixture(); const lead = f.member("conductor");
    const sent = await f.orch.sendUserMessage(f.project.id, { text: "배포해 주세요" });
    await until(() => f.reply(sent.id)?.state === "working", "일하는 중");
    f.store.patchMember(lead.id, { status: "blocked", blockedReason: "permission" });
    await until(() => f.states(sent.id).at(-1) === "blocked", "막힘 사건");
    expect(f.reply(sent.id)).toMatchObject({ state: "blocked", reason: "approval" });
    f.store.patchMember(lead.id, { status: "working", blockedReason: null });
    await until(() => f.states(sent.id).at(-1) === "working", "다시 일하는 중 사건");
    noRepeats(f.seen.get(sent.id)!);
  });

  test("총괄이 답 대신 팀장에게 맡기고 턴을 끝내면 답함", async () => {
    const f = fixture(); const lead = f.member("conductor"); const worker = f.member();
    const sent = await f.orch.sendUserMessage(f.project.id, { text: "결제 화면을 맡겨 주세요" });
    await until(() => f.reply(sent.id)?.state === "working", "일하는 중");
    f.store.noteDelegation(lead.id, f.store.enqueue({ projectId: f.project.id, memberId: worker.id, kind: "instruction", text: "할 일: 결제 화면" }), false);
    f.runner.end(f.store, lead.id, 1);
    await until(() => f.store.listMessages(f.project.id).some(m => m.id.startsWith("msg_delegation_ack_")), "배정 확인 글");
    await until(() => f.reply(sent.id)?.state === "replied" || f.reply(sent.id)?.state === "working", "답함 또는 보고 보완");
    // 보고 보완 턴이 돌아도(일하는 중) 그 턴이 끝나면 맡긴 것으로 답함이다.
    if (f.reply(sent.id)?.state === "working") {
      f.runner.end(f.store, lead.id, 2);
      await until(() => f.reply(sent.id)?.state === "replied", "답함");
    }
  });

  test("서버가 만든 알림(대표 전달 지연·시스템 글)은 답이 아니다", async () => {
    const f = fixture(); const lead = f.member("conductor");
    const sent = await f.orch.sendUserMessage(f.project.id, { text: "확인해 주세요" });
    await until(() => f.reply(sent.id)?.state === "working", "일하는 중");
    f.store.createMessage({ projectId: f.project.id, memberId: lead.id, who: "시스템", kind: "막힘", title: "대표 전달 지연", body: "30분 넘게 전달되지 않았습니다" });
    f.store.createMessage({ projectId: f.project.id, memberId: lead.id, who: "시스템", kind: "시스템", body: "총괄 오류" });
    await Bun.sleep(20);
    expect(f.reply(sent.id)?.state).toBe("working");
  });

  test("잠든 팀장: 깨우는 동안은 깨우는 중", async () => {
    const f = fixture(); f.member("conductor"); const worker = f.member("worker", "claude", "asleep");
    let release!: () => void;
    f.runner.startGate = () => new Promise<void>(resolve => { release = resolve; });
    const sent = await f.orch.sendUserMessage(f.project.id, { text: "일어나서 이것 좀", targetMemberId: worker.id });
    await until(() => f.reply(sent.id)?.state === "waking", "깨우는 중");
    expect(f.reply(sent.id)).toMatchObject({ reason: "waking", memberId: worker.id });
    release();
    await until(() => f.reply(sent.id)?.state === "working", "일하는 중");
  });

  test("전달이 실패로 끝나면 싣지 않는다. 받는 이가 없는 보류 글에도 없다", async () => {
    const f = fixture(); const lead = f.member("conductor");
    f.runner.busy.add(lead.id);
    const sent = await f.orch.sendUserMessage(f.project.id, { text: "실패할 글" });
    const delivery = f.store.listDeliveries().find(d => d.refId === sent.id)!;
    f.store.markFailed(delivery.id, "시험");
    expect(f.store.requireMessage(sent.id).reply).toBeUndefined();
    const orphan = f.store.createMessage({ projectId: f.project.id, mine: true, who: "나", kind: "나", body: "받는 이 없음", delivery: "held" });
    expect(f.store.requireMessage(orphan.id).reply).toBeUndefined();
    void lead;
  });
});

describe("모든 읽기 길과 출시 앱 호환", () => {
  test("상태·대화 페이지·한 건·실시간이 같은 reply 를 싣고, 기존 칸은 그대로다", async () => {
    const f = fixture(); f.member("conductor");
    const server = await startServer({ config: f.config, store: f.store, bus: f.bus, orch: f.orch, delivery: f.orch.deliveryRecovery });
    expect(server.port).not.toBe(7878);
    cleanups.push(async () => { await server.stop(); });
    const base = `http://127.0.0.1:${server.port}`, headers = { Authorization: `Bearer ${f.config.accessCode}`, "Content-Type": "application/json" };
    const posted = await fetch(`${base}/api/projects/${f.project.id}/messages`, { method: "POST", headers, body: JSON.stringify({ id: "z-reply", text: "상태를 알려 주세요" }) });
    expect(posted.status).toBe(200);
    expect((await posted.json() as Message).reply?.memberId).toBeDefined();
    await until(() => f.reply("z-reply")?.state === "working", "일하는 중");
    const get = async <T>(path: string) => (await (await fetch(base + path, { headers })).json()) as T;
    const one = await get<Message>("/api/messages/z-reply");
    const page = await get<{ items: Message[] }>(`/api/projects/${f.project.id}/messages/page?limit=50`);
    const state = await get<{ messages: Message[] }>(`/api/projects/${f.project.id}/state`);
    const sync = await get<{ state: { messages: Message[] } }>(`/api/sync?projectId=${f.project.id}`);
    for (const message of [one, page.items.find(m => m.id === "z-reply")!, state.messages.find(m => m.id === "z-reply")!, sync.state.messages.find(m => m.id === "z-reply")!]) {
      expect(message.reply).toEqual(f.reply("z-reply")!);
    }
    expect(f.seen.get("z-reply")!.at(-1)!.reply).toEqual(f.reply("z-reply")!);
    // 더한 칸은 reply 하나다(출시 앱 0.2.2~0.2.5 는 모르는 칸을 무시한다). 기존 칸의 이름·형은 그대로다.
    const keys = Object.keys(one).filter(key => key !== "reply").sort();
    expect(keys).toEqual(Object.keys(f.store.requireMessage("z-reply")).filter(key => key !== "reply").sort());
    for (const key of ["id", "projectId", "at", "mine", "who", "kind", "body", "delivery", "deliveryNote", "attachments"]) expect(keys).toContain(key);
    expect(typeof one.delivery).toBe("string");
    expect(Object.keys(one.reply!).every(key => ["state", "memberId", "since", "reason"].includes(key))).toBe(true);
    expect(REPLY_STATES).toContain(one.reply!.state);
  });
});
