import {
  definePlugin,
  registerPluginBehavior,
  type AgentCommand,
  type CommandContext,
  type SessionBundleDescriptor,
} from '@gugu/session-core/agents/plugins';
import { buildStandardCommand, miseDependency } from '@gugu/session-core/agents/plugins/helpers';
import { resolveSessionPermissionMode } from '@gugu/session-core/acp';
import { createNativeAcpBehavior } from '../../helpers/acp-stdio';
import { ANTIGRAVITY_PERMISSION_MODES } from './permission-modes';
import { discoverAntigravitySkills } from './skills';
import { forkAntigravityCliSession, forkAntigravitySession } from './fork';
import { readAntigravityRules } from './rules';
import { linkSkillsJsonRoots } from './skills-json';
import { runAntigravityStopHooks } from './stop-hooks';
import { antigravityFailureFromAgentMessage, antigravityFailureFromStderrLine } from './turn-failure';
import {
  ANTIGRAVITY_CLI_LOGIN_METHOD_ID,
  ANTIGRAVITY_CLI_PROGRAM,
  ANTIGRAVITY_GOOGLE_LOGIN_METHOD_ID,
  ANTIGRAVITY_OAUTH_PERSONAL,
  antigravityAuthStatus,
  antigravityCliAuthStatus,
} from './auth';
import { antigravityMcpAdapter } from './mcp';
import { antigravitySubscriptionBehavior } from './subscription';
import { buildAntigravityHookConfig } from './hooks';
import { icon } from './icon';
import {
  ANTIGRAVITY_CLI_VERSION,
  ANTIGRAVITY_LAUNCH_SCRIPT,
  ANTIGRAVITY_SESSION_TUI_ENABLED,
  antigravitySessionBundleDescriptor,
  materializeAntigravitySessionBundle,
  withLoopbackNoProxy,
} from './session-bundle';

const sessionBundle = antigravitySessionBundleDescriptor satisfies SessionBundleDescriptor;

/**
 * 终端腿的程序 `agy`(Antigravity CLI)—— 与聊天面板腿的 `agy_acp_server` 是 Google 分开发行的
 * **两个程序**(owner 拍板两条腿都要 ⇒ 两个都装,#6335)。点「安装」一次装两个。
 *
 * 分发:Google 官方 install.sh 用的同一份按平台版本清单
 * (`/tmp/agy-acp-probe/agy-install.sh`:`$DOWNLOAD_BASE_URL/manifests/$platform.json` → `{version,url,sha512}`),
 * 平台键八格照抄 install.sh 的判定(`<os>_<arch>`,Linux 上 musl 另成 `_musl` 一格)。
 * 2026-09-24 读 darwin_arm64 / windows_amd64 两格:1.2.10,前者 tar.gz(包内单独一个 `antigravity`),
 * 后者裸 `.exe`。
 *
 * ⚠️ 装进来的启动器叫 `agy`,❌ 不叫 `antigravity`:后者会在 PATH 上顶掉 Antigravity IDE 的
 * `antigravity` 命令(「在 Antigravity IDE 中打开」靠它判 IDE,`openInApps.ts`)。
 * 用户自己用 install.sh 装在 `~/.local/bin/agy` 的那一份,按二进制名 `agy` 照常被认出来。
 */
const ANTIGRAVITY_CLI_COMPANION = {
  id: ANTIGRAVITY_CLI_PROGRAM,
  name: 'Antigravity CLI',
  legs: ['tui' as const],
  dependency: miseDependency({
    id: 'agy',
    backend: 'vendor-manifest',
    manifest: 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/{platform}.json',
    platforms: {
      'darwin-arm64': 'darwin_arm64',
      'darwin-x64': 'darwin_amd64',
      'linux-x64': 'linux_amd64',
      'linux-arm64': 'linux_arm64',
      'linux-x64-musl': 'linux_amd64_musl',
      'linux-arm64-musl': 'linux_arm64_musl',
      'win32-x64': 'windows_amd64',
      'win32-arm64': 'windows_arm64',
    },
    archiveExecutable: 'antigravity',
    installDocs: 'https://antigravity.google/docs/cli/install',
  }),
};

