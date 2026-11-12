// Agent-A 연결(체험판): 요청 id 고정, 실행 담당 하나, 응답 유실·중복 클릭·재시작, A→B 이동 뒤 알림, 정본 충돌, 담당 교체 뒤 늦은 결과.
// Agent-A 서버는 c559881 의 계약(docs/INTERFACES.md·src/server/app.js·auth.js)을 흉내 낸 가짜다. 실제 서버 왕복은 체험 서버에서 따로 확인한다.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../server/bus.ts";
import { openDb } from "../server/db.ts";
import { AgentAClient, AgentAService, splitMarkdown, textAnchor } from "../server/integrations/agent-a.ts";
import { Store } from "../server/store.ts";

const APP = "app-token-for-tests-only-000";
const AGENT = "agent-token-for-tests-only-00";
const dirs: string[] = [];
afterAll(() => {
  // 임시 폴더는 지우지 않는다(작업 규칙). 시험 폴더는 OS 임시 경로에 남는다.
});

function fakeAgentA() {
  const artifacts = new Map<string, any>();
  const receipts = new Map<string, { hash: string; receipt: any }>();
  const jobs = new Map<string, any>();
  const keys = new Map<string, string>();
  const calls: { method: string; path: string; as: string }[] = [];
  let dropAfter: RegExp | null = null;
  let down = false;
  // 원래 화면(Plannotator) 쪽: 검토 세션·댓글 목록·그림 등록. 열쇠 없는 기본 방식(localMode)도 흉내 낸다.
  const comments = new Map<string, any[]>();
  const sessions: { id: string; artifact_id: string; key: string }[] = [];
  const assets: any[] = [];
  let localMode = false;
  const clone = (v: any) => structuredClone(v);
  const fail = (status: number, code: string, message = code) => Response.json({ error: code, code, message }, { status });
  function block(s: any, id: string) { return s.blocks.find((b: any) => b.id === id); }
  function run(s: any, c: any, actor: string) {
    const hash = JSON.stringify(c);
    const prior = receipts.get(c.command_id);
    if (prior) { if (prior.hash !== hash) return fail(409, "idempotency_conflict"); return Response.json(prior.receipt); }
    let result: any = {};
    let content = false;
    if (c.type === "create_branch" || c.type === "add_message") {
      let b = s.branches.find((x: any) => x.id === c.branch_id);
      if (c.type === "create_branch") {
        if (b) return fail(409, "revision_conflict", "Branch ID already exists");
        const t = block(s, c.target.block_id);
        if (!t || t.revision !== c.target.block_revision) return fail(409, "revision_conflict", "Target is not current");
        b = { id: c.branch_id, target: c.target, messages: [] };
        s.branches.push(b);
      } else if (!b) return fail(404, "not_found");
      const qid = crypto.randomUUID();
      b.messages.push({ id: qid, role: "user", body: c.message, created_at: new Date().toISOString() });
      const fid = crypto.randomUUID();
      s.feedback.push({ id: fid, branch_id: b.id, question_id: qid, target: b.target, message: c.message, state: "not_sent" });
      result = { branch_id: b.id, question_id: qid, feedback_id: fid };
    } else if (c.type === "apply_proposals") {
      const p = s.proposals.find((x: any) => x.id === c.proposal_ids[0]);
      if (!p) return fail(404, "not_found");
      if (!["pending", "held"].includes(p.status)) return fail(409, "revision_conflict", "Proposal is not applicable");
      for (const r of p.read_set) if (block(s, r.block_id).revision !== r.revision) return fail(409, "revision_conflict", "Block changed");
      for (const op of p.operations) { const b = block(s, op.block_id); b.history.push({ revision: b.revision, content: clone(b.content), archived: false }); b.revision++; b.content = clone(op.content); }
      p.status = "applied"; content = true; result = { proposal_ids: c.proposal_ids };
    } else if (c.type === "decide_proposal") {
      const p = s.proposals.find((x: any) => x.id === c.proposal_id);
      if (p.status === "applied") return fail(409, "revision_conflict");
      p.status = c.decision; result = { proposal_id: p.id, status: p.status };
    } else if (c.type === "record_agent_result") {
      for (const a of c.answers) {
        const f = s.feedback.find((x: any) => x.id === a.feedback_id);
        const b = s.branches.find((x: any) => x.id === f.branch_id);
        if (f.state === "succeeded") return fail(409, "invalid_state");
        b.messages.push({ id: crypto.randomUUID(), role: "assistant", body: a.body, question_id: f.question_id, created_at: new Date().toISOString() });
        f.state = "succeeded";
      }
      for (const p of c.proposals) s.proposals.push({ ...p, status: "pending" });
    } else return fail(400, "invalid_command");
    if (content) s.artifact_revision++;
    s.event_seq++;
    s.events.push({ seq: s.event_seq, type: c.type, actor_id: actor, created_at: new Date().toISOString(), payload: {} });
    const receipt = { command_id: c.command_id, artifact_id: s.id, event_seq: s.event_seq, status: "committed", result };
    receipts.set(c.command_id, { hash, receipt });
    return Response.json(receipt);
  }
  function packet(s: any, f: any) {
    const b = block(s, f.target.block_id);
    const current = b.revision === f.target.block_revision;
    const snap = current ? { block_id: b.id, revision: b.revision, content: clone(b.content) } : { block_id: b.id, revision: f.target.block_revision, content: clone(b.history.find((h: any) => h.revision === f.target.block_revision).content) };
    return { base_artifact_revision: s.artifact_revision, context_revision: s.context_revision, layout_revision: s.layout_revision,
      selected_feedback: [{ feedback_id: f.id, branch_id: f.branch_id, question_id: f.question_id, message: f.message, target: f.target }],
      target_snapshots: [snap], allowed_write_set: current ? [{ block_id: b.id, revision: b.revision }] : [], read_set: current ? [{ block_id: b.id, revision: b.revision }] : [] };
  }
  function store(job: any, result: any) {
    const s = artifacts.get(job.artifact_id);
    const res = run(s, { command_id: `result-${job.id}`, type: "record_agent_result", receipt_id: job.id, answers: result.answers, proposals: result.proposals }, "adapter-service");
    if (res.status === 200) { job.state = "succeeded"; job.result = result; }
    return res;
  }
  const transport = async (input: string, init: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const path = url.pathname;
    const method = init.method ?? "GET";
    const token = String((init.headers as Record<string, string>).authorization ?? "").replace(/^Bearer /, "");
    calls.push({ method, path, as: token === AGENT ? "agent" : token === APP ? "user" : "none" });
    const headers = init.headers as Record<string, string>;
    if (down) throw new TypeError("fetch failed");
    const body = init.body ? JSON.parse(String(init.body)) : null;
    const respond = (): Response => {
      if (token === AGENT && !(method === "POST" && path === "/api/agent-results")) return fail(403, "forbidden");
      if (token !== AGENT && token !== APP && !localMode) return fail(401, "unauthorized");
      if (token !== AGENT && path === "/api/agent-results") return fail(403, "forbidden");
      if (path === "/api/config") return Response.json({ adapter_enabled: true, auth_required: !localMode, mode: "local" });
      if (method === "POST" && path === "/api/assets") {
        const asset = { id: "a".repeat(64), revision: 1, src: `/assets/user/${"a".repeat(64)}/1`, width: 900, height: 334 };
        assets.push({ ...body });
        return Response.json(asset);
      }
      if (method === "POST" && path === "/api/plannotator/sessions") {
        const s = artifacts.get(body.artifact_id);
        if (!s) return fail(404, "not_found");
        const key = `${s.artifact_revision}.${s.context_revision}.${s.layout_revision}`;
        let found = sessions.find((x) => x.artifact_id === s.id && x.key === key);
        if (!found) { found = { id: `sess-${sessions.length + 1}`, artifact_id: s.id, key }; sessions.push(found); }
        return Response.json({ id: found.id });
      }
      if (method === "GET" && path === "/api/external-annotations") {
        const sess = sessions.find((x) => x.id === headers["x-enouv-review-session"]);
        if (!sess || sess.artifact_id !== headers["x-enouv-artifact"]) return fail(409, "session_mismatch");
        const list = comments.get(sess.artifact_id) ?? [];
        const version = JSON.stringify(list).length * 7 + list.length;
        if (url.searchParams.get("since") === String(version)) return new Response(null, { status: 304 });
        return Response.json({ artifact_id: sess.artifact_id, version, annotations: list });
      }
      if (method === "POST" && path === "/api/artifacts") {
        if (artifacts.has(body.id)) return fail(409, "duplicate_id");
        const s = { id: body.id, title: body.title, project_id: body.project_id, task_id: body.task_id, artifact_revision: 1, context_revision: 1, layout_revision: 1, event_seq: 0,
          blocks: body.blocks.map((b: any) => ({ id: b.id, kind: b.kind ?? "markdown", revision: 1, archived: false, content: b.content, ...(b.asset ? { asset: b.asset } : {}), history: [] })), branches: [], proposals: [], feedback: [], events: [] };
        artifacts.set(s.id, s);
        return Response.json(s);
      }
      let m = /^\/api\/artifacts\/([^/]+)$/.exec(path);
      if (m && method === "GET") return artifacts.has(m[1]!) ? Response.json(artifacts.get(m[1]!)) : fail(404, "not_found");
      m = /^\/api\/artifacts\/([^/]+)\/commands$/.exec(path);
      if (m) return run(artifacts.get(m[1]!), body, "local-user");
      m = /^\/api\/artifacts\/([^/]+)\/feedback-batches$/.exec(path);
      if (m) {
        const prior = keys.get(body.idempotency_key);
        if (prior) return Response.json(jobs.get(prior));
        const s = artifacts.get(m[1]!);
        const f = s.feedback.find((x: any) => x.id === body.feedback_ids[0]);
        if (f.state !== "not_sent") return fail(409, "feedback_state");
        f.state = "queued";
        const job = { id: crypto.randomUUID(), artifact_id: s.id, state: "queued", error: null, packet: packet(s, f) };
        jobs.set(job.id, job); keys.set(body.idempotency_key, job.id);
        return Response.json(job);
      }
      m = /^\/api\/jobs\/([^/]+)$/.exec(path);
      if (m) return jobs.has(m[1]!) ? Response.json(jobs.get(m[1]!)) : fail(404, "not_found");
      m = /^\/api\/jobs\/([^/]+)\/run$/.exec(path);
      if (m) { const j = jobs.get(m[1]!); if (j.state !== "queued") return fail(409, "invalid_state"); j.state = "running"; return Response.json(j); }
      m = /^\/api\/jobs\/([^/]+)\/cancel$/.exec(path);
      if (m) { const j = jobs.get(m[1]!); if (j.state !== "running") return fail(409, "invalid_state"); j.state = "unknown"; return Response.json({ id: j.id, state: "unknown" }); }
      if (path === "/api/agent-results") { const j = jobs.get(body.receipt_id); if (!j) return fail(404, "not_found"); return store(j, body); }
      return fail(404, "not_found");
    };
    const res = respond();
    if (dropAfter && dropAfter.test(path) && method !== "GET") { dropAfter = null; throw new TypeError("connection reset after write"); }
    return res;
  };
  return {
    transport, artifacts, jobs, calls, sessions, assets,
    setLocalMode(v: boolean) { localMode = v; },
    /** 원래 화면에서 댓글을 달고 Agent-A 가 답을 쓰는 것처럼 목록을 바꾼다. */
    setComments(artifactId: string, list: any[]) { comments.set(artifactId, structuredClone(list)); },
    dropNextWrite(pattern: RegExp) { dropAfter = pattern; },
    setDown(v: boolean) { down = v; },
    /** Agent-A 자체 AI(Codex 실행기)가 job 을 끝낸 것처럼 결과를 저장한다. */
    finish(jobId: string, answer: string, newBody?: string) {
      const job = jobs.get(jobId);
      const p = job.packet;
      const proposals = newBody && p.allowed_write_set.length ? [{ id: `p-${jobId.slice(0, 8)}`, branch_id: p.selected_feedback[0].branch_id, question_id: p.selected_feedback[0].question_id, reason: "요청 반영",
        base_artifact_revision: p.base_artifact_revision, context_revision: p.context_revision, read_set: p.read_set,
        operations: [{ op: "replace", block_id: p.allowed_write_set[0].block_id, base_revision: p.allowed_write_set[0].revision, content: { ...p.target_snapshots[0].content, body: newBody } }] }] : [];
      store(job, { answers: [{ feedback_id: p.selected_feedback[0].feedback_id, body: answer }], proposals });
    },
  };
}

