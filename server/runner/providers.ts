// Provider CLIs remain interactive and load their ordinary user/project settings.
// IAMCEO additions are invocation-scoped; no global CLI configuration is changed.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { RunnerMember, StartOpts } from "./types.ts";
import { CoreError } from "./core-client.ts";
import { writeStatuslineWrapper } from "./statusline.ts";
import { subagentEnv } from "./headless.ts";
import { antigravityMemberHome, prepareAntigravityHome, ANTIGRAVITY_CONVERSATION_RE } from "./antigravity.ts";
import { claudeRoleArgs, codexRoleArgs } from "./role-policy.ts";

export type CoreProvider = "claude" | "codex" | "antigravity";
export interface ProviderLaunch { argv: string[]; env: Record<string, string>; sessionId: string | null }
/** antigravityRoot: IAMCEO-owned folder holding one agy configuration root per member. */
export interface ProviderBins { claudeBin?: string; codexBin?: string; codexHome?: string; antigravityBin?: string; antigravityRoot?: string; antigravityUserRoot?: string; contextHome?: string }
export function providerBin(provider: CoreProvider, bins: ProviderBins): string {
  return provider === "claude" ? bins.claudeBin || "claude" : provider === "codex" ? bins.codexBin || "codex" : bins.antigravityBin || "agy";
}
interface BridgeConfig { command: string; args: string[]; env: Record<string, string> }
function readBridge(mcpConfigFile: string): BridgeConfig {
  const config = JSON.parse(readFileSync(mcpConfigFile, "utf8")) as { mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }> };
  const bridge = config.mcpServers?.iamceo;
  if (!bridge?.command || !Array.isArray(bridge.args) || bridge.args.some((arg) => typeof arg !== "string")) throw new CoreError("config", "IAMCEO MCP bridge must use a stdio command and args");
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(bridge.env || {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string") throw new CoreError("config", `Invalid MCP environment value: ${key}`);
    env[key] = value;
  }
  return { command: bridge.command, args: bridge.args, env };
}
const toml = (value: unknown) => JSON.stringify(value);

export function providerFor(member: RunnerMember): CoreProvider { return member.cli ?? "claude"; }
export function providerLaunch(member: RunnerMember, opts: StartOpts, bins: ProviderBins = {}): ProviderLaunch {
  const provider = providerFor(member);
  // agy currently has no verified native tool allowlist. A prompt or plan mode is not enforcement.
  if (member.kind === "conductor" && provider === "antigravity") throw new CoreError("role_policy", "Antigravity의 조정 전용 도구 제한을 지원하지 않습니다. 총괄은 Codex 또는 Claude로 설정하세요");
  if (member.sessionId && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(member.sessionId)) throw new CoreError("invalid_session", "Invalid CLI session id");
  const configured = providerBin(provider, bins);
  const bin = configured.includes("/") ? configured : Bun.which(configured);
  if (!bin) throw new CoreError("unavailable", `${provider} executable not found: ${configured}`);
  const args: string[] = [];
  const env: Record<string, string> = {};
  if (provider === "claude") {
    const sessionId = member.sessionId || crypto.randomUUID();
    args.push(opts.resume && member.sessionId ? "--resume" : "--session-id", sessionId,
      "--append-system-prompt-file", opts.systemPromptFile, "--mcp-config", opts.mcpConfigFile,
      ...claudeRoleArgs(member), "-n", member.name);
    if (member.model) args.push("--model", member.model);
    if (member.effort) args.push("--effort", member.effort);
    if (bins.contextHome) {
      const settings = opts.settingsFile ? JSON.parse(readFileSync(opts.settingsFile, "utf8")) : {};
      args.push("--settings", JSON.stringify({ ...settings, statusLine: writeStatuslineWrapper(bins.contextHome) }));
    } else if (opts.settingsFile) args.push("--settings", opts.settingsFile);
    if (member.kind !== "conductor") Object.assign(env, subagentEnv(member.subagentModel));
    // Claude Code 2.1.3xx shows a dim follow-up suggestion inside an empty composer. core's terminal.read is plain
    // text, so the suggestion reads exactly like a half-typed draft and blocks safe input. Off for this process only.
    env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION = "false";
    return { argv: [bin, ...args], env, sessionId };
  }
  if (provider === "antigravity") return antigravityLaunch(bin, member, opts, bins);
  // Codex owns its native id; inventing one would make resume silently wrong.
  if (opts.resume && !member.sessionId) throw new CoreError("session_unknown", "Codex session id is unknown; reattach the existing core terminal or explicitly start a fresh session");
  if (member.kind !== "conductor") {
    if (member.subagentModel) args.push("-c", `agents.default_subagent_model=${toml(member.subagentModel)}`);
    args.push("-c", "features.multi_agent=true");
  }
  // Codex 0.166 opens an "Update available" menu on start whose default item runs `npm install -g @openai/codex`.
  // Under IAMCEO that menu only stalls the member (and one stray Enter would upgrade a global CLI). Off per process.
  args.push("-c", "check_for_update_on_startup=false");
  if (member.kind === "conductor") args.push(...codexRoleArgs(bin, member, bins.codexHome));
  else if (member.permissionMode === "bypassPermissions") args.push("--dangerously-bypass-approvals-and-sandbox");
  else if (member.permissionMode === "auto") args.push("--approve-for-me");
  else args.push("--ask-for-approval", "on-request");
  if (member.model) args.push("--model", member.model);
  if (member.effort) {
    args.push("-c", `model_reasoning_effort=${toml(member.effort)}`);
  }
  args.push("-c", `developer_instructions=${toml(readFileSync(opts.systemPromptFile, "utf8"))}`);
  const bridge = readBridge(opts.mcpConfigFile);
  args.push("-c", `mcp_servers.iamceo.command=${toml(bridge.command)}`, "-c", `mcp_servers.iamceo.args=[${bridge.args.map(toml).join(",")}]`);
  const bridgeEnvironment = Object.entries(bridge.env);
  Object.assign(env, bridge.env);
  // Forward named environment variables instead of exposing bearer tokens in
  // the CLI argv/process list. Codex's MCP env_vars is invocation-scoped.
  args.push("-c", `mcp_servers.iamceo.env_vars=[${bridgeEnvironment.map(([key]) => toml(key)).join(",")}]`);
  if (opts.resume && member.sessionId) args.push("resume", member.sessionId);
  return { argv: [bin, ...args], env, sessionId: opts.resume ? member.sessionId : null };
}

