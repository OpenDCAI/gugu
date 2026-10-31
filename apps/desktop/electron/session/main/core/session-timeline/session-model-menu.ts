import { agentSteersActiveAcpTurn } from '@shared/core/agents/agent-payload';
import type { ProviderPermissionModeMap } from '@gugu/session-core/acp/client';
import type { LiveSettingCapability } from '@gugu/session-core/agents/plugins';
import type { SessionpageSessionOptions } from '@gugu/session-core/session-record/contract';
import { agentConfigListSchema, type AuthStatusModelState } from '@gugu/session-core/workspace-server/agent-config';
import { ReplicaState } from '@gugu/session-wire';
import type { HarnessCatalogState } from '@main/core/agents/harness-model-catalog';
import type { PlatformCatalogModel, PlatformModelCatalogResolver } from '@main/core/agents/platform-model-catalog-hook';
import { log } from '@main/lib/logger';

/**
 * 会话内模型菜单的**事实** —— 桌面会话菜单(acp-chat-panel)喂给装配的那几样,一样一份、同一个来源。
 * 手机拿去跑桌面那份装配(`ownModelTierOptions` / `assembleComposerModelOptions`)与 `planModelSwitch`;
 * ❌ 宿主不替它排菜单、不判能不能热切 —— 那是第二份判据。
 */
export type SessionModelMenu = {
  steers?: boolean;
  /** 这条会话记下的计费路决定(`sessionPlatformModel`);缺席 = 没做过这个决定。 */
  conversationSelection?: { modelId: string } | null;
  /** 「你的 X 模型」的 X —— 与桌面同一个 agent 名。 */
  agentName: string;
  /** 咕咕目录(这家 × 聊天腿)。 */
  platformModels: PlatformCatalogModel[];
  /** 用户自己凭据下的那份目录;会话明确在自己那条路上时不问 —— 活清单就是它(同桌面 @@@own-model-tier)。 */
  ownCatalog: HarnessCatalogState | null;
  /** 这家此刻的登录读数(worker 发布的那一格,桌面 `useAgentAuthStatus` 读的同一份);手机据此叠 `withAuthExpiry`。 */
  ownAuth: AuthStatusModelState | null;
  /** 这家声明的「模型」活设置 —— `planModelSwitch` 的 liveSetting。 */
  liveSetting?: LiveSettingCapability;
};

export type SessionpageSessionOptionsWithMenu = SessionpageSessionOptions & {
  modelMenu?: SessionModelMenu;
  /**
   * 这家声明的权限档表(`capabilities.autoApprove.modes`,来源各家插件的 permission-modes.ts)—— 手机拿它跑桌面那份
   * `localizePermissionModeOptions` / `selectedPermissionModeId`,与桌面同一个来源、同一套说法(#6693)。
   * 缺席 = 这家没声明:手机照它报的名字显示,❌ 自己猜。
   */
  modeMap?: ProviderPermissionModeMap;
};

export async function readSessionModelMenu(sessionId: string, providerId: string): Promise<SessionModelMenu> {
  const [{ sessionPlatformModel }, { getPlatformModelCatalogResolver }, { probeHarnessCatalogState }, { agentsController }] =
    await Promise.all([
      import('@main/core/sessions/platform-model-selection'),
      import('@main/core/agents/platform-model-catalog-hook'),
      import('@main/core/agents/session-discovery'),
      import('@main/core/agents/controller'),
    ]);
  const selection = await sessionPlatformModel(sessionId);
  const [agents, platformModels, ownCatalog, ownAuth] = await Promise.all([
    agentsController.list(),
    readPlatformModels(getPlatformModelCatalogResolver(), providerId),
    selection === null ? null : probeHarnessCatalogState(providerId, 'acp'),
    selection === null ? null : readOwnAuth(providerId),
  ]);
  const agent = agents.find((entry) => entry.id === providerId);
  const liveSetting = agent?.capabilities?.acp?.liveSettings?.model;
  return {
    ...(selection !== undefined ? { conversationSelection: selection } : {}),
    agentName: agent?.name ?? providerId,
    steers: agentSteersActiveAcpTurn(agent?.capabilities),
    platformModels,
    ownCatalog,
    ownAuth,
    ...(liveSetting ? { liveSetting } : {}),
  };
}

/** 只读 worker 已发布的那一格,❌ 不探(同桌面 `useAgentAuthStatus` 的 probe:false)。 */
async function readOwnAuth(providerId: string): Promise<AuthStatusModelState | null> {
  const { getAgentConfigRuntimeClient } = await import('@main/core/agent-config/runtime-process/host');
  const client = await getAgentConfigRuntimeClient();
  const agents = new ReplicaState(client.agents.state(undefined, 'list'), { schema: agentConfigListSchema });
  try {
    await agents.ready;
    return agents.current()[providerId]?.auth ?? null;
  } finally {
    agents.dispose();
  }
}

async function readPlatformModels(
  resolver: PlatformModelCatalogResolver | null,
  providerId: string
): Promise<PlatformCatalogModel[]> {
  if (!resolver) return [];
  try {
    return (await resolver({ providerId, surface: 'acp' })).models;
  } catch (error) {
    // 目录取不到 = 这一档没有条目(与桌面同一个结果);原因记下来,❌ 不让整张选项读失败。
    log.warn('session-model-menu: platform catalog unavailable', { providerId, error: String(error) });
    return [];
  }
}
