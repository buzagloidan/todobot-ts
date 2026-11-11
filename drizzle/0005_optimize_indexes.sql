-- Extend idx_task_user_status to include created_at so getUserTasks can satisfy
-- both the WHERE (user_id, status) filter and the ORDER BY created_at DESC with
-- a single index range scan instead of a separate in-memory sort.
DROP INDEX IF EXISTS `idx_task_user_status`;
--> statement-breakpoint
CREATE INDEX `idx_task_user_status` ON `task` (`user_id`, `status`, `created_at`);
--> statement-breakpoint

-- Composite index for message lookups by user + type. Makes getLastReminderMessageId
-- (WHERE user_id=? AND message_type='reminder' ORDER BY created_at DESC LIMIT 1) O(1).
-- Also speeds up getConversationHistory for the text/audio OR branches.
CREATE INDEX `idx_message_user_type_created` ON `message` (`user_id`, `message_type`, `created_at`);
--> statement-breakpoint

-- Drop low-selectivity single-column indexes. They add a write penalty on every
-- task/message insert but are never chosen as the primary filter (4-5 possible values).
DROP INDEX IF EXISTS `idx_task_status`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_message_type`;
