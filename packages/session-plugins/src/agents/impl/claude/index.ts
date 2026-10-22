import { platformModel } from './platform-model';
import {
  definePlugin,
  registerPluginBehavior,
  type AgentMemoryDescriptor,
  type SessionBundleDescriptor,
} from '@gugu/session-core/agents/plugins';
import {
  CLAUDE_GUGU_CAPABILITY_PACKAGE,
  CLAUDE_NATIVE_HOME,
  claudeSessionBundleDescriptor,
  materializeClaudeSessionBundle,
} from './session-bundle';
import {
  buildStandardCommand,
  miseDependency,
} from '@gugu/session-core/agents/plugins/helpers';
import { resolveWindowsHandoffExecutable } from '@gugu/session-core/exec';
import { connectStdioAcpV2 } from '../../helpers/acp-v2';
import { requireBridgeEntry } from '../../helpers/acp-bridge-entry';
import {
  NODE_FOR_CLAUDE_ACP,
  resolveNodeInterpreter,
} from '../../helpers/node-interpreter';
import { enrichClaudeUpdate } from './acp-transform';
import { claudeAuthStatus } from './auth';
import { claudeSubscriptionBehavior } from './subscription';
import { buildClaudeHookConfig } from './hooks';
import { CLAUDE_PRESENCE_SINCE } from './presence';
import { icon } from './icon';
import { claudeMcpAdapter } from './mcp-scopes';
import { claudeAcpRootBypassEnv } from './root-bypass';
import { buildClaudeTrustBehavior } from './trust';
import { CLAUDE_PERMISSION_MODES } from './permission-modes';

/**
 * 咕咕需要的桥接改动(插消息走 `next`、`forkSession` 透传、UltraCode 档、确认过的上下文窗口跨进程保存)现在是
 * **咕咕维护的桥接构建** `@gugu-acp/claude-agent-acp`:shuxueshuxue/gugu-acp 仓里 `bridges/claude-agent-acp/`
 * 的补丁打在上游源码 tag 上构建(每个补丁写明为什么、对应上游 PR、何时删),版本号是我们自己的(#6394)。❌ 再回到 pnpm `patchedDependencies` 改发布产物:那份补丁绑死
 * 一个版本,桥接因此三周没升级,与用户自动升级的 Claude 失配(2.1.270 起被插消息的回合永不结束)。
 *
 * ⚠️ ❌ **绝不在这里就地改写随包发出去的 `dist/acp-agent.js`**(#5599)。那一手在装好的包里
 * 写临时文件再 rename,而**装好的包不保证可写**:Linux 的 AppImage 把 `resources/app` 挂成
 * 只读 squashfs(`/tmp/.mount_gugu.<rand>`,`ro,nosuid,nodev`),那次写必 EROFS ——
 * 它挂在桥入口的解析上,而那正是 claude `buildSpawn` 的 `args[0]`,
 * 于是模型目录探测与**任何 claude ACP 会话启动**一起炸(0.2.39 实测:「读取 Claude Code 的模型失败」)。
 *
 * 换版守卫是 `acp.test.ts` 的 vendor-boundary 断言:解析出来的那份 `acp-agent.js` 必须逐字含
 * {@link CLAUDE_ACP_FORK_PATCH_MARKERS} 与 {@link CLAUDE_ACP_CONTEXT_WINDOW_PATCH_MARKERS},UltraCode 由解析到的那份桥接的
 * `session-effort.js` 按行为验。
 * 换了一份不含这些提交的桥接 → CI 红,❌ 不会在用户机器上悄悄改文件。
 */
export const CLAUDE_ACP_FORK_PATCH_MARKERS = [
  'forkSession: options?.forkSession,',
  // 分叉与新建会话一样跑在桥接自己铸的会话 id 上(1.1.1,#6552)。此前那版把 id 交给 Claude 铸、
  // 等 `initializationResult.session_id`(Claude 不给)⇒ 按 SDK 消息 session_id 发的更新全被丢。
  'if (creationOpts?.resume === undefined || creationOpts?.forkSession) {',
] as const;

