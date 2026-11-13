/**
 * 0.2.6 Y: shared/server-text.ts 의 글 틀(ko·en)을 앱으로 옮긴다.
 * - native/Sources/IAMCEO/Models/ServerTextCatalog.swift: 코드 → `String(localized: "server.text.<코드>", defaultValue: "<한국어 틀>")`
 * - native/Resources/Shared/Localizable.xcstrings: 열쇠 server.text.<코드> 에 ko(=기본값)·en
 * 서버의 Mac 스크립트 알림 전용 코드(notice.*)는 넣지 않는다.
 *
 *   bun scripts/gen-server-text-swift.ts          # 두 파일을 다시 쓴다
 *   bun scripts/gen-server-text-swift.ts --check  # 다르면 1 로 끝난다(tests/server-text.test.ts 와 같은 검사)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isServerOnlyText, SERVER_TEXTS, type ServerTextTemplate } from "../shared/server-text";

const ROOT = resolve(import.meta.dir, "..");
export const SWIFT_PATH = join(ROOT, "native/Sources/IAMCEO/Models/ServerTextCatalog.swift");
export const CATALOG_PATH = join(ROOT, "native/Resources/Shared/Localizable.xcstrings");
export const KEY_PREFIX = "server.text.";
const COMMENT = "Y(0.2.6) 서버가 만든 글의 틀. {이름} 은 값, {이름:이} 는 한국어 조사. 원본 shared/server-text.ts";

function appEntries(): [string, ServerTextTemplate][] {
  return Object.entries(SERVER_TEXTS as Record<string, ServerTextTemplate>).filter(([code]) => !isServerOnlyText(code));
}

function swiftString(value: string): string {
  return JSON.stringify(value).replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => `\\u{${hex}}`);
}

export function renderServerTextSwift(): string {
  const cases = appEntries().map(([code, text]) =>
    `        case ${swiftString(code)}: return String(localized: ${swiftString(KEY_PREFIX + code)}, defaultValue: ${swiftString(text.ko)})`);
  return [
    "// 생성된 파일 — 손으로 고치지 않는다. 원본은 shared/server-text.ts, 다시 만들기: bun scripts/gen-server-text-swift.ts",
    "import Foundation",
    "",
    "/// 서버가 만든 글(시스템 글·결재 카드·활동 줄)의 코드별 틀을 화면 언어로. 영어는 문구 표의 server.text.*, 한국어는 기본값.",
    "/// 그리기 규칙은 ServerText.swift. 모르는 코드는 nil(받은 문장을 그대로 보인다).",
    "enum ServerTextCatalog {",
    "    static func template(_ code: String) -> String? {",
    "        switch code {",
    ...cases,
    "        default: return nil",
    "        }",
    "    }",
    "}",
    "",
  ].join("\n");
}

/** Xcode 가 쓰는 꼴(두 칸 들여쓰기, `"열쇠" : 값`)으로. 지금 표를 읽어 다시 쓰면 글자까지 같다(시험이 본다). */
export function xcstrings(value: unknown, indent = ""): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  const next = `${indent}  `;
  if (Array.isArray(value)) return value.length ? `[\n${value.map(v => next + xcstrings(v, next)).join(",\n")}\n${indent}]` : "[]";
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length ? `{\n${entries.map(([k, v]) => `${next}${JSON.stringify(k)} : ${xcstrings(v, next)}`).join(",\n")}\n${indent}}` : "{}";
}

function unit(value: string) { return { stringUnit: { state: "translated", value } }; }

/** 문구 표에서 server.text.* 를 지우고 지금 목록을 끝에 다시 넣는다. 다른 열쇠와 순서는 그대로다. */
export function renderCatalog(current: string): string {
  const catalog = JSON.parse(current) as { sourceLanguage: string; strings: Record<string, unknown>; version?: string };
  const strings = Object.fromEntries(Object.entries(catalog.strings).filter(([key]) => !key.startsWith(KEY_PREFIX)));
  for (const [code, text] of appEntries()) {
    strings[KEY_PREFIX + code] = { comment: COMMENT, localizations: { en: unit(text.en), ko: unit(text.ko) } };
  }
  return `${xcstrings({ ...catalog, strings })}\n`;
}

if (import.meta.main) {
  const swift = renderServerTextSwift();
  const catalog = renderCatalog(readFileSync(CATALOG_PATH, "utf8"));
  if (process.argv.includes("--check")) {
    const stale = [[SWIFT_PATH, swift], [CATALOG_PATH, catalog]].filter(([path, next]) => { try { return readFileSync(path!, "utf8") !== next; } catch { return true; } });
    if (stale.length) {
      console.error(`Out of date: ${stale.map(([path]) => path).join(", ")}. Run: bun scripts/gen-server-text-swift.ts`);
      process.exit(1);
    }
  } else {
    writeFileSync(SWIFT_PATH, swift);
    writeFileSync(CATALOG_PATH, catalog);
    console.log(`Wrote ${SWIFT_PATH} and ${CATALOG_PATH}`);
  }
}
