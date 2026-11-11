CREATE TABLE IF NOT EXISTS google_calendar_connection (
  user_id INTEGER PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL UNIQUE,
  calendar_id_encrypted TEXT NOT NULL,
  refresh_token_encrypted TEXT,
  access_token_encrypted TEXT,
  token_expires_at INTEGER NOT NULL DEFAULT 0,
  sync_token_encrypted TEXT,
  status TEXT NOT NULL DEFAULT 'connected',
  last_sync_at INTEGER NOT NULL DEFAULT 0,
  next_sync_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_google_calendar_due ON google_calendar_connection(status, next_sync_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS google_calendar_oauth (
  state_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  verifier_encrypted TEXT NOT NULL,
  cookie_hash TEXT,
  purpose TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_google_calendar_oauth_expiry ON google_calendar_oauth(expires_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS google_calendar_event (
  user_id INTEGER NOT NULL REFERENCES google_calendar_connection(user_id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  task_id INTEGER REFERENCES task(id) ON DELETE SET NULL,
  local_hash TEXT NOT NULL DEFAULT '',
  etag TEXT,
  remote_updated TEXT,
  snapshot_encrypted TEXT,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, event_id),
  UNIQUE (user_id, task_id)
);
--> statement-breakpoint
ALTER TABLE task ADD COLUMN google_event_key TEXT;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_google_event_key ON task(google_event_key) WHERE google_event_key IS NOT NULL;
