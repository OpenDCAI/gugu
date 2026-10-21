/**
 * @@@mcp-session-toggle —— 「这条会话关掉哪几台 MCP server」怎么落到各家 harness 上。
 *
 * 产品形态(owner 2026-09-06 定,#5157):`/mcp` 弹出面板,**只有 enable/disable、没有增删**,
 * 确认后提示用户是否重载会话,用户点了才重开。
 *
 * ## 为什么是「关闭指令」而不是「写配置」
 *
 * 咕咕**不写用户自己的 harness 配置文件**(`~/.claude.json` / `~/.codex/config.toml` /
 * `~/.config/opencode/opencode.json`)—— 那是 #4479 / #4595 / #4834 拍下来的零全局残留闸,
 * `createMcpAdapter.assertWritable` 今天只放行 `'owned'` scope。
 * ⇒ 「关掉一台」只能靠**会话级**通道:进程起来的那一刻把话说清楚,用户的文件一个字节不动。
 *
 * ## 三条通道都是实测出来的,不是推的(2026-09-06 / 10-07,mac1,临时 HOME)
 *
 * 判据用的是探针 MCP server **自己的调用账本**,而且只看 `initialize` / `tools/list` ——
 * 这两样是 **harness 自己**发的,`tools/call` 才是模型发的。
 * ⇒ 判据里没有模型的行为:模型这一轮想不想用那台 server,与「它装载了没有」无关。
 *
 * | 方言 | 实测 | 粒度 |
 * |---|---|---|
 * | `config-content-enabled`(opencode) | 磁盘仍是 `enabled:true`,只在 `OPENCODE_CONFIG_CONTENT` 里写 `enabled:false` ⇒ 账本全空 | 单台 |
 * | `config-arg-enabled`(codex) | `-c mcp_servers.<名>.enabled=false` ⇒ `codex mcp list` 的 Status 变 `disabled`,去掉又变回 `enabled` | 单台 |
 * | `disallowed-tools`(claude) | `disallowedTools: mcp__<名>` ⇒ 真实请求里只少那一台的工具,用户级 / 本地级 / 项目级其余照旧(10-07,假端点读请求) | 单台 |
 *
 * ⚠️ codex 那一格**换过一次仪器**:codex **不在建会话时拉起 MCP server**(懒启动),
 * 所以「账本空」在 codex 上**不能**读成「关掉生效了」。换成 `codex mcp list` 的 Status 列
 * 才是有效读数 —— 它同样是 harness 侧输出、零模型参与,而且双向都跟着输入走。
 *
 * ## ⚠️ 名字用哪一个:**必须是 harness 自己的配置键**,❌ 不是界面上显示的那个
 *
 * 关闭指令里的 `name` 会原样进 harness 的配置(`mcp_servers.<name>` / `mcp.<name>`),
 * 所以它必须与 harness 用来认这台 server 的**那个字符串**逐字相同 ——
 * 也就是 `readServers` 从用户配置里读回来的键,❌ 不是任何展示名、别名或归一过的形式。
 *
 * 仓里已经有这个坑的实账(`mcp/gugu-mcp-name.mjs`):声明名与 codex 配置键**不是同一个字符串**
 * (`gugu-im` 时代是 `gugu-im` / `gugu_im`),按工具名反推配置键实测得到 `-32603 unknown MCP server`,
 * 而**症状是一条永远「运行中」的 turn,不是一条错误**。
 *
 * ⇒ 咕咕自己那台也**按 `owner` 标记识别,❌ 不按名字比对** —— 名字比对会在
 * 「声明名 ≠ 配置键」的那一天静默失效,而失效的方向正是把它当成用户的 server 关掉。
 *
 * ## ❌ 不按 harness id 分叉
 *
 * 方言由 descriptor 声明,这里只认方言。理由与 `agent-home.ts` 同源:
 * 一旦这层出现 `if (providerId === 'codex')`,第 37 家接进来时没人知道该往哪个分支加。
 */

/** 一台 server 在这条会话里的身份 —— 名字是各家配置里的键,咕咕不改写它。 */
/**
 * 谁把一台 MCP server 放进这条会话的。三档，区别有实际后果:
 *
 * · `'user'` —— 用户自己 MCP 配置里的那几台。各家 harness 原生发现它们,咕咕**不复述**。
 * · `'gugu'` —— 咕咕自己那台(agent 靠它把话说回来)。**不可关**,且名字写在各家带版本号的
 *   静态能力包里。
 * · `'integration'` —— 用户在资源库里连上的服务(Linear、Notion…),地址是咕咕的转发口。
 *   它随连随变,所以**不在静态包的名单里**,但和 `'gugu'` 一样由咕咕投递;用户可以在
 *   `/mcp` 面板里为某条会话关掉它。
 */
export type McpServerOwner = 'user' | 'gugu' | 'integration';

export interface McpToggleServer {
  name: string;
  /** 用户在 `/mcp` 面板里把它打开着吗。缺省(没被用户碰过)= 开。 */
  enabled: boolean;
  /**
   * 谁把这台 server 放进这条会话的。
   *
   * `'gugu'` = 咕咕自己注入的那台(agent 靠它把话说回来)。**它不可关** ——
   * 关掉它 agent 就成了哑巴:活着、在干活、但一个字传不回来,而用户看到的只是"没反应"。
   * ⇒ 面板不列它,领域规则也拒绝为它生成关闭指令(两道,因为界面不列 ≠ 调用方不会传)。
   */
  owner?: McpServerOwner;
}

