# Web Performance Implementation Plan

> **For agentic workers:** Use test-driven implementation, with independent web state work and a final code review under superpowers:requesting-code-review.

**Goal:** Reduce current web/server duplicate work without changing observable domain or write behavior.

**Architecture:** Request-local delivery data reuse, a bounded short-lived compact-response cache, and structural sharing at web snapshot acceptance.

**Tech Stack:** Existing Bun/SQLite/TypeScript, React and Playwright. No new dependencies or schema migrations.

**Spec:** `docs/superpowers/specs/2026-11-17-web-performance-design.md`

## Global Constraints

- Work only in this task's isolated Mini worktree. Preserve concurrent work and native source.
- Preserve paging, gzip, managed terminal addresses, delivery/recovery policy and authenticated write protection.
- Keep runtime records and credentials outside Git. Push verified task commits and verify remote SHA.
- Reconcile with the latest active service source before deploying; preserve worker terminal/session identities.

## Review Focus

- Cached domain reads must not survive a request or change recovery/approval decisions.
- Failed/orphan messages and message previews must match existing behavior without hydrating unrelated history. The orphan predicate may scan the selected project’s index range; no schema/index migration is included.
- Cache keys must include database state and request-specific connection information, not just event sequence.
- Time-dependent values and Unicode cache entries must respect TTL and byte limits.
- Structural sharing must not hide status changes, new fields, message overlays or reordered lists.

### Task 1: Delivery read batching

**Files:** `server/store.ts`, `server/delivery-recovery.ts`, `tests/delivery-read-cost.test.ts`.
**Interfaces:** `withDeliveryRead(projectId, read)`, bulk notice source lookup and orphan-failure lookup; existing notice JSON contracts remain identical.

- [x] Add query-count, semantic parity, orphan/preview and scope cleanup regressions; run RED on the base.
- [x] Implement bounded synchronous request-local reuse and targeted failed-message reads, changing no mutation paths.
- [x] Run delivery/store/HTTP/recovery regressions, record before/after query counts and commit verified files.

### Task 2: Compact sync response reuse

**Files:** new `server/sync-snapshot-cache.ts`, `server/http.ts`, new cache unit/integration tests.
**Interfaces:** cache `get(key): string | undefined`, `set(key, value): void`; 250ms TTL /32 entries /8MiB default limits.

- [x] Write failing real HTTP tests for repeated compact construction and invalidation after database/Host/config changes; write TTL/LRU/Unicode limit tests.
- [x] Cache only successful compact sync bytes after authorization, partitioned by actual public response inputs and SQLite total changes/data version.
- [x] Run HTTP/realtime/connection/auth/paging/compression regressions and commit verified files.

### Task 3: Stable web state references

**Files:** new `web/src/lib/structural-sharing.ts`, `web/src/lib/store.ts`, `web/src/screens/{Home,Settings,Team}.tsx`, focused structural-sharing and store/browser tests. These three consumers previously treated domain-object identity as read completion or optimistic-write ownership; a client-only accepted-snapshot counter keeps that evidence separate.
**Interfaces:** a pure JSON-value reconciliation helper; apply to bootstrap/project/revisions during snapshot acceptance.

- [x] Write tests proving equal snapshot identity, isolated status updates without revision changes, reordered keyed rows and immutable inputs; observe RED.
- [x] Implement sharing and wire the actual store acceptance path, retaining existing history/revision/generation behavior.
- [x] Run web sync/store/history/submission and browser regressions; typecheck and commit verified files.

### Task 4: Review, integration and service verification

- [ ] Run required cross-component checks and the project suite in an isolated home. Compare any known failures with the immutable base.
- [x] Request one independent final review; fix consequential findings with RED→GREEN coverage.
- [ ] Verify a fixed Git build and push the task branch; compare local and remote SHA.
- [x] Integrate any newer deployed source in this worktree before deployment and rerun affected checks.
- [ ] Deploy using the existing supervisor, preserve worker PID/session/approval identities, verify actual Tailscale flow and report measured gains and remaining limits.

## Evidence before final integration

- Delivery fixture, 40 → 240 queued rows: before 285 → 1,685 SQL reads; after 8 → 8. Source-preview EXPLAIN uses the referenced source primary key rather than scanning its table. The orphan query still examines the selected project’s message index range.
- Eight concurrent identical compact HTTP reads build project state once. Direct SQLite changes, another SQLite connection, event-only cursor changes, Host/config changes, auth rotation and expiry have passing regressions. Legacy reads remain uncached.
- Server focused set: 110 pass; HTTP/auth/realtime/connection/history/paging set: 105 pass.
- Before merging the concurrent startup change: unit aggregate 2,176 pass /26 fail across112 files. All26 failure signatures match immutable base7b3f290 in harness-defaults/herdr. The aggregate browser wrapper did not complete within90 seconds; owned test processes were stopped and focused real-browser coverage is run separately.
- During implementation the active release advanced from5fe3fb7 to eaa12a7. Final integration must preserve that startup/runtime-diagnosis and asset-compression change and reverify the combined source.

## Integrated-source checks

- Integrated exact active startup release eaa12a7, preserving its deferred runtime diagnostics and JS/CSS compression.
- Combined focused test:56 pass; combined real-browser checks:10 web-state scenarios and8 paging/startup scenarios pass. TypeScript and diff whitespace checks pass.
- Independent final review: no Critical or Important findings; the indexed orphan-history scan remains documented. Full unit aggregate is rerun on the combined source.
- Build, activation, remote-SHA and live-state evidence are recorded outside source Git in the task-owned runtime directory and immutable release manifest. These checkboxes describe planned actions, not service activation receipts.

## Concurrent storage rollout compatibility

During activation, another authorized task migrated the shared live database fromv34 to v35. The v34 candidate correctly refused to open it. HTTP was restored using the already-built v35-compatible storage releaseb92f225; the optimization branch then integrated that exact source. The web optimization itself adds no database schema or compression format. There was no database downgrade, restore or repeat VACUUM. Final activation must verify the actual database version as well as the current service executable before replacement, and verify existing terminal/member identities afterward.
