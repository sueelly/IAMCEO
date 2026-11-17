# 실행 위치 연결판의 독립 검토 안내

실행 위치 수정은 검증했지만 계약 r2 전체 회귀는 막힘이다. 최신판의 보관 시험 실패, 기존 화면·실행기 실패와 하위 미실행이 남았다. 이 문서는 구현자의 확인이며 독립 검토를 대신하지 않는다.

## 기준과 보존

- 고정 검토판: `e63ebd70633474c42c60a3a958e662dac2615582`. 기존 브랜치와 워크트리, 미수신 검토 전달은 변경하지 않았다.
- 최초 전체 대조 기준: `2f51d9b66ba2f66cd50bcf71a7e4aa117c3ea831` / 스키마 38.
- 연결 대상으로 고정한 최신 원격: `5140c3936ad990f90dfcbe8ddc7212ab94370ab2` / 이주 40개.
- 최신판은 URI/workdir 수정을 포함하지 않는다. 원 구현의 기능을 작업 브랜치에 가져오고 최신 원격을 작업 브랜치에 연결했다. 메인 브랜치는 변경하지 않았다.
- 기존 이주 40개는 원문 그대로다. nullable `report_checks.workdir`만 **41번**으로 추가했다. 다른 업무의 39·40번 이주와 정책은 수정하지 않았다.
- 최신 서비스 조회는 DB 40 / 지원 40 / required / 실행 근거 available이다. 이 작업의 41번 코드는 실제 서비스에 적용하지 않았다. 서비스의 정확한 소스 SHA는 확인하지 않았다.

## 파일별 변경 이유

| 파일 | 이유 |
| --- | --- |
| `server/harness-workdir.ts` | 검증 가능한 로컬 file URI만 절대 경로로 푼다. 기존 절대 경로는 그대로 둔다. |
| `server/harness-evidence.ts` | 정규화한 실제 cwd를 명시 workdir 또는 기존 등록 위치와 대조한다. 누락 cwd를 와일드카드로 쓰지 않는다. |
| `server/harness.ts` | 원 command와 독립된 선택 workdir를 정의한다. |
| `server/agent-tools.ts` | workdir의 절대 경로·유니코드·길이를 검증한다. |
| `server/store.ts` | 원 command와 workdir를 별도로 기록하고 조회한다. |
| `server/orchestrator.ts` | 입력→검사 메타데이터→순수 판정·지원 진단·업무 조회에 같은 workdir를 연결한다. 최신 정책을 보존한다. |
| `server/harness-exec-diagnostics.ts` | 판정기와 같은 cwd 정규화를 지원 진단에 사용한다. |
| `server/db.ts` | 기존 40개 이주 뒤에 workdir 열을 한 번 추가한다. |
| `tests/harness-workdir.test.ts` | URI 수용·거절, 위치·명령·시각·종료·재사용 경계를 검증한다. |
| `tests/harness-workdir-integration.test.ts` | 격리 API·기록·진단과 과거 NULL의 호환을 검증한다. |
| `tests/harness-workdir-connection.test.ts` | 합성 v35·37·38·39·40 DB의 행·명령·위치·업무 상태를 이주·재열기 전후 지문으로 대조한다. |
| `tests/artifact.browser.ts` | 두 브라우저 시작 훅만 Playwright 기본 시작 예산인 30초와 맞춘다. 본문 판정·시간 제한·격리는 유지한다. WebKit 본문 실패는 남았다. |
| `scripts/execution-workdir-inventory.py` | 과거 실패와 파일을 대응시키고 중복 wrapper를 분리한다. |
| `scripts/execution-workdir-matrix.py` | 같은 환경에서 파일별 새 프로세스를 하나씩 실행한다. 실패·누락·불완전·skip은 외부 실패로 전달한다. |
| `tests/execution-workdir-matrix.test.ts` | 실패·skip·누락을 성공으로 세지 않는 실행기 회귀다. |
| 이 문서와 `execution-workdir-r2-results.json` | 판별 집계, 최소 재현, 미확인과 후속 소유를 전달한다. 원 출력은 수록하지 않는다. |

## 입력의 뜻과 경계

```json
{"kind":"behavior","name":"합성 검사","result":"pass","command":"bun  test 'synthetic test.ts'","workdir":"/synthetic/review results/한글%","evidence":"도구의 cmd와 workdir를 각각 기록함"}
```

