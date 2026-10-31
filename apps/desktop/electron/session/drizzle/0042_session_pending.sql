CREATE TABLE IF NOT EXISTS `session_pending` (
  `seq` integer PRIMARY KEY AUTOINCREMENT,
  `session_id` text NOT NULL REFERENCES `sessions`(`id`) ON DELETE CASCADE,
  `message_id` text NOT NULL REFERENCES `messages`(`id`) ON DELETE CASCADE,
  `kind` text NOT NULL CHECK (`kind` IN ('ordinary','session-direct','inbox-batch')),
  `state` text NOT NULL CHECK (`state` IN ('queued','dispatching','accepted','failed','unknown')),
  `attempt` integer,
  `native_receipt_id` text,
  `failure` text,
  `enqueued_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `settled_at` text,
  UNIQUE (`session_id`,`message_id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `session_pending_source` (
  `seq` integer NOT NULL REFERENCES `session_pending`(`seq`) ON DELETE CASCADE,
  `session_id` text NOT NULL,
  `source_message_id` text NOT NULL,
  UNIQUE (`session_id`,`source_message_id`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_session_pending_queue` ON `session_pending` (`session_id`,`state`,`seq`);
--> statement-breakpoint
ALTER TABLE `sessions` ADD COLUMN `life_hold` text;
--> statement-breakpoint
-- Keep each old array's order. The message row remains the only body copy.
INSERT OR IGNORE INTO `messages` (`id`,`session_id`,`content`,`sender`,`metadata`)
SELECT json_extract(j.value,'$.id'), s.id, json_extract(j.value,'$.text'), 'user',
  json_object('kind',CASE WHEN json_extract(j.value,'$.kind')='session-direct' THEN 'session-direct' ELSE 'ordinary-message' END)
FROM `sessions` s, json_each(CASE WHEN json_valid(s.config) THEN s.config ELSE '{}' END,'$.messageOutbox') j
WHERE json_extract(j.value,'$.kind') IS NULL OR json_extract(j.value,'$.kind') IN ('ordinary','session-direct')
ORDER BY s.rowid, CAST(j.key AS integer);
--> statement-breakpoint
INSERT OR IGNORE INTO `session_pending` (`session_id`,`message_id`,`kind`,`state`)
SELECT s.id, json_extract(j.value,'$.id'),
  CASE WHEN json_extract(j.value,'$.kind')='session-direct' THEN 'session-direct' ELSE 'ordinary' END,
  CASE WHEN json_extract(j.value,'$.state')='dispatching' THEN 'dispatching' ELSE 'queued' END
FROM `sessions` s, json_each(CASE WHEN json_valid(s.config) THEN s.config ELSE '{}' END,'$.messageOutbox') j
WHERE json_extract(j.value,'$.kind') IS NULL OR json_extract(j.value,'$.kind') IN ('ordinary','session-direct')
ORDER BY s.rowid, CAST(j.key AS integer);
--> statement-breakpoint
-- An existing explicit receipt wins over the older config outbox projection.
INSERT OR IGNORE INTO `session_pending` (`session_id`,`message_id`,`kind`,`state`,`native_receipt_id`)
SELECT session_id,id,CASE WHEN json_extract(metadata,'$.kind')='session-direct' THEN 'session-direct' ELSE 'ordinary' END,
  CASE WHEN json_extract(metadata,'$.state')='outcome-unknown' THEN 'unknown' ELSE json_extract(metadata,'$.state') END,
  json_extract(metadata,'$.nativeReceiptId')
FROM `messages`
WHERE json_valid(metadata) AND json_extract(metadata,'$.kind') IN ('ordinary-message','session-direct')
  AND json_extract(metadata,'$.state') IN ('queued','dispatching','accepted','failed','outcome-unknown');
--> statement-breakpoint
UPDATE `session_pending` SET
  state = (SELECT CASE WHEN json_extract(m.metadata,'$.state')='outcome-unknown' THEN 'unknown' ELSE json_extract(m.metadata,'$.state') END FROM messages m WHERE m.id=message_id),
  native_receipt_id = (SELECT json_extract(m.metadata,'$.nativeReceiptId') FROM messages m WHERE m.id=message_id)
WHERE message_id IN (SELECT id FROM messages WHERE json_valid(metadata) AND json_extract(metadata,'$.state') IN ('queued','dispatching','accepted','failed','outcome-unknown'));
--> statement-breakpoint
UPDATE `sessions` SET config=json_remove(config,'$.messageOutbox','$.spawnStartupState') WHERE json_valid(config);
--> statement-breakpoint
UPDATE `messages` SET metadata=json_remove(metadata,'$.state','$.nativeReceiptId')
WHERE json_valid(metadata) AND id IN (SELECT message_id FROM session_pending);
