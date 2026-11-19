import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const allocations = new Map<string, { root?: string; dev: number; ino: number }>();
const ordinals = new Map<string, number>();
const active = new Map<string, number>();

/** A caller-supplied path alone never grants ownership of a directory. */
export function managedRunRoot() {
  const root = process.env.IAMCEO_TEST_RUN_ROOT, token = process.env.IAMCEO_TEST_RUN_TOKEN;
  if (!root || !token || !/^run-[a-z0-9_]{8}$/.test(basename(root))) return;
  try {
    const marker = join(root, ".owner");
    if (realpathSync(root) === root && lstatSync(marker).isFile() && readFileSync(marker, "utf8") === token) return root;
  } catch {}
}

export function startFixtureCase() {
  const file = Bun.main;
  ordinals.set(file, (ordinals.get(file) ?? 0) + 1);
  active.set(file, (active.get(file) ?? 0) + 1);
  if (active.get(file)! > 1) {
    appendFileSync(join(process.env.IAMCEO_TEST_RUN_ROOT!, "fixtures.jsonl"),
      JSON.stringify(["overlap", process.env.IAMCEO_REPORT_ID, file]) + "\n");
  }
  return ordinals.get(file)!;
}

export function endFixtureCase() {
  const file = Bun.main;
  active.set(file, (active.get(file) ?? 0) - 1);
}

/** A distinct home for every fixture, also usable by standalone tool probes. */
export function testTempDir(prefix: string, fallbackParent = tmpdir()) {
  if (!prefix || basename(prefix) !== prefix || prefix === "." || prefix === "..") throw Error("Invalid fixture prefix");
  const root = managedRunRoot();
  const dir = mkdtempSync(join(root ?? fallbackParent, prefix));
  const info = lstatSync(dir);
  allocations.set(realpathSync(dir), { root, dev: info.dev, ino: info.ino });
  if (root) {
    // Bun.main changes with each test file. Keep the outermost frame in that
    // file so a shared fixture factory can still be linked to its caller.
    const file = Bun.main;
    const frame = new Error().stack?.split("\n").filter(line => line.includes(file + ":")).at(-1);
    const line = frame?.match(/:(\d+):\d+\)?$/)?.[1];
    appendFileSync(join(root, "fixtures.jsonl"), JSON.stringify(["fixture", process.env.IAMCEO_REPORT_ID, basename(dir), resolve(file), active.get(file) === 1 ? ordinals.get(file) : null, Number(line ?? 0)]) + "\n");
  }
  return dir;
}

/** Keep the fixture's normal teardown semantics while the test result is pending. */
export function releaseTestDir(dir: string) {
  if (!existsSync(dir)) return;
  const info = lstatSync(dir);
  const canonical = realpathSync(dir);
  const allocation = allocations.get(canonical);
  if (!info.isDirectory() || !allocation || allocation.dev !== info.dev || allocation.ino !== info.ino)
    throw Error("Cannot release a foreign fixture directory");
  const { root } = allocation;
  if (root) {
    if (managedRunRoot() !== root || dirname(canonical) !== root) throw Error("Fixture root ownership changed");
    const closed = join(root, ".closed");
    mkdirSync(closed, { recursive: true, mode: 0o700 });
    if (!lstatSync(closed).isDirectory()) throw Error("Fixture archive ownership changed");
    renameSync(dir, join(closed, basename(dir)));
  } else {
    rmSync(dir, { recursive: true, force: true });
  }
  allocations.delete(canonical);
}
