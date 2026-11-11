ALTER TABLE task ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE TRIGGER task_revision AFTER UPDATE ON task
WHEN NEW.revision = OLD.revision AND (
  NEW.description IS NOT OLD.description OR NEW.due_date IS NOT OLD.due_date OR
  NEW.status IS NOT OLD.status OR NEW.recurrence IS NOT OLD.recurrence OR
  NEW.completed_at IS NOT OLD.completed_at OR NEW.user_id IS NOT OLD.user_id)
BEGIN UPDATE task SET revision = OLD.revision + 1 WHERE id = NEW.id; END;
--> statement-breakpoint
CREATE TABLE task_undo (
  id TEXT PRIMARY KEY, actor_user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, claim_nonce TEXT
);
--> statement-breakpoint
CREATE INDEX idx_task_undo_actor ON task_undo(actor_user_id, created_at);
--> statement-breakpoint
CREATE TABLE task_control_use (
  key TEXT PRIMARY KEY, actor_user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE task_undo_change (
  group_id TEXT NOT NULL REFERENCES task_undo(id) ON DELETE CASCADE,
  task_id INTEGER NOT NULL,
  before_encrypted TEXT, after_revision INTEGER NOT NULL,
  PRIMARY KEY(group_id, task_id)
);
--> statement-breakpoint
CREATE TABLE agenda_preferences (
  user_id INTEGER PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0, time TEXT NOT NULL DEFAULT '08:00',
  days TEXT NOT NULL DEFAULT 'daily', next_send_at INTEGER NOT NULL DEFAULT 0,
  last_sent_date TEXT, revision INTEGER NOT NULL DEFAULT 0, last_error TEXT
);
--> statement-breakpoint
CREATE INDEX idx_agenda_due ON agenda_preferences(enabled, next_send_at);
--> statement-breakpoint
CREATE TABLE agenda_priority (
  user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  local_date TEXT NOT NULL, task_id INTEGER NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  PRIMARY KEY(user_id, local_date, task_id)
);
