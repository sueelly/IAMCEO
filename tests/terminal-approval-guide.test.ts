// 터미널 승인 안내(대표 2026-11-17 "전체에 적용해. 프롬프트에 적용해서 앞으로도 그렇게 하도록"):
// 모든 직원 종류·세 CLI·새 세션/이어 열기·고쳐 쓴 템플릿에 같은 안내가 한 번 들어간다. 실제 CLI 는 부르지 않는다.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportRoles, renderRole, TERMINAL_APPROVAL_GUIDE, WRITING_GUIDE } from "../server/roles.ts";
import { providerLaunch } from "../server/runner/providers.ts";
import type { RunnerMember, StartOpts } from "../server/runner/types.ts";
import type { CliProvider, MemberKind } from "../shared/types.ts";

const vars = { PROJECT: "P", NAME: "N", ROLE: "R", CONDUCTOR: "C" };
const KINDS: MemberKind[] = ["worker", "conductor", "root"];
const HEAD = "## 터미널 승인 창";
const count = (text: string, part: string) => text.split(part).length - 1;
/** 대표 원문의 세 가지와 승인 경계. 낱말이 아니라 문장 조각으로 본다. */
const MUST = [
  "돌리기 전에", // 승인이 예상되는 명령은 실행 전에 안내
  "창에 뜰 글", "무엇을 고르면 되는지", "고르면 생기는 일", // 실제 내용·선택할 항목·선택 결과
  "결재함의 '승인 대기'", // 막힌 동안 대표가 보는 곳
  "실제로 돌린 일과 결과", // 실행과 결과 보고
  "이 안내는 승인이 아니다",
];

describe("터미널 승인 안내: 공통 프롬프트", () => {
  test("세 직원 종류의 기본 역할 글에 한 번씩, 글 지침보다 앞에 들어간다", () => {
    expect(TERMINAL_APPROVAL_GUIDE.startsWith(HEAD)).toBe(true);
    for (const kind of KINDS) {
      const text = renderRole(kind, vars);
      expect(count(text, HEAD)).toBe(1);
      for (const part of MUST) expect(text).toContain(part);
      expect(text.indexOf(HEAD)).toBeLessThan(text.indexOf("## 대표에게 보이는 글"));
      expect(text).not.toContain("{{");
    }
  });

  test("총괄은 직원 창을 읽어 알리고, 대표의 선택 없이 답하지 않는다", () => {
    const conductor = renderRole("conductor", vars);
    expect(conductor).toContain("직원이 승인 창 앞에서 멈췄으면");
    expect(conductor).toContain("대표의 선택이 없으면 창에 답하지 않는다");
    expect(renderRole("worker", vars)).not.toContain("직원이 승인 창 앞에서 멈췄으면");
  });

  test("고쳐 쓴 템플릿에도 승인 안내와 공통 글 지침이 각각 한 번 붙는다", () => {
    const dir = mkdtempSync(join(tmpdir(), "iamceo-approval-guide-"));
    writeFileSync(join(dir, "worker.md"), "승인 규칙만 있는 템플릿");
    const custom = renderRole("worker", vars, dir);
    expect(custom.startsWith("승인 규칙만 있는 템플릿")).toBe(true);
    expect(count(custom, HEAD)).toBe(1);
    expect(count(custom, WRITING_GUIDE.trim())).toBe(1);
    // 자리표시를 둔 템플릿은 그 자리에만 들어간다.
    writeFileSync(join(dir, "conductor.md"), "앞\n{{TERMINAL_APPROVAL}}\n뒤");
    const placed = renderRole("conductor", vars, dir);
    expect(count(placed, HEAD)).toBe(1);
    expect(placed.indexOf(HEAD)).toBeLessThan(placed.indexOf("뒤"));
    // 꺼낸 예시에도 안내가 있다.
    for (const path of exportRoles(join(dir, "export"))) expect(readFileSync(path, "utf8")).toContain("{{TERMINAL_APPROVAL}}");
  });

  test("지원하는 제공자·역할은 새 세션과 이어 열기에 안내를 받고 미지원 총괄은 실행하지 않는다", () => {
    const root = mkdtempSync(join(tmpdir(), "iamceo-approval-cli-"));
    const codexBin = join(root, "codex-inventory");
    writeFileSync(codexBin, '#!/bin/sh\nprintf "[]\\n"\n', { mode: 0o700 });
    const bins = { claudeBin: "/fake/claude", codexBin, antigravityBin: "/fake/agy", antigravityRoot: join(root, "agy"), antigravityUserRoot: join(root, "nouser") };
    writeFileSync(join(root, "mcp.json"), JSON.stringify({ mcpServers: { iamceo: { command: "/bin/echo", args: ["bridge"], env: { IAMCEO_TOKEN: "t" } } } }));
    const sessions: Record<CliProvider, string> = { claude: "6f1c2b9e-1111-4222-8333-944455556666", codex: "019a0000-aaaa-7bbb-8ccc-dddddddddddd", antigravity: "6f1c2b9e-1111-4222-8333-944455556667" };
    for (const kind of KINDS) {
      const rules = renderRole(kind, vars);
      for (const resume of [false, true]) {
        const opts: StartOpts = { systemPromptFile: join(root, `${kind}-${resume}.rules.md`), mcpConfigFile: join(root, "mcp.json"), resume, projectName: "P" };
        writeFileSync(opts.systemPromptFile, rules);
        const member = (cli: CliProvider): RunnerMember => ({ id: `m-${kind}-${cli}`, sessionGeneration: 1, projectId: "p", cli, handle: cli, name: cli, cwd: root,
          sessionId: resume ? sessions[cli] : null, paneId: null, model: null, effort: null, subagentModel: null, permissionMode: "default", kind, parallel: false }) as unknown as RunnerMember;

        const claude = providerLaunch(member("claude"), opts, bins).argv;
        expect(claude.includes("--resume")).toBe(resume);
        expect(readFileSync(claude[claude.indexOf("--append-system-prompt-file") + 1]!, "utf8")).toContain(HEAD);

        const codex = providerLaunch(member("codex"), opts, bins).argv;
        expect(codex.includes("resume")).toBe(resume);
        const dev = codex.find((a) => a.startsWith("developer_instructions="))!;
        expect(JSON.parse(dev.slice("developer_instructions=".length))).toContain(HEAD);

        if (kind === "conductor") {
          expect(() => providerLaunch(member("antigravity"), opts, bins)).toThrow("총괄");
          continue;
        }
        const agy = providerLaunch(member("antigravity"), opts, bins).argv;
        expect(agy.includes("--conversation")).toBe(resume);
        const gemini = readFileSync(join(root, "agy", `m-${kind}-antigravity`, "GEMINI.md"), "utf8");
        expect(count(gemini, HEAD)).toBe(1);
        expect(gemini).toContain(WRITING_GUIDE.trim().split("\n")[0]!);
      }
    }
  });
});
