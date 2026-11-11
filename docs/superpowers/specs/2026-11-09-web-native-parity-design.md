# Web native behavior parity

The user approved keeping the existing web UI and bringing native synchronization, recovery and submission reliability to the browser. Work is based on codex/native-codex e311445; the old comparison on 7879 is retained.

## Approach
Keep React and reuse the existing v2 server contracts instead of reimplementing the native UI or changing the core runner. A browser-only realtime session cookie enables /ws?v=2 without placing the access code in URLs. The native Bearer path remains valid. Servers without the new browser capability retain explicit legacy handling; transport errors must not silently downgrade an established protocol.

## Behavior
- One synchronization coordinator per tab, single-flight reads, 250 ms invalidation coalescing, at most two snapshots per second. Visibility/pagehide pauses sockets, retries and background reads; visible/pageshow/online starts a new generation and reconciles state. Failed transport backs off to 30 seconds.
- Validate epoch/sequence, heartbeat high-water and snapshot cursor; recover missing events through /api/sync, ignore obsolete project/session responses, and retain visible data on transient failures.
- Cursor-based history, first 200 and earlier 100, binary (at,id) ordering/deduplication; reconnect gaps bridge before replacing history. Failed bridging preserves existing history.
- Persist an immutable message attempt before network/clearing input. Reload/reconnect queries the same message ID; unknown acknowledgement does not create a second ID or erase subsequent text/attachments/targets. Preserve attachment failures instead of silently dropping them.
- Use reviewed decision updatedAt and v2 revisions for supported settings/member/todo writes. Conflicts refresh rather than silently overwrite. No non-idempotent action is automatically replayed.
- Existing layout remains. This does not include SwiftUI redesign, APNs/web push, offline CLI execution, or installing local host services.

## Verification and delivery
Use isolated temporary server homes, fixture sockets and fake CLIs; never unfiltered Bun tests, production port 7878, or the production IAMCEO home. Test recovery races, auth separation/rotation, hidden-tab cancellation, paging ties/gaps, immutable retries and edited-draft preservation. Run typecheck, focused/regression tests and actual browser flow against an isolated fixture. Review the completed diff. Before restarting the existing 7881 trial back up its SQLite/uploads/config and record member/session/core terminal identities. Prefer idle; if core work is active, only gracefully detach/reconnect the HTTP daemon after verifying shutdown never kills terminals, and confirm the same CLI PIDs/session IDs afterward. Preserve projects and access code 1118. HTTPS Tailscale Serve on 8443 continues to proxy it.
