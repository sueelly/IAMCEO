// 라이트 테마 남은 일 시험: 앱 아이콘·파비콘 색, '권장' 배지 대비, 폰 폭 아래 탭 건수 겹침.
// 실제 서버 + Playwright chromium + 가짜 claude. 라이브 herdr·실제 ~/.iamceo·실제 claude 를 쓰지 않는다.
import { testTempDir } from "./fixtures/test-run-dirs";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startBrowserCore } from "./fixtures/core-browser-harness";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import type { Project } from "../shared/types.ts";
import { updateConfigFile } from "../server/config.ts";
import { httpDefaultTask } from "./fixtures/default-task.ts";

const core = await startBrowserCore();
afterAll(async () => { await core.stop(); });

const ROOT = resolve(import.meta.dir, "..");
const CLI = join(ROOT, "bin", "iamceo.ts");
const FAKE = join(ROOT, "tests", "fixtures", "fake-claude.ts");
const WORK = realpathSync(testTempDir("iamceo-light-"));
const HOME = join(WORK, "home");
const CODE = "light-code";

const STRIP = /^(HERDR_.*|CLAUDECODE|CLAUDE_CODE_.*|IAMCEO_.*)$/;
function env(extra: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !STRIP.test(k)) out[k] = v;
  return { ...out, ...core.env, IAMCEO_HOME: HOME, IAMCEO_TEST: "1", IAMCEO_CLAUDE_BIN: FAKE, IAMCEO_HERDR_SOCKET: join(WORK, "none.sock"), FAKE_CLAUDE_LOG: join(WORK, "fake.jsonl"), FAKE_CLAUDE_SESSIONS: join(WORK, "sessions"), ...extra };
}

let server: ReturnType<typeof Bun.spawn> | null = null;
let base = "";
let browser: Browser;
let project: Project;
/** 건수 경우: 홈(할 일)·결재함(결재)이 모두 n 건인 프로젝트. 한·두·세 자리(세 자리는 '99+'로 보인다) */
const COUNT_CASES = [7, 12, 99, 100, 999] as const;
const counted: Record<number, Project> = {};

const api = async <T,>(method: string, path: string, body?: unknown, token = CODE): Promise<T> => {
  const res = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
};
const rawTool = (token: string, name: string, args: unknown) => api<{ text: string }>("POST", "/agent/tool", { name, args }, token);
const withTask = httpDefaultTask(rawTool);
const tool = async (token: string, name: string, args: unknown) => rawTool(token, name, await withTask(token, name, args));

