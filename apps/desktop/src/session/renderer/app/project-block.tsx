import { observer } from 'mobx-react-lite';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { FolderClosed } from '@/lib/icons';
import { ProjectMainPanel } from '@renderer/features/projects/components/main-panel/main-panel';
import { ProjectMenu } from '@renderer/features/projects/components/project-menu';
import { ProjectTitleActions } from '@renderer/features/projects/components/project-title-actions';
import { getProjectStore, projectDisplayName } from '@renderer/features/projects/stores/project-selectors';
import { SessionShellProvider } from '@renderer/features/sessions/session-shell-context';
import { TabBarActionRow } from '@renderer/features/sessions/titlebar-actions';
import { TabStripShell } from '@renderer/features/tabs/tab-bar';
import { TabChip, TabSlot } from '@renderer/features/tabs/tab-bar/tab-chip';
import { useWorkspaceLayoutContext } from '@renderer/lib/layout/layout-provider';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { projectGroupsStore } from '@renderer/features/projects/stores/project-groups-store';
import { ChatSlot } from '@renderer/lib/chat-slot';
import { ComposerVerbDock } from '@renderer/features/sessions/task-dispatch-composer';
import { useChatHasMessages } from '@/lib/chatActivityBridge';
import { useComposerVerb } from '@/lib/composerVerbBridge';
import { useProjectFolderStage } from '@renderer/features/projects/components/main-panel/project-folder-stage';
import { rpcOn } from '@renderer/lib/ipc';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { log } from '@renderer/utils/logger';
import { screenLayout } from './screen-layout';

/**
 * 一个项目占一块(gugu-dev#181「块与页签」):顶上一条页签条(和会话块同一套),第一枚是项目群,不能关;
 * 下面是这一枚的内容:项目群的消息流(和对话页同一个群聊组件,由壳画进格子)。群里还没有消息(包括刚建的项目)
 * 时正中是项目首页那一套 —— 文件夹卡 + 输入框,和以前点项目进来看到的一样。
 * 项目菜单(移除项目、仓库链接)和「在哪里打开」挂在页签条右端,❌ 另起一条顶栏。
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
            <ProjectMenu projectId={projectId} />
            <ProjectTitleActions projectId={projectId} />
            {blockActions}
          </TabBarActionRow>
        }
      >
        <TabSlot data-project-block-tab={projectId}>
          <TabChip isActive isFocusedPane={focused} label={label} preSlot={<FolderClosed className="size-3.5 shrink-0" />} />
        </TabSlot>
      </TabStripShell>
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col" data-project-block={projectId}>
        {chatId && hasMessages ? (
          <>
            <ChatSlot chatId={chatId} className="flex min-h-0 min-w-0 flex-1 flex-col" />
            {/* gugu-dev#181 群里输入框选了「新任务 / 定时任务」:那个框收起,这里换上对应的框(建在这个项目里)。 */}
            {verb === 'task' ? <ProjectTaskDock chatId={chatId} projectId={projectId} /> : <ComposerVerbDock chatId={chatId} projectId={projectId} />}
          </>
        ) : (
          <SessionShellProvider>
            <ProjectMainPanel projectId={projectId} />
          </SessionShellProvider>
        )}
      </div>
    </>
  );
});

/**
 * 在项目里开新任务(gugu-dev#181「输入框」):框原地换成新任务的框,项目的文件夹卡浮到群聊上面 —— 整片统一淡下去,
 * 卡和输入框在最上面同一层(输入框不被盖住)。点一张文件夹 = 新任务从那里开工,卡收回;直接打字、按 Esc、点空白处,
 * 卡也让开。卡就是项目首页那一张(useProjectFolderStage),❌ 另画一份。
 */
const ProjectTaskDock = observer(function ProjectTaskDock({ chatId, projectId }: { chatId: string; projectId: string }) {
  const stage = useProjectFolderStage(projectId);
  const [cardShown, setCardShown] = useState(true);
  const chosen = stage.scopedFolders.chosen?.workspaceId ?? null;
  const chosenAtOpen = useRef(chosen);
  useEffect(() => {
    if (chosen !== chosenAtOpen.current) setCardShown(false);
  }, [chosen]);
  useEffect(() => {
    if (!cardShown) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setCardShown(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cardShown]);
  return (
    <>
      {cardShown ? (
        <div
          className="absolute inset-0 z-20 flex items-center justify-center bg-background/80 px-4 pb-32"
          data-project-task-card=""
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) setCardShown(false);
          }}
        >
          {stage.card}
        </div>
      ) : null}
      <div
        className="relative z-30"
        onKeyDownCapture={(event) => {
          if (cardShown && event.key.length === 1) setCardShown(false);
        }}
      >
        <ComposerVerbDock chatId={chatId} projectId={stage.targetProjectId} workspaceId={chosen} />
      </div>
    </>
  );
});
