#!/usr/bin/env python3
"""Second half of the v0.2.51 fixture: the shapes v0.2.51's product surface can no longer produce.

The first half is made by driving a real v0.2.51 build (see README.md). This script then grafts, into that
profile's stopped database and data directory, what only older versions (or since-closed paths) left behind.
Every grafted row is findable: ids start with `aaaaaaaa-` and titles/names with `[graft]`.
Usage: graft-v0251.py <profile dir>   (the app must not be running on that profile)
"""
import json, os, sqlite3, sys

profile = sys.argv[1]
db = sqlite3.connect(os.path.join(profile, 'gugu4.db'))
q = lambda sql, *a: db.execute(sql, a).fetchall()
one = lambda sql, *a: q(sql, *a)[0]
HOME = '00000000-0000-4000-8000-000000000001'
gid = lambda n: f'aaaaaaaa-0000-4000-8000-{n:012d}'

def task_of(title_prefix):
    return one('select t.id, t.project_id, t.workspace_id from tasks t join conversations c on c.task_id = t.id '
               'where c.title like ? order by c.created_at limit 1', title_prefix + '%')

t2, project, workspace = task_of('Reply with exactly OK-T2')
t5, _, _ = task_of('Reply with exactly OK-T5')
t1, _, _ = task_of('Reply with exactly OK-T1')

# 1. #5665 之前一个 task 挂两条会话:第二条不是首条、却是最近交互的那条(代表会话仍应是首条)。
second = gid(1)
db.execute("insert into conversations (id, project_id, task_id, title, provider, runtime, is_initial_conversation, "
           "last_interacted_at, created_at, updated_at) values (?, ?, ?, '[graft] pre-5665 second session', 'claude', "
           "'acp', 0, '2099-01-01 00:00:00', '2026-09-20 00:00:00', '2026-09-20 00:00:00')", (second, project, t2))
db.execute("insert into messages (id, conversation_id, content, sender) values (?, ?, '[graft] hello', 'user')",
           (gid(11), second))

# 2. standalone 却不在主目录项目里(spawn / 远端建会话显式传 taskType:'standalone' 造出来的那种)。
db.execute("update tasks set type = 'standalone' where id = ?", (t5,))

# 3. 关联 issue(v0.2.51 存的是不带 version 的扁平对象)。
db.execute('update tasks set linked_issue = ? where id = ?', (json.dumps({
    'provider': 'github', 'url': 'https://github.com/example/repo/issues/42', 'title': '[graft] fixture issue',
    'identifier': '#42'}, separators=(',', ':')), t2))

# 4. 指向已删运行的 automation_run_id(tasks 上这一列从来没有外键)。
db.execute('update tasks set automation_run_id = ? where id = ?', (gid(5), t1))

# 5. 名下一条会话都没有的 task:带一个终端、一个自有附件(盘上有文件)、一个引用附件、两条视图状态、一个隔离分区目录。
orphan = gid(2)
db.execute("insert into tasks (id, project_id, name, status, workspace_id, type) values (?, ?, '[graft] orphan task', "
           "'todo', ?, 'task')", (orphan, project, workspace))
db.execute("insert into terminals (id, project_id, task_id, name) values (?, ?, ?, '[graft] terminal')",
           (gid(3), project, orphan))
owned = os.path.join(profile, 'task-attachments', orphan, f'{gid(4)}-orphan.txt')
os.makedirs(os.path.dirname(owned), exist_ok=True)
with open(owned, 'w') as f:
    f.write('[graft] orphan attachment bytes\n')
db.execute("insert into task_attachments (id, task_id, name, size, stored_path, origin) values (?, ?, 'orphan.txt', ?, ?, "
           "'copy')", (gid(4), orphan, os.path.getsize(owned), owned))
db.execute("insert into task_attachments (id, task_id, name, size, stored_path, origin) values (?, ?, 'ref.txt', 1, "
           "'/Users/someone-else/ref.txt', 'reference')", (gid(6), orphan))
db.execute("insert into kv (key, value) values (?, '{\"sidebarTab\":\"files\"}'), (?, '{\"groups\":[]}')",
           (f'view-state:task:{orphan}', f'view-state:task:{orphan}:tabs'))
partition = os.path.join(profile, 'Partitions', f'gugu-browser-isolated-{project}-{workspace}-{orphan}')
os.makedirs(partition, exist_ok=True)
with open(os.path.join(partition, 'Cookies'), 'w') as f:
    f.write('[graft] orphan partition\n')

# 6. 侧栏手排顺序(v0.2.51 拖拽才会写;这里直接写成拖过之后的样子,含无主 task)。
sidebar = json.loads(one("select value from kv where key = 'view-state:sidebar'")[0])
order = [r[0] for r in q('select id from tasks where project_id = ? order by created_at desc', project)]
sidebar['taskOrderByProject'] = {project: order, HOME: [r[0] for r in q('select id from tasks where project_id = ?', HOME)]}
db.execute("update kv set value = ? where key = 'view-state:sidebar'", (json.dumps(sidebar, separators=(',', ':')),))

# 7. 群文件的「始终用它」(`group:<认领>`):这台桌面上没有带文件的群,产品面点不出来;补一条在 v0.2.51 的选择框写下的
#    `task:` 旁边,迁移要原样留着它。
ow = os.path.join(profile, 'task-extensions', '.open-with-defaults.json')
defaults = json.load(open(ow)) if os.path.exists(ow) else {}
defaults['group:.t2sow'] = 't2s-ow-b.view'
os.makedirs(os.path.dirname(ow), exist_ok=True)
with open(ow, 'w') as f:
    f.write(json.dumps(defaults, ensure_ascii=False, indent=2) + '\n')

db.commit()
print(json.dumps({'multi': t2, 'second': second, 'standaloneOutsideHome': t5, 'danglingRun': t1, 'orphan': orphan,
                  'sidebarOrder': len(order)}))
