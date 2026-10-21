// The single plugin registry
import {
  type CLIAgentPluginProvider,
  type NativeHome,
  type HarnessSessionSurface,
  matchesRuntimeCompatibility,
  mcpToolNamesOn,
  promptBlocksReplayedEverySpawn,
  providerStartupTurnViaLocalSession,
  requiredExactRuntimeCompatibility,
  agentSupportTier,
  probeGuguIntegration,
  type SessionTuiDeliveryToolNames,
  type SessionTuiHostAdapter,
  type SessionpageHostAdapter,
  type SessionpageSessionSurface,
  resolveSessionCredentialLifecycle,
} from '@gugu/session-core/agents/plugins';
import { resolveDeclaredPermissionMode, resolveSessionPermissionMode } from '@gugu/session-core/acp';
import { createPluginRegistry } from '@gugu/session-shared/plugins';
import { WITHHELD_FAMILIES } from './conformance/p0-families';
import { HOST_SHELL_DENIED_ENV_VARS, SHARED_AGENT_ENV_VARS } from '@gugu/session-core/agents/agent-env';
export { P0_FAMILIES, WITHHELD_FAMILIES } from './conformance/p0-families';
import { provider as amp } from './impl/amp';
import { provider as antigravity } from './impl/antigravity';
import { provider as auggie } from './impl/auggie';
import {
  CLAUDE_GUGU_CAPABILITY_PACKAGE,
  provider as claude,
} from './impl/claude';
import { provider as cline } from './impl/cline';
import { provider as codebuff } from './impl/codebuff';
import { provider as codebuddy } from './impl/codebuddy';
import {
  CODEX_GUGU_CAPABILITY_PACKAGE,
  CODEX_ACP_MINIMUM_VERSION,
  materializeCodexSessionBundle,
  provider as codex,
} from './impl/codex';
import { provider as commandcode } from './impl/commandcode';
import { provider as continueCli } from './impl/continue';
import { provider as copilot } from './impl/copilot';
import { provider as cursor } from './impl/cursor';
import { provider as devin } from './impl/devin';
import { provider as droid } from './impl/droid';
import { provider as gemini } from './impl/gemini';
import { provider as grok } from './impl/grok';
import { provider as hermes } from './impl/hermes';
import { provider as junie } from './impl/junie';
import { provider as kilocode } from './impl/kilocode';
import { provider as kimi } from './impl/kimi';
import { provider as kiro } from './impl/kiro';
import { provider as mimocode } from './impl/mimocode';
import { provider as mistral } from './impl/mistral';
import { provider as ohMyPi } from './impl/oh-my-pi';
import {
  OPENCODE_PLUGIN_CONTENT,
  OPENCODE_GUGU_CAPABILITY_PACKAGE,
  OPENCODE_GUGU_EVENT_MODULE_PATH,
  provider as opencode,
} from './impl/opencode';
import {
  PI_GUGU_CAPABILITY_PACKAGE,
  provider as pi,
} from './impl/pi';
import { provider as qoder } from './impl/qoder';
import { materializeQwenSessionBundle, provider as qwen } from './impl/qwen';
import { provider as zero } from './impl/zero';
import { provider as zcode } from './impl/zcode';

type SessionpageIntegrationOverride = {
  providerId: string;
  surface: SessionpageSessionSurface;
  identity?: 'addressable' | 'none';
  messageTransport?: 'router' | 'local-session' | 'none';
  inbound?: 'deliverable' | 'none';
};

const sessionpageIntegrationOverrides = new Map<string, SessionpageIntegrationOverride>();

function sessionpageIntegrationOverrideKey(providerId: string, surface: SessionpageSessionSurface): string {
  return `${providerId}:${surface}`;
}

export { asAgentProviderId } from './types';
export type { AgentProviderId } from './types';
export type { SessionpageSessionSurface } from '@gugu/session-core/agents/plugins';

