import { harnessPlatform } from './platform';
import type {
  Degradation,
  SessionBundleDescriptor,
  SessionCapabilityBundle,
  SessionMaterialization,
  SessionMaterializationContext,
} from '@gugu/session-core/agents/plugins';
import {
  sessionMcpProtocolServers,
} from '../../helpers/session-mcp';
import { sessionContextPrompt } from '../../helpers/session-bundle';

const VERSION = '0.57.0';
const unverified = (unit: string): Degradation => ({
  code: 'unverified',
  reason: `Gemini CLI v${VERSION} ${unit} delivery has not been verified at a controlled product collection point.`,
});
const zeroResidueExtension: Degradation = {
  code: 'violates-zero-residue',
  reason:
    'Gemini CLI extensions install/link only into the user-home ~/.gemini/extensions (v0.54.4 anchor, '
    + 'v0.57.0 still manages the same user-global store), violating zero global residue.',
};
/** 自治档不走物化：它经 ACP `session/set_mode` 在运行期下发，见 `capabilities.autoApprove.modes`。 */
const autonomyViaAcpModes: Degradation = {
  code: 'unverified',
  reason:
    'Gemini autonomy is delivered at runtime through ACP session/set_mode from the autoApprove.modes ladder, '
    + 'not through session materialization.',
};

/**
 * Gemini CLI 的唯一已发货 surface 仍是协议腿（`acp`）。
 *
 * 与旧版（surfaces: []，除 mcp/env 外全 `unverified`）的差别，逐格都有 2026-09-01 对
 * `@google/gemini-cli@0.57.0` 的真机读数背书（#4655，隔离 cwd + 本地假 Gemini 线端点，
 * 零真实推理，全部带变异或行为对照；配方与读数见 PR 与本节点 spec 正文）：
 *
 *  · **mcp / acp-session**：`session/new` 的 http mcpServers 走到 initialize→initialized→tools/list，
 *    注入的工具出现在下一次模型请求体里（`toolDeclared=true`）。Authorization 只进 header。
 *    ⚠️ 两个真实前置，都在 `impl/gemini/index.ts` 的 ACP spawn 上收口：
 *    - **信任门**：未信任目录下 MCP 被静默禁用（`gemini mcp list` 自己的话：
 *      "MCP servers are configured but disabled because this folder is untrusted"）。
 *      spawn 带 `--skip-trust`（官方语义「Trust the current workspace for this session」，
 *      会话级、零落盘 —— 比往用户的 ~/.gemini/trustedFolders.json 里替他积累临时工作区条目干净）。
 *    - **宿主 node 版本**：gemini 自带的 undici 栈在 node 26.8.1 上收到合法 initialize 应答后
 *      静默断连（22.23 / 24.14 / 25.9 全通，26 独红；qwen 打同一 server 全通 = server 无罪）。
 *      这是厂商 bug，边界记在这里免得下一个人把它当咕咕侧缺口去修。
 *  · **model / process-config**：`GOOGLE_GEMINI_BASE_URL` + `GEMINI_API_KEY` + `GEMINI_MODEL`
 *    三个纯环境变量（官方 docs/reference/configuration.md 在案）。实测请求打到注入的端点、
 *    路径带注入的模型名、`x-goog-api-key` 逐字等于注入的 key；换 key/换 model 读数跟着变。
 *    发行包源码另证：`GOOGLE_GEMINI_BASE_URL` 存在时 ACP 侧 authType 自动选 GATEWAY。
 *  · **promptBlocks / session-context**：`session/prompt` 是主通道 —— marker 字节实测进了
 *    模型请求体。与 qwen 同理（behavior `agent-context-injection`「②③ 只差载体」），
 *    ❌ 不走 `_meta.systemPrompt.append`（那是咕咕给 codex/claude 的私约，原生 ACP server 收下即丢）。
 *  · **autonomy**：不占物化格。四档 modes 由 `session/new` 自报，行为对照三档互不相同
 *    （default=1 次询问且拒后不跑；yolo=0 询问直接执行；plan=0 询问且工具被拦），
 *    运行期经 `session/set_mode` 下发 —— 声明在 `capabilities.autoApprove.modes`（claude 同形）。
 */
