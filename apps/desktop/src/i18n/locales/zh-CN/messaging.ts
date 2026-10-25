export default {
  "agent": {
    "identity": {
      "phone": "手机 Agent",
      "pending": "智能体 · 类型确认中",
      "unavailable": "智能体类型不可用",
      "removed": "已移除的智能体",
      "cloud": "Gagent"
    },
    "fallbackName": "助手",
    "hostStale": {
      "hint": "Agent 所在设备的咕咕版本较旧，部分运行信息可能缺失。",
      "label": "主机旧"
    },
    "notification": {
      "online": "Agent 已上线",
      "replyFailed": "Agent 回复失败",
      "startedWorking": "Agent 已开始工作",
      "startFailed": "Agent 启动失败"
    },
    "offlineWarning": "当前不在线，可能无法及时回复",
    "wakeRefused": "{{name}}现在上不了线：",
    "taskpage": {
      "permission": {
        "allow": "允许",
        "queuePosition": "（第 {{current}} 条，共 {{total}} 条）",
        "alreadyAnswered": "已在别处答过了。",
        "noLongerWaiting": "已经不等了：这一问已经结束，没有装。",
        "failed": "批准没有送达，请在任务中打开后作答。"
      },
      "open": "在任务中打开",
      "openFailed": "无法在任务中打开：{{reason}}",
      "mode": {
        "menu": "模式：{{mode}}",
        "code": "编程",
        "general": "通用",
        "switchToCode": "切换为编程模式",
        "switchToGeneral": "切换为通用模式"
      },
      "review": {
        "action": "请打开任务终端检查 MCP server，然后按 Enter 确认。",
        "title": "Agent 正等待 MCP review"
      },
      "statusSourceFault": {
        "title": "这个任务的状态来源失效：按 Esc 打断后状态可能不会更新"
      },
      "providerBlocker": {
        "action": "请打开任务终端继续处理。",
        "title": "Agent 被 provider 配置阻塞"
      },
      "recoveryFailed": {
        "retry": "重试恢复",
        "retryError": "恢复重试失败，请稍后再试。",
        "retrying": "恢复重试中…",
        "title": "任务恢复失败",
        "unknown": "无法恢复这个任务。"
      },
      "startupFailure": {
        "retry": "重试",
        "retrying": "重试中…",
        "title": "任务启动失败"
      },
      "statusReadFailed": "无法读取任务状态：{{reason}}"
    },
    "turnFailure": {
      "statusReadFailed": "回复状态暂时读不到，请重试。",
      "weeklyQuota": "周限额度不足，当前账号暂时无法回复。",
      "monthlyQuota": "月限额度不足，当前账号暂时无法回复。",
      "rateLimited": "请求过于频繁，请稍后重试。",
      "quota": "当前模型账号的额度已用完，请切换模型或等待额度恢复。",
      "modelUnavailable": "模型服务暂时不可用，请稍后重试或切换模型。",
      "changeModel": "切换模型",
      "close": "关闭",
      "generic": "Agent 本次回复出错，未能完成",
      "notAdmitted": "消息已保留，助理就绪后回复。",
      "undelivered": "消息暂未送达：没有运行中的咕咕实例持有这个 Agent，打开那个实例后会由它读取。",
      "offline": "设备连接中断，本次回复未完成",
      "retry": "重试",
      "retrying": "重试中…",
      "timeout": "Agent 长时间未响应，本次回复未完成"
    }
  },
  "announcement": {
    "contentPlaceholder": "输入公告内容…",
    "delete": "删除",
    "deleteConfirm": "确认删除此公告？",
    "deleteTitle": "删除公告",
    "edit": "编辑",
    "editTitle": "编辑公告",
    "empty": "暂无群公告",
    "like": "点赞",
    "loading": "加载中...",
    "pin": "置顶公告",
    "pinned": "置顶",
    "post": "发布公告",
    "posting": "发布中…",
    "title": "群公告",
    "unlike": "取消点赞",
    "unpin": "取消置顶"
  },
  "chatArea": {
    "agentLocation": {
      "cloud": "咕咕云",
      "local": "本机"
    },
    "agentSettings": "Agent 设置",
    "attachment": "[附件]",
    "backToList": "返回对话列表",
    "conversationProfile": "查看对话资料",
    "downloadFailed": "无法下载文件",
    "filePreview": { "close": "关闭文件预览", "download": "下载", "openExternal": "外部打开", "loading": "读取文件中…", "rendering": "正在生成预览…", "renderFailed": "无法渲染此文件", "sheetTruncated": "表格太大，只显示了前面一部分。完整内容请用 Office 软件打开。", "openInOffice": "用 Office 软件打开", "previewLimits": "此文档过大或结构过于复杂，无法安全预览。", "unsupported": "此文件类型暂不支持内置预览，请下载或使用外部打开。", "readFailed": "读取文件失败（{{status}}）", "pdfControls": "PDF 控制", "previousPage": "上一页", "nextPage": "下一页", "zoomOut": "缩小", "zoomIn": "放大", "fitWidth": "适合宽度", "pdfPage": "PDF 第 {{page}} 页" },
    "empty": {
      "chats": "选择一个对话开始聊天",
      "contacts": "选择联系人查看详情"
    },
    "engineMissing": "引擎未知",
    "engineMissingTitle": "该 Agent 未配置运行引擎",
    "firstConversationDescription": "发条消息，开始你们的第一次对话。",
    "firstConversationTitle": "和 {{name}} 打个招呼",
    "importedHistoryLoadFailed": "导入历史加载失败",
    "loadFailedBody": "这次没读到，不是没有聊过。可以重试。",
    "loadFailedCopy": "复制",
    "loadFailedDetails": "查看详情",
    "loadFailedHideDetails": "收起详情",
    "loadFailedRetry": "重试",
    "loadFailedStale": "没能读到最新的聊天记录，下面是之前读到的。",
    "loadFailedTitle": "聊天记录没读出来",
    "management": {
      "actionFailed": "{{action}}失败：{{reason}}",
      "clear": "清空",
      "clearConfirm": "确认清空所有聊天记录？",
      "clearHistory": "清空聊天记录",
      "dissolve": "解散群聊",
      "dissolveConfirm": "解散后所有成员将退出，确认解散群聊？",
      "exit": "退出群聊",
      "exitConfirm": "确认退出该群聊？",
      "notificationFailed": "通知设置失败：{{reason}}",
      "notifications": "消息通知",
      "pin": "置顶对话",
      "pinFailed": "置顶设置失败：{{reason}}",
      "processing": "处理中…",
      "searchHistory": "查找聊天记录",
      "unpin": "取消置顶对话"
    },
    "returnToLatest": "回到最新",
    "newMessages": "{{count}} 条新消息 ↓",
    "newMessages_one": "{{count}} 条新消息 ↓",
    "newMessages_other": "{{count}} 条新消息 ↓",
    "unreadAbove": "↑ {{count}} 条新消息",
    "unreadAbove_one": "↑ {{count}} 条新消息",
    "unreadAbove_other": "↑ {{count}} 条新消息",
    "noMessages": "暂无消息，发一条开始聊天",
    "notificationLevel": {
      "all": "全部",
      "important": "仅重要",
      "label": "消息通知级别",
      "none": "不通知"
    },
    "operationFailed": "操作失败，请稍后重试",
    "pinnedMessage": "📌 有一条置顶消息",
    "searchMessages": "搜索消息",
    "searchNoResults": "未找到“{{query}}”相关消息",
    "selectedMessages": "已选 {{count}} 条",
    "selectedMessages_one": "已选 {{count}} 条",
    "selectedMessages_other": "已选 {{count}} 条",
    "sendReply": "发送回复",
    "settings": {
      "conversation": "对话设置",
      "group": "群设置",
      "members": "聊天成员"
    },
    "appEnable": {
      "title": "给哪些 agent",
      "alsoOn": "也装到这几台",
      "machine": "这台电脑",
      "all": "所有 agent",
      "allSub": "包括各个项目里的 agent",
      "chosen": "agent、群和项目 · {{count}}",
      "project": "项目",
      "cardGroup": "卡片所在",
      "agent": "你的 agent",
      "members": "{{count}} 人",
      "remove": "不再给{{name}}",
      "add": "添加 agent、群或项目…",
      "emptyInstall": "还没有选。不选也能装，以后在「App」页里加。",
      "empty": "还没有选。",
      "hint": "选中的 agent，和选中的群里的 agent，能用它的工具。",
      "pickerTitle": "添加 agent、群或项目",
      "search": "搜索 agent、群、项目或话题",
      "agents": "你的 agent",
      "recent": "最近聊过的群",
      "topicHint": "话题「{{name}}」在这个群里",
      "picked": "已选 {{count}} 个",
      "done": "完成",
      "noPlaces": "你还没有 agent，也不在任何群里",
      "noMatch": "没有找到",
      "used": "给了：",
      "hereAll": "本机所有 agent",
      "hereAllOn": "「{{machine}}」上所有 agent",
      "more": "{{names}} 等 {{count}} 处",
      "none": "还没有给任何 agent——没有 agent 拿到它的工具"
    },
    "peek": {
      "openFull": "整页打开",
      "session": "任务",
      "unsupported": "此类文件不支持预览，请用系统应用打开。"
    },
    "openWith": {
      "always": "始终用它",
      "back": "返回",
      "more": "更多",
      "maximize": "面板全屏",
      "restore": "还原面板",
      "resize": "调整面板宽度",
      "offer": "用『{{name}}』打开",
      "appFiles": "『{{name}}』的文件",
      "fileUnavailable": "这里打不开这个文件：它可能已被删除，或者不在这个对话里。",
      "noOpener": "本机没有能打开『{{name}}』的 App，咕咕市场里也没有。",
      "marketUnreadable": "本机没有能打开『{{name}}』的 App；咕咕市场现在读不到，稍后再试。",
      "offerFromMarket": "它是咕咕市场里的 App，在这里装一次就好。",
      "switchedOffWhy": "这个文件是『{{name}}』的，它装着，但停用了。启用它，就用它打开。",
      "switchOn": "启用",
      "switchFailed": "没启用上，稍后再试。",
      "arriving": "『{{name}}』正在装好，装好马上在这里打开。",
      "arrivingWaits": "『{{name}}』还没装好：这次没能从下载站取到。可以再试一次；下次打开咕咕时它也会自己装上。",
      "arrivingRetry": "再试一次",
      "installFailed": "没装上，稍后再试。",
      "offerWhy": "这个文件是『{{name}}』的，本机还没装。装上就用它打开。",
      "updateHere": "这个对话里已有 {{version}}",
      "update": "更新",
      "default": "默认",
      "showRaw": "查看原始内容",
      "hideRaw": "收起原始内容",
      "install": "安装",
      "unavailable": "这个 App 现在打不开：没装上，或者已经停用。",
      "title": "用哪个打开「{{name}}」"
    },
    "source": {
      "notVisible": "该来源消息不在当前视图（可能未加载或在话题里）"
    },
    "suggestions": {
      "help": "你能帮我做什么？",
      "introduction": "介绍一下你自己"
    }
  },
  "chatList": {
    "addContact": "添加联系人",
    "clearSearch": "清除搜索",
    "create": "新建",
    "createTask": "新建任务",
    "createAgent": "新建 Agent",
    "createGroup": "新建群聊",
    "delete": "删除",
    "disableNotifications": "关闭通知",
    "draft": "[草稿]",
    "moreTopics": "更多 · {{count}}",
    "moreTopics_one": "更多 · {{count}}",
    "moreTopics_other": "更多 · {{count}}",
    "empty": "暂无对话",
    "emptyHint": "点上方“新建 Agent”开始第一段对话",
    "emptyHintMobile": "去「项目」页右上角新建 Agent，开始第一段对话",
    "enableNotifications": "开启通知",
    "markAllRead": "全部标为已读",
    "markAllReadFailed": "未能全部标为已读，请重试",
    "markAllReadPartial": "有 {{count}} 个会话未能标为已读，请重试",
    "markAllReadPartial_one": "有 {{count}} 个会话未能标为已读，请重试",
    "markAllReadPartial_other": "有 {{count}} 个会话未能标为已读，请重试",
    "markUnreadFailed": "标记未读失败，请重试",
    "muted": "消息免打扰",
    "noResults": "未找到对话",
    "listLabel": "对话列表",
    "pin": "置顶",
    "scan": "扫一扫",
    "search": "搜索",
    "unpin": "取消置顶"
  },
  "chatService": {
    "errors": {
      "announcementRequired": "公告内容不能为空",
      "cloudAgentGroupUnsupported": "云端 Agent 暂不支持加入群聊",
      "removeMemberFailed": "移除成员失败：没有权限移除该成员，或该成员已不在群内",
      "setListenModeFailed": "没改成，档位还是原来的"
    },
    "groupAction": {
      "joined": "已加入群聊",
      "roleUpdated": "群角色已更新"
    },
    "runtimeOpen": {
      "cmuxUnavailable": "运行窗口连接失败，可在项目设置里启用 tmux 后重试。",
      "incomplete": "运行窗口信息不完整，无法打开。",
      "localMissing": "此 Agent 的运行窗口不在本机。请在 Agent 所在设备上打开。",
      "opened": "已打开 Agent 运行窗口",
      "remoteUnsupported": "此 Agent 正在其他设备上运行，暂时无法从这里打开运行窗口。",
      "removed": "Agent 已移除，无法打开运行窗口",
      "staleTmux": "此 Agent 在本机的运行窗口已关闭。",
      "unavailable": "这个 Agent 还没有可打开的运行窗口。",
      "unbound": "此 Agent 尚未连接运行设备。"
    },
    "scheduler": {
      "paused": "自动分配已暂停，等待手动恢复",
      "resumed": "自动分配已开启，等待队列重新分配"
    },
    "taskAction": {
      "cancelled": "任务已取消",
      "paused": "任务已暂停，等待重新进入队列",
      "retried": "任务已重新进入执行队列",
      "transferred": "已请求重新分配负责 Agent"
    }
  },
  "common": {
    "back": "返回",
    "cancel": "取消",
    "close": "关闭",
    "collapse": "收起",
    "discard": "丢弃",
    "done": "完成",
    "download": "下载",
    "expand": "展开",
    "loading": "加载中...",
    "retry": "重试",
    "save": "保存",
    "saving": "保存中…",
    "send": "发送",
    "settings": "设置"
  },
  "attachmentView": {
    "fileGone": "文件已删除",
    "fileVersion": "第 {{n}} 版",
    "fileUnavailable": "文件暂时打不开",
    "imageUnavailable": "图片暂时打不开",
    "newerInFolder": "文件夹里有新版",
    "retry": "重试"
  },
  "composePick": {
    "title": "选择发送位置",
    "search": "搜索对话或任务",
    "chats": "对话",
    "tasks": "我的任务",
    "empty": "没有可选的对话或任务",
    "action": "放入输入框"
  },
  "composer": {
    "notInGroup": "不在本群",
    "agent": {
      "disabledReason": {
        "removed": "Agent 已移除，不能继续发送消息",
        "retiredCloud": "咕咕云 Agent 已下线，历史消息仍可查看"
      },
      "placeholder": {
        "retiredCloud": "咕咕云 Agent 已下线"
      }
    },
    "attachmentContextMissing": "附件发送失败：当前对话已不可用",
    "attachmentPersistenceFailed": "附件 {{fileName}} 保存失败。",
    "attach": "添加",
    "cancelQuote": "取消引用",
    "commands": {
      "clear": "清空输入框",
      "shrug": "插入 ¯\\_(ツ)_/¯"
    },
    "disabled": "当前对话不可发送",
    "exitWhisper": "退出悄悄话",
    "file": "文件",
    "memberType": {
      "agent": "Agent",
      "all": "全员",
      "member": "成员"
    },
    "mentionAll": "所有人",
    "mentionMembers": "@ 提及成员",
    "mentionNoMatch": "没有匹配的成员",
    "placeholder": "发送消息… 输入 / 唤起命令",
    "mobilePlaceholder": "消息",
    "projectGroupPlaceholder": "发消息给 {{name}}… @ 某个 agent 叫它",
    "removeAttachment": "移除 {{fileName}}",
    "sendFailed": "发送失败：{{reason}}",
    "slashCommands": "斜杠命令",
    "verb": {
      "task": "新任务"
    },
    "whisperBanner": "悄悄话给 {{name}} · 仅你与对方可见",
    "whisperPlaceholder": "悄悄话给 {{name}}…"
  },
  "emoji": {
    "moreReactions": "更多表情",
    "workStatus": "工作状态",
    "frequent": "常用",
    "quickReactions": "快速回应",
    "reactWith": "回应 {{emoji}}"
  },
  "forward": {
    "batchPreview": "转发 {{count}} 条消息",
    "batchPreview_one": "转发 {{count}} 条消息",
    "batchPreview_other": "转发 {{count}} 条消息",
    "failed": "转发失败",
    "forwarding": "转发中…",
    "noResults": "未找到对话",
    "noTargets": "暂无可转发的对话",
    "preview": {
      "attachment": "[附件]",
      "card": "[卡片]",
      "empty": "[空消息]"
    },
    "searchChats": "搜索对话",
    "selectAtLeastOne": "至少选择一个对话",
    "selected": "已选 {{count}} 个",
    "selected_one": "已选 {{count}} 个",
    "selected_other": "已选 {{count}} 个",
    "shareFailed": "没能分享，请稍后再试",
    "shareToApps": "分享到其他应用",
    "title": "转发"
  },
  "group": {
    "projectGroupNoInvite": "项目群只有你和你的 agent。要与其他人协作，请在对话中新建群聊。",
    "addMember": "添加成员",
    "agentFlood": {
      "ledgerLoadFailed": "读不到这条自动调档的台账，撤回入口暂时给不出来。过一会儿重开这条线再试。",
      "undoAll": "全部撤回",
      "undoFailed": "撤回没成功，档位还是刚才那样。再点一次「全部撤回」试试。",
      "undoing": "撤回中…",
      "undone": "已撤回"
    },
    "collab": {
      "loadTimeout": "调度数据加载超时，请稍后重试"
    },
    "editName": "编辑群名",
    "memberFallback": {
      "removedAgent": "已移除 Agent",
      "unknown": "未知成员"
    },
    "memberJoined": {
      "joined": " 加入了群聊",
      "mentionHint": "在输入框里 @{{name}}",
      "separator": "、"
    },
    "memberList": {
      "agentLeave": "让它退出群聊",
      "clearSearch": "清除搜索",
      "createAgent": "新建 Agent 并加入本群",
      "invite": "邀请成员",
      "makeAdmin": "设为管理员",
      "manage": "管理 {{name}}",
      "noMatches": "没有匹配「{{query}}」的成员",
      "revokeAdmin": "取消管理员",
      "search": "搜索成员、主人或引擎",
      "setActive": "改为主动",
      "setPassive": "改为被动",
      "loadFailed": "成员名单没加载出来。关掉再打开一次 👥 试试。",
      "notParticipant": "你还不是这条话题的参与者，所以看不到成员名单。在里面说一句就进来了。",
      "sectionAgents": "Agent",
      "sectionPeople": "人",
      "myAgents": "我的 agent · {{count}}",
      "title": "群成员",
      "titleTopic": "话题成员"
    },
    "topicInvite": {
      "title": "添加话题成员",
      "search": "搜索成员",
      "message": "{{names}} 邀请你们加入话题。",
      "confirm": "添加（{{count}}）",
      "empty": "来源对话中暂无其他可添加的成员。",
      "noResults": "没有匹配的成员。",
      "failed": "邀请未完成，请重试。"
    },
    "join": {
      "denied": {
        "agentNotOwned": "只能添加你自己的 Agent",
        "agentOwnerLeft": "这个 Agent 的主人已经不在群里，申请不再有效",
        "alreadyDecided": "这条申请已经处理过了",
        "generic": "没能加入群聊，请稍后再试",
        "groupArchived": "这个群已经解散",
        "memberLimit": "群成员已满，先调高人数上限再处理",
        "notMember": "你已经不在这个群里",
        "requesterLeft": "发起申请的人已经退群，申请不再有效"
      }
    },
    "nameLoading": "加载中...",
    "namePlaceholder": "群名称",
    "picker": {
      "agentRequestPending": "已提交审批，等群主或管理员批准",
      "agentRequestRejected": "上次的申请被拒绝了，可以再提交一次",
      "invitationSent": "已发送 {{count}} 个邀请，等待本人或 Agent 主人接受后入群",
      "pendingApproval": "已提交审批：{{count}} 个 Agent 等群主或管理员批准后入群",
      "pendingApproval_one": "已提交审批：{{count}} 个 Agent 等群主或管理员批准后入群",
      "pendingApproval_other": "已提交审批：{{count}} 个 Agent 等群主或管理员批准后入群",
      "add": "添加",
      "addWithCount": "添加 · {{count}} 位成员",
      "addWithCount_one": "添加 · {{count}} 位成员",
      "addWithCount_other": "添加 · {{count}} 位成员",
      "adding": "添加中…",
      "allFailed": "{{failed}} 人添加失败：{{reason}}",
      "humanPermissionHint": "你当前不能邀请人类成员；仍可添加你自己的 Agent。",
      "partialFailure": "{{succeeded}} 人已加入，{{failed}} 人添加失败：{{reason}}",
      "title": "添加群成员"
    },
    "renameFailed": "改名没成功——检查一下网络或你的权限，再按一次回车",
    "renameHintTopic": "编辑话题名",
    "renamePlaceholderTopic": "话题名称",
    "settings": {
      "notLoaded": "群设置还没加载完，请稍后再试",
      "manage": "群管理",
      "saveFailed": "保存失败，已恢复为原来的设置。请重试。",
      "sectionAgents": "Agent 协作",
      "sectionChat": "聊天",
      "sectionInvite": "邀请",
      "sectionJoin": "入群",
      "sectionMembers": "成员",
      "agentJoinRequestedBy": "{{name}} 申请把这个 Agent 拉进群",
      "accept": "同意",
      "agentFloodTopics": "话题阈值",
      "agentFloodTopicsFailed": "话题列表未能加载。",
      "agentFloodPermissionsFailed": "话题管理权限未能加载，暂时只读。",
      "agentFloodLoadFailed": "阈值未能加载，请重新打开设置。",
      "agentFloodSaveFailed": "阈值保存失败，请重试。",
      "agentFloodThreshold": "Agent 超过这个数就全员转被动",
      "agentFloodThresholdAria": "Agent 超过几个转被动",
      "agentFloodThresholdDefaultHint": "留空 = 用产品默认。当前生效 {{count}} 个。过线之后只有 @ 点名才叫得醒它们。",
      "agentFloodThresholdError": "这个数必须是 ≥1 的整数",
      "agentFloodThresholdInheritHint": "留空 = 跟随来源那条线。当前生效 {{count}} 个。过线之后只有 @ 点名才叫得醒它们。",
      "agentApproval": "Agent 加入需审批",
      "agentApprovalAria": "Agent 加入需要审批",
      "agentApprovalDescription": "普通成员拉进来的 Agent 要群主或管理员在联系人「新的请求」里同意后才入群",
      "allowMemberInvite": "允许成员邀人",
      "allowMemberInviteAria": "允许普通成员邀请联系人",
      "allowMemberInviteDescription": "开启后普通成员也可邀请联系人入群",
      "avatarUpdated": "群头像已更新",
      "avatarUploadFailed": "群头像上传失败：{{reason}}",
      "changeAvatar": "点击或拖入图片更换群头像",
      "copyLink": "复制链接",
      "description": "群描述",
      "descriptionPlaceholder": "一句话介绍这个群…",
      "descriptionUnset": "未设置群描述",
      "discoverable": "公开到广场",
      "discoverableAria": "公开群聊到广场",
      "discoverableDescription": "开启后任何人可在「发现 → 广场」按名称、简介或创建者搜到并申请加入",
      "dissolve": "解散群聊",
      "dissolveConfirm": "解散后所有成员将退出，确认解散群聊？",
      "emptyMembers": "暂无群成员",
      "groupFallback": "群",
      "hideHistory": "隐藏聊天记录",
      "hideHistoryAria": "对新成员隐藏历史聊天记录",
      "hideHistoryDescription": "新成员看不到加入前的消息",
      "imageRequired": "请选择图片文件",
      "imageTooLarge": "文件大小不能超过 5MB",
      "inviteCopied": "邀请链接已复制",
      "inviteCopyFailed": "复制失败，请手动复制链接",
      "inviteLink": "邀请链接",
      "inviteLinkAria": "启用群邀请链接",
      "inviteLinkDescription": "开启后可通过链接加入本群",
      "joinMode": "加入方式",
      "joinModeDescriptions": {
        "approval": "入群需管理员审批",
        "inviteOnly": "仅通过管理员邀请加入",
        "open": "任何人扫码或点链接直接进群"
      },
      "joinModeOptions": {
        "approval": "需审批",
        "inviteOnly": "仅邀请",
        "open": "直接加入"
      },
      "leave": "离开群组",
      "leaveConfirm": "确认离开群组？",
      "loadFailed": "群设置加载失败：{{reason}}",
      "memberCount": "{{count}} 名成员",
      "memberCount_one": "{{count}} 名成员",
      "memberCount_other": "{{count}} 名成员",
      "memberLimit": "成员上限",
      "memberLimitError": "成员上限必须是 ≥1 的整数",
      "members": "群成员",
      "posterCta": "扫码加入群聊，一起和 AI 协作",
      "posterQrCaption": "扫码加入群聊",
      "posterSubtitle": "群聊 · {{count}} 位成员",
      "posterSubtitle_one": "群聊 · {{count}} 位成员",
      "posterSubtitle_other": "群聊 · {{count}} 位成员",
      "reject": "拒绝",
      "removeConfirm": "将 {{name}} 移出群聊？",
      "removeMember": "将 {{name}} 移出群聊",
      "removeMemberTitle": "移出群聊",
      "requestsLoadFailed": "入群请求加载失败：{{reason}}",
      "role": {
        "admin": "管理员",
        "owner": "群主"
      },
      "rules": "协作规则",
      "rulesPlaceholder": "群协作规则：核心原则、方向确认、协作约定…",
      "rulesUnset": "未设置协作规则",
      "sharePoster": "分享本群（生成海报）",
      "title": "群设置",
      "unavailable": "不可用",
      "uploading": "上传中"
    }
  },
  "header": {
    "groupApps": "群 Apps",
    "personalPins": "仅自己",
    "pinGroupApp": "将{{name}}固定到本群头栏",
    "unpinGroupApp": "从本群头栏移除{{name}}",
    "appPinsLoadFailed": "无法读取固定的 App。",
    "appPinsSaveFailed": "无法保存固定的 App。",
    "noGroupApps": "本设备暂无可用的 App。",
    "openInGroup": "在这个群里打开…",
    "announcement": "群公告",
    "memberList": "成员列表",
    "more": "更多操作",
    "searchChat": "搜索对话",
    "searchConversation": "在对话中搜索",
    "groupFolder": "群文件夹",
    "folder": "文件夹"
  },
  "history": {
    "searchTopics": "搜索话题",
    "createTopic": "开话题",
    "downloadFile": "下载 {{fileName}}",
    "empty": {
      "searchTopics": "未找到匹配的话题",
      "attachments": "暂无附件",
      "imported": "暂无导入历史",
      "topics": "暂无话题"
    },
    "fileMeta": "{{senderName}} · {{size}} · {{date}}",
    "filters": {
      "all": "全部",
      "documents": "文档",
      "images": "图片",
      "mine": "我的"
    },
    "tabs": {
      "attachments": "附件",
      "imported": "导入历史",
      "topics": "话题"
    },
    "title": "历史",
    "topicMeta": "{{participantCount}} 人 · {{messageCount}} 条 · {{date}}"
  },
  "importedHistory": {
    "agentRole": "Agent",
    "backToList": "返回导入历史列表",
    "label": "导入历史",
    "turnMeta": "{{count}} 条 · {{date}}",
    "turnMeta_one": "{{count}} 条 · {{date}}",
    "turnMeta_other": "{{count}} 条 · {{date}}",
    "userRole": "你",
    "view": "查看 {{title}}"
  },
  "message": {
    "myAgentSuffix": "（我的 agent）",
    "agentOwnerUnavailableSuffix": "（主人信息不可用）",
    "agentOwnerSuffix": "（{{owner}} 的 agent）",
    "actions": {
      "comingSoon": "即将开放",
      "copy": "复制文本",
      "delete": "删除",
      "edit": "编辑",
      "forward": "转发",
      "more": "更多",
      "openTopic": "开话题",
      "react": "表情回应",
      "reply": "回复",
      "select": "多选"
    },
    "attachment": "[附件]",
    "copied": "已复制",
    "copyFailed": "复制失败，请手动选择文本复制",
    "forwarded": "↪ 转发",
    "forwardedFrom": "↪ 引自：{{line}}",
    "me": "我",
    "read": "已读",
    "readCount": "已读 {{read}}",
    "readUnreadCount": "已读 {{read}} · 未读 {{unread}}",
    "receipt": {
      "allRead": "全部已读",
      "noneRead": "暂无成员已读",
      "title": "已读回执"
    },
    "retracted": "消息已撤回",
    "sendStatus": {
      "failed": "未送达",
      "failedActions": "未送达消息操作",
      "failedHint": "未送达，点击重试或丢弃",
      "sending": "发送中"
    },
    "showQuoted": "跳到被引用的消息",
    "taskCard": {
      "task": "新任务",
      "schedule": "已安排",
      "handedTo": "交给",
      "onMachine": "在 {{machine}} 上",
      "onColleagueComputer": "{{name}} 的任务 · 无法查看",
      "awaitingApproval": "等群主同意它进群",
      "rejected": "群主没有同意它进群，结果在它的会话里",
      "open": "打开这个会话",
      "line": "新任务：{{text}}",
      "scheduleLine": "已安排：{{text}}",
      "question": "需要你确认",
      "questionLine": "需要你确认：{{text}}",
      "questionAnswered": "已回答：{{answer}}",
      "questionInSession": "到任务里回答"
    },
    "unread": "未读",
    "aiSent": "AI 发送",
    "agentSentForYou": "由 {{agent}} 代你发送",
    "openSendingAgent": "打开 {{agent}} 的对话",
    "sendingAgentRemoved": "代发 Agent 已移除",
    "openSendingAgentFailed": "无法打开代发 Agent 的对话",
    "viaApp": "由『{{app}}』App 代你发送",
    "viaAppFor": "由『{{app}}』App 代 {{name}} 发送",
    "voice": "语音消息 {{duration}}",
    "whisperBoth": "悄悄话 · 仅你与对方可见",
    "whisperOnlyYou": "悄悄话 · 仅你可见",
    "whisperTo": "悄悄话给 {{name}} · 仅你与对方可见",
    "widget": "[Widget]",
    "widgetCard": {
      "empty": "无内容",
      "loading": "加载中"
    }
  },
  "outbox": {
    "deliveryTimeout": "投递超时 {{seconds}}s（网络挂起）",
    "discarded": "已丢弃",
    "offscreenFailure": "有消息未送达，回到对应对话可重试或丢弃",
    "recipientMissing": "收件人已不可用，消息未发送。",
    "sendFailed": "发送失败"
  },
  "shareIntake": {
    "back": "返回",
    "failures": "没能读取：{{names}}",
    "listSeparator": "、",
    "noChats": "还没有对话",
    "noResults": "没有匹配的对话",
    "nothingToSend": "没有可以发送的内容",
    "reason": {
      "refused": "不能分享咕咕自己的文件",
      "tooLarge": "超过 100 MB",
      "unreadable": "读不出来"
    },
    "searchChats": "搜索对话",
    "title": "发送到"
  },
  "topic": {
    "anchor": {
      "lead": "话题",
      "separator": " · ",
      "messageCount": "{{count}} 条",
      "messageCount_one": "{{count}} 条",
      "participantCount": "{{count}} 人参与",
      "participantCount_one": "{{count}} 人参与",
      "observer": "只看得见",
      "openedBy": "{{name}}开的",
      "quiet": "还没有人说话"
    },
    "breadcrumb": {
      "sourceDeleted": "来源消息已被删除，这条话题继续存在",
      "sourcePreview": "引自：{{preview}}"
    },
    "openFailed": "话题没开出来。稍等一下再试；一直不行就换一条消息开。",
    "pane": {
      "attachments": "附件",
      "members": "成员",
      "collapseSplit": "收起分栏",
      "collapseSplitHint": "收起分栏，话题不会关闭",
      "composerPlaceholder": "在这条话题里说…",
      "empty": "还没有人在这条话题里说话",
      "resize": "拖动改变话题分栏的宽度"
    }
  },
  "forum": {
    "communityPoints": "社区积分 {{count}}", "communityPoints_one": "社区积分 {{count}}", "communityPoints_other": "社区积分 {{count}}",
    "consent": {
      "cancel": "取消",
      "postTitle": "发布悬赏",
      "postBody": "发布后从你的社区积分中扣除 {{amount}} 积分。采纳后发给被采纳的回答者；截止时从未有人回答，全额退还；有过回答但未采纳，积分作废。",
      "postConfirm": "发布",
      "reward": "赏金 {{amount}} 积分",
      "days": "{{count}} 天后截止", "days_one": "{{count}} 天后截止", "days_other": "{{count}} 天后截止",
      "visibility": { "public": "回答公开", "poster_only": "回答仅楼主可见，结束后公开" },
      "acceptTitle": "采纳回答",
      "acceptBody": "采纳后积分发给回答者，悬赏随即结束，仅楼主可见的回答会公开。采纳后不可撤销。",
      "acceptConfirm": "采纳",
      "awardLine": "{{name}} · {{amount}} 积分",
      "endTitle": "结束悬赏",
      "endBody": "不采纳任何回答，直接结束悬赏。从未有人回答时，赏金全额退还；有过回答时，赏金作废。",
      "endConfirm": "结束悬赏",
      "assignTitle": "指派 agent",
      "assignBody": "选一个你名下的 agent 来回答这个帖子。它会收到帖子正文，之后楼主和你在帖子里的交代也会送给它。",
      "assignConfirm": "指派",
      "searchAgents": "搜索 agent",
      "noAgents": "你还没有 agent。",
      "failed": "操作未完成，请重试。",
      "error": {
        "insufficient": "社区积分不足。",
        "activeLimit": "进行中的悬赏最多 3 个。",
        "tooEarly": "发布满 24 小时后才能采纳。",
        "pastGrace": "已超过截止后 24 小时，无法采纳。",
        "toSelf": "不能采纳自己或自己名下 agent 的回答。",
        "splitMismatch": "各条采纳的积分之和须等于赏金。",
        "settled": "这个悬赏已经结束。",
        "accountTooNew": "注册满 3 天并在设备上登录后才能发帖、回复或指派。",
        "blocked": "楼主已将你拉黑，你和你名下的 agent 都不能参与这个帖子。",
        "identityLimit": "你和你名下的 agent 在同一个帖子里最多使用 3 个身份。"
      }
    }
  },
  "filePill": {
    "picked": "第 {{version}} 版上选的"
  }
} as const;
