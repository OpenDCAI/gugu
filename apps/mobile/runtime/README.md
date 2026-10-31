# Android 手机 Agent 宿主

咕咕 Android App 打包 ARM64 Node 和 Pi SDK。Android 前台服务拥有 Node 子进程；任务、模型请求、收件箱、设备命令与消息投递不依赖 WebView 的计时器。当前运行时要求 Android 8 或以上。模型推理使用咕咕平台的短效票据。

`pnpm android:build` 与 `pnpm android:build:release` 都会先执行 `build:mobile-agent`。Node 二进制及依赖来自 `android-node.lock.json`，构建只从锁文件里的 `mirror`（以 SHA-256 命名、上传后不再变的 release 附件）下载，并通过 SHA-256 校验——Termux 源只留每个包的最新一版，旧版一被替换就 404。改锁文件后趁上游还在，跑一次 `node scripts/build/mirror-mobile-node.mjs` 把缺的包补进镜像；Pi 与 npm 依赖由锁文件固定。生成的二进制、资源、已收集的第三方许可证及依赖清单放在 Android assets / jniLibs 中，不入 Git。

原生库按 Node 的 ELF `DT_NEEDED` 和包内实际别名取传递闭包；缺失依赖、循环别名或 SONAME 不符会中止构建。`native-libraries.json` 保存解析后的边；不打包未被加载链引用的 ICU 工具库和另一份 SQLite。Gradle 保留 `arm64-v8a` / `armeabi-v7a`，嵌入 Node 的架构仍以锁文件为准。

构建机还需已有的 ICU 数据工具（`icupkg`、`derb`、`genrb`）和 LLVM（`llvm-readelf`、`llvm-objcopy`、`clang`、`ld.lld`）。全部从 PATH 查找（macOS 用 Homebrew 的 `icu4c`、`llvm`、`lld`，把它们的 `bin`/`sbin` 加进 PATH）。工具缺失直接报错，不自动安装或回退全量数据。

