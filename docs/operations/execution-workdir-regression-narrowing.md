# 보관 시험의 순서를 고쳤고 나머지 차단을 분리했습니다

계약 r2 전체 회귀는 아직 막힘이다. 검토 중인 연결판은 보존했다. 이번 변경은 보관 시험의 실행 순서와 격리 경로 진단 도구뿐이다. 제품 코드·기대값·승인·권한·위치 제한은 바꾸지 않았다.

| 범위 | 이번 관측 | 남은 조건 |
| --- | --- | --- |
| 보관 | 두 고정판에서 원 기대와 다른 보류 사유를 재현했다. 순서를 고친 동일 시험은 양쪽 22/0이다. | 독립 검토에 시험 수정 전달 |
| 옛 실행기 | 바이너리 부재와 가짜 소켓의 초안 보존 기대 충돌을 분리했다. | 지원되는 옛 실행기 설치 근거·시험 소유 판단 |
| WebKit | 추가 실패 사례 단독 1/0, 앞선 사례 포함 7/0을 양쪽에서 관측했다. | 과거 브라우저 종료 원인은 미확인 |
| 가짜 실행기 경로 | 다른 위치·설정·URL은 양쪽 거절, 같은 fixture 소유 입력은 양쪽 수용했다. | 기존 화면 시험의 fixture 구성 연결 |

## 보관 실패는 세션이 다시 열린 실패가 아니었습니다

기존 전체 실행에서 공통 실패는 `archive-gate.test.ts`의 “칸을 끝내는 동안 틱이 먼저 끝낸 칸을 다시 열지 않고, 다 끝나면 보관된다”였다. HTTP 200, 새 실행 0, 두 직원 asleep 검사는 통과했다. 마지막 전달 보류 사유만 expected=archived / actual=delivery_unknown이었다. 기존 출력의 attempts는 1이었다.

단독 원 시험은 양쪽 1/0이었다. 따라서 같은 명령을 통과할 때까지 반복하지 않고 전송 시도 순서를 명시한 반례를 만들었다. 원 Fake·setup을 각 고정판에서 가져오고, 틱을 60초로 정한 뒤 enqueue 다음 `await t.orch.pump(a.id)`를 먼저 호출했다. 그 뒤 원 보관 기대값을 그대로 확인했다.

두 판의 실제 최소 반례:

```json
{"before":{"attempts":1,"holdReason":"delivery_unknown"},"after":{"attempts":1,"holdReason":"delivery_unknown"},"httpStatus":200,"starts":0,"states":["asleep","asleep"]}
```

양쪽 종료 1, 0 pass / 1 fail이었다. 원 기대값을 낮추거나 실패 기록을 성공으로 바꾸지 않았다. `SendResult`에서 deliveryEffect 생략은 unknown이다. `sleepMember`는 보관 중 이미 시도한 전달의 보류 이유를 보존한다. 따라서 이 관측으로 제품 생명주기 결함이나 실제 세션 재열기를 주장할 수 없다.

시험 보정은 pair의 선행 자동 틱을 억제하고, 두 번째 칸을 닫는 중 첫 번째 칸에 `pump`를 명시적으로 끼우는 것이다. 시작 전 attempts=0, 첫 칸 asleep, 중간 pump 정확히 1회를 추가 검증한다. 기존 기대값과 unknown 재전송 방지 시험은 그대로다. 보정된 전체 파일은 연결판에서 22/0·140 expect, 같은 보정 시험을 기준판 제품 코드에 연결해도 22/0·140 expect였다. 다른 21개 사례를 성공으로 생략하지 않았다.

제품 수정은 필요하다고 확인하지 않았다. 구현 기반에는 “전달을 이미 시도한 상태를 보관만으로 archived로 바꾸지 않는다”는 반례와 이 시험 수정의 독립 확인을 인계한다.

## 옛 실행기 35개는 바이너리 부재로 계속 막힙니다

PATH와 알려진 설치 위치에서 `herdr`를 찾지 못했다. 확인한 위치는 Applications, 사용자 local/bin·config/herdr/bin, Homebrew bin, 기존 프로젝트 런타임이다. 사용자 local/bin에는 `herdr-core` 링크만 있었다. 이를 옛 `herdr --session` 실행기로 바꾸지 않았다.

