import { platformModel } from './platform-model';
import { resolveSessionPermissionMode } from '@gugu/session-core/acp';
import {
  definePlugin,
  registerPluginBehavior,
  type AgentMemoryDescriptor,
} from '@gugu/session-core/agents/plugins';
import {
  buildStandardCommand,
  createFileDropPlugin,
  miseDependency,
  BARE_VERSION_LINE,
} from '@gugu/session-core/agents/plugins/helpers';
import { connectStdioAcp } from '../../helpers/acp-stdio';
import { opencodeAuthStatus, opencodeModelCredential } from './auth';
import { OPENCODE_PLUGIN_CONTENT } from './plugin-file';
import {
  materializeOpencodeSessionBundle,
  opencodeCredentialLifecycle,
  OPENCODE_GUGU_EVENT_MODULE_PATH,
  opencodeSessionBundleDescriptor,
} from './session-bundle';
import {
  effortOptionsFromReasoningVariants,
  OPENCODE_REASONING_VARIANTS,
} from '../../helpers/opencode-family-model-config';

const validateProviderSessionId = (id: string) => id.startsWith('ses');
import { opencodeFamilyListedTitle } from '../../helpers/opencode-family-title';
import { opencodeScopedMcpAdapter } from './mcp-scopes';
import { icon } from './icon';
import { opencodeSubscription } from './subscription';
import { OPENCODE_PERMISSION_MODES } from './permission-modes';

