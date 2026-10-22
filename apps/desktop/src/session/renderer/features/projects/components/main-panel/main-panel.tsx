import { ShieldAlert, TriangleAlert } from '@/lib/icons'
import { isMacHost } from '@shared/host-os';
import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import { useConfirmDeleteProject } from '@renderer/features/projects/hooks/use-confirm-delete-project';
import { useParams } from '@renderer/lib/layout/navigation-provider';
import { rpc } from '@renderer/lib/ipc';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { log } from '@renderer/utils/logger';
import { isUnregisteredProject } from '../../stores/project';
import {
  getProjectManagerStore,
  getProjectStore,
  projectDisplayName,
  projectViewKind,
  unmountedMountErrorMessage,
} from '../../stores/project-selectors';
import { ActiveProject } from './active-project';
import { PendingProjectStatus } from './pending-project';

export const ProjectMainPanel = observer(function ProjectMainPanel() {
  const {
    params: { projectId },
  } = useParams('project');
  const { translate } = useSessionMessages();
  const store = getProjectStore(projectId);
  const kind = projectViewKind(store);
  const displayName = projectDisplayName(store) ?? translate('projects.fallbackName');

  // 打开项目首页 = 要用这个项目了:还没挂上(别的机器上的项目列出时不挂)就经挂载的唯一入口挂上它,
  // 那台机器此刻连不上就等它连上再挂。挂过失败的不在这里重试:那是错误面板上的「重试」。
  useEffect(() => {
    if (kind !== 'idle_unmounted') return;
    void getProjectManagerStore()
      .ensureMounted(projectId)
      .catch((error: unknown) => log.warn('[project-page] 挂载项目失败', { projectId, error }));
  }, [projectId, kind]);

  if (kind === 'creating' && store && isUnregisteredProject(store)) {
    return <PendingProjectStatus project={store} />;
  }

  // 首页不等挂载(product spec「项目」:项目不属于任何一台机器,机器离线时它的文件夹照样列着、标离线):
  // 挂载中(gugu #2328 乐观上屏,远程挂载是网络物理耗时)和还没挂上(那台机器没连上)都直接画首页 ——
  // 文件夹卡列上次读到的、标离线,输入框说那台机器此刻用不了。❌ 空白一页、❌ 整页 Setting up 转圈。
  if (kind === 'bootstrapping' || kind === 'idle_unmounted') {
    return <ActiveProject />;
  }

  if (kind === 'path_not_found') {
    return (
      <ProjectPathNotFoundPanel
        path={store?.error ?? ''}
        projectId={projectId}
        title={displayName}
      />
    );
  }

  if (kind === 'permission_blocked') {
    return <ProjectPathAccessBlockedPanel path={store?.error ?? ''} projectId={projectId} />;
  }

  if (kind === 'mount_error') {
    return (
      <ProjectBootstrapErrorPanel
        message={unmountedMountErrorMessage(store, translate)}
        projectId={projectId}
      />
    );
  }

  if (kind !== 'ready') {
    return <div className="flex flex-1 items-center justify-center text-foreground-muted" />;
  }

  return <ActiveProject />;
});

function ProjectBootstrapErrorPanel({
  message,
  projectId,
}: {
  message: string;
  projectId: string;
}) {
  const { translate } = useSessionMessages();
  return (
    <div className="flex h-full w-full flex-col items-center justify-center p-8">
      <div className="flex max-w-xs flex-col items-center gap-2 text-center">
        <p className="font-sans text-sm font-medium text-foreground-destructive">
          {translate('projects.error.setupFailed')}
        </p>
        <p className="font-sans text-xs text-foreground-passive">{message}</p>
        <RetryMountButton projectId={projectId} />
      </div>
    </div>
  );
}

/**
 * 挂载失败常常是暂时的(权限刚授予、网络盘刚醒),所以面板必须给得出一个恢复动作 ——
 * 在此之前唯一的出路是重启 app(gugu #3611)。mountProject 自己会去重、会把 phase
 * 拨回 opening,这里不需要另外的状态机。
 */
function RetryMountButton({ projectId }: { projectId: string }) {
  const { translate } = useSessionMessages();
  return (
    <button
      type="button"
      className="text-xs text-foreground underline underline-offset-2 transition-colors hover:text-foreground/80"
      onClick={() => {
        void getProjectManagerStore().mountProject(projectId);
      }}
    >
      {translate('projects.error.retry')}
    </button>
  );
}

/**
 * 目录在,但读不动 —— macOS 上典型是 TCC 授权还没给。与其让用户对着一句 20s 后才出现、
 * 且与真实原因无关的 timeout 干瞪眼,不如指出是权限、把设置面板和重试都递到手上。
 */
function ProjectPathAccessBlockedPanel({
  path,
  projectId,
}: {
  path: string;
  projectId: string;
}) {
  const { translate } = useSessionMessages();
  const isMac = isMacHost();

  return (
    <div className="flex h-full w-full flex-col items-center justify-center p-8">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <ShieldAlert className="h-6 w-6 text-foreground-warning" />
        <p className="font-sans text-sm font-medium text-foreground">
          {translate('projects.accessBlocked.title')}
        </p>
        {path && <p className="font-mono text-xs break-all text-foreground-passive">{path}</p>}
        <p className="text-xs text-foreground-passive">
          {translate('projects.accessBlocked.detail')}
        </p>
        <div className="mt-1 flex items-center gap-4">
          {isMac && (
            <button
              type="button"
              className="text-xs text-foreground underline underline-offset-2 transition-colors hover:text-foreground/80"
              onClick={() => {
                void rpc.app.openFileAccessSettings();
              }}
            >
              {translate('projects.accessBlocked.openSettings')}
            </button>
          )}
          <RetryMountButton projectId={projectId} />
        </div>
      </div>
    </div>
  );
}

function ProjectPathNotFoundPanel({
  path,
  projectId,
  title,
}: {
  path: string;
  projectId: string;
  title: string;
}) {
  const { translate } = useSessionMessages();
  const confirmDeleteProject = useConfirmDeleteProject();

  return (
    <div className="flex h-full w-full flex-col items-center justify-center p-8">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <TriangleAlert className="h-6 w-6 text-foreground-destructive" />
        <p className="font-sans text-sm font-medium text-foreground-destructive">
          {translate('projects.notFound.title')}
        </p>
        {path && <p className="font-mono text-xs break-all text-foreground-passive">{path}</p>}
        <p className="text-xs text-foreground-passive">{translate('projects.notFound.detail')}</p>
        <button
          type="button"
          className="mt-2 text-xs text-foreground-destructive underline underline-offset-2 transition-colors hover:text-foreground-destructive/80"
          onClick={() => {
            void confirmDeleteProject({ projectId, projectLabel: title });
          }}
        >
          {translate('projects.titlebar.remove')}
        </button>
      </div>
    </div>
  );
}
