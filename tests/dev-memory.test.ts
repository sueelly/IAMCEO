// 개발 기억(Hindsight 게이트웨이) 연결: 문서 계약대로 움직이는 가짜 게이트웨이로 서버 업로드·직원 도구·범위·중복·실패를 본다.
// 이 시험이 통과해도 실제 연결 확인은 아니다(실제 게이트웨이 확인은 따로 한다).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Backend, Member } from "../shared/types.ts";
import { Bus } from "../server/bus.ts";
import { loadConfig, updateConfigFile } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { startServer } from "../server/http.ts";
import { DevMemory, devMemoryConfigFromEnv, validateBaseUrl } from "../server/integrations/dev-memory.ts";
import type { AgentToolDef, AgentToolResult } from "../server/orchestrator-api.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import type { Runner, RunnerEvent, SendResult } from "../server/runner/types.ts";
import { Store } from "../server/store.ts";

class FakeRunner implements Runner {
  readonly kind: Backend = "headless";
  private cb: (e: RunnerEvent) => void = () => {};
  busy = new Set<string>();
  async available() { return { ok: true }; }
  async start() { return { sessionId: crypto.randomUUID(), paneId: null }; }
  async send(m: { id: string }): Promise<SendResult> { this.busy.add(m.id); return { ok: true }; }
  isBusy(id: string) { return this.busy.has(id); }
  async compact(): Promise<SendResult> { return { ok: true }; }
  async setParallel(): Promise<SendResult> { return { ok: true }; }
  async interrupt() {}
  async stop(m: { id: string }) { this.busy.delete(m.id); }
  async screen() { return ""; }
  on(cb: (e: RunnerEvent) => void) { this.cb = cb; }
  async shutdown() {}
  end(memberId: string) { this.busy.delete(memberId); this.cb({ type: "turn_end", memberId, finalText: "", isError: false }); }
}

const SERVICE_KEY = "svc-test-key-not-real";
const ID = /^[A-Za-z0-9_-]{1,100}$/;