const providers = [
  codex,
  claude,
  grok,
  devin,
  qwen,
  droid,
  antigravity,
  cursor,
  copilot,
  amp,
  commandcode,
  gemini,
  opencode,
  hermes,
  auggie,
  kimi,
  kilocode,
  kiro,
  cline,
  continueCli,
  codebuff,
  mistral,
  junie,
  ohMyPi,
  pi,
  qoder,
  mimocode,
  zero,
  zcode,
  codebuddy,
] as const;

// @@@adapter-surface-guard — every host adapter is physically carried on one specific descriptor surface;
// selecting it without that surface is a mis-declaration. Data-driven (one row per adapter) so a new
// adapter is a table entry, not another copy-pasted if-block. provider-session-bundle has no required
// surface (it is the default, guarded separately above the check).
const ADAPTER_REQUIRED_SURFACE: Partial<Record<SessionTuiHostAdapter, HarnessSessionSurface>> = {
  'codex-app-server-v1': 'app-server',
  'claude-rendezvous-v1': 'tui',
  'droid-daemon-v1': 'tui',
  'opencode-serve-attach-v1': 'tui',
};

/**
 * @@@declared-permission-modes (#6221) —— 档位表(`autoApprove.modes`)是这一家「能兑现哪几档」的唯一声明;
 * 标记完整(`modesExhaustive`)的家,终端命令只收得到表里的档。终端腿都经注册表拿
 * provider,在这里收一次就全到,❌ 在每个调用点各解析一遍(漏一个就是一条越权的路)。
 *
 * · 所选之档不在表里 ⇒ `resolveDeclaredPermissionMode` 落到不比它更松的最近一档;一档都落不到 ⇒ 抛,
 *   ❌ 以比所选更松的档启动。
 * · 没有 `permissionMode` 的会话按 `resolveSessionPermissionMode` 补(编辑档),与界面、聊天面板腿同一个答案,
 *   再照上一条收档。
 * · 表不完整(droid 只实测了完全访问)或没声明档位表的家原样返回(#6231 逐家实测后再收)。
 */
function withDeclaredPermissionModes(provider: CLIAgentPluginProvider): CLIAgentPluginProvider {
  const autoApprove = provider.capabilities.autoApprove;
  const modes = autoApprove.kind === 'supported' && autoApprove.modesExhaustive ? autoApprove.modes : undefined;
  const prompt = provider.behavior.prompt;
  if (!modes || !prompt) return provider;
  const id = provider.metadata.id;
  const buildCommand: typeof prompt.buildCommand = (ctx) => {
    const wanted = resolveSessionPermissionMode(ctx);
    const effective = resolveDeclaredPermissionMode(wanted, modes);
    if (!effective) {
      throw new Error(
        `Agent plugin '${id}': permission mode '${wanted}' is not declared and no declared mode is at least `
        + 'as strict; refusing to start the session looser than selected'
      );
    }
    return prompt.buildCommand({ ...ctx, permissionMode: effective });
  };
  return { ...provider, behavior: { ...provider.behavior, prompt: { ...prompt, buildCommand } } };
}

