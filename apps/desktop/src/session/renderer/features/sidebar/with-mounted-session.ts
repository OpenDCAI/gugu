// 人在一条会话上动手(置顶 / 归档 / 改名,点的和键盘的同一条路):它的项目还没挂就先挂上再做。
// 别的机器上的项目列出时 ❌ 挂(行来自会话目录),所以这一步是动手前唯一要补的。
import { getProjectManagerStore } from '@renderer/features/projects/stores/project-selectors';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { sessionRegistry } from '@renderer/features/sessions/stores/session-registry';
import { machineUnavailableLabel } from '@renderer/features/sessions/machine-unavailable-label';
import { toast } from '@renderer/lib/hooks/use-toast';
import { machineLinkState, subscribeMachineLink } from '@renderer/lib/machine-clients';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { log } from '@renderer/utils/logger';

type PageSessions = NonNullable<ReturnType<typeof sessionRegistry.get>>;
type ListedSession = NonNullable<ReturnType<PageSessions['sessions']['get']>>;

function listed(sessionId: string): { session: ListedSession; manager: PageSessions } | null {
  const manager = sessionRegistry.get(sessionId);
  const session = manager?.sessions.get(sessionId);
  return manager && session ? { session, manager } : null;
}

/**
 * 挂好了就当场做。「连没连上」与侧栏那颗点同一个判据(machineLinkState):
 * - open:挂上再做;
 * - connecting:等它连上再挂,但只等这一回 —— 等的中途变成别的(断了 / 太旧 / 不可用)就当场说「没连上」、放弃这次动作,
 *   ❌ 留着排队(否则几分钟、几小时后机器连上时,确认框会突然弹出来);
 * - closed / tooOld / unavailable:当场说「没连上」。
 * 挂的结果逐样说:项目没挂上(openProject 没成 / 挂的时候线断了)、会话列表没读成 = 「准备失败」或「没连上」;
 * 挂上了、列表也读完了还找不到这条,才是「那台机器上已经没有这条」。
 * 只给人的动作用:会话页要画一条会话时等它的机器连上(主区有加载态,看得见在等),那条路不走这里。
 */
export function withMountedSession(
  projectId: string,
  sessionId: string,
  run: (session: ListedSession, manager: PageSessions) => void
): void {
  const now = listed(sessionId);
  if (now) return run(now.session, now.manager);
  const machine = machineRegistry.machineOf(projectId);
  const device = machine ? (remoteHostsStore.device(machine)?.label ?? machine) : '';
  const say = (key: string): void => {
    toast({ title: translateSessionMessage(key, { device }), variant: 'destructive' });
  };
  const offline = (): void => {
    toast({ title: machineUnavailableLabel(projectId)
      ?? translateSessionMessage('remoteHost.status.offlineNever', { device }), variant: 'destructive' });
  };

  const mountThenRun = () => {
    void getProjectManagerStore()
      .ensureMounted(projectId)
      .then(
        () => {
          const found = listed(sessionId);
          if (found) return run(found.session, found.manager);
          const project = getProjectManagerStore().projects.get(projectId);
          const listState = project?.mountedProject?.sessionManager.listState;
          if (listState === 'read') {
            log.warn('A listed session is not in its mounted project', { projectId, sessionId });
            return say('task.remoteActionMissing');
          }
          // 没挂上 / 列表没读成:线断了就说没连上,否则说准备失败(原因各自已进日志)。
          log.warn('Mount did not complete for a listed session', { projectId, sessionId, listState, mounted: Boolean(project?.mountedProject) });
          if (machine && machineLinkState(machine) !== 'open') return offline();
          say('task.setUpWorkspaceFailed');
        },
        (error: unknown) => {
          log.error('Failed to mount the project of a listed session', { projectId, sessionId, error });
          if (machine && machineLinkState(machine) !== 'open') return offline();
          say('task.setUpWorkspaceFailed');
        }
      );
  };

  if (!machine) return mountThenRun();
  const link = machineLinkState(machine);
  if (link === 'open') return mountThenRun();
  if (link !== 'connecting') return offline();
  const off = subscribeMachineLink(machine, () => {
    const next = machineLinkState(machine);
    if (next === 'connecting') return;
    off();
    if (next === 'open') mountThenRun();
    else offline();
  });
}
