-- 已批准权益的自动条款更新（2026-11-24 管理员授权第一、二档）：同一官方页面重读时的延期、提前结束与模型减少。
-- 只记录排队、应用与管理员撤销；发布仍走既有身份版本与批准守卫。
CREATE TABLE auto_term_updates (
  id TEXT PRIMARY KEY NOT NULL,
  entity_id TEXT NOT NULL REFERENCES benefit_entities(id),
  offer_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL UNIQUE REFERENCES intake_candidates(id),
  base_version_id TEXT NOT NULL,
  kinds_json TEXT NOT NULL CHECK(json_valid(kinds_json)),
  fields_json TEXT NOT NULL CHECK(json_valid(fields_json)),
  previous_json TEXT NOT NULL CHECK(json_valid(previous_json)),
  state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','applied','skipped','failed','undone')),
  detail TEXT,
  decision_id TEXT,
  owner_actor TEXT,
  owner_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  applied_at TEXT
);
CREATE INDEX auto_term_updates_state ON auto_term_updates(state, created_at);
CREATE INDEX auto_term_updates_entity ON auto_term_updates(entity_id, state);
