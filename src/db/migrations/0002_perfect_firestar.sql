CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`node_id` text NOT NULL,
	`reason` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`resolved_at` text
);
