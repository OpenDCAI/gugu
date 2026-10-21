ALTER TABLE `conversations` ADD `parent_conversation_id` text REFERENCES conversations(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `conversations` ADD `spawned_by_conversation_id` text REFERENCES conversations(id) ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX `idx_conversations_parent_conversation_id` ON `conversations` (`parent_conversation_id`);--> statement-breakpoint
CREATE INDEX `idx_conversations_spawned_by_conversation_id` ON `conversations` (`spawned_by_conversation_id`);--> statement-breakpoint
/*
 SQLite does not support "Creating foreign key on existing column" out of the box, we do not generate automatic migration for that, so it has to be done manually
 Please refer to: https://www.techonthenet.com/sqlite/tables/alter_table.php
                  https://www.sqlite.org/lang_altertable.html

 Due to that we don't generate migration automatically and it has to be done manually
*/
