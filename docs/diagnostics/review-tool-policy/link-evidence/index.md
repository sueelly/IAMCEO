# Novel 검수 진단의 원자료 연결 확인서

새 보완 업무 tk_qx9Byiz7koZZ에서 **기존 고정판의 원본·전체 변경분·실행 결과를 연결하고 정상 지원 API에서 다시 읽어 확인했습니다.** 진행 보고 msg_0KVbJThWHE7Z의 세 자료 본문이 반환됐고, 필요한 실행 결과 JSON은 고정 입력과 일치했습니다.

이번 결과는 커밋 조회가 실패해도 자료 본문으로 대조할 수 있게 한 작성자 보완입니다. 기존 합성 시험·제품 검수·운영 복구는 다시 수행하지 않았습니다. 총괄이 지정 독립 검토를 이어갈 차례이며, 이 직원의 정상 조회를 지정 검수자의 최종 수용으로 바꾸지 않습니다.

## 무엇을 어느 업무에 연결했나

| 대상 | 근거와 연결 |
| --- | --- |
| 현재 보완 업무 | tk_qx9Byiz7koZZ · 확정 계약 r1 |
| 원 업무·문제 보고 | tk_34o1KVuzwy5Z · msg_sSjTzzyxObEk |
| 원래 검토 대상 | IAMCEO 679b10d99da712ff95eef7c6cdaa3437eb30be06 |
| 원자료 묶음의 고정판 | 28c08fc55dd79b6ee786e4cd42965239101dd0a0 |
| 제품 소스 기준 | 27ec070c1c83acbe0229c53ddccf278ad15d7965 |
| 저장소 | https://github.com/sueelly/IAMCEO.git |
| 원본 9개·소스 8구간 | f_Scyhi03Me6ic · 원 업무 f_dRBybUhHISeb의 입력을 연결 |
| 전체 변경분 | f_RuJfMFYh5SQ7 · 원 업무 f_7Am6QXyFjRpb의 전체 diff 입력을 연결 |
| 필요한 실행 원자료 | f_XIc9unzt2Pwn · 기존 CLI·서버 결과 JSON과 총괄 보고 본문 |

원 업무의 최신 task_trace에는 완료 근거 msg_p6fJQaxDvP8C와 msg_2pQdiJI4GGce가 eligible로 남고 지정 최종 검수는 pending으로 관측됐습니다. 이 상태를 보존하고, 새 업무에는 별도 브랜치·워크트리를 등록했습니다. 원 업무의 단계나 계약을 바꾸지 않았습니다.

## 직접 다시 읽어 확인한 범위

정상 post(report_id) 조회로 위 세 자료의 본문을 받았습니다. 호출 결과의 전체 실행 JSON을 고정 입력과 대조했습니다.

| 실행 원자료의 핵심 필드 | 재조회 결과 |
| --- | --- |
| 기본 fake MCP 호출 수 | 0 |
| 기본 오류 | MCP tool call requires approval, but approval policy is never · 2건 |
| 후보 fake MCP 호출 수 | post·task_review_evidence 각1건, 합계2건 |
| never/read-only·쉘/외부 MCP 제한 | 보존 true |
| 서버 fixture의 사람 결재 | 거절 뒤에도 열린 상태 true |
| 전체 실행 JSON과 고정 입력 | 일치 true |

이는 원 커밋에 보존된 기존 합성 실행 결과의 재조회입니다. 새 모델·계정·운영 호출이나 실제 검수 판정이 아닙니다. 당시 전체 터미널 또는 실서비스 서버 로그를 수집한 자료도 아닙니다. 06:39 KST 실제 오류는 자료 안의 총괄 보고 msg_joLOlvnUy3GJ에 귀속하고, 합성의 호출0을 실서비스 서버 로그 사실로 옮기지 않습니다.

큰 소스 자료를 지원 API로 읽으면 합성 코드의 usage 필드 등에 [가림]이 반환됩니다. 그 반환 본문을 Git 원문과 바이트가 같다고 주장하지 않았습니다. 가림을 풀거나 정책을 바꾸지 않았습니다. 원문 기준은 고정 Git 객체·blob·SHA-256이며, 필요한 실행 결과 JSON은 별도 자료로 나누어 재조회 일치를 확인했습니다. 가림이 저장·응답 중 어느 단계에서 적용됐는지는 이번 조회만으로 확정하지 않습니다.

## 문서 회귀 검사와 남은 담당

새 워크트리에서 다음 문서 검사를 실제 실행해 모두 exit0을 확인했습니다. 기존 CLI·서버 합성 fixture를 다시 실행하는 명령은 아닙니다.

```sh
python3 docs/diagnostics/review-tool-policy/review-handoff/verify-handoff.py
python3 docs/diagnostics/review-tool-policy/verify-report.py
python3 docs/diagnostics/review-tool-policy/link-evidence/verify-link.py
```

앞의 두 검사는 원본9개·제품소스8구간·전체diff·오류·역할/사람 결재 보호와 원 진단서의 일치를 확인합니다. 마지막 검사는 이번 업무의 연결 ID·정상 조회 기록·필요한 실행 JSON·표시 문서가 고정 입력과 맞는지 확인합니다. 검증한 새 문서만 커밋·작업 브랜치 일반 업로드하고 원격 SHA 일치를 연결 보고에 남깁니다.

자동 Git 조회의 missing_commit이 정상화됐다고 보고하지 않습니다. 지정 검수자의 이번 자료 열람·최종 수용, 실서비스 tools/call·/agent/tool·operation ID·현재 프로세스 동일성은 미확인입니다. 총괄은 새 업무의 세 자료로 지정 독립 검토를 이어갈 수 있습니다. 정책·권한·역할·승인·세션·기존 대기열·서비스·main 변경은0건입니다.

워크트리 `/Users/hyejookim/Programming/01_Ing/.worktrees/IAMCEO/link-review-evidence` · 브랜치 `docs-link-review-evidence-tk_qx9Byiz7koZZ`. 이 폴더 아래 `docs/diagnostics/review-tool-policy/link-evidence/index.html`은 일반 브라우저에서, `index.md`는 터미널에서 읽을 수 있습니다. 두 파일의 핵심 내용은 같습니다.
