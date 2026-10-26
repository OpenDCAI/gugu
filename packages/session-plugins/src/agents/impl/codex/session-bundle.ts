import { harnessPlatform } from './platform';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { mcpToggleDirective } from '@gugu/session-core/mcp';
import { assertSessionMcpStdioEnv, sessionMcpAuthorization } from '../../helpers/session-mcp';
import { codexNotifyConfigValue } from './hooks';
import { codexPlatformProviderConfigArgs } from './platform-provider-args';
import { codexPlatformModelFacts, GUGU_PLATFORM_MODELS_ENV } from './platform-models';
import { CODEX_AUTONOMY_BY_MODE, CODEX_PERMISSION_MODES, type CodexPermissionMode } from './permission-modes';

/**
 * 物化器 → ACP 薄桥的**唯一**一格交接:这条会话要关掉的 MCP server 名字(JSON 对象片段)。
 *
 * ⚠️ 它**不是**给 codex 看的 —— codex 不认识这个变量。它是咕咕自己两段代码之间的信道:
 * 关闭集合由物化器决定(它拿得到会话记录),而平台模型的 `CODEX_CONFIG` 由 `buildSpawn`
 * 独占产出(它拿得到平台凭据)。两边各有一半事实,所以只能在各自的 native consumer 合并。
 */
export const GUGU_CODEX_MCP_CONFIG_ENV = 'GUGU_CODEX_MCP_CONFIG';
/** ACP bridge input for the native Codex reasoning-summary config. */
export const GUGU_CODEX_REASONING_SUMMARY_ENV = 'GUGU_CODEX_REASONING_SUMMARY';
export const GUGU_CODEX_REASONING_SUMMARIES_SUPPORTED_ENV = 'GUGU_CODEX_REASONING_SUMMARIES_SUPPORTED';
/** ACP bridge input: the tool namespaces codex hands the model directly (JSON string array), see codexDirectNamespaces. */
export const GUGU_CODEX_DIRECT_TOOL_NAMESPACES_ENV = 'GUGU_CODEX_DIRECT_TOOL_NAMESPACES';
/** ACP bridge input: the skill roots it registers with `skills/extraRoots/set` (JSON string array), see extensionSkillRoot. */
export const GUGU_CODEX_SKILL_ROOTS_ENV = 'GUGU_CODEX_SKILL_ROOTS';

/**
 * #6387 Skills installed Apps bring, as one skill root gugu owns: `<extension>-<skill>` links to where the App keeps each
 * skill, in a folder named by its content (like claude's package folder: a session gets the set it opened with). codex
 * registers it at runtime — app-server `skills/extraRoots/set` (codex-rs app-server-protocol common.rs, since 0.136.0) —
 * and lists those skills as its own. Nothing lands in the person's ~/.codex.
 */
function extensionSkillRoot(bundle: SessionCapabilityBundle): { root: string; symlinks: GeneratedSymlink[] } | null {
  const skills = bundle.extensionSkills ?? [];
  if (skills.length === 0) return null;
  const guguHome = bundle.env.GUGU_HOME?.trim();
  if (!guguHome) throw new Error('Codex session adapter requires bundle.env.GUGU_HOME');
  const links = skills.map((skill) => ({ folder: extensionSkillFolderName(skill), source: skill.dir }));
  const fingerprint = createHash('sha256').update(JSON.stringify(links)).digest('hex').slice(0, 12);
  const root = join(guguHome, 'capability-packages', 'codex', 'skills', fingerprint);
  return {
    root,
    symlinks: links.map((link) => ({ sourcePath: link.source, path: join(root, link.folder), optionalSource: false })),
  };
}

/**
 * Library services and full-disclosure Apps retain direct-only namespaces. Gugu's own MCP uses Codex's native
 * execution surface, so its catalog remains callable from code mode. Its native omit_tools_from setting keeps
 * it out of Codex's deferred loading. The person's own MCP servers retain their native policy.
 * Namespace = `mcp__<config key>` (codex `sanitize_responses_api_tool_name`).
 */
function codexDirectNamespaces(bundle: SessionCapabilityBundle): string[] {
  return bundle.mcpServers.filter((server) => server.alwaysLoad && server.owner !== 'gugu').map((server) => `mcp__${mcpConfigKey(server.name)}`);
}

/**
 * `buildSpawn` → ACP 薄桥的第二格交接:agent 事件 hook 的 `notify` 回调(JSON 字符串数组)。
 *
 * @@@5380 与上面同一条纪律 —— codex 不认识这个变量,桥读到它之后把 `notify` 并进
 * thread-open 的 `config` map(`mcp_servers.*` 旁边),**不再**拼进 argv。
 * 只有咕咕自建的那座桥会转发 argv 给 `codex app-server`,而上游 `codex-acp` 不会;
 * 用 env 递就不必再按「是哪条腿」分两种拼法 —— 不读它的进程里它就是惰性的。
 */
export const GUGU_CODEX_NOTIFY_CONFIG_ENV = 'GUGU_CODEX_NOTIFY_CONFIG';

/**
 * 适配器的「同名去重」开关(`codex-acp` 1.3.0 的 `shouldDeduplicateMcpConflicts()`)。
 * 它默认**开着**,只有 `DISABLE_MCP_CONFIG_FILTERING === 'true'` 时才关。
 *
 * ⚠️ 咕咕**显式写死 `'false'`**,不是为了改它的默认,而是**不让用户环境里一个同名变量
 * 悄悄改掉它** —— 关掉去重之后,适配器会把 `mcp_servers` 整张表换成 ACP 递进去的那几台,
 * 我们写的 `enabled:false` 会被丢掉,而症状是「界面说关了、工具表纹丝不动」,零报错。
 */
export const CODEX_ACP_MCP_DEDUP_ENV = 'DISABLE_MCP_CONFIG_FILTERING';

/**
 * The oldest codex the chat leg (ACP bridge) runs: app-server `skills/extraRoots/set`, which mounts installed Apps'
 * skills, is there from 0.136.0 on (absent in 0.135.0's app-server protocol). One path for every codex: an older one
 * is told to upgrade, not given its skills another way.
 */
export const CODEX_ACP_MINIMUM_VERSION = '0.136.0' as const;

/**
 * 会话页 TUI 腿(app-server)的最低 codex 版本 —— 由 #6294 的「TUI 建 thread、咕咕认领」决定。
 * 认领要两件事,各有自己的起始版本(#6341,mac1 真机 + stdio JSON-RPC 逐版读数):
 *   · `thread/section/move` 能把**尚未落盘**的 thread 写盘 —— 0.149.0 起;更早报 `-32600 thread not found`。
 *   · `thread/read` 返回 thread 自己的 `model` —— 0.153.0 起;更早为 null,认领按 fail-loud 拒绝继续。
 * 方法本身各版本都有(不存在的 threadId 在所有版本上同样报 thread not found)⇒ 能力只能按版本判。
 */
export const CODEX_TUI_ADOPT_MINIMUM_VERSION = '0.153.0' as const;
import {
  agentHomeSegments,
  type CapabilityPackage,
  extensionSkillFolderName,
  type GeneratedSymlink,
  type HarnessSessionSurface,
  type NativeHome,
  resolveSessionCredentialLifecycle,
  type SessionBundleDescriptor,
  type SessionCapabilityBundle,
  type SessionMaterialization,
  type SessionMaterializationContext,
  type SessionMcpServer,
  type SessionPromptBlocks,
  type TomlOverlay,
} from '@gugu/session-core/agents/plugins';
export const CODEX_GUGU_PACKAGE_ID = 'gugu-product-codex';
export const CODEX_GUGU_PLUGIN_ID = 'gugu-product';
export const CODEX_GUGU_PACKAGE_VERSION = '1.0.0';

const pluginManifest = {
  name: CODEX_GUGU_PLUGIN_ID,
  version: CODEX_GUGU_PACKAGE_VERSION,
  description: 'Gugu product capabilities and their audit manifest.',
  mcpServers: './.mcp.json',
};

const pluginMcpConfig = {
  mcpServers: {
    gugu: {
      url: '${GUGU_SESSION_MCP_URL_GUGU}',
      bearer_token_env_var: 'GUGU_SESSION_MCP_BEARER_GUGU',
    },
  },
};

