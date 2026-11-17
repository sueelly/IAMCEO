// Diagnostic only: every model response and MCP call below is synthetic and local.
// The operational Codex home, IAMCEO URL, credentials and sessions are never used.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { providerLaunch } from "../../../server/runner/providers.ts";
import type { RunnerMember } from "../../../server/runner/types.ts";

const toolNames = ["status", "task_trace", "post", "task_review_evidence", "task_review"];

if (process.argv.includes("--mcp-stub")) {
  const server = new Server({ name: "iamceo", version: "synthetic" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolNames.map(name => ({
    name, description: `Synthetic ${name}; no production effect`,
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
  })) }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const path = process.env.SYNTHETIC_CALLS;
    if (!path) throw new Error("Synthetic call path missing");
    appendFileSync(path, JSON.stringify({ name: request.params.name }) + "\n");
    return { content: [{ type: "text", text: JSON.stringify({ synthetic: true, tool: request.params.name, accepted: true }) }] };
  });
  process.stdin.on("end", () => process.exit(0));
  await server.connect(new StdioServerTransport());
} else if (process.argv.includes("--external-stub")) {
  const marker = process.env.SYNTHETIC_EXTERNAL;
  if (marker) writeFileSync(marker, "unexpected external MCP start");
  throw new Error("External MCP must remain unavailable");
} else {
  // This is a separate diagnostic process. Do not forward the caller's account,
  // IAMCEO or OAuth environment to providerLaunch's MCP-inventory subprocess.
  for (const key of Object.keys(process.env)) if (key !== "PATH") delete process.env[key];
  const binary = "/opt/homebrew/Caskroom/codex/0.167.0/bin/codex";
  if (!existsSync(binary)) throw new Error("Pinned installed Codex 0.167.0 is missing");
  const sourceSha = "27ec070c1c83acbe0229c53ddccf278ad15d7965";
  const checkoutHead = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" }).stdout.toString().trim();
  const sourceDiff = Bun.spawnSync(["git", "diff", "--exit-code", sourceSha, "--", "server", "shared", "bin", "scripts", "package.json"], {
    cwd: process.cwd(), stdout: "pipe", stderr: "pipe",
  });
  if (sourceDiff.exitCode !== 0) throw new Error("Diagnostic requires unchanged pinned release source");
  const results: unknown[] = [];

  function encodeResponse(id: string, outputs: Record<string, unknown>[]) {
    let seq = 0;
    const events: Record<string, unknown>[] = [{ type: "response.created", response: { id, object: "response", status: "in_progress", output: [] } }];
    outputs.forEach((item, output_index) => {
      const empty = item.type === "function_call" ? { ...item, arguments: "" } : item;
      events.push({ type: "response.output_item.added", output_index, item: empty });
      if (item.type === "function_call") {
        events.push({ type: "response.function_call_arguments.delta", item_id: item.id, output_index, delta: item.arguments });
        events.push({ type: "response.function_call_arguments.done", item_id: item.id, output_index, arguments: item.arguments });
      }
      events.push({ type: "response.output_item.done", output_index, item });
    });
    events.push({ type: "response.completed", response: { id, object: "response", status: "completed", output: outputs,
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
    return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: seq++ })}\n\n`).join("");
  }

  for (const condition of ["baseline", "per-tool-approve"] as const) {
    const dir = mkdtempSync("/private/tmp/iamceo-review-codex-");
    const home = join(dir, "codex"); mkdirSync(home, { mode: 0o700 });
    const work = join(dir, "work"); mkdirSync(work, { mode: 0o700 });
    const callsPath = join(dir, "mcp-calls.jsonl"), externalMarker = join(dir, "external-started");
    let requestCount = 0, observedTools: string[] = [], injected = false;
    const toolOutputs: { callId: string; output: string }[] = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
      const body = await req.json() as { tools?: { name?: string; type?: string; tools?: { name?: string; type?: string }[] }[]; input?: unknown };
      requestCount++;
      const functions = (body.tools ?? []).flatMap(tool => tool.tools
        ? tool.tools.map(child => ({ namespace: tool.name, name: child.name }))
        : [{ namespace: undefined, name: tool.name }]);
      observedTools = functions.map(tool => [tool.namespace, tool.name].filter(Boolean).join("."));
      if (Array.isArray(body.input)) for (const item of body.input as Record<string, unknown>[]) {
        if (item.type === "function_call_output") {
          let output = typeof item.output === "string" ? item.output : JSON.stringify(item.output);
          try {
            const parts: unknown = JSON.parse(output);
            if (Array.isArray(parts)) output = parts.filter(part => part?.type === "input_text" && typeof part.text === "string" && !part.text.startsWith("Wall time:"))
              .map(part => part.text).join("\n");
          } catch { /* Keep the bounded synthetic error text when it is not structured. */ }
          if (!toolOutputs.some(old => old.callId === item.call_id && old.output === output)) {
            toolOutputs.push({ callId: String(item.call_id), output: output.slice(0, 1800) });
          }
        }
      }
      const targets = ["task_review_evidence", "post"].map(short => functions.find(tool => tool.namespace === "mcp__iamceo" && tool.name === short)
        ?? functions.find(tool => tool.name?.endsWith(`__${short}`)));
      if (!injected && targets.every(Boolean)) {
        injected = true;
        const output = targets.map((target, i) => ({ type: "function_call", id: `fc_${condition}_${i}`,
          call_id: `call_${i}`, name: target!.name, ...(target!.namespace ? { namespace: target!.namespace } : {}),
          arguments: JSON.stringify(i === 0 ? { task_id: "tk_synthetic", report_id: "msg_synthetic" } : { report_id: "msg_synthetic" }) }));
        return new Response(encodeResponse(`resp_${condition}_call`, output), { headers: { "Content-Type": "text/event-stream" } });
      }
      if (!injected) return Response.json({ error: { message: "Synthetic fixture did not observe expected IAMCEO tools" } }, { status: 400 });
      const final = { type: "message", id: `msg_${condition}`, status: "completed", role: "assistant",
        content: [{ type: "output_text", text: "Synthetic policy comparison complete.", annotations: [] }] };
      return new Response(encodeResponse(`resp_${condition}_done`, [final]), { headers: { "Content-Type": "text/event-stream" } });
    } });
    const config = [
      'model="gpt-5-codex"', 'model_provider="fixture"',
      '[model_providers.fixture]', 'name="Synthetic local policy fixture"',
      `base_url="http://127.0.0.1:${server.port}/v1"`, 'wire_api="responses"', 'requires_openai_auth=false',
      '[mcp_servers.external]', `command=${JSON.stringify(process.execPath)}`,
      `args=[${JSON.stringify(import.meta.path)},"--external-stub"]`,
    ].join("\n");
    writeFileSync(join(home, "config.toml"), config + "\n", { mode: 0o600 });
    const opts = { systemPromptFile: join(dir, "rules.md"), mcpConfigFile: join(dir, "mcp.json"), resume: false, projectName: "Synthetic review diagnostic" };
    writeFileSync(opts.systemPromptFile, "Only use the synthetic IAMCEO metadata tools. No shell, filesystem changes, outside network or actual review verdict.");
    writeFileSync(opts.mcpConfigFile, JSON.stringify({ mcpServers: { iamceo: { command: process.execPath,
      args: [import.meta.path, "--mcp-stub"], env: { SYNTHETIC_CALLS: callsPath, SYNTHETIC_EXTERNAL: externalMarker } } } }), { mode: 0o600 });
    const member: RunnerMember = { id: "synthetic-reviewer", projectId: "synthetic", handle: "review", name: "Synthetic final reviewer",
      kind: "conductor", cli: "codex", cwd: work, sessionId: null, paneId: null,
      model: null, effort: null, subagentModel: null, permissionMode: "default", codexSpeed: "fast" };
    const launch = providerLaunch(member, opts, { codexBin: binary, codexHome: home });
    const extra = condition === "per-tool-approve" ? toolNames.flatMap(name => ["-c", `mcp_servers.iamceo.tools.${name}.approval_mode="approve"`]) : [];
    const child = Bun.spawn([...launch.argv, ...extra, "exec", "--skip-git-repo-check", "--json", "Run the synthetic review metadata fixture."], {
      cwd: work, env: { PATH: process.env.PATH, HOME: dir, CODEX_HOME: home, ...launch.env },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const stdout = new Response(child.stdout as ReadableStream<Uint8Array>).text();
    const stderr = new Response(child.stderr as ReadableStream<Uint8Array>).text();
    const timeout = setTimeout(() => child.kill(), 25_000);
    let exitCode: number;
    try { exitCode = await child.exited; } finally { clearTimeout(timeout); await server.stop(true); }
    const out = await stdout, err = await stderr;
    const calls = existsSync(callsPath) ? readFileSync(callsPath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { name: string }) : [];
    const errors: string[] = [];
    const cliNotices: string[] = [];
    const toolEvents: { tool: string; status: string; error: string | null }[] = [];
    for (const line of out.split("\n")) {
      try {
        const event = JSON.parse(line);
        if (event.type === "item.completed" && event.item?.type === "mcp_tool_call") {
          toolEvents.push({ tool: event.item.tool, status: event.item.status, error: event.item.error?.message ?? null });
          if (event.item.error?.message) errors.push(event.item.error.message);
        } else if (event.type === "item.completed" && event.item?.type === "error" && typeof event.item.message === "string") {
          cliNotices.push(event.item.message.slice(0, 500));
        } else if (event.type === "turn.failed" || event.type === "error") {
          errors.push(String(event.error?.message ?? event.message).slice(0, 1800));
        }
      } catch { /* Do not retain the raw CLI stream. */ }
    }
    if (exitCode !== 0 && errors.length === 0) errors.push(err.split("\n").find(line => /error|Error/i.test(line))?.slice(0, 500) ?? `CLI exited ${exitCode}`);
    const forbiddenTools = observedTools.filter(name => /exec|patch|shell|agent|imagegen|computer|browser|external/i.test(name));
    const policy = { askForApproval: launch.argv[launch.argv.indexOf("--ask-for-approval") + 1],
      sandbox: launch.argv[launch.argv.indexOf("--sandbox") + 1],
      shellDisabled: launch.argv.includes("features.shell_tool=false"), externalDisabled: launch.argv.includes("mcp_servers.external.enabled=false") };
    results.push({ condition, fixtureRoot: dir, exitCode, requestCount, injected, tools: observedTools, forbiddenTools,
      externalStarted: existsSync(externalMarker), calls, callCount: calls.length, policy, toolOutputs, toolEvents, errors, cliNotices });
  }
  const [baseline, candidate] = results as { injected: boolean; callCount: number; forbiddenTools: string[];
    exitCode: number; calls: { name: string }[]; toolEvents: { tool: string; status: string; error: string | null }[];
    requestCount: number; externalStarted: boolean; toolOutputs: { output: string }[];
    policy: { askForApproval: string; sandbox: string; shellDisabled: boolean; externalDisabled: boolean } }[];
  const common = [baseline, candidate].every(item => item.injected && item.forbiddenTools.length === 0 && !item.externalStarted
    && item.exitCode === 0 && item.policy.askForApproval === "never" && item.policy.sandbox === "read-only" && item.policy.shellDisabled && item.policy.externalDisabled);
  const exactError = "MCP tool call requires approval, but approval policy is never";
  const baselineDeniedBeforeMcp = baseline.callCount === 0 && baseline.toolOutputs.length === 2 && baseline.toolOutputs.every(item => item.output === exactError)
    && baseline.toolEvents.length === 2 && baseline.toolEvents.every(event => event.status === "failed" && event.error === exactError);
  const candidateAllowedMcp = candidate.callCount === 2 && candidate.calls.map(call => call.name).sort().join(",") === "post,task_review_evidence"
    && candidate.toolOutputs.length === 2 && candidate.toolOutputs.every(item => item.output.includes('"accepted":true'))
    && candidate.toolEvents.length === 2 && candidate.toolEvents.every(event => event.status === "completed" && event.error === null);
  const verification = { restrictionsPreserved: common, baselineDeniedBeforeMcp, candidateAllowedMcp };
  const result = { sourceSha, checkoutHead, binaryVersion: "0.167.0", realModelRequests: 0, operationalCalls: 0,
    syntheticResponseRequests: baseline.requestCount + candidate.requestCount, conditions: results, verification, fixtureRootsPreserved: true };
  const file = join(import.meta.dir, "synthetic-codex-results.json");
  writeFileSync(file, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
  if (!common || !baselineDeniedBeforeMcp || !candidateAllowedMcp) process.exitCode = 1;
}
