import { isAbsolute } from "node:path";

/** Preserve the declared path in storage; comparison applies the ordinary task scope. */
export const isExecutionWorkdir = (value: unknown): value is string =>
  typeof value === "string" && value.isWellFormed() && isAbsolute(value) && !value.includes("\0");


import { commandObservation } from "./harness-command.ts";
import { executionPath, executionExpectedCwd, executionCwdAllowed } from "./harness-worktree.ts";

/** Explicit workdir describes the tool start, independently of later shell cd.
 * Completion and diagnostics share both the starting and effective cwd checks. */
export function observeCheckCommand(executed: string, command: string, actual: string | null, declared: string | null | undefined, registered: string | null, worktree?: string | null) {
  const start = executionPath(actual), wanted = declared == null ? executionExpectedCwd(start, registered, worktree) : executionPath(declared);
  const observation = commandObservation(executed, command, start, wanted, cwd => executionCwdAllowed(cwd, registered, worktree));
  if (declared != null && (!isExecutionWorkdir(declared) || !start || start !== wanted || !executionCwdAllowed(start, registered, worktree))) {
    return { ...observation, cwdMatch: "different" as const, proof: "absent" as const };
  }
  return observation;
}
