# Claude resume recovery implementation plan

Goal: An explicit reopen must recover a missing Claude transcript without replaying migrated uncertain inputs or dismissing setup prompts.
Spec: The existing reopen contract in server/orchestrator.ts already starts a fresh session only for a confirmed missing native conversation. Production currently launches --resume against an absent transcript, returns startup success, and later fails as an unclassified dead terminal.
Architecture: Check Claude transcript availability after owned-live-terminal reattachment and before terminal.run. Only conclusive filesystem absence means missing; permission and I/O errors retain the current conversation. Codex/Antigravity, live owned terminals and unknown transport results retain existing behavior.

- [x] Add regression tests for a missing Claude resume, existing transcript in another cwd, live reattachment with no transcript yet, and inconclusive filesystem access.
- [x] Run new tests and observe missing preflight failing.
- [x] Add the narrow preflight in server/runner/core.ts using strict filesystem checks. Do not mutate delivery recovery state.
- [x] Run core/lifecycle/recovery regressions, typecheck and the project suite; compare known baseline failures.
- [x] Review and commit verified files; push the task branch and verify remote SHA.
- [x] Build an immutable candidate; arrange a service-safe rollout without interrupting active user work; verify the failed writer can open and its same eligible instruction is received once.

Constraints: Preserve conversations, drafts, approvals, old native logs, migrated held/unknown deliveries and other active work. Do not accept trust prompts, retry unknown input, create duplicate workers, force-push, or merge main. User request is continuation of the established migration, not authorization for new feature scope.

Verification ledger: Started from deployed source d3f234e. Production writer m_LZwnt9TMRno4 failed before input; screen explicitly reports No conversation found. Fresh-session API correctly refuses due to preserved older unknown deliveries. This fix uses the established confirmed-missing reopen path and leaves that guard intact.

Verification: Initial tests failed on missing-resume acceptance and unchanged native ID. After the preflight, 212 core/lifecycle/HTTP/delivery recovery regressions pass and TypeScript typecheck passes. Resume fixtures now explicitly include an existing transcript when testing preservation. The full product command was attempted; its known browser fixture stall was terminated only within the owned test process tree. All non-browser tests are being run with isolated IAMCEO_TEST=1 and IAMCEO_HOME; baseline schema/legacy failures are not hidden.

Final required verification: 223 tests across core-runner, core-context, lifecycle-recovery, operations-http and delivery-recovery pass; typecheck passes. The full non-browser suite reports 2,129 pass / 27 fail. No new CoreRunner or lifecycle failure remains. Existing schema-v32 expectations and legacy Herdr tests remain red; one legacy status timing test also failed in the all-files run and is checked separately. Full product/browser success is not claimed.

