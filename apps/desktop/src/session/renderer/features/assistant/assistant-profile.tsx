import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Avatar } from '@/components/Avatar';
import { AssistantNameInline } from '@/components/assistant/AssistantNameInline';
import { ChevronRight, Link, Monitor, Pencil } from '@/lib/icons';
import { MarkdownRenderer } from '@renderer/lib/ui/markdown-renderer';
import { readAssistantShellBridge } from '@/lib/assistantShellBridge';
import type { AssistantPageProps } from './assistant-context';
import { AssistantDiaryDetail, AssistantDiaryList } from './assistant-diary';
import { useTodayFeedView } from './assistant-today';
import { ResourceFiles } from './assistant-memory-page';
import { CustomizeDialog, usePersona } from './assistant-personality';
import { ShellSlot, useAssistantShell } from './assistant-shell';
import { useAssistantPanelPage } from '@/lib/assistantPanelPage';
import { usePhoneRead } from '@/mobile/assistant/usePhoneRead';
import { peekAssistantPanelIntegrations,readAssistantPanelIntegrations } from '@/components/assistant/assistant-panel-integrations';
import { useChatChannels } from '@/components/settings/channels/useChatChannels';
import { assistantApplicationCounts } from '@/components/assistant/assistant-app-connections';
import { AssistantRow, AssistantSection, PageHead } from './assistant-ui';
import { AssistantLibraryCard, AssistantLibraryVolume } from '@/components/assistant/AssistantLibraryVolume';

/**
 * 资料页：头像、名字、性格胶囊，以及项目、设备、能力、连接应用四个入口。
 * 应用入口复用设置中的同一个连接组件;详情、授权也走原来的数据与操作。
 */

export const AssistantProfilePage = observer(function AssistantProfilePage({ context }: AssistantPageProps) {
  const sub = context.route.sub ?? '';
  if (sub === 'library:workspace') return <AssistantLibraryVolume key={sub} assistantId={context.assistant.id} machine={context.machine} kind="workspace" askInChat={context.askInChat} />;
  if (sub === 'library:capabilities') return <AssistantLibraryVolume key={sub} assistantId={context.assistant.id} machine={context.machine} kind='capabilities' askInChat={context.askInChat} />;
  if (sub === 'library:devices') return <ShellPage slot="devices" title="devices.title" />;
  if (sub === 'settings') return <ShellPage slot="settings" title="nav.settings" />;
  if (sub === 'devices') return <ShellPage slot="devices" title="devices.title" />;
  if (sub === 'connectors') return <ShellPage slot="connectors" title="connectors.title" />;
  if (sub === 'files' || sub.startsWith('files:')) return <ResourceFiles key={sub} context={context} trail={sub.startsWith('files:') ? sub.slice('files:'.length).split('/').filter(Boolean) : []} />;
  if (sub === 'diaries' || sub.startsWith('diary:')) return <DiaryPage context={context} sub={sub} />;
  // 「customize」= 开通后聊天里那张「自定义」卡点进来的:资料页上直接打开自定义弹窗,关掉回资料页。
  return <ProfileHome context={context} openCustomize={sub === 'customize'} />;
});

/** 全部日记 / 一篇日记(它写在 today.json 里的 diary 那几批,与「动态」页同一份)。 */
function DiaryPage({ context, sub }: AssistantPageProps & { sub: string }) {
  const view = useTodayFeedView(context.chatId);
  const name = context.assistant.display_name;
  const askInChat = (draft: string) => context.askInChat(draft);
  if (sub === 'diaries') return <AssistantDiaryList view={view} name={name} askInChat={askInChat} open={(id) => context.go({ tab: 'profile', sub: `diary:${id}` })} />;
  return (
    <AssistantDiaryDetail
      view={view}
      name={name}
      askInChat={askInChat}
      id={sub.slice('diary:'.length)}
      renderMarkdown={(markdown) => <MarkdownRenderer content={markdown} />}
    />
  );
}

