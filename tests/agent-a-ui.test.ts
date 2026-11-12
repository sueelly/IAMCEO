// Agent-A 원래 화면을 IAMCEO 주소 아래 입장권 경로로 잇기.
// 입장권 없이는 못 열고, 열쇠는 서버만 붙이며, IAMCEO 접속 코드·쿠키는 Agent-A 로 넘어가지 않는다.
// 격리 칸(출처 'null')은 이 경로에서만 받는다. 실제 Agent-A·실제 브라우저 왕복은 체험 서버에서 따로 확인한다.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../server/bus.ts";
import { loadConfig, updateConfigFile } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { startServer, type RunningServer } from "../server/http.ts";
import { AgentAClient, AgentAService } from "../server/integrations/agent-a.ts";
import { AgentAUiTickets, rewriteAsset, rewriteHtml, splitAgentAUiPath } from "../server/integrations/agent-a-ui.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import { Store } from "../server/store.ts";

const CODE = "agent-a-ui-test-code";
const APP = "app-token-for-ui-tests-0000";

const HTML = `<!DOCTYPE html><html><head><meta charset="UTF-8" /><title>Agent-A</title>
<link rel="icon" href="/favicon.svg"><script type="module" crossorigin src="/assets/index-AAA.js"></script>
<link rel="stylesheet" crossorigin href="/assets/index-BBB.css"><link rel="x" href="//cdn.example/x"></head><body><div id="root"></div></body></html>`;
const PRELOAD = "var e=function(e){return`/`+e},t={};";
const CSS = "@font-face{src:url(/assets/KaTeX.woff2)} .a{background:url('/assets/x.png')} .b{background:url(//cdn.example/y.png)}";

describe("입장권·주소 고치기", () => {
  test("입장권은 8시간 살고, 모양이 다르거나 지우면 받지 않는다", () => {
    let now = 1_000;
    const t = new AgentAUiTickets(() => now);
    const { ticket, base } = t.mint();
    expect(base).toBe(`/agent-a-ui/s/${ticket}`);
    expect(t.valid(ticket)).toBe(true);
    expect(t.valid(ticket.slice(1))).toBe(false);
    expect(t.valid("../../api/bootstrap")).toBe(false);
    now += 8 * 60 * 60 * 1000;
    expect(t.valid(ticket)).toBe(false);
    const again = t.mint();
    t.clear();
    expect(t.valid(again.ticket)).toBe(false);
  });

  test("경로 나누기", () => {
    const tk = "a".repeat(43);
    expect(splitAgentAUiPath(`/agent-a-ui/s/${tk}/api/x`)).toEqual({ ticket: tk, prefix: `/agent-a-ui/s/${tk}`, rest: "/api/x" });
    expect(splitAgentAUiPath(`/agent-a-ui/s/${tk}`)?.rest).toBe("/");
    expect(splitAgentAUiPath(`/agent-a-ui/s/short/api`)).toBeNull();
    expect(splitAgentAUiPath(`/api/x`)).toBeNull();
  });

  test("HTML·JS·CSS 의 뿌리 경로를 입장권 경로로 바꾸고, 바깥 주소(//)는 건드리지 않는다", () => {
    const p = `/agent-a-ui/s/${"b".repeat(43)}`;
    const html = rewriteHtml(HTML, p);
    expect(html).toContain(`<head><link rel="stylesheet" href="${p}/__iamceo/skin.css"><script src="${p}/__iamceo/shim.js"></script>`);
    expect(html).toContain(`src="${p}/assets/index-AAA.js"`);
    expect(html).toContain(`href="${p}/assets/index-BBB.css"`);
    expect(html).toContain(`href="${p}/favicon.svg"`);
    expect(html).toContain(`href="//cdn.example/x"`);
    expect(html).not.toContain(`${p}${p}`);
    expect(rewriteAsset(PRELOAD, "js", p)).toBe(`var e=function(e){return\`${p}/\`+e},t={};`);
    const css = rewriteAsset(CSS, "css", p);
    expect(css).toContain(`url(${p}/assets/KaTeX.woff2)`);
    expect(css).toContain(`url('${p}/assets/x.png')`);
    expect(css).toContain("url(//cdn.example/y.png)");
  });
});

