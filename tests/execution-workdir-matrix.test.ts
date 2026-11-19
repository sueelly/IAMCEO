import { testTempDir } from "./fixtures/test-run-dirs";
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

test("순차 실행기는 실제 하위 실패·미실행을 성공으로 세지 않고 비정상 종료로 전달한다", async () => {
  const root = testTempDir("test-matrix-");
  const base = join(root, "base"), candidate = join(root, "candidate");
  const files = ["tests/pass.test.ts", "tests/fail.test.ts", "tests/skip.test.ts"];
  for (const dir of [base, candidate]) {
    mkdirSync(join(dir, "tests"), { recursive: true });
    writeFileSync(join(dir, files[0]), 'import {test,expect} from "bun:test";test("pass",()=>expect(1).toBe(1));\n');
    writeFileSync(join(dir, files[1]), 'import {test,expect} from "bun:test";test("intentional child failure",()=>expect(1).toBe(2));\n');
    writeFileSync(join(dir, files[2]), 'import {test} from "bun:test";test.skip("unexecuted case",()=>{});\n');
  }
  const inventory = join(root, "inventory.json"), output = join(root, "output");
  writeFileSync(inventory, JSON.stringify({ leafFiles: files, wrappers: [{ file: "tests/browser.test.ts", leaves: files }] }));
  const proc = Bun.spawn(["python3", "-I", "-B", resolve(import.meta.dir, "../scripts/execution-workdir-matrix.py"),
    "--inventory", inventory, "--baseline", base, "--candidate", candidate, "--runtime", process.execPath, "--output", output],
    { stdout: "ignore", stderr: "pipe" });
  const err = await new Response(proc.stderr).text();
  expect(await proc.exited, err).toBe(1);
  const result = JSON.parse(readFileSync(join(output, "results.json"), "utf8"));
  expect(result.rows).toHaveLength(6);
  expect(result.totals.candidate).toMatchObject({ expectedFiles: 3, executedFiles: 3, unexecutedFiles: 0, passedFiles: 1, failedFiles: 1, skippedTests: 1 });
  expect(result.rows.find((r: any) => r.phase === "candidate" && r.file === files[1])).toMatchObject({ exitCode: 1, status: "failed", fail: 1 });
  expect(result.rows.find((r: any) => r.phase === "candidate" && r.file === files[2]).status).not.toBe("passed");
  expect(result.duplicateWrappers).toHaveLength(1);
}, 20_000);

test("순차 실행기는 목록에 있지만 연결판에서 사라진 파일을 미실행으로 남긴다", async () => {
  const root = testTempDir("matrix-missing-"), base = join(root, "base"), candidate = join(root, "candidate");
  for (const dir of [base, candidate]) {
    mkdirSync(join(dir, "tests"), { recursive: true });
    writeFileSync(join(dir, "tests/pass.test.ts"), 'import {test,expect} from "bun:test";test("pass",()=>expect(1).toBe(1));\n');
  }
  const inventory = join(root, "inventory.json"), output = join(root, "output");
  writeFileSync(inventory, JSON.stringify({ leafFiles: ["tests/pass.test.ts", "tests/missing.test.ts"] }));
  const proc = Bun.spawn(["python3", "-I", "-B", resolve(import.meta.dir, "../scripts/execution-workdir-matrix.py"),
    "--inventory", inventory, "--baseline", base, "--candidate", candidate, "--runtime", process.execPath, "--output", output],
    { stdout: "ignore", stderr: "pipe" });
  const err = await new Response(proc.stderr).text();
  expect(await proc.exited, err).toBe(1);
  const result = JSON.parse(readFileSync(join(output, "results.json"), "utf8"));
  expect(result.totals.candidate).toMatchObject({ expectedFiles: 2, executedFiles: 1, unexecutedFiles: 1 });
}, 20_000);
