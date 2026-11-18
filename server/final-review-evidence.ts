import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);
const sha = /^(?:[\da-f]{40}|[\da-f]{64})$/i;

/** Read only objects in the project's registered repository. No worktree files, fetches, or user commands. */
export async function readFinalReviewPatch(cwd: string, commit: string, path: string | undefined, offset: number, recordedBase?: string | null) {
  if (!sha.test(commit)) return { state: "missing_commit" as const };
  const git = async (...args: string[]) => {
    try {
      const { stdout } = await run("/usr/bin/git", ["--no-pager", "--literal-pathspecs", ...args], { cwd, timeout: 4000,
        maxBuffer: 2 * 1024 * 1024, env: { PATH: "/usr/bin:/bin", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1",
          GIT_ALLOW_PROTOCOL: "", GIT_TERMINAL_PROMPT: "0" } });
      return stdout;
    } catch { return null; }
  };
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
  const options = ["--no-ext-diff", "--no-textconv", "--no-renames", "--no-color"];
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
