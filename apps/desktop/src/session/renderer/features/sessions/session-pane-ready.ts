import { asProvisioned, getSessionManagerStore, getSessionPageStore, sessionViewKind } from './stores/session-selectors';
import { getProjectManagerStore } from '@renderer/features/projects/stores/project-selectors';

/**
 * 宿主要开的这条会话,它的面板就绪了没有 —— 三个打开入口(文件 / App 页签 / 网页)等的是同一件事。
 * 等之前先请它准备:renderer 重载后每条会话都回到「没准备」,只有屏上那一条会被 view.tsx 准备,
 * 后台会话的面板永远等不来,请求等满期限超时(#6040)。调的就是 view.tsx 那一处 provisionSession,
 * 宿主已挂着的会话走它的快路径;已准备的、正在准备的它自己直接返回。只准备,不导航、不切焦点。
 */
export function sessionPaneReady(projectId: string, sessionId: string): () => boolean {
  void getProjectManagerStore()
    .mountProject(projectId)
    .then(() => {
      if (sessionViewKind(getSessionPageStore(projectId, sessionId), projectId) === 'archived') return;
      return getSessionManagerStore(projectId)?.provisionSession(sessionId);
    })
    .catch(() => {});
  return () => Boolean(asProvisioned(getSessionPageStore(projectId, sessionId))?.viewModel);
}

