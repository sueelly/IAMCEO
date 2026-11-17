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

  test("모든 역할이 독립적으로 이해되는 구체적인 문장을 작성하게 한다", () => {
    for (const kind of KINDS) {
      const text = renderRole(kind, vars);
      for (const phrase of ["대상 명사", "그것", "누가 무엇을", "직접 확인", "요청의 출처", "판단이 필요한 이유", "다음 행동", "맥락이 이미 전달됐다고 가정하지 않는다"]) {
        expect(text).toContain(phrase);
      }
    }
  });

  test("화면·사용자 흐름·아키텍처의 검토 가능한 산출물을 모든 역할에 전달한다", () => {
    const dir = mkdtempSync(join(tmpdir(), "iamceo-artifact-guide-"));
    for (const kind of KINDS) {
      writeFileSync(join(dir, `${kind}.md`), "맞춤 승인 규칙");
      for (const rolesDir of [undefined, dir]) {
        const guide = renderRole(kind, vars, rolesDir);
        for (const requirement of [/UI.*실제 목업/, /유저 플로우.*플로우차트/, /아키텍처.*다이어그램/, /핵심 조작을 직접/, /자료를 직접 열어/, /`post\.file_ids`/, /`ask\.file_id`/]) {
          expect(guide.match(requirement)).not.toBeNull();
        }
      }
    }
    expect(renderRole("conductor", vars)).toContain("목업·플로우차트·아키텍처 다이어그램의 제작과 등록을 담당 직원에게 맡긴다");
    expect(renderRole("worker", vars)).toContain("결재에서 조작해 볼 목업은 `ask.file_id`로 연결한다");
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
