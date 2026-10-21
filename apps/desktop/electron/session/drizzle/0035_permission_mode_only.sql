-- 会话的权限只剩 permissionMode 一格(体检 B7):存量记录里的 autoApprove 布尔按 permissionModeFromAutoApprove 那张表
-- 折成档位(true ⇒ full-access,false ⇒ edit),已有档位的记录档位为准,然后删掉布尔。读取端从此不再认它。
-- 「已安排」那份 agent_config 的 autoApprove 不是会话的档位(是「无人值守」那一个开关,校验要求为真),不动。
UPDATE `sessions`
SET `config` = json_remove(
	json_set(
		`config`,
		'$.permissionMode',
		coalesce(
			json_extract(`config`, '$.permissionMode'),
			CASE WHEN json_extract(`config`, '$.autoApprove') THEN 'full-access' ELSE 'edit' END
		)
	),
	'$.autoApprove'
)
WHERE json_valid(`config`) AND json_type(`config`, '$.autoApprove') IS NOT NULL;
--> statement-breakpoint
UPDATE `automations`
SET `session_config` = json_remove(
	json_set(
		`session_config`,
		'$.sessionConfig.initialSession.permissionMode',
		coalesce(
			json_extract(`session_config`, '$.sessionConfig.initialSession.permissionMode'),
			CASE WHEN json_extract(`session_config`, '$.sessionConfig.initialSession.autoApprove') THEN 'full-access' ELSE 'edit' END
		)
	),
	'$.sessionConfig.initialSession.autoApprove'
)
WHERE json_valid(`session_config`) AND json_type(`session_config`, '$.sessionConfig.initialSession.autoApprove') IS NOT NULL;
--> statement-breakpoint
UPDATE `automation_runs`
SET `session_config_snapshot` = json_remove(
	json_set(
		`session_config_snapshot`,
		'$.sessionConfig.initialSession.permissionMode',
		coalesce(
			json_extract(`session_config_snapshot`, '$.sessionConfig.initialSession.permissionMode'),
			CASE WHEN json_extract(`session_config_snapshot`, '$.sessionConfig.initialSession.autoApprove') THEN 'full-access' ELSE 'edit' END
		)
	),
	'$.sessionConfig.initialSession.autoApprove'
)
WHERE json_valid(`session_config_snapshot`) AND json_type(`session_config_snapshot`, '$.sessionConfig.initialSession.autoApprove') IS NOT NULL;
