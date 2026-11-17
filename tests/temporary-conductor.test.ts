import { expect, test } from "bun:test";
import { fixture } from "./fixtures/harness-fixture.ts";
import { startServer } from "../server/http.ts";
import { Bus } from "../server/bus.ts";
import type { Runner, RunnerMember } from "../server/runner/types.ts";

function setup() {
  const f = fixture();
  const task = f.store.ensureSourceTask({ projectId: f.project.id, sourceRef: "temporary-review", title: "임시 검수 총괄", origin: "owner" }).task;
  const source = f.store.createMessage({ projectId: f.project.id, taskId: task.id, mine: true, who: "대표", kind: "나", body: "기존 총괄을 유지하고 이번 대기열을 검수할 임시 총괄을 추가하세요" });
  const request = { name: "임시 검수 총괄", role: "이번 대기열 검수 후 인계하고 종료", sourceMessageId: source.id, taskId: task.id, modelOverride: "gpt-6-astra", effortOverride: "xhigh", parallel: true } as const;
  const create = (patch = {}) => f.orch.createTemporaryConductor(f.project.id, { ...request, ...patch });
  return { ...f, task, source, request, create };
}

test("temporary conductor starts with requested Codex configuration and preserves primary and worker allowance", async () => {
  const f = setup();
  f.store.patchSettings({ maxAwakeWorkers: 2 });
  const workers = f.store.listMembers(f.project.id).filter(m => m.kind === "worker");
  const starts: RunnerMember[] = [];
  const start = f.runner.start.bind(f.runner);
  f.runner.start = async member => { starts.push(member); return start(member); };
  const helper = await f.create();
  expect(helper.kind).toBe("conductor");
  expect(helper.cli).toBe("codex");
  expect(helper.appliedModel).toBe("gpt-6-astra");
  expect(helper.appliedEffort).toBe("xhigh");
  expect(helper.parallel).toBe(true);
  expect(starts).toHaveLength(1);
  expect(starts[0]).toMatchObject({ id: helper.id, kind: "conductor", cli: "codex", model: "gpt-6-astra", effort: "xhigh", parallel: true });
  expect(f.store.getConductor(f.project.id)?.id).toBe(f.lead.id);
  expect(f.store.listMembers(f.project.id).filter(m => m.kind === "worker")).toEqual(workers);
  expect(f.runner.to(f.lead)).toHaveLength(0);
});

test("new Claude workers still apply Ultracode before their first parallel instruction", async () => {
  const f = setup();
  const controls: boolean[] = [];
  (f.runner as Runner).setParallel = async (_member, on) => { controls.push(on); return { ok: true }; };
  const created = await f.orch.addMember(f.project.id, { name: "Claude 병렬 직원", cli: "claude", parallel: true, firstInstruction: "독립 항목을 검수하세요", taskId: f.task.id });
  expect(controls).toEqual([true]);
  expect(created.member.parallel).toBe(true);
  expect(f.runner.to(created.member)).toHaveLength(1);
});

test("concurrent retry of the same source and task creates once and rejects a different request", async () => {
  const f = setup();
  const [first, repeated] = await Promise.all([f.create(), f.create()]);
  expect(repeated.id).toBe(first.id);
  expect((await f.create()).id).toBe(first.id);
  const different = f.store.createMessage({ projectId: f.project.id, taskId: f.task.id, mine: true, who: "대표", kind: "나", body: "다른 요청" });
  await expect(f.create({ sourceMessageId: different.id, name: "두 번째 임시 총괄" })).rejects.toMatchObject({ status: 409 });
  expect(f.store.listMembers(f.project.id).filter(m => m.kind === "conductor")).toHaveLength(2);
});

test.each(["foreign source", "worker source", "missing source", "foreign task", "missing task", "mismatched task", "missing primary", "unrelated conductor"])("rejects %s without spawning or changing existing members", async condition => {
  const f = setup();
  const other = f.store.createProject({ name: "다른 프로젝트", cwd: f.project.cwd });
  const patch: Record<string, string> = {};
  if (condition === "foreign source") patch.sourceMessageId = f.store.createMessage({ projectId: other.id, mine: true, who: "대표", kind: "나", body: "다른 프로젝트 지시" }).id;
  if (condition === "worker source") patch.sourceMessageId = f.store.createMessage({ projectId: f.project.id, mine: false, who: f.worker.name, memberId: f.worker.id, kind: "진행", body: "직원 요청" }).id;
  if (condition === "missing source") patch.sourceMessageId = "missing";
  if (condition === "foreign task") patch.taskId = f.store.ensureSourceTask({ projectId: other.id, sourceRef: "foreign", title: "다른 업무", origin: "owner" }).task.id;
  if (condition === "missing task") patch.taskId = "missing";
  if (condition === "mismatched task") patch.taskId = f.store.ensureSourceTask({ projectId: f.project.id, sourceRef: "unrelated", title: "별도 업무", origin: "owner" }).task.id;
  if (condition === "missing primary") f.store.removeMember(f.lead.id);
  if (condition === "unrelated conductor") f.make("unrelated", "기존 추가 총괄", "conductor");
  const before = f.store.listMembers(f.project.id);
  await expect(f.create(patch)).rejects.toThrow();
  expect(f.store.listMembers(f.project.id)).toEqual(before);
  expect(f.runner.sent).toHaveLength(0);
});

