import { expect, test } from "bun:test";
import { agentLabel, effectiveAgentCli, memberResumeCommand, providerRanks, suggestedModels, supportsCompact } from "../web/src/lib/agent.ts";
import { DEFAULT_RANKS } from "../shared/types.ts";
test("Codex UI uses its own label and does not suggest Claude-only models", () => {
  expect(agentLabel("codex")).toBe("Codex CLI");
  expect(suggestedModels("codex")).not.toContain("opus");
  expect(suggestedModels()).toContain("opus");
  expect(agentLabel()).toBe("Claude Code");
});
test("terminal instructions quote paths and retain the member's original provider", () => {
  expect(memberResumeCommand({ cli: "codex", cwd: "/tmp/my project", sessionId: "abc" })).toBe("cd '/tmp/my project' && codex resume abc");
  expect(memberResumeCommand({ cli: "claude", cwd: "/tmp/project", sessionId: "abc" })).toBe("cd /tmp/project && claude --resume abc");
});
test("headless Codex does not offer unsupported manual compact", () => {
  expect(supportsCompact({ cli: "codex", backend: "headless" })).toBe(false);
  expect(supportsCompact({ cli: "claude", backend: "headless" })).toBe(true);
});
test("an existing herdr setup is identified as Claude until headless is selected", () => {
  expect(effectiveAgentCli("herdr", "codex")).toBe("claude");
  expect(effectiveAgentCli("headless", "codex")).toBe("codex");
});
test("Codex rank hints ignore historical Claude ranks when Codex settings are absent", () => {
  const settings = { ranks: { ...DEFAULT_RANKS, manager: { model: "opus", effort: null } } };
  expect(providerRanks(settings as never, "codex").manager.model).toBeNull();
  expect(providerRanks(settings as never, "claude").manager.model).toBe("opus");
});
