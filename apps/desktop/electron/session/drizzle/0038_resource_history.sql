CREATE TABLE `resource_history` (
 `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
 `timestamp` integer NOT NULL,
 `run_id` text NOT NULL,
 `cpu` real,
 `memory` integer,
 `bytes` integer NOT NULL,
 `snapshot` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `resource_history_meta` (`discarded` integer NOT NULL);
--> statement-breakpoint
INSERT INTO `resource_history_meta` VALUES (0);
