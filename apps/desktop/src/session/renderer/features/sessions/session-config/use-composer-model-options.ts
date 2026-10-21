import { useMemo } from 'react';
import type { ComposerModelOption } from '@gugu/session-ui/react/components';
import type { PlatformModelOption } from '@shared/core/agents/platform-model';
import { useAgents } from '@renderer/lib/stores/use-agents';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { translateSessionMessage, type SessionMessageValues } from '@renderer/localization/locale-store';
import type { SessionMessageLookupKey } from '@renderer/localization/messages';
import { platformModelIdFromOption, platformOptionId } from '@/session/shared/platform-model-id';
import { PLATFORM_GROUP_HEADING_KEY } from '@/session/shared/platform-model-labels';
import { composerModelOptions, type PlatformModelRow } from './platform-model-options';
import { modelProviderIcon } from './model-provider-icon';
import { openBillingPage } from '@/lib/appLinks';
import type { ComposerModelUpgrade } from '@gugu/session-ui/react/components';
import { openShellSettings } from '@renderer/lib/open-shell-settings';

/**
 * @@@composer-model-assembly —— **模型下拉的装配只有这一份**。
 *
 * 两个入口(新建会话页 `initial-session-section`、会话页 `acp-chat-panel`)点开的是
 * 同一张卡:一级按厂商(组头 / 过滤药丸 / 行内 logo),二级是「你的 {agent} 模型」与
 * 「咕咕提供的模型 · 按积分计费」。
 *
 * ⚠️ 从前这两处**各自手搓这段参数**,于是同一个下拉已经开始两种长相:新建页取不到 agent 名
 * 时兜底成 `'agent'`(组头照在),会话页那份写的是 `providerId ? … : null`(**组头整个消失**)。
 * 渲染出来一时看不出,因为常态下 providerId 都在 —— 这类漂移正是「两份卡」的起点。
 * ⇒ 装配收在这里,两处只递数据。❌ 别再在调用点自己拼 `ownTierLabel` / `icon`。
 *
 * 这个 hook 碰 React 与 i18n,所以**不能**并进 `platform-model-options.ts`:那个模块被黑盒
 * e2e 直接引用,必须保持无 React、无 i18n。分工是「它算合并,这里配翻译与图标」。
 *
 * 两处**唯一合法的差别是喂进来的数据**:新建页喂 harness 静态目录,会话页喂活会话自报的清单
 * (会话里能不能切,是调用点在拿到结果之后另判的,见 @@@session-options-disabled)。
 *
 * 装配还管**读回**:下面那两个函数把「这条 option id 是哪一路」与「这一路该高亮哪条 id」
 * 收在这里。id 是这份装配铸的(`composerModelOptions` 给平台条目加前缀),❌ 那就别让调用点
 * 各自再解一遍前缀 —— 第二处解码就是第二份分流,而它们会各自被改。判据在
 * `composer-model-assembly.test.ts` ③。
 */
export function useComposerModelOptions(
  harnessOptions: Record<string, ComposerModelOption> | null,
  platformModels: PlatformModelOption[],
  providerId: string | null | undefined,
  /** 会话正在用的平台模型:要会员或被关掉了也照列(见 `composerModelOptions`)。新建页没有。 */
  currentPlatformModelId?: string | null
): Record<string, ComposerModelOption> | null {
  const { translate } = useSessionMessages();
  const { data: agents } = useAgents();
  const agentName = composerOwnTierAgentName(agents, providerId);

  return useMemo(
    () => assembleComposerModelOptions(harnessOptions, platformModels, agentName, translate, currentPlatformModelId),
    [harnessOptions, platformModels, translate, agentName, currentPlatformModelId]
  );
}

type Translate = (key: SessionMessageLookupKey, values?: SessionMessageValues) => string;

/**
 * 装配本身(不碰 React)。手机与无任务宿主的 web 拿不到这里的 agents store,由调用方递 agent 名,
 * 其余与桌面这两处**逐字同一份**:组头、倍率那一行、收起时的「咕咕 X」都出自这里。
 */
export function assembleComposerModelOptions(
  harnessOptions: Record<string, ComposerModelOption> | null,
  platformModels: readonly PlatformModelRow[],
  agentName: string,
  translate: Translate = translateSessionMessage,
  currentPlatformModelId?: string | null
): Record<string, ComposerModelOption> | null {
  return composerModelOptions(
    harnessOptions,
    platformModels,
    { ownTierLabel: composerTierLabel('own', agentName, translate), icon: modelProviderIcon },
    currentPlatformModelId
  );
}