/** 设备:壳那棵树里的组件(设置里同一份逻辑与数据),画进格子、在这里换助理 App 的样子(.ta-skin)。 */
function ShellPage({ slot, title }: { slot: 'devices' | 'connectors' | 'settings'; title: string }) {
  const { t } = useTranslation('assistant');
  const innerPage = useAssistantPanelPage();
  return (
    <div className="ta-page" data-testid={`assistant-slot-${slot}`}>
      {/* 页头(大标题);头一句说明由壳那一侧的组件带(让 X 帮你操作以下设备)。 */}
      {!innerPage && <PageHead title={t(title)} />}
      <ShellSlot name={slot} className="ta-skin" />
    </div>
  );
}

const ProfileHome = observer(function ProfileHome({ context, openCustomize = false }: AssistantPageProps & { openCustomize?: boolean }) {
  const { t, i18n } = useTranslation('assistant');
  const [customizing, setCustomizing] = useState(openCustomize);
  // 资料页已经开着时再从聊天的卡点进来:路由变了也要打开(useState 的初值只在第一次挂载时读)。
  useEffect(() => {
    if (openCustomize) setCustomizing(true);
  }, [openCustomize]);
  const { assistant } = context;
  const persona = usePersona(context);
  const shell = useAssistantShell();
  const panel = context.machine?.panel;
  const apps = usePhoneRead(panel ? `profile-apps|${context.assistant.id}` : null, () => readAssistantPanelIntegrations(panel!, i18n.language), 'read application connections',undefined,() => peekAssistantPanelIntegrations(panel,i18n.language));
  const chat = useChatChannels();
  const counts = apps.state === 'ok' && chat.status === 'ready' ? assistantApplicationCounts(apps.data.items, apps.data.configured, apps.data.statuses, chat.list) : null;
  const chip = persona.preset ? t(`customize.preset.${persona.preset}`) : persona.rest ? t('customize.custom') : t('customize.setCharacter');
  return (
    <div className="ta-page" data-testid="assistant-profile">
      <div className="ta-hero">
        <button type="button" className="ta-hero-avatar" onClick={() => setCustomizing(true)} aria-label={t('customize.title')} data-testid="assistant-profile-edit">
          <Avatar name={assistant.display_name} avatarUrl={assistant.avatar} seed={assistant.id} size={72} canvasPaddingX={24} isAgent harnessBadge={false} hoverPoke />
          <span className="ta-hero-edit">
            <Pencil />
          </span>
        </button>
        <h1 className="ta-hero-name" data-testid="assistant-name">
          <AssistantNameInline key={assistant.id} name={assistant.display_name} onCommit={async (name) => { const actions = readAssistantShellBridge()?.getActions(); if (!actions) throw new Error('assistant shell unavailable'); await actions.renameAssistant(name); }} />
        </h1>
        <button type="button" className="ta-chip mt-3" onClick={() => setCustomizing(true)} data-testid="assistant-character-chip">
          {chip}
          <ChevronRight />
        </button>
      </div>

      <AssistantSection testId="assistant-profile-entries">
        <AssistantLibraryCard assistantId={context.assistant.id} machine={context.machine} kind="workspace" onOpen={() => context.go({ tab: 'profile', sub: 'library:workspace' })} />
        <AssistantRow leading={<Monitor />} title={t('library.devices')} detail={shell?.deviceCount === undefined ? undefined : t('connectors.deviceCount', { count: shell.deviceCount })} onClick={() => context.go({ tab: 'profile', sub: 'devices' })} testId="assistant-library-devices" />
        <AssistantLibraryCard assistantId={context.assistant.id} machine={context.machine} kind="capabilities" onOpen={() => context.go({ tab: 'profile', sub: 'library:capabilities' })} />
        <AssistantRow leading={<Link />} title={t('connectors.title')} detail={!counts ? undefined : t(counts.saved > counts.connected ? 'connectors.savedCount' : 'connectors.connectedCount', { count: counts.saved > counts.connected ? counts.saved : counts.connected })}
          onClick={() => context.go({ tab: 'profile', sub: 'connectors' })} testId="assistant-profile-connectors" />
      </AssistantSection>

      {customizing ? (
        <CustomizeDialog
          context={context}
          onClose={() => {
            setCustomizing(false);
            if (openCustomize) context.go({ tab: 'profile' });
          }}
        />
      ) : null}
    </div>
  );
});