export function createAgentPluginRegistry(entries: readonly CLIAgentPluginProvider[] = providers) {
  const registry = createPluginRegistry<CLIAgentPluginProvider>();
  const ids = new Set<string>();

  for (const provider of entries) {
    const id = provider.metadata.id;
    if (ids.has(id)) throw new Error(`Duplicate agent plugin id '${id}'`);
    ids.add(id);

    const errors = provider.validate();
    if (errors.length > 0) {
      const issues = errors.flatMap((error) => error.issues);
      throw new Error(`Agent plugin '${id}' has invalid descriptors: ${JSON.stringify(issues)}`);
    }

    const descriptor = provider.capabilities.sessionBundle;
    const requiredSessionAcpRuntime = requiredExactRuntimeCompatibility(descriptor, 'acp');
    const declaredSessionAcpRuntime = descriptor.runtimeCompatibility?.['acp'];
    if (requiredSessionAcpRuntime && (
      !declaredSessionAcpRuntime
      || !matchesRuntimeCompatibility(declaredSessionAcpRuntime, requiredSessionAcpRuntime)
    )) {
      throw new Error(
        `Agent plugin '${id}' must declare a acp runtime floor of at least `
        + `${requiredSessionAcpRuntime.supportedFloor}`
      );
    }
    // PR #3785 曾在这里硬禁 opencode-format event-module 申明 tui —— 那是「未实测故
    // 不申明」的 fail-loud 占位,不是机制冲突。#4406 按真机实测(见 impl/opencode/
    // session-bundle.ts descriptor 抬头的取证清单)补上了这条腿,守卫随之退役;
    // 「申明必须有实测背书」由各 descriptor 的证据注释与 conformance 考卷承担,❌ 别再按
    // 适配器形态一刀切。
    if (descriptor.surfaces.length > 0 && !provider.behavior.sessionBundle) {
      throw new Error(
        `Agent plugin '${id}' declares session bundle surfaces without a materializer`
      );
    }
    const sessionTuiHostAdapter = provider.behavior.sessionBundle?.sessionTuiHostAdapter;
    if (sessionTuiHostAdapter && !descriptor.sessionpage['tui']) {
      throw new Error(
        `Agent plugin '${id}' declares a TUI host adapter without sessionpage.tui`
      );
    }
    if (
      descriptor.sessionpage['tui']
      && !descriptor.surfaces.includes('tui')
      && !sessionTuiHostAdapter
    ) {
      throw new Error(
        `Agent plugin '${id}' maps session-TUI through another surface without a host adapter`
      );
    }
    const requiredSurface = sessionTuiHostAdapter
      ? ADAPTER_REQUIRED_SURFACE[sessionTuiHostAdapter]
      : undefined;
    if (requiredSurface && !descriptor.surfaces.includes(requiredSurface)) {
      throw new Error(
        `Agent plugin '${id}' selects ${sessionTuiHostAdapter} without the ${requiredSurface} surface`
      );
    }
    for (const surface of ['acp', 'tui'] as const) {
      const declaresSurface = descriptor.surfaces.includes(surface);
      const mapsAppServerSurface =
        surface === 'tui' && descriptor.surfaces.includes('app-server');
      const integration = descriptor.sessionpage[surface];
      // A harness session surface is lower-level capability, while sessionpage is an
      // opt-in product integration.  A provider may expose ACP to another host
      // without claiming that the session page can address or message it.
      if (declaresSurface && !integration) {
        throw new Error(
          `Agent plugin '${id}' declares the ${surface} session surface without sessionpage.${surface}`
        );
      }
      if (integration && !declaresSurface && !mapsAppServerSurface) {
        throw new Error(
          `Agent plugin '${id}' declares a ${surface} sessionpage integration without that session surface`
        );
      }
    }

    // 声明了平台模型,就得说得出怎么写(宿主按方言找到这一家后只调它的 declare / load)。
    const supportsPlatform = descriptor.platform.kind === 'supported';
    if (supportsPlatform !== Boolean(provider.behavior.sessionBundle?.platformModel)) {
      throw new Error(
        supportsPlatform
          ? `Agent plugin '${id}' declares sessionBundle.platform without behavior.sessionBundle.platformModel`
          : `Agent plugin '${id}' implements platformModel but declares sessionBundle.platform unsupported`
      );
    }
    registry.register(withDeclaredPermissionModes(provider));
  }

  return registry;
}

export const pluginRegistry = createAgentPluginRegistry();

/**
 * 用户 shell 透传给 agent 的白名单:多家共用的厂商约定 + 每一家插件声明的自己的名字(`sessionBundle.shellEnv`)。
 * 取**全部注册插件**的并集(含不上架的):白名单对每条会话一样,一个名字只是「有一家会读」。
 */
export function agentShellEnvPassThrough(): readonly string[] {
  return shellEnvUnion(SHARED_AGENT_ENV_VARS, (env) => env.passThrough);
}

/** 用户 shell 里不许透传的名字:与哪一家都无关的那几个 + 每一家声明的咕咕自己管着的那几格。 */
export function agentShellEnvDenied(): readonly string[] {
  return shellEnvUnion(HOST_SHELL_DENIED_ENV_VARS, (env) => env.denied);
}

