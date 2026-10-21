-- #6334 用量页:一条会话每次启动时「用的是咕咕模型还是用户自己的账号」,一次启动一行(与上一行相同则不记)。
--
-- 用量页要把 Token 分成「咕咕模型」(扣积分)与「自己账号」(BYOK:订阅或自己的 key)两份。
-- 会话级的选择(kv `taskpage-platform-model:<id>`)只记得「现在」,中途换过来源就说不清之前那几轮;
-- 这里按启动时刻留底,Token 按自己的时刻归到当时那一段。
-- `source`:'gugu' | 'byok'。时间是 epoch 毫秒。❌ 不挂外键,理由同 conversation_run_intervals。
CREATE TABLE IF NOT EXISTS `conversation_model_sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`conversation_id` text NOT NULL,
	`source` text NOT NULL,
	`started_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_conversation_model_sources_conversation_started` ON `conversation_model_sources` (`conversation_id`,`started_at`);
