import { harnessPlatform } from './platform';
import { join } from 'node:path';
import { MIMOCODE_PLUGIN_CONTENT } from './plugin-file';
import { MIMOCODE_REASONING_VARIANTS } from './efforts';
import {
  openCodeFamilyModelConfig,
  type OpenCodeFamilyModelSpec,
} from '../../helpers/opencode-family-model-config';
import {
  openCodeFamilyPermissionConfig,
  type OpenCodeFamilyPermissionSpec,
} from '../../helpers/opencode-family-permission-config';
import {
  definedEnv,
  mergeOpenCodeFamilyOwnedConfig,
  openCodeFamilyMcpConfig,
  openCodeFamilyRunHome,
  parseOpenCodeFamilyConfig,
  type OpenCodeFamilyConfigSpec,
} from '../../helpers/opencode-family-session-config';
import type {
  HarnessSessionSurface,
  SessionBundleDescriptor,
  SessionCapabilityBundle,
  SessionMaterialization,
  SessionMaterializationContext,
} from '@gugu/session-core/agents/plugins';
import { resolveSessionCredentialLifecycle as resolveCredentialLifecycle } from '@gugu/session-core/agents/plugins';

/** 承载整份配置文档的环境变量。opencode 那家叫 OPENCODE_CONFIG_CONTENT，只有名字不同。 */
const MIMOCODE_CONFIG_ENV = 'MIMOCODE_CONFIG_CONTENT';
export const MIMOCODE_GUGU_EVENT_MODULE_PATH = '.mimocode/plugins/gugu-notifications.js';

/** 与 opencode 同一套约定：模型按 `<providerId>/<model>` 寻址，所以 provider 要一起声明。 */
export const MIMOCODE_FAMILY_MODEL_SPEC: OpenCodeFamilyModelSpec = {
  displayName: 'MiMo-Code',
  dialect: 'mimocode-config-content',
  platformProviderId: 'gugu-platform',
  platformProviderName: 'Gugu 平台额度',
  outputLimit: 131_072,
  // 推理档 —— 与 opencode 的**唯一**形状差别。为什么这一家能声明而 opencode 不能，
  // 以及这三档各自的一手出处，全在 `./efforts.ts` 抬头。
  reasoningVariants: MIMOCODE_REASONING_VARIANTS,
};

