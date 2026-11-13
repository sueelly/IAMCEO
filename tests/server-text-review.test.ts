// 0.2.6 Y 리뷰 처리: 서버가 만드는 글 가운데 코드 없이 한국어로 남던 자리를 실제 흐름으로 확인한다.
// - 실행 중단의 까닭(잠재우기·닫기·설정 변경·터미널 부재)이 대화의 중단 글에 코드로 실린다(journal 에는 한국어 문장 그대로).
// - 터미널 종료 활동 줄('초기/실행 종료 …', 재시작 안내)이 코드로 남는다.
// - 대표 답으로 결재를 닫은 활동 줄이 코드로 남는다.
// - 도구 승인 카드: 60자가 넘는 '무엇을'은 예전처럼 잘리고, 대상의 붙임말('(5자)' 등)은 영어 카드에 한국어로 섞이지 않는다.
// 운영과 같은 틀(가짜 엔진 소켓 + 실제 CoreRunner + 실제 HTTP 서버)로 돈다. 진짜 CLI 는 띄우지 않는다.
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../server/bus.ts";
import { openDb } from "../server/db.ts";
import type { AgentToolsImpl, PostInput } from "../server/orchestrator.ts";
import { Store } from "../server/store.ts";
import { describeToolRequest, ToolPermissions } from "../server/tool-permission.ts";
import { renderServerText, type ServerTextRef } from "../shared/server-text.ts";
import type { DecisionOption } from "../shared/types.ts";
import { coreSetup, type CoreSetupOptions } from "./fixtures/core-harness.ts";

const HANGUL = /[가-힣ㄱ-ㆎ]/;
const TOOLS: AgentToolsImpl = {
  listAgentTools: () => [],
  async handleAgentTool(orch, member, name, args) {
    if (name === "post") return { text: `보고함 ${(await orch.recordPost(member, args as unknown as PostInput)).id}` };
    if (name === "ask") return { text: (await orch.registerAsk(member, args as { title: string; detail?: string; options?: DecisionOption[] })).text };
    return { text: "모르는 도구", isError: true };
  },
};
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function setup(opts: CoreSetupOptions = {}) {
  const t = await coreSetup({ agentTools: TOOLS, ...opts });
  cleanups.push(() => t.close());
  return t;
}

describe("실행 중단의 까닭과 터미널 종료 줄", () => {
  for (const lang of ["ko", "en"] as const) {
    test(`일하는 중인 팀장을 재우면 중단 글의 까닭이 코드다(보고 언어 ${lang})`, async () => {
      const t = await setup();
      if (lang === "en") t.store.patchSettings({ reportLanguage: "en" });
      const member = (await t.orch.addMember(t.project.id, { name: "dev", handle: "dev", role: "개발" })).member;
      await t.orch.assign(t.project.id, "dev", { text: "큰 일 @fake:hold" });
      await t.waitFor("일하는 중", () => t.core.held(member.id) && t.member(member.id).status === "working");
      await t.orch.sleepMember(member.id, { force: true });
      const notice = await t.waitFor("중단 글", () => t.texts().find((m) => m.textCode === "chat.run_interrupted"));
      const run = notice.textParams?.run as string;
      expect(notice.textParams?.why).toEqual({ code: "why.slept" });
      expect(notice).toMatchObject({ textLang: lang, body: lang === "ko" ? `dev: 실행 ${run} 중단 — 팀원을 잠재워 실행을 종료했습니다`
        : `dev: run ${run} stopped — the staff member was put to sleep, which ended the run` });
      // 다른 언어의 앱은 코드로 그 언어 문장을 그린다(한국어 문장이 섞이지 않는다).
      const other = lang === "ko" ? "en" : "ko";
      expect(renderServerText({ code: notice.textCode!, params: notice.textParams }, other)).toBe(other === "en"
        ? `dev: run ${run} stopped — the staff member was put to sleep, which ended the run` : `dev: 실행 ${run} 중단 — 팀원을 잠재워 실행을 종료했습니다`);
      // 실행 기록의 사유는 예전 한국어 문장 그대로다(판정·진단이 읽는다).
      expect(t.store.getExecutionJournal(run)).toMatchObject({ phase: "interrupted", reason: "팀원을 잠재워 실행을 종료했습니다" });
    });
  }

  test("터미널이 끝나면 활동 줄이 코드로 남는다: 한국어는 예전 글, 영어 보고 언어는 영어", async () => {
    const t = await setup();
    const member = (await t.orch.addMember(t.project.id, { name: "dev", handle: "dev", role: "개발" })).member;
    await t.orch.assign(t.project.id, "dev", { text: "큰 일 @fake:hold" });
    await t.waitFor("일하는 중", () => t.core.held(member.id) && t.member(member.id).status === "working");
    t.store.patchSettings({ reportLanguage: "en" });
    t.core.exit(member.id, 3, "exited");
    const line = await t.waitFor("종료 줄", () => t.store.listActivity(member.id).find((a) => a.textCode === "activity.exit"));
    expect(line).toMatchObject({ kind: "error", text: "Session ended: exited (exit code 3)", textParams: { reason: "exited", code: "3" }, textLang: "en" });
    expect(renderServerText({ code: line.textCode!, params: line.textParams }, "ko")).toBe("초기/실행 종료: exited (exit_code=3)");
    // lastError 는 한국어 문장 그대로다(앱·서버가 문장 머리로 읽는다).
    expect(t.member(member.id).lastError).toBe("초기/실행 종료: exited (exit_code=3)");
    // 끊긴 실행의 중단 글: 엔진이 준 까닭(exited)은 그대로 값이다.
    const notice = await t.waitFor("중단 글", () => t.texts().find((m) => m.textCode === "chat.run_interrupted"));
    expect(notice.textParams?.why).toBe("exited");
  });
});

