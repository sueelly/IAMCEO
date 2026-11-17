# Codex 승인 단계의 검수 도구 거절을 재현했습니다

설정 경계를 합성 실행으로 확인했습니다. 지정 검수의 never 정책에서 task_review_evidence와 post가 MCP 호출 전에 거절됐습니다. IAMCEO의 지정 도구에만 공식 승인 방식을 명시하면 두 호출이 성공했고 기존 쉘·외부 MCP 차단은 유지됐습니다.

대표님이 지금 승인하실 새 운영 변경은 없습니다. 총괄이 기존 지원 읽기에서 최초06:39 KST의 도구명·오류 한 줄과 브리지 호출 도달 여부만 연결하면 실서비스 원문 대조를 마칠 수 있습니다.

현재 단계: 합성 재현·설정 후보 검증과 인계. 실제06:39 원문 대조는 미확인입니다. 운영 정책·세션·검수 판정은 바꾸지 않았습니다.

찾는 말: approval policy never, per-tool approval_mode, 전담 검수, task_review_evidence, post 조회, Codex0.167, 사람 결재 보호.

## ① 결론: 전담 검수의 실행 역할과 MCP 승인 방식이 충돌합니다

합성 환경에서 확정한 원인은 클라이언트 승인 경계입니다. 서버는 지정 직원에게 해당 조회 도구를 허용합니다. 그러나 실행용 역할 변환은 Codex에 never를 강제하고, IAMCEO 도구의 승인 방식은 별도로 고정하지 않습니다.

기본 조건의 정확한 합성 오류는 다음과 같습니다. 이것을 실서비스06:39 기록에서 직접 읽은 문자열로 바꾸지 않습니다.

```text
MCP tool call requires approval, but approval policy is never
```

| 같은 실제 Codex0.167 실행 | 기본 설정 | 지정 도구별 approve 후보 |
| --- | --- | --- |
| approval / sandbox | never / read-only | never / read-only |
| task_review_evidence / post | 둘 다 호출 전 거절 | 둘 다 완료 |
| MCP tools/call 도달 | 0건 | 2건 |
| 일반 쉘·패치·외부 MCP | 노출 0 / 외부 시작 0 | 노출 0 / 외부 시작 0 |
| 실제 모델·계정·운영 호출 | 0건 | 0건 |

합성 원인과 실서비스 확정은 구분합니다. 실서비스의 최초 오류는 총괄이 전달한 관측입니다. 기존 읽기 API에는 오류 원문과 호출 도달 정보가 없어 이 직원은 그 두 항목을 직접 확인하지 못했습니다. 같은 실패 조회를 반복하거나 원본 실행 기록을 열지 않았습니다.

## ③ 요청 경계: 호출 전 거절과 서버 역할 거절은 다릅니다

최종 검수 직원은 서버에서 worker+finalReviewer입니다. 실행 인자를 만들 때만 kind=conductor로 바뀝니다. 그 결과 read-only·never와 쉘·다른 MCP 차단을 받습니다.

현재 Codex 경로는 IAMCEO enabled·command·args·env_vars를 설정하지만 해당 MCP의 도구 승인 방식은 고정하지 않습니다. 일반 직원 기본 실행은 on-request이며, Claude 제한 역할은 allowedTools에 IAMCEO를 명시합니다. 현재 진단 직원의 지원 post 조회도 네 원보고에서 성공했습니다. 각 경로의 실행 설정을 동일하다고 보지 않습니다.

Codex의 도구 목록에는 IAMCEO 외에 기존 읽기·질문 보조 도구도 남습니다. IAMCEO만 허용했다는 말은 외부 MCP와 일반 실행 도구의 제한 범위입니다. 모델에 정확히 다섯 도구만 보인다고 과장하지 않습니다.

| 경계 | 관측 결과 | 오류·근거 |
| --- | --- | --- |
| Codex → MCP tools/call | 기본 합성에서 호출0 | 영문 never 오류 / IAMCEO 도구 목록은 이미 조회됨 |
| MCP bridge → /agent/tool | 호출을 받은 뒤 operation ID를 만들고 전달 | 실서비스 최초 호출 도달은 미확인 |
| 서버의 직원 역할 검사 | 지정 검수는 다섯 도구만 허용 | 쓸 수 없는 도구입니다: task_review_evidence / file |
| 서버의 post 분기 | report_id 조회는 허용, 보고 작성은 거절 | 최종 검수 직원은 보고를 조회하거나 task_review로 검수 결과를 남깁니다 |
| 서버의 대상·계약 검사 | 잘못된 검수 대상은 거절 | 현재 검수 대기 중인 완료 보고와 계약을 확인해 주세요 |

task_review_evidence는 완전한 읽기 전용 도구가 아닙니다. 근거를 읽은 뒤 evidence_reader_id를 갱신합니다. 실제 네 대상에 진단용으로 대신 호출하지 않았습니다. 모든 도구를 readOnlyHint=true로 표시해 승인층을 통과시키는 후보도 사용하지 않습니다.

