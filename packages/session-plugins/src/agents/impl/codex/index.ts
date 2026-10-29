import { platformModel } from './platform-model';
import {
  definePlugin,
  registerPluginBehavior,
  type AgentAuthContext,
  type AgentAuthStatus,
  type AgentMemoryDescriptor,
  type SessionBundleDescriptor,
} from '@gugu/session-core/agents/plugins';
import type { AcpPlatformInjection } from '@gugu/session-core/acp';
import {
  CODEX_ACP_MCP_DEDUP_ENV,
  CODEX_GUGU_CAPABILITY_PACKAGE,
  CODEX_ACP_MINIMUM_VERSION,
  codexSessionBundleDescriptor,
  codexCredentialLifecycle,
  codexProjectTrustArgs,
  GUGU_CODEX_MCP_CONFIG_ENV,
  GUGU_CODEX_NOTIFY_CONFIG_ENV,
  materializeCodexSessionBundle,
} from './session-bundle';
import {
  buildStandardCommand,
  miseDependency,
} from '@gugu/session-core/agents/plugins/helpers';
import { connectStdioAcp } from '../../helpers/acp-stdio';
import { requireBridgeEntry } from '../../helpers/acp-bridge-entry';
import { authenticatedFromEnv, commandAuthStatus } from '../../helpers/auth';
import {
  buildCodexHookConfig,
  codexNotifyConfigValue,
  makeCodexNotifyConfigOverride,
} from './hooks';
import { icon } from './icon';
import { CODEX_EFFORT_OPTIONS } from './efforts';
import { codexPlatformModelFacts, GUGU_PLATFORM_MODELS_ENV } from './platform-models';
import { enrichCodexUpdate } from './acp-transform';
import { codexPlatformProviderConfigArgs } from './platform-provider-args';
import { CODEX_PERMISSION_MODES } from './permission-modes';
import { codexCredentialInfo } from './auth';
import { codexSubscriptionBehavior } from './subscription';
import { codexScopedMcpAdapter } from './mcp-scopes';
import { CODEX_WIRE_API } from './platform';

/**
 * 读物化器递过来的关闭集合。**坏值一律当空**,❌ 不抛:
 * 这一格在 spawn 路径上,抛出去的表现是"这条会话打不开",而用户什么都没做错。
 * 而漏掉一次关闭的表现是"开关这一次没生效" —— 后者可恢复,前者不可。
 */
