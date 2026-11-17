// v49. Journal the input of the completion rule in the same transaction as the
// edit. OLD and NEW both matter when a message or a task changes families.
function changes(table: string, columns: string, targets: (row: string) => string): string {
  const keys = columns.split(" ");
  const enqueue = (row: string) => `INSERT INTO completion_changes(task_id)
    SELECT id FROM tasks WHERE id IN (${targets(row)}) ON CONFLICT(task_id) DO NOTHING;`;
  return `CREATE TRIGGER completion_${table}_insert AFTER INSERT ON ${table}
      BEGIN ${enqueue("NEW")} END;
    CREATE TRIGGER completion_${table}_delete AFTER DELETE ON ${table}
      BEGIN ${enqueue("OLD")} END;
    CREATE TRIGGER completion_${table}_update AFTER UPDATE OF ${keys.join(",")} ON ${table}
      WHEN ${keys.map(key => `OLD.${key} IS NOT NEW.${key}`).join(" OR ")}
      BEGIN ${enqueue("OLD")} ${enqueue("NEW")} END;`;
}

const task = (row: string) => `SELECT ${row}.task_id`;
const assigned = (member: string) => `SELECT d.task_id FROM deliveries d
  WHERE d.member_id=${member} AND d.kind IN ('instruction','user_message') AND d.task_id IS NOT NULL`;
const blocked = (member: string) => `EXISTS (SELECT 1 FROM members WHERE id=${member}
  AND status='blocked' AND blocked_reason IN ('permission','selection','setup'))`;

export const COMPLETION_CHANGE_SCHEMA = `
  CREATE TABLE completion_changes(task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE);
  CREATE INDEX deliveries_task_project ON deliveries(task_id, project_id) WHERE task_id IS NOT NULL;
  CREATE INDEX report_references_correction ON report_references(corrects_message_id) WHERE corrects_message_id IS NOT NULL;
  CREATE INDEX deliveries_completion_expiry ON deliveries(created_at, member_id, task_id)
    WHERE status='delivered' AND kind IN ('instruction','user_message') AND task_id IS NOT NULL;
  CREATE INDEX tasks_parent_completion ON tasks(parent_task_id) WHERE parent_task_id IS NOT NULL;

  ${changes("tasks", "parent_task_id merged_into", r => `SELECT ${r}.id UNION SELECT ${r}.parent_task_id`)}
  ${changes("decisions", "task_id status", task)}
  ${changes("todos", "task_id done outcome", task)}
  ${changes("task_stage_marks", "task_id stage", task)}
  ${changes("task_sequence", "task_id member_id", task)}
  ${changes("task_watch", "task_id tripped_at", task)}
  ${changes("task_continuations", "task_id pause_token pause_source_seq pause_mark_seq",
    r => `SELECT ${r}.task_id WHERE ${r}.pause_token IS NOT NULL`)}
  ${changes("task_contracts", "task_id rev kind goal author_kind confirmed_at acceptance scope inputs outputs constraints_json exclusions checks", task)}
  ${changes("report_harness", "task_id contract_task_id member_id contract_rev gate evidence_status",
    r => `SELECT ${r}.task_id UNION SELECT ${r}.contract_task_id`)}
  ${changes("report_checks", "message_id name kind result criterion",
    r => `SELECT task_id FROM messages WHERE id=${r}.message_id`)}
  ${changes("report_references", "source_message_id corrects_message_id project_id",
    r => `SELECT task_id FROM messages WHERE id IN (${r}.source_message_id,${r}.corrects_message_id)`)}
  ${changes("report_closures", "ref_id ref_type kind member_id at", r => `SELECT task_id FROM messages
    WHERE id=${r}.ref_id AND ${r}.ref_type='message' AND ${r}.kind='continuing'`)}
  ${changes("messages", "task_id member_id kind mine at", r => `SELECT ${r}.task_id WHERE ${r}.mine=0
    UNION ${assigned(r + ".member_id")} AND ${r}.kind IN ('완료','막힘') AND ${blocked(r + ".member_id")}`)}
  ${changes("deliveries", "task_id kind wake status member_id created_at scope_seq", r => `SELECT ${r}.task_id
    WHERE ${r}.kind IN ('instruction','user_message','answer','todo_done')
    UNION ${assigned(r + ".member_id")} AND ${r}.kind IN ('instruction','user_message') AND ${blocked(r + ".member_id")}`)}
  ${changes("members", "status blocked_reason session_generation kind", r => `
    ${assigned(r + ".id")} AND ${r}.status='blocked'
    UNION SELECT task_id FROM messages WHERE member_id=${r}.id AND kind='완료' AND task_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM members WHERE id=${r}.id AND kind=${r}.kind)`)}
  ${changes("execution_journal", "member_id generation delivery_ids_json ended_at created_at",
    r => `${assigned(r + ".member_id")} AND ${blocked(r + ".member_id")}`)}
  CREATE TRIGGER completion_project_enabled AFTER UPDATE OF archived,runner_enabled ON projects
    WHEN NEW.archived=0 AND NEW.runner_enabled=1 AND (OLD.archived<>0 OR OLD.runner_enabled=0)
    BEGIN INSERT INTO completion_changes(task_id) SELECT id FROM tasks WHERE project_id=NEW.id
      AND merged_into IS NULL AND (EXISTS(SELECT 1 FROM report_harness WHERE contract_task_id=tasks.id)
        OR EXISTS(SELECT 1 FROM task_completion_reviews WHERE task_id=tasks.id)) ON CONFLICT(task_id) DO NOTHING; END;
  INSERT INTO completion_changes(task_id) SELECT id FROM tasks WHERE merged_into IS NULL
    AND (EXISTS(SELECT 1 FROM report_harness WHERE contract_task_id=tasks.id)
      OR EXISTS(SELECT 1 FROM task_completion_reviews WHERE task_id=tasks.id));
`;
