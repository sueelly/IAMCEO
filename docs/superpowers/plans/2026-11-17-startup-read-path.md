# 첫 접속 개선 실행 계획

> **For agentic workers:** Use superpowers:executing-plans for sequential implementation in this worktree and one final independent code review.

**Goal:** 현재 서버 조회 재사용과 저장 최적화를 보존하며 첫 화면 코드와 초기 왕복을 줄인다.

**Architecture:** 같은 최신 운영 소스를 기준으로 빌드 설정, 접속 수명, 선택적인 상태·대화 합동 조회를 차례로 수정한다. API의 구버전 경로와 기존 대화 커서·단일 동기화 소유자를 유지한다.

**Tech Stack:** Bun 1.3.14, TypeScript, SQLite, React, Playwright. 새 의존성과 DB migration은 없다.

**Spec:** `docs/superpowers/specs/2026-11-17-startup-read-path-design.md`.

## Global Constraints

- 최신 제공 소스 `6471aa7`의 스키마 v35, 원본 자료·대화·승인·실행을 보존한다.
- 부분 상태를 완전한 프로젝트 상태로 넣지 않는다. 쓰기의 검토 버전과 acceptedSnapshotVersion을 보존한다.
- 개발은 맥미니의 작업 워크트리에서 차례대로 수행한다. 공유 main을 임의로 바꾸지 않는다.
- 실행 데이터·토큰·영수증은 소스 Git 밖에 둔다. 새 운영 백업과 재압축은 하지 않는다.

## Review Focus

- 쿠키·기능 확인 중 로그인 변경과 pageshow가 겹쳐도 이전 세션이 새 상태를 덮어쓰지 않아야 한다.
- 기능 확인 404인 구버전 서버와 첨부 쿠키 실패의 기존 동작을 유지한다.
- 대화와 상태를 따로 병렬화해 초기 연결 사이의 메시지를 잃지 않는다.
- 합동 응답과 일반 compact 응답의 캐시를 섞지 않으며 직접 DB 변경·인증 경계를 유지한다.
- 과거 대화 간격 복원, 프로젝트 전환, 같은 상태 재확인과 optimistic write의 소유권을 보존한다.

### Task 1: 현재 서버 개선 확인

- [x] 운영 소스와 두 최적화 브랜치를 비교하고 현재 제공 소스 `6471aa7`을 작업 브랜치에 fast-forward로 가져온다.
- [x] 캐시·알림 조회·객체 공유 검사 19개를 재실행한다. 결과는 19 pass /0 fail이다.

### Task 2: 운영용 단일 실행 파일

**Files:** `package.json`, `scripts/build-app.ts`, `scripts/build-release.ts`, `tests/production-web.test.ts`.
**Interfaces:** `buildApp({ outfile, target? })`는 현재 Bun으로 운영 옵션의 독립 실행 파일을 만든다. `bun run build`와 release 스크립트가 이를 사용한다.

- [ ] 실제 앱 만들기·격리 기동·JS 전송 예산 검사를 먼저 추가해 현재 개발용 번들에서 실패를 확인한다.
- [ ] 공통 빌드 함수를 연결하고 격리 홈·내장 화면·인증·전송 예산과 타입 검사를 통과한다.
- [ ] 검증한 변경을 커밋한다.

### Task 3: 초기 접속 수명과 왕복

**Files:** `web/src/lib/api.ts`, `web/src/lib/store.ts`, `tests/web-sync-store.test.ts`, 브라우저 회귀 검사.
**Interfaces:** `api.filesSession(signal?)`; 동일 자격 증명·세대의 `startSession()`은 진행 중인 Promise를 공유한다. 기능 확인과 쿠키 발급은 모두 정리된 뒤 기존 coordinator가 읽기를 시작한다.

- [ ] 보류한 쿠키보다 기능 확인이 먼저 시작되는지, pageshow에서 쿠키 한 개만 요청하는지 RED를 확인한다.
- [ ] 두 준비 요청을 동시에 시작하고 취소 신호·인증 세대를 유지한다.
- [ ] 동기화·재로그인·화면 숨김·구버전 API 검사를 통과하고 커밋한다.

### Task 4: 상태와 최신 대화의 합동 조회

**Files:** `shared/types.ts`, `shared/operations.ts`, `server/http.ts`, `web/src/lib/api.ts`, `web/src/lib/store.ts`, 합동 조회 HTTP·웹·브라우저 검사.
**Interfaces:** 서버 `snapshotHistory: true`; 요청 `/api/sync?projectId=...&view=compact&history=50`; 선택적 `SyncSnapshot.history: MessagePage`. 기존 응답과 페이지 API는 유지한다. 상태와 history는 마지막 cursor를 정하기 전 await 없이 생성한다.

- [ ] 기능 협상·일반/합동 캐시 분리·과거 페이지 경계·인증·404·잘못된 조건의 RED를 확인한다.
- [ ] 새 기능을 지원할 때만 합동 요청을 보내고 CursorHistory의 첫 최신 페이지로 적용한다. bridge와 과거 조회는 기존 API를 사용한다.
- [ ] 파일·대화·동기화·객체 공유·쓰기 검토와 구버전 fallback 검사를 통과하고 커밋한다.

### Task 5: 검증·서비스 반영

- [ ] 관련 검사·타입·전체 회귀를 실행하고 기존 실패를 별도 기록한다. 변경 전체를 독립 코드 리뷰한다.
- [ ] 최신 제공 SHA를 다시 확인하고 고정 소스 빌드·격리 기동 후 작업 브랜치를 푸시해 원격 SHA를 대조한다.
- [ ] 기존 웹 서비스만 정상 인계하고 인증·기존 터미널 PID·기록·Tailscale 경로를 대조한다. 새 운영 백업을 만들지 않는다.
- [ ] 동일한 느린 연결 조건으로 전송량·첫 조회 수·첫 화면 시간을 비교하고 결과를 보고한다.
