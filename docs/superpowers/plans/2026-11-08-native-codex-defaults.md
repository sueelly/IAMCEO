# Native Codex Defaults Implementation Plan

> **For agentic workers:** Execute inline under superpowers:executing-plans; the parent agent reviews the completed branch.

**Goal:** New projects and headquarters use Codex; new workers inherit the selected chief provider while explicit Claude and historical sessions remain intact.

**Architecture:** Set defaults at application creation boundaries, leaving historical migrations unchanged. Return the stored chief provider so native and legacy web creation forms can match server inheritance before a conductor exists.

**Tech Stack:** Bun, SQLite, TypeScript, React, SwiftUI.

**Spec:** User request to switch IAMCEO to Codex on separate main and native-redesign branches; native branch scope is recorded here.

## Constraints and review focus

- No model changes, global configuration writes, live runtime launches, real agent spawning, or pushes.
- Historical missing CLI fields and SQL migration defaults still mean Claude.
- Explicit worker CLI wins over conductor CLI, which wins over stored chief CLI.
- A stored Claude project with no conductor must offer Claude for new workers.
- Model validation must use the resolved worker provider.
- Full Swift builds may be blocked by existing SDK/API incompatibilities; do not expand scope to fix them.

### Task 1: Server defaults and compatibility

- [x] Add focused creation/inheritance/MCP/migration tests in `tests/provider-defaults.test.ts`; observe four expected failures before implementation, then seven passes.
- [x] Update `server/store.ts`, `server/orchestrator.ts`, and `server/agent-tools.ts`; expose optional `Project.chiefCli` in `shared/types.ts` and document it in `docs/spec.md`.
- [x] Run focused tests using fixture-owned homes, fake in-memory runner, and isolated socket paths.
- [x] Audit existing-session registration: reproduce wrong-provider failures in HTTP join and herdr adoption tests, explicitly preserve Claude at those boundaries, then pass both regressions.

### Task 2: Creation forms and verification

- [x] Update native `SettingsView.swift`, `TeamView.swift`, `AppStore.swift`, and `Models.swift` to use Codex for new projects and resolved chief CLI for new workers.
- [x] Update legacy web `NewProject.tsx` and `Team.tsx` creation defaults; preserve historical decode/resume fallbacks.
- [x] Run TypeScript checks and 312 safe focused tests across provider/store/model/migration/runner/MCP/HTTP/orchestrator paths (nine explicit test files).
- [x] Compile and execute `scripts/check-native-provider-defaults.swift` with `Models.swift`: missing inheritance property RED, then decoding/stored-choice/conductor/root checks GREEN. Modified Swift files pass syntax parsing.
- [x] Attempt full native build: existing CLT SDK cannot compile `Glass`, `glassEffect`, `safeAreaBar`, and `@Entry`; the build also reports a compiler crash. Stop the owned build after collecting these errors (exit 143). Foundation-only model verification remains runnable without XCTest/Xcode.
- [x] Review the diff, record limitations, and prepare the commit on `codex/native-codex`; parent agent performs the independent branch review.

Ruling: Keep historical SQL defaults unchanged and write Codex only at creation boundaries, so reopening or migrating existing data never reinterprets a Claude session.

Ruling: Legacy `/agent/join` and herdr adoption are known-Claude contracts, so explicitly label their existing sessions Claude instead of applying defaults intended for newly spawned workers.

Ruling: Leave SDK compatibility outside this provider change; independent Foundation-only checks verify the new native model logic, while full application compilation requires a compatible Xcode/SDK.
