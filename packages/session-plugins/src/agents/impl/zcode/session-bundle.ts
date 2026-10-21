import { harnessPlatform } from './platform';
import type {
  Degradation,
  SessionBundleDescriptor,
  SessionCapabilityBundle,
  SessionMaterialization,
  SessionMaterializationContext,
  SessionModelCapability,
} from '@gugu/session-core/agents/plugins';
import {
  sessionMcpProtocolServers,
} from '../../helpers/session-mcp';
import { sessionContextPrompt } from '../../helpers/session-bundle';

/**
 * ZCode(智谱)只开聊天面板腿。
 *
 * ZCode 的 CLI 没有 ACP(`zcode acp` 已删,它自己的测试断言 Unknown command);它的桌面端与 CLI 之间
 * 走 ZCode 自己的协议 `zcode app-server --stdio`。ACP 腿由社区桥 zcode-acp-server 提供 —— 它驱动的
 * 正是那个 app-server,咕咕用的是咕咕维护的构建 `@gugu-acp/zcode-acp`(上游 + 补丁,
 * shuxueshuxue/gugu-acp `bridges/zcode-acp/`)。终端腿不开:官方带 TUI 的 CLI 没有对外发行
 * (桌面包里的 CLI 不带 `@zcode/tui`)。
 *
 * 下面每一格的读数出自 gugu-base `notes/2026-10-16-zcode-harness/`(ZCode 3.15.3 / CLI 0.16.9,
 * 打包好的 `@gugu-acp/zcode-acp` 1.0.0,裸 ACP 客户端):
 *  · **mcp / acp-session**:`session/new.mcpServers` 原样到达(桥把 ACP 形状直接交给 app-server
 *    的 `session/create`),注入的 stdio 工具被模型调到,名字是 `mcp__<server>__<tool>`。
 *  · **promptBlocks / session-context**:咕咕各家都把提示块放进第一轮的输入;ZCode 的 `session/create`
 *    没有追加系统提示的参数,这一家也照此办。
 *  · **autonomy**:不占物化格。档位由 `session/new` 自报(configOption `mode`),运行期经
 *    `session/set_config_option` 下发 —— 声明在 `capabilities.autoApprove.modes`。
 */
export const zcodeSessionBundleDescriptor = {
  injectionMode: 'runtime',
  platform: harnessPlatform,
  // 平台令牌在桥进程环境里那份 provider 表中(桥启动时落成它自己的 0600 文件),spawn 后换不了值 ⇒ 到期按原形态重开。
  // 跨计费路(平台 ↔ 用户自己的 provider)起一条新的:同一条会话换计费路没量过,❌ 不凭推断声明 `preserve`。
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
  sessionpage: {
    'acp': {
      identity: 'addressable',
      messageTransport: 'router',
      // 忙时消息走 `_session/steering`(桥补丁 0001)→ app-server 的 `sendText` + `requestedDelivery:"guide"`:
      // 在飞那一轮的下一个工具边界并进去,❌ 不打断、❌ 不另起一轮。
      injection: {
        timing: 'next-tool-call',
        evidence: 'shuxueshuxue/gugu-base@c069d68f32ecdfa440528ce70dcef4e59c631081 '
          + 'notes/2026-10-16-zcode-harness/gugu-acp桥-实测与上游草稿.md(@gugu-acp/zcode-acp 1.0.0 + ZCode 3.15.3:'
          + '第 8 秒插话,第一条 prompt end_turn、steering 回 injected、回复同时带两条要求,只有一个回合;'
          + 'app-server 原生 guide 对照见同目录 补丁清单-zcode-acp.md)',
      },
    },
  },
  units: {
    mcp: { kind: 'native', channel: 'acp-session' },
    env: { kind: 'native', channel: 'child-process' },
    // 平台模型:整份 provider 表经桥的进程环境送达(`zcodePlatformEnv`,桥补丁 0005 + 0007)。非平台会话一个键
    // 都不发,用的是用户自己在 ZCode 里配的 provider 与套餐。
    model: { kind: 'native', channel: 'process-config' },
    autonomy: { kind: 'none', degraded: autonomyViaAcpModes() },
    promptBlocks: { kind: 'native', channel: 'session-context' },
  },
  extension: {
    kind: 'none',
    degraded: {
      code: 'violates-zero-residue',
      reason: 'ZCode plugins install into the user-global ~/.zcode/cli/plugins store; there is no per-session plugin directory.',
    },
  },
  coexistence: {
    pause: { kind: 'native', channel: 'protocol-cancel' },
    observability: { kind: 'native', channel: 'acp-update' },
    // 授权与 AskUserQuestion 都经 `session/request_permission` 到客户端(实测:Write / Bash 授权卡;
    // 提问卡的选项是 Red / Blue / Skip,选完 agent 接着答)。
    askUser: { kind: 'native', channel: 'permission-ask' },
    todo: { kind: 'native', channel: 'acp-plan' },
    // 记忆文件在磁盘上:项目根与 ZCode 数据根下的 `AGENTS.md`(登记见 index.ts)。
    memory: { kind: 'native', channel: 'agents-md' },
  },
} satisfies SessionBundleDescriptor;

