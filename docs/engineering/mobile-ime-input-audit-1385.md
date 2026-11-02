# 手机单行输入法收起覆盖清单（#1385）

公共机制挂在 App 根部，登录、加入页、首次引导、已登录手机壳及 React Portal 弹层共用同一 document 监听；只有 useMobileShell 判定手机时安装，Electron 始终不安装。只在非组字 Enter 后延迟到当前输入动作完成再 blur 原输入，既有搜索、提交和自动保存先运行；若已换焦点，不打扰新焦点。

旧修复：43df62d4d94200c23edacb3f419029e1ce532e04（共享 ChatComposer 的提交路径；较早的 90573463126b7149efd585eae06008b54fb5dab0 移除了手机发送后的抢焦点）。它们针对多行聊天输入，不覆盖本清单的普通单行表单；本次保留原聊天换行／发送规则。

## 入口核对

| 入口 | 实际控件／来源 | 处理 |
| --- | --- | --- |
| 消息全局搜索 | PhoneMessageSearch → GlobalSearch 的原生 input | 公共机制；Enter 仍打开选中结果，无结果时保留词与结果页 |
| 消息列表筛选、群内查找 | ChatListPanel / ChatSearch → SearchField | 公共机制；既有过滤和跳转保持 |
| 伙伴／通讯录搜索 | ContactSearch → HeaderSearch → SearchField | 公共机制；原选结果／无结果逻辑保持 |
| 项目／文件夹搜索 | HeaderSearch / ChatPickSheet / RemoteFolderPicker | 公共机制；搜索与目录选择保持 |
| 新建群、添加成员 | MemberPicker → SearchField | 公共机制；Enter 仍选成员，创建按钮仍提交 |
| 新建项目 | PhoneNewProjectPage 原生名称 input | 公共机制；原 create 路径不变 |
| 群／话题改名、个人备注 | InlineNameInput / AliasSheet / ContactProfileCard / MemberProfileCard | 公共机制；InlineNameInput 特殊接合：手机 Enter 只交给既有 onBlur 保存一次，防失败后再次提交；桌面原提交方式保持 |
| 任务改名 | SessionsPage → Field.Input | 公共机制；仍走原 rename |
| 自有 Agent 改名、设备改名 | OwnedAgentNameEditor / DeviceRenameField | 公共机制；原保存／取消保持 |
| 助理名称 | AssistantNameInline / PhoneCustomize / AssistantSetupIdentity | 公共机制；AssistantNameInline 的点击编辑模式同样让手机 Enter 只走失焦保存，显式保存模式保持 |
| 账号设置：名字、简介、其他职业 | AccountSection 的三个 input | 公共机制；保存和校验不变 |
| 设备设置：设备筛选、删除确认 | DevicesSection / DeviceRemoveDialog | 公共机制；既有确认规则不变 |
| 添加服务器：地址、用户名及 SSH 密码／交互回答 | AddServerPanel / SshPromptCard → Field.Input | 公共机制；Enter 仍执行原连接／回答 |
| 模型设置及临时模型名 | ModelSection / UsageCredits | 公共机制；过滤及添加保持 |
| Apps 搜索、微信连接字段 | MobileAppsSection / WechatConnectDialog | 公共机制；原搜索与连接动作保持 |
| 群设置：成员上限、Agent 提醒阈值 | GroupSettingsManagePage / AgentFloodThresholdSetting | 公共机制；原 Enter→blur→保存保持 |
| 助理库条目：名称、分组、描述 | AssistantLibraryEditor → Input | 公共机制 |
| 手机 Skill：名称、描述 | PhoneSkillFields → Field.Input | 公共机制 |
| 连接器：普通字段和密码 | PhoneConnectorSetup 动态 input | 公共机制；类型由当前真实 input 决定 |
| 分享、加好友、加群、标签、Agent 分享等搜索 | SearchField 各调用者 | 公共机制；既有查找和选择保持 |
| 首次引导：名字、其他职业 | FirstRunGate 原生 input | 公共机制 |
| 登录邮箱、六位验证码 | LoginPage → DarkInputField | 公共机制；不依赖登录状态，真实 form 校验和提交保持 |
| 图像标注短备注 | AnnotateNotes → Field.Input | 公共机制 |
| 聊天／会话／助理长文本、反馈、公告等 textarea/contenteditable | ChatComposer / PromptEditor / textarea | 特殊边界：公共机制不介入，保留换行／发送／现有收键盘逻辑 |
| 文件、照片、复选框、开关、范围等系统控件 | file / checkbox / range 等 input | 特殊边界：类型过滤，不当成文本输入处理 |
| 桌面（包括窄 Electron 窗口） | 所有相同组件 | 特殊边界：机制不安装，Enter 不额外 blur |

