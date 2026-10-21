import { sameFolder } from './folder-path';

/**
 * 「+」/ 拖进来一个文件夹之后走哪条路(product spec「挂文件夹」,#7341 第二步)。项目首页按它分派,❌ 在组件里另判一遍。
 *   · 这个项目在那台机器上已经有本地项目 ⇒ 挂在它下面(第一步那条路,那台机器自己判这个文件夹能不能挂);
 *   · 那台机器上这个文件夹本身就是另一个项目 ⇒ 要不要把它并进来(有会话先确认,owner 2026-10-17 选 A);
 *   · 它挂在那台机器上的另一个项目下 ⇒ 不能挂(一个文件夹只属于一个项目),❌ 悄悄把那整个项目并进来;
 *   · 都不是 ⇒ 在那台机器上把文件夹认成项目,绑到这个项目的群上。
 * 「那台机器上它是什么」问那台机器(它的库才是真的),❌ 拿这边侧栏认得的项目清单猜 —— 清单里没有挂上的文件夹。
 */
export type AttachPlan =
  | { kind: 'member'; memberId: string }
  | { kind: 'merge'; projectId: string; name: string }
  | { kind: 'taken'; projectName: string }
  | { kind: 'link' };

export type FolderOnMachine = { existingProject?: { id: string; path: string; name: string } };

export async function planAttach(input: {
  /** 选的机器;null = 这台电脑。 */
  machine: string | null;
  path: string;
  /** 这个项目在各台机器上的本地项目。 */
  memberIds: readonly string[];
  machineOf: (projectId: string) => string | null;
  /** 那台机器上这个文件夹此刻属于哪个项目(是它的根,或挂在它下面)。 */
  inspect: (machine: string | null, path: string) => Promise<FolderOnMachine>;
}): Promise<AttachPlan> {
  const member = input.memberIds.find((id) => input.machineOf(id) === input.machine);
  if (member) return { kind: 'member', memberId: member };
  const { existingProject } = await input.inspect(input.machine, input.path);
  if (!existingProject) return { kind: 'link' };
  return sameFolder(existingProject.path, input.path)
    ? { kind: 'merge', projectId: existingProject.id, name: existingProject.name }
    : { kind: 'taken', projectName: existingProject.name };
}

type Answer<T> = { success: true; data: T } | { success: false; error: unknown };

export type LinkFolderDeps = {
  /** 这个项目的群(还没有就预留一个),由代表那一行所在的机器回答。 */
  ensureGroup: (rowId: string) => Promise<Answer<{ chatId: string }>>;
  /** 在那台机器上把文件夹认成项目。created = 这一步才建出来的(❌ 本来就有的)。 */
  createProjectOn: (machine: string | null, path: string) => Promise<{ projectId: string; created: boolean } | null>;
  bind: (machine: string | null, projectId: string, chatId: string) => Promise<Answer<unknown>>;
  unbind: (machine: string | null, projectId: string) => Promise<Answer<unknown>>;
  /** 只删项目那一行记录,❌ 动文件夹。 */
  deleteProject: (projectId: string) => Promise<void>;
  sessionCountOf: (projectId: string) => number | Promise<number>;
};

export type LinkFolderResult =
  | { ok: true; projectId: string; undo: () => Promise<boolean> }
  | { ok: false; error: unknown };

/**
 * 把那台机器上的文件夹接进这个项目:认成项目(并进来的就用那一个),绑到这个项目的群上。
 * 返回的 undo 回到接之前 —— 解绑;这一步才建出来的项目(还没有会话)一并去掉,❌ 撤完侧栏多出一个项目。
 * 绑不上时同样不留它。
 */
export async function linkFolderOnMachine(
  deps: LinkFolderDeps,
  input: { rowId: string; machine: string | null; path: string; existingProjectId?: string }
): Promise<LinkFolderResult> {
  const { machine } = input;
  const group = await deps.ensureGroup(input.rowId);
  if (!group.success) return { ok: false, error: group.error };
  const linked = input.existingProjectId
    ? { projectId: input.existingProjectId, created: false }
    : await deps.createProjectOn(machine, input.path);
  if (!linked) return { ok: false, error: new Error(`could not add ${input.path} as a project`) };
  const { projectId, created } = linked;
  const dropIfCreated = async () => {
    if (created && await deps.sessionCountOf(projectId) === 0) await deps.deleteProject(projectId);
  };
  const bound = await deps.bind(machine, projectId, group.data.chatId);
  if (!bound.success) {
    await dropIfCreated();
    return { ok: false, error: bound.error };
  }
  return {
    ok: true,
    projectId,
    undo: async () => {
      const unbound = await deps.unbind(machine, projectId);
      if (!unbound.success) return false;
      await dropIfCreated();
      return true;
    },
  };
}