지정 검수의 최종 글·턴 오류는 일반 직원처럼 자동 보고로 전환되지 않는 소스 분기가 있습니다. task_trace의 실행 ended/success만으로 검수 도구 성공이나 최종 판정 완료를 말할 수 없습니다.

## ④ 합성 실행: 역할 제한과 사람 결재를 보존했습니다

실제 설치된 Codex0.167.0을 새 CODEX_HOME·작업 폴더·loopback 합성 Responses 서버·가짜 MCP로 실행했습니다. 계정·IAMCEO·OAuth 환경은 전달하지 않았습니다. 모델 응답은 스크립트가 제공했으며 실제 모델 또는 과금 호출은 없습니다.

기본 조건과 후보 조건은 기존 providerLaunch의 같은 never/read-only/쉘·외부 MCP 제한을 사용했습니다. 차이는 지정된 다섯 IAMCEO 도구의 per-tool approval_mode=approve뿐입니다. Codex를 통한 실제 호출 검증은 문제의 두 도구에 한정했습니다.

처음에는 Codex0.167의 namespace 형식 때문에 합성 응답이 도구를 호출하지 못했습니다. 이를 승인 실패로 세지 않고 합성 프로토콜을 맞춘 뒤 정확한 오류 두 건·MCP 호출0/2·정책 불변을 다시 확인했습니다.

| 실제 실행 명령 | 결과 | 검증 범위 |
| --- | --- | --- |
| bun docs/diagnostics/review-tool-policy/synthetic-codex.ts | exit 0 / 검증3항목 true | 기본 거절·후보 성공·제한 유지 |
| bun test --preload ./tests/fixtures/preserve-temp.ts ./docs/diagnostics/review-tool-policy/synthetic-server.test.ts | 1 pass / 0 fail / 20 expectations | 역할·조회·판정·사람 결재 보존 |

서버 합성 fixture에서는 지정 직원의 post 조회와 증거 조회·판정이 성공했습니다. 일반 직원의 증거 도구, 지정 직원의 보고 작성·file 도구, 잘못된 대상, 근거를 읽지 않은 판정은 거절됐습니다.

열린 사람 결재를 만든 뒤 지정 직원이 판정을 시도하면 거절됐고 결재는 열린 상태로 남았습니다. 실제 사람의 승인에 답하거나 승인 정책을 바꾼 결과가 아닙니다.

합성 CLI의 가짜 MCP는 전송 계층만 검사합니다. IAMCEO 서버 역할 검사는 별도 실제 서버 코드의 격리 fixture로 확인했습니다. 두 실험을 실서비스 검수 대행으로 바꾸지 않습니다. 임시 폴더와 가짜 구성은 삭제하지 않았습니다.

## ⑤ 설정 후보: 지정 실행의 기존 다섯 도구만 명시합니다

공식 Codex 설정 문서는 mcp_servers.<id>.tools.<tool>.approval_mode를 지원하며 auto·prompt·writes·approve를 나열합니다. 실제 설치된 CLI의 합성 실행에서도 approve 후보를 확인했습니다. 전역 approval_policy를 바꾸는 후보가 아닙니다.

다음은 합성 후보에서 사용한 invocation 인자입니다. 실제 직원의 공유 CODEX_HOME 설정에 쓰거나 운영 세션을 다시 열라는 명령이 아닙니다. 일반 쉘·다른 MCP·사람 결재는 기존대로 둡니다.

```text
-c 'mcp_servers.iamceo.tools.status.approval_mode="approve"'
-c 'mcp_servers.iamceo.tools.task_trace.approval_mode="approve"'
-c 'mcp_servers.iamceo.tools.post.approval_mode="approve"'
-c 'mcp_servers.iamceo.tools.task_review_evidence.approval_mode="approve"'
-c 'mcp_servers.iamceo.tools.task_review.approval_mode="approve"'
```

바로 재현할 수 있는 경로는 위의 합성 실행 명령입니다. 실제 운영 적용은 이 계약 밖입니다. 지정 직원만의 실행 구성에 같은 인자를 전달할 정식 후속 범위와 관리 정책의 허용 여부를 먼저 확인해야 합니다. 현재 세션에 중단 없이 적용 가능한 지원 경로는 검증하지 않았습니다.

최소 소스 후보는 세 곳입니다. server/runner/types.ts의 RunnerMember에 기존 finalReviewer 표지를 선택 항목으로 전달하고, server/orchestrator.ts의 runnerMember가 그 표지를 보존하며, server/runner/role-policy.ts의 codexRoleArgs가 지정 검수일 때만 다섯 인자를 생성하는 방식입니다. 현재 kind 변환만으로는 일반 총괄과 구분할 표지가 실행 객체에 없습니다.

