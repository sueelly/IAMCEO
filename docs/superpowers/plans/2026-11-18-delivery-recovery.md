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

- [x] 없는·보관된·살아 있는 Codex 재개와 접근 오류의 회귀를 만들고 기존 실패를 확인한다.
- [x] 초기 비정상 종료, 동일 실패 재관측, 재구성, 명시적 재개의 회귀를 먼저 만든다.
- [x] 사용량/인증 분류, 한도 상태의 자동 전달 차단·정상 회복, 실제 대기 사유·해제의 회귀를 만든다.
- [x] 확인된 부재만 기존 인계 복구로 넘기고 실패 재실행을 멈춘다. 영속 오류와 대기 관측을 공통 계약·표시에 연결한다.
- [x] 관련 core/lifecycle/workflow/HTTP 회귀와 typecheck, 실제 브라우저를 검증한다.
- [x] 검증한 실행 변경을 fix(runtime) 커밋으로 저장한다.

## Task 2: 보고 길이를 권고로 전환

Files: server/agent-tools.ts, server/writing-lint.ts, 보고 설명·역할 문서 중 해당 부분. Tests: tests/report-length.test.ts 또는 기존 도구·하네스 검사.

- [x] 실제 도구 경계에서 긴 명령·근거·설명·인용이 길이 때문에 거절되는 회귀를 만들고 실패를 확인한다.
- [x] 보고 텍스트의 길이 상한을 권고로 바꾸고 성공 응답에 간결한 권고를 덧붙인다. 명령·근거 원문은 보존한다.
- [x] 긴 명령의 실행 연결과 실패 근거 거절을 검증한다. 식별자·배열 개수·HTTP 전송 한도 등 별도 계약은 유지한다.
- [x] 관련 검사·typecheck 통과 후 fix(reports) 커밋을 만든다.

## 통합 검증과 전달

- [x] 별도 보고 브랜치를 작업 브랜치에 통합하고 전체 검사 시도 결과와 기존 실패를 기록하고, 관련 회귀·typecheck·build 및 핵심 화면을 검증한다.
- [x] 변경을 독립 검토하고 필요한 수정·검증을 마친다.
- [x] 작업 브랜치를 origin으로 푸시하고 원격 SHA 일치를 확인한다.
- [x] 운영 반영 여부를 실제 릴리스·readiness·Tailscale 결과로 구분해 기록한다.

## 검증 결과 (2026-11-18)

- 운영에 반영된 main `0c70c4f`를 작업 브랜치에 통합했다. 배포된 v1–v39 SQL은 변경하지 않고 오류 상태 열을 v40으로 추가했다.
- 통합본의 관련 검사 311개, 실제 브라우저 검사 24개(직원 상태 4개·업무 흐름 11개·새 관리판 9개), typecheck와 Bun 1.3.14 컴파일이 통과했다.
- 독립 검토에서 찾은 서버 비가동 중 종료, 오류 후 종료 이벤트 누락, 한도 미해소 재확인, 보류 사유 우선순위, 세션 교체 세대의 불확실 생성 보호를 각각 재현하고 수정했다. 재검토의 남은 차단 이슈는 없다.
- 전체 검사 시도는 통과하지 못했다. 기준판 `2f51d9b`에서도 저장소 최적화 검사 두 건과 브라우저의 총괄 생성 실패가 재현됐다. 전체 실행은 최종 합계 없이 exit 137로 종료됐으며 원인을 확정하지 않았다. 이후 관련 검사와 위 세 브라우저 묶음은 통합본에서 새로 통과했다.
- 작업 브랜치의 일반 푸시와 원격 SHA 대조를 완료했다. 이 문서 이후 문서 커밋을 포함한 최종 SHA는 별도 작업 영수증으로 확인한다.
- 운영의 전역 한도 20과 로컬·Tailscale readiness는 재확인했다. 이 변경의 main 반영·배포는 아직 수행하지 않았다.

## 운영 배포 승인 후 최신 main 통합

사용자는 전역 한도 20을 유지하며 운영 배포하도록 승인했다. 위 결과는 승인 전 기록이며, 배포할 최종 통합본은 다음과 같이 추가 검증했다.

- 운영된 main `5140c39`의 완료 기준·프로젝트 한도·반복 실패 정책을 보존했다. 이미 배포된 v40 SQL도 그대로 두고 오류 상태 열은 v41로 추가한다.
- 전역 20과 프로젝트별 한도를 DB 이주·Store 재구성 뒤에도 유지하는 회귀와 별도 대기 표시를 검증했다. 실제 운영 DB의 일관된 복사본도 v40에서 v41로 이주했고 전역 20과 외래 키 무결성을 확인했다.
- 시작 중 한도 오류를 관측한 후 입력이 한 번 전달되는 경합을 재현했다. 세션 준비 후와 물리 전송 직전에 현재 실패 상태를 다시 읽도록 수정했다. 세 개의 실패 회귀를 먼저 확인했고, 독립 재검토에서도 전송 0회·시도 0회·대기 입력 보존을 확인했다.
- 최종 관련 검사 435개와 타입 검사가 통과했다. 화면 변경 통합 후 실제 브라우저 검사 26개(직원 상태 4개·업무 흐름 11개·업무 관리판 9개·프로젝트 한도 2개)가 통과했다. 전체 검사 시도의 기존 실패·exit 137 기록은 위와 같다.
- 빌드, 컴파일된 실행 파일의 격리 검사, 일반 푸시 및 원격 SHA 대조, 운영 백업과 웹 재시작, 로컬·Tailscale 검증은 `docs/operations/delivery-recovery-rollout.md`의 절차와 Git 밖 배포 영수증으로 기록한다. 이 계획 문서는 운영 성공 영수증이 아니다.
