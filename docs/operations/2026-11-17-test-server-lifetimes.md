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

작업 워크트리는 `/Users/hyejookim/Programming/01_Ing/.worktrees/IAMCEO/test-server-lifetimes`, 브랜치는 `fix-track-test-server-lifetimes-01a1e3d1-a72a-73d3-b88d-818b7592933b`다. Git 반영은 작업 브랜치 커밋·일반 푸시까지이며 main 통합·배포와 구분한다. 다음 개선 후보는 여러 서버의 빌드·검증 등 무거운 작업이 동시에 몰리는 것을 제한하는 공용 대기열이다.