export const mimocodeSessionBundleDescriptor = {
  // ⚠️ 今天声明托管,但**举证未完成** —— 见 #4834。已知读数:本家能力**全部**已走
  // `MIMOCODE_CONFIG_CONTENT` 一个环境变量,托管侧只为写 `data/trusted-workspaces.json` 一个文件;
  // 而 `configRoot.userPath: '.'` = 整个 $HOME,咕咕数据根又在家目录内部 ⇒ 复制自我嵌套(#4834 实测)。
  // ⚠️ 这条**最紧急**:在改成 'runtime' 之前,userPath 无论如何不该是 '.'。
  // 运行时注入(#4834 §4 owner 拍板)。托管那一侧对本家是**双向不成立**的:
  // ① 它声明的配置根是 `.` = 整个 `$HOME`,而咕咕数据根就在 HOME 里面 ⇒ 复制自我嵌套,
  //    2026-09-03 owner MBP 实测单个 tier 吃掉 34 GB,按并行 lane 数线性烧穿整机;
  // ② 「托管但不复制」也不许(owner 同日拍板):那等于咕咕凭空造一份配置根,用户自己的
  //    mimocode 配置在里面根本不存在 —— product spec 禁的正是这个。
  // 能力面本来就不依赖它:模型 / MCP / 自治全走 `MIMOCODE_CONFIG_CONTENT` 一个环境变量。
  // ⚠️ **如实标缺**:随之丢掉的是首启信任状态的预置(原先写影子 home 的
  //    `data/trusted-workspaces.json`)。这个缺口后来以运行时通道补上(#4975):
  //    TUI 的官方旗标 `--trust`,单次 spawn、零落盘,见 ./trust.ts。❌ 不拿托管侧换回来。
  injectionMode: 'runtime',
  platform: harnessPlatform,
  shellEnv: { passThrough: ['MIMOCODE_HOME'] },
  /**
   * 关自更新(#6186)。opencode 分支同一段升级逻辑,变量名换成 MIMOCODE_ 前缀。
   * 不关时 TUI 启动即查新版,patch 级直接覆盖 `~/.mimocode/bin/mimo`。
   */
  selfUpdate: {
    kind: 'session-env',
    env: { MIMOCODE_DISABLE_AUTOUPDATE: '1' },
    evidence:
      'XiaomiMiMo/MiMo-Code@1579e7d9ee5f packages/opencode/src/cli/upgrade.ts:26'
      + '「if (config.autoupdate === false || Flag.MIMOCODE_DISABLE_AUTOUPDATE) return」;'
      + ' 0.1.13 发行二进制同一段。取证 2026-09-23',
  },
  credentialLifecycle: {
    'acp': {
      delivery: 'credential-proxy',
      originalProcessRefresh: 'supported',
      recovery: 'reopen',
      inferenceOwner: 'serve-process-descendants',
      reopenEntry: 'host-session-reload',
      sourceChangeSession: 'replace',
    },
    'tui': {
      delivery: 'credential-proxy',
      originalProcessRefresh: 'supported',
      recovery: 'reopen',
      inferenceOwner: 'serve-process-descendants',
      reopenEntry: 'host-session-reload',
      sourceChangeSession: 'replace',
    },
  },
  surfaces: ['acp', 'tui'],
  sessionpage: {
    // 2026-08-25 起 ACP 腿可寻址。此前是 none/none —— 那不是厂商的限制，是咕咕
    // 还没往这条腿投递 MCP 与身份自述：**没有 gugu-im 工具就发不出消息，没有身份自述
    // 就不知道自己是谁**，两样都缺时声明 addressable 等于骗人（`canProvisionSessionpageAgent`
    // 也正是卡在这一格上，不翻它连咕咕身份都不会给这条会话开）。
    // 两样现在都由上面的 units.mcp / units.promptBlocks 实测投递（读数见那两处注释）。
    'acp': { identity: 'addressable', messageTransport: 'router' },
    // MiMo Code is an OpenCode downstream fork. Its TUI is rendered by `attach` while the
    // host-owned `serve` process provides the control channel, so ordinary messages must use
    // the provider-agnostic serve/attach router rather than the PTY local-session path.
    'tui': {
      identity: 'addressable',
      messageTransport: 'router',
      hostAdapter: 'opencode-serve-attach-v1',
    },
  },
  runtimeCompatibility: {
    // 0.1.13 is the oldest version directly measured with serve/attach: health 200,
    // session creation, prompt_async admission, and a turn-start receipt all succeeded.
    'tui': { kind: 'semver-supported-floor', supportedFloor: '0.1.13', versionArgs: ['--version'] },
  },
  units: {
    // MCP —— 与 model / autonomy 同一条通道（`MIMOCODE_CONFIG_CONTENT` 里的 `mcp` 键）。
    //
    // 实测 @mimo-ai/cli 0.1.13（2026-08-25，隔离 HOME + 本地假 MCP 端点）：声明进去之后
    // 它**真的去连**——假端点收到 4 个真实 HTTP 请求（initialize / notifications/initialized /
    // GET text/event-stream / tools/list），`Authorization: Bearer …` 一字不差原样带上，
    // 协议版本 2025-11-25。工具也**真进了模型的工具表**，命名 `<server>_<tool>`
    // （从它发往本地假 OpenAI 端点的 `tools` 数组里抓到 `gugu-im_<tool>`）。
    // 反例对照：url 换成死端口 → `✗ failed`，活端点 0 请求 ⇒ 这个判据能红。
    //
    // ⚠️ `mimo debug agent build` 与 `/experimental/tool/ids` **都不是**工具表判据：
    //    前者是启用/禁用策略表，后者是静态内置表，两者都不含 MCP 工具。拿它们读就会
    //    得出「MCP 工具没进工具表」的错误结论。
    mcp: { kind: 'native', channel: 'process-config' },
    env: { kind: 'native', channel: 'child-process' },
    // 模型 —— 整份配置文档经**一个环境变量**送进去,不落盘。
    //
    // MiMo-Code 是 sst/opencode 的品牌化 fork(主包目录就叫 `packages/opencode`),
    // 所以配置形状与 opencode 逐字相同,差别只有承载它的变量叫 `MIMOCODE_CONFIG_CONTENT`
    // (出处:`packages/opencode/src/flag/flag.ts` 里 `MIMOCODE_CONFIG` / `MIMOCODE_CONFIG_CONTENT`
    //  两个逃生门,消费处在 config.ts;实测 @mimo-ai/cli 0.1.13 起本地假端点跑通,带变异对照 ——
    //  换 key 换 model id 两轮读数都跟着变)。
    //
    // ⚠️ 那段 JSON 的形状由 `helpers/opencode-family-model-config.ts` 与 opencode **共用** ——
    //    ❌ 别在这里重拼:两边漂移时,漂了的那家会静默走它自己的默认模型(opencode 系对读不懂的
    //    配置键不报错),再被网关按单模型白名单拒掉,症状离病根隔两层。
    model: { kind: 'native', channel: 'process-config' },
    // 自治级别 —— 与 model 同一条通道（`MIMOCODE_CONFIG_CONTENT` 里的 `permission` 块）。
    // 形状、那个 typo fail-open 坑、以及 MiMo 独有的 `bash_delete` 强制询问，
    // 全在 `helpers/opencode-family-permission-config.ts` 里说清了。
    autonomy: { kind: 'native', channel: 'process-config' },
    // 系统提示 —— 配置文档的 `instructions` 键指向一个 run-scoped 的 markdown 文件。
    //
    // ⚠️⚠️ **这一维默认是静默无效的**：MiMo 把整个 instruction 加载器关在
    // `MIMOCODE_ENABLE_DYNAMIC_SYSTEM_PROMPT` 后面（字节层 `if(!Jh.MIMOCODE_ENABLE_DYNAMIC_SYSTEM_PROMPT) return []`）。
    // 不设这个变量时，**一个 instruction 文件都不进系统提示——连项目里的 AGENTS.md / CLAUDE.md
    // 都不进**，而 `debug config` 里 `instructions` 好端端列着、退出码 0、零 warning。
    // 所以 materializer 在真的投递提示时必须把这个 gate 一起打开（见下面 `materialize…`）。
    //
    // 实测（同一次运行抓发往假端点的请求体）：不开 gate 时 `Instructions from:` 前缀、
    // 咕咕的标记、AGENTS.md 的标记**全部缺席**；开了之后三者同时出现，且同一请求里
    // `gugu-im_*` 工具也在 ⇒ MCP 与 instructions 可以同时生效。
    //
    // ⚠️ 指向不存在的路径是**静默丢弃**（软失败），与非法 `type` / 未知顶层键的 fail loud 不一致。
    //    所以这条路径由咕咕自己产出、自己保证存在，❌ 别接受外部传进来的路径。
    promptBlocks: { kind: 'native', channel: 'process-config' },
  },
  // The old event module is retired. Both task surfaces use host-owned serve/attach or
  // ACP lifecycle events, so no plugin is written during materialization.
  extension: {
    kind: 'none',
    degraded: {
      code: 'upstream-broken',
      reason: 'MiMo sessionpage delivery is host-owned; materializing @mimo-ai/plugin would trigger a cold install.',
    },
  },
  coexistence: {
    // 前三条由 ACP 腿提供(`surfaces` 含 'acp',本文件 provider.acp =
    // createNativeAcpBehavior(['acp'])),与厂商无关 —— 咕咕对任何走 ACP 的家都已接通
    // (⚠️ plan/todo **不在此列**,见下方单独说明):
    //  · cancel:acp/models/session.ts 的 'cancelling' 相 → acp/models/turns/turn.ts 的
    //    cancelled 出口。进程留着、会话还在,是**暂停**不是停止。
    //  · 在飞:session-runtime/src/acp-agents/machine/machine.ts 的 projectSessionState 产出
    //    isGenerating / canCancel / lifecycle;turn 侧有 startedAt + outcome 结算。
    //    ⚠️ 历史上的 plugin-file.ts gugu-notifications.js 曾提供另一条 hook 回传链；
    //    #4988 后两条 task surface 不再物化它，回合边界由宿主控制通道提供。
    //    (session.idle / session.error POST 到 GUGU_HOOK_PORT,由
    //    宿主 agent-hook-service 的 deriveAgentStatus 消费)。两条都在时取 acp-update:它报「在飞」,
    //    hook 链主要报「转空闲」。
    //  · 问人:走**授权型**——cell.ts 的 requestPermission → resolvePermission,
    //    pendingPermissions 由 session-chat-ui/src/state/chat-state.ts 的 setPermissions 递到界面。
    //    ❌ 澄清型(mcp-elicitation / native-tool)咕咕没通,不在此声明。
    pause: { kind: 'native', channel: 'protocol-cancel' },
    observability: { kind: 'native', channel: 'acp-update' },
    askUser: { kind: 'native', channel: 'permission-ask' },
    // ⚠️ todo 单独排除:**咕咕经这条腿收不到结构化 plan**。依据 #3889 横向发现②
    //    ——「『原生能力』和『经 ACP 拿得到的能力』必须分两栏,且不能互推」:
    //    opencode / goose / letta 的 ACP 桥不发 plan,grok / mistral / hermes 发,3:3,
    //    是实现差异不是协议限制。mimocode 落在**不发**那一栏,答案键证据串写得很明:
    //    「todo.updated数组;ACP不转发」—— 厂商侧**是有** todo 的(它自己发 todo.updated),
    //    断的是 ACP 这一段。所以整条移除、落回基类;❌ 不许读成「厂商没有 todo」,
    //    也不许改写成 none 去替厂商下结论。
    // 本文件注册了 behavior.mcp = mimocodeMcpAdapter() 且 capabilities.mcp 为 supported。
    // 它经 ./mcp.ts 的 mimocodeMcpAdapter(opencode 族形状,serversKey 'mcp')落到 createMcpAdapter.readServers,
    // 扫 `~/.config/mimocode/mimocode.json` 外加两条只读 legacy 路径,把配置里**每一条**都映射出来
    // (含用户自己加的)—— 不启引擎、纯读配置。
    introspection: { kind: 'native', channel: 'config-scan' },
    // 记忆文件读得到:本文件 capabilities.memory 登记了两条 AGENTS.md 入口(出处见那一段),
    // 宿主经 AgentPluginHost.readMemoryFiles(plugin-host.ts:270)按登记逐条读回 ——
    // 那条路与 surface 无关(读磁盘,不需要会话),故 ACP 腿断不断都不影响这一维。
    // ⚠️ channel 必须与 capabilities.memory 登记的通道同名。
    memory: { kind: 'native', channel: 'agents-md' },
    // 其余三维(todo / history / cron)落回基类 —— todo 的理由见上(这一波在上游源码里坐实了:
    // `XiaomiMiMo/MiMo-Code@0e5bf7b3c500b0708ad0999df5efd7d910508aa3` 的 `packages/opencode/src/acp/`
    // 全目录 grep `plan` **零命中**,发得出的 sessionUpdate 只有 agent_message_chunk /
    // agent_thought_chunk / available_commands_update / tool_call / tool_call_update /
    // usage_update / user_message_chunk —— 「ACP 不转发」是有源码的,不再只是答案键的转述);
    // 历史是 SQLite 不是 jsonl(`packages/opencode/src/storage/db.ts:30-35` →
    // `~/.local/share/mimocode/mimocode.db`,表 session/message/part/todo/permission),
    // 而 core 的 `TranscriptStorageChannel` 今天只实现了 jsonl 一种读法。
    // ⚠️ 那条库路径**不是固定的**:同文件 `getChannelPath()`(:29-34)只在安装通道是
    //    `latest` / `beta` / `prod` 时才叫 `mimocode.db`,其余通道叫 `mimocode-<channel>.db`,
    //    另有 `MIMOCODE_DB` 旗标可整个改掉(:36-42)。将来接历史时按这三条解析,
    //    ❌ 别把 `mimocode.db` 写死 —— 写死的后果是非默认通道的用户「历史读回来是空的」。
    //
    // ⚠️⚠️ **todo 这一维:这一波把「还差什么」查到底了,结论仍是欠账,但缺口不在厂商这边。**
    //    三条通道逐条落定(上游 `XiaomiMiMo/MiMo-Code@c3eeb3d732d802d18ec06bb6525a98c098f38918`):
    //     · `acp-plan`:**死路**,重验过了。`packages/opencode/src/acp/`(agent.ts / session.ts /
    //       types.ts 全目录)`grep -i plan` **零命中**;同一条命令 grep `sessionUpdate:` 有 13 处命中
    //       (usage_update / tool_call / tool_call_update / agent_message_chunk /
    //       agent_thought_chunk / available_commands_update)—— 阳性对照在,说明这把尺子会红,
    //       它的「零命中」是读数不是仪器坏。
    //     · `structured-event`:**厂商侧全通,断在咕咕主干**。厂商发的是结构化数组,不是文本:
    //       `packages/opencode/src/session/todo.ts:17-25`
    //         `Event.Updated = BusEvent.define("todo.updated",
    //            z.object({ sessionID: SessionID.zod, todos: z.array(Info) }))`,
    //       其中 `Info`(:9-14)= `{ content: string, status: string }`。
    //       **历史上这条事件曾递到咕咕手上** —— 本目录 `plugin-file.ts` 的 file-drop 插件
    //       挂的是 `event` 钩子,而 `packages/opencode/src/plugin/index.ts:413-423` 是
    //         `bus.subscribeAll()` → `for (const hook of hooks) hook["event"]?.({ event: input })`,
    //       **全量总线**,不是白名单。也就是说 `todo.updated` 每次都进过咕咕这个插件,只是
    //       `toGuguPayload()` 只认 `session.idle` / `session.error`,其余一律 return undefined。
    //       缺的是**回传那一段的词汇表**,而它在别的包里:
    //         · `session-core/src/agents/plugins/capabilities/hooks-types.ts:30-40` 的
    //           `CanonicalHookEvent` 只有 `status`(type ∈ start|stop|error|notification)/
    //           `session` / `ignore` 三支 —— 没有 todo 的位置;
    //         · 消费端 宿主 agent-hook-service 的 deriveAgentStatus 也只映这几支。
    //       ⇒ 现在硬接的话,插件 POST 出去的 todo 会在 `defaultHookEventParser` 那里被丢掉,
    //          界面上却记「已接通」。❌ 不许这么声明。要接的正解是先给主干长出 todo 这一支,
    //          那是 session-core + session-runtime 的改动,不该由这一家的 impl 目录顺手做。
    //     · `markdown`:**没有**。todo 只落 SQLite 的 `TodoTable`(todo.ts:41-55 的
    //       delete+insert 事务),厂商不写任何 markdown 待办文件。
    //    ℹ️ 另一条别走错的路:咕咕全仓消费 todo/plan 的入口**只有一个** ——
    //       `session-core/src/acp/transport/decode.ts:236` 的 `case 'plan'`(→ `normalized-event.ts:155`
    //       → `item-fold.ts:805`)。ACP 之外今天没有第二个入口,所以「厂商有 todo」离
    //       「咕咕读得到 todo」中间差的正是上面那一段。
  },
} satisfies SessionBundleDescriptor;

