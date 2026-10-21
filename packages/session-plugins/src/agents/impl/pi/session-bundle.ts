import { harnessPlatform, PI_PROVIDER_API } from './platform';
import { join } from 'node:path';
import type {
  CapabilityPackage,
  Degradation,
  SessionBundleDescriptor,
  SessionCapabilityBundle,
  SessionMaterialization,
  SessionMaterializationContext,
  SessionPromptBlocks,
  SessionpageSessionSurface,
} from '@gugu/session-core/agents/plugins';
import { assertSessionMcpStdioEnv, sessionMcpAuthorization, sessionMcpStdioEnv } from '../../helpers/session-mcp';
import {
  GUGU_PI_AUTONOMY_ENV,
  GUGU_PI_MCP_SERVERS_ENV,
  GUGU_PI_SYSTEM_PROMPT_ENV,
  PI_EXTENSION_CONTENT,
} from './plugin-file';
import { PI_AGENT_DIR_LEAF, PI_CONFIG_DIR_NAME, piAgentDir } from './agent-dir';

export const PI_GUGU_PACKAGE_ID = 'gugu-product-pi';
export const PI_GUGU_PACKAGE_VERSION = '1.0.0';
export const PI_GUGU_EVENT_MODULE_PATH = '.pi/extensions/gugu-hook.ts';

export const PI_GUGU_CAPABILITY_PACKAGE: CapabilityPackage = {
  id: PI_GUGU_PACKAGE_ID,
  version: PI_GUGU_PACKAGE_VERSION,
  artifacts: [
    {
      path: PI_GUGU_EVENT_MODULE_PATH,
      content: PI_EXTENSION_CONTENT,
      mode: 0o644,
    },
  ],
};

export const PI_MCP_EXTENSION_SOURCE = 'npm:pi-mcp-adapter@2.32.1';

/** pi 认的配置根环境变量(pi `dist/config.js` 的 `getAgentDir()`)。 */
const PI_AGENT_DIR_ENV = 'PI_CODING_AGENT_DIR';


/**
 * 插件级(**非**逐会话)的 MCP 登记面,家目录相对 —— 与 `.cursor/mcp.json`、`.codex/config.toml` 同族。
 *
 * ⚠️ **它解析到的不是这两条腿的任何一个会话根,而是用户的真 OS home。** 这一族路径走
 * `plugin-host.fsFor()` → `resolveAgentHomeRoot(providerId)`,而那里只认 descriptor 上的
 * `configRoot` 声明:pi 本家 `injectionMode: 'runtime'`、**没有** `configRoot` ⇒
 * `resolveAgentHome()` 返回 null ⇒ root 落到 `homedir()`(`agent-home.ts` 的
 * `compute()`:`if (!home) return { env: {}, root: osHomeDir }`)。
 * ⇒ 实际落点是 `$HOME/.pi/agent/…`,**两条腿同一份**,与 `<guguHome>/.pi/{agent,acp-agent}` 是
 * **两根不同的轴**:这一族描述的是**用户自己那套 pi 安装**(逐 provider 一份),不是本次会话的配置根。
 * ⇒ 这份共享是**有意的**,不是分根漏了一半。
 * ⚠️ 它落的是 pi 的**默认**根,而 pi 根本不读这个文件:grep pi
 * `@earendil-works/pi-coding-agent@0.85.1` 的 `dist/` + `docs/`,`mcp.json` / `mcpServers` 命中 0
 * (阳控:`models.json` 39/5、`settings.json` 35/12、`auth.json` 27/5 —— 同一条 grep 会命中,
 * 所以那个 0 是读数不是仪器瞎了;唯一那条 `mcpServers` 在一个 minified chunk 里的 Google GenAI
 * SDK 请求转换函数里,不是 pi 的配置键)。MCP 真正的通道是 adapter 扩展 + `GUGU_PI_MCP_SERVERS`
 * 环境变量(descriptor 的 `mcp: { channel: 'extension-event' }`)。
 * ⇒ 它**不逐腿**(plugin scope 只有一个路径),但字面量照样从上面那两个常量派生。
 */
export const PI_HOME_MCP_RELATIVE = `${PI_CONFIG_DIR_NAME}/${PI_AGENT_DIR_LEAF['tui']}/mcp.json`;

/**
 * 插件级的 pi **用户层** context file(`~/.pi/agent/AGENTS.md`)—— 同样是 pi 默认根下的家目录相对路径,
 * 与 `PI_HOME_MCP_RELATIVE` 同族:plugin scope、不逐腿,但字面量照样从上面两个常量派生。
 */
export const PI_HOME_AGENTS_MD_RELATIVE =
  `${PI_CONFIG_DIR_NAME}/${PI_AGENT_DIR_LEAF['tui']}/AGENTS.md`;

