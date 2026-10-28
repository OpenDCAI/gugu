export type ActiveSection =
  // 咕咕(助理)那一组(owner 10-16「咕咕的设置是全局设置里的一组;齿轮直接开这一组,❌ 再有第二个设置页」):
  // assistant = 它是谁与它的状态(名字、形象、醒着多久、积分、快速聊天、关闭);connectors = 它连着的应用。
  // 它用的设备在 devices,聊天工具并入 connectors。
  | 'assistant'
  | 'connectors'
  | 'account'
  | 'general'
  | 'devices'
  // 文件存储与读取(owner 10-27):设备页里的一个内页(你名下机器上的项目群怎么存文件),❌ 再占左栏一行。只作直达链接。
  | 'files'
  | 'model'
  | 'usage'
  // 用户自己在各家买的订阅(product spec):这台电脑上各家 Harness 的套餐与这一期还剩多少。
  | 'subscriptions'
  | 'activity'
  | 'about'
  | 'permissions'
  // The phone's own App store (L9): the Apps installed on it from chats, to uninstall. The desktop manages its Apps on
  // the far-left rail's 「App」 page.
  | 'apps'
  // Legacy settings deep links only; SettingsPanel redirects channels to connectors.
  | 'channels'
  // #7199 手机当设备:云端的个人助理能用这台手机做哪些事。只在手机壳上(桌面的「这台电脑能做的事」在「设备」里)。
  | 'phone'
  // Settings the session page holds (its own components draw them, product spec); only where a task host runs.
  | 'sessions'
  | 'interface'
  | 'resource-monitor'
  | 'browser'

/** The sections the session page draws (its own components and settings store); shown only where a task host runs. */
// connectors:「云端」那一段是会话页画的(资源库「集成」的同一份数据),所以也只在有会话页宿主的桌面形态上出现。
export const SESSION_HOST_SETTINGS_SECTIONS: readonly ActiveSection[] = ['sessions', 'interface', 'browser', 'subscriptions', 'connectors', 'resource-monitor']

/** 设置左栏的分组(owner 10-16 全局设置重做):组名只在桌面左栏画小标题;手机「我的」同一份分组。 */
export type SettingsGroupId = 'assistant' | 'account' | 'preferences' | 'work' | 'about'

/**
 * The one settings (product spec): sections in groups, a caption + divider between groups.
 * 咕咕 · 连接应用 / 账户 · 用量 · 订阅 · 活跃 / 通用 · 界面 · 权限 · 模型 / 会话 · 仓库 · 浏览器 · 设备 · App / 关于.
 * Which of them a host shows is SettingsPanel's filter (task host, system permissions, the phone's own Apps).
 * 桌面左栏与手机「我的」读的都是这一份,❌ 各写一个顺序。
 */
export const SETTINGS_GROUPS: readonly { readonly id: SettingsGroupId; readonly sections: readonly ActiveSection[] }[] = [
  // 咕咕自己的设置排第一组:「咕咕」页里的齿轮直接开到这里。
  { id: 'assistant', sections: ['assistant', 'connectors'] },
  // product spec:用量(积分)与活跃(会话/token)都是云端汇总,手机上一样看得到(只是不上传本机数据)。
  // 订阅挨着用量:咕咕的积分与用户自己在各家买的订阅两页并排，好对照(owner 2026-10-13 定单开一页)。
  // 它读的是这台电脑上装着的 Harness,由会话页那一侧画 ⇒ 只在有会话页的地方出现。
  { id: 'account', sections: ['account', 'usage', 'subscriptions', 'activity'] },
  // product spec:桌面与手机同一页;这台机器读不读得到真值由 SettingsPanel 那道过滤决定。
  { id: 'preferences', sections: ['general', 'interface', 'permissions', 'model', 'resource-monitor'] },
  // agent 跑起来的那几样(会话的默认行为、仓库、浏览器)挨着「设备」。App 只在手机壳上:那里的 App 由
  // 这一页自己的 App 仓管(L9)。
  { id: 'work', sections: ['sessions', 'browser', 'devices', 'apps', 'phone'] },
  { id: 'about', sections: ['about'] },
]
export const SETTINGS_SECTION_GROUPS: readonly (readonly ActiveSection[])[] = SETTINGS_GROUPS.map((group) => group.sections)
// ❌ 别在这里加「机器与会话」:手机看管 agent 的入口只有底部「项目」tab(owner 2026-09-05),一张自带三层导航的
// 全屏页塞进设置详情,返回箭头要打两次架。

export const SETTINGS_SECTIONS: ActiveSection[] = SETTINGS_SECTION_GROUPS.flat()
