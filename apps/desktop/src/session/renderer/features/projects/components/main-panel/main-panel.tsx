import { ShieldAlert, TriangleAlert } from '@/lib/icons'
import { isMacHost } from '@shared/host-os';
import { observer } from 'mobx-react-lite';
import { useConfirmDeleteProject } from '@renderer/features/projects/hooks/use-confirm-delete-project';
import { rpc } from '@renderer/lib/ipc';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { isUnregisteredProject } from '../../stores/project';
import {
  getProjectManagerStore,
  getProjectStore,
  projectDisplayName,
  projectViewKind,
  unmountedMountErrorMessage,
} from '../../stores/project-selectors';
import { ProjectHome } from './project-home';
import { PendingProjectStatus } from './pending-project';

/** 项目块里的内容(gugu-dev#181:项目是一块):按项目此刻的状态画首页、建立中、或读不到的原因。 */
export const ProjectMainPanel = observer(function ProjectMainPanel({ projectId }: { projectId: string }) {
  const { translate } = useSessionMessages();
  const store = getProjectStore(projectId);
  const kind = projectViewKind(store);
  const displayName = projectDisplayName(store) ?? translate('projects.fallbackName');

  if (kind === 'creating' && store && isUnregisteredProject(store)) {
    return <PendingProjectStatus project={store} />;
  }

  // gugu #2328: bootstrapping 直接渲染项目首页(乐观上屏)——远程项目挂载是网络物理耗时,
  // 页面不等它;发送等控件由 mounted 态渐进解锁,❌ 整页 Setting up 转圈。
  if (kind === 'bootstrapping') {
    return <ProjectHome projectId={projectId} />;
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

  return <ProjectHome projectId={projectId} />;
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