command는 실제 도구 문자열이다. 실행하지 않은 cd를 붙이지 않는다. workdir를 생략하거나 과거 DB 값이 NULL이면 기존 등록 위치를 사용한다. 명시 위치가 실제 cwd와 다르면 거절한다. 누락·상대·잘못된 URI는 위치 미확인 와일드카드가 아니다.

로컬 호스트는 런타임 URL이 빈 호스트로 해석하는 localhost만 허용한다. LOCALHOST도 같은 규칙이다. 원격·루프백 IP·다른 스킴·상대 file:값·깨진 인코딩·NUL·query·fragment를 거절한다. 공백·한글·인코딩된 로컬 경로는 회귀에 포함했다. Bun 1.3.14의 fileURLToPath만으로 malformed percent를 거절하지 못하므로 별도 디코딩 검증을 유지한다.

## 검증 결과를 판별로 구분한다

1. 최초 38 기준 전체 파일 대조: 기준 157개, 연결 161개를 모두 실행했다. 수정 전 이주 실패 3건과 수정 후 성공을 기록했다. 새 URI/API 67건·이주 3건·실행기 2건은 통과했다.
2. artifact 시작 훅 보정 뒤 해당 파일만 두 판에서 다시 실행했다. 기준 15 pass/2 fail, 연결 14 pass/3 fail이었다. 시작 훅은 통과했고 WebKit의 `Target page, context or browser has been closed`가 남았다. 연결에서 한 사례가 더 실패한 인과관계는 미확인이다. 기대값을 완화하거나 반복 실행하지 않았다.
3. 초기 전체 결과에서 artifact만 최신 관측으로 교체하면 기준 2625 pass/72 fail, 연결 2697 pass/72 fail이다. 각 fail 수에는 herdr 시작·정리 훅 오류 2개가 포함된다. 파일 미실행은 0이지만 **herdr 하위 35건은 미실행**이다. 이를 성공으로 더하지 않는다.
4. 최신 40 기준으로 다시 실패 회귀 5건을 확인하고, 41번 이주 뒤 이주·재열기 5건과 API·지원 진단 15건이 통과했다. 기존 보고 command·과거 NULL·명시 workdir·업무 상태, 배정 영수증, 실행 상한·실패 보고 상태의 지문을 보존했다.
5. 최신 원격에서 바뀐 38개 시험 파일을 같은 조건으로 추가 대조했다. 기준 811 pass/2 fail, 연결 812 pass/1 fail이다. 상세 결과는 옆 JSON의 latestDelta에 있다. 초기 전체와 최신 추가 대조를 더해 최종 전체 통과 수로 쓰지 않는다.
6. 최신 연결판의 전체 파일 수는 169개다. 최신 시점 실행은 추가 대조 38개와 격리 연결 2개, 총 40개다. 나머지 129개는 초기 대조를 보존했으며 최신 코드로 전체 재실행하지 않았다. 따라서 최신 전체 미실행 0·실패 0은 충족하지 못한다.
7. 최종 코드 검사는 `bun run typecheck`로 확인한다. 실행 기록·종료값은 업무 보고에 연결한다.

각 단계의 sourceBefore/sourceAfter 지문이 일치했다. 첫 대규모 종료 137의 원인은 확인하지 않았다. 파일별 실행에서는 137과 타임아웃이 발생하지 않았지만, 이것만으로 과거 원인을 단정하지 않는다.

## 같은 시험 환경과 정확한 재현

검사 런타임은 등록된 Bun 1.3.14다. 두 판은 같은 frozen lock과 Playwright 1.64.1을 쓴다. Chromium 1248과 WebKit 2370을 준비했다. 실제 개인 기본값은 바꾸지 않았다.

실행기는 IAMCEO_TEST=1, 자식 umask 022, 시험용 evidence 폴더, 같은 Bun 자식 PATH를 지정한다. 운영·제공자 인증 환경은 상속하지 않는다. 파일별 실제 argv·cwd·UTC 시작/종료·개별 종료는 옆 JSON에 있다. 해당 자식 명령을 네이티브 최상위 도구 호출로 꾸며 보고하지 않는다. 실행기 전체는 실패가 있으면 종료 1이다.

독립 검토자가 새 격리 워크트리에서 쓸 최소 회귀는 다음과 같다. `bun`은 같은 등록 1.3.14 런타임을 가리키게 한다.

```sh
bun install --frozen-lockfile
IAMCEO_TEST=1 bun test ./tests/harness-workdir-connection.test.ts ./tests/harness-workdir-integration.test.ts
IAMCEO_TEST=1 bun test ./tests/harness-workdir.test.ts ./tests/execution-workdir-matrix.test.ts
bun run typecheck
```

