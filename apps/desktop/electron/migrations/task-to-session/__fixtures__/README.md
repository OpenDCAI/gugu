# v0.2.51 夹具(task → session 迁移)

`v0251/` 是一份 v0.2.51(gugu `61fe8fb3a4`,迁移的唯一起点,DESIGN §0.5)的 profile 片段,`fixture-v0251.test.ts`
在它上面跑段 1(0032)+ 段 2,断言守恒。只含测试账号造出来的数据,❌ 放任何人的真实库。

## 怎么造的

1. **产品面**(mac1 上 v0.2.51 的构建,全新 profile,测试账号,`GUGU_TMUX_SOCKET_LABEL` 用车道自己的标签):
   - 主目录项目里两个 standalone:Codex 编程形态(开 tmux 之前建的,不在 tmux 里)、Claude 编程形态(在 tmux 里);
   - 设置里打开「默认 tmux」(`appSettings.update('project', {tmuxByDefault: true})`,与设置页开关同一个 handler);
   - 一个 git 项目(`projects.createProject`,同「添加项目」的 handler),里面:
     - Codex 编程形态会话 → 活的 `gugu-` / `gugubk-` 一对;在它的工作区面板开终端(→ 第三个 `gugu-`)、Review 页签、
       浏览器页签并把配置切到「按任务隔离」、打开一个网址(→ `Partitions/gugu-browser-isolated-<p>-<w>-<taskId>`);
     - Claude 工作形态会话,带一个附件(→ `task-attachments/<taskId>/…`),置顶;让它用 `session_spawn` 起一个子会话
       (→ 子会话的 task、`session-lifecycle-state.json` 里带 `parentTaskId` 的 intent);
     - 另一个 Codex 编程形态会话,随后归档;
     - 一个自动化,手动触发一次(→ `automation-run` 类型的 task、`automation_runs` 行、活的 `gugu-` / `gugubk-` 一对)。
   - 「始终用它」(10-05 补,主车道要):两个 v1 小 App(`t2s-ow-a` 开法甲 / `t2s-ow-b` 开法乙,都认领 `.t2sow`,
     从文件夹装)。在 git 项目那条 Codex 会话的 Files 里点开 `ow-fixture.t2sow`,「用哪个打开」里勾「这类文件始终用它」、
     选开法甲 → `task-extensions/.open-with-defaults.json` 里写下 `"task:.t2sow": "t2s-ow-a.view"`。这一步是在原来那份
     冻结状态上用 v0.2.51 的界面点的(t2s 装置的 `rig/ow-prep.sh`),夹具只取这一个文件。
   - SIGTERM 停掉实例(tmux 会话留着),记下 `tmux ls` → `tmux-sessions.txt`。
2. **补丁** `graft-v0251.py <profile>`:产品面已经造不出来的形状,id 以 `aaaaaaaa-` 开头、名字带 `[graft]`。
   第 7 步在 `.open-with-defaults.json` 里补一条群文件的 `"group:.t2sow"`(这台桌面上没有带文件的群)。
3. **打包**:库在线备份 + `VACUUM` + `journal_mode=delete`;`gugu-home/` 只留 `agents.json` 与
   `session-lifecycle-state.json`;`task-extensions/` 只留 `.open-with-defaults.json`;`Partitions/` 只留 `-isolated-` 目录,里面一个写着原目录名的 `Cookies`;附件原样。
   打包后扫过一遍凭据形状(JWT、`sk-`、`access_token` 等),0 命中。

附件行里存的是造夹具那台机器上的绝对路径(`/Users/mac1/gugu-t2s-mig-old-profile/…`),测试在副本里换成副本的位置。

社区快照额外将 provider_accounts 的 GitHub 测试账号元数据替换为合成账号，并执行 VACUUM；表结构、行数和迁移关系保留。
