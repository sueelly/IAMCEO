# IAMCEO 맥미니 이전 계획

등록된 프로젝트 4개(본사 포함)를 고유 저장소 IAMCEO와 god의 이력·대화·자료와 함께 맥미니로 옮긴다. 2026-11-16 최종 백업의 복원과 운영 HTTPS 접속은 검증됐다. 기존 총괄 4명의 시작 요청 중 본사·Native는 재개 글을 수신했고, Design·God는 Claude 폴더 신뢰 확인에서 기다린다. 전체 재개 완료로 판정하지 않는다. 사용자 실행 지시의 식별자는 `.migration/2026-11-16`이다.

## 최종 입력과 실제 운영 검증

원본 독립 검토가 자연 종료한 뒤 120초 간격의 안정 경계를 확인했고, 같은 최종 snapshot의 전송 파일 9개·uploads 351개의 SHA256, schema 33·SQLite 무결성과 FK를 검증했다. IAMCEO 60개·God 42개 원본 Git refs를 비교해 일반 push와 원격 SHA 확인을 마쳤다. 원격에 더 앞선 이력과 private WIP는 보존했다.

복원 기준은 프로젝트 4개·직원 24명·메시지 1,304개·업무 184개·결정 55개·자료 429개·첨부 275개다. 운영 시작 후에도 이 ID들이 모두 남았고 첨부 275개 해시가 일치했다. 새 활동으로 늘어난 행을 원본 복원 개수와 구분한다. 원본 장치의 pane·소켓은 활성화하지 않고 공식 복원 조정·재개와 버전 수명주기 API로 새 장치에 연결했다.

실행 SHA는 `d3f234e1db8685b2dcc304ffce030bde269dfe47`, build ID는 `daea1677177b94c5e275ca5f15bf35ec19375d47fe04e829ac414e097a651d66`이다. `gui/501` Aqua의 `com.iamceo.server`가 최종 data 홈과 private 로그를 사용한다. 실제 데이터의 정상 재시작·행 수·세션 소유권 보존을 직원 업무 시작 전에 검증했다. 현재 진행 중인 CLI를 재시작 시험으로 중단하지 않는다.

운영 주소는 `https://hyejoo-mac-mini.tail5169d3.ts.net:14443`이며 127.0.0.1:47878을 제공한다. TLS 기본 신뢰·호스트명, 기존 코드 로그인, 인증 없는 API/첨부의 401, 프로젝트 4개 홈·대화·자료 12개 경로와 모바일 화면을 확인했다. 기존 7개 Tailnet 경로와 Funnel 꺼짐, 기존 서비스 health·관리 API의 running/healthy도 확인했다. 다른 기기 접속·재부팅은 시험하지 않았다.

실제 worker PID의 cwd는 `_hq`, IAMCEO, god에 연결됐고 hostname은 맥미니다. Design·God의 새 Claude 세션은 폴더 신뢰 승인을 기다리며 재개 글은 아직 held다. 사용자가 앱의 확인 카드에서 직접 답한 뒤 실제 delivery·execution을 다시 확인한다. 감독은 이 조건의 변화만 관측하고 승인 응답을 보내지 않는다. 21개의 기존 쓰기 증거가 있는 불확실 전달과 오래된 unknown prompt 직원의 전달 1개는 격리를 유지한다.

원본 네 프로젝트 runner는 false이며 읽기 가능한 복구 대상으로 남는다. 대상 dispatch가 활성인 동안 원본을 켜지 않는다. `TARGET_ACTIVATED.json`의 `activated:true`와 운영 readiness가 rollback을 차단한다. 최종 snapshot·source native 참조·양쪽 백업·God 데이터·WIP를 private 경로에 보존한다. God 실서버는 `LAB_DATA_DIR`를 `.runtime/god/data`로 지정하고 테스트에는 별도 격리 데이터를 사용한다.

## 범위와 완료 조건

| 요구사항 | 판정 가능한 완료 조건 |
| --- | --- |
| R1. 개발과 서버를 맥미니 새 루트에서 실행한다. | A1 → R1. hostname·worker cwd·워크트리와 source SHA 영수증을 대조한다. |
| R2. 등록된 프로젝트의 소스 이력과 데이터를 보존한다. | A2 → R2. bundle 검증, 모든 작업 브랜치 원격 SHA, 동일 snapshot ID의 SQLite integrity·행 수·첨부 수/해시를 확인한다. |
| R3. 기존 관리 체계로 서비스를 운영한다. | A3 → R3. 기존 카탈로그에 IAMCEO를 추가하고 영구 데이터 경로·launchd 재시작·로그·인증된 readiness·릴리스 SHA를 검증한다. |
| R4. 원본 작업이 끝난 뒤에만 운영을 전환한다. | A4 → R4. 최종 영수증의 최신 refs·snapshot·종료 조건을 확인하고 rollback 백업을 남긴다. 그전에는 복제 데이터와 차단된 실행 경로만 사용한다. |
| R5. Tailscale 연결 기기에 HTTPS 인증 접속을 제공한다. | A5 → R5. 기존 7개 경로를 보존하고 새 Tailnet HTTPS 경로의 TLS·인증·프로젝트 화면을 확인한다. 공개 DNS와 사용자 도메인은 필수 조건이 아니다. |
| R6. 변경을 검증·커밋·푸시한다. | A6 → R6. 기능 검사와 필수 회귀 검사를 통과하고 origin의 브랜치 SHA와 HEAD 일치를 기록한다. |

