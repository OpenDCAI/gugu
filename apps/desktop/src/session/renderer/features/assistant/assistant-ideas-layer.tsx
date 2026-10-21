import { useVoiceNoteHandler } from '@/components/assistant/useVoiceNoteHandler';
import { Dialog, DialogContent } from '@renderer/lib/ui/dialog';
import type { AssistantContext } from './assistant-context';
import { IdeasEntry, IdeasPanel, useIdeasOpen } from './assistant-ideas';
import { useTodayFeedView } from './assistant-today';

/** 桌面「助理」视图左边那一列上的「灵感」:胶囊 + 对话框(「+」→「获取灵感」也开它)。读的是「动态」页那一份 today.json。 */
export function AssistantIdeasLayer({ context, column }: { context: AssistantContext; column: HTMLElement | null }) {
  const [open, setOpen] = useIdeasOpen();
  const view = useTodayFeedView(context.chatId);
  const { recording } = useVoiceNoteHandler();
  const { assistant } = context;
  return (
    <>
      <IdeasEntry assistantId={assistant.id} column={column} busy={recording} onOpen={() => setOpen(true)} />
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
