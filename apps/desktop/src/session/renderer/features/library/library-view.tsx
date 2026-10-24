import { observer } from 'mobx-react-lite';
import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import type { ViewDefinition } from '@renderer/app/view-registry';
import { McpLibraryView } from '@renderer/features/mcp/components/McpLibraryView';
import { IntegrationsProvider } from '@renderer/features/integrations/integrations-provider';
import { DeviceScopePicker, DeviceScopeProvider, useSelectedRemoteDevice } from '@renderer/features/remote-hosts/device-scope-picker';
import { libraryDeviceStore } from '@renderer/features/remote-hosts/device-scope-store';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { AgentsSettingsPage } from '@renderer/features/settings/agents-page/AgentsSettingsPage';
import IntegrationsCard from '@renderer/features/settings/components/IntegrationsCard';
import { PageHeader } from '@renderer/lib/components/page-header';
import { PageContent, PageLayout, PageSidebarMenu } from '@renderer/lib/components/page-layout';
import { ShellTitlebar } from '@renderer/lib/components/titlebar/shell-titlebar';
import { useParams } from '@renderer/lib/layout/navigation-provider';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { createRemoteLibraryHost, LOCAL_LIBRARY_HOST, LibraryHostProvider, type LibraryHost } from './library-host';
import { PromptLibraryView } from './prompts/prompt-library-view';

/**
 * 资源库 = 给 agent 用的东西;咕咕这个 app 自己怎么表现归设置(owner 2026-09-15,#5688)。
 * 智能体、集成两页因此从设置搬到这里。App(原「扩展」)在这里待过一阵,10-01 起搬到最左栏自己的一格(apps 视图)。
 * MCP 那格 10-18 换了内容(owner 选的):原来只抄各家配置文件、不连 server;现在是咕咕自己管的列表(检测连接、
 * 新建任务时勾选),各家自己配的并排列出、只读。
 *
 * 唯一的一份清单,类型从它推出来;LibraryMainPanel 以它为键配页面,少配一格就编译不过。
 */
export const LIBRARY_TABS = ['prompts', 'agents', 'integrations', 'mcp'] as const;

export type LibraryTab = (typeof LIBRARY_TABS)[number];

const LibraryTabContext = createContext<{
  tab: LibraryTab;
  onTabChange: (tab: LibraryTab) => void;
} | null>(null);

/**
 * 认得出来的 tab 才用它,认不出来一律回落「提示词」。
 *
 * tab 来自持久化的 view params,而恢复快照只过滤视图 id、不校验参数值:上次停在一格已经删掉的
 * tab(#5136 删掉的 `skills`)上的用户,重开会拿到一个取不到页面的值 ⇒ 一片空白、左栏没有高亮。
 */
function normalizeLibraryTab(tab: string | undefined): LibraryTab {
  return (LIBRARY_TABS as readonly string[]).includes(tab ?? '') ? (tab as LibraryTab) : 'prompts';
}

/**
 * 资源库这一页的 view params —— **一处定义**,`LibraryViewWrapper` 的 props 和下面那句
 * `satisfies ViewDefinition<LibraryViewParams>` 共用它。少了这层绑定,`transientParams`
 * 落在注册表的 `ViewDefinition<any>` 上(`keyof any & string` = `string`),把 `agentId`
 * 拼成 `agentID`、或者哪天把这个参数改名,都照样编译 —— 而机制一声不响地什么都不丢。
 */
export type LibraryViewParams = {
  tab?: LibraryTab;
  agentId?: string;
};

export function LibraryViewWrapper({
  children,
  tab: rawTab,
}: { children: ReactNode } & LibraryViewParams) {
  const tab = normalizeLibraryTab(rawTab);
  const { setParams } = useParams('library');
  const handleTabChange = useCallback(
    (nextTab: LibraryTab) => {
      // agent 详情抽屉盖在「智能体」那一格上 —— 换格就是离开它,它不该跟着你到别的格再冒出来。
      setParams({ tab: nextTab, agentId: undefined });
    },
    [setParams]
  );

  return (
    <LibraryTabContext.Provider value={{ tab, onTabChange: handleTabChange }}>
      {children}
    </LibraryTabContext.Provider>
  );
}

function useLibraryTab() {
  const context = useContext(LibraryTabContext);
  if (!context) {
    throw new Error('useLibraryTab must be used within a LibraryViewWrapper');
  }
  return context;
}

/** 资源库此刻看的是哪台机器(选的那台不在名下了就回落本机)。挂在资源库那一页上,observer 里调。 */
export function useSelectedLibraryHost(): LibraryHost {
  const selected = useSelectedRemoteDevice(libraryDeviceStore);
  const deviceId = selected?.deviceId ?? null;
  const label = selected?.device.label ?? '';
  const online = selected?.device.isOnline ?? false;
  const lastSeenAt = selected?.device.lastSeenAt ?? null;
  const hostKind = selected?.device.hostKind;
  return useMemo(
    () =>
      deviceId
        ? createRemoteLibraryHost({ deviceId, deviceLabel: label, online, lastSeenAt, hostKind }, (id, initialPath) =>
            remoteHostsStore.pickFolder(id, initialPath)
          )
        : LOCAL_LIBRARY_HOST,
    // device 对象本身每次心跳都换;按它身上会变、页面会用到的那几格重建。
    [deviceId, label, online, lastSeenAt, hostKind]
  );
}