/** MiMo-Code shares the OpenCode family config and recovery capability. */
export function mimocodeCredentialLifecycle(surface: HarnessSessionSurface) {
  const lifecycle = resolveCredentialLifecycle(mimocodeSessionBundleDescriptor, surface);
  if (!lifecycle) throw new Error(`MiMo-Code credential lifecycle is undeclared for surface '${surface}'`);
  return lifecycle;
}

/**
 * `toolKeys` 从 MiMo-Code `packages/core/src/v1/config/permission.ts` 逐字转录
 * （2026-08-25 核对 @mimo-ai/cli@0.1.13）。
 *
 * ⚠️ 与 opencode 的那份**不一样**：MiMo 多 `actor` / `codesearch` / `bash_delete`，
 * 少 `todowrite`。❌ 别把两份合成一份 —— 合了之后写给对方一个它不认识的键，
 * 厂商会照单全收编译成永不匹配的死规则，一声不吭（fail-open）。
 */
export const MIMOCODE_FAMILY_PERMISSION_SPEC: OpenCodeFamilyPermissionSpec = {
  displayName: 'MiMo-Code',
  toolKeys: [
    'read', 'edit', 'glob', 'grep', 'list', 'bash', 'bash_delete', 'task',
    'external_directory', 'question', 'webfetch', 'websearch',
    'lsp', 'doom_loop', 'skill', 'actor', 'codesearch',
  ],
  // 比 opencode 多一条 `bash_delete`：它在 MiMo 里本就是 FORCED_ASK，写明只是让
  // 咕咕的意图不依赖厂商那条内建下限继续存在。
  approvalGatedKeys: [
    'bash', 'bash_delete', 'webfetch', 'websearch', 'external_directory', 'doom_loop',
  ],
};