export const geminiSessionBundleDescriptor = {
  injectionMode: 'runtime',
  platform: harnessPlatform,
  // 平台令牌是适配器进程环境里的 `GEMINI_API_KEY`(三键同进同出),spawn 后换不了值 ⇒ 到期按原形态重开。
  credentialLifecycle: {
    'acp': {
      delivery: 'child-process-env',
      originalProcessRefresh: 'unsupported',
      recovery: 'reopen',
      inferenceOwner: 'provider-process',
      reopenEntry: 'host-session-reload',
      sourceChangeSession: 'preserve',
    },
  },
  surfaces: ['acp'],
  sessionpage: {
    /**
     * 两轴与 qwen 的 `acp` 同声明：identity 走通用 provisioning，普通消息经 router
     * 化成 `route=chat` 信封进 ACP `session/prompt`（#4612 那条链路，对 provider 通用）。
     * 结构声明只表示产品会选择并启动这条路径；产品级闭环读数按
     * `e2e/agent/qwen-acp-delivery-4530.spec.ts`(#6270 已删) 的形状为 gemini 立判据（本节点 eval 的
     * `gemini-product-reachable` 场景），B 读数落地前不外推「消息成功到达」。
     */
    'acp': {
      identity: 'addressable',
      messageTransport: 'router',
      // 第三轴 injection（spec session-injection，next-tool-call 铺开第二批 2026-09-01）：
      // 忙时第二条**标准** `session/prompt` 受理，turn-1 主 RPC 报 `stopReason=cancelled`（假 cancelled，
      // 由 cell 移交守卫覆盖），暗号折进本轮 —— 在 ping 结果尚未回时（tool_results=0）即进模型，firstToolResultReq
      // 亦携暗号。busy 3/3 + idle 阳控 1/1（gemini-cli 0.57.0，本地 gemini-format 假端点，咕咕不在回路）。
      // 与 qwen 同形；机制走宿主共用的 detached ACP steer 腿（steerIfBusy），内核零 diff。
      injection: {
        timing: 'next-tool-call',
        evidence:
          'shuxueshuxue/gugu-base@95501c067bbc626f56972aa98362e433a1f6a3a1 evidence/2026-09-01-nextcall-batch2-gemini（gemini ACP busy 3/3 next-tool-call + idle 1/1；gemini generateContent 假端点）',
        // 忙时 turn-1 主 RPC 报 stopReason=cancelled（假 cancelled），由 cell 移交守卫覆盖 —— 与 qwen 同款、机器可见，不藏注释。
        deviations:
          '忙时 turn-1 主 RPC 报 stopReason=cancelled（假 cancelled），由 cell 移交守卫覆盖 —— 工具往返照常完成、暗号照常在 tool 边界进模型、turn 不落 cancelled 终态，对用户透明',
      },
    },
  },
  units: {
    mcp: { kind: 'native', channel: 'acp-session' },
    env: { kind: 'native', channel: 'child-process' },
    model: { kind: 'native', channel: 'process-config' },
    autonomy: { kind: 'none', degraded: autonomyViaAcpModes },
    promptBlocks: { kind: 'native', channel: 'session-context' },
  },
  extension: { kind: 'none', degraded: zeroResidueExtension },
  coexistence: {
    /** ACP `cancel` 是官方列出的核心方法（随包 docs/cli/acp-mode.md），经 cell.cancel 同一条通用链。 */
    pause: { kind: 'native', channel: 'protocol-cancel' },
    /** `session/update` 流实测在跑（available_commands / agent_message_chunk / tool_call 全见过）。 */
    observability: { kind: 'native', channel: 'acp-update' },
    /** `session/request_permission` 实测发到客户端，拒绝后工具真的没跑（default 档行为对照）。 */
    askUser: { kind: 'native', channel: 'permission-ask' },
    /**
     * `geminiMcpAdapter()` 扫用户自己的 `~/.gemini/settings.json` 的 `mcpServers`，
     * 咕咕写的与用户手写的一视同仁 —— 不用启引擎 → config-scan（同 qwen）。
     */
    introspection: { kind: 'native', channel: 'config-scan' },
    memory: { kind: 'native', channel: 'vendor-file' },
  },
} satisfies SessionBundleDescriptor;

