// 결재함 승인 클릭 격리 왕복: 실제 herdr-core(새 HC_SESSION·임시 XDG) + 실제 IAMCEO 서버 코드 + 실제 화면(Playwright).
// CLI 는 가짜 Claude 화면(tests/fixtures/core-fake-claude-tui.ts)이다. 실제 Claude·모델·토큰은 쓰지 않는다.
//   IAMCEO_E2E_CORE=1 bun tests/e2e-real/inbox-approval-core.ts
// 이름이 *.test.ts 가 아니라 기본 bun test 에는 잡히지 않는다. 운영 코어(이 세션이 물려받은 HC_SOCKET)에는 닿지 않는다.
// 끝나면 이 격리 코어만 멈춘다. 임시 폴더는 지우지 않는다(결과·화면·원문 응답이 남는다).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright";
import { Bus } from "../../server/bus.ts";
import { loadConfig, updateConfigFile } from "../../server/config.ts";
import { openDb } from "../../server/db.ts";
import { startServer } from "../../server/http.ts";
import { Orchestrator } from "../../server/orchestrator.ts";
import { CoreRunner } from "../../server/runner/core.ts";
import { Store } from "../../server/store.ts";

if (process.env.IAMCEO_E2E_CORE !== "1") {
  console.log("건너뜀: IAMCEO_E2E_CORE=1 일 때만 격리 herdr-core 로 돈다");
  process.exit(0);
}
// 이 프로세스가 물려받은 운영 코어 주소를 지운다. 아래 모든 코어 호출은 격리 소켓을 명시한다.
for (const key of Object.keys(process.env)) if (/^(HC_|HERDR_)/.test(key)) delete process.env[key];

const ROOT = resolve(import.meta.dir, "..", "..");
const HC = process.env.IAMCEO_E2E_CORE_BIN || join(process.env.HOME!, ".local", "share", "herdr-core", "current", "Contents", "MacOS", "herdr-core");
const T = realpathSync(process.env.REVIEW_CORE_STAGE!);
const P = Object.fromEntries(["state", "config", "cache", "work", "claude", "codex", "context", "iamceo", "fake", "bin", "shots", "raw"].map((k) => [k, join(T, k)])) as Record<string, string>;
for (const p of Object.values(P)) mkdirSync(p, { recursive: true });
const SESSION = `iqc${Date.now().toString(36)}`;
const coreEnv = { ...process.env, HC_SESSION: SESSION, XDG_STATE_HOME: P.state!, XDG_CONFIG_HOME: P.config!, XDG_CACHE_HOME: P.cache! } as Record<string, string>;
const SOCK = join(P.state!, "herdr-core", SESSION, `${SESSION}.sock`);

const results: { name: string; ok: boolean; detail: string }[] = [];
const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`, ...a);
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); log(ok ? "통과" : "실패", name, detail); }
const raw = (name: string, value: unknown) => writeFileSync(join(P.raw!, `${name}.json`), JSON.stringify(value, null, 2));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const events = () => existsSync(join(P.fake!, "events.jsonl")) ? readFileSync(join(P.fake!, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const chosen = () => events().filter((e) => e.event === "choose");

// 1) 격리 코어
const hc = (...args: string[]) => spawnSync(HC, args, { env: coreEnv, encoding: "utf8", timeout: 30_000 });
const version = hc("--version").stdout.trim();
const start = hc("server", "start", "--json");
raw("core-start", { cmd: `${HC} server start --json`, status: start.status, stdout: start.stdout, stderr: start.stderr });
const status = JSON.parse(hc("server", "status", "--json").stdout);
if (!existsSync(SOCK) || status.live !== 0) { console.error("격리 코어가 아니거나 비어 있지 않습니다", SOCK, status.live); process.exit(2); }
check("격리 코어 시작(새 세션·빈 칸)", start.status === 0 && status.live === 0, `${version} · live ${status.live}`);

// 2) 가짜 Claude 실행 파일(이 경로만 IAMCEO 의 claudeBin 이다)
const claudeBin = join(P.bin!, "claude");
writeFileSync(claudeBin, `#!/bin/sh\nFAKE_TUI_DIR='${P.fake}' exec '${process.execPath}' '${join(ROOT, "tests/fixtures/core-fake-claude-tui.ts")}' "$@"\n`, { mode: 0o700 });

