CREATE TABLE `memberships` (
	`organization_id` text NOT NULL,
	`subject` text NOT NULL,
	`role` text NOT NULL,
	PRIMARY KEY(`organization_id`, `subject`)
);
--> statement-breakpoint
CREATE TABLE `outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	`sent_at` integer
);
--> statement-breakpoint
CREATE INDEX `outbox_unsent_idx` ON `outbox` (`sent_at`,`created_at`);--> statement-breakpoint
CREATE TABLE `processed_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`processed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `realtime_tickets` (
	`hash` text PRIMARY KEY NOT NULL,
	`subject` text NOT NULL,
	`organization_id` text NOT NULL,
	`origin` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `realtime_tickets_expiry_idx` ON `realtime_tickets` (`expires_at`);