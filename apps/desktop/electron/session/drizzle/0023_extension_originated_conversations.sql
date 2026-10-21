ALTER TABLE `conversations` ADD `spawned_by_extension_id` text;--> statement-breakpoint
CREATE INDEX `idx_conversations_spawned_by_extension_id` ON `conversations` (`spawned_by_extension_id`);