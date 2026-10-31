-- A task has one name: its agent identity's name, or before binding its pending-bind record
-- (config.agentDisplayName). Every legacy row gets that record from the title it showed; a row
-- without a config gets one holding just that name (an unversioned config, upgraded on read).
UPDATE `sessions`
SET `config` = json_set(COALESCE(`config`, json_object()), '$.agentDisplayName', COALESCE(NULLIF(trim(`title`), ''), `provider`, `id`))
WHERE trim(COALESCE(json_extract(`config`, '$.agentDisplayName'), '')) = '';
--> statement-breakpoint
-- The second copy is gone: a session reads its name from its identity or its pending-bind record.
--
-- @@@rollback-title - the column itself stays one more release. A failed version switch (server
-- upgrade guard) runs the previous build on this same database, and that build selects
-- `sessions.title`; the database has no "newer than the app" guard, so a dropped column would crash
-- it at boot. It is re-added with a default so this build never has to read or maintain it; existing
-- rows keep the name they showed. The next release drops it for good.
ALTER TABLE `sessions` DROP COLUMN `title`;
--> statement-breakpoint
ALTER TABLE `sessions` ADD COLUMN `title` text DEFAULT '' NOT NULL;
--> statement-breakpoint
UPDATE `sessions` SET `title` = json_extract(`config`, '$.agentDisplayName');
