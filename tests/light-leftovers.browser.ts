// 라이트 테마 남은 일 시험: 앱 아이콘·파비콘 색, '권장' 배지 대비, 폰 폭 아래 탭 건수 겹침.
// 실제 서버 + Playwright chromium + 가짜 claude. 라이브 herdr·실제 ~/.iamceo·실제 claude 를 쓰지 않는다.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startBrowserCore } from "./fixtures/core-browser-harness";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
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
const WORK = realpathSync(mkdtempSync(join(tmpdir(), "iamceo-light-")));
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
  browser = await chromium.launch();
}, 40_000);

afterAll(async () => {
  await browser?.close();
  server?.kill();
  await server?.exited;
});

async function open(width: number, hash: string): Promise<Page> {
  const phone = width < 1024;
  const ctx = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, isMobile: phone, hasTouch: phone });
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

  for (const width of [390, 375, 320]) {
    for (const tab of ["home", "inbox"]) {
      test(`폰 ${width}px ${tab}: 아래 탭 건수가 글자·옆 칸·물방울 위선과 겹치지 않고 가로로 밀리지 않는다`, async () => {
        const page = await open(width, `#/p/${project.id}/${tab}`);
        await page.locator(".gtabs__count").first().waitFor();
        await page.waitForTimeout(700); // 물방울이 제자리에 온 뒤
        const m = await page.evaluate(() => {
          const box = (e: Element | Range) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; };
          const links = [...document.querySelectorAll(".gtabs__link")].map((a) => ({
            text: a.querySelector(".gtabs__label")!.firstChild!.textContent!,
            label: (() => { const range = document.createRange(); range.selectNodeContents(a.querySelector(".gtabs__label")!.firstChild!); return box(range); })(),
            count: a.querySelector(".gtabs__count") ? box(a.querySelector(".gtabs__count")!) : null,
            current: a.hasAttribute("aria-current"),
          }));
          return { links, drop: box(document.querySelector(".gtabs__drop")!), bar: box(document.querySelector(".gtabs")!), scrollW: document.documentElement.scrollWidth, winW: innerWidth };
        });
        const hit = (a: { l: number; r: number; t: number; b: number }, b: { l: number; r: number; t: number; b: number }) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
        expect(m.scrollW).toBeLessThanOrEqual(m.winW);
        const counted = m.links.filter((l) => l.count);
        expect(counted.map((l) => l.text)).toEqual(["홈", "결재함"]);
        for (const l of counted) {
          for (const other of m.links) expect({ tab: l.text, over: other.text, hit: hit(l.count!, other.label) }).toEqual({ tab: l.text, over: other.text, hit: false });
          expect(l.count!.t).toBeGreaterThanOrEqual(m.bar.t);
          expect(l.count!.r).toBeLessThanOrEqual(m.bar.r);
          // 고른 칸의 건수는 물방울 위선을 넘지 않는다
          if (l.current) expect(l.count!.t).toBeGreaterThanOrEqual(m.drop.t + 2);
        }
        await page.context().close();
      }, 20_000);
    }
  }
});

// 시험 파일이 import 한 그림 원본도 라이트인지(서버 번들과 같은 파일)
test("원본 index.html 의 파비콘에 옛 짙은 바탕이 없다", () => {
  const html = readFileSync(join(ROOT, "web", "index.html"), "utf8");
  expect(html).not.toContain("%23090713");
  expect(readFileSync(join(ROOT, "web", "manifest.json"), "utf8")).not.toContain("%23090713");
});
