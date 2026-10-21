import type { AgentProviderId } from '@gugu/session-plugins/agents';
import { useMemo, useState } from 'react';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { useAgentInstallationStatuses } from '@renderer/lib/stores/use-agent-installation-statuses';
import { useAgents } from '@renderer/lib/stores/use-agents';
import { useLibraryHost } from '@renderer/features/library/library-host';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import {
  type ProviderSelectionError,
  resolveSessionProviderSelection,
  sessionpageLegFor,
} from '@shared/core/sessions/provider-selection';

type Translate = ReturnType<typeof useSessionMessages>['translate'];

// key 必须以字面量出现在 translate 调用里 —— 文案守卫按 `translate('<key>'` 的字面量对账,
// 经查表间接分发会让「每个前缀都有真实消费者」恒假阴性。
function translateSelectionError(
  translate: Translate,
  error: ProviderSelectionError,
  name: string
): string {
  switch (error.code) {
    case 'no-sessionpage-session':
      return translate('providerSelection.noTaskpageSession', { name });
  }
}

export type SessionpageLeg = 'acp' | 'tui';

export type EffectiveProvider = {
  providerId: AgentProviderId | null;
  setProviderOverride: (id: AgentProviderId | null) => void;
  createDisabled: boolean;
  error: string | null;
  /** 选中的这家是用户自己表过态的,不是我方按出厂偏好猜的 —— 决定它该不该被记成「上次用过的」。 */
  chosenByUser: boolean;
};

export function useEffectiveProvider(
  initialOverride?: AgentProviderId,
  sessionpageSurface: SessionpageLeg = 'tui',
  /**
   * 上次真的启动过会话时用的那家。❌ 不要把它并进 `initialOverride` —— 那是这个 hook 里
   * 「这一次的选择」那格 state 的初值,换项目时会被重置成 null,记忆跟着一起没(#5973:
   * 新建一个项目打开,上次选过的 agent 不见了,输入框回到「智能体」)。
   */
  rememberedProviderId?: AgentProviderId | null
): EffectiveProvider {
  // Overrides are intentionally scoped to this hook instance. The modal, task composer, and
  // quick-create path are separate creation surfaces; sharing this transient choice would make a
  // selection in one surface silently affect another. Only the persisted default crosses surfaces.
  const [providerOverride, setProviderOverride] = useState<AgentProviderId | null>(
    initialOverride ?? null
  );

  const { translate } = useSessionMessages();
  const { value: defaultAgentValue } = useAppSettingsKey('defaultAgent');
  const { data: agents } = useAgents();
  const defaultProviderId = defaultAgentValue as AgentProviderId | null;
  const knownProviderIds = useMemo(
    () => (agents ?? []).map((agent) => agent.id as AgentProviderId),
    [agents]
  );
  const sessionpageProviderIds = useMemo(
    () =>
      (agents ?? [])
        // 会话形态按引擎定：只有一条腿的引擎跟着自己那条走，❌ 不因为开关拨在另一边就消失。
        // 判据本体与出处见 `sessionpageLegFor` 抬头。
        .filter((agent) => sessionpageLegFor(agent.capabilities.sessionpage, sessionpageSurface) !== null)
        .map((agent) => agent.id as AgentProviderId),
    [agents, sessionpageSurface]
  );

  const { data: statuses } = useAgentInstallationStatuses();
  const availabilityKnown = statuses !== undefined;

  const installedProviderIds = useMemo(
    () =>
      (statuses ?? []).filter((s) => s.status === 'available').map((s) => s.id as AgentProviderId),
    [statuses]
  );

  // #6264 别的机器上:那边没装的家点了照样能用 —— 建会话时那台机器当场装(与本机「去装」不同,不在这台电脑上装)。
  const remote = useLibraryHost().remote !== null;
  const installOnCreateProviderIds = useMemo(
    () =>
      remote
        ? (statuses ?? []).filter((s) => s.reading === 'not-detected').map((s) => s.id as AgentProviderId)
        : [],
    [remote, statuses]
  );

  const { providerId, createDisabled, error, chosenByUser } = resolveSessionProviderSelection({
    defaultProviderId,
    providerOverride,
    knownProviderIds,
    sessionpageProviderIds,
    installedProviderIds,
    installOnCreateProviderIds,
    availabilityKnown,
    rememberedProviderId: rememberedProviderId ?? null,
  });

  // 文案在这里过本地化表(product spec:19):纯函数只表态原因。名字用展示名,
  // 拿不到时退回 id —— agent 刚退役时列表里已没有它,id 是仅剩的线索,❌ 不能因此整句不渲染。
  const errorProviderName = error?.providerId
    ? (agents ?? []).find((agent) => agent.id === error.providerId)?.name ?? error.providerId
    : '';
  const errorMessage = error
    ? translateSelectionError(translate, error, errorProviderName)
    : null;

  return { providerId, setProviderOverride, createDisabled, error: errorMessage, chosenByUser };
}