export const plugin = definePlugin(
  {
    id: 'opencode',
    name: 'OpenCode',
    description:
      'OpenCode CLI that interfaces with models for code generation and edits from the shell.',
    websiteUrl: 'https://opencode.ai/docs/cli/',
  },
  {
    sessionBundle: opencodeSessionBundleDescriptor,
    /**
     * 厂商账号是不是硬门槛 —— 判据与陷阱见 `capabilities/vendor-account.ts` 抬头。
     * 这一格是**实测**出来的，❌ 不收「文档写着」。
     */
    vendorAccount: {
      kind: 'not-required',
      evidence:
        '只给 OPENCODE_CONFIG_CONTENT 里的自定义 provider、零厂商凭据，`opencode run` exit=0，假端点收到 chat/completions',
    },
    // 「订阅」页(product spec):读 auth.json 判谁付钱;余量只在 OpenCode 控制台(./subscription.ts)。
    subscription: { kind: 'supported', usageRefresh: 'on-open' },
    acp: {
      kind: 'supported',
      startup: { noticeKey: 'chat.opencodePreparing' },
      /**
       * 三维**全部是热的** —— 这一格曾整块声明成 `reload-session`,而那是**声明出来的,不是量出来的**,
       * 并且实测推翻了它。代价是我们照着那句错声明给用户造了一条死路:界面告诉他「必须先重启会话」,
       * 而重启这件事本身没有任何地方做得到(owner 2026-09-13 在产品里撞到)。
       *
       * 实测(2026-09-13,mac1,opencode-ai 1.18.25,真咕咕网关令牌 + 产品同款
       * `OPENCODE_CONFIG_CONTENT`,裸 ACP 客户端,**同一条活会话**、不重启不恢复):
       * `session/new` 自己就把三样报成 config option ——
       *   `model`(category=model) · `effort`(category=thought_level) · `mode`(category=mode)
       *  · **model**:`set_config_option` 接受平台限定值并读回(`gugu-platform/<id>`);
       *    而且它**真的决定上游路由** —— 同一条会话上来回切、每次发一句:
       *    `glm-5` OK → `gpt-5.4` 上游 429 → 换回 `glm-5` **又 OK** → `glm-5.2` OK。
       *    失败随模型来、随模型走且可逆 ⇒ 送上去的就是这条会话当前那个值,不是启动时钉死的。
       *  · **effort**:接受并读回 `high` / `low`。
       *  · **mode(权限档)**:接受并读回 `plan` / `build`,而且是**行为**读数不是字符串读数 ——
       *    同一句「用写工具建这个文件」,`plan` 下文件**没被建出来**、`build` 下**建出来了**。
       *
       * ⚠️ `ack: 'ack-read-back'` 是有意选最严的那一档:三维都实测读得回来,所以「提供者悄悄
       * 没生效」必须响亮失败(`cell.confirmSettingResponse` 会据此拒),❌ 不要降成 `'ack'`。
       *
       * ⚠️ `permission.allowStartupDowngrade` **故意保留**(它原名 `startupOnly`,名字像是在说
       * 「只能启动时设」,与同一对象里 `channel: 'acp-config-option'` 正面矛盾 ⇒ 同刀按其唯一
       * 读者改名)。它管的是**启动期档位对不上时能不能降档启动**,不是「这一维能不能热改」。
       * opencode 只报 build/plan、完全访问由会话包在 spawn 那刻兑现,拿掉它会把那几处 warn
       * 变成 throw —— 那是另一件事、也没有读数支持。⇒ 这次只改「热不热」,不动降档策略。
       *
       * ❌ `reload-session` 这个档本身不要删:qwen 的 model 在 ACP 腿上只 advertise 注入的那一条,
       *    热切被拒、重开才换得成(#6182 实测)。要死的是「opencode 这三维是 reload-session」这句话,不是那个档。
       */
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
          // 见上:这一格管的是启动期降档,与「能不能热改」无关。
          allowStartupDowngrade: true,
        },
        effort: {
          channel: 'acp-config-option',
          ack: 'ack-read-back',
          busy: 'reject',
          reloadRequired: false,
          recovery: 'none',
        },
      },
    },
    effort: {
      kind: 'selectable',
      // The option ids are derived from the same payload table that is emitted into
      // OPENCODE_CONFIG_CONTENT; labels are localized by the renderer.
      effortOptions: effortOptionsFromReasoningVariants(OPENCODE_REASONING_VARIANTS),
      resetId: 'default',
    },
    autoApprove: {
      kind: 'supported',
      // opencode 1.18.16 真机 ACP(`opencode acp` → session/new 的 configOptions
      // category:'mode')**只上报两档**,原文照录:
      //   build — "The default agent. Executes tools based on configured permissions."
      //   plan  — "Plan mode. Disallows all edit tools."
      // 所以它有规划档、没有只读档 —— 界面据此只摆它真有的那些,❌ 不为凑数补一个假只读。
      // ⚠️ 完全访问不是它的一个 mode,而是 permission 规则。所以它不在这张
      //    「ACP 自报档位」表里 —— 这张表只登记它真上报的两档,❌ 不为凑数补一格假的。
      //    两条腿各自兑现:
      //      · TUI 腿 —— 下面 sessionTui 的 `OPENCODE_PERMISSION={"*":"allow"}`
      //      · ACP 腿 —— 2026-08-25 起由 session-bundle 的 `units.autonomy` 兑现:
      //        把 `permission` 写进 `OPENCODE_CONFIG_CONTENT`
      //        (session-bundle.ts + helpers/opencode-family-permission-config.ts)。
      //    ⇒ 「ACP 那条路给不了完全访问」这个曾登记在案的缺口已经关闭。
      modes: OPENCODE_PERMISSION_MODES,
    },
    auth: {
      kind: 'supported',
      methods: [
        {
          kind: 'cli-login',
          id: 'opencode-login',
          name: 'Sign in with OpenCode',
          args: ['auth', 'login'],
          // 别的机器上照样是它:终端里挑提供方,各家走贴码 / 设备码 / 填 key(anomalyco/opencode#8274:
          // VPS 上 TUI 的 /connect 回跳 localhost 失败,而 `opencode auth login` 能完成)。
          headlessArgs: ['auth', 'login'],
          description: 'Open the OpenCode CLI sign-in flow in a terminal.',
        },
        {
          kind: 'api-key',
          id: 'provider-api-key',
          name: 'Use provider API keys',
          envVars: [
            { name: 'ANTHROPIC_API_KEY', label: 'Anthropic API key' },
            { name: 'OPENAI_API_KEY', label: 'OpenAI API key' },
            { name: 'GEMINI_API_KEY', label: 'Gemini API key' },
          ],
        },
      ],
    },
    hooks: {
      kind: 'plugin',
      scope: 'workspace',
      supportedEvents: ['notification', 'stop', 'session'],
    },
    // 托管安装:`opencode-ai` 的 bin 是个启动器,程序体在 `opencode-<platform>-<arch>` 里
    // (六格齐全,归档内 `bin/opencode`;bun 编的那一族把 `win32` 叫 `windows`)。
    hostDependency: { ...miseDependency({
      id: 'opencode',
      package: 'opencode-ai',
      platformPackages: {
        'darwin-x64': 'opencode-darwin-x64', 'darwin-arm64': 'opencode-darwin-arm64',
        'linux-x64': 'opencode-linux-x64', 'linux-arm64': 'opencode-linux-arm64',
        'win32-x64': 'opencode-windows-x64', 'win32-arm64': 'opencode-windows-arm64',
      },
      executables: {
        'darwin-x64': 'bin/opencode', 'darwin-arm64': 'bin/opencode',
        'linux-x64': 'bin/opencode', 'linux-arm64': 'bin/opencode',
        'win32-x64': 'bin/opencode.exe', 'win32-arm64': 'bin/opencode.exe',
      },
    }), versionLine: BARE_VERSION_LINE },
    mcp: {
      kind: 'supported',
      scope: 'global',
      supportedTransports: ['stdio', 'http'],
      toolNames: { kind: 'listed', prefix: 'gugu_', evidence: 'mac1 harness 会话存档里模型实际调用的工具名(#6192 盘点,2026-09-23):~/.local/share/opencode/opencode.db 的工具名 `gugu_message_reply`' },
      // 会话通道与用户配置**合并**:`OPENCODE_CONFIG_CONTENT` 只叠咕咕自己那几台与关闭位,
      // 用户 `~/.config/opencode/opencode.json` 里那几台照常装载 ⇒ 不必复述。
      sessionUserServers: 'inherit',
    },
    // agent memory —— opencode 管这一族叫 **rules**,官方文档 https://opencode.ai/docs/rules
    // 的「Types」一节把两层写死:
    //  · Project —— 仓根 `AGENTS.md`;
    //  · Global  —— `~/.config/opencode/AGENTS.md`。
    // 源码同处(anomalyco/opencode@2a6be0a03b93a6734070e10a6c3b56863475f214,
    // `packages/web/src/content/docs/rules.mdx` 即该页正文;`packages/opencode/src/session/instruction.ts`
    // 是实现)。
    // ⚠️ 故意**不**登记 Claude Code 兼容回退(项目 `CLAUDE.md`、全局 `~/.claude/CLAUDE.md`):
    //    同页写明它们只在对应的 AGENTS.md 缺席时才顶上,且可由 `OPENCODE_DISABLE_CLAUDE_CODE*`
    //    关掉。登记进来会把用户的 Claude 记忆显示成「opencode 的记忆」。
    // ⚠️ 也不登记 `opencode.json` 的 `instructions` 数组:那是用户配置里的任意 glob / 远程 URL,
    //    不是静态相对路径,本 descriptor 表达不了。
    // ⚠️ `satisfies` 见 memory.ts 的说明:schema 钉的是 `z.ZodType<…>`,漏了这句本段不受类型检查。
    memory: {
      kind: 'files',
      entries: [
        { kind: 'file', scope: 'global', channel: 'agents-md', path: '.config/opencode/AGENTS.md' },
        { kind: 'file', scope: 'project', channel: 'agents-md', path: 'AGENTS.md' },
      ],
    } satisfies AgentMemoryDescriptor,
    plugins: {
      kind: 'file-drop',
      scope: 'workspace',
    },
    // 如实标缺:本家没有已知的「把工作区标成可信」的通道 —— 引擎自己问一次(或它压根不问)。
    // ⚠️ 这一格没有默认值(owner 2026-09-03「强类型,不存在灰色地带」):写出来的是一句
    //    说过的话,❌ 不是省略。真查到通道了就改成 `{ kind: 'supported', channel: … }`。
    trust: { kind: 'none' },
    prompt: {
      kind: 'argv',
      flag: '--prompt',
      // serve/attach:用户看的 pty 只跑 `attach <url> --session <id>`,argv 无 prompt 槽 ⇒
      // 首轮不烤进 spawn,与 codex app-server 同类,经宿主 bridge/router 投递(见
      // providerConsumesStartupPrompt 与 [[opencode-serve-attach-readiness]])。acp 腿另有原生通道。
      startupDelivery: 'delivery-bridge',
    },
    sessions: {
      kind: 'resumable',
      tuiResume: 'provider-id',
      // Context7 official OpenCode SDK/TUI sources define fork as `client.session.fork({
      // sessionID, messageID? })`, backed by HTTP `POST /session/{id}/fork`:
      // https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/session.ts
      // https://github.com/anomalyco/opencode/blob/dev/packages/tui/src/routes/session/dialog-fork-from-timeline.tsx
      // Gugu's session-TUI host calls that HTTP endpoint; ACP's `unstable_forkSession` is deliberately not used.
      fork: 'supported',
    },
  },
  { icon }
);

