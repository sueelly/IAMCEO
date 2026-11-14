# Codex execution evidence: baseline diagnosis, not a product fix

Task `tk_6NzefaUS0u6g`, contract r1. Base main `ffaa6328e6fe806d7df0b9290fb25d70fb8cc708`.

## Verified real input and limit

The supplied secretary report `msg_bFbkt91oAGj0` and its original record `f_u51RDRAPyjkg` contain a native `functions.exec → tools.exec_command` invocation: `git rev-parse HEAD`, cwd `/Users/kimhyejoo/Projects/00_Ing/IAMCEO`, exit 0, stdout equal to the base commit, chunk `0be0f2`. The contract timestamp is `2026-11-14T16:38:19.938Z`. The invocation was after contract review and before `16:41:22Z`; its exact timestamp is not available. The rejected post at `16:42:14.676Z` combined execution-not-found and an unread README claim. This is not an isolated successful source-blocking test.

Official `post(report_id)`, `task_trace`, and `server_check` expose no selected native session, raw event shape, invocation ID, or numeric result pair for that specific invocation. Other staff's matched executions are comparison clues, not this execution's evidence. No live database, provider transcript, credentials or other conversations were opened for this diagnosis.

## Current server path

1. `Orchestrator.contextLog`: select exactly one Codex rollout by current registered native session and exact metadata cwd.
2. `readProviderEvidence/readLog`: guarded path read, newest 192 MiB, drop a partial leading line.
3. `parseCodexLog`: recognize timestamped `event_msg/item_completed/CommandExecution` and `McpToolCall`. Unrecognized shapes are ignored, not promoted to success.
4. `matchExecChecks`: exact shell command proof, known matching execution cwd, latest completion with numeric exit 0, and no reuse by another task.
5. `recordPost`: combine execution and source-claim refusals before storing completion.

Under this source, `log_not_found` would produce a different error from the supplied command-not-found response. The latter narrows the stage to absence of a qualifying command proof, but cannot identify whether the relevant event was outside the read range/time filter, unsupported, absent from the chosen resumed log, or had missing/different command/cwd fields. This is a code-path inference, not an inspection of the real event or a proof of the running binary's commit.

## Permanent isolated baseline

`tests/harness-codex-exec-diagnostics.test.ts` uses explicitly synthetic fixture records and the real `post`/`task_trace` processing path. It does not inject evidence into live staff logs and does not claim to reproduce the secretary's unknown event shape.

The supplied command/cwd/exit fields are accepted when represented by a supported Codex event. Different session, metadata cwd, execution cwd, missing execution cwd, old contract timestamp, nonzero or unfinished result, command only in stdout, and a hypothetical unsupported event all reject. Later failure and cross-task reuse also reject. The raw isolated responses retain `syntheticOnly:true` and `liveSecretaryEventRead:false`.

Results: 13 behavior tests pass; typecheck exits 0; 127 tests across the eight relevant harness files pass with zero failures. The regression includes Claude exit interpretation, correction inheritance, literal command preservation, source observation, and credential redaction. Temporary fixture paths are retained by a local preload that moves only paths newly created by the test process.

Commands executed after this contract:

```sh
cd /Users/kimhyejoo/Projects/00_Ing/IAMCEO/.pumasi/worktrees/codex-exec-evidence-20261115 && bun test --preload ./.pumasi/evidence/retain-preload.ts tests/harness-codex-exec-diagnostics.test.ts
cd /Users/kimhyejoo/Projects/00_Ing/IAMCEO/.pumasi/worktrees/codex-exec-evidence-20261115 && bun run typecheck
cd /Users/kimhyejoo/Projects/00_Ing/IAMCEO/.pumasi/worktrees/codex-exec-evidence-20261115 && bun test --preload ./.pumasi/evidence/retain-preload.ts tests/harness-codex-exec-diagnostics.test.ts tests/harness-exit-status.test.ts tests/harness-completion-corrections.test.ts tests/harness-review.test.ts tests/harness-defaults.test.ts tests/harness-residual.test.ts tests/harness-auth-boundary.test.ts tests/harness.test.ts
```

## Required server-owned minimum diagnostic

For this one command in the secretary's current registered session, the server needs to return only: selection outcome and same-session flag; contract revision/time; selected log read-range/truncation outcome; relevant top-level/payload/item event kinds; command/cwd metadata in command position; invocation/result IDs and their pairing; event timestamp if actually present; completion status and numeric exit code. Limit results to the exact requested command or an explicit unsupported-wrapper indicator. Do not return full provider records, arbitrary commands, conversation text, stdout, credentials, or log paths.

At-failure diagnostics should distinguish session selection, unreadable range, omitted/unsupported events, before-contract filtering, unknown/wrong cwd, command mismatch, incomplete result, failure, and cross-task reuse. A later rescan alone does not establish which bytes were visible at the original rejection time.

This is a concrete next diagnostic scope, not an implemented API or an instruction to bypass authentication. After it identifies the actual event, either provide a verified usage correction or implement support for that observed call/result shape only, retaining all current boundaries. Shell `sed/rg` source reads remain separate from the currently supported `Read/WebFetch` source observation; no fake Read event or weaker source rule is proposed.

## Status

No product/runtime/database/configuration/permission change. The test and this note freeze the baseline only. Criterion 1 and real-case before/after acceptance remain unverified; actual secretary revalidation, independent review, merge, deployment and the unrelated environment-file decision are later stages. Report blocked with these limits, not complete.
