import { platformModel } from './platform-model';
import { resolveSessionPermissionMode } from '@gugu/session-core/acp';
import {
  definePlugin,
  registerPluginBehavior,
  type AgentMemoryDescriptor,
} from '@gugu/session-core/agents/plugins';
import {
  materializeMimocodeSessionBundle,
  MIMOCODE_GUGU_EVENT_MODULE_PATH,
  mimocodeSessionBundleDescriptor,
} from './session-bundle';
import {
  buildStandardCommand,
  createFileDropPlugin,
  miseDependency,
  BARE_VERSION_LINE,
} from '@gugu/session-core/agents/plugins/helpers';
import { createNativeAcpBehavior } from '../../helpers/acp-stdio';
import { mimocodeAuthStatus, mimocodeModelCredential } from './auth';
import { MIMOCODE_EFFORT_OPTIONS } from './efforts';
import { opencodeFamilyListedTitle } from '../../helpers/opencode-family-title';
import { icon } from './icon';
import { mimocodeSubscription } from './subscription';
import { MIMOCODE_PLUGIN_CONTENT } from './plugin-file';
import { buildMimocodeTrustBehavior } from './trust';
import { mimocodeFailureFromStderrLine } from './turn-failure';
import { mimocodeMcpAdapter } from './mcp';

export { MIMOCODE_EFFORT_OPTIONS } from './efforts';
export { MIMOCODE_GUGU_EVENT_MODULE_PATH } from './session-bundle';

// MiMoCode session ids match `^ses.*` (inherited from its OpenCode base). The
// guard prevents resuming with the session-page conversation UUID that
// `conversation.sessionId` is seeded with before the first native id is captured.
const validateProviderSessionId = (id: string) => id.startsWith('ses');

const sessionBundle = mimocodeSessionBundleDescriptor;