/** 一档的组头。某一档空着、清单里没有条目可带组头时(手机新建页要写「这一组为什么空」),也取这一份。 */
export function composerTierLabel(
  tier: ComposerModelSelection['source'],
  agentName: string,
  translate: Translate = translateSessionMessage
): string {
  return tier === 'own'
    ? translate('harnessCatalog.ownModelsGroup', { name: agentName })
    : translate(PLATFORM_GROUP_HEADING_KEY);
}

/**
 * 组头里那个 agent 名字的**三级兜底:名字 → id → `'agent'`**。
 *
 * ⚠️ 最后一格不是凑数。会话页那份旧写法在认不出 agent 时递的是 `null`,`composerModelOptions`
 * 收到 null 就**不给组头** —— 一列模型于是没了「这是谁的」那条界线,而那正是一级分类要回答的
 * 问题。常态下 providerId 都在,所以肉眼看不出来,只有 agents 还没加载完/id 对不上时才显形。
 * ⇒ 这里恒返回非空串,调用点不必再判。判据在 `composer-model-assembly.test.ts`。
 */
export function composerOwnTierAgentName(
  agents: { id: string; name?: string }[] | undefined,
  providerId: string | null | undefined
): string {
  return agents?.find((agent) => agent.id === providerId)?.name ?? providerId ?? 'agent';
}

/**
 * 要会员那一行上的「开通会员」(#7056 / #7092)⇒ 去网页面板。买会员只在网页面板做
 * (`GUGU_BILLING_URL` 抬头写了为什么),❌ app 里不开第二个购买界面、不报价格。
 * 怎么打开见 `openBillingPage`(三端同一条路)。
 */
export function openMembershipPage(): void {
  openBillingPage();
}

/**
 * 模型面板底部的两条去路(#7056,对齐 Cursor):三个模型菜单(新建页、Chat UI 会话、终端会话)共用这一份。
 *  - 「管理模型」开设置里的「模型」页 —— 哪些出现在这张清单里由那一页的开关定;
 *  - 「升级解锁更多模型」只给这一档有用不了的模型的人(免费档),悬停列出是哪几个,点了去网页面板。
 * 这一档用不了的模型**不进清单**:列出来点了才说要会员「像是埋雷」(owner 2026-10-10)。
 */
export function composerModelFooter(
  platformModels: readonly PlatformModelRow[],
  translate: Translate = translateSessionMessage
): { onManageModels: () => void; modelUpgrade: ComposerModelUpgrade | null; onModelUpgrade: () => void } {
  const locked = platformModels.filter((model) => model.requiresMembership).map((model) => model.displayName);
  return {
    onManageModels: () => openShellSettings('model'),
    modelUpgrade: locked.length
      ? {
          label: translate('composer.platformModelUpgrade'),
          title: translate('composer.platformModelUpgradeTitle'),
          models: locked,
        }
      : null,
    onModelUpgrade: openMembershipPage,
  };
}

/** 一条 option id 指的是哪一路计费。 */
export interface ComposerModelSelection {
  /** `platform` = 咕咕代付、按积分计费;`own` = 用户自己的凭据。 */
  source: 'platform' | 'own';
  /** 脱掉编码之后真正发给 harness / 存进会话记录的那个 id。 */
  modelId: string;
}

/**
 * 下拉给回来的 option id → **它指的是哪一路**。
 *
 * ⚠️ 两路的 id 共用一个空间,前缀是唯一分界(`@/session/shared/platform-model-id` 抬头写了
 * 为什么)。解错的后果不是显示不对,是**错账**:以为选了自己的模型、实际按积分计费。
 * ⇒ 解码只在这里做一次,调用点拿到的已经是分好的两路。
 */
export function composerModelSelection(optionId: string): ComposerModelSelection {
  const platformId = platformModelIdFromOption(optionId);
  return platformId === null
    ? { source: 'own', modelId: optionId }
    : { source: 'platform', modelId: platformId };
}

/**
 * 反过来:**这一路选中的是哪个**,编回下拉认得的 option id。
 *
 * 平台那一路优先 —— 两个 state 同时有值时,能跑起来的是平台那条(spawn 走代付路)。
 * 两个都空就返回 undefined(下拉不高亮任何一条),❌ 不回空串:空串是个合法 id。
 */
export function composerSelectedOptionId(selection: {
  platformModel?: string | null;
  model?: string | null;
}): string | undefined {
  if (selection.platformModel) return platformOptionId(selection.platformModel);
  return selection.model ?? undefined;
}
