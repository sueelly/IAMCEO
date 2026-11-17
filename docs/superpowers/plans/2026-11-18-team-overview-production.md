# 팀 요약·직원 상세·전체 지도 운영 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 승인된 팀 요약과 전체 지도를 기존 직원 상세에 연결하고 main과 운영 서비스에 반영한다.
**Architecture:** 기존 workflow 상태·관계·배정 계약과 MemberDetail의 제어를 유지한다. 읽기 전용 묶음 모델, 요약판·지도, 공통 업무 목록을 추가하고 반복되는 하단 기능의 진입점만 이동한다.
**Tech Stack:** TypeScript, React 19, 기존 Glass, Bun, Playwright. 신규 패키지 없음.
**Spec:** docs/superpowers/specs/2026-11-18-team-density-design.md

## Global Constraints

- 큰 업무의 진행·막힘 > 직원 참여 > 선후관계 순서로 강조하며 세 정보를 모두 제공한다.
- 직원 이름은 같은 직원 상세의 요약을, 업무와 수는 업무 탭을 연다. 직접 지시·결재·중단·전달 확인·터미널·실행 설정의 기존 검사를 보존한다.
- 실제 부모·직원별 순서만 그린다. unknown·막힘·미완료 이력은 완료로 바꾸지 않는다. 고유 업무와 담당별 표시 수를 구분한다.
- 요약에 없는 모든 업무·직원·진행판 기록은 목록·검색·메뉴에서 접근한다. 접기나 강조는 대기열과 상태를 변경하지 않는다.
- 드래그와 메뉴 배정은 기존 WorkflowAssignment의 미리보기·버전·영수증 확인을 거친다.
- 기존 Glass 토큰을 쓰고 상시 설명문을 추가하지 않는다. PC와 390px에서 검증한다.
- 개발은 현재 맥미니 별도 워크트리에서 한다. 운영 기록과 키는 Git 밖 private에 보존한다.
- 사용자가 이번 변경의 구현·main 통합·운영 반영을 승인했다. 공유 main은 일반 푸시하며 웹 서비스만 정상 재시작한다.

## Review Focus

1. 실시간 갱신으로 선택 업무/직원이 없어져도 팝업과 지도는 충돌하거나 다른 직원을 자동 선택하지 않는다.
2. 순환·누락 부모·직원 없는 완료·과거 담당도 집계와 전체 목록에서 사라지지 않는다.
3. 보드에 없는 진행판 기록, 잠든 직원, 직원 없는 프로젝트의 시작 경로를 보존한다.
4. 승인 대기와 전달 보류가 다른 탭에서도 발견 가능하고 지시 초안과 검토 버전은 유지된다.
5. 다수 묶음·긴 제목·양방향 관계·모바일에서 지도 경계와 초점 복귀를 유지한다.

### Task 1: 읽기 모델과 지도 범위

**Files:** Create `shared/workflow-map.ts`, `tests/workflow-map.test.ts`.
**Interfaces:** `workflowMap(tasks: Task[], flow: ProjectWorkflow)` → groups(id/title/taskIds/members/counts/blocked), links(from/to/edges), occurrences, byNode, taskMap. `workflowTaskNodes(nodes, ids)` → 상태 근거를 우선한 고유 업무 표시. 실제 실행 순서는 수정하지 않는다.

- [ ] 부모 묶음과 개별 업무의 중복 없는 합계, 중복 참여의 상태 우선순위, 원본 양방향 순서, 순환·부모 누락·완료 무담당 테스트를 먼저 작성한다.
- [ ] `bun test tests/workflow-map.test.ts`로 미구현 실패를 확인한다.
- [ ] 읽기 모델을 구현하고 `bun test tests/workflow-map.test.ts tests/workflow-view.test.ts tests/workflow-state.test.ts`가 모두 통과하는지 확인한다.
- [ ] 관련 파일만 `feat(team): ...` 형식으로 커밋한다.

### Task 2: 요약판·지도와 기존 직원 상세 통합

**Files:** Create `web/src/components/TeamOverview.tsx`, `WorkflowMap.tsx`, `TeamTaskList.tsx`, `WorkflowDetail.tsx`, `web/src/styles/team-overview.css`, `tests/team-overview.browser.ts`. Modify `WorkFlow.tsx`, `screens/Team.tsx`, `components/ui.tsx`, 관련 browser tests.
**Interfaces:** TeamOverview는 ProjectState와 신선도 판정한 WorkflowNode[], 관계, onSelect/onMember/onAssign/onFocus 콜백을 받는다. WorkFlow는 freshness 및 assignment 영수증의 소유자다. MemberDetail은 기존 member route를 유지하고 summary/tasks/activity/runtime 탭과 선택 node ID를 받는다. WorkflowDetail은 기존 원문 증거 조회를 재사용한다.

- [ ] 실제 격리 서버에서 11명·다수 업무를 준비해 고정 높이 행, 같은 직원 팝업, 모든 목록 수, 상태 탭, 지도 합계/연결/초점/검색을 검증하는 실패 검사를 작성한다. 승인·전달·시작·진행판 진입과 프로젝트 변경을 포함한다.
- [ ] `bun test ./tests/team-overview.browser.ts`로 요약 행 미구현 실패를 확인한다.
- [ ] 요약판과 지도, 공통 업무 상세, 직원 상세 탭, 상단 팀 메뉴를 구현한다. 하단 중복 렌더만 제거하고 실제 데이터·제어 API는 유지한다.
- [ ] 기존 브라우저 검사를 새 진입 동작으로 갱신한다. 상태·보호 검증의 강도를 낮추지 않는다. 드래그 배정과 충돌·응답 유실을 실제 격리 서버로 확인한다.
- [ ] `bun run typecheck`, 새 browser tests와 기존 workflow/queue/delivery/approval/stop browser tests를 통과시킨다.
- [ ] `bun test tests` 전체 결과를 기록하고 실패는 정확한 baseline 비교로 구분해 해결한다. `bun run build`를 확인한다.
- [ ] 검증한 변경을 커밋한다.

### Task 3: 검토·main·운영 반영

**Files:** Update `docs/operations/work-overview-rollout.md` with this rollout's validation; private receipts outside Git.
**Interfaces:** 최신 origin/main과 검증한 HEAD → origin feature/main 일반 푸시 → 정확한 Git SHA 릴리스 → com.iamceo.server 웹 재시작 → localhost:47878와 기존 Tailscale:14443 확인.

- [ ] 전체 변경을 새 검토자에게 읽기 전용 검토한다. 중요한 발견은 실패 검사부터 보완한다.
- [ ] 최신 main과 통합한 결과를 검증하고 작업 브랜치·main을 일반 푸시한 뒤 원격 SHA를 확인한다.
- [ ] 기존 plist/설정/SQLite 일관 백업과 직원 세대·core PID를 private에 기록한다. 해당 main SHA에서 빌드한 릴리스로 웹만 정상 재시작한다.
- [ ] 로컬·Tailscale build ID, 요약/직원 상세/전체 지도, 기존 작업·대화·결재 보존을 읽기 전용으로 확인하고 영수증을 남긴다. 실제 배정/직원 시작/승인 응답은 운영 검증에 사용하지 않는다.
