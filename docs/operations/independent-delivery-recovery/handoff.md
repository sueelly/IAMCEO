# 기존 지시 보존 복구 경로를 검증했습니다

구현·검증: 기존 전달 한 건에만 대표님의 독립 실행 허용을 연결하는 복구 경로를 만들었습니다. 관련 시험 331개, 코드 검사와 앱 만들기를 통과했습니다. 실제 운영 적용과 원 지시의 수신·실행은 아직 확인하지 못했습니다.

대표님이 지금 고르실 새 안건은 없습니다. 총괄이 검증한 변경을 운영 적용 업무로 이어받을 차례입니다. 이번 계약은 공유 메인 합치기와 운영 서비스의 임의 변경을 허용하지 않습니다.

직접 원인은 운영에서 확정하지 못했습니다. 읽은 코드와 실패 fixture에서는 이전 업무의 최종 완료 표시가 없으면 새 업무가 전송 시도 전에 제외되는 경계를 확인했습니다. 네 직원 모두가 같은 경계에서 멈췄다고 단정하지 않습니다.

찾는 말: 원래 전달 ID, 독립 실행 허용, 전송 직전 검사, 실패 결재, 실행 상한, 운영 적용.

## ① 결론: 코드 경로는 검증했고 운영 복구는 남았습니다

| 단계 | 확인한 결과 | 남은 조건 |
| --- | --- | --- |
| 소스 수정 | 기존 전달 ID에 묶인 명시적 순서 예외를 구현했습니다. | 기본 순차 정책과 보호된 입력은 그대로 검사합니다. |
| 검증 | 15개 관련 시험 파일에서 331개 통과·실패 0개입니다. 코드 검사와 앱 만들기도 통과했습니다. | 전체 저장소 시험이나 실제 제공자 계정 실행을 통과했다고 쓰지 않습니다. |
| 독립 검토 | 하위 에이전트의 정적 검토에서 찾은 주요 보호 문제를 수정했습니다. 마지막 검토에는 남은 P1·P2 지적이 없습니다. | 독립 검토 직원은 시험·운영 조작을 실행하지 않았습니다. |
| 운영 | 원래 대기 지시를 복사·재송신하거나 승인·세션·대기열을 바꾸지 않았습니다. | 실제 운영 바이너리의 일치와 원 지시의 수신·실행을 확인해야 합니다. |

## ③ 전달 근거: 대표 직접 지시와 원 지시의 수신은 다릅니다

이 업무는 대표님의 최신 직접 지시를 근거로 착수했습니다. 총괄이 먼저 보낸 원 지시를 받았다고 기록하지 않았습니다. 아래는 실제 지원 도구의 고정 관측이며 시험 fixture의 가짜 직원과 구분합니다. 시각은 UTC입니다.

| 실제 업무·직원 | 원 전달과 등록 시각 | 고정 관측 |
| --- | --- | --- |
| 설계 아키텍처 검수 / tk_w_v4VqC53JzpX1 | dl_xMNElcL65rIn / 2026-11-17T16:04:29.918Z | 17:35:39.390Z: 미결 10건, 최초 지시 queued·시도 0·수신/실행 없음 |
| 독자 서비스 설계 / tk_w_B2I9m9RGD7SV | dl_l5yUxEbQAa2g / 2026-11-17T15:52:36.425Z | 17:35:40.274Z: 미결 12건, 최초 지시 queued·시도 0·수신/실행 없음 |
| 디자인 시스템 / tk_w_xeXefGm8U2g7 | dl_wMuYDGWwhErX / 2026-11-17T15:07:54.803Z | 17:35:40.424Z: 미결 5건, 최초 지시 queued·시도 0·수신/실행 없음 |
| 독자 반응 / tk_w_Egk3jcVxrD2o | dl_kGqSJg92tD3x / 2026-11-17T16:03:48.822Z | 17:35:40.453Z: 미결 6건, 최초 지시 queued·시도 0·수신/실행 없음 |
| 이 복구 업무 / tk_w_SoxDmyweQG9B | dl_DPkK7h9osSqt / 2026-11-17T17:30:14.439Z | 17:48:37.702Z: queued·시도 0·수신/실행 없음. 후속 dl_6rTzQPshPykm도 같은 상태 |