function setup(fake = fakeAgentA(), dbPath?: string, appToken: string | null = APP) {
  const dir = mkdtempSync(join(tmpdir(), "iamceo-agent-a-"));
  dirs.push(dir);
  const db = openDb(dbPath ?? join(dir, "iamceo.db"));
  const store = new Store(db, new Bus());
  const woke: string[] = [];
  const client = new AgentAClient({ baseUrl: "http://127.0.0.1:1", appToken, agentToken: AGENT }, fake.transport);
  const svc = new AgentAService(store, client, { wake: (id) => woke.push(id) });
  return { fake, store, svc, woke, dbPath: dbPath ?? join(dir, "iamceo.db"), dir };
}

const DOC_A = "# 자료 A\n\n## 목표\n이번 분기에는 가입 전환율을 올린다.\n\n## 일정\n11월 셋째 주에 시안을 확정한다. 11월 넷째 주에 출시한다.";
const DOC_B = "## 개요\n자료 B는 고객 인터뷰 요약이다.";

async function settle(svc: AgentAService, rounds = 6) {
  for (let i = 0; i < rounds; i++) {
    await svc.tick(20);
    // 백오프를 기다리지 않게 기한을 당긴다(시험 전용).
    (svc as any).db.query("UPDATE agent_a_requests SET next_check_at = 0 WHERE next_check_at IS NOT NULL").run();
  }
}

