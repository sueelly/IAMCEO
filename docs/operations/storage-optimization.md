# SQLite storage optimization

Schema v34 consolidates asynchronous agent reservations and results into one receipt. `state = reserved` means the outcome is not confirmed; `completed` means the result (including an explicit tool error) is recorded. Interrupted reservations are never automatically executed again. Request identity still includes project, member, tool and exact canonical arguments.

Successful report lookups store response metadata and references to their original file bodies/HTML. Replay resolves those originals under the same project and applies the existing public redaction. Missing or foreign material fails closed. Legacy snapshots that cannot be matched exactly are retained rather than discarded.

Large file bodies, HTML and receipt JSON use a versioned gzip BLOB envelope when it saves space. Small values and legacy records remain TEXT. Use Store APIs to read these columns; direct `JSON.parse(result_json)` and assumptions that `files.body` is always TEXT are no longer valid. The encoding is lossless compression, not encryption.

## Read-only inspection

Run on the Mac mini from this source checkout. Supply the actual data home explicitly:

```sh
bun scripts/optimize-storage.ts --home /absolute/data/home --inspect
```

This reports schema version, file/allocated/free bytes and row counts. It does not migrate, compress, compact or create a backup. It can inspect a live database.

## Apply to an offline home

First prepare and verify the v34-compatible application release. Wait for a safe service handoff; do not terminate active employee runs, respond to approvals or discard sessions to make the home available. Main integration and release activation require the applicable repository authorization.

```sh
bun scripts/optimize-storage.ts --home /absolute/data/home --apply --vacuum
```

`--apply` explicitly uses `migrationBackup: false`, as requested for this task. It never creates a pre-migration backup. The standard `openDb` backup default remains unchanged for other callers.

The tool acquires the same exclusive home lock as the service and refuses if the home is in use. It accepts supported schema v33 or later. Before opening a writable connection it checks integrity, foreign keys and logical content fingerprints. Migration validates the original files and normalized receipt results inside its transaction; a mismatch rolls back both changes and the schema version.

After migration the tool checks every unaffected table's logical contents as well. `--vacuum` explicitly reclaims allocated space; without it, freed pages remain available for reuse inside the database. Integrity/content checks run again after compaction. Final JSON contains only measurements, counts and `verified: true`; content and credentials are not printed. Repeating the command is safe and does not execute agent work.

Activate the prepared compatible release afterward and check file rendering, report lookup, receipt replay and service health. Older application binaries do not support schema v34; do not reactivate one against an upgraded home.
