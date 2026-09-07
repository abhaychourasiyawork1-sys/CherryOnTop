CREATE TABLE `dod_items` (
	`id` text PRIMARY KEY NOT NULL,
	`node_id` text NOT NULL,
	`text` text NOT NULL,
	`state` text NOT NULL,
	`artifact_id` text,
	`event_id` integer,
	`note` text,
	`checked_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mandates` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`authority` text NOT NULL,
	`constraints` text NOT NULL,
	`builtin` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `events` ADD `prev_hash` text;--> statement-breakpoint
ALTER TABLE `events` ADD `hash` text;--> statement-breakpoint
ALTER TABLE `nodes` ADD `mandate_id` text;--> statement-breakpoint
ALTER TABLE `nodes` ADD `snapshot` text;