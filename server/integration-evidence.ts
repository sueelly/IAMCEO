import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import type { ReportCheckInput } from "./harness.ts";
import type { CheckEvidence } from "./harness-evidence.ts";

const run = promisify(execFile);
export const beforeMainCommand = "git ls-remote --exit-code origin refs/heads/main";
export const remoteMainCommand = "git ls-remote origin refs/heads/main";
export const fullCommit = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;

async function git(cwd: string, ...args: string[]) {
  try {
    const { stdout } = await run("/usr/bin/git", ["--no-replace-objects", ...args], { cwd, timeout: 4000,
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
        GIT_OPTIONAL_LOCKS: "0", GIT_ALLOW_PROTOCOL: "", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" } });
    return stdout.trim();
  } catch { return null; }
}

export async function artifactRange(cwd: string, branch: string, commit: string) {
  if (!fullCommit.test(commit) || !branch || branch.startsWith("-") || branch.startsWith("refs/") ||
    ["main", "master", "HEAD"].includes(branch)) return null;
  const root = await git(cwd, "rev-parse", "--show-toplevel");
  if (!root || await realpath(cwd) !== await realpath(root)) return null;
  if (await git(cwd, "check-ref-format", "refs/heads/" + branch) === null) return null;
  const [tip, remoteTip, main] = await Promise.all([git(cwd, "rev-parse", "--verify", "refs/heads/" + branch),
    git(cwd, "rev-parse", "--verify", "refs/remotes/origin/" + branch), git(cwd, "rev-parse", "--verify", "refs/remotes/origin/main")]);
  if (tip !== commit && remoteTip !== commit) return null;
  const mainTip = main ?? await git(cwd, "rev-parse", "--verify", "refs/heads/main");
  const base = mainTip && await git(cwd, "merge-base", commit, mainTip);
  return base && base !== commit && fullCommit.test(base) ? base : null;
}

/** Git objects and the remote tracking ref belong to the registered repo. The live
 * remote observation comes from the worker's bound command receipt, with its actual stdout. */
export async function verifyIntegrationGraph(cwd: string, commit: string, base: string, main: string, comparisonBase: string | null) {
  if (![commit, base, main].every(sha => fullCommit.test(sha)) || comparisonBase && !fullCommit.test(comparisonBase)) return false;
  const [remote, mergeBase, included, advanced] = await Promise.all([git(cwd, "rev-parse", "--verify", "refs/remotes/origin/main"),
    git(cwd, "merge-base", base, commit), git(cwd, "merge-base", "--is-ancestor", commit, main), git(cwd, "merge-base", "--is-ancestor", base, main)]);
  if (!mergeBase || remote !== main || included !== "" || advanced !== "") return false;
  // A concurrent main update may have incorporated earlier commits in this work.
  return !comparisonBase || await git(cwd, "merge-base", "--is-ancestor", comparisonBase, mergeBase) === "";
}

function remoteObservation(checks: ReportCheckInput[], evidence: CheckEvidence[], command: string, sha: string) {
  const line = sha + "\trefs/heads/main";
  // Codex captures combined stdout, Claude may append a newline before stderr.
  const hashes = new Set([line, line + "\n", line + "\n\n"].map(text => createHash("sha256").update(text).digest("hex")));
  return evidence.find(e => e.status === "matched" && checks[e.idx]?.command === command &&
    e.outputSha !== null && hashes.has(e.outputSha))?.at;
}

export function witnessedRemoteIntegration(checks: ReportCheckInput[], evidence: CheckEvidence[], base: string, main: string): boolean {
  const before = remoteObservation(checks, evidence, beforeMainCommand, base);
  const after = remoteObservation(checks, evidence, remoteMainCommand, main);
  return !!before && !!after && before <= after;
}
