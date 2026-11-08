import { readFileSync } from "node:fs";
import { SESSION_ID_RE } from "../text.ts";
import type { ParsedResult } from "./headless.ts";
import type { RunnerEvent, RunnerMember, StartOpts } from "./types.ts";

/** Settings are passed to this invocation only. MCP credentials travel in the environment. */
export function buildCodexInvocation(member: RunnerMember, opts: StartOpts, resume: boolean, inbox?: string): { args: string[]; env: Record<string, string> } {
  if (resume && (!member.sessionId || !SESSION_ID_RE.test(member.sessionId))) throw new Error("Codex 세션 ID가 올바르지 않습니다");
  const args = ["exec", "--json", "--skip-git-repo-check"];
  const config = (key: string, value: unknown) => args.push("-c", `${key}=${JSON.stringify(value)}`);
  config("check_for_update_on_startup", false);
  config("features.multi_agent", member.parallel ?? false);
  if (member.subagentModel) config("agents.default_subagent_model", member.subagentModel);
  config("developer_instructions", readFileSync(opts.systemPromptFile, "utf8"));
  if (member.model) args.push("--model", member.model);
  if (member.effort) config("model_reasoning_effort", member.effort === "max" ? "xhigh" : member.effort);
  if (member.permissionMode === "bypassPermissions") args.push("--dangerously-bypass-approvals-and-sandbox");
  else if (member.permissionMode === "auto") args.push("--approve-for-me");
  else { config("approval_policy", "never"); config("sandbox_mode", "read-only"); }
  if (inbox) args.push("--add-dir", inbox);
  const mcp = JSON.parse(readFileSync(opts.mcpConfigFile, "utf8"));
  const bridge = mcp?.mcpServers?.iamceo;
  if (typeof bridge?.command !== "string" || !bridge.command || !Array.isArray(bridge.args) || bridge.args.some((arg: unknown) => typeof arg !== "string")) throw new Error("IAMCEO MCP 명령과 인자가 필요합니다");
  config("mcp_servers.iamceo.command", bridge.command);
  config("mcp_servers.iamceo.args", bridge.args);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(bridge.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string") throw new Error("IAMCEO MCP 환경변수가 올바르지 않습니다");
    env[key] = value;
  }
  config("mcp_servers.iamceo.env_vars", Object.keys(env));
  config("mcp_servers.iamceo.required", true);
  if (resume) args.push("resume", member.sessionId!);
  args.push("-");
  return { args: args.map(arg => arg.replaceAll("\0", "")), env };
}

/** Official `codex exec --json` JSONL, normalized to the shared headless lifecycle. */
export class CodexStreamParser {
  sessionId: string | null = null;
  result: ParsedResult | null = null;
  sawOutput = false;
  contextWindow: number | null = null;
  sawCompactBoundary = false;
  private lastText = "";
  private lastError: string | null = null;
  constructor(private readonly memberId: string, private readonly emit: (event: RunnerEvent) => void) {}
  feed(line: string): void {
    let event: any;
    try { event = JSON.parse(line); } catch { return; }
    if (!event || typeof event !== "object") return;
    if (event.type === "thread.started" && typeof event.thread_id === "string" && SESSION_ID_RE.test(event.thread_id)) {
      this.sessionId = event.thread_id;
      this.emit({ type: "session", memberId: this.memberId, sessionId: event.thread_id });
    } else if (event.type === "turn.completed") this.result = { finalText: this.lastText, isError: false };
    else if (event.type === "turn.failed" || event.type === "error") {
      const message = typeof event.error?.message === "string" ? event.error.message : typeof event.message === "string" ? event.message : "Codex 실행 오류";
      this.lastError = message;
      if (event.type === "turn.failed") this.result = { finalText: this.lastText, isError: true, errorText: message };
    } else if (["item.started", "item.updated", "item.completed"].includes(event.type)) {
      const item = event.item;
      if (!item || typeof item !== "object") return;
      this.sawOutput = true;
      if (item.type === "agent_message" && typeof item.text === "string" && event.type === "item.completed") {
        this.lastText = item.text;
        this.emit({ type: "activity", memberId: this.memberId, kind: "text", text: item.text });
      } else if (event.type === "item.started") {
        this.emit({ type: "activity", memberId: this.memberId, kind: "tool", text: `${item.type}: ${item.command ?? item.tool ?? ""}`.slice(0, 300) });
      } else if (event.type === "item.completed" && item.type !== "agent_message") {
        const content = item.result?.content;
        const text = item.aggregated_output ?? (Array.isArray(content) ? content.map((c: any) => typeof c?.text === "string" ? c.text : "").join("\n") : typeof content === "string" ? content : null) ?? item.text ?? item.type;
        this.emit({ type: "activity", memberId: this.memberId, kind: "tool_result", text: String(text).slice(0, 300) });
      }
    }
  }
  finish(): void {
    if (!this.result && this.lastError) this.result = { finalText: this.lastText, isError: true, errorText: this.lastError };
  }
}
