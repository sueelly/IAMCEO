// This fixture is selected explicitly by the lifecycle integration test.
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createIsolatedRuntime } from "./isolated-runtime";
async function probe(name: string) {
  const f = createIsolatedRuntime();
  const db = new Database(join(f.paths.iamceoHome, name + ".db"), { create: true });
  db.exec("create table probe(note text)");
  console.log("fixture=" + JSON.stringify({ root: process.env.IAMCEO_TEST_RUN_ROOT, dir: f.dir }));
  try {
    if (process.env.HOLD_RUN_PROBE) {
      writeFileSync(process.env.HOLD_RUN_PROBE, JSON.stringify({ root: process.env.IAMCEO_TEST_RUN_ROOT, pid: process.pid }));
      await Bun.sleep(60_000);
    }
    writeFileSync(join(f.dir, "debug.log"), "diagnostic");
    writeFileSync(join(f.dir, "ignore.txt"), "not a diagnostic");
    symlinkSync(import.meta.path, join(f.dir, "external.log"));
    const uploads = join(f.dir, "uploads");
    mkdirSync(uploads); writeFileSync(join(uploads, "attachment.db"), "not a diagnostic");
    if (name === "failed" && process.env.FAIL_RUN_PROBE) {
      // Snapshot a committed WAL before closing its writer, just as after a crash.
      const writerPath = join(f.paths.temp, "writer");
      const writer = new Database(writerPath, { create: true });
      writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE durable(note); INSERT INTO durable VALUES ('in WAL')");
      for (const suffix of ["", "-wal", "-shm"]) copyFileSync(writerPath + suffix, join(f.dir, "crash.db" + suffix));
      writer.close();
      throw new Error("planned fixture failure");
    }
    expect(db.query("select count(*) as n from probe").get()).toEqual({ n: 0 });
  } finally {
    db.exec("insert into probe values ('teardown completed')");
    db.close(); await f.stop();
  }
}
test("passing fixture with a control character \x00", () => probe("passed"));
test("conditional fixture", () => probe("failed"));
