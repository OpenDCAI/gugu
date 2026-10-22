import { observer } from 'mobx-react-lite';
import type { ReactNode } from 'react';
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
            <ComposerVerbDock chatId={chatId} projectId={projectId} />
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