test("문서를 블록으로 나누고 고른 문장은 한 번 나올 때만 문장에 단다", () => {
  const blocks = splitMarkdown(DOC_A, "자료 A");
  expect(blocks.map((b) => b.title)).toEqual(["자료 A", "목표", "일정"]);
  expect(textAnchor("가 나 가", "가")).toBeNull();
  expect(textAnchor("11월 셋째 주에 시안을 확정한다.", "시안을 확정")).toMatchObject({ start: 10, end: 16, exact: "시안을 확정", prefix: "11월 셋째 주에 ", suffix: "한다." });
});

test("A에 요청하고 B로 옮겨도 답은 A의 원래 댓글로 돌아오고, 업무 대화 알림은 한 번만 생긴다", async () => {
  const { fake, store, svc } = setup();
  const project = store.createProject({ name: "체험", cwd: tmpdir() });
  const a = await svc.createDoc(project.id, { title: "자료 A", markdown: DOC_A });
  const b = await svc.createDoc(project.id, { title: "자료 B", markdown: DOC_B });
  const goal = a.blocks.find((x) => x.title === "목표")!;
  const req = await svc.createRequest(a.fileId, { opId: "op-aaaaaaaa-1", blockId: goal.id, blockRevision: goal.revision, quote: "가입 전환율", text: "목표를 수치로 바꿔 줘" });
  // 같은 opId 다시 보내기(응답 유실·중복 클릭): 새 요청을 만들지 않는다.
  const again = await svc.createRequest(a.fileId, { opId: "op-aaaaaaaa-1", blockId: goal.id, blockRevision: goal.revision, quote: "가입 전환율", text: "목표를 수치로 바꿔 줘" });
  expect(again.id).toBe(req.id);
  expect(fake.artifacts.get(a.artifactId).branches).toHaveLength(1);
  expect(req.state).toBe("running");
  expect(req.executor).toBe("agent_a");
  // B 로 이동해 B 에도 요청한다.
  const bBlock = b.blocks[0]!;
  await svc.createRequest(b.fileId, { opId: "op-bbbbbbbb-1", blockId: bBlock.id, blockRevision: bBlock.revision, text: "요약을 한 줄로" });
  const jobA = [...fake.jobs.values()].find((j) => j.artifact_id === a.artifactId)!;
  fake.finish(jobA.id, "가입 전환율 3%→5%로 적었습니다.", "이번 분기에는 가입 전환율을 3%에서 5%로 올린다.");
  await settle(svc);
  const viewA = await svc.view(a.fileId);
  const done = viewA.requests.find((r) => r.id === req.id)!;
  expect(done.state).toBe("answered");
  expect(done.answer?.body).toContain("3%→5%");
  expect(done.proposals).toHaveLength(1);
  expect(done.proposals[0]!.operations[0]!.before).toBe("이번 분기에는 가입 전환율을 올린다.");
  // B 의 요청은 그대로 기다린다.
  expect((await svc.view(b.fileId)).requests[0]!.state).toBe("running");
  const notice = store.getMessage(`msg_aa_${req.id}`)!;
  expect(notice.fileId).toBe(a.fileId);
  expect(notice.body).toContain(`/files/${a.fileId}/${req.id}`);
  await settle(svc);
  expect(store.listMessages(project.id).filter((m) => m.id === `msg_aa_${req.id}`)).toHaveLength(1);
  // 실행 담당은 하나: Agent-A 자체 AI 요청에는 직원 결과 제출이 없다.
  expect(fake.calls.filter((c) => c.path === "/api/agent-results")).toHaveLength(0);
  expect(fake.calls.filter((c) => c.path.endsWith("/run"))).toHaveLength(2);
});