정상 후속 비교: 공통 재생의 dl_pLNg1CWnIYVf는 2026-11-17T16:22:55.046Z에 등록됐습니다. 시도 1회 후 16:28:27.103Z에 수신·실행을 시작했고 16:30:05.151Z에 ended/success로 끝났습니다. 실행 ID는 81c3a3a9-574b-4e6b-ad20-bcc2791b96ab입니다. 이 근거는 17:35:39.353Z의 새 관측에서 읽었습니다. 같은 업무의 더 늦은 새 지시는 대기 중이므로 업무 이름만으로 현재 정상 여부를 나누지 않습니다.

대표 직접 입력 dl_K9ZDPA9vHPGP의 수신 시각은 17:34:11.851Z입니다. 이는 기존 진단 업무에 붙은 대표 직접 입력입니다. 새 복구 업무의 원 전달 dl_DPkK7h9osSqt의 수신 증거로 바꾸지 않았습니다. 기존 진단 인계에는 서버가 합격으로 기록한 보고가 있으며, 그 결과를 실제 운영 복구 완료로 확대하지 않았습니다.

## ④ 수정 경계: 순서 예외만 허용하고 안전 검사는 유지합니다

- 확인한 실패 경계는 pendingInputs → taskSequenceBlocker → hasWake=false입니다. 이전 업무가 eligible이며 최종 완료 표시가 없으면 독립 새 업무도 시도 0회로 남습니다.
- 네이티브 하위 에이전트의 parallel 설정만으로 순서를 풀지 않습니다. 대표 인증 경로에서 기존 전달 한 건에 대한 명시적 독립 실행 요청을 받아야 합니다.
- 허용 영수증은 기존 workflow_assignment_receipts에 기록합니다. 새 전달을 만들지 않습니다. 원 전달 ID·원문·직원·업무·세대·대표 원문·선행 업무를 묶습니다.
- 같은 부모 계통의 선행 조건과 대상 계통의 결재·할 일·중단·반복 실패, 다른 직원의 같은 계통 불확실 입력·미종료 실행은 그대로 막습니다.
- 실제 소켓 쓰기 직전 원문·세대·부모 연결·유효 계약·실패 결재·전체 및 프로젝트 실행 상한을 다시 검사합니다. 이미 준비한 자기 봉투의 미수신 starting 실행만 정확히 확인해 점유 검사에서 제외합니다.
- 같은 요청을 다시 보내면 기존 영수증만 반환합니다. 전체 업무나 같은 업무의 다른 지시까지 허용하지 않습니다. 응답을 잃으면 같은 요청 번호와 본문을 유지해야 합니다.

읽기 관측도 좁혔습니다. 새 task_trace의 inputAdmission은 미결 전달별 sequenceBlockerTaskId·세대·독립 허용 여부만 보여 줍니다. 본문·세션 신원·다른 프로젝트 식별자를 내보내지 않으며 상태를 바꾸지 않습니다. independentAuthorized는 순서 예외의 유효성일 뿐, 수신이나 실행 가능 전체를 뜻하지 않습니다.

## ⑤ 검증: 실제 입력 직전의 실패 반례를 고쳤습니다

| 검사 | 실제 결과 | 근거 |
| --- | --- | --- |
| 전송 전 차단 재현 | 기능 부재 상태의 실패를 먼저 확인했습니다. | 기존 업무를 남긴 채 새 원 지시가 queued·시도 0회로 남는 fixture를 사용했습니다. |
| 전송 직전 반례 | 원문·부모 연결·세대·계약·결재 변경 5건이 입력 1건을 보내던 실패를 확인했습니다. | 수정 후 같은 실제 Core 소켓 경계에서 입력 0건·수신 기록 없음으로 거절합니다. |
| 최종 관련 시험 | 331 통과, 0 실패, 15개 파일입니다. | 기존 순차·busy·lease·불확실 입력·정상 종료 재진입·단 한 번 수신·실패 결재·전체/프로젝트 한도를 포함합니다. |
| 코드 검사 | 통과했습니다. | bun run typecheck |
| 앱 만들기 | 통과했습니다. | 컴파일한 CLI의 build-id와 파일 SHA-256이 같습니다. 서버 실행은 하지 않았습니다. |

초기 소스는 0c70c4f였습니다. 작업 중 운영 DB 지원 판이 39에서 40으로 바뀌었고 하네스는 required로 관측됐습니다. 최신 원격 정책 5140c39를 이 작업 브랜치 안으로 가져와 보호 조건을 유지한 뒤 다시 검사했습니다. 공유 메인에는 쓰지 않았습니다.

