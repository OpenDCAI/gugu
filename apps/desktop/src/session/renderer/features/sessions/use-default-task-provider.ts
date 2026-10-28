import { rememberedProviderOf } from '@shared/core/sessions/provider-selection';
import { sessionpageLegOfView } from '@shared/core/sessions/sessions';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { DEFAULT_SESSION_VIEW } from '@shared/core/sessions/new-session-defaults';
import { useEffectiveProvider } from './use-effective-provider';

/**
 * 新任务的框打开时会默认选中的那个 agent:与新建框(useInitialSessionState)同一条解析 —— 记住的那一家、设置里的默认 Agent、
 * 再按这台电脑上装没装 —— ❌ 另定一个默认。「新任务」按钮上画它的标(gugu-dev#181:标签、按钮、任务卡说的是同一个 agent)。
 */
export function useDefaultTaskProvider(): string | null {
  const { value: memory } = useAppSettingsKey('newSessionMemory');
  return useEffectiveProvider(undefined, sessionpageLegOfView(DEFAULT_SESSION_VIEW), rememberedProviderOf(memory)).providerId ?? null;
}
