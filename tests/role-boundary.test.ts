// 총괄 역할 분리·검증 뒤 메인 합치기(대표 2026-11-17 "앞으로는 모든 게 끝나고 총괄이 메인에 머지하는 것까지 하도록 해.
// 총괄은 앞으로 구현은 맡지말고 시키고 합치고 판단하고 설계하는 일 까지만 맡도록 해"):
// 세 직원 종류·고쳐 쓴 템플릿·세 CLI 의 새 세션/이어 열기·오케스트레이터가 쓰는 규칙 파일에 같은 경계가 한 번 들어간다.
// 실제 CLI·모델은 부르지 않는다(인자·파일 생성까지). 하네스의 깃허브 올리기 승인 창은 그대로인지도 본다.
import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../server/bus.ts";
import { loadConfig, updateConfigFile } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { guardDecision } from "../server/harness-guard.ts";
import { guardHooks, Orchestrator } from "../server/orchestrator.ts";
import { exportRoles, renderRole, WRITING_GUIDE } from "../server/roles.ts";
import { providerLaunch } from "../server/runner/providers.ts";
import type { RunnerMember, StartOpts } from "../server/runner/types.ts";
import { Store } from "../server/store.ts";
import type { CliProvider, Member, MemberKind, Project } from "../shared/types.ts";

const vars = { PROJECT: "P", NAME: "N", ROLE: "R", CONDUCTOR: "C" };
const KINDS: MemberKind[] = ["worker", "conductor", "root"];
const HEAD: Record<MemberKind, string> = {
  conductor: "## 역할 경계: 설계하고 맡기고 판단하고 합친다",
  worker: "## 납품: 작업 브랜치까지가 직원 몫이다",
  root: "## 프로젝트 일의 경계",
};
const count = (text: string, part: string) => text.split(part).length - 1;

/** 대표 원문과 계약 기준을 문장 조각으로 본다. */
const CONDUCTOR_MUST = [
  "구현은 직원에게 맡긴다", "제품 코드를 직접 고치지 않는다", // R1·R4
  "설계", "맡김", "판단", "메인 합치기", // R1
  "직원 납품은 업무 전체의 완료가 아니다", // R2
  "최신 원격 메인", "별도 통합 워크트리", "일반 전송", "원격 메인 SHA", // R3
  "메인이 앞서면", "완료로 적지 않는다", "결재 카드로 다시 묻지 않는다", // A3
  "그 직원에게", "미완료", "멈추거나 보류한", "남은 결재", "무관한 변경", "실행 자료", // A4
  "강제 전송은 하지 않는다", "대표 화면 반영", // R6
  "이 단락이 앞선다", // 옛 템플릿 문구와 부딪힐 때
];
const WORKER_MUST = [
  "작업 브랜치에 커밋", "원격 SHA", "review_needed", // R2
  "업무 전체의 완료가 아니다", "'아직'", // A2
  "메인에 합치거나 메인으로 올리지 않는다", "강제 전송하지 않는다", // R4·R6
  "최신 원격 메인을 작업 브랜치에 받아", // A4
];
/** 변경 전 총괄 글에서 새 지시와 부딪히던 문구. */
const OLD_CONFLICTS = ["네가 직접 하는 일은 상태 확인, 판 관리, 짧은 사실 답변뿐이다", "코드를 고치거나 조사를 직접 하지 않는다", "완료 보고를 받으면 같은 id로 완료(`done`)로 옮긴다."];

