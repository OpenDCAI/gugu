/**
 * 项目跨设备(product spec,#7341 第二步):项目的跨设备身份就是它的项目群。
 *
 * 每台机器各有自己的本地项目(id 各不相同 —— 渲染层按 id 认机器,❌ 让两台机器共用一个项目 id),
 * 绑在同一个群上的本地项目 = 同一个项目。绑定记在每台机器自己的「本地项目 → 项目群」对照里。
 */
export type ProjectGroupBinding = {
  /** 这台机器上的本地项目 id。 */
  projectId: string;
  /** 它绑的项目群。 */
  chatId: string;
};

export type ProjectGroupError =
  | { type: 'not-found'; message: string }
  /** 这台机器上没有登录的咕咕账号(读不到 / 写不了对照)。 */
  | { type: 'not-signed-in'; message: string }
  /**
   * 那个群不能用:已归档、不是群、当前账号不是它的成员,或这个 id 已被一个看不见的群占了。
   * ⚠️ 云端不建空群(至少一个成员):还没开过会话的项目只**预留**一个群 id(与第一个会话一直以来的做法相同),
   * 第一个 agent 加入时才按这个 id 建出来 —— 所以「云端还没有这个群」本身不算不能用。
   */
  | { type: 'group-unavailable'; chatId: string; message: string }
  /** 云端调用失败(建群 / 把 agent 加进群)。 */
  | { type: 'cloud-failed'; message: string };

/** 绑定之后:原来那个项目里有几个 agent 被加进了这个群(owner 2026-10-17 选 A),原来的群是哪个(留作历史)。 */
export type BindProjectToGroupResult = {
  movedAgents: number;
  previousChatId: string | null;
};
