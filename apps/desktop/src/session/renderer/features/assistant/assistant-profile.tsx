import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Avatar } from '@/components/Avatar';
import { AssistantNameInline } from '@/components/assistant/AssistantNameInline';
import { ChevronRight, Pencil } from '@/lib/icons';
import { MarkdownRenderer } from '@renderer/lib/ui/markdown-renderer';
import { UI_EVENTS } from '@/lib/uiEvents';
import { readAssistantShellBridge } from '@/lib/assistantShellBridge';
import type { ActiveSection } from '@gugu/core/shared/enums/settingsSectionModels';
import type { AssistantPageProps } from './assistant-context';
import { AssistantDiaryDetail, AssistantDiaryList, AssistantDiarySection } from './assistant-diary';
import { useTodayFeedView } from './assistant-today';
import { CustomizeDialog, usePersona } from './assistant-personality';
import { ShellSlot } from './assistant-shell';
import { AssistantRow, AssistantSection, PageHead } from './assistant-ui';
import { AssistantLibraryCard, AssistantLibraryVolume } from '@/components/assistant/AssistantLibraryVolume';

/**
 * <它的名字> 这一格(资料页):头像(右下一支笔 = 自定义)、名字、「从某天起陪伴你」、性格胶囊、日记;
 * 应用和连接状态直接展开,复用设置中的同一个连接组件;详情、授权也走原来的数据与操作。
 */
function openSettings(section: ActiveSection) {
  window.dispatchEvent(new CustomEvent(UI_EVENTS.openSettings, { detail: { section } }));
}

export const AssistantProfilePage = observer(function AssistantProfilePage({ context }: AssistantPageProps) {
  const sub = context.route.sub ?? '';
  if (sub === 'library:capabilities' || sub === 'library:devices') return <AssistantLibraryVolume key={sub} machine={context.machine} kind={sub === 'library:capabilities' ? 'capabilities' : 'devices'} askInChat={context.askInChat} />;
  if (sub === 'settings') return <ShellPage slot="settings" title="nav.settings" />;
  if (sub === 'devices') return <ShellPage slot="devices" title="devices.title" />;
  if (sub === 'connectors') return <ShellPage slot="connectors" title="connectors.title" />;
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
  return (
    <div className="ta-page" data-testid={`assistant-slot-${slot}`}>
      {/* 页头(大标题);头一句说明由壳那一侧的组件带(让 X 帮你操作以下设备)。 */}
      <PageHead title={t(title)} />
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
  const diaries = useTodayFeedView(context.chatId);
  const since = assistant.created_at
    ? new Intl.DateTimeFormat(i18n.language, { year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(assistant.created_at))
    : null;
  const chip = persona.preset ? t(`customize.preset.${persona.preset}`) : persona.rest ? t('customize.custom') : t('customize.setCharacter');
  return (
    <div className="ta-page" data-testid="assistant-profile">
      <div className="ta-hero">
        <button type="button" className="ta-hero-avatar" onClick={() => setCustomizing(true)} aria-label={t('customize.title')} data-testid="assistant-profile-edit">
          <Avatar name={assistant.display_name} avatarUrl={assistant.avatar} seed={assistant.id} size={72} isAgent harnessBadge={false} hoverPoke />
          <span className="ta-hero-edit">
            <Pencil />
          </span>
        </button>
        <h1 className="ta-hero-name" data-testid="assistant-name">
          <AssistantNameInline key={assistant.id} name={assistant.display_name} onCommit={async (name) => { const actions = readAssistantShellBridge()?.getActions(); if (!actions) throw new Error('assistant shell unavailable'); await actions.renameAssistant(name); }} />
        </h1>
        {since ? <p className="ta-hero-since">{t('header.since', { date: since, name: context.ownerName || t('header.you') })}</p> : null}
        <button type="button" className="ta-chip mt-3" onClick={() => setCustomizing(true)} data-testid="assistant-character-chip">
          {chip}
          <ChevronRight />
        </button>
      </div>

      <AssistantDiarySection
        view={diaries}
        name={assistant.display_name}
        askInChat={(draft) => context.askInChat(draft)}
        open={(id) => context.go({ tab: 'profile', sub: `diary:${id}` })}
        openAll={() => context.go({ tab: 'profile', sub: 'diaries' })}
      />

      <AssistantSection title={t('connectors.title')} testId="assistant-profile-connectors" bare>
        <ShellSlot name="connectors" className="ta-skin ta-profile-connectors" />
      </AssistantSection>
      <AssistantSection title={t('capabilities.title')} testId="assistant-capabilities">
        <AssistantLibraryCard machine={context.machine} kind="capabilities" onOpen={() => context.go({ tab: 'profile', sub: 'library:capabilities' })} />
        <AssistantLibraryCard machine={context.machine} kind="devices" onOpen={() => context.go({ tab: 'profile', sub: 'library:devices' })} />
        <AssistantRow
          title={t('channels.title')}
          detail={t('channels.note', { name: assistant.display_name })}
          onClick={() => openSettings('channels')}
          testId="assistant-open-channels"
        />
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