## 源码声明逐项扫描

以下逐项列出客户端及共享会话 UI 的输入声明，包含一些仅桌面可达的组件；“单行：公共机制”指该控件进入手机 document 时覆盖，不能把源码存在当成手机已有入口。动态类型在事件发生时按真实 input.type 判定，render 为 textarea 的 Field.Input 按多行排除。

| 声明位置 | 控件／类型 | 覆盖方式 |
| --- | --- | --- |
| `packages/session-ui/src/react/examples/surface-cascade.stories.tsx:89` | `Input` / `"text"` | 单行：公共机制 |
| `packages/session-ui/src/react/stories/rounding.stories.tsx:158` | `input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/components/media/ImageAttachStrip.tsx:38` | `input` / `"file"` | 非文本控件：过滤 |
| `apps/desktop/src/pages/LoginPage.tsx:45` | `input` / `{type}` | 单行：公共机制 |
| `apps/desktop/src/pages/LoginPage.tsx:300` | `DarkInputField` / `"email"` | 单行：公共机制 |
| `apps/desktop/src/pages/LoginPage.tsx:357` | `DarkInputField` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/components/devices/DeviceRenameField.tsx:14` | `input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/components/RemoteFolderPicker.tsx:344` | `input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/components/RemoteFolderPicker.tsx:461` | `SearchField` / `"search"` | 单行：公共机制 |
| `apps/desktop/src/components/RemoteFolderPicker.tsx:513` | `input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/components/RemoteFolderPicker.tsx:594` | `input` / `"checkbox"` | 非文本控件：过滤 |
| `packages/session-ui/src/react/primitives/textarea/index.tsx:14` | `textarea` / `"text"` | 多行：保留原回车规则 |
| `packages/session-ui/src/react/primitives/input-group/index.tsx:79` | `Input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/components/AgentPresetsPanel.tsx:219` | `SearchField` / `"search"` | 单行：公共机制 |
| `apps/desktop/src/components/ContactsPanel.tsx:175` | `input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/mobile/local-agent/PhoneTaskSkillsButton.tsx:107` | `input` / `"file"` | 非文本控件：过滤 |
| `apps/desktop/src/mobile/local-agent/PhoneSkillFields.tsx:11` | `Field.Input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/mobile/local-agent/PhoneSkillFields.tsx:15` | `Field.Input` / `"text"` | 单行：公共机制 |
| `packages/session-ui/src/react/primitives/input/input.stories.tsx:23` | `Input` / `"text"` | 单行：公共机制 |
| `packages/session-ui/src/react/primitives/input/input.stories.tsx:31` | `Input` / `"text"` | 单行：公共机制 |
| `packages/session-ui/src/react/primitives/input/input.stories.tsx:32` | `Input` / `"text"` | 单行：公共机制 |
| `packages/session-ui/src/react/primitives/input/input.stories.tsx:40` | `Input` / `"text"` | 单行：公共机制 |
| `packages/session-ui/src/react/primitives/input/input.stories.tsx:48` | `Input` / `"text"` | 单行：公共机制 |
| `packages/session-ui/src/react/primitives/input/input.stories.tsx:56` | `Input` / `"text"` | 单行：公共机制 |
| `packages/session-ui/src/react/primitives/input/input.stories.tsx:64` | `Input` / `"text"` | 单行：公共机制 |
| `packages/session-ui/src/react/primitives/input/input.stories.tsx:65` | `Input` / `"email"` | 单行：公共机制 |
| `packages/session-ui/src/react/primitives/input/input.stories.tsx:66` | `Input` / `"password"` | 单行：公共机制 |
| `packages/session-ui/src/react/primitives/input/input.stories.tsx:67` | `Input` / `"number"` | 单行：公共机制 |
| `packages/session-ui/src/react/primitives/input/input.stories.tsx:68` | `Input` / `"search"` | 单行：公共机制 |
| `packages/session-ui/src/react/primitives/input/index.tsx:15` | `InputPrimitive` / `{type}` | 单行：公共机制 |
| `apps/desktop/src/mobile/partners/PhoneNewProjectPage.tsx:164` | `input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/mobile/share-intake/ShareIntakeSheet.tsx:107` | `SearchField` / `"search"` | 单行：公共机制 |
| `apps/desktop/src/mobile/agent-watch/SessionConversation.tsx:211` | `input` / `"file"` | 非文本控件：过滤 |
| `apps/desktop/src/mobile/agent-watch/TimelineView.tsx:229` | `Field.Input` / `"text"` | 多行：保留原回车规则 |
| `apps/desktop/src/mobile/agent-watch/TimelineView.tsx:230` | `textarea` / `"text"` | 多行：保留原回车规则 |
| `apps/desktop/src/mobile/agent-watch/SessionsPage.tsx:100` | `Field.Input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/components/productTour/FeatureTour.tsx:99` | `input` / `"range"` | 非文本控件：过滤 |
| `apps/desktop/src/components/AddFriendSearch.tsx:62` | `SearchField` / `"search"` | 单行：公共机制 |
| `apps/desktop/src/components/AddFriendSearch.tsx:322` | `textarea` / `"text"` | 多行：保留原回车规则 |
| `apps/desktop/src/mobile/assistant/PhoneHealth.tsx:166` | `input` / `"file"` | 非文本控件：过滤 |
| `apps/desktop/src/mobile/assistant/PhoneFiles.tsx:107` | `input` / `"file"` | 非文本控件：过滤 |
| `apps/desktop/src/mobile/assistant/PhoneCustomize.tsx:87` | `input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/mobile/assistant/PhoneCustomize.tsx:104` | `textarea` / `"text"` | 多行：保留原回车规则 |
| `apps/desktop/src/mobile/assistant/MobileAssistantApp.tsx:253` | `input` / `"file"` | 非文本控件：过滤 |
| `apps/desktop/src/mobile/assistant/PhoneConnectorSetup.tsx:248` | `input` / `{field.secret && !shown ? 'password' : 'text'}` | 单行：公共机制 |
| `apps/desktop/src/mobile/assistant/PhoneConnectorSetup.tsx:460` | `textarea` / `"text"` | 多行：保留原回车规则 |
| `apps/desktop/src/components/chat/MemberListPanel.tsx:440` | `SearchField` / `"search"` | 单行：公共机制 |
| `apps/desktop/src/components/assistant-ui/thread.aui.tsx:409` | `input` / `"file"` | 非文本控件：过滤 |
| `apps/desktop/src/components/chat/GroupMembersSection.tsx:223` | `textarea` / `"text"` | 多行：保留原回车规则 |
| `apps/desktop/src/components/chat/GroupMembersSection.tsx:260` | `input` / `"file"` | 非文本控件：过滤 |
| `apps/desktop/src/components/chat/AgentFloodThresholdSetting.tsx:127` | `input` / `"number"` | 单行：公共机制 |
| `apps/desktop/src/components/chat/ChatMessageComposer.tsx:167` | `input` / `"file"` | 非文本控件：过滤 |
| `apps/desktop/src/components/chat/ExpiredAttachmentCard.tsx:48` | `input` / `"file"` | 非文本控件：过滤 |
| `apps/desktop/src/components/chat/AgentQuestionCard.tsx:76` | `textarea` / `"text"` | 多行：保留原回车规则 |
| `apps/desktop/src/components/chat/ChatSearch.tsx:13` | `SearchField` / `"search"` | 单行：公共机制 |
| `apps/desktop/src/components/chat/DispatchSheet.tsx:118` | `textarea` / `"text"` | 多行：保留原回车规则 |
| `apps/desktop/src/components/chat/DispatchSheet.tsx:137` | `input` / `"checkbox"` | 非文本控件：过滤 |
| `apps/desktop/src/components/chat/AnnouncementDrawer.tsx:183` | `textarea` / `"text"` | 多行：保留原回车规则 |
| `apps/desktop/src/components/chat/AnnouncementDrawer.tsx:372` | `textarea` / `"text"` | 多行：保留原回车规则 |
| `apps/desktop/src/components/chat/ChatPickSheet.tsx:136` | `SearchField` / `"search"` | 单行：公共机制 |
| `apps/desktop/src/components/chat/GroupSettingsManagePage.tsx:117` | `input` / `"number"` | 单行：公共机制 |
| `apps/desktop/src/components/assistant-ui/ui/textarea.tsx:10` | `textarea` / `"text"` | 多行：保留原回车规则 |
| `apps/desktop/src/components/FeedbackModal.tsx:257` | `textarea` / `"text"` | 多行：保留原回车规则 |
| `apps/desktop/src/components/FeedbackModal.tsx:317` | `input` / `"file"` | 非文本控件：过滤 |
| `apps/desktop/src/components/agentsettings/AgentSharePane.tsx:98` | `SearchField` / `"search"` | 单行：公共机制 |
| `apps/desktop/src/components/agentsettings/AgentTasksPane.tsx:140` | `textarea` / `"text"` | 多行：保留原回车规则 |
| `apps/desktop/src/components/agentsettings/AgentProfilePane.tsx:130` | `input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/components/agentsettings/AgentProfilePane.tsx:195` | `input` / `"file"` | 非文本控件：过滤 |
| `apps/desktop/src/components/agentsettings/AgentProfilePane.tsx:219` | `input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/components/agentsettings/AgentProfilePane.tsx:229` | `textarea` / `"text"` | 多行：保留原回车规则 |
| `apps/desktop/src/components/settings/DeviceRemoveDialog.tsx:39` | `input` / `"checkbox"` | 非文本控件：过滤 |
| `apps/desktop/src/components/settings/channels/WechatConnectDialog.tsx:58` | `input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/components/settings/ModelSection.tsx:82` | `SearchField` / `"search"` | 单行：公共机制 |
| `apps/desktop/src/components/settings/MobileAppsSection.tsx:172` | `SearchField` / `"search"` | 单行：公共机制 |
| `apps/desktop/src/components/settings/AddServerPanel.tsx:353` | `Field.Input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/components/firstRun/FirstRunHarness.tsx:91` | `input` / `"checkbox"` | 非文本控件：过滤 |
| `apps/desktop/src/components/firstRun/FirstRunGate.tsx:260` | `input` / `"file"` | 非文本控件：过滤 |
| `apps/desktop/src/components/firstRun/FirstRunGate.tsx:265` | `input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/components/firstRun/FirstRunGate.tsx:296` | `input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/components/assistant/AssistantCloseHost.tsx:194` | `input` / `"checkbox"` | 非文本控件：过滤 |
| `apps/desktop/src/components/assistant/AssistantLibraryEditor.tsx:47` | `Input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/components/assistant/AssistantLibraryEditor.tsx:48` | `Input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/components/assistant/AssistantLibraryEditor.tsx:49` | `Input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/components/assistant/AssistantSetupIdentity.tsx:31` | `input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/components/assistant/AssistantChatSlot.tsx:86` | `input` / `"file"` | 非文本控件：过滤 |
| `apps/desktop/src/components/assistant/QuickChat.tsx:162` | `textarea` / `"text"` | 多行：保留原回车规则 |
| `apps/desktop/src/components/assistant/AssistantNameInline.tsx:54` | `input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/components/settings/DevicesSection.tsx:226` | `SearchField` / `"search"` | 单行：公共机制 |
| `apps/desktop/src/components/ui/HeaderSearch.tsx:71` | `SearchField` / `"search"` | 单行：公共机制 |
| `apps/desktop/src/components/ui/InlineNameInput.tsx:35` | `input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/components/ui/SearchField.tsx:47` | `InputPrimitive` / `"search"` | 单行：公共机制 |
| `apps/desktop/src/components/ui/Field.tsx:77` | `InputPrimitive` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/components/ui/Field.tsx:90` | `textarea` / `"text"` | 多行：保留原回车规则 |
| `apps/desktop/src/components/settings/AccountSection.tsx:152` | `input` / `"file"` | 非文本控件：过滤 |
| `apps/desktop/src/components/settings/AccountSection.tsx:160` | `input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/components/settings/AccountSection.tsx:180` | `input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/components/settings/AccountSection.tsx:221` | `input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/components/settings/FileStorageDashboard.tsx:142` | `input` / `"checkbox"` | 非文本控件：过滤 |
| `apps/desktop/src/components/settings/addServer/SshPromptCard.tsx:210` | `Field.Input` / `{visible ? 'text' : 'password'}` | 单行：公共机制 |
| `apps/desktop/src/components/settings/addServer/SshPromptCard.tsx:252` | `input` / `"checkbox"` | 非文本控件：过滤 |
| `apps/desktop/src/components/extensionBundle/ExtensionConsentSheet.tsx:132` | `input` / `"checkbox"` | 非文本控件：过滤 |
| `apps/desktop/src/components/MemberProfileCard.tsx:177` | `input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/session/renderer/lib/components/list-filters/list-filter-searchable-select.tsx:32` | `Input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/session/renderer/lib/components/list-filters/list-filter-multi-select.tsx:40` | `Input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/components/member-picker/MemberPicker.tsx:227` | `SearchField` / `"search"` | 单行：公共机制 |
| `apps/desktop/src/components/imageAnnotate/AnnotateNotes.tsx:30` | `Field.Input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/session/renderer/lib/CronPicker/CronPicker.tsx:159` | `input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/session/renderer/lib/CronPicker/CronPicker.tsx:333` | `Input` / `"number"` | 单行：公共机制 |
| `apps/desktop/src/components/ChatListPanel.tsx:995` | `SearchField` / `"search"` | 单行：公共机制 |
| `apps/desktop/src/components/appSlot/OpenWithPick.tsx:53` | `input` / `"checkbox"` | 非文本控件：过滤 |
| `apps/desktop/src/components/usage/ReferralCard.tsx:65` | `input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/components/usage/UsageCredits.tsx:97` | `input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/components/contacts/ShareAgentModal.tsx:147` | `SearchField` / `"search"` | 单行：公共机制 |
| `apps/desktop/src/components/contacts/OwnedAgentNameEditor.tsx:74` | `input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/components/contacts/ContactProfileCard.tsx:221` | `input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/components/contacts/JoinGroupById.tsx:114` | `SearchField` / `"search"` | 单行：公共机制 |
| `apps/desktop/src/components/contacts/TagDetail.tsx:175` | `SearchField` / `"search"` | 单行：公共机制 |
| `apps/desktop/src/components/contacts/ContactSearch.tsx:170` | `SearchField` / `"search"` | 单行：公共机制 |
| `apps/desktop/src/components/contacts/AliasSheet.tsx:51` | `input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/session/renderer/features/settings/components/BrowserSettingsCard.tsx:221` | `Input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/session/renderer/features/settings/components/BrowserSettingsCard.tsx:320` | `Input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/session/renderer/features/settings/components/keyboard-shortcuts-cheat-sheet.tsx:475` | `input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/session/renderer/features/settings/components/SessionSettingsRows.tsx:153` | `Input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/session/renderer/features/settings/components/MachineSettingsCard.tsx:39` | `Input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/session/renderer/features/global-search/global-search.tsx:100` | `input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/session/renderer/features/settings/agents-page/AgentAdvancedSection.tsx:206` | `Input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/session/renderer/features/settings/agents-page/AgentAdvancedSection.tsx:228` | `Input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/session/renderer/features/settings/agents-page/AgentAdvancedSection.tsx:249` | `Input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/session/renderer/features/settings/agents-page/InstallationOverrideCard.tsx:84` | `Input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/session/renderer/features/library/prompts/prompt-modal.tsx:56` | `Input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/session/renderer/features/integrations/integration-setup-modal.tsx:472` | `Input` / `{field.secret && !shown ? 'password' : 'text'}` | 单行：公共机制 |
| `apps/desktop/src/session/renderer/features/browser/browser-toolbar.tsx:198` | `Input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/session/renderer/features/projects/components/create-project-name-modal.tsx:110` | `Input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/session/renderer/features/settings/subscriptions/SubscriptionConnections.tsx:314` | `Input` / `"password"` | 单行：公共机制 |
| `apps/desktop/src/session/renderer/features/settings/subscriptions/SubscriptionConnections.tsx:324` | `input` / `"checkbox"` | 非文本控件：过滤 |
| `apps/desktop/src/session/renderer/features/settings/subscriptions/SubscriptionConnections.tsx:334` | `Input` / `"url"` | 单行：公共机制 |
| `apps/desktop/src/session/renderer/features/settings/subscriptions/SubscriptionConnections.tsx:350` | `Input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/session/renderer/features/sessions/rename-session-modal.tsx:78` | `Input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/session/renderer/features/extensions/app-settings-page.tsx:144` | `Input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/session/renderer/features/sessions/session-schedule-time-editor.tsx:61` | `input` / `"datetime-local"` | 单行：公共机制 |
| `apps/desktop/src/session/renderer/features/sessions/session-schedule-time-editor.tsx:82` | `input` / `"time"` | 单行：公共机制 |
| `apps/desktop/src/session/renderer/features/sessions/session-schedule-time-editor.tsx:93` | `input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/session/renderer/features/sessions/add-remote-modal.tsx:223` | `Input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/session/renderer/features/sessions/add-remote-modal.tsx:280` | `Input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/session/renderer/features/sessions/editor/editor-file-tree.tsx:587` | `input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/session/renderer/features/sessions/editor/editor-file-tree.tsx:836` | `input` / `"file"` | 非文本控件：过滤 |
| `apps/desktop/src/session/renderer/features/sessions/editor/editor-file-tree.tsx:882` | `input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/session/renderer/features/remote-hosts/workspace/remote-ports-tab-view.tsx:141` | `Input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/session/renderer/features/extensions/open-with-chooser.tsx:49` | `input` / `"checkbox"` | 非文本控件：过滤 |
| `apps/desktop/src/session/renderer/features/sessions/composer-context-tray.tsx:61` | `input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/session/renderer/features/sessions/acp/acp-chat-panel.tsx:1385` | `input` / `"file"` | 非文本控件：过滤 |
| `apps/desktop/src/session/renderer/features/assistant/assistant-personality.tsx:96` | `input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/session/renderer/features/assistant/assistant-personality.tsx:122` | `textarea` / `"text"` | 多行：保留原回车规则 |
| `apps/desktop/src/session/renderer/lib/ui/input.tsx:10` | `InputPrimitive` / `{type}` | 单行：公共机制 |
| `apps/desktop/src/session/renderer/lib/ui/textarea.tsx:6` | `textarea` / `"text"` | 多行：保留原回车规则 |
| `apps/desktop/src/session/renderer/lib/ui/editable-name-field.tsx:26` | `Input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/session/renderer/lib/ui/input-group.tsx:114` | `Input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/session/renderer/features/sessions/diff-view/changes-panel/components/commit-card.tsx:221` | `Input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/session/renderer/features/sessions/diff-view/changes-panel/components/commit-card.tsx:297` | `Input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/session/renderer/features/sessions/diff-view/changes-panel/components/commit-card.tsx:306` | `Input` / `"email"` | 单行：公共机制 |
| `apps/desktop/src/session/renderer/lib/ui/search-input.tsx:17` | `Input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/session/renderer/lib/ui/find-bar.tsx:48` | `Input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/session/renderer/features/sessions/session-config/initial-session-section.tsx:1773` | `input` / `"file"` | 非文本控件：过滤 |
| `apps/desktop/src/session/renderer/features/assistant/assistant-health.tsx:257` | `input` / `"file"` | 非文本控件：过滤 |
| `apps/desktop/src/session/renderer/features/assistant/assistant-widget-discover.tsx:101` | `textarea` / `"text"` | 多行：保留原回车规则 |
| `apps/desktop/src/session/renderer/features/assistant/assistant-memory-page.tsx:218` | `Input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/session/renderer/features/assistant/assistant-memory-page.tsx:379` | `input` / `"file"` | 非文本控件：过滤 |
| `apps/desktop/src/session/renderer/features/assistant/assistant-memory-page.tsx:419` | `Input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/session/renderer/features/tabs/tab-bar/generic-tab-item.tsx:153` | `input` / `"text"` | 单行：公共机制 |
| `apps/desktop/src/session/renderer/features/sessions/diff-view/changes-panel/components/pr-entry/create-pr-modal.tsx:223` | `Input` / `"text"` | 单行：公共机制 |
