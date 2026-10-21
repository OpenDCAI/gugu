import { harnessPlatform } from './platform';
import type {
  NativeHome,
  Degradation,
  SessionBundleDescriptor,
  SessionCapabilityBundle,
  SessionMaterialization,
  SessionModelCapability,
  SessionMaterializationContext,
} from '@gugu/session-core/agents/plugins';
import {
  materializeAcpSessionBundle,
  sessionPromptText,
} from '../../helpers/session-bundle';

const unverifiedExtension: Degradation = {
  code: 'unverified',
  reason: 'Hermes Agent extension delivery has not been verified at a controlled product collection point.',
};

// 只开 ACP 腿:终端腿(`tui`)不声明,界面上就没有「编程/Code」这一种展示。
// ACP 腿是咕咕自己的桥(`runtime/hermes-serve-acp.ts`),说 `hermes serve` —— Hermes Desktop 用的那个后端。
export const hermesSessionBundleDescriptor = {
  injectionMode: 'runtime',
  nativeHome: { envVar: 'HERMES_HOME', userPath: '.hermes', evidence: 'hermes_cli:HERMES_HOME,默认 ~/.hermes;serve 继承用户自己的那份(runtime/hermes-serve/serve.ts)' } satisfies NativeHome,
  platform: harnessPlatform,
  // 令牌在桥进程环境里(`GUGU_HERMES_PLATFORM_KEY`),桥再交给 serve 的进程环境,托管层只写 `${…}` ⇒ 到期按原形态重开。
  // 跨计费路(平台 ↔ 自己的模型)仍按 `replace` 起一条新的:serve 下两种会话已在同一个 HERMES_HOME 的会话库里,
  // 但「同一条会话换计费路」没量过,❌ 不凭推断声明 `preserve`。
  credentialLifecycle: {
    'acp': {
      delivery: 'child-process-env',
      originalProcessRefresh: 'unsupported',
      recovery: 'reopen',
      inferenceOwner: 'provider-process',
      reopenEntry: 'host-session-reload',
      sourceChangeSession: 'replace',
    },
  },
  surfaces: ['acp'],
  /**
   * 聊天腿的版本地板:咕咕的桥第一句就调 serve 的 `client.capabilities`,0.21.5 之前的 hermes 不认这个方法
   * (mac1 0.21.0 实撞 2026-10-06;#6907 量过 0.21.5 与 main 都认)。声明在这里,起会话前的通用版本闸
   * 就能当场说「需要 0.21.5,现在是 0.21.0」,❌ 等桥连上 serve 再抛一句英文。
   */
  runtimeCompatibility: {
    'acp': { kind: 'semver-supported-floor', supportedFloor: '0.21.5', versionArgs: ['--version'] },
  },
  sessionpage: {
    'acp': {
      identity: 'addressable',
      messageTransport: 'router',
      // 忙时消息走 `_session/steering` → serve 的 `session.steer`:在飞那一轮的下一个工具边界注入,❌ 不打断、
      // ❌ 不排队。agent 还在构建(提交后、`message.start` 前,serve 回 4010)时桥扣住,等那一轮起来再 steer;
      // 模型最后一步没调工具时 hermes 把它交回成下一轮,桥让同一条 ACP prompt 跨到那一轮结束。
      injection: {
        timing: 'next-tool-call',
        evidence: 'shuxueshuxue/gugu-base@e4c3f30136b44e6a4e64e3f7dab2c2585b209690 evidence/2026-10-04-hermes-serve-bridge '
          + '(Phase 0, v2026.9.24 and main ddde0670: a busy steer lands in the next request of the same turn, an idle one is rejected; '
          + 'bridge cells tests/unit/desktop/electron/hermesServeAcp.test.ts)',
      },
    },
  },
  units: {
    // ⚠️ 工具表里看不到 `mcp__*` 不是没送到:hermes 的渐进披露把 MCP 工具藏在 tool_search /
    //    tool_call 桥后面(见 `index.ts` 的 `capabilities.mcp.toolNames`)。
    mcp: { kind: 'native', channel: 'acp-session' },
    env: { kind: 'native', channel: 'child-process' },
    // 平台模型(连同整组可切模型与逐模型推理档)以事实交到桥的进程环境(`hermesPlatformEnv`);桥再写进 serve 的
    // 托管层 config.yaml —— 咕咕自有的那份,❌ 不碰用户的 HERMES_HOME。
    model: { kind: 'native', channel: 'process-config' },
    autonomy: { kind: 'none', degraded: { code: 'unverified', reason: 'Approvals are a live ACP setting (mode), not a bundle unit.' } },
    // `session/new` 的 `_meta.systemPrompt.append` → 桥写成 `session.create` 的隐藏种子行(Hermes Desktop
    // 给模型垫话的同一个机制):随会话存下、不进标题。
    promptBlocks: { kind: 'native', channel: 'developer-instructions' },
  },
  extension: { kind: 'none', degraded: unverifiedExtension },
  coexistence: {
    // - 打断走协议 cancel(桥 → `session.interrupt`),落在 turn 状态机的 cancelled outcome 上
    // - plan:serve 的 `todo.updated` → ACP `plan`
    // - observability:ACP update 流 → projectSessionState 的 isGenerating / canCancel / lifecycle
    // - askUser:serve 的 `approval` / 带选项的 `clarify` → ACP `session/request_permission`。⚠️ 只算授权型与选择题;
    //   自由文本澄清没有 ACP 表单,桥答「跳过」,❌ 不许声明更多。
    pause: { kind: 'native', channel: 'protocol-cancel' },
    observability: { kind: 'native', channel: 'acp-update' },
    askUser: { kind: 'native', channel: 'permission-ask' },
    todo: { kind: 'native', channel: 'acp-plan' },
    // 记忆文件在磁盘上,读它不需要活着的会话(`AgentPluginHost.readMemoryFiles`,登记见 index.ts)。
    memory: { kind: 'native', channel: 'agents-md' },
    // introspection 走 `config-scan`:读用户自己的 `~/.hermes/config.yaml` `mcp_servers`(写口由共享适配器钳死)。
    introspection: { kind: 'native', channel: 'config-scan' },
  },
} satisfies SessionBundleDescriptor;