describe("대표 답으로 결재를 닫은 활동 줄", () => {
  for (const lang of ["ko", "en"] as const) {
    test(`같은 그룹의 결재를 대표 답에 따라 닫으면 코드로 남는다(보고 언어 ${lang})`, async () => {
      const t = await setup();
      if (lang === "en") t.store.patchSettings({ reportLanguage: "en" });
      const worker = t.store.createMember({ projectId: t.project.id, handle: "dev", name: "dev", kind: "worker", cli: "claude", backend: "core", origin: "runner", status: "asleep", cwd: t.project.cwd });
      const input = { projectId: t.project.id, memberId: worker.id, who: worker.name, title: "결제 검토", group: "결제", options: [{ k: "yes", label: "승인" }] };
      const answered = t.store.createDecision(input), open = t.store.createDecision(input);
      t.store.answerDecision(answered.id, { choice: "yes", note: "검토 범위만" });
      await t.orch.closeAsk(worker, { id: open.id, kind: "decided", reason: "대표 결정", answeredDecisionId: answered.id });
      const line = t.store.listActivity(worker.id).find((a) => a.textCode === "activity.decision_closed_by_answer_group")!;
      expect(line).toMatchObject({ textParams: { id: open.id, answer: answered.id }, textLang: lang,
        text: lang === "ko" ? `결재 #${open.id}를 대표 답 #${answered.id}에 따라 닫았습니다 (같은 그룹)` : `Closed decision #${open.id} based on your answer #${answered.id} (same group)` });
    });
  }
});