function shellEnvUnion(
  shared: readonly string[],
  pick: (env: NonNullable<CLIAgentPluginProvider['capabilities']['sessionBundle']['shellEnv']>) => readonly string[] | undefined,
): readonly string[] {
  const names = new Set<string>(shared);
  for (const plugin of pluginRegistry.getAll()) {
    const env = plugin.capabilities.sessionBundle.shellEnv;
    for (const name of (env && pick(env)) ?? []) names.add(name);
  }
  return [...names].sort();
}

/** The one owner-controlled default offer projection over the fully registered adapter set. */
export function listUserExposedPlugins(includeWithheld = false): CLIAgentPluginProvider[] {
  const all = pluginRegistry.getAll();
  if (includeWithheld) return all;
  const withheld = new Set<string>(WITHHELD_FAMILIES);
  return all.filter((provider) =>
    agentSupportTier(provider.capabilities) === 'supported'
      && passesIntegrationGate(provider)
      && !withheld.has(provider.metadata.id)
  );
}

/**
 * 咕咕集成档:五维(mcp / env / model / promptBlocks / autonomy)全通。
 *
 * `model` 一维考的是「咕咕的自营模型能不能注入进去」。厂商那一侧就点不了名的家(model 那一格如实声明为
 * `unsupported-channel`)这一维**不可能通**,用户只能用它自己的订阅 —— owner 2026-09-24 对 antigravity
 * 的裁决「只能走订阅,这个我们客观承认」。这种家不因这一维挡在入口外,其余四维照样必须全通。
 * 声明 `unsupported-channel` 有举证门槛(见 session-bundle 的 `Degradation`),❌ 拿它当没接通的托词。
 */
function passesIntegrationGate(provider: CLIAgentPluginProvider): boolean {
  const probe = probeGuguIntegration(provider.capabilities);
  if (probe.integrated) return true;
  const model = provider.capabilities.sessionBundle?.units.model;
  const modelDeclaredUnsupported = model?.kind === 'none' && model.degraded.code === 'unsupported-channel';
  return modelDeclaredUnsupported && probe.mcp && probe.env && probe.promptBlocks && probe.autonomy;
}

/** 没声明就抛:读记录 / 用量 / fork 的调用方被路由到了一家没声明原生配置根的 harness。 */
export function requireNativeHome(providerId: string): NativeHome {
  const nativeHome = pluginRegistry.get(providerId)?.capabilities.sessionBundle?.nativeHome;
  if (!nativeHome) throw new Error(`Agent plugin '${providerId}' does not declare sessionBundle.nativeHome`);
  return nativeHome;
}

export function resolveSessionpageSessionIntegration(
  providerId: string,
  surface: SessionpageSessionSurface
) {
  const provider = pluginRegistry.get(providerId);
  if (!provider) throw new Error(`Unknown agent plugin '${providerId}'`);
  const integration = provider.capabilities.sessionBundle.sessionpage[surface];
  if (!integration) {
    throw new Error(
      `Agent plugin '${providerId}' does not declare a ${surface} sessionpage integration`
    );
  }
  const override = process.env.GUGU_SESSION_TEST_HOOKS === '1'
    ? sessionpageIntegrationOverrides.get(sessionpageIntegrationOverrideKey(providerId, surface))
    : undefined;
  // @@@4682 override 的语义是「**盖掉我指名的那几格**」,不是「把其余格子清空」。
  // `...integration` 打头是必需的:少了它,`injection` / `terminalInput` / `hostAdapter` 会被**静默丢掉** ——
  // 而 `injection` 缺席按契约等于「未判定 → 最保守的 idle-only」,于是一个只想把 messageTransport
  // 打成 none 的 fault injection,会**顺带把注入档位降一档**,且没有任何地方出声。
  return override
    ? {
        ...integration,
        identity: override.identity ?? integration.identity,
        messageTransport: override.messageTransport ?? integration.messageTransport,
        inbound: override.inbound ?? integration.inbound,
      }
    : integration;
}

