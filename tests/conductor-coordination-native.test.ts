import { releaseTestDir, testTempDir } from "./fixtures/test-run-dirs";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { providerLaunch } from "../server/runner/providers.ts";

// Opt in with a real CLI binary. All configuration, MCPs and model traffic stay in this fixture;
// no account credential, production session or billed model request is used.
const binary = process.env.IAMCEO_CODEX_POLICY_BIN;
test.skipIf(!binary)("installed Codex executes routine conductor tools and denies staff control and outside tools", async () => {
  const root = testTempDir("iamceo-native-policy-");
  const home = join(root, "codex"); mkdirSync(home);
  const observed = new Set<string>();
  const calls = ["post", "team_assign", "team_stop"];
  let injected = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    type Tool = { name?: string; type?: string; tools?: { name: string }[] };
    const body = await req.json() as { tools?: Tool[] };
    const offered = (body.tools ?? []).flatMap(t => t.tools
      ? t.tools.map(c => ({ name: c.name, namespace: t.name }))
      : [{ name: t.name ?? t.type ?? "", namespace: undefined }]);
    for (const t of offered) observed.add([t.namespace, t.name].filter(Boolean).join("."));
    if (injected) return Response.json({ error: { message: "fixture finished after tool responses" } }, { status: 400 });
    const requested = calls.map(name => offered.find(t => (t.namespace === "mcp__iamceo" && t.name === name) || t.name === `mcp__iamceo__${name}`));
    if (!requested.every(t => t !== undefined)) return Response.json({ error: { message: "IAMCEO tools missing" } }, { status: 400 });
    injected = true;
    const output = requested.map((t, i) => ({ type: "function_call", id: `fc_${i}`, call_id: `call_${i}`, name: t.name, namespace: t.namespace, arguments: "{}" }));
    const response = { id: "resp_fixture", object: "response", output };
    const events = [
      { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
      ...output.flatMap((item, output_index) => [
        { type: "response.output_item.added", output_index, item: { ...item, arguments: "" } },
        { type: "response.function_call_arguments.delta", output_index, item_id: item.id, delta: item.arguments },
        { type: "response.function_call_arguments.done", output_index, item_id: item.id, arguments: item.arguments },
        { type: "response.output_item.done", output_index, item },
      ]),
      { type: "response.completed", response: { ...response, status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ];
    return new Response(events.map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join(""),
      { headers: { "Content-Type": "text/event-stream" } });
  } });
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const marker = join(root, "external-mcp-started");
    writeFileSync(join(home, "config.toml"), `model="gpt-5-codex"\nmodel_provider="fixture"\n[model_providers.fixture]\nname="Fixture"\nbase_url="http://127.0.0.1:${server.port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n[mcp_servers.external]\ncommand="/usr/bin/touch"\nargs=[${JSON.stringify(marker)}]\n`);
    const opts = { systemPromptFile: join(root, "rules.md"), mcpConfigFile: join(root, "mcp.json"), resume: false, projectName: "Policy fixture" };
    writeFileSync(opts.systemPromptFile, "Inspect orchestration metadata only.");
    const received = join(root, "received.log");
    writeFileSync(received, "");
    writeFileSync(opts.mcpConfigFile, JSON.stringify({ mcpServers: { iamceo: { command: process.execPath,
      args: [join(import.meta.dir, "fixtures", "conductor-policy-mcp.ts"), received], env: {} } } }));
    const launch = providerLaunch({ id: "lead", projectId: "fixture", handle: "lead", name: "Conductor", cli: "codex", kind: "conductor", origin: "runner", codexSpeed: "standard", cwd: root,
      sessionId: null, paneId: null, model: null, effort: null, subagentModel: null, permissionMode: "bypassPermissions" }, opts, { codexBin: binary, codexHome: home });
    child = Bun.spawn([...launch.argv, "exec", "--skip-git-repo-check", "--json", "Inspect fixture"], {
      cwd: root, env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: home, ...launch.env }, stdin: "ignore", stdout: "pipe", stderr: "ignore",
    });
    const output = new Response(child.stdout as ReadableStream<Uint8Array>).text();
    const timeout = setTimeout(() => child?.kill(), 15_000);
    let exitCode: number;
    try { exitCode = await child.exited; } finally { clearTimeout(timeout); }
    expect(exitCode).toBe(1); // The fixture refuses further generation after the tool calls.
    expect(injected).toBe(true);
    expect(observed.has("view_image")).toBe(true);
    expect([...observed].filter(name => /exec|patch|shell|agent|imagegen|computer|browser|external/i.test(name))).toEqual([]);
    expect(existsSync(marker)).toBe(false);
    const completions = (await output).trim().split("\n").map(line => JSON.parse(line))
      .filter(event => event.type === "item.completed" && event.item?.type === "mcp_tool_call").map(event => event.item);
    expect(completions.find(tool => tool.tool === "team_stop")).toMatchObject({
      status: "failed", error: { message: "MCP tool call requires approval, but approval policy is never" },
    });
    for (const name of ["post", "team_assign"]) {
      expect(completions.find(tool => tool.tool === name)).toMatchObject({ status: "completed" });
    }
    expect(readFileSync(received, "utf8").trim().split("\n").sort()).toEqual(["post", "team_assign"]);
  } finally {
    child?.kill(); if (child) await child.exited;
    await server.stop(true); releaseTestDir(root);
  }
}, 20_000);