/**
 * 还是猜的上下文窗口读数打标(#6552)。1.2.0 起桥接不再跨进程保存确认过的窗口:上游 0.83.0 在建会话后
 * 约 0.5 s 自己向 Claude 确认窗口(gugu-acp b305d1613),补丁 0004 只剩这一个标记。
 */
export const CLAUDE_ACP_CONTEXT_WINDOW_PATCH_MARKERS = [
  '"_claude/contextWindowEstimated": true',
] as const;

export const CLAUDE_ACP_STEERING_PATCH_MARKERS = [
  'params._meta?.steering?.delivery === "next"',
] as const;

/**
 * 宿主讲 ACP v2(`connectStdioAcpV2`),要桥在 v2 上服务插话与后台任务扩展,插话也进 Claude 自发的周期
 * (gugu-acp 1.5.0 的「serve _session/steering on ACP v2」「serve the async tasks extension on ACP v2」)。
 * 键是 dist 里的文件(相对 `acp-agent.js` 所在目录)。
 */
export const CLAUDE_ACP_V2_EXTENSION_MARKERS = {
  'acp-agent.js': ['if (!turnInFlight && !this.foregroundWork.has(sessionId)) {'],
  'v2/agent.js': ['v2Steer(agent, params)', 'agent.stopAsyncTask(params)'],
} as const;

const CLAUDE_ULTRACODE_EFFORT_ID = 'ultracode';
const CLAUDE_ULTRACODE_SETTINGS = '{"ultracode":true}';

/**
 * 交给厂商 ACP 适配器的那条 claude 路径 —— 它必须是**那边 spawn 得起来**的东西。
 *
 * 适配器把 `CLAUDE_CODE_EXECUTABLE` 原样交给 Claude Agent SDK,SDK 直接 `spawn` 它。
 * Windows 上 npm 装完留下的是 `claude.cmd`(壳里再调 `…\claude-code\bin\claude.exe`),
 * 而 Node 自 18.20.2 / 20.12.2 起禁止不经 shell 执行 `.cmd` ⇒ `spawn EINVAL`。
 * 这一层不在咕咕手里(是别人的进程在 spawn),所以只能**递一条它跑得动的路径**。
 *
 * 2026-09-18 Windows 真机实测(同一台机、同一份适配器,只换这一个值):
 * · `…\npm\claude.cmd`  → `session/new` = `-32603 Internal error {details:"spawn EINVAL"}`
 * · `…\claude-code\bin\claude.exe` → `session/new` 正常返回 modes / configOptions(含模型清单)
 *
 * 症状离真因很远:模型目录就是靠这条 `session/new` 探的,探不到 ⇒ composer 里
 * 「你的 Claude Code 模型」那一整档(连同它下面唯一的登录入口)**整组不渲染**。
 * ⇒ 翻译不出来就**当场响亮失败**,❌ 不静默回落到 SDK 自带的那份二进制:
 *   那会让用户以为跑的是他自己装的那份 claude。
 */
function claudeExecutableForAdapter(cli: string): string {
  const spawnable = resolveWindowsHandoffExecutable(cli);
  if (spawnable) return spawnable;
  throw new Error(
    `Claude Code 解析到的是一个 Windows 壳脚本(${cli}),而 ACP 适配器会直接 spawn 它 —— `
      + 'Node 在 Windows 上不允许直接执行 .cmd/.bat(CVE-2024-27980),表现是 spawn EINVAL。'
      + '请安装官方 claude.exe(irm https://claude.ai/install.ps1 | iex),或把 Claude Code 的路径指向 claude.exe。'
  );
}

const sessionBundle = claudeSessionBundleDescriptor satisfies SessionBundleDescriptor;