/**
 * ACP 腿上咕咕自有配置根的相对锚点。
 *
 * 终端腿把事件模块投在**工作区** `.pi/extensions/`,ACP 腿不能:pi 的项目级资源要先过 project trust,
 * 而那条腿递不进 `--approve`、也没有人可问。咕咕自有配置根下的**全局** extensions 目录不受 trust 约束
 * (pi 官方 security 文档:声明为需要 trust 的是 `.pi/…` 那些项目级入口)。
 * ❌ 别改成「给工作区发一张 trust」:那会顺带让被测仓库自己的 `.pi/settings.json` 也被加载。
 */
export const PI_ACP_EVENT_MODULE_RELATIVE = 'extensions/emdash-hook.ts';
export const PI_ACP_SETTINGS_RELATIVE = 'settings.json';
export const PI_MODELS_RELATIVE = 'models.json';

/** 咕咕在 pi 的 `models.json` 里注册的自定义 provider 名 —— 两条腿、三个使用点共用一份。 */
export const PI_PLATFORM_PROVIDER_ID = 'gugu-platform';

const unverifiedModel: Degradation = {
  code: 'unverified',
  reason: 'Pi session-bundle model delivery has not been verified.',
};

const unverifiedAutonomy: Degradation = {
  code: 'unverified',
  reason: 'Pi session-bundle autonomy delivery has not been verified.',
};

