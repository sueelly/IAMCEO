import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createTestServerScope } from "./fixtures/test-server-scope";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const home = () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "iamceo-owned-server-")));
  cleanups.push(async () => { rmSync(directory, { recursive: true }); });
  return directory;
};
const env = (directory: string) => ({ PATH: process.env.PATH!, IAMCEO_TEST: "1", IAMCEO_HOME: directory });
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(check: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw Error("process state timed out"); await Bun.sleep(20); }
}
const childScript = (directory: string, ignoreTerm = false) =>
  `${ignoreTerm ? 'process.on("SIGTERM",()=>{});' : ''}require("node:fs").writeFileSync(${JSON.stringify(join(directory, "ready"))},"ready");setInterval(()=>{},100);`;

test("registered server is reaped when a readiness or assertion step fails", async () => {
  const directory = home(), scope = createTestServerScope();
  cleanups.push(() => scope.stop());
  const child = scope.spawn([process.execPath, "-e", childScript(directory)], { env: env(directory), stdout: "ignore", stderr: "ignore" });
  await until(() => existsSync(join(directory, "ready")));
  await expect((async () => {
    try { throw Error("readiness failed"); } finally { await scope.stop(); }
  })()).rejects.toThrow("readiness failed");
  expect(alive(child.pid)).toBe(false);
  await scope.stop();
  expect(() => scope.spawn([process.execPath, "-e", "0"], { env: env(directory) })).toThrow();
});

test("cleanup bounds a nonresponsive owned child and preserves an unrelated process", async () => {
  const directory = home(), scope = createTestServerScope({ graceMs: 50 });
  cleanups.push(() => scope.stop());
  const unrelated = Bun.spawn([process.execPath, "-e", "setInterval(()=>{},100)"], { stdout: "ignore", stderr: "ignore" });
  cleanups.push(async () => { unrelated.kill("SIGTERM"); await unrelated.exited; });
  const child = scope.spawn([process.execPath, "-e", childScript(directory, true)], { env: env(directory), stdout: "ignore", stderr: "ignore" });
  await until(() => existsSync(join(directory, "ready")));
  await scope.stop();
  expect(alive(child.pid)).toBe(false);
  expect(alive(unrelated.pid)).toBe(true);
});

test("SIGKILL of the test owner does not leave its server running", async () => {
  const directory = home(), module = resolve(import.meta.dir, "fixtures/test-server-scope.ts");
  const script = `import {createTestServerScope} from ${JSON.stringify(module)};
const scope=createTestServerScope();
const child=scope.spawn([process.execPath,"-e",${JSON.stringify(childScript(directory))}],{env:${JSON.stringify(env(directory))},stdout:"ignore",stderr:"ignore"});
console.log(child.pid);setInterval(()=>{},100);`;
  const owner = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "ignore" });
  let childPid = 0;
  cleanups.push(async () => {
    if (owner.exitCode === null) owner.kill("SIGKILL");
    await owner.exited;
    if (childPid && alive(childPid)) process.kill(childPid, "SIGKILL");
  });
  const reader = owner.stdout.getReader();
  try { childPid = Number(new TextDecoder().decode((await reader.read()).value).trim()); }
  finally { reader.releaseLock(); }
  expect(childPid).toBeGreaterThan(1);
  await until(() => existsSync(join(directory, "ready")));
  owner.kill("SIGKILL"); await owner.exited;
  await until(() => !alive(childPid));
}, 10000);

test("scope refuses production homes and a missing test boundary before spawning", async () => {
  const scope = createTestServerScope(); cleanups.push(() => scope.stop());
  expect(() => scope.spawn([process.execPath, "-e", "throw Error('must not start')"], { env: env(homedir()) })).toThrow();
  expect(() => scope.spawn([process.execPath, "-e", "throw Error('must not start')"], { env: { IAMCEO_HOME: home() } })).toThrow();
  expect(() => scope.spawn(["/bin/sh", "-c", "exit 1"], { env: env(home()) })).toThrow();
});

test("server lifetime policy is not forwarded into independently owned core providers", async () => {
  const directory = home(), scope = createTestServerScope();
  cleanups.push(() => scope.stop());
  const record = join(directory, "provider-env.json");
  const child = scope.spawn([process.execPath, "-e", `require("node:fs").writeFileSync(${JSON.stringify(record)},JSON.stringify({flag:process.env.BUN_FEATURE_FLAG_NO_ORPHANS}));`], { env: env(directory), stdout: "ignore", stderr: "ignore" });
  expect(await child.exited).toBe(0);
  expect(JSON.parse(readFileSync(record, "utf8"))).toEqual({});
});
