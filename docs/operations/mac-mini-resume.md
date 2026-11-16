# 이전 조건 감시와 같은 세션 재개

기존 이전 작업을 조건 변화에 따라 같은 Codex 세션으로 재개한다. 감시 자체는 원본을 읽기만 하며, 진행 작업·승인·큐를 수정하지 않는다. 구현 전 확정한 범위와 완료 조건은 다음과 같다.

| 요구 | 완료 판정 |
| --- | --- |
| 준비·idle·영수증·접속 조건의 실제 변화를 감시한다. | 시각·PID만 달라진 반복 관측은 재개를 만들지 않고, 의미 있는 변화는 한 번만 대기열에 넣는다. |
| 원본의 안정적인 종료를 확인한다. | 등록 프로젝트와 전체 메시지 페이지를 읽고, 실행/대기/막힘·열린 결정·미전달 큐가 없는 상태를 간격을 둔 두 번의 관측으로 확인한다. |
| 같은 세션만 재개한다. | 고정 UUID와 `codex exec resume`을 사용한다. 현재 PID 종료와 terminal turn event를 모두 확인하고, 세션별 프로세스·파일 잠금·영속 claim으로 중복 실행을 막는다. |
| GUI 없는 감독을 지원한다. | user/501 Background launchd에서 가짜 재개 프로그램으로 실제 기동·중복 방지·재시작을 검증한다. 모델 시험 호출은 하지 않는다. |
| 준비가 끝나야 원본을 동결한다. | 실제 대상 서버·복원·CLI 로그인·접속·기존 서비스·최종 소스 호환 검증이 없으면 PATCH와 EXPORT_REQUEST 작성을 거절한다. |
| 원본 변경에는 복구 경로가 있다. | 정식 PATCH API만 사용하고 변경 전 플래그·응답을 private 영수증에 저장한다. 실패 시 대상이 비활성임을 확인하고 변경한 플래그를 복원한다. |
| 실제 경로·프로젝트 ID·인증을 Git과 분리한다. | 감독/전송 도구는 외부 0600 설정만 읽는다. access code는 정식 Bearer 요청에만 쓰며 로그·재개 프롬프트·Git에 포함하지 않는다. |

이전 준비와 무관한 제품 기능을 고치지 않는다. 최초 전체 회귀 실패는 정확한 SHA·런타임·경로와 원인을 분류하고, 최종 원본 SHA가 도착하면 호환 검증을 다시 한다. 초기 데이터를 최종 운영 데이터로 바꾸지 않는다.

공식 CLI 근거: https://learn.chatgpt.com/docs/developer-commands#codex-exec (2026-11-16 확인). 로컬 Codex 0.167.0의 `codex exec resume --help`에서도 UUID·stdin prompt·JSON event를 확인했다. `--last`나 fork는 사용하지 않는다.

## 실행과 설치

실제 경로·project ID·메시지 ID·세션 UUID는 Git 밖 0600 JSON 설정에 둔다. `migration-supervisor.example.json`은 구조 예시이며 실제 설정이나 키를 포함하지 않는다.

```sh
python3 tests/migration-supervisor.test.py
python3 tests/mac-mini-migration.test.py
CONFIG=/absolute/private/migration-supervisor.json
python3 scripts/migration_supervisor.py --config "$CONFIG" observe
python3 scripts/migration_supervisor.py --config "$CONFIG" status
python3 scripts/migration_supervisor.py --config "$CONFIG" run
```

실제 배치는 검증한 Git SHA의 `git archive`에서 감독 스크립트와 공통 private JSON 도구를 꺼내 고정 경로에 둔다. 기존 감시 LaunchAgent만 백업·정상 종료하고 같은 label을 `LimitLoadToSessionType=Background`, `RunAtLoad=true`, `KeepAlive=true`로 `user/<uid>`에 등록한다. 감독이 멈춰도 그 감독이 재개한 Codex 턴은 interrupt하지 않는다. 다른 서비스·Codex·직원은 중지하지 않는다. 머신 재부팅은 실행하지 않으며 이 검증을 부팅 시험과 혼동하지 않는다.

