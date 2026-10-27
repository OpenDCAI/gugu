import { Dialog, DialogContent } from '@renderer/lib/ui/dialog';
import type { AssistantContext } from './assistant-context';
import { IdeasPanel, useIdeasOpen } from './assistant-ideas';
import { useTodayFeedView } from './assistant-today';

/** 桌面「助理」视图左边那一列上的「灵感」:对话框；入口在输入框工具行(「+」→「获取灵感」也开它)。读的是「动态」页那一份 today.json。 */
export function AssistantIdeasLayer({ context }: { context: AssistantContext }) {
  const [open, setOpen] = useIdeasOpen();
  const view = useTodayFeedView(context.chatId);
  const { assistant } = context;
  return (
    <>
      {open ? (
        <Dialog open onOpenChange={(next) => !next && setOpen(false)}>
          <DialogContent className="ta-dialog sm:max-w-[760px]" showCloseButton={false}>
            <IdeasPanel layout="dialog" view={view} assistantId={assistant.id} name={assistant.display_name} askInChat={(draft) => context.askInChat(draft)} onClose={() => setOpen(false)} />
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}
