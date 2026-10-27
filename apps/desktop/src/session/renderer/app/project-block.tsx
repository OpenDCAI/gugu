import { observer } from 'mobx-react-lite';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ProjectMainPanel } from '@renderer/features/projects/components/main-panel/main-panel';
import { ProjectMenuItems, ProjectTabMenu, projectHasMenu } from '@renderer/features/projects/components/project-menu';
import { getProjectStore, projectDisplayName } from '@renderer/features/projects/stores/project-selectors';
import { TabBarActionRow } from '@renderer/features/sessions/titlebar-actions';
import { TabStripShell } from '@renderer/features/tabs/tab-bar';
import { TabChip, TabSlot } from '@renderer/features/tabs/tab-bar/tab-chip';
import { useWorkspaceLayoutContext } from '@renderer/lib/layout/layout-provider';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { projectGroupsStore } from '@renderer/features/projects/stores/project-groups-store';
import { ChatEmptyContent, ChatPartSlot, ChatSlot } from '@renderer/lib/chat-slot';
import { cancelComposerVerb, composerVerbLook } from '@renderer/features/sessions/composer-verb-tag';
import { composerDrafts, projectDraftKey } from '@renderer/features/sessions/composer-drafts';
import { ProjectTaskComposer } from '@renderer/features/projects/components/main-panel/project-home';
import { setComposerVerb, takeComposerCarry, useComposerVerb } from '@/lib/composerVerbBridge';
import { useProjectFolderStage } from '@renderer/features/projects/components/main-panel/project-folder-stage';
import { useFloatingCardKeys } from './floating-card-keys';
import { chatTabHasActions } from '@renderer/features/chats/chat-tab-menu-items';
import { ChatPanes, ChatTabChip } from '@renderer/features/chats/chat-tabs/chat-panes';
import { rpcOn } from '@renderer/lib/ipc';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { log } from '@renderer/utils/logger';
import { screenLayout } from './screen-layout';

/**
 * 一个项目占一块(gugu-dev#181「块与页签」):顶上一条页签条(和会话块同一套),第一枚是项目群,不能关;
 * 下面是这一枚的内容:项目群的消息流(和对话页同一个群聊组件,由壳画进格子)。群里还没有消息(包括刚建的项目)
 * 时正中是项目首页那一套 —— 文件夹卡 + 输入框,和以前点项目进来看到的一样。
 * The conversation supplies the strip's actions even while its empty column shows the project home.
 */
