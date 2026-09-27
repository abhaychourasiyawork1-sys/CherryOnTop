CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`repo_path` text,
	`title` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `nodes` ADD `session_id` text;