CREATE TABLE reminder_job (
  id TEXT PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  owner_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL, due_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'ready', attempt INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0,
  nonce TEXT, next_task_id INTEGER, created_at INTEGER NOT NULL, accepted_at INTEGER,
  UNIQUE(task_id, revision, due_at)
);
--> statement-breakpoint
CREATE INDEX idx_reminder_job_owner ON reminder_job(owner_id, state, next_attempt_at);
--> statement-breakpoint
CREATE INDEX idx_reminder_job_cleanup ON reminder_job(created_at) WHERE state IN ('done','stale');
--> statement-breakpoint
CREATE TABLE reminder_delivery (
  job_id TEXT NOT NULL REFERENCES reminder_job(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'pending', whatsapp_id TEXT,
  error_code INTEGER, delivery_status TEXT, updated_at INTEGER NOT NULL,
  PRIMARY KEY(job_id, user_id)
);