/** 문서(brain-docs 2026-11-11)의 계약만 흉내 낸다. */
function fakeGateway() {
  const records: { id: string; project_id: string; event_id: string; body: string; experience: Record<string, any> }[] = [];
  const tokens = new Map<string, string>(); // token → project/task
  const seen: { path: string; body: any; auth: string }[] = [];
  let down = 0;
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const auth = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
      const body = req.method === "POST" ? await req.json().catch(() => null) : null;
      seen.push({ path: url.pathname, body, auth });
      if (url.pathname === "/healthz") return Response.json({ ok: true, service: "development-memory", generation_model_calls: 0 });
      if (down > 0) { down--; return Response.json({ error: "memory_temporarily_unavailable" }, { status: 503 }); }
      if (url.pathname.startsWith("/v1/")) {
        if (auth !== SERVICE_KEY) return Response.json({ error: "unauthorized" }, { status: 401 });
        if (url.pathname === "/v1/context") {
          if (!ID.test(body.project_id) || !ID.test(body.task_id)) return Response.json({ error: "invalid_memory_request" }, { status: 400 });
          const scope = `${body.project_id}/${body.task_id}`;
          let token = [...tokens].find(([, s]) => s === scope)?.[0];
          if (!token) { token = `mcp-${crypto.randomUUID()}`; tokens.set(token, scope); }
          const experiences = records.filter((r) => r.project_id === body.project_id && (r.experience.summary + r.experience.content).includes(body.query))
            .slice(0, body.limit ?? 5).map((r) => { const { evidence: _e, ...rest } = r.experience; return { ...rest, id: r.id, project_id: r.project_id, content: String(rest.content).slice(0, 1600), excerpted: String(rest.content).length > 1600 }; });
          return Response.json({ experiences, semantic_index: "available", automatic_rule_adoptions: 0, truncated: false, mcp: { path: `/mcp/${body.project_id}/${body.task_id}`, token } });
        }
        if (url.pathname === "/v1/experiences") {
          const e = body.experience;
          if (!ID.test(body.project_id) || !e?.source?.task_id || !["decision", "mistake", "lesson", "outcome"].includes(e.kind)) return Response.json({ error: "invalid_memory_request" }, { status: 400 });
          const same = records.find((r) => r.project_id === body.project_id && r.event_id === e.event_id);
          const norm = JSON.stringify(e);
          if (same) return same.body === norm ? Response.json({ ...same.experience, id: same.id }, { status: 201 }) : Response.json({ error: "invalid_memory_request" }, { status: 400 });
          const id = `exp-${records.length + 1}`;
          records.push({ id, project_id: body.project_id, event_id: e.event_id, body: norm, experience: { ...e, status: "reported", is_rule: false } });
          return Response.json({ ...e, id, project_id: body.project_id, status: "reported", is_rule: false }, { status: 201 });
        }
        if (url.pathname === "/v1/feedback") {
          const r = records.find((x) => x.id === body.id && x.project_id === body.project_id);
          if (!r || r.experience.source.task_id === body.feedback.task_id) return Response.json({ error: "invalid_memory_request" }, { status: 400 });
          return Response.json({ ...r.experience, id: r.id, feedback: [body.feedback] });
        }
      }
      const m = /^\/mcp\/([^/]+)\/([^/]+)$/.exec(url.pathname);
      if (m) {
        if (tokens.get(auth) !== `${m[1]}/${m[2]}`) return Response.json({ error: "unauthorized" }, { status: 401 });
        if (body.method === "initialize") return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "dm" } } });
        if (body.method === "notifications/initialized") return Response.json({}, { status: 202 });
        if (body.method === "tools/call" && body.params.name === "get_experience") {
          const r = records.find((x) => x.id === body.params.arguments.id && x.project_id === m[1]);
          if (!r) return Response.json({ jsonrpc: "2.0", id: body.id, result: { isError: true, content: [{ type: "text", text: "not found" }] } });
          return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify({ ...r.experience, id: r.id }) }] } });
        }
        return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "unknown" } });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, records, seen, tokens, failNext: (n: number) => { down = n; }, stop: () => server.stop(true) };
}

const cleanups: (() => Promise<void> | void)[] = [];
afterAll(async () => { for (const c of cleanups) await c(); });
const settle = () => new Promise((r) => setTimeout(r, 40));

async function setup(opts: { memory: boolean; keyFile?: string } = { memory: true }) {
  const home = mkdtempSync(join(tmpdir(), "iamceo-mem-"));
  const env = { IAMCEO_HOME: home, IAMCEO_PORT: "0" };
  updateConfigFile({ accessCode: "code", hosts: ["127.0.0.1"] }, env);
  const config = loadConfig(env);
  const bus = new Bus();
  const store = new Store(openDb(config.dbPath), bus);
  const gw = fakeGateway();
  const keyFile = opts.keyFile ?? join(home, "memory-key");
  if (!opts.keyFile) writeFileSync(keyFile, SERVICE_KEY + "\n", { mode: 0o600 });
  const project = store.createProject({ name: "기억 켠 프로젝트", cwd: home });
  // 새 프로젝트는 기억을 켠 채로 생긴다. 끈 프로젝트를 보려고 하나는 대표가 끈 것으로 만든다.
  const other = store.createProject({ name: "다른 프로젝트", cwd: home, memory: false });
  const devMemory = opts.memory ? new DevMemory({ baseUrl: gw.url, keyFile, projects: [project.id] }) : null;
  const runner = new FakeRunner();
  const orch = new Orchestrator({ config, store, runners: new Map<Backend, Runner>([["headless", runner]]), devMemory });
  const server = await startServer({ config, store, bus, orch });
  const url = server.urls[0]!;
  orch.setServerUrl(url);
  cleanups.push(async () => { await orch.shutdown(); await server.stop(); gw.stop(); });
  const call = async (member: Member, name: string, args: Record<string, unknown> = {}): Promise<AgentToolResult> => {
    const res = await fetch(`${url}/agent/tool`, { method: "POST", headers: { Authorization: `Bearer ${store.getMemberToken(member.id)}`, "Content-Type": "application/json" }, body: JSON.stringify({ name, args }) });
    return (await res.json()) as AgentToolResult;
  };
  const tools = async (member: Member) => {
    const res = await fetch(`${url}/agent/tools`, { headers: { Authorization: `Bearer ${store.getMemberToken(member.id)}` } });
    return ((await res.json()) as AgentToolDef[]).map((t) => t.name);
  };
  const worker = async (projectId: string, handle: string) => {
    const lead = await orch.ensureConductor(projectId); runner.end(lead.id);
    const w = (await orch.addMember(projectId, { name: handle, handle, role: "개발" })).member;
    runner.end(w.id); await settle();
    return w;
  };
  return { home, store, orch, gw, project, other, call, tools, worker, devMemory };
}

