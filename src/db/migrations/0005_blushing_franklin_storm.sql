CREATE TABLE `memory` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`confidence` real,
	`node_id` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `nodes` ADD `runtime` text;