-- Project removal preserves its exact directory memberships for task-history Restore.
ALTER TABLE `projects` ADD COLUMN `archived_at` text;
