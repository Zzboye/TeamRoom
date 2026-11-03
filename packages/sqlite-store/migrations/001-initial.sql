CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE room_streams (room_id TEXT PRIMARY KEY, version INTEGER NOT NULL CHECK(version >= 0));
CREATE TABLE room_events (
  room_id TEXT NOT NULL REFERENCES room_streams(room_id), sequence INTEGER NOT NULL CHECK(sequence > 0),
  event_id TEXT NOT NULL UNIQUE, event_type TEXT NOT NULL, occurred_at TEXT NOT NULL,
  causation_id TEXT NOT NULL, schema_version INTEGER NOT NULL, event_json TEXT NOT NULL,
  PRIMARY KEY(room_id, sequence)
);
CREATE INDEX room_events_type ON room_events(room_id, event_type, sequence);
CREATE TABLE room_snapshots (
  room_id TEXT NOT NULL REFERENCES room_streams(room_id), last_sequence INTEGER NOT NULL CHECK(last_sequence > 0),
  schema_version INTEGER NOT NULL, snapshot_json TEXT NOT NULL, checksum TEXT NOT NULL,
  PRIMARY KEY(room_id, last_sequence)
);
CREATE TABLE persona_templates (template_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version > 0), template_json TEXT NOT NULL, PRIMARY KEY(template_id, version));
CREATE TABLE team_templates (template_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version > 0), template_json TEXT NOT NULL, PRIMARY KEY(template_id, version));
CREATE TABLE rooms (room_id TEXT PRIMARY KEY REFERENCES room_streams(room_id), status TEXT NOT NULL, room_json TEXT NOT NULL);
CREATE TABLE room_members (room_id TEXT NOT NULL REFERENCES room_streams(room_id), member_id TEXT NOT NULL, member_json TEXT NOT NULL, PRIMARY KEY(room_id, member_id));
CREATE TABLE messages (room_id TEXT NOT NULL REFERENCES room_streams(room_id), message_id TEXT NOT NULL, sequence INTEGER NOT NULL, message_json TEXT NOT NULL, PRIMARY KEY(room_id, message_id), UNIQUE(room_id, sequence));
CREATE TABLE message_links (room_id TEXT NOT NULL, message_id TEXT NOT NULL, position INTEGER NOT NULL, link_json TEXT NOT NULL, PRIMARY KEY(room_id, message_id, position), FOREIGN KEY(room_id, message_id) REFERENCES messages(room_id, message_id));
CREATE TABLE memory_items (room_id TEXT NOT NULL REFERENCES room_streams(room_id), memory_item_id TEXT NOT NULL, member_id TEXT NOT NULL, kind TEXT NOT NULL, item_json TEXT NOT NULL, PRIMARY KEY(room_id, memory_item_id));
CREATE INDEX memory_by_member ON memory_items(room_id, member_id);
CREATE TABLE runs (room_id TEXT NOT NULL REFERENCES room_streams(room_id), run_id TEXT NOT NULL, status TEXT NOT NULL, run_json TEXT NOT NULL, PRIMARY KEY(room_id, run_id));
CREATE TABLE actions (room_id TEXT NOT NULL, action_id TEXT NOT NULL, run_id TEXT NOT NULL, status TEXT NOT NULL, idempotency_key TEXT NOT NULL, action_json TEXT NOT NULL, PRIMARY KEY(room_id, action_id), UNIQUE(room_id, idempotency_key), FOREIGN KEY(room_id, run_id) REFERENCES runs(room_id, run_id));
CREATE INDEX actions_by_status ON actions(room_id, status);
CREATE TABLE candidate_results (room_id TEXT NOT NULL REFERENCES room_streams(room_id), candidate_id TEXT NOT NULL, candidate_json TEXT NOT NULL, PRIMARY KEY(room_id, candidate_id));
CREATE TABLE handoffs (room_id TEXT NOT NULL REFERENCES room_streams(room_id), handoff_id TEXT NOT NULL, event_sequence INTEGER NOT NULL, handoff_json TEXT NOT NULL, PRIMARY KEY(room_id, handoff_id));
