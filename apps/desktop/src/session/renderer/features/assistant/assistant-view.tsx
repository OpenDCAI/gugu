import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import '@/i18n/registerAssistantCatalog';
import '@/i18n/registerSettingsCatalog';
import '@/i18n/registerAgentsCatalog';
import './assistant-today.css';
import { PanelRight } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Avatar } from '@/components/Avatar';
import { ChevronLeft, Search, Settings } from '@/lib/icons';
import { assistantSlotKey, readAssistantShellBridge } from '@/lib/assistantShellBridge';
import { UI_EVENTS } from '@/lib/uiEvents';
import { OPEN_ASSISTANT_TASK_CHAT, showAssistantTaskChat, useOpenedAssistantTaskChat } from '@/lib/assistantTaskChat';
import type { ViewDefinition } from '@renderer/app/view-registry';
import { ShellTitlebar } from '@renderer/lib/components/titlebar/shell-titlebar';
import { useParams } from '@renderer/lib/layout/navigation-provider';
import {
  AssistantCtx,
  PANEL_TABS,
  parentRoute,
  type AssistantContext,
  type PanelRoute,
  type PanelTab,
} from './assistant-context';
import { assistantWorkdir, homeReadiness, useAssistantMachine } from './assistant-data';
import { localHomeSessions } from './assistant-home-sessions';
import { AssistantSetupFinish } from './assistant-setup-finish';
import { refreshLocalAssistantHome } from '@/lib/assistantSetup';
import { assistantTintHue, assistantTintStyle } from '@/lib/assistantTint';
import { ASSISTANT_PAGES } from './assistant-pages';
import { ShellSlot, useAssistantShell } from './assistant-shell';
import { useVoiceNotesHost, VoiceRecordingBar } from './voice-notes/voice-recording-bar';
import { AssistantIdeasLayer } from './assistant-ideas-layer';

/**
 * #7199 「助理」App —— 那一个个人助理(owner:「它是一个个人级别的 agent……一个个人代理」;会员住云上、非会员住自己的电脑):
 * 左边一整列就是和它的聊天(咕咕的私聊,同一份记录,壳画进 `chat` 格子);右边一块能收起的面板,
 * 顶上胶囊 动态 / 任务 / 记忆 / <它的名字>,往下钻左上出返回箭头;齿轮打开面板里的「设置」。
 * 它住哪、个人助理是谁这些在壳那棵树里,经 lib/assistantShellBridge 读;壳的组件由壳画进格子。还没有它 = 整页是给它安家的引导。
 */
export type AssistantViewParams = { tab?: string; sub?: string };

const PANEL_PREF_KEY = 'gugu.assistant.panel';

function readPanelOpen(): boolean {
  try {
    return localStorage.getItem(PANEL_PREF_KEY) !== 'closed';
  } catch {
    return true;
  }
}

function writePanelOpen(open: boolean) {
  try {
    localStorage.setItem(PANEL_PREF_KEY, open ? 'open' : 'closed');
  } catch {
    // 记不住就算了:下次打开回到默认(开着)。
  }
}

function routeOf(params: AssistantViewParams): PanelRoute {
  const tab = (PANEL_TABS as readonly string[]).includes(params.tab ?? '') ? (params.tab as PanelRoute['tab']) : 'today';
  return params.sub ? { tab, sub: params.sub } : { tab };
}

export function AssistantViewWrapper({ children }: { children: ReactNode } & AssistantViewParams) {
  return <>{children}</>;
}

/** 没开云电脑、正在开、还没有助理:整页一块居中的(与首屏同一块中性底)。 */
function Centered({ children, testId }: { children: ReactNode; testId: string }) {
  return (
    <div className="ta-app ta-centered" data-testid={testId}>
      <div className="ta-intro">{children}</div>
    </div>
  );
}

