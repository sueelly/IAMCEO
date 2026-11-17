# 실행 복구와 대기 원인 표시 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for the runtime task. The independent report task is delegated through superpowers:dispatching-parallel-agents. Each task follows regression-first implementation.

**Goal:** 반복 시작을 막고 제공자 오류와 전달 대기를 구분하며 긴 보고를 접수한다.
**Architecture:** CoreRunner에서 재개 대화를 확인하고 Orchestrator에서 영속 오류와 실제 전달 대기 원인을 관리한다. 기존 공통 타입·Store·워크플로·웹 표시가 같은 상태를 사용한다. 보고 도구는 텍스트 길이 검사만 권고로 바꾸고 근거 검증은 유지한다.
**Tech Stack:** TypeScript, Bun, SQLite, React, 기존 core RPC.
**Spec:** docs/superpowers/specs/2026-11-18-delivery-recovery-design.md

## Global Constraints

- 맥미니의 별도 작업 워크트리에서 작업한다. 운영 설정의 전역 한도 20을 유지한다.
- 대화·미확인 전달·승인·다른 작업을 보존한다. 비밀·실행 로그를 소스에 커밋하지 않는다.
- 검증한 변경만 커밋하고 origin 작업 브랜치로 일반 푸시한다.

## Review Focus

- 저장 대화 조회의 접근 오류를 부재로 오인하지 않는지 시험한다.
- 살아 있는 소유 터미널은 파일 기록이 아직 없어도 재사용하는지 시험한다.
- 같은 실패가 poll 및 서버 재시작에서 새 실행을 반복하지 않는지 시험한다.
- 한도 해소 후 정상 작업의 대기 표시가 남지 않는지 시험한다.
- 긴 명령이 그대로 실행 근거와 대조되며 거짓 완료를 통과시키지 않는지 시험한다.

## Task 1: 실행 복구·한도·대기 원인

Files: server/runner/core.ts, server/orchestrator.ts, server/store.ts, server/db.ts, shared/types.ts, server/workflow.ts, web/src/screens/Team.tsx, 관련 공통 표시 모듈. Tests: tests/core-runner.test.ts, tests/lifecycle-recovery.test.ts, tests/workflow-queue-regression.test.ts, tests/workflow-state.test.ts 및 격리 브라우저 검사.

- [ ] 없는·보관된·살아 있는 Codex 재개와 접근 오류의 회귀를 만들고 기존 실패를 확인한다.
- [ ] 초기 비정상 종료, 동일 실패 재관측, 재구성, 명시적 재개의 회귀를 먼저 만든다.
- [ ] 사용량/인증 분류, 한도 상태의 자동 전달 차단·정상 회복, 실제 대기 사유·해제의 회귀를 만든다.
- [ ] 확인된 부재만 기존 인계 복구로 넘기고 실패 재실행을 멈춘다. 영속 오류와 대기 관측을 공통 계약·표시에 연결한다.
- [ ] 관련 core/lifecycle/workflow/HTTP 회귀와 typecheck, 실제 브라우저를 검증한다.
- [ ] 검증한 실행 변경을 fix(runtime) 커밋으로 저장한다.

## Task 2: 보고 길이를 권고로 전환

Files: server/agent-tools.ts, server/writing-lint.ts, 보고 설명·역할 문서 중 해당 부분. Tests: tests/report-length.test.ts 또는 기존 도구·하네스 검사.

- [ ] 실제 도구 경계에서 긴 명령·근거·설명·인용이 길이 때문에 거절되는 회귀를 만들고 실패를 확인한다.
- [ ] 보고 텍스트의 길이 상한을 권고로 바꾸고 성공 응답에 간결한 권고를 덧붙인다. 명령·근거 원문은 보존한다.
- [ ] 긴 명령의 실행 연결과 실패 근거 거절을 검증한다. 식별자·배열 개수·HTTP 전송 한도 등 별도 계약은 유지한다.
- [ ] 관련 검사·typecheck 통과 후 fix(reports) 커밋을 만든다.

## 통합 검증과 전달

- [ ] 별도 보고 브랜치를 작업 브랜치에 통합하고 전체 npm test/bun test, typecheck, build 및 핵심 화면을 확인한다. 기존 실패는 기준판과 대조해 이름을 기록한다.
- [ ] 변경을 독립 검토하고 필요한 수정·검증을 마친다.
- [ ] 작업 브랜치를 origin으로 푸시하고 원격 SHA 일치를 확인한다.
- [ ] 운영 반영 여부를 실제 릴리스·readiness·Tailscale 결과로 구분해 기록한다.
