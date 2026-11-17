# IAMCEO 저장소 운영

- 개발·빌드·시험·서버는 맥미니의 `/Users/hyejookim/Programming/01_Ing` 아래에서 실행한다. 작업 전에 브랜치·변경·워크트리를 확인하고 `.worktrees/IAMCEO/<task>`의 별도 워크트리를 사용한다.
- origin은 `https://github.com/sueelly/IAMCEO.git`, upstream은 `https://github.com/yehsung/IAMCEO.git`다. 다른 기기의 진행 작업을 덮어쓰지 않는다.
- 목적·범위·완료 조건과 판정 가능한 검증을 먼저 작성한다. 동작 변경은 회귀 검사를 먼저 마련한다. 검증한 파일만 `type(scope): subject` 형식으로 커밋하고 작업 브랜치를 일반 푸시한 뒤 원격 SHA를 확인한다.
- 직원의 작업 브랜치 납품은 업무 전체의 완료가 아니다. 계약 기준과 필요한 독립 검토를 통과한 변경은 총괄이 최신 원격 main 기준 별도 통합 워크트리에서 합치고, 필요한 검사·일반 푸시·원격 SHA 확인까지 한다. main이 앞서면 다시 합치고 다시 검사한다. 총괄은 제품 코드를 구현하지 않고, 충돌을 풀 코드 수정은 직원에게 돌려보낸다. 대표 화면 반영(운영 서버 다시 띄우기)과 강제 푸시는 이 단계에 들어 있지 않다.
- 운영 데이터·DB·첨부·로그·키·CLI 로그인 자료는 Git 밖 0700 경로에 둔다. 비밀 값을 출력하지 않는다.
- 이전은 `docs/operations/mac-mini-migration.md`를 따른다. `SOURCE_EXPORT_READY.json`은 복구 연습만 허용한다. `CUTOVER_READY.json` 검증 전에는 실제 직원 실행·원본 중지·운영 데이터 교체를 하지 않는다.
- 기존 대화·자료·결재·실행 상태와 다른 서비스의 포트·Tailscale 경로를 보존한다. 원본의 소켓·PID·owner lock·PTY ID를 활성화하지 않는다.