test("반영은 정본을 다시 읽어 확인하고, 같은 opId 재시도는 두 번 반영하지 않는다. 옛 기준 수정안은 충돌로 남는다", async () => {
  const { fake, store, svc } = setup();
  const project = store.createProject({ name: "체험", cwd: tmpdir() });
  const a = await svc.createDoc(project.id, { title: "자료 A", markdown: DOC_A });
  const plan = a.blocks.find((x) => x.title === "일정")!;
  const r1 = await svc.createRequest(a.fileId, { opId: "op-cccccccc-1", blockId: plan.id, blockRevision: 1, text: "날짜를 구체적으로" });
  const r2 = await svc.createRequest(a.fileId, { opId: "op-cccccccc-2", blockId: plan.id, blockRevision: 1, text: "출시를 한 주 미뤄" });
  const [j1, j2] = [...fake.jobs.values()];
  fake.finish(j1.id, "날짜를 넣었습니다.", "11월 17일에 시안을 확정한다. 11월 24일에 출시한다.");
  fake.finish(j2.id, "출시를 미뤘습니다.", "11월 셋째 주에 시안을 확정한다. 12월 첫째 주에 출시한다.");
  await settle(svc);
  const v = await svc.view(a.fileId);
  const p1 = v.requests.find((r) => r.id === r1.id)!.proposals[0]!;
  const p2 = v.requests.find((r) => r.id === r2.id)!.proposals[0]!;
  // 응답 유실: 반영은 됐지만 응답을 못 받았다 → 같은 opId 로 다시 누르면 같은 결과로 확인한다.
  fake.dropNextWrite(/\/commands$/);
  const lost = await svc.decide(a.fileId, p1.id, "apply", "op-apply-0001");
  expect(lost.state).toBe("unknown");
  const retry = await svc.decide(a.fileId, p1.id, "apply", "op-apply-0001");
  expect(retry).toMatchObject({ state: "committed", verified: true, artifactRevision: 2 });
  const twice = await svc.decide(a.fileId, p1.id, "apply", "op-apply-0001");
  expect(twice.artifactRevision).toBe(2);
  const otherClick = await svc.decide(a.fileId, p1.id, "apply", "op-apply-0002");
  expect(otherClick).toMatchObject({ state: "committed", message: "이미 반영된 수정안입니다" });
  expect(fake.artifacts.get(a.artifactId).artifact_revision).toBe(2);
  // 두 번째 수정안은 옛 본문 기준이다.
  const after = await svc.view(a.fileId);
  const stale = after.requests.find((r) => r.id === r2.id)!.proposals[0]!;
  expect(stale.applicable).toBe(false);
  expect(stale.staleReason).toContain("바뀌었습니다");
  const conflict = await svc.decide(a.fileId, p2.id, "apply", "op-apply-0003");
  expect(conflict.state).toBe("conflict");
  expect(fake.artifacts.get(a.artifactId).artifact_revision).toBe(2);
  // 원래 댓글은 판 1 원문을 그대로 가리킨다.
  const block = after.blocks.find((b) => b.id === plan.id)!;
  expect(block.revision).toBe(2);
  expect(block.history[0]!.body).toBe("11월 셋째 주에 시안을 확정한다. 11월 넷째 주에 출시한다.");
  expect(after.requests.find((r) => r.id === r2.id)!.blockRevision).toBe(1);
  // 최신본 기준 재요청은 새 요청이고 원래 요청을 가리킨다.
  const redo = await svc.createRequest(a.fileId, { opId: "op-cccccccc-3", blockId: plan.id, blockRevision: 2, text: "출시를 한 주 미뤄", supersedesId: r2.id });
  expect(redo.supersedesId).toBe(r2.id);
  expect(redo.blockRevision).toBe(2);
  // 반영 알림도 한 번만.
  expect(store.listMessages(project.id).filter((m) => m.title.includes("판 2"))).toHaveLength(1);
});

