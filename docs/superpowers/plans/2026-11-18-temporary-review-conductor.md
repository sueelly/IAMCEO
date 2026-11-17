# Temporary Review Conductor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans; execute regression-first.

**Goal:** God에 정식 권한의 임시 검수 총괄 한 명을 추가하고 인계·대기열 처리·안전한 종료를 연결한다.
**Architecture:** 기존 conductor 세션과 addMember를 재사용하는 대표 API를 추가한다. 기본 총괄 선택은 유지하며 원문/작업 검증과 단일 임시 총괄 제한을 둔다. 운영 인계·종료 자료는 Git 밖 private 경로에 보존한다.
**Tech Stack:** TypeScript, Bun, SQLite, 기존 인증 HTTP와 Codex CLI.
**Spec:** docs/superpowers/specs/2026-11-18-temporary-review-conductor.md

## Global Constraints
- 맥미니의 지정 워크트리에서만 소스를 변경한다. 기존 원격·미커밋·직원·승인 상태를 보존한다.
- 모델 gpt-6-astra, effort xhigh, Fast. 원본 총괄과 일반 직원 수는 유지한다.
- 정식 생성·종료만 사용한다. 직접 DB 변경·토큰 노출·허위 완료·자동 승인 금지.

## Review Focus
- 다른 프로젝트나 직원의 글로 총괄 권한을 만들지 못한다.
- 동시/중복 생성에도 한 명만 생기고 기본 총괄이 바뀌지 않는다.
- 새 총괄이 실제 conductor 도구를 얻으며 직원 한도에 섞이지 않는다.
- 종료는 미확정 전달과 진행 실행이 없는 경우만 한다.

### Task 1: 대표용 임시 총괄 생성 경로
Files: shared/types.ts, server/http.ts, server/orchestrator-api.ts, server/orchestrator.ts, tests/temporary-conductor.test.ts 또는 관련 기존 검사.
- [ ] 같은 프로젝트 대표 원문·작업 검증, 중복 생성, 기본 총괄 보존, conductor 도구·실행 설정의 실패 회귀를 먼저 작성하고 RED를 확인한다.
- [ ] POST /api/projects/:id/temporary-conductor와 createTemporaryConductor를 추가한다. 입력은 name/role/sourceMessageId/taskId/modelOverride/effortOverride/parallel이다. 기존 대표 글·작업을 대조하고 기존 primary 외 추가 conductor 한 명만 허용한다. 재요청은 동일 생성으로 판별할 때만 기존 세션을 반환한다. 기존 addMember(kind:conductor)를 사용한다.
- [ ] 관련 회귀·타입·전체 검사와 빌드를 실행한다. 새 실패와 기준판 실패를 구분한다.
- [ ] 독립 검토·수정 검증 후 문서와 코드를 커밋하고 작업 브랜치를 origin에 일반 푸시해 SHA를 확인한다.

### Task 2: 맥락 인계·실제 세션 연결
- [ ] 전체 프로젝트 기록·원본 native transcript를 private snapshot으로 보존하고 개수·해시·대기열을 manifest에 남긴다.
- [ ] 검증된 릴리스의 기존 배포 절차를 확인해 운영 세션을 보존한다. 고정된 소스·실행 build를 기록한다.
- [ ] 새 Astra/xhigh/Fast 총괄에 전체 인계 경로와 검수 소유권·승인 범위·종료 조건을 전달하고 실제 수신·실행·도구 권한을 확인한다.
- [ ] 기존 총괄에게 대기열 검수 소유권과 인계를 연결하고 중복 검수를 방지한다.
- [ ] 모든 대기 검수와 파생 재검수가 해결된 뒤 인계·종료 조건을 검사해 정식 close로 임시 직원을 제거한다. 미완료 기간에는 실행과 종료 감시를 유지하고 상태를 사실대로 보고한다.
