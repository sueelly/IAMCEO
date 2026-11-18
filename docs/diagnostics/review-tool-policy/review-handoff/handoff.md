# Novel 검수 도구 진단의 검토용 원자료

예비 검수 보고 msg_sSjTzzyxObEk에서 열지 못한 **IAMCEO 검토 커밋의 변경분과 기존 합성 실행 원자료를 이 업무의 자료 본문으로 연결했습니다.** 저장소를 직접 조회하지 못해도 원본 파일, 제품 소스 구간, 저장된 실행 결과와 총괄 보고 원문을 읽을 수 있습니다.

이번 보완은 검토 자료 연결까지입니다. 기존 합성 시험·제품 검수·운영 복구를 다시 실행하지 않았습니다. 승인 정책·세션·역할·대기열·서비스·main 변경은0건입니다. 총괄이 이 자료로 지정 독립 검토를 이어갈 차례이며, 이 직원의 자료 대조를 최종 검수 수용으로 쓰지 않습니다.

## 어떤 판을 검토하는 자료인가

| 대상 | 고정 값과 의미 |
| --- | --- |
| 저장소 | `https://github.com/sueelly/IAMCEO.git` |
| 제품 소스 기준 | `27ec070c1c83acbe0229c53ddccf278ad15d7965` |
| 최초 합성·진단 자료 | `71bc06099d79d5bb834d355940b59d4e68ba969d` |
| 원래 검토 대상 | `679b10d99da712ff95eef7c6cdaa3437eb30be06` — 위 커밋의 직접 후속 문서 보완 |
| 작업 브랜치 | `docs-diagnose-review-tools-tk_34o1KVuzwy5Z` |
| 원본·실행 근거 | **f_dRBybUhHISeb** · 로컬 `snapshot.md` |
| 전체 변경분 | **f_7Am6QXyFjRpb** · 로컬 `changes.md`와 `original.patch` |
| 패치 SHA-256 | `9765f9d81ab0dc9cdf8eab27348eae76928dd7cbfad04e0aa3176baf8571e3a7` · 78318 bytes |

IAMCEO 저장소에서 원래 검토 커밋의 존재와 부모 관계를 확인했습니다. 이번 자료 생성 시 원격 작업 브랜치도 같은679b10d를 가리켰습니다. 예비 검수의 조회 결과는 missing_commit이지만, 그 호출이 어느 저장소·체크아웃을 실제로 읽었는지는 해당 보고에 없습니다. 커밋이 모든 저장소에서 사라졌다고 판단하거나 조회 경로의 원인을 단정하지 않습니다. 프로젝트 root·권한·등록을 바꾸는 대신 검토 가능한 내용 자체를 제공합니다.

이번 인계 자료를 보존하는 새 커밋은 원래 검토 대상679b10d와 구분하며, 전체 SHA와 원격 일치는 연결 보고에 적습니다.

## 검수자가 바로 대조할 근거

1. **원본과 소스:** f_dRBybUhHISeb에는679b10d의 문서·fixture·저장 결과9개 전체가 있습니다. 각 파일의 Git blob·SHA-256·바이트 수를 붙였습니다. 제품 소스는27ec070의 관련8구간만 줄 범위와 전체 파일 blob을 고정했습니다. 추출·검증 스크립트와 manifest도 같은 자료 끝에 있습니다.
2. **문서 변경:** f_7Am6QXyFjRpb는27ec070→679b10d의 생략 없는 full-index diff입니다. 실제 제품 `server/shared/tests/bin/scripts/package.json`의 변경은0입니다. 적용을 요구하는 운영 패치가 아닙니다.
3. **실행 원자료:** `synthetic-codex-results.json`의 toolOutputs·toolEvents·errors·호출 수·정책과 `synthetic-server-results.json`의 역할·판정·사람 결재 결과를 원문 그대로 포함했습니다. 당시 stdout/stderr 전체나 실서비스 원시 실행 기록을 수집한 자료는 아닙니다. 과거 보고의1pass/20expectations는 당시 실행 요약이며 이번에 새로 만든 실행 출력이 아닙니다.
4. **열리지 않던 총괄 보고:** post 조회로 다시 읽은 msg_joLOlvnUy3GJ의 작성자·시각·제목·본문을 `external-report.json`으로 묶고 f_dRBybUhHISeb에도 담았습니다. 06:39 KST 오류는 총괄의 실제 터미널 관측 보고에 귀속합니다.

