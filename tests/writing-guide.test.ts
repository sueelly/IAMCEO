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

  test("지침은 B 화면 약속(대표 차례 띠, 권장 줄)과 맞고, 자료 뼈대에서 권장이 지금 단계보다 위다", () => {
    expect(WRITING_GUIDE).toContain("서버가 본문 맨 위에 \"● 대표 차례\" 줄을 만든다");
    expect(WRITING_GUIDE).toContain("서버가 `detail` 맨 위에 \"★ 권장: 안 — 이유\" 줄을 만든다");
    const order = /첫 화면 차례: (.*)\./.exec(WRITING_GUIDE)![1]!.split(", ");
    expect(order.indexOf("권장과 이유")).toBeLessThan(order.indexOf("지금 단계"));
    expect(order.slice(0, 3)).toEqual(["결론 제목", "대표 차례", "권장과 이유"]);
    expect(WRITING_GUIDE).toContain("'자료에 둔 것'에는 그 자료에 실제로 넣은 것만 적는다");
    for (const cls of ["page", "owner", "toc", "find", "hero", "delta", "bars", "cols", "ba", "rec", "gantt", "status", "dg"]) expect(WRITING_GUIDE).toContain(`\`${cls}\``);
  });

  test("역할 글이 지침과 부딪히지 않는다: 탭 권장, 보고 본문의 파일 목록, 작은 표도 html", () => {
    for (const kind of KINDS) {
      const text = renderRole(kind, vars);
      expect(text).not.toContain("tabs, tag, compare");
      expect(text).not.toContain("바뀐 파일·커밋, 대표가");
      expect(text).not.toContain("csv 나 마크다운 표가 아니라");
      expect(text).toContain("3열·5행 안의 표는 `post`에 마크다운 표로 쓴다");
      expect(text).toContain("`tabs`");
      expect(text).not.toContain("\"확인했습니다\" 한 줄로 끝낸다");
    }
    expect(renderRole("worker", vars)).toContain("바뀐 파일 목록·해시·경로는 본문에 쓰지 않는다");
  });

  test("대표용 자료는 기본 한 개다: 같은 본문의 html·md 짝을 요구하지 않고, 서로 다른 자료는 막지 않는다", () => {
    for (const kind of KINDS) {
      const text = renderRole(kind, vars);
      for (const old of ["`md` 짝", "md 짝", "(글로 읽기)", "짝을 함께 올린다"]) expect(text).not.toContain(old);
      expect(text).toContain("대표용 자료는 기본 한 개다. 같은 본문을 `html`과 `md`로 두 번 올리지 않는다.");
      expect(text).toContain("그림·차트·조작 요소가 있어도 글 판을 따로 만들지 않는다.");
      expect(text).toContain("내용이 서로 다른 것(원기록·이미지·따로 쓰는 납품물)은 각각 올려도 된다.");
    }
    const checklist = WRITING_GUIDE.split("### 끝 확인 12줄")[1]!.split("\n").filter((line) => line.startsWith("- "));
    expect(checklist).toHaveLength(12);
    expect(checklist).toContain("- 같은 본문을 자료 두 개로 나눠 올리지 않았는가");
  });

  test("고쳐 쓴 템플릿은 그대로 쓰고, 꺼낸 예시에는 지침이 들어 있다", () => {
    const dir = mkdtempSync(join(tmpdir(), "iamceo-guide-"));
    const paths = exportRoles(dir);
    for (const path of paths) expect(count(readFileSync(path, "utf8"), HEAD)).toBe(1);
    writeFileSync(join(dir, "worker.md"), "승인 규칙만 있는 템플릿");
    expect(renderRole("worker", vars, dir)).toBe("승인 규칙만 있는 템플릿");
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
