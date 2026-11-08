# Codex migration implementation plan

Goal: maintain independent `codex/main-codex` and `codex/native-codex` branches, with Codex as the default engine for new headquarters, chiefs and workers. Preserve each branch's existing UI and existing Claude session identity. User explicitly requested both branch variants and a shared user-chosen access code for local trial servers.

Design: the main branch retains its headless lifecycle and receives a Codex JSONL adapter, invocation-scoped instructions and stdio MCP configuration. Codex owns session IDs: capture thread.started and resume that exact ID. Existing Claude runners remain available. The native branch already supports Codex via herdr-core; change new-session and UI defaults while preserving historical Claude data.

1. Main adapter: test fresh and resumed IDs, stdin, MCP environment token handling, output/error/interrupt lifecycle; implement a Codex adapter integrated with the existing headless lifecycle.
2. Main defaults: select provider through server configuration, default new production sessions to Codex, retain explicit Claude; expose provider in bootstrap and UI; no Claude-only compact/parallel commands for Codex.
3. Native defaults: default new projects/workers/UI to Codex, inherit an explicitly chosen provider, preserve stored Claude sessions; focused regressions and TypeScript validation.
4. Run isolated mock checks, typechecks and safe regression suites. Start separate trial homes, the shared access code, different ports. Verify actual Codex message and MCP result in the main path and herdr-core path; preserve old trial home for rollback.
5. Review diffs and commit each branch. Report native SDK/build limits separately from backend verification.

Constraints: no changes to ~/.codex configuration or authentication; no use of production port 7878, live IAMCEO home or global herdr socket. No merges or pushes. Runtime data lives outside the repositories.

Validation so far: main adapter/default/UI tests and existing Claude regression checks passed; TypeScript and standalone binary build passed. Actual Codex MCP status/file/post and same-session resume passed on isolated data; native core Codex status/file/post passed. Full native app build remains blocked by the installed SDK. A separate read-only reviewer checks both branches before completion.

Final verification: 430 tests / 16 explicit safe files passed (herdr integration and browser wrapper excluded); TypeScript and compiled CLI build pass. Independent review found three main-branch compatibility issues: shared Claude ranks, saved herdr display, and default-only CLI health. Regression tests reproduced rank/health failures before fixes, and Codex ranks/provider health/backend display now remain distinct. Native safe suite: 312 passing, plus Swift syntax and Foundation model checks. Main and native trial servers, with isolated homes, both retain their Codex session after daemon restart and report through MCP. Native SDK build limitations remain disclosed. Keep both named branches and managed worktrees as requested; no merges or pushes.
