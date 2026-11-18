import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import type { ReportCheckInput } from "./harness.ts";
import type { CheckEvidence } from "./harness-evidence.ts";

const run = promisify(execFile);
export const integrationHeadCommand = "git diff --quiet HEAD -- && git rev-parse HEAD";
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

export function isRemoteObservation(command: string | null | undefined) {
  return command === beforeMainCommand || command === remoteMainCommand;
}

async function originTargets(cwd: string) {
  const urls = await Promise.all([git(cwd, "remote", "get-url", "--all", "origin"),
    git(cwd, "remote", "get-url", "--push", "--all", "origin")]);
  if (urls.some(value => !value)) return null;
  // Relative filesystem remotes resolve from the checkout running Git.
  return JSON.stringify(urls.map(value => value!.split("\n").map(url => url.includes(":") ? url : resolve(cwd, url))));
}

/** The worktree list comes from the authorized repository, including linked checkouts.
 * A clone with the same objects and a different origin cannot register its receipts here. */
export async function integrationWorktreeAt(repo: string, worktree: string, commit: string): Promise<boolean> {
  if (!isAbsolute(worktree)) return false;
  const [list, root, projectRoot] = await Promise.all([git(repo, "worktree", "list", "--porcelain", "-z"),
    realpath(worktree).catch(() => null), realpath(repo).catch(() => null)]);
  if (!list || !root || !projectRoot) return false;
  for (const entry of list.split("\0\0")) {
    const [path, head] = entry.split("\0");
    if (head !== "HEAD " + commit || !path?.startsWith("worktree ") || await realpath(path.slice(9)).catch(() => null) !== root) continue;
    if (root === projectRoot) return true;
    const [authorized, actual] = await Promise.all([originTargets(projectRoot), originTargets(root)]);
    return authorized !== null && authorized === actual;
  }
  return false;
}

export function witnessedRemoteIntegration(checks: ReportCheckInput[], evidence: CheckEvidence[], base: string, main: string): boolean {
  const before = remoteObservation(checks, evidence, beforeMainCommand, base);
  const after = remoteObservation(checks, evidence, remoteMainCommand, main);
  if (!before || !after) return false;
  const start = Date.parse(before), end = Date.parse(after);
  return start <= end && evidence.every(e => e.status !== "matched" || isRemoteObservation(checks[e.idx]?.command) ||
    (e.at !== null && Date.parse(e.at) >= start && Date.parse(e.at) <= end));
}
