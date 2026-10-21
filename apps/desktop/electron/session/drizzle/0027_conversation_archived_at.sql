-- spec session-graph:归档的归属键从 task 收到**会话自己**(#5413)。
-- null = 在会话列表里,时间戳 = 已归档。
ALTER TABLE `conversations` ADD COLUMN `archived_at` text;--> statement-breakpoint
-- 回填是这次迁移的一半:在此之前一条会话可不可见由它所属 task 的 `archived_at` 回答,会话行上
-- 什么都没有。过滤器收到会话这一列之后,**不回填就等于把存量已归档任务的会话全部放回列表**。
-- 盖的是容器那一次归档的**那个**时间戳(不是 CURRENT_TIMESTAMP):容器恢复只抹掉盖着同一个章的
-- 那些会话,历史行必须与将来由 archiveTask 盖的章同形,否则老任务恢复不回来。
UPDATE `conversations` SET `archived_at` = (
  SELECT `tasks`.`archived_at` FROM `tasks` WHERE `tasks`.`id` = `conversations`.`task_id`
) WHERE `archived_at` IS NULL AND `task_id` IN (SELECT `id` FROM `tasks` WHERE `archived_at` IS NOT NULL);