test("답이 막 저장돼 요청에 옮기기 전에 눌러도 화면에 보인 수정안을 반영하고, 화면을 열면 바로 답 상태로 옮긴다", async () => {
  // 실제 체험 서버에서 본 틈: 화면은 정본에서 수정안을 보지만 요청 행은 다음 확인 전이라 '이 자료의 수정안이 아닙니다'로 막혔다.
  const { fake, store, svc } = setup();
  const project = store.createProject({ name: "체험", cwd: tmpdir() });
  const a = await svc.createDoc(project.id, { title: "자료 A", markdown: DOC_A });
  const plan = a.blocks.find((x) => x.title === "일정")!;
  const r = await svc.createRequest(a.fileId, { opId: "op-dddddddd-1", blockId: plan.id, blockRevision: 1, text: "출시를 한 주 미뤄" });
  const job = [...fake.jobs.values()][0]!;
  fake.finish(job.id, "출시를 미뤘습니다.", "11월 셋째 주에 시안을 확정한다. 12월 첫째 주에 출시한다.");
  // 다음 확인이 아직 멀다.
  (svc as any).db.query("UPDATE agent_a_requests SET next_check_at = ? WHERE id = ?").run(Date.now() + 60_000, r.id);
  const v = await svc.view(a.fileId);
  const shown = v.requests[0]!;
  expect(shown.state).toBe("running");
  expect(shown.proposals).toHaveLength(1);
  // 화면을 열었으니 다음 확인을 당겼다.
  expect(((svc as any).db.query("SELECT next_check_at FROM agent_a_requests WHERE id = ?").get(r.id) as any).next_check_at).toBeLessThanOrEqual(Date.now());
  const res = await svc.decide(a.fileId, shown.proposals[0]!.id, "apply", "op-apply-race-1");
  expect(res).toMatchObject({ state: "committed", verified: true, artifactRevision: 2 });
  await settle(svc, 2);
  expect((await svc.view(a.fileId)).requests[0]!.state).toBe("answered");
  // 남의 자료 수정안 id 로는 여전히 막는다.
  const b = await svc.createDoc(project.id, { title: "자료 B", markdown: DOC_B });
  await expect(svc.decide(b.fileId, shown.proposals[0]!.id, "apply", "op-apply-race-2")).rejects.toThrow("이 자료의 수정안이 아닙니다");
});

