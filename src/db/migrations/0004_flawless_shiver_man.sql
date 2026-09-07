CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`node_id` text NOT NULL,
	`kind` text NOT NULL,
	`path` text,
	`summary` text NOT NULL,
	`event_id` integer,
	`created_at` text NOT NULL
);
