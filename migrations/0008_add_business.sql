CREATE TABLE `business_profile` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL REFERENCES `user`(`id`) ON DELETE CASCADE,
	`name_encrypted` text NOT NULL,
	`tax_id_encrypted` text NOT NULL,
	`tax_id_kind` text NOT NULL DEFAULT 'osek_morshe',
	`address_encrypted` text NOT NULL,
	`default_vat_rate` integer NOT NULL DEFAULT 18,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_biz_profile_user` ON `business_profile` (`user_id`);
--> statement-breakpoint
CREATE TABLE `business_customer` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL REFERENCES `user`(`id`) ON DELETE CASCADE,
	`name_hash` text NOT NULL,
	`name_encrypted` text NOT NULL,
	`tax_id_encrypted` text,
	`address_encrypted` text,
	`email_encrypted` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_biz_cust_user` ON `business_customer` (`user_id`);
--> statement-breakpoint
CREATE INDEX `idx_biz_cust_lookup` ON `business_customer` (`user_id`, `name_hash`);
--> statement-breakpoint
CREATE TABLE `document_counter` (
	`user_id` integer NOT NULL REFERENCES `user`(`id`) ON DELETE CASCADE,
	`doc_type` text NOT NULL,
	`year` integer NOT NULL,
	`next_seq` integer NOT NULL DEFAULT 1,
	PRIMARY KEY(`user_id`, `doc_type`, `year`)
);
--> statement-breakpoint
CREATE TABLE `business_document` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL REFERENCES `user`(`id`) ON DELETE CASCADE,
	`doc_type` text NOT NULL,
	`doc_number` text NOT NULL,
	`customer_id` integer REFERENCES `business_customer`(`id`) ON DELETE SET NULL,
	`customer_snapshot_encrypted` text NOT NULL,
	`lines_encrypted` text NOT NULL,
	`subtotal_agorot` integer NOT NULL,
	`vat_agorot` integer NOT NULL,
	`total_agorot` integer NOT NULL,
	`currency` text NOT NULL DEFAULT 'ILS',
	`r2_key` text NOT NULL,
	`whatsapp_media_id` text,
	`issued_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_biz_doc_user` ON `business_document` (`user_id`, `issued_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_biz_doc_number` ON `business_document` (`user_id`, `doc_type`, `doc_number`);
