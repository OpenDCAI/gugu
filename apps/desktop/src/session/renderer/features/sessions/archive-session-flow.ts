import {
  canOfferDontAskAgain,
  shouldConfirm as shouldConfirmField,
  stopAsking,
} from '@renderer/features/settings/interface-confirm-preference';
import { leaveSessionView } from '@renderer/features/sessions/leave-session-view';
import { toast } from '@renderer/lib/hooks/use-toast';
import { showModal } from '@renderer/lib/modal/modal-provider';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { log } from '@renderer/utils/logger';
import type { ArchivedSessionRef } from '@shared/core/sessions/sessions';
import { tellChildrenNotReached } from './children-not-reached';
import { countSessionDescendants } from './session-descendants';
import { restoreArchivedSession } from './restore-session-flow';
import { sessionRegistry } from './stores/session-registry';

/** 「撤销」要留够看见并点到的时间;成功档 3s 是给瞥一眼的确认,不够。 */
const ARCHIVE_UNDO_DWELL_MS = 8000;

/**
 * 「归档任务」的唯一路径 —— spec session-graph。
 *
 * **一个动作,这几处入口**:会话列表行尾 hover 浮出的按钮、会话列表的右键那一格、会话页标题行 ⋯ 菜单、
 * 命令面板(Mod+Shift+E)、键盘导航连按两次 ⌃X、引擎丢失页的那颗按钮,以及手机(经会话页路由 `sessionTimeline.sessionUpdate`
 * 到主进程同一个 `archiveSession`)。owner 2026-09-11:「不管是右边的按钮还是右键里面的那个按钮,都是归档任务」。
 * 人这一侧收起会话只有归档(#6949,owner 2026-10-06「那就改」):删除入口已经全部换成这一条,与 agent 的
 * `session_archive` 同一个动作。
 * ❌ 各写一份脾气 —— 那一份迟早比别人少带一样东西(实测:侧栏那两个忘了带「离开视图」,于是归档掉当前
 * 打开的会话之后,右边永久停在「正在准备文件…」)。
 *
 * 入口的标签说「任务」,归属键是**会话**:用户心智里会话列表的一行就是一项任务,而产品动的是这条
 * conversation(#5413 的修法)。❌ 把标签改成「归档会话」—— 那是把实现的词汇端到用户面前。
 *
 * 范围由确认框里**一个勾选**说:「连同 N 条子会话一起归档」。子会话只有 spawn 出来的那种
 * ([[session-descendants]]);fork 与它的来源是平行同级,不在其中。
 */

/** 归档前问不问,由 `interface.confirmBeforeArchive` 说了算(出厂 = 问)。 */
function shouldConfirm(): boolean {
  return shouldConfirmField('confirmBeforeArchive');
}

function stopAskingBeforeArchive(): void {
  stopAsking('confirmBeforeArchive', {
    logTag: '[gugu-archive]',
    title: translateSessionMessage('task.archiveDontAskAgainFailed'),
    description: translateSessionMessage('task.archiveDontAskAgainFailedHint'),
  });
}

/**
 * 确认之后真正归档的那一步。自带确认形态的入口(键盘连按两次 ⌃X:两次按键就是确认)直接调它;
 * 其余入口经 `requestArchiveSession` 先问。
 *
 * fail-loud:每一条「归档没发生」的路径都要留下话,❌ 点了没反应。
 */
export function archiveSessionNow(args: { projectId: string; sessionId: string; withChildren: boolean }): void {
  const { projectId, sessionId, withChildren } = args;
  const manager = sessionRegistry.get(sessionId);
  if (!manager) {
    log.error('[gugu-archive] 会话未挂载,无法归档', { sessionId });
    return;
  }
  manager.archiveSession(sessionId, { withChildren }).then(
    ({ archived, unreached }) => {
      // 只在归档**真的成功**之后走 —— ❌ 把人送走再让这条会话在原处活着。
      leaveSessionView(projectId, sessionId);
      offerUndo(archived);
      tellChildrenNotReached(unreached);
    },
    (error: unknown) => {
      log.error('[gugu-archive] 归档会话失败', { sessionId, error: String(error) });
      toast({
        title: translateSessionMessage('task.archiveTaskFailed'),
        description: translateSessionMessage('task.archiveTaskFailedHint'),
        variant: 'destructive',
      });
    }
  );
}

