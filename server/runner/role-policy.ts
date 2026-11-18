import type { RunnerMember } from "./types.ts";
import { FINAL_REVIEWER_TOOLSET } from "../../shared/types.ts";
import { CoreError } from "./core-client.ts";

/** Availability, not an approval hint: unlisted built-ins and external MCPs cannot execute. */
export function claudeRoleArgs(member: RunnerMember): string[] {
  return member.kind === "conductor"
    ? ["--permission-mode", "default", "--tools", "Read,Glob,Grep", "--strict-mcp-config", "--allowedTools", "mcp__iamceo,Read,Glob,Grep"]
    : ["--permission-mode", member.permissionMode, "--allowedTools", "mcp__iamceo"];
}

const COORDINATION_TOOLS = ["board", "roster", "task_trace", "status", "post", "team_assign"] as const;

/** This subset also forms part of the managed session's policy fingerprint. */
export function codexCoordinationTools(member: Pick<RunnerMember, "kind" | "cli" | "origin" | "finalReviewer">) {
  if (member.cli === "codex" && member.kind === "conductor" && member.origin === "runner" && !member.finalReviewer) {
    return COORDINATION_TOOLS;
  }
}

/** Codex maps merge across config layers, so an empty mcp_servers table is NOT an allowlist. */
export function codexRoleArgs(bin: string, member: RunnerMember, codexHome?: string): string[] {
  if (member.kind !== "conductor") return [];
  let servers: { name: string }[];
  try {
    const result = Bun.spawnSync([bin, "-c", "features.plugins=false", "-c", "features.apps=false", "mcp", "list", "--json"], {
      cwd: member.cwd, env: { ...process.env, ...(codexHome ? { CODEX_HOME: codexHome } : {}) },
      stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 5000,
    });
    if (result.exitCode !== 0) throw new Error("discovery failed");
    const parsed: unknown = JSON.parse(result.stdout.toString());
    if (!Array.isArray(parsed) || parsed.some(server => !server || typeof server.name !== "string" || !/^[A-Za-z0-9_-]+$/.test(server.name))) throw new Error("invalid inventory");
    servers = parsed;
  } catch {
    // Discovery output can contain server credentials. Never copy it into an error or log.
    throw new CoreError("role_policy", "총괄의 조정 전용 MCP 목록을 확인하지 못해 실행하지 않았습니다");
  }
  const args = ["--sandbox", "read-only", "--ask-for-approval", "never"];
  // shell_tool removes exec AND apply_patch. Disable alternate executors, native children and external writes.
  for (const feature of ["shell_tool", "multi_agent", "multi_agent_v2", "apps", "plugins", "hooks", "computer_use", "browser_use", "browser_use_external", "in_app_browser", "image_generation", "code_mode", "goals", "request_permissions_tool"]) {
    args.push("-c", `features.${feature}=false`);
  }
  args.push("-c", 'web_search="disabled"');
  // Codex splits -c keys on literal dots; TOML-quoted segments are not decoded here.
  for (const server of servers) if (server.name !== "iamceo") args.push("-c", `mcp_servers.${server.name}.enabled=false`);
  args.push("-c", "mcp_servers.iamceo.enabled=true");
  const tools = member.finalReviewer ? FINAL_REVIEWER_TOOLSET : codexCoordinationTools(member);
  for (const tool of tools ?? []) {
    args.push("-c", `mcp_servers.iamceo.tools.${tool}.approval_mode="approve"`);
  }
  return args;
}