describe("도구 승인 카드의 '무엇을'과 대상", () => {
  function fixture() {
    const dir = mkdtempSync(join(tmpdir(), "iamceo-y-review-"));
    const db = openDb(join(dir, "iamceo.db"));
    const store = new Store(db, new Bus());
    const project = store.createProject({ name: "도구 승인", cwd: dir });
    const member = store.createMember({ projectId: project.id, handle: "dev", name: "dev", kind: "worker", cwd: dir, origin: "runner", backend: "core", status: "working", sessionId: randomUUID(), paneId: "pane-1" });
    const notices: string[] = [];
    const shown = (text: string | ServerTextRef) => typeof text === "string" ? text : store.renderText(text);
    const tp = new ToolPermissions({ store, notify: (title, body) => notices.push(`${shown(title)}|${shown(body)}`), deliverNote: () => {}, ttlMs: 2_000, pollMs: 200, goneMs: 300, graceMs: 80, sweepMs: 20 });
    cleanups.push(() => db.close());
    cleanups.push(() => tp.dispose());
    return { store, member, tp, notices };
  }
  const longMcp = "mcp__plugin_acme-enterprise-integrations_acme-enterprise-data-warehouse__run_query";

  // 리뷰 지적: 한국어 화면이 바뀌면 안 된다. 예전에는 '무엇을'을 60자에서 잘랐는데(describeToolRequest 의 clip), 코드로 다시 그리며 빠졌다.
  test("보고 언어 한국어: 60자가 넘는 연결 도구 이름도 제목·본문·활동 줄이 예전 글자 그대로다", async () => {
    const { store, member, tp } = fixture();
    const input = { sql: "select 1" };
    const pending = tp.request(member, { toolName: longMcp, toolInput: input, sessionId: "s", cwd: null });
    const card = store.listOpenToolPermissions()[0]!;
    // 59f26a9 의 식: action = clip(oneLine(`연결 도구 쓰기(${server})`), 60), 제목 = `${action}: ${대상 한 줄}`, 활동 = clip(`도구 승인 요청을 … · ${action}: ${대상}`, 300)
    const { action, target } = describeToolRequest(longMcp, input);
    expect(action).toBe("연결 도구 쓰기(plugin_acme-enterprise-integrations_acme-enterprise…(16자 더 있음)");
    expect(card.toolPermission).toMatchObject({ action, target });
    expect(card.title).toBe(`${action}: ${target}`);
    expect(card.detail).toContain(`**${action}**`);
    expect(store.listActivity(member.id).at(-1)!.text).toBe(`도구 승인 요청을 결재함에 올렸습니다 · ${action}: ${target}`);
    // 영어 앱은 코드로 다시 그린다: 잘린 이름 뒤 붙임말도 영어다.
    expect(renderServerText({ code: "card.tool_permission.title", params: card.textParams }, "en")).toBe(`Use a connected tool (plugin_acme-enterprise-integrations_acme-enterprise… 16 more characters): ${target}`);
    tp.answer(card.id, { choice: "deny" });
    await pending;
    expect(store.listActivity(member.id).at(-1)!.text).toBe(`대표가 결재함에서 도구 승인 요청을 거절했습니다 · ${action}: ${target}`);
  });

  // 리뷰 지적: 대상에 서버가 붙이는 말('(5자)', '…(N자 더 있음)')이 언어와 상관없이 한국어였다.
  test("보고 언어 영어: 카드·활동 줄·알림에 한국어 붙임말이 없다. 한국어 앱은 코드로 예전 한국어 카드를 그린다", async () => {
    const { store, member, tp, notices } = fixture();
    store.patchSettings({ reportLanguage: "en" });
    const pending = tp.request(member, { toolName: "Write", toolInput: { file_path: "/tmp/x.txt", content: "hello" }, sessionId: "s", cwd: null });
    const card = store.listOpenToolPermissions()[0]!;
    expect(card.title).toBe("Write a file: /tmp/x.txt (5 characters)");
    expect(card.toolPermission).toMatchObject({ action: "Write a file", target: "/tmp/x.txt (5 characters)" });
    expect(HANGUL.test(`${card.title}\n${card.detail}`)).toBe(false);
    expect(HANGUL.test(store.listActivity(member.id).at(-1)!.text)).toBe(false);
    expect(notices).toEqual(["dev tool approval|Write a file: /tmp/x.txt (5 characters)"]);
    expect(card.textParams?.target).toEqual({ ko: "/tmp/x.txt (5자)", en: "/tmp/x.txt (5 characters)" });
    expect(renderServerText({ code: "card.tool_permission.title", params: card.textParams }, "ko")).toBe("파일 쓰기: /tmp/x.txt (5자)");
    tp.answer(card.id, { choice: "allow" });
    await pending;
    const line = store.listActivity(member.id).at(-1)!;
    expect(line.text).toBe("You allowed the tool approval request in the Inbox · Write a file: /tmp/x.txt (5 characters)");
    expect(renderServerText({ code: line.textCode!, params: line.textParams }, "ko")).toBe("대표가 결재함에서 도구 승인 요청을 허용했습니다 · 파일 쓰기: /tmp/x.txt (5자)");
  });

  test("보고 언어 한국어 + 영어 앱: 긴 명령의 '…(N자 더 있음)'도 영어로 그린다", async () => {
    const { store, member, tp } = fixture();
    const command = `echo ${"x".repeat(700)}`;
    const pending = tp.request(member, { toolName: "Bash", toolInput: { command }, sessionId: "s", cwd: null });
    const card = store.listOpenToolPermissions()[0]!;
    expect(card.detail).toContain("…(105자 더 있음)");
    const english = renderServerText({ code: card.textCode!, params: card.textParams }, "en")!;
    expect(english).toContain("… (105 more characters)");
    expect(HANGUL.test(english)).toBe(false);
    expect(HANGUL.test(renderServerText({ code: "card.tool_permission.title", params: card.textParams }, "en")!)).toBe(false);
    tp.answer(card.id, { choice: "deny" });
    await pending;
  });
});
