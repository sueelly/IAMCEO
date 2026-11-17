# Terminal connections after the Mac mini migration

The Team screen must copy a command that opens the selected member's existing terminal on the current server. The web copy currently omits `IAMCEO_HOME`; a different computer then uses its old local installation. The native helper already pins the home, but the web helper also needs remote SSH transport.

## Requirements and acceptance

- R1. Commands use the current daemon's CLI, data home and actual HTTP port. A1 → R1: execute generated commands against isolated fake CLI/SSH executables and check the exact home, port, member and arguments; the caller's old environment must never win.
- R2. External browsers connect to the server through SSH; loopback browsers keep a local command. A2 → R2: a Tailnet hostname generates an SSH command; loopback IPv4/IPv6 does not. Both attach and provider resume commands run on the same host.
- R3. SSH addresses are managed centrally in the active `config.json.connection`. Host and user default to the current request host and server account, port to 22. A3 → R3: change request hostname or the managed override and verify a new command without a daemon restart. Null values clear overrides.
- R4. Every copy reads the current connection descriptor. A4 → R4: change configuration after opening Team, then click Copy; clipboard and visible command contain the new target. Lookup failure shows an error and never copies the stale command.
- R5. Shell interpolation, SSH options and credentials cannot leak into the command. A5 → R5: exercise spaces, quotes, malicious host/user strings, invalid ports and unauthenticated API access. No access code appears in descriptors or commands.
- R6. Deploy the verified immutable release while preserving existing worker terminal/session identities and pending approvals. A6 → R6: compare pre/post identities, runtime build ID, authenticated HTTPS connection descriptor and Team copy behavior.

## Approach

Hardcoded Mini URLs would fix only today's installation. Reusing local commands with a data-home prefix fixes the wrong configuration but still executes on the caller's computer. Use a shared command builder with a server-provided connection descriptor, current-request hostname discovery, and explicit optional SSH overrides in the existing atomic configuration store. A lightweight authenticated GET/PATCH API and `iamceo connection` command manage those overrides. No new address screen or public DNS dependency is needed.

The host inferred from the request follows the address the user actually opened. Existing pasted commands cannot discover a completely different hostname; copying again resolves the latest settings. Tailscale DNS itself follows IP changes. Overrides remain explicit until cleared with `auto`. SSH credentials stay in the user's SSH configuration. Copying does not start, stop, resume or approve a worker.

Scope is the web Team copy action and its address management. This change does not alter message synchronization performance, worker lifecycle rules or native app UI. Deployment changes only the HTTP supervisor and retains the existing core service and data.
