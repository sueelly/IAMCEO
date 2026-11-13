#!/usr/bin/env bun
// Claude 직원의 PreToolUse 훅. 서버를 띄우지 않고 판정 모듈만 읽어 빨리 끝난다.
// 사용: iamceo-guard.ts --home <IAMCEO 데이터 폴더>. 판정이 허용이면 아무것도 내지 않는다.
// 입력을 읽지 못하면 막지 않는다(훅이 고장 나도 일이 멈추지 않게). 이 점은 하네스 보고에 '미지원'으로 남긴다.
import { guardDecision, hookOutput } from "../server/harness-guard.ts";

export async function runGuard(argv: string[], stdin: string): Promise<string | null> {
  const at = argv.indexOf("--home");
  const iamceoHome = at >= 0 ? argv[at + 1] : process.env.IAMCEO_HOME;
  if (!iamceoHome) return null;
  let input: unknown;
  try { input = JSON.parse(stdin); } catch { return null; }
  return hookOutput(guardDecision(input as Record<string, unknown>, { iamceoHome }));
}

if (import.meta.main) {
  const out = await runGuard(process.argv.slice(2), await new Response(Bun.stdin.stream()).text());
  if (out) process.stdout.write(`${out}\n`);
}
