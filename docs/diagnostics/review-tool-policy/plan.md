# Novel 전담 검수 도구 승인 경계 진단 계획

업무 tk_34o1KVuzwy5Z의 확정 계약 r1을 따릅니다. 기존 전달 지연 진단이나 실제 최종 검수 판정을 다시 수행하지 않습니다.

## 고정 기준과 관측

읽은 원격 소스와 운영 등록 릴리스 경로의 SHA는 모두 27ec070c1c83acbe0229c53ddccf278ad15d7965입니다. 현재 지원 server_check는 schema48/supported48/ok=true, harness required입니다. 등록된 실행 파일 build-id는 6e2371cab9260fd6a97ef706705055b846ada4510cb1e6b0ec7a8918a9c31bec입니다. 이 직원 토큰으로 readiness는 HTTP 오류여서 반복하거나 인증을 넓히지 않았습니다. 현재 실행 중 프로세스의 신원과 등록 파일의 동일성까지 독립 확인한 것은 아닙니다.

실제 최초06:39 KST의 MCP 승인 never 거절은 총괄이 전달한 관측입니다. 지원task_trace 네 건은 현재finalReview pending을 확인하지만 오류문자열을 노출하지 않습니다. 이 직원에게 전담 검수 실행 출력·터미널 읽기 도구는 없습니다. 원문 오류를 합성 오류로 대체하지 않습니다.

## 단일 가설

최종 검수 직원은 서버에서는worker+finalReviewer이지만 실행용변환에서conductor가되어read-only/approval never/쉘·외부MCP차단을 받습니다. IAMCEO도구는 서버에서허용되지만Codex MCP 승인방식은 고정하지 않습니다. 이 조합이 도구 호출 전에 거절할 수 있는지를 실제설치CLI0.167과합성모델응답으로확인합니다.

## 최소 실험과 분담

1. native read관점3개: 역할·설정전파/실제오류노출범위/합성CLI설계.
2. root는격리IAMCEO fixture에서지정역할의post조회·task_review_evidence·task_review와잘못된역할·보고작성·일반도구거절을대조합니다. 실제검수대상은사용하지않습니다.
3. 합성CLI담당은별도CODEX_HOME과loopbackfakeResponses·fakeMCP만사용합니다. 현재launch와동일한never/read-only/IAMCEO전용정책에서기본상태와정식per-tool approval_mode=approve 설정후보만대조합니다. 실제계정·OAuth·과금호출은0입니다.
4. 일반쉘·외부MCP미노출과never유지를검증합니다. 상태를쓰는tool을readOnlyHint=true로가장하지않습니다.

## 보존·판정

task_review_evidence는근거읽기뒤evidence_reader_id를갱신합니다. 운영대상에대신호출하지않습니다. 실제승인정책·세션·권한·대기열·운영소스·서비스변경은금지합니다. 임시루트는삭제하지않습니다.

실제오류·합성오류·서버역할거절·미확인을분리합니다. 합성시험에서정상호출가능여부와허용된설정범위를판정하고, 필요한최소설정/소스후보와운영별도조건만인계합니다. 제품코드수정이나main통합·배포는하지않습니다. 자료는검증·문서커밋·작업브랜치일반업로드·원격일치후file/post로인계합니다.