/**
 * 登录终端跑的命令 —— **同一个启动器**起一个裸的 `agy`,由它自己的 TUI 首屏带用户登录(理由见
 * ./auth.ts 的 `ANTIGRAVITY_CLI_PROGRAM`)。与 `buildAntigravityCommand` 同一层包法:HOME 只换在
 * `agy` 这一个进程上,登录写进的就是终端会话会读的托管根,钥匙串经影子 home 的软链落进用户的登录钥匙串。
 * `ctx.cli` 是宿主按 `tui` 解析的那一份(`authProgramRole`),与终端会话跑的是同一个二进制。
 */
function buildAntigravityCliLoginCommand(ctx: { cli: string }): { command: string; args: string[] } {
  return { command: '/bin/sh', args: ['-c', ANTIGRAVITY_LAUNCH_SCRIPT, ctx.cli] };
}

/**
 * 终端腿的命令 —— 包一层启动器再起 `agy`(`/bin/sh -c <ANTIGRAVITY_LAUNCH_SCRIPT> <agy> <参数…>`)。
 *
 * 启动器只做一件事:把 `HOME` 换成咕咕托管那份 `.gemini` 的父目录(影子 home),且只换在 `agy` 这一个
 * 进程上 —— `agy` 只认 `HOME` 找配置根,而外层 shell 若拿到影子 HOME 会读到影子 home 的 `.zshenv` 又换回去。
 * 理由逐条见 session-bundle 的 `ANTIGRAVITY_LAUNCH_SCRIPT` 抬头。
 *
 * 各旗标的出处(`agy --help`,1.2.9 本机逐字;官方 https://antigravity.google/docs/cli/reference 与各子页):
 *  · 首句 `-i <正文>`(`--prompt-interactive`「Run an initial prompt interactively and continue the session」)。
 *  · 续跑 `--conversation <id>`(「Resume a previous conversation by ID」,docs/cli/commands/resume)。id 由
 *    `agy` 自己分配,咕咕从 `PreInvocation` 钩子的 `conversationId` 记下(./hooks.ts);没有原生 id 就不算续跑
 *    (`resolve-agent-session-command.ts` 的名单)。❌ 不用 `-c`:按 cwd 找「最近一条」,会续到别的会话上。
 *  · 权限三档由同一张档位表(`ANTIGRAVITY_PERMISSION_MODES`)落成 argv:
 *      full-access → `--dangerously-skip-permissions`(「Auto-approve all tool permission requests without prompting」,
 *                    实测默认档会弹的 `Run this command?` 不再出现、命令直接执行);
 *      edit        → `--mode accept-edits`(docs/cli/modes.md「Automatically approves file edits and creations」,
 *                    shell 命令仍按权限规则问 —— 与聊天面板腿 `auto_edit` 同义);
 *      read-only   → **终端腿没有**(档位表里只给 `legs: ['acp']`,界面不摆)。agy 1.4.0 `--mode` 只认
 *                    accept-edits / auto / plan,`--mode default` 只打一行 warning 照常起,落到用户自己存的档;
 *                    shell 另由 `toolPermission` 管(docs/cli/modes.md)。走到这里就是调用方绕过了界面 ⇒ 抛。
 *    ❌ 不摆 plan:`--mode plan` 在 CLI 上存在,但档位表是两条腿共用的,聊天面板腿自报的三档里没有 plan,
 *    摆出来就是那条腿上一个选了也不生效的档。
 *  · 模型 `--model <id>`:只收它自己目录里的 id(`agy models`,API key 模式实测 11 条,与聊天面板腿的目录同形)。
 *
 * ⚠️ Windows 上这条腿不开(`ANTIGRAVITY_SESSION_TUI_ENABLED`),走到这里就是调用方绕过了 surface 闸 ⇒ 抛。
 */
