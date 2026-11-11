-- Normalize legacy rows so the reminder query can use a small partial index.
UPDATE `task` SET `reminder_sent` = 0 WHERE `reminder_sent` IS NULL;
--> statement-breakpoint

-- Only index tasks that are eligible for reminder delivery. Sent reminders stay
-- pending until the user completes them, so including them made the minute cron
-- scan an ever-growing history of already-delivered tasks.
CREATE INDEX IF NOT EXISTS `idx_task_pending_unsent_due`
ON `task` (`due_date`, `id`)
WHERE `status` = 'pending' AND `reminder_sent` = 0;