감독은 120초 간격으로 인증된 source GET, 정책 메시지 실제 delivery, 전체 메시지 페이지, 열린 결정, CLI 로그인, 선택한 HTTPS 주소의 실제 app build ID, 기존 health, GUI/Docker를 관측한다. 사용자는 Tailnet 전용 접속을 확정했다. DOMAIN-PREFERENCE의 `access_scope=tailnet_only` 또는 `mode=tailscale_only`를 인식하며 이 모드에서는 공개 DNS/TLS·ingress 계정 확인을 생략한다. 브라우저 저장소·쿠키는 읽지 않는다. 초기 복원본 조회의 `initial_viewing_ready`는 운영 후보의 `domain_ready`/`target_prepared`와 구분한다. 조회의 상세 조건은 [초기 복원본 접속](../mac-mini-read-only.md)에 있다.

`state.json`에는 의미 있는 조건만 fingerprint로 비교한다. 바뀐 시각·heartbeat·PID만으로 재개하지 않는다. 실행/대기/막힘·열린/전달 대기 결정·queued/sending/delivering 메시지가 있으면 idle 자격을 주지 않는다. 120초 이상 간격을 둔 같은 idle 관측 두 번이 필요하다. 관측 불가나 상태 변화가 생기면 자격을 초기화한다.

현재 턴은 소유 PID의 실행 시작 시각·프로그램과 terminal event를 함께 확인한다. 프로세스가 사라져도 turn.completed/turn.failed가 없으면 자동 재개하지 않고 `owner_exit_unconfirmed`로 남긴다. 재개는 고정 UUID의 `codex exec ... resume UUID -`이며 last/fork를 사용하지 않는다. 세션 UUID가 담긴 다른 resume 프로세스도 검사한다. 감독·dispatch 잠금과 fsync한 영속 claim을 먼저 쓰고 실행한다. claimed 이후 결과를 알 수 없으면 `uncertain_launch`로 남겨 같은 입력을 반복하지 않는다. 실행 전 확실한 spawn 실패도 매 poll 재시도하지 않고 새로운 실제 조건 변화나 운영자 점검을 기다린다.

CLI는 현재 승인된 실행 권한을 이어 쓰며 `approve-for-me`나 직원 승인 응답을 추가하지 않는다. 감독 자체의 source write는 0이며 외부 재개 프롬프트에도 접속 코드·메시지 본문을 넣지 않는다.

진행 중인 소유 턴이 대기열의 변화까지 확인하고 상태 보고에 반영했다면 `acknowledge --owner-pid <active_job.pid> --fingerprint <검토한 meaningful의 SHA256>`로 처리할 수 있다. dispatch 잠금 안에서 살아 있는 동일 PID 신원과 최신 fingerprint가 일치해야 하며, 새 조건이 기록됐으면 거절한다. active_job과 현재 턴은 그대로 둔다. 처리 이후 새로운 실제 변화는 다시 대기열에 들어간다. 미검토 상태를 자동으로 지우거나 현재 모델이 끝나기 전에 다른 모델을 시작하지 않는다.

## 동결·백업 요청·복구

실제 준비 검증을 완료한 뒤에만 다음 명령을 사용한다.

```sh
python3 scripts/migration_supervisor.py --config "$CONFIG" freeze
python3 scripts/migration_supervisor.py --config "$CONFIG" verify-final
python3 scripts/migration_supervisor.py --config "$CONFIG" rollback
```

`freeze`는 TARGET_PRECUTOVER_VALIDATED.json의 verified=true와 server/data_restore/cli_auth/domain/baseline_services/source_compatibility/required_regression 증거 파일·SHA를 요구한다. 선택한 binary SHA·source SHA·지원 schema·원본 runtime build ID와 실제 health/로그인을 다시 비교한다. 불완전한 준비 영수증을 미리 true로 만들지 않는다. 현재 준비 후보는 production_eligible=false이므로 이 명령으로 원본을 동결할 수 없다.

