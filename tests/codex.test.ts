import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HeadlessRunner } from "../server/runner/headless.ts";
import { buildCodexInvocation, CodexStreamParser } from "../server/runner/codex.ts";
import type { RunnerEvent, RunnerMember, StartOpts } from "../server/runner/types.ts";

const runners: HeadlessRunner[] = [];
afterEach(async () => { await Promise.all(runners.splice(0).map(r => r.shutdown())); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "iamceo-codex-"));
  const opts: StartOpts = { systemPromptFile: join(dir, "role.md"), mcpConfigFile: join(dir, "mcp.json"), resume: false, projectName: "시험" };
  writeFileSync(opts.systemPromptFile, "총괄 역할. 결재와 보고는 IAMCEO 도구로 올린다.");
  writeFileSync(opts.mcpConfigFile, JSON.stringify({ mcpServers: { iamceo: { command: process.execPath, args: ["bridge.ts"], env: { IAMCEO_TOKEN: "private-member-token", IAMCEO_URL: "http://127.0.0.1:12345" } } } }));
  const member: RunnerMember = { id: "m-codex", projectId: "p", handle: "chief", name: "총괄", kind: "conductor", cli: "codex", cwd: dir, sessionId: null, paneId: null, model: null, effort: "high", subagentModel: null, permissionMode: "auto" };
  return { dir, opts, member };
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 8000;
  while (!check()) { if (Date.now() > deadline) throw Error("Codex runner timed out"); await Bun.sleep(10); }
}
describe("Codex headless", () => {
  test("fresh launch passes invocation-scoped MCP and instructions without putting tokens in argv", () => {
    const { member, opts } = fixture();
    const launch = buildCodexInvocation(member, opts, false);
    expect(launch.args[0]).toBe("exec");
    expect(launch.args).toContain("--json");
    expect(launch.args.at(-1)).toBe("-");
    expect(launch.args).not.toContain("resume");
    expect(launch.args.join(" ")).not.toContain("private-member-token");
    expect(launch.env.IAMCEO_TOKEN).toBe("private-member-token");
    expect(launch.args.join(" ")).toContain("mcp_servers.iamceo.env_vars");
    expect(launch.args.join(" ")).toContain("developer_instructions");
    expect(launch.args).toContain("--approve-for-me");
  });
  test("resume uses the exact native thread id and rejects option-shaped ids", () => {
    const { member, opts } = fixture();
    const id = "019abcde-1234-7123-8123-123456789abc";
    const launch = buildCodexInvocation({ ...member, sessionId: id }, { ...opts, resume: true }, true);
    expect(launch.args.slice(-3)).toEqual(["resume", id, "-"]);
    expect(() => buildCodexInvocation({ ...member, sessionId: "--last" }, opts, true)).toThrow();
  });
  test("JSONL captures native session, assistant text and a failed turn", () => {
    const events: RunnerEvent[] = [];
    const parser = new CodexStreamParser("m", e => events.push(e));
    parser.feed(JSON.stringify({ type: "thread.started", thread_id: "019abcde-1234-7123-8123-123456789abc" }));
    parser.feed(JSON.stringify({ type: "item.completed", item: { id: "i", type: "agent_message", text: "Codex 응답" } }));
    parser.feed(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 5 } }));
    expect(parser.result).toEqual({ finalText: "Codex 응답", isError: false });
    expect(events.some(e => e.type === "session")).toBe(true);
    const failed = new CodexStreamParser("m", () => {});
    failed.feed(JSON.stringify({ type: "turn.failed", error: { message: "usage limit reached" } }));
    expect(failed.result).toMatchObject({ isError: true, errorText: "usage limit reached" });
    expect(failed.sawOutput).toBe(false);
  });
  test("transient JSONL errors do not end a turn before subsequent successful output", () => {
    const parser = new CodexStreamParser("m", () => {});
    parser.feed(JSON.stringify({ type: "error", message: "Reconnecting..." }));
    expect(parser.result).toBeNull();
    parser.feed(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "복구됨" } }));
    parser.feed(JSON.stringify({ type: "turn.completed" }));
    expect(parser.result).toEqual({ finalText: "복구됨", isError: false });
  });
  test("a fatal error without turn.failed is surfaced at EOF", () => {
    const parser = new CodexStreamParser("m", () => {});
    parser.feed(JSON.stringify({ type: "error", message: "authentication failed" }));
    parser.finish();
    expect(parser.result).toMatchObject({ isError: true, errorText: "authentication failed" });
  });
  test("unknown events and malformed MCP result content do not strand the runner", () => {
    const parser = new CodexStreamParser("m", () => {});
    expect(() => {
      parser.feed("not JSON");
      parser.feed("null");
      parser.feed(JSON.stringify({ type: "item.completed", item: { type: "mcp_tool_call", result: { content: "plain result" } } }));
      parser.feed(JSON.stringify({ type: "turn.completed" }));
    }).not.toThrow();
    expect(parser.result?.isError).toBe(false);
  });
  test("read-only permissions and Codex maximum effort do not enable unrestricted execution", () => {
    const { member, opts } = fixture();
    const { args } = buildCodexInvocation({ ...member, permissionMode: "default", effort: "max" }, opts, false);
    expect(args.join(" ")).toContain('sandbox_mode="read-only"');
    expect(args.join(" ")).toContain('model_reasoning_effort="xhigh"');
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });
  test("real subprocess lifecycle persists native thread id, sends stdin and resumes after restart", async () => {
    const { dir, member, opts } = fixture();
    const log = join(dir, "calls.jsonl"), fake = resolve(import.meta.dir, "fixtures/fake-codex.ts");
    const env = { ...process.env, FAKE_CODEX_LOG: log };
    const events: RunnerEvent[] = [];
    const make = () => { const r = new HeadlessRunner({ claudeBin: "/unused/claude", codexBin: fake }, { env }); runners.push(r); r.on(e => events.push(e)); return r; };
    const first = make();
    expect((await first.start(member, opts)).sessionId).toBeNull();
    expect(await first.send(member, "첫 지시", opts)).toEqual({ ok: true });
    await until(() => events.some(e => e.type === "turn_end"));
    const session = events.find(e => e.type === "session") as Extract<RunnerEvent, { type: "session" }>;
    expect(session.sessionId).toBe("019abcde-1234-7123-8123-123456789abc");
    await first.shutdown();
    const second = make();
    await second.send({ ...member, sessionId: session.sessionId }, "다음 지시", { ...opts, resume: true });
    await until(() => events.filter(e => e.type === "turn_end").length === 2);
    const calls = readFileSync(log, "utf8").trim().split("\n").map(x => JSON.parse(x));
    expect(calls.map(c => c.stdin)).toEqual(["첫 지시", "다음 지시"]);
    expect(calls[1].args.slice(-3)).toEqual(["resume", session.sessionId, "-"]);
    expect(calls[0].token).toBe("private-member-token");
    expect(events.filter(e => e.type === "turn_end").every(e => !e.isError)).toBe(true);
  });
  test("Codex parallel setting does not send Claude slash commands and compact is refused", async () => {
    const { member, opts } = fixture();
    const runner = new HeadlessRunner({ claudeBin: "/unused", codexBin: resolve(import.meta.dir, "fixtures/fake-codex.ts") }); runners.push(runner);
    expect(await runner.setParallel(member, true, opts)).toEqual({ ok: true });
    expect(await runner.compact(member, "정리", opts)).toMatchObject({ ok: false, reason: "error", retryable: false });
  });
  test("interruption ends a Codex subprocess once without reporting a false failure", async () => {
    const { member, opts } = fixture();
    const runner = new HeadlessRunner({ claudeBin: "/unused", codexBin: resolve(import.meta.dir, "fixtures/fake-codex.ts") }, { timings: { interruptToTermMs: 50, termToKillMs: 50 } }); runners.push(runner);
    const events: RunnerEvent[] = []; runner.on(e => events.push(e));
    await runner.send(member, "hang", opts);
    await until(() => events.some(e => e.type === "activity"));
    await runner.interrupt(member);
    await until(() => events.some(e => e.type === "turn_end"));
    expect(events.filter(e => e.type === "turn_end")).toHaveLength(1);
    expect(events.find(e => e.type === "turn_end")).toMatchObject({ isError: false, finalText: "" });
    expect(runner.isBusy(member.id)).toBe(false);
  });
});
