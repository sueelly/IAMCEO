// Read-only production comparison: exercise only the existing fake core fixture.
// No provider turn, real CLI, live socket, or runtime-directory deletion.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = realpathSync(resolve(process.argv[2] ?? "."));
if (process.env.IAMCEO_TEST !== "1" || !root.startsWith("/Users/hyejookim/Programming/01_Ing/.worktrees/IAMCEO/")) {
  throw new Error("Explicit isolated IAMCEO worktree and IAMCEO_TEST=1 required");
}
const moduleAt = (file: string) => import(pathToFileURL(join(root, file)).href);
const { createIsolatedRuntime } = await moduleAt("tests/fixtures/isolated-runtime.ts");
const { startBrowserCore } = await moduleAt("tests/fixtures/core-browser-harness.ts");
const { coreRpc } = await moduleAt("server/runner/core-client.ts");
const runtime = createIsolatedRuntime();
const foreign = realpathSync(mkdtempSync("/private/tmp/iamceo-foreign-probe-"));
const listener = runtime.serve(() => new Response("synthetic fixture"));
const core = await startBrowserCore({ runtime });
const config = join(runtime.dir, "bridge.json");
const foreignConfig = join(foreign, "bridge.json");
const bridge = (url: string) => JSON.stringify({ mcpServers: { iamceo: { env: { IAMCEO_URL: url, IAMCEO_TOKEN: "synthetic-fixture-token" } } } });
writeFileSync(config, bridge(listener.url));
writeFileSync(foreignConfig, bridge(listener.url));
const request = (cwd: string, configPath = config) => coreRpc(runtime.socketPath, "terminal.run", {
  argv: [runtime.bins.claudeBin, "--session-id", "synthetic-probe", "--mcp-config", configPath],
  cwd, env: {}, labels: {},
});
const results: Record<string, unknown> = {};
try {
  await assert.rejects(request(foreign), /Path is outside this fixture/);
  results.foreignCwd = "rejected";
  await assert.rejects(request(runtime.paths.work, foreignConfig), /Path is outside this fixture/);
  results.foreignMcpConfig = "rejected";
  writeFileSync(config, bridge("http://127.0.0.1:7878"));
  await assert.rejects(request(runtime.paths.work), /URL must use this fixture's listening loopback port/);
  results.foreignUrl = "rejected";
  writeFileSync(config, bridge(listener.url));
  const accepted = await request(runtime.paths.work);
  assert.equal(accepted.cwd, runtime.paths.work);
  assert.equal(core.count("terminal.send"), 0);
  assert.equal(core.holders.size, 1);
  results.ownedCwdConfigUrl = "accepted";
  results.providerTurns = 0;
} finally {
  await core.stop();
  await listener.server.stop(true);
  // An externally supplied runtime is not removed by core.stop(). No provider
  // was spawned; the only listener is stopped above. Preserve both directories.
  assert.ok(existsSync(runtime.dir));
  assert.ok(existsSync(foreign));
}
console.log(JSON.stringify({ root, ...results, preservedDirectories: true }));
