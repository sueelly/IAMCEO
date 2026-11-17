# IAMCEO 출력의 대상과 맥락 보존 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans. 이 세션에서 순서대로 구현하고 마지막에 변경 전체를 검토한다.

**Goal:** 대화·자료·팀 상태·보고·결재를 며칠 뒤 읽어도 업무와 판단 대상을 알 수 있게 한다.
**Architecture:** 모든 역할에 공통 작성 지침을 적용하고 도구 설명과 검사 경고를 같은 기준으로 맞춘다. 자동 후속 요청문은 이미 저장된 업무·지시·보고·계약을 읽어 구체적인 맥락을 포함한다.
**Tech Stack:** TypeScript, Bun, SQLite, Markdown 역할 템플릿.
**Spec:** docs/superpowers/specs/2026-11-18-report-context.md

## Global Constraints

- 맥미니의 별도 워크트리에서 실행한다. 운영 데이터와 다른 작업의 변경을 보존한다.
- 수치·시점·원문·불확실성을 보존한다. 글 검사 경고는 보고를 거절하지 않는다.
- 기존 승인·자동 실행·완료 판정 동작은 변경하지 않는다.

## Review Focus

- 사용자 정의 역할과 이전 내보내기 파일에서도 최신 공통 지침이 빠지지 않는지 확인한다.
- 긴 설명이나 근거 링크가 있다는 이유만으로 맥락 삭제를 권하지 않는지 확인한다.
- 원문 지시와 최근 보고가 없거나 업무가 다를 때 다른 내용을 근거로 연결하지 않는지 확인한다.
- 후속 조정 횟수와 실제 구현·검증 횟수, 확정 계약과 제안 계약을 혼동하지 않는지 확인한다.
- 설명 보완이 승인 응답·재전송·완료 처리를 만들지 않는지 확인한다.

### Task 1: 공통 프롬프트·도구·검사 경고 정합성

**Files:** server/roles/writing.md, server/roles.ts, server/roles/{worker,conductor,root}.md, server/agent-tools.ts, server/writing-lint.ts, tests/writing-{guide,lint}.test.ts.
**Interfaces:** renderRole과 lintPost/lintAsk/lintFile를 유지한다. 팀 상태에도 같은 비차단 맥락 경고를 적용한다.

- [x] 사용자 정의 역할에 최신 지침이 전달되지 않는 사례와, 구체적인 긴 보고를 불필요하게 줄이라는 경고를 먼저 재현한다.
- [x] 10가지 원칙과 최소 맥락을 공통 지침에 기록하고 역할·도구 설명의 충돌을 제거한다.
- [x] 검사 경고를 모호한 참조·확인 상태에 집중하고 강제 축약·일괄 용어 치환을 제거한다.
- [x] `bun test tests/writing-guide.test.ts tests/writing-lint.test.ts tests/terminal-approval-guide.test.ts`의 실패 0건을 확인한다.

### Task 2: 자동 후속 조정문에 실제 업무 맥락 포함

**Files:** server/task-continuation.ts, 새 server/task-context.ts, server/store.ts, server/orchestrator.ts, tests/task-continuation.test.ts, tests/task-context.test.ts, tests/task-stage.test.ts.
**Interfaces:** task context formatter는 Store와 Task 및 ProgressFacts를 읽고 Markdown 텍스트를 반환한다. coordinator의 실행 조건과 저장 상태는 유지한다.

- [x] 후속 조정을 끝낸 뒤 생성한 결재에 프로젝트·업무·원문 요청·보고 내용·남은 검사·시각이 없는 실패를 먼저 확인한다.
- [x] 같은 업무의 저장된 원문과 계약을 포함하고 누락과 제안을 구분한다. 식별자는 대상 이름과 함께 상세에 둔다.
- [x] `bun test tests/task-continuation.test.ts tests/task-continuation-runtime.test.ts tests/task-progress.test.ts tests/harness-completion-corrections.test.ts`의 실패 0건을 확인한다.
- [x] 타입 검사·빌드와 전체 검사를 실행하고 기존 실패는 변경 기능의 결과와 구분한다.

## 검증과 인계

검증 결과와 전체 검사에서 남은 문제는 `docs/operations/report-context-validation.md`에 기록했다. 변경 기능의 검사는 통과했고 전체 검사 통과는 확인하지 못했다. 인계 시 검증한 변경을 커밋·일반 푸시하고 원격 SHA를 대조한다. main 통합·운영 배포는 별도 상태로 보고한다.
