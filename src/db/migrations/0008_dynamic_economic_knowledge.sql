CREATE TABLE `evidence_conflicts` (
	`id` text PRIMARY KEY NOT NULL,
	`evidence_ids` text NOT NULL,
	`reason` text NOT NULL,
	`severity` text NOT NULL,
	`resolved` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `knowledge` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`content` text NOT NULL,
	`repository` text NOT NULL,
	`revision` text NOT NULL,
	`source_paths` text NOT NULL,
	`source_symbols` text NOT NULL,
	`confidence` real NOT NULL,
	`validated` integer DEFAULT false NOT NULL,
	`supersedes` text,
	`invalidated_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `knowledge_repo_revision` ON `knowledge` (`repository`,`revision`);--> statement-breakpoint
CREATE INDEX `knowledge_repo_kind` ON `knowledge` (`repository`,`kind`);