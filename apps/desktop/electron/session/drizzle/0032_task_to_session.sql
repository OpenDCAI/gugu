-- task → session(spec session-graph):task 只是包在单条会话外面的壳,它身上还在用的四样(工作区、关联 issue、
-- 自动化运行、standalone)搬到会话上,然后删掉 task。新代码不认识 task;旧模型的知识只留在这个文件和
-- `electron/migrations/task-to-session/`(段 2:库外的 tmux 名、名册缓存、无主附件文件),两处只靠 `legacy_task_map`
-- 与 `legacy_task_orphans` 两张交接表联系,段 2 用完即删。
--
-- 执行器在外键关着的事务里跑整批,提交前做 foreign_key_check(initialize.ts @@@foreign-keys-off):下面重建
-- `conversations` 时,指着它的 messages / conversation_turns 不会被 DROP 的隐式 DELETE 连带删光。
--
-- 一个 task 的「代表会话」:有 is_initial_conversation=1 的取它,否则取最近交互的那条。task 名下的终端、附件、
-- 视图状态都归给代表会话。#5665 之前一个 task 挂多条会话的老数据,每条会话各自成为独立 session,共享原工作区。

-- 1. 交接表。session_id 为 NULL 的行 = 名下一条会话都没有的 task(它的终端、附件、视图状态见 1b)。
CREATE TABLE `legacy_task_map` AS
SELECT
	t.`id` AS `task_id`,
	t.`project_id` AS `project_id`,
	t.`type` AS `task_type`,
	c.`id` AS `session_id`,
	CASE WHEN c.`id` IS NULL THEN 0 ELSE c.`scope_rank` = 1 END AS `is_scope_owner`
FROM `tasks` t
LEFT JOIN (
	SELECT `id`, `task_id`, ROW_NUMBER() OVER (
		PARTITION BY `task_id`
		ORDER BY coalesce(`is_initial_conversation`, 0) DESC,
			coalesce(`last_interacted_at`, `updated_at`, `created_at`) DESC,
			`id`
	) AS `scope_rank`
	FROM `conversations`
) c ON c.`task_id` = t.`id`;
--> statement-breakpoint
CREATE INDEX `idx_legacy_task_map_task_id` ON `legacy_task_map` (`task_id`);
--> statement-breakpoint

-- 1b. 名下一条会话都没有的 task:它的终端、附件、视图状态没有会话可归(三者都要一个会话 id)。先把它们逐行记进
--     第二张交接表,下面重建时它们随 task 消失;段 2 读这张表计数写进摘要,把 origin='copy' 的附件文件挪进
--     迁移目录留着(❌ 删),然后和 legacy_task_map 一起 DROP。`ref` = 终端 id / 附件 id / kv 键。
CREATE TABLE `legacy_task_orphans` (
	`task_id` text NOT NULL,
	`kind` text NOT NULL,
	`ref` text NOT NULL,
	`stored_path` text,
	`origin` text
);
--> statement-breakpoint
INSERT INTO `legacy_task_orphans` (`task_id`, `kind`, `ref`, `stored_path`, `origin`)
SELECT x.`task_id`, 'terminal', x.`id`, NULL, NULL
FROM `terminals` x JOIN `legacy_task_map` m ON m.`task_id` = x.`task_id` AND m.`session_id` IS NULL
UNION ALL
SELECT a.`task_id`, 'attachment', a.`id`, a.`stored_path`, a.`origin`
FROM `task_attachments` a JOIN `legacy_task_map` m ON m.`task_id` = a.`task_id` AND m.`session_id` IS NULL
UNION ALL
SELECT m.`task_id`, 'kv', k.`key`, NULL, NULL
FROM `kv` k JOIN `legacy_task_map` m
	ON m.`session_id` IS NULL
	AND (k.`key` = 'view-state:task:' || m.`task_id` OR k.`key` = 'view-state:task:' || m.`task_id` || ':tabs')
UNION ALL
-- task 早就删了、视图状态却还留着的键(老版本删 task 时没清;owner 库实测有):同样记下来,不悄悄丢。
SELECT replace(replace(k.`key`, 'view-state:task:', ''), ':tabs', ''), 'kv', k.`key`, NULL, NULL
FROM `kv` k
WHERE k.`key` LIKE 'view-state:task:%'
	AND NOT EXISTS (SELECT 1 FROM `legacy_task_map` m
		WHERE k.`key` IN ('view-state:task:' || m.`task_id`, 'view-state:task:' || m.`task_id` || ':tabs'));
