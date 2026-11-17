import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportRoles, renderRole, WRITING_GUIDE } from "../server/roles.ts";
import { providerLaunch } from "../server/runner/providers.ts";
import type { RunnerMember, StartOpts } from "../server/runner/types.ts";
import type { CliProvider, MemberKind } from "../shared/types.ts";

const vars = { PROJECT: "P", NAME: "N", ROLE: "R", CONDUCTOR: "C" };
const KINDS: MemberKind[] = ["worker", "conductor", "root"];
const HEAD = "## 대표에게 보이는 글";
const count = (text: string, part: string) => text.split(part).length - 1;

describe("글 지침", () => {
  test("모든 직원 종류의 기본 역할 글 끝에 한 번 붙는다", () => {
    expect(WRITING_GUIDE.startsWith(HEAD)).toBe(true);
    for (const kind of KINDS) {
      const text = renderRole(kind, vars);
      expect(count(text, HEAD)).toBe(1);
      expect(text.trimEnd().endsWith(WRITING_GUIDE.trimEnd())).toBe(true);
      expect(text).toContain("owner_action");
      expect(text).toContain("rec_reason");
      expect(text).not.toContain("{{");
    }
  });

  test("사용자 정의 역할도 최신 공통 작성 지침을 받고 작성자의 역할 내용은 보존된다", () => {
    const dir = mkdtempSync(join(tmpdir(), "iamceo-custom-guide-"));
    for (const kind of KINDS) {
      writeFileSync(join(dir, `${kind}.md`), "승인 규칙과 {{PROJECT}}의 고유 역할을 보존한다.");
      const custom = renderRole(kind, vars, dir);
      expect(custom).toContain("승인 규칙과 P의 고유 역할을 보존한다.");
      expect(count(custom, WRITING_GUIDE.trim())).toBe(1);
    }
  });

  test("내보낸 역할을 다시 사용해도 최신 지침이 중복되지 않는다", () => {
    const dir = mkdtempSync(join(tmpdir(), "iamceo-export-guide-"));
    for (const path of exportRoles(dir)) {
      const kind = path.split("/").at(-1)!.replace(".example.md", "") as MemberKind;
      writeFileSync(join(dir, `${kind}.md`), readFileSync(path, "utf8"));
      expect(count(renderRole(kind, vars, dir), WRITING_GUIDE.trim())).toBe(1);
    }
  });

  test("이전 글 지침이 들어 있는 사용자 역할에도 최신 기준이 추가된다", () => {
    const dir = mkdtempSync(join(tmpdir(), "iamceo-old-guide-"));
    writeFileSync(join(dir, "worker.md"), "승인 규칙\n" + HEAD + "\n설명은 60자까지 쓴다.");
    const result = renderRole("worker", vars, dir);
    expect(result).toContain("승인 규칙");
    expect(result.trimEnd().endsWith(WRITING_GUIDE.trim())).toBe(true);
    expect(count(result, WRITING_GUIDE.trim())).toBe(1);
  });

  test("Claude·Codex·Antigravity 세 CLI 모두 지침이 든 역할 글을 받는다", () => {
    const root = mkdtempSync(join(tmpdir(), "iamceo-guide-cli-"));
    const rules = renderRole("worker", vars);
    const opts: StartOpts = { systemPromptFile: join(root, "rules.md"), mcpConfigFile: join(root, "mcp.json"), resume: false, projectName: "P" };
    writeFileSync(opts.systemPromptFile, rules);
    writeFileSync(opts.mcpConfigFile, JSON.stringify({ mcpServers: { iamceo: { command: "/bin/echo", args: ["bridge"], env: { IAMCEO_TOKEN: "t" } } } }));
    const bins = { claudeBin: "/fake/claude", codexBin: "/fake/codex", antigravityBin: "/fake/agy", antigravityRoot: join(root, "agy"), antigravityUserRoot: join(root, "nouser") };
    const member = (cli: CliProvider): RunnerMember => ({ id: `m-${cli}`, sessionGeneration: 1, projectId: "p", cli, handle: cli, name: cli, cwd: root, sessionId: null, paneId: null,
      model: null, effort: null, subagentModel: null, permissionMode: "default", kind: "worker", parallel: false }) as unknown as RunnerMember;

    const claude = providerLaunch(member("claude"), opts, bins).argv;
    expect(readFileSync(claude[claude.indexOf("--append-system-prompt-file") + 1]!, "utf8")).toContain(HEAD);

    const codex = providerLaunch(member("codex"), opts, bins).argv;
    const dev = codex.find((a) => a.startsWith("developer_instructions="))!;
    expect(JSON.parse(dev.slice("developer_instructions=".length))).toBe(rules);

    providerLaunch(member("antigravity"), opts, bins);
    expect(readFileSync(join(root, "agy", "m-antigravity", "GEMINI.md"), "utf8")).toContain(WRITING_GUIDE.trim());
  });
});