export const plugin = definePlugin(
  {
    id: 'claude',
    name: 'Claude Code',
    description:
      'CLI that uses Anthropic Claude for code edits, explanations, and structured refactors in the terminal.',
    websiteUrl: 'https://code.claude.com/docs/en/quickstart',
  },
  {
    sessionBundle,
    /**
     * 厂商账号是不是硬门槛 —— 判据与陷阱见 `capabilities/vendor-account.ts` 抬头。
     * 这一格是**实测**出来的，❌ 不收「文档写着」。
     */
    // 「订阅」页(product spec):用量只在用户点「现在查」时问 —— 厂商那个查询问几次就会被封一阵。
    subscription: { kind: 'supported', usageRefresh: 'on-open' },
    vendorAccount: {
      kind: 'not-required',
      evidence:
        '只给 ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN/ANTHROPIC_MODEL、零 Anthropic 账号，隔离 HOME 下 `claude -p` exit=0，假端点收到 POST /v1/messages 且逐字带上给的 token 与 model',
    },
    acp: {
      kind: 'supported',
      liveSettings: {
        model: {
          channel: 'acp-config-option',
          ack: 'ack-read-back',
          busy: 'queue-next-turn',
          reloadRequired: false,
          recovery: 'none',
        },
        permission: {
          channel: 'acp-config-option',
          ack: 'ack-read-back',
          busy: 'queue-next-turn',
          reloadRequired: false,
          recovery: 'none',
          allowStartupDowngrade: true,
        },
        effort: {
          channel: 'acp-config-option',
          ack: 'ack-read-back',
          busy: 'queue-next-turn',
          reloadRequired: false,
          recovery: 'none',
        },
      },
    },
    autoApprove: {
      kind: 'supported',
      // claude ACP 真机上报 6 档(fixtures/acp-transcript.json):
      //   auto / default / acceptEdits / plan / dontAsk / bypassPermissions
      // ⚠️ `default` 才是它的只读档(官方 permission-modes 文档原文「default (read-only)」),
      //    ❌ 不是 plan。plan 单独占一档:只读是「能看不能动」,规划是「只出方案」——
      //    Gemini CLI 把这两档并列排进 PLAN < DEFAULT < AUTO_EDIT < YOLO,同一个阶梯。
      // `dontAsk`(预授权工具,其余一律拒)最贴近只读,作别名归进去,这样 agent 处在
      // 该档时界面显示「只读」而不是错报成「编辑」。
      // ⚠️ `auto`(交给模型分类器判批准/拒绝)**不进阶梯** —— 它不是"能改多少"这条轴上的
      //    一个刻度,而是"谁来决定"。硬塞进任何一档都是骗人,所以不声明、界面也不摆。
      modes: CLAUDE_PERMISSION_MODES,
    },
    auth: {
      kind: 'supported',
      methods: [
        {
          kind: 'cli-login',
          id: 'claude-login',
          name: 'Sign in with Claude Code',
          args: ['auth', 'login'],
          // 别的机器上照样是它:浏览器回跳不到那台机器时,登录页给一串码,贴回终端即完成
          // (code.claude.com/docs/en/troubleshoot-install「OAuth login fails in WSL2, SSH, or containers」:
          // `claude auth login` 从标准输入读贴回来的码)。
          headlessArgs: ['auth', 'login'],
          description: 'Open the Claude Code CLI sign-in flow in a terminal.',
        },
        {
          kind: 'api-key',
          id: 'anthropic-api-key',
          name: 'Use an Anthropic API key',
          envVars: [{ name: 'ANTHROPIC_API_KEY', label: 'Anthropic API key' }],
          helpUrl: 'https://docs.anthropic.com/en/api/admin-api/apikeys/get-api-key',
        },
      ],
    },
    // Effort levels — Claude Code 2.1.220 advertises `supportedEffortLevels` per model, drawn
    // from `low|medium|high|xhigh|max`.
    //
    // All four models list the full set here rather than a narrowed one. The CLI does compute
    // per-model support (`supportsEffort`, which its built-in branch answers false for
    // claude-haiku-4-5), but that branch sits behind a per-model override lookup we cannot
    // evaluate offline, and the behaviour disagrees: `claude --model haiku --effort xhigh`
    // is accepted without complaint and a live haiku session reports `xhigh`. Narrowing on
    // the strength of minified internals would hide a level that demonstrably works, so the
    // authority stays where it belongs — once the ACP session starts, the agent re-advertises
    // the real list for the chosen model and the composer switches to it.
    effort: {
      kind: 'selectable',
      effortOptions: {
        low: { name: '低', description: '快速回应，推理较浅' },
        medium: { name: '中', description: '兼顾速度与推理深度，适合日常任务' },
        high: { name: '高', description: '更深的推理，适合复杂问题' },
        xhigh: { name: '极高', description: '超高推理深度，适合疑难问题' },
        max: { name: '最高', description: '最大推理深度，留给最难的问题' },
        ultracode: { name: 'UltraCode', description: '极高推理并按需编排动态工作流' },
      },
    },
    // ⚠️ 这张表的 id / 名字**逐字抄自 claude 2.1.229 自己经 ACP `session/new` 报上来的清单**
    //    (`category="model"` 的 configOptions),❌ 不再自己编 `claude-opus-4-8` 这类 API 全名:
    //    那套 id 这个 CLI 根本不认(原样透传、窗口回落 200K),而且没人维护、一发新模型就烂
    //    (owner 2026-09-15 真机看到「Opus 4.8」时 Opus 5 早就出了)。活目录读得到时以活目录为准,
    //    这张表只剩两个用途:说不上 ACP 的路径(终端腿 `--model` 的候选)与按模型查推理档。
    //    换 CLI 版本后请重新对一遍;整张静态表的长期去留见 #5014 讨论。
    models: {
      kind: 'selectable',
      userAllowlist: {
        scope: 'agent-home',
        file: '.claude/settings.json',
        pointer: '/availableModels',
        envVar: CLAUDE_NATIVE_HOME.envVar,
      },
      defaultModelId: 'default',
      modelOptions: {
        default: {
          name: 'Default (recommended)',
          effortIds: ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
        },
        'opus[1m]': {
          name: 'Opus (1M context)',
          modelFeatures: { intelligence: 5, speed: 2 },
          effortIds: ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
        },
        'claude-fable-5-1[1m]': {
          name: 'Fable',
          modelFeatures: { intelligence: 5, speed: 2 },
          effortIds: ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
        },
        sonnet: {
          name: 'Sonnet',
          modelFeatures: { intelligence: 4, speed: 4 },
          effortIds: ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
        },
        haiku: {
          name: 'Haiku',
          modelFeatures: { intelligence: 3, speed: 5 },
          effortIds: ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
        },
      },
    },
    // 与 `hooks.ts` 的 `claudeHookSpecs()` 真装的边一致(#5922):StopFailure → error、
    // PermissionRequest / 问题工具的 PreToolUse → wait、PostToolUse(Failure) → wait_resolved。
    hooks: {
      kind: 'config',
      scope: 'workspace',
      supportedEvents: ['start', 'notification', 'stop', 'error', 'wait', 'wait_resolved'],
      // hooks 不报打断(Esc):从这个版本起读 claude 自己的会话在场文件补这一条边(presence.ts)。
      presence: { sinceVersion: CLAUDE_PRESENCE_SINCE },
    },
    hostDependency: miseDependency({
      id: 'claude',
      package: '@anthropic-ai/claude-code',
      executables: {
        'win32-x64': 'claude.exe', 'win32-arm64': 'claude.exe',
        'darwin-x64': 'claude', 'darwin-arm64': 'claude',
        'linux-x64': 'claude', 'linux-arm64': 'claude',
      },
    }),
    mcp: {
      kind: 'supported',
      scope: 'global',
      supportedTransports: ['stdio', 'http'],
      toolNames: { kind: 'listed', prefix: 'mcp__plugin_gugu-product_gugu__', evidence: 'mac1 harness 会话存档里模型实际调用的工具名(#6192 盘点,2026-09-23):~/.claude/projects 的 tool_use.name `mcp__plugin_gugu-product_gugu__message_reply`(经 plugin-manifest 投递,server 名带插件前缀)' },
      // 会话通道与用户配置**合并**:claude 自己读它的每一层(用户级、本地级、项目级、插件),咕咕只经插件投递
      // 自己的那几台,`/mcp` 关掉的走 `disallowedTools`(session-bundle.ts)⇒ 咕咕不必也不该复述用户的 server。
      // 复述过来也没人读:插件那份清单跳过 `owner === 'user'`,`session/new.mcpServers` 恒为空,
      // 它们的 env / 地址 / Authorization 只会留在 claude 和它起的子进程环境里(复核 93 ②;
      // 10-07 资源库体检实测:不开 strict 时三层都在、各答各的)。
      sessionUserServers: 'inherit',
    },
    // agent memory —— claude 的专名文件 CLAUDE.md。
    // global 那条的原始理由是**咕咕自己已经在读它**:apps/desktop/electron/main.ts:1028 的
    // MEMORY_SOURCE_FILES 把 `~/.claude/CLAUDE.md` 内联进云 agent 创建载荷(@@@1422)。
    // project 三条按厂商官方文档补齐(https://code.claude.com/docs/en/memory 的
    // 「Choose where to put CLAUDE.md files」表):
    //   · Project instructions:`./CLAUDE.md` **或** `./.claude/CLAUDE.md`(两处都会被加载)
    //   · Local instructions:  `./CLAUDE.local.md`(同页:「loads alongside CLAUDE.md」)
    // ❌ 不登记 `.claude/rules/` 与 `~/.claude/rules/`:同页写明「All `.md` files are discovered
    //    **recursively**」,而 `AgentMemoryEntry` 的 directory 形态**只收顶层**
    //    (capabilities/memory.ts 里那段注释写死了)。登记它 = 承诺读全、实际只读一层,
    //    是静默截断。要接需要先给 core 的 capability 加一个递归 kind(在本次的禁改区),见报告。
    // ❌ 不登记 managed policy 的 `/etc/claude-code/CLAUDE.md` 一族:那是绝对路径,
    //    越出任何一个作用域根,`local-plugin-fs.ts` 的 resolveSafe 会直接抛。
    // ⚠️ `satisfies` 不是装饰:capability 的 schema 钉的是 `z.ZodType<AgentMemoryDescriptor>`,
    // 而 zod 4 的 `ZodType<Output>` 把 Input 留成 `unknown` —— 少了这一句,这段声明在类型上
    // 是**不受检**的(同 sessionBundle 用 `satisfies SessionBundleDescriptor` 的理由)。
    memory: {
      kind: 'files',
      entries: [
        { kind: 'file', scope: 'global', channel: 'vendor-file', path: '.claude/CLAUDE.md' },
        { kind: 'file', scope: 'project', channel: 'vendor-file', path: 'CLAUDE.md' },
        { kind: 'file', scope: 'project', channel: 'vendor-file', path: '.claude/CLAUDE.md' },
        { kind: 'file', scope: 'project', channel: 'vendor-file', path: 'CLAUDE.local.md' },
      ],
    } satisfies AgentMemoryDescriptor,
    prompt: {
      kind: 'argv',
      flag: '',
    },
    sessions: {
      kind: 'resumable',
      tuiResume: 'caller-id',
      // Verified: `claude --resume <src> --fork-session` lets Claude mint and report the
      // provider child id from system/init; the caller-owned conversation id is not an argv id.
      fork: 'supported',
      childId: 'provider-minted',
    },
    trust: {
      kind: 'supported',
      // 只进这一次 spawn 的 env,一个字节都不落盘 —— 见 ./trust.ts 的取证。
      channel: 'runtime-env',
    },
  },
  { icon },
);