export const piSessionBundleDescriptor = {
  injectionMode: 'runtime',
  platform: harnessPlatform,
  shellEnv: {
    passThrough: [
      'PI_CODING_AGENT_DIR',
      'PI_CONFIG_DIR',
      'PI_NO_TITLE',
      'PI_PLAN_MODEL',
      'PI_SLOW_MODEL',
      'PI_SMOL_MODEL',
    ],
  },
  /**
   * 关自更新(#6186)。pi 自己不装新版,但交互界面启动即查 pi.dev 并在会话里画「Update Available … Run pi update」,
   * 这正是本票要消掉的会话内更新提示。env 只关版本检查,不像 `PI_OFFLINE` 那样连模型目录刷新一起关。
   */
  selfUpdate: {
    kind: 'session-env',
    env: { PI_SKIP_VERSION_CHECK: '1' },
    evidence:
      'earendil-works/pi@13cbf77df239 (v0.86.1) packages/coding-agent/src/utils/version-check.ts:98'
      + '「if (process.env.PI_SKIP_VERSION_CHECK) return undefined」。取证 2026-09-23',
  },
  credentialLifecycle: {
    // 两条腿骑的是同一对载体(子进程 env + 咕咕自有配置根;ACP 腿 BYOK 恒 env-only,见 units.env 注释),
    // 所以 lifecycle 声明两条腿同值。漏掉 ACP 腿会让会话页凭据闸在「从联系人进聊天」这条路上
    // 直接报 "credential lifecycle is undeclared for pi/acp"。
    'acp': {
      delivery: 'child-process-env',
      originalProcessRefresh: 'unsupported',
      recovery: 'reopen',
      inferenceOwner: 'provider-process',
      reopenEntry: 'host-session-reload',
      // 换计费路续接同一条原生会话:平台 → 自己时 pi 只在那家 provider 有凭据时才恢复会话里记的模型
      // (`dist/core/sdk.js` 的 restore 分支查 `hasConfiguredAuth`),自己那条路上没有平台凭据 ⇒ 落回 pi 自己的默认,
      // 并在 `configOptions` 里报出来;自己 → 平台由启动断言(#6196)。2026-09-23 mac1 裸 ACP 实测(#6210)。
      sourceChangeSession: 'preserve',
    },
    'tui': {
      delivery: 'child-process-env',
      originalProcessRefresh: 'unsupported',
      recovery: 'reopen',
      inferenceOwner: 'provider-process',
      reopenEntry: 'host-session-reload',
      sourceChangeSession: 'preserve',
    },
  },
  // ACP 腿恒跑在咕咕自有的配置根上(见 `units.env` 注释:这条腿的 BYOK 是 env-only)。
  // 模型目录探针据此指到同一份根,于是「自己的模型」一档列的就是这条腿看得见的那些(#6211)。
  acpConfigRoot: {
    envVar: PI_AGENT_DIR_ENV,
    guguHomePath: [PI_CONFIG_DIR_NAME, PI_AGENT_DIR_LEAF['acp']],
  },
  surfaces: ['acp', 'tui'],
  sessionpage: {
    'acp': {
      identity: 'addressable',
      messageTransport: 'router',
      injection: {
        timing: 'next-tool-call',
        evidence:
          'shuxueshuxue/gugu-acp@de4a74b1b5da bridges/pi-acp/patches/0001-_session-steering-extension-method-mid-turn-mes.patch '
          + '(the `_session/steering` capability this leg relies on; upstream svkozak/pi-acp#115). Product reading 2026-09-12: '
          + 'DM and group delivery A/B pass; runtime-state and owner-chat projection are independent defects',
      },
    },
    'tui': { identity: 'addressable', messageTransport: 'local-session' },
  },
  runtimeCompatibility: {
    // Pi's zstd path requires Node 22.15+ on the 22 line or 23.8+; a single floor would
    // incorrectly admit the known-broken 23.7 runtime or reject the supported 22 line.
    'tui': {
      kind: 'semver-supported-ranges',
      runtime: 'node',
      supportedRanges: ['>=22.15.0 <23.0.0', '>=23.8.0'],
      versionArgs: ['--version'],
    },
  },
  units: {
    // MCP / env / model / promptBlocks 四维**两条腿答案相同**,所以仍是扁平声明 —— 不是图省事:
    // 两条腿最终都只能骑「子进程环境 + 咕咕自有配置根」这一对载体(ACP 腿递不进任何 pi argv),
    // 而这四维本来就都走这一对。真正分叉的只有下面的自治级别。
    mcp: { kind: 'native', channel: 'extension-event' },
    // ⚠️ ACP 腿的 BYOK 是 **env-only**:那条腿的配置根恒为咕咕自有(事件模块与 MCP 适配器都住在
    //    里面,不指走这两维当场就没了),于是用户 `pi login` 存在自己 `~/.pi/agent/auth.json`
    //    里的登录态在这条腿上**看不见**,只能靠 provider 的环境变量(宿主 env 白名单照常透传)。
    //    ❌ 不许把用户的 auth.json 拷进 run home 来补 —— 那是把认证字节复制进咕咕的地盘。
    //    要两者并存得改走 `managed-config-root`(kimi 那套),那是另一刀。
    env: { kind: 'native', channel: 'child-process' },
    model: { kind: 'native', channel: 'system-config-overlay' },
    /**
     * 自治级别 —— **逐腿**,只有 ACP 腿量过。
     *
     * pi 引擎没有内建审批档(官方 security 文档:不带沙箱,内建工具以进程权限直接执行),
     * 所以这一档由咕咕自己的事件模块在 `tool_call` 边界建起来:approval-required 时逐个工具
     * `ctx.ui.confirm`,而 `pi-acp` 把 rpc 模式下的这次 confirm 桥成真正的 ACP
     * `session/request_permission`(allow_once / reject_once),落进咕咕既有的权限往返。
     * 通道是 `process-config`:咕咕按本次会话解析出的档**算出**一个子进程环境变量再注进去
     * (与只是把给进来的变量原样透传的 `env` 那一维不是一回事)。
     *
     * ⚠️ ❌ 不许拿 `pi-acp` 的 `session/set_mode` 顶这一维:它回报的 `availableModes` 是
     *    **思考强度**(off/minimal/…/xhigh),不是权限档;拿咕咕的档名去 set 会被当场
     *    `Unknown modeId` 拒绝。同理本家**不声明** `autoApprove.modes`。
     * ⚠️ 终端腿如实留 `none`:同一个事件模块在那条腿上也在,但那条腿的 confirm 往返咕咕
     *    没有量过(没有等价的权限 UI 读数)。❌ 不许让 ACP 腿替它背书。
     */
    autonomy: {
      kind: 'per-surface',
      surfaces: {
        'acp': { kind: 'native', channel: 'process-config' },
        'tui': { kind: 'none', degraded: unverifiedAutonomy },
      },
    },
    promptBlocks: { kind: 'native', channel: 'extension-event' },
  },
  extension: {
    kind: 'event-module',
    format: 'pi',
    scope: 'workspace',
    carries: { mcp: 'none', skills: 'none', systemPrompt: 'module', hooks: 'module' },
  },
  coexistence: {
    /**
     * TUI 腿的回传通道(主干见 `session-core/.../capabilities/tui-coexistence.ts`):
     * `PI_EXTENSION_CONTENT` 落到 `.pi/extensions/gugu-hook.ts`(behavior 的
     * `createFileDropPlugin`,由 `hook-config-service.ts:72 ensureHooksInstalled` 每次 spawn
     * 前写盘),扩展挂 `pi.on('agent_start')` / `agent_end` / `session_shutdown` / uncaughtException,
     * POST 到 `GUGU_HOOK_PORT` 的 `/hook` → 宿主 `hook-server.ts` → `event-enricher.ts`
     * → `agent-hook-service.ts:317` 落成 `conversations.agentStatus`。
     * 引擎自己的事件系统推出来的,故是 `event-stream`。
     *
     * ⚠️ **两条边都是原生的**(`supportedEvents` = ['session','start','stop'])。
     * 此前这里写着「没有原生 start,『本轮在飞』那一半由宿主从『用户按了回车』推」——
     * 那句话记录的状态本身就是缺陷:实测(base 271ffaa7f6)第一句之后的每一轮,不论咕咕投递
     * 还是用户自己在终端里敲,状态点全程 `av-status--idle`;只有**建会话**那一发亮,而那一下来自
     * [[session-initial-status]] 的状态出生,不是回合边沿(owner 2026-09-14;#5438/#5509 同族)。
     * 读数与控见 `index.ts` 的 hooks 描述符那一段。
     */
    observability: { kind: 'native', channel: 'event-stream' },
    /**
     * TUI 腿的中断通道(主干同上)。宿主 `ptyController.interrupt`
     * (apps/desktop/electron/session/main/core/pty/controller.ts:149)读下面的 `sessionTuiInterrupt`,
     * 经 `tuiInterruptWrites` 展开成 pty 写入序列。
     * ⚠️ 这一条与 `sessionTuiInterrupt` 同生同灭。
     */
    pause: { kind: 'native', channel: 'interrupt-key' },
    /**
     * 记忆文件读得到:`impl/pi/index.ts` 的 capabilities.memory 登记了两条 AGENTS.md 入口
     * (出处见那一段),宿主经 `AgentPluginHost.readMemoryFiles`(plugin-host.ts:270)按登记
     * 逐条读回 —— 读的是磁盘,不经会话表面,故与 pi 只有一条 TUI 腿无关。
     * ⚠️ channel 必须与 capabilities.memory 登记的通道同名。
     */
    memory: { kind: 'native', channel: 'agents-md' },
  },
  /**
   * 中断键 = 单按 **Esc**。
   *
   * ⚠️ 这一家的 Ctrl-C **会退进程**,填错就是把用户正在跑的会话杀掉、界面还报「已暂停」——
   * 所以这里逐字照录官方键位表的三行,而不是套「Esc 大家都一样」的通例:
   *   `app.interrupt` = `escape`  → "Cancel / abort"
   *   `app.clear`     = `ctrl+c`  → "Clear editor (first) / exit (second)"
   *   `app.exit`      = `ctrl+d`  → "Exit (when editor empty)"
   * 单按即中断(表里没有「按两次」的限定),故不写 `presses` / `intervalMs`。
   */
  sessionTuiInterrupt: {
    sequence: '\u001b',
    evidence:
      'earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477 '
      + 'packages/coding-agent/docs/keybindings.md 的 Application 键位表:'
      + 'app.interrupt=escape「Cancel / abort」;同表 app.clear=ctrl+c「Clear editor (first) / '
      + 'exit (second)」、app.exit=ctrl+d —— 故 Ctrl-C 是退出、只有 Esc 是暂停。'
      + '同仓 packages/coding-agent/docs/usage.md 的 Message Queue 一节佐证:'
      + '「Escape aborts and restores queued messages to the editor」。取证日期 2026-08-24。',
  },
  // ❌ 其余五维不写:落 BASE_SESSION_COEXISTENCE。pi 只有 tui 一条腿
  // (`surfaces` = ['tui'],provider 也没有 acp 行为),所以没有协议 cancel / plan,
  // askUser 那条往返在 TUI 腿上两头都断(理由见 session-core 的 tui-coexistence.ts 末尾);
  // MCP 不是 Pi 内建配置行为,但 tui 通过上面的外部 `pi-mcp-adapter` event registration
  // 接入 session-scoped server;plugins 仍是 createFileDropPlugin —— 只写/删/探
  // **咕咕自己那一个** `.pi/extensions/gugu-hook.ts`,从不枚举用户自己的 extension;
  // trust 行为走 `--approve` 的 runtime-argv,不往 `.pi/agent/trust.json` 写用户配置;历史读回也只接了
  // claude-code 与 codex(transcriptInventory.ts)。
  // ⚠️ 别把 units.promptBlocks('extension-event' = 经 GUGU_PI_SYSTEM_PROMPT 注系统提示)
  // 当成 memory:那是咕咕每次会话推进去的提示块,不是引擎自己会去读的记忆文件。
  // 这是「咕咕还没接」,不是「pi 做不到」。
  //
  // ⚠️ `todo` 这一维**不是**「咕咕没接」,是**引擎里没有这个东西**,所以别照着 #3889 答案键
  // 那格(`have` /「todo.ts示例结构化」)去找接线口:pi 的内建工具全集是
  // `packages/coding-agent/src/core/tools/index.ts:95` 的
  // `type ToolName = "read" | "bash" | "powershell" | "edit" | "write" | "grep" | "find" | "ls"`
  // —— 没有 todo。答案键指的 `todo.ts` 住在 `packages/coding-agent/examples/extensions/todo.ts`
  // (文件抬头自称 "Todo Extension - Demonstrates state management via session entries"),
  // 是一份**示例扩展**:用户装了才有,而且它注册的是自己那个 `todo` 工具,不是引擎事件。
  // 判据取自阳性对照过的全仓扫描:`grep -rni todo src/` 在 pi 引擎源码里只命中
  // `src/core/export-html/vendor/highlight.min.js` 里的 TODO 注释高亮正则,零业务命中;
  // 同一条命令对着 `examples/extensions/todo.ts` 命中三行,证明它会红。
  // ⇒ 咕咕这一侧就算把 `.pi/extensions/gugu-hook.ts` 从只转 `agent_end`/`session_shutdown`
  //   扩到转 todo,也**没有 todo 事件可转**。取证 sha 同 sessionTuiInterrupt。
  // ❌ `history` 这一维**今天做不成**,不是没排上。查清楚了,写在这里免得下一个人重走一遍:
  //
  // pi 的会话文件是**树**:条目用 `id` / `parentId` 相连,支持原地分叉,而 pi 自己构造上下文的
  // 做法是「从当前叶子回溯到根」(官方 `docs/session-format.md` 的 Context Building 一节,
  // `buildContextEntries()`)。咕咕这边 `JsonlTranscriptSourceSpec.readFrame` 是**逐行纯函数**、
  // 明文不看上下文 —— 结构上选不出当前路径。线性读全部行 = 把用户**明确分叉抛弃**的那些消息
  // 也一并导入,而摘录结果是要上云的。
  //
  // ⚠️ 更关键的是**验不了**:pi 上游仓里那两份 fixture
  // (`test/fixtures/large-session.jsonl` 1019 行 / `before-compaction.jsonl` 1003 行)
  // 实测是 **v1 legacy 线性格式** —— 1019 条里带 `id` 的只有文件头那一条,`parentId` **零条**,
  // 头里也没有 `version` 字段(文档:v1 无树,v2 才引入 id/parentId,当前是 v3)。
  // 本机也没装 pi(`~/.pi/agent/sessions` 不存在)。
  // ⇒ 今天写解析器,只能得到一个「拿两个版本前的样本验过、对当前 v3 文件静默出错」的东西。
  //   编一份 v3 样本来验自己写的解析器是自证循环,本仓明令禁止。
  //
  // 解锁需要两件事,缺一不可:
  //   1. 契约长出选路能力(spec 声明 `id`/`parentId` 键名,通用层做叶子→根选择),或等价机制;
  //   2. 一份**真实的 v3 会话**(装上 pi 跑一轮产出,或上游补 v3 fixture)。
  //   出处 earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477。
} satisfies SessionBundleDescriptor;

