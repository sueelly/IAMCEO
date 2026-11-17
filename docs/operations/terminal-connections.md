# 팀 화면의 터미널 접속 관리

팀 화면의 복사 명령은 현재 IAMCEO 서버의 CLI 실행 파일, 데이터 홈과 실제 HTTP 포트를 사용한다. 다른 기기에서 접속한 화면은 SSH를 통해 그 서버에서 명령을 실행한다. 맥미니 자체의 localhost 화면에서는 같은 명령을 로컬에서 실행한다.

## 주소가 바뀌는 경우

SSH 호스트를 따로 지정하지 않으면 현재 열어 둔 웹 주소의 호스트를 사용한다. Tailscale DNS가 가리키는 IP가 바뀌어도 같은 DNS 이름으로 접속한다. 호스트 이름 자체가 바뀌면 새 웹 주소로 들어온 화면에서 새 이름을 사용한다. 웹의 HTTPS 포트와 SSH 포트는 서로 다르다.

복사 버튼은 가벼운 인증 조회 `GET /api/connection`으로 최신 정보를 확인한 뒤 클립보드에 쓴다. 화면을 연 뒤 설정을 바꿔도 새 복사에 반영되며, 조회가 실패하면 이전 명령을 복사하지 않는다. 이미 외부에 붙여 넣은 문자열을 소급해서 바꾸지는 않는다.

## 한곳에서 관리하는 설정

운영 데이터 홈의 `config.json.connection`이 SSH 재정의 값의 유일한 저장 위치다. 기본값은 현재 웹 호스트, 서버 계정, SSH 포트 22다. 사용자 지정 값은 유지되며 `auto`로 지우면 자동 감지로 돌아간다. SSH 인증은 실행 기기의 기존 SSH 키·에이전트·설정을 사용한다. 명령에 접속 코드나 키 내용을 넣지 않는다.

현재 서버의 실행 파일을 `IAMCEO_HOME`과 함께 호출한다. 아래 `/path/to/iamceo`는 실제 실행 파일 경로로 바꾼다.

```sh
IAMCEO_HOME=/Users/hyejookim/Programming/01_Ing/.runtime/IAMCEO/data /path/to/iamceo connection
IAMCEO_HOME=/Users/hyejookim/Programming/01_Ing/.runtime/IAMCEO/data /path/to/iamceo connection --ssh-user hyejookim --ssh-port 22
IAMCEO_HOME=/Users/hyejookim/Programming/01_Ing/.runtime/IAMCEO/data /path/to/iamceo connection --ssh-host auto
```

`iamceo connection`은 실행 중인 서버의 인증 API로 변경하므로 재시작할 필요가 없다. `PATCH /api/connection`도 같은 동작을 제공한다. `sshHost`, `sshUser`, `sshPort` 중 지정한 필드만 합치며 `null`은 그 필드의 재정의를 지운다. 기존 접속 코드와 나머지 설정은 보존한다.

이 기능은 명령을 생성·복사한다. 복사만으로 직원 실행·재개·중단이나 승인 응답을 보내지 않는다.
