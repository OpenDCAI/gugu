-- #4915 `conversations.type` → `conversations.runtime`。
-- 只改列名,❌ 不重写任何一行值:`'pty'` / `'acp'` 在这一层是准确的,换值才要动数据。
-- SQLite 从 3.25 起支持 RENAME COLUMN;better-sqlite3 捆的版本远高于它。
ALTER TABLE `conversations` RENAME COLUMN `type` TO `runtime`;
