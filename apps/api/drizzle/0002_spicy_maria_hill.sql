CREATE TABLE `dispatch_leases` (
	`name` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `processed_jobs_time_idx` ON `processed_jobs` (`processed_at`);