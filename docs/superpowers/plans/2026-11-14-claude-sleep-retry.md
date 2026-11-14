# Claude sleep retry: guarded inspection candidate

> Execute sequentially in this session. No subagents, model calls, live input, dependency replacement, database migration, merge, push, or server restart.

**Goal:** Preserve the existing conversation and queued deliveries while distinguishing a known sleep error from an input that is safe to retry.

**Architecture:** The installed generation-1 protocol supports only `if: idle|working`; its send does not atomically compare the process, native session, generation, turn, input epoch, composer, and exact error. Therefore this candidate must never transmit from error. Add a read-only inspection under CoreRunner's existing input reservation, and use its refusal in the ordinary send path. An empty composer is a provisional observation, not permission to type.

**Authority:** The supplied task explicitly requests a reviewable minimum supplement when the current protocol cannot prove safe input. Prior diagnosis and seven-case isolated reproduction are reused. The earlier code-change prohibition is lifted only for this candidate.

**Tech stack:** Existing TypeScript, Bun, CoreRunner and fake JSON-RPC sockets. No new dependency or schema.

## Design decision

Unconditional `error` input and `force:true` are rejected. A speculative new vendor RPC must not be enabled or advertised. The selected fallback is a read-only `inspectSleepRetry(member)` result that always sets `automaticSend:false`, reports `requires_protocol` only for a stable known sleep candidate, and gives specific refusal codes for invalid observations. The ordinary send path remains fail closed.

## Task 1: Inspection and permanent regression

Files: `server/runner/core.ts`, `tests/core-sleep-retry.test.ts`, this document.

Interface: `CoreRunner.inspectSleepRetry(member: RunnerMember): Promise<CoreSleepRetryInspection>`. Result contains `outcome`, `reason`, `automaticSend:false`, and provisional identity/turn/input epoch only. It must not contain composer text or user data and cannot be supplied as a send authorization.

- [x] Write fake-socket regressions first; retain temporary fixture directories.
- [x] Observe RED for the missing inspection and the missing explicit protocol refusal.
- [x] Check exact Claude sleep status, known matching session/generation/PID, empty conservative composer, and no manual lease, active run, compact/config change, or unresolved dispatch. Recheck after asynchronous reads; refuse state/identity/epoch/screen changes.
- [x] Integrate the inspection into the known-sleep `send` refusal. No new successful write path, no original-error clearing, no new turn-end event.
- [x] Confirm GREEN for normal candidates, wrong errors/provider/identity, drafts/dialogs, races, concurrent calls, read failure and existing idle/done sends; unknown writes remain fenced.
- [x] Run code inspection and relevant core/queue regressions sequentially. Report baseline failures accurately; do not rerun the full suite.
- [x] Review the diff and commit this candidate only. Independent review and live retry belong to the coordinator.

## Review focus

- An error that becomes idle during inspection is refused in that inspection; later ordinary delivery must independently reevaluate it.
- Old sleep errors must not become successful turn-end events.
- Changing a native-session label without changing PID is still an identity conflict.
- A partial, ANSI, whitespace, placeholder, or dialog composer cannot establish an empty input.
- Read-only errors and concurrent resume cannot authorize a write; accepted/ambiguous existing writes remain fenced.

## Verification and live handoff

RED/GREEN: `bun test tests/core-sleep-retry.test.ts`.
Code inspection: `bun run typecheck`.
Related regression: core runner, delivery recovery/evidence, and delivery HTTP tests, with fixture cleanup redirected to retained temporary directories.

Before any future actual error retry, a separately reviewed execution-layer contract must atomically compare expected owner/session/generation/PID/turn, current error and empty composer at the write boundary; honor human-input/approval fences; and deduplicate a durable dispatch identity with a retrievable receipt after response loss. Current generation 1 has none of this contract. Until then this candidate intentionally writes nothing from error.

After review, apply only through an approved integration/handover; retain existing terminal identities and queued items. Verify w1's existing real follow-up once, correlate CLI receipt and execution input timestamp, then do w3. Do not run original UI work or full tests again. A source-only rollback restores the prior refusal; it must never replay deliveries or replace a conversation.

## Execution record

Pre-flight: no shared interfaces with the separate harness worktree. Base main and live source are both `122bf7878b7cb708ad20932908f868daaae67ed1` at inspection.
Ruling: keep the current protocol fail closed and deliver an inspection candidate, as expressly allowed by the supplied task. Cost: this commit alone cannot restore real input.
Ruling: preserve temporary directories and perform author review sequentially; the coordinator supplies the independent review before integration.

RED: 1 pass / 13 fail, because `inspectSleepRetry` did not exist. GREEN: 15 pass / 0 fail after adding the in-memory queue case. Its initial fixture conflict was a mismatched fake cwd and was corrected without changing production code.
Code inspection: `bun run typecheck` exited 0.
Related suite: 213 pass / 0 fail across `core-sleep-retry`, `core-runner`, `delivery-recovery`, `delivery-evidence`, and `delivery-http` tests. These are scoped results, not a claim about the historical full suite.
The first related run had 124 cleanup-instrumentation failures; the local preload initially recognized only `/tmp` fixture paths. The corrected preload records each newly created fixture root and moves only its owned paths to a retained directory. Final scoped tests pass with product assertions unchanged.

Author review: the only production change is the read-only inspection and a more explicit known-sleep refusal in `CoreRunner.send`. There is no new write RPC, server harness change, database change, dependency update, or capability guess. The ordinary queue's existing bounded retry policy is unchanged; `retryable:false` on the inspection refusal does not by itself change that policy. Existing idle/done writes keep their original behavior.
Independent review: pending with the coordinator. Actual error retry and CLI receipt remain unverified and blocked on an execution-layer contract.
