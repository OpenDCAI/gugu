import { useCallback, useEffect, useRef, useState } from 'react';
import type { AttachProjectFolderError, ProjectFolder } from '@shared/core/projects/project-folders';
import { projectFoldersChangedChannel, projectGroupBindingChangedChannel } from '@shared/core/projects/projectEvents';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { onMachineEvent, rpc } from '@renderer/lib/ipc';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { log } from '@renderer/utils/logger';
import { reportAssistantAppChange } from '@/components/assistant/assistant-app-client';
import { cachedDevicesAccount } from '@/store/devicesCache';

/**
 * 项目首页的文件夹卡与输入框的文件夹选择器共用的数据(product spec「项目首页」,#7341)。
 * 项目首页读一次、往下传:❌ 两处各读一遍。
 *
 * 一个项目可以在几台机器上各有一个本地项目(绑在同一个项目群上,#7341 第二步):这里把它们的文件夹汇总成一份。
 * 每个本地项目的文件夹由它所在的那台机器回答(rpc 按 projectId 自动路由,lib/ipc.ts)。
 * 那台机器此刻答不上(离线)时,用账号上记着的那份(#113)、标离线 —— 机器离线时它的文件夹照样列在项目里(product spec)。
 */

/** 卡片上的一个文件夹:多一格「那台机器此刻答不上,这是账号上记着的」。 */
export type ShownFolder = ProjectFolder & { offline: boolean };

/** 每个项目(按代表那一行的 id)「新会话从哪个文件夹开工」:切走再回来还在;没选过 = 代表行的根目录。 */
const folderChoice = new Map<string, string>();
/** 刚挂上的文件夹(这一页里标「刚挂上」、排在最前)。 */
const freshFolders = new Map<string, string>();

/** 一台机器这么久还没答(掉线了、连接还没断开):先列账号上记着的、标离线。 */
export const UNANSWERED_AFTER_MS = 3000;

/** 账号上记着的这个本地项目的文件夹(本机的项目 / 还没读到过账号上的那份 = null)。 */
function accountFolders(projectId: string): ProjectFolder[] | null {
  const machine = machineRegistry.machineOf(projectId);
  return machine ? remoteHostsStore.accountFolders(machine, projectId) : null;
}

/** 账号上那份比这一端经连接读到的新(见 RemoteHostsStore.accountIsNewer);本机的项目 = false。 */
function accountIsNewer(projectId: string): boolean {
  const machine = machineRegistry.machineOf(projectId);
  return machine ? remoteHostsStore.accountIsNewer(machine) : false;
}

export function chosenFolderOf(rowId: string, folders: readonly ShownFolder[] | null): ShownFolder | null {
  if (!folders || folders.length === 0) return null;
  const chosen = folderChoice.get(rowId);
  return (
    folders.find((folder) => folder.workspaceId === chosen) ??
    folders.find((folder) => folder.kind === 'root' && folder.projectId === rowId) ??
    folders.find((folder) => folder.kind === 'root') ??
    folders[0]
  );
}

export type AttachResult =
  | { ok: true; folder: ProjectFolder }
  | { ok: false; error: AttachProjectFolderError | { type: 'rpc-failed'; message: string } };

export type ProjectFoldersState = {
  folders: ShownFolder[] | null;
  /** 一台都读不到、账号上也没有:卡片如实说读不到(原因进日志),❌ 拿根目录冒充全部。 */
  loadError: boolean;
  /** 这一行里还没答过的本地项目(那台机器的文件夹还不知道,❌ 当成没有)。 */
  unanswered: readonly string[];
  chosen: ShownFolder | null;
  /** 刚挂上的那一个(workspaceId)。 */
  fresh: string | undefined;
  choose: (workspaceId: string) => void;
  reload: () => void;
  /** 挂到这个项目在某台机器上的那个本地项目(projectId)下。 */
  attach: (projectId: string, path: string) => Promise<AttachResult>;
  detach: (folder: ProjectFolder) => Promise<boolean>;
};

/**
 * @param rowId 代表这个项目的那一行(侧栏那一行)的本地项目 id
 * @param memberIds 这个项目在各台机器上的本地项目(含 rowId;没合并就只有它)
 */