export const AssistantMainPanel = observer(function AssistantMainPanel() {
  const { t } = useTranslation('assistant');
  const { params, setParams } = useParams('assistant');
  const route = routeOf(params);
  const shell = useAssistantShell();
  const bridge = readAssistantShellBridge();
  const filePreviewOpen = useSyncExternalStore(
    (listener) => bridge?.subscribe(listener) ?? (() => undefined),
    () => bridge?.filePreviewOpen() ?? false,
  );
  const home = shell?.assistant ? shell.home : null;
  // 住云上:管家给的样子(休眠中 / 正在唤醒 / 运行中);住电脑 = 没有这一份。
  const snapshot = home?.kind === 'cloud' ? shell?.cloud ?? null : null;
  const readiness = homeReadiness(home);
  // 住眼前这台:它自己的会话、它派的子 agent 都是本机会话,开着 App 时问本机(别的机器的由会话目录同步)。
  const localHome = home?.kind === 'computer' && home.thisDevice;
  useEffect(() => localHomeSessions.use(), []);
  useEffect(() => remoteHostsStore.start(), []);
  // 住电脑:每次打开 App 把它家里宿主维护的那段说明刷到这一版(管家在云上每次唤醒做同一件事)。
  useEffect(() => {
    if (localHome) void refreshLocalAssistantHome().catch(() => undefined);
  }, [localHome]);
  // 助理那条会话跑在哪个目录(它的记忆跟着那个目录走);会话目录是 observable,这里随它重算。
  const workdir = home && shell?.assistant ? assistantWorkdir(home, shell.assistant.id) : null;
  const machine = useAssistantMachine(home, readiness, workdir?.state === 'found' ? workdir.path : null);
  const [panelOpen, setPanelOpenState] = useState(readPanelOpen);
  const openedTask = useOpenedAssistantTaskChat();
  useEffect(() => {
    if (openedTask && openedTask.request.assistantId === shell?.assistant?.id) {
      writePanelOpen(true); setPanelOpenState(true); setParams(() => ({ tab: 'tasks' }));
    }
  }, [openedTask, shell?.assistant?.id, setParams]);
  useEffect(() => {
    const expand = () => { writePanelOpen(true); setPanelOpenState(true); };
    window.addEventListener(OPEN_ASSISTANT_TASK_CHAT, expand);
    return () => window.removeEventListener(OPEN_ASSISTANT_TASK_CHAT, expand);
  }, []);
  const [chatColumn, setChatColumn] = useState<HTMLDivElement | null>(null);
  // 语音笔记:录音机与它的进度要知道此刻是哪位助理、它家是哪台(录到一半离开 App 也接着传、接着转写)。
  useVoiceNotesHost({
    home,
    assistantId: shell?.assistant?.id ?? null,
    ownerName: shell?.ownerName ?? null,
    machine: machine.data,
  });

  if (!shell) {
    return (
      <Centered testId="assistant-shell-loading">
        <p className="ta-page-sub">{t('cloud.loading')}</p>
      </Centered>
    );
  }
  // 新用户 / 还没有它:整页是给它安家的引导(欢迎 → 起名选色 → 你的称呼 → 安家;壳画进格子)。
  const waitingForCloudSetup = shell.setup !== null && (snapshot?.state === 'provisioning' || snapshot?.state === 'error');
  if (waitingForCloudSetup || shell.setup === 'shell' || (!shell.assistant && shell.assistantState === 'none')) {
    return (
      <div className="ta-app ta-centered" data-testid="assistant-onboarding">
        <ShellSlot name="onboarding" className="ta-skin ta-onb-slot" />
      </div>
    );
  }
  if (!shell.assistant || !home) {
    // 读库认它(还在读 / 读不到):如实分开说,❌ 读不到当成没有。
    const state = shell.assistant ? 'loading' : shell.assistantState;
    return (
      <Centered testId={`assistant-missing-${state}`}>
        <div className="ta-intro-glow" aria-hidden />
        <h1 className="ta-intro-title">{t('identity.title')}</h1>
        <p className="ta-intro-body">{t(`identity.${state}`)}</p>
      </Centered>
    );
  }

  const assistant = shell.assistant;
  const setPanelOpen = (open: boolean) => {
    writePanelOpen(open);
    setPanelOpenState(open);
  };
  const go = (next: PanelRoute) => {
    setPanelOpen(true);
    // 整份换掉(❌ 合并):往回走 / 换一格时上一页的 sub 不能留下来。
    setParams(() => (next.sub ? { tab: next.tab, sub: next.sub } : { tab: next.tab }));
  };
  const context: AssistantContext = {
    assistant,
    ownerName: shell.ownerName,
    chatId: shell.chatId,
    home,
    homeDeviceId: home.deviceId,
    snapshot,
    readiness,
    machine: machine.data,
    machineLoading: machine.isLoading || (readiness === 'ready' && workdir?.state === 'pending'),
    machineError: machine.error ?? (readiness === 'ready' && workdir?.state === 'missing' ? new Error(t('machine.noWorkdir', { name: assistant.display_name })) : null),
    retryMachine: () => void machine.refetch(),
    route,
    go,
    askInChat: (draft, files) => {
      if (draft || files?.length) readAssistantShellBridge()?.fillChatDraft(draft ?? '', files);
    },
  };

  const tint = assistantTintStyle(assistantTintHue(assistant.id, assistant.avatar));
  // 引导的后两步(连应用 → 一切就绪):它已经建好了,要读它家那台的集成,所以在这一侧画。
  if (shell.setup === 'connect' || shell.setup === 'ready') {
    return (
      <AssistantCtx.Provider value={context}>
        <div className="ta-app ta-centered" style={tint} data-testid="assistant-onboarding">
          <AssistantSetupFinish context={context} step={shell.setup} />
        </div>
      </AssistantCtx.Provider>
    );
  }

  return (
    <AssistantCtx.Provider value={context}>
      <div className="ta-app" style={tint} data-panel={panelOpen || filePreviewOpen ? 'open' : 'closed'} data-testid="assistant-app">
        <div className="ta-chat-col" data-testid="assistant-chat-col" ref={setChatColumn}>
          <div className="ta-chat-top">
            <button
              type="button"
              className="ta-identity"
              onClick={() => go({ tab: 'profile' })}
              aria-label={t('top.profile', { name: assistant.display_name })}
              data-testid="assistant-identity"
            >
              <Avatar name={assistant.display_name} avatarUrl={assistant.avatar} seed={assistant.id} size={48} isAgent harnessBadge={false} />
              <span className="ta-identity-name">{assistant.display_name}</span>
            </button>
            <div className="ta-chat-actions">
              <button
                type="button"
                className="ta-circle"
                aria-label={t('top.search')}
                title={t('top.search')}
                onClick={() => window.dispatchEvent(new CustomEvent(UI_EVENTS.openChatSearch, { detail: { chatId: context.chatId, viewportKey: assistantSlotKey('chat') } }))}
                data-testid="assistant-search"
              >
                <Search />
              </button>
              <button
                type="button"
                className="ta-circle"
                aria-label={t('top.settings')}
                title={t('top.settings')}
                onClick={() => { setPanelOpen(true); go({ tab: 'profile', sub: 'settings' }); }}
                data-testid="assistant-gear"
              >
                <Settings />
              </button>
              {panelOpen ? null : (
                <button
                  type="button"
                  className="ta-circle"
                  aria-label={t('top.expand')}
                  title={t('top.expand')}
                  onClick={() => setPanelOpen(true)}
                  data-testid="assistant-panel-expand"
                >
                  <PanelRight />
                </button>
              )}
            </div>
          </div>
          <ShellSlot name="chat" className="ta-chat" />
          <VoiceRecordingBar context={context} column={chatColumn} />
          <AssistantIdeasLayer context={context} column={chatColumn} />
        </div>
        {filePreviewOpen ? <section className="ta-panel" data-testid="assistant-file-preview"><ShellSlot name="file-preview" className="min-h-0 flex-1" /></section> : panelOpen ? <AssistantPanel context={context} onCollapse={() => setPanelOpen(false)} /> : null}
      </div>
    </AssistantCtx.Provider>
  );
});