test("쓰기 응답을 못 받으면 같은 명령 id 로 다시 확인해 질문이 하나만 생긴다", async () => {
  const { fake, store, svc } = setup();
  const project = store.createProject({ name: "체험", cwd: tmpdir() });
  const a = await svc.createDoc(project.id, { title: "자료 A", markdown: DOC_A });
  fake.dropNextWrite(/\/commands$/);
  const r = await svc.createRequest(a.fileId, { opId: "op-dddddddd-1", blockId: "b2", blockRevision: 1, text: "질문" });
  expect(r.state).toBe("unconfirmed");
  await settle(svc);
  const s = fake.artifacts.get(a.artifactId);
  expect(s.branches).toHaveLength(1);
  expect(s.branches[0].messages).toHaveLength(1);
  expect((await svc.requestView(r.id)).state).toBe("running");
  // Agent-A 가 꺼져도 열린 요청은 실패로 바꾸지 않고 다시 확인한다.
  fake.setDown(true);
  await settle(svc, 2);
  fake.setDown(false);
  expect(store.getMessage(`msg_aa_${r.id}`)).toBeNull();
});

test("직원 담당 요청은 Agent-A 실행기를 부르지 않고, 담당이 바뀐 뒤 늦은 결과는 보관만 한다", async () => {
  const { fake, store, svc, woke } = setup();
  const project = store.createProject({ name: "체험", cwd: tmpdir() });
  const w1 = store.createMember({ projectId: project.id, handle: "w1", name: "직원 하나", kind: "worker" });
  const w2 = store.createMember({ projectId: project.id, handle: "w2", name: "직원 둘", kind: "worker" });
  const a = await svc.createDoc(project.id, { title: "자료 A", markdown: DOC_A, executor: "staff", assigneeId: w1.id });
  const r = await svc.createRequest(a.fileId, { opId: "op-eeeeeeee-1", blockId: "b2", blockRevision: 1, text: "목표를 다듬어 줘" });
  expect(r.state).toBe("waiting_staff");
  expect(woke).toEqual([w1.id]);
  const d1 = store.listDeliveries(project.id).find((d) => d.memberId === w1.id)!;
  expect(d1.text).toContain(`#${r.id}`);
  expect(d1.text).toContain("담당 차례 1");
  expect(fake.calls.filter((c) => c.path.endsWith("/run"))).toHaveLength(0);
  // 담당을 둘로 바꾼다. 하나가 늦게 낸 결과는 보관만 된다.
  await svc.reassign(r.id, w2.id);
  expect(woke).toEqual([w1.id, w2.id]);
  const late = await svc.submitFromStaff(store.getMember(w1.id)!, { requestId: r.id, assignment: 1, answer: "늦은 답" });
  expect(late).toContain("보관");
  expect(fake.calls.filter((c) => c.path === "/api/agent-results")).toHaveLength(0);
  const ok = await svc.submitFromStaff(store.getMember(w2.id)!, { requestId: r.id, assignment: 2, answer: "다듬었습니다", edit: { body: "이번 분기에는 가입 전환율을 5%로 올린다.", reason: "수치화" } });
  expect(ok).toContain("수정안");
  const results = fake.calls.filter((c) => c.path === "/api/agent-results");
  expect(results).toHaveLength(1);
  expect(results[0]!.as).toBe("agent");
  const v = (await svc.view(a.fileId)).requests[0]!;
  expect(v.state).toBe("answered");
  expect(v.lateResults).toHaveLength(1);
  expect(v.lateResults[0]!.memberName).toBe("직원 하나");
  expect(v.proposals[0]!.operations[0]!.after).toBe("이번 분기에는 가입 전환율을 5%로 올린다.");
  // 같은 결과를 다시 내도 두 번 저장하지 않는다.
  expect(await svc.submitFromStaff(store.getMember(w2.id)!, { requestId: r.id, assignment: 2, answer: "다듬었습니다" })).toContain("이미");
  expect(fake.calls.filter((c) => c.path.endsWith("/run"))).toHaveLength(0);
  // 알림은 실제로 답한 직원 이름으로 남는다.
  expect(store.getMessage(`msg_aa_${r.id}`)!.who).toBe("직원 둘");
});

