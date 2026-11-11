CREATE TABLE `message` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`message_type` text NOT NULL,
	`content_encrypted` text,
	`ai_response_encrypted` text,
	`parsed_tasks` text,
	`whatsapp_message_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_message_user_created` ON `message` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_message_type` ON `message` (`message_type`);--> statement-breakpoint
CREATE INDEX `idx_message_whatsapp_id` ON `message` (`whatsapp_message_id`);--> statement-breakpoint
CREATE INDEX `idx_message_created` ON `message` (`created_at`);--> statement-breakpoint
CREATE TABLE `task` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`description` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`due_date` integer,
	`reminder_date` integer,
	`reminder_sent` integer DEFAULT false,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_task_user_status` ON `task` (`user_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_task_user_created` ON `task` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_task_due_date` ON `task` (`due_date`);--> statement-breakpoint
CREATE INDEX `idx_task_status_due` ON `task` (`status`,`due_date`);--> statement-breakpoint
CREATE INDEX `idx_task_status` ON `task` (`status`);--> statement-breakpoint
CREATE INDEX `idx_task_created` ON `task` (`created_at`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`phone_number_encrypted` text NOT NULL,
	`phone_number_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_active` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_phone_number_hash_unique` ON `user` (`phone_number_hash`);--> statement-breakpoint
CREATE INDEX `idx_user_phone_hash` ON `user` (`phone_number_hash`);--> statement-breakpoint
CREATE INDEX `idx_user_created` ON `user` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_user_active` ON `user` (`last_active`);