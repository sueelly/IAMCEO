// 실제 herdr-core 칸 안에서 `claude` 처럼 도는 가짜 화면. 실제 Claude·모델을 절대 부르지 않는다.
// 상태는 실제 Claude 처럼 OSC 7501 로만 알린다(형식은 herdr-core 0.1.18 에서 확인: ESC ] 7501 ; state=blocked:kind=permission BEL).
// 받은 글에 "BLOCK <명령>" 이 있으면 Claude Code 2.1.322 실측 모양의 Bash 권한 창을 띄운다.
//   1~3(승인): 그 명령을 이 칸의 작업 폴더에서 실제로 돌리고 출력을 보인 뒤 쉰다. 4·Esc(거절): 'Interrupted' 를 보이고 쉰다.
// 그 밖의 글은 짧게 일하고 쉰다. 창이 떠 있는 동안 FAKE_TUI_DIR/ctl 의 글이 바뀌면 그 글을 명령으로 창을 다시 그린다(낡은 카드 시험).
// 받은 키·고른 것·돌린 명령은 FAKE_TUI_DIR/events.jsonl 에 남긴다. transcript 는 CLAUDE_CONFIG_DIR 아래 실제 자리에 쓴다.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.FAKE_TUI_DIR;
if (!dir) throw new Error("FAKE_TUI_DIR 없음");
const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] ?? null : null; };
const sessionId = flag("--session-id") ?? flag("--resume") ?? crypto.randomUUID();
const claudeHome = process.env.CLAUDE_CONFIG_DIR;
if (!claudeHome) throw new Error("CLAUDE_CONFIG_DIR 없음");
const sessionsDir = join(claudeHome, "projects", process.cwd().replace(/[^a-zA-Z0-9]/g, "-"));
mkdirSync(sessionsDir, { recursive: true });
const transcript = join(sessionsDir, `${sessionId}.jsonl`);
const record = (value: Record<string, unknown>) => appendFileSync(transcript, JSON.stringify({ ...value, sessionId, cwd: process.cwd(), isSidechain: false, uuid: crypto.randomUUID(), timestamp: new Date().toISOString() }) + "\n");
const note = (value: Record<string, unknown>) => appendFileSync(join(dir, "events.jsonl"), JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...value }) + "\n");
if (!existsSync(transcript)) record({ type: "system", subtype: "init" });
note({ event: "start", args });

const width = () => Math.max(60, Math.min(process.stdout.columns || 120, 160));
const rule = (ch = "─") => ch.repeat(width());
const osc = (state: "idle" | "working" | "blocked", kind?: string) => process.stdout.write(`\x1b]7501;state=${state}${kind ? `:kind=${kind}` : ""}\x07`);
const paint = (text: string) => process.stdout.write(`\x1b[2J\x1b[H${text.replace(/\n/g, "\r\n")}`);

let history = ` ▐▛███▛█   Claude Code v2.1.322 (가짜 화면)\n▝▜██████▀  시험용 · 모델 없음\n ▝▝   ▝▝   ${process.cwd()}\n\n`;
let state: "idle" | "working" | "blocked" = "idle";
let input = "";
let selected = 0;
let command = "";
let ctlSeen = existsSync(join(dir, "ctl")) ? readFileSync(join(dir, "ctl"), "utf8") : "";
const OPTIONS = () => ["Yes", `Yes, and always allow access to ${process.cwd()} from this project`, "Yes, and switch to auto mode · auto mode handles these prompts for you", "No"];

