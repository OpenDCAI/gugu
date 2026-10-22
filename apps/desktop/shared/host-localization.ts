import { SUPPORTED_LOCALES, type SupportedLocale } from '@/i18n/locale'

// @@@host-system-languages — 宿主真实系统语言列表的同步取值通道(sendSync)。renderer 在首帧之前
// (preload 加载时)就要拿到它,所以是同步的:异步 IPC 会让第一帧退回 navigator 语言、再闪换成宿主语言,
// 违反 localization spec「首帧跟随宿主语言、不闪换」。main 侧答以 app.getPreferredSystemLanguages()。
export const HOST_SYSTEM_LANGUAGES_CHANNEL = 'host-locale:get-system-languages'

export interface WindowChromeLabels {
  minimize: string
  maximize: string
  restore: string
  close: string
}

const HOST_CATALOG = {
  'zh-CN': {
    tray: {
      tooltip: '咕咕',
      show: '打开咕咕',
      quit: '退出咕咕',
    },
    /** mac 菜单栏「咕咕」那一栏里自己加的项(其余是系统 role,系统自己翻)。 */
    appMenu: {
      settings: '设置…',
    },
    notifications: {
      closeToTray: {
        title: '咕咕 仍在后台运行',
        body: '点咕咕图标或重新打开应用即可恢复；要退出，在图标菜单里选「退出咕咕」。',
      },
      authExpired: {
        title: '咕咕登录已失效，请在该设备重新登录',
        body: '该设备的咕咕会话已失效，已停止上线；重新登录后会自动恢复。',
      },
    },
    windowChrome: {
      minimize: '最小化',
      maximize: '最大化',
      restore: '还原',
      close: '关闭',
    },
    barcodeScan: {
      hint: '将二维码放入框内',
      cancel: '取消',
    },
    /** 安卓通知渠道名 —— 用户在系统「设置 → 应用 → 咕咕 → 通知」的类别列表里看到的名字(product spec)。 */
    notificationChannels: {
      alerts: '提醒',
      quiet: '静音提醒',
    },
    /**
     * 「后台守着」那条常驻通知的第二行(product spec)。标题由渲染层给(在看管几台机器),
     * 这一行回答「它凭什么常驻在我的通知栏里」—— 说给用户的好处,不说前台服务这类机制。
     * ⚠️ 必须给:不给的话插件会填它自带的默认句 "App will start faster" ——
     * 一句英文,而且讲的是它作者关心的事(2026-09-16 在模拟器通知栏里实际看到)。
     */
    backgroundWatch: {
      text: '干完了或需要你回话时，第一时间提醒你',
    },
    /** @@@5301 会话页 agent 的系统通知正文。这条链在 session/main/core/agent-hooks/notification.ts,
        与上面 notifications 那条(聊天/托盘)彼此独立,但文案同样要跟宿主语言走。 */
    sessionAgentNotifications: {
      finished: '智能体已经干完了',
      needsApproval: '智能体需要你批准',
      needsAnswer: '智能体在等你回答',
    },
    /** #6387 点了一条 gugu://ext 链接却没打开时,告诉人为什么。{name} = 扩展名(没装时是它的 id)。 */
    extensionLinks: {
      title: '打不开这个链接',
      notInstalled: '这个链接要打开 App「{name}」,但它没有安装。',
      disabled: '这个链接要打开「{name}」,但它已停用。可以在左栏「App」里启用。',
      noSuchTab: '「{name}」里没有这个链接指向的页面,链接可能来自另一个版本。',
      noSession: '这个链接要在一个任务里打开「{name}」,但那个任务不在这台电脑上。',
      openFailed: '「{name}」没能打开:{detail}',
    },
    /**
     * @@@touchid-passkey 内置浏览器的 Touch ID 通行密钥(electron/macWebAuthn.ts)。touchIdReason 由 macOS 拼进系统指纹框:
     * 「"咕咕"正在尝试<这一句>」,`$1` 换成网站域名。chooseAccount = 同一网站存着多把时让人选。
     */
    webAuthn: {
      touchIdReason: '在 $1 上验证你的身份',
      chooseAccount: {
        message: '用哪个账号登录 {site}?',
        detail: '这台 Mac 上的咕咕里存着 {site} 的多把通行密钥。',
        cancel: '取消',
      },
    },
    /** 主窗口的页面几分钟内连着崩了好几次、不再自动重新载入时,当面说的话(electron/renderer-crash-recovery.ts)。{count} = 次数。 */
    rendererCrash: {
      title: '咕咕的界面反复出错',
      detail: '界面在几分钟内连续崩溃了 {count} 次,已停止自动重新载入。',
      reload: '重新载入',
      quit: '退出咕咕',
    },
    sessionPlatform: {
      /**
       * 会话跑到一半、咕咕额度的凭据签不出来时,agent 自己界面上显示的那一句(claude 显示为
       * `apiKeyHelper failed: exited 1: <这一句>`,codex / opencode 显示为请求被拒的原因)。
       * 句首带「咕咕」:这一行夹在 agent 自己的报错里,得让人认得出是谁说的。
       */
      credentialUnavailable: {
        signedOut: '咕咕:登录已失效,在咕咕里重新登录后再发一次',
        modelUnavailable: '咕咕:这个模型现在用不了,换一个模型再发一次',
        membership: '咕咕:你用的咕咕模型要开会员才能用。换个模型,或开通会员后再发一次',
        unreachable: '咕咕:连不上咕咕服务,稍后再发一次',
        serviceUnavailable: '咕咕:咕咕这边出错了,稍后再发一次',
      },
    },
  },
  'en-US': {
    tray: {
      tooltip: '咕咕',
      show: 'Open 咕咕',
      quit: 'Quit 咕咕',
    },
    appMenu: {
      settings: 'Settings…',
    },
    notifications: {
      closeToTray: {
        title: '咕咕 is still running in the background',
        body: 'Click the 咕咕 icon or reopen the app to restore it; to quit, choose Quit 咕咕 from the icon menu.',
      },
      authExpired: {
        title: 'Your 咕咕 sign-in expired',
        body: '咕咕 stopped running on this device. Sign in again to resume automatically.',
      },
    },
    windowChrome: {
      minimize: 'Minimize',
      maximize: 'Maximize',
      restore: 'Restore',
      close: 'Close',
    },
    barcodeScan: {
      hint: 'Place the QR code inside the frame',
      cancel: 'Cancel',
    },
    notificationChannels: {
      alerts: 'Alerts',
      quiet: 'Silent alerts',
    },
    /** 见 zh-CN 那条的说明:插件不给正文就会填一句英文默认句,所以这一行必须自己写。 */
    backgroundWatch: {
      text: 'You will hear the moment an agent finishes or needs you',
    },
    sessionAgentNotifications: {
      finished: 'Your agent has finished working',
      needsApproval: 'Your agent needs your approval',
      needsAnswer: 'Your agent is waiting for your answer',
    },
    extensionLinks: {
      title: "Couldn't open the link",
      notInstalled: 'This link opens the App "{name}", which is not installed.',
      disabled: 'This link opens {name}, which is turned off. Turn it on in Apps, in the left rail.',
      noSuchTab: "{name} has no page this link points to — it may come from another version.",
      noSession: 'This link opens {name} in a task that is not on this computer.',
      openFailed: "{name} couldn't open: {detail}",
    },
    webAuthn: {
      // macOS renders `"咕咕" is trying to <this>`, so a lowercase fragment.
      touchIdReason: 'verify your identity on $1',
      chooseAccount: {
        message: 'Which account do you want to sign in to {site} with?',
        detail: '咕咕 on this Mac has more than one passkey for {site}.',
        cancel: 'Cancel',
      },
    },
    rendererCrash: {
      title: "咕咕's window keeps crashing",
      detail: 'The window crashed {count} times within a few minutes, so it is no longer reloaded automatically.',
      reload: 'Reload',
      quit: 'Quit 咕咕',
    },
    sessionPlatform: {
      credentialUnavailable: {
        signedOut: '咕咕: you are signed out. Sign in again in 咕咕, then resend',
        modelUnavailable: '咕咕: this model is unavailable now. Switch to another model, then resend',
        membership: '咕咕: the Gugu model you are using needs a membership. Switch models, or get a membership, then resend',
        unreachable: '咕咕: cannot reach the 咕咕 service. Resend in a moment',
        serviceUnavailable: "咕咕: something went wrong on 咕咕's side. Resend in a moment",
      },
    },
  },
} as const

export type HostCatalog = (typeof HOST_CATALOG)[SupportedLocale]

export function isResolvedLocale(value: unknown): value is SupportedLocale {
  return SUPPORTED_LOCALES.includes(value as SupportedLocale)
}

export function hostCatalog(locale: SupportedLocale): HostCatalog {
  return HOST_CATALOG[locale]
}
