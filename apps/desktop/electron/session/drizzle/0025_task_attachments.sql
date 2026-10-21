-- #5269 输入框附件:字节存一份在我们自己的地盘,消息里不再长期指着 $TMPDIR 里的临时文件。
-- `origin` = 'copy'(文件归这一行所有,任务删了跟着删) | 'reference'(指向用户自己的文件,不拥有)。
CREATE TABLE `task_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`name` text NOT NULL,
	`mime_type` text,
	`size` integer NOT NULL,
	`stored_path` text NOT NULL,
	`origin` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_task_attachments_task_id` ON `task_attachments` (`task_id`);