const capabilityAudit = {
  schemaVersion: 1,
  adapterId: 'codex',
  surfaces: ['acp', 'app-server'],
  units: ['mcp', 'env', 'model', 'autonomy', 'promptBlocks', 'packages'],
  dynamicReferences: ['mcp.url', 'mcp.authorizationEnv', 'env', 'model', 'autonomy'],
  verifiedCodexCli: ['0.144.3', '0.147.0'],
};

export const CODEX_GUGU_CAPABILITY_PACKAGE: CapabilityPackage = {
  id: CODEX_GUGU_PACKAGE_ID,
  version: CODEX_GUGU_PACKAGE_VERSION,
  artifacts: [
    {
      path: '.codex-plugin/plugin.json',
      content: `${JSON.stringify(pluginManifest, null, 2)}\n`,
      mode: 0o644,
    },
    {
      path: 'gugu-capabilities.json',
      content: `${JSON.stringify(capabilityAudit, null, 2)}\n`,
      mode: 0o644,
    },
    {
      path: '.mcp.json',
      content: `${JSON.stringify(pluginMcpConfig, null, 2)}\n`,
      mode: 0o644,
    },
  ],
};

export const CODEX_NATIVE_HOME = {
  envVar: 'CODEX_HOME',
  userPath: '.codex',
  evidence: 'openai/codex codex-rs find_codex_home:CODEX_HOME,否则 ~/.codex',
} as const satisfies NativeHome;