function parseMcpFragment(raw: string | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function codexBinaryForSpawn(ctx: { cli: string; env: Record<string, string> }): string {
  return ctx.env.GUGU_CODEX_BIN?.trim() || ctx.cli;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function codexAppServerPlatformArgs(platform: AcpPlatformInjection): string[] {
  const args = ['-c', `model=${tomlString(platform.model)}`];
  if (platform.contextWindow) args.push('-c', `model_context_window=${platform.contextWindow}`);
  args.push(...codexPlatformProviderConfigArgs({
    providerId: platform.providerId,
    providerName: platform.providerLabel,
    baseUrl: platform.baseUrl,
    // #6921 与 app-server 腿(session-bundle 的 modelArgs)同一个开关:这份 argv 经咕咕的桥原样转给
    // `codex app-server`(`codex-app-server-acp.mjs` 的 inheritedArgs)。
    ...(platform.callableRoutes ? { callableRoutes: platform.callableRoutes } : {}),
    model: platform.model,
  }));
  return args;
}

const sessionBundle = codexSessionBundleDescriptor satisfies SessionBundleDescriptor;

export const plugin = definePlugin(
  {
    id: 'codex',
    name: 'Codex',
    description:
      'CLI that connects to OpenAI models for project-aware code assistance and terminal workflows.',
    websiteUrl: 'https://github.com/openai/codex',
  },
  {
    sessionBundle,
    /**
     * 厂商账号是不是硬门槛 —— 判据与陷阱见 `capabilities/vendor-account.ts` 抬头。
     * 这一格是**实测**出来的，❌ 不收「文档写着」。
     */
    // 「订阅」页(product spec):用量是 Codex 自己的 app-server 查询，便宜、打开页面就问。
    subscription: { kind: 'supported', usageRefresh: 'on-open' },
    vendorAccount: {
      kind: 'not-required',
      evidence:
        '只给 `-c model_providers.<id>.*` 自定义 provider + OPENAI_API_KEY、零 OpenAI 账号，假端点收到 6 次 POST /v1/responses（wire_api=responses），Authorization 为给的 key',
    },
    acp: {
      kind: 'supported',
      // The native app-server bridge owns exactly one Codex thread per adapter process.
      maxSessionsPerProcess: 1,
      liveSettings: {
        model: {
          channel: 'provider-thread-settings',
          ack: 'ack-read-back',
          busy: 'queue-next-turn',
          reloadRequired: false,
          recovery: 'none',
        },
        permission: {
          // Product measurement (Codex 0.147.0): process argv masks permission changes, while
          // thread/start plus thread/settings/update changes the next turn. The adapter consumes
          // the thread/settings/updated notification and reports the selected profile back to ACP.
          channel: 'provider-thread-settings',
          ack: 'ack-read-back',
          busy: 'queue-next-turn',
          reloadRequired: false,
          recovery: 'none',
          allowStartupDowngrade: true,
        },
        effort: {
          channel: 'provider-thread-settings',
          ack: 'ack-read-back',
          busy: 'queue-next-turn',
          reloadRequired: false,
          recovery: 'none',
        },
      },
    },
    autoApprove: {
      kind: 'supported',
      // codex 0.146.0 `permissionProfile/list` 真机上报的内置档(冒号前缀=内置)。
      // 实测:自造档名 + `-c permissions.<档>.sandbox_mode=…` 注册出来的是空档,一律落回只读。
      modes: CODEX_PERMISSION_MODES,
    },
    auth: {
      kind: 'supported',
      methods: [
        {
          kind: 'cli-login',
          id: 'codex-login',
          name: 'Sign in with Codex',
          args: ['login'],
          // 别的机器上:设备码登录 —— 打印链接 + 一次性码(15 分钟有效),在任何浏览器里确认,CLI 自己轮询。
          // 默认的 `login` 回跳 localhost:1455,浏览器在用户自己电脑上时回不到那台机器。
          // 出处:openai/codex `codex-rs/login/src/device_code_auth.rs`(run_device_code_login)。
          headlessArgs: ['login', '--device-auth'],
          description: 'Open the Codex CLI sign-in flow in a terminal.',
        },
        {
          kind: 'api-key',
          id: 'openai-api-key',
          name: 'Use an OpenAI API key',
          envVars: [{ name: 'OPENAI_API_KEY', label: 'OpenAI API key' }],
          helpUrl: 'https://platform.openai.com/api-keys',
        },
      ],
    },
    // Reasoning effort — `effortIds` / `defaultEffortId` below are transcribed from codex
    // 0.144.6's own embedded model catalog (`ModelInfo.supported_reasoning_levels` /
    // `.default_reasoning_level`), not guessed. The tiers really do differ per model:
    // sol/terra reach `ultra`, luna stops at `max`, the 5.5/5.4 family at `xhigh`.
    // `gpt-5.3-codex-spark` is absent from that catalog, so it declares no levels and the
    // composer hides the control for it instead of offering one the CLI would reject.
    effort: {
      kind: 'selectable',
      // 词表与平台模型 catalog 共用一份(见 ./efforts.ts)。
      effortOptions: CODEX_EFFORT_OPTIONS,
    },
    models: {
      kind: 'selectable',
      modelOptions: {
        'gpt-5.6-sol': {
          name: 'GPT-5.6 Sol',
          shortName: '5.6 Sol',
          description: 'Flagship GPT-5.6 model for the hardest agentic coding workflows.',
          modelFeatures: { intelligence: 5, speed: 2 },
          effortIds: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
          defaultEffortId: 'low',
        },
        'gpt-5.6-terra': {
          name: 'GPT-5.6 Terra',
          shortName: '5.6 Terra',
          description: 'Balanced GPT-5.6 model for everyday coding work with lower cost.',
          modelFeatures: { intelligence: 5, speed: 4 },
          effortIds: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
          defaultEffortId: 'medium',
        },
        'gpt-5.6-luna': {
          name: 'GPT-5.6 Luna',
          shortName: '5.6 Luna',
          description: 'Fast and cost-efficient GPT-5.6 model for lighter coding tasks.',
          modelFeatures: { intelligence: 4, speed: 5 },
          effortIds: ['low', 'medium', 'high', 'xhigh', 'max'],
          defaultEffortId: 'medium',
        },
        'gpt-5.5': {
          name: 'GPT-5.5',
          shortName: '5.5',
          description: 'Recommended Codex model for complex coding and agentic workflows.',
          modelFeatures: { intelligence: 5, speed: 3 },
          effortIds: ['low', 'medium', 'high', 'xhigh'],
          defaultEffortId: 'medium',
        },
        'gpt-5.4-mini': {
          name: 'GPT-5.4 Mini',
          shortName: '5.4 Mini',
          description: 'Faster Codex model for lighter coding tasks and subagents.',
          modelFeatures: { intelligence: 4, speed: 5 },
          effortIds: ['low', 'medium', 'high', 'xhigh'],
          defaultEffortId: 'medium',
        },
        'gpt-5.3-codex-spark': {
          name: 'GPT-5.3 Codex Spark',
          shortName: '5.3 Codex Spark',
          description: 'Research-preview Codex model optimized for near-instant iteration.',
          modelFeatures: { intelligence: 2, speed: 5 },
        },
      },
    },
    // hook 回调是 codex 的 `notify`,随**这一次启动**的配置覆盖递:app-server 腿进 thread-open 的
    // config map,prompt 直起的终端腿是 `-c notify=…`(`hooks.ts` 的 `codexNotifyConfigValue`,一个值两种载法)。
    // ❌ 不写用户的 `~/.codex/config.toml`;旧版写进去的那条由启动清理摘除。
    hooks: {
      kind: 'config',
      scope: 'session',
      channel: 'session-argv',
      evidence:
        'openai/codex@78fdcd2311bf codex-rs/hooks/src/legacy_notify.rs(notify 程序收 agent-turn-complete JSON);'
        + ' nmhjklnm/gugu@61d79a7a6 packages/session-plugins/src/agents/impl/codex/session-bundle.ts'
        + '(thread-open config 的 notify 键)与 index.ts 的 `-c notify=…`',
      supportedEvents: ['notification', 'stop', 'session'],
    },
    // `versionLine`:`--version` 里它自己那一行,实测原样「codex-cli 0.145.0」(包装器的 banner 在它前面)。
    hostDependency: { ...miseDependency({
      id: 'codex',
      package: '@openai/codex',
      executables: {
        'win32-x64': 'vendor/x86_64-pc-windows-msvc/bin/codex.exe',
        'win32-arm64': 'vendor/aarch64-pc-windows-msvc/bin/codex.exe',
        'darwin-x64': 'vendor/x86_64-apple-darwin/bin/codex',
        'darwin-arm64': 'vendor/aarch64-apple-darwin/bin/codex',
        'linux-x64': 'vendor/x86_64-unknown-linux-musl/bin/codex',
        'linux-arm64': 'vendor/aarch64-unknown-linux-musl/bin/codex',
      },
    }), versionLine: /^codex-cli / },
    mcp: {
      kind: 'supported',
      scope: 'global',
      supportedTransports: ['stdio', 'http'],
      // 两条腿按腿声明(#6615 问题 11):聊天面板腿量到了命名空间形态;终端腿没重量,沿用 #6192 那次读数,❌ 借聊天腿的答案。
      toolNames: {
        kind: 'per-surface',
        surfaces: {
          'acp': {
            kind: 'namespaced',
            namespace: 'mcp__gugu',
            evidence: '#6615 W-21(2026-09-28,codex 0.156.1):会话页聊天面板会话发给模型的 /responses(抓包)里咕咕工具是 `{type:"namespace", name:"mcp__gugu", tools:[message_send, …]}`,模型调用回来是 `function_call{namespace:"mcp__gugu", name:"message_send"}`。旁证:同一台测试机 09-25~28 咕咕起的 codex rollout(app-server 客户端,未分腿)里这几个工具 360/379 次带这个命名空间,其余是 #3551 动态工具的裸名。',
          },
          'tui': { kind: 'listed', prefix: 'mcp__gugu__', evidence: 'mac1 harness 会话存档里模型实际调用的工具名(#6192 盘点,2026-09-23):codex 模型面名 `mcp__gugu__<tool>`(code mode 同名 `tools.mcp__gugu__…`,见 sessionpage/codex-app-server-delivery.ts)' },
        },
      },
      // 会话通道与用户配置**合并**:`-c mcp_servers.<名>.…` 是 codex 自己的配置覆盖层,
      // 用户 `~/.codex/config.toml` 里那几台照常装载 ⇒ 咕咕不必也不该复述它们。
      sessionUserServers: 'inherit',
    },
    // agent memory —— codex 读 AGENTS.md 系。
    // global 那条的原始理由是**咕咕自己已经在读它**:apps/desktop/electron/main.ts:1029 的
    // MEMORY_SOURCE_FILES 把 `~/.codex/AGENTS.md` 内联进云 agent 创建载荷(@@@1422)。
    // project 一条按厂商官方文档补齐(https://developers.openai.com/codex/guides/agents-md):
    // 「Codex looks for AGENTS.md files starting in your Codex home directory (defaults to
    //  ~/.codex …). From the project scope, starting at the project root (typically the Git root),
    //  Codex walks down to your current working directory.」
    // ❌ 不登记 `AGENTS.override.md` / `project_doc_fallback_filenames`:前者是同页记的覆盖档
    //    (存在时**顶掉** AGENTS.md,不是并列加载),后者的文件名由用户配置决定 ——
    //    两者都不是一条能写死的相对路径,猜一个进来就是编事实。
    // ⚠️ `satisfies` 不是装饰:capability 的 schema 钉的是 `z.ZodType<AgentMemoryDescriptor>`,
    // 而 zod 4 的 `ZodType<Output>` 把 Input 留成 `unknown` —— 少了这一句,这段声明在类型上
    // 是**不受检**的(同 sessionBundle 用 `satisfies SessionBundleDescriptor` 的理由)。
    memory: {
      kind: 'files',
      entries: [
        { kind: 'file', scope: 'global', channel: 'agents-md', path: '.codex/AGENTS.md' },
        { kind: 'file', scope: 'project', channel: 'agents-md', path: 'AGENTS.md' },
      ],
    } satisfies AgentMemoryDescriptor,
    // 如实标缺:本家没有已知的「把工作区标成可信」的通道 —— 引擎自己问一次(或它压根不问)。
    // ⚠️ 这一格没有默认值(owner 2026-09-03「强类型,不存在灰色地带」):写出来的是一句
    //    说过的话,❌ 不是省略。真查到通道了就改成 `{ kind: 'supported', channel: … }`。
    trust: { kind: 'none' },
    prompt: {
      kind: 'argv',
      flag: '',
      startupDelivery: 'delivery-bridge',
    },
    sessions: {
      kind: 'resumable',
      tuiResume: 'provider-id',
      resumeNeedsProviderId: true,
      // codex 0.144+ has a native `codex fork <session-id>` subcommand (verified 0.144.6).
      fork: 'supported',
    },
  },
  { icon }
);

export const provider = registerPluginBehavior(plugin, {
  sessionBundle: {
    platformModel,
    sessionTuiHostAdapter: 'codex-app-server-v1',
    materialize: materializeCodexSessionBundle,
  },
  acp: {
    // codex 的 ACP 腿只有一座桥:咕咕自己写的 `runtime/codex-app-server-acp.mjs`(驱动用户自己那份
    // `codex app-server`),随应用一起构建;入口由宿主解析(#6394)。❌ 再回落到上游
    // `@agentclientprotocol/codex-acp` —— 那座桥没有 notify / 平台模型目录 / MCP 关闭集合这些通道,
    // 回落过去就是 #5050 那种静默的「探测与会话两个 adapter」。
    bridge: { kind: 'app-runtime', file: 'codex-app-server-acp.mjs' },
    buildSpawn: (ctx) => {
      const credentialLifecycle = codexCredentialLifecycle('app-server');
      if (
        credentialLifecycle.delivery !== 'credential-proxy'
        || credentialLifecycle.recovery !== 'reopen'
      ) {
        throw new Error('Codex app-server credential lifecycle does not match its native consumer');
      }
      const platform = ctx.platform;
      const guguAdapterEntry = requireBridgeEntry(ctx, 'codex');
      const codexBin = codexBinaryForSpawn(ctx);
      // spec `mcp-session-toggle`:关闭集合由**物化器**决定(它拿得到会话记录),
      // 而 `CODEX_CONFIG` 这份文档由**这里**独占产出(它拿得到平台凭据)。
      // 两边各有一半事实 ⇒ 只能在其中一边合,而只能合在这里:
      // 物化器的 env 被宿主叠在最上面,在那边写 `CODEX_CONFIG` 会把平台那份整个顶掉。
      const mcpFragment = parseMcpFragment(ctx.capabilityEnv?.[GUGU_CODEX_MCP_CONFIG_ENV]);
      // MCP is delivered by the app-server thread `config` map in the thin bridge.
      // ⚠️ 没有平台会话时也可能要发这份文档 —— 关闭集合与平台额度是**两件独立的事**。
      //    第一版只在 `platform` 分支里写 `CODEX_CONFIG`,于是 BYOK 会话的开关静默失效。
      const codexConfig = platform
        ? {
            model: platform.model,
            ...(platform.contextWindow ? { model_context_window: platform.contextWindow } : {}),
            model_provider: platform.providerId,
            model_providers: {
              [platform.providerId]: {
                name: platform.providerLabel,
                base_url: platform.baseUrl,
                env_key: 'OPENAI_API_KEY',
                wire_api: CODEX_WIRE_API,
              },
            },
          }
        : undefined;
      // 咕咕自己的 app-server 适配器从宿主收到 thread-open config map；
      // ACP 薄桥再把同一语义交给 app-server 的 thread/start|resume|fork。
      // `CODEX_CONFIG` 在这里仅承载平台模型层，不能再拿来伪装 MCP 注入通道。
      return {
        command: process.execPath,
        executable: codexBin,
        args: [
          guguAdapterEntry,
          // #6264 工作目录的信任按次给(见 codexProjectTrustArgs):聊天会话与模型目录探针都走这里,
          // ❌ 让 codex 把「信任这个目录」写进用户自己的 config.toml。
          ...codexProjectTrustArgs(ctx.cwd),
          ...(platform ? codexAppServerPlatformArgs(platform) : []),
          ...(ctx.capabilityArgs ?? []),
        ],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          GUGU_CODEX_BIN: codexBin,
          // @@@5380 agent 事件 hook 的 `notify` 回调 —— 桥把它并进 thread-open 的 `config`
          // map(与 MCP 同一扇门),❌ 不拼 argv `-c`:#5363 已经把这条腿的 MCP 从 argv 迁走,
          // 再从 argv 递 notify 就是同一个进程两扇门(#5380)。
          //
          // 少了它,这条腿一条 hook 事件都发不出来 ⇒ 没有 `stop` ⇒ maybeShowNotification 不被
          // 调到 ⇒ **跑完没有系统横幅**(#5301,owner 实机撞到的正是这条腿)。
          [GUGU_CODEX_NOTIFY_CONFIG_ENV]: JSON.stringify(codexNotifyConfigValue()),
          // Codex sizes its own compaction against whatever window it believes the model
          // has, and a gateway alias is never an id it recognizes. `model_context_window` is
          // omitted when unknown so it keeps its own default — merely conservative, unlike a
          // guess that overflows. (那份文档现在在上面组装,因为它还要合进会话级的 MCP 关闭集合。)
          ...(codexConfig ? { CODEX_CONFIG: JSON.stringify(codexConfig) } : {}),
          // 见 `CODEX_ACP_MCP_DEDUP_ENV`:写死它,免得用户环境里一个同名变量把去重关掉 ——
          // 关掉之后 `mcp_servers` 整张表会被 ACP 那几台换掉,我们的 `enabled:false` 静默丢失。
          ...(mcpFragment ? { [CODEX_ACP_MCP_DEDUP_ENV]: 'false' } : {}),
          ...(platform
            ? {
                ...platform.spawnEnv,
                MODEL_PROVIDER: platform.providerId,
                OPENAI_API_KEY: platform.apiKey,
                // 这条会话可用的整组平台模型的事实 —— 咕咕的桥据此写 codex 的 model catalog,
                // codex 自己的 `model/list` 于是报出它们(连同目录里逐模型的推理档,#6447),窗口也不再被
                // fallback metadata 压到 272k。见 `platform-models.ts`。
                [GUGU_PLATFORM_MODELS_ENV]: codexPlatformModelFacts({
                  model: platform.model,
                  contextWindow: platform.contextWindow,
                  reasoningEfforts: platform.reasoningEfforts,
                  models: platform.switchableModels,
                }),
                ...(platform.authRequest
                  ? { DEFAULT_AUTH_REQUEST: JSON.stringify(platform.authRequest) }
                  : {}),
              }
            : {}),
        },
      };
    },
    connect: (io, toClient) => {
      return connectStdioAcp(io, toClient);
    },
    enrich: enrichCodexUpdate,
  },
  subscription: codexSubscriptionBehavior(),
  auth: {
    checkStatus: codexAuthStatus,
    // codex 只有一个模型提供方(OpenAI),所以「这个自家模型有没有凭据」就是「codex 登没登 / 有没有
    // OPENAI_API_KEY」。它没登录也报得出自家目录 —— 不给这个读数,创建框会把默认按在一跑就 401 的模型上
    // (#6264 在一台从没登录过 codex 的咕咕 server 上实撞)。
    modelCredential: async (ctx) => {
      const status = await codexAuthStatus(ctx);
      return status.kind === 'authenticated'
        ? 'credentialed'
        : status.kind === 'unauthenticated'
          ? 'uncredentialed'
          : 'unknown';
    },
  },
  prompt: {
    buildCommand: (ctx) =>
      buildStandardCommand(ctx, {
        // 关启动更新菜单的 `-c check_for_update_on_startup=false` 不在这里:它是 descriptor 的
        // `selfUpdate` 声明,由起终端的宿主统一追加(#6186)。
        defaultArgs: ['-c', makeCodexNotifyConfigOverride()],
        autoApproveFlag:
          '-c approval_policy="never" -c sandbox_mode="danger-full-access" --dangerously-bypass-hook-trust',
        // `codex --help` 0.146.0: `-s, --sandbox <read-only|workspace-write|danger-full-access>`。
        // 编辑档不给 flag —— codex 自己的默认就是那一档。
        readOnlyFlag: '-s read-only',
        initialPromptFlag: '',
        resumeFlag: 'resume',
        cliSessionIdFlag: ' ',
        cliSessionIdOnResumeOnly: true,
        resumeWithoutSessionFlag: 'resume --last',
        // `codex fork <src>` replaces `resume`; codex mints the forked session id itself,
        // which the host learns via the session hook (same path as a fresh codex session).
        forkCommand: 'fork',
        deduplicateFlags: ['--dangerously-bypass-approvals-and-sandbox'],
        modelFlag: '-m',
        // codex has no --effort flag; the level is a config override (`codex --help` 0.144.6).
        effortFlag: '-c model_reasoning_effort=',
      }),
  },
  hooks: buildCodexHookConfig(),
  mcp: codexScopedMcpAdapter(),
});

export {
  CODEX_GUGU_CAPABILITY_PACKAGE,
  CODEX_ACP_MINIMUM_VERSION,
  codexSessionBundleDescriptor,
  materializeCodexSessionBundle,
};

async function codexAuthStatus(ctx: AgentAuthContext): Promise<AgentAuthStatus> {
  const envStatus = authenticatedFromEnv(ctx, ['OPENAI_API_KEY']);
  if (envStatus.kind === 'authenticated') return { ...envStatus, credentialKind: 'api-key' };
  const status = await commandAuthStatus({ ...ctx, cli: codexBinaryForSpawn(ctx) }, ['login', 'status'], {
    authenticatedPattern: /authenticated|logged in|signed in/i,
    unauthenticatedPattern: /not authenticated|not logged in|not signed in|login required/i,
  });
  if (status.kind !== 'authenticated') return status;
  const credential = await codexCredentialInfo(ctx);
  return credential.kind === 'unknown' ? status : { ...status, credentialKind: credential.kind, ...(credential.account ? { account: credential.account } : {}) };
}