/**
 * agy 1.5.3. `--gemini_dir` (undocumented, verified) points agy at an IAMCEO-owned root: its GEMINI.md carries the
 * member prompt and its config/mcp_config.json the IAMCEO bridge. The owner's ~/.gemini is only read. Sign-in lives in
 * the OS keychain and is shared. The bridge token is written to that 0600 file, the same exposure as Claude's
 * --mcp-config file, and never to argv.
 */
function antigravityLaunch(bin: string, member: RunnerMember, opts: StartOpts, bins: ProviderBins): ProviderLaunch {
  if (!bins.antigravityRoot) throw new CoreError("config", "Antigravity needs an IAMCEO-owned configuration root");
  if (opts.resume && !member.sessionId) throw new CoreError("session_unknown", "Antigravity conversation id is unknown; reattach the existing core terminal or explicitly start a fresh session");
  if (member.sessionId && !ANTIGRAVITY_CONVERSATION_RE.test(member.sessionId)) throw new CoreError("invalid_session", "Invalid Antigravity conversation id");
  const home = antigravityMemberHome(bins.antigravityRoot, member.id);
  prepareAntigravityHome({ home, systemPrompt: readFileSync(opts.systemPromptFile, "utf8"), bridge: readBridge(opts.mcpConfigFile), userRoot: bins.antigravityUserRoot });
  const args = [`--gemini_dir=${home}`];
  if (opts.resume && member.sessionId) args.push("--conversation", member.sessionId);
  if (member.model) args.push("--model", member.model);
  if (member.permissionMode === "bypassPermissions") args.push("--dangerously-skip-permissions");
  else if (member.permissionMode === "auto") args.push("--mode", "auto");
  // IAMCEO's own tools never wait on an approval card, like Claude's --allowedTools mcp__iamceo.
  const session: Record<string, unknown> = { permissions: { allow: ["mcp(iamceo/*)"] } };
  if (bins.contextHome) session.statusLine = { ...writeStatuslineWrapper(bins.contextHome, { forward: false }), stack_with_default: true };
  args.push("--settings", JSON.stringify(session));
  // The self-updater would otherwise replace the shared ~/.local/bin/agy in the background during IAMCEO runs.
  return { argv: [bin, ...args], env: { AGY_CLI_DISABLE_AUTO_UPDATE: "true" }, sessionId: opts.resume ? member.sessionId : null };
}

export function isProviderArgv(argv: string[], provider: CoreProvider, bin?: string): boolean {
  const name = provider === "antigravity" ? "agy" : provider;
  return argv.length > 0 && (basename(argv[0]) === name || (!!bin && argv[0] === bin));
}
