# Agent-A 직접 화면과 초안 보존 규약

IAMCEO 의 Agent-A 직접 화면(`web/src/components/AgentAReview.tsx`)은 Agent-A 앱을 칸(iframe)에 넣지 않고,
IAMCEO 서버의 검토 길(`server/integrations/agent-a-review.ts`)이 Agent-A 의 검토 규약을 대신 부른다.
이 문서는 그 길이 **다른 창의 초안을 덮지 않으려고** Agent-A 쪽에 더한 규약과, 적용·되돌리기 조건을 적는다.

## 왜 Agent-A 를 바꿔야 했나

원래 Agent-A(c559881)의 초안 저장(`POST /api/draft`)은 초안을 통째로 바꾼다. 세대 번호(`draftGeneration`)는
초안을 지우거나 제출할 때만 오르고, 보통 저장에서는 그대로다. 그래서 '초안을 읽고 → 주석 하나를 더해 → 통째로 저장'하면,
읽은 뒤 다른 창(원래 Agent-A 화면·다른 프로세스)이 저장한 직접 편집·첨부·주석이 사라진다. 두 저장이 모두 200 이라 알 수도 없다.
IAMCEO 안에서 줄을 세워도(직렬 잠금) 다른 창은 막지 못한다. 독립 검토 F1 이 이 반례다.

IAMCEO 만으로는 고칠 수 없다: 조건을 걸 수 있는 쓰기도, 주석 하나만 더하는 쓰기도 원래 규약에 없다.

## Agent-A 에 더한 것(초안 규약 2)

`agent-a-draft-protocol-2.patch` (기준 c559881, `src/server/plannotator.js` 와 시험 1개). 원래 화면(Plannotator)은 고치지 않았고,
원래 화면이 쓰는 요청·응답 본문의 모양도 그대로다. 더한 것만 쓰는 쪽이 보호받는다.

| 더한 것 | 뜻 |
| --- | --- |
| `draft_revision` | 저장된 초안이 바뀔 때마다 오르는 판 번호(저장·지우기·문서별 초안·제출·주석 추가). 응답 머리 `X-ENOUV-Draft-Revision` 으로 준다. |
| `POST /api/draft` 의 `ifDraftRevision` | 보낸 판과 지금 판이 다르면 아무것도 바꾸지 않고 409 `draft_conflict`. 안 보내면 예전처럼 통째로 바꾼다(원래 화면). |
| `POST /api/feedback` 의 `ifDraftRevision` | 제출하려는 사이 초안이 바뀌었으면 제출하지 않는다. 같은 제출의 재전송은 판 검사보다 먼저 처음 결과를 돌려준다. |
| `POST /api/draft/annotations` | 주석 하나만 한 트랜잭션에서 더한다. 초안의 다른 칸은 건드리지 않는다. 같은 id·같은 내용은 처음 결과 확인, 같은 id·다른 내용은 409 `idempotency_conflict`, 지난 판의 검토는 409 `revision_conflict`, 제출한 검토는 409 `decided`. |
| 검토 세션의 `capabilities.draft_protocol = 2` | 이 규약을 아는 Agent-A 라는 표시. |

## IAMCEO 가 쓰는 방법

| 일 | 길 | 다른 창의 초안 |
| --- | --- | --- |
| 새 댓글·삭제 표시 | `GET /api/draft`(초안 판 머리로 규약 확인) → `POST /api/draft/annotations` | 통째 저장을 하지 않으므로 남는다 |
| 본문 직접 고치기(초안) | `GET /api/draft` → `POST /api/draft` + `ifDraftRevision`(화면이 고치기 시작할 때 본 판) | 그사이 바뀌었으면 거절하고 대표에게 보인다 |
| 검토 제출 | `GET /api/draft` → `POST /api/feedback` + `ifDraftRevision` | 그사이 바뀌었으면 제출하지 않는다 |
| 답글·완료·지우기·다시 요청·갈래 질문·수정안 저장·판·문서 관리 | 원래 규약 그대로(줄 하나만 바꾸는 쓰기) | 초안을 건드리지 않는다 |

IAMCEO 만으로 고친 것: 직접 고치기·되살리기의 재전송(F2). 명령을 요청이 가리킨 판으로만 만들어, 같은 요청을 다시 보내면
같은 명령이 되고 Agent-A 가 판 검사보다 먼저 보관한 처음 결과를 돌려준다. 지금 판으로 바꿔 다시 보내지 않는다.

## 서버 조합

| IAMCEO | Agent-A | 결과 |
| --- | --- | --- |
| 이 가지 | 초안 규약 2(패치 적용) | 모든 기능 |
| 이 가지 | 원래 c559881 | 새 댓글·삭제 표시·본문 고치기·검토 제출을 **거절**한다(`AGENT_A_UNSUPPORTED`, 화면에 까닭을 보인다). 읽기·답글·수정안·판·문서 관리·문서에 묻기는 된다. 통째 저장으로 조용히 넘어가지 않는다. |
| 예전 가지(칸 방식) | 초안 규약 2 | 원래 화면이 그대로 돈다(더한 것은 안 쓴다) |

지금 켜 둔 체험 Agent-A(4417)는 원래 c559881 이다. 이 가지를 그 Agent-A 에 붙이면 둘째 줄이 된다.

## 적용과 되돌리기

1. 적용: Agent-A 소스에 `git apply docs/agent-a/agent-a-draft-protocol-2.patch` → Agent-A 다시 시작. DB 구조는 바뀌지 않는다
   (검토 세션 기록에 `draft_revision` 칸이 생길 뿐이고, 없는 옛 세션은 0 으로 읽는다).
2. 되돌리기: 패치를 빼고 Agent-A 를 다시 시작한다. 저장된 `draft_revision` 칸은 원래 코드가 읽지 않아 그대로 두어도 된다.
   그 뒤 IAMCEO 는 둘째 줄(쓰기 거절)로 돈다. 이미 저장된 댓글·초안·판은 그대로다.
3. 코드를 되돌려도 예전 방식으로 이미 덮인 초안은 돌아오지 않는다. 그 복구는 Agent-A 의 백업으로만 한다.

## 확인하는 방법

- Agent-A 쪽: 패치를 적용한 소스에서 `node --test tests/server/draft-protocol.test.js` 와 기존 `npm test`.
- IAMCEO 쪽: `bun test tests/agent-a-review-preserve.test.ts tests/agent-a-review.test.ts`(가짜 Agent-A, 초안 규약 1·2 둘 다),
  `bun test ./tests/agent-a-review.browser.ts`(화면).
- 실제 Agent-A 서버 코드로 대조: 패치한 소스의 `buildApp` 을 새 데이터 폴더·AI 대역으로 띄우고
  `IAMCEO_AGENT_A_REAL_URL=http://127.0.0.1:<포트> bun test ./tests/agent-a-review.browser.ts`.

## 아직 옮기지 않은 것

- 도식(Mermaid): 원문을 '도식 원문'으로 밝혀 글로 보인다. 그림으로 그리려면 Mermaid 부품(약 5MB, 딸린 패키지 다수)을 IAMCEO 에 넣어야 해서 정하지 않았다.
- 앱 자신을 고치는 수정안·미리 보기·적용: 문서 검토와 다른 코드 변경·적용 범위라 이 화면에 넣지 않았다(범위 미정).
- 원래 화면의 빠른 라벨(Label), 그림 위 자유 그리기, 대화 갈래 만들기(문서에 묻기의 fork), 블록 보관·새 블록·배치 보드.
