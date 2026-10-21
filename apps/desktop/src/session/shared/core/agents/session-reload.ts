/**
 * 「重开这条会话、把历史续上」在会话页两侧(渲染层 / electron 主进程)之间的契约。
 *
 * 为什么要跨进程:重开会话要停掉这条 conversation 的适配器连接、按**当前**会话记录重算整份注入、
 * 再用同一个 provider 会话 id 走 `session/load` —— 那三件都只有主进程做得到(凭据、工作区挂载、
 * 运行时连接都在那一侧),渲染层只能把「用户确认了」这个决定送过去。
 *
 * ⚠️ 这条通道**不带任何注入内容**:调用方先把新的选择落进会话记录(模型 / MCP 开关),
 * 这里只说「按记录重来一遍」。传 diff 的那种设计会让两条车道各自往里塞自己的方言,
 * 而重算整份、幂等,才是 `reloadEmdashSession` 立起来的语义。
 */

/** 渲染层 → 主进程的重开请求(逻辑名 `taskpageSession.reload`)。 */
export const SESSIONPAGE_SESSION_RELOAD_CHANNEL = 'sessionpage-session:reload';

/**
 * 为什么要重开 —— 只进日志与遥测,**不参与**主进程的任何判断。除模型/MCP 变更外，用户也可手动重开。
 *
 * 它是枚举而不是自由文本:自由文本会让两条车道各写各的措辞,而这个值最终会出现在事故排查里,
 * 那时「reason 有几种取值」必须是能穷举的。
 */
export type SessionReloadReasonCode = 'model-switch' | 'mcp-toggle' | 'manual';

export interface SessionReloadRequest {
  sessionId: string;
  reason: SessionReloadReasonCode;
  /**
   * 这次要换成的模型(裸模型 id,不带 `platform:` 前缀);不换模型的重开(如 MCP 开关)省略。
   *
   * ⚠️ 由**宿主**落进会话记录,不是调用方先写一遍 —— 渲染层那条路要么走活 ACP
   * (必然失败:换不成正是重开的前提),要么在两次往返之间被打断。顺序只有一个地方保证得了。
   */
  model?: string;
  /**
   * 新模型走**哪条计费路** —— `platform` = 咕咕代付,`own` = 用户自己的凭据。与 `model` 同进同出。
   *
   * ⚠️ 少了它,重开会带着**旧的**那条计费路重来:spawn 侧读的是每会话那份
   * `sessionpage-platform-model` 记录(`sessionPlatformModel`),而不是 `config.model`。
   * ⇒ 换到自己的模型时进程仍然连咕咕的端点、带咕咕的票(下一轮 403),
   *   换到咕咕的模型时又一个平台变量都不注入(拿用户自己的 key 去调一个他没有的模型)。
   * 只有 platform→platform 那一种碰巧还成立 —— 那正是「看起来能用」最危险的形状。
   *
   * ⇒ 它就是 composer 建会话时做的**同一个决定**(`recordSessionPlatformModel`),
   * 只是这次发生在会话中途。❌ 不由宿主去猜:宿主那侧没有目录,猜出来的与用户点的会漂。
   */
  modelSource?: 'platform' | 'own';
  /**
   * 思考档位,三态:字符串 = 换成这一档;`null` = 清掉、回 harness 默认;**缺席 = 不碰**。
   * 只给终端会话用 —— 通用模式的档位在活会话里当场改,不需要重开。
   * 与 `model` 同一条纪律:由宿主先写进会话记录、再重开,spawn 按记录重算。
   */
  effort?: string | null;
  /**
   * 这次要**关掉**的那几台 MCP server(harness 自己的配置键);不改 MCP 的重开(如换模型)省略。
   *
   * ⚠️ **记「关掉的」而不是「启用的」**:记启用集合的话,用户之后在自己 harness 配置里新加的
   * 一台不在集合里 ⇒ **默认变成关的** —— 一个他从没做过的决定,而且看起来像咕咕吞了他的 server。
   *
   * ⚠️ **空数组与省略不是一回事,❌ 不许在任何一层归一掉**:
   * `[]` = 用户决定过、一台都没关;省略 = 用户从没碰过。
   * 宿主按 `Array.isArray` 判在场、**不按长度** —— 用长度判会让「用户把开关全打开」
   * 那一刻仍要保留「用户明确决定过」这一事实；adapter 进程归属不由数组内容推导。
   */
  mcpDisabledServers?: readonly string[];
}

export interface SessionReloadResponse {
  ok: boolean;
  /**
   * 失败原话(主进程抛出的那句)。原样带回渲染层 —— ❌ 不折成一句「重开失败」:
   * 「同工作区还有另一条会话attach在同一个适配器上」与「恢复原 provider 会话失败」是
   * 完全不同的事故,用户的下一步也不同,折了之后界面上说的和什么都没说一样。
   */
  error?: string;
  /**
   * `true` = 这条会话从没起来过(#7092):宿主只把新选择落进了记录,没停也没起。
   * 调用方接着走正常首启(终端:hydrate 重试;通用模式:`store.retry()`),
   * ❌ 当成「已重开」去重挂 —— 没有可挂的会话。
   */
  notStarted?: boolean;
}