export const provider = registerPluginBehavior(plugin, {
  sessionBundle: { materialize: materializeOpencodeSessionBundle, platformModel },
  subscription: opencodeSubscription,
  auth: {
    checkStatus: opencodeAuthStatus,
    // #4956 —— composer 默认预选规则的判读:自家默认(如 opencode/big-pickle 的 Zen provider)
    // 判得出无凭据时,新会话默认预选落到咕咕平台模型。判法见 helpers/opencode-family-credential.ts。
    modelCredential: opencodeModelCredential,
  },
  acp: {
    sessionTitleFromList: opencodeFamilyListedTitle,
    async resolveForkSource({ sourceProviderSessionId, sourceSession, sourceConnection, host }) {
      const endpoint = sourceSession.providerSessionEndpoint?.replace(/\/$/, '')
      if (endpoint) {
        const path = `/session/${encodeURIComponent(sourceProviderSessionId)}/fork`
        const response = await fetch(`${endpoint}${path}`, { method: 'POST' })
        const body = await response.text()
        if (!response.ok) {
          throw new Error(
            `OpenCode runtime fork POST ${path} failed (${response.status}): ${body || '<empty response>'}`,
          )
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(body)
        } catch {
          throw new Error(`OpenCode runtime fork POST ${path} returned invalid JSON: ${body || '<empty response>'}`)
        }
        const id = typeof parsed === 'object' && parsed !== null && typeof (parsed as { id?: unknown }).id === 'string'
          ? (parsed as { id: string }).id
          : ''
        if (!id.startsWith('ses_')) {
          throw new Error(`OpenCode runtime fork POST ${path} returned no session id: ${body || '<empty response>'}`)
        }
        return { loadProviderSessionId: id }
      }

      // OpenCode 1.18.25 ships ACP's unstable session/fork even though the protocol marks it
      // experimental. A acp parent has no serve endpoint, so this call must stay on the
      // parent's live connection; the runtime will load the returned id in a new private adapter.
      if (!sourceConnection) {
        throw new Error(
          `OpenCode runtime fork requires the parent ACP connection for session ${sourceSession.id}; `
            + 'no live source connection is available (OpenCode 1.18.25 unstable session/fork)',
        )
      }
      if (!sourceConnection.supportsForkSession || !sourceConnection.agent.unstable_forkSession) {
        throw new Error(
          `OpenCode runtime fork requires sessionCapabilities.fork on the parent ACP connection `
            + `(OpenCode 1.18.25 unstable session/fork) for session ${sourceSession.id}`,
        )
      }
      const forked = await sourceConnection.agent.unstable_forkSession({
        cwd: host.cwd,
        sessionId: sourceProviderSessionId,
        mcpServers: [],
      })
      const id = typeof forked?.sessionId === 'string' ? forked.sessionId : ''
      if (!id.startsWith('ses_')) {
        throw new Error(
          `OpenCode runtime ACP session/fork returned no session id for session ${sourceSession.id}`,
        )
      }
      return { loadProviderSessionId: id }
    },
    buildSpawn: (ctx) => {
      const credentialLifecycle = opencodeCredentialLifecycle('acp');
      if (credentialLifecycle.delivery !== 'credential-proxy' || credentialLifecycle.recovery !== 'reopen') {
        throw new Error('OpenCode acp credential lifecycle does not match OPENCODE_CONFIG_CONTENT');
      }
      return {
        command: ctx.cli,
        args: ['acp'],
        env: ctx.platform ? { ...ctx.platform.spawnEnv } : undefined,
      };
    },
    connect: (io, toClient) => {
      return connectStdioAcp(io, toClient);
    },
  },
  prompt: {
    buildCommand: (ctx) =>
      buildStandardCommand(ctx, {
        extraEnv: resolveSessionPermissionMode(ctx) === 'full-access' ? { OPENCODE_PERMISSION: '{"*":"allow"}' } : {},
        // `--agent plan` 选中 opencode 的 plan agent(禁掉全部 edit 工具)。
        // ❌ 不能靠"不加 flag"顶替:不加就是 build,那是可写档。
        planFlag: '--agent plan',
        initialPromptFlag: '--prompt',
        modelFlag: '--model',
        resumeFlag: '--session',
        cliSessionIdFlag: '--session',
        cliSessionIdOnResumeOnly: true,
        resumeWithoutSessionFlag: '--continue',
        // The sessionpage host forks through serve HTTP and replaces the visible attach argv.
        forkHandledByHost: true,
        validateProviderSessionId,
      }),
  },
  sessions: { validateProviderSessionId },
  mcp: opencodeScopedMcpAdapter(),
  plugins: createFileDropPlugin({
    relativePath: OPENCODE_GUGU_EVENT_MODULE_PATH,
    content: OPENCODE_PLUGIN_CONTENT,
    legacyRelativePaths: ['.opencode/plugins/emdash-notifications.js'],
  }),
});

export {
  OPENCODE_PLUGIN_CONTENT,
} from './plugin-file';
export {
  materializeOpencodeSessionBundle,
  OPENCODE_GUGU_CAPABILITY_PACKAGE,
  OPENCODE_GUGU_EVENT_MODULE_PATH,
  OPENCODE_GUGU_PACKAGE_ID,
  OPENCODE_GUGU_PACKAGE_VERSION,
  opencodeSessionBundleDescriptor,
} from './session-bundle';
