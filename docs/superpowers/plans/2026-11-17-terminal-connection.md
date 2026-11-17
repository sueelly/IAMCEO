# Terminal Connection Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline with test-driven development.

**Goal:** Copy current-server terminal commands from Team and centrally manage SSH overrides.

**Architecture:** The active configuration owns optional SSH settings. HTTP derives an authenticated descriptor per request; one web helper builds local or SSH commands. Copy resolves the descriptor again before writing the clipboard.

**Tech Stack:** Existing Bun/TypeScript, React, Zod and Playwright; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-17-terminal-connection-design.md`

## Global Constraints

- Run only on the Mini in this isolated worktree; preserve all concurrent work.
- Keep access codes, runtime data and deployment receipts outside Git.
- Use the existing atomic config writer and server owner lock.
- Preserve current worker terminal/session identities, inputs and approvals.
- Do not merge to shared main without repository-specific authorization.

## Review Focus

- SSH and remote shell quoting must prevent option/command injection.
- The loopback URL used by a reverse proxy must not replace the incoming Tailnet hostname.
- Clearing one override must preserve other settings and the access code.
- Clipboard permission/user-activation differences must never report stale content as copied.
- Missing bootstrap metadata or a connection lookup failure must not redirect to an old local server.

### Task 1: Managed connection descriptor and copied commands

**Files:** `server/config.ts`, new `server/connections.ts`, `server/http.ts`, `shared/types.ts`, `bin/iamceo.ts`, new `web/src/lib/terminal-command.ts`, `web/src/screens/Team.tsx`, `web/src/lib/api.ts`, and focused tests.

**Interfaces:** `ConnectionInfo { home, port, cli, ssh: { host, user, port } }`; optional `Bootstrap.connection`; authenticated `GET/PATCH /api/connection`; `terminalCommand(member, connection, local)`.

- [ ] Write shell execution and real HTTP regression tests for R1–R5; run and observe missing descriptor/builder failures.
- [ ] Implement config validation, live override lookup, GET/PATCH descriptor and CLI management.
- [ ] Implement local/SSH command generation and fresh-on-copy UI with actionable errors.
- [ ] Run focused HTTP/config/CLI/command tests, typecheck and an isolated real browser clipboard flow. Expected: no failures.
- [ ] Run the project suite with an isolated test home; classify existing failures against the base without changing their expectations.
- [ ] Commit verified source, review the diff independently and push the task branch; verify remote HEAD.
- [ ] Build a fixed Git release, verify it against an isolated fixture, deploy it through the existing supervisor and verify R6 over Tailnet HTTPS.
- [ ] Record fresh validation, deployment SHA and any real remaining limitations.