describe("역할 경계: 공통 역할 글", () => {
  test("세 직원 종류의 기본 역할 글에 자기 경계가 한 번씩, 글 지침보다 앞에 들어간다", () => {
    for (const kind of KINDS) {
      const text = renderRole(kind, vars);
      expect(count(text, HEAD[kind])).toBe(1);
      for (const other of KINDS.filter((k) => k !== kind)) expect(text).not.toContain(HEAD[other]);
      expect(text.indexOf(HEAD[kind])).toBeLessThan(text.indexOf("## 대표에게 보이는 글"));
      expect(text).not.toContain("{{");
    }
  });

  test("총괄: 구현은 맡기고 설계·맡김·판단·메인 합치기를 한다. 옛 충돌 문구가 남지 않는다", () => {
    const conductor = renderRole("conductor", vars);
    for (const part of CONDUCTOR_MUST) expect(conductor).toContain(part);
    for (const old of OLD_CONFLICTS) expect(conductor).not.toContain(old);
    // 진행판 done 은 코드 변경이면 합치기·원격 확인 뒤다.
    expect(conductor).toContain("코드 변경이 있는 일은 메인 합치기와 원격 확인까지 끝나야");
    // 대표 화면 반영·삭제·비용은 이 규칙에 들어 있지 않다.
    expect(conductor).toMatch(/대표 화면 반영[^\n]*이 규칙에 들어 있지 않/);
    // 보류된 일(예: 대표가 멈춘 변경)은 이 규칙만으로 합치지 않는다.
    expect(conductor).toContain("이 규칙만으로 보류를 풀지 않는다");
  });

  test("직원: 작업 브랜치 납품까지가 직원 몫이고, 메인 합치기·대표 화면 반영은 따로다", () => {
    const worker = renderRole("worker", vars);
    for (const part of WORKER_MUST) expect(worker).toContain(part);
    // 커밋·깃허브 올리기의 승인 규칙은 그대로다.
    expect(worker).toContain("커밋·푸시");
    expect(worker).toContain("위 '승인' 규칙을 따른다");
  });

  test("본사 AI: 프로젝트 코드의 구현·합치기를 떠안지 않는다", () => {
    const root = renderRole("root", vars);
    expect(root).toContain("프로젝트의 구현은 그 프로젝트 직원이");
    expect(root).toContain("메인 합치기는 그 프로젝트 총괄이");
  });

  test("고쳐 쓴 템플릿에도 끝에 한 번 붙고, 자리표시가 있으면 그 자리다. 꺼낸 예시에도 자리가 있다", () => {
    const dir = mkdtempSync(join(tmpdir(), "iamceo-role-boundary-"));
    // 변경 전 총괄 첫 줄을 그대로 둔 옛 템플릿: 경계가 붙고, 경계가 앞선다고 밝힌다.
    writeFileSync(join(dir, "conductor.md"), "너는 총괄이다. 네가 직접 하는 일은 상태 확인, 판 관리, 짧은 사실 답변뿐이다. 승인 규칙.");
    const old = renderRole("conductor", vars, dir);
    expect(count(old, HEAD.conductor)).toBe(1);
    expect(old.indexOf(HEAD.conductor)).toBeGreaterThan(old.indexOf("상태 확인"));
    expect(old).toContain("이 단락이 앞선다");
    expect(old).not.toContain("## 대표에게 보이는 글");
    writeFileSync(join(dir, "worker.md"), "앞 승인\n{{ROLE_BOUNDARY}}\n뒤");
    const placed = renderRole("worker", vars, dir);
    expect(count(placed, HEAD.worker)).toBe(1);
    expect(placed.indexOf(HEAD.worker)).toBeLessThan(placed.indexOf("뒤"));
    writeFileSync(join(dir, "root.md"), "본사 승인");
    expect(count(renderRole("root", vars, dir), HEAD.root)).toBe(1);
    for (const path of exportRoles(join(dir, "export"))) expect(readFileSync(path, "utf8")).toContain("{{ROLE_BOUNDARY}}");
    // 승인 규칙이 없는 고친 템플릿은 경계 글이 붙어도 여전히 경고한다.
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const bare = mkdtempSync(join(tmpdir(), "iamceo-role-boundary-bare-"));
    writeFileSync(join(bare, "worker.md"), "규칙 없는 템플릿");
    try {
      expect(count(renderRole("worker", vars, bare), HEAD.worker)).toBe(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain("승인 규칙이 없습니다");
    } finally { warn.mockRestore(); }
  });

  test("Claude·Codex·Antigravity 모두 새 세션과 이어 열기에서 경계가 든 역할 글을 받는다(인자·파일)", () => {
    const root = mkdtempSync(join(tmpdir(), "iamceo-role-boundary-cli-"));
    const bins = { claudeBin: "/fake/claude", codexBin: "/fake/codex", antigravityBin: "/fake/agy", antigravityRoot: join(root, "agy"), antigravityUserRoot: join(root, "nouser") };
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
        expect(readFileSync(claude[claude.indexOf("--append-system-prompt-file") + 1]!, "utf8")).toContain(HEAD[kind]);

        const codex = providerLaunch(member("codex"), opts, bins).argv;
        expect(codex.includes("resume")).toBe(resume);
        const dev = codex.find((a) => a.startsWith("developer_instructions="))!;
        expect(JSON.parse(dev.slice("developer_instructions=".length))).toContain(HEAD[kind]);

        const agy = providerLaunch(member("antigravity"), opts, bins).argv;
        expect(agy.includes("--conversation")).toBe(resume);
        const gemini = readFileSync(join(root, "agy", `m-${kind}-antigravity`, "GEMINI.md"), "utf8");
        expect(count(gemini, HEAD[kind])).toBe(1);
        expect(gemini).toContain(WRITING_GUIDE.trim().split("\n")[0]!);
      }
    }
  });
});

