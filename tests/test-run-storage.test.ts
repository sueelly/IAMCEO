import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { releaseTestDir, testTempDir } from "./fixtures/test-run-dirs";

const probe = join(import.meta.dir, "fixtures/test-run-probe.ts");
function launch(parent: string, failure = false) {
  const env = { ...process.env, IAMCEO_TEST_RUNS_PARENT: parent, FAIL_RUN_PROBE: failure ? "1" : "" };
  delete (env as NodeJS.ProcessEnv).IAMCEO_TEST_RUN_ROOT;
  return Bun.spawn([process.execPath, "test", probe], { env, stdout: "pipe", stderr: "pipe" });
}
async function result(proc: ReturnType<typeof launch>) {
  const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code, paths: (out + "\n" + err).split("\n").filter(line => line.startsWith("fixture=")).map(line => JSON.parse(line.slice(8)) as { root: string; dir: string }), err };
}

test("overlapping successful Bun invocations remove their own run after independent fixtures close", async () => {
  const parent = mkdtempSync(join(tmpdir(), "run-test-"));
  try {
    const runs = await Promise.all([result(launch(parent)), result(launch(parent))]);
    expect(runs.map(run => run.code)).toEqual([0, 0]);
    const paths = runs.flatMap(run => run.paths);
    expect(paths).toHaveLength(4);
    expect(paths.every(p => p.root && p.dir.startsWith(p.root + "/"))).toBe(true);
    expect(new Set(paths.map(p => p.root)).size).toBe(2);
    expect(new Set(paths.map(p => p.dir)).size).toBe(4);
    expect(paths.every(p => !existsSync(p.root))).toBe(true);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test("failed Bun runs retain the failing database and cause until 72 hours have elapsed", async () => {
  const parent = mkdtempSync(join(tmpdir(), "run-test-"));
  try {
    const { code, err, paths } = await result(launch(parent, true));
    expect(code).toBe(1);
    expect(err).toContain("planned fixture failure");
    const files = readdirSync(parent, { recursive: true }) as string[];
    const dbPaths = files.filter(p => p.endsWith(".db"));
    expect(dbPaths.map(p => basename(p)).sort()).toEqual(["crash.db", "failed.db"]);
    const db = new Database(join(parent, dbPaths.find(p => basename(p) === "failed.db")!), { readonly: true });
    try { expect(db.query("select note from probe").get()).toEqual({ note: "teardown completed" }); }
    finally { db.close(); }
    const crash = dbPaths.find(p => basename(p) === "crash.db")!;
    expect(files).toContain(crash + "-wal");
    const recovered = new Database(join(parent, crash), { readonly: true });
    try { expect(recovered.query("select note from durable").get()).toEqual({ note: "in WAL" }); }
    finally { recovered.close(); }
    expect(files.some(p => p.endsWith("debug.log"))).toBe(true);
    expect(files.some(p => p.endsWith("ignore.txt") || p.endsWith("external.log") || p.endsWith("attachment.db"))).toBe(false);
    expect(files.some(p => p.endsWith(".log") && readFileSync(join(parent, p), "utf8").includes("planned fixture failure"))).toBe(true);
    expect(existsSync(paths[0].root)).toBe(false);
    const failed = files.find(p => !p.includes("/") && p.startsWith("failed-"))!;
    const receipt = join(parent, failed, "failure.log");
    const external = join(parent, "unrelated");
    writeFileSync(external, "keep");
    symlinkSync(external, join(parent, "failed-link"));
    const age = (hours: number) => new Date(Date.now() - hours * 3600_000);
    utimesSync(receipt, age(71), age(71));
    expect((await result(launch(parent))).code).toBe(0);
    expect(existsSync(receipt)).toBe(true);
    utimesSync(receipt, age(72), age(72));
    expect((await result(launch(parent))).code).toBe(0);
    expect(existsSync(receipt)).toBe(false);
    expect(readFileSync(external, "utf8")).toBe("keep");
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test.skipIf(Bun.semver.order(Bun.version, "1.4.0") < 0)("direct parallel Bun workers archive their failing fixture after the coordinator exits", async () => {
  const parent = mkdtempSync(join(tmpdir(), "run-test-"));
  try {
    const env = { ...process.env, IAMCEO_TEST_RUNS_PARENT: parent, FAIL_RUN_PROBE: "1" };
    delete (env as NodeJS.ProcessEnv).IAMCEO_TEST_RUN_ROOT;
    const proc = Bun.spawn([process.execPath, "test", "--parallel=2", probe, join(import.meta.dir, "writing-guide.test.ts")],
      { env, stdout: "pipe", stderr: "pipe" });
    const { code, paths } = await result(proc);
    expect(code).toBe(1);
    expect(paths).toHaveLength(2);
    expect(paths[0].root).toBe(paths[1].root);
    const deadline = Date.now() + 3000;
    while (existsSync(paths[0].root) && Date.now() < deadline) await Bun.sleep(15);
    expect(existsSync(paths[0].root)).toBe(false);
    const files = readdirSync(parent, { recursive: true }) as string[];
    expect(files.some(f => f.endsWith("failed.db"))).toBe(true);
    expect(files.some(f => f.endsWith("passed.db"))).toBe(false);
    const log = files.find(f => f.endsWith("/failure.log"))!;
    expect(readFileSync(join(parent, log), "utf8")).toContain("planned fixture failure");
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test("killing a supervisor closes its Bun worker and leaves the interrupted run untouched on a later run", async () => {
  const parent = mkdtempSync(join(tmpdir(), "run-test-"));
  try {
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      const env = { ...process.env, IAMCEO_TEST_RUNS_PARENT: parent, HOLD_RUN_PROBE: join(parent, signal) };
      delete (env as NodeJS.ProcessEnv).IAMCEO_TEST_RUN_ROOT;
      const proc = Bun.spawn([process.execPath, "test", probe], { env, stdout: "ignore", stderr: "ignore" });
      try {
        const deadline = Date.now() + 3000;
        while (!existsSync(env.HOLD_RUN_PROBE) && Date.now() < deadline) await Bun.sleep(10);
        const { pid, root } = JSON.parse(readFileSync(env.HOLD_RUN_PROBE, "utf8"));
        proc.kill(signal);
        expect(await proc.exited).not.toBe(0);
        let alive = true;
        while (alive && Date.now() < deadline) {
          try { process.kill(pid, 0); await Bun.sleep(10); } catch { alive = false; }
        }
        expect(alive).toBe(false);
        expect((await result(launch(parent))).code).toBe(0);
        expect(existsSync(root)).toBe(true);
      } finally { if (proc.exitCode === null && proc.signalCode === null) proc.kill(); }
    }
  } finally { rmSync(parent, { recursive: true, force: true }); }
});


test("a fixture cannot release another directory in the shared run", () => {
  const other = mkdtempSync(join(process.env.IAMCEO_TEST_RUN_ROOT!, "outside-fixture-"));
  try {
    expect(() => testTempDir("../escape-")).toThrow();
    expect(() => releaseTestDir(other)).toThrow();
    expect(existsSync(other)).toBe(true);
  } finally { rmSync(other, { recursive: true, force: true }); }
});