--> statement-breakpoint

-- 2. 会话:去掉 task_id / is_initial_conversation,带上 task 的工作区、关联 issue、自动化运行。
CREATE TABLE `__new_conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`provider` text,
	`config` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`last_interacted_at` text,
	`session_id` text,
	`agent_status` text,
	`agent_status_seen` integer DEFAULT 1,
	`agent_status_detail` text,
	`runtime` text,
	`is_pinned` integer DEFAULT 0 NOT NULL,
	`parent_conversation_id` text,
	`spawned_by_extension_id` text,
	`spawned_by_conversation_id` text,
	`archived_at` text,
	`workspace_id` text,
	`linked_issue` text,
	`automation_run_id` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`spawned_by_conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`automation_run_id`) REFERENCES `automation_runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_conversations` (
	`id`, `project_id`, `title`, `provider`, `config`, `created_at`, `updated_at`, `last_interacted_at`,
	`session_id`, `agent_status`, `agent_status_seen`, `agent_status_detail`, `runtime`, `is_pinned`,
	`parent_conversation_id`, `spawned_by_extension_id`, `spawned_by_conversation_id`, `archived_at`,
	`workspace_id`, `linked_issue`, `automation_run_id`
)
SELECT
	c.`id`, c.`project_id`, c.`title`, c.`provider`, c.`config`, c.`created_at`, c.`updated_at`, c.`last_interacted_at`,
	c.`session_id`, c.`agent_status`, c.`agent_status_seen`, c.`agent_status_detail`, c.`runtime`, c.`is_pinned`,
	c.`parent_conversation_id`, c.`spawned_by_extension_id`, c.`spawned_by_conversation_id`, c.`archived_at`,
	t.`workspace_id`, t.`linked_issue`,
	-- tasks.automation_run_id 从来没有外键:指向已删运行的值在这里变成 NULL,而不是变成一条新违例。
	(SELECT r.`id` FROM `automation_runs` r WHERE r.`id` = t.`automation_run_id`)
FROM `conversations` c
JOIN `tasks` t ON t.`id` = c.`task_id`;
--> statement-breakpoint
DROP TABLE `conversations`;
--> statement-breakpoint
ALTER TABLE `__new_conversations` RENAME TO `conversations`;
--> statement-breakpoint
CREATE INDEX `idx_conversations_parent_conversation_id` ON `conversations` (`parent_conversation_id`);
--> statement-breakpoint
CREATE INDEX `idx_conversations_spawned_by_conversation_id` ON `conversations` (`spawned_by_conversation_id`);
--> statement-breakpoint
CREATE INDEX `idx_conversations_spawned_by_extension_id` ON `conversations` (`spawned_by_extension_id`);
--> statement-breakpoint
CREATE INDEX `idx_conversations_workspace_id` ON `conversations` (`workspace_id`);
--> statement-breakpoint

-- 3. 终端归给代表会话。
CREATE TABLE `__new_terminals` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`session_id` text NOT NULL,
	`ssh` integer DEFAULT 0 NOT NULL,
	`name` text NOT NULL,
	`shell_id` text DEFAULT 'system' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_terminals` (`id`, `project_id`, `session_id`, `ssh`, `name`, `shell_id`, `created_at`, `updated_at`)
SELECT x.`id`, x.`project_id`, m.`session_id`, x.`ssh`, x.`name`, x.`shell_id`, x.`created_at`, x.`updated_at`
FROM `terminals` x
JOIN `legacy_task_map` m ON m.`task_id` = x.`task_id` AND m.`is_scope_owner` = 1;
--> statement-breakpoint
DROP TABLE `terminals`;
--> statement-breakpoint
ALTER TABLE `__new_terminals` RENAME TO `terminals`;
--> statement-breakpoint
CREATE INDEX `idx_terminals_session_id` ON `terminals` (`session_id`);
--> statement-breakpoint

-- 4. 附件归给代表会话。stored_path 是绝对路径,文件不搬(读的时候只认这一列)。
CREATE TABLE `session_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`name` text NOT NULL,
	`mime_type` text,
	`size` integer NOT NULL,
	`stored_path` text NOT NULL,
	`original_path` text,
	`origin` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `session_attachments` (`id`, `session_id`, `name`, `mime_type`, `size`, `stored_path`, `original_path`, `origin`, `created_at`)
