import { expect, test } from "bun:test";
import { resolve, join } from "node:path";
import { chromium } from "playwright";
import { loadConfig, updateConfigFile } from "../server/config";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime";

test("the standard build embeds a production screen within the first-load transfer budget", async () => {
  const root = resolve(import.meta.dir, "..");
  const runtime = createIsolatedRuntime();
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port!;
  await probe.stop(true);
  expect(port).not.toBe(7878);
  const env = { ...runtime.childEnv(), IAMCEO_LOG_WRITER: "0", IAMCEO_PORT: String(port) };
  const settings = loadConfig(env);
  updateConfigFile({ hosts: ["127.0.0.1"] }, env);
  const build = Bun.spawn([process.execPath, "run", "build"], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
  const [buildCode, buildError] = await Promise.all([build.exited, new Response(build.stderr).text(), new Response(build.stdout).text()]);
  expect({ code: buildCode, error: buildCode === 0 ? "" : buildError }).toEqual({ code: 0, error: "" });
  const child = Bun.spawn([join(root, "dist/iamceo"), "serve"], { cwd: runtime.paths.work, env, stdout: "pipe", stderr: "pipe" });
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  let browser;
  try {
    const origin = `http://127.0.0.1:${port}`;
    const headers = { Authorization: `Bearer ${settings.accessCode}` };
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { ready = (await (await fetch(origin + "/api/readiness", { headers })).json()).ok === true; } catch {}
      if (ready) break;
      await Bun.sleep(50);
    }
    expect(ready).toBe(true);
    expect((await fetch(origin + "/api/capabilities")).status).toBe(401);
    const html = await fetch(origin).then(r => r.text());
    const script = /src="([^"]+\.js)"/.exec(html)?.[1];
    expect(script).toBeString();
    const response = await fetch(new URL(script!, origin), { headers: { "Accept-Encoding": "gzip" } });
    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(Number(response.headers.get("content-length"))).toBeLessThan(250_000);
    const bundle = await response.text();
    expect(bundle.length).toBeGreaterThan(100_000);
    console.log("PRODUCTION_SCREEN_BYTES", { wire: Number(response.headers.get("content-length")), decoded: bundle.length });
    browser = await chromium.launch();
    const context = await browser.newContext();
    await context.addInitScript(code => localStorage.setItem("iamceo.accessCode", code), settings.accessCode);
    const page = await context.newPage();
    const errors: string[] = [];
    const requests: string[] = [];
    page.on("request", request => { if (request.url().includes("/api/")) requests.push(new URL(request.url()).pathname + new URL(request.url()).search); });
    const failedReads: { path: string; status: number }[] = [];
    page.on("pageerror", error => errors.push(error.stack ?? error.message));
    page.on("response", response => { if (response.status() >= 400) failedReads.push({ path: new URL(response.url()).pathname, status: response.status() }); });
    await page.goto(origin);
    try { await page.locator(".shell").waitFor({ timeout: 10_000 }); }
    catch (error) { console.log({ errors, failedReads, body: await page.locator("body").innerText() }); throw error; }
    expect(await page.getByRole("link", { name: "설정", exact: true }).count()).toBeGreaterThan(0);
    expect(requests.filter(path => path === "/api/files-session")).toHaveLength(1);
    expect(requests.some(path => path.includes("/api/sync?") && path.includes("history=50"))).toBe(true);
    expect(requests.filter(path => path.includes("/messages/page?"))).toHaveLength(0);
    expect(errors).toEqual([]);
    await context.close();
  } finally {
    await browser?.close();
    child.kill("SIGTERM");
    await child.exited;
    await output;
    await runtime.stop();
  }
}, 60_000);
