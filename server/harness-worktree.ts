import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Local execution paths only; malformed URLs must never become an unknown-cwd wildcard. */
export function executionPath(value: unknown): string | null {
  if (typeof value !== "string" || !value.isWellFormed() || value.includes("\0")) return null;
  if (isAbsolute(value)) return resolve(value);
  if (!/^file:(?:\/\/[^/]*\/|\/(?!\/))/i.test(value) || /[\x00-\x20\\?#]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "file:" || url.hostname || url.search || url.hash || /%2f|%5c/i.test(url.pathname)) return null;
    decodeURIComponent(url.pathname);
    const path = fileURLToPath(url);
    return path.includes("\0") ? null : resolve(path);
  } catch { return null; }
}

/** A task's registered worktree (including tool subdirectories) is an additional
 * execution scope. Prefix siblings and parent escapes keep the ordinary cwd check. */
export function executionExpectedCwd(actual: string | null, registered: string | null, worktree?: string | null): string | null {
  const root = executionPath(worktree), cwd = executionPath(actual);
  if (root && root !== "/" && cwd) {
    const path = relative(root, cwd);
    if (path !== ".." && !path.startsWith("../") && !isAbsolute(path)) return cwd;
  }
  return executionPath(registered);
}

/** Compare real locations when they still exist; historical removed paths retain
 * their lexical meaning, but existing symlinks never widen a task's scope. */
export function executionCwdAllowed(cwd: string | null, registered: string | null, worktree?: string | null): boolean {
  if (cwd === null) return registered === null && !worktree;
  const physical = (path: string) => { try { return realpathSync(path); } catch { return path; } };
  const actual = executionPath(cwd); if (!actual) return false;
  return [registered, worktree].some(value => {
    const root = executionPath(value); if (!root || root === "/") return false;
    const rel = relative(physical(root), physical(actual));
    return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
  });
}
