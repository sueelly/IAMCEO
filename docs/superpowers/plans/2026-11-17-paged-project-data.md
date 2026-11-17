# 자료·대화 점진 조회 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 외부 기기가 자료 전체 대신 20개 요약과 선택한 본문만 받고, 대화는 최신 50개부터 읽게 한다.

**Architecture:** 기존 계약은 유지하고 capability로 가벼운 상태 조회를 협상한다. SQLite 커서 페이지 API, 조건별 인덱스, 취소 가능한 웹 목록·상세 조회와 무한 스크롤을 연결한다. 큰 GET JSON 응답은 gzip을 협상한다.

**Tech Stack:** Bun, SQLite, TypeScript, React 19, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-17-paged-project-data-design.md`

## Global Constraints

- 자료 20개, 대화 50개를 페이지 기본 단위로 사용한다.
- 업무·종류·프로젝트가 다른 응답을 혼합하지 않는다.
- 인증·대화·승인·실행 상태와 기존 네이티브 API 계약을 보존한다.
- 검증한 변경만 커밋하고 origin에 일반 푸시한 뒤 SHA를 확인한다.

## Review Focus

- 업무를 빠르게 바꿀 때 느린 이전 응답이 새 목록을 덮어쓰지 않아야 한다.
- 새 자료 추가·페이지 경계 삭제·같은 생성 시각에서도 중복과 누락이 없어야 한다.
- 직접 링크의 자료는 첫 페이지와 다른 업무 밖에서도 열려야 한다.
- 실시간 갱신이 이미 읽은 과거 대화와 자료의 스크롤을 잃게 하지 않아야 한다.
- 압축하지 않는 클라이언트와 기존 네이티브 클라이언트가 계속 동작해야 한다.

### Task 1: 서버의 자료 페이지와 가벼운 상태 조회

**Files:** `shared/types.ts`, `shared/operations.ts`, `server/db.ts`, `server/store.ts`, `server/http.ts`, `tests/file-paging.test.ts`, `tests/http.test.ts`.

**Interfaces:** `FilePageOptions {taskId?, kind?, cursor?, limit?}`, `FilePage {projectId, items, nextCursor, hasMore, counts}`; `Store.listFilePage(projectId, options)`; GET `/api/projects/:id/files/page`; GET `/api/files/:id`; compact state query negotiated by capability.

- [ ] 커서 경계·조건 검증·본문 제외·업무별 인덱스·legacy 계약 보존 회귀 검사를 먼저 작성하고 실패를 확인한다.
- [ ] 자료 요약 SELECT, 인덱스 migration, 페이지·상세 HTTP와 compact 상태를 구현한다.
- [ ] 새 검사와 HTTP·Store·migration·대화 페이지 회귀 검사를 통과하고 커밋한다.

### Task 2: 웹의 비동기 목록과 대화 단위 축소

**Files:** `web/src/lib/api.ts`, `web/src/lib/store.ts`, `web/src/lib/history.ts`, `web/src/lib/files.ts`, `web/src/screens/Files.tsx`, `tests/files-by-task.browser.ts`, `tests/file-paging.browser.ts`, `tests/web-history.test.ts`.

**Interfaces:** API client page/detail methods and a cancellable file-page hook; existing CursorHistory initial/latest/older 50-item requests.

- [ ] 45개 자료의 첫 20개, 스크롤 다음 20개, 업무·종류 변경 경합, 깊은 링크와 50개 채팅 요청을 먼저 검사한다.
- [ ] capability 협상, 요약 목록·상세 지연 조회, 무한 스크롤과 취소·재시도를 구현한다.
- [ ] 기존 자료 업무별 보기·대화·동기화·타입 검사와 새 브라우저 검사를 통과하고 커밋한다.

### Task 3: 압축·실제 응답량과 운영 확인

**Files:** `server/http.ts`, `tests/http.test.ts`, 필요한 경우 압축 helper와 그 회귀 검사.

**Interfaces:** gzip을 허용한 큰 GET JSON 응답에만 Content-Encoding을 설정하고 Vary와 인증 응답을 보존한다.

- [ ] gzip 수락·q=0·작은 응답·압축 해제 내용 일치 검사를 먼저 작성하고 실패를 확인한다.
- [ ] 협상 압축을 구현하고 관련 회귀·타입·고정 SHA 빌드를 검증한다.
- [ ] 전체 변경을 독립 리뷰하고 지적을 검증·해결한다. 검증한 작업 브랜치를 푸시하고 SHA를 대조한다.
- [ ] 운영의 실행 보존 조건을 확인하고 가능한 반영 절차를 수행한다. 이전·이후 응답 바이트, HTTPS·인증, 기존 서비스와 진행 실행의 보존을 검증한다.
