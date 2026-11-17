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
const T = realpathSync(mkdtempSync("/private/tmp/iqc-"));
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
  // A) 승인: 창 관찰 → 카드 → 클릭 → 실제 키 접수 → 명령 실행
  check("A 승인 창 관찰(core blocked·permission)", await blockWith("touch probe-claude.txt && ls -l probe-claude.txt"), memberNow().status);
  let page = await inbox();
  await card(page).locator(".apv-opt").first().waitFor({ timeout: 20_000 });
  const seen = await promptJson(page);
  raw("A-prompt", seen);
  const text = await card(page).innerText();
  check("A 카드: 직원·업무·창 글·선택지·고르면 생기는 일", ["결제 연동", "권한 승인에 답을 기다립니다", "업무: 환불 기능", "touch probe-claude.txt && ls -l probe-claude.txt", "Do you want to proceed?", "Yes", "No", "이후에도 적용"].every((p) => text.includes(p)), seen.prompt?.kind);
  await shot(page, "A1-card");
  const before = chosen().length;
  const a = await answer(page, 1, "A-answer");
  await shot(page, "A2-answered");
  check("A 응답: 답함·터미널 받음", a.response.status === "answered" && a.response.terminal === "accepted", `${a.response.status}/${a.response.terminal}/${a.response.after}`);
  await until("명령 실행", () => events().some((e) => e.event === "ran" && e.command.startsWith("touch probe-claude.txt")), 15_000);
  const ran = events().filter((e) => e.event === "ran");
  check("A 터미널 접수 1회·명령 실제 실행", chosen().length - before === 1 && chosen().at(-1)?.n === 1 && existsSync(join(P.work!, "probe-claude.txt")) && ran.at(-1)?.status === 0, JSON.stringify(ran.at(-1)));
  await page.waitForFunction(() => /턴이 끝났습니다|다음 창이 떴습니다|일하는 중/.test(document.querySelector(".npc-stages")?.textContent ?? ""), null, { timeout: 15_000 }).catch(() => {});
  await sleep(1500);
  await shot(page, "A3-after");
  const stagesText = await card(page).innerText();
  raw("A-card-after", { text: stagesText });
  check("A 단계 표시(창 확인·응답 기록·터미널 접수·CLI 상태)", ["창 확인", "응답 기록", "터미널 접수", "받음 · 창이 닫혔습니다", "CLI 상태", "명령 결과는 직원 보고에서 보세요"].every((p) => stagesText.includes(p)), stagesText.split("\n").slice(-6).join(" / "));
  // 같은 operationId 재요청(응답 유실 뒤 다시 받기): 같은 영수증, 새 입력 없음
  const again = await page.evaluate(async ([id, c, body]) => { const r = await fetch(`/api/members/${id}/prompt/answer`, { method: "POST", headers: { Authorization: `Bearer ${c}`, "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; }, [pay.id, config.accessCode, a.request] as const);
  raw("A-retry-same-operation", again);
  check("A 같은 id 재요청: 처음 결과 그대로·새 입력 없음", again.status === 200 && again.body.at === a.response.at && again.body.status === "answered" && chosen().length - before === 1);
  // 새 id 로 같은(이미 닫힌) 창에 다시: 넣지 않음
  const dup = await page.evaluate(async ([id, c, body]) => { const r = await fetch(`/api/members/${id}/prompt/answer`, { method: "POST", headers: { Authorization: `Bearer ${c}`, "content-type": "application/json" }, body: JSON.stringify({ ...body, operationId: `dup-${Date.now()}` }) }); return { status: r.status, body: await r.json() }; }, [pay.id, config.accessCode, a.request] as const);
  raw("A-duplicate-new-operation", dup);
  check("A 새 id 로 지난 창 재클릭: 넣지 않음", dup.body.terminal === "not_sent" && chosen().length - before === 1, `${dup.body.status}/${dup.body.terminal}`);
  await page.close();

  // B) 거절
  check("B 승인 창 관찰", await blockWith("rm -f probe-claude.txt"));
  page = await inbox();
  await card(page).locator(".apv-opt").first().waitFor({ timeout: 20_000 });
  const beforeB = chosen().length;
  const b = await answer(page, 4, "B-answer");
  await until("거절 반영", () => memberNow().status !== "blocked", 10_000);
  await sleep(800);
  await shot(page, "B1-rejected");
  check("B 거절: 한 번 접수·명령 실행 안 함·파일 그대로", b.response.status === "answered" && b.response.reject === true && chosen().length - beforeB === 1 && chosen().at(-1)?.n === 4 && !events().some((e) => e.event === "ran" && e.command.startsWith("rm -f")) && existsSync(join(P.work!, "probe-claude.txt")), `${b.response.terminal}`);
  await page.close();

  // C) 낡은 카드: 보던 창이 바뀌면 넣지 않고 지금 창을 보인다 (폰 폭 390px)
  check("C 승인 창 관찰", await blockWith("touch stale-a.txt"));
  page = await inbox(390, 844);
  await card(page).locator(".apv-opt").first().waitFor({ timeout: 20_000 });
  const noSide = () => page.evaluate(() => document.scrollingElement!.scrollWidth <= window.innerWidth + 1);
  check("C 폰 폭 390px 옆 밀림 없음(카드)", await noSide());
  await shot(page, "C1-phone-card");
  writeFileSync(join(P.fake!, "ctl"), "touch stale-b.txt");
  await until("창 바뀜", () => events().some((e) => e.event === "window-changed"), 5_000);
  const beforeC = chosen().length;
  const c = await answer(page, 1, "C-answer-stale");
  await page.waitForFunction(() => document.querySelector("article.ibx-approval .apv-body")?.textContent?.includes("touch stale-b.txt"), null, { timeout: 15_000 }).catch(() => {});
  await shot(page, "C2-phone-stale");
  check("C 낡은 카드 거부: 넣지 않음·다른 창 그대로", c.response.status === "changed" && c.response.terminal === "not_sent" && chosen().length === beforeC && !existsSync(join(P.work!, "stale-a.txt")) && !existsSync(join(P.work!, "stale-b.txt")), `${c.response.status}/${c.response.terminal}`);
  const cText = await card(page).innerText();
  raw("C-card-after", { text: cText });
  check("C 지금 창을 다시 보임·넣지 않았다는 알림", cText.includes("touch stale-b.txt") && cText.includes("보던 창이 바뀌어 고른 답을 넣지 않았습니다"));
  check("C 폰 폭 390px 옆 밀림 없음(거부 뒤)", await noSide());
  // 바뀐 창은 거절로 닫는다(대표가 고른 것으로)
  const c2 = await answer(page, 4, "C-answer-reject-current");
  check("C 지금 창 거절: 한 번 접수·파일 안 생김", c2.response.status === "answered" && chosen().length - beforeC === 1 && !existsSync(join(P.work!, "stale-b.txt")));
  await page.close();

  // D) 다른 직원·프로젝트 귀속으로 온 답은 넣지 않는다
  check("D 승인 창 관찰", await blockWith("touch other.txt"));
  page = await inbox();
  await card(page).locator(".apv-opt").first().waitFor({ timeout: 20_000 });
  const ctx = (await promptJson(page)).context;
  const beforeD = chosen().length;
  const wrong = await page.evaluate(async ([id, c, body]) => { const r = await fetch(`/api/members/${id}/prompt/answer`, { method: "POST", headers: { Authorization: `Bearer ${c}`, "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; },
    [pay.id, config.accessCode, { operationId: `wrong-${Date.now()}`, projectId: "p_other", memberId: pay.id, promptId: ctx.promptId, generation: ctx.generation, executionId: ctx.executionId, option: 1 }] as const);
  raw("D-wrong-project", wrong);
  check("D 다른 프로젝트 귀속: 넣지 않음", wrong.body.terminal === "not_sent" && chosen().length === beforeD, `${wrong.body.status}`);
  const d = await answer(page, 4, "D-answer-reject");
  check("D 정상 거절 1회", d.response.status === "answered" && chosen().length - beforeD === 1 && !existsSync(join(P.work!, "other.txt")));
  await page.close();
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