describe("개발 기억 연결", () => {
  test("설정이 없으면 기억 도구가 안 보이고 외부 호출도 없다. 설정은 루프백·Tailscale HTTPS 주소만 받는다", async () => {
    const t = await setup({ memory: false });
    const w = await t.worker(t.project.id, "w1");
    expect((await t.tools(w)).some((n) => n.startsWith("memory_"))).toBe(false);
    expect((await t.call(w, "memory_search", { query: "x" })).text).toContain("쓸 수 없는 도구");
    const d = t.store.createDecision({ projectId: t.project.id, memberId: w.id, who: w.name, title: "정할 것", options: [{ k: "a", label: "가" }] });
    await t.orch.answerDecision(d.id, { choice: "a" });
    expect(t.store.listMemoryUploads()).toHaveLength(0);
    expect(t.gw.seen).toHaveLength(0);

    expect(devMemoryConfigFromEnv({})).toBeNull();
    // 프로젝트 목록이 없어도 연결 설정만 있으면 켠다. 쓸지 말지는 프로젝트마다 정한다(목록은 이전 프로젝트용).
    expect(devMemoryConfigFromEnv({ IAMCEO_MEMORY_URL: "https://x.tail1.ts.net:11443", IAMCEO_MEMORY_KEY_FILE: "/k" })).toEqual({ baseUrl: "https://x.tail1.ts.net:11443", keyFile: "/k", projects: [] });
    expect(validateBaseUrl("https://hyejoo-mac-mini.tail5169d3.ts.net:11443")).toBe("https://hyejoo-mac-mini.tail5169d3.ts.net:11443");
    expect(() => validateBaseUrl("http://hyejoo-mac-mini.tail5169d3.ts.net:11443")).toThrow();
    expect(() => validateBaseUrl("https://brain.enouv.studio")).toThrow();
    expect(() => validateBaseUrl("https://x.tail1.ts.net:11443/brain-docs/")).toThrow();
  });

  test("대표가 결재에 답하면 명시 결정으로 한 번만 올라가고, 직원이 쓴 배경과 대표 원문이 구분된다", async () => {
    const t = await setup();
    const w = await t.worker(t.project.id, "w1");
    const task = (await t.call(w, "task", { title: "결제 개편", branch: "feat/pay", worktree: "/tmp/pay" })).text;
    const taskId = /#(tk_[A-Za-z0-9]+)/.exec(task)![1]!;
    const d = t.store.createDecision({ projectId: t.project.id, memberId: w.id, who: w.name, title: "환불 방식", detail: "직원 설명: 부분 환불이 필요합니다", options: [{ k: "a", label: "부분 환불", desc: "금액만 돌려줌" }, { k: "b", label: "전체 환불" }], rec: "a", taskId });
    await t.orch.answerDecision(d.id, { choice: "a", note: "카드사 수수료는 우리가 낸다" });
    await t.devMemory!.flush(t.store);
    expect(t.gw.records).toHaveLength(1);
    const rec = t.gw.records[0]!;
    expect(rec.project_id).toBe(`iamceo-${t.project.id}`);
    expect(rec.experience.kind).toBe("decision");
    expect(rec.experience.source).toEqual({ task_id: taskId, item_id: d.id, service: "iamceo" });
    expect(rec.experience.evidence[0]).toEqual({ kind: "classification", text: "explicit_user_decision" });
    expect(rec.experience.content).toContain('대표 답(원문): "부분 환불" (금액만 돌려줌)');
    expect(rec.experience.content).toContain("대표 메모(원문): 카드사 수수료는 우리가 낸다");
    expect(rec.experience.content).toContain("배경(직원이 쓴 설명이며 대표 결정이 아니다):\n직원 설명: 부분 환불이 필요합니다");
    expect(t.store.listMemoryUploads()[0]).toMatchObject({ status: "sent", remoteId: "exp-1", refId: d.id });
    // 같은 답을 다시 처리해도(재시작 뒤 대기열 재전송 포함) 기록은 하나
    await t.orch.answerDecision(d.id, { choice: "a", note: "카드사 수수료는 우리가 낸다" });
    t.store.settleMemoryUpload(t.store.listMemoryUploads()[0]!.eventId, { status: "pending", attempts: 1, nextAt: new Date(0).toISOString() });
    await t.devMemory!.flush(t.store);
    expect(t.gw.records).toHaveLength(1);
    expect(t.store.listMemoryUploads()).toHaveLength(1);
    // 대표가 끈 프로젝트의 결재는 올리지 않는다
    const ow = await t.worker(t.other.id, "o1");
    const od = t.store.createDecision({ projectId: t.other.id, memberId: ow.id, who: ow.name, title: "다른 일", options: [{ k: "a", label: "가" }] });
    await t.orch.answerDecision(od.id, { choice: "a" });
    expect(t.store.listMemoryUploads(t.other.id)).toHaveLength(0);
  });

  test("직원 검색·전문 조회는 자기 프로젝트 범위만 보고, 키는 직원에게 가지 않는다", async () => {
    const t = await setup();
    const w = await t.worker(t.project.id, "w1");
    expect(await t.tools(w)).toEqual(expect.arrayContaining(["memory_search", "memory_get", "memory_record", "memory_feedback"]));
    const ow = await t.worker(t.other.id, "o1");
    expect((await t.tools(ow)).some((n) => n.startsWith("memory_"))).toBe(false);
    // 다른 프로젝트의 기록이 게이트웨이에 있어도
    t.gw.records.push({ id: "exp-x", project_id: `iamceo-${t.other.id}`, event_id: "x", body: "{}", experience: { kind: "lesson", summary: "트랜잭션 비밀 교훈", content: "트랜잭션", source: { task_id: "t" } } });
    const d = t.store.createDecision({ projectId: t.project.id, memberId: w.id, who: w.name, title: "트랜잭션 처리", options: [{ k: "a", label: "트랜잭션 안에서" }] });
    await t.orch.answerDecision(d.id, { choice: "a" });
    await t.devMemory!.flush(t.store);
    const found = await t.call(w, "memory_search", { query: "트랜잭션" });
    expect(found.isError).toBeFalsy();
    const parsed = JSON.parse(found.text);
    const mine = t.store.listMemoryUploads(t.project.id)[0]!.remoteId!;
    expect(parsed.experiences.map((e: { id: string }) => e.id)).toEqual([mine]);
    expect(found.text).not.toContain("mcp-");
    const ctx = t.gw.seen.find((s) => s.path === "/v1/context")!;
    expect(ctx.body).toMatchObject({ project_id: `iamceo-${t.project.id}`, task_id: `iamceo-${w.id}-general`, query: "트랜잭션" });
    const full = await t.call(w, "memory_get", { id: mine });
    expect(full.isError).toBeFalsy();
    expect(JSON.parse(full.text).evidence[0].text).toBe("explicit_user_decision");
    expect((await t.call(w, "memory_get", { id: "exp-x" })).isError).toBe(true); // 다른 프로젝트 기록은 MCP 범위 밖
    for (const s of t.gw.seen) if (s.path.startsWith("/mcp/")) expect(s.auth.startsWith("mcp-")).toBe(true);
    for (const s of t.gw.seen) if (s.path.startsWith("/v1/")) expect(s.auth).toBe(SERVICE_KEY);
  });

  test("직원 기록은 AI 보고로 표시되고, 확인 결과는 근거가 있어야 하며, 같은 내용은 한 건이다", async () => {
    const t = await setup();
    const w = await t.worker(t.project.id, "w1");
    const noEvidence = await t.call(w, "memory_record", { kind: "outcome", basis: "verified", summary: "시험 통과", content: "통과했다" });
    expect(noEvidence.isError).toBe(true);
    const args = { kind: "outcome", basis: "verified", summary: "작업별 대화 시험 통과", content: "서버 시험 12개 통과", evidence: ["bun test tests/task-threads.test.ts → 12 pass 0 fail"], commit_sha: "3807ee9" };
    const first = await t.call(w, "memory_record", args);
    expect(first.isError).toBeFalsy();
    const again = await t.call(w, "memory_record", args);
    expect(again.text).toBe(first.text);
    expect(t.gw.records).toHaveLength(1);
    const e = t.gw.records[0]!.experience;
    expect(e.evidence[0]).toEqual({ kind: "classification", text: "ai_reported_verified" });
    expect(e.content.startsWith("분류: AI 보고(직원이 확인한 결과) — 대표 결정 아님")).toBe(true);
    expect(e.source).toMatchObject({ task_id: `iamceo-${w.id}-general`, service: "iamceo", commit_sha: "3807ee9" });
    const guess = await t.call(w, "memory_record", { kind: "lesson", basis: "ai_inference", summary: "아마 캐시 문제", content: "추측" });
    expect(t.gw.records[1]!.experience.evidence[0].text).toBe("ai_inference");
    expect(guess.isError).toBeFalsy();
    // 자기 작업 기록에는 피드백할 수 없다(게이트웨이 계약)
    expect((await t.call(w, "memory_feedback", { id: "exp-1", outcome: "helped" })).isError).toBe(true);
    // 작업을 쓰기 시작한 직원은 기록에도 작업을 밝혀야 한다
    await t.call(w, "task", { title: "작업 A", branch: "feat/a" });
    expect((await t.call(w, "memory_record", { kind: "lesson", basis: "ai_inference", summary: "작업 없는 기록", content: "x" })).text).toContain("task_id");
  });

  test("게이트웨이가 잠깐 안 되면 대기열에 남아 같은 사건으로 다시 보내고, 키 파일이 없으면 키 없이 알린다", async () => {
    const t = await setup();
    const w = await t.worker(t.project.id, "w1");
    t.gw.failNext(1);
    const d = t.store.createDecision({ projectId: t.project.id, memberId: w.id, who: w.name, title: "배포 시각", options: [{ k: "a", label: "밤" }] });
    await t.orch.answerDecision(d.id, { choice: "a" });
    await t.devMemory!.flush(t.store);
    const job = t.store.listMemoryUploads()[0]!;
    expect(job).toMatchObject({ status: "pending", attempts: 1 });
    expect(job.lastError).toContain("503");
    t.store.settleMemoryUpload(job.eventId, { status: "pending", attempts: 1, nextAt: new Date(0).toISOString() });
    await t.devMemory!.flush(t.store);
    expect(t.store.listMemoryUploads()[0]).toMatchObject({ status: "sent", attempts: 2 });
    expect(t.gw.records).toHaveLength(1);

    const missing = await setup({ memory: true, keyFile: join(tmpdir(), `no-such-key-${crypto.randomUUID()}`) });
    const mw = await missing.worker(missing.project.id, "w1");
    const res = await missing.call(mw, "memory_search", { query: "x" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("서비스 키 파일을 읽을 수 없습니다");
    expect(missing.gw.seen.filter((s) => s.path !== "/healthz")).toHaveLength(0);
  });
});
