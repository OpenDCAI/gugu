import { eq, sql } from 'drizzle-orm';
import type { AppCallAction, AppMessageOptions, AppMessageReceipt, AppReadFileAction, AppSpawnAction, SessionpageSessionSummary, UnreachedMachine } from '@gugu/session-core/session-record/contract';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { events } from '@main/lib/events';
import { sessionChangedChannel } from '@shared/core/sessions/sessionEvents';
import { SESSION_PARENT_CYCLE } from '@shared/core/sessions/sessions';
import { sessionParentId, storedParent, type SessionParent } from './utils';
import type { WorkspaceChunk } from '@main/core/files/workspace-transfer';

/**
 * 「连同子会话」(owner 2026-10-01「一起收」「链路统一」):先按父子关系找出要收哪些 —— 父会话这条边(与侧栏建树、
 * session_children 同一个关系;派出去但没挂的不算,owner 10-08)、传递、哪台机器上的都算 —— 再对每一条走它所在
 * 机器上的单条归档。收起会话只有归档(#6949),删除不带子树。
 */
export type FamilyMember = {
  id: string;
  projectId: string;
  /** 在别的机器上时那台机器;本机为 null。 */
  deviceId: string | null;
  label: string | null;
};

type Linked = FamilyMember & { parentId: string | null };

/**
 * 别的机器,由宿主接上(列会话、收一条,与手机同一套方法;App 发一条消息);没接上(单测、单机)= 只有本机。
 */
export type OtherMachines = {
  devices(): Promise<Array<{ deviceId: string; label: string; online: boolean; thisMachine: boolean }>>;
  isThisDevice(deviceId: string): Promise<boolean>;
  appSpawn(app: { extensionId: string; extensionName: string }, deviceId: string, action: AppSpawnAction): Promise<{ agentId: string }>;
  /** 别的机器上的会话(界面那份列表的整行);够不着的报在 unreached。`since` 之前就离线的机器不报,null = 都报。 */
  sessions(since: string | null): Promise<{
    sessions: Array<{ deviceId: string; label: string; session: SessionpageSessionSummary }>;
    unreached: UnreachedMachine[];
  }>;
  archive(deviceId: string, sessionId: string): Promise<void>;
  /** 这台机器上的一个 App 给别的机器上的一条会话发消息(`agents:control:all-machines`)。 */
  appMessage(app: { extensionId: string; extensionName: string }, deviceId: string, sessionId: string, text: string, how: AppMessageOptions): Promise<AppMessageReceipt>;
  /** 这台机器上的一个 App 读别的机器上一条会话工作副本里的一块(`files:read:all-machines`)。 */
  appReadFile(app: { extensionId: string; extensionName: string }, deviceId: string, action: AppReadFileAction): Promise<WorkspaceChunk>;
  /** 这台机器上一个 App 的页面让别的机器做它的一个跟着会话机器的动词(页面所在的会话在那台机器上)。 */
  appCall(app: { extensionId: string; extensionName: string }, deviceId: string, action: AppCallAction): Promise<unknown>;
};

let others: OtherMachines | null = null;

export function setOtherMachines(next: OtherMachines | null): void {
  others = next;
}

/** ❌ 没接上就当「别的机器上什么都没有」:那和「问不到」在读的一方眼里一模一样。 */
export function otherMachines(): OtherMachines {
  if (!others) throw new Error('other machines are not reachable from this process (not signed in yet)');
  return others;
}

/**
 * 这个账号的会话图:本机库里的(归档的要不要看调用方定),加上每台在线机器报来的。`since` = 那之前就离线的机器
 * 不必问(见 OtherMachines.sessions);null = 都问。`askOthers` 看过本机的之后说还要不要问别的机器(不给 = 要)。
 */
async function sessionGraph(options: {
  includeArchived: boolean;
  since: string | null;
  askOthers?: (local: Linked[]) => boolean;
}): Promise<{ nodes: Linked[]; unreached: UnreachedMachine[] }> {
  const rows = await db
    .select({
      id: sessions.id,
      projectId: sessions.projectId,
      parentSessionId: sessions.parentSessionId,
      config: sessions.config,
      archivedAt: sessions.archivedAt,
    })
    .from(sessions);
  const local: Linked[] = rows
    .filter((row) => options.includeArchived || !row.archivedAt)
    .map((row) => ({
      id: row.id,
      projectId: row.projectId,
      deviceId: null,
      label: null,
      parentId: sessionParentId(row),
    }));
  if (options.askOthers && !options.askOthers(local)) return { nodes: local, unreached: [] };
  const elsewhere = others ? await sessionsElsewhere(others, options.since) : { sessions: [], unreached: [] };
  return { nodes: [...local, ...elsewhere.sessions], unreached: elsewhere.unreached };
}

/**
 * 这条会话名下的全部子会话,叶子在前(收的时候孩子先走,每一条经历的都是它单独被收时那一套)。
 * 只顺着没归档的会话找(已经归档的那一支不再往下)。
 */
export async function familyOf(
  rootId: string
): Promise<{ members: FamilyMember[]; unreached: UnreachedMachine[] }> {
  const [root] = await db
    .select({ createdAt: sql<string>`strftime('%Y-%m-%dT%H:%M:%SZ', ${sessions.createdAt})` })
    .from(sessions)
    .where(eq(sessions.id, rootId))
    .limit(1);
  const { nodes: all, unreached } = await sessionGraph({ includeArchived: false, since: root?.createdAt ?? null });

  const found: FamilyMember[] = [];
  const seen = new Set([rootId]);
  const queue = [rootId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const { parentId, ...member } of all) {
      if (seen.has(member.id) || parentId !== current) continue;
      seen.add(member.id);
      found.push(member);
      queue.push(member.id);
    }
  }
  return { members: found.reverse(), unreached };
}

