-- spec agent-status-vocabulary:agent_status 是基础态(功能),这一列是它的附属态(只给显示)。
-- null = 没有附属态(旧行、某家量不到);界面据此画基础态。存量行不回填:下一次状态写入就会带上。
ALTER TABLE `conversations` ADD COLUMN `agent_status_detail` text;
--> statement-breakpoint
-- 基础态的词随词表换算一次,按它当时的意思:等人(needs_approval / 四态之前的 awaiting-input)→ needs_user,
-- 做完(四态之前的 completed)→ idle。开机收残随后照常把上一进程留下的在飞状态落成 idle。
UPDATE `conversations` SET `agent_status` = 'needs_user' WHERE `agent_status` IN ('needs_approval', 'awaiting-input');
--> statement-breakpoint
UPDATE `conversations` SET `agent_status` = 'idle' WHERE `agent_status` = 'completed';