test("서버를 다시 켜면 저장된 요청 id 로 상태만 다시 보고, 같은 job 을 다시 실행하지 않는다", async () => {
  const first = setup();
  const project = first.store.createProject({ name: "체험", cwd: tmpdir() });
  const a = await first.svc.createDoc(project.id, { title: "자료 A", markdown: DOC_A });
  const r = await first.svc.createRequest(a.fileId, { opId: "op-ffffffff-1", blockId: "b2", blockRevision: 1, text: "질문" });
  expect(first.fake.calls.filter((c) => c.path.endsWith("/run"))).toHaveLength(1);
  first.store.db.close();
  const second = setup(first.fake, first.dbPath);
  second.svc.start(60_000);
  await second.svc.tick();
  second.svc.stop();
  expect(first.fake.calls.filter((c) => c.path.endsWith("/run"))).toHaveLength(1);
  const job = [...first.fake.jobs.values()][0]!;
  first.fake.finish(job.id, "답");
  await settle(second.svc);
  expect((await second.svc.requestView(r.id)).state).toBe("answered");
  // 실행 중 멈춤: 요청함 → Agent-A 확인 뒤 확인됨.
  const r2 = await second.svc.createRequest(a.fileId, { opId: "op-ffffffff-2", blockId: "b3", blockRevision: 1, text: "다른 질문" });
  const stopped = await second.svc.stopRequest(r2.id);
  expect(stopped.state).toBe("unknown");
  expect(stopped.error).toContain("멈춤을 확인");
});

