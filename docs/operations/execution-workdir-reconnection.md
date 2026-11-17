# 실행 위치 근거의 최신판 연결과 회귀 인계

**고정 원격 bc17046의 42개 이주를 보존한 43번 연결판을 검증했다. 전체 완료는 막힘이다.** 시험 파일 182개를 모두 실행했지만 파일 실패 17개와 옛 herdr 본문 미실행 35개가 남았다. 종료 전 원격 main이 166c995·스키마44로 추가 변경된 것도 확인했다. 이 새 판에는 r2와 다른 위치 생략 규칙이 있어, 검증판과 분리해 총괄에게 정합 기준을 인계한다.

업무 `tk_w_fJtAv1MraUjs` 계약 r2의 검토 자료다. 이 브랜치는 실행 위치 연결과 격리 시험 보정만 제공한다. 메인 통합·서비스 적용·운영 근거 판정의 통과를 뜻하지 않는다.

## 연결한 판과 보존 범위

| 대상 | 고정 입력 | 역할 |
| --- | --- | --- |
| 원 연결판 | `a75c830ed4c01137552a2a636a59e231bb53cd59` | 기존 독립 검토판. 변경하지 않았다. |
| 시험 보정판 | `0a40146a2267bd81678781e9e1206925b21a6ce7` | 기존 보관 순서·시작 훅 예산 보정. 변경하지 않았다. |
| 첫 원격 기준 | `65cd908f9eca829494746b624aa02a37515cd8a0` | 41번 `execution_issue_json`을 포함한다. |
| 첫 연결 커밋 | `962f395` | 정식 Git merge로 원 고정판을 연결하고 42번에 workdir를 추가한 중간 검증판이다. 운영에 쓰지 않는다. |
| 이번 검증의 고정 원격 기준 | `bc1704696793533d8d2841a650b9e6530d816683` | 검증 도중 추가된 42번 기억 보관·평가 이주를 포함한다. |
| 이번 검증의 연결판 | 이 작업 브랜치 HEAD | 원격의 42개 이주를 그대로 두고 **43번**에 `report_checks.workdir`를 추가한다. |

작업 브랜치는 `fix-reconnect-execution-workdir-tk_w_fJtAv1MraUjs`, 워크트리는 `/Users/hyejookim/Programming/01_Ing/.worktrees/IAMCEO/reconnect-execution-workdir-20261118`이다. 비교판은 같은 루트의 `execution-workdir-baseline-bc17046-20261118`에 분리했다. 원격은 `https://github.com/sueelly/IAMCEO.git`이다. 다른 직원의 브랜치나 미커밋 변경은 옮기지 않았다.

최종 기준과 `server/db.ts`를 대조하면 workdir 이주 두 줄만 추가된다. 41번과 42번 원문을 바꾸지 않았다. `harness-evidence.ts`, `harness-workdir.ts`, `harness-exec-diagnostics.ts`, `harness.ts`는 고정 0a 판과 바이트가 같다. 실제 command를 바꾸거나 실행하지 않은 cd를 만들지 않았다. 위치 비교, 계약 시각, 마지막 실행, 종료값과 중복 사용 기준은 유지한다.

## 격리 이주와 재열기

최신 원격 42에서 새 회귀는 먼저 0 성공·4 실패였다(43개 이주 요구, 실제 42개). 연결 후 v35·v37·v41·v42 합성 DB 네 개가 모두 통과했다. 운영 DB를 입력으로 사용하지 않았다.

각 시험은 기존 모든 열과 행의 지문, 원 command, 과거 workdir NULL, 새 명시 workdir, 업무 단계·순서·후속·실패 결재 상태를 이주 전후와 재열기 후 대조한다. v42에는 기억 보관 원문 지문과 평가 대기 행도 넣어 기존 열/값의 보존을 확인했다. `tests/harness-workdir-current-migration.test.ts`에 독립 재현 코드가 있다.

| 입력 DB | 이주 전 = 재열기 후 SHA-256 |
| --- | --- |
| v35 | `34daf99571026b3e53846aee61e6a7c53f7a0c1139b5b712b36edfc8139360b7` |
| v37 | `56d2dc2b8363b2c2ceb561ef905c1eae28b2b6d40380921e865f4e5d75be4f62` |
| v41 | `eb249fb05f646f2c36d99733b92f6759ac7d9400712fdd83f11a10188d3cee13` |
| v42 | `57463b43dd01a0c15a325852961a14cb39577b85a9aebde3eda3004e1af6637f` |

