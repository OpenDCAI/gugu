-- 一律存一份(#5269)。从这里起,拖进来的文件也在 `<userData>/task-attachments/<taskId>/`
-- 留一份副本 —— `stored_path` 恒指向我们自己那份。用户自己盘上那个文件的位置记进
-- `original_path`:发给 agent 的 mention 用它(他要改的就是那个文件),消息里显示与点开用副本。
--
-- 从前的 `origin='reference'` 行没有副本,`stored_path` 指着用户的文件:历史行照旧,
-- `original_path` 为 NULL —— ❌ 不回填(那会把「这行有没有副本」这件事说谎)。
ALTER TABLE task_attachments ADD COLUMN original_path text;