test("created helper can confirm contracts, mark review, and delegate through real agent authorization", async () => {
  const f = setup(), helper = await f.create();
  const contract = f.orch.saveTask(f.worker, { taskId: f.task.id, contract: { kind: "other", goal: "대기열 검수", acceptance: ["각 항목 근거를 검수한다"] } }).contract!;
  const confirmation = await f.tool(helper, "task", { task_id: f.task.id, confirm_contract_rev: contract.rev });
  expect(confirmation.isError).not.toBe(true);
  expect(f.store.getTaskContract(f.task.id)?.confirmedByMemberId).toBe(helper.id);
  const stage = await f.tool(helper, "task_stage", { task_id: f.task.id, stage: "review", evidence: "독립 검수 담당자를 지정했습니다" });
  expect(stage.isError).not.toBe(true);
  expect(f.store.listStageMarks(f.task.id).at(-1)?.memberId).toBe(helper.id);
  const assigned = await f.tool(helper, "team_assign", { task_id: f.task.id, member: f.worker.handle, text: "검수 근거를 정리하세요", user_quote: f.source.body });
  expect(assigned.isError).not.toBe(true);
  expect(f.store.listDeliveries().some(d => d.memberId === f.worker.id && d.taskId === f.task.id)).toBe(true);
  expect((await f.tool(f.worker, "task_stage", { task_id: f.task.id, stage: "review", evidence: "직원 시도" })).isError).toBe(true);
  expect((await f.tool(f.worker, "team_assign", { task_id: f.task.id, member: f.worker2.handle, text: "직원 시도" })).isError).toBe(true);
});

test("HTTP creation requires representative authentication, rejects unknown inputs, and returns no member token", async () => {
  const f = setup(), server = await startServer({ config: f.config, store: f.store, bus: new Bus(), orch: f.orch });
  try {
    const url = `${server.urls[0]}/api/projects/${f.project.id}/temporary-conductor`;
    const post = (token?: string, body = f.request) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    expect((await post()).status).toBe(401);
    expect((await post(f.store.getMemberToken(f.lead.id)!)).status).toBe(401);
    expect((await post(f.config.accessCode, { ...f.request, kind: "root" } as never)).status).toBe(400);
    const response = await post(f.config.accessCode);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.kind).toBe("conductor");
    expect(body.token).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(f.store.getMemberToken(body.id)!);
  } finally { await server.stop(); }
});

test.each(["working", "blocked", "busy", "queued", "held", "delivering", "decision", "lease", "execution", "lifecycle", "compaction"])("temporary retirement refuses %s without stopping or removing state", async condition => {
  const f = setup(), helper = await f.create(), at = new Date().toISOString();
  const identity = { terminalId: helper.paneId, sessionId: helper.sessionId, sessionGeneration: f.store.memberRevisions(helper.id).sessionGeneration, process: null };
  let stopped = false;
  f.runner.stop = async () => { stopped = true; };
  if (condition === "working" || condition === "blocked") f.store.patchMember(helper.id, { status: condition });
  if (condition === "busy") f.runner.busy.add(helper.id);
  if (["queued", "held", "delivering"].includes(condition)) {
    const delivery = f.store.enqueue({ projectId: f.project.id, memberId: helper.id, taskId: f.task.id, kind: "instruction", text: "보존해야 하는 입력", status: condition === "held" ? "held" : "queued" });
    if (condition === "delivering") f.store.db.query("UPDATE deliveries SET status='delivering' WHERE id=?").run(delivery.id);
  }
  if (condition === "decision") f.store.createDecision({ projectId: f.project.id, memberId: helper.id, taskId: f.task.id, who: helper.name, title: "대표 결정 대기" });
  if (condition === "lease") f.store.saveLease({ memberId: helper.id, claimId: "claim", leaseId: "lease", expiresAt: Date.now() + 60_000, lastInputSequence: 0, identity });
  if (condition === "execution") f.store.saveExecutionJournal({ runId: "uncertain", memberId: helper.id, projectId: f.project.id, identity, turn: 1, deliveryIds: [], phase: "unknown", inputReceivedAt: at, startedAt: null, lastProgressAt: null, endedAt: null, result: null, reason: "timeout", exitCode: null, interruptionNotifiedAt: null, reportRequestedAt: null, createdAt: at, updatedAt: at });
  if (condition === "lifecycle") f.store.saveLifecycleJournal({ operationId: "uncertain", memberId: helper.id, projectId: f.project.id, intent: "sleep", phase: "unknown", identity, runId: null, deliveryIds: [], baseline: null, reason: "timeout", exitCode: null, createdAt: at, updatedAt: at });
  if (condition === "compaction") f.store.saveContextState({ ...f.store.ensureContextState(helper.id), compaction: { id: "compact", phase: "queued", trigger: "manual", reason: null, requestedAt: at, startedAt: null, finishedAt: null } });
  const before = f.store.requireMember(helper.id), decisions = f.store.listOpenDecisions(f.project.id), deliveries = f.store.listUndelivered(f.project.id);
  await expect(f.orch.retireTemporaryConductor(f.project.id, helper.id, f.request)).rejects.toMatchObject({ status: 409 });
  expect(stopped).toBe(false);
  expect(f.store.requireMember(helper.id)).toEqual(before);
  expect(f.store.listOpenDecisions(f.project.id)).toEqual(decisions);
  expect(f.store.listUndelivered(f.project.id)).toEqual(deliveries);
});