export const provider = registerPluginBehavior(plugin, {
  sessionBundle: {
    platformModel,
    sessionTuiHostAdapter: 'claude-rendezvous-v1',
    materialize: materializeClaudeSessionBundle,
  },
  acp: {
    explainError: (cause) => {
      const models = plugin.capabilities.models;
      if (!/Invalid value for config option model/i.test(cause.message ?? '')
        || models.kind !== 'selectable' || !models.userAllowlist) return undefined;
      const { file, pointer } = models.userAllowlist;
      return `你的 ~/${file} ${pointer.slice(1).split('/').filter(Boolean).join('.')} 排除了该模型。`;
    },
    /**
     * ❌ 不用 ACP 的 `session/fork`:0.75.1 起它是**存储级**动作(0.81.1 的 `unstable_forkSession` 仍是 SDK forkSession + importSessionToStore) —— 只在 project 目录里分出
     * 一条、返回它的 id,**不建立也不登记 live 会话**(响应里连 `modes`/`models` 都没有了,
     * 0.38.0 是有的)。直接拿那个 id `session/prompt` 必答 `Session not found`;要用得再
     * `session/load` 一次,而那会在盘上留下一份 transcript —— 正是运行时分叉不能留的东西(#4230)。
     *
     * 改用 SDK 自己的 `resume` + `forkSession` —— 经 `_meta.claudeCode.options` 整体展开透传。
     * 语义与仓里那条「Verified」的 CLI 举证同源:`--resume <src> --fork-session`。
     *
     * 这条路在独立 adapter 进程中运行 —— Claude 在 system/init 里铸 child id，不能让来源
     * session 继续留在同一进程的会话表里。分叉带着 `persistSession: false`:来源会话
     * 回复照常、**一个字都不落盘**,重开不会把 side transcript 冒回会话列表。
     */
    forkViaNewSessionMeta: (sourceProviderSessionId: string) => ({
      claudeCode: { options: { resume: sourceProviderSessionId, forkSession: true } },
    }),
    // 模型目录探针只要清单:SDK 的 `strictMcpConfig` = 只用调用方给的 MCP(探针给的是空表),
    // 用户级、本地级、项目级、插件的一台都不起。适配器把 `_meta.claudeCode.options` 整体展开进 SDK
    // (@gugu-acp/claude-agent-acp 1.4.0 dist/acp-agent.js `...userProvidedOptions`)。
    // 10-17 mac1 实测(隔离 HOME,echo 账本):不带它起了 3 台、带它 0 台,`session/new` 照样回模型清单。
    catalogProbeSessionMeta: { claudeCode: { options: { strictMcpConfig: true } } },
    // 咕咕维护的构建 @gugu-acp/claude-agent-acp,按别名装在 @agentclientprotocol/claude-agent-acp 下;
    // 宿主按用户这份 Claude 的版本从配对表选版本,随包那份不合适就下载配对的那份(#6394)。
    bridge: {
      kind: 'package',
      alias: '@agentclientprotocol/claude-agent-acp',
      entry: 'dist/index.js',
      pairWith: 'claude',
    },
    buildSpawn: (ctx) => ({
      // @@@sessionpage claude-acp-node — 解释器在**要用它的这个进程里、这一刻**现解析，并把最低版本
      // 要求一起说出来（以桥接 package.json 的 engines 为准：Node ≥22，见 NODE_FOR_CLAUDE_ACP）。
      // ❌ 读一个别处、别的时刻塞进 process.env 的全局：那样「谁先跑」就成了正确性的前提 —— ACP worker
      // 是独立进程，env 是 spawn 那一刻的快照，宿主的赋值只要晚一步，这里就静悄悄回落到 Electron 自带的
      // Node 18，界面只剩一句 "ACP connection closed"。够不着就在这里响亮地说清楚要什么、试过谁。
      //
      // ⚠️ 这里**故意不传 ctx.env**（= agentEnv）：agentEnv 由宿主的白名单造出来（pty-env.ts `buildAgentEnv`），
      // `GUGU_NODE_BIN` 根本不在那份 allowlist 上。传 ctx.env 会让显式覆盖项静默失效，
      // PATH 一侧却一个字都不会变 —— 换句话说：只有坏处。挑出来的是绝对路径，子进程不需要它在 PATH 上。
      command: resolveNodeInterpreter({
        require: NODE_FOR_CLAUDE_ACP,
        purpose: 'claude 的 ACP adapter',
      }).command,
      executable: claudeExecutableForAdapter(ctx.cli),
      // 宿主按 `bridge` 声明解析好的桥:用户这份 Claude 的版本配对出来的那份,或随包的那份(#6394)。
      args: [requireBridgeEntry(ctx, 'claude')],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        // Point the adapter's Claude Agent SDK at the host-installed claude
        // binary instead of the SDK's auto-downloaded native binary.
        CLAUDE_CODE_EXECUTABLE: claudeExecutableForAdapter(ctx.cli),
        // 以 root 跑咕咕时,桥会把「完全访问」这一档整个不报 —— 取证与 A/B 见 ./root-bypass.ts。
        // 非 root 上返回 {},这一行什么都不加。
        ...claudeAcpRootBypassEnv(),
        // 桥只讲 v2:讲 v1 的客户端在握手处就被拒(-32022),❌ 不会悄悄退回 v1。
        CLAUDE_AGENT_ACP_PROTOCOL: 'v2',
      },
    }),
    // ACP v2:一轮在前台 idle 处结束,后台子智能体不再扣住这一轮的结局(子智能体在跑时下一句不进队列)。
    connect: connectStdioAcpV2,
    enrich: enrichClaudeUpdate,
  },
  auth: {
    checkStatus: claudeAuthStatus,
  },
  subscription: claudeSubscriptionBehavior(),
  prompt: {
    buildCommand: (ctx) => {
      const ultracode = ctx.effort === CLAUDE_ULTRACODE_EFFORT_ID;
      return buildStandardCommand({
        ...ctx,
        ...(ultracode
          ? {
              effort: undefined,
              extraArgs: [
                ...(ctx.extraArgs ?? []),
                '--settings',
                CLAUDE_ULTRACODE_SETTINGS,
              ],
            }
          : {}),
      }, {
        autoApproveFlag: '--dangerously-skip-permissions',
        // ⚠️ 每一档都显式给,❌ 不靠「不加 flag」:不加 flag 时 claude 自己挑启动档 ——
        // settings 的 `permissions.defaultMode`,再没有就用账号组织的默认档(2.1.293 在 Max 账号上实测是 `auto`)。
        // 只读档于是会静默变成 auto,比用户所选更松。
        readOnlyFlag: '--permission-mode default',
        editFlag: '--permission-mode acceptEdits',
        // 规划档。❌ 不能拿「不加 flag」(= default = 只读)顶替:只读允许 agent 动手做
        // 只读的事,规划连动手的意图都不产生,只产出方案 —— 顶替会让选了规划的用户拿到只读行为。
        planFlag: '--permission-mode plan',
        initialPromptFlag: '',
        resumeFlag: '--resume',
        cliSessionIdFlag: '--session-id',
        cliSessionIdOnFork: false,
        forkFlag: '--fork-session',
        modelFlag: '--model',
        // `--effort <level>` — "Effort level for the current session" (claude --help 2.1.220).
        effortFlag: '--effort',
      });
    },
  },
  hooks: buildClaudeHookConfig(),
  mcp: claudeMcpAdapter(),
  trust: buildClaudeTrustBehavior(),
});

export {
  CLAUDE_GUGU_CAPABILITY_PACKAGE,
  claudeSessionBundleDescriptor,
  materializeClaudeSessionBundle,
};
