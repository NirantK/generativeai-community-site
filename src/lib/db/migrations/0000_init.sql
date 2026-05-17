CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`role` text NOT NULL,
	`company` text NOT NULL,
	`location` text NOT NULL,
	`comp` text,
	`apply_web` text NOT NULL,
	`apply_api` text,
	`contact_email` text NOT NULL,
	`blurb` text NOT NULL,
	`user_id` text,
	`status` text DEFAULT 'pending_payment' NOT NULL,
	`posted_at` integer,
	`stripe_session_id` text,
	`wa_status` text DEFAULT 'pending' NOT NULL,
	`wa_posted_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_jobs_live` ON `jobs` (`status`,`posted_at`);--> statement-breakpoint
CREATE INDEX `idx_jobs_user` ON `jobs` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_jobs_stripe_session` ON `jobs` (`stripe_session_id`);--> statement-breakpoint
CREATE TABLE `payments` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text,
	`amount_cents` integer NOT NULL,
	`currency` text NOT NULL,
	`email` text NOT NULL,
	`created_at` integer NOT NULL,
	`raw_event` text NOT NULL
);
