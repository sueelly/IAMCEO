# IAMCEO 검증 서버 누적 개선 결과

2026-11-17 15:06 KST 기준, 부모 실행기가 사라진 임시 검증 서버 22개를 SIGTERM으로 종료했다. 종료 대상의 RSS 합계는 1,634.9MiB였다. RSS에는 공유 메모리도 포함되므로 시스템 가용 메모리가 같은 크기로 늘었다는 뜻은 아니다. 모든 대상의 PID가 사라지고 기존 포트가 응답하지 않는 것을 확인했다. 운영 IAMCEO 프로세스와 두 HTTP listener는 전후 모두 HTTP 200을 반환했다. 임시 DB와 운영 데이터는 삭제하지 않았다.

## 원인과 변경

`screens-regress.browser.ts`의 SIGHUP·SIGKILL 검사 2개가 가짜 제공자 시작을 기다리다 실패하면, 처음 띄운 서버가 종료 경로에 도달하지 않았다. 소스 서버 실행을 테스트 전용 scope에 즉시 등록하고, suite 종료 때 브라우저 정리 실패와 관계없이 서버·core fixture를 정리하도록 바꿨다. CLI 검사의 공통 소스 서버 helper에도 같은 scope를 적용했다.

scope는 현재 Bun 실행 파일, `IAMCEO_TEST=1`, 명시한 임시 홈을 요구한다. 추적한 자식만 SIGTERM으로 종료하고 2초 뒤에도 남으면 해당 자식만 SIGKILL로 정리한다. 부모가 SIGKILL로 종료되면 Bun의 네이티브 감시가 동작한다. 테스트 전용 preload는 Bun이 자동으로 내보내는 환경변수를 제거하여 독립 core 제공자에 수명 정책이 전달되지 않도록 한다. Bun의 [네이티브 감시 구현](https://github.com/oven-sh/bun/blob/bun-v1.4.4/src/io/ParentDeathWatchdog.rs)을 확인했으며 실제 subprocess로 동작을 검증했다.

운영 소스·서비스 설정은 수정하지 않았다. 다른 browser suite와 컴파일된 CLI 감독 프로세스 검사는 이번 수명 관리 범위 밖이다. 작업 브랜치의 변경을 받지 않은 기존 워크트리에서 옛 검사를 다시 실행하면 같은 잔존 현상이 재발할 수 있다.

## 검증

| 검사 | 결과 |
| --- | --- |
| 새 subprocess 회귀 검사 5개 + CLI 검사 27개 | Bun 1.3.14와 1.4.4에서 각각 32개 통과 |
| 부모 종료 감시를 제거한 반례 | 잔여 프로세스 검사 실패 재현 |
| 제공자 환경 전파 반례 | 환경변수 유출 검사 실패 후 preload로 통과 |
| `bun run typecheck` | 통과 |
| `bun run build` | 통과 |
| 기존 강제 종료 검사 2개와 무관 PID 보존 검사 | 1개 통과·기존 2개 실패, 종료 후 이 suite의 잔여 서버 0개 |
| `bun test tests` 조사 실행, Bun 1.4.4 | 2,199개 통과·34개 실패, 전체 통과 아님 |
| CI와 같은 단위 파일 집합, Bun 1.3.14 | 2,162개 통과·2개 실패, 전체 통과 아님 |
| 독립 코드 검토 | 중요한 코드 지적 해결 후 남은 중요한 지적 없음 |

CI 단위 검사에 남은 실패는 `tests/herdr-contract.test.ts`의 기본 소켓 test-mode guard와 `tests/server-runtime.test.ts`의 Codex rank HTTP 검증이다. 각각 `forbidden` 대신 연결 실패, HTTP 200 대신 400을 반환한다. 변경 전 조사 실행에도 같은 실패가 있고, 수정하지 않은 두 파일만 실행해도 재현된다. 브라우저의 기존 가짜 제공자 시작 실패와 함께 별도 보수 대상이다. 이번 작업은 이 실패를 해결하거나 전체 검사를 통과시켰다고 보고하지 않는다.

PID·시작 시각·임시 DB·검증용 설정·가짜 입력을 대조한 비공개 정리 영수증과 검증 로그는 `/Users/hyejookim/Programming/01_Ing/.runtime/process-tuning/20261117/test-server-lifetimes/`에 보관했다. 원본 환경변수·접속 키·운영 DB를 소스 커밋에 넣지 않았다.

작업 워크트리는 `/Users/hyejookim/Programming/01_Ing/.worktrees/IAMCEO/test-server-lifetimes`, 브랜치는 `fix-track-test-server-lifetimes-01a1e3d1-a72a-73d3-b88d-818b7592933b`다. 최초 제공은 작업 브랜치 커밋·일반 푸시까지였다. 후속 main 통합과 기존 개발 환경 반영은 아래에 기록한다. 다음 개선 후보는 여러 서버의 빌드·검증 등 무거운 작업이 동시에 몰리는 것을 제한하는 공용 대기열이다.

## main 통합과 기존 개발 환경 반영

후속 요청에 따라 최신 main `4b79e9b`와 원래 수정 `f44547f`를 충돌 없이 통합했다. 테스트 관련 변경 외에는 최신 main의 내용을 유지한다.

조사 시점의 별도 개발 브랜치 13개에도 테스트 관련 5개 파일만 적용했다. 각 워크트리에서 수명 회귀 검사 5개와 실제 CLI 서버 검사 3개를 수행해 총 104개가 통과했다. 각각 별도 커밋·일반 푸시 후 원격 SHA 일치를 확인했다. 원래 브랜치의 나머지 파일과 이력은 보존했다.

| 워크트리 | 적용 커밋 |
| --- | --- |
| agent-a-native | `cc0b3adb` |
| approval-click-20261117 | `c66c611f` |
| conductor-merge-role-20261117 | `2ac34c18` |
| conductor-merge-role-main-20261117 | `66758881` |
| integrate-queue-approval-20261117 | `997295a5` |
| light-leftovers-web-20261116 | `dd6232e4` |
| mac-mini-migration-2026-11-16 | `f066aecd` |
| native-glass-20261116 | `824fd6d3` |
| refresh-terminal-address-20261117 | `752e7263` |
| resume-queue-status-20261117 | `c3fb921e` |
| storage-optimization-20261117 | `cc3a2ca9` |
| task-stage-sync-20261117 | `c31ced88` |
| terminal-approval-inbox-20261117 | `082d8ec1` |

위 워크트리는 모두 `/Users/hyejookim/Programming/01_Ing/.worktrees/IAMCEO/` 아래에 있다. 브랜치와 원래 HEAD, 최종 SHA, 검증 로그는 비공개 `test-server-lifetimes-main/rollout-results.json` 및 `rollout-final-check.json`에 기록했다. 비교 기준으로 쓰는 detached 리뷰·과거 스냅샷 44개에는 패치를 적용하지 않았다.

후속 조사에서는 다시 남아 있던 테스트 서버 20개를 정상 종료했다. 작업 폴더 안의 16개는 임시 DB·가짜 입력·설정·소스·프로세스 시작 시각을 확인했다. 임시 비교 폴더의 4개는 추가로 소스가 기존 main `e707d82`와 일치하는지 확인했다. 종료 대상 RSS 합계는 1,495.2MiB이며 운영 서버의 두 listener는 전후 HTTP 200이었다. DB·원본 비교 파일·운영 세션은 삭제하지 않았다.

운영 코드 변경이 없는 테스트 경로 개선이므로 운영 앱 재시작은 수행하지 않는다. 새 테스트 실행부터 적용되며, 이미 부모가 사라진 이전 테스트 서버는 별도로 종료했다.


통합 결과의 새 회귀 검사 5개와 CLI 검사 27개는 Bun 1.3.14·1.4.4에서 각각 32개 통과했다. 타입 검사와 최신 main의 `bun run build`도 통과했다. 기존 브라우저 강제 종료 검사는 1개 통과·기존 2개 실패였고, 해당 실행이 남긴 고아 서버는 0개였다.

CI 단위 파일 집합을 Bun 1.3.14의 단일 프로세스로 실행하면 macOS `EXC_GUARD`로 종료되었다. 시스템 진단 보고서에서 보호된 파일 디스크립터의 중복 CLOSE를 확인했다. 125개 파일을 각각 별도 프로세스로 실행해 이 문제를 피했다. 최신 main의 통합 검사 4개는 결과 저장 폴더가 없어 실패했으므로, 검증 결과를 Git 밖의 전용 경로에 저장하도록 실행 환경을 준비한 뒤 해당 파일들을 재검사했다. 이 재검사는 모두 통과했다. 최종 단위 집계는 2,210개 통과·기존 2개 실패다. 기존 기본 소켓 guard와 Codex rank HTTP 실패는 수정 범위에 포함하지 않았다. 전체 검사 통과로 보고하지 않는다.

메인 통합 전 독립 검토에서 차단할 소스 문제는 없었다. 원래 수정 `f44547f`가 main 이력에 포함되도록 일반 merge·일반 push를 수행하고, 원격 main SHA와 깨끗한 기본 main 체크아웃의 SHA 일치를 최종 확인한다. 통합 작업 브랜치도 같은 커밋으로 푸시한다. 강제 푸시와 운영 앱 재배포는 수행하지 않는다. Git 반영 영수증과 최종 SHA는 Git 밖의 `test-server-lifetimes-main/main-integration-receipt.json`에 기록한다.
