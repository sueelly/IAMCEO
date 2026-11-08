import { DEFAULT_RANKS, type Backend, type Member, type Ranks, type Settings } from "@shared/types";

export type AgentCli = Member["cli"];

const CLAUDE_MODELS = ["fable", "opus", "sonnet", "haiku"];
const CODEX_MODELS: string[] = [];

/** 이전 서버의 bootstrap 에 CLI 가 없으면 기존 Claude 동작을 유지한다. */
export const agentLabel = (cli: AgentCli = "claude"): string => cli === "codex" ? "Codex CLI" : "Claude Code";
export const suggestedModels = (cli: AgentCli = "claude"): readonly string[] => cli === "codex" ? CODEX_MODELS : CLAUDE_MODELS;
export const effectiveAgentCli = (backend: Backend | null, cli: AgentCli = "claude"): AgentCli => backend === "herdr" ? "claude" : cli;
export const providerRanks = (settings: Pick<Settings, "ranks" | "codexRanks">, cli: AgentCli = "claude"): Ranks =>
  cli === "codex" ? settings.codexRanks ?? DEFAULT_RANKS : settings.ranks;

/** 작은따옴표와 경로·세션 ID 를 셸에 안전하게 전달한다. */
const shellQuote = (s: string) => (/^[A-Za-z0-9_\-./:=@]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
export const memberResumeCommand = (m: Pick<Member, "cli" | "cwd" | "sessionId">): string =>
  `cd ${shellQuote(m.cwd)} && ${m.cli === "codex" ? "codex resume" : "claude --resume"} ${shellQuote(m.sessionId ?? "")}`;

export const supportsCompact = (m: Pick<Member, "cli" | "backend">): boolean => m.cli !== "codex" || m.backend !== "headless";
