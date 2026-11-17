# 업무 관리판과 배정 인계 구현 계획

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking. 사용자는 2026-11-18 설계를 승인하고 기존 디자인 시스템에 맞춘 구현을 지시했다. 이미 승인된 구현 방법을 다시 묻지 않고 현재 세션에서 구현하며 마지막에 독립 검토를 수행한다.

**Goal:** 직원별 완료·현재·다음 업무, 연결 집중 보기와 검토 후 배정을 기존 디자인 시스템에서 제공한다.

**Architecture:** 서버의 완전한 workflow 스냅샷을 공통 분류 함수로 표시한다. 인계 미리보기는 서버가 만들고 내용과 큐의 지문을 확정 요청에서 재검증한다. 배정·원문 연결·전달 큐·영수증은 같은 SQLite 트랜잭션으로 저장하며 기존 pump가 실제 전달을 수행한다.

**Tech Stack:** Bun, SQLite, TypeScript, React, 기존 Glass/GlassButton/Modal/Sheet와 CSS tokens, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-18-work-overview-design.md` (2026-11-18 사용자 승인, 디자인 시스템 준수 추가).

## Global Constraints

- 기존 원본 터미널·운영 데이터·실행·승인을 변경하지 않는다. 시험은 가짜 실행기와 격리 DB에서 수행한다.
- 미배정 업무의 신규 배정만 제공한다. 이미 받은 업무·실행 중인 업무를 이동하거나 입력 보호를 우회하지 않는다.
- 후보에 확정 계약이 없으면 배정을 막는다. 기존 계약을 새로 확정하거나 기존 승인에 자동 응답하지 않는다.
- task ID, 확정 계약 판, 원문·자료와 제한을 보존한다. 다른 프로젝트 자료를 인계하지 않는다.
- 업무 완료와 턴 종료를 구분한다. 미확인 옛 기록을 완료로 접거나 큐에 자동 등록하지 않는다.
- 현재 Store.listTasks/projectWorkflow는 프로젝트 전체를 반환한다. 이 완전한 스냅샷으로 집계·집중 보기를 계산하고 50개 메시지 창에 의존하지 않는다. 제품 전체의 작업 페이지 API 교체는 이번 구현에 포함하지 않는다.
- 공통 디자인 토큰과 Glass 구성요소를 사용하고 네트워크 그래프 라이브러리를 추가하지 않는다.
- 브랜치 `design-show-work-overview-01a1ea05`, 워크트리 `/Users/hyejookim/Programming/01_Ing/.worktrees/IAMCEO/work-overview-01a1ea05`를 유지한다. 검증 후 커밋·일반 푸시·원격 SHA 확인을 수행한다.

## Review Focus

- 검토를 연 뒤 계약·대상 세대·배정·큐가 바뀌면 이전 검토로 배정하지 않는다. Task 2에서 충돌·동시 요청을 검사한다.
- 응답 유실과 중복 클릭은 같은 업무를 두 번 전달하지 않는다. Task 2에서 재시작·동일 ID·다른 ID 경합을 검사한다.
- 같은 업무의 복수 직원 노드와 순환 파생 관계는 수를 부풀리거나 무한 탐색하지 않는다. Task 1에서 고정한다.
- 오래된 기록·연결 단절·승인 대기는 완료로 보이거나 실행 중으로 강조되지 않는다. Task 1과 3에서 확인한다.
- 프로젝트 변경과 늦은 응답·키보드·모바일 입력은 다른 프로젝트에 쓰거나 조작을 잃지 않는다. Task 3에서 브라우저 검증한다.

## Task 1: 완료·현재·다음 분류와 관계 탐색

**Files:** `shared/workflow.ts`, 새 `shared/workflow-view.ts`, `server/workflow.ts`, 새 `tests/workflow-view.test.ts`, `tests/workflow-state.test.ts`.

**Interfaces:** `workflowBucket(node): 'done'|'now'|'next'|'unassigned'`, `workflowFocus(workflow,nodeId,depth): Set<string>`, `workflowSummary(nodes): Record<WorkflowFilter,number>`, `WorkflowFilter = 'all'|'action'|'running'|'next'|'done'|'unassigned'`를 제공한다. Task 3가 사용한다.

- [ ] 옛 보완·미확인 기록이 현재에 남고, 큐는 바뀌지 않는 회귀를 먼저 작성한다. 복수 담당의 고유 업무 집계와 직접/묶음 탐색·순환을 검사한다.
- [ ] `bun test tests/workflow-view.test.ts tests/workflow-state.test.ts`를 실행해 새 반례 실패를 확인한다.
- [ ] 순서 도입 전 표시보다 실제 단계·막힘을 우선한다. 결과 미확인 옛 기록의 라벨을 명확히 하고 순서 등록은 바꾸지 않는다. 분류·집중·집계 함수를 구현한다.
- [ ] 같은 검사와 `bun run typecheck`가 통과하면 `feat(workflow): 완료 현재 다음 분류와 연결 탐색 추가`로 커밋한다.

## Task 2: 검토 가능한 인계와 원자적 배정 API

**Files:** 새 `server/workflow-assignment.ts`, `shared/workflow.ts`, `server/store.ts`, `server/db.ts`, `server/orchestrator.ts`, `server/orchestrator-api.ts`, `server/http.ts`, 새 `tests/workflow-assignment.test.ts`.

**Interfaces:** `WorkflowAssignmentPreview`는 task/member, 확정 계약, 원문·최근 보고·자료 참조, 제약, 순서, blockers, revision을 제공한다. `WorkflowAssignmentRequest`는 operationId/memberId/revision이다. `WorkflowAssignmentResult`는 operationId/projectId/taskId/memberId/deliveryId/createdAt이다. `previewWorkflowAssignment(store,projectId,taskId,memberId)`와 `commitWorkflowAssignment(store,projectId,taskId,request)`를 서버 모듈에 둔다. 오케스트레이터 `assignWorkflow`가 커밋 후 기존 pump를 호출한다.

**Routes:** `GET /api/projects/:id/workflow/tasks/:taskId/assignment?memberId=...`, 같은 경로의 `POST`, `GET /api/projects/:id/workflow/assignments/:operationId`.

- [ ] 확정 계약·과거 50건 밖 원문·지켜야 할 조건·다른 프로젝트 자료 배제와 GET 무실행을 검사한다. 계약/대상/큐 변경, 기존 배정·보류·수신 불확실·미확정 계약·중단·반복 감시와 재시작 중복을 검사한다.
- [ ] `bun test tests/workflow-assignment.test.ts`에서 신규 기능 부재의 실패를 확인한다.
- [ ] Store에서 업무와 부모 원문·자료를 제한된 조회로 수집하되 생략 범위를 명시한다. 필수 계약 조건은 생략하지 않는다. 검토 지문은 인계 내용, 현재 계약, 관련 큐·세대·보호 상태를 포함한다.
- [ ] 새 전용 배정 영수증 테이블을 추가한다. 기존 operation_receipts의 kind CHECK를 확장하려고 표를 재작성하지 않는다. 배정 트랜잭션에서 다시 검증하고 전달과 영수증을 함께 저장한다. 같은 operation ID는 같은 결과, 다른 본문은 409다.
- [ ] 인증된 HTTP 경계에 엄격 schema·범위·읽기 전용 방어를 추가한다. 실제 전송은 기존 pump만 사용한다. 인계 GET과 영수증 GET은 실행하지 않는다.
- [ ] 신규 검사·`tests/operations-http.test.ts`·`tests/workflow-queue-regression.test.ts`·타입 검사가 통과하면 `feat(workflow): 맥락을 보존하는 배정 검토와 전달 추가`로 커밋한다.

## Task 3: 디자인 시스템에 맞춘 관리판과 조작

**Files:** `web/src/components/WorkFlow.tsx`, 새 `web/src/components/WorkflowAssignment.tsx`, `web/src/styles/workflow.css`, `web/src/lib/api.ts`, `tests/workflow.browser.ts`, 새 `tests/workflow-overview.browser.ts`.

**Interfaces:** Task 1의 순수 함수와 Task 2의 DTO/API를 사용한다. API 클라이언트에 `workflowAssignmentPreview`, `assignWorkflow`, `workflowAssignmentReceipt`를 추가한다. 검토 컴포넌트는 projectId/taskId/initialMemberId와 onClose를 받는다.

- [ ] 실제 격리 서버에서 고정 열, 옛 막힘 유지, 우클릭·메뉴·복원, 드래그의 대상 고정, 배정 확인·취소, 미확정 거절, 응답 유실·프로젝트 전환과 모바일 회귀를 먼저 작성한다.
- [ ] 신규 브라우저 검사가 기존 화면에서 실패하는 것을 확인한다.
- [ ] Glass 판과 기존 카드 토큰, GlassButton, Modal/Sheet를 사용한다. 완료는 최근 3개를 표시하고 현재의 막힌 일은 접지 않는다. 기본 판에는 관계선을 숨기고 지도/집중 보기에는 같은 노드에 선을 연결한다.
- [ ] 미배정 카드의 드래그와 메뉴가 같은 검토 창을 연다. 최신 검토 전에는 배정할 수 없고 응답 유실 시 영수증 확인만 제공한다. 프로젝트·인증 세대가 바뀌면 읽기를 취소하고 이전 요청 결과를 버린다.
- [ ] 1440px와 390px, 키보드 초점, 연결 단절·90초 관측 만료, 공통 토큰 적용을 확인한다. 기존 모바일 가로 스크롤 검사는 승인된 세로 재배치 기준으로 갱신한다.
- [ ] 신규·기존 브라우저 검사, 관련 workflow 검사, 타입 검사와 빌드를 통과하면 `feat(workflow): 디자인 시스템으로 업무 관리판과 배정 연결`로 커밋한다.

## Task 4: 전체 변경 검토와 전달

**Files:** 설계·계획·검증 기록과 작업 소유 화면 이미지.

- [ ] 독립 검토자에게 전체 변경과 승인된 설계·위험 경계를 전달한다. 중요한 발견은 실패 회귀를 먼저 고정하고 수정한다.
- [ ] 관련 workflow·배정·계약·HTTP·동기화 회귀, 타입 검사·빌드·브라우저 검증을 마친다. 전체 저장소 검사와 변경 관련 검사를 구분해 기록한다.
- [ ] 실제 제품의 격리 화면 이미지를 저장하고 기존 독립 HTML/Markdown 링크를 유지한다. 제품 구현·작업 브랜치 푸시와 운영 적용 여부를 구분한다.
- [ ] 최종 변경을 커밋하고 origin에 일반 푸시한 뒤 원격 SHA와 HEAD 일치를 확인한다.