동결은 최근 두 번의 안정 관측을 요구하고, 등록 목록·모든 메시지 페이지·회원 상태·열린 결정을 PATCH 직전/직후 다시 읽는다. 정식 프로젝트 runnerEnabled PATCH만 허용하며 승인 답변·interrupt·sleep·다른 필드 쓰기를 지원하지 않는다. 변경 전 플래그와 응답을 SOURCE_FROZEN.json에 보존하고 모두 false임을 확인한 뒤 원본 exporter의 계약에 맞춰 EXPORT_REQUEST를 원자적으로 게시한다. 요청 ID는 ASCII 영숫자/밑줄/하이픈만 사용한다. 같은 요청은 재작성·재동결하지 않는다.

도중에 실패하면 대상이 활성화되지 않았음을 확인한 뒤 변경한 원본 플래그를 복구한다. 대상 활성화 표식 또는 운영 readiness가 있으면 자동 복구를 거절하고 실행 소유권 점검을 요구한다. rollback은 export 요청을 취소 보관하고 복구 응답을 확인한다. 복구 실패도 영수증에 별도 기록한다. freeze/rollback은 전용 잠금으로 동시 실행을 막는다. 실제 원본 동결/복구를 시험하지 않고 격리 가짜 API에서 성공·실패·플래그 보존을 검증한다.

`verify-final`은 준비용 초기 파일을 거절한다. 현재 요청·SOURCE_FROZEN·CUTOVER_READY의 ID, 모든 전달 파일의 크기/SHA, WIP archive/metadata 존재, 실제 SQLite schema·integrity/FK·행 수·runner 꺼짐·미전달 큐 부재, runtime archive의 uploads 파일별 SHA와 DB 첨부 경로/크기를 대조한다. source schema가 선택한 코드보다 높으면 거절한다. 결과는 입력 검증일 뿐 Git bundle 이력의 fetch/push·실제 복원·운영 활성화 영수증이 아니다. 최종 refs 동기화·private WIP 보존·cwd 매핑·정식 세션 재연결과 runner 플래그 복원은 같은 이전 세션에서 계속 수행한다.

## 실패의 범위

전체 제품 회귀는 c408f8e를 통합한 준비 브랜치에서 Bun 1.3.14로 실행한 결과다. 환경 의존 4건은 격리 상위 환경에서 통과했고, schema 고정 기대 2건·legacy Herdr 계약/fixture 24건은 남았다. 화면 suite도 옛 cwd와 현재 격리 fixture가 맞지 않는다. 이 실패를 같은 이전 준비에서 제품 전체 재개발로 확대하지 않는다. 최종 원본 실제 SHA에서 배포에 필요한 core/session/복원/HTTP/인증 및 변경 기능을 다시 검증하고 실패/제외 근거를 분리해 보고한다.

## 최종 동기화 요청과 실제 로그인 세션 검증

2026-11-16 사용자가 최종 동기화를 지시했고 맥미니의 Claude 공식 로그인을 완료했다. 터미널에서 성공한 로그인은 `user/501`의 Background 서비스에서는 감지되지 않았고, 같은 CLI를 `gui/501`의 Aqua 서비스로 실행하자 감지됐다. 인증 자료나 키체인 설정은 변경하지 않았다. 실제 직원을 사용할 운영 서비스와 같은 세션 감독은 로그인 세션에서 실행하며, GUI가 없는 최초 빈 데이터 서비스 시험을 실제 Claude 인증의 근거로 삼지 않는다.

고정 Git 후보는 `d3f234e1db8685b2dcc304ffce030bde269dfe47`이다. 검토된 owner-retry 수정 `14be9be`와 운영 전환 때 적용하기로 한 자료 한 개 지침 `d0dab35`를 포함한다. 운영 관련 검사 132개, 지침·도구·새 세션/재개 검사 50개, 감독 검사 23개와 타입 검사가 통과했다. 고정 archive 빌드·core 서명·관리되는 빈 점검 서버의 HTTP/HTTPS 인증·build ID·실행기 연결도 확인했다. 제품 전체 회귀가 통과했다는 뜻은 아니다.

