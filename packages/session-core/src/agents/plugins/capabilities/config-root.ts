import type { AgentFirstRunState } from './session-bundle';

/**
 * 咕咕替各家持有的**独立 home** 都放在 `<GUGU_HOME>/agent-homes/<providerId>/` 下,一家一格。
 *
 * ## 为什么这一层要造一个「影子 home」,而不是直接把配置根摆进去
 *
 * `AgentConfigRoot.userPath` 是**相对用户 OS home** 的(`.kimi-code`)。把同一段相对路径
 * 原样铺在影子目录里,影子目录就**扮演了 OS home 的角色**:
 *
 * ```
 *   用户那份    ~/.kimi-code                                    ← 复制的来源
 *   咕咕这份    <GUGU_HOME>/agent-homes/kimi/.kimi-code         ← 递给子进程的值
 *               └────────── shadowHome ─────────┘└─ userPath ─┘
 * ```
 *
 * 好处是各家**一行代码都不用改**:咕咕自己写 hook 用的是 home 相对路径
 * (kimi 的 `KIMI_CONFIG_PATH = '.kimi-code/config.toml'`),把这一家的 `PluginFs`
 * 从真 OS home 换成 `shadowHome`,它就自动落进了同一份配置根里 —— 会话读什么,hook 就写什么。
 *
 * ❌ 如果把配置根直接摆成 `<GUGU_HOME>/agent-homes/kimi/`(省掉 `userPath` 那一层),
 *    上面那条就断了:`PluginFs` 要么锚在配置根(hook 写到 `<配置根>/.kimi-code/config.toml`,
 *    多套了一层)、要么锚在别处(写到用户真 home)。两种都是**静默**错位。
 */
export const AGENT_HOMES_DIRNAME = 'agent-homes';

/**
 * 独立 home 的**目录布局** —— 只此一处定义。
 *
 * ⚠️ 返回**路径段**而不是拼好的路径:这个文件进渲染包,不能 import `node:path`
 *    (理由见文件末尾那段)。落盘侧的 `resolveAgentHome` 与各家物化器都用它,
 *    ❌ 别在第二个地方手写 `agent-homes/<id>/<userPath>` —— 两处会各自漂。
 */
export function agentHomeSegments(providerId: string, userPath: string): readonly string[] {
  return [AGENT_HOMES_DIRNAME, providerId, ...userPath.split(/[/\\]/).filter(Boolean)];
}

export type ResolvedAgentHome = {
  providerId: string;
  /** 把配置根挪过去的环境变量名 —— 递进子进程的就是它。 */
  envVar: string;
  injectEnv?: boolean;
  /** 扮演「OS home」的那一层 —— 这一家的 `PluginFs` 锚在这里。 */
  shadowHome: string;
  /** 咕咕这一份配置根 —— `envVar` 的值。 */
  configRoot: string;
  /** 用户那一份 —— **只**在首次复制时读一次,之后永不再看。 */
  userConfigRoot: string;
  /**
   * 分家时**不**带过来的条目(相对配置根,`/` 分隔)—— 见 `AgentConfigRoot.carryExclusions`。
   * 默认全带:❌ 复制那一层不许自己决定「哪些算配置」,它没有那个信息;
   * 而漏挑一条配置是静默丢用户数据,漏排一条派生物只是多占点盘。
   */
  carryExclusions: readonly string[];
  /**
   * 首次铺好之后顺手写下的文件(相对配置根)—— 见 `AgentConfigRoot.seedFiles`。
   * 由这一家自己声明,❌ 落盘那一层不按 providerId 分支。
   */
  seedFiles: readonly { path: string; content: string }[];
  firstRunState?: readonly AgentFirstRunState[];
};

/**
 * ⚠️ **算路径的那个函数不在这里,在 `helpers/agent-home.ts`(node 侧)。**
 *
 * 这个文件被 `agents/plugins` 的桶导出,而那个桶**进渲染包**。往这里加一个
 * `node:path` / `node:fs` 的 import,Vite 会把它 externalize 掉,浏览器里一访问就抛
 * `Module "node:path" has been externalized` —— 而且爆的不是本模块,是**碰巧同包**的
 * 那几个终端组件测试(2026-08-28 实测:xterm-host / pane-resize / pty-dispose /
 * settings-cards 四个文件一起红,报错却指向 config-root.ts 第 1 行)。
 * ⇒ 这里**只放类型和纯常量**,一行运行时依赖都不许有。
 */
