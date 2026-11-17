// Bun has already armed the native parent watcher before preloads execute.
// Keep this server's policy out of the environment forwarded over core RPC:
// provider sessions are owned by core and must outlive an IAMCEO restart.
delete process.env.BUN_FEATURE_FLAG_NO_ORPHANS;
