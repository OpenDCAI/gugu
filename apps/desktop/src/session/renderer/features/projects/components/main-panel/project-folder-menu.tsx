import { messageForUser } from '@/lib/userFacingError';
import type { ReactElement } from 'react';
import type { ProjectFolder } from '@shared/core/projects/project-folders';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@renderer/lib/ui/context-menu';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { ProjectFoldersState, ShownFolder } from './project-folders';

export function ProjectFolderMenu({ folder, projectName, state, disabled, children }: {
  folder: ShownFolder;
  projectName: string;
  state: Pick<ProjectFoldersState, 'detach'>;
  disabled: boolean;
  children: ReactElement;
}) {
  const { translate } = useSessionMessages();
  const reportFailure = () => toast({ tier: 'error', title: translate('projects.folders.errorDetach') });
  const detach = async () => {
    try {
      if (!await state.detach(folder)) { reportFailure(); return; }
      toast({
        title: translate('projects.folders.detached', { path: folder.path, projectName }),
        duration: 8000,
        action: {
          label: translate('projects.folders.undo'),
          // The last folder can unmount this card. Undo must work independently of its hook state.
          onClick: () => { void restore(folder); },
        },
      });
    } catch { reportFailure(); }
  };
  const restore = async (detached: ProjectFolder) => {
    try {
      const result = await rpc.projects.attachProjectFolder(detached.projectId, detached.path);
      if (!result.success) throw new Error(result.error.message);
    } catch (error) { console.error(error);
      toast({ tier: 'error', title: messageForUser(error) });
    }
  };
  return (
    <ContextMenu onOpenChange={(open, details) => {
      if (open && (disabled || folder.offline)) details.cancel();
    }}>
      <ContextMenuTrigger render={children} />
      <ContextMenuContent onClick={(event) => event.stopPropagation()}>
        <ContextMenuItem disabled={disabled || folder.offline} onClick={() => { void detach(); }}>
          {translate('projects.folders.detach')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
