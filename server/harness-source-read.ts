// 프로젝트의 두 비민감 코드 출처만 읽는다. 셸/제공자 출력은 이 관찰을 만들 수 없다.
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { ApiError } from "./store.ts";
import { isSecretPath } from "./secret-paths.ts";
import { redactHarnessText } from "./harness-redaction.ts";

export const CODE_SOURCES = ["server/orchestrator.ts", "server/harness-evidence.ts"] as const;
export const CODE_READ_KIND = "server_code_read_v1";
export const CODE_FILE_BYTES = 2 * 1024 * 1024, CODE_FRAGMENT_BYTES = 16 * 1024, CODE_LINES = 80;
export interface CodeReadScope { projectId: string; memberId: string; taskId: string; contractTaskId: string; contractRev: number; contractAt: string; root: string }
export interface CodeReadObservation {
  id: string; kind: typeof CODE_READ_KIND; source: string; startLine: number; endLine: number;
  text: string; snapshotSha256: string; fragmentSha256: string; observedAt: string; complete: true;
}
const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const refused = () => new ApiError(403, "허용된 비민감 코드의 완결된 줄 조각만 읽을 수 있습니다");
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

export function readCodeSource(scope: CodeReadScope, source: string, start: number, end: number, protectedRoots: readonly string[]): CodeReadObservation {
  if (!(CODE_SOURCES as readonly string[]).includes(source) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end - start >= CODE_LINES) throw refused();
  let fd: number | undefined;
  try {
    const root = resolve(scope.root), path = resolve(root, source), realRoot = realpathSync(root);
    if (redactHarnessText(path) !== path || isSecretPath(path, homedir(), protectedRoots) || isSecretPath(realRoot, homedir(), protectedRoots)) throw refused();
    // server 한 계층만 허용한다. 부모/말단 링크를 막고 열린 descriptor와 전후 경로를 대조한다.
    const chain = [root, join(root, "server")].map(p => ({ p, stat: lstatSync(p) }));
    if (chain.some(c => c.stat.isSymbolicLink() || !c.stat.isDirectory())) throw refused();
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > CODE_FILE_BYTES || realpathSync(path) !== join(realRoot, source)) throw refused();
    if (isSecretPath(realpathSync(path), homedir(), protectedRoots)) throw refused();
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || !same(before, opened) || !same(opened, lstatSync(path)) || chain.some(c => !same(c.stat, lstatSync(c.p)))) throw refused();
    const buf = Buffer.alloc(opened.size + 1); let used = 0, n: number;
    while (used < buf.length && (n = readSync(fd, buf, used, buf.length - used, used)) > 0) used += n;
    if (used !== opened.size || !same(opened, fstatSync(fd)) || !same(opened, lstatSync(path)) || chain.some(c => !same(c.stat, lstatSync(c.p)))) throw refused();
    const bytes = buf.subarray(0, used), all = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (all.includes("\0")) throw refused();
    const offsets = [0]; for (let i = 0; i < all.length; i++) if (all[i] === "\n" && i + 1 < all.length) offsets.push(i + 1);
    if (!all.length || end > offsets.length) throw refused();
    const text = all.slice(offsets[start - 1], offsets[end] ?? all.length);
    if (!text || Buffer.byteLength(text) > CODE_FRAGMENT_BYTES || redactHarnessText(text) !== text) throw refused();
    return { id: `code-read:${randomUUID()}`, kind: CODE_READ_KIND, source: path, startLine: start, endLine: end,
      text, snapshotSha256: sha(bytes), fragmentSha256: sha(text), observedAt: new Date().toISOString(), complete: true };
  } catch { throw refused(); }
  finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* 오류에도 원시 경로/내용을 내보내지 않는다. */ } } }
}

/** 서버 전용 namespace의 관찰만 대상으로 하며 이전/손상/미완료 관찰은 채택하지 않는다. */
export function validCodeRead(value: unknown, scope: CodeReadScope): value is CodeReadObservation {
  if (!value || typeof value !== "object") return false;
  const v = value as CodeReadObservation;
  return v.kind === CODE_READ_KIND && /^code-read:[\da-f-]{36}$/.test(v.id) && v.complete === true &&
    CODE_SOURCES.some(s => resolve(scope.root, s) === v.source) && typeof v.text === "string" && !!v.text &&
    Number.isSafeInteger(v.startLine) && Number.isSafeInteger(v.endLine) && v.startLine > 0 && v.endLine >= v.startLine && v.endLine - v.startLine < CODE_LINES &&
    Buffer.byteLength(v.text) <= CODE_FRAGMENT_BYTES && redactHarnessText(v.text) === v.text &&
    v.text.split("\n").length - (v.text.endsWith("\n") ? 1 : 0) === v.endLine - v.startLine + 1 &&
    /^[a-f\d]{64}$/.test(v.snapshotSha256) && v.fragmentSha256 === sha(v.text) &&
    Number.isFinite(Date.parse(v.observedAt)) && Date.parse(v.observedAt) >= Date.parse(scope.contractAt) && Date.parse(v.observedAt) <= Date.now();
}
