import type { Result } from '@gugu/session-shared';
import { events } from '@main/lib/events';
import type {
  BindProjectToGroupResult,
  ProjectGroupBinding,
  ProjectGroupError,
} from '@shared/core/projects/project-groups';
import { projectGroupBindingChangedChannel } from '@shared/core/projects/projectEvents';

/**
 * #7341 第二步:项目的跨设备身份 = 它的项目群(product spec)。「项目 → 群」对照、登录态、名册、云端建群 /
 * 加 agent 全住在宿主这一侧(electron/sessionpage/sessionpage-project-group-binding.ts);会话页这一侧只有项目与会话的事实。
 * 所以由宿主把实现接上来,与 `setAgentSessionHost` / `setOtherMachines` 同一个做法 —— ❌ 在会话页树里 import 宿主模块
 * 去写那份对照(它的写队列是模块级状态,写口只能有一个)。
 */

/** 会话页库里这个本地项目的事实,交给宿主去对照 / 建群 / 搬 agent。 */
export type ProjectGroupSubject = {
  projectId: string;
  projectName: string;
  /** 这个项目里没归档的会话(它们的 agent 就是「这个项目的 agent」)。 */
  sessionIds: string[];
};

/** 宿主做完之后多带一格:有没有真的改了什么(改了才发 projectGroupBindingChangedChannel)。 */
type Changed = { changed: boolean };

export interface ProjectGroupHost {
  /** 这些本地项目里,在这台机器、当前账号名下绑了群的那些。 */
  listBindings(projectIds: readonly string[]): Promise<Result<ProjectGroupBinding[], ProjectGroupError>>;
  ensureGroup(project: ProjectGroupSubject): Promise<Result<{ chatId: string } & Changed, ProjectGroupError>>;
  bindToGroup(
    project: ProjectGroupSubject,
    chatId: string,
    expectedChatId?: string | null
  ): Promise<Result<BindProjectToGroupResult & Changed, ProjectGroupError>>;
  unbind(project: ProjectGroupSubject): Promise<Result<Changed & { expectedChatId?: string | null }, ProjectGroupError>>;
}

let host: ProjectGroupHost | null = null;

export function setProjectGroupHost(next: ProjectGroupHost | null): void {
  host = next;
}

/** 宿主还没接上(启动早期、或这个宿主没有身份那一层)是传输层的事,不是项目的结果 ⇒ 抛,❌ 编成一个空列表。 */
export function projectGroupHost(): ProjectGroupHost {
  if (!host) {
    throw Object.assign(new Error('项目群:这台机器的咕咕宿主还没接上(稍后再试)'), { code: 'host_not_ready' });
  }
  return host;
}

/**
 * 「项目 → 群」对照变了 ⇒ 渲染层重读 `projects.listProjectGroupBindings()`。宿主那边对照文件的唯一写口每写一次就经桥叫它一次
 * (新会话建了群、回收器忘了一条);这一侧的四个操作改了东西也叫。同一次改动可能叫两遍 —— 重读是幂等的。
 */
export function notifyProjectGroupBindingChanged(projectId: string): void {
  events.emit(projectGroupBindingChangedChannel, { projectId });
}
