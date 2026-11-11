CREATE TABLE `board` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `user_id` integer NOT NULL REFERENCES `user`(`id`) ON DELETE CASCADE,
  `name_encrypted` text NOT NULL,
  `columns_encrypted` text NOT NULL,
  `rows_encrypted` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_board_user_unique` ON `board` (`user_id`);
