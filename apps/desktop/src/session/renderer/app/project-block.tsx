import { observer } from 'mobx-react-lite';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { FolderClosed } from '@/lib/icons';
import { ProjectMainPanel } from '@renderer/features/projects/components/main-panel/main-panel';
import { ProjectTabMenu } from '@renderer/features/projects/components/project-menu';
import { ProjectTitleActions } from '@renderer/features/projects/components/project-title-actions';
import { getProjectStore, projectDisplayName } from '@renderer/features/projects/stores/project-selectors';
import { SessionShellProvider } from '@renderer/features/sessions/session-shell-context';
import { TabBarActionRow } from '@renderer/features/sessions/titlebar-actions';
import { TabStripShell } from '@renderer/features/tabs/tab-bar';
import { TabChip, TabSlot } from '@renderer/features/tabs/tab-bar/tab-chip';
import { useWorkspaceLayoutContext } from '@renderer/lib/layout/layout-provider';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { projectGroupsStore } from '@renderer/features/projects/stores/project-groups-store';
import { ChatPartSlot, ChatSlot } from '@renderer/lib/chat-slot';
import { ComposerVerbDock } from '@renderer/features/sessions/task-dispatch-composer';
import { composerVerbLook } from '@renderer/features/sessions/composer-verb-tag';
import { composerDrafts, projectDraftKey } from '@renderer/features/sessions/composer-drafts';
import { ProjectTaskComposer } from '@renderer/features/projects/components/main-panel/project-home';
import { useChatHasMessages } from '@/lib/chatSummariesBridge';
import { setComposerVerb, takeComposerCarry, useComposerVerb } from '@/lib/composerVerbBridge';
import { Button } from '@renderer/lib/ui/button';
import { useProjectFolderStage } from '@renderer/features/projects/components/main-panel/project-folder-stage';
import { focusSessionComposer } from '@renderer/features/sidebar/session-keyboard-nav';
import { rpcOn } from '@renderer/lib/ipc';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { log } from '@renderer/utils/logger';
import { screenLayout } from './screen-layout';

/**
 * 一个项目占一块(gugu-dev#181「块与页签」):顶上一条页签条(和会话块同一套),第一枚是项目群,不能关;
 * 下面是这一枚的内容:项目群的消息流(和对话页同一个群聊组件,由壳画进格子)。群里还没有消息(包括刚建的项目)
 * 时正中是项目首页那一套 —— 文件夹卡 + 输入框,和以前点项目进来看到的一样。
 * 格子里没有群聊头:群聊头那排图标(搜索、群文件夹、成员、历史、⋯)由壳画进页签条右端,后面是「在哪里打开」,
 * ❌ 另起一条顶栏。仓库链接、移除项目在项目页签的右键菜单里。
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
  const hasMessages = useChatHasMessages(chatId);
  const verb = useComposerVerb(chatId);
  // 项目就是群(gugu-dev#181):项目一摆上屏,它的群就该在 —— 新建的项目一进来就建好(只有自己一个人),
  // 老项目没有群的也在这时补上。幂等;建好了由绑定变更事件刷新各处。
  useEffect(() => {
    void Promise.resolve().then(() => rpcOn(machineRegistry.machineOf(projectId) ?? null).projects.ensureProjectGroup(projectId)).then((result) => {
      if (!result.success) log.warn('[project-block] 项目群没建成', { projectId, error: result.error });
    }).catch((error: unknown) => log.warn('[project-block] 项目群没建成', { projectId, error: String(error) }));
  }, [projectId]);
  return (
    <>
      <TabStripShell
        reserveShellRestoreLane={corners.topLeft && !isLeftOpen}
        actionsSlot={
          <TabBarActionRow atWindowEdge={corners.topRight} fixedCluster={false}>
            {chatId && hasMessages !== false ? <ChatPartSlot chatId={chatId} part="actions" className="flex items-center" /> : null}
            <ProjectTitleActions projectId={projectId} />
            {blockActions}
          </TabBarActionRow>
        }
      >
        <TabSlot data-project-block-tab={projectId}>
          <ProjectTabMenu projectId={projectId}>
            <TabChip
              isActive
              isFocusedPane={focused}
              label={label}
              preSlot={
                // gugu-dev#181:页签上那枚小文件夹 = 在这个项目里开新任务(框变「新任务」、文件夹卡浮出来)。
                // 群里还没有消息时这一块本来就是项目首页,不用它。
                chatId && hasMessages !== false ? (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={translate('taskDispatch.task')}
                    title={translate('taskDispatch.task')}
                    onClick={(event) => {
                      event.stopPropagation();
                      setComposerVerb(chatId, 'task');
                    }}
                  >
                    <FolderClosed className="size-3.5 shrink-0" />
                  </Button>
                ) : (
                  <FolderClosed className="size-3.5 shrink-0" />
                )
              }
            />
          </ProjectTabMenu>
        </TabSlot>
        {chatId && hasMessages !== false ? <ChatPartSlot chatId={chatId} part="tabs" className="contents" /> : null}
      </TabStripShell>
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col" data-project-block={projectId}>
        {/* 正中摆群还是首页:只有确知群里没消息(或确知没有群)才摆首页;还不知道时摆群(多数项目群里有消息),
            连有没有群都还不知道就先空着 —— ❌ 把「还没读到」当成「没有」先画一帧首页。 */}
        {chatId && hasMessages !== false ? (
          <>
            <ChatSlot chatId={chatId} className="flex min-h-0 min-w-0 flex-1 flex-col" />
            {/* gugu-dev#181 群里输入框选了「新任务 / 定时任务」:那个框收起,这里换上对应的框(建在这个项目里)。 */}
            {verb === 'task' ? <ProjectTaskDock chatId={chatId} projectId={projectId} /> : <ComposerVerbDock chatId={chatId} projectId={projectId} />}
          </>
        ) : chatId || projectGroupsStore.bindingKnown(projectId) ? (
          <SessionShellProvider>
            <ProjectMainPanel projectId={projectId} />
          </SessionShellProvider>
        ) : null}
      </div>
    </>
  );
});