/**
 * 平台会话交给桥的事实:中转地址、令牌、选中的模型,以及这条会话可热切到的整组模型(逐模型的窗口与推理档,
 * 全部来自网关目录)。整组模型的格式与 codex 桥共用(`GUGU_PLATFORM_MODELS`,`runtime/codex-model-catalog.mjs`
 * 的 `platformModelFacts` 解析)。用户自己的模型:一个键都不发,桥列 hermes 自己的 `model.options`。
 * 会话包与平台信封(`./platform-model.ts` 的 `load`)读同一个函数:同一组键、同一个写法。
 */
export function hermesPlatformEnv(model: SessionModelCapability | null | undefined): Record<string, string> {
  if (!model) return {};
  if (model.dialect !== 'hermes-serve-env') {
    throw new Error(`Hermes session adapter cannot materialize model dialect '${model.dialect}'`);
  }
  const selected = model.model?.trim();
  if (!model.platformProvider || !selected) return {};
  const facts = (model.platformModels?.length ? model.platformModels : [{ id: selected, displayName: selected }])
    .map((entry) => ({
      id: entry.id,
      displayName: entry.displayName,
      contextWindow: entry.contextWindow ?? (entry.id === selected ? model.contextWindow ?? null : null),
      efforts: [...((entry.reasoningEfforts ?? (entry.id === selected ? model.reasoningEfforts : null)) ?? [])],
    }));
  return {
    GUGU_HERMES_PLATFORM_BASE_URL: model.platformProvider.baseUrl,
    GUGU_HERMES_PLATFORM_KEY: model.platformProvider.apiKey,
    GUGU_HERMES_PLATFORM_MODEL: selected,
    GUGU_PLATFORM_MODELS: JSON.stringify(facts),
  };
}

export function materializeHermesSessionBundle(
  ctx: SessionMaterializationContext,
  bundle: SessionCapabilityBundle
): SessionMaterialization {
  const result = materializeAcpSessionBundle('hermes', hermesSessionBundleDescriptor, ctx, bundle);
  const modelEnv = hermesPlatformEnv(bundle.model);
  const prompt = sessionPromptText(bundle.promptBlocks);
  return {
    ...result,
    env: { ...result.env, ...modelEnv },
    prompt,
    report: {
      ...result.report,
      units: {
        ...result.report.units,
        model: modelEnv.GUGU_HERMES_PLATFORM_MODEL ? { status: 'loaded' as const } : result.report.units.model,
        promptBlocks: prompt ? { status: 'loaded' as const } : result.report.units.promptBlocks,
      },
    },
  };
}
