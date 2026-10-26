import { useState } from 'react';
import { Dialog, DialogContent } from '@renderer/lib/ui/dialog';
import { MarkdownRenderer } from '@renderer/lib/ui/markdown-renderer';
import type { AssistantPageProps } from './assistant-context';
import { useTodayFile } from './assistant-data';
import { AssistantTodayFeed, type TodayFeedView } from './assistant-today-feed';
import { WidgetDiscover } from './assistant-widget-discover';
import { AssistantDiaryDetail } from './assistant-diary';

/**
 * 桌面「助理」视图的「动态」那一格:主进程读私聊文件夹里的 today.json(useTodayFile),画成共用的信息流(assistant-today-feed.tsx)。
 * 手机壳里的助理 App 画同一个信息流,读法换成窗口里 fetch(mobile/assistant)。
 */
/** today.json 此刻读到哪一步(「动态」页信息流与「<名字>」那一格的日记读同一份,react-query 同一个缓存)。 */
export function useTodayFeedView(chatId: string | null): TodayFeedView {
  const today = useTodayFile(chatId);
  return !chatId || today.isLoading
    ? { state: 'loading' }
    : today.isError || !today.data
      ? { state: 'error', error: today.error, retry: () => void today.refetch() }
      : { state: 'read', read: today.data };
}

/** 「添加组件」在桌面是一个对话框(发现组件,宽 625);「管理连接器」去 <名字> → 连接应用。 */
export function AssistantTodayPage({ context }: AssistantPageProps) {
  const view = useTodayFeedView(context.chatId);
  const [discovering, setDiscovering] = useState(false);
  const name = context.assistant.display_name;
  if (context.route.sub?.startsWith('diary:')) return <AssistantDiaryDetail view={view} name={name}
    askInChat={(draft) => context.askInChat(draft)} id={context.route.sub.slice('diary:'.length)}
    renderMarkdown={(markdown) => <MarkdownRenderer content={markdown} />} />;
  return (
    <>
      <AssistantTodayFeed
        view={view}
        assistantName={name}
        ownerName={context.ownerName}
        askInChat={(draft) => context.askInChat(draft)}
        renderMarkdown={(markdown) => <MarkdownRenderer content={markdown} />}
        onAddWidget={() => setDiscovering(true)}
        onManageConnectors={() => context.go({ tab: 'profile', sub: 'connectors' })}
        onOpenDiary={(id) => context.go({ tab: 'today', sub: `diary:${id}` })}
      />
      {discovering ? (
        <Dialog open onOpenChange={(open) => !open && setDiscovering(false)}>
          <DialogContent className="ta-dialog sm:max-w-[625px]" showCloseButton={false}>
            <WidgetDiscover layout="dialog" name={name} askInChat={(draft) => context.askInChat(draft)} onClose={() => setDiscovering(false)} />
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}
