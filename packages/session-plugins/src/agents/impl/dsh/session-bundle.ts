import { harnessPlatform } from './platform';
import { DSH_PLATFORM_KEY_ENV, dshCatalogRow, platformModel } from './platform-model';
import { DSH_PERMISSION_MODES } from './permission-modes';
import type {
  Degradation,
  NativeHome,
  SessionBundleDescriptor,
  SessionCapabilityBundle,
  SessionMaterialization,
  SessionMaterializationContext,
} from '@gugu/session-core/agents/plugins';
import { sessionPromptText, sessionRunHome } from '../../helpers/session-bundle';
import { sessionMcpProtocolServers } from '../../helpers/session-mcp';
import { resolveDeclaredPermissionMode } from '@gugu/session-core/acp';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DSH_PERMISSION_PLUGIN_FILE, DSH_PERMISSION_PLUGIN_SOURCE } from './permission-plugin';

/**
 * DeepSeek Harness(`@deepseek-ai/dsh`)的会话包。一手出处:发行包 0.2.1-rc.5(gpu 上 npm 装开读
 * `node_modules/@deepseek-ai/*`)与 2026-11-05 gpu 假网关实测。
 */
const VERSION = '0.2.1-rc.5';

/** dsh 的 provider id:`llm-deepseek` 那一行注册的路由名(`dsh-llm-deepseek-api-key` 的 `PROVIDER`)。 */
const DSH_PROVIDER = 'deepseek-official';

/**
 * `extension` / `packages` 这一格指的是咕咕**自己的原生插件包**(claude 的 `.claude-plugin`、codex 的
 * `.codex-plugin`、opencode 的事件模块:装钩子、原生挂 skill)。dsh 不需要它:装了的 App 照常到达 ——
 * App 的 MCP server 由宿主并进 `mcpServers`,经 `session/new` 送进去(下面的 `units.mcp`);App 列表与
 * skill 走平台块里的 `<gugu_apps>`(`mountsExtensionSkillsNatively` 为假时宿主就这么投)。
 * 所以这里没有缺了什么,只是这一家没有、也不用这条通道。
 */
const noNativePackage: Degradation = {
  code: 'unsupported-channel',
  reason: 'Gugu ships no native plugin package for DeepSeek Harness and needs none: installed Apps reach it as MCP '
    + 'servers in session/new and through the <gugu_apps> platform block.',
};

const PATCH_FILE = 'gugu-session-patch.yml';

/** 平台会话每个请求的输出上限(理由见 `platformRows`)。 */
const PLATFORM_MAX_TOKENS = 32000;

/**
 * 每一条会话都关掉的三样回传(平台与自带 key 一样,不做开关):
 *  · `session-log-deepseek`:每个模型请求的 body 带 `dsh_session_log` —— 整份会话事件(含文件内容、命令输出、
 *    cwd),不脱敏,单次最多 8 MiB;它自己的界面文案写明用途是「Help improve DeepSeek models and products」。
 *  · `plugin-package-inventory-deepseek`:body 带 `dsh_plugin_packages`(插件包名 + 版本),「request diagnostics」。
 *  两样都不看 baseURL,换了中转照发(实测:走假网关时 body 里有这两个键,关掉之后没有)。关掉没有功能损失:
 *  响应里不读它们,README 写「Zero model-input tokens」「KV Cache effect: None」,续接与压缩读本地日志。
 *  · OTel 反馈导出:只在用户显式反馈后发;咕咕界面里没有 dsh 的反馈入口,`DSH_TELEMETRY_DISABLED`
 *    (非空即关,`dsh-base` 的 patch 原文)一并关掉。
 */
const DISABLED_ROWS = ['session-log-deepseek', 'plugin-package-inventory-deepseek'] as const;