독립 검토는 두 핵심 문제를 찾았습니다. 다른 직원에게 남은 같은 계통의 불확실 입력과, 실제 전송 직전 허용 조건의 변경입니다. 반례를 추가하고 수정했습니다. 마지막 독립 정적 검토에는 남은 P1·P2 지적이 없습니다.

## ⑥ 운영 적용: 총괄이 현재 조건을 읽고 별도 범위에서 이어갑니다

아래 절차는 실행하지 않았습니다. 운영 적용이나 대표 조작이 필요한 경우의 정확한 후속 인계입니다. 이미 실행 중인 직원과 서비스는 중단하지 않습니다. 메인 합치기·운영 서비스 변경은 이번 계약 밖입니다.

1. 실행 주체: 총괄이 지정한 IAMCEO 운영 적용 직원입니다. 검증한 작업 브랜치를 현재 운영 소스와 대조합니다. 이후 원격 판이 더 바뀌면 그 판과 함께 다시 검증해야 합니다. 예전 DB 지원 판의 바이너리로 운영을 되돌리지 않습니다.
2. 운영 적용 전에 server_backup으로 현재 판의 새 일관 백업을 확보합니다. 관측된 백업은 판 35·33이므로 현재 판 40의 새 백업으로 세지 않습니다. core 터미널·직원 세대·대화·결재·자료 ID·기존 Tailscale·인증 경로를 보존할 기준선을 남깁니다.
3. 별도 승인된 운영 범위에서 검증한 릴리스의 웹 서비스만 정상 교체합니다. core·직원 프로세스는 끊지 않습니다. 현재 세션을 멈추지 않고 적용할 조건을 만족하지 못하면 적용을 보류합니다. readiness의 build ID와 실제 바이너리의 build-id를 대조합니다.
4. 새 task_trace로 원 지시의 현재 순서 차단 업무와 세대를 읽습니다. 시도 0회·미수신·복구 none·같은 세대인지 확인합니다. 순서 차단이 없거나 조작권·미확정 입력·승인·계정 한도·실행 상한이 원인이면 이 순서 예외를 사용하지 않습니다.
5. 대표님의 적합한 직접 원문과 연결한 기존 지시 한 건만 새 대표 인증 경로에 명시적으로 요청합니다. 이는 실제 입력을 시작할 수 있는 쓰기 요청입니다. 단순 조회가 아닙니다. 다른 직원이나 총괄과 중복 송신하지 않습니다.
6. 성공은 원래 전달 ID의 시도 증가, 실제 inputReceivedAt, 같은 전달을 가리키는 실행 ID의 연결로 판정합니다. 영수증 응답만으로 수신 성공을 선언하지 않습니다. 보호 조건 변화·동일 계통 불확실 입력·새 전달 생성·중복 실행·승인/세대 유실이 보이면 실패로 기록하고 자동 재송신하지 않습니다.

```text
POST /api/projects/<현재 프로젝트>/deliveries/<원 전달 ID>/independent
Content-Type: application/json
Authorization: Bearer <기존 대표 인증>

{
  "operationId": "<새 UUID; 응답 유실 시 같은 값 유지>",
  "sourceMessageId": "<이 직원·업무에 대한 적합한 대표 직접 원문 ID>",
  "expectedSessionGeneration": 0,
  "expectedBlockerTaskId": "<새 관측의 실제 순서 차단 업무 ID>"
}

GET /api/projects/<현재 프로젝트>/workflow/assignments/<같은 operationId>
```

요청의 세대 0은 예시입니다. 새 관측의 정수 세대로 바꿔야 합니다. 현재 API에는 직원 도구로 쓰기 권한을 추가하지 않았습니다. 대표 인증이 있는 운영 클라이언트만 호출할 수 있습니다. 오래된 대표 원문, 같은 계통 업무, 긴급·보호·이미 시도한 지시, 바뀐 세대·계약·부모 연결에는 새 허용을 주지 않습니다. 임의의 병렬 단어나 총괄 인용문을 승인으로 읽지 않습니다.

```text
# 검증한 릴리스 확인. 기존 운영 환경값을 새 값으로 덮지 않습니다.
"$TASK_RELEASE_BIN" build-id

# 보존 조건을 만족한 별도 운영 적용 범위에서만 사용합니다.
IAMCEO_HOME="$TASK_RUNTIME_HOME" "$TASK_RELEASE_BIN" service install --restart

# 교체 뒤 동일한 바이너리로 준비와 식별값을 대조합니다.
IAMCEO_HOME="$TASK_RUNTIME_HOME" "$TASK_RELEASE_BIN" readiness
```

