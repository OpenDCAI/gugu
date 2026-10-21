-- Keep the historical root workspace and sessions when its folder membership is removed.
ALTER TABLE `projects` ADD `root_folder_detached` integer DEFAULT false NOT NULL;