/**
 * 归档要有去处(spec session-page-flows,#6083):提示里说得出「在会话历史里能找回」,并给**一次**「撤销」。
 * 撤销按主进程报回的清单原样放回 —— 点名的那条与勾了范围时一起收走的子会话,一条不多一条不少;
 * 走 [[restore-session-flow]] 那条唯一路径。❌ 渲染侧自己猜范围:子会话可能在别的机器上,这里数不全。
 */
function offerUndo(archived: ArchivedSessionRef[]): void {
  if (archived.length === 0) return;
  let undone = false;
  toast({
    title: translateSessionMessage('task.archivedToast'),
    description: translateSessionMessage('task.archivedToastHint'),
    duration: ARCHIVE_UNDO_DWELL_MS,
    action: {
      label: translateSessionMessage('task.archiveUndo'),
      onClick: () => {
        // 一次:提示还挂着时连点两下,第二下不该再跑一遍恢复。
        if (undone) return;
        undone = true;
        void undoArchive(archived);
      },
    },
  });
}

async function undoArchive(archived: ArchivedSessionRef[]): Promise<void> {
  try {
    for (const ref of archived) await restoreArchivedSession(ref);
  } catch (error) {
    // 撤销没成的话,东西还在归档里 —— 出路是会话历史,提示里指过去。
    log.error('[gugu-archive] 撤销归档失败', { archived, error: String(error) });
    toast({
      title: translateSessionMessage('task.archiveUndoFailed'),
      description: translateSessionMessage('task.archiveUndoFailedHint'),
      variant: 'destructive',
    });
  }
}

export function requestArchiveSession(args: { projectId: string; sessionId: string }): void {
  const { projectId, sessionId } = args;
  if (!sessionRegistry.get(sessionId)?.sessions.has(sessionId)) {
    log.error('[gugu-archive] 要归档的会话不在列表里', { sessionId });
    return;
  }
  // 子会话可能在别的机器上:名下有几条要全表数,否则这个勾选永远不出现。主进程的归档本来就按边跨机器收,
  // 别处的孩子由它们自己那张表收到归档事件后移行。
  const childCount = countSessionDescendants(sessionRegistry.allSessions(), sessionId);

  confirmArchive({
    childCount,
    proceed: (withChildren) => archiveSessionNow({ projectId, sessionId, withChildren }),
  });
}

/**
 * 归档前的那一问(含「不再询问」与子会话勾选)。本机会话与别的机器上的会话(#6264)共用这一问 ——
 * 同一个动作、同一条确认,只是「真的归档」那一步落在不同的地方。
 */
export function confirmArchive(args: {
  childCount: number;
  proceed: (withChildren: boolean) => void;
}): void {
  const { childCount, proceed } = args;
  // 确认被「不再询问」关掉时按**默认范围**走:一个不弹的确认不能替用户勾上递归。
  if (!shouldConfirm()) {
    proceed(false);
    return;
  }

  showModal('confirmActionModal', {
    title: translateSessionMessage('task.archiveTaskTitle'),
    description: translateSessionMessage('task.archiveSessionDescription'),
    confirmLabel: translateSessionMessage('task.archiveTaskConfirm'),
    variant: 'default',
    // 名下没有子会话时不摆这个勾选 —— 勾了也不改变结果的开关比没有更坏。
    scopeLabel:
      childCount > 1
        ? translateSessionMessage('task.archiveSessionWithChildren', { count: childCount })
        : childCount === 1
          ? translateSessionMessage('task.archiveSessionWithChildrenOne')
          : undefined,
    dontAskAgainLabel: canOfferDontAskAgain()
      ? translateSessionMessage('task.archiveDontAskAgain')
      : undefined,
    onSuccess: ({ dontAskAgain, scopeChecked }) => {
      // 先落偏好再归档:归档会把这一行从列表里收起、连带卸掉触发它的组件,顺序反过来就赌一个正在
      // 消失的调用栈还能把设置写完。
      if (dontAskAgain) stopAskingBeforeArchive();
      proceed(childCount > 0 && scopeChecked);
    },
  });
}
