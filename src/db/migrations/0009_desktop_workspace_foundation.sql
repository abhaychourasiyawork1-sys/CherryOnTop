CREATE TABLE `workspaces` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `description` text DEFAULT '' NOT NULL,
  `settings` text NOT NULL,
  `status` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `projects` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `name` text NOT NULL,
  `description` text DEFAULT '' NOT NULL,
  `settings` text NOT NULL,
  `status` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `projects_workspace_updated_idx` ON `projects` (`workspace_id`,`updated_at`);
--> statement-breakpoint
CREATE TABLE `conversations` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `project_id` text,
  `title` text NOT NULL,
  `status` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `conversations_project_updated_idx` ON `conversations` (`project_id`,`updated_at`);
--> statement-breakpoint
CREATE TABLE `runs` (
  `id` text PRIMARY KEY NOT NULL,
  `conversation_id` text NOT NULL,
  `case_id` text NOT NULL,
  `goal` text NOT NULL,
  `status` text NOT NULL,
  `mandate_snapshot` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `runs_conversation_updated_idx` ON `runs` (`conversation_id`,`updated_at`);
