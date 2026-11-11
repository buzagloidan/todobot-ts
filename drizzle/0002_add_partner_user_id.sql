ALTER TABLE `user` ADD COLUMN `partner_user_id` integer REFERENCES `user`(`id`) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX `idx_user_partner` ON `user` (`partner_user_id`);
