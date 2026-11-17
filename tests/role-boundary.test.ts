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
import { exportRoles, renderRole, ROLE_BOUNDARY, WRITING_GUIDE } from "../server/roles.ts";
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

// 독립 검토(2026-11-17) 세 지점: ① 통합 조건의 순환 ② 이미 받은 승인과 새 판단 ③ 고친 템플릿의 경계 1회.
describe("역할 경계 보완: 단계별 판정·승인 범위·경계 한 번", () => {
  test("① 통합 전 기준과 통합 뒤 기준을 가른다. 계약은 낮추지 않고, 미룰 수 있는 것은 메인·운영에 들어가야만 볼 수 있는 기준뿐이다", () => {
    const conductor = renderRole("conductor", vars);
    // 통합 뒤에만 확인할 기준까지 합치기 전에 통과하라던 순환 문구가 없다.
    expect(conductor).not.toContain("그 판의 합격 기준을 모두 통과한 직원 완료 보고가 있다");
    for (const stage of ["직원 납품(통합 전)", "독립 검토(통합 전)", "통합판 검사", "실제 적용·최종 완료"]) expect(conductor).toContain(stage);
    expect(conductor).toContain("계약 기준은 낮추지 않는다");
    expect(conductor).toContain("통합 전에 판정할 수 있는 기준은 모두 통과했다");
    expect(conductor).toContain("미구현·검증 실패·중요한 미확인·남은 보류·남은 결재를 뒤 단계로 미뤄 통과로 셈하지 않는다");
    expect(conductor).toContain("메인이나 운영에 들어가야만 확인할 대상이 생기는 기준");
    // 그런 기준 때문에 직원 납품이 막힘이어도 통합 전 근거를 읽고 합칠 수 있다. 서버 판정은 건드리지 않는다.
    expect(conductor).toContain("납품 보고가 `막힘`이어도");
    expect(conductor).toContain("서버의 완료 판정을 앞당기려고");
    // 정상 예(통합 뒤 확인 기준만 남음)와 거절 예(구현·시험 실패가 남음)를 둘 다 적는다.
    expect(conductor).toMatch(/예: [^\n]*합친 판[^\n]*남기고 합친 뒤/);
    expect(conductor).toMatch(/구현이 덜 됐거나 시험이 실패한 채 남은 일[^\n]*합치지 않는다/);
    // 업무 done 은 통합 뒤 기준까지 확인한 뒤다.
    expect(conductor).toContain("통합 뒤 기준이 있는 계약은 그 확인까지 끝나야");
    const worker = renderRole("worker", vars);
    expect(worker).toContain("메인이나 운영에 들어가야만 확인할 수 있는 기준");
    expect(worker).toContain("통합 전 기준을 모두 통과시킨 뒤 `막힘`으로 납품한다");
    expect(worker).toContain("그 기준을 통과로 적지 않는다");
  });

  test("② 이미 받은 승인 범위의 같은 통합은 다시 허락받지 않는다. 창은 끄지 않고, 범위를 대조해 한 번만 잇는다. 새 판단은 기다린다", () => {
    const conductor = renderRole("conductor", vars);
    // 같은 통합마다 대표에게 창을 넘기라던 문구가 없다.
    expect(conductor).not.toContain("창의 글과 고를 것을 `post`(알림)로 대표에게 알린다");
    expect(conductor).toContain("다시 허락을 구하지 않는다");
    // 하네스의 ask 는 실행 보호다. 새 업무 승인이 필요하다는 뜻이 아니다. 보호는 끄지 않는다.
    expect(conductor).toContain("새 업무 승인이 필요하다는 뜻이 아니다");
    expect(conductor).toContain("끄거나 우회하지 않는다");
    // 실행 확인: 저장소·브랜치·검증한 판·행동을 실제 창과 근거로 대조하고, 지원되는 조작 경로로 한 번만.
    for (const part of ["저장소·원격·브랜치", "검증한 판", "행동", "`terminal_read`", "`terminal_input`", "한 번만", "이미 받은 승인을 잇는 실행 확인이다"]) expect(conductor).toContain(part);
    // 자기 세션의 창은 스스로 답할 수 없다: 무엇이 막는지 남기고, 완료로 적지 않는다.
    expect(conductor).toContain("네 세션의 창은 네가 답할 수 없다");
    expect(conductor).toMatch(/어느 창이[^\n]*근거[^\n]*완료로 적지 않는다/);
    // 새 판단으로 남는 것.
    for (const part of ["강제 전송", "삭제", "비용", "새 권한 선택", "범위를 넓히는", "확실하지 않은", "근거가 모자란"]) expect(conductor).toContain(part);
    // '대신 답하지 않기' 규칙과 부딪히지 않게 관계를 밝힌다.
    expect(conductor).toContain("대신 답하기가 아니다");
  });

  test("③ 자리표시가 둘이어도, 완성된 역할 글을 다시 써도 현재 역할 경계는 한 번이다. 앞뒤 글과 값은 그대로다", () => {
    const dir = mkdtempSync(join(tmpdir(), "iamceo-role-boundary-once-"));
    // 자리표시 둘: 첫 자리에 넣고 남는 자리는 지운다.
    writeFileSync(join(dir, "conductor.md"), "앞 승인\n{{ROLE_BOUNDARY}}\n가운데\n{{ROLE_BOUNDARY}}\n뒤");
    const twice = renderRole("conductor", vars, dir);
    expect(count(twice, HEAD.conductor)).toBe(1);
    expect(twice).not.toContain("{{ROLE_BOUNDARY}}");
    expect(twice.indexOf(HEAD.conductor)).toBeLessThan(twice.indexOf("가운데"));
    for (const part of ["앞 승인", "가운데", "뒤"]) expect(twice).toContain(part);
    // 완성된 역할 글을 고친 템플릿으로 다시 쓰면 그대로 나온다(세 종류).
    for (const kind of KINDS) {
      const normal = renderRole(kind, vars);
      const again = mkdtempSync(join(tmpdir(), "iamceo-role-boundary-again-"));
      writeFileSync(join(again, `${kind}.md`), normal);
      const second = renderRole(kind, vars, again);
      expect(count(second, HEAD[kind])).toBe(1);
      expect(second).toBe(normal);
      // effort·기억 줄이 든 완성된 글을 다시 써도 그 줄은 한 번이다.
      const full = { ...vars, SUBAGENT_EFFORT: "서브에이전트 effort=high", MEMORY: "## 개발 기억\n기억 단락 한 줄" };
      const fullNormal = renderRole(kind, full);
      const fullAgain = mkdtempSync(join(tmpdir(), "iamceo-role-boundary-full-"));
      writeFileSync(join(fullAgain, `${kind}.md`), fullNormal);
      const fullSecond = renderRole(kind, full, fullAgain);
      expect(count(fullSecond, "서브에이전트 effort=high")).toBe(1);
      expect(count(fullSecond, "기억 단락 한 줄")).toBe(1);
      expect(fullSecond).toBe(fullNormal);
    }
    // 같은 경계 글이 두 번 든 템플릿: 뒤 사본만 빠지고 사이 글은 남는다.
    const body = ROLE_BOUNDARY.worker.trim();
    writeFileSync(join(dir, "worker.md"), `앞 승인\n\n${body}\n\n사이 글\n\n${body}\n\n끝 글\n`);
    const dup = renderRole("worker", vars, dir);
    expect(count(dup, HEAD.worker)).toBe(1);
    for (const part of ["앞 승인", "사이 글", "끝 글"]) expect(dup).toContain(part);
    // 값 안의 자리표시는 다시 치환하지 않는다. effort 는 한 번, 승인 규칙 없는 원문은 여전히 경고한다.
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const v = mkdtempSync(join(tmpdir(), "iamceo-role-boundary-values-"));
      writeFileSync(join(v, "root.md"), "맞춤 {{NAME}} {{SUBAGENT_EFFORT}}\n{{ROLE_BOUNDARY}}\n{{ROLE_BOUNDARY}}");
      const text = renderRole("root", { ...vars, NAME: "이름{{ROLE_BOUNDARY}}{{NAME}}", SUBAGENT_EFFORT: "effort=high" }, v);
      expect(text).toContain("이름{{ROLE_BOUNDARY}}{{NAME}}");
      expect(count(text, HEAD.root)).toBe(1);
      expect(count(text, "effort=high")).toBe(1);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally { warn.mockRestore(); }
  });
});
