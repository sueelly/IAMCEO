# 실행 위치 연결 수정 계획

> 이 세션이 직접 순차 구현한다. 하위 에이전트를 쓰지 않는다.

**Goal:** 실제 명령과 도구 실행 위치를 보존하면서 로컬 파일 주소를 정확히 대조한다.

**Architecture:** Codex의 cwd만 엄격하게 경로로 정규화한다. 검사별 선택 필드 `workdir`를 입력·기록·matcher·진단에 연결한다. 생략하면 등록 위치를 쓴다. 명령 문자열을 합성하지 않는다.

**Tech Stack:** Bun, TypeScript, Zod, 기존 격리 DB 시험.

**Spec:** IAMCEO 작업 tk_w_fJtAv1MraUjs의 계약 r1과 R1–R5 지시.

## 범위

- 수정 브랜치·검증·커밋·origin 일반 푸시까지 한다.
- 메인 합치기·운영 서비스 변경·실제 God 검사·QA 제출을 하지 않는다.
- 원 CLI 기록·운영 DB·권한·기본값·W5 정책을 바꾸지 않는다.
- Git에는 소스·합성 회귀·이 계획과 검토 안내만 남긴다.

## 검토 초점

- URL이 상대 위치나 원격 호스트를 로컬 위치로 바꾸지 않아야 한다.
- localhost는 런타임 URL의 로컬 호스트 규칙만 따른다.
- 잘못된/누락 cwd는 와일드카드가 되지 않아야 한다.
- workdir를 생략한 기존 보고는 등록 위치 기준을 유지한다.
- 명령·종료 의미·계약시각·마지막 실행·재사용 판정을 유지한다.

## 1. 실패 회귀 → 최소 수정

**Files:** server/harness-workdir.ts, server/harness-evidence.ts,
server/harness.ts, server/agent-tools.ts, server/orchestrator.ts,
server/store.ts, server/db.ts, server/harness-exec-diagnostics.ts,
tests/harness-workdir.test.ts, tests/harness-workdir-integration.test.ts.

- [x] 로컬 URI·한글/공백/인코딩·다른 위치·잘못된 위치 회귀를 만든다.
- [x] API 입력→정확한 command/workdir 기록→판정→실패 검사 진단 회귀를 만든다.
- [x] `bun test tests/harness-workdir.test.ts tests/harness-workdir-integration.test.ts`의 의도한 실패를 확인한다.
- [x] 로컬 file URI 정규화와 선택 workdir를 구현한다. 저장에는 새 nullable 열을 추가하며 운영 DB는 열지 않는다.
- [x] 같은 회귀를 통과시키고 관련 기존 회귀·코드 검사를 실행한다.

## 2. 원 다섯 메타데이터 대조와 검토 자료

- [x] 원 다섯 항목의 필요한 메타데이터만 메모리에서 추린다.
- [x] 수정 전·후 순수 파서/matcher에 원 command와 실제 workdir를 그대로 넣어 결과를 비교한다.
- [x] 운영 전체 관문 통과와 구분하고 원 거절 당시 미기록 범위를 유지한다.
- [x] `bun test tests`, `bun run typecheck`와 최종 diff를 확인한다. 전체 회귀는 종료 137·미완이며 새 회귀 67건과 관련 범위 414건은 통과했다.
- [x] 독립 검토자가 쓸 명령·변경 이유·서비스 후속 범위를 안내한다.
- [x] 검증한 변경만 커밋하고 origin 작업 브랜치로 일반 푸시한다. 원격 SHA와 로컬 HEAD를 비교한다. 구현 커밋 64473d63093e707113962e165b192a3a8861a179의 원격 일치를 확인했다.

종료 시점의 외부 변경: 운영과 origin/main이 80d4d766·스키마 v37로 바뀌었다. 이 브랜치의 v36 이주 번호와 충돌한다. 현재 브랜치의 검증과 새 메인 통합판의 검증을 구분한다. 메인 합치기와 서비스 변경 금지에 따라 통합은 실행하지 않았다. 필요한 후속은 검토 안내에 적었다.

자기 검토는 독립 검토로 부르지 않는다. 운영의 미적용 코드 때문에 이 직원의 실행 연결이 거절되면 실제 시험 결과와 구분해 막힘으로 보고한다. 같은 검사나 완료 제출을 반복하지 않는다.
