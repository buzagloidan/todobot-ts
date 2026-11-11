ALTER TABLE `user` ADD COLUMN `api_token_encrypted` text;
--> statement-breakpoint
ALTER TABLE `user` ADD COLUMN `api_token_hash` text;
--> statement-breakpoint
ALTER TABLE `user` ADD COLUMN `api_token_created_at` integer;
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_user_api_token_hash` ON `user` (`api_token_hash`);
