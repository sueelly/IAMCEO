# Web native behavior parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Bring native synchronization and submission safeguards to the existing Codex web UI.

**Architecture:** Reuse /api/sync, realtime v2, message cursors and strict writes; add browser-safe realtime authentication. Independent sync/history and composer reliability changes have disjoint file ownership and are integrated with the shared API by the root implementer.

**Tech Stack:** Bun, TypeScript, React, existing SQLite server.

**Spec:** docs/superpowers/specs/2026-11-09-web-native-parity-design.md

## Global Constraints
- Existing web layout and core runner retained; 7879 unchanged.
- First history page 200, previous 100; coalesce 250 ms, snapshots <=2/s, one read in flight.
- Visibility pauses communication; restore in a new generation. Backoff <=30 seconds.
- Persist immutable submission before network; reconcile the same ID; never clear later edits.
- Only isolated fixture tests. No production state or real CLI runs. Back up before trial restart.

## Review Focus
- Late responses after logout/project switch cannot mutate another view.
- A hidden tab cannot restart its socket from an in-flight completion.
- Same-timestamp message boundaries and >200-message gaps retain every row.
- A lost acknowledgement followed by reload/edit cannot send a duplicate or erase a newer draft.
- Browser cookie authenticates only realtime, is revoked on code rotation and cannot be supplied cross-origin.

### Task 1: Browser v2 transport and reviewed write API
**Files:** server/http.ts, shared/operations.ts, web/src/lib/api.ts, tests/http.test.ts, new API tests.
**Interfaces:** api.capabilities(), api.realtimeSession(), api.sync(projectId), api.message(id), api.messagePage(projectId, options), wsUrl(protocol?:1|2); v2 request helpers accept reviewed revisions.
- [x] Write/run failing realtime-cookie separation, missing-auth, cross-origin, v1/v2 and logout/rotation tests.
- [x] Add a separate HttpOnly SameSite=Strict /ws cookie issued through Bearer-authenticated POST /api/realtime-session; remove via DELETE; advertise browserRealtime capability. No cookie access to API/files/agent routes.
- [x] Add API methods and optional AbortSignal support; preserve old signatures and strict failure semantics.
- [x] Run HTTP/API tests and typecheck; inspect results.

### Task 2: Synchronization and cursor history
**Files:** web/src/lib/store.ts, new focused synchronization/history modules and tests. Own no api.ts or Composer.tsx.
**Interfaces:** Task 1 transport methods; existing store exports remain compatible. Expose current SyncRevisions/capability state for strict-write consumers.
- [x] Write/run failing lifecycle/single-flight/gap/epoch/stale-response/history tests using real coordinators with injected time/network.
- [x] Implement v2 coordinator with explicit legacy fallback, visibility suspension, batched invalidations and cursor validation.
- [x] Implement cursor paging and staged gap bridging; preserve optimistic rows and ordering.
- [x] Run tests and typecheck; report changed files and evidence.

### Task 3: Durable message attempts and attachment recovery
**Files:** web/src/components/Composer.tsx, new web/src/lib/submissions.ts and tests. Own no api.ts or store.ts.
**Interfaces:** existing sendMessage(req,extra), api.message(id), existing localStorage draft keys. Immutable attempts use stable message IDs and host-scoped persistence.
- [x] Write/run failing persistence/reload/lost-ack/edited-draft/logout/upload-result tests.
- [x] Persist attempts before clearing input/network; query pending IDs on reload/reconnect; reuse IDs on explicit retry.
- [x] Reconcile accepted attempts without erasing later draft content/target/uploads. Keep failed or interrupted uploads visible with a meaningful recovery path.
- [x] Run focused tests; report changed files and evidence.

### Task 4: Integration, reviewed conflicts and end-to-end delivery
**Files:** web/src/screens/Inbox.tsx, Settings.tsx, Team.tsx, components/TodoList.tsx if applicable; integration/browser tests, docs.
- [x] Add failing tests for reviewed decision version/revision conflict and writes after newer state arrives.
- [x] Wire strict write helpers at user review boundaries; retain explicit legacy compatibility and no automatic action replay.
- [x] Run typecheck and safe regression suite, build standalone CLI/web bundle, test browser login/socket/visibility/reconnect/history/submission on a fake isolated daemon.
- [x] Request a fresh whole-diff review; fix material findings with regression tests.
- [x] Commit changes, back up 7881 trial, gracefully reconnect its daemon with the same data/config and verify authenticated HTTPS/readiness and preserved core PID/Codex identities. Document actual checks/limits.

## Verification before trial refresh

- `bun run typecheck`: passed on the final source.
- Isolated safe regression: 441 passed, 0 failed, 3618 assertions across 19 files. Real-herdr/full unfiltered suite intentionally excluded.
- Actual headless Chromium mobile viewport: 6 passed, covering a 240-message gap plus a reconnect live-row race, lost acknowledgement+reload without duplicate POST, explicit conflict re-review/save, another tab editing during uncertain send, employee-detail direct send recovery, and access-code rotation preserving draft/attempt.
- Standalone Bun CLI/web bundle compiled and `--version` returned 0.1.0.
- One independent review identified 4 P2 findings; each fixed with RED→GREEN coverage in one fix wave. No deferred minors. Actual iPhone/Safari device behavior is not verified.
- Online SQLite integrity-checked backup and an executable rollback build prepared outside the checkout.

## Trial delivery

Feature commit: `02b54e8` on `codex/native-codex`. The existing 7881 trial was backed up with online SQLite integrity verification, then its HTTP daemon was gracefully reconnected to the same home/config. Schema remains25. All six existing core CLI PIDs and member session/pane identities were preserved; all three projects and existing files remained present. An executable of the previous code was prepared for rollback and was not needed.

Authenticated loopback API and Tailscale HTTPS both returned200. A fresh headless Chromium mobile viewport logged in through the actual HTTPS origin, received the protocol2 WSS hello and rendered the input with zero page errors. This live verification made no model writes. Physical iPhone/Safari acceptance remains unverified. The old 7879 headless comparison stayed unchanged and authenticated successfully.

The independent review's four P2 findings were fixed: page-proven history anchors prevent a reconnect live row concealing a gap; non-destructive session invalidation retains drafts on401; member-detail direct sends use the same durable journal; immutable per-ID attempt records prevent stale tabs overwriting or resurrecting attempts. Fresh reproductions and the final safe suite/browser flows passed. No deferred minors.

Implementation decisions: keep the two requested branch variants separate; use a separate test browser because the configured browser plugin service could not load; reconnect only the web daemon while preserving active core holders, accepting a brief API reconnect. These choices were validated as described above. Native UI redesign, push notifications and real-device Safari behavior are outside this change.