원 God 다섯 검사는 다시 실행하거나 완료 보고를 제출하지 않았다. 이미 허용된 제한 메타데이터를 사용하는 순수 회귀와 기존 원문 보존만 확인한다. 이 대조를 원 거절 시점의 전체 내부 경로나 운영 gate의 통과로 해석하지 않는다.

## 시험 조건과 작은 보정

Bun 1.3.14를 절대 경로로 고정했고 각 워크트리에서 `install --frozen-lockfile`을 실행했다. 잠금파일은 변경하지 않았다. Playwright 1.64.1의 Chromium 1248·WebKit 2370 캐시가 존재한다. 파일별 새 프로세스를 순차 실행하고, 같은 파일 안에 포함되는 `browser.test.ts` wrapper는 중복 집계하지 않는다. 원래 전체 종료 137의 원인은 확정하지 않았다.

최초 41 기준 전체 실행은 개별 시험 파일 177개 모두 시도, 파일 성공 157·실패 20, Bun 성공 2,863·실패 이벤트 104, runner 시간 초과 0이었다. 이 숫자는 아래 최종 입력판 집계에 더하지 않는다. 처음 별도 시도 9개 파일은 저장소의 기존 정리 함수를 사용했으므로 그 임시 자료가 전부 보존됐다고 보장하지 않는다. 이를 발견한 뒤 해당 시도를 중단하고 이후 격리 자료를 남기는 보정으로 전환했다. 직원 세션과 운영 자료는 건드리지 않았다.

최소 보정은 시험 파일에만 있다.

- 격리 fixture의 DB·로그를 지우는 종료 처리를 보존 처리로 바꿨다. 공통 runtime은 자기 자식과 리스너를 닫은 다음 자신이 만든 루트를 새 전용 보관 폴더로 이동한다. 원 활성 경로가 없어야 한다는 기대는 유지하고, 보관된 파일 바이트와 세션 파일 존재도 검사한다. 재호출은 같은 종료 Promise를 돌려준다.
- 흐름 복구와 결재함 시험에는 시험용 확정 계약, 업무 연결과 완료 검사 자료를 준비했다. 기존 보고·원자성·중복 방지·UI 기대는 유지한다. 실제 운영 결재·완료 제출이 아니다.
- 아티팩트 시작 훅의 기존 30초 예산을 비교판에도 똑같이 적용했다. 화면 기대와 보안 경계는 바꾸지 않았다.

옛 `herdr`는 PATH에 없다. 저장소 설치 계약은 `herdr-core 0.1.18`의 서명·체크섬 확인을 요구한다. 옛 `herdr`의 승인된 설치 핀은 찾지 못했다. 이번에는 core 실행기를 새로 설치하지 않았다. 다른 실행기를 별칭으로 대체하지 않았다. 해당 describe의 본문 35개는 실행되지 않았다. Bun이 기록한 setup/teardown 오류와 실제 가짜 소켓 assertion 실패는 별도로 센다.

## 검토와 운영 후속

독립 검토자는 고정 a75/0a 검토와 이 브랜치의 최신 통합 검토를 구분해야 한다. 먼저 원격 기준에 대한 `server/db.ts` 차이, 원 command/workdir 전달, 격리 이주·재열기, 시험 보정의 기대 보존을 확인한다. 원 다섯 God 명령을 재실행할 필요가 없다.

지원 `server_check`의 이번 관측은 **운영 DB 44 / 지원 44**, harness required, execEvidence available이었다. 이는 원격 메인의 소스 스키마 42와 별개다. 운영 44가 어느 소스 조합인지와 이 브랜치의 실제 적용 가능성은 확인하지 못했다. **43이라는 번호만 보고 운영에 적용하면 안 된다.** 총괄·서비스 소유자가 운영 소스판을 확인하고, 독립 검토를 거친 통합판에서 번호와 적용 경로를 결정해야 한다. 이 작업은 메인·서비스·운영 DB를 변경하지 않았다.

자동 근거 수집·인용 등록·외부 검수 운영 연결은 별도 소유다. 이번 브랜치 결과를 그 통과로 바꾸지 않는다. 최종 커밋과 실제 origin SHA 일치는 업무 자료와 보고에 별도로 연결한다.