고정 저장소의 vendor/herdr-core/README.md와 setup-core.ts는 herdr-core 0.1.18·generation 1의 검증된 설치만 정의한다. 옛 `herdr` 설치 버전·서명·배포 출처는 이 경로에 없다. 옛 harness는 `herdr --session <시험 이름>`을 필요로 한다. 지원 근거 없는 설치·별칭·가짜 대체·권한 완화는 하지 않았다. 또한 옛 harness의 종료 절차에는 시험 세션 삭제 호출이 있으므로, 실행 환경을 복구할 때 자료 보존 조건도 소유자가 맞춰야 한다.

가짜 소켓 시험 한 건은 바이너리와 무관하게 양쪽에서 종료 1이다. “입력칸에 남은 글은 지우는 키를 한 번…”은 `{ok:true}`를 기대하지만 실제 결과는 다음과 같다.

```json
{"ok":false,"reason":"input_busy","detail":"입력칸의 초안을 보존했습니다","retryable":true,"deliveryEffect":"not_written"}
```

이는 같은 두 판의 초안 보존 분기와 일치한다. 정책을 옛 삭제 기대에 맞추지 않았다. 실행기 설치 소유와 가짜 소켓 시험의 기대 계약 소유를 나누어야 한다. 35개 하위 사례는 여전히 미실행이다.

## WebKit의 추가 한 건은 이번 최소 실행에서 재현되지 않았습니다

고정 Playwright 1.64.1 / WebKit 2370 / Bun 1.3.14를 썼다. 같은 환경에서 주석·닫는 태그 사례만 실행하면 양쪽 1/0·12 expect다. 앞선 격리 사례를 포함한 WebKit 묶음은 양쪽 7/0·54 expect다. 마지막 두 사례의 브라우저 닫힘도 이 묶음에서는 없었다.

이 결과는 과거 전체 실행의 기준 2 / 연결 3 실패를 덮어쓰지 않는다. 최소 실행은 10개 다른 사례를 명시적으로 필터했다. 추가 사례가 과거에 먼저 닫힌 원인과 연결판의 인과관계는 여전히 미확인이다. 브라우저·제품·CSP·격리 정책은 수정하지 않았다. 시작 훅 예산은 양쪽 30초로 맞췄다. 이미 명시된 본문 기한 30/60초는 그대로다. 연결판 묶음 마지막 구간에 짧은 보관 시험이 겹쳤으므로 엄밀한 호스트 부하 동일성까지 주장하지 않는다.

## 가짜 실행기는 서로 다른 fixture의 경로를 섞고 있습니다

세 기존 화면 시험은 먼저 `startBrowserCore()`로 소유 runtime을 만든다. 이어 별도 mkdtemp의 WORK/PROJECT_DIR을 만들고 실제 실행 위치로 전달한다. 실행기의 `assertOwnedPath`는 앞의 runtime만 허용한다. 두 고정판에서 해당 fixture·세 화면 시험의 파일 지문은 동일하다.

새 진단 도구는 원 fixture와 원 coreRpc를 그대로 사용한다. 양쪽에서 다른 fixture의 cwd, 다른 위치의 MCP 설정, 소유하지 않은 URL을 각각 거절했다. 같은 fixture의 cwd·설정·등록 loopback URL은 수용했다. 실제 모델·제공자 턴은 0회이며 원 CLI와 서비스에는 접속하지 않았다. 자신이 연 소켓·리스너만 닫고 두 격리 폴더는 남겼다.

최소 후속은 화면 시험의 WORK·HOME·설정·가짜 실행 파일·HTTP 서버를 하나의 명시적 runtime 소유로 구성하는 것이다. URL을 임의 allowlist에 추가하거나 cwd 비교를 없애는 수정이 아니다. 실제 제공자 턴과 화면 전체의 연결은 이 진단 결과만으로 통과 처리할 수 없다. 범위 밖 화면 제품은 수정하지 않았다.

## 최신 원격의 새로운 41번은 이 연결판과 충돌합니다

이번 조사 도중 origin/main 참조는 49df056으로 이동했다. 그 판의 41번은 `members.execution_issue_json`이며, 고정 연결판 a75c830의 41번 `report_checks.workdir`와 다르다. 지원된 서버 조회도 DB41/지원41/required/execEvidence available이었다. 숫자 41이 같다는 이유로 이 작업의 workdir 코드가 운영에 적용됐다고 말할 수 없다.

