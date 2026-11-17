# 맥미니 준비·재개 명령

이 명령들은 초기 전송의 검증과 오프라인 복구 연습을 위한 것이다. 운영 전환은 `CUTOVER_READY.json`과 최종 스냅샷 검증을 마친 뒤 별도로 수행한다.

## 준비 작업

워크트리에서 PATH를 설정한다. Bun은 저장소 시험 주석에 맞춘 1.3.14이며 Claude Code는 2.1.325다. Homebrew 설치는 기존 CLT 호환 오류로 실패해서 공식 npm 패키지를 실행 루트에 설치했다. 설치 및 고정 lockfile 참고: https://bun.sh/docs/installation

```sh
export PATH=/Users/hyejookim/Programming/01_Ing/.runtime/IAMCEO/toolchain/node_modules/.bin:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.bun/bin:/usr/bin:/bin:/usr/sbin:/sbin
python3 tests/mac-mini-migration.test.py
bun run typecheck
bun run build
python3 scripts/mac_mini_migration.py verify-initial /Users/hyejookim/Programming/01_Ing/.migration/2026-11-16
```

`extract-private`는 링크·절대 경로·상위 경로 탈출을 거절하고 기존 목적지를 교체하지 않는다. 다음 두 경로가 없을 때만 실행한다.

```sh
python3 scripts/mac_mini_migration.py extract-private /Users/hyejookim/Programming/01_Ing/.migration/2026-11-16/incoming/initial/iamceo-runtime.tar.gz /Users/hyejookim/Programming/01_Ing/.runtime/IAMCEO/private/rehearsal/source-runtime
python3 scripts/mac_mini_migration.py extract-private /Users/hyejookim/Programming/01_Ing/.migration/2026-11-16/incoming/initial/god-files.tar.gz /Users/hyejookim/Programming/01_Ing/.runtime/IAMCEO/private/rehearsal/god-files
bun scripts/mac-mini-rehearsal.ts /Users/hyejookim/Programming/01_Ing/.migration/2026-11-16 /Users/hyejookim/Programming/01_Ing/.runtime/IAMCEO/private/rehearsal
```

복구 연습은 검증한 초기 DB와 첨부를 기존 앱의 native backup 형식으로 바꾸고 `restoreBackup(..., mode: clone)`으로 빈 private 홈에 복원한다. 생성한 snapshot ID는 대상 연습용이며 원본 최종 snapshot ID를 대신하지 않는다. 원본 WAL/SHM은 활성화하지 않으며, 복사한 DB에서만 journal을 정규화한다. 복원 후 첨부 해시·행 수·실행기 꺼짐·발신 fence와 소켓 미복사를 검사한다. `restore reconcile`이나 `restore resume`은 호출하지 않는다.

## 기존 관리 체계

`register-catalog`는 기존 고정 카탈로그를 private 백업하고 IAMCEO 한 항목만 추가한다. 기존 토큰·항목·승인 저널은 보존한다. 활동 검사를 지원하기 전에는 IAMCEO의 시작·중지·재시작을 관리 화면에서 허용하지 않는다.

```sh
python3 scripts/mac_mini_migration.py register-catalog \
  --config /Users/hyejookim/Programming/00_Always/home-server/.ops/mac-services/config/service.json \
  --backups /Users/hyejookim/Programming/01_Ing/.runtime/IAMCEO/private/rollback/home-server \
  --port 47878 --plist /Users/hyejookim/Library/LaunchAgents/com.iamceo.server.plist
```

현재 GUI 세션과 Docker daemon이 없어 기존 관리 API와 브리지가 제공되지 않는다. 카탈로그 파일 등록을 대시보드 실제 연결 완료로 보고하지 않는다. 원본 서비스의 승인 대기나 실행을 중단하지 않는다.

## 영수증 감시와 재개

```sh
python3 scripts/mac_mini_migration.py watch /Users/hyejookim/Programming/01_Ing/.migration/2026-11-16 --once
```

상시 감시는 검증된 고정 Git 릴리스의 같은 스크립트를 launchd Background 서비스로 실행한다. `SOURCE_EXPORT_READY.json`, `CUTOVER_READY.json`, `DNS_READY.json`의 내용 해시가 바뀌면 `receipt-events.jsonl`과 `TARGET_RESUME_NEEDED.json`을 갱신한다. 모델·직원·전환 명령을 호출하지 않는다. 같은 영수증에는 반복 이벤트를 만들지 않는다.

재개할 때 `status.json`, `progress.md`, `TARGET_RESUME_NEEDED.json`과 새 영수증을 읽는다. 최종 영수증이 없으면 준비 결과를 보존하고 대기한다. 감시기가 전환을 승인했다고 해석하지 않는다.

## 운영 서비스 후보와 복구

운영 데이터 경로는 `/Users/hyejookim/Programming/01_Ing/.runtime/IAMCEO/data`, 릴리스는 `.runtime/IAMCEO/releases/<Git SHA>`, 로그는 운영 데이터의 `logs/`를 사용한다. HQ는 `/Users/hyejookim/Programming/01_Ing/_hq`, 두 저장소의 기본 경로는 `IAMCEO/`와 `god/`다. 실제 프로젝트·직원의 모든 cwd는 최종 영수증과 대조해 매핑한다.

현재 고정 릴리스는 준비 후보다. 최종 전환 전에는 운영 데이터 홈에 초기 데이터를 배치하거나 `com.iamceo.server`를 시작하지 않는다. 최종 검증 후 기존 CLI의 `service install`과 `IAMCEO_LOG_WRITER=1` 로그 supervisor를 사용한다. GUI 없는 Background 세션에서는 `LimitLoadToSessionType=Background`를 명시해야 한다. user/501에서 이 속성을 생략하면 bootstrap이 오류 5로 실패했다. 빈 데이터·가짜 실행기로 자동 재시작을 확인했지만 실제 재부팅은 시험하지 않았다.

서비스 후보의 source SHA·binary SHA·build ID를 기록하고 검증한 release를 사용한다. 공개 게이트웨이는 loopback origin의 Host/Origin 및 WebSocket 인증을 보존하는 방법으로 연결한다. `iamceo.enouv.studio`는 기존 Host allowlist에서 자동 허용되지 않으므로 임의로 검사를 끄지 않는다. 실제 ingress가 정해지면 정확한 도메인 허용과 proxy의 origin 처리를 검증한다.

최종 전환 실패 시 새 IAMCEO만 정상 종료하고 전환 전 데이터·설정·릴리스를 복구한다. 기존 home-server·Orchestra 데이터나 Tailscale 경로는 교체하지 않는다. 공개 DNS와 인증은 `.migration/2026-11-16/DNS-REQUEST.md`, `AUTH-REQUEST.md`의 미완료 조건을 따른다.

## 현재 검증 한계

이전 도구·복구 연습·타입 검사·컴파일은 통과했다. 기존 전체 제품 회귀에는 schema 버전 고정 기대와 시험 격리 경로 등 실패가 있어 운영 릴리스 검증 완료로 간주하지 않는다. 정확한 실행·실패 목록과 상위 환경 재검증은 이전 루트의 `TEST-FAILURES.md`와 `status.json`에 기록한다. 기존 시험의 격리 경계를 완화해 통과시키지 않는다.
