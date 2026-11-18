// Keep independent review verdicts and worker integration receipts on the same immutable report.
export const SELF_INTEGRATION_SCHEMA = `
  ALTER TABLE task_contracts ADD COLUMN main_authority TEXT;
  ALTER TABLE report_harness ADD COLUMN artifact_base TEXT;
  ALTER TABLE task_completion_reviews ADD COLUMN legacy_integration INTEGER NOT NULL DEFAULT 0;
  UPDATE task_completion_reviews SET legacy_integration=1 WHERE reviewed_commit IS NOT NULL AND status='confirmed';
  ALTER TABLE task_completion_reviews ADD COLUMN main_base TEXT;
  ALTER TABLE task_completion_reviews ADD COLUMN main_commit TEXT;
  ALTER TABLE task_completion_reviews ADD COLUMN integration_report_id TEXT REFERENCES messages(id);
  INSERT OR IGNORE INTO completion_changes(task_id)
    SELECT DISTINCT task_id FROM task_completion_reviews WHERE status IN ('pending','confirmed');
`;