export const dshSessionBundleDescriptor = {
  injectionMode: 'runtime',
  nativeHome: {
    envVar: 'DSH_HOME',
    userPath: '.dsh',
    evidence: '@deepseek-ai/dsh-home-paths 0.2.1-rc.5:`DSH_HOME_ENV = "DSH_HOME"`,默认 `~/.dsh`',
  } satisfies NativeHome,
  platform: harnessPlatform,
  credentialLifecycle: {
    'acp': {
      delivery: 'process-config',
      originalProcessRefresh: 'unsupported',
      recovery: 'reopen',
      inferenceOwner: 'provider-process',
      reopenEntry: 'host-session-reload',
      sourceChangeSession: 'preserve',
    },
  },
  surfaces: ['acp'],
  sessionpage: {
    'acp': { identity: 'addressable', messageTransport: 'router' },
  },
  /**
   * 0.2.1-rc.5 是 `--patch` 里那几行 id(两样回传、`llm-deepseek.apiKeyEnv`、`acp`)实测过的版本。更早的 rc
   * 上它们若叫别的名字,patch 不会报错,会话日志却照样上传 —— 这是已知不安全,不是「没测过」。
   */
  runtimeCompatibility: {
    'acp': { kind: 'semver-supported-floor', supportedFloor: VERSION, versionArgs: ['--version'] },
  },
  units: {
    /** `session/new.mcpServers`(stdio + Streamable HTTP;`initialize` 报 `mcpCapabilities.http`)。 */
    mcp: { kind: 'native', channel: 'acp-session' },
    env: { kind: 'native', channel: 'child-process' },
    /** 平台模型 → 0600 的 `--patch` 文档(dsh 配置最高一层,压得住用户 `~/.dsh` 的 profile patch)。 */
    model: { kind: 'native', channel: 'config-file' },
    /**
     * 自治级别 → `--patch` 里插进去的咕咕插件(./permission-plugin.ts),在每个 `agent/created` 上调 dsh 自己的
     * `permissionPresets.set` —— 与 `/permission` 同一条写入路。
     * ⚠️ 不用 `DSH_PERMISSION_MODE`:它只管新会话的默认档,续接时 dsh 沿用钉下的那一档(`dsh-permission-presets`
     *    README「A resumed seed … preserves its effective permission」;实测 read-only 建的会话带
     *    danger-full-access 重起再 resume,命令照旧被拦)。插件在续接时同样生效,所以换档能走 `reload-session`。
     */
    autonomy: { kind: 'native', channel: 'config-file' },
    /** 厂商原生 ACP server 不读 `_meta.systemPrompt.append`,身份自述随首轮用户消息走(同 codebuddy)。 */
    promptBlocks: { kind: 'native', channel: 'session-context' },
  },
  extension: { kind: 'none', degraded: noNativePackage },
  coexistence: {
    pause: { kind: 'native', channel: 'protocol-cancel' },
    observability: { kind: 'native', channel: 'acp-update' },
    askUser: { kind: 'native', channel: 'permission-ask' },
    memory: { kind: 'native', channel: 'agents-md' },
  },
} satisfies SessionBundleDescriptor;

/** 平台模型 → `--patch` 里的那两行。注入不成立返回 null(一个字段都不发)。 */
function platformRows(bundle: SessionCapabilityBundle): Record<string, unknown>[] | null {
  const model = bundle.model;
  if (!model) return null;
  if (model.dialect !== harnessPlatform.dialect) {
    throw new Error(`DeepSeek Harness session adapter cannot materialize model dialect '${model.dialect}'`);
  }
  const env = platformModel.load(model).spawnEnv;
  if (!env?.DEEPSEEK_BASE_URL || !model.model) return null;
  const selected = model.model;
  const choices = model.platformModels?.length ? model.platformModels : [{ id: selected, contextWindow: model.contextWindow }];
  if (!choices.some((choice) => choice.id === selected)) {
    throw new Error(`DeepSeek Harness platform model '${selected}' is not among the session's platform models`);
  }
  return [
    {
      id: 'llm-deepseek',
      // patch 换的是这一行**整份** config(dsh-base 抬头原文),用户 profile 里的同一行整份让位。
      config: {
        baseURL: env.DEEPSEEK_BASE_URL,
        apiKeyEnv: DSH_PLATFORM_KEY_ENV,
        // dsh 默认每个请求 `max_tokens: 256000`(`DEFAULT_MAX_TOKENS`),而可切的咕咕模型各有各的输出上限,目录里
        // 没有这一格:2026-11-05 中转实测 GLM 5.3 Flash 拒收(「限制数值范围[1,131072]」),DeepSeek 两档收。
        // 取 Claude Code 在同一个中转上默认发的 32000,所有可切模型都收。
        maxTokens: PLATFORM_MAX_TOKENS,
        models: choices.map(dshCatalogRow),
      },
    },
    { id: 'acp', config: { provider: DSH_PROVIDER, model: selected } },
  ];
}