export const codexSessionBundleDescriptor = {
  // 运行时注入(#4834 §4 owner 拍板)。托管那份 `CODEX_HOME` 从来没被递给过子进程 ——
  // 当年的 `configRoot.injectEnv` 就是 false(那一格已删),materialize 把用户真实 `CODEX_HOME` 原样透传;
  // 信任真正生效的是 argv 上的按次信任 `-c projects={ "<cwd>" = { trust_level = "trusted" } }`(见 codexProjectTrustArgs,单测钉着)。
  // ⇒ 那份副本**没有任何读者**,只是每个 tier 白烧 8.8 GB(2026-09-03 owner MBP 实测)。
  injectionMode: 'runtime',
  nativeHome: CODEX_NATIVE_HOME,
  platform: harnessPlatform,
  // ❌ `CODEX_ACCESS_TOKEN`:凭据的出处是咕咕给这一家的独立配置根,同名 export 会让「面板上的账号」与「实际在用的账号」分家且不报错。
  // ❌ 这里也没有 `GUGU_CODEX_BIN`(#5702):咕咕起适配器时自己填(./index.ts),透传就是让 shell 顶掉面板上的选择。
  shellEnv: { passThrough: ['CODEX_HOME', 'GUGU_CODEX_ACP_TEST_AUDIT_PATH'], denied: ['CODEX_ACCESS_TOKEN'] },
  credentialLifecycle: {
    'acp': {
      delivery: 'credential-proxy',
      originalProcessRefresh: 'supported',
      recovery: 'reopen',
      inferenceOwner: 'app-server-process-thread',
      reopenEntry: 'host-session-reload',
      sourceChangeSession: 'preserve',
    },
    'app-server': {
      delivery: 'credential-proxy',
      originalProcessRefresh: 'supported',
      recovery: 'reopen',
      inferenceOwner: 'app-server-process-thread',
      reopenEntry: 'host-session-reload',
      sourceChangeSession: 'preserve',
    },
  },
  /**
   * spec `mcp-session-toggle` —— codex 的会话级关闭方言。
   *
   * `config-content-enabled`:逐台 `mcp_servers.<键>.enabled = false`,
   * 经 ACP 薄桥与 app-server thread `config` 两个 native consumer 送出去。
   *
   * 每条会话都运行在自己的 adapter 进程里，因此 spawn 时生成的关闭配置不会被其它会话复用。
   */
  mcpToggle: { dialect: 'config-content-enabled' },
  /**
   * 关自更新(#6186):codex 没有 env 开关,只有配置键 `check_for_update_on_startup`,会话级载体是 `-c`。
   * 更新检查只在 TUI crate 里 ⇒ 只有终端腿(`--remote` 可见 TUI 与退回的直起 PTY)要带;app-server
   * 与 ACP 薄桥不查更新。不关时 TUI 首屏是「Update now / Skip」菜单,吞掉首批按键,选了就去改全局安装。
   * ⚠️ 宿主一律把它追加在命令**尾部**(0.155.0 实测):`resume`/`fork` 子命令自己另带 `-c` 时,放在子命令
   *    前面的这一格不起作用,启动更新菜单照弹。原因没核出来,不是「根级被丢掉」:codex 源码里子命令先接上
   *    自己的 `-c`,再把根级的插到最前面,同一个键冲突时子命令的赢(rust-v0.155.0 / rust-v0.156.1
   *    `codex-rs/cli/src/main.rs` finalize_resume_interactive、`codex-rs/utils/cli/src/config_override.rs:42-45`)。
   */
  selfUpdate: {
    kind: 'session-argv',
    args: ['-c', 'check_for_update_on_startup=false'],
    evidence:
      'openai/codex@f0a1b8f0849d (rust-v0.155.0) codex-rs/tui/src/updates.rs:28/152 两个入口都先判'
      + ' `!config.check_for_update_on_startup`;更新动作是 npm/brew 全局升级。取证 2026-09-23',
  },
  surfaces: ['acp', 'app-server'],
  /**
   * 终端腿的中断键:单击 Esc。官方 CLI 参考的快捷键表没写它,出处只能是源码:
   * `codex-rs/tui/src/keymap.rs` 默认键表 `chat.interrupt_turn: default_bindings![plain(KeyCode::Esc)]`,
   * 状态行也画着「Working (0s • esc to interrupt)」(`status_indicator_widget.rs`)。
   * ⚠️ 不是 Ctrl+C:参考页「Interactive shortcuts」写明 Ctrl+C = 关闭会话。ACP 腿的暂停仍是 protocol-cancel。
   */
  sessionTuiInterrupt: {
    sequence: '\u001b',
    evidence:
      'openai/codex@508a006d7aaa codex-rs/tui/src/keymap.rs:1575「interrupt_turn: default_bindings![plain(KeyCode::Esc)]」;'
      + ' 同仓 codex-rs/tui/src/status_indicator_widget.rs:104「interrupt_binding: Some(key_hint::plain(KeyCode::Esc))」;'
      + ' https://developers.openai.com/codex/cli/reference「Interactive shortcuts」Ctrl+C = 关闭会话;取证 2026-09-15',
  },
  /**
   * 终端腿的 `request_user_input` 选择器能从咕咕的提问卡回答(#7035):Esc 打断这一轮(记录里这条工具调用的输出是
   * 「aborted by user」),再把回答当消息发过去。⚠️ 有人在终端里打开了备注框时,第一下 Esc 只关备注框
   * (`request_user_input/mod.rs:1214`)⇒ 宿主等不到结果、报错并放回可答,再答一次就是再按一下。
   */
  sessionTuiQuestionAnswer: {
    cancel: '\u001b',
    settleMs: 20,
    maxWaitMs: 2000,
    evidence:
      'openai/codex@cd85a26cae00 codex-rs/tui/src/bottom_pane/request_user_input/mod.rs:645(Esc = interrupt_key)、:1214(备注框开着先关备注);'
      + ' 选择器底栏「esc to interrupt」(同目录 snapshots);Esc 后再发消息 agent 照答:'
      + ' 实测 Codex 0.153.4,7/7;取证 2026-10-09',
  },
  runtimeCompatibility: {
    'acp': {
      kind: 'semver-supported-floor',
      supportedFloor: CODEX_ACP_MINIMUM_VERSION,
      versionArgs: ['--version'],
    },
    'app-server': {
      kind: 'semver-supported-floor',
      supportedFloor: CODEX_TUI_ADOPT_MINIMUM_VERSION,
      versionArgs: ['--version'],
    },
  },
  sessionpage: {
    // ACP 腿由产品 R9 读数升档：宿主在 inbox admission 后释放 work tick，
    // 让 codex app-server 桥在同一轮的下一个工具边界消费 steer。
    // Spex data evidence: e11cab894fdcfa229b695b2bace2054d2cf533f7a182deab1f2d4418f439f24e。
    'acp': {
      identity: 'addressable',
      messageTransport: 'router',
      injection: {
        timing: 'next-tool-call',
        evidence:
          'openai/codex@78ad6e6bfd1d codex-rs/app-server/README.md:976 (rust-v0.144.3): `turn/steer` appends user input to the '
          + 'active regular turn, the call the app-server ACP bridge makes; product ACP R9 reading '
          + '(Spex data evidence e11cab894fdcfa229b695b2bace2054d2cf533f7a182deab1f2d4418f439f24e)',
      },
    },
    // app-server 腿(detachedInference):turn/steer 端到端 6/6 同轮、0/6 回退(2026-08-29,
    // 车道 3c297fc1;协议级同轮证据 = steer.result.turnId 与该轮唯一 turn/started/completed 相同)。
    'tui': {
      identity: 'addressable',
      messageTransport: 'router',
      injection: {
        timing: 'next-tool-call',
        evidence: 'openai/codex@78ad6e6bfd1d codex-rs/app-server/README.md:976(rust-v0.144.3:turn/steer 把输入并进进行中的那一轮);'
          + 'codex/TUI F1R5 【产品】读数(2026-08-31)——聊天页建 agent(surface=tui)→app-server WS-over-unix turn/steer,暗号 A=11:48:10.945Z 于 wait yield 边界(function_call_output 11:48:25.724 后 9ms)进模型,逐字 ACK b8ef1c7a 首轮内、rollout task_started/complete=2/2 零新轮,B=task_complete 11:49:33.434,维度4 running→idle 双周期在案,PRE/POST 阳控双过。装置面另有 turn/steer 6/6 同轮、0/6 回退(Codex 0.144.3,2026-08-29)。',
      },
      // 可见 TUI(`codex --remote … resume <tid>`)读到同一次 read 里的「正文 + 回车」时,拿回车结算
      // 的是还没收下正文的 composer:**整条提交消失,屏幕上不留任何痕迹,也不报错**(#4525)。
      terminalInput: {
        submitSeparationMs: 25,
        evidence: 'https://github.com/nmhjklnm/gugu/issues/4525',
        measurement:
          '2026-08-31,Codex 0.147.0,mac1。装置里没有任何 gugu 代码:python pty.fork() 起 '
          + '`codex --remote unix://<sock> resume <tid>`,对面是同一套 `codex app-server --listen`。'
          + '在一轮 turn 在飞时连发十条单字符消息,唯一自变量是「字符与回车之间的间隔」,一次跑出整条曲线:'
          + '0/2/5/10ms 全丢,15/20/30/40/60/100ms 全到 ⇒ 阈值落在 10–15ms 之间,且与负载无关'
          + '(数到 40 与数到 500 两种输出压力各测一次,40ms 间隔均 10/10 到)。'
          + '25 = 在首个通过值 15ms 之上再留一倍余量,仍在人感知不到的范围内。'
          + '重测:同样扫 keyGap 曲线;判据 e2e/agent/terminal-busy-input-4525.spec.ts(#6270 已删) 里,'
          + '把这一格删掉即应重新变红。',
      },
    },
  },
  units: {
    // ⚠️ 这一栏只声明得下**一个**通道,而实际是按 surface 分两条(见 materialize()):
    //   · app-server        → thread/start|resume|fork `config` map (same dotted keys as `-c`)
    //   · acp         → ACP 协议自己的 `session/new`(acp-session)
    // 所以填 process-config 是**取其一**,不是全部实情。❌ 不是 'plugin-manifest':插件文件装不下
    // `listen(0)` 分配的运行时端口,而 `${VAR}` 在插件 `.mcp.json` 里不被替换 —— 实测见 materialize()。
    // 要让契约不再半真,得让 UnitDelivery 支持 per-surface 声明;那会动到共享类型与所有 adapter 的
    // 元判据,单开一笔做。在那之前,per-surface 的覆盖由 adapter 自己的判据钉住
    //(「每个 surface 的 gugu server 有且仅有一条活通道」)。
    mcp: { kind: 'native', channel: 'process-config' },
    env: { kind: 'native', channel: 'child-process' },
    model: { kind: 'native', channel: 'process-config' },
    autonomy: { kind: 'native', channel: 'process-config' },
    promptBlocks: { kind: 'native', channel: 'developer-instructions' },
  },
  extension: {
    kind: 'declarative-bundle',
    format: 'codex',
    // Only the skills are laid out, as a skill root codex registers at runtime (extensionSkillRoot); a synthetic home
    // would break its sign-in (#②) and the person's own home is not gugu's — so mcp / hooks stay off this path.
    activation: 'skill-roots',
    carries: { mcp: 'none', skills: 'manifest', hooks: 'none' },
  },
  // 只写咕咕**真接通了**的维度;没写的落回 BASE_SESSION_COEXISTENCE(= 尚未接通)。
  coexistence: {
    // 两条腿都通,而且是同一条实现:咕咕发 ACP 协议的 `session/cancel`(咕咕侧的 cancelled turn
    // 状态机见 session-core/src/acp/models/turns/turn.ts),codex 桥的 handleAcpNotification 接住它,
    // 转成 codex 的 `turn/interrupt`(apps/desktop/electron/runtime/codex-app-server-acp.mjs)。
    // ⚠️ 这是**暂停**不是停止:进程活着、会话还在、能接着说。
    pause: { kind: 'native', channel: 'protocol-cancel' },
    // ACP 腿的 session 状态机把「本轮在飞」算进了咕咕自己的会话状态词汇:
    // session-runtime/src/acp-agents/machine/machine.ts 的 projectSessionState 产出
    // isGenerating / canCancel / backgroundAgentCount。
    observability: { kind: 'native', channel: 'acp-update' },
    // 判据是**往返**(见 `tui-coexistence.ts:172`:带选项的问题 -> 界面 -> 用户选 -> 答案回到
    // agent),不是「收得到一个"它在等人"的通知」。桥现在走的就是这条:codex 的
    // `item/tool/requestUserInput` -> ACP `session/request_permission` -> `cell.ts` 的待决请求
    // -> permission-band -> `resolvePermission` 按 id 回填 -> 桥把人选的 label 回给 codex。
    // 与 qoder/claude 等同通道同形状:`permission-ask` 本来就只表达**带选项**的一问一答,
    // 自由文本/多选/密文三种形状全生态都在这条通道之外(见下面的形状对照),不是 codex 独有的欠。
    askUser: { kind: 'native', channel: 'permission-ask' },
    // ❌ 这里**没有** todo —— 别照「含 acp 就该有」的通例往里加。codex 两条腿在
    // 生产里都落到咕咕自建的桥 `apps/desktop/electron/runtime/codex-app-server-acp.mjs`:
    // index.ts 的 `acp.bridge` 声明它是 app-runtime 桥,宿主把入口随 `AgentRunContext.acpAdapterEntry`
    // 递给 buildSpawn(#6394;上游 codex-acp 的回退已删)。而这座桥:
    //  · askUser **本 PR 已接通**(见下面「askUser 这一格的实情」)。在此之前它的病不是
    //    「桥答不了」,而是桥**全都答了、而且是替用户答的** —— 那些答案从没到过人手里。
    //  · 桥只把 `item/plan/delta` 映射成 `agent_thought_chunk`,plan 以思考文本落地、
    //    拿不到结构化 `{ kind: 'plan', entries }` → todo 今天不成立(基类注释里
    //    「原生有而 ACP 桥不发」说的就是这一例)。
    //    ⚠️ **但「结构性做不到」是错的标签,别继承** —— 这一格是**能做的,只是没做**,
    //    差的东西已经查清了,见下面「todo 这一格差什么」。
    // 两条都落回基类的 unverified = 咕咕没接;❌ 不许据此推断 codex 厂商做不到。
    // ⚠️ 上游**两条都有**,这一波逐条取到了坐标,记在这里免得下一个人再当「厂商也没有」:
    //  · 问用户:app-server 协议有整整十条**服务端→客户端请求**(每条都声明了 response,
    //    即 codex 发出后阻塞等答案),`codex-rs/app-server-protocol/src/protocol/common.rs:1663`
    //    起的 `server_request_definitions!`。与本维相关的是 `item/tool/requestUserInput`(:1680,
    //    「EXPERIMENTAL - Request input from the user for a tool call.」)与
    //    `item/commandExecution/requestApproval`(:1667)/`item/fileChange/requestApproval`(:1674)。
    //
    //    ### askUser 这一格的实情(2026-08-24 亲验,**上一版三条断言全错,已更正**)
    //
    //    上一版写:「桥只有 respond/notify、发不出带 id 的客户端请求 ⇒ 这些请求它一条都答不了,
    //    codex 会在那里阻塞」。三条逐条证伪:
    //     1. ❌「答不了」—— 桥**三条全都接了**:`codex-app-server-acp.mjs:847`(两条
    //        `requestApproval`)、`:851`(`item/permissions/requestApproval`)、
    //        `:862`(`item/tool/requestUserInput`)。
    //     2. ❌「发不出带 id 的请求」—— `appRequest()`(同文件 `:80`)第一行就是
    //        `const id = appNextId++`,挂 pending promise 等回包。它就是在发带 id 的请求。
    //     3. ❌「codex 会阻塞」—— 恰恰相反,`handleAppRequest` 在 `:933` 被**无条件**调用
    //        (`if (message.id !== undefined && message.method)`),没有任何开关、也不看
    //        auto-approve 档位。从来不会停在那里。
    //
    //    实际发生的是:
    //     · 两条 `requestApproval` -> 桥把 Codex 的决定交给 ACP `session/request_permission`,再原样回写;
    //     · `item/permissions/requestApproval` -> 桥把 turn/session 范围交给人选择,拒绝回空权限;
    //     · `item/tool/requestUserInput` -> **替用户挑答案**:拿
    //       `/\b(allow|approve|yes|continue|use|run)\b/i` 去匹配每个选项的 label+description,
    //       命中就选它,**一个都不命中就取 `options[0]`**,然后把 label 当作用户的回答发回去。
    //
    //    ⚠️ 前两条与 `autoApprove: { kind: 'supported' }` 的自治模型是自洽的(用户就是要它别问)。
    //    但第三条不同:上游给 `item/tool/requestUserInput` 的说明是「Request input from the user
    //    for a tool call」—— 那是**向人提问**,不是权限闸。而那个正则找的全是许可类词,
    //    一道内容型问题(「这三个方案选哪个」)上一个都不会命中,于是恒定落到 `options[0]`,
    //    一个与问题无关的任选项被当成用户的回答送了回去。全仓搜 `requestUserInput` 只有
    //    桥里这一处命中 —— **没有任何一条路径把这个问题呈给人看**。
    //
    //    ⇒ 所以这一格的准确说法是:**通到人的那一段没有接**(不是"往返不存在"),
    //    而缺口处现在填着一个会替用户表态的启发式。
    //
    //    ### 「要不要阻塞」不是产品决定 —— **协议里逐请求带着这个开关**
    //
    //    ⚠️ 上一版这里写「这属于产品决定,不该替 owner 定」。**那是查得不够。**
    //    wire 形状(上游 ts-rs 生成物,同一 sha,`schema/typescript/v2/`):
    //      `ToolRequestUserInputParams = { threadId, turnId, itemId,`
    //      `                               questions: ToolRequestUserInputQuestion[],`
    //      `                               isBlocking: boolean,`
    //      `                               autoResolutionMs: number|null }`  <- 后者已 @deprecated,
    //                                                       原文「Use `isBlocking` to decide whether
    //                                                       the request should block」
    //    ⇒ **codex 每一次都告诉客户端这一问该不该阻塞**,不需要咕咕定一条全局策略。
    //      而桥**把这个字段整个忽略了**:`isBlocking` 真假一律走同一条"自己编个答案"。
    //
    //    ### 「能不能渲染」才是真前提,答案是「只有一种形状能」
    //
    //    codex 能问的(`ToolRequestUserInputQuestion` / `...Answer`):
    //      `{ id, header, question, isOther: bool, isSecret: bool, options: Option[] | null }`
    //      `Answer = { answers: string[] }`   <- 数组,可多选
    //    咕咕现有的渲染面(`session-ui/.../chat-composer/permission-band.tsx:30-44`):
    //      `ComposerPermissionRequest = { requestId, title, options: ComposerPermissionOption[] }`
    //      `onResolve: (optionId: string) => void`   <- 只回**一个** optionId
    //    逐形状对照:
    //     · 单选(`options` 非空)      -> ✅ 能渲染。`acp-chat-panel.tsx:372` 取 `permissionQueue[0]`,
    //       是**队列、一次渲一个** => codex 一次问 N 个的形状天然串行解决,不必另设计。
    //     · 自由文本(`options: null`) -> ❌ permission-band 里**没有任何输入框**。
    //     · 多选(`answers: string[]`) -> ❌ `onResolve` 只回一个 optionId。
    //     · 密文(`isSecret`)          -> ❌ 同上,另见下面的隐患。
    //     · 另有两处小的:codex 给 `header` + `question` 两段文案,咕咕只有一个 `title`;
    //       `isOther` 允许用户答选项之外的东西,现有面板给不了。
    //
    //    ⇒ 范围线是它自己落下来的,不需要谁拍板。**三条都已落地(本 PR)**:
    //      · `isBlocking && options 非空 && 非密文` —— 真的问人。桥补了两样原本缺的东西:
    //        一条「自己发问、等回答」的出站通道(此前对 host 只有 respond/notify),
    //        以及 stdin 分派里**响应**那一支(此前「有 id 无 method」的消息被整类丢弃,
    //        所以桥在物理上收不到人的回答 —— 这才是那个启发式的来历)。
    //      · 其余三种形状(自由文本 / 多选 / 密文)—— 要先补 UI,那是另一件活,没混进来;
    //        它们如实回 `answers: []`。
    //      · `isBlocking: false` —— 同样如实回空。用 `options[0]` 冒充用户表态踩的是本仓
    //        ❌fake / fail-loud 铁律,没有任何自治档位能为它辩护。
    //
    //    ⚠️ 「空答案会不会把 codex 卡住」这条原本记成阻塞项(「没实测过,而 d15 不跑 e2e」),
    //    已由上游源码结清,不需要真跑:回包被
    //    `serde_json::to_string(&response)` 直接当 tool output 交给模型,没有校验、没有错误
    //    分支(`core/src/tools/handlers/request_user_input.rs`);上游自己的测试就用
    //    `ToolRequestUserInputResponse { answers: HashMap::new() }`
    //    (`tui/src/app/app_server_requests.rs:1002`);参考客户端 TUI 的真实路径也是
    //    **排队等人、从不代答**(`:145` 入队 / `:391` 出队)。
    //    ⚠️ 另更正一处:`isBlocking` 是逐请求带在线上没错,但上游是**按协作模式派生**的
    //    (`is_blocking: mode == ModeKind::Plan`),所以真正问到人主要发生在 plan 模式。
    //    ❌ 别在桥里加一条全局开关去覆盖它。
    //
    //    ⚠️ **给实现者的隐患,现在还没发作**:`session-runtime/.../session/cell.ts:328` 的
    //    `rawLog.record({ kind: 'permission_request', request: params })` 把整个请求原样落日志。
    //    今天无害(记的是问题不是答案),但一旦接上 `isSecret` 的自由文本,
    //    用户敲进去的密码/token 就会经这条路进日志。**接密文那一支之前必须先掐掉这条记录。**
    //  · plan:`turn/plan/updated`(common.rs:1851)是**通知**。
    //    ⚠️ **上一版这里写「桥收得到却把它揉进了 thought 文本」,那是错的,已更正**:
    //    桥里 `turn/plan/updated` **一次都没出现** —— 全文件搜 `plan` 只有一处命中,
    //    就是 `codex-app-server-acp.mjs:737` 的 `item/plan/delta`。两个是不同的方法,
    //    上一版把它们说成了同一件事。⇒ 不是「收到了又丢掉」,是**从来没接**。
    //    这个区别是有后果的:没接 ⇒ 接上去是**纯增量**,不需要先拆掉什么。
    //    `item/plan/delta`(:1864)自带「EXPERIMENTAL … 不要假设拼接等于成品」的告诫 ——
    //    而现在那条 thought 文本路径把拼接结果直接给用户看了,正落在这句告诫里。
    //    ⚠️ `TodoList` 不在 app-server 协议里,它只在 `codex exec --json` 那条 JSONL 面上
    //    (`codex-rs/exec/src/exec_events.rs:130`,且 item 形状是 `{text, completed:bool}`,
    //    与上面的三态不同)—— 两个面别混着引。
    //    坐标基准 sha:openai/codex@a25e986323931ec54909b0cd936b612f30c8ce46。
    //
    //    ### todo 这一格差什么(2026-08-24 查完,**只差一个 UI 决定,不差事实**)
    //
    //    wire 形状取自上游**自己生成**的 TS schema(ts-rs 产物,`schema/typescript/v2/`,同一 sha),
    //    不是从 rust 结构体反推的:
    //      `TurnPlanUpdatedNotification = { threadId, turnId, explanation: string|null,
    //                                       plan: Array<TurnPlanStep> }`
    //      `TurnPlanStep       = { step: string, status: TurnPlanStepStatus }`
    //      `TurnPlanStepStatus = "pending" | "inProgress" | "completed"`
    //    咕咕这边要的是 `planEntrySchema`(`session-core/src/acp/models/plan.ts`):
    //      `{ content: string, status: 'pending'|'in_progress'|'completed',
    //         priority: 'high'|'medium'|'low' }`
    //    映射三条,逐条都是确定的:
    //      · `step` -> `content`,直通。
    //      · `status` 三态一一对应,但 **`inProgress` -> `in_progress` 是真转换、不是恒等** ——
    //        照抄会被 `planEntryStatusSchema` 打回,整条 plan 更新被丢掉。
    //      · `priority` codex **没有这个概念**,而 ACP 这边必填。填常量**不算编造** ——
    //        Kimi Code 这个真实在跑的 ACP agent 就是这么干的,而且写进了文档注释:
    //        `MoonshotAI/kimi-code@243f348329fc15e857dcaa0ae3cfe514729bd7a6`
    //        `packages/acp-server/src/events-map.ts:393` 原文「`priority` defaults to `'medium'`」,
    //        :403-407 实装 `priority: 'medium'`。它自己的 todo 模型同样没有优先级。
    //        ⇒ 这是 ACP 生态对「源模型没有优先级」的既有惯例,不是咕咕自己发明一个排序。
    //      · `explanation` 在 ACP 的 plan entry 里**没有落点**,会丢。要不要另找地方是单独一问。
    //
    //    ⇒ 事实层面没有缺口了。**没有当场接**的两条理由,都不是"查不到":
    //      1. 桥的回放路径**没有测试**(整体是有的,见上;`item/plan/delta` 这条没有),
    //         而它是最常用那一家的运行时热路径。
    //      2. **它会改渲染**:plan 会从"思考文本"变成 plan 组件,而 `item/plan/delta` 那条
    //         thought 路径还在 —— 同一份 plan 会不会**双显**,是个 UI 形态问题。
    //         行为表批准 != UI 形态批准,这一步该有真渲染对照,不该由这一刀顺手定。
    //    ❌ 别把上面这两条读成"所以永远别做"。要做的话:先给桥补回放测试,再在能出截图的机器上
    //       决定双显那一问,两件都齐了这一格就能翻成 native。
    // codexMcpAdapter() 直接解析用户自己的 `~/.codex/config.toml` 的 `mcp_servers`
    // (session-core/src/agents/plugins/helpers/mcp.ts 的 createMcpAdapter().readServers),
    // 不用启引擎 → config-scan。读的是用户那份表,不是咕咕注进去的那条。
    // ❌ 不含 hooks:各家 readHooks 只认 GUGU_HOOK_MARKER,报的是「咕咕自己装没装」,不是用户的 hooks。
    introspection: { kind: 'native', channel: 'config-scan' },
    // 咕咕自己会扫 `~/.codex/sessions` 下的 .jsonl 并解析成轮次:spec 在 core 的
    // `transcriptSources/codex.ts`(scanRoots + readFrame),通用层 transcriptInventory.ts 执行。
    // 全仓只有 claude-code 与 codex 两家进了这条路;
    // 声明⇔接通由 tests/unit/core/local/transcriptSources.test.ts 双向对账。
    history: { kind: 'native', channel: 'jsonl' },
    // 咕咕经 `AgentPluginHost.readMemoryFiles`(session-core/.../plugin-host.ts:270)读得到 codex
    // 自己会去读的 AGENTS.md —— 具体登记在 `impl/codex/index.ts` 的 `capabilities.memory`。
    // ⚠️ 这一维**与那座桥无关**:它读的是磁盘上的文件,不经 ACP,所以上面 askUser / todo 落空的
    // 理由在这里不适用。厂商出处:https://developers.openai.com/codex/guides/agents-md
    // ⚠️ 两处必须同通道。
    memory: { kind: 'native', channel: 'agents-md' },
  },
} satisfies SessionBundleDescriptor;