/**
 * 把选中的平台模型落成 gemini 认的那三个环境变量（实测 0.57.0，出处见 descriptor 抬头）。
 *
 * ⚠️ 三个键同进同出：`GEMINI_API_KEY` 单独也能跑，但那会把平台 key 打到 Google 默认端点 ——
 *    计费打错人。所以「不成立就一个键都别发」，同 qwen 的 early-return 形。
 * ❌ 非平台会话（BYOK / 用户自己的 key）这里一个键都不发 —— 不顶掉用户自己的配置。
 * ⚠️ 中转两键只认协议表的原话（宿主写进 `platformSettingsEnv`），❌ 不从 `platformProvider.baseUrl`
 *    反推：那是 OpenAI 面的 `/v1` 根，gemini-cli 自己再拼 `/v1beta/...` 就成了
 *    `POST /v1/v1beta/models/<alias>:streamGenerateContent`，网关 404（#4700 共享测试真机首读即红）。
 *    缺两键 = 有人绕开协议表另拼了一条路，响亮拒绝而不是剥后缀。
 */
function applyModelEnv(bundle: SessionCapabilityBundle, env: Record<string, string>): void {
  const model = bundle.model;
  if (!model) return;
  if (model.dialect !== 'gemini-env') {
    throw new Error(`Gemini session adapter cannot materialize model dialect '${model.dialect}'`);
  }
  const platform = model.platformProvider;
  if (!platform) return;
  const selected = model.model?.trim();
  if (!selected) return;
  const baseUrl = model.platformSettingsEnv?.GOOGLE_GEMINI_BASE_URL?.trim();
  const apiKey = model.platformSettingsEnv?.GEMINI_API_KEY?.trim();
  if (!baseUrl || !apiKey) {
    throw new Error(
      'Gemini session adapter: platform relay env must come from the protocol table '
        + '(platformSettingsEnv.GOOGLE_GEMINI_BASE_URL + GEMINI_API_KEY); refusing to derive it from '
        + 'platformProvider.baseUrl, which carries the OpenAI-surface /v1 suffix (#4700)'
    );
  }
  env.GOOGLE_GEMINI_BASE_URL = baseUrl;
  env.GEMINI_API_KEY = apiKey;
  env.GEMINI_MODEL = selected;
}

export function materializeGeminiSessionBundle(
  ctx: SessionMaterializationContext,
  bundle: SessionCapabilityBundle
): SessionMaterialization {
  if (!geminiSessionBundleDescriptor.surfaces.includes(ctx.surface as never)) {
    throw new Error(`Gemini session adapter does not support surface '${ctx.surface}'`);
  }
  const env = Object.fromEntries(
    Object.entries(bundle.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  const mcpServers = sessionMcpProtocolServers(bundle, 'Gemini');
  for (const server of bundle.mcpServers) {
    if (server.transport !== 'stdio' && server.authorizationEnv) delete env[server.authorizationEnv];
  }
  const prompt = sessionContextPrompt(bundle.promptBlocks);
  applyModelEnv(bundle, env);
  const loaded = { status: 'loaded' as const };
  return {
    argsAppend: [],
    env,
    acp: { mcpServers },
    ...(prompt ? { prompt } : {}),
    configMerges: [],
    artifacts: [],
    report: {
      adapterId: 'gemini',
      surface: ctx.surface,
      units: {
        mcp: loaded,
        env: loaded,
        model: bundle.model
          ? loaded
          : { status: 'degraded', reason: { code: 'unverified', reason: 'No model was declared.' } },
        autonomy: { status: 'degraded', reason: autonomyViaAcpModes },
        promptBlocks: prompt
          ? loaded
          : { status: 'degraded', reason: unverified('prompt blocks') },
        packages: { status: 'degraded', reason: zeroResidueExtension },
      },
      discoveredCommands: [],
    },
  };
}
