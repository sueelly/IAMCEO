# Session and queue recovery implementation plan

**Goal:** Restore queued work and safe session retries while preserving native conversations and uncertain writes.

**Evidence:** A preflight terminal.list timeout left the start journal unknown before terminal.run; a completed Claude compact boundary was ignored because the native CLI changed into its worktree. The old cursor already advanced beyond that boundary. The live global concurrency limit is four; actual ongoing turns must retain their slots.

## Tasks

- [x] Reproduce preflight failure, legacy recovery and real unknown-run fencing in the isolated lifecycle fixture. Mark pre-launch read failures as not written; reconcile only the legacy list preflight failure after verified owner absence. Resume the same conversation.
- [x] Reproduce Claude compaction in a different cwd and an exhausted legacy cursor. Recognize the boundary in the bound session/file, retain generation/terminal/session/model/error and sidechain guards, version the cursor and replay old cursors once.
- [ ] Run lifecycle, parser, runner/context and queue admission checks plus typecheck, review the patch, then restart only the web daemon to load it. Validate that holders and native IDs survive, the known compact resolves, and the failed member resumes from its saved native conversation.

## Review focus

- No terminal.run replay after an ambiguous terminal.run result.
- No absence inferred from a failed list/hello or an ownership conflict.
- No compact success from idle, screen text, old boundaries or another native session.
- Old parser cursors must be replayed with bounded incremental reads.
- Preserve manual leases, input drafts, queues and running provider processes.

## Verification scope

Use isolated provider/core fixtures. Avoid the full legacy suite on the live host because it starts real CLI/browser processes and competing workers are already running full browser suites. Report any failures and do not claim a green full suite.

## Verification and review record

- Five new regression cases RED -> GREEN; context/parser suites 34/34 pass; TypeScript check passes.
- Broader four-file runs show sub-150ms fixture timing failures under concurrent real browser workload (167/173, then 169/174, then 173/174). Unmodified c4ec15a baseline four-file run passed 169/169. This is not a claim of a green full suite. Full outputs: /private/tmp/iamceo-queue-tests-20261116*.log.
- Independent review found a race where resolving the legacy fence before awaiting a null-terminal read could overwrite a concurrent fresh generation. A delayed RPC/concurrent fresh-session regression reproduced it; recovery is now synchronous for null-pane, no-run, empty-delivery preflight absence. RED -> GREEN.
- No actual terminal.run uncertainty is auto-cleared. No idle-only compact success is inferred. No concurrency limit increase or provider interruption.