/** Resolve the provider-neutral static credential lifecycle for a declared sessionpage surface. */
export function resolveSessionpageCredentialLifecycle(
  providerId: string,
  surface: SessionpageSessionSurface,
) {
  const provider = pluginRegistry.get(providerId);
  if (!provider) throw new Error(`Unknown agent plugin '${providerId}'`);
  const direct = resolveSessionCredentialLifecycle(provider.capabilities.sessionBundle, surface);
  if (direct) return direct;

  // A session-TUI can be a visible adapter over a native app-server owner. Resolve its
  // lifecycle through the declared adapter mapping; the materializer still only consumes
  // the native surface it actually declares.
  const nativeSurface = resolveSessionpageNativeSurface(providerId, surface);
  if (nativeSurface && nativeSurface !== surface) {
    return resolveSessionCredentialLifecycle(provider.capabilities.sessionBundle, nativeSurface);
  }
  return null;
}

/**
 * The descriptor surface that physically carries a session-page leg: the leg itself when the
 * descriptor declares it, otherwise (session-TUI only) the surface its host adapter rides on.
 * `null` = no declared surface carries this leg.
 */
export function resolveSessionpageNativeSurface(
  providerId: string,
  surface: SessionpageSessionSurface,
): HarnessSessionSurface | null {
  const provider = pluginRegistry.get(providerId);
  if (!provider) throw new Error(`Unknown agent plugin '${providerId}'`);
  const descriptor = provider.capabilities.sessionBundle;
  if (descriptor.surfaces.includes(surface)) return surface;
  if (surface !== 'tui' || !descriptor.sessionpage['tui']) return null;
  return ADAPTER_REQUIRED_SURFACE[resolveSessionpageHostAdapter(providerId, surface)] ?? null;
}

/**
 * 这条腿**收不收得进**消息 —— #4670 的入站可达性轴,唯一产地。
 *
 * ❌ 别在别处拿 `integration.inbound` 再判一遍,也❌ 别从 `messageTransport` / `prompt.kind` 推:
 * 前者被身份供给闸同时读着(说"无入站"会连身份一起否掉,正是本轴要解开的那个绑架),
 * 后者是 provider 级的**启动首句**通道声明,与 per-surface 的入站事实是两回事。
 *
 * 缺席 = 收得进:现存 51 个 `addressable` 格的入站早已被各自的投递读数证实,一律降成"收不进"才是编造。
 */
export function sessionpageAcceptsInboundMessages(
  providerId: string,
  surface: SessionpageSessionSurface,
): boolean {
  return resolveSessionpageSessionIntegration(providerId, surface).inbound !== 'none';
}

/**
 * Test-only runtime fault injection for the built Electron black-box suite.
 * Production code cannot alter capability declarations; this only changes the main-process resolver
 * while the explicit env-gated test hooks are enabled, so sendMessage exercises its real guard.
 */
export function setSessionpageSessionIntegrationOverrideForTest(
  override: SessionpageIntegrationOverride,
): void {
  if (process.env.GUGU_SESSION_TEST_HOOKS !== '1') {
    throw new Error('sessionpage integration test override is disabled');
  }
  const provider = pluginRegistry.get(override.providerId);
  if (!provider) throw new Error(`Unknown agent plugin '${override.providerId}'`);
  if (!provider.capabilities.sessionBundle.sessionpage[override.surface]) {
    throw new Error(
      `Agent plugin '${override.providerId}' does not declare a ${override.surface} sessionpage integration`,
    );
  }
  if (override.identity === undefined && override.messageTransport === undefined) {
    sessionpageIntegrationOverrides.delete(sessionpageIntegrationOverrideKey(override.providerId, override.surface));
    return;
  }
  sessionpageIntegrationOverrides.set(
    sessionpageIntegrationOverrideKey(override.providerId, override.surface),
    { ...override },
  );
}

