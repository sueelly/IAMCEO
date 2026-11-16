# Session and queue recovery implementation plan

**Goal:** Restore queued work and safe session retries while preserving native conversations and uncertain writes.

**Evidence:** A preflight terminal.list timeout left the start journal unknown before terminal.run; a completed Claude compact boundary was ignored because the native CLI changed into its worktree. The old cursor already advanced beyond that boundary. The live global concurrency limit is four; actual ongoing turns must retain their slots.

## Tasks

- [x] Reproduce preflight failure, legacy recovery and real unknown-run fencing in the isolated lifecycle fixture. Mark pre-launch read failures as not written; reconcile only the legacy list preflight failure after verified owner absence. Resume the same conversation.
- [x] Reproduce Claude compaction in a different cwd and an exhausted legacy cursor. Recognize the boundary in the bound session/file, retain generation/terminal/session/model/error and sidechain guards, version the cursor and replay old cursors once.
- [x] Run lifecycle, parser, runner/context and queue admission checks plus typecheck, review the patch, then restart only the web daemon to load it. Validate that holders and native IDs survive, the known compact resolves, and the failed member resumes from its saved native conversation.

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

## Live recovery and remaining query bottleneck

- f9b5817 deployed on 8443: all 18 preexisting holders and 23 native conversations preserved; pending lifecycle journals became zero; failed staff resumed the same conversation; completed compact recognized; three new elite-staff deliveries received.
- Default concurrency four was saturated by real work. Runtime setting raised to five through revision-checked API (response timed out, durable value read back; no write retry). God-of-the-world conductor and the recovered staff both observed working with queued reports/instructions delivered.
- CPU/I/O load still caused web watchdog restarts. Native sample showed SQLite overflow reads. Offline SQL profiling found repeated file bodies (5.48M characters) dominating snapshots. Metadata-only SQL still followed content overflow chains with the old index.
- Added a bounded 16MiB/1024-entry body LRU (bodies are insert-only; metadata is always read fresh) plus v33 covering index and explicit INDEXED BY. Body-cache and actual-query-plan tests observed RED -> GREEN. Independent source review found no Critical/Important blockers.
- Same public FileDoc response verified by SHA-256 on a private database copy. Repeated old reads 6.65-10.15ms; indexed/cache reads 0.55-0.81ms. Related isolated tests 72/72, migration/backup tests 50/50, typecheck passes. No UI/API payload fields or sort semantics changed.
- Retain the automatic pre-v33 migration backup: a v32 binary cannot directly reopen v33. Large projects beyond LRU capacity may reread bodies, while memory stays bounded. Full live liveness verification follows deployment.

## Registered Codex metadata scan

- Temporary live SQL timing was removed after use; steady-state reads totaled ~127ms/5s while HTTP still stalled. Direct localhost and tailnet probes delayed together, ruling out proxy routing.
- contextLog enumerated 537 Codex rollouts and parsed up to 1MiB of each to inspect only the first session_meta record (376MiB per lookup). A real read-only lookup blocked 5239ms.
- Added optional maxRecords to readJsonlRange, preserving actual byte accounting and resumable exact offsets after read-ahead. Only the three session-header consumers request one record; exhaustive candidate matching, native nonce discovery and full delivery evidence scans keep their prior rules.
- Stop/resume, long partial UTF-8 header and invalid record-budget regressions RED -> GREEN. Related caller/parser/context/diagnostic tests 103/103; typecheck passes; independent review found no Critical/Important blockers. Same real lookup found the registered session in 234ms.