function renderPromptBlocks(blocks: SessionPromptBlocks): string {
  return (blocks.platform ?? '') + (blocks.identity ?? '');
}

function childEnv(
  bundle: SessionCapabilityBundle,
  promptValue: string
): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(bundle.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  const stdioEnvRefs = new Set(
    bundle.mcpServers.flatMap((server) =>
      server.transport === 'stdio' ? Object.values(server.env ?? {}) : []
    )
  );
  const mcpServers = bundle.mcpServers.map((server, index) => {
    // ⚠️ `eager` 在**运行时注册**这条路上**不等于「会话一起来就连」**。读 pi-mcp-adapter 2.32.1 的源码:
    //    只有 `startLoadTimeInitialization()` 会在启动时连,而它扫的是 `earlyConfig.mcpServers`
    //    ——**配置文件里**那些 server;运行时注册走 `attachRuntimeServerLifecycle`,那里 `eager`
    //    只用来算 `persistsAfterFirstSpawn` ⇒ `idleTimeout: 0`(**首次拉起之后**不因空闲而断),
    //    从头到尾不触发连接。⇒ 咕咕这台 server 实际是**首次被用到时才连**。
    // 仍然发 `eager` 是对的:我们要的正是「这条会话期间别把它空闲断掉」。
    // ❌ 但不许据此在任何声明或注释里说它在 session start 就完成了握手 —— 实测 initialize /
    //    tools/list 出现在第一次代理工具调用之后,不在会话起来那一刻。
    const lifecycle = server.alwaysLoad ? ('eager' as const) : ('lazy' as const);
    if (server.transport === 'stdio') {
      assertSessionMcpStdioEnv(server, bundle, 'Pi');
      return {
        name: server.name,
        command: server.command,
        ...(server.args ? { args: [...server.args] } : {}),
        ...(server.env ? { env: sessionMcpStdioEnv(server) } : {}),
        ...(server.cwd ? { cwd: server.cwd } : {}),
        lifecycle,
      };
    }
    const bearerTokenEnv = server.authorizationEnv
      ? `GUGU_PI_MCP_BEARER_${index}`
      : undefined;
    if (server.authorizationEnv) {
      const authorization = sessionMcpAuthorization(server, env, 'Pi') ?? '';
      const match = /^Bearer\s+(.+)$/i.exec(authorization);
      if (!match?.[1]) {
        throw new Error(
          `Pi session adapter MCP '${server.name}' requires a Bearer authorization value`,
        );
      }
      env[bearerTokenEnv!] = match[1];
      if (!stdioEnvRefs.has(server.authorizationEnv)) delete env[server.authorizationEnv];
    }
    return {
      name: server.name,
      url: server.url,
      auth: bearerTokenEnv ? ('bearer' as const) : false,
      ...(bearerTokenEnv ? { bearerTokenEnv } : {}),
      lifecycle,
    };
  });
  if (mcpServers.length > 0) {
    env[GUGU_PI_MCP_SERVERS_ENV] = JSON.stringify(mcpServers);
  }
  if (promptValue) env[GUGU_PI_SYSTEM_PROMPT_ENV] = promptValue;
  return env;
}