전체 파일 목록과 순차 실행기의 입력은 `execution-workdir-r2-results.json`의 leafFiles/wrappers다. 새 출력 폴더와 같은 조건의 별도 기준 워크트리를 지정한다. 원 God checker 다섯 명령은 이 문서의 재현에 포함되지 않는다.

## 남은 실패와 필요한 소유

| 파일/범위 | 관측과 최소 재현 | 필요한 소유 |
| --- | --- | --- |
| `archive-gate.test.ts` | 최신 기준 2 fail, 연결 1 fail. 같은 보관 중 세션 재열기 사례가 두 판에서 실패한다. 같은 순차 실행기의 이 파일 argv/cwd/env로 재현한다. | 보관·세션 생명주기 시험 소유 |
| `artifact.browser.ts` | 시작 훅 수정 뒤 WebKit 본문 2/3 fail. 연결의 추가 1건 원인은 미확인이다. | 브라우저·자료 격리 시험 소유 |
| `herdr.test.ts` | 초기 두 판 24 fail(훅 2 포함), 하위 35 미실행. `herdr` ENOENT이며 알려진 설치 경로에도 없다. 가짜 소켓 시험 일부는 현재 초안 보존과 옛 삭제 기대가 충돌한다. 바이너리를 새로 설치하거나 정책을 변경하지 않았다. | 옛 herdr 시험 환경·실행기 정책 소유 |
| `e2e-fake.browser.ts`, `integrated.browser.ts`, `screens-regress.browser.ts` | 초기 각각 두 판 14/8/16 fail. fixture 밖 경로가 거절된다. 가짜 cwd·HOME·실행 파일·시험 서버를 동일 runtime의 소유 범위에 맞춰야 한다. 소유 경로·URL 검사를 풀면 안 된다. | 가짜 실행기·브라우저 fixture 소유 |
| `home.browser.ts` | 초기 기준 3/연결 2 fail. 배지 기대값과 본사 시간 초과, 기준판 펼침 사례가 포함된다. | 해당 화면 시험 소유 |
| `flow-recovery.test.ts`, `orchestrator.test.ts`, `regress.test.ts` | 초기 두 판 각 1 fail. 보완 보고 수와 wait 결과가 기대와 다르다. 최신 delta의 regress는 두 판 86/0이다. 나머지 최신 재현은 미확인이다. | 복구·직접 CLI 전달 시험 소유 |
| `storage-maintenance-optimization.test.ts` | 초기 두 판 2 fail. 최적화 전후 논리 데이터 지문 불일치다. 관련 유지보수·검증 코드는 수정하지 않았다. 최신 재현은 미확인이다. | 격리 스토리지 이주·최적화 소유 |

과거 59개는 관측된 이름 수다. 하위 이름 52개와 중복 wrapper 이름 7개로 대응시켰고 미대응은 0이다. 현재 새로 관측된 실패를 변경 유발 실패로 단정하지 않는다. 파일별 결과와 원문 시험 이름은 옆 JSON에 두었다. 실패를 skip이나 성공으로 바꾸지 않았다.

## 원 다섯 항목과 운영 후속

원 다섯 항목은 command·도구 workdir·CommandExecution id/argv/cwd/시각/개별 종료만 제한해 순수 함수로 대조했다. 기준 0/5 → 연결 5/5, 위치 생략과 다른 위치는 각각 0/5였다. 원 command를 바꾸지 않았다. 실제 검사·QA 제출·원 JSONL/DB/보고를 변경하지 않았다. 원 출력·소설 본문·전체 실행 기록은 Git에 넣지 않는다.

이 대조의 기준/연결 파서와 진단 파일은 최신 연결 뒤에도 동일하다. 파일 지문을 JSON에 남겼다. 따라서 같은 순수 함수의 결과만 연결하며, 원 거절 당시 전체 내부 경로·운영 전체 관문·다른 업무 사용 여부의 실제 판정은 주장하지 않는다.

후속은 최종 작업 브랜치의 독립 검토, 기존 시험 환경·실패의 소유 배정, 필요 범위 회귀, 실제 서비스 전환이다. 서비스 전환은 별도 권한과 기존 백업·이주·MCP 스키마 갱신 절차가 필요하다. 현재 서비스 40에는 이 작업의 명시 workdir 도구 필드가 없으므로 이 직원 자신의 자동 실행 연결도 확인하지 못했다. 실제 종료 0과 운영 자동 연결을 구분하며 완료 재제출을 반복하지 않는다.
