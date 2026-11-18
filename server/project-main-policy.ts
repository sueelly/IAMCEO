import { execFileSync } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import type { Task } from "../shared/types.ts";
import { bindingContract, missingExecutionContractFields, type TaskContract } from "./harness.ts";
import { fullCommit } from "./integration-evidence.ts";
import { ApiError, type Store } from "./store.ts";

const component = /^[\w.-]+(?:\/[\w.-]+)*$/u;
const safePath = (path: string) => component.test(path) && path.split("/").every(part => part !== "." && part !== ".." && part !== ".git");
export const MainPolicyRequest = z.strictObject({
  origin: z.string().regex(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\.git$/u),
  paths: z.array(z.string().max(300).refine(safePath)).min(1).max(32),
  source: z.string().trim().min(1).max(1000),
  contracts: z.array(z.strictObject({ taskId: z.string().min(1), rev: z.number().int().positive() })).max(256).default([]),
});
type Request = z.infer<typeof MainPolicyRequest>;
export const projectMainPolicyPrefix = "프로젝트 main 승인 #";
interface Policy { root: string; origin: string; paths: string; source: string }
interface Artifact { artifact_base: string; artifact_commit: string }
const main = /\b(?:main|master)\b|메인|주\s*브랜치|공유\s*브랜치|공용\s*브랜치/iu;

// Remove only the force operation and its immediately attached target. A separate main or push prohibition still applies.
const forceTarget = /(?:\b(?:origin\/)?(?:main|master)\b|메인(?:\s*브랜치)?)/u.source;
const forceOperation = /(?:\bforce[- ]?push(?:es|ing)?\b|(?:\bgit\s+)?\bpush\s+--force(?:-with-lease)?\b|강제\s*(?:푸시|push))/u.source;
const forceOnly = new RegExp(
  String.raw`(?:(?:\bno|\bnever|\bdo not|\bmust not)\s+)?(?:${forceTarget}(?:에는?|으로|로)?\s+)?${forceOperation}(?:\s+(?:(?:to|onto|on)\s+(?:the\s+)?|origin\s+)${forceTarget})?`,
  "giu",
);

function eligible(contract: TaskContract) {
  if (contract.kind !== "coding" || !bindingContract(contract) || missingExecutionContractFields(contract).length) return false;
  if (/원문\s*(?:근거(?:와|를)?\s*)?(?:채증|추출)|원작\s*추출|source[- ]text extraction/iu.test([contract.goal, contract.scope].join("\n"))) return false;
  const prohibitions = [...contract.forbidden, ...(contract.exclusions ?? [])].map(value =>
    value.replace(forceOnly, " "));
  if (prohibitions.some(value => main.test(value) || /(?:원격|github|깃허브|git)\s*(?:반영|푸시|push)|(?:통합|병합|머지|푸시|merge|push)|(?:github|깃허브).{0,12}올리/iu.test(value))) return false;
  const limits = [contract.goal, contract.scope, ...contract.acceptance, ...(contract.constraints ?? []), ...(contract.outputs ?? [])].join("\n").replace(forceOnly, " ");
  const branchOnly = /(?:브랜치|branch)(?:\s*(?:일반\s*)?(?:푸시|push))?\s*(?:만(?:\s|$)|까지|에만)|(?:only|solely)[^\n.]{0,32}branch|branch[- ]only/iu;
  const reviewOnly = /읽기\s*전용|read[- ]only|검수만|검증만|검증\s*(?:스크립트|자료)[^\n.]{0,20}만\s*작성|원\s*제품의?\s*변경\s*없이/iu;
  const disallowed = /(?:main|master|메인|통합|병합|푸시)[^\n.]{0,30}(?:금지|제외|불가|하지\s*않|하지\s*말|별도\s*승인)|(?:no|never|exclude|without|do not|must not)[^\n.]{0,32}(?:main|merge|push)/iu;
  return ![branchOnly, reviewOnly, disallowed].some(limit => limit.test(limits));
}

