import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../server/bus.ts";
import { loadConfig } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import { Store } from "../server/store.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";
import { providerLaunch } from "../server/runner/providers.ts";

// Opt in with a real CLI binary. All configuration, MCPs and model traffic stay in this fixture;
// no account credential, production session or billed model request is used.
const binary = process.env.IAMCEO_CODEX_POLICY_BIN;
for (const role of ["conductor", "reviewer", "worker", "root"] as const) test.skipIf(!binary)(`installed Codex exposes native spawn only to production staff: ${role}`, async () => {
  const runtime = createIsolatedRuntime();
  const config = loadConfig(runtime.childEnv());
  const store = new Store(openDb(config.dbPath), new Bus());
  const orch = new Orchestrator({ config, store, runners: new Map(), providerHomes: runtime.providerHomes, serverUrl: "http://127.0.0.1:1" });
  const root = mkdtempSync(join(tmpdir(), "iamceo-native-policy-"));
  const home = join(root, "codex"); mkdirSync(home);
  let resolveRequest!: (names: string[]) => void;
  const request = new Promise<string[]>(resolve => { resolveRequest = resolve; });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const body = await req.json() as { tools?: { name?: string; type?: string; tools?: { name: string }[] }[] };
    resolveRequest((body.tools ?? []).flatMap(tool => [tool.name ?? tool.type ?? "unknown", ...(tool.tools ?? []).map(child => child.name)]));
    return Response.json({ error: { message: "policy fixture complete" } }, { status: 400 });
  } });
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const marker = join(root, "external-mcp-started");
    writeFileSync(join(home, "config.toml"), `model="gpt-5-codex"\nmodel_provider="fixture"\n[model_providers.fixture]\nname="Fixture"\nbase_url="http://127.0.0.1:${server.port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n[mcp_servers.external]\ncommand="/usr/bin/touch"\nargs=[${JSON.stringify(marker)}]\n`);
    const opts = { systemPromptFile: join(root, "rules.md"), mcpConfigFile: join(root, "mcp.json"), resume: false, projectName: "Policy fixture" };
    writeFileSync(opts.systemPromptFile, "Inspect orchestration metadata only.");
    writeFileSync(opts.mcpConfigFile, JSON.stringify({ mcpServers: { iamceo: { command: "/usr/bin/false", args: [], env: {} } } }));
    const project = store.createProject({ name: "fixture", cwd: root });
    const employee = role === "reviewer" ? store.ensureFinalReviewer(project.id)! :
      store.createMember({ projectId: project.id, name: role, handle: role === "conductor" ? "lead" : "staff", kind: role, cli: "codex" });
    const member = orch["runnerMember"](employee, project);
    const launch = providerLaunch(member, opts, { codexBin: binary, codexHome: home });
    child = Bun.spawn([...launch.argv, "exec", "--skip-git-repo-check", "--json", "Inspect fixture"], {
      cwd: root, env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: home, ...launch.env }, stdin: "ignore", stdout: "ignore", stderr: "pipe",
    });
    const stderr = new Response(child.stderr as ReadableStream<Uint8Array>).text();
    const names = await Promise.race([request, child.exited.then(async code => { throw new Error(`Fixture Codex exited ${code}: ${await stderr}`); }), Bun.sleep(10_000).then(() => { throw new Error("No fixture model request received"); })]);
    expect(names).toContain("view_image");
    if (role === "worker" || role === "root") {
      expect(names.some(name => name === "spawn_agent")).toBe(true);
    } else {
      expect(names.filter(name => /exec|patch|shell|agent|imagegen|computer|browser|external/i.test(name))).toEqual([]);
      expect(existsSync(marker)).toBe(false);
    }
    expect(await child.exited).toBe(1); // The fixture intentionally refuses generation after inspecting tools.
  } finally {
    child?.kill(); if (child) await child.exited;
    await server.stop(true); rmSync(root, { recursive: true, force: true });
    await orch.shutdown(); store.db.close(); await runtime.stop();
  }
}, 20_000);
