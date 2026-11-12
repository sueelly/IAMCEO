// 직원 CLI 가 화면에 띄운 질문·선택·승인 창을 읽는다(core 칸의 terminal.read 글). 대표가 웹 대화에서 직접 답하게 한다.
//
// 실측한 모양(2026-11-12, 격리 칸):
//   Claude Code 2.1.322 AskUserQuestion
//      ☐ 과일
//
//     어떤 과일이 좋아요?
//
//     ❯ 1. 사과
//          사과를 고릅니다.          ← 선택지 설명(더 깊이 들여쓴 줄)
//       …
//       4. Type something.          ← 고르면 그 줄에 글을 쳐서 Enter 로 낸다(자유 응답)
//     ────────────
//       5. Chat about this
//
//     Enter to select · ↑/↓ to navigate · Esc to cancel
//   Claude Code 2.1.322 시작 창(번호 없는 목록): "❯ No, keep browser tools off" / "  Yes, use my browser" / "Enter to confirm · Esc to …"
//   Codex 0.16x MCP 도구 승인: "  › 1. Allow                   Run the tool and continue" … "  enter to submit | esc to cancel"
//   Codex 폴더 신뢰: "› 1. Trust and continue" / "  2. Back to …" / "  enter continue · esc back"
//
// 고르기는 화살표로 그 줄까지 옮긴 뒤 Enter 한 번이다(번호 키는 CLI 마다 뜻이 달라 쓰지 않는다).
// 모양이 확실하지 않으면 선택지를 지어내지 않는다: limited 로 돌려 화면 원문만 보인다.
import { createHash } from "node:crypto";
import type { CliProvider, NativePrompt, NativePromptOption } from "../../shared/types.ts";

const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g;
export const stripScreen = (s: string) => s.replace(OSC_RE, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b./g, "");