function modelArtifact(
  surface: SessionpageSessionSurface,
  bundle: Pick<SessionCapabilityBundle, 'env' | 'model'>
): SessionMaterialization['artifacts'][number] | null {
  const model = bundle.model;
  if (!model) return null;
  if (model.dialect !== 'pi-models-json' || !model.platformProvider || !model.model) {
    throw new Error('Pi platform model requires pi-models-json, a selected model and relay credentials');
  }
  const guguHome = bundle.env.GUGU_HOME?.trim();
  if (!guguHome) throw new Error('Pi platform model requires GUGU_HOME');
  const entries = [
    { id: model.model, name: model.model, contextWindow: model.contextWindow },
    ...(model.platformModels ?? []).map((entry) => ({
      id: entry.id,
      name: entry.displayName,
      contextWindow: entry.contextWindow,
    })),
  ].filter((entry, index, all) => all.findIndex((candidate) => candidate.id === entry.id) === index);
  return {
    path: join(piAgentDir(surface, guguHome), PI_MODELS_RELATIVE),
    mode: 0o600,
    target: 'gugu-home',
    content: `${JSON.stringify({
      providers: {
        [PI_PLATFORM_PROVIDER_ID]: {
          name: 'Gugu platform quota',
          api: PI_PROVIDER_API,
          baseUrl: model.platformProvider.baseUrl,
          apiKey: '${GUGU_PI_API_KEY}',
          authHeader: true,
          models: entries.map((entry) => ({
            id: entry.id,
            name: entry.name,
            api: PI_PROVIDER_API,
            // pi `docs/models.md` 的模型字段表:`reasoning` 缺省 **false** = 「不支持扩展思考」。
            // 而 pi 把它当**硬门**:`model.reasoning` 为假时,`setThinkingLevel` 会被它自己钉回
            // `off`(2026-09-13 实测:逐档设、read_back 恒 "off"、上游请求体里根本没有
            //  `reasoning_effort`)⇒ 不写这一行,咕咕里的 thinking 档**无论重不重启都不生效**。
            //
            // ⚠️ 这里对整组平台模型**一视同仁**写 true,而那是**权宜,不是设计** —— 见 #5566。
            // 「这个平台模型到底支不支持扩展思考」今天在咕咕里**没有真值**:
            // `billing.platform_models` 没有这一列、目录项(`PlatformModelCatalogItem`)与签发的
            // `switchableModels` 都没有这一格;而 `harness-model-catalog.ts` 明文禁止伪造
            // per-model 的推理事实(「❌ 不要伪装成 per-model:那会编出一个协议没说过的事实」)。
            // ⇒ 在 #5566 把这一列补进控制面之前,只能整组声明,由上游的拒绝当裁判。
            // ❌ 别把这行读成「我们认定所有平台模型都支持思考」。
            reasoning: true,
            ...(entry.contextWindow ? { contextWindow: entry.contextWindow } : {}),
          })),
        },
      },
    }, null, 2)}\n`,
  };
}