function buildAntigravityCommand(ctx: CommandContext): AgentCommand {
  if (!ANTIGRAVITY_SESSION_TUI_ENABLED) {
    throw new Error('Antigravity terminal sessions are not available on Windows; use the chat UI leg');
  }
  if (ctx.isResuming && !ctx.providerSessionId) {
    // 缺原生 id 的续跑在宿主那边已经被压成新起(名单),走到这里 = 别的调用方没过那道闸 —— 响亮失败,
    // ❌ 发一个没有值的 `--conversation`。
    throw new Error('Antigravity resume needs the native conversation id reported by agy');
  }
  if (resolveSessionPermissionMode(ctx) === 'read-only') {
    throw new Error('Antigravity CLI has no read-only mode on the terminal leg; use the chat UI leg');
  }
  const agy = buildStandardCommand(ctx, {
    autoApproveFlag: '--dangerously-skip-permissions',
    editFlag: '--mode accept-edits',
    initialPromptFlag: '-i',
    resumeFlag: '--conversation',
    cliSessionIdFlag: '--conversation',
    cliSessionIdOnResumeOnly: true,
    modelFlag: '--model',
  });
  return { ...agy, command: '/bin/sh', args: ['-c', ANTIGRAVITY_LAUNCH_SCRIPT, agy.command, ...agy.args] };
}

/**
 * Google Antigravity —— **两条腿、两个程序**(#6335,owner 拍板两条都要,点「安装」一次装两个):
 *  · 聊天面板腿跑 Google 官方 ACP 服务 `agy_acp_server`(ACP 注册表 `antigravity-acp`,
 *    Google 2026-08-20 提交进 agentclientprotocol/registry PR #542);
 *  · 终端腿在 pty 里跑 `agy` CLI(伴随程序 `ANTIGRAVITY_CLI_COMPANION`)。Windows 上不开,理由见
 *    session-bundle 的 `ANTIGRAVITY_SESSION_TUI_ENABLED`。
 *
 * ⚠️ 两个程序**不共享登录**:agy CLI 已登录的机器上 ACP 服务照样报 `Credentials missing`,
 *    钥匙串里是两条条目(service `gemini` 下 account `antigravity` 与 `antigravity-acp`,实测;官方
 *    troubleshooting 管 CLI 那条叫 `Antigravity CLI`)。所以登录入口与状态**按程序**各一份(`auth.programs`)。
 * ⚠️ 两条腿**共用**咕咕托管的一份 `.gemini`(owner 原则:一个 harness 一个配置根):ACP 服务经
 *    `GEMINI_HOME`,agy 经 `HOME`(它不认 `GEMINI_HOME`)。
 *
 * 能力声明的读数底座见 `./session-bundle.ts` 抬头。
 */
