# Code source read Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans sequentially. 새 직원·하위 에이전트·중첩 CLI를 쓰지 않는다.

**Goal:** 원 두 코드 출처의 실제 조각과 인용을 서버 소유 관찰에 묶는다.
**Architecture:** 고정 두 파일의 bounded read → 서버 receipt → 현재 연구 계약의 verifyClaims. 기존 provider parser/실행 관문은 유지한다.
**Tech Stack:** Bun/TypeScript, node:fs, 기존 SQLite Store/agent tools.
**Spec:** docs/superpowers/specs/2026-11-15-code-source-read-design.md

## Global Constraints

- 원 주장/출처/계약·기본 하네스/환경 정책을 낮추지 않는다.
- 운영/실제 직원/비서/원본 전체/비밀/네트워크·합치기/반영/깃허브/삭제 금지.
- 2파일, 파일2MiB, 요청80줄, 응답16KiB, 계약별128관찰.
- receipt는 project/member/task/contract-task/rev/at/root에 고정. DBv32 유지.
- 의미는 verified=false/semanticReview=required. sourceRead와 quoteMatched만 구분한다.

## Review Focus

- 여러 도구 분기·성공/실패/부분을 같은 불변식으로 검사한다.
- 실행 등 다른 조건이 정상인 미열람 단독 실패를 만든다.
- 양방향 링크·하드링크·보호 root·긴/비ASCII 민감값·오류·공통 요청 원문 보관을 확인한다.
- 현재 판·직원·프로젝트·업무·시각과 파일 내용 변경 후 snapshot 의미를 확인한다.
- 문자열로 만든 receipt/도구 이름·자기 자료·printf는 서버 관찰이 아니다.

### Task 1: 서버 관찰과 출처 대조

**Files:** Create server/harness-source-read.ts. Modify server/store.ts, server/orchestrator.ts, server/agent-tools.ts, server/harness-evidence.ts, shared/types.ts. Test tests/harness-source-read.test.ts.

**Interfaces:** code_read의 위5인자 → bounded text observation. Store에는 CodeReadScope별 저장/조회. verifyClaims의 선택적 서버 관찰 인자는 기본[]로 기존 호출을 보존한다.

- [x] 원자료·실제 지원 코드/도구와 분기표를 확인한다. 기존 F4/P2 선택4건을 기준에서 통과 확인한다.
- [x] 정상 두 출처 read→완료 저장, 단일 미열람/인용 불일치/위조를 실제 처리기로 고정하고 수정 전 실패를 확인한다.
- [x] bounded read/민감 거절/namespace receipt/scope 조회와 완료 대조를 최소 구현한다.
- [x] 정상/거절·권한/판·시각·부분/잘림·파일 변경·operation/가림 반례를 추가하고 수정·재검사한다.
- [x] 실제 F4 원반례·실행/종료/계약/정정/인증/진단의 영향 회귀와 최종 코드 검사를 낮은 부하로 순차 실행한다.
- [ ] 메인 재조회·고정 커밋/차이와 적용·되돌리기/미검증을 납품한다. HTML+md와 별도 원응답을 같은 업무에 연결한다.

기억 exp-ee3fb4e15efcaf9f83123cd9068ad37d48c9fc38의 분기 누락 교훈을 검증 설계에 적용한다. 과거 통과 수나 대표 권한으로 사용하지 않는다. 작성자 자기 확인은 독립 재검토가 아니다.

## 자기 확인 기록

- 네이티브 도구로 새 관리 워크트리7191과 브랜치를 만들고 같은 업무에 등록했다. 기준 HEAD/트리 지문을 먼저 확인했고 기존 진단 워크트리14b4/e62c729는 보존했다.
- 첫3건은 기준에서1통과/2실패였다. 고정 기준 archive에서도 최종 같은 소스의 핵심3건은1통과/2실패이며 실제 code_read 미지원 원응답을 보존했다. 수정 뒤 정상 저장·미열람 단독 거절/읽기 뒤 수용·셸/자기자료 위조 거절은 통과했다.
- 확장 중 손상 JSON이 예외로 빠지는1건을 재현하고 Store 조회에서 미확인 관찰로 버리도록 수정했다. Stats 타입의 첫 코드 검사 오류도 고쳤다. 현재 코드 사본의 verified=false가 인용 바로 전 줄에 있어 두 줄을 실제 읽도록 시험 범위를 바로잡았다. 원 주장과 인용은 바꾸지 않았다.
- 기능 동작66통과/0실패,289단언 뒤 원 연구와 같은 README 미열람 해석 단독 반례를 추가해 최종67통과/0실패,298단언. 두 코드 원인용·다른 직원 자료의 실제 조회를 준비했고, 원 코드 사본에서도 verified=false 맥락과 정상 완료 저장을 확인했다. 실행matched/exit0·quoteMatched/sourceRead true·verified false·semanticReview required가 원응답/저장값에 연결된다.
- 영향 회귀: 실행/계약/정정/출처69, 명령 원문7, 인증18, 진단 D1~D3의 기존141 =235통과/0실패. 기준 F4/P2 선택4와 과거/중간 수를 더하지 않는다. 전체 프로젝트 시험/이전 전체 실패는 반복하지 않았다.
- 최종 tsc --noEmit 종료0, git diff --check 종료0. provider parser·진단 관찰기·권한/환경 기본 정책·DB schema에는 추가 차이가 없다.
- 범용 API 대신 두 출처 allowlist를 선택했다. 제한된 파일을 실제 읽고 전체 snapshot/읽힌 조각 hash를 보존한다. 서버 읽기 성공을 관찰한 것이며 직원의 주의·네트워크 수신 ACK를 독립 증명하지 않는다.
- 기존 공통 request_json은 스키마 전 요청 원문을 보관한다. 새 응답/관찰/오류의 비노출과 분리한다. 같은 업무/직원/판/root 범위의128 제한이며 모든 보관량·조회 성능 상한을 뜻하지 않는다. receipt 조회는 기존 테이블의 필터 조회로 DBv32를 유지하고 운영 성능은 미검증이다.
- 고정 커밋 뒤 자료/보고를 같은 업무에 남긴다. 본사7항목·실제 비서 완료/미열람 재제출·원래 실행 누락 원인·운영/의미 검토는 아직이다. 기존 w4의 독립 검토가 다음 단계다.
