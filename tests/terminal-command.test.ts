import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnectionInfo, Member } from "../shared/types";
import { terminalCommand, isLocalTerminalHost } from "../web/src/lib/terminal-command";

const roots: string[] = [];
afterEach(() => { roots.splice(0); /* Preserve these isolated test directories for review. */ });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "iamceo-command-"))); roots.push(root);
  const bin = join(root, "bin"), home = join(root, "server's data"), cwd = join(root, "project's files");
  for (const dir of [bin, home, cwd]) mkdirSync(dir);
  const output = join(root, "observe.ts");
  writeFileSync(output, 'console.log(JSON.stringify({home:process.env.IAMCEO_HOME,port:process.env.IAMCEO_PORT,args:Bun.argv.slice(2),cwd:process.cwd()}));');
  for (const name of ["iamceo", "claude", "codex", "agy"]) writeFileSync(join(bin, name), `#!/bin/sh\nexec '${process.execPath}' '${output}' "$@"\n`, { mode: 0o700 });
  writeFileSync(join(bin, "ssh"), '#!/bin/sh\nprintf "%s\\0" "$@" > "$SSH_ARGS_FILE"\nfor arg; do remote="$arg"; done\nexec /bin/sh -c "$remote"\n', { mode: 0o700 });
  const info: ConnectionInfo = { home, port: 47878, cli: join(bin, "iamceo"), ssh: { host: "mini.tail1234.ts.net", user: "operator", port: 2222 } };
  const member = { id: "m_member", backend: "core", paneId: "terminal-1", cli: "codex", sessionId: "session-1", cwd } as Member;
  async function run(command: string) {
    const p = Bun.spawn(["/bin/sh", "-c", command], { env: { PATH: bin + ":/usr/bin:/bin", IAMCEO_HOME: "/old/local/server", IAMCEO_PORT: "7878", SSH_ARGS_FILE: join(root, "ssh-args") }, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    expect({ code, err }).toEqual({ code: 0, err: "" });
    return JSON.parse(out);
  }
  return { root, info, member, run };
}

test("local attach pins the server home instead of the caller's old local installation", async () => {
  const f = fixture();
  expect(await f.run(terminalCommand(f.member, f.info, true))).toMatchObject({ home: f.info.home, port: "47878", args: ["attach", "m_member"] });
});

test("remote attach selects the current SSH target and preserves the quoted remote command", async () => {
  const f = fixture();
  const command = terminalCommand(f.member, f.info, false);
  expect(await f.run(command)).toMatchObject({ home: f.info.home, port: "47878", args: ["attach", "m_member"] });
  const args = readFileSync(join(f.root, "ssh-args"), "utf8").split("\0").filter(Boolean);
  expect(args.slice(0, 5)).toEqual(["-t", "-p", "2222", "--", "operator@mini.tail1234.ts.net"]);
  expect(args).toHaveLength(6);
  const next = terminalCommand(f.member, { ...f.info, ssh: { ...f.info.ssh, host: "renamed.tail1234.ts.net", port: 22 } }, false);
  await f.run(next);
  expect(readFileSync(join(f.root, "ssh-args"), "utf8")).toContain("operator@renamed.tail1234.ts.net\0");
});

test.each(["claude", "codex", "antigravity"] as const)("%s resume uses the server project and data home over SSH", async cli => {
  const f = fixture();
  const m = { ...f.member, cli, backend: null, paneId: null, sessionId: "session'; echo wrong" } as Member;
  const result = await f.run(terminalCommand(m, f.info, false));
  expect(result.home).toBe(f.info.home); expect(result.cwd).toBe(f.member.cwd);
  expect(result.args).toEqual(cli === "codex" ? ["resume", m.sessionId] : cli === "claude" ? ["--resume", m.sessionId] : [`--gemini_dir=${f.info.home}/antigravity/m_member`, "--conversation", m.sessionId]);
});

test.each(["localhost", "127.0.0.1", "127.0.0.2", "::1", "[::1]"])("%s identifies a local browser", host => {
  expect(isLocalTerminalHost(host)).toBe(true);
});

test("Tailnet and LAN browsers require SSH; no session fails instead of opening another local CLI", () => {
  for (const host of ["mini.tail1234.ts.net", "100.79.130.55", "192.168.1.5"]) expect(isLocalTerminalHost(host)).toBe(false);
  const f = fixture();
  expect(() => terminalCommand({ ...f.member, paneId: null, sessionId: null }, f.info, false)).toThrow();
});
