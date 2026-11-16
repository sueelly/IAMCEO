# 초기 복원본의 읽기 전용 접속

Tailscale에 연결된 기기에서 기존 인증으로 초기 복원본의 프로젝트·대화·결정·자료를 열 수 있게 한다. 원본 작업 종료와 CLI 로그인은 최종 운영 전환의 조건이며 이 조회의 조건은 아니다.

별도 조회 진입점은 기존 HTTP/UI를 사용하되 SQLite를 readonly/query_only로 열고 Store 초기 보정과 실행기 생성을 생략한다. 허용한 조회 및 인증 쿠키 발급·삭제 외 요청은 거절한다. 폴더·GitHub·로컬 파일 가져오기·PTY·에이전트·짝 맺기는 차단한다. 복원 fence와 꺼진 runner 플래그를 유지한다.

완료 조건은 인증 없는 API/첨부의 401, 인증된 프로젝트·대화·자료 조회, 쓰기/실행 요청의 409, DB/첨부 해시 불변, 실제 직원 실행 0개, 기존 Tailscale 경로 보존, 새 HTTPS 경로의 인증 검증, 전용 launchd 재시작 복원이다. 다른 기기에서의 접속 여부는 실제 확인한 범위와 구분한다.

조회는 최종 운영 전환 영수증이 아니다. 최종 전환 때 최신 source schema·Git refs·DB·업로드 검증을 다시 하고 조회용 포트를 운영 서버로 연결한 뒤 인증·TLS·실행 hostname/cwd를 확인한다.

빌드는 `bun build bin/iamceo-view.ts --compile --outfile dist/iamceo-view`로 한다. 배포는 검증·커밋한 Git archive의 소스로 같은 빌드를 만들고 바이너리 SHA를 영수증에 기록한다. `IAMCEO_VIEW_HOME`은 0700 private 경로의 복원본 절대 경로, `IAMCEO_VIEW_PORT`는 예약 충돌을 확인한 loopback 포트다. 이 진입점은 config.json의 기존 인증만 읽으며 새 접근 코드를 만들거나 출력하지 않는다. 기존 사용자 브라우저 저장소는 사용하지 않는다.

감독의 `tailscale_origin`은 실제 HTTPS 주소이고 `viewing_release_manifest`는 조회 바이너리의 build_id 및 `kind=read-only-snapshot-view`, `operational_cutover=false`를 가진 private 영수증이다. `initial_viewing_ready`는 해당 빌드·읽기 전용 응답을 검증한다. `domain_ready`, `target_authenticated_readiness`, `target_prepared`는 운영 후보의 별도 검증으로 남는다. 조회 서버를 운영 전환 준비 완료로 인정하지 않는다. Tailscale 전용 선택에서는 공개 DNS/TLS/Cloudflare 인증을 조사하거나 요구하지 않는다.

변경 검증: HTTP·realtime·Store·조회 회귀 6개 파일 130개 통과, Python 감독 22개 및 이전 안전 검사 5개 통과, TypeScript 검사와 조회 바이너리 컴파일 통과. 기존 전체 회귀의 실패 분류는 TEST-FAILURES.md를 따른다. 실제 초기 복원본·HTTPS·브라우저·launchd 검증 결과는 이전 루트의 별도 영수증에 기록한다.

기존 짧은 접속 코드를 보존하는 독립 진입점 검사도 추가했다. 실제 복원본은 별도 `verify-read-only-view.ts <private-config.json>`으로 검증한다. 설정에는 origin, home, releaseManifest, beforeInventory, expectedCounts, outputDir, receiptPath를 둔다. 새 Playwright context에서 정식 로그인·4개 프로젝트 화면·첨부와 DB 무결성·fence·파일 해시를 확인한다. 브라우저 자료와 설정은 private 경로에 둔다.

실제 배포 검증은 source SHA `f3f4408d04fc632ccf9550ed3c475480f6d90f91`, 읽기 전용 build ID `a2229b4f27bcdcac3004597a0c888c47e45159b1ec97ec7211b61ed2916f3b57` 기준으로 통과했다. 초기 export 시각은 2026-11-16 12:08 KST다. TLS 신뢰·호스트 이름 검증, 인증, 데스크톱 12개 경로·모바일 화면, 248개 복원 파일 해시 불변, FK/무결성 및 전용 Background 서비스의 종료 후 자동 재시작을 확인했다. 검증 기기는 맥미니 자신이며 다른 기기 접속과 실제 재부팅은 미검증이다. 원본 작업·결정은 남아 있어 운영 전환은 보류한다.

후속 검증에서는 독립 진입점까지 조회 검사 5개를 통과했다. 감독에는 현재 소유 턴의 검토한 조건 fingerprint만 처리하는 기능을 추가했고, 소유 PID 불일치·사망·새 조건 경합·후속 변화 보존을 포함해 23개 검사를 통과했다. 이번 턴에서 이미 검토한 변화 때문에 모델을 다시 부르는 일을 막으며 새로운 실제 변화는 보존한다.
