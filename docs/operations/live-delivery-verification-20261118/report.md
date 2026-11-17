# 운영 정본의 전달 경계 시험 87개를 검증했습니다

운영 릴리스와 같은 소스의 격리된 관련 시험 87개와 코드 검사가 통과했습니다. 실제 원래 지시 두 건은 같은 세대·같은 실행에 연결돼 정상 종료했습니다. 구판 복구 코드를 적용하거나 운영 상태를 바꾸지 않았습니다.

대표님이 새로 고르실 안건은 없습니다. 총괄은 이 결과를 기존 전달 복구 인계에 연결하면 됩니다. DS 납품 검수와 다른 제품의 후속 통합 소유는 그대로 유지합니다.

검증 단계: 현재 정본의 외부 검수. 실제 운영 상태 변경은 0건입니다.

찾는 말: 운영 정본 166c995, schema44, 관련 시험 87개, 실제 원래 전달, 비동기 최종 검토, 단일 수신, 불확실 입력 보호.

## ① 결론: 현재 정본의 관련 검증과 실제 수신을 연결했습니다

이번 외부 검수는 이전 40 대 44 차이 뒤에 남은 관련 실행 검사만 다뤘습니다. 총괄이 확정한 운영 릴리스 166c99529eaae584169983049d0058bad78f6e29에서 새 워크트리를 만들었습니다.

관련 7개 시험 파일에서 87개 통과·실패 0개이며 코드 검사도 종료 코드 0입니다. 이는 기존 331개 전체의 반복이나 프로젝트 전체 검수가 아닙니다. 새 원복 패치·소스 수정·새 서버 반영은 없습니다.

| 확인 단계 | 이번 결과 | 판정 범위 |
| --- | --- | --- |
| 현행 소스 검증 | 87 pass / 0 fail / 535 expectations | 선별한 전달·계약·완료 경계 |
| 코드 검사 | bun run typecheck / exit 0 | 같은 정본의 TypeScript 검사 |
| 실제 수신 | 원래 지시 두 건 / 같은 세대 0 / ended success | 업무 전체·다른 네 직원 전체의 최신 해소로 확대하지 않음 |
| 운영 변경 | 0건 | 지원 읽기 API만 사용 |

## ③ 소스 판: 구판 패치 없이 운영 릴리스 정본을 검사했습니다

운영 SHA는 총괄의 이번 확정 지시에 근거합니다. 지원 server_check는 별도로 schema.version=44, supportedVersion=44, ok=true, harness.mode=required를 확인했습니다. task_trace나 판 번호만으로 바이너리 파일의 해시를 직접 증명한 것은 아닙니다.

제품 소스·기존 시험·실행 스크립트는 166c995와 같습니다. git diff --exit-code로 차이 0을 확인했습니다. 기존 40 기반 워크트리와 미추적 임시 파일은 보존했습니다.

현재 정본에는 검증 납품·범위 보류 뒤 실행 자리 반환과 비동기 최종 검토가 이미 있습니다. 구판의 별도 independent API 패치를 재적용해야 한다는 근거는 이번 관련 검수에서 찾지 못했습니다.

| 항목 | 기준 | 의미 |
| --- | --- | --- |
| 실행한 정본 SHA | 166c99529eaae584169983049d0058bad78f6e29 | 총괄이 확인한 운영 릴리스와 같은 Git 정본 |
| 새 워크트리 | /Users/hyejookim/Programming/01_Ing/.worktrees/IAMCEO/verify-live-delivery | 기존 워크트리에서 소스를 옮기거나 덮지 않음 |
| 새 브랜치 | test-verify-live-delivery-tk_w_SoxDmyweQG9B | 이 검수의 문서만 커밋·origin 일반 업로드 |
| 기존 자료 | msg_ETUsyhi0hixB / f_vPvunU9NvXsn / 5d24eab | 이전 판 차이와 DS 단계 메타데이터 기록은 보존 |

## ④ 실행 검사: 보호를 해제하지 않고 독립 후속을 확인했습니다

모든 시험은 새 /private/tmp/iq-* 아래의 격리 DB·가짜 실행기·격리 소켓만 사용합니다. 기존 preserve-temp preload로 시험 루트의 재귀 삭제를 막았습니다. 운영 DB와 원본 실행 기록은 열지 않았습니다.