## 파일별 변경 이유와 재현 범위

| 파일 | 변경 이유 |
| --- | --- |
| `server/db.ts` | 원격 v42 원문 뒤에 nullable workdir 이주 v43을 한 번 추가한다. |
| `server/agent-tools.ts` | 원 command와 별도로 실제 절대 workdir를 받을 수 있게 검증한다. 최신 원격의 명령·근거 원문 길이 정책은 그대로다. |
| `server/orchestrator.ts`, `server/store.ts` | 검사 메타데이터의 저장·조회·지원 진단까지 workdir를 전달한다. 생략 시 등록 위치 기준을 유지한다. |
| `server/harness-workdir.ts`, `server/harness-evidence.ts`, `server/harness-exec-diagnostics.ts`, `server/harness.ts` | 고정판의 URI 정규화와 위치 비교를 보존한다. 이 재연결에서 함수 내용을 다시 바꾸지 않았다. |
| `tests/harness-workdir-current-migration.test.ts` | 공식 v35/v37/v41/v42의 과거 행과 최신 기억 상태를 포함한 보존·재열기를 검증한다. |
| `tests/fixtures/isolated-runtime.ts`, `tests/isolation.test.ts` | 종료된 fixture의 활성 경로는 없애되 자료는 전용 보관 위치에 남긴다. 원 종료 기대와 소유 경계를 유지하고 보존 바이트를 추가 확인한다. |
| `tests/flow-recovery.test.ts`, `tests/inbox-approval.browser.ts` | 합성 시험 계약과 업무/보고 근거를 준비해 기존 기능 기대를 검사할 수 있게 한다. |
| 그 밖의 fixture 정리 부분 | 임시 폴더를 삭제하지 않고 DB·서버·자식 자원만 닫는다. 실행기·브라우저·권한·기대값 변경은 없다. |
| 기존 inventory/matrix/probe 도구와 고정판 회귀 | 기존 기록·최소 반례·원 다섯 제한 메타데이터의 재현 방법을 보존한다. |

동일한 번호가 동일한 스키마라는 뜻은 아니다. 중간 연결판의 시험용42와 원격의 공식42는 다르다. 이전 합성 DB는 보존했고 새 시험은 공식 이주 원문으로 만든 새 DB만 사용했다. 운영44나 이전 합성 DB를 이번 연결판으로 열어 고치지 않았다.

독립 검토에서는 잠금파일 설치 후 해당 워크트리를 실행 위치로 삼는다. 예를 들어 `bun test ./tests/harness-workdir-current-migration.test.ts`, `bun test ./tests/harness-workdir.test.ts`, `bun test ./tests/harness-workdir-integration.test.ts`, `bun test ./tests/isolation.test.ts`를 실행할 수 있다. 이것은 재현용 축약이다. 실제 실행된 절대 Bun 경로·argv·workdir·시각·종료값은 결과 JSON을 기준으로 한다. 전체 행을 다시 성공으로 등록하기 위한 반복은 필요하지 않다.

## 최종 전체 집계

입력 원격은 `bc1704696793533d8d2841a650b9e6530d816683`이고 소스 스키마는43이다. 개별 시험 파일 182개 중 182개를 실행했다. 파일 성공 165·실패 17·미실행 0이며 wrapper 1개는 중복에서 제외했다. Bun 결과는 성공 2947·실패 이벤트 98·skip 0다. runner 시간 초과는 0건이다.

파일 미실행0과 본문 미실행0은 다르다. 옛 herdr 본문35개는 준비 훅에서 막혔으므로 **계약 r2 전체 완료는 아니다**. 기존/최종 입력판의 결과를 합산하지 않았다. 소스는 전체 실행 전후 같은 지문인지 함께 확인한다.

전체 실행 전후 소스 동일: `true`. 실제 argv·workdir·UTC 시각·개별 종료·실패 이름과 비교판 결과는 `execution-workdir-reconnection-results.json`에 있다. CLI 원문 로그와 운영 메타데이터는 이 파일에 넣지 않았다.