export function useProjectFolders(rowId: string, memberIds: readonly string[] = [rowId]): ProjectFoldersState {
  const [snapshot, setSnapshot] = useState<{ rowId: string; folders: ShownFolder[] | null; loadError: boolean; unanswered?: readonly string[] }>(
    () => ({ rowId, folders: null, loadError: false })
  );
  // Switching projects must never expose the previous project's folders, even
  // during the render before the new request's effect starts.
  const folders = snapshot.rowId === rowId ? snapshot.folders : null;
  const loadError = snapshot.rowId === rowId && snapshot.loadError;
  const [generation, setGeneration] = useState(0);
  const [fresh, setFresh] = useState<string | undefined>(() => freshFolders.get(rowId));
  // 上一次读到的那份:重读后多出来的文件夹就是刚挂上的(product spec:几条路挂上的都看得见它落进去)。
  const previous = useRef<{ rowId: string; members: Map<string, Set<string> | null> } | null>(null);
  // 上一次画出来的、每台机器的那一份(重读时还没答的那台先照旧列着)。
  const shown = useRef<{ rowId: string; lists: Map<string, ShownFolder[]> } | null>(null);
  const bump = useCallback(() => setGeneration((value) => value + 1), []);
  const membersKey = memberIds.join('\u0000');
  // 账号上记着的那几份变了(那台机器离线时挂 / 摘了文件夹之后记上来、这一端刚读到账号上的那份):重读一遍。
  // 读的是 mobx 里的设备行 —— 项目首页是 observer,那一份变了这里才重算。
  const accountKey = JSON.stringify(memberIds.map((projectId) => [accountFolders(projectId), accountIsNewer(projectId)]));
  // 换了项目:「刚挂上」跟着换成那个项目的(❌ 把上一个项目的那张带过来)。
  useEffect(() => setFresh(freshFolders.get(rowId)), [rowId]);

  useEffect(() => {
    let cancelled = false;
    setSnapshot((current) => current.rowId === rowId
      ? { ...current, loadError: false }
      : { rowId, folders: null, loadError: false });
    const ids = membersKey.split('\u0000');
    const fromAccount = (projectId: string): ShownFolder[] | null =>
      accountFolders(projectId)?.map((folder): ShownFolder => ({ ...folder, offline: true })) ?? null;
    // 每台各自回话:答了的(读到的,或读不到 = null)、过了时限还没答的。
    const answered = new Map<string, ShownFolder[] | null>();
    const late = new Set<string>();

    // 哪台先答就先画哪台(❌ 等齐 —— 一台掉线的机器的请求可能挂很久,不能拖住这台电脑自己的文件夹)。
    const publish = () => {
      if (cancelled) return;
      const lastShown = shown.current?.rowId === rowId ? shown.current.lists : null;
      // 一台的那一份:读到的 > 读不到就用账号上记着的与这一页刚才画的那份里新的那个(都标离线;账号上那份在那台机器
      // 经连接答过之后没变 = 刚才画的更新,❌ 拿它把刚挂上、还没记到账号上的文件夹抹掉);过了时限还没答的同样;
      // 还没到时限的先照旧列着上一次画的(❌ 每次重读远程机器的文件夹都闪一下),这一行头一回读就先不画它(undefined)。
      const listFor = (projectId: string): ShownFolder[] | null | undefined => {
        const last = lastShown?.get(projectId);
        const offline = () => {
          const shownBefore = last?.map((folder) => ({ ...folder, offline: true })) ?? null;
          const recorded = fromAccount(projectId);
          return (accountIsNewer(projectId) ? recorded ?? shownBefore : shownBefore ?? recorded) ?? null;
        };
        if (answered.has(projectId)) return answered.get(projectId) ?? offline();
        if (late.has(projectId)) return offline();
        return last;
      };
      const lists = ids.map(listFor);
      const known = lists.filter((list): list is ShownFolder[] => Array.isArray(list));
      if (known.length === 0) {
        // 还有没答的就再等;都答了(或都过了时限)也一份都没有:如实说读不到。
        if (lists.some((list) => list === undefined)) return;
        setSnapshot({ rowId, folders: null, loadError: true });
        return;
      }
      const merged = known.flat();
      // 「刚挂上」只拿上一次看见过的比:上一次那台还没答 / 没列出来的,这次它的文件夹不算刚挂上;
      // 这一行新并进来的机器(上一次根本不是成员)上的文件夹才算 —— 那是刚从那台接进来的。
      const before = previous.current?.rowId === rowId ? previous.current.members : null;
      const added = before
        ? merged.filter((folder) => {
            if (!before.has(folder.projectId)) return true;
            const seen = before.get(folder.projectId);
            return !!seen && !seen.has(folder.workspaceId);
          })
        : [];
      const newest = added.sort((a, b) => (b.attachedAt ?? '').localeCompare(a.attachedAt ?? ''))[0];
      if (newest) {
        freshFolders.set(rowId, newest.workspaceId);
        setFresh(newest.workspaceId);
      }
      // 记下这一次看见的(null = 是这一行的成员、但还不知道它有哪些文件夹)。还没答的那台:沿用上一次的记录;
      // 这一行头一回读(上一次没有记录)时记成 null —— 它只是答得慢,❌ 答了之后被当成新并进来的、整台标「刚挂上」;
      // 读到一半新并进来的那台(上一次的成员里没有它)不记,它答了才算刚接进来。
      const members = new Map<string, Set<string> | null>();
      ids.forEach((projectId, index) => {
        const list = lists[index];
        if (Array.isArray(list)) members.set(projectId, new Set(list.map((folder) => folder.workspaceId)));
        else if (before?.has(projectId)) members.set(projectId, before.get(projectId) ?? null);
        else if (!before || list === null) members.set(projectId, null);
      });
      previous.current = { rowId, members };
      shown.current = { rowId, lists: new Map(ids.flatMap((projectId, index) => { const list = lists[index]; return Array.isArray(list) ? [[projectId, list] as const] : []; })) };
      setSnapshot({ rowId, folders: merged, loadError: false, unanswered: ids.filter((_, index) => lists[index] === undefined) });
    };

    for (const projectId of ids) {
      // 包一层:调用本身同步抛(通道不在)也算这一台读不到,❌ 让整页崩掉。
      void Promise.resolve()
        .then(() => rpc.projects.listProjectFolders(projectId))
        .then((result) => {
          if (result.success) {
            return result.data.map((folder): ShownFolder => ({ ...folder, offline: false }));
          }
          log.warn('[project-folders] 读不到这台机器上的文件夹', {
            projectId,
            error: result.error,
          });
          return null;
        })
        .catch((error: unknown) => {
          log.warn('[project-folders] 读不到这台机器上的文件夹', { projectId, error });
          return null;
        })
        .then((live) => {
          answered.set(projectId, live);
          publish();
        });
    }
    // 过了时限还没答的那台:先列账号上记着的、标离线;它答了再换成真的。
    const deadline = setTimeout(() => {
      for (const projectId of ids) if (!answered.has(projectId)) late.add(projectId);
      if (late.size > 0) publish();
    }, UNANSWERED_AFTER_MS);
    return () => {
      cancelled = true;
      clearTimeout(deadline);
    };
  }, [rowId, membersKey, generation, accountKey]);

  // 别处挂上 / 摘下 / 并进来(另一个窗口、agent、撤销)也要跟着变:在各成员项目所在的机器上订,那台推一声就重读。
  useEffect(() => {
    const ids = new Set(membersKey.split('\u0000'));
    const machines = new Set([...ids].map((id) => machineRegistry.machineOf(id)));
    const offs = [...machines].flatMap((machine) => [
      onMachineEvent(machine, projectFoldersChangedChannel, ({ projectId: changed }) => {
        if (ids.has(changed)) bump();
      }),
      onMachineEvent(machine, projectGroupBindingChangedChannel, () => bump()),
    ]);
    return () => offs.forEach((off) => off());
  }, [membersKey, bump]);

  const choose = useCallback(
    (workspaceId: string) => {
      folderChoice.set(rowId, workspaceId);
      // 列表没变,只是选中那一张变了:同一份数据换个引用,让卡片和输入框跟着重画。
      setSnapshot((current) => current.rowId === rowId && current.folders
        ? { ...current, folders: [...current.folders] }
        : current);
    },
    [rowId]
  );

  const attach = useCallback(
    async (projectId: string, path: string): Promise<AttachResult> => {
      const ownerId = cachedDevicesAccount();
      try {
        const result = await rpc.projects.attachProjectFolder(projectId, path);
        if (!result.success) return { ok: false, error: result.error };
        void reportAssistantAppChange({ rpc }, undefined, { resource: 'projects', operation: 'edited', section: 'folders', id: projectId,
          deviceId: machineRegistry.machineOf(projectId) ?? undefined, after: { path: result.data.path } }, ownerId);
        freshFolders.set(rowId, result.data.workspaceId);
        setFresh(result.data.workspaceId);
        bump();
        return { ok: true, folder: result.data };
      } catch (error) {
        return { ok: false, error: { type: 'rpc-failed', message: error instanceof Error ? error.message : String(error) } };
      }
    },
    [rowId, bump]
  );

  const detach = useCallback(
    async (folder: ProjectFolder): Promise<boolean> => {
      const ownerId = cachedDevicesAccount();
      const result = await rpc.projects.detachProjectFolder(folder.projectId, folder.workspaceId);
      if (!result.success) throw new Error(result.error.message, { cause: result.error });
      void reportAssistantAppChange({ rpc }, undefined, { resource: 'projects', operation: 'edited', section: 'folders', id: folder.projectId,
        deviceId: machineRegistry.machineOf(folder.projectId) ?? undefined, before: { path: folder.path } }, ownerId);
      if (freshFolders.get(rowId) === folder.workspaceId) {
        freshFolders.delete(rowId);
        setFresh(undefined);
      }
      if (folderChoice.get(rowId) === folder.workspaceId) folderChoice.delete(rowId);
      bump();
      return true;
    },
    [rowId, bump]
  );

  return {
    folders,
    loadError,
    unanswered: (snapshot.rowId === rowId && snapshot.unanswered) || [],
    chosen: chosenFolderOf(rowId, folders),
    fresh,
    choose,
    reload: bump,
    attach,
    detach,
  };
}