## 초기 조사 (2026-11-16)

- IAMCEO main은 `3f6f3e49cb464324c0d110df436170cd92d81382`이며 기본 체크아웃은 깨끗했다. 별도 워크트리와 `chore-prepare-mac-mini-2026-11-16` 브랜치를 준비했다.
- 기존 home-server는 `.ops/mac-services/config/service.json`의 고정 카탈로그와 `dev.personal-ops.mac-services` 브리지로 서비스를 관리한다. 기존 인증과 승인 흐름을 재사용한다. IAMCEO의 활동 검사 지원 전에는 카탈로그에서 조회만 허용한다.
- 기존 주요 서비스 포트가 현재 응답하지 않고 gui/501 launchd 세션이 없다. 기존 설정·데이터는 보존하며 이 초기 장애를 새 IAMCEO로 덮어쓰지 않는다.
- Tailscale Serve의 443·8443·9443·10443·11443·12443·13443 경로는 이미 예약되어 있다. 전체 reset을 하지 않는다.
- Bun·Claude CLI는 PATH에서 발견되지 않았다. Codex·node·npm·gh·cloudflared·tailscale은 설치되어 있다. 설치와 로그인은 각각 별도로 검증한다.
- iamceo.enouv.studio는 DNS가 없고 Squarespace 네임서버를 사용한다. 인증된 공개 터널·DNS 권한의 존재는 미확인이다.

## 준비와 검증 순서

1. 계획·운영 규칙을 검토하고 작업 브랜치에 커밋·푸시한다.
2. 런타임을 설치하고 lockfile 고정 설치, 타입 검사, 서버 회귀, 컴파일을 확인한다. 고정 Git SHA에서 릴리스와 영수증을 만든다.
3. 기존 서비스 카탈로그·launchd 등록을 최소 변경으로 준비한다. 기존 관리 API나 DB는 복제하지 않는다. 설정 변경 전에 원본을 private 백업하고 원래 항목이 유지되는지 검사한다.
4. SOURCE_EXPORT_READY 영수증의 파일 해시·bundle 이력을 검증한다. 복제 홈으로 복원하고 발신 격리 상태·DB·첨부를 검사한다. 복원본의 발신 fence를 임의 해제하지 않는다.
5. 조건 파일 감시기는 모델 호출 없이 영수증 변화를 기록한다. 운영 전환을 자동 실행하거나 승인에 응답하지 않는다.
6. 기존 Tailscale Serve에 전용 HTTPS 포트를 추가한다. 최종 전환 전에는 발신이 차단된 초기 복원본 조회를 제공하고 원본 작업·직원 로그인과 별도 검증한다. 사용자 확정에 따라 공개 DNS/Cloudflare/Squarespace 작업은 제외한다.
7. CUTOVER_READY 수신 후 최신 refs 일반 푸시와 원격 SHA 검증을 먼저 마친다. 최종 DB와 첨부가 같은 snapshot인지 확인하고 rollback 백업을 양쪽에 남긴다.
8. HQ는 새 루트의 `_hq`로, 프로젝트·직원의 cwd는 각 프로젝트 경로로 매핑한다. 소켓·PID·owner lock·기존 PTY는 새 장치에서 재사용하지 않는다. 정식 복원·세션 수명주기로 연결하며 미해결 승인을 보존한다.
9. 로그인·프로젝트 4개·메시지·자료·재시작 복원·worker hostname/cwd·기존 서비스 health·Tailnet HTTPS를 검증하고 결과를 final-report.md에 기록한다.

## 영구 경로와 복구

소스는 `/Users/hyejookim/Programming/01_Ing/IAMCEO`, 별도 개발 워크트리는 `.worktrees/IAMCEO/`, 실행 자료와 고정 릴리스는 새 루트의 `.runtime/IAMCEO/`에 둔다. 이전 영수증과 비밀 없는 진행 상태는 `.migration/2026-11-16/`에 둔다. 본사는 `_hq/`를 사용하며 원본 홈 전체를 복제하지 않는다.

실제 설정·인증 자료와 백업은 0700 private 경로에 둔다. 전환 실패 시 새 서비스만 중지하고 전환 전 설정·스냅샷·고정 릴리스를 복원한다. 다른 서비스의 DB·Tailscale·컨테이너를 교체하지 않는다. 운영 전환 후 재시도 전에 외부 효과와 실행 소유권을 확인한다. 미확인 메시지·실행은 자동 재전송하지 않는다.

## 초기 준비 때의 의존 조건

아래 초기 조사와 준비 순서는 당시 기록이다. 최종 입력·복원·로그인·운영 HTTPS 검증은 위 현황으로 갱신됐고, 남은 총괄의 사람 확인을 전체 완료와 구분한다. 공개 DNS·Squarespace/Cloudflare 계정은 필요하지 않다.

최신 접속 범위와 초기 읽기 전용 조회의 검증·제한은 [초기 복원본 접속](../mac-mini-read-only.md)을 따른다. 초기 조사에 적힌 공개 DNS 관측은 당시의 사실이며 현재의 전환 차단 조건이 아니다.