| 기존 합성에서 실제 확인한 범위 | 기본 조건 | 지정 도구별 설정 후보 |
| --- | --- | --- |
| 정확한 오류 | MCP tool call requires approval, but approval policy is never · 2건 | 오류0 |
| fake MCP tools/call | 0건 | post·task_review_evidence 각1건, 합계2건 |
| 기존 제한 | never/read-only, shell·외부 MCP 제한 유지 | 같은 제한 유지 |
| 실제 모델·운영 호출 | 0건 | 0건 |

실제 Codex 호출 검증은 문제의 두 도구에 한정됩니다. 서버의 나머지 역할·대상 검사와 열린 사람 결재 보존은 별도 격리 fixture의 결과입니다. 가짜 모델 표시는 합성 Responses 응답용이며 운영 모델·effort·Fast를 바꾸지 않았습니다. CLI 공지 두 건도 원자료에 남겼습니다.

실서비스06:39 오류 문자열은 이 합성 오류와 일치합니다. 06:55:53·06:57:04의 다섯 건 배치 수신·턴 실행과 이번 총괄 입력의 턴 종료는 개별 검수 도구·최종 판정 성공과 구분합니다. 실서비스의 tools/call·/agent/tool·operation ID와 현재 프로세스 동일성은 확인하지 못했습니다. 합성 호출0을 실서비스 서버 로그 사실로 옮기지 않습니다.

## 새로 확인한 자료 정합성과 다음 담당

다음 명령은 원본 Git 객체와 내보낸 자료의 바이트·해시·인용을 대조합니다. 옛 합성 시험을 실행하거나 운영 데이터에 접근하지 않습니다.

```sh
python3 docs/diagnostics/review-tool-policy/review-handoff/verify-handoff.py
```

최종 결과는 exit0입니다. 원본9개·관련소스8구간·전체patch·총괄 보고의 출처를 확인했습니다. 별도 native 읽기 관점도 부모 관계·원자료의0/2호출·제한·사람 결재 보존의 표기를 대조했으며, 지정 최종 검수 판정은 수행하지 않았습니다.

총괄 또는 지정 독립 검수자는 위 두 자료 본문으로 기존679b10d의 진단·설정 후보·제한 유지와 이번 인계 내용을 검토할 수 있습니다. 자동 Git 조회에 같은 missing_commit이 남으면 이 자료 경로로 검토하거나 IAMCEO 저장소를 정식으로 읽는 후속 범위를 정합니다. 이 직원은 저장소 조회 권한을 넓히거나 다른 직원의 검수 판정을 대신하지 않습니다.

운영 설정 후보의 적용·현재 세션에 중단 없이 반영하는 경로·실제 검수 복구는 이번 범위 밖입니다. 기존 진단서 f_VgiVxZi5vlKy와 완료 보고 msg_p6fJQaxDvP8C의 이러한 제한은 보존합니다.

업무 tk_34o1KVuzwy5Z / 계약 r1. 워크트리 `/Users/hyejookim/Programming/01_Ing/.worktrees/IAMCEO/review-tool-diagnostics` · 브랜치 `docs-diagnose-review-tools-tk_34o1KVuzwy5Z`. 이 폴더의 `handoff.html`은 일반 브라우저에서, 같은 내용의 `handoff.md`는 터미널에서 읽습니다. 상세 원문은 같은 폴더의 `snapshot.md`와 `changes.md`에 있습니다.
