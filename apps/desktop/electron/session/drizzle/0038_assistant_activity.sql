CREATE TABLE `activity_events` (
  `seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `event_id` text NOT NULL UNIQUE,
  `occurred_at` integer,
  `observed_at` integer NOT NULL,
  `kind` text NOT NULL,
  `session_id` text,
  `project_id` text,
  `data` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `activity_events_time` ON `activity_events` (`occurred_at`, `seq`);
--> statement-breakpoint
CREATE INDEX `activity_events_session` ON `activity_events` (`session_id`, `seq`);
--> statement-breakpoint
CREATE INDEX `activity_events_project` ON `activity_events` (`project_id`, `seq`);
--> statement-breakpoint
CREATE TABLE `activity_coverage` (
  `id` text PRIMARY KEY NOT NULL,
  `started_at` integer NOT NULL,
  `last_seen_at` integer NOT NULL,
  `ended_at` integer
);