원본은 정식 `runnerEnabled:false` PATCH로 신규 자동 실행만 차단했다. 이미 진행 중인 독립 검토의 실행 ID와 종료되지 않은 기록을 보존했으며, interrupt·sleep·자동 승인 응답을 보내지 않았다. 전환 시점 질문에는 사용자가 명시한 최종 동기화 지시를 `after_sync` 답으로 반영했다. 실행 중인 세션에 체크포인트 글을 넣는 요청도 앱이 입력 전에 거절했다. 원본 작업이 자연 종료해야 최종 내보내기를 요청한다.

원본의 오래된 직원 한 명은 이전 실행의 확정 종료 기록이 있지만 native prompt를 분류하지 못하는 상태다. 그 상태와 지시를 보존하며, prompt에 답하거나 완료·수신을 추정하지 않는다. 이 직원은 대상의 자동 실행에서 제외한다. 신규 실행 차단 뒤 진행 실행이 없고 전달 대기 메시지·열린 결정이 없는 경계를 120초 간격으로 두 번 검증해야 최종 요청을 만든다.

등록된 `dev.iamceo.final-sync-drain-20261116`은 모델 없이 경계를 확인한다. 최종 백업 영수증은 기존 같은 세션 감독의 재개 조건이며, 데이터 가져오기·운영 서비스 시작·총괄 시작의 완료 영수증을 대신하지 않는다. 진행 상태와 실제 경로는 Git 밖 이전 루트의 `MANUAL_FINAL_SYNC_PROGRESS.json`, `FINAL_SYNC_BOUNDARY_WATCH_INSTALLED.json`, `GUI_CLI_AUTH_VERIFIED.json`에 둔다. 최종 전환 뒤 점검 서버·임시 HTTPS 경로·완료된 이전 감독을 정리한다.


## 최종 복원 뒤 남은 사람 확인 감시

최종 운영 주소로 전환한 뒤에도 총괄의 폴더 신뢰 확인이 남을 수 있다. private 설정의 선택 항목 `target_handoff`에 `origin`(HTTPS), `credential_file`, `members` 목록을 넣는다. 각 항목은 이미 시작한 직원의 `member_id`, `project_id`, 이미 등록한 재개 글의 `message_id`다. 실제 ID와 인증 자료는 Git에 넣지 않는다.

감독은 GET으로 직원/글의 ID와 프로젝트를 대조하고 전달 상태와 blocked/waiting 원인 코드만 비교한다. 글 본문·prompt 내용·시각·PID·일하는 중/대기 중 전환은 재개 fingerprint에 추가하지 않는다. 잘못된 ID·접속 실패는 성공으로 처리하지 않는다. 승인에 응답하거나 글을 재등록하지 않으며, 사람이 확인을 마치면 기존 앱의 큐 수명주기가 글을 전달한다. 같은 세션 소유 PID 종료와 terminal event, 영속 중복 방지 잠금은 그대로 적용한다.

운영 주소/build로 설정을 갱신한 뒤 현재 소유자가 새 관측을 검토하고 acknowledge한다. 남은 두 글이 실제 delivered이고 실행 근거가 확인돼야 전체 재개를 완료로 기록한다. 그전에는 감독을 유지하고 완료된 경계 감시·빈 점검 서버만 정리한다. 운영 서비스/진행 직원은 감독 교체로 중단하지 않는다. 최종 data 홈의 재시작 검증은 실제 업무 시작 전에 완료했으며 재부팅 시험과 구분한다.

2026-11-16 운영 보고: 최종 snapshot의 schema 33·ID와 첨부 275개 해시, 운영 HTTPS 로그인/12개 화면/모바일, 기존 관리 서비스 health가 검증됐다. 본사·Native의 재개 글은 delivered, Design·God는 폴더 신뢰 확인으로 held다. 자동 승인·미확인 글 재전송은 하지 않았다. 감독 단위 검사 25개와 이전 안전 검사 5개가 통과했다. 제품 전체 회귀 실패는 기존 TEST-FAILURES 기록대로 남긴다.