function modelArgs(bundle: SessionCapabilityBundle): string[] {
  const model = bundle.model;
  if (!model) return [];
  if (model.dialect !== 'pi-models-json' || !model.platformProvider || !model.model) {
    throw new Error('Pi platform model requires pi-models-json, a selected model and relay credentials');
  }
  return ['--provider', PI_PLATFORM_PROVIDER_ID, '--model', model.model];
}

function packageEntry(bundle: SessionCapabilityBundle): CapabilityPackage {
  const entry = bundle.packages.find(
    (candidate) =>
      candidate.id === PI_GUGU_PACKAGE_ID && candidate.version === PI_GUGU_PACKAGE_VERSION
  );
  if (!entry) {
    throw new Error(
      `Pi session adapter requires capability package '${PI_GUGU_PACKAGE_ID}@${PI_GUGU_PACKAGE_VERSION}'`
    );
  }
  return entry;
}

function report(
  ctx: SessionMaterializationContext,
  promptValue: string,
  bundle: SessionCapabilityBundle,
): SessionMaterialization['report'] {
  const loaded = { status: 'loaded' as const };
  return {
    adapterId: 'pi',
    surface: ctx.surface,
    units: {
      mcp: { status: 'loaded' },
      env: loaded,
      model: bundle.model ? loaded : { status: 'degraded', reason: unverifiedModel },
      autonomy: { status: 'degraded', reason: unverifiedAutonomy },
      promptBlocks: promptValue
        ? loaded
        : {
            status: 'degraded',
            reason: { code: 'unverified', reason: 'No prompt blocks were declared.' },
          },
      packages: loaded,
    },
    discoveredCommands: [],
  };
}