function composer() {
  paint(`${history}${rule()}\n❯ ${input}\n${rule()}\n  ? for shortcuts\n`);
}
function windowScreen() {
  const opts = OPTIONS().map((o, i) => `${i === selected ? " ❯ " : "   "}${i + 1}. ${o}`).join("\n");
  paint(`${history}⏺ Bash(${command})\n  ⎿  Waiting…\n\n${rule()}\n Bash command\n Tip: auto mode handles these prompts for you — choose "switch to auto mode" below\n Run the requested command\n${rule("╌")}\n ${command}\n${rule("╌")}\n Do you want to proceed?\n${opts}\n\n Esc to cancel · Tab to amend\n${rule()}\n`);
}
function idle() { state = "idle"; osc("idle"); composer(); }
function reply(text: string) {
  history += `⏺ ${text}\n\n`;
  record({ type: "assistant", message: { role: "assistant", model: "fake", content: [{ type: "text", text }], usage: { input_tokens: 1000, output_tokens: 10 } } });
  idle();
}
function submit(text: string) {
  if (!text.trim()) return composer();
  history += `❯ ${text.split("\n").join("\n  ")}\n\n`;
  record({ type: "user", message: { role: "user", content: text } });
  note({ event: "submit", text: text.slice(0, 200) });
  state = "working"; osc("working"); composer();
  const block = /BLOCK\s+(.+?)\s*(?:"|$)/m.exec(text);
  setTimeout(() => {
    if (!block) return reply("알겠습니다.");
    command = block[1]!.trim();
    selected = 0;
    state = "blocked"; osc("blocked", "permission"); windowScreen();
    note({ event: "window", command });
  }, 300);
}
function choose(n: number) {
  note({ event: "choose", n, label: OPTIONS()[n - 1], command });
  if (n === 4) {
    history += `⏺ Bash(${command})\n  ⎿  Interrupted · What should Claude do instead?\n\n`;
    record({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_fake", is_error: true, content: "The user doesn't want to proceed with this tool use." }] } });
    return idle();
  }
  state = "working"; osc("working");
  history += `⏺ Bash(${command})\n`;
  paint(`${history}  ⎿  Running…\n`);
  setTimeout(() => {
    const run = spawnSync("/bin/sh", ["-c", command], { cwd: process.cwd(), encoding: "utf8", timeout: 10_000 });
    const out = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim() || `(exit ${run.status})`;
    note({ event: "ran", command, status: run.status, out: out.slice(0, 400) });
    history += `  ⎿  ${out.split("\n").join("\n     ")}\n\n`;
    reply(`명령을 실행했습니다(종료 코드 ${run.status}).`);
  }, 500);
}
function key(seq: string) {
  if (state === "blocked") {
    note({ event: "key", seq: JSON.stringify(seq) });
    if (seq === "\x1b[A") selected = Math.max(0, selected - 1);
    else if (seq === "\x1b[B") selected = Math.min(3, selected + 1);
    else if (seq === "\r" || seq === "\n") return choose(selected + 1);
    else if (/^[1-4]$/.test(seq)) return choose(Number(seq));
    else if (seq === "\x1b") return choose(4);
    return windowScreen();
  }
  if (state !== "idle") return note({ event: "ignored", seq: JSON.stringify(seq), state });
  if (seq === "\r" || seq === "\n") { const text = input; input = ""; return submit(text); }
  if (seq === "\x7f") input = input.slice(0, -1);
  else if (seq === "\x03") input = "";
  else if (!seq.startsWith("\x1b")) input += seq;
  composer();
}

process.stdin.setRawMode?.(true);
process.stdin.setEncoding("utf8");
process.stdout.write("\x1b[?2004h"); // 붙여 넣기 표시를 받는다(실제 Claude 와 같음)
process.stdin.on("data", (chunk: string) => {
  // 한 번에 온 조각을 키 단위로 나눈다: 붙여 넣기 덩어리, ESC 열, 그 밖의 글자
  const re = /\x1b\[200~([\s\S]*?)\x1b\[201~|\x1b\[[0-9;]*[A-Za-z~]|\x1b|[\s\S]/g;
  for (const m of chunk.matchAll(re)) {
    if (m[1] !== undefined) {
      if (state === "idle") { input += m[1]; composer(); }
      else note({ event: "ignored-paste", state });
      continue;
    }
    key(m[0]);
  }
});
setInterval(() => {
  const path = join(dir, "ctl");
  const now = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (now === ctlSeen) return;
  ctlSeen = now;
  if (state === "blocked" && now.trim()) { command = now.trim(); selected = 0; windowScreen(); note({ event: "window-changed", command }); }
}, 100);
idle();
