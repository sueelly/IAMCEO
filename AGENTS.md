# IAMCEO 저장소 운영

- 개발·빌드·시험·서버는 맥미니의 `/Users/hyejookim/Programming/01_Ing` 아래에서 실행한다. 작업 전에 브랜치·변경·워크트리를 확인하고 `.worktrees/IAMCEO/<task>`의 별도 워크트리를 사용한다.
- origin은 `https://github.com/sueelly/IAMCEO.git`, upstream은 `https://github.com/yehsung/IAMCEO.git`다. 다른 기기의 진행 작업을 덮어쓰지 않는다.
- 목적·범위·완료 조건과 판정 가능한 검증을 먼저 작성한다. 동작 변경은 회귀 검사를 먼저 마련한다. 검증한 파일만 `type(scope): subject` 형식으로 커밋하고 작업 브랜치를 일반 푸시한 뒤 원격 SHA를 확인한다.
- 운영 데이터·DB·첨부·로그·키·CLI 로그인 자료는 Git 밖 0700 경로에 둔다. 비밀 값을 출력하지 않는다.
- 이전은 `docs/operations/mac-mini-migration.md`를 따른다. `SOURCE_EXPORT_READY.json`은 복구 연습만 허용한다. `CUTOVER_READY.json` 검증 전에는 실제 직원 실행·원본 중지·운영 데이터 교체를 하지 않는다.
- 기존 대화·자료·결재·실행 상태와 다른 서비스의 포트·Tailscale 경로를 보존한다. 원본의 소켓·PID·owner lock·PTY ID를 활성화하지 않는다.

## 출력의 대상과 맥락

- 대화·자료·팀 진행 상황·업무 보고·결재함 등 모든 출력은 며칠 뒤에도 무엇에 대한 글인지 알 수 있게 쓴다. 업무와 요청 맥락, 결과, 가까운 근거, 남은 조건과 다음 행동의 주체·대상을 명시한다.
- 사용자 2026-11-18의 10가지 작성 원칙은 `server/roles/writing.md`에 있다. 프롬프트·도구 설명·자동 생성 문구를 변경할 때 같은 기준을 적용한다.
- 글자·줄 수에 맞추려고 목적어·조건·근거를 삭제하지 않는다. ‘원ID’·‘원 지시’·‘확인 대기’는 대상과 출처 없이 쓰지 않는다. 확인하지 못한 내용은 추측하지 않는다.