| 실패 파일 | 연결판 성공/실패 | 기준판 성공/실패 | 대조 |
| --- | --- | --- | --- |
| `tests/api-compatibility.test.ts` | 12/1 (exit 1) | 12/1 (exit 1) | 같은 실패 이름 |
| `tests/artifact.browser.ts` | 15/2 (exit 1) | 17/0 (exit 0) | 단판 차이 있음·원인 별도 확인 |
| `tests/e2e-fake.browser.ts` | 7/15 (exit 1) | 8/14 (exit 1) | 단판 차이 있음·원인 별도 확인 |
| `tests/headless.test.ts` | 26/1 (exit 1) | 26/1 (exit 1) | 같은 실패 이름 |
| `tests/herdr.test.ts` | 39/24 (exit 1) | 39/24 (exit 1) | 같은 실패 이름 |
| `tests/home.browser.ts` | 12/3 (exit 1) | 12/3 (exit 1) | 같은 실패 이름 |
| `tests/http.test.ts` | 52/1 (exit 1) | 52/1 (exit 1) | 같은 실패 이름 |
| `tests/integrated.browser.ts` | 4/8 (exit 1) | 4/8 (exit 1) | 같은 실패 이름 |
| `tests/orchestrator.test.ts` | 69/3 (exit 1) | 69/3 (exit 1) | 같은 실패 이름 |
| `tests/regress.test.ts` | 84/2 (exit 1) | 84/2 (exit 1) | 같은 실패 이름 |
| `tests/screens-regress.browser.ts` | 49/15 (exit 1) | 48/16 (exit 1) | 단판 차이 있음·원인 별도 확인 |
| `tests/stop-follow-up.browser.ts` | 0/1 (exit 1) | 0/1 (exit 1) | 같은 실패 이름 |
| `tests/storage-maintenance-optimization.test.ts` | 4/2 (exit 1) | 4/2 (exit 1) | 같은 실패 이름 |
| `tests/task-stage.browser.ts` | 0/1 (exit 1) | 0/1 (exit 1) | 같은 실패 이름 |
| `tests/task-threads.browser.ts` | 3/2 (exit 1) | 3/2 (exit 1) | 같은 실패 이름 |
| `tests/tools.test.ts` | 28/15 (exit 1) | 28/15 (exit 1) | 같은 실패 이름 |
| `tests/unified.test.ts` | 47/2 (exit 1) | 47/2 (exit 1) | 같은 실패 이름 |

## 최소 반례와 남은 소유

최종 전체 파일의 실패 수를 아래 최소 실행의 성공으로 대체하지 않는다. 같은 실패 이름은 양쪽에서 관측했다는 뜻이며 모든 내부 원인이 같다는 증명은 아니다.

- **WebKit 종료:** 연결판 전체 파일 실행에서 `# 링크`의 `page.evaluate`가 `Target page, context or browser has been closed`로 끝났고 다음 `빈 칸`의 새 페이지 생성도 실패했다. 기준판 전체 파일은 17/0이었다. 이후 `-t 'webkit.*(# 링크|빈 칸)'`로 두 사례만 실행하면 양쪽 모두 2/0, 종료0이었다. 첫 선택식은 0건을 선택하고 종료1이었으며 시험 성공으로 세지 않았다. 순서·브라우저 종료의 원인은 미확인이다. 브라우저 시험 소유자가 전체 파일의 생명주기와 최소 실행 차이를 이어 확인해야 한다.
- **가짜 실행기 소유 경계:** 두 판의 최소 probe는 외부 cwd·외부 MCP 설정·외부 URL을 모두 거절하고 자기 fixture의 세 경로만 받았다. provider turn은0이었다. 실제 e2e-fake의 첫 경로 오류는 독립 WORK가 fixture 밖이어서 `Path is outside this fixture`가 된 것이다. 소유 제한을 풀지 않았고 대역 실행기로 통과시키지 않았다. fixture 소유자가 cwd/HOME/MCP/URL 준비를 같은 소유 안에 맞춰야 한다.
- **옛 herdr:** 파일의 실패 이벤트24는 이름 있는 assertion22와 준비/정리 훅 오류2다. 가짜 소켓의 초안 제거 기대에 대해 실제 구현은 `input_busy`, `not_written`, `입력칸의 초안을 보존했습니다`를 반환한다. 별도 실제 실행기 describe의 본문35개는 `herdr` 실행파일 부재로 실행되지 않았다. 실행기 소유자가 승인된 옛 herdr 설치판·지원 계약을 제공하거나 기반 소유자가 옛 시험의 지원 범위를 결정해야 한다. 설치 핀이 없는 실행기를 임의 설치하거나 core를 별칭 대체하지 않았다.
- **연결판에서만 관측한 화면 차이:** e2e-fake의 마지막 `phone07-team-empty` 대비 검사도 연결판에서 실패했다(4.35·4.27·1.53·1.31). 기준판의 해당 이름은 실패하지 않았다. 제품 화면은 수정하지 않았고 연결판 유발 여부는 확정하지 않았다. 화면 시험 소유자의 재현이 필요하다. screens-regress는 공유 실패15개에 기준판에서만 추가 실패1개가 있었다.
- **기반 계약·응답 기대:** api-compatibility의 응답 `deliveryWait:null` 대 이후 store의 quiet 상태, http의 새 `workflowAssignment:false` 필드, 역할 템플릿에 추가된 문장, waitInbox의 문자열/객체 기대, tools의 옛 계약 준비는 양판에서 같은 이름으로 실패했다. 기반 시험 소유자가 원 스냅샷·계약의 기대를 판단해야 하며 이번 범위에서 기대값을 바꾸지 않았다.
- **저장소 유지 시험:** storage-maintenance 두 실패는 logical digest 불일치이며 과거 합성 스키마에서 `p.max_concurrent_turns`가 없다는 경고도 있었다. 원 검증기를 완화하지 않았다. 기반 이주/유지 시험 소유자가 과거 fixture와 현재 Store 조회의 호환성을 확인해야 한다.
- **그 밖의 화면·전달:** home, integrated, stop-follow-up, task-stage, task-threads와 orchestrator/regress의 남은 실패 이름·시각·명령은 JSON에 각각 남겼다. 알림·가짜 실행기·계약 준비의 소유를 기반/화면 담당이 나눠 확인해야 한다. 원 보관 세션 재열기의 고정 반례와 제품 생명주기 후속은 기존 `execution-workdir-regression-narrowing.md`에 보존했다.