const FOOTER = /(?:^|[\s·|])enter\s+(?:to\s+)?(?:select|confirm|submit|continue)\b|\besc to cancel\b|\besc back\b|↑\/↓ (?:to )?navigate/i;
const SOLID_RULE = /^\s*[╭╰]?─{8,}/;
const DASHED_RULE = /^\s*╌{8,}\s*$/;
const CURSOR = "❯›>▸";
const NUMBERED = new RegExp(`^(\\s*)([${CURSOR}]\\s*)?(\\d{1,2})[.)]\\s+(\\S.*)$`);
const UNNUMBERED = new RegExp(`^(\\s*)([${CURSOR}])\\s+(\\S.*)$`);
const FREE_TEXT = /^(?:Type something|Other|Something else|직접 입력|기타)\b/i;
const REJECT = /^(?:No\b|Deny\b|Cancel\b|Reject\b|Decline\b|Quit\b|Don'?t\b|Back to\b)/i;
const ACCEPT = /^(?:Yes\b|Allow\b|Approve\b|Accept\b|Trust\b|Proceed\b|Continue\b)/i;
const CHECKBOX = /^(?:\[[ xX✓✔]\]|[☐☑☒◻◼])\s/;
/** 선택지 줄 사이가 이보다 멀면 한 창으로 보지 않는다. */
const MAX_SCAN = 48;
/** 화면 원문으로 보일 아래쪽 줄 수 */
const RAW_LINES = 30;

interface Row { index: number; indent: number; textCol: number; cursor: boolean; n: number | null; text: string }

function rawTail(lines: string[]): string {
  return lines.slice(-RAW_LINES).join("\n").replace(/^\n+|\n+$/g, "");
}

function fingerprint(provider: CliProvider, parts: unknown): string {
  return createHash("sha256").update(JSON.stringify([provider, parts])).digest("hex").slice(0, 24);
}

/** 제한 상태: 질문 창은 있어 보이지만 선택지를 확실히 읽지 못했다. 원문만 보인다. */
export function limitedPrompt(provider: CliProvider, screen: string, reason: string): NativePrompt {
  const lines = stripScreen(screen).split(/\r?\n/).map((l) => l.replace(/\s+$/, ""));
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  const raw = rawTail(lines);
  return { kind: "unknown", provider, title: "", body: "", question: "", options: [], selected: -1, limited: true, limitedReason: reason, raw, fingerprint: fingerprint(provider, ["limited", raw]) };
}

/**
 * 화면 맨 아래의 선택 창을 읽는다. 창이 없으면 null. 창처럼 보이나 확실하지 않으면 limited.
 * 화면 위쪽의 지난 대화 글(번호 목록 등)은 맨 아래 안내 줄(Enter to select · Esc to cancel 등) 바로 위가 아니면 읽지 않는다.
 */
export function parseNativePrompt(screen: string, provider: CliProvider): NativePrompt | null {
  const lines = stripScreen(screen).split(/\r?\n/).map((l) => l.replace(/\s+$/, ""));
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  // 안내 줄: 맨 아래 몇 줄 안(뒤에 칸 테두리·상태줄이 올 수 있다).
  let footer = -1;
  for (let i = lines.length - 1, seen = 0; i >= 0 && seen < 6; i--) {
    if (!lines[i]!.trim()) continue;
    seen++;
    if (FOOTER.test(lines[i]!)) { footer = i; break; }
  }
  if (footer < 0) return null;
  // 안내가 두 줄이면(Antigravity: '↑/↓ Navigate …' 아래 'esc to cancel') 선택지 쪽 줄을 안내 줄로 본다.
  for (let i = footer - 1; i >= 0; i--) {
    if (!lines[i]!.trim()) continue;
    if (FOOTER.test(lines[i]!)) footer = i;
    break;
  }

  const rows: Row[] = [];
  const top = Math.max(0, footer - MAX_SCAN);
  for (let i = top; i < footer; i++) {
    const line = lines[i]!;
    const m = NUMBERED.exec(line);
    if (m) {
      const indent = m[1]!.length;
      rows.push({ index: i, indent, textCol: line.length - m[4]!.length, cursor: !!m[2], n: Number(m[3]), text: m[4]! });
      continue;
    }
    const u = UNNUMBERED.exec(line);
    if (u) rows.push({ index: i, indent: u[1]!.length, textCol: line.length - u[3]!.length, cursor: true, n: null, text: u[3]! });
  }

  // 번호 목록: 안내 줄에 가장 가까운 1..k 연속.
  const numbered = rows.filter((r) => r.n !== null);
  let options: Row[] = [];
  if (numbered.length >= 2) {
    const chain: Row[] = [];
    for (let k = numbered.length - 1; k >= 0; k--) {
      const r = numbered[k]!;
      if (chain.length && r.n !== chain[0]!.n! - 1) break;
      chain.unshift(r);
      if (r.n === 1) break;
    }
    if (chain[0]?.n === 1 && chain.length >= 2) options = chain;
  }
  let unnumbered = false;
  if (!options.length) {
    // 번호 없는 목록: 커서 줄 하나와, 그 글 칸에 맞춰 들여 쓴 이웃 줄들(안내 줄 바로 위 덩어리).
    const cursorRows = rows.filter((r) => r.n === null);
    if (cursorRows.length !== 1) return cursorRows.length > 1 || numbered.length ? limitedPrompt(provider, screen, "선택지 줄을 확실히 읽지 못했습니다") : null;
    const cur = cursorRows[0]!;
    const block: Row[] = [cur];
    const sibling = (i: number): Row | null => {
      const line = lines[i]!;
      if (!line.trim()) return null;
      const lead = line.length - line.trimStart().length;
      return lead === cur.textCol ? { index: i, indent: lead, textCol: lead, cursor: false, n: null, text: line.trim() } : null;
    };
    for (let i = cur.index - 1; i >= top; i--) { const s = sibling(i); if (!s) break; block.unshift(s); }
    for (let i = cur.index + 1; i < footer; i++) { const s = sibling(i); if (!s) break; block.push(s); }
    // 덩어리와 안내 줄 사이에는 빈 줄만 있어야 한다.
    if (lines.slice(block[block.length - 1]!.index + 1, footer).some((l) => l.trim())) return limitedPrompt(provider, screen, "선택지와 안내 줄 사이에 다른 글이 있습니다");
    if (block.length < 2) return limitedPrompt(provider, screen, "선택지가 하나뿐입니다");
    options = block;
    unnumbered = true;
  }

  // 선택지 사이의 줄: 빈 줄·구분선은 건너뛰고, 더 깊이 들여 쓴 줄은 바로 위 선택지의 설명이다. 그 밖의 글이 끼면 확실하지 않다.
  const details = new Map<number, string[]>();
  const first = options[0]!;
  const last = options[options.length - 1]!;
  for (let i = first.index + 1; i < footer; i++) {
    if (options.some((o) => o.index === i)) continue;
    const line = lines[i]!;
    if (!line.trim() || SOLID_RULE.test(line) || DASHED_RULE.test(line)) continue;
    const owner = [...options].reverse().find((o) => o.index < i)!;
    const lead = line.length - line.trimStart().length;
    if (i > last.index && lead <= last.indent) return limitedPrompt(provider, screen, "선택지 아래에 읽지 못한 글이 있습니다");
    if (lead < owner.textCol) return limitedPrompt(provider, screen, "선택지 사이에 읽지 못한 글이 있습니다");
    details.set(owner.index, [...(details.get(owner.index) ?? []), line.trim()]);
  }

  const selected = options.findIndex((o) => o.cursor);
  if (options.filter((o) => o.cursor).length !== 1) return limitedPrompt(provider, screen, "지금 고른 줄을 알 수 없습니다");
  if (options.some((o) => CHECKBOX.test(o.text))) return limitedPrompt(provider, screen, "여러 개를 고르는 창은 여기서 답할 수 없습니다");

  const opts: NativePromptOption[] = options.map((o, i) => {
    // Codex 는 한 줄에 이름과 설명을 둔다(두 칸 이상 빈칸으로 나뉨).
    const [label, ...rest] = o.text.split(/\s{2,}/);
    const detail = [...rest, ...(details.get(o.index) ?? [])].join("\n").trim();
    const clean = label!.trim();
    return { n: unnumbered ? i + 1 : o.n!, label: clean, reject: REJECT.test(clean), ...(detail ? { detail } : {}), ...(FREE_TEXT.test(clean) ? { freeText: true } : {}) };
  });

  // 질문 덩어리: 첫 선택지 위로 실선·빈 줄 둘(Codex 는 지난 도구 기록과 빈 줄 둘로 나뉜다)·화면 끝까지.
  const head: string[] = [];
  let blanks = 0;
  for (let i = first.index - 1; i >= 0 && first.index - i <= 24; i--) {
    const line = lines[i]!;
    if (SOLID_RULE.test(line)) break;
    if (!line.trim()) { if (++blanks >= 2) break; head.unshift(""); continue; }
    blanks = 0;
    head.unshift(line);
  }
  const block = head.filter((l) => !DASHED_RULE.test(l)).map((l) => l.trim()).join("\n").replace(/^\n+|\n+$/g, "").replace(/\n{3,}/g, "\n\n");
  const blockLines = block.split("\n").filter((l) => l.trim());
  let qi = -1;
  for (let i = blockLines.length - 1; i >= 0; i--) if (/[?？]\s*$/.test(blockLines[i]!)) { qi = i; break; }
  if (qi < 0) qi = blockLines.length - 1;
  const question = blockLines[qi] ?? "";
  const title = qi > 0 ? blockLines[0]! : "";
  const body = blockLines.filter((_, i) => i !== qi && !(title && i === 0)).join("\n");
  if (!question && !title) return limitedPrompt(provider, screen, "질문 글을 찾지 못했습니다");

  const kind: NativePrompt["kind"] = opts.some((o) => o.freeText) || /Enter to select/.test(lines[footer]!) ? "question"
    : opts.some((o) => o.reject) && opts.some((o) => ACCEPT.test(o.label)) ? "permission" : "menu";
  return {
    kind, provider, title, body, question, options: opts, selected, limited: false,
    raw: rawTail(lines.slice(0, footer + 1)),
    fingerprint: fingerprint(provider, [title, body, question, opts.map((o) => [o.n, o.label, o.detail ?? ""])]),
  };
}