/** sRGB 상대 휘도 대비(WCAG). */
function contrast(a: number[], b: number[]): number {
  const lum = ([r, g, bl]: number[]) => {
    const f = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(bl!);
  };
  const x = lum(a) + 0.05, y = lum(b) + 0.05;
  return Math.max(x, y) / Math.min(x, y);
}
const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
/** 그림 글(svg)의 채움 색 중 가장 어두운 것의 휘도 대비(흰색 기준). 라이트 아이콘은 짙은 바탕이 없다. */
const darkestFill = (svg: string) => Math.max(...[...decodeURIComponent(svg).matchAll(/#[0-9a-fA-F]{6}/g)].map((m) => contrast(hex(m[0]), [255, 255, 255])));

beforeAll(async () => {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = probe.port!;
  probe.stop(true);
  updateConfigFile({ accessCode: CODE, port, hosts: ["127.0.0.1"] }, { IAMCEO_HOME: HOME });
  server = Bun.spawn([process.execPath, CLI, "serve"], { cwd: ROOT, env: env({ IAMCEO_PORT: String(port) }), stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  base = `http://127.0.0.1:${port}`;
  const end = Date.now() + 15000;
  while (!(await fetch(`${base}/api/health`).then((r) => r.ok, () => false))) {
    if (Date.now() > end) throw new Error("서버가 뜨지 않음");
    await Bun.sleep(80);
  }
  const dir = join(WORK, "project");
  mkdirSync(dir);
  project = await api<Project>("POST", "/api/projects", { name: "라이트", cwd: dir });
  const w = await api<{ token: string }>("POST", "/agent/join", { project: project.id, name: "민수", handle: "minsu" });
  // 홈·결재함 탭에 건수가 붙도록 할 일과 결재를 하나씩 둔다
  await tool(w.token, "todo", { title: "아이폰에서 홈 화면에 추가해 보기" });
  await tool(w.token, "ask", { title: "탭 글자 크기를 이대로 둘까요?", detail: "확인했습니다.", options: [{ k: "keep", label: "이대로 두기" }, { k: "big", label: "키우기" }], rec: "keep", rec_reason: "겹침이 없습니다" });
  for (const n of COUNT_CASES) {
    const dir = join(WORK, `count-${n}`);
    mkdirSync(dir);
    counted[n] = await api<Project>("POST", "/api/projects", { name: `건수 ${n}`, cwd: dir });
    const b = await api<{ token: string }>("POST", "/agent/join", { project: counted[n]!.id, name: "영희", handle: `younghee${n}` });
    // 스물다섯씩 함께 보낸다(999건을 한 줄로 보내면 오래 걸린다)
    for (let i = 1; i <= n; i += 25) {
      const batch = Array.from({ length: Math.min(25, n - i + 1) }, (_, k) => i + k);
      await Promise.all(batch.flatMap((j) => [
        tool(b.token, "todo", { title: `할 일 ${j}` }),
        tool(b.token, "ask", { title: `결재 ${j}번을 정해 주세요`, detail: "확인", options: [{ k: "a", label: "가" }, { k: "b", label: "나" }] }),
      ]));
    }
  }
  browser = await chromium.launch();
}, 300_000);

afterAll(async () => {
  await browser?.close();
  server?.kill();
  await server?.exited;
});

async function open(width: number, hash: string): Promise<Page> {
  const phone = width < 1024;
  const ctx = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, deviceScaleFactor: phone ? 3 : 1, isMobile: phone, hasTouch: phone });
  const page = await ctx.newPage();
  await page.addInitScript((code) => localStorage.setItem("iamceo.accessCode", code), CODE);
  await page.goto(`${base}/${hash}`);
  await page.locator(".gtabs__link").first().waitFor();
  return page;
}

describe("라이트 테마 남은 일", () => {
  test("파비콘·앱 아이콘·매니페스트가 라이트 색이다", async () => {
    const page = await open(1440, `#/p/${project.id}/home`);
    const favicon = (await page.locator("link[rel=icon]").getAttribute("href"))!;
    expect(favicon.startsWith("data:image/svg+xml,")).toBe(true);
    // 옛 짙은 바탕(#090713, 흰색 대비 19 이상)이 없다. 가장 진한 색은 보라 알약(흰색 대비 3.9 안팎)
    expect(darkestFill(favicon)).toBeLessThan(6);
    const manifestHref = (await page.locator("link[rel=manifest]").getAttribute("href"))!;
    const manifest = (await (await fetch(new URL(manifestHref, page.url()))).json()) as { icons: { src: string }[]; background_color: string };
    expect(darkestFill(manifest.icons[0]!.src)).toBeLessThan(6);
    expect(manifest.background_color).toBe("#F7F5FD");
    // 홈 화면 아이콘(PNG)도 화면에 그려 네 귀퉁이가 밝은지 본다
    const iconHref = (await page.locator("link[rel=apple-touch-icon]").getAttribute("href"))!;
    const corners = await page.evaluate(async (src) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width; c.height = img.height;
      const g = c.getContext("2d")!;
      g.drawImage(img, 0, 0);
      return [[2, 2], [img.width - 3, 2], [2, img.height - 3], [img.width - 3, img.height - 3], [img.width >> 1, img.height >> 1]].map(([x, y]) => [...g.getImageData(x!, y!, 1, 1).data.slice(0, 3)]);
    }, iconHref);
    for (const px of corners.slice(0, 4)) expect(contrast(px, [0, 0, 0])).toBeGreaterThan(14); // 귀퉁이: 흰 보라 바탕
    expect(contrast(corners[4]!, [255, 255, 255])).toBeGreaterThan(3); // 가운데: 보라 알약
    await page.context().close();
  }, 20_000);

  for (const width of [1440, 390]) {
    test(`'권장' 배지 글자 대비가 4.5 이상이다(${width}px)`, async () => {
      const page = await open(width, `#/p/${project.id}/inbox`);
      const badge = page.locator(".ibx-opt .badge", { hasText: "권장" });
      await badge.waitFor();
      const shot = await badge.screenshot();
      // 실제로 그려진 배지 화소에서 가장 흔한 색(바탕)과 글자 색을 잰다
      const [fg, bg] = await page.evaluate(async (b64) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.width; c.height = img.height;
        const g = c.getContext("2d")!;
        g.drawImage(img, 0, 0);
        const d = g.getImageData(0, 0, c.width, c.height).data;
        const count = new Map<string, number>();
        for (let i = 0; i < d.length; i += 4) { const k = `${d[i]},${d[i + 1]},${d[i + 2]}`; count.set(k, (count.get(k) ?? 0) + 1); }
        const top = [...count.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k.split(",").map(Number));
        return [top.find((p) => p[0]! > 250 && p[1]! > 250 && p[2]! > 250)!, top[0]!];
      }, shot.toString("base64"));
      expect(contrast(fg!, bg!)).toBeGreaterThanOrEqual(4.5);
      const style = await badge.evaluate((el) => { const s = getComputedStyle(el); return [s.color, s.backgroundColor]; });
      const rgb = (s: string) => s.match(/\d+/g)!.slice(0, 3).map(Number);
      expect(contrast(rgb(style[0]!), rgb(style[1]!))).toBeGreaterThanOrEqual(4.5);
      await page.context().close();
    }, 20_000);
  }

  type Box = { l: number; r: number; t: number; b: number };
  const hit = (a: Box, b: Box) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
  /** 안쪽 상자가 바깥 상자 테두리까지 남긴 가장 작은 여유(px). 음수면 그만큼 넘친다 */
  const slack = (inner: Box, outer: Box) => Math.min(inner.l - outer.l, outer.r - inner.r, inner.t - outer.t, outer.b - inner.b);
  /** 폭마다·건수마다 가장 작은 여유 */
  const sweep: { n: number; width: number; tab: string; selected: string; cellSlack: number; dropSlack: number | null; gapToLabel: number; shown: string }[] = [];
  afterAll(() => { if (process.env.LIGHT_TAB_MEASURE) Bun.write(process.env.LIGHT_TAB_MEASURE, JSON.stringify(sweep)); });
  const TABS = ["home", "inbox", "team", "thread", "files"] as const;
  const WIDTHS = Array.from({ length: 430 - 320 + 1 }, (_, i) => 320 + i);

  // 폰 폭 전 구간: 320~430px 를 1px 간격으로, 고른 칸 다섯마다 잰다(같은 결함이 특정 폭에서 다시 생기지 않게).
  // 칸 사이 물방울 움직임은 '움직임 줄이기'로 끄고 바로 잰다.
  for (const n of COUNT_CASES) {
    test(`폰 320~430px 전 구간, 건수 ${n}: 건수가 자기 칸·고른 칸 안에 있고 글자와 1px 이상 떨어지며 가로로 밀리지 않는다`, async () => {
      const p = counted[n]!;
      const ctx = await browser.newContext({ viewport: { width: 320, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
      const page = await ctx.newPage();
      await page.addInitScript((code) => localStorage.setItem("iamceo.accessCode", code), CODE);
      await page.goto(`${base}/#/p/${p.id}/home`);
      await page.locator(".gtabs__count").nth(1).waitFor();
      const shown = n > 99 ? "99+" : String(n);
      // 줄였으면 정확한 수는 탭 이름(읽어 주는 글)에 남는다
      if (n > 99) for (const name of ["홈", "결재함"]) await page.getByRole("link", { name: new RegExp(`^${name}\\s*${n}건$`) }).waitFor({ timeout: 2000 });
      const problems: string[] = [];
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 844 });
        for (const tab of TABS) {
          await page.evaluate((h) => { location.hash = h; }, `#/p/${p.id}/${tab}`);
          await page.waitForFunction((t) => document.querySelector(`.gtabs__link[aria-current]`)?.getAttribute("href")?.endsWith(`/${t}`), tab);
          const m = await page.evaluate(() => new Promise<any>((done) => requestAnimationFrame(() => requestAnimationFrame(() => {
            const box = (e: Element | Range) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; };
            const links = [...document.querySelectorAll(".gtabs__link")].map((a) => ({
              text: a.querySelector(".gtabs__label")!.firstChild!.textContent!,
              link: box(a),
              label: (() => { const range = document.createRange(); range.selectNodeContents(a.querySelector(".gtabs__label")!.firstChild!); return box(range); })(),
              count: a.querySelector(".gtabs__count") ? { ...box(a.querySelector(".gtabs__count")!), n: a.querySelector(".gtabs__count")!.textContent } : null,
              current: a.hasAttribute("aria-current"),
            }));
            done({ links, drop: box(document.querySelector(".gtabs__drop")!), scrollW: document.documentElement.scrollWidth, winW: innerWidth });
          }))));
          if (process.env.LIGHT_TAB_SHOTS && [320, 359, 360, 361, 375, 390, 430].includes(width) && (tab === "inbox" || tab === "home"))
            await page.locator(".gtabs").screenshot({ path: join(process.env.LIGHT_TAB_SHOTS, `${width}-${n}-${tab}.png`) });
          const at = `${width}px·${n}·${tab}`;
          if (m.winW !== width) problems.push(`${at}: 창 폭 ${m.winW}`);
          if (m.scrollW > m.winW) problems.push(`${at}: 가로 밀림 ${m.scrollW}>${m.winW}`);
          const withCount = m.links.filter((l: any) => l.count);
          const texts = withCount.map((l: any) => `${l.text}:${l.count.n}`).join(",");
          if (texts !== `홈:${shown},결재함:${shown}`) problems.push(`${at}: 건수 글 ${texts}`);
          for (const l of withCount) {
            const cellSlack = slack(l.count, l.link);
            const dropSlack = l.current ? slack(l.count, m.drop) : null;
            const gapToLabel = l.count.l - l.label.r;
            sweep.push({ n, width, tab: l.text, selected: tab, cellSlack: +cellSlack.toFixed(2), dropSlack: dropSlack === null ? null : +dropSlack.toFixed(2), gapToLabel: +gapToLabel.toFixed(2), shown: l.count.n });
            // 넘침 0 에 더해 테두리까지 1px 를 남긴다(실기기 글꼴 차이로 다시 넘치지 않게)
            if (cellSlack < 1) problems.push(`${at}: ${l.text} 건수와 칸 테두리 여유 ${cellSlack.toFixed(2)}px(1px 미만)`);
            if (dropSlack !== null && dropSlack < 1) problems.push(`${at}: ${l.text} 건수와 고른 칸 테두리 여유 ${dropSlack.toFixed(2)}px(1px 미만)`);
            if (l.current && l.count.t < m.drop.t + 2) problems.push(`${at}: ${l.text} 건수가 물방울 윗선에 붙음`);
            if (gapToLabel < 1 - 1e-6) problems.push(`${at}: ${l.text} 글자 간격 ${gapToLabel.toFixed(2)}px`);
            for (const other of m.links) if (hit(l.count, other.label)) problems.push(`${at}: ${l.text} 건수가 '${other.text}' 글자와 겹침`);
          }
        }
      }
      await ctx.close();
      expect(problems).toEqual([]);
    }, 240_000);
  }

  test("데스크톱 위 탭도 100 이상은 '99+'이고 탭 이름에 정확한 수가 남는다", async () => {
    const page = await open(1440, `#/p/${counted[999]!.id}/home`);
    await page.locator(".gtabs__count").nth(1).waitFor();
    expect(await page.locator(".gtabs__count").allTextContents()).toEqual(["99+", "99+"]);
    for (const name of ["홈", "결재함"]) await page.getByRole("link", { name: new RegExp(`^${name}\\s*999건$`) }).waitFor({ timeout: 2000 });
    const small = await open(1440, `#/p/${counted[99]!.id}/home`);
    await small.locator(".gtabs__count").nth(1).waitFor();
    expect(await small.locator(".gtabs__count").allTextContents()).toEqual(["99", "99"]);
    await page.context().close();
    await small.context().close();
  }, 30_000);
});

// 시험 파일이 import 한 그림 원본도 라이트인지(서버 번들과 같은 파일)
test("원본 index.html 의 파비콘에 옛 짙은 바탕이 없다", () => {
  const html = readFileSync(join(ROOT, "web", "index.html"), "utf8");
  expect(html).not.toContain("%23090713");
  expect(readFileSync(join(ROOT, "web", "manifest.json"), "utf8")).not.toContain("%23090713");
});
