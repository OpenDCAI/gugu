-- #6334 用量页(product spec)的本机底账。
--
-- `conversation_run_intervals`:一条会话处于「在干活」(agent_status = working / needs_approval)的一段时间一行。
-- 用量页的「运行时长」「并行时长」「峰值并发」都从这里算 —— 状态列只记得「现在」,记不得「那天几点到几点」。
-- 时间一律 epoch 毫秒;`ended_at` 为 null = 还开着。`last_seen_at` 是主进程每分钟盖的心跳:
-- 进程被强杀时来不及收口,下次开机按它收(= 最后一次确认它还在跑的时刻),❌ 不按开机时刻收(那会把关机那段算成在跑)。
-- ❌ 不挂外键:会话删了,那天它跑过的时长仍是那天的事实,用量不能跟着删而倒退。provider 因此冗余存一份。
--
-- `usage_token_file_cache`:各家 CLI 的日志文件(claude 的 projects/*.jsonl、codex 的 rollout-*.jsonl)解析结果缓存。
-- 以路径为键,size + mtime 没变就不再读;只长不改的文件从上次读到的字节处接着读(`data` 里带着偏移与解析状态)。
--
-- ⚠️ IF NOT EXISTS 与回填的 NOT EXISTS 闸同 0028 的理由:分支迁移的编号由 dev 定,追 dev 时可能改号重跑。
CREATE TABLE IF NOT EXISTS `conversation_run_intervals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`conversation_id` text NOT NULL,
	`provider` text,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`last_seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_conversation_run_intervals_started_at` ON `conversation_run_intervals` (`started_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_conversation_run_intervals_conversation_ended` ON `conversation_run_intervals` (`conversation_id`,`ended_at`);
--> statement-breakpoint
-- 回填:0028 起任务页落盘的每一回合带着 startedAt / endedAt(epoch 毫秒)—— 这就是本表之前那段历史里
-- 唯一留下的「几点到几点在干活」。没有 endedAt(回合没收口)或时长 ≤ 0 的回合不回填:编一个结束时刻是造数。
INSERT INTO `conversation_run_intervals` (`conversation_id`, `provider`, `started_at`, `ended_at`, `last_seen_at`)
SELECT t.`conversation_id`, c.`provider`,
       CAST(json_extract(t.`data`, '$.startedAt') AS INTEGER),
       CAST(json_extract(t.`data`, '$.endedAt') AS INTEGER),
       CAST(json_extract(t.`data`, '$.endedAt') AS INTEGER)
FROM `conversation_turns` t
JOIN `conversations` c ON c.`id` = t.`conversation_id`
WHERE json_valid(t.`data`)
  AND json_type(t.`data`, '$.startedAt') IN ('integer', 'real')
  AND json_type(t.`data`, '$.endedAt') IN ('integer', 'real')
  AND json_extract(t.`data`, '$.endedAt') > json_extract(t.`data`, '$.startedAt')
  AND NOT EXISTS (SELECT 1 FROM `conversation_run_intervals`)
ORDER BY t.`conversation_id`, t.`seq`;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `usage_token_file_cache` (
	`path` text PRIMARY KEY NOT NULL,
	`size` integer NOT NULL,
	`mtime_ms` integer NOT NULL,
	`provider` text NOT NULL,
	`session_id` text NOT NULL,
	`data` text NOT NULL
);