function AssistantPanel({ context, onCollapse }: { context: AssistantContext; onCollapse: () => void }) {
  const { t } = useTranslation('assistant');
  const opened = useOpenedAssistantTaskChat();
  const taskChat = opened?.request.assistantId === context.assistant.id && context.route.tab === 'tasks';
  const { route, go } = context;
  const back = parentRoute(route);
  const labels: Record<PanelTab, string> = {
    today: t('nav.today'),
    tasks: t('nav.tasks'),
    memory: t('nav.memory'),
    profile: t('nav.profile'),
  };
  const Page = ASSISTANT_PAGES[route.tab];
  return (
    <section className="ta-panel" data-testid={`assistant-page-${route.tab}`} data-sub={route.sub ?? ''}>
      <div className="ta-panel-top" hidden={taskChat}>
        {back ? (
          <button type="button" className="ta-circle ta-panel-back" aria-label={t('panel.back')} title={t('panel.back')} onClick={() => go(back)} data-testid="assistant-back">
            <ChevronLeft />
          </button>
        ) : null}
        <div className="ta-seg" role="tablist">
          {PANEL_TABS.map((tab) => (
            <button key={tab} type="button" role="tab" aria-selected={route.tab === tab} onClick={() => { showAssistantTaskChat(null); go({ tab }); }} data-testid={`assistant-tab-${tab}`}>
              {labels[tab]}
            </button>
          ))}
        </div>
        <button type="button" className="ta-circle ta-panel-collapse" aria-label={t('panel.collapse')} title={t('panel.collapse')} onClick={onCollapse} data-testid="assistant-panel-collapse">
          <PanelRight />
        </button>
      </div>
      <div className="ta-panel-body" hidden={taskChat}>
        <Page context={context} />
      </div>
      {taskChat ? <ShellSlot name="task-chat" className="ta-task-chat-slot" /> : null}
      {taskChat ? <button type="button" className="ta-circle ta-task-panel-collapse" aria-label={t('panel.collapse')} onClick={onCollapse}><PanelRight /></button> : null}
    </section>
  );
}

export const assistantView = {
  WrapView: AssistantViewWrapper,
  TitlebarSlot: () => <ShellTitlebar />,
  MainPanel: AssistantMainPanel,
  withoutSessionSidebar: true,
} satisfies ViewDefinition<AssistantViewParams>;