/**
 * 在项目里开新任务(gugu-dev#181「输入框」):框原地换成新任务的框(与项目首页同一个,ProjectTaskComposer),项目的文件夹卡
 * 浮到群聊上面 —— 整片统一淡下去、虚一点,卡和输入框在最上面同一层(输入框不被盖住)。点一张文件夹 = 新任务从那里开工,
 * 卡让开;直接打字、按 Esc、点空白处,卡也让开。卡就是项目首页那一张(useProjectFolderStage),❌ 另画一份。
 */
const ProjectTaskDock = observer(function ProjectTaskDock({ chatId, projectId }: { chatId: string; projectId: string }) {
  const { translate } = useSessionMessages();
  const [cardShown, setCardShown] = useState(true);
  const stage = useProjectFolderStage(projectId, { floating: true, onChosen: () => setCardShown(false) });
  // 选「新任务」那一刻群里输入框写着的话跟过来:要在新建框挂上(读草稿)之前放好。
  useState(() => {
    const carried = takeComposerCarry(chatId);
    if (carried) composerDrafts.set(projectDraftKey(projectId), carried);
    return null;
  });
  // 卡浮着时按 Esc 或直接打字,卡就让开;打的字落进新任务的框(焦点在别处也一样)。
  const dockRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!cardShown) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setCardShown(false);
      if (event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) return;
      setCardShown(false);
      if (dockRef.current && !dockRef.current.contains(document.activeElement)) focusSessionComposer(dockRef.current);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cardShown]);
  const close = () => setComposerVerb(chatId, null);
  return (
    <>
      {cardShown ? (
        <div
          className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-(--em-surface-base)/65 px-4 pb-32 backdrop-blur-[2px]"
          data-project-task-card=""
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) setCardShown(false);
          }}
        >
          {stage.card}
        </div>
      ) : null}
      <div ref={dockRef} className="relative z-30">
        <ProjectTaskComposer
          projectId={projectId}
          stage={stage}
          verb={composerVerbLook('task', { label: translate('taskDispatch.task'), onCancel: close, testId: 'task-dispatch' })}
          placeholder={(agent) => translate('taskDispatch.placeholder', { agent })}
          onSessionCreated={close}
          focusOnOpen
        />
      </div>
    </>
  );
});