이 후보는 구현하지 않았습니다. 기존 권한과 서버 도구 목록·post 작성 금지·검수 대상/계약/사람 결재 검사를 바꾸지 않는 것이 수용 조건입니다. 일반 총괄·일반 직원·다른 프로젝트·기존 MCP의 승인 방식을 함께 바꾸면 범위를 벗어납니다.

실행 주체는 별도 범위를 받은 IAMCEO 실행 설정 소유자입니다. 성공은 지정 직원의 현재 대상에서 정상 조회와 올바른 판정이 연결되고, 기존 제한과 사람 결재가 보존되는 것입니다. 새 권한 노출·승인 자동 응답·다른 역할 영향·세션/대기열 유실은 실패입니다.

설정 키의 공식 근거: [OpenAI Codex 설정 참조](https://developers.openai.com/codex/config-reference). 키 지원과 값 목록은 공식 문서, 호출 결과는 위 합성 실행에 근거합니다.

## ⑥ 실제 네 건: 납품 합격과 검수 대기를 분리해 보존합니다

네 원보고를 post 조회로 읽고, 독립 직원이 task_trace를 각 한 번 조회했습니다. 모두 currentCompletion.eligible=true, finalReview=pending, 열린 결재0입니다. 제품 납품 합격을 도구 장애로 뒤집지 않았습니다.

| 기존 검수 대상 | 관측 시각(2026-11-17 UTC) | 현재 최소 상태 |
| --- | --- | --- |
| Cc r2 / msg_cW0EDY8b1sJc | 21:49:21.807Z | 검수 pending / 업무 미결0 |
| A6 / msg_tAVxiIAc1DMx | 21:49:21.880Z | 검수 pending / 미결2·wake1 |
| Astra 선행 / msg_FxrxRSWpvxw6 | 21:49:21.937Z | 검수 pending / 미결1·wake1 |
| 독자 전용 디자인 / msg_KxVn7uPOBJrV | 21:49:22.137Z | 검수 pending / 미결2·wake1 |

실서비스 원문 대조에 필요한 새 근거는 세 가지뿐입니다. 최초06:39 KST의 도구명과 오류 한 줄, 그 호출의 MCP tools/call 또는 bridge /agent/tool 도달 여부, 같은 세대·실행 역할·정책이 읽은 릴리스와 맞는지입니다. 총괄의 기존 지원 읽기로 최소 항목만 연결하면 됩니다. 전체 대화·원시 실행 기록·접속 값은 필요하지 않습니다.

합성에서 오류를 재현했지만 이 미확인 항목을 실제 확인한 것으로 쓰지 않습니다. 실제 승인 정책·검수 권한·검수 판정·운영 설정·서비스·기존 대기열 변경은0건입니다. 옛 전달 지연 진단도 재개하지 않았습니다.

## ⑦ 세부: 릴리스와 근거의 관측 범위를 고정했습니다

업무 tk_34o1KVuzwy5Z / 확정 계약 r1입니다. 워크트리는 /Users/hyejookim/Programming/01_Ing/.worktrees/IAMCEO/review-tool-diagnostics이며 브랜치는 docs-diagnose-review-tools-tk_34o1KVuzwy5Z입니다.

읽은 원격 소스와 운영 등록 릴리스 경로의 SHA는 27ec070c1c83acbe0229c53ddccf278ad15d7965입니다. 지원 server_check는48/48/ok/required입니다. 등록 실행 파일 build-id는 6e2371cab9260fd6a97ef706705055b846ada4510cb1e6b0ec7a8918a9c31bec입니다.

현재 직원 토큰의 readiness 조회는 HTTP 오류였습니다. 실패 조회를 반복하거나 인증을 넓히지 않았습니다. 현재 프로세스와 등록 파일의 동일성까지 직접 확정한 것은 아닙니다. 환경 값 대신 등록 존재·공개 이름·종류만 남겼습니다.

정확한 소스 위치: server/orchestrator.ts:6631~6649(실행 역할), server/runner/role-policy.ts:12~37(never와 MCP 제한), server/runner/providers.ts:74~89(설정 전달), bin/mcp-bridge.ts:88~113(목록/호출 전달), server/agent-tools.ts:465~482,932~953(조회와 역할), server/orchestrator.ts:4900~4918(증거 조회의 갱신),6360~6374(자동 보고 제외)입니다.

독립 읽기 세 관점은 역할 소스·실제 오류 노출 범위·합성 CLI를 나눴습니다. root가 최종 CLI 합성을 독립 재실행하고 서버 fixture를 실행했습니다. 제품 소스는 정본과 차이0이며 이 문서·실험 파일만 커밋합니다. 최종 문서 커밋과 원격 일치는 연결 보고에 남깁니다.

자동 기억 세 건은 사용하지 않았습니다. A6는 기억 대신 이번 입력이 지정한 원보고를 직접 읽었습니다. 다른 두 전달 발췌도 현재 도구 정책의 근거로 채택하지 않았습니다. 각각 not_used와 이유를 남깁니다.