export const plugin = definePlugin(
  {
    id: 'mimocode',
    name: 'MiMo Code',
    description:
      "Xiaomi's terminal-native coding agent with persistent cross-session memory and OpenAI-compatible provider support.",
    websiteUrl: 'https://github.com/XiaomiMiMo/MiMo-Code',
  },
  {
    sessionBundle,
    /**
     * 厂商账号是不是硬门槛 —— 判据与陷阱见 `capabilities/vendor-account.ts` 抬头。
     * 这一格是**实测**出来的，❌ 不收「文档写着」。
     */
    vendorAccount: {
      kind: 'not-required',
      evidence:
        '只给 MIMOCODE_CONFIG_CONTENT 里的自定义 provider、零厂商凭据，`mimo run` exit=0，假端点收到 chat/completions',
    },
    // 「订阅」页(product spec):按 key 前缀分按量 / Token Plan;余量只在小米后台(./subscription.ts)。
    subscription: { kind: 'supported', usageRefresh: 'on-open' },
    /**
     * 登录方式(#6100)。opencode 的逐字节 fork,登录子命令同形 —— 本机 mimo 0.1.13
     * `mimo auth --help` 逐字:
     *   `mimo auth login [url]  log in to a provider`
     * (同一份输出里还有 list / logout / whoami,与 `./auth.ts` 复用 opencode 家族判据的理由同源。)
     *
     * 从前这里是缺省的 `kind: 'none'`,而 `behavior.auth` 却登记着 checkStatus —— 那是一格
     * **读不到的判据**:`checkAuthStatusUncached` 见 `auth.kind === 'none'` 直接答 `unknown`,
     * 行为一次都跑不到。声明补齐之后它才真的被问。
     */
    auth: {
      kind: 'supported',
      methods: [
        {
          kind: 'cli-login',
          id: 'mimocode-login',
          name: 'Sign in with MiMo Code',
          args: ['auth', 'login'],
          description: 'Open the MiMo Code CLI sign-in flow in a terminal.',
        },
      ],
    },
    acp: {
      kind: 'supported',
      // MiMo ACP 0.1.13 exposes model and mode as session config options. The host applies
      // both during startup, so omitting this declaration makes every configured session fail
      // before its first request with LiveSettingUndeclared. Effort remains a process-config
      // model variant, not an ACP setting.
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
    /**
     * 推理强度 —— 三档 `low/medium/high`,**不是编出来的**:档位清单、它在配置文档里的形状、
     * 以及「为什么这一家能声明而 opencode 不能」,逐条一手出处见 `./efforts.ts` 抬头。
     * 一句话版:这一家的 ACP 没有 `thought_level` 轴(整仓 0 命中),深浅是模型的 `variant`,
     * 而 `variants` 正是咕咕已经在写的那份配置文档里的合法字段,显式声明会 merge 在派生表**之上**
     * (`provider/provider.ts:1427`/`:1592`),所以那条 `!capabilities.reasoning` 早退和
     * `glm`/`kimi`/`qwen` 子串黑名单都绕得过去。
     *
     * ⚠️⚠️ **悬案:网关认不认 `reasoning_effort` 这个 body 参数,只有发一次真请求核真实账单才算数。**
     * 目前查到的一手读数(2026-08-27,源码,不是文档转述):
     *  · 官方网关基于开源 New API;其 `dto/openai_request.go:39` 有
     *    `ReasoningEffort string \`json:"reasoning_effort,omitempty"\`` —— 它**收**这个 body 参数;
     *    `relay/channel/openai/adaptor.go:348-355` 里模型名后缀(`-high`/`-low`)只是**另一个入口**,
     *    最终写的是同一个字段,没有后缀时 body 里的值原样生效并记进
     *    `service/log_info_generate.go:82` 的账单 other 字段。
     *  · 各家上游由 New API 自己翻译:Claude 走
     *    `service/relayconvert/internal/oai_chat/to_claude_messages_req.go:177-195`,
     *    Gemini 走 `shared/gemini/request.go:133`,DeepSeek/xAI 各有一格。
     * ⇒ 「文档只写模型名后缀」这条**在源码上被证伪**了。但 d15 发不出真请求,所以「这一档最终有没有
     *    改变账单上的推理 token」仍未取证。
     *
     * ⚠️ **降级行为(必须知道)**:这条链上**没有一处会响亮失败**。上面那个 Claude switch 只认
     *    `low`/`medium`/`high`,别的取值一声不吭地不设 thinking;`llm.ts:482` 对模型上没有的 variant
     *    也是静默空合并。这正是把词表钉死在这三档、并让物化层对**词表外**的档位当场抛错
     *    (`openCodeFamilyReasoningEntry`)的理由 —— 咕咕这一侧能判的都判掉,判不了的(上游模型
     *    究竟理不理这个参数)如实留在这里。
     */
    effort: {
      kind: 'selectable',
      effortOptions: MIMOCODE_EFFORT_OPTIONS,
    },
    autoApprove: {
      kind: 'supported',
    },
    hooks: {
      kind: 'plugin',
      scope: 'workspace',
      supportedEvents: ['notification', 'stop', 'session'],
    },
    // 托管安装:`@mimo-ai/cli` 的 bin 是启动器,程序体在 `@mimo-ai/mimocode-<platform>-<arch>`
    // 里(六格齐全,归档内 `bin/mimo`;包名从 `cli` 换成了 `mimocode`,`win32` 叫 `windows`)。
    // ❌ 厂商的 curl / powershell 脚本不再作为产品内装法(#6098)。
    hostDependency: { ...miseDependency({
      id: 'mimo',
      package: '@mimo-ai/cli',
      installDocs: 'https://github.com/XiaomiMiMo/MiMo-Code#quick-start',
      platformPackages: {
        'darwin-x64': '@mimo-ai/mimocode-darwin-x64', 'darwin-arm64': '@mimo-ai/mimocode-darwin-arm64',
        'linux-x64': '@mimo-ai/mimocode-linux-x64', 'linux-arm64': '@mimo-ai/mimocode-linux-arm64',
        'win32-x64': '@mimo-ai/mimocode-windows-x64', 'win32-arm64': '@mimo-ai/mimocode-windows-arm64',
      },
      executables: {
        'darwin-x64': 'bin/mimo', 'darwin-arm64': 'bin/mimo',
        'linux-x64': 'bin/mimo', 'linux-arm64': 'bin/mimo',
        'win32-x64': 'bin/mimo.exe', 'win32-arm64': 'bin/mimo.exe',
      },
    }), versionLine: BARE_VERSION_LINE },
    mcp: {
      kind: 'supported',
      scope: 'global',
      supportedTransports: ['stdio', 'http'],
      toolNames: { kind: 'listed', prefix: 'gugu_', evidence: 'mac1 harness 会话存档里模型实际调用的工具名(#6192 盘点,2026-09-23):~/.local/share/mimocode/mimocode.db 的工具名 `gugu_message_reply`' },
    },
    // agent memory —— MiMo Code 是 opencode 的下游分叉(会话 id 前缀 `ses` 那条注释同源),
    // 记忆入口沿用 AGENTS.md 约定,只是把配置目录改成了自己的名字。逐条出处
    // (XiaomiMiMo/MiMo-Code@0e5bf7b3c500b0708ad0999df5efd7d910508aa3):
    //  · `packages/opencode/src/session/instruction.ts` —— `systemPaths()` 先 `fs.findUp('AGENTS.md',
    //    ctx.directory, ctx.worktree)` 取项目层;`globalFiles()` 推 `path.join(Global.Path.config,
    //    'AGENTS.md')` 取用户层。
    //  · `packages/shared/src/global.ts` —— `resolveMimocodeHome()` 的 xdg 分支是
    //    `path.join(xdgConfig, 'mimocode')`,即 `~/.config/mimocode`。与本仓
    //    `mimocodeMcpAdapter()` 默认扫的 `.config/mimocode/mimocode.json` 同一目录,互为佐证。
    // ⚠️ 故意**不**登记两条 Claude Code 兼容回退(项目 `CLAUDE.md`、用户 `~/.claude/CLAUDE.md`,
    //    同文件 FILES/globalFiles 里由 `MIMOCODE_DISABLE_CLAUDE_CODE_PROMPT` 开关):它们是
    //    条件回退(仅在 AGENTS.md 缺失/过短时才生效),登记进来会让用户的 Claude 记忆显示成
    //    「MiMo 的记忆」。要收它们得先定「回退入口怎么标注」,那是产品决定。
    // ⚠️ `satisfies` 不是装饰:capability 的 schema 钉的是 `z.ZodType<AgentMemoryDescriptor>`,
    //    zod 4 把 Input 留成 `unknown` —— 少了这一句,这段声明在类型上不受检。
    memory: {
      kind: 'files',
      entries: [
        { kind: 'file', scope: 'global', channel: 'agents-md', path: '.config/mimocode/AGENTS.md' },
        { kind: 'file', scope: 'project', channel: 'agents-md', path: 'AGENTS.md' },
      ],
    } satisfies AgentMemoryDescriptor,
    plugins: {
      kind: 'file-drop',
      scope: 'workspace',
    },
    prompt: {
      kind: 'argv',
      flag: '--prompt',
      // The session-TUI pty only renders `mimo attach`; the host-owned `mimo serve` session
      // consumes both the initial and subsequent user messages over its HTTP control channel.
      startupDelivery: 'delivery-bridge',
    },
    sessions: {
      kind: 'resumable',
      tuiResume: 'provider-id',
    },
    // #4834 归运行时注入时这一格曾是 `none`(first-run-state 的载体就是托管配置根,随影子 home
    // 一起退场)—— 代价是首装态 TUI 腿卡死在无人应答的信任门上,首句永远不到(#4975)。
    // 运行时通道后来在引擎自己的 CLI 面上找到了:`--trust`(取证与正当性举证见 ./trust.ts)。
    trust: { kind: 'supported', channel: 'runtime-argv' },
  },
  { icon }
);

export const provider = registerPluginBehavior(plugin, {
  sessionBundle: { materialize: materializeMimocodeSessionBundle, platformModel },
  subscription: mimocodeSubscription,
  // 两件事:#4956 默认预选规则的 modelCredential 判读,以及与 opencode 同形的
  // `mimo auth list` 登录态读数 —— 后者从 #6100 起真的会被问到(capabilities.auth 已声明)。
  auth: {
    checkStatus: mimocodeAuthStatus,
    modelCredential: mimocodeModelCredential,
  },
  acp: {
    ...createNativeAcpBehavior(() => ({
      // `--print-logs` 只为让失败的回合有一句真因(它不打这句就是 0 token 的 end_turn,见 ./turn-failure.ts);
      // `--log-level ERROR` 把 stderr 压到只剩报错。
      args: ['acp', '--print-logs', '--log-level', 'ERROR'],
    })),
    sessionTitleFromList: opencodeFamilyListedTitle,
    turnFailure: { fromStderrLine: mimocodeFailureFromStderrLine },
  },
  prompt: {
    buildCommand: (ctx) =>
      buildStandardCommand(ctx, {
        extraEnv: resolveSessionPermissionMode(ctx) === 'full-access' ? { MIMOCODE_PERMISSION: '{"*":"allow"}' } : {},
        // 推理档在这一家叫 model variant —— `cli/cmd/run.ts:295` 的 `--variant`,help 原文
        // 「model variant (provider-specific reasoning effort, e.g., high, max, minimal)」。
        // ⚠️ 只有旗标是不够的:`session/llm.ts:482` 查的是**模型自己**的 `variants` 表,
        //    模型上没有那一档就静默合个空对象。那张表由 `MIMOCODE_FAMILY_MODEL_SPEC
        //    .reasoningVariants` 一起写进 `MIMOCODE_CONFIG_CONTENT`,两者缺一不可。
        effortFlag: '--variant',
        initialPromptFlag: '--prompt',
        resumeFlag: '--session',
        cliSessionIdFlag: '--session',
        cliSessionIdOnResumeOnly: true,
        resumeWithoutSessionFlag: '--continue',
        validateProviderSessionId,
      }),
  },
  sessions: { validateProviderSessionId },
  mcp: mimocodeMcpAdapter(),
  trust: buildMimocodeTrustBehavior(),
  plugins: createFileDropPlugin({
    relativePath: MIMOCODE_GUGU_EVENT_MODULE_PATH,
    content: MIMOCODE_PLUGIN_CONTENT,
    legacyRelativePaths: ['.mimocode/plugins/emdash-notifications.js'],
  }),
});