고정 검토판을 바꾸거나 새 메인·서비스를 합치지 않았다. 다음 연결 소유자는 기존 이주 41개를 보존한 뒤 실제 최신 다음 번호를 재확인해야 한다. 지금 관측 기준으로는 42이며, 합칠 때 다시 확인해야 한다. 새 기준의 v41 행·execution_issue_json·workdir 보존과 재열기 검사가 필요하다. 이 추가 통합은 이번 시험 보정 커밋에 섞지 않았다.

## 집계와 후속

초기 전체·최신 추가·이번 최소 관측은 서로 더하지 않는다. 고정 a75c830 기준 전체 169개 중 이전 40개 파일 실행 기록을 보존한다. 이번 보관 파일은 그 40개 안의 결과를 교체할 수 있지만, artifact/herdr는 선택 사례만 실행했다. 최신 전체 미실행 129개 파일과 herdr 하위 35건은 그대로 남는다. 환경·정책 차단이 풀리기 전에 전체 성공 시험을 등록용으로 반복하지 않았다.

이번 코드 검사는 종료 0이다. 원 God 다섯 명령·QA 완료 제출·원 기록·운영 DB·W5 정책은 보존했다. 전체 미실행 0·실패 0이 아니므로 완료 제출을 하지 않는다. 기존 a75c830 독립 검토와 이번 시험 보정의 독립 확인은 다른 판으로 취급해야 한다.

## 세부

- 원 업무: tk_w_fJtAv1MraUjs / 계약 r2.
- 고정 검토판: a75c830ed4c01137552a2a636a59e231bb53cd59. 원 브랜치 fix-connect-execution-workdir-tk_w_fJtAv1MraUjs는 추적 변경 없이 보존했다.
- 고정 기준판: 5140c3936ad990f90dfcbe8ddc7212ab94370ab2.
- 이번 브랜치: test-narrow-execution-regressions-tk_w_fJtAv1MraUjs.
- 이번 워크트리: /Users/hyejookim/Programming/01_Ing/.worktrees/IAMCEO/narrow-execution-regressions-20261118.
- 기준 워크트리: /Users/hyejookim/Programming/01_Ing/.worktrees/IAMCEO/execution-workdir-latest-base-20261118. 원 추적 파일을 수정하지 않고 같은 보정 시험의 임포트만 기준 소스로 연결한 파생 파일을 썼다.
- 새 원격 참조: 49df056d9d6e88f25532d809d21d7d99d2421f6a. 실제 서비스 소스 SHA는 미확인이다.
- 실제 명령·개별 결과·시각은 execution-workdir-narrowing-results.json에 연결한다. 파생 시험은 기본 전체 목록에 중복 추가하지 않는다.
- 원문 연결 거절 세 묶음은 별도 tk_w_DMDXmIiu4jM6의 자료 f_qfbb3q3DDa15에 있다. 명령 실행·순서 차단의 원인으로 섞지 않는다.

최소 재현 명령에서 BUN은 등록된 `/Users/hyejookim/Programming/01_Ing/.runtime/IAMCEO/toolchain/node_modules/bun/bin/bun.exe`다.

```sh
IAMCEO_TEST=1 "$BUN" test ./tests/archive-gate.test.ts
IAMCEO_TEST=1 "$BUN" test ./tests/herdr.test.ts -t '입력칸에 남은 글은 지우는 키를 한 번'
IAMCEO_TEST=1 "$BUN" test ./tests/artifact.browser.ts --timeout 30000 -t '아티팩트 격리: webkit'
IAMCEO_TEST=1 "$BUN" scripts/probe-fixture-ownership.ts '/absolute/path/to/isolated/IAMCEO/worktree'
```

실제 실행은 기록에 적힌 정리된 환경과 절대 BUN 경로를 사용했다. 위 명령은 독립 검토용 축약이며 그대로 실행했다고 보고하지 않는다. 반례 파생 파일은 `.pumasi/regression-narrowing-20261118/`에 남겼다. 다른 검토 환경에서는 원 archive-gate의 Fake·setup을 가져와 자동 틱 60초, enqueue 뒤 명시 pump 1회, 기존 보관 기대값 순서로 재현한다.
