import { observable, runInAction, when } from 'mobx';
import { messageForUser } from '@/lib/userFacingError';
import { asProvisioned, getSessionManagerStore, getSessionPageStore, sessionViewKind, sessionErrorMessage, projectMountErrorMessage } from './stores/session-selectors';
import { getProjectManagerStore } from '@renderer/features/projects/stores/project-selectors';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { machineUnavailableLabel } from './machine-unavailable-label';

/**
 * 宿主要开的这条会话,它的面板就绪了没有 —— 三个打开入口(文件 / App 页签 / 网页)等的是同一件事。
 * 等之前先请它准备:renderer 重载后每条会话都回到「没准备」,只有屏上那一条会被 view.tsx 准备,
 * 后台会话的面板永远等不来,请求等满期限超时(#6040)。调的就是 view.tsx 那一处 provisionSession,
 * 宿主已挂着的会话走它的快路径;已准备的、正在准备的它自己直接返回。只准备,不导航、不切焦点。
 * `reviveArchived: false`:打开任务块时不把归档的任务准备回来,由等待出口立即报不可打开;打开文件照旧准备。
 */
export function sessionPaneReady(projectId: string, sessionId: string, { reviveArchived = true } = {}): () => boolean {
  void prepareSessionPane(projectId, sessionId, { reviveArchived }).catch(() => {});
  return () => Boolean(asProvisioned(getSessionPageStore(projectId, sessionId))?.viewModel);
}

/** Prepare the pane without navigation or a timed event acknowledgement. */
export async function prepareSessionPane(projectId: string, sessionId: string, { reviveArchived = true } = {}): Promise<void> {
  await getProjectManagerStore().mountProject(projectId);
  if (!reviveArchived && sessionViewKind(getSessionPageStore(projectId, sessionId), projectId) === 'archived') return;
  await getSessionManagerStore(projectId)?.provisionSession(sessionId);
}

/** Session opens and forks share the preparation state; transport owns its own RPC deadline. */
export function whenSessionPaneReady(
  projectId: string,
  sessionId: string,
  onReady: () => void,
  options: {
    /** true: open; false: unavailable; string: failure; undefined: an active load is still pending. */
    canOpen?: () => boolean | string | undefined;
    onError: (reason: string) => void;
    reviveArchived?: boolean;
  },
): () => void {
  const rejected = observable.box<string | null>(null);
  let disposed = false;
  void prepareSessionPane(projectId, sessionId, { reviveArchived: options.reviveArchived ?? false }).catch(error => {
    if (!disposed) runInAction(() => rejected.set(messageForUser(error)));
  });
  const reason = () => {
    if (rejected.get()) return rejected.get();
    const page = getSessionPageStore(projectId, sessionId);
    const kind = sessionViewKind(page, projectId);
    if (kind === 'archived') return translateSessionMessage('task.archivedToast');
    if (kind === 'missing') return translateSessionMessage('task.notFound');
    if (kind === 'project-error') return projectMountErrorMessage(projectId, translateSessionMessage);
    const failure = sessionErrorMessage(page, translateSessionMessage) ?? machineUnavailableLabel(projectId);
    if (failure) return failure;
    if (asProvisioned(page)?.viewModel && options.canOpen) {
      const openable = options.canOpen();
      if (openable === false) return translateSessionMessage('sidebar.workspaceNotReady');
      if (typeof openable === 'string') return openable;
    }
    return null;
  };
  const cancel = when(
    () => Boolean(reason() || (asProvisioned(getSessionPageStore(projectId, sessionId))?.viewModel && (!options.canOpen || options.canOpen() === true))),
    () => {
      const failure = reason();
      disposed = true;
      if (failure) options.onError(failure);
      else onReady();
    },
  );
  return () => { disposed = true; cancel(); };
}