/** Static credential capability consumed by both Codex delivery consumers. */
export function codexCredentialLifecycle(surface: HarnessSessionSurface) {
  const lifecycle = resolveSessionCredentialLifecycle(codexSessionBundleDescriptor, surface);
  if (!lifecycle) throw new Error(`Codex credential lifecycle is undeclared for surface '${surface}'`);
  return lifecycle;
}

function packageEntry(bundle: SessionCapabilityBundle): CapabilityPackage {
  const entry = bundle.packages.find(
    (candidate) =>
      candidate.id === CODEX_GUGU_PACKAGE_ID &&
      candidate.version === CODEX_GUGU_PACKAGE_VERSION
  );
  if (!entry) {
    throw new Error(
      `Codex session adapter requires capability package '${CODEX_GUGU_PACKAGE_ID}@${CODEX_GUGU_PACKAGE_VERSION}'`
    );
  }
  return entry;
}

/**
 * 这道闸守的是**咕咕自己那几台**:名字必须写在带版本号的静态包里,漏一台就抛。
 *
 * ⚠️ `owner: 'integration'` 的不在这道闸里 —— 用户在资源库里连上哪几家是**随连随变**的,
 * 塞不进一份静态清单(product spec);它们由咕咕的转发口投递,是按构造成立的。
 * ❌ 别把这道闸改成「对着 bundle 自己判」:那样它恒为真,等于把守卫删了还留着个壳。
 */