export function clearSessionpageSessionIntegrationOverridesForTest(): void {
  if (process.env.GUGU_SESSION_TEST_HOOKS !== '1') {
    throw new Error('sessionpage integration test override is disabled');
  }
  sessionpageIntegrationOverrides.clear();
}

export function resolveSessionTuiHostAdapter(
  providerId: string,
  registry: ReturnType<typeof createAgentPluginRegistry> = pluginRegistry
): SessionTuiHostAdapter {
  const provider = registry.get(providerId);
  if (!provider) throw new Error(`Unknown agent plugin '${providerId}'`);
  const descriptor = provider.capabilities.sessionBundle;
  if (!descriptor.sessionpage['tui']) {
    throw new Error(
      `Agent plugin '${providerId}' does not declare a session-TUI host adapter`
    );
  }
  const integrationHostAdapter = descriptor.sessionpage['tui'].hostAdapter;
  if (integrationHostAdapter) return integrationHostAdapter;
  const hostAdapter = provider.behavior.sessionBundle?.sessionTuiHostAdapter;
  if (hostAdapter) return hostAdapter;
  if (descriptor.surfaces.includes('tui')) return 'provider-session-bundle';
  throw new Error(`Agent plugin '${providerId}' has no resolvable session-TUI host adapter`);
}

/**
 * 终端腿启动时宿主要做的两个决定,都从声明里读(❌ 调用点按 provider 名字分支):
 *  · `replayPromptBlocksOnResume`:续跑也要递身份块(提示块通道每次调用现插、不进历史,见
 *    `promptBlocksReplayedEverySpawn`);
 *  · `startupTurnViaLocalSession`:首句不进启动参数,由宿主在会话就绪之后经 local-session 注入
 *    (见 `providerStartupTurnViaLocalSession`)—— 宿主要为它给出启动门。
 */
export function resolveSessionTuiStartupPolicy(
  providerId: string,
  registry: ReturnType<typeof createAgentPluginRegistry> = pluginRegistry
): { replayPromptBlocksOnResume: boolean; startupTurnViaLocalSession: boolean } {
  const provider = registry.get(providerId);
  if (!provider) throw new Error(`Unknown agent plugin '${providerId}'`);
  const descriptor = provider.capabilities.sessionBundle;
  return {
    replayPromptBlocksOnResume: promptBlocksReplayedEverySpawn(descriptor, 'tui'),
    startupTurnViaLocalSession: providerStartupTurnViaLocalSession(
      provider.capabilities.prompt,
      descriptor.sessionpage['tui']?.messageTransport,
    ),
  };
}

/** Resolve the host-owned control channel for any session-page surface. */
export function resolveSessionpageHostAdapter(
  providerId: string,
  surface: SessionpageSessionSurface,
  registry: ReturnType<typeof createAgentPluginRegistry> = pluginRegistry,
): SessionpageHostAdapter {
  const provider = registry.get(providerId);
  if (!provider) throw new Error(`Unknown agent plugin '${providerId}'`);
  const integration = provider.capabilities.sessionBundle.sessionpage[surface];
  if (!integration) {
    throw new Error(`Agent plugin '${providerId}' does not declare a ${surface} sessionpage integration`);
  }
  if (integration.hostAdapter) return integration.hostAdapter;
  const behavior = provider.behavior.sessionBundle;
  if (surface === 'tui' && behavior?.sessionTuiHostAdapter) return behavior.sessionTuiHostAdapter;
  return 'provider-session-bundle';
}

import { CANONICAL_SESSION_TUI_DELIVERY_TOOL_NAMES } from './delivery-tool-names';

