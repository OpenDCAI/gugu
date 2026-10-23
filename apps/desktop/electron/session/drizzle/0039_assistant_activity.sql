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
--> statement-breakpoint
-- The project of every session this database has had, kept after the session is deleted so activity about a deleted
-- session still belongs to its project. A session never moves to another project, so the row written with the
-- session stays true. The trigger records sessions created by any path; the INSERT records those that exist now.
-- Owned by the activity journal: remove the table and trigger with it.
CREATE TABLE `activity_session_projects` (
  `session_id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `activity_session_projects` (`session_id`, `project_id`) SELECT `id`, `project_id` FROM `sessions`;
--> statement-breakpoint
CREATE TRIGGER `activity_session_projects_record` AFTER INSERT ON `sessions` BEGIN
  INSERT OR REPLACE INTO `activity_session_projects` (`session_id`, `project_id`) VALUES (NEW.`id`, NEW.`project_id`);
END;
