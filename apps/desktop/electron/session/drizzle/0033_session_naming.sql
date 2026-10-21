-- 名字层(PR-2,spec session-graph):库里的名字跟上代码的词 —— 会话就叫 session,harness 自己的会话 id 叫
-- provider_session_id。只改名字和存着的名字,行与值的意思一个不动。
--
-- 顺序要紧:先把 conversations.session_id(harness 的 id)改成 provider_session_id,再把别处的 conversation_id
-- 改成 session_id —— 任何时刻都没有一列同时装着两种意思。SQLite 的 ALTER TABLE RENAME 会顺带改写别的表里
-- 指着它的外键子句与索引里的列名;索引的**名字**不跟,所以下面按新名字重建。执行器在外键关着的事务里跑整批,
-- 提交前做 foreign_key_check(initialize.ts @@@foreign-keys-off)。
--
-- 搜索索引(search_index,FTS5)不在这里:它按版本号整张重建(initialize.ts ensureSearchIndex),版本号随本次升一档,
-- 重建时 item_type 写的就是新值。

-- 1. 会话表与它的列
ALTER TABLE `conversations` RENAME COLUMN `session_id` TO `provider_session_id`;
--> statement-breakpoint
ALTER TABLE `conversations` RENAME COLUMN `parent_conversation_id` TO `parent_session_id`;
--> statement-breakpoint
ALTER TABLE `conversations` RENAME COLUMN `spawned_by_conversation_id` TO `spawned_by_session_id`;
--> statement-breakpoint
ALTER TABLE `conversations` RENAME TO `sessions`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_conversations_workspace_id`;
--> statement-breakpoint
CREATE INDEX `idx_sessions_workspace_id` ON `sessions` (`workspace_id`);
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_conversations_parent_conversation_id`;
--> statement-breakpoint
CREATE INDEX `idx_sessions_parent_session_id` ON `sessions` (`parent_session_id`);
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_conversations_spawned_by_extension_id`;
--> statement-breakpoint
CREATE INDEX `idx_sessions_spawned_by_extension_id` ON `sessions` (`spawned_by_extension_id`);
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_conversations_spawned_by_conversation_id`;
--> statement-breakpoint
CREATE INDEX `idx_sessions_spawned_by_session_id` ON `sessions` (`spawned_by_session_id`);
--> statement-breakpoint

-- 2. 挂在会话上的表
ALTER TABLE `messages` RENAME COLUMN `conversation_id` TO `session_id`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_messages_conversation_id`;
--> statement-breakpoint
CREATE INDEX `idx_messages_session_id` ON `messages` (`session_id`);
--> statement-breakpoint
ALTER TABLE `conversation_turns` RENAME COLUMN `conversation_id` TO `session_id`;
--> statement-breakpoint
ALTER TABLE `conversation_turns` RENAME TO `session_turns`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_conversation_turns_conversation_seq`;
--> statement-breakpoint
CREATE INDEX `idx_session_turns_session_seq` ON `session_turns` (`session_id`,`seq`);
--> statement-breakpoint
ALTER TABLE `conversation_run_intervals` RENAME COLUMN `conversation_id` TO `session_id`;
--> statement-breakpoint
ALTER TABLE `conversation_run_intervals` RENAME TO `session_run_intervals`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_conversation_run_intervals_started_at`;
--> statement-breakpoint
CREATE INDEX `idx_session_run_intervals_started_at` ON `session_run_intervals` (`started_at`);
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_conversation_run_intervals_conversation_ended`;
--> statement-breakpoint
CREATE INDEX `idx_session_run_intervals_session_ended` ON `session_run_intervals` (`session_id`,`ended_at`);
--> statement-breakpoint
ALTER TABLE `conversation_model_sources` RENAME COLUMN `conversation_id` TO `session_id`;
--> statement-breakpoint
ALTER TABLE `conversation_model_sources` RENAME TO `session_model_sources`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_conversation_model_sources_conversation_started`;
--> statement-breakpoint
CREATE INDEX `idx_session_model_sources_session_started` ON `session_model_sources` (`session_id`,`started_at`);
--> statement-breakpoint
ALTER TABLE `usage_token_file_cache` RENAME COLUMN `session_id` TO `provider_session_id`;
--> statement-breakpoint

-- 3. 自动化:两份配置各叫它装的东西 —— 建会话的那份文档(名字、首轮、工作区)是 session_config,
--    要跑的 agent(提示词、引擎、模型、档位、审批)是 agent_config;运行记录里的快照同名。
ALTER TABLE `automations` RENAME COLUMN `task_config` TO `session_config`;
--> statement-breakpoint
ALTER TABLE `automations` RENAME COLUMN `conversation_config` TO `agent_config`;
--> statement-breakpoint
ALTER TABLE `automation_runs` RENAME COLUMN `task_config_snapshot` TO `session_config_snapshot`;
--> statement-breakpoint
ALTER TABLE `automation_runs` RENAME COLUMN `conversation_config_snapshot` TO `agent_config_snapshot`;
--> statement-breakpoint
-- 运行的三步各叫它在做的事:准备并建会话行 / 挂工作区 / 起 agent。存着的状态与错误里的 step 一起换。
UPDATE `automation_runs` SET `status` = CASE `status`
	WHEN 'creating_task' THEN 'creating_session'
	WHEN 'launching_task' THEN 'launching_session'
	WHEN 'creating_conversation' THEN 'starting_agent'
END
WHERE `status` IN ('creating_task', 'launching_task', 'creating_conversation');
--> statement-breakpoint
UPDATE `automation_runs` SET `error` = json_set(`error`, '$.step', CASE json_extract(`error`, '$.step')
	WHEN 'create_task' THEN 'create_session'
	WHEN 'launch_task' THEN 'launch_session'
	WHEN 'create_conversation' THEN 'start_agent'
END)
WHERE json_valid(`error`) AND json_extract(`error`, '$.step') IN ('create_task', 'launch_task', 'create_conversation');
--> statement-breakpoint

-- 4. 存着的键:设置行 `tasks`(新建会话那一组默认)叫 `sessions`;每条会话的平台模型选择换前缀。
--    JSON 里面的键名与值不在这里,在段 2(electron/migrations/session-naming):那些要按形状一层层改。
UPDATE `app_settings` SET `key` = 'sessions'
WHERE `key` = 'tasks' AND NOT EXISTS (SELECT 1 FROM `app_settings` WHERE `key` = 'sessions');
--> statement-breakpoint
UPDATE `kv` SET `key` = 'sessionpage-platform-model:' || substr(`key`, length('taskpage-platform-model:') + 1)
WHERE substr(`key`, 1, length('taskpage-platform-model:')) = 'taskpage-platform-model:';