function assertPackageDeclaresMcpServers(bundle: SessionCapabilityBundle): void {
  const declared = new Set(Object.keys(pluginMcpConfig.mcpServers));
  const missing = bundle.mcpServers
    .filter((server) => server.owner !== 'user' && server.owner !== 'integration')
    .map(({ name }) => name)
    .filter((name) => !declared.has(name));
  if (missing.length > 0) {
    throw new Error(
      `Codex capability package '${CODEX_GUGU_PLUGIN_ID}@${CODEX_GUGU_PACKAGE_VERSION}' does not declare MCP server(s): ${missing.join(', ')}. Add them to the versioned static package before routing the session.`
    );
  }
}

function authorization(
  server: Exclude<SessionMcpServer, { transport: 'stdio' }>,
  source: Readonly<Record<string, string | undefined>>
): string | undefined {
  return sessionMcpAuthorization(server, source, 'Codex')?.replace(/^Bearer\s+/i, '');
}

function mcpSuffix(name: string): string {
  return mcpConfigKey(name).toUpperCase();
}

/**
 * MCP server 名 → codex 的**配置键**。
 *
 * 这个键不只是配置里的一行字:codex 用它当 server 的**标识**。宿主执行动态工具时要发
 * `mcpServer/tool/call { server: <键> }`,键对不上就是
 * `{"code":-32603,"message":"unknown MCP server '<名>'"}`(2026-08-20 实测原文)。
 *
 * ⚠️ 别拿工具名去推这个键:codex 暴露给模型的工具名是规范化过的,而 server 标识是**原始配置键**。
 * 两者不是一回事 —— 我按工具名反推过一次,得到的正是上面那条 -32603。改名成 `gugu` 后两者恰好
 * 同形(名字里没有需要归一的字符),但那是巧合,❌ 不能当成规则依赖。
 *
 * 薄适配器(`codex-app-server-acp.mjs` 的 `mcpConfig()`)一直用同一个消毒函数,
 * 这里与它对齐,让同一台 server 在两条 transport 上同名。
 */
function mcpConfigKey(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, '_');
}

function renderPromptBlocks(blocks: SessionPromptBlocks): string {
  return (blocks.platform ?? '') + (blocks.identity ?? '');
}

