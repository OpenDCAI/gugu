export default {
  "actions": {
    "copiedAgentId": "已复制 Agent ID",
    "copiedGuguNumber": "已复制咕咕号",
    "copiedLink": "已复制链接",
    "copy": "复制",
    "copyFailed": "复制失败"
  },
  "cloudComputer": {
    "reason": {
      "plan_required": "你的咕咕是 Plus 及以上的权益。",
      "credits_exhausted": "积分已用完。",
      "membership_expired": "会员已到期，云上的资源已停用。续费，或把它搬回你自己的电脑。",
      "timeout": "两分钟内没连上。",
      "network": "连不上你的咕咕服务，检查一下网络。",
      "signed_out": "登录已失效，重新登录后再试。",
      "gone": "你的咕咕已经关闭了。",
      "failed": "你的咕咕那边出了问题。"
    }
  },
  "agentStatus": {
    "running": "运行中",
    "parked": "后台运行中",
    "needsApproval": "等你批准",
    "needsAnswer": "等你回答",
    "needsPlanReview": "等你看计划",
    "needsAction": "需要你处理",
    "error": "出错了",
    "done": "做完了",
    "idle": "空闲",
    "online": "在线",
    "offline": "不在线",
    "removed": "已移除",
    "pending": "确认中",
    "none": "状态不可用"
  },
  "agentShare": {
    "guguNumber": "咕咕号",
    "close": "关闭",
    "dialog": "分享 {{name}}",
    "generatePoster": "生成名片海报",
    "inviteLink": "邀请链接",
    "numberUnassigned": "未分配",
    "copied": "已复制",
    "copyRow": "复制{{label}}",
    "makePublic": "开启公开",
    "makingPublic": "正在开启…",
    "makePublicHint": "开启公开后才有咕咕号和邀请链接",
    "makePublicFailed": "开启公开失败",
    "title": "分享 Agent"
  },
  "brand": {
    "documentTitle": "咕咕"
  },
  "dialog": {
    "close": "关闭对话框",
    "label": "对话框"
  },
  "errors": {
    "offline": "网络连接失败，请检查网络后重试",
    "operationFailed": "操作失败，请稍后重试",
    "permissionDenied": "你没有权限做这件事"
  },
  "locale": {
    "enUS": "English",
    "label": "语言",
    "system": "跟随系统",
    "zhCN": "简体中文"
  },
  "relativeTime": {
    "daysAgo": "{{count}} 天前",
    "daysAgo_one": "{{count}} 天前",
    "daysAgo_other": "{{count}} 天前",
    "hoursAgo": "{{count}} 小时前",
    "hoursAgo_one": "{{count}} 小时前",
    "hoursAgo_other": "{{count}} 小时前",
    "justNow": "刚刚",
    "minutesAgo": "{{count}} 分钟前",
    "minutesAgo_one": "{{count}} 分钟前",
    "minutesAgo_other": "{{count}} 分钟前"
  },
  "toast": {
    "dismiss": "关闭提示"
  },
  "tabs": {
    "pending": "{{label}}，{{count}} 条待处理",
    "pending_one": "{{label}}，{{count}} 条待处理",
    "pending_other": "{{label}}，{{count}} 条待处理"
  }
} as const;
