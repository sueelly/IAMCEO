// 기억 운영: 프로젝트 기본값, 일 시작 전 검색, 총괄의 대표 결정 선별 기록, 대기열(장애·응답 유실·대체 순서·빠진 결재), 도구 목록 갱신.
// 문서 계약을 흉내 낸 가짜 게이트웨이로 본다. 이 시험이 통과해도 실제 게이트웨이 확인은 아니다(따로 한다).
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Backend, Member } from "../shared/types.ts";
import { Bus } from "../server/bus.ts";
import { loadConfig, updateConfigFile } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { startServer } from "../server/http.ts";
import { DevMemory, memoryKindLabel } from "../server/integrations/dev-memory.ts";
import type { AgentToolDef, AgentToolResult } from "../server/orchestrator-api.ts";
import { Orchestrator, formatMemoryContext } from "../server/orchestrator.ts";
import type { Runner, RunnerEvent, RunnerMember, SendResult, StartOpts } from "../server/runner/types.ts";
import { CoreError } from "../server/runner/core-client.ts";
import { Store } from "../server/store.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";

const SERVICE_KEY = "svc-test-key-not-real";
const ID = /^[A-Za-z0-9_-]{1,100}$/;

/** 문서(brain-docs 2026-11-11) 계약만 흉내 낸다: 같은 사건 id 는 같은 본문만 받고, supersedes 는 같은 프로젝트의 앞 기록이어야 한다. */
function fakeGateway() {
  const records: { id: string; project_id: string; event_id: string; body: string; experience: Record<string, any>; superseded_by?: string }[] = [];
  const tokens = new Map<string, string>();
  const seen: { path: string; body: any }[] = [];
  let down = 0;
  let dropAfterSave = 0;
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const auth = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
      const body = req.method === "POST" ? await req.json().catch(() => null) : null;
      seen.push({ path: url.pathname, body });
      if (url.pathname === "/healthz") return Response.json({ ok: true, service: "development-memory" });
      if (down > 0) { down--; return Response.json({ error: "memory_temporarily_unavailable" }, { status: 503 }); }
      if (auth !== SERVICE_KEY && url.pathname.startsWith("/v1/")) return Response.json({ error: "unauthorized" }, { status: 401 });
      if (url.pathname === "/v1/context") {
        if (!ID.test(body.project_id) || !ID.test(body.task_id)) return Response.json({ error: "invalid_memory_request" }, { status: 400 });
        const scope = `${body.project_id}/${body.task_id}`;
        let token = [...tokens].find(([, s]) => s === scope)?.[0];
        if (!token) { token = `mcp-${crypto.randomUUID()}`; tokens.set(token, scope); }
        const words = String(body.query).split(/[\s,.!?·"'()]+/).filter((w) => w.length >= 2);
        const experiences = records.filter((r) => r.project_id === body.project_id && !r.superseded_by && words.some((w) => `${r.experience.summary}\n${r.experience.content}`.includes(w)))
          .slice(0, body.limit ?? 5).map((r) => ({ ...r.experience, evidence: undefined, id: r.id, project_id: r.project_id, event_id: r.event_id, content: String(r.experience.content).slice(0, 1600), excerpted: String(r.experience.content).length > 1600 }));
        return Response.json({ experiences, semantic_index: "available", truncated: false, mcp: { path: `/mcp/${body.project_id}/${body.task_id}`, token } });
      }
      if (url.pathname === "/v1/experiences") {
        const e = body.experience;
        if (!ID.test(body.project_id) || !e?.source?.task_id || !["decision", "mistake", "lesson", "outcome"].includes(e.kind)) return Response.json({ error: "invalid_memory_request" }, { status: 400 });
        const same = records.find((r) => r.project_id === body.project_id && r.event_id === e.event_id);
        const norm = JSON.stringify(e);
        if (same) return same.body === norm ? Response.json({ ...same.experience, id: same.id }, { status: 201 }) : Response.json({ error: "invalid_memory_request" }, { status: 400 });
        if (e.supersedes) {
          const target = records.find((r) => r.id === e.supersedes && r.project_id === body.project_id);
          if (!target) return Response.json({ error: "invalid_memory_request" }, { status: 400 });
        }
        const id = `exp-${records.length + 1}`;
        records.push({ id, project_id: body.project_id, event_id: e.event_id, body: norm, experience: { ...e, status: "reported" } });
        if (e.supersedes) records.find((r) => r.id === e.supersedes)!.superseded_by = id;
        if (dropAfterSave > 0) { dropAfterSave--; return new Response("bad gateway", { status: 502 }); }
        return Response.json({ ...e, id, project_id: body.project_id, status: "reported" }, { status: 201 });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`, records, seen,
    failNext: (n: number) => { down = n; },
    dropResponseAfterSave: (n: number) => { dropAfterSave = n; },
    contextCalls: () => seen.filter((s) => s.path === "/v1/context").length,
    stop: () => server.stop(true),
  };
}

class FakeRunner implements Runner {
  readonly kind: Backend = "headless";
  private cb: (e: RunnerEvent) => void = () => {};
  busy = new Set<string>();
  sent: { id: string; text: string }[] = [];
  async available() { return { ok: true }; }
  async start() { return { sessionId: crypto.randomUUID(), paneId: null }; }
  async send(m: { id: string }, text: string): Promise<SendResult> { this.busy.add(m.id); this.sent.push({ id: m.id, text }); return { ok: true }; }
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

const cleanups: (() => Promise<void> | void)[] = [];
afterAll(async () => { for (const c of cleanups.reverse()) await c(); });
async function until(check: () => boolean, what = "조건") {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(10);
  if (!check()) throw new Error(`${what}을 기다리다 시간이 지났습니다`);
}
const settle = () => Bun.sleep(40);

async function setup() {
  const home = mkdtempSync(join(tmpdir(), "iamceo-memops-"));
  const env = { IAMCEO_HOME: home, IAMCEO_PORT: "0" };
  updateConfigFile({ accessCode: "access-code-for-test", hosts: ["127.0.0.1"] }, env);
  const config = loadConfig(env);
  const bus = new Bus();
  const store = new Store(openDb(config.dbPath), bus);
  store.patchSettings({ maxConcurrentTurns: 8, boardTidyHours: 0 });
  const gw = fakeGateway();
  const keyFile = join(home, "memory-key");
  writeFileSync(keyFile, SERVICE_KEY + "\n", { mode: 0o600 });
  // 서버 환경 목록(projects)은 비워 둔다. 새 프로젝트는 스스로 켠 값으로 기억을 쓴다.
  const devMemory = new DevMemory({ baseUrl: gw.url, keyFile, projects: [] });
  const project = store.createProject({ name: "기억 운영", cwd: home });
  const off = store.createProject({ name: "기억 끈 곳", cwd: home, memory: false });
  const runner = new FakeRunner();
  const orch = new Orchestrator({ config, store, runners: new Map<Backend, Runner>([["headless", runner]]), devMemory, timings: { tickMs: 60_000, healthMs: 60_000 } });
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
  const lead = async (projectId: string) => {
    const m = await orch.ensureConductor(projectId);
    await settle(); runner.end(m.id); await settle();
    return store.requireMember(m.id);
  };
  const worker = async (projectId: string, handle: string) => {
    await lead(projectId);
    const w = (await orch.addMember(projectId, { name: handle, handle, role: "개발" })).member;
    await settle(); runner.end(w.id); await settle();
    return store.requireMember(w.id);
  };
  /** 대표 글을 보내고 총괄에게 나간 묶음을 돌려준다. */
  const ownerSays = async (projectId: string, text: string, extra: { taskId?: string } = {}) => {
    const leadId = store.getConductor(projectId)!.id;
    const before = runner.sent.length;
    const message = await orch.sendUserMessage(projectId, { text, ...extra });
    await until(() => runner.sent.slice(before).some((s) => s.id === leadId), "총괄 전달");
    const sent = runner.sent.slice(before).find((s) => s.id === leadId)!;
    runner.end(leadId); await settle();
    return { message, sent: sent.text };
  };
  const owner = (projectId: string, body: string, extra: Partial<{ taskId: string; decisionId: string }> = {}) =>
    store.createMessage({ projectId, mine: true, who: "나", kind: "나", body, ...extra });
  return { home, store, orch, gw, devMemory, project, off, runner, call, tools, lead, worker, ownerSays, owner };
}

test("새 프로젝트는 기억을 켠 채로 생기고, 대표가 끈 값은 서버 목록이 덮지 않는다. 연결 상태는 따로 보인다", async () => {
  const t = await setup();
  expect(t.project.memory).toMatchObject({ mode: "on", on: true });
  expect(t.project.memory!.enabledAt).toBeString();
  expect(t.off.memory).toEqual({ mode: "off", on: false, enabledAt: null });
  expect(t.store.requireProject("hq").memory).toMatchObject({ mode: "legacy", on: false });

  // 이전 프로젝트(값 없음)는 서버 환경 목록을 따른다. 대표가 정하면 그 값이 앞선다.
  const old = t.store.createProject({ name: "이전 프로젝트", cwd: t.home });
  t.store.db.query("UPDATE projects SET memory_mode = NULL, memory_enabled_at = NULL WHERE id = ?").run(old.id);
  expect(t.store.requireProject(old.id).memory).toMatchObject({ mode: "legacy", on: false });
  t.store.setLegacyMemoryProjects([old.id, t.off.id]);
  expect(t.store.requireProject(old.id).memory).toMatchObject({ mode: "legacy", on: true });
  expect(t.store.requireProject(t.off.id).memory!.on).toBe(false); // 끈 값은 목록에 있어도 꺼짐
  t.store.setLegacyMemoryProjects([]);

  // 대표가 켜고 끄면 도구 목록이 따라간다(세션은 쉬는 틈에 이어 열 때 받는다).
  const ow = await t.worker(t.off.id, "o1");
  expect((await t.tools(ow)).some((n) => n.startsWith("memory_"))).toBe(false);
  const on = await t.orch.patchProject(t.off.id, { memory: true });
  expect(on.memory).toMatchObject({ mode: "on", on: true });
  expect(await t.tools(ow)).toEqual(expect.arrayContaining(["memory_search", "memory_get", "memory_record", "memory_feedback"]));
  expect(await t.tools(ow)).not.toContain("memory_capture"); // 대표 결정 선별은 총괄만
  expect(await t.tools(t.store.getConductor(t.off.id)!)).toContain("memory_capture");
  await t.orch.patchProject(t.off.id, { memory: false });
  expect((await t.tools(ow)).some((n) => n.startsWith("memory_"))).toBe(false);

  expect((await t.devMemory.checkHealth()).state).toBe("ok");
  expect((await t.orch.runtimeInfo()).memory).toMatchObject({ state: "ok" });
  const broken = new DevMemory({ baseUrl: t.gw.url, keyFile: join(t.home, "no-key"), projects: [] });
  const status = await broken.checkHealth();
  expect(status.state).toBe("key_unreadable");
  expect(status.detail).not.toContain(t.home); // 경로 전체가 아니라 파일 이름만
});

test("대표 글·총괄 위임 앞에 한 번 찾아 붙이고, 결과 없음·실패·다시 쓰기를 나눈다. 답·보고·짧은 글은 찾지 않는다", async () => {
  const t = await setup();
  t.gw.records.push({ id: "exp-seed", project_id: `iamceo-${t.project.id}`, event_id: "iamceo-decision-seed", body: "{}", experience: { kind: "decision", summary: "대표 결정: 환불은 부분 환불로", content: "부분 환불만 지원한다", source: { task_id: "x" } } });
  const w = await t.worker(t.project.id, "w1");
  const leadId = t.store.getConductor(t.project.id)!.id;

  const before = t.gw.contextCalls();
  const first = await t.ownerSays(t.project.id, "환불 화면을 새로 만들어 주세요. 부분 환불 버튼도 필요해요");
  expect(t.gw.contextCalls()).toBe(before + 1);
  const block = first.sent.indexOf("관련 기억 1건");
  expect(block).toBeGreaterThanOrEqual(0);
  expect(first.sent.indexOf("환불 화면을 새로 만들어 주세요")).toBeGreaterThan(block); // 기억 글이 지시보다 먼저
  expect(first.sent).toContain("exp-seed [decision · 대표 결재 답 기록");
  expect(first.sent).toContain("지금 대표 원문·승인·정본이 앞선다");
  const ok = t.store.listMemorySearches(t.project.id).filter((s) => s.memberId === leadId);
  expect(ok.at(-1)).toMatchObject({ trigger: "delivery", status: "ok", resultIds: ["exp-seed"] });

  // 10분 안의 같은 검색어는 다시 쓴다(게이트웨이를 다시 부르지 않는다).
  const again = await t.ownerSays(t.project.id, "환불 화면을 새로 만들어 주세요. 부분 환불 버튼도 필요해요");
  expect(t.gw.contextCalls()).toBe(before + 1);
  expect(again.sent).toContain("같은 검색어로 찾은 결과를 다시 씀");
  expect(t.store.listMemorySearches(t.project.id).at(-1)!.detail).toStartWith("reused:");

  // 맞는 기억이 없으면 '관련 기억 없음'
  const empty = await t.ownerSays(t.project.id, "영수증 메일 제목을 조금 다듬어 주세요");
  expect(empty.sent).toContain("관련 기억 없음");
  expect(t.store.listMemorySearches(t.project.id).at(-1)).toMatchObject({ status: "empty", resultIds: [] });

  // 실패는 '없음'이 아니다. 한 번만 부르고 다시 시도하지 않는다.
  const beforeFail = t.gw.contextCalls();
  t.gw.failNext(3);
  const failed = await t.ownerSays(t.project.id, "배송 추적 화면의 지도 표시를 고쳐 주세요");
  expect(t.gw.contextCalls()).toBe(beforeFail + 1);
  expect(failed.sent).toContain("기억 검색 실패");
  expect(failed.sent).not.toContain("관련 기억 없음(");
  expect(t.store.listMemorySearches(t.project.id).at(-1)).toMatchObject({ status: "error" });
  t.gw.failNext(0);

  // 짧은 답("진행해")은 찾지 않는다.
  const searches = t.store.listMemorySearches(t.project.id).length;
  const calls = t.gw.contextCalls();
  await t.ownerSays(t.project.id, "네 진행해");
  expect(t.store.listMemorySearches(t.project.id)).toHaveLength(searches);

  // 총괄의 위임은 직원 쪽에서 찾는다.
  await t.orch.assign(t.project.id, w.handle, { text: "부분 환불 API 의 금액 검증을 고쳐 주세요" }, t.store.requireMember(leadId));
  await until(() => t.store.listMemorySearches(t.project.id).some((s) => s.memberId === w.id), "직원 검색");
  expect(t.store.listMemorySearches(t.project.id).find((s) => s.memberId === w.id)).toMatchObject({ trigger: "delivery", status: "ok" });
  await settle(); t.runner.end(w.id); await settle();
  const afterAssign = t.gw.contextCalls();
  expect(afterAssign).toBe(calls + 1);

  // 결재 답·직원 보고는 같은 일의 후속이라 찾지 않는다.
  const d = t.store.createDecision({ projectId: t.project.id, memberId: w.id, who: w.name, title: "환불 한도를 정해 주세요", options: [{ k: "a", label: "10만 원" }] });
  await t.orch.answerDecision(d.id, { choice: "a" });
  await settle(); t.runner.end(w.id); await settle();
  const report = await t.call(w, "post", { kind: "완료", title: "환불 금액 검증 고침", body: "시험 통과했습니다" });
  expect(report.isError).toBeFalsy();
  await until(() => t.store.listDeliveries(t.project.id).some((d) => d.memberId === leadId && d.kind === "report"), "보고 전달");
  await settle(); t.runner.end(leadId); await settle();
  expect(t.store.listDeliveries(t.project.id).some((d) => d.memberId === w.id && d.kind === "answer")).toBe(true);
  expect(t.gw.contextCalls()).toBe(afterAssign);
});

test("총괄만 대표 글을 골라 남기고, 대표 원문·해석·근거가 나뉜다. 직원 글·인용·결재 답·다른 프로젝트·민감 정보는 받지 않는다", async () => {
  const t = await setup();
  const w = await t.worker(t.project.id, "w1");
  const lead = t.store.getConductor(t.project.id)!;
  expect(await t.tools(w)).not.toContain("memory_capture");
  expect((await t.call(w, "memory_capture", { message_ids: ["x"], type: "decision", scope: "project", interpretation: "x" })).text).toContain("쓸 수 없는 도구");

  const said = t.owner(t.project.id, "앞으로 결제 화면은 항상 다크 모드를 기본으로 해 주세요. 눈이 덜 피곤해서요");
  const args = { message_ids: [said.id], type: "constraint", scope: "project", standing: true, standing_quote: "앞으로 결제 화면은 항상 다크 모드를 기본으로 해 주세요", reason_quote: "눈이 덜 피곤해서요", interpretation: "결제 화면을 새로 만들거나 고칠 때 다크 모드를 기본값으로 둔다" };
  const saved = await t.call(lead, "memory_capture", args);
  expect(saved.isError).toBeFalsy();
  const captureId = /#(mc_[A-Za-z0-9_-]+)/.exec(saved.text)![1]!;
  await t.devMemory.flush(t.store);
  expect(t.gw.records).toHaveLength(1);
  const e = t.gw.records[0]!.experience;
  expect(e.kind).toBe("decision");
  expect(e.summary).toStartWith("대표가 정한 제약: 앞으로 결제 화면은");
  expect(e.content).toContain(`대표(#${said.id}): "앞으로 결제 화면은 항상 다크 모드를 기본으로 해 주세요. 눈이 덜 피곤해서요"`);
  expect(e.content).toContain("총괄 해석(");
  expect(e.content).toContain("대표 원문 아님");
  expect(e.content).toContain('대표가 말한 이유(원문): "눈이 덜 피곤해서요"');
  expect(e.evidence[0]).toEqual({ kind: "classification", text: "explicit_user_statement" });
  expect(e.source).toMatchObject({ item_id: said.id, service: "iamceo" });
  expect(memoryKindLabel({ kind: e.kind, event_id: e.event_id })).toBe("decision · 대표 원문 기록 · 총괄 해석 따로");

  // 같은 내용은 한 건
  expect((await t.call(lead, "memory_capture", args)).text).toContain(`같은 기록이 이미 있습니다 #${captureId}`);
  await t.devMemory.flush(t.store);
  expect(t.gw.records).toHaveLength(1);

  const reject = async (patch: Record<string, unknown>, text: string) => {
    const res = await t.call(lead, "memory_capture", { ...args, ...patch });
    expect(res.isError).toBe(true);
    expect(res.text).toContain(text);
  };
  await reject({ standing_quote: "언제나 다크 모드" }, "standing");
  await reject({ standing_quote: undefined }, "standing_quote");
  await reject({ reason_quote: "밝은 화면이 싫어서" }, "reason_quote");
  const staff = t.store.createMessage({ projectId: t.project.id, mine: false, memberId: w.id, who: w.name, kind: "완료", body: "앞으로는 라이트 모드로 하겠습니다" });
  await reject({ message_ids: [staff.id], standing: false }, "대표가 쓴 글이 아닙니다");
  const quoted = t.owner(t.project.id, "> 직원: 라이트 모드가 좋겠습니다");
  await reject({ message_ids: [quoted.id], standing: false, reason_quote: undefined }, "인용");
  const answer = t.owner(t.project.id, "10만 원", { decisionId: "d_fake" });
  await reject({ message_ids: [answer.id], standing: false, reason_quote: undefined }, "결재 카드 답");
  const elsewhere = t.owner(t.off.id, "다른 곳의 결정");
  await reject({ message_ids: [elsewhere.id], standing: false, reason_quote: undefined }, "이 프로젝트의 글이 아닙니다");
  const secret = t.owner(t.project.id, "배포 토큰은 token: abcdef123456 으로 바꿔 주세요");
  await reject({ message_ids: [secret.id], standing: false, reason_quote: undefined }, "민감 정보");
  const serviceKey = t.owner(t.project.id, `키는 ${SERVICE_KEY} 입니다`);
  await reject({ message_ids: [serviceKey.id], standing: false, reason_quote: undefined }, "서버 비밀값");
  const taskA = t.store.saveTask({ projectId: t.project.id, memberId: w.id, who: w.name, title: "A" }).task;
  const taskB = t.store.saveTask({ projectId: t.project.id, memberId: w.id, who: w.name, title: "B" }).task;
  const inA = t.owner(t.project.id, "A 는 이렇게", { taskId: taskA.id });
  const inB = t.owner(t.project.id, "B 는 저렇게", { taskId: taskB.id });
  await reject({ message_ids: [inA.id, inB.id], standing: false, reason_quote: undefined }, "작업이 다른 글");
  expect(t.store.listMemoryUploads(t.project.id)).toHaveLength(1);

  // 같은 글로 다른 기록을 남기면 대체하지 않고 앞 기록을 알려 준다(한 글에 결정이 둘일 수 있다).
  const second = await t.call(lead, "memory_capture", { message_ids: [said.id], type: "feedback", scope: "project", interpretation: "다크 모드가 눈이 편하다는 피드백" });
  expect(second.text).toContain(`같은 대표 글로 남긴 앞 기록: #${captureId}(constraint)`);
  // 정정은 supersedes 로만
  const fixed = await t.call(lead, "memory_capture", { ...args, interpretation: "결제·환불 화면 모두 다크 모드를 기본값으로 둔다", supersedes: captureId });
  expect(fixed.text).toContain(`앞 기록 #${captureId} 를 대체`);
  await t.devMemory.flush(t.store);
  const replaced = t.gw.records.find((r) => r.experience.content.includes("결제·환불 화면 모두"))!;
  expect(replaced.experience.supersedes).toBe(t.gw.records[0]!.id);
  expect(t.gw.records[0]!.superseded_by).toBe(replaced.id);
  const twice = await t.call(lead, "memory_capture", { ...args, interpretation: "또 다른 해석", supersedes: captureId });
  expect(twice.isError).toBe(true);
  expect(twice.text).toContain("이미");

  // 직원 기록도 키 모양이면 남기지 않는다. 서버가 올리는 결재 답은 그 부분만 가린다.
  const leak = await t.call(w, "memory_record", { kind: "lesson", basis: "ai_inference", summary: "배포 키 교체", content: "새 키는 sk-abcdefghijklmnopqrstuvwxyz123 이다" });
  expect(leak.isError).toBe(true);
  expect(leak.text).toContain("민감 정보(API 키)");
  const d = t.store.createDecision({ projectId: t.project.id, memberId: w.id, who: w.name, title: "배포 방식", detail: "지금 설정은 password: hunter22secret 로 되어 있습니다", options: [{ k: "a", label: "그대로" }] });
  await t.orch.answerDecision(d.id, { choice: "a" });
  await t.devMemory.flush(t.store);
  const masked = t.gw.records.find((r) => r.experience.source.item_id === d.id)!.experience.content as string;
  expect(masked).toContain("[가림: 비밀번호·키 값]");
  expect(masked).not.toContain("hunter22secret");
});

test("대기열: 장애는 같은 사건으로 다시 보내고, 응답이 사라져도 한 건이며, 대체는 앞 기록이 들어간 뒤에 싣는다. 빠진 결재 답은 켠 뒤 것만 메운다", async () => {
  const t = await setup();
  await t.worker(t.project.id, "w1");
  const lead = t.store.getConductor(t.project.id)!;
  const said = t.owner(t.project.id, "이번 배포는 금요일 밤에 하지 말아 주세요");

  // 응답 유실: 게이트웨이는 저장했는데 응답이 안 왔다 → 같은 사건 id·본문으로 다시 보내 한 건으로 끝난다.
  t.gw.dropResponseAfterSave(1);
  const first = await t.call(lead, "memory_capture", { message_ids: [said.id], type: "constraint", scope: "task", interpretation: "이번 배포 일정에서 금요일 밤은 뺀다" });
  const firstId = /#(mc_[A-Za-z0-9_-]+)/.exec(first.text)![1]!;
  await t.devMemory.flush(t.store);
  const job = t.store.listMemoryUploads(t.project.id).find((u) => u.refId === firstId)!;
  expect(job).toMatchObject({ status: "pending", attempts: 1 });
  expect(t.gw.records).toHaveLength(1);

  // 앞 기록이 아직 전송 전이면 대체 기록은 시도 수를 쓰지 않고 기다린다.
  const fix = await t.call(lead, "memory_capture", { message_ids: [said.id], type: "constraint", scope: "task", interpretation: "이번 배포는 금·토 밤 모두 뺀다", supersedes: firstId });
  expect(fix.isError).toBeFalsy();
  const fixJob = () => t.store.listMemoryUploads(t.project.id).find((u) => u.supersedesEventId === job.eventId)!;
  expect(fixJob()).toMatchObject({ status: "pending", attempts: 0 });
  t.store.settleMemoryUpload(job.eventId, { status: "pending", attempts: 1, nextAt: new Date(0).toISOString() });
  await t.devMemory.flush(t.store);
  expect(t.store.getMemoryUpload(job.eventId)).toMatchObject({ status: "sent", remoteId: "exp-1" });
  t.store.settleMemoryUpload(fixJob().eventId, { status: "pending", attempts: 0, nextAt: new Date(0).toISOString() });
  await t.devMemory.flush(t.store);
  expect(fixJob()).toMatchObject({ status: "sent", attempts: 1 });
  expect(t.gw.records).toHaveLength(2);
  expect(t.gw.records[1]!.experience.supersedes).toBe("exp-1");

  // 장애: 대기열에 남았다가 같은 사건으로 다시 간다.
  t.gw.failNext(1);
  const other = t.owner(t.project.id, "로그인 화면 문구는 존댓말로 통일해 주세요");
  await t.call(lead, "memory_capture", { message_ids: [other.id], type: "decision", scope: "project", interpretation: "로그인 화면 문구를 존댓말로" });
  await t.devMemory.flush(t.store);
  const down = t.store.listMemoryUploads(t.project.id).at(-1)!;
  expect(down).toMatchObject({ status: "pending", attempts: 1 });
  expect(down.lastError).toContain("503");
  t.store.settleMemoryUpload(down.eventId, { status: "pending", attempts: 1, nextAt: new Date(0).toISOString() });
  await t.devMemory.flush(t.store);
  expect(t.store.getMemoryUpload(down.eventId)).toMatchObject({ status: "sent", attempts: 2 });
  expect(t.gw.records).toHaveLength(3);

  // 결재 답 저장 뒤 대기열에 넣기 전에 멈췄다면 같은 사건 id 로 메운다. 이미 있으면 그대로.
  const w = t.store.listMembers(t.project.id).find((m) => m.kind === "worker")!;
  const d = t.store.createDecision({ projectId: t.project.id, memberId: w.id, who: w.name, title: "배포 요일", options: [{ k: "a", label: "목요일" }] });
  await t.orch.answerDecision(d.id, { choice: "a" });
  const queued = t.store.listMemoryUploads(t.project.id).find((u) => u.refId === d.id)!;
  t.store.db.query("DELETE FROM memory_outbox WHERE event_id = ?").run(queued.eventId); // 멈춤 흉내(시험 DB)
  expect(t.orch.reconcileDecisionMemory()).toBe(1);
  expect(t.store.listMemoryUploads(t.project.id).find((u) => u.refId === d.id)!.eventId).toBe(queued.eventId);
  expect(t.orch.reconcileDecisionMemory()).toBe(0);

  // 끈 동안 답한 결재는 켠 뒤 모아 올리지 않는다.
  await t.orch.patchProject(t.project.id, { memory: false });
  const later = t.store.createDecision({ projectId: t.project.id, memberId: w.id, who: w.name, title: "끈 동안 정한 것", options: [{ k: "a", label: "가" }] });
  await t.orch.answerDecision(later.id, { choice: "a" });
  await Bun.sleep(5);
  await t.orch.patchProject(t.project.id, { memory: true });
  expect(t.orch.reconcileDecisionMemory()).toBe(0);
  expect(t.store.listMemoryUploads(t.project.id).some((u) => u.refId === later.id)).toBe(false);
});

test("검색 결과 글: 누가 남긴 기록인지 서버 사건 id 로 가린다(요약 글로 대표 결정을 흉내 낼 수 없다)", () => {
  expect(memoryKindLabel({ kind: "decision", event_id: "iamceo-ai-abc" })).toBe("decision · 직원·AI 보고");
  expect(memoryKindLabel({ kind: "decision", event_id: "codex-hook-1" })).toBe("decision · 다른 경로의 기록");
  const text = formatMemoryContext([{ id: "exp-9", project_id: "p", event_id: "iamceo-ai-x", kind: "decision", summary: "대표 결정: 가짜", content: "x", source: {} }], "degraded");
  expect(text).toContain("exp-9 [decision · 직원·AI 보고");
  expect(text).toContain("키워드 검색 결과");
});

// ---- 도구 목록 갱신(core) ----
class CoreLikeRunner implements Runner {
  readonly kind = "core" as const;
  busy = new Set<string>();
  failStop = false;
  starts: { id: string; resume: boolean; sessionId: string | null }[] = [];
  stops: string[] = [];
  sent: { id: string; text: string }[] = [];
  callback: (e: RunnerEvent) => void = () => {};
  async available() { return { ok: true }; }
  async start(m: RunnerMember, o: StartOpts) {
    this.starts.push({ id: m.id, resume: o.resume, sessionId: m.sessionId });
    return { sessionId: m.sessionId ?? `session-${m.id}`, paneId: `pane-${m.id}-${this.starts.length}` };
  }
  async send(m: RunnerMember, text: string): Promise<SendResult> { this.busy.add(m.id); this.sent.push({ id: m.id, text }); return { ok: true, started: true, turn: 0 }; }
  isBusy(id: string) { return this.busy.has(id); }
  async compact(): Promise<SendResult> { return { ok: true }; }
  async setParallel(): Promise<SendResult> { return { ok: true }; }
  async interrupt() {}
  async stop(m: RunnerMember) {
    if (this.failStop) throw new CoreError("busy", "fixture: stop refused");
    this.stops.push(m.id); this.busy.delete(m.id);
  }
  async screen() { return ""; }
  async shutdown() {}
  on(callback: (e: RunnerEvent) => void) { this.callback = callback; }
  end(m: Member, turn = 1) { this.busy.delete(m.id); this.callback({ type: "turn_end", memberId: m.id, terminalId: m.paneId, sessionGeneration: 0, turn, finalText: "", isError: false }); }
}

function coreFixture() {
  const isolated = createIsolatedRuntime();
  const config = loadConfig({ IAMCEO_HOME: isolated.paths.iamceoHome, IAMCEO_PORT: "0", IAMCEO_CORE_SOCKET: isolated.socketPath,
    IAMCEO_CORE_BIN: isolated.bins.coreBin, IAMCEO_CLAUDE_BIN: isolated.bins.claudeBin, IAMCEO_CODEX_BIN: isolated.bins.codexBin });
  const store = new Store(openDb(config.dbPath), new Bus());
  store.patchSettings({ maxConcurrentTurns: 8, boardTidyHours: 0 });
  const gw = fakeGateway();
  const keyFile = join(isolated.paths.configDir, "memory-key");
  writeFileSync(keyFile, SERVICE_KEY + "\n", { mode: 0o600 });
  const project = store.createProject({ name: "도구 갱신", cwd: isolated.paths.work });
  const off = store.createProject({ name: "기억 끈 곳", cwd: isolated.paths.work, memory: false });
  const runner = new CoreLikeRunner();
  const orch = new Orchestrator({ config, store, runners: new Map([["core", runner]]), devMemory: new DevMemory({ baseUrl: gw.url, keyFile, projects: [] }), timings: { tickMs: 60_000, healthMs: 60_000 } });
  cleanups.push(async () => { await orch.shutdown(); gw.stop(); });
  let seq = 0;
  const member = (projectId: string, cli: "claude" | "codex" = "claude") => {
    const n = ++seq;
    return store.createMember({ projectId, handle: `w${n}`, name: `직원 ${n}`, kind: "worker", origin: "runner", backend: "core", status: "idle", cwd: isolated.paths.work, paneId: `pane-${n}`, sessionId: `session-${n}`, cli });
  };
  const instruct = async (m: Member, text: string) => {
    store.enqueue({ projectId: m.projectId, memberId: m.id, kind: "instruction", text: `[총괄] ${m.name}에게\n할 일: ${text}`, wake: true });
    await orch.pump(m.id);
  };
  return { store, orch, runner, project, off, member, instruct };
}

test("도구 목록이 바뀐 세션은 쉬는 틈에만 같은 대화로 이어 다시 열고, 일하는 세션·끈 프로젝트·끝내기 실패는 그대로 둔다", async () => {
  const t = coreFixture();
  await Bun.sleep(20); // 도구 모듈을 읽는 동안
  const w = t.member(t.project.id);
  expect(t.store.getAppliedConfig(w.id)).toBeNull(); // 기억 연결 전에 뜬 옛 세션

  await t.instruct(w, "환불 화면 시험을 고쳐 주세요");
  expect(t.runner.stops).toEqual([w.id]);
  expect(t.runner.starts).toEqual([{ id: w.id, resume: true, sessionId: "session-1" }]); // 새 세션이 아니라 같은 대화
  expect(t.runner.sent.filter((s) => s.id === w.id)).toHaveLength(1);
  expect(t.runner.sent[0]!.text).toContain("환불 화면 시험을 고쳐 주세요");
  expect(t.store.requireMember(w.id).sessionId).toBe("session-1");
  expect(t.store.getAppliedConfig(w.id)!.toolsSig).toBeString();
  expect(t.store.listActivity(w.id).some((a) => a.text.includes("같은 대화로 이어 다시 열었습니다"))).toBe(true);

  // 다음 일에는 다시 열지 않는다.
  t.runner.end(t.store.requireMember(w.id));
  await Bun.sleep(20);
  await t.instruct(w, "이어서 환불 금액 검증도 봐 주세요");
  expect(t.runner.stops).toHaveLength(1);
  expect(t.runner.starts).toHaveLength(1);

  // 일하는 세션은 끊지 않는다(끝난 뒤 다음 전달 때 연다).
  const busy = t.member(t.project.id);
  t.runner.busy.add(busy.id);
  t.store.patchMember(busy.id, { status: "working" });
  await t.instruct(busy, "배송 화면도 봐 주세요");
  expect(t.runner.stops).not.toContain(busy.id);

  // 기억을 끈 프로젝트의 옛 세션은 그대로 둔다.
  const plain = t.member(t.off.id);
  await t.instruct(plain, "로그인 문구를 고쳐 주세요");
  expect(t.runner.stops).not.toContain(plain.id);
  expect(t.runner.sent.some((s) => s.id === plain.id)).toBe(true);

  // 끝내기가 거절되면 지금 세션으로 일을 잇고, 같은 목록으로는 다시 시도하지 않는다.
  const stuck = t.member(t.project.id, "codex");
  t.runner.failStop = true;
  await t.instruct(stuck, "결제 문구를 고쳐 주세요");
  expect(t.runner.sent.some((s) => s.id === stuck.id)).toBe(true);
  expect(t.store.requireMember(stuck.id).sessionId).toBe(`session-${4}`);
  t.runner.end(t.store.requireMember(stuck.id));
  await Bun.sleep(20);
  t.runner.failStop = false;
  await t.instruct(stuck, "결제 문구 하나 더");
  expect(t.runner.stops).not.toContain(stuck.id);
});
