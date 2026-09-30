CREATE TABLE `delegations` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_id` text NOT NULL,
	`child_id` text NOT NULL,
	`data` text NOT NULL,
	`status` text NOT NULL,
	`revision` integer NOT NULL,
	`attempt` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `delegations_parent` ON `delegations` (`parent_id`);--> statement-breakpoint
CREATE INDEX `delegations_child` ON `delegations` (`child_id`);