TASK_RELEASE_BIN은 검증한 실행 파일이며 TASK_RUNTIME_HOME은 기존 운영 홈입니다. 값은 이 자료에 싣지 않았습니다. 현재 릴리스가 이 명령으로 안전하게 교체될 조건과 승인 범위를 확인하기 전에는 마지막 명령을 실행하지 않습니다. 실패 시 운영 DB를 과거 백업으로 자동 교체하지 않습니다.

## ⑦ 세부: 코드 위치와 실행 근거를 연결합니다

| 항목 | 값 |
| --- | --- |
| 실제 새 업무 | tk_w_SoxDmyweQG9B / 계약 r1 |
| 워크트리 | /Users/hyejookim/Programming/01_Ing/.worktrees/IAMCEO/delivery-recovery |
| 작업 브랜치 | fix-unblock-delivery-admission-tk_w_SoxDmyweQG9B |
| 최종 코드와 빌드 소스 커밋 | ec5345164c47365ff8009f3c39fe6c46ff6790a6 |
| 컴파일 바이너리 | /Users/hyejookim/Programming/01_Ing/.worktrees/IAMCEO/delivery-recovery/dist/iamceo-independent-delivery |
| 로컬 빌드 ID와 SHA-256 | 7c226f57c27b8ca763dfad986ac6c39d7cfe69210818e2e509c0986f8ca1186a |
| 추적 원격 | https://github.com/sueelly/IAMCEO.git / 작업 브랜치 일반 업로드 |
| 실제 운영 바이너리와 같은지 | 미확인. 로컬에서 만든 바이너리를 운영에 설치하지 않았습니다. |

바뀐 소유 코드: server/independent-delivery.ts, server/orchestrator.ts, server/store.ts, server/http.ts, server/orchestrator-api.ts, shared/workflow.ts입니다. 전용 시험 5개와 구현 계획을 함께 남겼습니다. 최신 원격 정책은 작업 브랜치에서 보존했으며 다른 직원 워크트리와 God 소스는 수정하지 않았습니다.

```text
bun test --preload ./tests/fixtures/preserve-temp.ts tests/delivery-independent-admission.test.ts tests/independent-delivery-http.test.ts tests/independent-delivery-trace.test.ts tests/independent-delivery-authorization.test.ts tests/independent-delivery-write-boundary.test.ts tests/admission.test.ts tests/workflow-worker-order.test.ts tests/workflow-recovery-order.test.ts tests/workflow-assignment.test.ts tests/task-delivery-trace.test.ts tests/delivery-recovery.test.ts tests/lifecycle-recovery.test.ts tests/harness-mandatory.test.ts tests/task-failure-escalation.test.ts tests/core-capacity.test.ts

bun run typecheck
bun scripts/build-app.ts --outfile dist/iamceo-independent-delivery
dist/iamceo-independent-delivery build-id
```

운영 관측 출처: 계약 뒤의 IAMCEO task_trace·server_check입니다. 네 직원과 정상 후속의 고정 관측은 독립 하위 에이전트가 지원 도구로 읽었습니다. 전체 대화·원본 실행 기록·운영 DB는 직접 열지 않았습니다. 기존 진단 자료는 읽기만 했습니다.

보고 연결 오류는 같은 operation_id로 한 번 재확인해 msg_Dn39OAhtE77e 보고에 연결했습니다. 이 재확인은 직원 지시의 재송신이 아닙니다. 서버가 판을 바꾼 것은 외부 운영 변화로 관측했으며 이 업무의 운영 반영으로 세지 않았습니다.

미확인: 네 직원의 실제 최신 차단 분기, 실행 중 바이너리와 이 소스 판의 동일성, 운영 반영 뒤 원 지시의 실제 수신·실행입니다. 임시 폴더와 앱 만들기 임시 파일은 삭제하지 않았습니다. 최종 원격 일치와 자료 연결의 실제 결과는 이 자료에 붙는 막힘 보고의 검사에 남깁니다.

```text
open '/Users/hyejookim/Programming/01_Ing/.worktrees/IAMCEO/delivery-recovery/docs/operations/independent-delivery-recovery/handoff.html'
cat '/Users/hyejookim/Programming/01_Ing/.worktrees/IAMCEO/delivery-recovery/docs/operations/independent-delivery-recovery/handoff.md'
```
