# 운영 릴리스 정본의 전달 경계 검증 계획

확정 범위는 운영 릴리스 166c99529eaae584169983049d0058bad78f6e29의 기존 관련 시험을 격리 실행하고, 원래 지시 두 건의 실제 수신·실행에 연결하는 외부 검수입니다. 계약은 tk_w_SoxDmyweQG9B r2입니다.

- 새 워크트리: /Users/hyejookim/Programming/01_Ing/.worktrees/IAMCEO/verify-live-delivery
- 브랜치: test-verify-live-delivery-tk_w_SoxDmyweQG9B
- 운영 SHA의 귀속: 총괄의 이번 확정 지시. server_check는 schema44/supported44/ok=true/required를 별도 확인합니다. 판 번호만으로 바이너리 해시 일치를 증명하지 않습니다.
- 제품 소스·기존 시험은 정본 그대로 둡니다. 구판40의 별도 복구 패치를 적용하지 않습니다.
- 기존 정상/미수신4명 고정 비교와 실패→수정 근거는 이전 자료를 이어받습니다. 전체 진단·331개 전체·원래 지시 재송신·운영 변경은 반복하지 않습니다.

## 실행할 최소 관련 범위

1. workflow-assignment-release / orchestration-completion / dispatch-execution-contract: 선행 업무 차단과 검증 납품 뒤 해제, 비동기 최종 확인, 원문·계약 불변 및 미확정 입력 보호.
2. task-continuation-runtime / admission / core-capacity: busy·lease·승인·불확실 입력·정상 종료 재진입·전역/프로젝트 상한·실제 소켓 쓰기 직전 재검사.
3. lifecycle-recovery에서 ACK started:false, 응답 유실, busy rejected의 기존 3개 회귀만 시험명으로 선별합니다. 시도 횟수와 단일 수신을 구분합니다.
4. bun run typecheck로 같은 정본의 코드 검사를 실행합니다. 새 앱 만들기나 설치는 이 검수에 포함하지 않습니다.

## 격리·보존 조건

기존 preserve-temp preload를 사용해 /private/tmp/iq-* 시험 루트를 보존합니다. 공통 fixture는 별도 provider homes와 FakeRunner를 주입합니다. core-capacity peer는 실제 계정 argv를 실행하지 않습니다. 새 시험의 격리 DB만 사용하며 운영 DB·원시 실행 기록·설정·키는 열지 않습니다.

세 독립 읽기 관점은 시험 범위의 안전성, 현행 보호 경계, 지원 API의 실제 수신 연결을 각각 확인합니다. root만 시험과 자료 작성·검증·커밋을 맡습니다. 운영 API 쓰기·직원 입력·세션/서비스 변경·임시 폴더 삭제는 0건을 유지합니다.

## 판정

실제로 실행한 명령·종료 코드·통과/실패 수를 기록합니다. 기존 부정 fixture가 통과하는 것을 새 실패→소스 수정으로 쓰지 않습니다. 시험의 가짜 수신과 실제 원래 전달의 증거는 다른 표에 연결합니다. 실패가 있으면 소스를 고치지 않고 원인과 정확한 미확인 조건을 인계합니다.

자료만 커밋하고 이 작업 브랜치를 origin에 일반 업로드합니다. 원격 SHA와 HEAD를 대조합니다. 공유 메인·운영 서비스는 이 검수의 반영 대상이 아닙니다.