/**
 * 这一家在 opencode 系共用件里的身份。
 *
 * ⚠️ `configEnvKey` 是 `MIMOCODE_*` 而不是 `OPENCODE_*` —— MiMo 的官网文档至今仍写着
 * `OPENCODE_CONFIG_CONTENT`，但它代码里读 `OPENCODE_*` 的地方是 **0 处**（实测：同一份
 * 配置换成 `OPENCODE_CONFIG_CONTENT` 下发，模型读出来是 None；换回 `MIMOCODE_*` 才生效）。
 * 照它文档写 = 静默无效。
 */
const MIMOCODE_FAMILY_CONFIG_SPEC: OpenCodeFamilyConfigSpec = {
  displayName: 'MiMo-Code',
  configEnvKey: MIMOCODE_CONFIG_ENV,
  runHomeSlug: 'mimocode-capability-runs',
};

/** 与 opencode 同一套：平台自述在前，身份在后。 */
function renderPromptBlocks(blocks: SessionCapabilityBundle['promptBlocks']): string {
  return (blocks.platform ?? '') + (blocks.identity ?? '');
}

/**
 * MiMo-Code 的物化。
 *
 * ❌ 没有走 `materializeAcpSessionBundle`：那个基座只会把 MCP 渲染成 ACP `session/new`
 * 的参数（它对 `units.mcp.channel !== 'acp-session'` 直接抛错）。这一家的 MCP 走配置文档，
 * 与 model / autonomy / instructions 挤在同一个环境变量里，所以整份配置要一次拼完。
 *
 * 扩展模块只保留为历史 artifact 声明；当前两条 task surface 都由宿主控制通道承接，materializer
 * 不生成插件文件，只回收逐字节匹配的旧残留。
 */