최종 코드 검사는 `bun run typecheck`의 실제 절대 경로 호출로 종료0이었다. 전체 순차 실행기의 종료는1이며 하위 파일별 종료를 결과 JSON에 남겼다. 182개 파일의 성공·실패 및 35개 본문 미실행을 합격으로 바꾸지 않았다.

## 검증 후 추가된 원격판과 계약 경계

최종 원격 확인 `git ls-remote origin refs/heads/main`은 `166c99529eaae584169983049d0058bad78f6e29`를 반환했다. 이 판은 bc17046 이후 72개 파일 변경을 포함하며, 공식43은 계약의 입력·산출물·제한·제외 열이고 공식44는 `task_completion_reviews`다. **이 관측에서 다음 번호는45이며, 이 검증판의 workdir43을 그대로 적용하면 충돌한다.** 새 원격은 fetch하여 읽었지만 이번 검증판에 추가 merge하지 않았다.

새 `server/harness-worktree.ts`의 `executionPath`에는 로컬 file URI 정규화가 이미 있다. 그러나 전체 동등 회귀는 이번 판에서 실행하지 않았다. `executionExpectedCwd`는 명시 report workdir가 없어도 등록된 task worktree와 하위 경로를 기대 위치로 채택한다. 실제 호출자도 matcher와 지원 진단에 `task.worktree`를 전달한다. 새 시험 `tests/harness-worktree-scope.test.ts`는 check에 workdir 없이 `/repo/main` 밖 `/repo/.worktrees/editor/app`의 통과를 기대한다. 전용 검사 workdir 필드/저장 열은 해당 새 판의 입력·타입·저장에서 찾지 못했다.

이 규칙은 r2의 기존 위치 생략 시 직원 등록 위치 유지와 동일하지 않다. 새 main의 규칙을 제거하거나 이 작업의 기대를 완화하는 것은 이번 권한 밖이다. **총괄은 위치 생략의 우선 기준과 명시 workdir의 추가 경계를 먼저 정합화해야 한다.** 그 뒤 새 고정판에서 기존43·44를 보존하고 누락 메타데이터만 연결하며, URI 중복 helper를 추가하지 않는 방향으로 영향 회귀를 정할 수 있다. 이번 검증 결과를 새166판의 통과라고 쓰지 않는다.

운영 server_check의44와 새 원격 소스44는 숫자가 같지만 실제 배포 SHA 일치를 확인하지 않았다. 독립 검토·최신판 재연결·운영 소스 확인은 각각 후속 소유이며, 메인/서비스/운영 DB에는 이번 작업을 적용하지 않았다.
