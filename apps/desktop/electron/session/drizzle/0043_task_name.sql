-- A task has one name: its agent identity's name, or before binding its pending-bind record
-- (config.agentDisplayName). Every legacy row gets that record from the title it showed; a row
-- without a config gets one holding just that name (an unversioned config, upgraded on read).
UPDATE `sessions`
SET `config` = json_set(COALESCE(`config`, json_object()), '$.agentDisplayName', COALESCE(NULLIF(trim(`title`), ''), `provider`))
WHERE trim(COALESCE(json_extract(`config`, '$.agentDisplayName'), '')) = '';
