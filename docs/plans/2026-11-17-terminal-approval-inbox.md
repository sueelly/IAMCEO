# 터미널 승인 안내 공통 적용 · 결재함 연결 (2026-11-17)

업무 tk_QxXYx8u1FDOt, 계약 r1. 대표 원문 c8386973-36b7-47b9-9649-1c7abe487f38, 앞선 개인 메모 보고 msg_asxgOuhkyXMn.
맥미니(hyejoo-mac-mini.local) 워크트리 `.worktrees/IAMCEO/terminal-approval-inbox-20261117`, 브랜치 `feat/terminal-approval-inbox-20261117`(origin/main c408f8e 에서).

## 지금 있는 것(재사용)
- 역할 글: `server/roles.ts` 의 `renderRole` 하나가 모든 경로의 출처다. 런너가 띄운 Claude(`--append-system-prompt-file`), Codex(`-c developer_instructions=`), Antigravity(`--gemini_dir` 의 GEMINI.md)는 띄울 때마다 다시 쓴 규칙 파일을 받는다(새 세션·이어 열기 같음). 넘겨받은 세션은 첫 지시와 압축 뒤 규칙 재전송으로, 직접 연결(`iamceo join`)은 그때 쓴 규칙 파일로 받는다.
- 승인 창 읽기·넣기: core 실행기의 `nativePrompt`/`answerNativePrompt`(창 차례 키·세대·실행 확인, 같은 창 재입력 울타리), 오케스트레이터의 operationId 영수증(메모리), 대화 화면 `NativePromptCard`.
- 결재함 '승인 대기': `ApprovalPanel` 은 herdr 칸만 읽는다(`backend === "herdr"`). core 직원은 읽지 않고 "여기서 답할 수 없는 창"을 그린다. ← 이번에 메울 곳.

## 바꿀 것(구현자 판단)
1. 공통 프롬프트: `server/roles/terminal-approval.md` 를 세 종류 역할 글에 넣는다. 고쳐 쓴 템플릿에도 빠지지 않게 끝에 붙인다(기억·effort 줄과 같은 방식). 총괄·본사 AI 에는 직원 창을 알리는 줄을 더한다.
2. 결재함: core 직원은 `NativePromptCard` 로 그린다(직원·업무·제공자·창 글·선택지·고르면 생기는 일). herdr 칸은 지금 `ApprovalPanel` 그대로.
3. 단계 표시: 창 확인(카드 등록) · 응답 기록 · 터미널 접수 · 이후 상태(명령 결과)를 따로 보인다. 터미널 접수는 넣은 뒤 창을 다시 읽어 닫혔는지 본다. 그대로면 다시 넣지 않고 '확인 필요'로 둔다.
4. 식별 강화: 요청에 projectId·memberId 를 싣고 서버가 대조한다. 창 차례 키에 실행기 기동 표지를 넣어 서버 재시작 전 카드는 넣지 않는다. 같은 operationId 영수증을 DB 에 남겨 재시작 뒤 재요청도 첫 결과만 돌려준다. 결과를 모르면 'unknown' 으로 두고 다시 넣지 않는다.
5. 표시 글 가림: 창 글·원문에 든 토큰·비밀번호 꼴은 `[가림]` 으로 보인다(넣는 동작은 원래 창 키로 한다).
6. 승인 대기 알림: core 직원도 창 요약을 알림 본문에 싣는다.
7. 이미 답을 넣은 창이 그대로 남으면(다른 탭·응답 유실) 선택지를 다시 내지 않고 '이미 답했다'고 보인다. 넣지 않은 답 뒤에 새 창이 보이면 그 사실을 새 창 위에 남긴다. 응답을 잃은 답은 보낼 때의 귀속으로 같은 id 의 결과만 다시 받는다.

## 하지 않는 것
자동 승인·상시 승인 설정, 새 입력 권한, 기존 보류 전달·과거 unknown 입력 재생, 실행 중 세션 끊기, 메인 합치기·운영 재시작, 네이티브 앱(Swift) 결재함 변경(그대로 터미널 안내).

## 요구 ↔ 검사
| 기준 | 검사 |
| --- | --- |
| 1 공통 프롬프트·전달 경로 | `tests/terminal-approval-guide.test.ts`: 세 종류 × 기본/고친 템플릿, Claude·Codex·Antigravity × 새/이어 열기 |
| 2 결재함에 창 내용 | `tests/inbox-approval.browser.ts`: core 직원 카드에 직원·업무·창 글·선택지·결과 문구, 지원 안 하는 창은 버튼 없음, 일반 출력은 창 없음 |
| 3 한 번 전달·단계 구분 | `tests/inbox-approval.test.ts` + 브라우저: 키 한 번, 접수 확인, 네 단계 |
| 4 낡은 카드·다른 직원·중복·유실 | `tests/inbox-approval.test.ts`: 세대·실행·창·프로젝트·직원 불일치, 같은 id 재요청, 재시작 뒤 재요청, 넣은 뒤 창 그대로 |
| 5 의미·권한 보존 | 선택지 글·번호 그대로, 가림은 표시만, 기존 시험 회귀 |
| 6 왕복·정상 거절 | 위 시험 + `tests/e2e-real/inbox-approval-core.ts`(`IAMCEO_E2E_CORE=1`): 격리 실제 herdr-core 0.1.18 + 실제 서버 코드 + 가짜 Claude 화면(`tests/fixtures/core-fake-claude-tui.ts`, OSC 7501) 왕복, 좁은 폭 390px. 실제 Claude CLI·실기기는 돌리지 않음 |
| 7·8 커밋·원격·단계 | 커밋, 작업 브랜치 깃허브에 올리기, ls-remote 대조, 결과 자료 |
