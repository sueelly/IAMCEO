# Storage optimization validation

This document records the pre-rollout validation. The storage changes preserve the already-running pagination source `5fe3fb7` and the subsequent startup improvement `eaa12a7`. Pagination remains schema v34; storage optimization follows it as v35. Shared main is not changed.

## Passing checks

- 270 focused storage, API, migration, replay, file paging/cache and compatibility tests passed across 14 files.
- 41 diagnostic-query tests passed after updating the former two-row receipt expectation to one completed row. Sensitive-value assertions inspect decompressed content.
- 7 Chromium file-list/detail/mobile/race tests passed in an independent run. These exercise large bodies stored as compressed BLOBs.
- The final storage/migration follow-up passed 36 tests, including collision rejection; the isolated maintenance CLI then passed all 6 maintenance tests with unchanged-file verification on a conflicting schema layout.
- TypeScript checking and the compiled Bun executable build passed after the schema-layout guard was added.
- Independent code review reported no Critical or Minor findings. Its two Important findings (invalid legacy-pair folding and concurrent schema numbering) were reproduced with failing regressions and fixed. The merged read/write/cache boundaries were checked separately.

The synthetic existing database shrank from **4,227,072 to 708,608 bytes** with explicit compaction. File text/HTML, replay responses, other table contents and an unanswered approval were preserved. No backup was created in that maintenance fixture.

## Repository-wide limits

The integrated repository-wide run reported **2,176 passed and 36 failed across 112 files**. It is not a green suite. Failures include existing fake-provider fixture path isolation, legacy fake-socket/test-mode assumptions, WebSocket close-code expectations, model-catalog validation and browser timing/cleanup cases. The earlier untouched-main run also failed (2,109 passed, 42 failed); this is evidence of baseline problems, not proof that every current failure is identical.

The file-paging wrapper's seven assertions passed in the large run, but its afterAll cleanup exceeded the hook deadline. Its independent run passed completely. A terminal-control timing case also passed independently on both the previous live source and the integrated branch. The new receipt-count expectation was repaired and its entire 41-test file rerun successfully.

The broad run began before the final schema-layout hardening; that hardening and the updated diagnostic/CLI checks were verified in fresh targeted processes afterward. No claim is made that the final head passes every repository test.

## Runtime application

Before rollout authorization, production checks were read-only inspection and in-memory transformation/fingerprint calculations. No runtime migration, VACUUM, new production backup, service restart, approval response or main integration was performed at that stage.

The user subsequently authorized the runtime migration and service update. Preparation preserves startup source `eaa12a7`, uses the running service's pinned Bun 1.3.14, and checks core detachment/reattachment without stopping its CLI holders. The storage/API/migration/lifecycle checks passed 134 tests; the additional core/bridge/state/maintenance checks passed 134 tests. Actual activation, measurements and runtime identities belong in the private operational receipt and release manifest, never source Git. The no-backup offline command and release compatibility requirements are in [storage-optimization.md](storage-optimization.md).
