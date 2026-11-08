#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const stdin = await Bun.stdin.text();
if (process.env.FAKE_CODEX_LOG) appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ args: process.argv.slice(2), stdin, token: process.env.IAMCEO_TOKEN }) + "\n");
const emit = (o: unknown) => console.log(JSON.stringify(o));
emit({ type: "thread.started", thread_id: "019abcde-1234-7123-8123-123456789abc" });
emit({ type: "turn.started" });
if (stdin === "hang") { emit({ type: "item.started", item: { id: "a", type: "command_execution", command: "sleep" } }); await new Promise(() => {}); }
else if (stdin === "fail") { emit({ type: "turn.failed", error: { message: "usage limit reached" } }); process.exitCode = 1; }
else { emit({ type: "item.completed", item: { id: "a", type: "agent_message", text: "Codex 응답" } }); emit({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 4 } }); }
