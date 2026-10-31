// @@@task-web-host — 网页版的「使用现有文件夹」:桌面版走系统文件夹对话框,网页版没有(那是 Electron 的
// 原生对话框,无头宿主里只会静默取消)。这里给一个咕咕风格的小弹窗:零命名(项目名 = 文件夹名)、
// 一棵长在弹窗里的懒加载目录树(根 = 宿主家目录)、直接创建。
// ❌ 别接到旧的 AddProjectModal(Pick/New/Clone 页签 + 名称输入):那套已删。
import { useEffect, useState } from 'react';
import { DirectoryTree } from '@renderer/features/projects/components/add-project-modal/directory-browser/directory-tree';
import { normalizePath } from '@renderer/features/projects/components/add-project-modal/directory-browser/paths';
import { createProjectFromLocalFolder } from '@renderer/features/projects/components/create-project-from-local-folder';
import { rpc } from '@renderer/lib/ipc';
import { type BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { ConfirmButton } from '@renderer/lib/ui/confirm-button';
import { DialogContentArea, DialogFooter, DialogHeader, DialogTitle } from '@renderer/lib/ui/dialog';
import { ModalLayout } from '@renderer/lib/ui/modal-layout';
import { Spinner } from '@renderer/lib/ui/spinner';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { cn } from '@renderer/utils/utils';
import { basenameFromAnyPath } from '@shared/path-name';

export type LocalFolderProjectModalProps = BaseModalProps<string>;

type RootState = { status: 'loading' } | { status: 'ready'; path: string } | { status: 'error'; message: string };

export function LocalFolderProjectModal({ onClose, onSuccess }: LocalFolderProjectModalProps) {
  const { translate } = useSessionMessages();
  const [root, setRoot] = useState<RootState>({ status: 'loading' });
  const [path, setPath] = useState('');
  // null = 没选 / 还没探;false = 选中的目录不是 git 仓库(放行,给一句提示,❌ 替用户 init)。
  const [isGitRepo, setIsGitRepo] = useState<boolean | null>(null);
  const [submitState, setSubmitState] = useState<'idle' | 'creating'>('idle');
  const name = basenameFromAnyPath(path);
  const canSubmit = path.trim().length > 0 && !!name && submitState === 'idle';

  // 树从宿主的家目录长起:从 / 开始翻没意义。
  useEffect(() => {
    let cancelled = false;
    rpc.app
      .getHomeDirectory()
      .then((home) => {
        if (cancelled) return;
        if (!home) throw new Error(translate('projects.dirTree.homeUnavailable'));
        setRoot({ status: 'ready', path: normalizePath(home) });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setRoot({ status: 'error', message: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      cancelled = true;
    };
    // translate 的身份随语言变,家目录不随语言变。
  }, []);

  useEffect(() => {
    setIsGitRepo(null);
    if (!path) return;
    let cancelled = false;
    rpc.projects
      .inspectProjectPath({ type: 'local', path })
      .then((status) => {
        if (!cancelled && status.isDirectory) setIsGitRepo(status.isGitRepo);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [path]);

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitState('creating');
    const projectId = await createProjectFromLocalFolder(path, translate);
    setSubmitState('idle');
    if (!projectId) return;
    onClose();
    onSuccess(projectId);
  };

  return (
    <ModalLayout
      header={
        <DialogHeader showCloseButton={submitState === 'idle'}>
          <DialogTitle>{translate('projects.create.pickFolderTitle')}</DialogTitle>
        </DialogHeader>
      }
      footer={
        <DialogFooter className="items-center gap-3">
          <p
            className={cn(
              'min-w-0 flex-1 truncate font-mono text-xs',
              path ? 'text-foreground' : 'text-foreground-muted'
            )}
            title={path || undefined}
          >
            {path || translate('projects.remoteDir.selectDirectory')}
          </p>
          <ConfirmButton type="button" onClick={() => void handleSubmit()} disabled={!canSubmit}>
            {translate(submitState === 'creating' ? 'projects.create.creating' : 'projects.remoteDir.useThis')}
          </ConfirmButton>
        </DialogFooter>
      }
    >
      <DialogContentArea data-autofocus tabIndex={-1} className="gap-2">
        <p className="text-sm text-foreground-muted">{translate('projects.create.pickFolderMessage')}</p>
        <div className="h-[320px] overflow-y-auto rounded-md border border-border p-1">
          {root.status === 'loading' && (
            <div role="status" className="flex h-full items-center justify-center">
              <span className="sr-only">{translate('projects.remoteDir.loading')}</span>
              <Spinner className="text-foreground-muted" />
            </div>
          )}
          {root.status === 'error' && (
            <div className="flex h-full items-center justify-center px-6 text-center text-sm text-foreground-destructive">
              {root.message}
            </div>
          )}
          {root.status === 'ready' && (
            <DirectoryTree
              key={root.path}
              rootPath={root.path}
              value={path}
              onChange={setPath}
            />
          )}
        </div>
        {isGitRepo === false && (
          <p className="text-xs text-foreground-muted">{translate('projects.dirTree.notAGitRepo')}</p>
        )}
      </DialogContentArea>
    </ModalLayout>
  );
}