export function resolveSessionTuiDeliveryToolNames(
  providerId: string,
  registry: ReturnType<typeof createAgentPluginRegistry> = pluginRegistry
): SessionTuiDeliveryToolNames {
  const provider = registry.get(providerId);
  if (!provider) throw new Error(`Unknown agent plugin '${providerId}'`);
  if (!provider.capabilities.sessionBundle.sessionpage['tui']) {
    throw new Error(
      `Agent plugin '${providerId}' does not declare session-TUI delivery tool names`
    );
  }
  // 模型面工具名只有一个出处:harness 的 MCP 能力声明(`capabilities.mcp.toolNames`)。
  // ❌ 没声明就回落裸名 —— 那正是「记账静默丢失」的形状;量过了再来。
  const mcp = provider.capabilities.mcp;
  // 这是终端腿的投递面 ⇒ 读终端腿的形态(两条腿是两个程序的家按腿声明,见 `mcpToolNamesOn`)。
  const names = mcp.kind === 'supported' ? mcpToolNamesOn(mcp.toolNames, 'tui') : { kind: 'unmeasured' as const };
  if (names.kind === 'unmeasured') {
    throw new Error(
      `Agent plugin '${providerId}' has no measured MCP tool names; declare capabilities.mcp.toolNames in impl/${providerId}/index.ts`
    );
  }
  // `server-proxied`:模型经通用代理工具调,目标写成 (server 名, **裸**工具名) —— 模型眼里的工具名
  // 就是 canonical 本身,❌ 不拼前缀(拼出来的字符串在这家 harness 里不存在)。`namespaced` 同理:命名空间里是裸名。
  const prefix = names.kind === 'server-proxied' || names.kind === 'namespaced' ? '' : names.prefix;
  return {
    message: `${prefix}${CANONICAL_SESSION_TUI_DELIVERY_TOOL_NAMES.message}`,
  };
}

/** 宿主给每条会话都带的那一组咕咕产品包(各家声明自己的那一个,这里只是汇总)。 */
export const PRODUCT_CAPABILITY_PACKAGES = [
  CLAUDE_GUGU_CAPABILITY_PACKAGE,
  CODEX_GUGU_CAPABILITY_PACKAGE,
  OPENCODE_GUGU_CAPABILITY_PACKAGE,
  PI_GUGU_CAPABILITY_PACKAGE,
] as const;

export {
  CLAUDE_GUGU_CAPABILITY_PACKAGE,
  CODEX_GUGU_CAPABILITY_PACKAGE,
  CODEX_ACP_MINIMUM_VERSION,
  OPENCODE_PLUGIN_CONTENT,
  OPENCODE_GUGU_EVENT_MODULE_PATH,
  OPENCODE_GUGU_CAPABILITY_PACKAGE,
  PI_GUGU_CAPABILITY_PACKAGE,
  materializeCodexSessionBundle,
  materializeQwenSessionBundle,
};
// 平台会话 Chat UI 信封里 codex / claude 各自的那一份(宿主拼信封时用)。
export {
  CODEX_PLATFORM_PROVIDER_ID,
  codexPlatformAuthRequest,
  codexPlatformProviderArgs,
  codexPlatformProviderBlock,
  type CodexPlatformAuthRequest,
  type CodexPlatformProviderBlock,
} from './impl/codex/platform-model';
export { claudeAcpPlatformSessionMeta, type ClaudeAcpPlatformSessionMeta } from './impl/claude/platform-model';
// 宿主登记中继入口用的变量名 —— 只此一份,❌ 在 worker-manifest 里另写一个字面量。
export { GUGU_MCP_STDIO_RELAY_ENTRY_ENV } from './impl/antigravity/session-bundle';
export { effortOptionsFromReasoningVariants } from './helpers/opencode-family-model-config';
// opencode 家 TUI 腿(serve/attach)的会话名判读:宿主的 serve transport 读 SSE 时用。
export { opencodeFamilyUpdatedTitle } from './helpers/opencode-family-title';
// @@@5380 agent 事件 hook 的 `notify` 回调值。宿主侧只需要**值**(它进 thread-open 的
// `config` map),❌ 不再导出 `-c notify=…` 的 argv 拼法 —— 那条腿已经没有宿主消费者了。
export { codexNotifyConfigValue } from './impl/codex/hooks';
export {
  CODEX_ACTOR_AUTHORIZATION_HEADER,
  CODEX_PLATFORM_DISABLE_APPS_ARGS,
} from './impl/codex/platform-provider-args';
