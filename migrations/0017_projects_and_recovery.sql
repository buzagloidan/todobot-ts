CREATE TABLE project (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  name_encrypted TEXT NOT NULL, name_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id,name_hash)
);
--> statement-breakpoint
ALTER TABLE task ADD COLUMN project_id INTEGER REFERENCES project(id) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX idx_task_project ON task(project_id,status,created_at);
--> statement-breakpoint
DROP TRIGGER task_revision;
--> statement-breakpoint
CREATE TRIGGER task_revision AFTER UPDATE ON task
WHEN NEW.revision = OLD.revision AND (
  NEW.description IS NOT OLD.description OR NEW.due_date IS NOT OLD.due_date OR
  NEW.status IS NOT OLD.status OR NEW.recurrence IS NOT OLD.recurrence OR
  NEW.completed_at IS NOT OLD.completed_at OR NEW.user_id IS NOT OLD.user_id OR
  NEW.project_id IS NOT OLD.project_id)
BEGIN UPDATE task SET revision = OLD.revision + 1 WHERE id = NEW.id; END;
--> statement-breakpoint
CREATE TABLE task_recovery (
  actor_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  task_id INTEGER NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL, reviewed_at INTEGER NOT NULL,
  PRIMARY KEY(actor_id,task_id)
);
--> statement-breakpoint
CREATE TABLE recovery_pending (
  actor_id INTEGER PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  task_id INTEGER NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
