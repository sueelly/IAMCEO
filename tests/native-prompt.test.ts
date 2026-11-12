// 직원 CLI 질문·선택·승인 창 읽기: 실측 화면(tests/fixtures/native-prompts)으로 선택지·고른 줄·자유 응답 줄을 확인한다.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseNativePrompt } from "../server/runner/prompt.ts";

const fx = (name: string) => readFileSync(join(import.meta.dir, "fixtures/native-prompts", name), "utf8");

describe("직원 CLI 창 읽기(실측 화면)", () => {
  test("Claude AskUserQuestion: 선택지·설명·자유 응답 줄·지금 고른 줄", () => {
    const p = parseNativePrompt(fx("claude-ask-free.txt"), "claude")!;
    expect(p.limited).toBe(false);
    expect(p.kind).toBe("question");
    expect(p.question).toBe("어떤 과일이 좋아요?");
    expect(p.title).toBe("☐ 과일");
    expect(p.options.map((o) => o.label)).toEqual(["사과", "배", "포도", "Type something.", "Chat about this"]);
    expect(p.options[0]!.detail).toBe("사과를 고릅니다.");
    expect(p.options[3]!.freeText).toBe(true);
    expect(p.selected).toBe(3);
  });

  test("Codex MCP 도구 승인: 한 줄의 이름·설명을 나누고 거절(Cancel)을 안다", () => {
    const p = parseNativePrompt(fx("codex-mcp-approval.txt"), "codex")!;
    expect(p.limited).toBe(false);
    expect(p.kind).toBe("permission");
    expect(p.question).toBe('Allow the iamceo MCP server to run tool "status"?');
    expect(p.options.map((o) => [o.label, o.reject])).toEqual([["Allow", false], ["Allow for this session", false], ["Always allow", false], ["Cancel", true]]);
    expect(p.options[0]!.detail).toBe("Run the tool and continue");
    expect(p.selected).toBe(0);
  });

  test("Claude 번호 없는 시작 창과 Codex 폴더 신뢰 창", () => {
    const c = parseNativePrompt(fx("claude-chrome.txt"), "claude")!;
    expect(c.limited).toBe(false);
    expect(c.options.map((o) => o.label)).toEqual(["No, keep browser tools off", "Yes, use my browser"]);
    expect(c.selected).toBe(0);
    expect(c.title).toBe("Claude in Chrome extension detected");
    const t = parseNativePrompt(fx("codex-trust.txt"), "codex")!;
    expect(t.options.map((o) => [o.label, o.reject])).toEqual([["Trust and continue", false], ["Back to Agent Command Center", true]]);
    expect(t.selected).toBe(0);
  });

  test("Claude Bash 권한 창(2.1.322): 제목·명령·질문·거절", () => {
    const p = parseNativePrompt(fx("claude-bash-permission.txt"), "claude")!;
    expect(p.kind).toBe("permission");
    expect(p.title).toBe("Bash command");
    expect(p.question).toBe("Do you want to proceed?");
    expect(p.body).toContain("touch probe-claude.txt");
    expect(p.options.map((o) => o.reject)).toEqual([false, false, false, true]);
    expect(p.options[0]!.label).toBe("Yes");
  });

  test("Codex: 지난 도구 기록은 질문에 섞지 않는다", () => {
    const p = parseNativePrompt(fx("codex-mcp-approval-2.txt"), "codex")!;
    expect(p.title).toBe("Field 1/1");
    expect(p.question).toBe('Allow the iamceo MCP server to run tool "post"?');
    expect(p.body.startsWith("body:")).toBe(true);
  });

  test("Antigravity 1.5.6: 폴더 신뢰(> 커서)와 명령 실행 권한(안내 두 줄)", () => {
    const t = parseNativePrompt(fx("agy-trust.txt"), "antigravity")!;
    expect(t.options.map((o) => [o.label, o.reject])).toEqual([["Yes, I trust this folder", false], ["No, exit", true]]);
    expect(t.question).toBe("Do you trust the contents of this project?");
    const p = parseNativePrompt(fx("agy-run-permission.txt"), "antigravity")!;
    expect(p.limited).toBe(false);
    expect(p.kind).toBe("permission");
    expect(p.title).toBe("Requesting permission for:");
    expect(p.body).toBe("touch probe-agy.txt");
    expect(p.question).toBe("Run this command?");
    expect(p.options).toHaveLength(4);
    expect(p.options[3]).toMatchObject({ label: "No, cancel", reject: true });
  });

  test("입력을 기다리는 보통 화면(위쪽 번호 목록 포함)은 창이 아니다", () => {
    expect(parseNativePrompt(fx("claude-idle.txt"), "claude")).toBeNull();
    expect(parseNativePrompt(fx("codex-idle-list.txt"), "codex")).toBeNull();
  });

  test("확실하지 않으면 선택지를 만들지 않고 원문만(제한)", () => {
    const twoCursors = "  ❯ 하나\n  ❯ 둘\n\n  Enter to confirm · Esc to cancel";
    const p = parseNativePrompt(twoCursors, "claude")!;
    expect(p.limited).toBe(true);
    expect(p.options).toEqual([]);
    expect(p.raw).toContain("하나");
    const multi = " 고르세요?\n\n❯ 1. [ ] 사과\n  2. [ ] 배\n\n Enter to select · Esc to cancel";
    expect(parseNativePrompt(multi, "claude")!.limited).toBe(true);
    const stray = " 고르세요?\n\n❯ 1. 사과\n  2. 배\n이상한 글\n\n Enter to select · Esc to cancel";
    expect(parseNativePrompt(stray, "claude")!.limited).toBe(true);
  });

  test("지문은 선택지가 같으면 같고, 바뀌면 다르다", () => {
    const a = parseNativePrompt(fx("codex-mcp-approval.txt"), "codex")!;
    const b = parseNativePrompt(fx("codex-mcp-approval.txt").replace('"status"', '"post"'), "codex")!;
    expect(a.fingerprint).toBe(parseNativePrompt(fx("codex-mcp-approval.txt"), "codex")!.fingerprint);
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });
});