test("safe retirement uses idle-only stop, preserves reports and primary, and refuses primary identity", async () => {
  const f = setup(), helper = await f.create();
  const report = f.store.createMessage({ projectId: f.project.id, taskId: f.task.id, memberId: helper.id, mine: false, who: helper.name, kind: "진행", body: "검수 결과와 인계를 보존합니다" });
  await expect(f.orch.retireTemporaryConductor(f.project.id, f.lead.id, f.request)).rejects.toThrow();
  let stopOptions: unknown;
  (f.runner as Runner).stop = async (_member, options) => { stopOptions = options; };
  await f.orch.retireTemporaryConductor(f.project.id, helper.id, f.request);
  expect(stopOptions).toEqual({ whileWorking: false });
  expect(f.store.getMember(helper.id)).toBeNull();
  expect(f.store.getConductor(f.project.id)?.id).toBe(f.lead.id);
  expect(f.store.requireMessage(report.id).body).toBe(report.body);
});

test("retired request remains retired when the representative retries creation", async () => {
  const f = setup(), helper = await f.create();
  await f.orch.retireTemporaryConductor(f.project.id, helper.id, f.request);
  await expect(f.create()).rejects.toMatchObject({ status: 409 });
  expect(f.store.listMembers(f.project.id).filter(m => m.kind === "conductor")).toHaveLength(1);
  const retirement = f.store.listMessages(f.project.id).filter(m => m.kind === "시스템" && m.aboutMessageId === f.source.id);
  expect(retirement).toHaveLength(1);
  expect(retirement[0]?.taskId).toBe(f.task.id);
  expect(f.store.doneMark(f.task.id)).toBeNull();
});

test("temporary creation rejects a backend without verified idle-only retirement", async () => {
  const f = setup();
  f.store.setRuntimeBackend("headless");
  await expect(f.create()).rejects.toMatchObject({ status: 409 });
  expect(f.store.listMembers(f.project.id)).toHaveLength(3);
});

test("temporary retirement refuses a non-core helper without removing it", async () => {
  const f = setup(), helper = await f.create();
  f.store.patchMember(helper.id, { backend: "headless" });
  await expect(f.orch.retireTemporaryConductor(f.project.id, helper.id, f.request)).rejects.toMatchObject({ status: 409 });
  expect(f.store.getMember(helper.id)).not.toBeNull();
});

test("input arriving during idle stop prevents removal and remains queued", async () => {
  const f = setup(), helper = await f.create();
  f.runner.stop = async () => { f.store.enqueue({ projectId: f.project.id, memberId: helper.id, taskId: f.task.id, kind: "instruction", text: "종료와 경합한 새 입력" }); };
  await expect(f.orch.retireTemporaryConductor(f.project.id, helper.id, f.request)).rejects.toMatchObject({ status: 409 });
  expect(f.store.getMember(helper.id)).not.toBeNull();
  expect(f.store.listPending(helper.id).map(d => d.text)).toEqual(["종료와 경합한 새 입력"]);
});

test("creation retry cannot return a helper whose retirement is already in progress", async () => {
  const f = setup(), helper = await f.create();
  let release!: () => void;
  const stopping = new Promise<void>(resolve => { release = resolve; });
  f.runner.stop = async () => { await stopping; };
  const retiring = f.orch.retireTemporaryConductor(f.project.id, helper.id, f.request);
  try { await expect(f.create()).rejects.toMatchObject({ status: 409 }); }
  finally { release(); await retiring; }
});

test("retirement HTTP is representative-only and verifies request binding", async () => {
  const f = setup(), helper = await f.create();
  const server = await startServer({ config: f.config, store: f.store, bus: new Bus(), orch: f.orch });
  try {
    const url = `${server.urls[0]}/api/projects/${f.project.id}/temporary-conductor/${helper.id}/retire`;
    const request = { sourceMessageId: f.source.id, taskId: f.task.id };
    const post = (token: string, body = request) => fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect((await post(f.store.getMemberToken(helper.id)!)).status).toBe(401);
    expect((await post(f.config.accessCode, { ...request, sourceMessageId: "missing" })).status).toBe(400);
    expect((await post(f.config.accessCode)).status).toBe(200);
    expect(f.store.getMember(helper.id)).toBeNull();
  } finally { await server.stop(); }
});
