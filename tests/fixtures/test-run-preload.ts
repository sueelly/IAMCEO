// Bun's test runner omits its CLI flags from process.argv and does not call
// process "exit" handlers. Supervise the real invocation before loading tests.
import { afterAll, afterEach, beforeEach } from "bun:test";
import { CString, dlopen, read } from "bun:ffi";
import { spawnSync } from "node:child_process";
import { appendFileSync, closeSync, fstatSync, openSync, readSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { endFixtureCase, managedRunRoot, startFixtureCase } from "./test-run-dirs";

let recordCase: ((file: string, ordinal: number) => void) | undefined;
const runner = resolve(import.meta.dir, "../../scripts/test-run.py");
if (process.ppid !== Number(process.env.IAMCEO_TEST_PARENT_PID) || !managedRunRoot()) {
  const lib = dlopen("/usr/lib/libSystem.B.dylib", {
    _NSGetArgc: { args: [], returns: "ptr" }, _NSGetArgv: { args: [], returns: "ptr" },
    dup: { args: ["i32"], returns: "i32" }, dup2: { args: ["i32", "i32"], returns: "i32" },
  });
  const argc = read.i32(lib.symbols._NSGetArgc()!);
  const argv = read.ptr(lib.symbols._NSGetArgv()!)!;
  const flags = Array.from({ length: argc - 1 }, (_, i) => new CString(read.ptr(argv, (i + 1) * 8)!).toString());
  if (!flags.includes("--test-worker")) {
    process.execve!("/usr/bin/python3", ["python3", runner, process.execPath, ...flags], process.env as Record<string, string>);
  } else if (!managedRunRoot()) {
    // Direct --parallel only preloads the workers. Share the coordinator's
    // root and preserve its ordinary stderr when recording worker failures.
    const result = spawnSync("/usr/bin/python3", [runner, "--worker-root", String(process.ppid)], { encoding: "utf8" });
    if (result.status !== 0) throw Error(result.stderr || "Could not prepare parallel test storage");
    const [root, token] = JSON.parse(result.stdout) as [string, string];
    process.env.IAMCEO_TEST_RUN_TOKEN = token;
    process.env.IAMCEO_TEST_RUN_ROOT = root;
    process.env.IAMCEO_REPORT_ID = "parallel";
    process.env.TMPDIR = join(root, "tmp");
  }
  if (flags.includes("--test-worker") && process.env.IAMCEO_REPORT_ID === "parallel") {
    const raw = join(process.env.IAMCEO_TEST_RUN_ROOT!, ".worker-" + crypto.randomUUID());
    const fd = openSync(raw + ".log", "wx+", 0o600);
    const previous = lib.symbols.dup(2);
    if (previous < 0 || lib.symbols.dup2(fd, 2) < 0) throw Error("Could not capture worker diagnostics");
    let offset = 0;
    const buffer = Buffer.alloc(16384);
    function forward() {
      for (;;) {
        const count = readSync(fd, buffer, 0, buffer.length, offset);
        if (!count) break;
        offset += count;
        writeSync(previous, buffer.subarray(0, count));
      }
    }
    recordCase = (file, ordinal) => appendFileSync(raw + ".jsonl",
      JSON.stringify([fstatSync(fd).size, file, ordinal]) + "\n");
    recordCase(Bun.main, 0);
    afterEach(forward);
    afterAll(() => {
      forward();
      lib.symbols.dup2(previous, 2);
      closeSync(previous); closeSync(fd); lib.close();
    });
  } else {
    lib.close();
  }
}

delete process.env.BUN_FEATURE_FLAG_NO_ORPHANS;
beforeEach(() => { const ordinal = startFixtureCase(); recordCase?.(Bun.main, ordinal); });
afterEach(endFixtureCase);
