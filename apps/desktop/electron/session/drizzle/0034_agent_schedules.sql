-- #7221 agent 给自己排的「已安排」:到点把交代送回建它的那条会话,不新开会话。
-- 沿用 automations / automation_runs(云电脑管家睡前按 automation_runs 里 status='scheduled' 的那一行算下次到期),
-- 只多一格「送回给谁」。不加外键:会话删了这一格也要留着,到点才说得出「建它的 agent 已不在」。
ALTER TABLE `automations` ADD `agent_session_id` text;
--> statement-breakpoint
CREATE INDEX `idx_automations_agent_session_id` ON `automations` (`agent_session_id`);