export function materializeDshSessionBundle(
  ctx: SessionMaterializationContext,
  bundle: SessionCapabilityBundle
): SessionMaterialization {
  if (ctx.surface !== 'acp') {
    throw new Error(`DeepSeek Harness session adapter does not support surface '${ctx.surface}'`);
  }
  const env = Object.fromEntries(
    Object.entries(bundle.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  env.DSH_TELEMETRY_DISABLED = '1';
  // 所选之档这一家没有(plan)⇒ 落到不比它更松的最近一档,一档都落不到就抛 —— 与注册表收档同一个判据。
  const wanted = bundle.autonomy?.permissionMode
    ?? (bundle.autonomy?.mode === 'full-access' ? 'full-access' : bundle.autonomy ? 'edit' : undefined);
  const tier = wanted ? resolveDeclaredPermissionMode(wanted, DSH_PERMISSION_MODES) : undefined;
  if (wanted && !tier) throw new Error(`DeepSeek Harness has no permission mode for '${wanted}' or any stricter one`);
  const permission = tier ? DSH_PERMISSION_MODES[tier as keyof typeof DSH_PERMISSION_MODES].id : undefined;

  const platform = platformRows(bundle);
  if (platform) {
    const token = platformModel.load(bundle.model!).spawnEnv![DSH_PLATFORM_KEY_ENV]!;
    env[DSH_PLATFORM_KEY_ENV] = token;
  }
  const runHome = sessionRunHome(bundle, 'DeepSeek Harness', 'dsh-capability-runs');
  const path = join(runHome, PATCH_FILE);
  const pluginPath = join(runHome, DSH_PERMISSION_PLUGIN_FILE);
  // 权限档只经这一条路:插件在每个 `agent/created`(新建与续接)上把它写进会话(见 ./permission-plugin.ts)。
  // ❌ 不再并发 `DSH_PERMISSION_MODE`:那只管新会话的默认档,续接时被钉下的那一档压住,留着就是第二条路。
  // 插件按 file URL 加载(cordis loader 把 `name` 当模块说明符 import;Windows 盘符路径不是合法说明符)。
  const permissionRows = permission
    ? [{ insert: [{ id: 'gugu-permission', name: pathToFileURL(pluginPath).href, config: { preset: permission } }] }]
    : [];
  const rows = [...DISABLED_ROWS.map((id) => ({ id, disabled: true })), ...(platform ?? []), ...permissionRows];

  const prompt = sessionPromptText(bundle.promptBlocks);
  // 令牌随 ACP 条目的 header 走,不再留在适配器进程环境里。
  for (const server of bundle.mcpServers) {
    if (server.transport !== 'stdio' && server.authorizationEnv) delete env[server.authorizationEnv];
  }
  const loaded = { status: 'loaded' as const };
  return {
    // 传**路径**不传内联:进程表人人可读。JSON 是 YAML 的子集,dsh 的 patch 加载器照收。
    argsAppend: ['--patch', path],
    env,
    acp: { mcpServers: sessionMcpProtocolServers(bundle, 'DeepSeek Harness') },
    // ⚠️ `carrier` 必须显式写出来:缺席 = 静默回落系统位(`_meta.systemPrompt.append`),对厂商原生
    //    ACP server 是黑洞。
    ...(prompt ? { prompt: { ...prompt, carrier: 'session-context' as const } } : {}),
    configMerges: [],
    // 0600:里面有中转地址;令牌不在里面(只在进程环境)。
    artifacts: [
      { path, content: `${JSON.stringify(rows, null, 2)}\n`, mode: 0o600 },
      ...(permission ? [{ path: pluginPath, content: DSH_PERMISSION_PLUGIN_SOURCE, mode: 0o600 as const }] : []),
    ],
    report: {
      adapterId: 'dsh',
      surface: ctx.surface,
      units: {
        mcp: bundle.mcpServers.length > 0
          ? loaded
          : { status: 'degraded', reason: { code: 'unverified', reason: 'No MCP server was declared.' } },
        env: loaded,
        model: platform
          ? loaded
          : { status: 'degraded', reason: { code: 'unverified', reason: 'No platform model was declared.' } },
        autonomy: permission
          ? loaded
          : { status: 'degraded', reason: { code: 'unverified', reason: 'No autonomy level was declared.' } },
        promptBlocks: prompt
          ? loaded
          : { status: 'degraded', reason: { code: 'unverified', reason: 'No prompt blocks were declared.' } },
        packages: { status: 'degraded', reason: noNativePackage },
      },
      discoveredCommands: [],
    },
  };
}