function autonomyViaAcpModes(): Degradation {
  return {
    code: 'unverified',
    reason:
      'ZCode autonomy is delivered at runtime through the ACP mode setting from the autoApprove.modes ladder, '
      + 'not through session materialization.',
  };
}

/** ZCode provider 表里咕咕那一家的 id;`ZCODE_PROVIDER` 把桥的模型菜单钉在它上面。 */
export const ZCODE_PLATFORM_PROVIDER_ID = 'gugu-platform';

/**
 * 平台会话交给桥的事实:一整份 ZCode 个人 provider 表(`ZCODE_PERSONAL_PROVIDER_CONFIG_CONTENT`),加上把模型菜单
 * 钉在它上面的 `ZCODE_PROVIDER`。用户自己的模型:一个键都不发。
 *
 * 表的形状是 ZCode 自己的 `provider_config.json`(zai-org/ZCode `packages/provider-node/src/provider-config-file-codec.ts`,
 * `packages/provider/src/config/provider-data-schema.ts`):`access.apiKey` 只认字面值,所以令牌在表里 ——
 * 这份表只活在桥的进程环境与桥写的 0600 临时文件里。`api.type` 就是
 * ./platform.ts 声明的 `wireProtocol`(网关按它给 ZCode 开渠道,只此一处),`baseUrl` 是中转的 OpenAI 面根(带 `/v1`)。
 * `defaultModelSelection` 必须带 `options.reasoningLevel`:缺了它 ZCode 静默落回第一个 provider 的第一个模型
 * (ZCode `docs/plugin-eval-docker.md`)。
 */
export function zcodePlatformEnv(model: SessionModelCapability | null | undefined): Record<string, string> {
  if (!model) return {};
  if (model.dialect !== 'zcode-provider-table') {
    throw new Error(`ZCode session adapter cannot materialize model dialect '${model.dialect}'`);
  }
  const selected = model.model?.trim();
  const platform = model.platformProvider;
  if (!platform || !selected) return {};
  const ids = [...new Set([selected, ...(model.platformModels ?? []).map((entry) => entry.id)])];
  const table = {
    schemaVersion: 1,
    config: {
      providerConfigRules: {
        providerRules: [{
          providerId: ZCODE_PLATFORM_PROVIDER_ID,
          config: {
            group: 'standard-personal',
            access: { type: 'api-key', apiKey: platform.apiKey },
            api: { type: harnessPlatform.wireProtocol, baseUrl: platform.baseUrl },
            personalModelIds: ids,
          },
        }],
      },
      modelConfigRules: {
        providerModelRules: ids.map((modelId) => ({
          providerId: ZCODE_PLATFORM_PROVIDER_ID,
          modelId,
          config: { properties: {} },
        })),
        manualProviderModelRules: [],
      },
      defaultModelSelection: {
        providerId: ZCODE_PLATFORM_PROVIDER_ID,
        modelId: selected,
        options: { reasoningLevel: 'disabled' },
      },
    },
  };
  return {
    ZCODE_PERSONAL_PROVIDER_CONFIG_CONTENT: JSON.stringify(table),
    ZCODE_PROVIDER: ZCODE_PLATFORM_PROVIDER_ID,
  };
}

export function materializeZcodeSessionBundle(
  ctx: SessionMaterializationContext,
  bundle: SessionCapabilityBundle
): SessionMaterialization {
  if (!zcodeSessionBundleDescriptor.surfaces.includes(ctx.surface as never)) {
    throw new Error(`ZCode session adapter does not support surface '${ctx.surface}'`);
  }
  const env = Object.fromEntries(
    Object.entries(bundle.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  const mcpServers = sessionMcpProtocolServers(bundle, 'ZCode');
  // Authorization 只进 MCP 的 header,❌ 再以环境变量交给 harness 进程。
  for (const server of bundle.mcpServers) {
    if (server.transport !== 'stdio' && server.authorizationEnv) delete env[server.authorizationEnv];
  }
  const prompt = sessionContextPrompt(bundle.promptBlocks);
  const modelEnv = zcodePlatformEnv(bundle.model);
  const loaded = { status: 'loaded' as const };
  return {
    argsAppend: [],
    env: { ...env, ...modelEnv },
    acp: { mcpServers },
    ...(prompt ? { prompt } : {}),
    configMerges: [],
    artifacts: [],
    report: {
      adapterId: 'zcode',
      surface: ctx.surface,
      units: {
        mcp: loaded,
        env: loaded,
        model: modelEnv.ZCODE_PERSONAL_PROVIDER_CONFIG_CONTENT
          ? loaded
          : { status: 'degraded', reason: { code: 'unverified', reason: 'No platform model was declared.' } },
        autonomy: { status: 'degraded', reason: autonomyViaAcpModes() },
        promptBlocks: prompt
          ? loaded
          : { status: 'degraded', reason: { code: 'unverified', reason: 'No prompt blocks were rendered.' } },
        packages: { status: 'degraded', reason: zcodeSessionBundleDescriptor.extension.degraded },
      },
      discoveredCommands: [],
    },
  };
}
