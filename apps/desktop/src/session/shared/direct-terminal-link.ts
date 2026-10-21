// #6264 经 SSH 直连那台机器(端口转发)断开 / 连不上的原因代号(主进程 → 渲染层)。
//
// 主进程(electron/session/main/core/pty/direct-terminal)管连接,但它没有界面语言;
// 它只报「此刻在哪一步 + 原因代号」,由渲染层按界面语言写成人话 ——
// ❌ 主进程自己拼中文句子(那样换了界面语言也还是中文)。

/** 这一次断开 / 连不上是因为什么。 */
export type DirectTerminalReason =
  /** 网断了 / 连接被重置(睡眠、换 Wi-Fi) */
  | 'network'
  | 'timeout'
  | 'unreachable'
  | 'host-unresolved'
  /** 那台机器拒绝了 SSH(多半在重启) */
  | 'refused'
  | 'auth'
  | 'host-key-rejected'
  | 'host-key-changed'
  /** 人在咕咕里取消了 ssh 的提问(密码 / 口令 / 指纹) */
  | 'cancelled'
  /** ssh 的提问一直没人回答,那台机器等不及断开了 */
  | 'prompt-unanswered'
  /** 那头正常断开(例如 server 升级后重启) */
  | 'ended'
  | 'unknown';