function IntegrationsLibraryPage() {
  const { translate } = useSessionMessages();
  return (
    <div className="space-y-8">
      <PageHeader
        sticky
        title={translate('settings.integrations')}
        remoteDescription={(device) => translate('deviceScope.subtitle.integrations', { device })}
      />
      <IntegrationsCard />
    </div>
  );
}

export const LibraryMainPanel = observer(function LibraryMainPanel() {
  const { tab, onTabChange } = useLibraryTab();
  const { params, setParams } = useParams('library');
  const { translate } = useSessionMessages();
  /**
   * #6264 **整个资源库**是分机器的(owner:「整个资源库或者其他的都是分设备的,而不是说智能体中分设备」):
   * 左栏「资源库」列头下**一个**机器选择器(owner:「设备是资源库级别的」),默认本机;子页标题下的说明写出那台机器;选了别的机器,提示词、智能体、集成、MCP、扩展**每一格**的读数与动作
   * 都换成那台机器的,长相不变。换机器 = 换一份页面(key 按机器):上一台机器的搜索词、刷新中的状态不带到下一台。
   */
  const host = useSelectedLibraryHost();
  const tabs: Array<{ id: LibraryTab; label: string; badge?: number }> = [
    { id: 'prompts', label: translate('prompts.title') },
    { id: 'agents', label: translate('settings.agents') },
    { id: 'integrations', label: translate('settings.integrations') },
    { id: 'mcp', label: translate('mcpLibrary.title') },
  ];
  const tabContent: Record<LibraryTab, ReactNode> = {
    prompts: <PromptLibraryView />,
    agents: (
      <AgentsSettingsPage
        selectedAgentId={params.agentId ?? null}
        onSelectAgent={(agentId) => setParams({ agentId: agentId ?? undefined })}
      />
    ),
    // 集成的数据放在一个 Provider 里(应用根上那份是本机的,聊天里的 @issue 用它);这里按所选机器另挂一份。
    integrations: host.remote ? (
      <IntegrationsProvider>
        <IntegrationsLibraryPage />
      </IntegrationsProvider>
    ) : (
      <IntegrationsLibraryPage />
    ),
    mcp: <McpLibraryView />,
  };

  return (
    <PageLayout
      sidebar={
        <PageSidebarMenu
          title={translate('sidebar.library')}
          header={<DeviceScopePicker store={libraryDeviceStore} variant="sidebar" />}
          items={tabs}
          activeId={tab}
          onSelect={(item) => onTabChange(item.id)}
        />
      }
    >
      <PageContent>
        <DeviceScopeProvider store={libraryDeviceStore} inTitle={false}>
          <LibraryHostProvider value={host} key={host.key}>
            {tabContent[tab]}
          </LibraryHostProvider>
        </DeviceScopeProvider>
      </PageContent>
    </PageLayout>
  );
});

/**
 * 页名不在这条顶栏里 —— 它是左列的**列头**(PageSidebarMenu 的 `title`),与设置页同一形状。
 * 早先版本把它画在这里,结果和右边的「提示词」叠在一起,而且贴着窗口顶那条带
 * (owner 2026-09-15:「这个是不是太靠上了」)。这里只留壳自己那点东西。
 */
export function LibraryTitlebar() {
  return <ShellTitlebar />;
}

export const libraryView = {
  WrapView: LibraryViewWrapper,
  // 从前这个视图**没有** TitlebarSlot,navigation-provider 会静默回落成 () => null ——
  // 真机实测:侧栏收起后这一页一个顶栏元素都没有,缺了其他每页都有的展开按钮。
  // (不是把人关死:最左那条图标栏还在、⌘⇧S 也还能切,但你得知道快捷键。)
  // ❌ 不传 children:资源库**不需要右上角那一排**(owner 2026-08-19 定)。
  //    它只要壳左边那个侧栏展开按钮和页名,别往这里加动作。
  TitlebarSlot: LibraryTitlebar,
  MainPanel: LibraryMainPanel,
  // 资源库是最左栏自己的一格(与「App」同形,product spec):整页,左边不带任务列表。
  withoutSessionSidebar: true,
  /**
   * 资源库记得住的「位置」只到 tab 这一层。`agentId` 不是位置,是一次性意图:
   * 「这次进去,顺便把这个 agent 的详情抽屉打开」(聊天页的「配置 <agent>」就是这么进来的)。
   *
   * 它从前与 `tab` 一起躺在同一份 view params 里,而 `navigate('library')` 不带参数时会整份继承
   * 上一次 —— 于是那个一次性意图获得了位置的寿命:**关掉抽屉、去别处、再回资源库,它又弹出来**,
   * 重启后照样弹。写进这里,离开资源库与从快照恢复时它都会被丢掉;抽屉当下的开关状态仍由它表达
   * (一个事实一个写入者),只是不再活过这一次到访。
   */
  transientParams: ['agentId'] as const,
} satisfies ViewDefinition<LibraryViewParams>;
