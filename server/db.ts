import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, statSync } from "node:fs";
import { migrateStoredContent } from "./agent-receipts.ts";

export const STORAGE_OPTIMIZATION_VERSION = 35;

export const MIGRATIONS: string[] = [
  `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    is_hq INTEGER NOT NULL DEFAULT 0,
    cwd TEXT NOT NULL,
    backend TEXT NOT NULL,
    permission_mode TEXT NOT NULL,
    model TEXT,
    runner_enabled INTEGER NOT NULL,
    now TEXT NOT NULL DEFAULT '',
    now_at TEXT,
    herdr_workspace_id TEXT,
    herdr_tab_id TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE members (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    handle TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL,
    origin TEXT NOT NULL,
    cli TEXT NOT NULL DEFAULT 'claude',
    status TEXT NOT NULL,
    now TEXT NOT NULL DEFAULT '',
    next TEXT NOT NULL DEFAULT '',
    cwd TEXT NOT NULL,
    session_id TEXT,
    pane_id TEXT,
    context_pct REAL,
    subagents INTEGER NOT NULL DEFAULT 0,
    parallel INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    token TEXT NOT NULL UNIQUE,
    updated_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (project_id, handle)
  );

  CREATE TABLE decisions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    member_id TEXT,
    who TEXT NOT NULL,
    title TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    options TEXT NOT NULL DEFAULT '[]',
    rec TEXT,
    grp TEXT,
    file_id TEXT,
    images TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL,
    choice TEXT,
    note TEXT,
    batch INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    answered_at TEXT,
    delivered_at TEXT
  );
  CREATE INDEX decisions_project ON decisions(project_id, status);
  CREATE INDEX decisions_member ON decisions(member_id, status);

  CREATE TABLE todos (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    member_id TEXT,
    who TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    done INTEGER NOT NULL DEFAULT 0,
    done_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX todos_project ON todos(project_id, done);

  CREATE TABLE work (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    sec TEXT NOT NULL,
    title TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    who TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL,
    done_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX work_project ON work(project_id, sort_order);

  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    at TEXT NOT NULL,
    mine INTEGER NOT NULL DEFAULT 0,
    member_id TEXT,
    who TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    target_member_id TEXT,
    target_name TEXT,
    decision_id TEXT,
    file_id TEXT,
    attachments TEXT NOT NULL DEFAULT '[]',
    delivery TEXT,
    delivery_note TEXT
  );
  CREATE INDEX messages_project ON messages(project_id, at);

  CREATE TABLE files (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    who TEXT NOT NULL DEFAULT '',
    member_id TEXT,
    summary TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    path TEXT,
    attachments TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    sort_order INTEGER NOT NULL
  );
  CREATE INDEX files_project ON files(project_id, sort_order);

  CREATE TABLE attachments (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    path TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE deliveries (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    wake INTEGER NOT NULL DEFAULT 1,
    urgent INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    hold_reason TEXT,
    ref_type TEXT,
    ref_id TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL,
    delivered_at TEXT
  );
  CREATE INDEX deliveries_member ON deliveries(member_id, status);

  CREATE TABLE activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL
  );
  CREATE INDEX activity_member ON activity(member_id, id);

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // 받을 사람이 없어 '했음'을 아직 못 알린 할 일.
  `ALTER TABLE todos ADD COLUMN notice_pending INTEGER NOT NULL DEFAULT 0;`,
  // 결재 상태는 되돌아갈 수 있다(전달 실패 → 다시 열림). 화면이 새 값과 늦게 온 응답을 가르는 판 번호.
  `ALTER TABLE decisions ADD COLUMN updated_at TEXT;
   UPDATE decisions SET updated_at = COALESCE(delivered_at, answered_at, created_at);`,
  // 어디서도 쓰지 않았다. 탭 번호만 둔다(§5).
  `ALTER TABLE projects DROP COLUMN herdr_workspace_id;`,
  // 설정을 전체 하나로 통일한다. 프로젝트 값은 지우기 전에 직원과 보관 표로 옮겨 잃지 않는다.
  `CREATE TABLE project_settings_v4 AS SELECT id AS project_id, backend, permission_mode, model FROM projects;
   ALTER TABLE members ADD COLUMN backend TEXT;
   ALTER TABLE members ADD COLUMN model_override TEXT;
   ALTER TABLE members ADD COLUMN effort_override TEXT;
   ALTER TABLE members ADD COLUMN applied_config TEXT;
   UPDATE members SET backend = (SELECT p.backend FROM projects p WHERE p.id = members.project_id)
     WHERE origin != 'manual' AND (session_id IS NOT NULL OR pane_id IS NOT NULL);
   UPDATE members SET model_override = (SELECT p.model FROM projects p WHERE p.id = members.project_id) WHERE origin != 'manual';
   UPDATE members SET applied_config = json_object('model', model_override, 'effort', NULL, 'staffModel', NULL, 'staffEffort', NULL)
     WHERE origin = 'runner' AND session_id IS NOT NULL;
   UPDATE settings SET key = 'backend' WHERE key = 'defaultBackend';
   UPDATE settings SET key = 'permissionMode', value = CASE value WHEN '"acceptEdits"' THEN '"auto"' ELSE value END WHERE key = 'defaultPermissionMode';
   ALTER TABLE projects DROP COLUMN backend;
   ALTER TABLE projects DROP COLUMN permission_mode;
   ALTER TABLE projects DROP COLUMN model;`,
  // 자료의 모양과 아티팩트 원본. 원본은 화면 상태에 싣지 않고 따로 받는다.
  `ALTER TABLE files ADD COLUMN kind TEXT;
   ALTER TABLE files ADD COLUMN html TEXT;`,
  // 편입으로 들어온 세션의 표시. 해제할 때 되돌릴 것을 적어 둔다(JSON). 가져온 명부의 빈 자리(세션 없음)는 편입이 아니다.
  `ALTER TABLE members ADD COLUMN adopted_info TEXT;
   UPDATE members SET adopted_info = '{"turnedOnRunner":false}' WHERE origin = 'adopted' AND session_id IS NOT NULL;`,
  // 다시 열린 결재의 직전 답과 이유. 전달 실패로 대표의 메모가 사라지지 않게 한다.
  // 실행을 켠 것이 편입인가는 프로젝트의 사실이다. 켠 직원이 먼저 해제되면 직원 표시는 행과 함께 사라진다.
  `ALTER TABLE decisions ADD COLUMN last_choice TEXT;
   ALTER TABLE decisions ADD COLUMN last_note TEXT;
   ALTER TABLE decisions ADD COLUMN reopen_note TEXT;
   ALTER TABLE projects ADD COLUMN runner_by_adopt INTEGER NOT NULL DEFAULT 0;
   UPDATE projects SET runner_by_adopt = 1
     WHERE runner_enabled = 1 AND id IN (SELECT project_id FROM members WHERE json_extract(adopted_info, '$.turnedOnRunner') = 1);`,
  // v4→v5 이주가 옛 프로젝트의 승인 필요·오토를 조용히 바이패스로 올렸다. 저장한 전역 값과 프로젝트 값 중 가장 엄격한 것을 적는다.
  // 옛 기본은 auto 다. acceptEdits·모르는 값도 바이패스로 올리지 않는다. 프로젝트가 없는 새 DB 만 바이패스 기본을 쓴다.
  // 어느 값이든 바뀌었으면 대표에게 알린다. 바이패스는 대표가 설정에서 직접 고른다.
  `CREATE TEMP TABLE perm_repair AS
     SELECT saved, CASE
       WHEN saved = '"default"' OR strict = '"default"' THEN '"default"'
       WHEN strict = '"bypassPermissions"' AND (saved IS NULL OR saved = '"bypassPermissions"') THEN '"bypassPermissions"'
       ELSE '"auto"' END AS final
     FROM (SELECT
       (SELECT value FROM settings WHERE key = 'permissionMode') AS saved,
       CASE
         WHEN EXISTS (SELECT 1 FROM project_settings_v4 WHERE permission_mode = 'default') THEN '"default"'
         WHEN EXISTS (SELECT 1 FROM project_settings_v4 WHERE permission_mode IS NULL OR permission_mode != 'bypassPermissions') THEN '"auto"'
         ELSE '"bypassPermissions"' END AS strict)
     WHERE EXISTS (SELECT 1 FROM project_settings_v4);
   INSERT INTO messages (id, project_id, at, who, kind, body)
     SELECT 'msg_permkept', 'hq', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), '시스템', '시스템',
       '설정을 전체 하나로 합치면서 권한 모드를 지정했던 값 중 가장 엄격한 ' || CASE final WHEN '"default"' THEN '모두 승인' ELSE '오토' END || ' 으로 정했습니다. 바이패스를 쓰려면 설정에서 직접 골라 주세요.'
     FROM perm_repair
     WHERE EXISTS (SELECT 1 FROM projects WHERE id = 'hq')
       AND ((saved IS NOT NULL AND saved != final)
         OR EXISTS (SELECT 1 FROM project_settings_v4 WHERE permission_mode IS NULL OR json_quote(permission_mode) != final));
   INSERT OR REPLACE INTO settings (key, value) SELECT 'permissionMode', final FROM perm_repair;
   DROP TABLE perm_repair;`,
  // 프로젝트 모델이 이주 시점의 직원에게만 옮겨져 새 직원이 그 값을 잃었다. 하나로 모이면 직급 기본값으로 올리고 직원별 지정을 푼다(그래야 설정의 직급 값이 먹는다).
  // 갈리면 직급 값을 정할 수 없다. 직원별 지정은 두고 대표에게 알린다.
  // 직급 값이 이미 저장돼 있으면 빈 칸만 채운다. 대표가 고른 모델은 덮지 않고, 그 직급의 직원별 지정은 남긴다.
  `INSERT OR IGNORE INTO settings (key, value)
     SELECT 'ranks', json_object(
       'manager', json_object('model', m.model, 'effort', NULL),
       'lead', json_object('model', m.model, 'effort', NULL),
       'staff', json_object('model', NULL, 'effort', NULL))
     FROM (SELECT MAX(model) AS model FROM project_settings_v4 WHERE model IS NOT NULL HAVING COUNT(DISTINCT model) = 1) m;
   UPDATE settings SET value = json_set(value,
       '$.manager', json_object('model', COALESCE(json_extract(value, '$.manager.model'), (SELECT MAX(model) FROM project_settings_v4)), 'effort', json_extract(value, '$.manager.effort')),
       '$.lead', json_object('model', COALESCE(json_extract(value, '$.lead.model'), (SELECT MAX(model) FROM project_settings_v4)), 'effort', json_extract(value, '$.lead.effort')))
     WHERE key = 'ranks' AND (SELECT COUNT(DISTINCT model) FROM project_settings_v4 WHERE model IS NOT NULL) = 1;
   UPDATE members SET model_override = NULL
     WHERE origin != 'manual' AND model_override IS NOT NULL
       AND (SELECT COUNT(DISTINCT model) FROM project_settings_v4 WHERE model IS NOT NULL) = 1
       AND model_override = (SELECT MAX(model) FROM project_settings_v4)
       AND (SELECT json_extract(value, CASE WHEN members.kind IN ('root', 'conductor') THEN '$.manager.model' ELSE '$.lead.model' END) FROM settings WHERE key = 'ranks') = model_override;
   INSERT INTO messages (id, project_id, at, who, kind, body)
     SELECT 'msg_modellift', 'hq', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), '시스템', '시스템',
       '설정을 전체 하나로 합치면서 프로젝트에 지정했던 모델 ' || (SELECT MAX(model) FROM project_settings_v4) || ' 을 부장·팀장 기본값으로 옮겼습니다. 모델을 지정하지 않았던 프로젝트의 세션도 이 값을 따릅니다. 설정의 직급별 모델을 확인해 주세요.'
     WHERE (SELECT COUNT(DISTINCT model) FROM project_settings_v4 WHERE model IS NOT NULL) = 1
       AND (SELECT json_extract(value, '$.manager.model') FROM settings WHERE key = 'ranks') = (SELECT MAX(model) FROM project_settings_v4)
       AND (SELECT json_extract(value, '$.lead.model') FROM settings WHERE key = 'ranks') = (SELECT MAX(model) FROM project_settings_v4)
       AND EXISTS (SELECT 1 FROM projects WHERE id = 'hq');
   INSERT INTO messages (id, project_id, at, who, kind, body)
     SELECT 'msg_modelkept', 'hq', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), '시스템', '시스템',
       '설정을 전체 하나로 합치면서 프로젝트에 지정했던 모델 ' || (SELECT MAX(model) FROM project_settings_v4) || ' 은 저장된 직급 기본값과 달라 직원별 지정으로 남겼습니다. 앞으로 새로 뜨는 직원은 직급 기본값을 따릅니다. 설정의 직급별 모델을 확인해 주세요.'
     WHERE (SELECT COUNT(DISTINCT model) FROM project_settings_v4 WHERE model IS NOT NULL) = 1
       AND NOT (COALESCE((SELECT json_extract(value, '$.manager.model') FROM settings WHERE key = 'ranks') = (SELECT MAX(model) FROM project_settings_v4), 0)
         AND COALESCE((SELECT json_extract(value, '$.lead.model') FROM settings WHERE key = 'ranks') = (SELECT MAX(model) FROM project_settings_v4), 0))
       AND EXISTS (SELECT 1 FROM projects WHERE id = 'hq');
   INSERT INTO messages (id, project_id, at, who, kind, body)
     SELECT 'msg_modelsplit', 'hq', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), '시스템', '시스템',
       '설정을 전체 하나로 합치면서 프로젝트마다 달랐던 모델은 직원별 지정으로 옮겼습니다. 앞으로 새로 뜨는 직원은 직급 기본값을 따릅니다. 설정의 직급별 모델을 확인해 주세요.'
     WHERE (SELECT COUNT(DISTINCT model) FROM project_settings_v4 WHERE model IS NOT NULL) > 1
       AND EXISTS (SELECT 1 FROM projects WHERE id = 'hq');`,
  // 총괄 이름에 프로젝트 이름을 붙인다. 핸들은 칸 소유 판정에 쓰여 여기서 바꾸지 않는다.
  `UPDATE members SET name = substr((SELECT name FROM projects WHERE projects.id = members.project_id) || ' 총괄', 1, 40)
   WHERE kind = 'conductor' AND name = '총괄';`,
  // 판 정리. 결재를 닫은 이유·닫은 이, 할 일의 끝남/필요 없어짐과 이유, 프로젝트의 마지막 판 정리 시각.
  // 이미 닫힌 결재는 직원이 명부에서 빠질 때 함께 닫힌 것뿐이다. 이유를 채워 결재된 항목에 보이게 한다.
  `ALTER TABLE decisions ADD COLUMN close_kind TEXT;
   ALTER TABLE decisions ADD COLUMN close_reason TEXT;
   ALTER TABLE decisions ADD COLUMN close_quote TEXT;
   ALTER TABLE decisions ADD COLUMN closed_by TEXT;
   ALTER TABLE decisions ADD COLUMN closed_at TEXT;
   UPDATE decisions SET close_reason = '물은 직원이 명부에서 빠져 함께 닫혔습니다', closed_by = '시스템', closed_at = COALESCE(updated_at, created_at)
     WHERE status = 'closed';
   ALTER TABLE todos ADD COLUMN outcome TEXT;
   ALTER TABLE todos ADD COLUMN close_reason TEXT;
   ALTER TABLE todos ADD COLUMN closed_by TEXT;
   ALTER TABLE todos ADD COLUMN updated_at TEXT;
   UPDATE todos SET outcome = 'done' WHERE done = 1;
   UPDATE todos SET updated_at = COALESCE(done_at, created_at);
   ALTER TABLE projects ADD COLUMN board_tidied_at TEXT;`,
  // Keep previous CLI generations for audit and handoff without reusing another provider's session.
  `ALTER TABLE projects ADD COLUMN chief_cli TEXT NOT NULL DEFAULT 'claude';
   ALTER TABLE members ADD COLUMN session_generation INTEGER NOT NULL DEFAULT 0;
   CREATE TABLE member_session_history (
     id TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
     cli TEXT NOT NULL, backend TEXT, session_id TEXT, pane_id TEXT, generation INTEGER NOT NULL,
     applied_config TEXT, archived_at TEXT NOT NULL, reason TEXT NOT NULL
   );`,
  // 직원별로 상태줄에서 배운 문맥 창 크기. herdr 는 상태줄이 잘리면 토큰을 200k 로 나눠 1M 세션의 % 를 5배로 부풀렸다.
  // 그렇게 적힌 값이 다음 전달 때 압축을 부르지 않게 비운다(다음 턴 끝에 바로 다시 잰다). headless 값은 실제 창 크기로 잰 것이라 둔다.
  `ALTER TABLE members ADD COLUMN context_window INTEGER;
   ALTER TABLE members ADD COLUMN context_window_source TEXT;
   UPDATE members SET context_pct = NULL WHERE backend IS NOT 'headless';`,
  // 새 keyset 조회만 BINARY (at,id)를 쓴다. 구형 rowid 조회 인덱스는 보존한다.
  `CREATE INDEX messages_project_page ON messages(project_id, at COLLATE BINARY, id COLLATE BINARY);
   CREATE INDEX messages_member_page ON messages(project_id, member_id, at COLLATE BINARY, id COLLATE BINARY);
   CREATE INDEX messages_target_page ON messages(project_id, target_member_id, at COLLATE BINARY, id COLLATE BINARY);`,
  // 외부 쓰기 전에 봉투/기준선/시도를 commit한다. 옛 입력에 새 수신 증거를 만들지 않는다.
  `CREATE TABLE delivery_recovery (
     delivery_id TEXT PRIMARY KEY REFERENCES deliveries(id) ON DELETE CASCADE,
     marker TEXT UNIQUE,
     phase TEXT NOT NULL DEFAULT 'none'
       CHECK (phase IN ('none','checking','waiting','retry_wait','needs_owner','resolved','stopped')),
     reason TEXT,
     version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
     auto_attempts INTEGER NOT NULL DEFAULT 0 CHECK (auto_attempts >= 0),
     check_count INTEGER NOT NULL DEFAULT 0 CHECK (check_count >= 0),
     active_check_ms INTEGER NOT NULL DEFAULT 0 CHECK (active_check_ms >= 0),
     next_check_at TEXT,
     last_checked_at TEXT,
     evidence_json TEXT NOT NULL DEFAULT '[]',
     updated_at TEXT NOT NULL
   );
   INSERT INTO delivery_recovery (delivery_id, updated_at)
     SELECT id, COALESCE(delivered_at, created_at) FROM deliveries;
   CREATE INDEX delivery_recovery_due ON delivery_recovery(phase, next_check_at);
   CREATE TABLE delivery_dispatches (
     id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
     bundle_marker TEXT NOT NULL UNIQUE,
     cli TEXT NOT NULL,
     backend TEXT NOT NULL,
     generation INTEGER NOT NULL CHECK (generation >= 0),
     native_session_id TEXT,
     terminal_identity_json TEXT NOT NULL,
     baseline_json TEXT NOT NULL,
     wire_text TEXT NOT NULL,
     wire_sha256 TEXT NOT NULL,
     transport_state TEXT NOT NULL
       CHECK (transport_state IN ('prepared','write_started','accepted','rejected','unknown')),
     submit_attempts INTEGER NOT NULL DEFAULT 0 CHECK (submit_attempts BETWEEN 0 AND 1),
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX delivery_dispatches_member ON delivery_dispatches(member_id, created_at);
   CREATE TABLE delivery_dispatch_items (
     dispatch_id TEXT NOT NULL REFERENCES delivery_dispatches(id) ON DELETE CASCADE,
     delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
     ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
     source_revision TEXT,
     PRIMARY KEY (dispatch_id, delivery_id),
     UNIQUE (dispatch_id, ordinal)
   );
   CREATE INDEX delivery_dispatch_items_delivery ON delivery_dispatch_items(delivery_id);
   CREATE TABLE delivery_recovery_operations (
     operation_id TEXT PRIMARY KEY,
     delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
     request_json TEXT NOT NULL,
     result_json TEXT NOT NULL,
     created_at TEXT NOT NULL
   );
   ALTER TABLE activity ADD COLUMN delivery_event_key TEXT;
   CREATE UNIQUE INDEX activity_delivery_event ON activity(delivery_event_key)
     WHERE delivery_event_key IS NOT NULL;`,
  // 기존 실측 window 열을 재추가하거나 값을 초기화하지 않는다. 상태는 같은 세대에서 lazy 생성한다.
  `CREATE TABLE member_context_state (
     member_id TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
     generation INTEGER NOT NULL CHECK (generation >= 0),
     binding_nonce TEXT NOT NULL,
     rollout_path TEXT,
     rollout_offset INTEGER NOT NULL DEFAULT 0 CHECK (rollout_offset >= 0),
     measurement_json TEXT,
     compaction_json TEXT,
     baseline_json TEXT,
     updated_at TEXT NOT NULL
   );`,
  // 생성/종료 의도와 실제 실행은 별개다. 명부 삭제 뒤에도 신원과 중단 통지 증거를 보존한다.
  `CREATE TABLE lifecycle_journal (
     operation_id TEXT PRIMARY KEY,
     member_id TEXT NOT NULL,
     project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     intent TEXT NOT NULL CHECK (intent IN ('start','sleep','close','archive','fresh_session')),
     phase TEXT NOT NULL CHECK (phase IN ('prepared','started','unknown','confirmed','refused')),
     generation INTEGER NOT NULL CHECK (generation >= 0),
     terminal_identity_json TEXT NOT NULL,
     run_id TEXT,
     delivery_ids_json TEXT NOT NULL DEFAULT '[]',
     baseline_json TEXT,
     reason TEXT,
     exit_code INTEGER,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX lifecycle_journal_pending ON lifecycle_journal(phase, updated_at);
   CREATE INDEX lifecycle_journal_member ON lifecycle_journal(member_id, generation, created_at);
   CREATE TABLE execution_journal (
     run_id TEXT PRIMARY KEY,
     member_id TEXT NOT NULL,
     project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     generation INTEGER NOT NULL CHECK (generation >= 0),
     terminal_identity_json TEXT NOT NULL,
     turn INTEGER,
     delivery_ids_json TEXT NOT NULL DEFAULT '[]',
     phase TEXT NOT NULL CHECK (phase IN ('received','starting','running','ended','interrupted','unknown')),
     input_received_at TEXT,
     started_at TEXT,
     last_progress_at TEXT,
     ended_at TEXT,
     result TEXT CHECK (result IN ('success','error','interrupted')),
     reason TEXT,
     exit_code INTEGER,
     interruption_notified_at TEXT,
     report_requested_at TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX execution_journal_member ON execution_journal(member_id, generation, phase);
   CREATE INDEX execution_journal_pending ON execution_journal(phase, updated_at);
   CREATE TABLE terminal_leases (
     member_id TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
     claim_id TEXT NOT NULL UNIQUE,
     lease_id TEXT NOT NULL UNIQUE,
     generation INTEGER NOT NULL CHECK (generation >= 0),
     terminal_identity_json TEXT NOT NULL,
     expires_at INTEGER NOT NULL,
     last_input_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_input_sequence >= 0)
   );
   CREATE INDEX terminal_leases_expiry ON terminal_leases(expires_at);
   CREATE TABLE operation_receipts (
     operation_id TEXT PRIMARY KEY,
     kind TEXT NOT NULL CHECK (kind IN ('fresh_session','terminal_control','settings','member_config','todo_done')),
     project_id TEXT,
     member_id TEXT,
     status TEXT NOT NULL CHECK (status IN ('pending','applied','refused','unknown')),
     request_json TEXT NOT NULL,
     result_json TEXT,
     code TEXT,
     error TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     CHECK ((status = 'pending' AND result_json IS NULL AND code IS NULL AND error IS NULL)
       OR (status = 'applied' AND result_json IS NOT NULL AND code IS NULL AND error IS NULL)
       OR (status IN ('refused','unknown') AND result_json IS NULL AND code IS NOT NULL AND error IS NOT NULL))
   );
   CREATE INDEX operation_receipts_member ON operation_receipts(member_id, created_at);
   CREATE TABLE agent_operation_receipts (
     operation_id TEXT PRIMARY KEY,
     member_id TEXT NOT NULL,
     project_id TEXT NOT NULL,
     tool_name TEXT NOT NULL,
     request_json TEXT NOT NULL,
     result_json TEXT NOT NULL,
     created_at TEXT NOT NULL
   );`,
  // CAS는 도메인 변경과 같은 transaction에서 증가시킨다. 옛 판 검토/활동 시각을 추정하지 않는다.
  `CREATE TABLE domain_revisions (
     domain TEXT PRIMARY KEY,
     revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)
   );
   INSERT INTO domain_revisions (domain) VALUES ('settings');
   ALTER TABLE members ADD COLUMN config_revision INTEGER NOT NULL DEFAULT 0 CHECK (config_revision >= 0);
   ALTER TABLE members ADD COLUMN status_observation_json TEXT;
   ALTER TABLE members ADD COLUMN blocked_reason TEXT;
   ALTER TABLE members ADD COLUMN subagent_state_json TEXT;
   ALTER TABLE members ADD COLUMN now_at TEXT;
   ALTER TABLE members ADD COLUMN manual_activity_at TEXT;
   ALTER TABLE members ADD COLUMN lifecycle_state_json TEXT;
   ALTER TABLE todos ADD COLUMN revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0);
   ALTER TABLE projects ADD COLUMN board_revision INTEGER NOT NULL DEFAULT 0 CHECK (board_revision >= 0);
   ALTER TABLE projects ADD COLUMN board_requested_revision INTEGER CHECK (board_requested_revision >= 0);
   ALTER TABLE projects ADD COLUMN board_completed_revision INTEGER CHECK (board_completed_revision >= 0);
   ALTER TABLE projects ADD COLUMN board_reviewed_revision INTEGER CHECK (board_reviewed_revision >= 0);
   ALTER TABLE projects ADD COLUMN board_requested_at TEXT;
   ALTER TABLE projects ADD COLUMN board_completed_at TEXT;
   ALTER TABLE deliveries ADD COLUMN next_attempt_at TEXT;
   ALTER TABLE deliveries ADD COLUMN source_revision TEXT;
   ALTER TABLE deliveries ADD COLUMN retry_scope TEXT;
   ALTER TABLE deliveries ADD COLUMN retry_reason TEXT;
   ALTER TABLE deliveries ADD COLUMN correction_revision INTEGER CHECK (correction_revision >= 0);
   CREATE INDEX deliveries_due ON deliveries(status, next_attempt_at, member_id);
   CREATE INDEX deliveries_reference ON deliveries(ref_type, ref_id, member_id);
   ALTER TABLE decisions ADD COLUMN follow_up_json TEXT;
   CREATE TABLE report_references (
     source_message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
     project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     file_ids_json TEXT NOT NULL DEFAULT '[]',
     decision_ids_json TEXT NOT NULL DEFAULT '[]',
     authored_at TEXT NOT NULL,
     sequence INTEGER NOT NULL CHECK (sequence >= 0),
     corrects_message_id TEXT
   );
   CREATE INDEX report_references_order ON report_references(project_id, sequence);
   CREATE TABLE manual_inbox_batches (
     id TEXT PRIMARY KEY,
     member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
     created_at TEXT NOT NULL,
     acknowledged_at TEXT
   );
   CREATE UNIQUE INDEX manual_inbox_open ON manual_inbox_batches(member_id) WHERE acknowledged_at IS NULL;
   CREATE TABLE manual_inbox_items (
     batch_id TEXT NOT NULL REFERENCES manual_inbox_batches(id) ON DELETE CASCADE,
     delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
     ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
     PRIMARY KEY (batch_id, delivery_id),
     UNIQUE (delivery_id),
     UNIQUE (batch_id, ordinal)
   );`,
  // SQL은 서버 ID나 과거 사건을 만들지 않는다. PushStore가 초기화/episode baseline을 소유한다.
  `CREATE TABLE push_meta (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     server_id TEXT NOT NULL UNIQUE,
     created_at TEXT NOT NULL
   );
   CREATE TABLE push_devices (
     id TEXT PRIMARY KEY,
     label TEXT NOT NULL,
     platform TEXT NOT NULL CHECK (platform = 'ios'),
     bundle_id TEXT NOT NULL,
     environment TEXT NOT NULL CHECK (environment IN ('sandbox','production')),
     token TEXT,
     authorization TEXT NOT NULL CHECK (authorization IN ('authorized','provisional','ephemeral','denied','notDetermined')),
     enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
     preferences TEXT NOT NULL DEFAULT '{"decision":true,"approval_wait":true,"error":true,"report_complete":true}',
     state TEXT NOT NULL CHECK (state IN ('active','revoked','invalid','expired')),
     revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
     registration_generation INTEGER NOT NULL DEFAULT 1 CHECK (registration_generation > 0),
     registered_at TEXT NOT NULL,
     last_seen_at TEXT NOT NULL,
     expires_at TEXT NOT NULL,
     revoked_at TEXT,
     invalidated_at TEXT,
     last_accepted_at TEXT,
     last_failure TEXT CHECK (last_failure IN ('token_invalid','provider_error','temporary_error'))
   );
   CREATE UNIQUE INDEX push_devices_token ON push_devices(bundle_id, environment, token) WHERE token IS NOT NULL;
   CREATE INDEX push_devices_expiry ON push_devices(state, expires_at);
   CREATE TABLE push_events (
     id TEXT PRIMARY KEY,
     source_key TEXT NOT NULL UNIQUE,
     kind TEXT NOT NULL CHECK (kind IN ('decision','approval_wait','error','report_complete','test')),
     project_id TEXT,
     member_id TEXT,
     target TEXT NOT NULL,
     occurred_at TEXT NOT NULL,
     expires_at TEXT NOT NULL
   );
   CREATE INDEX push_events_expiry ON push_events(expires_at);
   CREATE TABLE push_episodes (
     member_id TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
     blocked_generation INTEGER NOT NULL DEFAULT 0 CHECK (blocked_generation >= 0),
     blocked_active INTEGER NOT NULL DEFAULT 0 CHECK (blocked_active IN (0,1)),
     error_generation INTEGER NOT NULL DEFAULT 0 CHECK (error_generation >= 0),
     error_active INTEGER NOT NULL DEFAULT 0 CHECK (error_active IN (0,1)),
     error_digest TEXT
   );
   CREATE TABLE push_deliveries (
     id TEXT PRIMARY KEY,
     event_id TEXT NOT NULL REFERENCES push_events(id) ON DELETE CASCADE,
     device_id TEXT NOT NULL REFERENCES push_devices(id) ON DELETE CASCADE,
     registration_generation INTEGER NOT NULL CHECK (registration_generation > 0),
     state TEXT NOT NULL CHECK (state IN ('queued','sending','retry','accepted','cancelled','invalid','expired','failed','unknown')),
     attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
     next_attempt_at TEXT NOT NULL,
     lease_until TEXT,
     last_status INTEGER,
     last_reason TEXT,
     accepted_at TEXT,
     expires_at TEXT NOT NULL,
     finished_at TEXT,
     UNIQUE (event_id, device_id)
   );
   CREATE INDEX push_deliveries_due ON push_deliveries(state, next_attempt_at);`,
  // 첫 보고 시각 + 120초의 고정 창. 보고 순서와 최초 수신 집합/취소 표식을 정규화해 보존한다.
  `CREATE TABLE push_report_groups (
     id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL,
     member_id TEXT NOT NULL,
     opened_at TEXT NOT NULL,
     closes_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', opened_at, '+120 seconds') IS NOT NULL
       AND closes_at = strftime('%Y-%m-%dT%H:%M:%fZ', opened_at, '+120 seconds')),
     last_message_id TEXT NOT NULL,
     state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','closed','cancelled')),
     event_id TEXT UNIQUE REFERENCES push_events(id) ON DELETE SET NULL,
     closed_at TEXT
   );
   CREATE UNIQUE INDEX push_report_groups_open ON push_report_groups(project_id, member_id) WHERE state = 'open';
   CREATE INDEX push_report_groups_due ON push_report_groups(state, closes_at);
   CREATE TABLE push_report_group_reports (
     group_id TEXT NOT NULL REFERENCES push_report_groups(id) ON DELETE CASCADE,
     message_id TEXT NOT NULL UNIQUE,
     ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
     PRIMARY KEY (group_id, ordinal)
   );
   CREATE TABLE push_report_group_recipients (
     group_id TEXT NOT NULL REFERENCES push_report_groups(id) ON DELETE CASCADE,
     device_id TEXT NOT NULL REFERENCES push_devices(id) ON DELETE CASCADE,
     registration_generation INTEGER NOT NULL CHECK (registration_generation > 0),
     cancelled_at TEXT,
     PRIMARY KEY (group_id, device_id)
   );`,
  // 예전 실행기는 직원 보고를 총괄에게 넣을 때 원본 메시지 연결(ref)을 남기지 않았다. 그 보고들을 '전달 기록 없음'으로
  // 보고 시작 복구가 총괄에게 다시 넣지 않도록, 이 시점까지의 메시지는 보고 전달 추적 대상에서 뺀다.
  `CREATE TABLE report_delivery_tracking (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     legacy_max_rowid INTEGER NOT NULL CHECK (legacy_max_rowid >= 0)
   );
   INSERT INTO report_delivery_tracking (id, legacy_max_rowid) SELECT 1, COALESCE(MAX(rowid), 0) FROM messages;`,
  // 생성 때 대표가 쓴 목표 원문. now 변경과 독립하며 과거 프로젝트는 소급하지 않는다.
  `ALTER TABLE projects ADD COLUMN creation_goal TEXT;`,
  // CLI 작업 시각은 상태 패치와 분리한다. 기존 활동은 직원별로 한 번만 집계한다.
  `ALTER TABLE members ADD COLUMN last_active_at TEXT;
   UPDATE members SET last_active_at = recent.at
     FROM (SELECT member_id, MAX(at) AS at FROM activity
       WHERE kind IN ('turn_start', 'turn_end', 'tool', 'tool_result')
       GROUP BY member_id) AS recent
     WHERE members.id = recent.member_id;`,
  // 대표 지시 턴의 배정 확인. 활동 보관 한도와 무관하게 재시작·재전달을 합친다.
  `CREATE TABLE delegation_ack_turns (
     run_id TEXT PRIMARY KEY,
     member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
     source_ids TEXT NOT NULL,
     assignments TEXT NOT NULL DEFAULT '[]',
     posted INTEGER NOT NULL DEFAULT 0,
     ended INTEGER NOT NULL DEFAULT 0
   );
   CREATE INDEX delegation_ack_member ON delegation_ack_turns(member_id, ended);`,
  // 작업별 대화. 작업 id 는 등록 때 한 번 정해지고 브랜치·워크트리를 고쳐도 그대로다. 옛 글·카드·자료·할 일은 task_id 가 비어
  // 전체 대화에만 남는다(소급 분류하지 않는다). 직원 출력의 작업은 직원이 밝힌 task_id 나 바뀌지 않는 출처(결재·자료·정정 대상 글,
  // 자동 보고는 그 턴에 받은 전달의 deliveries.task_id)로만 정한다. 마지막으로 받은 작업으로 추측하지 않는다.
  `CREATE TABLE tasks (
     id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     member_id TEXT,
     who TEXT NOT NULL DEFAULT '',
     title TEXT NOT NULL,
     branch TEXT,
     worktree TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX tasks_project ON tasks(project_id, created_at);
   ALTER TABLE messages ADD COLUMN task_id TEXT;
   ALTER TABLE decisions ADD COLUMN task_id TEXT;
   ALTER TABLE files ADD COLUMN task_id TEXT;
   ALTER TABLE todos ADD COLUMN task_id TEXT;
   ALTER TABLE deliveries ADD COLUMN task_id TEXT;
   CREATE INDEX messages_task ON messages(project_id, task_id, at) WHERE task_id IS NOT NULL;`,
  // 개발 기억(Hindsight 게이트웨이) 업로드 대기열. 원본(결재·작업·전달 상태)은 IAMCEO 에 남고, 여기에는 보낼 기록과 결과만 둔다.
  // event_id 는 게이트웨이의 같은 사건 재시도 키다. 같은 사건은 한 줄만 생기고, 같은 본문으로만 다시 보낸다.
  `CREATE TABLE memory_outbox (
     event_id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL,
     ref_type TEXT NOT NULL,
     ref_id TEXT NOT NULL,
     body TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'pending',
     attempts INTEGER NOT NULL DEFAULT 0,
     next_at TEXT NOT NULL,
     last_error TEXT,
     remote_id TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX memory_outbox_due ON memory_outbox(status, next_at);`,
  // 기억 운영 기본값. memory_mode: 'on'·'off' 는 프로젝트가 정한 값, NULL 은 이전 프로젝트(서버 환경 목록을 따른다).
  // memory_captures: 총괄이 대화에서 고른 대표 결정·제약·수정·피드백. 원문은 messages 에 있고 여기에는 고른 글 id·범위·해석만 둔다.
  // memory_searches: 일을 넣기 전에 서버가 한 기억 검색(결과 없음·실패를 구분해 남긴다). memory_search_deliveries 는 같은 전달을 두 번 찾지 않게 한다.
  `ALTER TABLE projects ADD COLUMN memory_mode TEXT;
   ALTER TABLE projects ADD COLUMN memory_enabled_at TEXT;
   ALTER TABLE memory_outbox ADD COLUMN supersedes_event_id TEXT;
   CREATE TABLE memory_captures (
     id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL,
     event_id TEXT NOT NULL UNIQUE,
     type TEXT NOT NULL,
     scope TEXT NOT NULL,
     standing INTEGER NOT NULL DEFAULT 0,
     message_ids TEXT NOT NULL,
     task_id TEXT,
     interpretation TEXT NOT NULL,
     file_refs TEXT NOT NULL DEFAULT '[]',
     supersedes_id TEXT,
     captured_by TEXT NOT NULL,
     created_at TEXT NOT NULL
   );
   CREATE INDEX memory_captures_project ON memory_captures(project_id, created_at);
   CREATE TABLE memory_searches (
     id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL,
     member_id TEXT NOT NULL,
     task_id TEXT,
     trigger TEXT NOT NULL,
     query_hash TEXT NOT NULL,
     status TEXT NOT NULL,
     result_ids TEXT NOT NULL DEFAULT '[]',
     block TEXT,
     detail TEXT,
     created_at TEXT NOT NULL
   );
   CREATE INDEX memory_searches_member ON memory_searches(project_id, member_id, created_at);
   CREATE TABLE memory_search_deliveries (
     delivery_id TEXT PRIMARY KEY,
     search_id TEXT NOT NULL
   );`,
  // 모든 글의 업무. origin: staff(직원 task 도구)·board(진행판 일 항목)·owner(대표가 이름 붙인 새 업무)·auto(서버가 첫 줄로 이름 붙인 새 업무)·backfill(옛 글 정리).
  // source_ref: 서버가 만든 업무의 출처 키(message:<id> 등). 같은 출처로는 업무를 한 번만 만든다(재시도·보고 보완이 업무를 늘리지 않게).
  // merged_into: 총괄이 auto 업무의 대표 글을 다른 업무로 분류해 비게 된 업무가 합쳐진 곳. 그 업무 id 로 오는 글은 합쳐진 업무로 간다.
  // renamed_at·renamed_by: 만든 뒤 이름을 바꾼 때와 바꾼 직원. 서버가 지은 이름(auto·backfill)은 바꾸기 전까지 임시다.
  // task_links: 글·카드·자료·할 일의 업무를 처음 붙인 뒤 바꾼 기록과 업무 사이 관계(ref_type 'task'). 원문(글 id·본문·시각)은 그대로 두고
  // 업무 칸만 바꾸며, 여기서 되돌린다.
  `ALTER TABLE tasks ADD COLUMN origin TEXT;
   ALTER TABLE tasks ADD COLUMN source_ref TEXT;
   ALTER TABLE tasks ADD COLUMN parent_task_id TEXT;
   ALTER TABLE tasks ADD COLUMN merged_into TEXT;
   ALTER TABLE tasks ADD COLUMN renamed_at TEXT;
   ALTER TABLE tasks ADD COLUMN renamed_by TEXT;
   UPDATE tasks SET origin = CASE WHEN id LIKE 'tk_w_%' THEN 'board' ELSE 'staff' END;
   CREATE UNIQUE INDEX tasks_source ON tasks(project_id, source_ref) WHERE source_ref IS NOT NULL;
   CREATE TABLE task_links (
     id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     ref_type TEXT NOT NULL,
     ref_id TEXT NOT NULL,
     from_task_id TEXT,
     to_task_id TEXT,
     basis TEXT NOT NULL,
     note TEXT,
     actor TEXT NOT NULL,
     batch_id TEXT,
     undone_at TEXT,
     created_at TEXT NOT NULL
   );
   CREATE INDEX task_links_ref ON task_links(project_id, ref_type, ref_id, created_at);
   CREATE INDEX task_links_batch ON task_links(batch_id) WHERE batch_id IS NOT NULL;`,
  // v30: 보고 의무의 마감 근거와 보고 보완의 원인 실행, 총괄 확인 글이 가리키는 직원 원보고(messages.about_message_id). 보완을 받은 실행은 새 보고 의무를 만들지 않고,
  // 보완 뒤에도 근거가 없으면 원래 실행을 '보고 미확인'으로 한 번만 남긴다(재시작해도 같은 판정).
  `CREATE TABLE report_closures (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     member_id TEXT NOT NULL,
     project_id TEXT NOT NULL,
     run_id TEXT,
     kind TEXT NOT NULL,
     ref_type TEXT NOT NULL,
     ref_id TEXT NOT NULL,
     cause_id TEXT,
     at TEXT NOT NULL
   );
   CREATE INDEX report_closures_member ON report_closures(member_id, at);
   CREATE TABLE report_followups (
     root_run_id TEXT PRIMARY KEY,
     member_id TEXT NOT NULL,
     project_id TEXT NOT NULL,
     delivery_id TEXT NOT NULL UNIQUE,
     requested_at TEXT NOT NULL,
     settled_kind TEXT,
     settled_ref TEXT,
     settled_at TEXT
   );
   ALTER TABLE messages ADD COLUMN about_message_id TEXT;`,
  // v31: 공통 하네스. 업무 시작 계약(판마다 한 줄, 고치면 판이 오른다)과 완료 보고의 검사 기록.
  // 검사는 글·직원·실행·계약 판을 함께 남겨, 같은 업무를 여러 직원이 다뤄도 누가 무엇을 확인했는지 섞이지 않는다.
  `CREATE TABLE task_contracts (
     task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
     rev INTEGER NOT NULL,
     kind TEXT NOT NULL,
     goal TEXT NOT NULL,
     acceptance TEXT NOT NULL,
     scope TEXT,
     forbidden TEXT NOT NULL DEFAULT '[]',
     evidence TEXT NOT NULL DEFAULT '[]',
     checks TEXT NOT NULL DEFAULT '[]',
     author TEXT NOT NULL,
     author_member_id TEXT,
     author_kind TEXT NOT NULL DEFAULT 'conductor',
     source_message_id TEXT,
     at TEXT NOT NULL,
     PRIMARY KEY (task_id, rev)
   );
   CREATE TABLE report_harness (
     message_id TEXT PRIMARY KEY,
     task_id TEXT,
     member_id TEXT NOT NULL,
     run_id TEXT,
     contract_task_id TEXT,
     contract_rev INTEGER,
     review_needed TEXT,
     at TEXT NOT NULL
   );
   CREATE TABLE report_checks (
     message_id TEXT NOT NULL,
     idx INTEGER NOT NULL,
     name TEXT NOT NULL,
     kind TEXT NOT NULL,
     result TEXT NOT NULL,
     evidence TEXT NOT NULL,
     command TEXT,
     criterion INTEGER,
     PRIMARY KEY (message_id, idx)
   );
   CREATE INDEX report_harness_task ON report_harness(task_id, at);
   CREATE INDEX report_harness_contract ON report_harness(contract_task_id, contract_rev);`,
  // v32: 하네스 기본 적용. 직원이 단 계약의 총괄 확인, 검사마다 대조한 실행 증거(제공자 기록의 실행 표지·종료 코드·출력 지문),
  // 한 실행은 한 업무의 증거로만 쓰는 표, 조사 주장(사실/해석·출처·인용)과 대조 결과, 보고의 판정 종류,
  // 개선 후보(완료 차단·증거 없음·대표 개입·거절). 후보는 기록일 뿐 규칙·권한을 바꾸지 않는다.
  `ALTER TABLE task_contracts ADD COLUMN confirmed_by TEXT;
   ALTER TABLE task_contracts ADD COLUMN confirmed_by_member_id TEXT;
   ALTER TABLE task_contracts ADD COLUMN confirmed_at TEXT;
   ALTER TABLE report_harness ADD COLUMN gate TEXT;
   ALTER TABLE report_harness ADD COLUMN evidence_status TEXT;
   ALTER TABLE report_checks ADD COLUMN exec_status TEXT;
   ALTER TABLE report_checks ADD COLUMN exec_ref TEXT;
   ALTER TABLE report_checks ADD COLUMN exec_exit INTEGER;
   ALTER TABLE report_checks ADD COLUMN exec_at TEXT;
   ALTER TABLE report_checks ADD COLUMN exec_output_sha TEXT;
   ALTER TABLE report_checks ADD COLUMN exec_command TEXT;
   CREATE TABLE harness_exec_refs (
     exec_ref TEXT PRIMARY KEY,
     message_id TEXT NOT NULL,
     contract_task_id TEXT,
     task_id TEXT,
     member_id TEXT NOT NULL,
     at TEXT NOT NULL
   );
   CREATE TABLE report_claims (
     message_id TEXT NOT NULL,
     idx INTEGER NOT NULL,
     text TEXT NOT NULL,
     basis TEXT NOT NULL,
     source TEXT,
     quote TEXT,
     criterion INTEGER,
     verified INTEGER NOT NULL DEFAULT 0,
     via TEXT,
     PRIMARY KEY (message_id, idx)
   );
   CREATE TABLE harness_findings (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     project_id TEXT NOT NULL,
     task_id TEXT,
     member_id TEXT,
     kind TEXT NOT NULL,
     detail TEXT NOT NULL,
     ref_type TEXT,
     ref_id TEXT,
     at TEXT NOT NULL
   );
   CREATE INDEX harness_findings_project ON harness_findings(project_id, at);
   CREATE INDEX harness_findings_task ON harness_findings(task_id, at);`,
  // v33: serve list metadata without walking large body/artifact overflow chains.
  `CREATE INDEX files_list_metadata ON files
    (project_id, sort_order DESC, id, title, who, member_id, summary, path, attachments, created_at, kind, task_id);`,
  // Stable keyset order and task-scoped metadata reads never fetch body/html overflow pages.
  `CREATE INDEX files_page_project ON files
    (project_id, sort_order DESC, id DESC, title, who, member_id, summary, path, attachments, created_at, kind, task_id);
   CREATE INDEX files_page_task ON files
    (project_id, task_id, sort_order DESC, id DESC, title, who, member_id, summary, path, attachments, created_at, kind);
   CREATE INDEX messages_task_page ON messages(project_id, task_id, at COLLATE BINARY DESC, id COLLATE BINARY DESC)
    WHERE task_id IS NOT NULL;`,
  // v35: a durable reservation becomes its result; large originals have one compressed owner.
  `ALTER TABLE agent_operation_receipts ADD COLUMN state TEXT NOT NULL DEFAULT 'completed' CHECK(state IN ('reserved','completed'));
   ALTER TABLE agent_operation_receipts ADD COLUMN result_kind TEXT NOT NULL DEFAULT 'json';
   ALTER TABLE agent_operation_receipts ADD COLUMN request_sha256 TEXT NOT NULL DEFAULT '';
   ALTER TABLE agent_operation_receipts ADD COLUMN updated_at TEXT;`,
  // v36: 업무 단계(대표 2026-11-17). 총괄의 단계 표시(검토 맡김·메인 합침·반영·완료·보류·다시 열기), 막힘 반복 감시(시작 시각·시도·지문은 재시작에도 남는다),
  // 완료 알림(완료 표시 하나에 하나), 진행판 항목이 가리키는 기존 업무. 단계 자체는 저장하지 않고 근거에서 다시 계산한다.
  `CREATE TABLE task_stage_marks (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     task_id TEXT NOT NULL,
     stage TEXT NOT NULL CHECK (stage IN ('review','merged','applied','done','hold','reopen')),
     evidence TEXT NOT NULL,
     member_id TEXT,
     who TEXT NOT NULL,
     at TEXT NOT NULL
   );
   CREATE INDEX task_stage_marks_task ON task_stage_marks(task_id, id);
   CREATE TABLE task_watch (
     task_id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     started_at TEXT NOT NULL,
     attempts INTEGER NOT NULL,
     same_count INTEGER NOT NULL,
     fingerprint TEXT NOT NULL,
     last_progress_at TEXT NOT NULL,
     tripped_at TEXT,
     trip_reason TEXT,
     notice_delivery_id TEXT,
     history_json TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX task_watch_project ON task_watch(project_id);
   CREATE TABLE task_notices (
     id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     task_id TEXT NOT NULL,
     mark_id INTEGER NOT NULL UNIQUE,
     lines_json TEXT NOT NULL,
     created_at TEXT NOT NULL,
     seen_at TEXT
   );
   CREATE INDEX task_notices_task ON task_notices(task_id, created_at);
   ALTER TABLE work ADD COLUMN task_id TEXT;`,
  // v37: adopt current queued/in-flight work, never turn all historical deliveries into prerequisites.
  `CREATE TABLE task_sequence (
     member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
     task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
     entered_at TEXT NOT NULL,
     PRIMARY KEY (member_id, task_id)
   );
   INSERT OR IGNORE INTO task_sequence(member_id, task_id, entered_at)
     SELECT d.member_id, d.task_id, MIN(d.created_at)
     FROM deliveries d LEFT JOIN delivery_recovery r ON r.delivery_id = d.id
     WHERE d.task_id IS NOT NULL AND d.wake = 1 AND d.kind IN ('instruction','user_message')
       AND d.status IN ('queued','held','delivering')
       AND (COALESCE(r.phase,'none') NOT IN ('stopped','resolved') OR
         (r.phase = 'resolved' AND r.reason = 'not_received' AND
           (SELECT x.transport_state FROM delivery_dispatches x JOIN delivery_dispatch_items i ON i.dispatch_id = x.id
             WHERE i.delivery_id = d.id ORDER BY x.created_at DESC, x.rowid DESC LIMIT 1) = 'rejected'))
     GROUP BY d.member_id, d.task_id;
   INSERT OR IGNORE INTO task_sequence(member_id, task_id, entered_at)
     SELECT e.member_id, d.task_id, MIN(d.created_at)
     FROM execution_journal e JOIN members m ON m.id = e.member_id
       JOIN json_each(e.delivery_ids_json) j JOIN deliveries d ON d.id = j.value
       LEFT JOIN delivery_recovery r ON r.delivery_id = d.id
     WHERE e.generation = m.session_generation AND e.ended_at IS NULL
       AND e.phase NOT IN ('ended','interrupted') AND d.task_id IS NOT NULL
       AND (d.status = 'delivered' OR COALESCE(r.phase,'none') NOT IN ('stopped','resolved') OR
         (r.phase = 'resolved' AND r.reason = 'not_received' AND
           (SELECT x.transport_state FROM delivery_dispatches x JOIN delivery_dispatch_items i ON i.dispatch_id = x.id
             WHERE i.delivery_id = d.id ORDER BY x.created_at DESC, x.rowid DESC LIMIT 1) = 'rejected'))
       AND e.rowid = (SELECT MAX(x.rowid) FROM execution_journal x WHERE x.member_id = e.member_id AND x.generation = e.generation)
     GROUP BY e.member_id, d.task_id;`,
  // v38: task completion survives the end of one CLI turn. Generated followups
  // and user stops have durable identities; source inputs are never replayed.
  `CREATE TABLE delivery_scope_sequence (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     delivery_id TEXT NOT NULL UNIQUE
   );
   ALTER TABLE deliveries ADD COLUMN scope_seq INTEGER NOT NULL DEFAULT 0;
   INSERT INTO delivery_scope_sequence(delivery_id) SELECT id FROM deliveries ORDER BY rowid;
   UPDATE deliveries SET scope_seq=(SELECT seq FROM delivery_scope_sequence WHERE delivery_id=deliveries.id);
   CREATE TRIGGER delivery_scope_sequence_insert AFTER INSERT ON deliveries BEGIN
     INSERT INTO delivery_scope_sequence(delivery_id) VALUES(NEW.id);
     UPDATE deliveries SET scope_seq=(SELECT seq FROM delivery_scope_sequence WHERE delivery_id=NEW.id) WHERE id=NEW.id;
   END;
   ALTER TABLE task_stage_marks ADD COLUMN source_seq INTEGER;
   CREATE TABLE task_continuations (
     task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
     project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     source_delivery_id TEXT,
     evidence_key TEXT NOT NULL DEFAULT '',
     delivery_id TEXT,
     round INTEGER NOT NULL DEFAULT 0,
     no_progress_count INTEGER NOT NULL DEFAULT 0,
     next_attempt_at TEXT,
     pause_token TEXT,
     pause_reason TEXT,
     paused_at TEXT,
     pause_source_seq INTEGER NOT NULL DEFAULT 0,
     pause_mark_seq INTEGER NOT NULL DEFAULT 0,
     attention_decision_id TEXT,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX task_continuations_project ON task_continuations(project_id, next_attempt_at);
   CREATE TABLE task_continuation_deliveries (
     delivery_id TEXT PRIMARY KEY REFERENCES deliveries(id) ON DELETE CASCADE,
     task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
     round INTEGER NOT NULL,
     created_at TEXT NOT NULL,
     retired_reason TEXT
   );
   CREATE INDEX task_continuation_deliveries_task ON task_continuation_deliveries(task_id, round);`,
  // v39: A workflow assignment is committed with its queue input. No pending external action is replayed.
  `CREATE TABLE workflow_assignment_receipts (
     operation_id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL,
     task_id TEXT NOT NULL,
     member_id TEXT NOT NULL,
     delivery_id TEXT NOT NULL,
     request_json TEXT NOT NULL,
     created_at TEXT NOT NULL
   );
   CREATE INDEX workflow_assignment_receipts_project ON workflow_assignment_receipts(project_id, created_at);`,
  // v40: independent project admission caps and durable owner escalation after
  // repeated task failures. No running execution or existing answer is changed.
  `ALTER TABLE projects ADD COLUMN max_concurrent_turns INTEGER DEFAULT NULL
     CHECK (max_concurrent_turns IS NULL OR (typeof(max_concurrent_turns) = 'integer' AND max_concurrent_turns BETWEEN 1 AND 64));
   CREATE TABLE task_failure_escalations (
     task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
     decision_id TEXT NOT NULL REFERENCES decisions(id),
     tripped_at TEXT NOT NULL,
     trigger_message_id TEXT,
     created_at TEXT NOT NULL
   );`,
  // v41: persistent CLI failure prevents automatic restart loops.
  `ALTER TABLE members ADD COLUMN execution_issue_json TEXT;`,
  // v42: Preserve the command independently from an optional explicit execution workdir.
  `ALTER TABLE report_checks ADD COLUMN workdir TEXT;`,
];

export function openDb(path: string, options: { migrationBackup?: boolean } = {}): Database {
  // 읽기/쓰기 연결은 close만으로도 남아 있던 WAL을 checkpoint할 수 있다.
  // 기존 DB의 버전 검사와 이주 전 백업은 읽기 전용 연결에서 끝내야 실패 시 원본이 그대로다.
  if (path !== ":memory:" && path !== "" && existsSync(path)) {
    let probe = new Database(path, { readonly: true });
    try {
      let current: number;
      try {
        current = supportedVersion(probe);
      } catch (error) {
        // WAL 모드 DB 파일만 복사·복원되어 -wal/-shm 이 없으면 읽기 전용 연결은 공유 메모리 파일을 만들지 못해
        // SQLITE_CANTOPEN 이 난다. 커밋 안 된 WAL 내용이 없을 때만 내용을 쓰지 않는 읽기/쓰기 연결로 다시 연다.
        if ((error as { code?: string }).code !== "SQLITE_CANTOPEN" || !walIsEmpty(path)) throw error;
        probe.close();
        probe = new Database(path, { readwrite: true, create: false });
        current = supportedVersion(probe);
      }
      probe.exec("PRAGMA busy_timeout = 5000");
      if (options.migrationBackup !== false && current < MIGRATIONS.length &&
          (current > 0 || probe.query("SELECT 1 FROM sqlite_schema LIMIT 1").get())) {
        const backup = `${path}.pre-v${current}-${Date.now()}-${randomBytes(4).toString("hex")}.bak`;
        try {
          // VACUUM INTO는 읽기 전용 원본에서도 commit된 WAL을 포함하는 독립 snapshot을 만든다.
          probe.query("VACUUM INTO ?").run(backup);
          chmodSync(backup, 0o600);
        } catch (e) {
          throw new Error(`마이그레이션 전 백업을 만들지 못했습니다. 원본은 변경하지 않았습니다: ${(e as Error).message}`);
        }
      }
    } finally { probe.close(); }
  }
  const db = new Database(path, { create: true });
  try {
    // 홈 배타 잠금은 호출자가 소유한다. 새/빈 DB를 포함해 실제 사용 연결에서도 재확인한다.
    supportedVersion(db);
    db.exec("PRAGMA busy_timeout = 5000");
    // 토큰과 대화가 들어 있다. 본인만 읽게 한다(폴더가 700 이어도 옮겨지면 소용없다).
    try {
      chmodSync(path, 0o600);
    } catch {
      // 메모리 DB 등. 권한을 걸 파일이 없다.
    }
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA synchronous = NORMAL");
    migrate(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function walIsEmpty(path: string): boolean {
  try {
    return statSync(`${path}-wal`).size === 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

function supportedVersion(db: Database): number {
  const { user_version: current } = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!;
  if (current > MIGRATIONS.length) {
    throw new Error(`지원하지 않는 미래 DB 스키마입니다 (DB v${current}, 지원 v${MIGRATIONS.length}). 호스트를 업데이트해 주세요.`);
  }
  if (current < 0) throw new Error(`잘못된 DB 스키마 버전입니다 (v${current}).`);
  // Independently deployed branches can claim the same version. Refuse their
  // incompatible layout before backup, WAL setup or any writable connection.
  if (current >= STORAGE_OPTIMIZATION_VERSION) {
    const columns = new Set(db.query<{ name: string }, []>("PRAGMA table_info(agent_operation_receipts)").all().map(row => row.name));
    if (["state", "result_kind", "request_sha256", "updated_at"].some(name => !columns.has(name))) {
      throw new Error(`DB 스키마 버전과 도구 기록 구조가 다릅니다 (v${current}). 적용한 소스 버전을 확인하세요.`);
    }
  }
  return current;
}

function migrate(db: Database): void {
  const { user_version: current } = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      if (v + 1 === STORAGE_OPTIMIZATION_VERSION) migrateStoredContent(db);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    })();
  }
}

export function newId(prefix: string): string {
  return prefix + randomBytes(9).toString("base64url").replace(/[-_]/g, "x");
}

export function nowIso(): string {
  return new Date().toISOString();
}
