import { observer } from 'mobx-react-lite';
import { useContext, useEffect, useRef, useState, type ReactNode } from 'react';
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
import { machineLinkState, onMachineReconnected } from '@renderer/lib/machine-clients';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { log } from '@renderer/utils/logger';
import { createSessionCommandProvider } from './commands';
import { SessionMainPanel } from './main-panel';
import { SessionTitlebar } from './session-titlebar';

/** 到那台机器的线从断变通了几次(本机 = 0):让「线通了再准备」那一下重算。 */
function useLinkOpenings(machine: string | null): number {
  const [openings, setOpenings] = useState(0);
  useEffect(() => (machine ? onMachineReconnected(machine, () => setOpenings((count) => count + 1)) : undefined), [machine]);
  return openings;
}

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
  // 别的机器上的会话还看那台机器的线:线没通不准备(准备了也只会失败);准备失败在线没通的那一下的(开机恢复时线刚通
  // 又断),线**从断变通**的那一下再准备一次 —— 只在那一下,❌ 循环重试。本机会话 machine 为空,照旧。
  const machine = machineRegistry.machineOf(projectId);
  const linkOpenings = useLinkOpenings(machine);
  const retriedAtOpening = useRef(0);
  useEffect(() => {
    if (!shown || (machine && machineLinkState(machine) !== 'open')) return;
    if (kind !== 'idle' && kind !== 'provision-error') return;
    // 失败了只等下一次「线从断变通」:这一回合线里已经准备过一次的,❌ 再来。
    if (kind === 'provision-error' && linkOpenings <= retriedAtOpening.current) return;
    retriedAtOpening.current = linkOpenings;

    getSessionManagerStore(projectId)
      ?.provisionSession(sessionId)
      .catch(() => {});
  }, [kind, shown, projectId, sessionId, sessionPageStore, machine, linkOpenings]);

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
