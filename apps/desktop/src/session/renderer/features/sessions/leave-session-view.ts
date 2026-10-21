import { isImplicitSessionHomeProject } from '@renderer/features/sessions/session-home-project-constants';
import { forgetSessionOnScreen } from '@renderer/app/screen-layout-actions';
import { appState } from '@renderer/lib/stores/app-state';

/**
 * 一项 task 从会话列表里消失之后(删除 / 归档),不能把人留在它的视图上。删除留下的是一块谁也点不到
 * 的空白;归档更糟 —— 归档后的 task 停在 unprovisioned/idle,而自动 provision 明确跳过归档任务
 * (`view.tsx`),于是任务视图永远画着「正在准备文件…」的转圈,没有尽头(owner 2026-09-06 实机:
 * 侧栏归档掉当前打开的那条会话,右边就此转到天荒地老)。路由守卫只在下一次导航时才跑,救不了原地不动
 * 的这一次,所以让人离开是动作自己的责任。
 *
 * 只在**当前正看着这项 task** 时才动:侧栏归档的可能是别人那一行,那时把人从手上的任务里踢走才是 bug。
 *
 * 独立任务住在 app 自己的 task-home 项目里,用户从没见过它(spec session-page 任务分区)—— 落到它的项目
 * 主页会把这个隐藏项目变成一个真实目的地,而从那里新建的任务在侧栏里是隐形的。
 */
export function leaveSessionView(projectId: string, sessionId: string): void {
  // 摆在屏上某一块里(spec session-page「一屏几块」):那块收掉。屏上还有别的块,导航已跟到那块,下面就不用走;
  // 它是唯一一块,才照旧离开会话页。
  forgetSessionOnScreen(sessionId);
  const nav = appState.navigation;
  const current = nav.viewParamsStore['session'] as { sessionId?: string } | undefined;
  if (nav.currentViewId !== 'session' || current?.sessionId !== sessionId) return;
  const destination = sessionLeaveDestination(projectId);
  if (destination.viewId === 'new-session') nav.navigate('new-session');
  else nav.navigate('project', destination.params);
}

/**
 * 「退到哪」只此一处。走人动作(归档 / 删除)和路由守卫都问它 —— 两边各写一份的下场就是其中一边
 * 忘了隐藏的 task-home 项目,把人送进一个用户从没见过的项目主页。
 */
export function sessionLeaveDestination(
  projectId: string
):
  | { viewId: 'new-session'; params?: undefined }
  | { viewId: 'project'; params: { projectId: string } } {
  return isImplicitSessionHomeProject({ id: projectId })
    ? { viewId: 'new-session' }
    : { viewId: 'project', params: { projectId } };
}