// 3) 실제 서버 코드(격리 DB·포트 0)
const env = { IAMCEO_HOME: P.iamceo!, IAMCEO_PORT: "0", IAMCEO_CORE_SOCKET: SOCK, IAMCEO_CORE_BIN: HC, IAMCEO_CLAUDE_BIN: claudeBin, IAMCEO_CODEX_BIN: join(P.bin!, "codex"), IAMCEO_HERDR_SOCKET: join(T, "no-herdr.sock") };
updateConfigFile({ hosts: ["127.0.0.1"], accessCode: `iqc-${crypto.randomUUID()}` }, env);
const config = loadConfig(env);
const bus = new Bus();
const store = new Store(openDb(config.dbPath), bus);
store.patchSettings({ boardTidyHours: 0 });
const runner = new CoreRunner({ socketPath: SOCK, coreBin: HC, claudeBin, codexBin: env.IAMCEO_CODEX_BIN, claudeHome: P.claude, codexHome: P.codex, contextHome: P.context, stateDir: P.state, configDir: P.config }, { recoveryStore: store });
const orch = new Orchestrator({ config, store, runners: new Map([["core", runner]]), providerHomes: { claudeHome: P.claude!, codexHome: P.codex! } });
const server = await startServer({ config, store, bus, orch, delivery: orch.deliveryRecovery });
const base = server.urls[0]!;
orch.setServerUrl(base);
const project = store.createProject({ name: "결재함 승인 격리 왕복", cwd: P.work!, chiefCli: "claude" });
const pay = await orch.createMember(project.id, { name: "결제 연동", cli: "claude" });
const task = orch.saveTask(pay, { title: "환불 기능", branch: "feat/refund" }).task;
const memberNow = () => store.requireMember(pay.id);
async function until(what: string, ok: () => boolean, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (ok()) return true; await sleep(100); }
  log("시간 넘김:", what, memberNow().status);
  return false;
}
async function blockWith(command: string) {
  await until("쉼", () => memberNow().status === "idle" || memberNow().status === "offline", 60_000);
  await orch.sendUserMessage(project.id, { text: `BLOCK ${command}`, targetMemberId: pay.id, taskId: task.id });
  return until(`승인 창(${command})`, () => memberNow().status === "blocked" && events().some((e) => e.event === "window" && e.command === command));
}

const browser = await chromium.launch();
async function inbox(width = 1280, height = 900) {
  const page = await browser.newPage({ viewport: { width, height }, ...(width < 500 ? { isMobile: true, hasTouch: true } : {}) });
  await page.goto(`${base}/api/health`);
  await page.evaluate((c) => localStorage.setItem("iamceo.accessCode", c), config.accessCode);
  await page.goto(`${base}/#/p/${encodeURIComponent(project.id)}/inbox`);
  await page.locator(".ibx").waitFor({ timeout: 20_000 });
  return page;
}
const card = (page: Page) => page.locator("article.ibx-approval", { hasText: "결제 연동" });
const opt = (page: Page, n: number) => card(page).locator(".apv-opt").filter({ has: page.locator(".apv-opt__n", { hasText: new RegExp(`^${n}\\.$`) }) });
async function answer(page: Page, n: number, name: string) {
  await opt(page, n).click();
  await page.waitForTimeout(700);
  const res = page.waitForResponse((r) => r.url().endsWith("/prompt/answer") && r.request().method() === "POST", { timeout: 20_000 });
  await card(page).locator(".apv-confirm__go").click();
  const r = await res;
  const body = { request: JSON.parse(r.request().postData() ?? "{}"), status: r.status(), response: await r.json() };
  raw(name, body);
  return body;
}
const promptJson = (page: Page) => page.evaluate(async ([id, c]) => (await fetch(`/api/members/${id}/prompt`, { headers: { Authorization: `Bearer ${c}` } })).json(), [pay.id, config.accessCode] as const);
const shot = (page: Page, name: string) => page.screenshot({ path: join(P.shots!, `${name}.png`), fullPage: true });

try {
  check("E two tabs prompt",await blockWith("touch two-tabs.txt"));
  const one=await inbox(),two=await inbox(390,844);
  await card(one).locator(".apv-opt").first().waitFor();await card(two).locator(".apv-opt").first().waitFor();
  const before=chosen().length;
  const [a,b]=await Promise.all([answer(one,1,"E-tab-one"),answer(two,4,"E-tab-two")]);
  await until("one choice",()=>chosen().length>before,10000);
  check("E different-id two tabs input once",chosen().length-before===1,JSON.stringify({a,b,chosen:chosen().slice(before)}));
  await one.close();await two.close();
  check("F same-id prompt",await blockWith("touch same-id.txt"));
  const page=await inbox();await card(page).locator(".apv-opt").first().waitFor();const ctx=(await promptJson(page)).context;
  const req={operationId:"independent-shared-operation",projectId:ctx.projectId,memberId:ctx.memberId,promptId:ctx.promptId,generation:ctx.generation,executionId:ctx.executionId,option:1,via:"inbox"};
  const send=async(body:unknown)=>{const res=await fetch(base+"/api/members/"+pay.id+"/prompt/answer",{method:"POST",headers:{authorization:"Bearer "+config.accessCode,"content-type":"application/json"},body:JSON.stringify(body)});return {status:res.status,body:await res.json()};};
  const n=chosen().length;const [first,other]=await Promise.all([send(req),send({...req,option:4})]);await until("same id choice",()=>chosen().length>n,10000);
  raw("F-same-id-different-choice",{req,first,other,keys:events().filter(e=>e.event==="key"),choices:chosen().slice(n)});
  check("F original request input once",chosen().length-n===1&&chosen().at(-1)?.n===1);
  check("F same id different choice must conflict",other.status===409,JSON.stringify(other));await page.close();
} catch (error) {
  check("예외 없이 끝남", false, String(error instanceof Error ? error.stack : error));
} finally {
  await browser.close().catch(() => {});
  await orch.shutdown().catch(() => {});
  await server.stop().catch(() => {});
  const stop = hc("server", "stop", "--json");
  raw("core-stop", { status: stop.status, stdout: stop.stdout, stderr: stop.stderr });
  writeFileSync(join(T, "result.json"), JSON.stringify({ dir: T, core: version, session: SESSION, results, events: events() }, null, 2));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n결과 ${results.length - failed.length}/${results.length} 통과 · 폴더 ${T}`);
  process.exit(failed.length ? 1 : 0);
}
