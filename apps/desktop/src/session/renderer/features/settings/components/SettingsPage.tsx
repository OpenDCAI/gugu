import { QueryClientProvider } from '@tanstack/react-query';
import { SettingsGroup, SettingsPage } from '@/components/settings/SettingsPrimitives';
import type { AssistantHomePlace } from '@/lib/assistantHome';
import { useLayoutEffect, type ReactNode } from 'react';
import { UiPortalContainerProvider } from '@gugu/session-ui/react/primitives';
import { InSettingsPanelProvider, PageHeader } from '@renderer/lib/components/page-header';
import { modalStore } from '@renderer/lib/modal/modal-store';
import { queryClient } from '@renderer/lib/query-client';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import { BrowserSettingsCard } from './BrowserSettingsCard';
import HiddenToolsSettingsCard from './HiddenToolsSettingsCard';
import InterfaceSettingsCard from './InterfaceSettingsCard';
import KeyboardSettingsCard from './KeyboardSettingsCard';
import NotificationSettingsCard from './NotificationSettingsCard';
import { MachineSettingsCard } from './MachineSettingsCard';
import { ResourceMonitorSettingsPage } from './ResourceMonitorSettingsPage';
import SidebarMetadataSettingsCard from './SidebarMetadataSettingsCard';
import {
  AutoApproveByDefaultRow,
  AutoGenerateSessionNamesRow,
  AutoTrustWorktreesRow,
  PreserveSessionNameCapitalizationRow,
  SessionTitleInstructionsRow,
  SessionTitleModelRow,
} from './SessionSettingsRows';
import { SidebarTintRow } from './SidebarTintRow';
import TerminalSettingsCard from './TerminalSettingsCard';
import ChatViewCard from './ChatViewCard';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { DeviceScopeProvider } from '@renderer/features/remote-hosts/device-scope-picker';
import { settingsDeviceStore } from '@renderer/features/remote-hosts/device-scope-store';
import { DeviceSettingsScope } from './DeviceSettingsScope';
import { SubscriptionsSettingsPage } from '../subscriptions/SubscriptionsSettingsPage';
import { CloudConnectorsSettings, HomeConnectorsSettings } from '../../assistant/assistant-connectors-settings';

// ---------------------------------------------------------------------------
// Tab page components
// ---------------------------------------------------------------------------

function GeneralSettingsPage() {
  const { translate } = useSessionMessages();
  return (
    <SettingsPage>
      <PageHeader
        title={translate('settings.general')}
        description={translate('settings.generalDescription')}
      />
      <SettingsGroup>
        <AutoGenerateSessionNamesRow />
        <SessionTitleModelRow />
        <SessionTitleInstructionsRow />
        <AutoApproveByDefaultRow />
        <AutoTrustWorktreesRow />
        <PreserveSessionNameCapitalizationRow />
      </SettingsGroup>
      <DeviceSettingsScope>
        <MachineSettingsCard />
      </DeviceSettingsScope>
      <NotificationSettingsCard />
    </SettingsPage>
  );
}

function InterfaceSettingsPage() {
  const { translate } = useSessionMessages();
  return (
    <SettingsPage>
      <PageHeader
        title={translate('settings.interface')}
        description={translate('settings.interfaceDescription')}
      />
      <SettingsGroup>
        <SidebarTintRow />
      </SettingsGroup>
      <ChatViewCard />
      <TerminalSettingsCard />
      <SidebarMetadataSettingsCard />
      <InterfaceSettingsCard />
      <SettingsGroup title={translate('settings.keyboardShortcuts')}>
        <KeyboardSettingsCard />
      </SettingsGroup>
      <SettingsGroup title={translate('settings.tools')}>
        <HiddenToolsSettingsCard />
      </SettingsGroup>
    </SettingsPage>
  );
}

function BrowserSettingsPage() {
  const { translate } = useSessionMessages();
  return (
    <SettingsPage>
      <PageHeader
        title={translate('settings.browser')}
        description={translate('settings.browserDescription')}
      />
      <BrowserSettingsCard />
    </SettingsPage>
  );
}

// ---------------------------------------------------------------------------
// SessionSettingsContent
// ---------------------------------------------------------------------------

/** 设置弹窗里由本页画的那几格(product spec);键与壳的 ActiveSection 同名。 */
export type SessionSettingsSection = 'sessions' | 'interface' | 'browser' | 'subscriptions' | 'connectors' | 'resource-monitor';

/** 个别格要壳告诉它的事实(「连接应用」要知道咕咕住的那台云端宿主是谁);其余格不用。 */
export type SessionSettingsContext = {
  cloudDeviceId?: string | null;
  /** 咕咕住哪(云上 / 某台电脑);给了就按它读写集成(住电脑 = 那台电脑自己的),不给才退回 cloudDeviceId 那台云端。 */
  home?: AssistantHomePlace | null;
  assistantName?: string;
};

const SECTION_CONTENT: Record<SessionSettingsSection, (context: SessionSettingsContext) => ReactNode> = {
  sessions: () => <GeneralSettingsPage />,
  interface: () => <InterfaceSettingsPage />,
  'resource-monitor': () => <ResourceMonitorSettingsPage />,
  browser: () => <BrowserSettingsPage />,
  // 订阅与任务里的机器组共用一份机器选择。
  subscriptions: () => <DeviceScopeProvider store={settingsDeviceStore}><SubscriptionsSettingsPage /></DeviceScopeProvider>,
  // 咕咕那一组的「连接应用 · 云端」:资源库「集成」的同一份数据,机器钉死在它住的那台(助理 App 的资料页读的也是它)。
  connectors: ({ cloudDeviceId, home, assistantName }) =>
    home ? (
      <HomeConnectorsSettings home={home} assistantName={assistantName ?? ''} />
    ) : cloudDeviceId ? (
      <CloudConnectorsSettings cloudDeviceId={cloudDeviceId} assistantName={assistantName ?? ''} />
    ) : null,
};

/**
 * 壳的设置弹窗直接渲染这几格:壳与本页是同一次构建、同一份模块实例,所以不需要 portal 或交接对象,
 * 只补上它们在本页树里本来就有的几样 —— 同一个 queryClient(设置存取写的就是它的缓存)、本页的文案、
 * 浮层落点(壳给一个在弹窗**里面**的元素:弹窗的焦点圈、点外面关、inert 都按 DOM 包含关系判)。
 * 少补一样,那一格在弹窗里直接渲染失败 —— tests/browser/session-settings-content.test.tsx 逐格渲染钉住。
 * 浏览器的确认框走全局 modalStore,由本页 App 里那一个 ModalRenderer 画;这几格画着的时候让它落进同一个落点。
 */
export function SessionSettingsContent({
  section,
  portalContainer,
  context = {},
}: {
  section: SessionSettingsSection;
  portalContainer: HTMLElement;
  context?: SessionSettingsContext;
}) {
  useLayoutEffect(() => {
    modalStore.setPortalContainer(portalContainer);
    return () => modalStore.setPortalContainer(null);
  }, [portalContainer]);
  return (
    <QueryClientProvider client={queryClient}>
      <SessionLocalizationProvider>
        <UiPortalContainerProvider value={portalContainer}>
          <InSettingsPanelProvider>{SECTION_CONTENT[section](context)}</InSettingsPanelProvider>
        </UiPortalContainerProvider>
      </SessionLocalizationProvider>
    </QueryClientProvider>
  );
}