/** 咕咕在 ACP 腿上自有的那份 pi 配置根(`PI_CODING_AGENT_DIR` 指过去)。 */
function acpAgentDir(bundle: Pick<SessionCapabilityBundle, 'env'>): string {
  const guguHome = bundle.env.GUGU_HOME?.trim();
  if (!guguHome) throw new Error('Pi session-ACP session requires bundle.env.GUGU_HOME');
  return piAgentDir('acp', guguHome);
}

/**
 * ACP 腿的启动配置 —— 这条腿递不进 `--extension` / `--provider` / `--model`,那三样只能落在
 * 咕咕自有配置根的这份 settings 里。
 *
 * ⚠️ ❌ 不写 `defaultProjectTrust`:那会顺带打开被测仓库自己的 `.pi/settings.json` 与项目扩展。
 *    咕咕自己的事件模块走**全局** extensions 目录,本来就不需要 project trust。
 */
function acpSettingsArtifact(
  bundle: Pick<SessionCapabilityBundle, 'model'>,
  agentDir: string
): SessionMaterialization['artifacts'][number] {
  const model = bundle.model;
  const selected = model?.model?.trim();
  const settings: Record<string, unknown> = {
    // 版本钉死的 MCP 适配器 —— 与终端腿 argv 上那一份是**同一个** source 常量。
    packages: [PI_MCP_EXTENSION_SOURCE],
    // @@@quiet-startup (#5557) 关掉适配器合成的那段开场清单 —— 它会成为对话里的第一条 assistant 消息。
    //
    // 那段横幅**不是 pi 在吵,是我们塞了一句话进它嘴里、它照着念**:pi-acp 的 `buildStartupInfo`
    // 把 `<PI_CODING_AGENT_DIR>/settings.json` 的 `packages[]` 逐条列进 `## Extensions`
    // (`npm:` 开头的还补一行 `- index.ts`),而那个数组正是上面这一行 ⇒ 用户看到
    // 「pi v0.85.1 / Extensions / npm:pi-mcp-adapter 2.32.1 / index.ts」,一段没有作者的开场白。
    // 它走正规 `session/update` + `agent_message_chunk`、**自称就是一条 assistant 消息**,
    // 所以宿主渲染它毫不奇怪 —— 要治的是别让它被造出来,❌ 不是在宿主侧按文案去认它
    // (认 `pi v` / `## Extensions` = 把判据挂在上游文案上,他们改一个字我们就瞎,而且瞎的时候不报错)。
    //
    // ⚠️ 这一维只关**合成的清单**,❌ 不是「把 pi 的输出全丢掉」——真正的失败一条都不经过这里:
    //    鉴权走 `authRequired`、起不来走 `PiRpcSpawnError`、prompt 失败照旧抛;
    //    版本更新提示(`buildUpdateNotice`)也不受它影响,照旧送到用户面前。
    // ⚠️ 只给 ACP 腿:终端腿那段横幅是 pi 自己终端里的正常输出,用户本来就该看见。
    // 出处:pi-acp@0.0.33 `getQuietStartup()` 读的就是这份全局 settings 的 `quietStartup`;
    //      实测 2/4 次落进对话(竞态,见 #5557),关掉之后 0/6。
    quietStartup: true,
  };
  if (model && selected) {
    if (model.dialect !== 'pi-models-json' || !model.platformProvider) {
      throw new Error('Pi platform model requires pi-models-json and relay credentials');
    }
    // 启动那一刻钉住;运行时改选仍走 adapter 的模型目录 + session/set_config_option。
    settings.defaultProvider = PI_PLATFORM_PROVIDER_ID;
    settings.defaultModel = selected;
  }
  // 这条会话选中的**思考档**,同样在启动那一刻钉住。
  // 出处:pi `docs/settings.md` 的 `defaultThinkingLevel`(「Startup thinking level」)。
  //
  // ⚠️ 它是「重开之后仍然是用户要的那一档」**唯一**的通道:ACP 腿递不进 argv,而活会话的
  //    `set_config_option` 只作用于当前进程 —— 重开就回到启动值。⇒ 宿主先把新档落进会话记录
  //    (`config.effort`),重开时这份 settings 按记录重算,于是新档跟着进新会话。
  //    少了这一行,「点确认 → 重启」会**重启回旧档**,而界面显示的是新档。
  const thinkingLevel = model?.reasoningEffort?.trim();
  if (thinkingLevel) settings.defaultThinkingLevel = thinkingLevel;
  return {
    path: join(agentDir, PI_ACP_SETTINGS_RELATIVE),
    mode: 0o600,
    target: 'gugu-home',
    content: `${JSON.stringify(settings, null, 2)}\n`,
  };
}

