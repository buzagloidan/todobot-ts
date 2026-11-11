CREATE TABLE IF NOT EXISTS task_schedule_pending (
  actor_id INTEGER PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  task_id INTEGER NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  prompt_message_id TEXT,
  expires_at INTEGER NOT NULL
);
