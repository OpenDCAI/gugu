-- #7341 项目 = 根目录 + 挂上来的文件夹:挂上的那一行记下它属于哪个项目、什么时候挂上的(同一路径本来就只有一行 ⇒ 一个文件夹只属于一个项目)。
-- 根目录不记在这里,仍由 projects.repository_workspace_id 指着,老行一行不动。项目删了,挂着的文件夹放回无主(SET NULL),行与会话照旧。
ALTER TABLE `workspaces` ADD `project_id` text REFERENCES projects(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `attached_at` text;
--> statement-breakpoint
CREATE INDEX `idx_workspaces_project_id` ON `workspaces` (`project_id`);