현행 시험은 검증 전 차단 상태와 검증 납품 뒤 해제를 함께 확인합니다. 새로 실패를 만든 뒤 코드를 고친 기록으로 쓰지 않습니다. 최초 실패→수정 근거는 이전 인계에 남은 별도 이력입니다.

| 실제 명령 | 결과 | 확인한 경계 |
| --- | --- | --- |
| bun test --preload ./tests/fixtures/preserve-temp.ts tests/workflow-assignment-release.test.ts tests/orchestration-completion.test.ts tests/dispatch-execution-contract.test.ts | 34 pass / 0 fail / 99 expectations | 보류 범위·검증 납품·거짓 완료 차단·실행 계약 불변·비동기 최종 확인 |
| bun test --preload ./tests/fixtures/preserve-temp.ts tests/task-continuation-runtime.test.ts tests/admission.test.ts tests/core-capacity.test.ts | 50 pass / 0 fail / 418 expectations | busy·수동 lease·승인·unknown write·한도·정상 종료 재진입·물리 쓰기 직전 보호 |
| bun test --preload ./tests/fixtures/preserve-temp.ts tests/lifecycle-recovery.test.ts --test-name-pattern 'ACK started:false\|a write whose reply was lost\|busy rejected survives' | 3 pass / 0 fail / 35 filtered / 18 expectations | ACK·응답 유실·busy 거절 뒤의 기존 수신/복구 회귀 |
| bun run typecheck | exit 0 | 같은 정본의 코드 검사 |

단일 수신 근거는 시험별로 다릅니다. ACK started:false와 응답 유실 회귀는 원래 입력 전송 1회·중단 0회를 검사합니다. busy rejected 회귀는 거절된 최초 시도를 포함해 terminal.send=2, attempts=2입니다. 시험명의 ‘exactly once’를 ‘시도 1회’로 바꾸지 않았습니다.

미확정 입력은 계약이 바뀌어도 실제 수신 근거를 읽을 수 있지만 재생하지 않습니다. 수동 중단·승인·실행 상한·계정 제한·관련 계통 선행 조건은 유지합니다. 운영 읽기 관측에서 상태 정리가 섞인 DeliveryRecovery.fenced를 호출하지 않았습니다.

## ⑤ 실제 원래 지시 두 건은 같은 실행에서 정상 종료했습니다

독립 읽기 직원이 지원 task_trace를 한 번 조회했습니다. 고정 관측 시각은 2026-11-17T20:06:36.691Z입니다. 앞 관측의 running이 ended/success로 바뀌었습니다. 원래 전달 ID·시도·세대·수신·실행 연결을 보존했습니다.

두 지시의 공통 수신은 2026-11-17T19:42:07.749Z입니다. 실행은 c8d215f5-7aee-471a-8df5-ee7fdaa5e960, 세대 0입니다. 시작은 19:42:07.709Z, 종료는 19:49:41.608Z이며 result=success입니다.

두 전달 모두 attempts=2, status=delivered, recovery.phase=resolved입니다. 같은 실행 연결은 실제 도구 근거입니다. 이를 시도 1회나 모든 중복 실행 부재의 확정으로 바꾸지 않습니다.

| 원래 전달 ID | 등록 → 실제 전달 시각(2026-11-17 UTC) | 현재 연결 |
| --- | --- | --- |
| dl_DPkK7h9osSqt | 17:30:14.439Z → 19:42:07.717Z | delivered / ended success |
| dl_6rTzQPshPykm | 17:48:21.690Z → 19:42:07.721Z | delivered / ended success |

업무 전체 표본은 17/17건이며 생략은 없습니다. 전체 미결은 1건이고 pendingWake=0입니다. 두 원래 지시의 수신을 업무 전체 미결 0건으로 쓰지 않습니다. 이 직원은 원래 입력을 복사·재송신하거나 운영 수신 기록을 만들지 않았습니다.

## ⑥ 과거 비교와 독립 검토는 범위를 보존해 이어받았습니다

