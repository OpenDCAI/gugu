import { observer } from 'mobx-react-lite';
import { useEffect, useState, type ReactNode } from 'react';
import { MessageFilePreviewPanel } from '@/components/chat/MessageFilePreviewPanel';
import { classifyDocumentPreview } from '@/components/chat/documentPreview';
import { forgetSampleProjectOnScreen } from '@renderer/app/screen-layout-actions';
import { screenLayout } from '@renderer/app/screen-layout';
import { TabBarActionRow } from '@renderer/features/sessions/titlebar-actions';
import { TabStripShell } from '@renderer/features/tabs/tab-bar';
import { TabChip, TabSlot } from '@renderer/features/tabs/tab-bar/tab-chip';
import { useWorkspaceLayoutContext } from '@renderer/lib/layout/layout-provider';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { SampleNewProjectButton } from './sample-new-project-button';
import { SampleProjectTranscript, sampleFileBytes } from './sample-project-transcript';
import { SampleTaskPane } from './sample-task-pane';
import { sampleProjectContent, useSampleProject } from './use-sample-project';

type OpenPane = { kind: 'file'; fileId: string } | { kind: 'task' } | null;

/**
 * 示例项目「周末去杭州」那一块(#709):和项目那一块同一条页签条(项目名 + 「示例」),下面是项目群里那段真跑过、固化下来的对话。
 * 点文件卡 = 右边看这份文件(群聊同一块预览);点任务卡 = 右边看这一趟它做了什么。没有输入框:底下一行说明这是示例,
 * 旁边「新建项目」和侧栏「添加项目」同一组。全在包里,❌ 读网络、❌ 调模型。账号上的键读到「不在了」,这一块自己收掉。
 */
export const SampleProjectBlock = observer(function SampleProjectBlock({ blockId, blockActions }: { blockId: string; blockActions?: ReactNode }) {
  const { translate, locale } = useSessionMessages();
  const { isLeftOpen } = useWorkspaceLayoutContext();
  const sample = useSampleProject();
  const [pane, setPane] = useState<OpenPane>(null);
  const corners = screenLayout.corners(blockId);
  const focused = screenLayout.focusedBlockId === blockId;
  const content = sampleProjectContent(locale);
  useEffect(() => {
    if (sample.settled && !sample.shown) forgetSampleProjectOnScreen();
  }, [sample.settled, sample.shown]);
  const file = pane?.kind === 'file' ? content.files.find((entry) => entry.id === pane.fileId) : undefined;
  return (
    <>
      <TabStripShell
        reserveShellRestoreLane={corners.topLeft && !isLeftOpen}
        actionsSlot={<TabBarActionRow atWindowEdge={corners.topRight}>{blockActions}</TabBarActionRow>}
      >
        <TabSlot data-sample-project-tab="">
          <TabChip isActive isFocusedPane={focused} label={translate('projects.sample.name')} hint={translate('projects.sample.tag')} />
        </TabSlot>
      </TabStripShell>
      <div className="flex min-h-0 min-w-0 flex-1" data-sample-project-block="">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {sample.owner ? (
            <SampleProjectTranscript
              content={content}
              owner={sample.owner}
              onOpenFile={(fileId) => setPane({ kind: 'file', fileId })}
              onOpenTask={() => setPane({ kind: 'task' })}
            />
          ) : <div className="min-h-0 flex-1" />}
          <footer className="flex shrink-0 items-center gap-3 border-t border-border-subtle px-4 py-3">
            <span className="min-w-0 flex-1 text-sm text-foreground-muted">{translate('projects.sample.note')}</span>
            <SampleNewProjectButton />
          </footer>
        </div>
        {file ? (
          <MessageFilePreviewPanel
            file={{ fileName: file.name, sizeBytes: sampleFileBytes(file), mimeType: file.mimeType }}
            kind={classifyDocumentPreview({ fileName: file.name, mimeType: file.mimeType })}
            content={file.text}
            loading={false}
            onClose={() => setPane(null)}
          />
        ) : null}
        {pane?.kind === 'task' ? (
          <SampleTaskPane content={content} onOpenFile={(fileId) => setPane({ kind: 'file', fileId })} onClose={() => setPane(null)} />
        ) : null}
      </div>
    </>
  );
});