export const ProjectBlock = observer(function ProjectBlock({
  blockId,
  projectId,
  blockActions,
}: {
  blockId: string;
  projectId: string;
  /** 屏上不止一块时右端那枚「关闭这一块」(由这屏的骨架给)。 */
  blockActions?: ReactNode;
}) {
  const { translate } = useSessionMessages();
  const { isLeftOpen } = useWorkspaceLayoutContext();
  const corners = screenLayout.corners(blockId);
  const focused = screenLayout.focusedBlockId === blockId;
  const label = projectDisplayName(getProjectStore(projectId)) ?? translate('projects.fallbackName');
  const chatId = projectGroupsStore.chatIdOf(projectId);
  const verb = useComposerVerb(chatId);
  // 项目就是群(gugu-dev#181):项目一摆上屏,它的群就该在 —— 新建的项目一进来就建好(只有自己一个人),
  // 老项目没有群的也在这时补上。幂等;建好了由绑定变更事件刷新各处。
  useEffect(() => {
    void Promise.resolve().then(() => rpcOn(machineRegistry.machineOf(projectId) ?? null).projects.ensureProjectGroup(projectId)).then((result) => {
      if (!result.success) log.warn('[project-block] 项目群没建成', { projectId, error: result.error });
    }).catch((error: unknown) => log.warn('[project-block] 项目群没建成', { projectId, error: String(error) }));
  }, [projectId]);
  const projectChip = (
    <TabSlot data-project-block-tab={projectId}>
      <ProjectTabMenu projectId={projectId} chatId={null}>
        <TabChip isActive isFocusedPane={focused} label={label} />
      </ProjectTabMenu>
    </TabSlot>
  );
  // 项目群还没绑上(刚建、还在读):只有项目那一枚,正中是项目首页。
  if (!chatId) {
    return (
      <>
        <TabStripShell
          reserveShellRestoreLane={corners.topLeft && !isLeftOpen}
          actionsSlot={<TabBarActionRow atWindowEdge={corners.topRight}>{blockActions}</TabBarActionRow>}
        >
          {projectChip}
        </TabStripShell>
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col" data-project-block={projectId}>
          {projectGroupsStore.bindingKnown(projectId) ? <ProjectMainPanel projectId={projectId} /> : null}
        </div>
      </>
    );
  }
  return (
    <ChatPanes
      chatId={chatId}
      blockId={blockId}
      reserveShellRestoreLane={corners.topLeft && !isLeftOpen}
      actionsSlot={
        <TabBarActionRow atWindowEdge={corners.topRight}>
          <ChatPartSlot chatId={chatId} part="actions" className="flex items-center" />
          {blockActions}
        </TabBarActionRow>
      }
      // 项目群那一枚写项目名;点它 = 看群(并排着的那一页照旧在旁边),右键是项目的菜单。
      chip={({ tab, host }) => (
        <ChatTabChip
          tab={tab}
          host={host}
          focused={focused}
          data-project-block-tab={projectId}
          label={label}
          menu={projectHasMenu(projectId) || chatTabHasActions(chatId) ? <ProjectMenuItems projectId={projectId} chatId={chatId} /> : undefined}
        />
      )}
      body={
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col" data-project-block={projectId}>
          {/* The conversation owns the header and right panels even before its first message. */}
          <ChatSlot chatId={chatId} className="flex min-h-0 min-w-0 flex-1 flex-col" />
          <ChatEmptyContent chatId={chatId}><ProjectMainPanel projectId={projectId} /></ChatEmptyContent>
          {/* gugu-dev#181 群里输入框选了「新任务」:那个框收起,这里换上新任务的框(建在这个项目里)。 */}
          {verb === 'task' ? <ProjectTaskDock chatId={chatId} projectId={projectId} /> : null}
        </div>
      }
    />
  );
});

/**
 * 在项目里开新任务(gugu-dev#181「输入框」):框原地换成新任务的框(与项目首页同一个,ProjectTaskComposer),项目的文件夹卡
 * 浮到群聊上面 —— 整片统一淡下去、虚一点,卡和输入框在最上面同一层(输入框不被盖住)。点一张文件夹 = 新任务从那里开工,
 * 卡让开;按 Esc 卡也让开。打字不让开(owner 10-26「一打字，彩色文件夹就消失了，这不对」),框里本来就有字也照样浮着。
 * 点卡旁边的空白不让开(owner 10-23:点空了不该把这一页退掉)。卡就是项目首页那一张(useProjectFolderStage),❌ 另画一份。
 */
const ProjectTaskDock = observer(function ProjectTaskDock({ chatId, projectId }: { chatId: string; projectId: string }) {
  const { translate } = useSessionMessages();
  // 选「新任务」那一刻群里输入框写着的话跟过来:要在新建框挂上(读草稿)之前放好。
  useState(() => {
    const carried = takeComposerCarry(chatId);
    if (carried) composerDrafts.set(projectDraftKey(projectId), carried);
    return null;
  });
  // 框里已经有字(群里写着带过来的、新建会话页选项目带过来的)也照样浮着:打字不收卡,带过来的字同理(owner 10-26)。
  const [cardShown, setCardShown] = useState(true);
  const stage = useProjectFolderStage(projectId, { floating: true, onChosen: () => setCardShown(false) });
  const dockRef = useRef<HTMLDivElement>(null);
  useFloatingCardKeys(cardShown, () => setCardShown(false), dockRef);
  const close = () => setComposerVerb(chatId, null);
  return (
    <>
      {cardShown ? (
        <div
          className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-(--em-surface-base)/65 px-4 pb-32 backdrop-blur-[2px]"
          data-project-task-card=""
        >
          {stage.card}
        </div>
      ) : null}
      <div ref={dockRef} className="relative z-30">
        <ProjectTaskComposer
          projectId={projectId}
          stage={stage}
          verb={composerVerbLook('task', { label: translate('taskDispatch.task'), onCancel: () => cancelComposerVerb(chatId, projectDraftKey(projectId)), testId: 'task-dispatch' })}
          placeholder={(agent) => translate('taskDispatch.placeholder', { agent })}
          onSessionCreated={close}
          focusOnOpen
        />
      </div>
    </>
  );
});
