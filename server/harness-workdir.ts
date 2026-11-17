import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

/** 도구의 실행 위치는 절대 경로 원문이다. 공백·한글·% 등을 다듬지 않는다. */
export const isExecutionWorkdir = (value: unknown): value is string =>
  typeof value === "string" && value.isWellFormed() && isAbsolute(value) && !value.includes("\0");

/** Codex가 남긴 로컬 file URL만 경로로 푼다. 실패는 미확인 위치이며 와일드카드가 아니다. */
export function codexWorkdir(value: unknown): string | null {
  if (isExecutionWorkdir(value)) return value;
  // WHATWG URL이 상대 file:값·공백·제어문자·역슬래시를 절대 위치로 고쳐 주지 않게 한다.
  if (typeof value !== "string" || !value.isWellFormed() || !/^file:(?:\/\/[^/]*\/|\/(?!\/))/i.test(value) || /[\x00-\x20\\?#]/.test(value)) return null;
  try {
    const url = new URL(value);
    // 런타임은 localhost(대소문자 포함)를 빈 로컬 호스트로 정규화한다. DNS/원격 호스트는 허용하지 않는다.
    if (url.protocol !== "file:" || url.hostname !== "" || url.search || url.hash) return null;
    // Bun 1.3의 fileURLToPath는 깨진 % 이스케이프를 그대로 둘 수 있어 먼저 검증한다.
    decodeURIComponent(url.pathname);
    const path = fileURLToPath(url);
    return isExecutionWorkdir(path) ? path : null;
  } catch { return null; }
}
