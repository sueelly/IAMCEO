# 남은 구현 검토 및 통합 실행 계획

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. The user authorized execution and integration; continue without another planning approval.

**Goal:** 최신 조정 전용 총괄 정책을 지키면서 남은 구현을 검토하고 검증된 변경을 main과 운영에 반영한다.
**Architecture:** 최신 원격 main의 별도 워크트리에서 후보를 고정해 하나씩 대조한다. 기존 테스트를 먼저 재현하고 통합 충돌·발견된 결함은 실패 회귀부터 수정한다. 취소·대체·중복 후보는 사유를 기록한다.
**Tech Stack:** Bun 1.3.14, TypeScript, React, SQLite, Playwright, 기존 launchd/Tailscale.
**Spec:** docs/superpowers/specs/2026-11-18-reviewed-integration.md

## Global Constraints
- 작업 워크트리 `integrate-reviewed-work-01a1eacb`, 브랜치 `fix-integrate-reviewed-work-01a1eacb`만 수정한다.
- 총괄의 최신 읽기·조정 전용 도구 경계를 보존한다. 취소된 임시 공동 총괄은 합치지 않는다.
- 실제 지시 재송신·승인 입력·완료 판정·운영 DB 직접 수정은 하지 않는다. 기존 직원 실행과 다른 작업을 보존한다.
- 테스트는 작업 소유의 격리 DB/소켓/CLI를 사용한다. 운영 자료와 배포 영수증은 Git 밖 0700 경로에 둔다.
- 원격 main이 바뀌면 합친 결과를 다시 검증한다. 강제 푸시·미커밋 덮어쓰기·직원 프로세스 종료를 하지 않는다.

## Review Focus
- 옛 총괄 템플릿이나 통합 충돌이 명령 실행·직원 승인 창 입력을 다시 허용하지 않는다.
- 독립 전달 허용 뒤 계약·부모·세대·결재 조건이 바뀌면 실제 쓰기 직전에 거절한다.
- workdir 후보의 옛 이주 번호·명시 경로가 기존 DB 열과 최신 실제 cwd 검사를 훼손하지 않는다.
- 신규 팀/문서 화면이 승인·중단·초안·자료 접근과 모바일 초점 경로를 잃지 않는다.
- Agent-A의 문서 판·요청 ID·도식 좌표가 다른 본문/문서/갈래에 재사용되지 않는다.

### Task 1: 총괄 역할과 적용 대상 판정
**Files:** 현재 역할/정책 소스 읽기; `docs/operations/reviewed-integration.md` 기록.
**Interfaces:** 최신 main 정책과 고정 후보 SHA → 반영/제외 목록.
- [ ] 옛 boundary-conductor와 최신 conductor-role-policy를 대조하고 차이를 기록한다.
- [ ] `tests/conductor-policy.test.ts`, `tests/conductor-codex-native.test.ts`를 실제 격리 CLI 설정으로 검증한다.
- [ ] 취소된 임시 총괄·중복 패치·역사 백업을 제외하고 다음 후보 범위를 고정한다.

### Task 2: 독립 전달 복구와 승인/연결 게이트 후속 수정
**Files:** `server/independent-delivery.ts`, delivery/orchestrator/http/store/shared workflow, 제출/연결 화면과 전용 테스트.
**Interfaces:** 기존 delivery ID와 대표 인증 영수증 → 현재 계약/순서 검사를 보존한 단일 전달; 명시적 전송 거절 → 초안 복원.
- [ ] 고정 후보의 전용 실패 검사를 최신 main에서 먼저 확인한다.
- [ ] 후보 변경을 통합하고 최신 dispatch snapshot·계약·보류·총괄 역할 제한과 충돌을 해결한다.
- [ ] 독립 전달·전송 직전 경계·순서·복구·core capacity·archive gate·web submissions와 관련 화면 검사를 통과시킨다.
- [ ] 타입 검사 후 검증된 변경을 커밋한다.

### Task 3: 검사별 실행 위치 후보 판정과 통합
**Files:** harness evidence/diagnostics/workdir, db/store/types, 전용 migration/경로 검사.
**Interfaces:** 명시 검사 workdir와 등록된 task worktree → 실제 명령 cwd와 범위가 확인된 증거만 인정.
- [ ] 현재 배포의 파일 URL/워크트리 보완과 중복·추가 동작을 대조한다.
- [ ] 추가 동작이 필요하면 경로 이탈·이주 충돌·기존 행 보존 실패를 먼저 재현한다. 중복 또는 안전성 충돌이면 후보를 제외하고 근거를 기록한다.
- [ ] 통합한 경우 관련 harness·증거 재사용·이주/재열기 검사와 타입 검사를 통과시켜 커밋한다.

### Task 4: 팀 요약/지도 후보 검토와 통합
**Files:** `shared/workflow-map.ts`, Team/WorkFlow 및 새 TeamOverview/WorkflowMap/WorkflowDetail/TeamTaskList, 화면 검사.
**Interfaces:** 기존 ProjectWorkflow와 신선도 → 요약/지도/직원 상세; 제어는 기존 API와 영수증 경로 유지.
- [ ] 마지막 완성된 소스판을 고정하고 원 작업의 미커밋 변경은 보존한다.
- [ ] workflow-map·team-overview·workflow·delivery/queue/approval 화면 검사를 검증한다.
- [ ] 최신 main과 합친 뒤 발견한 결함은 실패 검사부터 고쳐 커밋한다.

### Task 5: Agent-A 후보와 현재 수정 조건 확인
**Files:** Agent-A integrations/shared/web modules 및 전용 unit/browser/real contract 검사.
**Interfaces:** 실제 Agent-A 문서/판/요청 계약 → IAMCEO 자료 화면과 정확한 댓글·초안·도식 대상.
- [ ] 독립 검토의 남은 반례와 실제 연동 전제를 확인하고 고정 후보에서 재현한다.
- [ ] 최신 main·실행 권한·자료 조회와 호환되게 통합한다. 필요한 결함은 실패 회귀부터 수정한다.
- [ ] 실제 연동 검증을 포함한 필요한 검사가 충족되면 커밋한다. 해결할 수 없는 외부 조건이나 명시적 보류는 정확한 근거와 함께 기록하고 미검증 코드는 배포하지 않는다.

### Task 6: 독립 검토·main·운영 검증
**Files:** 검증 기록, 기존 빌드/서비스 절차; 운영 영수증은 private 경로.
**Interfaces:** 검증된 통합 HEAD → 동일 GitHub main/릴리스 SHA와 기존 세션·자료 보존.
- [ ] 통합 범위의 필수 회귀·타입·빌드 및 정책 검사를 실행한다. 기준판 실패는 동일 조건으로 구분한다.
- [ ] 새 검토자의 전체 변경 검토를 받고 중요한 발견을 실패→통과로 검증한다.
- [ ] 작업 브랜치와 main을 일반 푸시하고 원격 SHA를 확인한다.
- [ ] 정확한 원격 main 바이너리를 격리 검증한 후 웹 서비스만 정상 재시작한다.
- [ ] 로컬/Tailscale 준비 상태·빌드·ID·세션·설정·메모리·한도·경로 보존과 변경 기능을 확인한다.
