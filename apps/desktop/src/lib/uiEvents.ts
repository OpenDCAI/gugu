
export const UI_EVENTS = {
  closeContextMenus: '__close_context_menus',
  updateReady: '__update_ready',
  updateStatus: '__update_status',
  // @@@5813 「更新说明」:设置→关于里那一行点了 → App 层常挂的 ReleaseNotesOpener 把人带到网页上。
  // 装完新版第一次打开时它自己会弹一次,这个事件只是让人随时能再翻一遍。
  openReleaseNotes: '__open_release_notes',
  // 设置 → 关于里重新打开首次登录的功能导览。
  reopenProductTour: '__reopen_product_tour',
  notificationClicked: '__notification_clicked',
  openUnreadMessage: '__open_unread_message',
  togglePasswordVisibility: '__ui_toggle_password_visibility',
  groupCollabChanged: '__group_collab_changed',
  // @@@1877 本机 Agent 删除成功后广播 { agentUserId }：会话列表(chat store)与已打开的群成员抽屉(ChatAreaPanel)
  // 据此即时把该 Agent 从各自 surface 乐观移除，与通讯录的即时更新看齐，不再等 realtime/refetch 兜底(1–3s 残留)。
  ownedAgentRemoved: '__owned_agent_removed',
  // #6091 会话页「重命名」弹窗改了自有 agent 的名字后广播 { agentUserId, displayName }:通讯录据此重新拉一遍,
  // 聊天页 / 资料卡 / 分享浮层读的都是通讯录那一份,❌ 让它们挂着旧名等 realtime。
  ownedAgentRenamed: '__owned_agent_renamed',
  quoteMessage: '__chat_quote_message',
  // @@@5856 这是个 **window 级**事件,而同一扇窗里现在有两个输入框(主线 + 话题分栏)。
  // 两份都听 ⇒ 一次 attach 同时进两个待发队列。所以只有主输入框(InputArea 的 surface='main')登记它 ——
  // 与 focusComposer 的登记表是同一个形状的坑:单例语义遇上第二个挂载点。
  composerAttachFiles: '__chat_composer_attach_files',
  // @@@5856 有一条「开成分栏」的请求待取(请求本体在 topicSplitRequest.ts 的盒子里)。
  // 事件只负责叫醒**已经挂着的**聊天区;没挂载的那种情况靠它挂载时自己去取。
  openTopicSplit: '__chat_open_topic_split',
  // @@@5856 分栏现在显示的是哪条话题(关掉时 chatId 为 null)。会话列表据此给话题子行高亮。
  // 只有这一个方向(聊天区 → 列表):「打开一条话题」不走事件,它就是普通的选中会话,
  // 由聊天区那个收口当场换成「来源线 + 分栏」(见 ChatAreaPanel 的话题收口)。
  topicSplitChanged: '__chat_topic_split_changed',
  agentStream: '__agent_stream',
  // @@@sessionpage fail-loud VISIBLE (#6) — 会话页 agent 投递终态失败:聊天流失败条在「任务」
  // tab 不可见,故 main 额外广播此事件 → renderer 弹可见 toast(fail-loud 让用户看见,不静默、不回退)。
  sessionpageDeliverFailed: '__sessionpage_deliver_failed',
  // @@@sessionpage 分享 — 会话页头部点了分享:main 转达「分享这个 agent」,由 gugu 渲染层用自己的
  // 通讯录数据打开既有的 SharePosterDialog(contact QR 名片)。
  sessionpageShareAgent: '__sessionpage_share_agent',
  // 设置「关于」与会话页报障入口共用同一个全局反馈弹窗(product spec)。
  sessionpageOpenFeedback: '__sessionpage_open_feedback',
  // 会话页要打开设置(⌘, / 应用菜单 / 命令面板 / 浏览器工具栏):设置是壳的弹窗(product spec),
  // detail = { section?: ActiveSection },缺省落在「账户」。
  openSettings: '__open_settings',
  // #7350 关闭咕咕:设置里的「关闭咕咕」、通讯录 / agent 设置里删它都只发这一声,确认框只有一个(AssistantCloseHost)。
  closeAssistant: '__close_assistant',
  // 手机的全局设置与资料页打开同一份连接应用流程。
  openAssistantConnectors: '__open_assistant_connectors',
  // #7199「助理」App 顶上那一排的「搜索」:摆在眼前的那块聊天面进入搜索(与 Alt+F 同一个动作)。
  openContact: '__open_contact',
  openChatSearch: '__open_chat_search',
  openPhoneListSearch: '__open_phone_list_search',
  sessionpageShareAgentUnavailable: '__sessionpage_share_agent_unavailable',
  // #6646 会话页要人当场决定一件事(装扩展的同意框就画在它里面):不在任务 tab 上就切过去。
  sessionpageReveal: '__sessionpage_reveal',
  // 「在本群打开」(app-redesign §5): an App was opened from a chat (detail = { extensionId, chatId? }) — `useOpenApp`.
  openApp: '__open_app',
  // 群成员面板里「新建 Agent 并加入本群」(detail = { chatId }):壳打开新建 Agent 的那一页,并带上这个群
  // —— 建出来的 agent 一出生就进群(与 session_spawn 的 chat_id 同一条 birth-groups 链),建完回到这个群。
  createAgentInGroup: '__create_agent_in_group',
  // Something was asked of a chat (摩擦单 F10, 真源原则 13): a file or an App beside it (askChat, chat-tabs), a
  // message in its list (askReveal) — the view showing that chat takes it, now or when it shows it.
  chatAsked: '__chat_asked',
  // gugu-dev#181 会话页侧栏「对话」页的两行入口:新建群聊、添加联系人。弹窗是聊天列表那一套,会话页只转达。
  // #6646 扩展详情里点了「转发」:聊天壳用同一个转发页把这个扩展发出去(detail = ExtensionForwardRequest)。
  forwardExtension: '__forward_extension',
} as const
