# Storage optimization

The user approved all three optimizations on 2026-11-17: update a reservation into its result in one row, retrieve report material from its original record, and compress large text losslessly. This is implementation authorization; no additional design approval is needed for these choices. No new backup is requested. Runtime deployment and main integration remain separate from the authorized branch push.

## Behavior

- An asynchronous agent operation has one receipt, with `state` equal to `reserved` or `completed`. Reserve and commit before executing; overwrite its result and state on completion. A completed error result is still completed. An interrupted reservation never automatically repeats its effects. Same-ID requests must still match member, project, tool, and canonical arguments. Concurrent identical calls share their running promise.
- Keep synchronous `Store.agentOperation` for durable observations, using the same completed receipt schema.
- Successful `post({report_id})` results store report metadata and file IDs, not copies of file body/HTML. On replay, resolve the original project's immutable file body/HTML and apply the existing public redaction. Missing or foreign files fail closed, without rerunning an operation. Other tool results and error results retain their full response.
- Files and receipt request/result columns may contain legacy TEXT or a versioned compressed BLOB. New large UTF-8 strings are compressed only if smaller; small/incompressible values stay TEXT. Decode errors fail explicitly. Exact text, including Korean, emoji, NUL and normalization, must survive a DB reopen. No provider/account/token changes.
- A transactional migration folds valid legacy `agent-result:<id>` rows into their matching reservation, preserves unpaired/invalid pairs conservatively, removes redundant report material only when matching the current immutable original, and compresses existing file/receipt content. Reopen is idempotent. Corruption or migration failure rolls back data and schema version.
- Preserve ordinary migration backup defaults for other callers, but provide an explicit `migrationBackup: false` option for this user's approved no-backup maintenance. No new backup is made by the optimization tool. Never alter a running production DB from this development session.
- Provide offline maintenance with the existing exclusive data-home ownership guard, dry-run inspection, content verification and explicit compaction. Refuse while the service owns the home. Do not stop sessions or approve pending work. DB file reclamation is a separate explicit `VACUUM`, after logical optimization and validation.

## Approach

The chosen design updates one row with explicit state, rather than retaining two immutable receipts or inferring completion from a result shape. It supports later states without changing operation identity. Versioned lossless BLOB encoding avoids base64 expansion and leaves existing public APIs unchanged. Report reference results keep metadata snapshots and hydrate only large immutable material; replacing every result with a fresh tool execution would risk duplicate writes and lose replay semantics.

## Implementation boundaries

`stored-text.ts` owns encoding. `agent-receipts.ts` owns canonical request matching, report result compaction/hydration and migration helpers. `db.ts` owns versioned schema migration. `Store` and `Orchestrator` own transactional reservation/completion and existing APIs. A standalone maintenance script owns offline inspection, verification and file-space reclamation.

## Acceptance and verification

Regression tests cover reservation/completion/error/restart/concurrent retry and conflicting IDs, legacy paired/orphan/mismatched receipts and rollback, material hydration/redaction/project isolation, and codec corruption/legacy/mixed-format/reopen. A synthetic existing database proves measurable size reduction after explicit compaction while preserving all logical content. Run focused tests, the full Bun suite, TypeScript check and compiled build. Review the whole branch independently, commit tested changes, push to origin and verify remote HEAD. Production data stays untouched until the concrete release and maintenance operation are authorized.