describe("역할 경계: 오케스트레이터가 쓰는 규칙 파일과 하네스", () => {
  async function setup() {
    const home = mkdtempSync(join(tmpdir(), "iamceo-role-boundary-orch-"));
    const env = { IAMCEO_HOME: home, IAMCEO_PORT: "0" };
    // 코어 실행 파일은 없는 경로로 둔다. 이 시험은 규칙 파일만 쓰고 세션·코어를 띄우지 않는다.
    updateConfigFile({ accessCode: "code", hosts: ["127.0.0.1"], coreBin: join(home, "missing-core") }, env);
    const config = loadConfig(env);
    const db = openDb(config.dbPath);
    const store = new Store(db, new Bus());
    const orch = new Orchestrator({ config, store, runners: new Map(), timings: { tickMs: 60_000, healthMs: 60_000 } });
    const project = store.createProject({ name: "경계", cwd: home });
    const add = (kind: MemberKind, cli: CliProvider, handle: string) =>
      store.createMember({ projectId: project.id, handle, name: handle, kind, origin: "runner", backend: "core", status: "idle", cwd: home, cli } as never);
    const write = (m: Member) => (orch as unknown as { writeRunFiles(m: Member, p: Project, resume?: boolean): StartOpts }).writeRunFiles(m, project);
    return { config, store, orch, project, add, write, close: async () => { await orch.shutdown(); db.close(); } };
  }

  test("총괄·직원의 규칙 파일(세 CLI)에 경계가 들어가고, 고쳐 쓴 템플릿을 쓴 프로젝트에도 들어간다", async () => {
    const t = await setup();
    const conductor = t.add("conductor", "claude", "lead");
    for (const cli of ["claude", "codex", "antigravity"] as CliProvider[]) {
      const worker = t.add("worker", cli, `w-${cli}`);
      expect(count(readFileSync(t.write(worker).systemPromptFile, "utf8"), HEAD.worker)).toBe(1);
    }
    expect(count(readFileSync(t.write(conductor).systemPromptFile, "utf8"), HEAD.conductor)).toBe(1);
    mkdirSync(t.config.rolesDir, { recursive: true });
    writeFileSync(join(t.config.rolesDir, "conductor.md"), "고친 총괄 템플릿. 승인 규칙. 네가 직접 하는 일은 상태 확인, 판 관리, 짧은 사실 답변뿐이다.");
    const custom = readFileSync(t.write(conductor).systemPromptFile, "utf8");
    expect(custom.startsWith("고친 총괄 템플릿")).toBe(true);
    expect(count(custom, HEAD.conductor)).toBe(1);
    await t.close();
  });

  test("권한은 넓히지 않는다: 총괄 Claude 설정의 하네스 훅이 그대로이고, 깃허브 올리기·강제 전송은 여전히 승인 창으로 간다", async () => {
    const t = await setup();
    const conductor = t.add("conductor", "claude", "lead");
    const settings = JSON.parse(readFileSync(t.write(conductor).settingsFile!, "utf8"));
    expect(settings.hooks).toEqual(guardHooks(t.config.home));
    const ctx = { iamceoHome: t.config.home };
    for (const command of ["git push origin HEAD:main", "git push --force origin main", "git -C /tmp/x push origin integrate:main"]) {
      expect(guardDecision({ tool_name: "Bash", tool_input: { command }, cwd: "/tmp" }, ctx).decision).toBe("ask");
    }
    await t.close();
  });
});
