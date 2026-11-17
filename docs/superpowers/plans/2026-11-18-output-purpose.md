# IAMCEO 표시 목적별 작성·읽기 개선 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans. 같은 작업 워크트리에서 순서대로 구현하고 변경 전체를 독립 검토한다.

**Goal:** 제목·요약·상세가 탐색·결정·검토·사용이라는 각 위치의 목적을 수행하게 한다.
**Architecture:** 기존 필드를 유지하면서 공통 작성 지침과 도구 스키마 설명을 구체화한다. 저장 중 제목 절단과 화면의 판단 정보 접기를 제거한다.
**Tech Stack:** TypeScript, Bun, React, SwiftUI, Markdown.
**Spec:** docs/superpowers/specs/2026-11-18-output-purpose.md

## Global Constraints

- 맥미니의 기존 작업 워크트리와 `fix-explain-report-context-01a1ea8c` 브랜치를 사용한다.
- 원문·실제 확인 상태·승인·실행 조건을 보존한다. 경고는 저장을 막지 않는다.
- 상시 안내문이나 모든 글에 같은 제목 체계를 추가하지 않는다.

## Review Focus

- 대표가 붙인 긴 업무 이름과 자동 임시 이름에서 서로 다른 기존 API 한도를 보존한다.
- 짧지만 대상을 정확히 드러내는 제목을 일반 제목 경고로 잘못 판정하지 않는다.
- 결재 선택지를 옮겨도 선택·확인 두 단계와 변경 내용 재검토가 유지된다.
- 오래된 상태를 새 실행의 증거로 바꾸지 않고 시점과 다음 조건을 보존한다.
- 웹과 네이티브의 상세가 다른 순서나 접힘 상태로 중요한 조건을 숨기지 않는다.

### Task 1: 위치별 작성 계약과 업무 이름 보존

**Files:** server/roles/writing.md, server/agent-tools.ts, server/writing-lint.ts, server/task-names.ts, tests/output-purpose.test.ts, tests/task-everywhere.test.ts.
**Interfaces:** 기존 도구 인자와 반환 계약을 유지한다. lintTask를 추가하고 lintPost/lintAsk/lintFile가 제목의 목적을 구분한다.

- [x] 자동 이름의 목적 부분·대표의 60자 초과 이름 손실과 일반 제목의 도구 경고 누락을 먼저 재현한다.
- [x] 위치별 작성 기준·예시와 도구 설명을 맞추고 기존 API 범위에서 제목을 보존한다.
- [x] `bun test tests/output-purpose.test.ts tests/task-everywhere.test.ts tests/report-context.test.ts tests/writing-guide.test.ts tests/writing-lint.test.ts tests/terminal-approval-guide.test.ts`를 실행한다. Expected: 관련 검사 실패 0건.
- [x] 검증한 변경을 커밋한다.

### Task 2: 결정·상황 파악의 읽는 순서

**Files:** web/src/screens/Inbox.tsx, web/src/screens/Home.tsx, web/src/styles/home.css, native/Sources/IAMCEO/Views/{InboxView,HomeView}.swift, tests/output-purpose.browser.ts, tests/browser.test.ts.
**Interfaces:** 기존 결재·상황 필드를 소비한다. API와 승인 상태 변경은 없다.

- [x] 격리 가상 업무로 결재 상세의 순서와 홈 마지막 조건이 숨겨지는 실패를 먼저 재현한다. 같은 검사에서 보고·자료·상태·이름의 역할을 확인한다.
- [x] 웹·네이티브의 열린 결재 상세를 선택지 앞에 표시하고 판단 정보의 자동 접기를 제거한다.
- [x] `bun test tests/browser.test.ts --test-name-pattern '읽는 목적|자동 결재의 업무'`, `bun run typecheck`, `bun run build`, `swift test --package-path native`를 실행한다. Expected: 새 브라우저 검사와 빌드 통과. 기존 검사 실패는 근거와 함께 구분한다.
- [x] 독립 검토에서 발견한 문제를 보완하고 관련 회귀 검증을 통과시킨다.

## 검증과 인계

실제 결과와 남은 범위는 `docs/operations/output-purpose-validation.md`에 있다. 검증한 변경을 커밋·일반 푸시하고 원격 SHA를 대조한 결과는 인계 메시지로 보고한다. main 통합·운영 배포는 별도 단계다.