/** 归档别的机器上的一条:交给那台。那台收不动不拦着别的,记成「这次没够着」说出来。 */
export async function archiveOnOtherMachine(
  deviceId: string,
  member: FamilyMember,
  unreached: UnreachedMachine[]
): Promise<boolean> {
  try {
    if (!others) throw new Error('other machines are not connected here');
    await others.archive(deviceId, member.id);
    return true;
  } catch (error) {
    unreached.push({
      deviceId,
      label: member.label,
      detail: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** 本机这一份已经能用了,问别的机器出什么错都不能让整个动作失败 —— 落成「这次没够着」说出来。 */
async function sessionsElsewhere(
  machines: OtherMachines,
  since: string | null
): Promise<{ sessions: Linked[]; unreached: UnreachedMachine[] }> {
  try {
    const { sessions, unreached } = await machines.sessions(since);
    const nodes = sessions.map(({ deviceId, label, session: s }) => ({ id: s.conversationId, projectId: s.projectId, deviceId, label, parentId: s.parentConversationId ?? null }));
    return { sessions: nodes, unreached };
  } catch (error) {
    return {
      sessions: [],
      unreached: [{
        deviceId: null,
        label: null,
        detail: `other machines were not asked (${error instanceof Error ? error.message : String(error)})`,
      }],
    };
  }
}

/**
 * 改一条会话挂在谁下面(`session_set_parent`;owner 2026-10-02)。只改父会话这条边 —— 侧栏和手机按它建树;
 * 由谁派的是来历,不动。在 child 所在的机器上执行(宿主按 child 的地址转过来),父会话可以在任一台机器上。
 * 校验只有两条:父会话是这个账号的一条会话(本机库里的,或在线机器报来的);挂上去不成环。
 * 够不着的机器上的会话既找不到、也查不了环 —— 回执里照实说没够着哪台。
 */
export async function setSessionParent(
  childId: string,
  parentId: string | null
): Promise<{ parent_session_id: string | null; not_reached: string[] }> {
  let not_reached: string[] = [];
  let parent: SessionParent = null;
  // 挪回顶层什么都不用查。挂上去时,父会话和它往上一串都在本机库里,判环就只用本机的(别的机器上的会话
  // 不会出现在一条全在本机的链上):❌ 每次都等所有在线机器回话 —— 一台标成在线、实际不回话的机器
  // 会让每次本机拖本机都白等它超时(12–60 s)。
  if (parentId !== null) {
    if (parentId === childId) throw new Error('a session cannot be its own parent');
    const { nodes, unreached } = await sessionGraph({
      includeArchived: true,
      since: null,
      askOthers: (local) => {
        const parentOf = new Map(local.map((node) => [node.id, node.parentId]));
        const seen = new Set<string>();
        for (let at: string | null | undefined = parentId; at && !seen.has(at); at = parentOf.get(at)) {
          if (!parentOf.has(at)) return true;
          seen.add(at);
        }
        return false;
      },
    });
    // 够不着的机器只在它挡住了这一次判断时才说:父会话没找到,或往上走断在一条看不见的会话上。
    const notReached = () => unreached.map((machine) => machine.label ?? machine.detail);
    const node = nodes.find((candidate) => candidate.id === parentId);
    if (!node) {
      const missed = notReached();
      throw new Error(`parent session not found on any of your machines${missed.length ? ` (not reached: ${missed.join(', ')})` : ''}`);
    }
    // 从新的父会话往上走:走到 child 自己,就是把 child 挂到了它自己的子孙下面。
    const parentOf = new Map(nodes.map((candidate) => [candidate.id, candidate.parentId]));
    const seen = new Set<string>();
    for (let at: string | null | undefined = parentId; at && !seen.has(at); at = parentOf.get(at)) {
      if (at === childId) throw new Error(`${SESSION_PARENT_CYCLE}: session:${parentId} is under session:${childId}`);
      if (!parentOf.has(at)) not_reached = notReached();
      seen.add(at);
    }
    parent = node.deviceId === null ? { localSessionId: node.id } : { deviceId: node.deviceId, sessionId: node.id };
  }

  const [row] = await db
    .select({ projectId: sessions.projectId, config: sessions.config })
    .from(sessions)
    .where(eq(sessions.id, childId))
    .limit(1);
  if (!row) throw new Error('session not found on this machine');
  const { parentSessionId, parentRemote } = storedParent(parent);
  // 旧写法 `spawnedByRemote.nested` 也是一个父会话事实,改了父会话就不能让它再被读出来。
  const { parentRemote: _previous, ...config } = row.config ?? ({} as NonNullable<typeof row.config>);
  const spawnedByRemote = config.spawnedByRemote ? { ...config.spawnedByRemote, nested: undefined } : undefined;
  await db
    .update(sessions)
    .set({
      parentSessionId,
      config: {
        ...config,
        ...(spawnedByRemote ? { spawnedByRemote } : {}),
        ...(parentRemote ? { parentRemote } : {}),
      } as typeof row.config,
    })
    .where(eq(sessions.id, childId));
  // 与删父会话时把孩子挂成根同一条事件:侧栏与手机列表(`LISTED_FIELDS`)都跟着它重画。
  events.emit(sessionChangedChannel, {
    sessionId: childId,
    projectId: row.projectId,
    changes: { parentSessionId: parentId },
  });
  return { parent_session_id: parentId, not_reached };
}
