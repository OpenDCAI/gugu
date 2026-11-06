import { Button } from '@renderer/lib/ui/button';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { openPathWithFailureToast } from '../stores/open-file-in-file-editor';

type FileWorkspace = { projectId: string; workspaceId: string };

/** 这台电脑上的文件交给系统默认程序。画不出来的文件不能是死路(#7191);新建任务的草稿文件面板也用这一个。 */
export function OpenWithSystemButton({ absolutePath, workspace }: { absolutePath: string; workspace?: FileWorkspace }) {
  const { translate } = useSessionMessages();
  return (
    <Button size="sm" variant="outline" className="mt-4" onClick={() => void openPathWithFailureToast(absolutePath, workspace)}>
      {translate('file.openWithSystem')}
    </Button>
  );
}
