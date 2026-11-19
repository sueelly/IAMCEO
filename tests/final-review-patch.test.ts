import { releaseTestDir, testTempDir } from "./fixtures/test-run-dirs";
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readFinalReviewPatch } from "../server/final-review-evidence.ts";

test("after a fast-forward onto main the reviewer reads the entire recorded change range", async () => {
  const dir = testTempDir("iamceo-review-range-");
  const git = (...args: string[]) => execFileSync("/usr/bin/git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", ...args],
    { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    git("init", "-b", "main");
    git("commit", "--allow-empty", "-m", "base");
    const base = git("rev-parse", "HEAD");
    git("checkout", "-b", "topic");
    for (const file of ["first.txt", "second.txt"]) {
      writeFileSync(join(dir, file), file + "\n");
      git("add", file);
      git("commit", "-m", file);
    }
    const tip = git("rev-parse", "HEAD");
    git("checkout", "main");
    git("merge", "--ff-only", "topic");
    expect(await readFinalReviewPatch(dir, tip, undefined, 0, base)).toMatchObject({
      state: "observed", comparison: base, files: ["first.txt", "second.txt"] });
    expect(await readFinalReviewPatch(dir, tip, undefined, 0)).toMatchObject({ state: "missing_base" });
    expect(await readFinalReviewPatch(dir, tip, undefined, 0, "0".repeat(40))).toMatchObject({ state: "missing_base" });
  } finally { releaseTestDir(dir); }
});
