# 검증용 서버 수명 관리 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 검증 실행이 끝난 뒤 IAMCEO 테스트 서버가 누적되지 않게 한다.

**Architecture:** 테스트 전용 소유 scope에서 실행·종료 확인과 Bun 부모 감시를 관리한다. preload는 네이티브 감시를 유지하면서 제공자 환경 전파를 막는다. 운영 CLI와 실제 데이터는 변경하지 않는다.

**Tech Stack:** Bun, TypeScript, Playwright, 격리 core fixture.

**Spec:** docs/superpowers/specs/2026-11-17-test-server-lifetimes-design.md

## Global Constraints

실제 직원 실행·기존 대화·승인 상태·운영 서버·독립 core 세션을 보존한다. 모든 작업은 맥미니 01_Ing의 별도 워크트리에서 수행한다. 검증 후 작업 브랜치 커밋·origin 일반 푸시와 SHA 확인을 수행한다.

## Review Focus

- 준비 단계가 실패해도 이미 실행한 검증 서버가 등록돼야 한다.
- 검증 실행기가 SIGKILL로 종료돼도 자식 서버가 남지 않아야 한다.
- 종료에 응답하지 않는 검증 자식만 제한 시간 뒤 정리해야 한다.
- scope 밖의 프로세스와 운영 IAMCEO_HOME은 대상으로 삼지 않아야 한다.
- IAMCEO 종료 뒤 core가 소유한 진행 실행은 유지돼야 한다.

## Task 1: 검증 서버 등록과 종료

**Files:** tests/fixtures/test-server-scope.ts, tests/fixtures/test-server-watchdog-preload.ts, tests/test-server-scope.test.ts, tests/screens-regress.browser.ts, tests/cli.test.ts.

- [x] 기존 강제 종료 두 검사의 실패와 남는 서버를 재현한다.
- [x] 실제 Bun subprocess로 실패·정리 예산·부모 종료·다른 프로세스 보존을 검증한다. 부모 감시 제거 시의 실패와 환경 전파 실패를 각각 확인한 뒤 보수한다.
- [x] scope를 구현하고 screens-regress의 모든 검증 서버를 실행 즉시 등록한다. 기존 강제 종료 검사의 assertion과 격리 제한은 보존하고, 실패 뒤 서버가 정리됨을 확인한다.
- [x] 새 검사와 기존 강제 종료 검사, `bun run typecheck`, `bun test tests`, CI 단위 검사, `bun run build`를 수행한다. 기준부터 존재하는 실패는 구분해서 기록한다.
- [x] 독립 코드 검토를 수행하고 중요한 환경 전파 문제를 회귀 검사와 preload로 해결한다.
- 최종 전달 단계에서 검증한 변경을 커밋·푸시하고 원격 SHA를 확인한다.

## Task 2: 확인된 잔존 검증 서버 정리

- [x] 원래 검증 실행기가 없고 임시 DB·가짜 입력·검증용 설정이 확인된 서버 22개를 선별한다.
- [x] 비공개 영수증을 남기고 SIGTERM으로 22개를 종료한다. PID·포트 종료와 운영 서버 응답을 대조한다.
- [x] 수정 적용 범위와 기존 워크트리 재검증 시 주의점을 기록한다. 다음 개선은 공용 작업 대기열로 남긴다.

**Scope ruling:** 다른 browser suite와 컴파일된 CLI 감독 프로세스의 수명 보장은 이번 변경 범위 밖이다. 기존 제공자 fixture 실패는 제한 완화로 숨기지 않는다. 구체적 검증 결과는 `docs/operations/2026-11-17-test-server-lifetimes.md`에 기록한다.


## 후속 승인: main 통합과 기존 환경 적용

사용자가 최초 결과와 기존 검사 실패를 확인한 뒤 main 통합과 현재 환경 적용을 요청했다. 기존 작업 워크트리와 브랜치를 재사용한다.

- 최신 main `4b79e9b`를 충돌 없이 통합하고 최신 main의 나머지 내용을 보존한다.
- 통합 결과에서 두 Bun 버전의 관련 검사 32개, 타입 검사, 최신 빌드를 확인한다.
- CI 단위 파일 125개를 프로세스별로 검증한다. 결과 저장 경로를 준비한 뒤 재검사까지 반영한 집계는 2,210개 통과·기존 2개 실패다.
- 별도 개발 워크트리 13개에 테스트 관련 5개 파일만 적용하고, 각각 8개 검사 통과·커밋·일반 푸시·원격 SHA 일치를 확인한다. detached 비교 스냅샷 44개는 보존한다.
- 추가 고아 테스트 서버 20개를 식별 후 SIGTERM으로 종료하고 운영 HTTP 응답을 보존한다.
- 원래 수정이 main 이력에 포함되도록 일반 푸시하고, 깨끗한 기본 main 체크아웃을 fast-forward한다. 기존 데이터와 실제 세션을 보존하고 테스트 변경에 불필요한 운영 재시작은 하지 않는다.

판정 근거와 적용 커밋 목록은 운영 결과 문서 및 Git 밖의 `test-server-lifetimes-main/` 영수증에 보관한다. 기존 전체 검사 실패를 해결했다고 확대해 보고하지 않는다.
