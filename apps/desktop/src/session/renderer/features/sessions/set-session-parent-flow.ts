import { messageForUser } from '@/lib/userFacingError';
import { runInAction } from 'mobx';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpcOn } from '@renderer/lib/ipc';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { sidebarStore } from '@renderer/lib/stores/app-state';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { log } from '@renderer/utils/logger';
import { SESSION_PARENT_CYCLE } from '@shared/core/sessions/sessions';

/** 「撤销」要留够看见并点到的时间(同归档那一条)。 */
const NEST_UNDO_DWELL_MS = 8000;

type SessionRef = { projectId: string; sessionId: string; title: string };

/**
 * 改一条会话挂在谁下面(null = 回到根)—— 与 agent 的 `session_set_parent` 是**同一个动作**:主进程
 * `setSessionParent`(session-family.ts)校验父会话在不在、成不成环,落库,再发 sessionChanged 让侧栏与手机重画。
 * 在 child 所在的机器上做(agent 那边由宿主按 child 的地址转过去);❌ 交给 `rpc` 按参数选线 —— 父会话在别的机器上时
 * 它会把这一步发到父会话那台,那里没有 child。
 */
function setSessionParent(child: { projectId: string; sessionId: string }, parentSessionId: string | null) {
  return rpcOn(machineRegistry.machineOf(child.projectId)).sessions.setSessionParent(child.sessionId, parentSessionId);
}

/**
 * 人在侧栏挪一条会话(spec session-page「把会话拖成 child」):拖到另一条会话的行上 = 挂到它下面(`parent`),
 * 拖回它自己那一行(项目行 /「任务」分区头)= 回到根(`parent` = null)。
 * 挂上去时父会话那一行展开,这条当场看得见;提示里给一次「撤销」= 挂回原来那里(`previousParentId`,原来是根就回到根)。
 * fail-loud:没挪成就说出来(见 nestFailed),❌ 松手没反应。
 */
export function moveSessionUnder(child: SessionRef, parent: SessionRef | null, previousParentId: string | null): void {
  setSessionParent(child, parent?.sessionId ?? null).then(
    ({ not_reached }) => {
      if (parent) runInAction(() => sidebarStore.expandedSessionIds.add(parent.sessionId));
      let undone = false;
      toast({
        title: parent
          ? translateSessionMessage('sidebar.nestedUnder', { child: child.title, parent: parent.title })
          : translateSessionMessage('sidebar.nestedAtTop', { child: child.title }),
        // 往上查环时有机器没够着:挂是挂上了,但那几台上的会话没查到 —— 照实说。
        description: not_reached.length
          ? translateSessionMessage('sidebar.nestNotReached', { machines: not_reached.join(', ') })
          : undefined,
        duration: NEST_UNDO_DWELL_MS,
        action: {
          label: translateSessionMessage('task.archiveUndo'),
          onClick: () => {
            if (undone) return;
            undone = true;
            setSessionParent(child, previousParentId).catch((error: unknown) => nestFailed(child, null, error));
          },
        },
      });
    },
    (error: unknown) => nestFailed(child, parent, error)
  );
}

/**
 * 没挪成:主进程的原话进日志,提示里说清是哪一种。落点挡掉了自己、已挂在这、侧栏看得见的成环;还剩两种 ——
 * 成环隔着侧栏看不见的已归档会话(主进程沿整张图走,以 SESSION_PARENT_CYCLE 拒),或者够不着:父会话或 child
 * 所在的机器此刻不在线。
 */
function nestFailed(child: SessionRef, parent: SessionRef | null, error: unknown): void {
  log.error('[gugu-nest] 改父会话失败', { sessionId: child.sessionId, error: String(error) });
  const cycle = parent !== null && String(error).includes(SESSION_PARENT_CYCLE);
  toast({
    title: translateSessionMessage('sidebar.nestFailed', { child: child.title }),
    description: messageForUser(cycle
      ? translateSessionMessage('sidebar.nestCycleHint', { parent: parent.title })
      : error),
    variant: 'destructive',
  });
}