/** 这台 server 允许用户在 `/mcp` 面板里开关吗。 */
export function isUserToggleable(server: McpToggleServer): boolean {
  return server.owner !== 'gugu';
}

/**
 * 各家「怎么关掉一台」的方言。**由 session-bundle descriptor 声明**,❌ 不在这里按 id 推。
 *
 * - `config-content-enabled`:进程配置文档里逐台写 `enabled: false`(与用户配置**合并**)。
 * - `config-arg-enabled`:spawn 参数里逐台写 `-c <前缀>.<名>.enabled=false`。
 * - `disallowed-tools`:harness 自己的工具黑名单(claude 的 `disallowedTools`),逐台摘掉那一台的工具;
 *   配置怎么分层照旧由 harness 自己解析。
 * - `unsupported`:这家没有已证实的会话级关闭通道。
 */
export type McpToggleDialect =
  | 'config-content-enabled'
  | 'config-arg-enabled'
  | 'disallowed-tools'
  | 'unsupported';

/**
 * 用户在这一家上**能表达到多细**。
 *
 * - `'per-server'`(缺省):逐台开关。
 * - `'all-or-none'`:只能整组开关 —— 关掉任何一台 = 用户配置里的那一整组都不装载。
 *
 * ⚠️ 它与方言是**两件事**:方言说"指令怎么递出去",粒度说"用户能表达什么"。
 * claude 更早是 strict 整份接管 + `all-or-none`,而后者的成因**不在 claude**:
 * `strictMcpConfig` 一开,文件来源的全部不装载,只有咕咕经 `session/new.mcpServers`
 * 显式递回去的才在;而咕咕的会话 MCP 类型(`SessionMcpServer`)过去只能表达
 * **HTTP + 至多一个 Authorization 头** —— 用户配置里最常见的 stdio server
 * (`command` / `args` / `env`)在旧类型里**没有对应的形状**,递不回去。
 * ⇒ 粒度是**咕咕这一侧的表达力**决定的,不是 harness 的限制。
 *   `SessionMcpServer` 现在同时表达 `stdio | http`,claude 这一格因此使用 `per-server` ——
 *   ❌ 所以不许把"只能整组"写死进方言,它会随咕咕自己变。
 *
 * ⚠️ 面板必须**按粒度换形状**:`all-or-none` 的家只渲染**一个**开关。
 * 渲染 N 个开关会让用户以为他只关了一台,而实际另外几台也没了 —— 正是本节点最该防的静默失效。
 */
export type McpToggleGranularity = 'per-server' | 'all-or-none';

export type McpToggleDirective =
  | { kind: 'none' }
  | { kind: 'config-content'; disabled: string[] }
  | { kind: 'config-args'; args: string[] }
  | { kind: 'disallowed-tools'; disabled: string[] }
  | { kind: 'unsupported'; disabled: string[] };

/**
 * 这条会话要发给 harness 的关闭指令。一台都没关时一律返回 `{ kind: 'none' }`。
 */
export function mcpToggleDirective(
  dialect: McpToggleDialect,
  servers: readonly McpToggleServer[],
  options: { configArgPrefix?: string; granularity?: McpToggleGranularity } = {}
): McpToggleDirective {
  // 咕咕自己那台永远算开着 —— 调用方就算传了 `enabled: false` 也不接受。
  // ⚠️ 这是第二道:界面不列它是第一道。只做界面那一道的话,任何一个新调用点
  //    (面板之外的批量操作、以后的恢复默认)都可能把它关掉,而症状是 agent 变哑巴。
  const owned = servers.map((s) => (isUserToggleable(s) ? s : { ...s, enabled: true }));
  // 整组粒度:用户关掉任何一台 ⇒ 他那一整组都不装载。
  // ⚠️ 这一步**必须在方言之前**做:它改的是"用户表达了什么",而方言只负责把结果递出去。
  //    放到方言里做,四个分支就各要写一遍同一条规则,而漏掉的那个分支会静默保留一台。
  const groupOff =
    options.granularity === 'all-or-none' && owned.some((s) => isUserToggleable(s) && !s.enabled);
  const effective = groupOff
    ? owned.map((s) => (isUserToggleable(s) ? { ...s, enabled: false } : s))
    : owned;
  const disabled = effective.filter((s) => !s.enabled).map((s) => s.name);
  if (disabled.length === 0) return { kind: 'none' };

  switch (dialect) {
    case 'config-content-enabled':
      return { kind: 'config-content', disabled };
    case 'config-arg-enabled': {
      const prefix = options.configArgPrefix;
      if (!prefix) {
        // ❌ 不给默认前缀:猜错的表现是「-c 写进去了,harness 当没看见」——
        //    界面说关了、工具表纹丝不动,正是这一格最该防的静默失效。
        throw new Error(
          'mcpToggleDirective: dialect config-arg-enabled requires configArgPrefix (e.g. "mcp_servers")'
        );
      }
      return { kind: 'config-args', args: disabled.map((n) => `${prefix}.${n}.enabled=false`) };
    }
    case 'disallowed-tools':
      return { kind: 'disallowed-tools', disabled };
    case 'unsupported':
      return { kind: 'unsupported', disabled };
  }
}