Full-suite observed failures (verbatim test names):
- (fail) DB v32: 계약 확인·실행 증거·조사 주장·개선 후보 표가 생긴다 [18.37ms]
- (fail) server_check·server_backup: 직원은 데이터 폴더를 직접 읽지 않고 서버가 만든 백업과 상태를 본다. 경로는 싣지 않는다 [18.77ms]
- (fail) herdr status observations > events retain unknown observations and recover the same blocked state after snapshot failure [77.18ms]
- (fail) 가짜 소켓 서버 > 입력칸에 남은 글은 지우는 키를 한 번 눌러 지우고, 0.3초 뒤 다시 읽어 비었으면 넣는다 [0.54ms]
- (fail) 가짜 소켓 서버 > 지운 글이 늦게 사라져도 0.5초 안이면 다시 누르지 않고 넣는다 [0.44ms]
- (fail) 가짜 소켓 서버 > 흐린 다음 말 추천만 있으면 지우는 키 없이 넣는다 [1.06ms]
- (fail) 가짜 소켓 서버 > 일하는 중(urgent)에는 남은 글을 지우지 않는다. 지우는 키가 턴을 끊는다 [0.54ms]
- (fail) 가짜 소켓 서버 > 지우는 키는 칸마다 간격을 두고 한 번씩만 누른다. 종료 안내가 떠 있으면 누르지 않는다 [0.50ms]
- (fail) 가짜 소켓 서버 > timeout: 넣기 전부터 화면에 있던 머리글·[Pasted text·#id 는 증거가 아니다 [110.90ms]
- (fail) 가짜 소켓 서버 > 머리글만 있는 글에는 고유 표지를 붙여 넣는다 [1.45ms]
- (fail) 가짜 소켓 서버 > 응답이 턴보다 늦어도 turn_end 는 한 번이고 바쁨이 남지 않는다 [1070.51ms]
- (fail) 가짜 소켓 서버 > 승인 창을 거쳐 idle 이 되면 시한을 넘겼어도 awaiting 이 풀린다 [72.99ms]
- (fail) 가짜 소켓 서버 > 소켓이 끊긴 사이에도 awaiting 시한을 다시 건다 [3165.56ms]
- (fail) 가짜 소켓 서버 > herdr 가 되살린 칸(인자 없음)은 전체 인자로 다시 열고 나서 넣는다. 넘겨받은 세션은 예외 [4.53ms]
- (fail) 가짜 소켓 서버 > 편입: 입력칸에 쓰던 글은 지우고 /add-dir 를 넣는다. 입력칸을 못 찾으면 미뤘다가 다음 전달 때 넣는다 [316.92ms]
- (fail) 가짜 소켓 서버 > timeout 뒤 화면에 #id 가 있으면 다시 넣지 않는다 [158.33ms]
- (fail) 가짜 소켓 서버 > timeout 뒤 흔적이 없을 때만 한 번 다시 넣는다 [159.27ms]
- (fail) 가짜 소켓 서버 > working 이면 timeout 을 들어간 것으로 본다 [160.12ms]
- (fail) 격리 herdr 서버 > (unnamed) [4.42ms]
- (fail) 격리 herdr 서버 > (unnamed) [0.39ms]
- (fail) 2차 검수 회귀: 칸 소유·전달(가짜 소켓) > 해제 도중·뒤의 화면 조회는 칸을 다시 묶지 않아 곧바로 다시 넘겨받을 수 있다 [2.42ms]
- (fail) 2차 검수 회귀: 칸 소유·전달(가짜 소켓) > 일하는 칸의 인자가 모자라도 urgent 로 닫지 않는다 [2.74ms]
- (fail) 2차 검수 회귀: 칸 소유·전달(가짜 소켓) > agent.prompt 시간 초과 뒤: 쉬는 세션에서만 남은 글을 지우고 다시 넣는다. 일하는 중이거나 입력칸을 못 찾으면 다시 넣지 않는다 [158.06ms]
- (fail) 2차 검수 회귀: 칸 소유·전달(가짜 소켓) > 칸에 넣는 글에는 ESC·DEL·양방향 문자가 없다(prompt·compact 공통 관문) [2.50ms]
- (fail) 2차 검수 회귀: 칸 소유·전달(가짜 소켓) > 병렬 명령의 working 이 일 글 응답보다 먼저 묻혀도 turn_end 가 난다 [2.29ms]
- (fail) 2차 검수 회귀: 칸 소유·전달(가짜 소켓) > 남은 working 이 응답까지 이어져도 awaiting 이 걸려 스톨이 턴을 끝낸다 [4.28ms]
- (fail) 2차 검수 회귀: 칸 소유·전달(가짜 소켓) > promptSeen: 세션 기록이나 화면에 표지가 있을 때만 true [1.69ms]
- (fail) DB v32: 계약 확인·실행 증거·조사 주장·개선 후보 표가 생긴다 [18.37ms]
- (fail) server_check·server_backup: 직원은 데이터 폴더를 직접 읽지 않고 서버가 만든 백업과 상태를 본다. 경로는 싣지 않는다 [18.77ms]
- (fail) herdr status observations > events retain unknown observations and recover the same blocked state after snapshot failure [77.18ms]
- (fail) 가짜 소켓 서버 > 입력칸에 남은 글은 지우는 키를 한 번 눌러 지우고, 0.3초 뒤 다시 읽어 비었으면 넣는다 [0.54ms]
- (fail) 가짜 소켓 서버 > 지운 글이 늦게 사라져도 0.5초 안이면 다시 누르지 않고 넣는다 [0.44ms]
- (fail) 가짜 소켓 서버 > 흐린 다음 말 추천만 있으면 지우는 키 없이 넣는다 [1.06ms]
- (fail) 가짜 소켓 서버 > 일하는 중(urgent)에는 남은 글을 지우지 않는다. 지우는 키가 턴을 끊는다 [0.54ms]
- (fail) 가짜 소켓 서버 > 지우는 키는 칸마다 간격을 두고 한 번씩만 누른다. 종료 안내가 떠 있으면 누르지 않는다 [0.50ms]
- (fail) 가짜 소켓 서버 > timeout: 넣기 전부터 화면에 있던 머리글·[Pasted text·#id 는 증거가 아니다 [110.90ms]
- (fail) 가짜 소켓 서버 > 머리글만 있는 글에는 고유 표지를 붙여 넣는다 [1.45ms]
- (fail) 가짜 소켓 서버 > 응답이 턴보다 늦어도 turn_end 는 한 번이고 바쁨이 남지 않는다 [1070.51ms]
- (fail) 가짜 소켓 서버 > 승인 창을 거쳐 idle 이 되면 시한을 넘겼어도 awaiting 이 풀린다 [72.99ms]
- (fail) 가짜 소켓 서버 > 소켓이 끊긴 사이에도 awaiting 시한을 다시 건다 [3165.56ms]
- (fail) 가짜 소켓 서버 > herdr 가 되살린 칸(인자 없음)은 전체 인자로 다시 열고 나서 넣는다. 넘겨받은 세션은 예외 [4.53ms]
- (fail) 가짜 소켓 서버 > 편입: 입력칸에 쓰던 글은 지우고 /add-dir 를 넣는다. 입력칸을 못 찾으면 미뤘다가 다음 전달 때 넣는다 [316.92ms]
- (fail) 가짜 소켓 서버 > timeout 뒤 화면에 #id 가 있으면 다시 넣지 않는다 [158.33ms]
- (fail) 가짜 소켓 서버 > timeout 뒤 흔적이 없을 때만 한 번 다시 넣는다 [159.27ms]
- (fail) 가짜 소켓 서버 > working 이면 timeout 을 들어간 것으로 본다 [160.12ms]
- (fail) 격리 herdr 서버 > (unnamed) [4.42ms]
- (fail) 격리 herdr 서버 > (unnamed) [0.39ms]
- (fail) 2차 검수 회귀: 칸 소유·전달(가짜 소켓) > 해제 도중·뒤의 화면 조회는 칸을 다시 묶지 않아 곧바로 다시 넘겨받을 수 있다 [2.42ms]
- (fail) 2차 검수 회귀: 칸 소유·전달(가짜 소켓) > 일하는 칸의 인자가 모자라도 urgent 로 닫지 않는다 [2.74ms]
- (fail) 2차 검수 회귀: 칸 소유·전달(가짜 소켓) > agent.prompt 시간 초과 뒤: 쉬는 세션에서만 남은 글을 지우고 다시 넣는다. 일하는 중이거나 입력칸을 못 찾으면 다시 넣지 않는다 [158.06ms]
- (fail) 2차 검수 회귀: 칸 소유·전달(가짜 소켓) > 칸에 넣는 글에는 ESC·DEL·양방향 문자가 없다(prompt·compact 공통 관문) [2.50ms]
- (fail) 2차 검수 회귀: 칸 소유·전달(가짜 소켓) > 병렬 명령의 working 이 일 글 응답보다 먼저 묻혀도 turn_end 가 난다 [2.29ms]
- (fail) 2차 검수 회귀: 칸 소유·전달(가짜 소켓) > 남은 working 이 응답까지 이어져도 awaiting 이 걸려 스톨이 턴을 끝낸다 [4.28ms]
- (fail) 2차 검수 회귀: 칸 소유·전달(가짜 소켓) > promptSeen: 세션 기록이나 화면에 표지가 있을 때만 true [1.69ms]

Independent legacy timing check: herdr-contract.test.ts / events retain unknown observations passes in isolation (1 pass, 0 fail). This does not erase the observed full-suite failure. Final review confirms preflight is after live ownership reattachment and native-ID validation, before terminal.run; no delivery, approval or interrupt mutation was added.

Production verification (2026-11-16): fa6581a62436f73a03177bf90bd48e0044606b2d was pushed and origin HEAD matched. An immutable git-archive build, frozen dependencies, code signature and compiled empty-home HTTP readiness passed. First launchd replacement did not settle and was rolled back. The second waited for the old log supervisor and web child to exit before bootstrap; local and Tailscale readiness now match binary SHA 91b7e6ec8ad35342f9fafcf31eebb86de5858a5fadd35785a4b70aefb83cb5c3. All five pre-existing live CLI PIDs were preserved.

The writer reopened with a fresh native ID through the existing confirmed-missing path. Twelve current instructions proved not written were rechecked through the versioned official API with the same delivery IDs; all twelve have actual delivered_at receipts and matching inputReceivedAt in the six receiving workers. Historical restore-quarantined instructions were not replayed or relabeled received. The original writer completed its handoff-only instruction; the actual R1/R2 follow-up was then explicitly sent under the existing Agent-A task so handoff completion would not be mistaken for code work.

The design conductor received the original user implementation approvals and resumed web leftovers. The separate old native app worker was inspected on the source: prior execution ended, no approval, empty composer. Target had no owned terminal, live execution or unresolved physical dispatch. Official sleep/resume normalized that inactive imported state; no source session was touched or live CLI killed. Native app verification remains blocked on missing Xcode. No new candidates, users, main merges or unknown-input retries were authorized.

User's ongoing product tasks are distinct from this service fix: work continues in the registered projects, subject to the existing seven concurrent turns. Full-product failures above remain a limitation; this is not a claim that all backlog features are complete.