function git(cwd: string, ...args: string[]): string | null {
  try {
    return execFileSync("/usr/bin/git", ["--no-replace-objects", ...args], { cwd, encoding: "utf8", timeout: 2000, maxBuffer: 2_000_000,
      stdio: ["ignore", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin", HOME: homedir(), LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0",
        GIT_ALLOW_PROTOCOL: "", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" } });
  } catch { return null; }
}
function physical(path: string) { try { return realpathSync(path); } catch { return null; } }
function textFile(path: string, maxBytes = 8192) {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    return stat.isFile() && stat.size <= maxBytes ? readFileSync(fd, "utf8").trim() : null;
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}
function stamp(path: string) {
  try { const s = statSync(path, { bigint: true }); return [s.ino, s.ctimeNs, s.size].join("/"); } catch { return ""; }
}

// Only execute Git in the registered checkout or a linked checkout with its backlink in that Git directory.
function checkout(root: string, task: Task): string | null {
  if (!task.worktree || !isAbsolute(task.worktree) || !task.branch || /^(?:-|refs\/)|^(?:main|master|HEAD)$/u.test(task.branch)) return null;
  const tree = physical(task.worktree), common = physical(join(root, ".git"));
  if (!tree || !common) return null;
  let gitdir = common;
  if (tree !== root) {
    const pointer = textFile(join(tree, ".git"));
    if (!pointer?.startsWith("gitdir: ")) return null;
    const admin = physical(resolve(tree, pointer.slice(8)));
    if (!admin || dirname(admin) !== join(common, "worktrees")) return null;
    const back = textFile(join(admin, "gitdir")), shared = textFile(join(admin, "commondir"));
    if (!back || physical(resolve(admin, back)) !== join(tree, ".git") || !shared || physical(resolve(admin, shared)) !== common) return null;
    gitdir = admin;
  }
  return textFile(join(gitdir, "HEAD")) === "ref: refs/heads/" + task.branch ? tree : null;
}

const origins = new Map<string, { fingerprint: string; match: boolean }>();
function originMatches(root: string, tree: string, origin: string) {
  const marker = textFile(join(tree, ".git"));
  const admin = marker?.startsWith("gitdir: ") ? resolve(tree, marker.slice(8)) : join(root, ".git");
  const configs = [join(root, ".git", "config"), join(admin, "config.worktree"), join(root, ".git", "config.worktree"),
    join(homedir(), ".gitconfig"), join(homedir(), ".config", "git", "config"), "/etc/gitconfig", "/Library/Developer/CommandLineTools/usr/etc/gitconfig"];
  const fingerprint = configs.map(stamp).join("|"), key = [root, tree, origin].join("\0");
  const prior = origins.get(key);
  if (prior?.fingerprint === fingerprint) return prior.match;
  const match = [root, ...(tree === root ? [] : [tree])].every(cwd =>
    git(cwd, "remote", "get-url", "--all", "origin")?.trim() === origin && git(cwd, "remote", "get-url", "--push", "--all", "origin")?.trim() === origin);
  // Included config files and their conditions can change independently of the standard paths.
  const cacheable = configs.every(file => {
    if (!existsSync(file)) return true;
    const contents = textFile(file, 2_000_000);
    return contents !== null && !/^\s*\[\s*include/imu.test(contents);
  });
  if (cacheable) {
    if (origins.size > 256) origins.clear();
    origins.set(key, { fingerprint, match });
  }
  return match;
}

const deltas = new Map<string, boolean>();
function artifactInScope(policy: Policy, paths: string[], artifact: Artifact) {
  if (!fullCommit.test(artifact.artifact_base) || !fullCommit.test(artifact.artifact_commit)) return false;
  const key = [policy.root, policy.paths, artifact.artifact_base, artifact.artifact_commit].join("\0");
  if (deltas.has(key)) return deltas.get(key)!;
  const output = git(policy.root, "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", artifact.artifact_base, artifact.artifact_commit, "--");
  if (!output?.endsWith("\0")) return false;
  const inScope = (files: string) => files.slice(0, -1).split("\0").every(file => paths.some(prefix => file.startsWith(prefix + "/")));
  // A push also transfers intermediate commits, including files subsequently deleted before the submitted tip.
  const history = git(policy.root, "log", "--format=", "--no-ext-diff", "--no-textconv", "--no-renames", "--diff-merges=combined",
    "--name-only", "-z", artifact.artifact_base + ".." + artifact.artifact_commit, "--");
  const match = inScope(output) && !!history?.endsWith("\0") && inScope(history);
  if (deltas.size > 1024) deltas.clear();
  deltas.set(key, match);
  return match;
}

function applicableTree(store: Store, task: Task, registered: Policy) {
  if (task.mergedInto || physical(store.requireProject(task.projectId).cwd) !== registered.root) return false;
  const tree = checkout(registered.root, task);
  return !!tree && originMatches(registered.root, tree, registered.origin);
}

/** Effective projection only. Recorded contract revisions and report bindings stay immutable. */
export function projectMainContract(store: Store, taskId: string, contract: TaskContract, reportId?: string): TaskContract {
  if (contract.main_authority || taskId !== contract.taskId || !eligible(contract)) return contract;
  const registered = store.db.query<Policy & { id: number }, [string]>(`SELECT p.id,p.root,p.origin,p.paths,p.source FROM project_main_policies p
    JOIN tasks t ON t.project_id=p.project_id WHERE t.id=? AND p.revoked_at IS NULL`).get(taskId);
  if (!registered) return contract;
  const task = store.requireTask(taskId);
  if (!task.branch || !task.worktree) return contract;
  const paths: string[] = JSON.parse(registered.paths);
  const artifact = store.db.query<Artifact, [string, number, string, string | null]>(`SELECT artifact_base,artifact_commit FROM report_harness
    WHERE task_id=?1 AND contract_task_id=?1 AND contract_rev=?2 AND artifact_branch=?3 AND artifact_commit IS NOT NULL
    AND (?4 IS NULL OR message_id=?4) ORDER BY rowid DESC LIMIT 1`).get(taskId, contract.rev, task.branch, reportId ?? null);
  if (reportId && !artifact) return contract;
  const listed = contract.outputs?.length && contract.outputs.every(file => safePath(file) && paths.some(prefix => file.startsWith(prefix + "/")));
  const enrolled = !!store.db.query("SELECT 1 FROM task_main_policy_enrollments WHERE policy_id=? AND task_id=? AND rev=? AND branch=?").get(registered.id, taskId, contract.rev, task.branch);
  if ((!artifact && !listed && !enrolled) || !applicableTree(store, task, registered) || (artifact && !artifactInScope(registered, paths, artifact))) return contract;
  return { ...contract, main_authority: `${projectMainPolicyPrefix}${registered.id} · ${registered.source} · ${registered.origin} origin/main · ${paths.map(path => path + "/").join(", ")}`,
    projectMainPolicy: registered.id };
}

export function saveProjectMainPolicy(store: Store, projectId: string, input: Request): number {
  const { origin, paths, source, contracts } = input;
  const project = store.requireProject(projectId), root = physical(project.cwd);
  if (project.archived || project.isHq || !root || physical(git(root, "rev-parse", "--show-toplevel")?.trim() ?? "") !== root ||
      !existsSync(join(root, ".git", "config")) || !originMatches(root, root, origin))
    throw new ApiError(409, "프로젝트 저장소 루트와 origin의 가져오기·푸시 주소를 확인해 주세요");
  const registered: Policy = { root, origin, paths: JSON.stringify([...new Set(paths)].sort()), source };
  const prior = store.db.query<Policy, [string]>("SELECT root,origin,paths,source FROM project_main_policies WHERE project_id=? AND revoked_at IS NULL").get(projectId);
  if (prior && Object.keys(registered).some(key => prior[key as keyof Policy] !== registered[key as keyof Policy]))
    throw new ApiError(409, "이 프로젝트에는 범위나 출처가 다른 main 승인이 등록되어 있습니다");
  store.db.query("INSERT OR IGNORE INTO project_main_policies(project_id,root,origin,paths,source) VALUES(?,?,?,?,?)")
    .run(projectId, root, origin, registered.paths, source);
  const policyId = store.db.query<{id: number}, [string]>("SELECT id FROM project_main_policies WHERE project_id=? AND revoked_at IS NULL").get(projectId)!.id;
  for (const { taskId, rev } of contracts) {
    const task = store.requireTask(taskId), contract = store.getEffectiveContract(taskId);
    if (!contract || contract.taskId !== taskId || contract.rev !== rev || task.projectId !== projectId || !eligible(contract) || !applicableTree(store, task, registered))
      throw new ApiError(409, `업무 #${taskId}의 확정 계약 r${rev}, 작업 브랜치와 저장소 또는 main 제한을 확인해 주세요`);
    store.db.query("INSERT OR IGNORE INTO task_main_policy_enrollments(policy_id,task_id,rev,branch) VALUES(?,?,?,?)").run(policyId, taskId, rev, task.branch);
  }
  return policyId;
}