describe("서버: 원래 화면 잇기", () => {
  let server: RunningServer;
  let orch: Orchestrator;
  let base = "";
  const seen: { method: string; path: string; headers: Record<string, string>; body: string }[] = [];
  const transport = async (input: string, init: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const headers = (init.headers ?? {}) as Record<string, string>;
    const body = init.body instanceof ArrayBuffer ? new TextDecoder().decode(init.body) : init.body ? String(init.body) : "";
    seen.push({ method: init.method ?? "GET", path: url.pathname + url.search, headers, body });
    if (url.pathname === "/api/config") return Response.json({ auth_required: true });
    if (headers.authorization !== `Bearer ${APP}`) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (url.pathname === "/") return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8", etag: '"h1"', "set-cookie": "agent=1", "x-frame-options": "DENY" } });
    if (url.pathname === "/assets/preload-helper-X.js") return new Response(PRELOAD, { headers: { "content-type": "text/javascript" } });
    if (url.pathname === "/assets/index-BBB.css") return new Response(CSS, { headers: { "content-type": "text/css" } });
    if (url.pathname === "/api/plannotator/sessions" && init.method === "POST") return Response.json({ id: "sess-1", got: JSON.parse(body) });
    return new Response("없음", { status: 404 });
  };

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), "iamceo-agent-a-ui-"));
    const env = { IAMCEO_HOME: home, IAMCEO_PORT: "0" };
    updateConfigFile({ accessCode: CODE, hosts: ["127.0.0.1"] }, env);
    const config = loadConfig(env);
    const bus = new Bus();
    const store = new Store(openDb(config.dbPath), bus);
    orch = new Orchestrator({ config, store, runners: new Map() });
    const agentA = new AgentAService(store, new AgentAClient({ baseUrl: "http://127.0.0.1:1", appToken: APP, agentToken: null }, transport));
    server = await startServer({ config, store, bus, orch, delivery: orch.deliveryRecovery, agentA });
    base = server.urls[0]!;
  });
  afterAll(async () => {
    await orch.shutdown();
    await server.stop();
  });

  const ticketBase = async (): Promise<string> => {
    const r = await fetch(`${base}/api/agent-a/ui-session`, { method: "POST", headers: { Authorization: `Bearer ${CODE}` } });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { base: string; expiresAt: string };
    expect(body.base).toMatch(/^\/agent-a-ui\/s\/[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(body)).not.toContain("127.0.0.1:1");
    expect(JSON.stringify(body)).not.toContain(APP);
    return body.base;
  };

  test("입장권은 접속 코드로만 받는다. 입장권 없이·틀린 입장권으로는 못 연다", async () => {
    expect((await fetch(`${base}/api/agent-a/ui-session`, { method: "POST" })).status).toBe(401);
    expect((await fetch(`${base}/agent-a-ui/s/${"z".repeat(43)}/`)).status).toBe(401);
    expect((await fetch(`${base}/agent-a-ui/s/short/`)).status).toBe(404);
    // 접속 코드를 머리에 실어도 입장권 대신이 되지 않는다
    expect((await fetch(`${base}/agent-a-ui/s/${"z".repeat(43)}/`, { headers: { Authorization: `Bearer ${CODE}` } })).status).toBe(401);
  });

  test("HTML 은 격리·CORS 머리와 IAMCEO 모양을 붙여 내고, 열쇠는 서버가 붙이며 IAMCEO 쿠키·접속 코드는 넘기지 않는다", async () => {
    const p = await ticketBase();
    seen.length = 0;
    const r = await fetch(`${base}${p}/?artifact=iamceo-1`, { headers: { Cookie: "iamceo_files_1=secret", Authorization: `Bearer ${CODE}`, "If-None-Match": '"h1"' } });
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain(`${p}/__iamceo/shim.js`);
    expect(html).toContain(`src="${p}/assets/index-AAA.js"`);
    expect(r.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
    expect(r.headers.get("content-security-policy")).not.toContain("allow-same-origin");
    expect(r.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    expect(r.headers.get("set-cookie")).toBeNull();
    expect(r.headers.get("x-frame-options")).toBeNull();
    expect(r.headers.get("etag")).toBeNull();
    const call = seen.find((c) => c.path === "/?artifact=iamceo-1")!;
    expect(call.headers.authorization).toBe(`Bearer ${APP}`);
    expect(Object.keys(call.headers)).not.toContain("cookie");
    expect(Object.keys(call.headers)).not.toContain("if-none-match");
    expect(JSON.stringify(call.headers)).not.toContain(CODE);
  });

  test("미리 읽기 도우미와 CSS 도 입장권 경로로, 격리 칸의 shim·skin 은 IAMCEO 가 낸다", async () => {
    const p = await ticketBase();
    expect(await (await fetch(`${base}${p}/assets/preload-helper-X.js`)).text()).toContain(`return\`${p}/\`+e`);
    expect(await (await fetch(`${base}${p}/assets/index-BBB.css`)).text()).toContain(`url(${p}/assets/KaTeX.woff2)`);
    const shim = await fetch(`${base}${p}/__iamceo/shim.js`);
    expect(shim.headers.get("content-type")).toContain("javascript");
    expect(await shim.text()).toContain("agent-a-ui");
    expect(await (await fetch(`${base}${p}/__iamceo/skin.css`)).text()).toContain("--primary");
  });

  test("격리 칸(출처 null)의 저장 요청은 이 경로에서만 받고, Agent-A 에는 Agent-A 자신의 출처로 보낸다", async () => {
    const p = await ticketBase();
    seen.length = 0;
    const pre = await fetch(`${base}${p}/api/plannotator/sessions`, { method: "OPTIONS", headers: { Origin: "null", "Access-Control-Request-Method": "POST" } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-headers")).toContain("x-enouv-artifact");
    const r = await fetch(`${base}${p}/api/plannotator/sessions`, { method: "POST", headers: { Origin: "null", "Content-Type": "application/json", "X-ENOUV-Artifact": "iamceo-1", "Sec-Fetch-Site": "cross-site" }, body: JSON.stringify({ artifact_id: "iamceo-1" }) });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ id: "sess-1", got: { artifact_id: "iamceo-1" } });
    const call = seen.find((c) => c.path === "/api/plannotator/sessions")!;
    expect(call.headers.origin).toBe("http://127.0.0.1:1");
    expect(call.headers["x-enouv-artifact"]).toBe("iamceo-1");
    expect(Object.keys(call.headers)).not.toContain("sec-fetch-site");
    // 다른 사이트 출처는 막는다
    expect((await fetch(`${base}${p}/api/plannotator/sessions`, { method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "application/json" }, body: "{}" })).status).toBe(403);
    // 출처 null 은 IAMCEO 자체 API 에서 받지 않는다
    expect((await fetch(`${base}/api/bootstrap`, { headers: { Origin: "null", Authorization: `Bearer ${CODE}` } })).status).toBe(403);
  });

  test("화면 정보에는 Agent-A 주소·열쇠가 없다", async () => {
    const r = await fetch(`${base}/api/projects/hq/agent-a`, { headers: { Authorization: `Bearer ${CODE}` } });
    const text = await r.text();
    expect(r.status).toBe(200);
    expect(JSON.parse(text)).toMatchObject({ enabled: true, ui: true });
    expect(text).not.toContain("127.0.0.1:1");
    expect(text).not.toContain(APP);
  });
});