export function materializeMimocodeSessionBundle(
  ctx: SessionMaterializationContext,
  bundle: SessionCapabilityBundle,
): SessionMaterialization {
  const credentialLifecycle = mimocodeCredentialLifecycle(ctx.surface);
  if (credentialLifecycle.delivery !== 'credential-proxy' || credentialLifecycle.recovery !== 'reopen') {
    throw new Error(`MiMo-Code credential lifecycle for '${ctx.surface}' does not match MIMOCODE_CONFIG_CONTENT`);
  }
  if (!mimocodeSessionBundleDescriptor.surfaces.includes(ctx.surface as never)) {
    throw new Error(`MiMo-Code session adapter does not support surface '${ctx.surface}'`);
  }

  const promptValue = renderPromptBlocks(bundle.promptBlocks);
  const instructionsPath = promptValue
    ? join(openCodeFamilyRunHome(MIMOCODE_FAMILY_CONFIG_SPEC, bundle), 'instructions', 'gugu-session.md')
    : null;

  const merge = (base: Record<string, unknown>, patch: Record<string, unknown>) =>
    mergeOpenCodeFamilyOwnedConfig(MIMOCODE_FAMILY_CONFIG_SPEC, base, patch);
  // ⚠️ 一个 MCP server 都没有时**不写** `mcp` 键：写个 `{}` 进去是往调用方的配置文档里
  //    塞一个咕咕并不需要的键。这条与下面「四样全空就一个字都不发」是同一个纪律 ——
  //    没有能力可投递的会话，应当让用户的环境**原样不动**。
  const mcpPatch = bundle.mcpServers.length > 0
    ? { mcp: openCodeFamilyMcpConfig(MIMOCODE_FAMILY_CONFIG_SPEC, bundle) }
    : {};
  // ⚠️ **撞了就炸**，❌ 不静默覆盖。这里原先是一句浅覆盖 `{...existing, ...modelPatch}` ——
  // 调用方自己写过 `model` / `provider` 会被咕咕悄悄顶掉，而 opencode 系对配置读不懂不报错，
  // 于是他只会看到「我明明配了自己的端点，却在用别的」。现在与 opencode 同一套 owned-merge。
  const config = merge(
    merge(
      merge(
        parseOpenCodeFamilyConfig(MIMOCODE_FAMILY_CONFIG_SPEC, bundle.env[MIMOCODE_CONFIG_ENV]),
        openCodeFamilyModelConfig(MIMOCODE_FAMILY_MODEL_SPEC, bundle.model),
      ),
      openCodeFamilyPermissionConfig(MIMOCODE_FAMILY_PERMISSION_SPEC, bundle.autonomy),
    ),
    {
      ...mcpPatch,
      ...(instructionsPath ? { instructions: [instructionsPath] } : {}),
    },
  );

  const env = definedEnv(bundle.env);
  // 四样（模型 / 权限 / MCP / 指令）全空 ⇒ 这次会话咕咕没有任何东西要投递，
  // ❌ 那就别改调用方已经放在环境里的那份配置。
  const ownsConfig =
    Boolean(bundle.model) || Boolean(bundle.autonomy)
    || bundle.mcpServers.length > 0 || Boolean(instructionsPath);
  if (ownsConfig) env[MIMOCODE_CONFIG_ENV] = JSON.stringify(config);
  if (instructionsPath) {
    // ⚠️ 少了这一行，上面那份 `instructions` 一个字都不会进系统提示，而且不报错。
    //    见 units.promptBlocks 的注释：整个加载器关在这个 gate 后面。
    env.MIMOCODE_ENABLE_DYNAMIC_SYSTEM_PROMPT = '1';
  }

  const loaded = { status: 'loaded' as const };
  const absent = (unit: string) => ({
    status: 'degraded' as const,
    reason: { code: 'unverified' as const, reason: `No ${unit} was declared.` },
  });

  return {
    argsAppend: [],
    env,
    // MCP 走配置文档，不走 `session/new` —— ❌ 别两条都发，那会让同一个 server 被加载两次。
    acp: { mcpServers: [] },
    configMerges: [],
    // MiMo inherits OpenCode's plugin-origin behavior: the mere presence of this file triggers
    // a cold install of @mimo-ai/plugin before initialize. Retire only the exact bytes Gugu used
    // to write, leaving any user-owned plugin at the same path untouched.
    retiredArtifacts: [{
      path: join(ctx.cwd, MIMOCODE_GUGU_EVENT_MODULE_PATH),
      content: MIMOCODE_PLUGIN_CONTENT,
      target: 'workspace' as const,
    }],
    artifacts: instructionsPath
      ? [{ path: instructionsPath, content: promptValue, mode: 0o600 as const }]
      : [],
    report: {
      adapterId: 'mimocode',
      surface: ctx.surface,
      units: {
        mcp: bundle.mcpServers.length > 0 ? loaded : absent('MCP server'),
        env: loaded,
        model: bundle.model ? loaded : absent('model'),
        autonomy: bundle.autonomy ? loaded : absent('autonomy'),
        promptBlocks: instructionsPath ? loaded : absent('prompt blocks'),
        packages: {
          status: 'degraded' as const,
          reason: {
            code: 'upstream-broken' as const,
            reason:
              'MiMo Code treats any workspace .mimocode/plugins/*.js as a plugin origin and cold-installs '
              + '@mimo-ai/plugin before initialize; neither session surface consumes the module, so it is '
              + 'retired rather than materialized (#4988).',
          },
        },
      },
      discoveredCommands: [],
    },
  };
}
