-- ⚠️ 为什么带 IF NOT EXISTS(本目录其余迁移都没带):这条迁移在这条分支上**撞过两次号**——
-- 原本 0026,与 dev 的 0026_task_attachment_original_path 撞,改成 0027;2026-09-13 再追 dev 时
-- 又与 dev 的 0027_conversation_archived_at(#5413 归档重做)撞,改成 0028。两次都把 `when`
-- 排到 dev 那条之后。
-- 迁移执行器(db/initialize.ts)只按 `when` 判定「跑没跑过」,不看 tag 也不校验 hash ⇒
-- 已经用分支构建跑过旧编号的库(验收实例、自测库)会把这一条**再跑一遍**,不带 IF NOT EXISTS
-- 就在 CREATE TABLE 上炸,而整批迁移在同一个事务里 —— 连 dev 那条也一起回滚,应用起不来。
-- ⇒ 这条分支只要还没合,每次追 dev 都要重新核一次编号:分支迁移的编号不是自己定的,是 dev 定的。
-- #5381 会话历史落盘:任务页不再把「用户会不会丢历史」交给 provider 的重放去决定。
-- 一条已提交的回合一行,`data` 是该回合的结构化条目(消息 / 思考 / 工具调用)的 JSON。
-- `seq` 由主进程按到达序分配(max(seq)+1),❌ 不复用运行时那份回合序号——重开会话后它从 0 重数,
-- 而重放只含压缩边界之后的一段,直接拿来当键必然与库里已有的撞号。
CREATE TABLE IF NOT EXISTS `conversation_turns` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`seq` integer NOT NULL,
	`turn_id` text NOT NULL,
	`data` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_conversation_turns_conversation_seq` ON `conversation_turns` (`conversation_id`,`seq`);
