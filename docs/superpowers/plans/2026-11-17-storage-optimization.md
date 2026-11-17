# Storage Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce SQLite storage without deleting chat/material or weakening duplicate-execution protection.

**Architecture:** One mutable receipt transitions from reserved to completed. Versioned BLOB text compression and reference-only report results preserve the public API. Transactional migration upgrades historical content and an exclusive offline maintenance command verifies and compacts it.

**Tech Stack:** Bun 1.4, TypeScript, bun:sqlite, node:zlib; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-17-storage-optimization-design.md`

## Global Constraints

- Work only in this task's Mac mini worktree. Preserve all other tasks and runtime state.
- User approved the three approaches and delegated the completion-state representation.
- No new backup; normal backup defaults for unrelated callers remain unchanged.
- No automatic production restart, main merge or pending approval response.
- Existing plaintext databases remain readable; corruption is never silently replaced with empty content.

## Review Focus

- A process dies after the effect but before completion: retry must not repeat effects.
- Migrated result rows with mismatched scope/request must not overwrite a reservation.
- Report hydration must retain redaction and reject foreign/missing originals.
- Binary content and repeated reopen must preserve byte-exact logical text.
- Offline maintenance must refuse an active data-home owner and never create a backup implicitly.

### Task 1: Lossless stored text

**Files:** Create `server/stored-text.ts`, `tests/stored-text.test.ts`.

**Interfaces:** `encodeStoredText(text: string): string | Uint8Array`; `decodeStoredText(value: unknown): string`.

- [ ] Add failing tests for exact Unicode/NUL round-trip, legacy/incompressible TEXT, version and corruption rejection, SQLite BLOB round-trip/reopen.
- [ ] Run `bun test tests/stored-text.test.ts`; expected new-code failures.
- [ ] Implement a versioned gzip envelope, 1 KiB compression threshold, 64 MiB maximum compressed-source length, only retaining compression with at least 32 bytes savings. Longer text stays plaintext.
- [ ] Run the focused tests and commit `refactor(storage): add lossless versioned text encoding`.

### Task 2: Receipt state, material references, existing-data migration

**Files:** Create `server/agent-receipts.ts`, `tests/storage-optimization.test.ts`; modify `server/db.ts`, `server/store.ts`, `server/orchestrator.ts`, `tests/agent-operation.test.ts`.

**Interfaces:** Store reservation returns `{ created, state, result }`; completion updates the same operation ID. Existing `agentOperation` remains synchronous. Stored report result kind is explicit and versioned. Canonical request hashes support compressed-request lookup; exact decompressed arguments still determine conflicts.

- [ ] Add and run failing regressions for single-row state transitions/concurrent retry/restart/errors/conflicts, compressed file reads, report hydration/redaction/project boundaries, and paired/orphan/mismatched old receipts plus migration rollback.
- [ ] Add schema state/result-kind/request-hash/update-time columns and one transactional data migration. Fold only valid async pairs. Reserve before external work and finish in the existing row. Keep interrupted calls reserved.
- [ ] Encode/decode file body/HTML and receipt JSON at storage boundaries. Compact only successfully matched report material, preserve its metadata, hydrate originals on replay and apply existing public redaction.
- [ ] Run receipt, optimization, migration, file-list-cache, backup/restore and code-read regressions; expected all pass. Commit `refactor(storage): consolidate receipts and reference report material`.

### Task 3: Offline verification and compaction

**Files:** Create `scripts/optimize-storage.ts`, `tests/storage-maintenance-optimization.test.ts`, operational documentation; modify migration option only as required.

**Interfaces:** Read-only `--inspect`; explicit `--home PATH --apply` with exclusive existing home ownership and `migrationBackup: false`; optional `--vacuum`. Exit nonzero on owned/live home or integrity/content mismatch. Never print content or credentials.

- [ ] Add failing tests for read-only inspect, live-owner refusal, no implicit backup, before/after exact content and lower allocated size on a synthetic historical DB.
- [ ] Implement inspection, exclusive migration, streaming logical content verification and optional explicit VACUUM. Verify integrity and foreign keys; provide JSON counts/bytes only.
- [ ] Run focused maintenance tests, full `bun test tests`, `bun run typecheck`, and `bun run build`; record any baseline failures separately and resolve regressions.
- [ ] Commit `refactor(storage): add verified offline storage compaction`; independent whole-branch review, fix Important findings with RED/GREEN, push branch to origin and compare `git ls-remote` with HEAD.
