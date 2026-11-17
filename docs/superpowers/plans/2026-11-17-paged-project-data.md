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

### 후속 작업: 첫 화면의 진단 대기와 정적 코드 전송 지연 수정

2026-11-17 사용자가 첫 접속의 장시간 로딩을 다시 보고했다. 현재 서비스는 앞선 `5fe3fb7`이다. 맥미니의 새 브라우저에서는 0.36초에 열렸으나 실행기 진단 응답을 지연시키면 프로젝트를 받아도 첫 화면이 계속 가려지는 것을 재현했다. 첫 화면 JS 1,776,637바이트와 CSS 123,897바이트에는 압축도 적용되지 않았다. 사용자 기기와 동일한 원인은 아직 확정하지 않았다.

- 요구 R8: 웹은 프로젝트와 대화를 받으면 실행기 진단을 기다리지 않고 화면을 연다. 진단이 도착하기 전 직원 실행 제한은 유지한다. 확인 A8 → R8: 실제 브라우저에서 `/api/runtime`을 보류해도 화면이 열리고, 늦은 진단은 현재 로그인과 프로젝트에만 적용되는지 확인한다.
- 요구 R9: 정적 JS·CSS를 압축 가능한 요청에는 gzip으로 전달한다. 첨부·쓰기·인증·정적 자산의 보안 헤더는 보존한다. 확인 A9 → R9: 실제 번들 경로에서 gzip 협상, 명시적 거부, 압축 전후 내용 동일과 CSP·ETag 보존을 검사한다.
- [x] 브라우저·HTTP 회귀 검사를 먼저 추가하고 현재 코드의 실패를 확인한다.
- [x] `web/src/lib/store.ts`에서 진단을 비동기로 받되 세션·프로젝트 변경과 중복 요청을 방어한다. `server/http-compression.ts`와 `server/http.ts`의 정적 프록시에서 JS·CSS만 추가 압축한다.
- [ ] 관련 검사·전체 회귀·타입 검사와 고정 SHA 빌드를 확인한 뒤 커밋하고 작업 브랜치를 origin에 올려 SHA를 대조한다. 전체 회귀의 기존 실패는 구분해 기록한다.
- [ ] 현재 운영 SHA와 동시 작업을 다시 확인하고 실행·데이터·인증을 보존하는 기존 반영 절차로 Tailscale 첫 접속을 검증한다.

코드 리뷰에서 프로젝트 전환 뒤 오래된 진단이 새 요청을 막는 경우와 일시 실패 뒤 재시도가 없는 경우를 확인했다. 각각 실패하는 검사를 확인한 뒤 현재 문맥 검사와 3초 후 재시도로 수정했다. 대화 조회 중 도착한 최신 진단을 뒤 스냅샷이 지우는 경합도 실패를 재현하고 수정했다. 최종 관련 검사 86개와 타입 검사가 통과했다. 자료 브라우저 7개가 통과했으며, 옛 자료를 다른 업무로 옮기는 기존 검사는 기준 `5fe3fb7`에서도 동일한 응답 대기 시간 초과로 실패했다.
