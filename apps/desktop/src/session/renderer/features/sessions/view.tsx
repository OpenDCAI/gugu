import { observer } from 'mobx-react-lite';
import { useContext, useEffect, type ReactNode } from 'react';
import { PageShownContext } from '@renderer/app/recent-session-pages';
import type { ViewDefinition } from '@renderer/app/view-registry';
import {
  getSessionManagerStore,
  getSessionPageStore,
  sessionViewKind,
} from '@renderer/features/sessions/stores/session-selectors';
import { leaveSessionView } from '@renderer/features/sessions/leave-session-view';
import { sessionViewCanActivate } from '@renderer/features/sessions/session-view-guard';
import { SessionViewWrapper } from '@renderer/features/sessions/session-view-context';
import { log } from '@renderer/utils/logger';
import { createSessionCommandProvider } from './commands';
import { SessionMainPanel } from './main-panel';
import { SessionTitlebar } from './session-titlebar';

const SessionViewWrapperWithProviders = observer(function SessionViewWrapperWithProviders({
  children,
  projectId,
  sessionId: sessionId,
}: {
  children: ReactNode;
  projectId: string;
  sessionId: string;
}) {
  const sessionPageStore = getSessionPageStore(projectId, sessionId);
  const kind = sessionViewKind(sessionPageStore, projectId);

  // Auto-provision when the task view is rendered with an idle task — covers
  // session restore, direct navigation,
  // and any other path that lands on the task view before provisioning runs.
  // 归档任务不在这里:`sessionViewKind` 先把它判成 'archived',永远到不了 'idle'。判据只留那一处 ——
  // 两处各判一次,改动一处就会让归档任务又被自动 provision 回来。
  // Only the page on screen provisions: idle reclaim stops a session nobody is looking at, and a retained
  // page that is hidden must not start it again (@@@retained-session-pages); it provisions when shown.
  const shown = useContext(PageShownContext);
  useEffect(() => {
    if (kind !== 'idle' || !shown) return;

    getSessionManagerStore(projectId)
      ?.provisionSession(sessionId)
      .catch(() => {});
  }, [kind, shown, projectId, sessionId, sessionPageStore]);

  // 绊线,不是主力。挡住归档任务有两道正经关口:归档动作自己把人送走(archive-task-flow),路由守卫
  // 判它不是目的地(session-view-guard,冷启动那次由 project-manager 在任务加载完后补跑)。两道都过了
  // 还站在这儿,说明我们**又漏了一条路** —— 所以这里记一条 warn 留线索,再把人送走兜底。
  //
  // ❌ 给这个状态配一块「这项任务已归档」的产品屏:按设计人根本不该抵达,配了 UI 就等于把「我们漏了
  // 一条路」化装成正常产品状态,下次再漏更难发现。日志是给我们的,用户什么都不该看见。
  useEffect(() => {
    if (kind !== 'archived') return;

    log.warn('[gugu-session] 停在了已归档的会话视图上,自动退回', { projectId, sessionId });
    leaveSessionView(projectId, sessionId);
  }, [kind, projectId, sessionId]);

  if (kind !== 'ready') {
    return (
      <SessionViewWrapper projectId={projectId} sessionId={sessionId}>
        {children}
      </SessionViewWrapper>
    );
  }

  return (
    <SessionViewWrapper projectId={projectId} sessionId={sessionId}>
      {children}
    </SessionViewWrapper>
  );
});

export const sessionView = {
  WrapView: SessionViewWrapperWithProviders,
  TitlebarSlot: SessionTitlebar,
  MainPanel: SessionMainPanel,
  commandProvider: ({ projectId, sessionId }: { projectId: string; sessionId: string }) =>
    createSessionCommandProvider(projectId, sessionId),
  canActivate: sessionViewCanActivate,
} satisfies ViewDefinition<{ projectId: string; sessionId: string }>;