test("원래 화면 댓글의 답은 다 쓴 뒤 한 번만 알리고, 처음 본 답은 알리지 않으며, 자료를 열면 읽음이 된다", async () => {
  const { fake, store, svc } = setup();
  const project = store.createProject({ name: "체험", cwd: tmpdir() });
  const a = await svc.createDoc(project.id, { title: "자료 A", markdown: DOC_A });
  const q = (id: string, text: string) => ({ id, type: "COMMENT", text, originalText: "가입 전환율" });
  const r = (id: string, parent: string, text: string, extra: Record<string, unknown> = {}) => ({ id, type: "COMMENT", inReplyTo: parent, isAIReply: true, author: "Codex", text, ...extra });
  // 연결 전에 이미 끝난 답: 기준으로만 삼는다.
  fake.setComments(a.artifactId, [q("c0", "예전 질문"), r("comment-answer-0", "c0", "예전 답")]);
  await svc.watchComments();
  // 새 댓글: 답을 쓰는 중 → 다 씀 → 한 번 더 같으면 알림.
  fake.setComments(a.artifactId, [q("c0", "예전 질문"), r("comment-answer-0", "c0", "예전 답"), q("c1", "목표를 숫자로"), r("comment-answer-1", "c1", "답변을 준비하고 있습니다…")]);
  await svc.watchComments();
  expect((await svc.projectInfo(project.id)).docs[0]!.pending).toBe(1);
  fake.setComments(a.artifactId, [q("c0", "예전 질문"), r("comment-answer-0", "c0", "예전 답"), q("c1", "목표를 숫자로"), r("comment-answer-1", "c1", "전환율 5%")]);
  await svc.watchComments();
  expect(store.listMessages(project.id).filter((m) => m.title.includes("댓글에 답이 왔습니다"))).toHaveLength(0);
  await svc.watchComments(); // 바뀐 것 없음(304)
  fake.setComments(a.artifactId, [q("c0", "예전 질문"), r("comment-answer-0", "c0", "예전 답"), q("c1", "목표를 숫자로"), r("comment-answer-1", "c1", "전환율 5%"), q("c2", "다시")]);
  await svc.watchComments();
  const notes = store.listMessages(project.id).filter((m) => m.title.includes("댓글에 답이 왔습니다"));
  expect(notes).toHaveLength(1);
  expect(notes[0]!.body).toContain("목표를 숫자로");
  expect(notes[0]!.body).toContain(`/files/${a.fileId})`);
  let info = await svc.projectInfo(project.id);
  expect(info.docs[0]!).toMatchObject({ unseen: 1, pending: 0 });
  // 같은 답을 다시 보아도 두 번 알리지 않는다.
  await svc.watchComments();
  await svc.watchComments();
  expect(store.listMessages(project.id).filter((m) => m.title.includes("댓글에 답이 왔습니다"))).toHaveLength(1);
  svc.markRead(a.fileId);
  info = await svc.projectInfo(project.id);
  expect(info.docs[0]!.unseen).toBe(0);
  // 답을 못 받은 댓글도 알린다.
  const failed = r("comment-answer-3", "c3", "", { answerError: { message: "모델 연결 실패" } });
  fake.setComments(a.artifactId, [q("c3", "실패할 질문"), failed]);
  await svc.watchComments();
  await svc.watchComments();
  fake.setComments(a.artifactId, [q("c3", "실패할 질문"), failed, q("c4", "x")]);
  await svc.watchComments();
  expect(store.listMessages(project.id).filter((m) => m.title.includes("답을 받지 못했습니다"))).toHaveLength(1);
});

test("정본 판이 바뀌면 원래 화면과 같이 새 검토 세션으로 댓글을 읽는다", async () => {
  const { fake, store, svc } = setup();
  const project = store.createProject({ name: "체험", cwd: tmpdir() });
  const a = await svc.createDoc(project.id, { title: "자료 A", markdown: DOC_A });
  await svc.watchComments();
  expect(fake.sessions).toHaveLength(1);
  await svc.watchComments();
  expect(fake.sessions).toHaveLength(1);
  fake.artifacts.get(a.artifactId).artifact_revision = 2;
  await svc.watchComments();
  expect(fake.sessions).toHaveLength(2);
});

test("열쇠 없는 기본 방식이면 열쇠를 보내지 않고 원래 화면 주소를 준다. 열쇠를 요구하면 주소를 주지 않는다", async () => {
  const local = fakeAgentA();
  local.setLocalMode(true);
  const one = setup(local, undefined, null);
  const p1 = one.store.createProject({ name: "체험", cwd: tmpdir() });
  const info = await one.svc.projectInfo(p1.id);
  expect(info).toMatchObject({ reachable: true, uiUrl: "http://127.0.0.1:1", uiBlocked: null });
  expect(local.calls.every((c) => c.as === "none")).toBe(true);
  const keyed = setup();
  const p2 = keyed.store.createProject({ name: "체험", cwd: tmpdir() });
  const info2 = await keyed.svc.projectInfo(p2.id);
  expect(info2.uiUrl).toBeNull();
  expect(info2.uiBlocked).toContain("열쇠");
});

test("그림을 넣으면 Agent-A 에 등록한 뒤 이미지 블록으로 만든다", async () => {
  const { fake, store, svc } = setup();
  const project = store.createProject({ name: "체험", cwd: tmpdir() });
  const png = "iVBORw0KGgo=";
  const doc = await svc.createDoc(project.id, { title: "자료 C", markdown: "## 설명\n그림 설명", images: [{ title: "가입 단계", name: "f.png", mediaType: "image/png", base64: png }] });
  expect(fake.assets).toHaveLength(1);
  const state = fake.artifacts.get(doc.artifactId);
  const img = state.blocks.find((b: any) => b.kind === "image");
  expect(img.asset.src).toStartWith("/assets/user/");
  expect(img.content.title).toBe("가입 단계");
  await expect(svc.createDoc(project.id, { title: "자료 D", markdown: "본문", images: [{ title: "", name: "f.png", mediaType: "image/png", base64: png }] })).rejects.toThrow("그림 제목");
});