SELECT a.`id`, m.`session_id`, a.`name`, a.`mime_type`, a.`size`, a.`stored_path`, a.`original_path`, a.`origin`, a.`created_at`
FROM `task_attachments` a
JOIN `legacy_task_map` m ON m.`task_id` = a.`task_id` AND m.`is_scope_owner` = 1;
--> statement-breakpoint
DROP TABLE `task_attachments`;
--> statement-breakpoint
CREATE INDEX `idx_session_attachments_session_id` ON `session_attachments` (`session_id`);
--> statement-breakpoint

-- 5. 视图状态。按 task 记的两条键归给代表会话;页签里 review 页签带的那个 task id 跟着换。
--    值是 JSON.stringify 的产物(无空白),`"taskId":"<id>"` 逐字出现。
INSERT OR REPLACE INTO `kv` (`key`, `value`, `updated_at`)
SELECT
	'view-state:session:' || m.`session_id` || substr(k.`key`, length('view-state:task:' || m.`task_id`) + 1),
	replace(k.`value`, '"taskId":"' || m.`task_id` || '"', '"sessionId":"' || m.`session_id` || '"'),
	k.`updated_at`
FROM `kv` k
JOIN `legacy_task_map` m
	ON m.`is_scope_owner` = 1
	AND (k.`key` = 'view-state:task:' || m.`task_id` OR k.`key` = 'view-state:task:' || m.`task_id` || ':tabs');
--> statement-breakpoint
DELETE FROM `kv` WHERE `key` LIKE 'view-state:task:%';
--> statement-breakpoint
-- 上次停在的视图:`task` 视图 {projectId, taskId, …} → `session` 视图 {projectId, sessionId, …}。那个 task 名下
-- 没有会话时,`task` 参数整个删掉、停在 `task` 视图上的退回 `home`(持久化状态里 ❌ 留 null)。
UPDATE `kv` SET `value` = CASE
	WHEN (SELECT m.`session_id` FROM `legacy_task_map` m
		WHERE m.`task_id` = json_extract(`kv`.`value`, '$.viewParams.task.taskId') AND m.`is_scope_owner` = 1) IS NULL
	THEN json_remove(`kv`.`value`, '$.viewParams.task')
	ELSE json_set(
		json_remove(`kv`.`value`, '$.viewParams.task'),
		'$.viewParams.session',
		json_set(
			json_remove(json_extract(`kv`.`value`, '$.viewParams.task'), '$.taskId'),
			'$.sessionId',
			(SELECT m.`session_id` FROM `legacy_task_map` m
				WHERE m.`task_id` = json_extract(`kv`.`value`, '$.viewParams.task.taskId') AND m.`is_scope_owner` = 1)
		)
	)
END
WHERE `key` = 'view-state:navigation' AND json_type(`value`, '$.viewParams.task') = 'object';
--> statement-breakpoint
UPDATE `kv` SET `value` = json_set(`value`, '$.currentViewId',
	CASE WHEN json_type(`value`, '$.viewParams.session') = 'object' THEN 'session' ELSE 'home' END)
WHERE `key` = 'view-state:navigation' AND json_extract(`value`, '$.currentViewId') = 'task';
--> statement-breakpoint
-- 侧栏手排顺序:每个 task 展开成它名下的会话(代表会话在前),顺序照旧。
UPDATE `kv` SET `value` = json_set(
	json_remove(`value`, '$.taskOrderByProject'),
	'$.sessionOrderByProject',
	json((
		SELECT json_group_object(p.`key`, json((
			SELECT json_group_array(m.`session_id` ORDER BY CAST(t.`key` AS integer), m.`is_scope_owner` DESC, m.`session_id`)
			FROM json_each(p.`value`) t
			JOIN `legacy_task_map` m ON m.`task_id` = t.`value` AND m.`session_id` IS NOT NULL
		)))
		FROM json_each(`kv`.`value`, '$.taskOrderByProject') p
	))
)
WHERE `key` = 'view-state:sidebar' AND json_type(`value`, '$.taskOrderByProject') = 'object';
--> statement-breakpoint

-- 6. 自动化运行:建出来的那个 task 的时间和名字,现在是那条会话的。
ALTER TABLE `automation_runs` RENAME COLUMN `task_created_at` TO `session_created_at`;
--> statement-breakpoint
ALTER TABLE `automation_runs` RENAME COLUMN `generated_task_name` TO `generated_session_name`;
--> statement-breakpoint

-- 7. task 本体。
DROP TABLE `tasks`;