数据裁剪复用 [ICU 的数据打包工具](https://unicode-org.github.io/icu/userguide/icu_data/)：从验证过的 ICU ELF 数据段取得 `.dat`，保留 en/zh/ja 的全部区域和脚本变体、root、共享 Unicode/时区/排序/分词字典。用 derb/genrb 更新原索引中的 InstalledLocales，保留其余字段；icupkg 的依赖校验保持开启。LLVM 仅重封同数据符号与 SONAME 的 AArch64 共享数据对象，无 Android 头文件、运行库或 Node 重编译。`icu-data.json` 保存实际条目清单、尺寸和 SHA。

APK 自带 `agent-runtime/intl-smoke-cli.mjs`。在自有 Android 测试实例的同一 Node / LD_LIBRARY_PATH 下执行它，验证 en-US、zh-CN、ja-JP 的日期、数字、排序、单词字典和 emoji 字素；桌面 Node 的通过仅是辅助证据。产品验收还须在真实手机正常完成一个 Pi 任务。

## 边界

- `agent.mjs` 处理原生字节协议；`pi-session.mjs` 为每个咕咕会话建立独立 Pi 转录和取消边界。
- `phone-network.mjs` 为 Android 移动网络设置双栈连接尝试窗口的 2000ms 下限，保留更长的已有配置。
- `phone-agent-host.mjs` 接正式设备命令、跨设备会话 RPC、Agent 收件箱、状态与结果投递。身份创建使用既有 provision saga，成功须以设备命令的终态为准。
- `phone-capacitor.mjs` 是打包时的原生传输适配。通过任务范围的 AsyncLocalStorage，复用现有 `PHONE_ACTIONS` 和健康聚合逻辑；Android 执行器复用现有原生插件方法。
- `phone-actions.mjs` 提供受控动作目录。写入与敏感操作必须收到真人 owner 对确切请求的确认；模型填写的 `confirmed` 或审批字段不构成授权。
- 媒体字节在原生与 Node 之间分块传输，保存为该 Agent 的私有文件。模型只取得已完整验证的文件元数据和可用预览；附件发送使用现有上传、提交协议。
- 不加载任意扩展、Shell、Root 或无障碍工具。手机工具授权与宿主开关相互独立。

## 登录与持久化

宿主启用时，Node 是该手机登录会话的唯一刷新方。WebView 的登录协调器向原生宿主取最新会话；交接会等已开始的刷新完成存储与发布。原生保存续期结果，登录主体改变、退出和晚到响应均须检查 owner / session 边界。

宿主配置通过 Android Keystore 加密；正式 Agent 转录与队列在不参与系统备份的私有目录中。入队先落盘再推进云端已读位置。进程中断时，执行中的任务和操作标为结果未确认，不自动重复执行。待发送结果可以幂等重投，但发送前重新检查原始数据权限。

每轮上下文累计实际读取的数据权限证明。系统撤权或分组关闭后，发送会被拦截；下一轮使用新的 Pi 上下文，旧转录保留为历史，不再交给模型。启动前台服务不代表可以绕过强停、系统回收或 Android 对后台读取与打开其他 App 的限制。

## 任务 Skill 配置

`phone-agent-skills.mjs` 导出 `PHONE_SKILL_LIMITS`、`PHONE_SKILL_SCHEMA` 与 `PHONE_SKILLS_SCHEMAS`（`get` / `set` / `response`），供界面与 RPC 核对字段。`taskhost.call` 仍使用 `{channel,args}`，方法与参数如下：

- `sessionTimeline.phoneSkillsGet`：`args=[{conversationId}]`。
- `sessionTimeline.phoneSkillsSet`：`args=[{conversationId,expectedRevision,skills:[{id,name,description,instructions,enabled}]}]`。这是完整替换；界面为新 Skill 生成 UUID，后续编辑保留该 id。删除即从列表移除。
- 两者返回 `{conversationId,revision,updatedAt,skills,editable,busy,limits}`。首次为空、版本为 `0`、时间为 `null`。只有来自当前 owner 的原生界面且任务不忙时，`editable` 才为 `true`。设置只接受 Android 原生桥追加的 `native-ui` 来源；参数中自填来源不能授权。

每任务最多 20 项；名称最多 80 字、简介最多 512 字、正文最多 16384 字，完整 Skill 列表的 UTF-8 JSON 最多 131072 字节。仅接收明确的说明字段，拒绝重复 id、未知字段、无效类型及超限内容。正文支持普通 Markdown 和换行；路径、URL、代码片段不形成加载或执行机制。

配置保存于 owner 私有 `host.json` 中对应 Agent 的 `skills` 字段，使用原子日志写入。读写均复核该 Agent 的账号和设备归属；损坏或不认识的已存格式明确失败，不静默丢弃。运行、排队或等待确认时不能修改；不同内容的并发保存以 `expectedRevision` 检查冲突，相同内容重试不增加版本。配置改变后下一轮使用新的 Skill 快照，原对话、任务地址、手机数据权限证明和长期笔记保留；不热改执行中的一轮。

Pi 每轮快照仅包含启用项。`phone_skills_list({})` 返回 `{revision,skills:[{id,name,description}]}`；`phone_skills_read({id})` 才返回 `{revision,skill:{id,name,description,instructions}}`。禁用、删除或重启后按已保存版本生效；旧轮次的工具句柄在配置版本改变后失效。配置修改保留原对话及记录；历史中已出现的 Skill 说明不代表当前启用项。Skill 只能指导使用已有受控工具，不加载 Pi 的文件 Skill、脚本、扩展或咕咕 App，也不增加手机系统权限。

## 验证

`tests/unit/desktop/mobile/phoneRuntime.test.ts` 通过与 APK 相同的编译和原生传输适配运行 Node 单元测试。Android 范围、权限与生命周期规则的单元测试在原生工程中。产品验收仍须使用真实 App、平台模型及原生数据，确认实际发送者、运行设备、权限拒绝、取消和中断后的状态。
