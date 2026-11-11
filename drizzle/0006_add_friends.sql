CREATE TABLE `friend_link` (
  `user_id` integer NOT NULL REFERENCES `user`(`id`) ON DELETE CASCADE,
  `friend_user_id` integer NOT NULL REFERENCES `user`(`id`) ON DELETE CASCADE,
  `nickname` text NOT NULL,
  `created_at` integer NOT NULL,
  PRIMARY KEY (`user_id`, `friend_user_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_friend_link_user` ON `friend_link` (`user_id`);
--> statement-breakpoint
CREATE TABLE `task_assignee` (
  `task_id` integer NOT NULL REFERENCES `task`(`id`) ON DELETE CASCADE,
  `assignee_user_id` integer NOT NULL REFERENCES `user`(`id`) ON DELETE CASCADE,
  PRIMARY KEY (`task_id`, `assignee_user_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_task_assignee_user` ON `task_assignee` (`assignee_user_id`);
