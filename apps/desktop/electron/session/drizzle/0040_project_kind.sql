-- #609 / project-machine-model: a project row is either something the person created or opened (`project`) or a
-- directory the app keeps for its own needs (`workspace`: task-home, the assistant's home and work directory, App
-- directories, a session started in ~). Workspaces never show as projects; their sessions are listed as Tasks.
ALTER TABLE `projects` ADD COLUMN `kind` text DEFAULT 'project' NOT NULL;
--> statement-breakpoint
UPDATE `projects` SET `kind` = 'workspace' WHERE `id` = '00000000-0000-4000-8000-000000000001';