function deliveredPromptBlocks(blocks: SessionPromptBlocks): (keyof SessionPromptBlocks)[] {
  return (['platform', 'identity'] as const).filter((key) => Boolean(blocks[key]));
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** `-c key=value` 里的字符串 value 始终按 TOML 字面量传递。 */
function configValueFor(
  _surface: SessionMaterializationContext['surface'],
  value: string
): string {
  return tomlString(value);
}

function modelArgs(
  surface: SessionMaterializationContext['surface'],
  bundle: SessionCapabilityBundle,
  env: Record<string, string>
): string[] {
  const model = bundle.model;
  if (!model) return [];
  if (model.dialect !== 'codex-config-flags') {
    throw new Error(`Codex session adapter cannot materialize model dialect '${model.dialect}'`);
  }
  const args: string[] = [];
  const configValue = (value: string) => configValueFor(surface, value);
  if (model.model?.trim()) args.push('-c', `model=${configValue(model.model.trim())}`);
  if (model.reasoningEffort?.trim()) {
    args.push('-c', `model_reasoning_effort=${configValue(model.reasoningEffort.trim())}`);
  }
  // acp has no argv consumer; its bridge reads the session config env below.
  // Keep app-server argv unchanged and let the native thread/start config map
  // carry the official `model_reasoning_summary` key.
  if (model.serviceTier?.trim()) {
    args.push('-c', `service_tier=${configValue(model.serviceTier.trim())}`);
  }
  if (model.contextWindow && model.contextWindow > 0) {
    args.push('-c', `model_context_window=${model.contextWindow}`);
  }
  if (model.platformProvider) {
    const provider = 'gugu_platform';
    args.push(...codexPlatformProviderConfigArgs({
      providerId: provider,
      providerName: 'Gugu 平台额度',
      baseUrl: model.platformProvider.baseUrl,
      // #6921 令牌能调 codex 写死的出图模型 ⇒ 打开它自己的出图工具(ACP 腿同一个函数,见 index.ts)。
      ...(model.platformCallableRoutes ? { callableRoutes: model.platformCallableRoutes } : {}),
      ...(model.model ? { model: model.model } : {}),
    }));
    env.OPENAI_API_KEY = model.platformProvider.apiKey;
    // 编程面 app-server 的启动方据此写 codex 的 model catalog。ACP 腿这份事实只由 `buildSpawn`
    // 交给咕咕的桥(它拿得到平台载荷)—— 一面一个写者。
    if (surface === 'app-server' && model.model?.trim()) {
      env[GUGU_PLATFORM_MODELS_ENV] = codexPlatformModelFacts({
        model: model.model,
        contextWindow: model.contextWindow,
        reasoningEfforts: model.reasoningEfforts,
        models: model.platformModels,
      });
    }
  }
  return args;
}

function codexPermissionMode(bundle: SessionCapabilityBundle): CodexPermissionMode {
  const explicit = bundle.autonomy?.permissionMode;
  if (explicit === 'read-only' || explicit === 'edit' || explicit === 'full-access') {
    return explicit;
  }
  // `plan` is intentionally not interpreted here; its unsupported-provider fallback remains #5623's
  // responsibility before this Codex materializer is reached.
  // Legacy boolean-only bundles preserve the historical false → edit behavior.
  return bundle.autonomy?.mode === 'full-access' ? 'full-access' : 'edit';
}

function codexPermissionProfile(mode: CodexPermissionMode): string {
  const profile = CODEX_PERMISSION_MODES[mode]?.id;
  if (!profile) throw new Error(`Codex permission mode '${mode}' has no declared native profile`);
  return profile;
}

function codexThreadPermission(bundle: SessionCapabilityBundle): {
  profile: string;
  threadStart: Readonly<Record<string, string>>;
} | undefined {
  if (!bundle.autonomy) return undefined;
  const mode = codexPermissionMode(bundle);
  const autonomy = CODEX_AUTONOMY_BY_MODE[mode];
  return {
    profile: codexPermissionProfile(mode),
    // Codex applies these fields to the thread, not the app-server process. Keeping them
    // here also makes the boundary explicit for the ACP adapter's session metadata.
    threadStart: {
      approvalPolicy: autonomy.approvalPolicy,
      sandbox: autonomy.sandboxMode,
    },
  };
}

/**
 * @@@codex-builtin-permission-profiles — 用 codex 自带的档,❌ 不自造。
 *
 * 冒号前缀的是 Codex 内置 profile,由 `permissionProfile/list` 发现并由
 * `thread/settings/update.permissions` 消费。它们与 `thread/start` 的
 * `approvalPolicy` / `sandbox` 一起构成同一档位的 native 载荷；这些值不能再放进进程 argv,
 * 因为 Codex 会让 argv 的策略遮住线程设置。
 */
function report(
  ctx: SessionMaterializationContext,
  bundle: SessionCapabilityBundle
): SessionMaterialization['report'] {
  const loaded = () => ({ status: 'loaded' as const });
  const absent = (unit: string) => ({
    status: 'degraded' as const,
    reason: { code: 'unverified' as const, reason: `No ${unit} was declared.` },
  });
  return {
    adapterId: 'codex',
    surface: ctx.surface,
    units: {
      mcp: loaded(),
      env: loaded(),
      model: bundle.model ? loaded() : absent('model'),
      autonomy: bundle.autonomy ? loaded() : absent('autonomy'),
      promptBlocks: renderPromptBlocks(bundle.promptBlocks) ? loaded() : absent('prompt blocks'),
      packages: loaded(),
    },
    discoveredCommands: [],
  };
}

/**
 * 会话自有 trust overlay 的**路径形状**,❌ 不是托管配置根 —— 本家 `injectionMode: 'runtime'`,
 * 不声明 `configRoot`,不复制用户那棵树。这里只是沿用同一套目录布局放一份 gugu 自己的 config.toml。
 */
const CODEX_OVERLAY_USER_PATH = '.codex';

function codexOwnedHome(bundle: SessionCapabilityBundle): string {
  const guguHome = bundle.env.GUGU_HOME?.trim();
  if (!guguHome) throw new Error('Codex session adapter requires bundle.env.GUGU_HOME');
  return join(guguHome, ...agentHomeSegments('codex', CODEX_OVERLAY_USER_PATH));
}

function trustOverlay(bundle: SessionCapabilityBundle, cwd: string): TomlOverlay {
  const configFile = join(codexOwnedHome(bundle), 'config.toml');
  return {
    sourcePath: configFile,
    path: configFile,
    conflict: 'gugu-owns',
    mode: 0o600,
    patch: { projects: { [cwd]: { trust_level: 'trusted' } } },
  };
}

/**
 * 这条会话的工作目录按次标成「受信任」—— 只在这个进程里生效。
 *
 * 不给的话,codex app-server 的 `thread/start` 碰到「没标过信任、权限又可写」的 cwd 会**自己写进
 * 用户的 `~/.codex/config.toml`**(codex-rs `thread_processor.rs` → `set_project_trust_level`,
 * rust-v0.153.4;判据 `config.active_project.trust_level.is_none()`)。咕咕的每一次模型目录探针都
 * 在一个新建的临时目录里开一条 thread,于是用户的配置里越积越多 `[projects."/tmp/gugu-model-probe-…"]`
 * (d22 实机 5 条,#6264)。按次给了,`trust_level` 就不是 none,codex 不再落盘。
 * 官方写法:`-c` 覆盖优先于用户 config.toml(learn.chatgpt.com/docs/config-file/config-basic)。
 */
export function codexProjectTrustArgs(cwd: string): string[] {
  // ⚠️ 必须是内联表写法,❌ 不能写成点路径 `projects."<cwd>".trust_level=…`:codex 把 `-c` 的键按 `.`
  // 裸切(codex-rs `config/src/overrides.rs` 的 `apply_toml_override`:`path.split('.')`,不认引号),
  // 于是那一格落成键名**带着引号**的 `"\"/w\""`,对不上任何目录 —— 等于没给;路径里一有 `.`
  // (`/root/.config/咕咕/task-home`)还会被再切碎。my-laptop 容器 codex 0.153.4 实测:点路径写法照样
  // 落盘,内联表写法不落。CLI 层与用户配置按表**深合并**(同文件 `merge_toml_values`),用户自己的
  // 其它 `projects` 条目不受影响。
  return ['-c', `projects={ ${tomlString(cwd)} = { trust_level = "trusted" } }`];
}

function trustArgs(cwd: string): string[] {
  return codexProjectTrustArgs(cwd);
}

/**
 * #7191 Codex 自带的两个浏览器插件(`browser` = 它桌面版的应用内浏览器,`chrome` = 人的 Chrome)。它们的 skill 写着
 * 「浏览器活之前必读、先于 standalone Playwright」,于是带着 `gugu-browser` 的会话里 agent 会先去走它们 —— 咕咕里没有那个
 * 应用内浏览器,它的 `getForUrl` 落到人的 Chrome 扩展上(10-15 实撞:10 次里 1 次连上了人的 Chrome、1 次在路上)。
 * 这条会话有自己的页签,就在这条会话里关掉这两个插件:进程级 `-c`,❌ 改人的 `~/.codex/config.toml`。
 * 键名不加引号:codex 的 `-c` 按 `.` 切路径,`plugins."browser@openai-bundled"` 会把引号当成名字的一部分、静默不生效
 * (codex 0.160 `codex plugin list -c …` 实测:加引号仍 enabled,不加 disabled)。
 */
const CODEX_OWN_BROWSER_PLUGINS = ['browser@openai-bundled', 'chrome@openai-bundled'] as const;

function ownBrowserPluginArgs(bundle: SessionCapabilityBundle): string[] {
  if (!bundle.mcpServers.some((server) => server.name === 'gugu-browser')) return [];
  return CODEX_OWN_BROWSER_PLUGINS.flatMap((plugin) => ['-c', `plugins.${plugin}.enabled=false`]);
}

/**
 * The `env` table a codex stdio server gets. codex does not expand `${VAR}` there (it is a static
 * table), so a reference written as `${REF}` reaches the program as that literal text — #6387: the
 * extension program got `ELECTRON_RUN_AS_NODE=${…}` and codex said "MCP startup incomplete".
 * Values are written as they are. The one place a secret must not go through here is the
 * app-server leg, whose table becomes `-c` argv; that leg hands secrets over with `env_vars`
 * instead (see `codexSecretEnvVars`).
 */
function codexStdioEnv(
  server: Extract<SessionMcpServer, { transport: 'stdio' }>,
  bundle: SessionCapabilityBundle
): Record<string, string> {
  if (!server.env) return {};
  return Object.fromEntries(
    Object.entries(server.env).map(([name, ref]) => [name, bundle.env[ref] ?? ''])
  );
}

/**
 * Names Codex itself or every program it starts reads from its own environment: a tool's secret
 * placed under one of these would change Codex, not hand the tool a value. `DEFAULT_ENV_VARS` of
 * codex `rmcp-client/src/utils.rs` plus the credential names of `config/src/mcp_types.rs`.
 */
const CODEX_OWN_ENV_NAMES = new Set([
  'HOME', 'LOGNAME', 'PATH', 'SHELL', 'USER', '__CF_USER_TEXT_ENCODING', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'TZ',
  'OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'CODEX_HOME',
]);

/**
 * #6387 review — a secret for a stdio tool on the app-server leg (a GitHub tool's token).
 *
 * Codex's own way to keep a secret out of its config: `mcp_servers.<name>.env_vars` names
 * variables the tool inherits from Codex's environment, under the same name (codex
 * `config/src/mcp_types.rs`, `McpServerEnvVar`). So the value goes into this one-session
 * app-server's environment under the name the tool reads, and only the name reaches argv.
 * A name Codex reads itself, or one another tool of this session wants with a different value,
 * cannot be shared: that fails loud instead of handing one of them the wrong value.
 */
function codexSecretEnvVars(
  server: Extract<SessionMcpServer, { transport: 'stdio' }>,
  bundle: SessionCapabilityBundle,
  env: Record<string, string>
): string[] {
  const names: string[] = [];
  for (const [name, ref] of Object.entries(server.env ?? {})) {
    const value = bundle.env[ref] ?? '';
    if (CODEX_OWN_ENV_NAMES.has(name.toUpperCase())) {
      throw new Error(`Codex MCP '${server.name}': its env '${name}' is a name Codex reads itself, so it cannot be handed over without changing Codex — rename it in the tool's settings`);
    }
    if (env[name] !== undefined && env[name] !== value) {
      throw new Error(`Codex MCP '${server.name}': env '${name}' is already set to a different value for this session (another tool uses the same name)`);
    }
    env[name] = value;
    names.push(name);
  }
  return names;
}

export function materializeCodexSessionBundle(
  ctx: SessionMaterializationContext,
  bundle: SessionCapabilityBundle
): SessionMaterialization {
  if (ctx.surface === 'tui') {
    throw new Error(`Codex session adapter does not support surface '${ctx.surface}'`);
  }
  const credentialLifecycle = codexCredentialLifecycle(ctx.surface);
  if (
    credentialLifecycle.delivery !== 'credential-proxy'
    || credentialLifecycle.recovery !== 'reopen'
  ) {
    throw new Error(`Codex credential lifecycle for '${ctx.surface}' does not match its native consumers`);
  }
  const trust = trustOverlay(bundle, ctx.cwd);
  //
  // 包仍然是权威:下面两行都是 fail-loud 闸 —— 会话里没带咕咕这一包、或想路由一个包里没声明的
  // MCP server,直接抛。❌ 但不再把包的文件铺到磁盘上:市场没人注册,铺出来就是一堆没人读的文件。
  packageEntry(bundle);
  assertPackageDeclaresMcpServers(bundle);

  const authorizationSourceKeys = new Set(
    bundle.mcpServers.flatMap((server) =>
      server.transport !== 'stdio' && server.authorizationEnv ? [server.authorizationEnv] : [])
  );
  const userCodexHome = bundle.env.CODEX_HOME?.trim();
  const env = ctx.surface === 'acp'
    ? (userCodexHome ? { CODEX_HOME: userCodexHome } : {})
    : Object.fromEntries(
        Object.entries(bundle.env).filter(
          (entry): entry is [string, string] =>
            entry[1] !== undefined &&
            !authorizationSourceKeys.has(entry[0])
        )
      );
  for (const server of bundle.mcpServers) {
    if (server.transport === 'stdio') {
      assertSessionMcpStdioEnv(server, bundle, 'Codex');
      for (const ref of Object.values(server.env ?? {})) {
        if (bundle.env[ref] !== undefined) env[ref] = bundle.env[ref] as string;
      }
      continue;
    }
    const suffix = mcpSuffix(server.name);
    env[`GUGU_SESSION_MCP_URL_${suffix}`] = server.url;
    const bearer = authorization(server, bundle.env);
    if (bearer) env[`GUGU_SESSION_MCP_BEARER_${suffix}`] = bearer;
  }
  // spec `mcp-session-toggle`:用户在 `/mcp` 里关掉的那几台。
  //
  // ACP 的薄桥仍需在 spawn env 里接收这份片段，再把它并进同一次 thread-open；
  // app-server session-TUI 则直接从 `threadConfig` 读取它。两条 surface 都不再把 MCP
  // 配置拼进 argv。归属现算(`bundle.mcpServers` = 咕咕这条会话自己那几台),❌ 不比名字常量。
  const guguOwned = new Set(bundle.mcpServers.map((server) => server.name));
  const toggleDirective = mcpToggleDirective(
    'config-content-enabled',
    (bundle.mcpDisabled ?? []).map((name) => ({
      name,
      enabled: false,
      owner: guguOwned.has(name) ? ('gugu' as const) : ('user' as const),
    }))
  );
  /**
   * #6387 acp: a stdio program (an extension's MCP program) does not go over ACP `session/new`.
   * gugu's Codex bridge turns that list into Codex's own config and only takes streamable HTTP there
   * (a stdio entry made every Codex chat session fail to open: "stdio MCP servers are no longer
   * supported"), and the ACP stdio shape can carry neither the working folder nor real env values —
   * this leg's process env holds only CODEX_HOME. The private config fragment below reaches the same
   * app-server config map the terminal leg writes (`threadConfig`), so it is written the same way.
   */
  const stdioServers = bundle.mcpServers.filter(
    (server): server is Extract<SessionMcpServer, { transport: 'stdio' }> => server.transport === 'stdio'
  );
  const stdioFragment = (server: Extract<SessionMcpServer, { transport: 'stdio' }>) => {
    assertSessionMcpStdioEnv(server, bundle, 'Codex');
    return {
      command: server.command,
      args: [...(server.args ?? [])],
      ...(server.cwd ? { cwd: server.cwd } : {}),
      ...(server.env ? { env: codexStdioEnv(server, bundle) } : {}),
    };
  };
  if (toggleDirective.kind === 'config-content' || (ctx.surface === 'acp' && stdioServers.length > 0)) {
    // Include Gugu-owned servers so ACP deduplication cannot discard enabled=false.
    const fragment: Record<string, Record<string, unknown>> = {};
    for (const server of bundle.mcpServers) {
      const key = mcpConfigKey(server.name);
      if (server.transport === 'stdio') {
        fragment[key] = stdioFragment(server);
        continue;
      }
      // Only the toggle needs the HTTP servers restated here; without it they ride session/new alone.
      if (toggleDirective.kind !== 'config-content') continue;
      const suffix = mcpSuffix(server.name);
      fragment[key] = {
        url: server.url,
        ...(env[`GUGU_SESSION_MCP_BEARER_${suffix}`] !== undefined
          ? { bearer_token_env_var: `GUGU_SESSION_MCP_BEARER_${suffix}` }
          : {}),
      };
    }
    if (toggleDirective.kind === 'config-content') {
      for (const name of toggleDirective.disabled) {
        fragment[mcpConfigKey(name)] = { ...(fragment[mcpConfigKey(name)] ?? {}), enabled: false };
      }
    }
    if (ctx.surface === 'acp') env[GUGU_CODEX_MCP_CONFIG_ENV] = JSON.stringify(fragment);
  }
  // Every start registers them again (open and resume alike): extra roots live in the app-server process.
  const skillRoot = extensionSkillRoot(bundle);
  if (skillRoot && ctx.surface === 'acp') env[GUGU_CODEX_SKILL_ROOTS_ENV] = JSON.stringify([skillRoot.root]);
  if (ctx.surface === 'acp') {
    env[GUGU_CODEX_REASONING_SUMMARY_ENV] = 'auto';
    env[GUGU_CODEX_REASONING_SUMMARIES_SUPPORTED_ENV] = 'true';
    const direct = codexDirectNamespaces(bundle);
    if (bundle.mcpServers.some((server) => server.alwaysLoad)) env[GUGU_CODEX_DIRECT_TOOL_NAMESPACES_ENV] = JSON.stringify(direct);
  }
  // gugu server 的 endpoint 走 Codex 原生 thread `config` map。
  //
  // app-server uses this map; acp uses ACP session/new.
  const usesAcpChannel = ctx.surface === 'acp';
  const threadConfig = ctx.surface === 'app-server'
    ? (() => {
        const entries: Array<readonly [string, unknown]> = [];
        for (const server of bundle.mcpServers) {
          const key = mcpConfigKey(server.name);
          // 问题 9:咕咕发的 server 不逐次问(Codex 缺省按注解判,没注解就问)。
          entries.push([`mcp_servers.${key}.default_tools_approval_mode`, 'approve']);
          if (server.owner === 'gugu') entries.push([`mcp_servers.${key}.omit_tools_from`, ['deferred']]);
          if (server.transport === 'stdio') {
            assertSessionMcpStdioEnv(server, bundle, 'Codex');
            entries.push(
              [`mcp_servers.${key}.command`, server.command],
              [`mcp_servers.${key}.args`, [...(server.args ?? [])]],
            );
            // 扩展程序的参数是相对扩展目录写的(`node mcp/server.mjs`),不带 cwd 就找不到自己。
            if (server.cwd) entries.push([`mcp_servers.${key}.cwd`, server.cwd]);
            if (server.env) {
              entries.push([`mcp_servers.${key}.env_vars`, codexSecretEnvVars(server, bundle, env)]);
              continue;
            }
            for (const [name, value] of Object.entries(codexStdioEnv(server, bundle))) {
              entries.push([`mcp_servers.${key}.env.${name}`, value]);
            }
            continue;
          }
          const suffix = mcpSuffix(server.name);
          entries.push([`mcp_servers.${key}.url`, server.url]);
          if (env[`GUGU_SESSION_MCP_BEARER_${suffix}`] !== undefined) {
            entries.push([
              `mcp_servers.${key}.bearer_token_env_var`,
              `GUGU_SESSION_MCP_BEARER_${suffix}`,
            ]);
          }
        }
        if (toggleDirective.kind === 'config-content') {
          for (const name of toggleDirective.disabled) {
            entries.push([`mcp_servers.${mcpConfigKey(name)}.enabled`, false]);
          }
        }
        // @@@5380 agent 事件 hook 的回调走**这张 map**,不再走 argv `-c notify=…`。
        //
        // 少了它,这条腿一条 hook 事件都发不出来 ⇒ 没有 `stop` ⇒ maybeShowNotification 不被调到
        // ⇒ **跑完没有系统横幅**(#5301,owner 2026-09-09 实机撞到)。WS 的 turn/completed 只驱动
        // lifecycle,不产出通知事件,所以那条路顶不了这一份。
        // ⚠️ 配置文件那条后路指望不上:codex 只有**一个** `notify` 槽,而咕咕刻意不覆盖用户自己
        // 写的那份(`isLegacyCodexNotify` 只认咕咕的标记)—— owner 机器上它被 Codex Computer Use
        // 占着。thread-open 的 config 覆盖优先级高于配置文件,且**不动用户的 config.toml**。
        entries.push(['notify', codexNotifyConfigValue()]);
        // Process-level, so every thread of this app-server has it, the one the TUI creates too.
        const direct = codexDirectNamespaces(bundle);
        if (bundle.mcpServers.some((server) => server.alwaysLoad)) entries.push(['features.code_mode.direct_only_tool_namespaces', direct]);
        return Object.fromEntries(entries);
      })()
    : undefined;
  /**
   * @@@app-server 的系统位是 thread 创建期属性 —— 只有恒定的块能进（#3703）。
   *
   * 写进 `developerInstructions` 的东西**此后永不更新且不报错**：`thread/resume` 收下不消费，
   * `thread/inject_items` 与 `thread/settings/update` 也盖不过它（三条写通道实测全否）。
   * 所以 `threadBootstrap`（该 thread 最近 ≤50 条历史，每条消息都变）不能进来；它由
   * canonical message delivery 的 `gugu_instruction` 携带。identity 是 session-stable，允许在这里一次投递。
   *
   * ⚠️ 只收窄 `app-server` —— 我实测的不可变性只覆盖这一条腿。`acp` 的投递点是否同样
   * 冻结**没有测过**，对它收窄会是未经证明的宽改动。
   */
  const channelBlocks = ctx.surface === 'app-server'
    ? { platform: bundle.promptBlocks.platform, identity: bundle.promptBlocks.identity }
    : bundle.promptBlocks;
  const promptValue = renderPromptBlocks(channelBlocks);
  const deliversPrompt =
    ctx.surface === 'acp' || (ctx.surface === 'app-server' && ctx.lifecycle !== 'resume');
  const prompt = promptValue && deliversPrompt
    ? { value: promptValue, delivered: deliveredPromptBlocks(channelBlocks) }
    : undefined;
  const threadPermission = codexThreadPermission(bundle);
  const acpMeta = usesAcpChannel && threadPermission
    ? {
        guguCodex: {
          permissionProfile: threadPermission.profile,
          threadStart: { ...threadPermission.threadStart },
        },
      }
    : undefined;

  return {
    ...(threadConfig ? { threadConfig } : {}),
    ...(threadPermission ? { threadStart: threadPermission.threadStart } : {}),
    // The app-server leg's host registers them itself (codex-app-server-delivery); the ACP bridge reads the env above.
    ...(skillRoot && ctx.surface === 'app-server' ? { skillRoots: [skillRoot.root] } : {}),
    argsAppend: [
      ...(ctx.surface === 'app-server' ? trustArgs(ctx.cwd) : []),
      ...modelArgs(ctx.surface, bundle, env),
      ...ownBrowserPluginArgs(bundle),
    ],
    env,
    // ACP 面按**名字**声明哪些 server 上 ACP 的 `session/new`;凭据的值不进 materialization,
    // 由宿主侧按名字取回它手里那份带 header 的真 server(见 capability-bundle 的 resolve)。
    acp: {
      // stdio programs ride the private config fragment above, not session/new (#6387).
      mcpServers: usesAcpChannel
        ? bundle.mcpServers.flatMap((server) => {
            if (server.transport === 'stdio') return [];
            return [{
              type: 'http' as const,
              name: server.name,
              url: server.url,
              // 空的:凭据的值按设计不进 materialization(它会落盘、会进取证报告)。
              // 宿主按名字把自己手里那份带 Authorization 的真 server 对回去,对不上就 fail loud。
              headers: [],
            }];
          })
        : [],
      ...(acpMeta ? { meta: acpMeta } : {}),
    },
    ...(prompt ? { prompt } : {}),
    configMerges: [],
    artifacts: [],
    // 一条都不需要了:home 是用户的,他的 sessions / auth.json / skills / 插件缓存本来就在原地。
    tomlOverlays: [trust],
    symlinks: skillRoot?.symlinks ?? [],
    directorySymlinkOverlays: [],
    report: report(ctx, bundle),
  };
}
