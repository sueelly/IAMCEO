import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../server/bus.ts";
import { loadConfig } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import { providerLaunch } from "../server/runner/providers.ts";
import { Store } from "../server/store.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";

const bin = process.env.IAMCEO_CLAUDE_POLICY_BIN;
for (const role of ["worker", "root", "conductor", "reviewer"] as const) {
  test.skipIf(!bin)(`installed Claude advertises the Agent tool only to eligible staff: ${role}`, async () => {
    const runtime = createIsolatedRuntime();
    const config = loadConfig(runtime.childEnv());
    const store = new Store(openDb(config.dbPath), new Bus());
    const orch = new Orchestrator({ config, store, runners: new Map(), providerHomes: runtime.providerHomes, serverUrl: "http://127.0.0.1:1" });
    let resolveTools!: (names: string[]) => void;
    const request = new Promise<string[]>(resolve => { resolveTools = resolve; });
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
      if (req.method === "POST" && new URL(req.url).pathname === "/v1/messages") {
        const payload = await req.json() as { tools?: { name: string }[] };
        if (payload.tools?.length) resolveTools(payload.tools.map(t => t.name));
      }
      return Response.json({ type: "error", error: { type: "invalid_request_error", message: "fixture complete" } }, { status: 400 });
    } });
    let child: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const project = store.createProject({ name: "Fixture", cwd: runtime.paths.work, chiefCli: "claude" });
      const employee = role === "reviewer" ? store.ensureFinalReviewer(project.id)! : store.createMember({
        name: role, handle: role === "conductor" ? "lead" : "staff", kind: role, cli: "claude", projectId: project.id });
      const member = orch["runnerMember"](employee, project);
      const opts = { systemPromptFile: join(runtime.paths.work, "rules.md"), mcpConfigFile: join(runtime.paths.work, "mcp.json"), projectName: "Fixture", resume: false };
      writeFileSync(opts.systemPromptFile, "Inspect synthetic fixtures.");
      writeFileSync(opts.mcpConfigFile, JSON.stringify({ mcpServers: {} }));
      const launch = providerLaunch(member, opts, { claudeBin: bin });
      child = Bun.spawn([...launch.argv, "--print", "Inspect the fixture"], {
        cwd: runtime.paths.work, stdin: "ignore", stdout: "ignore", stderr: "ignore",
        env: { ...runtime.childEnv(), ...launch.env, ANTHROPIC_API_KEY: "isolated-local-fixture",
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1", NO_PROXY: "127.0.0.1" },
      });
      const names = await Promise.race([request, child.exited.then(code => { throw new Error(`Claude exited ${code} before sending its tool inventory`); }),
        Bun.sleep(10_000).then(() => { throw new Error("The fixture received no Claude tool inventory"); })]);
      if (role === "worker" || role === "root") expect(names).toContain("Agent");
      else {
        expect(names).toContain("Read");
        expect(names.filter(name => ["Agent", "Task", "Bash", "Edit", "Write"].includes(name))).toEqual([]);
      }
    } finally {
      if (child) { child.kill(); await child.exited; }
      await server.stop(true); await orch.shutdown(); store.db.close(); await runtime.stop();
    }
  }, 15_000);
}