/** Shared model files and environment for sessions and isolated catalog probes. */
export function materializePiModelConfig(
  surface: SessionpageSessionSurface,
  bundle: Pick<SessionCapabilityBundle, 'env' | 'model'>
): Pick<SessionMaterialization, 'env' | 'artifacts'> {
  const env: Record<string, string> = {};
  const model = bundle.model;
  if (model) {
    if (model.dialect !== 'pi-models-json' || !model.platformProvider || !model.model) {
      throw new Error('Pi platform model requires pi-models-json, a selected model and relay credentials');
    }
    const guguHome = bundle.env.GUGU_HOME?.trim();
    if (!guguHome) throw new Error('Pi platform model requires GUGU_HOME');
    env[PI_AGENT_DIR_ENV] = piAgentDir(surface, guguHome);
    env.GUGU_PI_API_KEY = model.platformProvider.apiKey;
  }
  const agentDir = surface === 'acp' ? acpAgentDir(bundle) : null;
  if (agentDir) env[PI_AGENT_DIR_ENV] = agentDir;
  const models = modelArtifact(surface, bundle);
  return {
    env,
    artifacts: [
      ...(agentDir ? [acpSettingsArtifact(bundle, agentDir)] : []),
      ...(models ? [models] : []),
    ],
  };
}

function materializeSessionAcp(
  ctx: SessionMaterializationContext,
  bundle: SessionCapabilityBundle
): SessionMaterialization {
  const capabilityPackage = packageEntry(bundle);
  const promptValue = renderPromptBlocks(bundle.promptBlocks);
  const agentDir = acpAgentDir(bundle);
  const modelConfig = materializePiModelConfig('acp', bundle);
  const env = { ...childEnv(bundle, promptValue), ...modelConfig.env };
  const autonomy = bundle.autonomy;
  if (autonomy) env[GUGU_PI_AUTONOMY_ENV] = autonomy.mode;
  const base = report(ctx, promptValue, bundle);
  return {
    // ❌ 这条腿不发 argv:`buildAcpSpawn` 只从 `behavior.acp.buildSpawn` 造 args,
    //    物化器返回的 argsAppend 在 ACP 腿上是静默 no-op(与 grok 同一条记录)。
    argsAppend: [],
    env,
    configMerges: [],
    artifacts: [
      ...capabilityPackage.artifacts.map((artifact) => ({
        ...artifact,
        // 同一份字节,换一个不需要 project trust 的锚点。
        path: join(agentDir, PI_ACP_EVENT_MODULE_RELATIVE),
        target: 'gugu-home' as const,
      })),
      ...modelConfig.artifacts,
    ],
    report: acpReport(base, autonomy),
  };
}

/** ACP 腿多兑现一维(自治),其余逐字沿用共用的那份报告。 */
function acpReport(
  base: SessionMaterialization['report'],
  autonomy: SessionCapabilityBundle['autonomy']
): SessionMaterialization['report'] {
  return {
    ...base,
    units: {
      ...base.units,
      autonomy: autonomy
        ? { status: 'loaded' }
        : { status: 'degraded', reason: unverifiedAutonomy },
    },
  };
}

export function materializePiSessionBundle(
  ctx: SessionMaterializationContext,
  bundle: SessionCapabilityBundle
): SessionMaterialization {
  if (!piSessionBundleDescriptor.surfaces.includes(ctx.surface as never)) {
    throw new Error(`Pi session adapter does not support surface '${ctx.surface}'`);
  }
  if (ctx.surface === 'acp') return materializeSessionAcp(ctx, bundle);
  const capabilityPackage = packageEntry(bundle);
  const promptValue = renderPromptBlocks(bundle.promptBlocks);
  const modelConfig = materializePiModelConfig('tui', bundle);
  return {
    argsAppend: ['--extension', PI_MCP_EXTENSION_SOURCE, ...modelArgs(bundle)],
    env: { ...childEnv(bundle, promptValue), ...modelConfig.env },
    configMerges: [],
    artifacts: [
      ...capabilityPackage.artifacts.map((artifact) => ({
      ...artifact,
      path: join(ctx.cwd, artifact.path),
      target: 'workspace' as const,
      })),
      ...modelConfig.artifacts,
    ],
    report: report(ctx, promptValue, bundle),
  };
}