아래는 기존 진단 자료의 고정 사실입니다. 새 현재값을 만들기 위해 네 직원을 다시 조회하지 않았습니다. 최초 차단 원인은 runtime2f51d9b의 taskSequenceBlocker라는 대표 운영 관측을 총괄이 전달한 근거에 귀속합니다. 현재 166c995 정본의 검증과 구분합니다.

| 기존 고정 사례 | 원래 전달 · 등록 시각(2026-11-17 UTC) | 관측 사실 |
| --- | --- | --- |
| 설계 아키텍처 검수 | dl_xMNElcL65rIn · 16:04:29.918Z | 16:35:21.796Z: queued / 시도0 / 수신·실행 없음 |
| 독자 서비스 설계 | dl_l5yUxEbQAa2g · 15:52:36.425Z | 16:35:21.910Z: queued / 시도0 / 수신·실행 없음 |
| 디자인 시스템 | dl_wMuYDGWwhErX · 15:07:54.803Z | 16:35:21.945Z: queued / 시도0 / 수신·실행 없음 |
| 독자 반응 | dl_kGqSJg92tD3x · 16:03:48.822Z | 16:35:21.966Z: queued / 시도0 / 수신·실행 없음 |
| 정상 공통 재생 후속 | dl_pLNg1CWnIYVf · 16:22:55.046Z | 시도1 / 수신16:28:27.103Z / 종료16:30:05.151Z success |

정상 실행 ID는 81c3a3a9-574b-4e6b-ad20-bcc2791b96ab입니다. 기존 진단 msg_3tcKxGXkpBoV/f_Jkld3bxLD6sL/cb5d8af와 이전 복구 자료 935f2e7을 읽어 식별자·시점을 대조했습니다.

하위 에이전트 세 명이 병렬로 읽기 관점을 나눴습니다. live_suite_scope는 fixture 격리와 최소 시험 범위를, live_contract_boundary는 현행 소스와 회귀의 연결을, live_receipt_link는 지원 API의 실제 수신 근거를 확인했습니다. 세 직원 모두 소스 수정과 시험 실행은 하지 않았습니다. root가 실제 시험과 코드 검사를 실행했습니다.

기억 후보 세 건은 이번 판정에 사용하지 않았습니다. Astra의 과거 역할, 반응 API 자료, 다른 업무의 전달 원문은 현행 정본 검증의 근거로 채택하지 않았습니다. 전문을 열지 않았고 각각 not_used와 이유를 남깁니다.

## ⑦ 세부: 인계된 검증 범위와 남은 관측 한계를 구분합니다

확인한 단계는 같은 운영 SHA 정본의 관련 격리 시험·코드 검사와 원래 지시 두 건의 실제 정상 종료입니다. 별도 패치 적용·메인 합치기·운영 서비스 교체·새 API 운영 호출은 이번 작업의 결과가 아닙니다.

네 직원 전체의 최신 대기 해소, 실제 운영 바이너리 파일의 독립 해시 측정, DS 완료 단계의 현재 원상태는 이 검수에서 추가 확인하지 않았습니다. 기존 제품 검수와 후속 통합을 멈추는 조건으로 확대하지 않습니다. 관련 단계 메타데이터 기록은 이전 인계를 유지합니다.

운영 조치가 새로 필요하면 총괄이 그때의 최신 릴리스·현재 판 백업·원래 지시/세대/승인/진행 상태를 보존하는 별도 범위를 정해야 합니다. 이미 수신된 두 원래 지시는 재생하지 않습니다. 이 결과만으로 복구 API 호출이나 설치를 요구할 근거는 없습니다.

정본의 주요 위치: server/store.ts:2025~2036,2073~2085(검증 납품과 범위 해제); server/task-completion.ts:25~61(비동기 최종 확인); server/orchestrator.ts:611,5482,5532,5761(계약과 실제 입력 보호). 구판 실패 이력과 이번 현행 검증을 섞지 않습니다.

이번 자료는 plan.md, evidence.json, report.html, report.md와 자료 검사 파일로 구성합니다. 실제 명령·종료 코드·시험 수와 최소 운영 메타데이터만 보존합니다. 전체 대화·운영 DB·원시 실행 기록은 포함하지 않습니다. 최종 문서 커밋과 원격 SHA 일치는 연결 보고에 남깁니다.
