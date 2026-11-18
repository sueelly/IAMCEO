import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);
const sha = /^(?:[\da-f]{40}|[\da-f]{64})$/i;

async function gitAt(cwd: string, ...args: string[]) {
  try {
    const { stdout } = await run("/usr/bin/git", ["--no-pager", "--literal-pathspecs", ...args], { cwd, timeout: 4000,
      maxBuffer: 2 * 1024 * 1024, env: { PATH: "/usr/bin:/bin", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1",
        GIT_ALLOW_PROTOCOL: "", GIT_TERMINAL_PROMPT: "0" } });
    return stdout;
  } catch { return null; }
}

/** Read only objects in the project's registered repository. No worktree files, fetches, or user commands. */
export async function readFinalReviewPatch(cwd: string, commit: string, path: string | undefined, offset: number, recordedBase?: string | null, fullIndex = false) {
  if (!sha.test(commit)) return { state: "missing_commit" as const };
  const git = (...args: string[]) => gitAt(cwd, ...args);
  const root = (await git("rev-parse", "--show-toplevel"))?.trim();
  if (!root || await realpath(cwd).catch(() => null) !== await realpath(root).catch(() => null)) return { state: "missing_repository" as const };
  if ((await git("rev-parse", "--verify", commit + "^{commit}"))?.trim() !== commit.toLowerCase()) return { state: "missing_commit" as const };
  if (recordedBase && !sha.test(recordedBase)) return { state: "missing_base" as const };
  const base = recordedBase ? (await git("merge-base", commit, recordedBase))?.trim()
    : (await git("merge-base", commit, "refs/remotes/origin/main"))?.trim()
      ?? (await git("merge-base", commit, "refs/heads/main"))?.trim();
  const againstMain = !!base && sha.test(base) && (base !== commit || recordedBase === commit);
  if (!againstMain && (recordedBase || (await git("rev-list", "--parents", "-n", "1", commit))?.trim() !== commit)) {
    return { state: "missing_base" as const };
  }
  const command = againstMain ? ["diff", base, commit] : ["show", "--format=", "--root", commit];
  const options = ["--no-ext-diff", "--no-textconv", "--no-renames", "--no-color", ...(fullIndex ? ["--full-index"] : [])];
  const names = await git(...command, ...options, "--name-only", "-z", "--");
  if (names === null) return { state: "unavailable" as const };
  const files = names.split("\0").filter(Boolean);
  if (path !== undefined && !files.includes(path)) return { state: "unavailable" as const };
  const patch = await git(...command, ...options, "--", ...(path === undefined ? [] : [path]));
  if (patch === null) return { state: "select_file" as const, files: files.slice(0, 150), fileCount: files.length };
  const limit = 12_000;
  return { state: "observed" as const, commit, comparison: againstMain ? base : "root", files: files.slice(0, 150), fileCount: files.length,
    patch: patch.slice(offset, offset + limit), offset, nextOffset: patch.length > offset + limit ? offset + limit : null };
}

/** Reproduce the exact diff attached to a report whose feature is already on main.
 * This comparison is a read-only receipt and is never stored as an integration baseline. */
export async function readAttachedReviewPatch(cwd: string, worktree: string, branch: string, commit: string,
  base: string, document: string, path: string | undefined, offset: number) {
  if (!sha.test(base) || !sha.test(commit) || base === commit || !branch || branch.startsWith("-") ||
    branch.startsWith("refs/") || ["HEAD", "main", "master"].includes(branch)) return null;
  const root = (await gitAt(cwd, "rev-parse", "--show-toplevel"))?.trim();
  if (!root || await realpath(cwd).catch(() => null) !== await realpath(root).catch(() => null)) return null;
  const [trees, registered, branchCheck, included, ancestry] = await Promise.all([
    gitAt(cwd, "worktree", "list", "--porcelain", "-z"), realpath(worktree).catch(() => null),
    gitAt(cwd, "check-ref-format", "refs/heads/" + branch),
    gitAt(cwd, "merge-base", "--is-ancestor", commit, "refs/remotes/origin/main"),
    gitAt(cwd, "merge-base", "--is-ancestor", base, commit),
  ]);
  if (!trees || !registered || branchCheck !== "" || included !== "" || ancestry !== "") return null;
  const matches = trees.split("\0\0").some(record => {
    const lines = record.split("\0");
    return lines[0] === "worktree " + registered && lines.includes("HEAD " + commit) && lines.includes("branch refs/heads/" + branch);
  });
  if (!matches) return null;
  const full = await gitAt(cwd, "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color", "--full-index", base, commit, "--");
  if (!full) return null;
  const sha256 = createHash("sha256").update(full).digest("hex");
  const block = /^(`{3,})diff[ \t]*\n/mu.exec(document);
  if (!block) return null;
  const header = document.slice(0, block.index);
  if (![base, commit, sha256].every(value => new RegExp("(?<![0-9a-f])" + value + "(?![0-9a-f])", "iu").test(header))) return null;
  const contentStart = block.index + block[0].length;
  if (!document.startsWith(full + block[1], contentStart)) return null;
  const end = contentStart + full.length + block[1]!.length;
  if (end < document.length && document[end] !== "\n") return null;
  const patch = await readFinalReviewPatch(cwd, commit, path, offset, base, true);
  return patch.state === "observed" ? { sha256, patch } : null;
}