export const plugin = definePlugin(
  {
    id: 'antigravity',
    name: 'Antigravity',
    description:
      'Google Antigravity: the official ACP server (agy_acp_server) for chat, and the agy CLI for terminal sessions.',
    // ACP 服务的官方说明页(注册表条目给的同一个出处)。
    websiteUrl: 'https://antigravity.google/docs/ide/extensions',
  },
  {
    sessionBundle,
    // 「订阅」页(product spec):用量只有终端版 `agy` 报(官方 /usage,不花额度),打开页面就问。
    subscription: { kind: 'supported', usageRefresh: 'on-open', program: ANTIGRAVITY_CLI_PROGRAM },
    /**
     * `agy_acp_server` 本身就是 stdio JSON-RPC 服务,不带参数直接说 ACP。`initialize` 实测回
     * `protocolVersion:1`、`loadSession:true`、`promptCapabilities:{image,audio,embeddedContext}`、
     * `mcpCapabilities:{http,sse}`、`sessionCapabilities:{list,resume}`。
     * 它的 `--help` 只有 `--[no]debug` / `--[no]notices` 两个旗标,没有子命令。
     */
    acp: {
      kind: 'supported',
      // 冷启动实测(2026-09-24,MBP,负载 65):装好后头一次 `initialize` 20.7s,之后 2.4s。
      // 400MB 的 par + 本地内核头一次被系统读进来、过一遍扫描;没有自解压缓存可预热。
      // 启动只等事实、不设墙钟(#6183),这里只亮「首次较慢」让等待看得见。
      startup: { noticeKey: 'chat.antigravityPreparing' },
      // agy_acp_server 1.2.1 在 `session/new` 的 configOptions 里自报 `model` 与 `mode` 两项
      // (category 同名、type select),`session/set_config_option` 的响应带回整份 configOptions,
      // currentValue 即新值(2026-09-23 实测两项都读得回)。咕咕启动时就要下发这两维,
      // 缺这份声明每条会话都在第一句前死于 LiveSettingUndeclared(#6335 首测)。
      // 思考深浅编在模型 id 里(`-high/-medium/-low`),没有独立的 effort 轴。
      liveSettings: {
        model: {
          channel: 'acp-config-option',
          ack: 'ack-read-back',
          busy: 'reject',
          reloadRequired: false,
          recovery: 'none',
        },
        permission: {
          channel: 'acp-config-option',
          ack: 'ack-read-back',
          busy: 'reject',
          reloadRequired: false,
          recovery: 'none',
          allowStartupDowngrade: true,
        },
        effort: {
          channel: 'unsupported',
          ack: 'none',
          busy: 'reject',
          reloadRequired: false,
          recovery: 'unsupported',
        },
      },
    },
    /** 三档由 `session/new` 的 `mode` 配置项自报,运行期经 `session/set_config_option` 下发 —— 读数与映射见 `ANTIGRAVITY_PERMISSION_MODES`。 */
    autoApprove: {
      kind: 'supported',
      modes: ANTIGRAVITY_PERMISSION_MODES,
    },
    /**
     * 怎么登 —— **协议登录**(#6335):没有任何登录子命令(`--help` 只有 `--debug` / `--notices`),
     * 未登录时 `session/new` 回 `-32000 Authentication required`,原文要求「call the `authenticate`
     * method」。咕咕替它发 `authenticate {methodId:'oauth-personal'}`,它自己拉起浏览器、等本地回调。
     * 出处与登录态判据见 ./auth.ts。
     *
     * 只摆 Google 账号这一种 —— 咕咕管的是**登录入口与登录状态**,不是它的每一种认证。
     * 它另外三种(`gemini-api-key` / `agent-platform` / `oauth-business`)是 harness 自己实现的兼容性:
     * 用户在它自己的 settings.json 里选定、凭据放环境变量,咕咕照原样带进去(托管根拷的就是那份
     * settings.json,`GEMINI_API_KEY` / `GOOGLE_*` 在共用的透传白名单里(session-core `SHARED_AGENT_ENV_VARS`)),状态由 `./auth.ts` 如实读。
     * ❌ 别替用户挑认证方式、别为这三种造入口(owner 2026-09-24:「我们只是说兼容…我们管登录入口和状态就行了」)。
     */
    auth: {
      kind: 'supported',
      methods: [
        {
          kind: 'acp-authenticate',
          id: ANTIGRAVITY_GOOGLE_LOGIN_METHOD_ID,
          name: 'Google 账号',
          methodId: ANTIGRAVITY_OAUTH_PERSONAL,
          description: 'Opens Google sign-in in your browser (the Antigravity ACP server runs the OAuth flow itself).',
        },
      ],
      /**
       * 终端腿的 `agy` 自己的登录(#6335)—— 与聊天面板那个程序**不共享**登录,所以单独一份入口与状态。
       * `cli-login`、不带参数:`agy` 没有登录子命令,裸起它就是登录首屏(./auth.ts)。
       * 同样只摆 Google 账号 —— 它的「Use a Google Cloud project」与 API key 模式是它自己的兼容性,
       * 状态照实读(API key 模式判为已登录),❌ 不为它们造入口。
       * Windows 上终端腿不开(`ANTIGRAVITY_SESSION_TUI_ENABLED`),这份登录也就不声明 —— 没有会用到它的会话。
       */
      ...(ANTIGRAVITY_SESSION_TUI_ENABLED
        ? {
            programs: {
              [ANTIGRAVITY_CLI_PROGRAM]: {
                methods: [
                  {
                    kind: 'cli-login' as const,
                    id: ANTIGRAVITY_CLI_LOGIN_METHOD_ID,
                    name: 'Google 账号',
                    args: [],
                    description: 'Starts agy; its own sign-in screen opens Google sign-in in your browser.',
                  },
                ],
              },
            },
          }
        : {}),
    },
    // 托管安装:ACP 注册表来源(#6335)—— 版本与各平台归档读注册表 `antigravity-acp` 那一条。
    // 注册表**没有 darwin-x86_64**,Intel Mac 上装不了,是厂商侧的覆盖面。
    hostDependency: {
      ...miseDependency({
        id: 'agy_acp_server',
        backend: 'acp-registry',
        agentId: 'antigravity-acp',
        installDocs: 'https://antigravity.google/docs/ide/extensions',
      }),
      companions: [ANTIGRAVITY_CLI_COMPANION],
    },
    /**
     * MCP —— 用户级 `~/.gemini/config/mcp_config.json` 的 `mcpServers` 键,与 agy CLI **共用**同一份,
     * 而 ACP 服务起会话时读的正是它(stderr「Attempting to load global MCP configs from
     * <GEMINI_HOME>/config/mcp_config.json」)。形状不是 canonical(HTTP 用 `serverUrl`、启用状态是反的
     * `disabled`),所以走本目录的 `antigravityMcpAdapter()` —— 逐条出处与实测见 `./mcp.ts`。
     */
    mcp: {
      kind: 'supported',
      scope: 'global',
      supportedTransports: ['stdio', 'http'],
      /**
       * `inherit`:两条腿都**自己**读托管根里那份 `config/mcp_config.json`(用户的条目在里面),会话包只带咕咕那几台。
       * 实测(2026-09-24):聊天面板腿 `agy_acp_server` 把文件条目与 `session/new` 的 mcpServers **合并**,同名时
       * 会话那条胜出(stderr「Overwriting global MCP config for gugu with IDE-supplied version」,假 MCP 只收到
       * 会话令牌的请求);终端腿 `agy` 只有这份文件一个载体。复述 = 把用户的 stdio 条目连同它的 env 再写一遍
       * 进同一份文件,纯亏损。
       */
      sessionUserServers: 'inherit',
      /**
       * 两条腿是两个程序,工具进模型的方式不同 ⇒ 按腿声明。
       *  · 终端腿(`agy`):MCP 工具**不**逐个上工具表。模型请求里只有一个通用的 `call_mcp_tool`,
       *    系统提示按 `# <serverName>\nEager:\n<toolName>\nLazy:\n<toolName>` 列出各 server 的工具,并写明
       *    「For lazily-loaded tools, read the corresponding schema file … then call the tool using the
       *    `call_mcp_tool` tool」(实测咕咕那台落在 Lazy)。调法 = `call_mcp_tool {ServerName, ToolName, Arguments}`,
       *    ToolName 是**裸**名 ⇒ `server-proxied`,❌ 不硬套 `proxied` 的前缀全名。
       *    eager / lazy 用户配不了:官方 docs/mcp 的 server 字段表(command serverUrl args env cwd headers
       *    authProviderType oauth disabled disabledTools)里没有这一项;二进制里有个内部 proto 字段
       *    `McpToolConfig.enable_lazy_load`,没进文档 ⇒ ❌ 不依赖。
       *  · 聊天面板腿:工具进了 functionDeclarations(toolDeclared=true,见 session-bundle 抬头),但模型眼里
       *    的**名字**没量 ⇒ 缺席 = unmeasured,如实欠账。
       */
      toolNames: {
        kind: 'per-surface',
        surfaces: {
          'tui': {
            kind: 'server-proxied',
            proxyTool: 'call_mcp_tool',
            serverArg: 'ServerName',
            toolArg: 'ToolName',
            evidence:
              `agy ${ANTIGRAVITY_CLI_VERSION} MBP 2026-09-24 影子 HOME + 假 Gemini 端点抓上行请求体:tools 多出 `
              + '`call_mcp_tool`,systemInstruction 含「# gugu\nLazy:\ngugu_ping_7731」与「call the tool using the '
              + '`call_mcp_tool` tool」;参数 ServerName / ToolName / Arguments(同一请求的 functionDeclarations)',
          },
        },
      },
    },
    /*
     * ❌ 不再有静态模型表。旧表钉的是 agy CLI 的显示名(「Gemini 3.5 Flash (Medium)」),agy 1.2.9
     * 实测 `--model 'Gemini 3.5 Flash (Medium)'` 报 `model … is not recognized`。ACP 腿的模型目录
     * 由运行中的进程自报(`session/new` 的 `configOptions[category=model]`,由
     * `harness-model-catalog.ts` 读),实测 id 形如 `gemini-3.7-flash-high`、名字形如
     * 「Gemini 3.7 Flash (High)」;推理档**烤在 id 里**(-high/-medium/-low),线上请求去掉档位
     * (`gemini-3.7-flash-high` → `/v1beta/models/gemini-3.7-flash:…`)。
     * ⚠️ 目录**随认证方式变**:gemini-api-key 下只有 Gemini 3.7/3.6/3.5 Flash 与 3.1 Pro 共 11 条。
     */
    /**
     * 工作区信任 —— 终端腿的 `agy` 首次进一个目录会先问「trust this folder?」。托管配置根的家,信任由
     * `configRoot.firstRunState` 在托管的 `antigravity-cli/settings.json` 里落(实测与出处见 session-bundle),
     * 与 kimi 同一条路;这里没有第二个写者。
     */
    trust: { kind: 'supported', channel: 'first-run-state' },
    /**
     * 终端腿的消息编码:整段写进 pty 再回车(argv 家的通用注入);`-i <正文>` 是它的启动槽。
     * 首句**不走**启动槽(`startupDelivery: 'delivery-bridge'`),由宿主在这条会话的 gugu MCP 送出 `tools/list`
     * 之后,经同一条 local-session 注入送进去(`providerStartupTurnViaLocalSession`)。
     * 理由(2026-09-24 实测,agy 1.2.9 + 本地假端点):
     *  · `-i` 起:第一轮的 `mcp_servers` 提示段在任何 stdio server 应答之前就拼好了,咕咕的工具第一轮不在;
     *    PreInvocation 钩子里阻塞 3 秒等 MCP 就绪也不行(提示段在钩子之前就定了);
     *  · 不带 `-i` 起、等 `tools/list` 之后再注入:3/3 次第一轮就有 `# gugu` 工具,注入与 `tools/list` 请求
     *    到达只隔 3~4ms 也在(宿主的就绪信号还要更晚:在应答写完之后)。
     * 聊天面板腿不受影响:它的首句走 `session/prompt`(`providerConsumesStartupPrompt(…, 'acp')` 恒真)。
     */
    prompt: {
      kind: 'argv',
      flag: '-i',
      startupDelivery: 'delivery-bridge',
    },
    /**
     * `initialize` 回 `loadSession:true` 与 `sessionCapabilities:{list,resume}`(实测 1.1.1);终端腿续跑
     * `--conversation <id>`。
     * 分叉两条腿都由咕咕在**这一家自己的存档**上做(`./fork.ts`:SQLite 一致快照 + 库内旧 id 等长改写,
     * 来源不动):聊天面板腿的 `session/fork` 是空桩(经 `acp.forkSessionInStorage`,随后 `session/load`);
     * 终端腿的 `agy` 只有 TUI 里的 `/fork`、没有任何启动参数能分叉(`agy --help` 全表)⇒ 经
     * `sessions.forkSessionInStorage`,宿主随后 `--conversation <新 id>` 续跑。
     */
    sessions: {
      kind: 'resumable',
      tuiResume: 'provider-id',
      // `agy` 自己分配会话 id、调用方指定不了,续跑只有 `--conversation <id>` 一条路(官方 docs/cli/commands/resume)。
      // 它另有 `-c`(按 cwd 找「最近一条」),❌ 不拿它当没 id 时的退路;没有原生 id(首轮前就退了)= 起一条新的。(#6335,2026-09-24)
      resumeNeedsProviderId: true,
      fork: 'supported',
    },
    /**
     * 回合边界 —— 终端腿的 hooks 写进咕咕托管那份 `.gemini/config/hooks.json`(写入器与事件映射见 ./hooks.ts)。
     * 实测(agy 1.2.9,影子 HOME):交互终端里每一轮结束 `Stop` 触发一次,stdin 带 `conversationId`、
     * `terminationReason:"NO_TOOL_CALL"`、`fullyIdle:true`。
     * ⚠️ 聊天面板腿读同一份文件:它的服务自己会跑 PreInvocation(咕咕的命令在那边没有 `GUGU_HOOK_PORT`,
     *    走守卫里的空分支),咕咕代跑 Stop 那一路(./stop-hooks.ts)认得出咕咕的条目并跳过。
     */
    hooks: {
      kind: 'config',
      scope: 'agent-home',
      supportedEvents: ['session', 'stop'],
    },
    /*
     * 规则文件(GEMINI.md / AGENTS.md / rules 目录):ACP 服务一处都不读,由咕咕按官方文档的位置读出来、
     *    随会话级背景进第一轮(`acp.readRules`,见 ./rules.ts)。这不是会话包的 `memory` 单元 ——
     *    那一格描述的是「咕咕往 agent 的记忆文件里写东西」,这里是「替它读用户自己写的规则」。
     */
  },
  { icon }
);

