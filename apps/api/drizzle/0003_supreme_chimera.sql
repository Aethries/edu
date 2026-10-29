CREATE TABLE `failed_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`message_id` text NOT NULL,
	`body` text NOT NULL,
	`reason` text NOT NULL,
	`attempts` integer NOT NULL,
	`failed_at` integer NOT NULL
);
--> statement-breakpoint
DROP INDEX `outbox_unsent_idx`;--> statement-breakpoint
ALTER TABLE `outbox` ADD `attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `outbox` ADD `last_error` text;--> statement-breakpoint
ALTER TABLE `outbox` ADD `next_attempt_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `outbox` ADD `quarantined_at` integer;--> statement-breakpoint
CREATE INDEX `outbox_pending_idx` ON `outbox` (`sent_at`,`quarantined_at`,`next_attempt_at`,`created_at`);