export const provider = registerPluginBehavior(plugin, {
  // 声明了 `auth` 就必须配 `behavior.auth`(framework 直接抛)。
  auth: {
    checkStatus: (ctx) => antigravityAuthStatus(ctx),
    // 终端腿的 `agy`:钥匙串 account `antigravity` / API key 模式(./auth.ts),登录走同一个启动器。
    programs: {
      [ANTIGRAVITY_CLI_PROGRAM]: {
        checkStatus: (ctx) => antigravityCliAuthStatus(ctx),
        buildLoginCommand: (ctx) => buildAntigravityCliLoginCommand(ctx),
      },
    },
  },
  subscription: antigravitySubscriptionBehavior(),
  sessionBundle: { materialize: materializeAntigravitySessionBundle },
  // 终端腿的分叉:复制 `antigravity-cli/conversations/<id>.db` 并改写 id,宿主再 `--conversation <新 id>`(见 ./fork.ts)。
  sessions: { forkSessionInStorage: (ctx) => forkAntigravityCliSession(ctx) },
  /**
   * 托管装好的 `agy_acp_server` 就是 `ctx.cli`,不带参数。
   * 回环免代理必须在**这里**加而不是在物化器里:模型目录探针也走这条 `buildSpawn`,
   * 不经物化 —— 只在物化器里加,探针那一趟就会在代理机器上起不来(理由见 `withLoopbackNoProxy`)。
   */
  acp: {
    ...createNativeAcpBehavior((ctx) => ({
      args: [],
      env: withLoopbackNoProxy(ctx.env),
    }), { interruptAtToolBoundary: true }),
    // 用户 skill 它读进了系统提示却不经 ACP 报 ⇒ 咕咕按它认的四处目录补进「/」面板(见 ./skills.ts)。
    discoverCommands: discoverAntigravitySkills,
    // `session/fork` 回 `{}` ⇒ 复制存档并改写 id,运行时再 `session/load`(见 ./fork.ts)。
    forkSessionInStorage: (ctx) => forkAntigravitySession(ctx),
    // 规则文件它一处都不读 ⇒ 咕咕按官方文档的位置读出来,随会话级背景进第一轮(见 ./rules.ts)。
    readRules: readAntigravityRules,
    // `skills.json` 它不读 ⇒ 起进程前把那些 skill 链进托管根的 config/skills/(见 ./skills-json.ts)。
    prepareSession: linkSkillsJsonRoots,
    // `Stop` 钩子它只在会话结束时跑、且不认 continue ⇒ 咕咕每轮结束代跑(见 ./stop-hooks.ts)。
    onTurnEnded: runAntigravityStopHooks,
    // 失败的回合它报成 end_turn(错误写成一句回复,或只在 stderr 留一行)⇒ 认出来按失败结算(见 ./turn-failure.ts)。
    turnFailure: {
      fromAgentMessage: antigravityFailureFromAgentMessage,
      fromStderrLine: antigravityFailureFromStderrLine,
    },
  },
  // 用户级那一份;❌ 不加 `.agents/mcp_config.json` —— 这条路的 PluginFs 根是 `os.homedir()`,
  // 工作区相对路径会去家目录下找一个永远不存在的文件(静默读空)。
  mcp: antigravityMcpAdapter(),
  // 终端腿:`agy` 外面包一层只换 `agy` 自己 HOME 的启动器(见 `buildAntigravityCommand`)。
  prompt: { buildCommand: buildAntigravityCommand },
  // 终端腿的回合边界与原生会话 id(写进托管根的 hooks.json,见 ./hooks.ts)。
  hooks: buildAntigravityHookConfig(),
  // 信任由 configRoot.firstRunState 在托管配置根里落,这里没有第二个写者。
  trust: { channel: 'first-run-state' },
});

export {
  antigravitySessionBundleDescriptor,
  materializeAntigravitySessionBundle,
} from './session-bundle';
