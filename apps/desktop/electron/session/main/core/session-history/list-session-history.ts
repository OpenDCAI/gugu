import { eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { sessions, projects, workspaces } from '@main/db/schema';
import { hasLocalSessionSource, getLocalSessionSource } from '@main/core/session-import/host-source';
import type { SessionRuntime } from '@shared/core/sessions/sessions';
import { isImplicitSessionHomeProjectId } from '@shared/core/projects/session-home-project';
import {
  LOCAL_SESSION_ENGINE_PROVIDER,
  type ListLocalSessionsResult,
  type LocalSessionRow,
} from '@shared/core/session-import/session-import';
import {
  SESSION_HISTORY_SOURCES,
  SESSION_HISTORY_STATUSES,
  SESSION_HOME_SECTION_KEY,
  displaySessionTitle,
  type SessionHistoryDirectoryPage,
  type SessionHistoryDirectoryParams,
  type SessionHistoryDirectoryRow,
  type SessionHistoryPage,
  type SessionHistoryParams,
  type SessionHistoryRow,
  type SessionHistorySort,
} from '@shared/core/session-history/session-history';
import { sessionParentId } from '@main/core/sessions/utils';
import { taskName } from '@main/core/sessions/task-name';
import { createLocalGroupOf } from './local-session-group';

// spec session-page「会话历史」(#6083):把咕咕自己的会话(活跃 + 已归档)与本机引擎磁盘上还没导入的会话
// 合成**一张表**,筛 / 排全在这里做完再切页;目录视图(默认)= 同一份筛选结果按目录聚合,一目录一节,
// 每节随行带回头几条会话。
//
// 为什么不在渲染层排:本机索引是分轮的(`use-local-sessions` 那套:cached 首帧 → fresh 多轮),只对
// 「当前已索引的那 200 条」排序,索引没走完时给出的「最早 / 最晚」是错的。这里向索引要**全量已索引行**
// (不切页),与库表合并后再排、再切 —— 索引仍可能没走完,但那由 `local.pending` 原样透出,渲染层照旧
// 显示进度,而不是拿半截索引冒充全集。
//
// 账号边界:这里读的是与侧栏同一张 `conversations` 表(同一个库、同一份可见域),只是**不再**滤掉
// `archived_at`;本机引擎原件同机人人可读(product spec 明写的边界)。
// ❌ 没有借「统一」多露出任何别的账号的咕咕会话。

const DEFAULT_LIMIT = 200;

/**
 * SQLite `CURRENT_TIMESTAMP` 落的是 `YYYY-MM-DD HH:MM:SS`(UTC、无时区标记);渲染层写回的字段
 * (如 `last_interacted_at`)是 ISO 串。两种都认;认不出的当「没有」而不是 NaN 参与排序。
 */
export function toEpochMs(text: string | null | undefined): number | null {
  if (!text) return null;
  const raw = text.trim();
  if (!raw) return null;
  const normalized = /[TZ+]/.test(raw) ? raw : `${raw.replace(' ', 'T')}Z`;
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? null : ms;
}

function splitQuery(query: string | undefined): string[] {
  return (query ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);
}

/** 关键词匹配标题、目录、项目名、session id 与 conversation id(设计同事 2026-09-23:「特色是支持基于 sessionid 的搜索」)。 */
function matchesTerms(row: SessionHistoryRow, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const haystack = [row.title, row.directory ?? '', row.projectName ?? '', row.providerSessionId ?? '', row.gugu?.sessionId ?? '']
    .join('\n')
    .toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

type GuguJoinedRow = {
  session: typeof sessions.$inferSelect;
  projectName: string;
  projectPath: string;
  workspacePath: string | null;
};

async function readGuguRows(): Promise<GuguJoinedRow[]> {
  return db
    .select({
      session: sessions,
      projectName: projects.name,
      projectPath: projects.path,
      workspacePath: workspaces.path,
    })
    .from(sessions)
    .innerJoin(projects, eq(projects.id, sessions.projectId))
    .leftJoin(workspaces, eq(workspaces.id, sessions.workspaceId));
}

/**
 * 「子会话」= 挂在它下面的,按父会话这条边(`sessionParentId`)递归 —— 与渲染层 `session-descendants.ts`、
 * 归档的 `familyOf`、session_children 同一条规则,fork 不在其中。几处对「谁是子会话」必须给同一个答案。
 */
function countDescendants(rows: GuguJoinedRow[]): Map<string, number> {
  const childrenOf = new Map<string, string[]>();
  for (const { session } of rows) {
    const parent = sessionParentId(session);
    if (!parent || parent === session.id) continue;
    childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), session.id]);
  }
  const counts = new Map<string, number>();
  for (const { session } of rows) {
    const seen = new Set<string>();
    const queue = [session.id];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const child of childrenOf.get(current) ?? []) {
        if (child === session.id || seen.has(child)) continue;
        seen.add(child);
        queue.push(child);
      }
    }
    counts.set(session.id, seen.size);
  }
  return counts;
}

function toGuguRow(
  joined: GuguJoinedRow,
  titles: Map<string, string>,
  descendants: Map<string, number>
): SessionHistoryRow {
  const { session } = joined;
  const standalone = isImplicitSessionHomeProjectId(session.projectId);
  const archivedAt = toEpochMs(session.archivedAt);
  const parentId = sessionParentId(session);
  return {
    key: `gugu:${session.id}`,
    source: 'gugu',
    status: archivedAt === null ? 'active' : 'archived',
    title: displaySessionTitle(taskName(session)),
    providerSessionId: session.providerSessionId ?? null,
    providerId: session.provider ?? null,
    // 独立任务住在用户从没见过的 task-home 项目里(spec session-page 任务分区),它的路径不是用户的目录。
    directory: standalone ? null : (joined.workspacePath ?? joined.projectPath),
    projectName: standalone ? null : joined.projectName,
    updatedAt: toEpochMs(session.updatedAt) ?? 0,
    lastPromptAt: toEpochMs(session.lastInteractedAt),
    addedAt: toEpochMs(session.createdAt),
    archivedAt,
    childCount: descendants.get(session.id) ?? 0,
    parentTitle: parentId ? (titles.get(parentId) ?? null) : null,
    gugu: {
      projectId: session.projectId,
      sessionId: session.id,
      runtime: (session.runtime as SessionRuntime | null) ?? 'pty',
    },
  };
}

function toLocalRow(local: LocalSessionRow): SessionHistoryRow {
  return {
    key: `local:${local.filePath}`,
    source: local.engine,
    status: 'not-imported',
    title: displaySessionTitle(local.title),
    providerSessionId: local.providerSessionId,
    providerId: LOCAL_SESSION_ENGINE_PROVIDER[local.engine] ?? null,
    directory: local.cwd,
    projectName: null,
    updatedAt: local.updatedAt,
    lastPromptAt: local.updatedAt,
    addedAt: null,
    archivedAt: null,
    childCount: 0,
    parentTitle: null,
    local,
  };
}

type Sortable = { updatedAt: number; lastPromptAt: number | null; addedAt: number | null };

/** 会话行与目录行同一套排序:时间倒序、没有那个时间的排最后、字母正序;并列按更新时间倒序。 */
function compareBy<T extends Sortable>(sort: SessionHistorySort, nameOf: (row: T) => string) {
  const byTime = (pick: (row: T) => number | null) => (a: T, b: T) => {
    const av = pick(a);
    const bv = pick(b);
    if (av === null && bv === null) return b.updatedAt - a.updatedAt;
    if (av === null) return 1;
    if (bv === null) return -1;
    return bv - av || b.updatedAt - a.updatedAt;
  };
  switch (sort) {
    case 'lastPrompt':
      return byTime((row) => row.lastPromptAt);
    case 'added':
      return byTime((row) => row.addedAt);
    case 'title':
      return (a: T, b: T) => nameOf(a).localeCompare(nameOf(b)) || b.updatedAt - a.updatedAt;
    case 'updated':
      return byTime((row) => row.updatedAt);
  }
}

function emptyCounts<K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
}

function maxOf(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

type Collected = {
  /** 命中筛选的会话,尚未排序。 */
  matching: SessionHistoryRow[];
  countsBySource: Record<SessionHistoryRow['source'], number>;
  countsByStatus: Record<SessionHistoryRow['status'], number>;
  directories: SessionHistoryPage['directories'];
  local: SessionHistoryPage['local'];
  /** 这一行归哪一节:咕咕项目的路径(一个项目一节),不在任何项目下的就是它自己的目录;没有目录为 null。 */
  groupOf: (row: SessionHistoryRow) => { key: string | null; projectName: string | null };
};

/** 两种视图共用的前半段:读库 + 读索引 → 合并去重 → 计数 → 筛选。排序 / 聚合 / 切页由调用方做。 */
async function collect(params: SessionHistoryParams): Promise<Collected> {
  const [guguJoined, localPage] = await Promise.all([
    readGuguRows(),
    hasLocalSessionSource()
      ? getLocalSessionSource().list({
          // 全量:排序要在合并之后做,切页之前的任何截断都会把「最早」截没。
          limit: Number.MAX_SAFE_INTEGER,
          mode: params.mode,
          hydrateBudgetMs: params.hydrateBudgetMs,
        })
      : Promise.resolve<ListLocalSessionsResult | null>(null),
  ]);

  const titles = new Map(guguJoined.map(({ session }) => [session.id, taskName(session)]));
  const descendants = countDescendants(guguJoined);
  const guguRows = guguJoined.map((joined) => toGuguRow(joined, titles, descendants));

  // 已经导入过的本机会话不再算「未导入」:它在咕咕这边有一行(活跃或已归档),那一行就是它。
  // 匹配同 `importLocalSession` 的去重口径(`sessions.provider_session_id`);claude 导入还用原会话 id 当
  // conversation id,一并认。
  const imported = new Set<string>();
  for (const { session } of guguJoined) {
    imported.add(session.id);
    if (session.providerSessionId) imported.add(session.providerSessionId);
  }
  const localRows = (localPage?.rows ?? [])
    .filter((local) => !imported.has(local.providerSessionId))
    .map(toLocalRow);

  const all = [...guguRows, ...localRows];

  // 本机行没有咕咕项目,按「它所在的 git 仓库」归节(同一仓库的子目录、worktree 并成一节);不在仓库里的按目录本身。
  // 咕咕项目只收**它自己那个仓库之内**的原件:项目路径是 cwd 或 cwd 的上级,且不高出 cwd 所在仓库的根
  // (不在仓库里时 = 就是 cwd 本身)。❌ 纯前缀匹配 —— 一个路径是 /Users 的项目会把它底下几千条原件全吞掉
  // (mac1 2026-09-24 读数:一节 3424 条)。
  const localGroupOf = createLocalGroupOf(guguJoined.map((j) => ({
    projectId: j.session.projectId, projectPath: j.projectPath, projectName: j.projectName,
  })));
  const sessionHomeGroup = { key: SESSION_HOME_SECTION_KEY, label: null };
  // 一个项目一节(设计同事 2026-09-23 参照页:节名是「gugu」,❌ 每个 worktree 目录各一节)。
  // 咕咕行直接认它自己的项目(工作区 worktree 常常不在项目路径之下,按前缀猜会猜丢);本机行按仓库归。
  const guguProjectOf = new Map(
    guguJoined.map((j) => [
      `gugu:${j.session.id}`,
      isImplicitSessionHomeProjectId(j.session.projectId)
        ? sessionHomeGroup
        : { key: j.projectPath, label: j.projectName },
    ])
  );
  const groupOf = (row: SessionHistoryRow) => {
    const project = guguProjectOf.has(row.key) ? guguProjectOf.get(row.key)! : localGroupOf(row.directory);
    return { key: project.key, projectName: project.label };
  };

  const countsBySource = emptyCounts(SESSION_HISTORY_SOURCES);
  const countsByStatus = emptyCounts(SESSION_HISTORY_STATUSES);
  const directoryCounts = new Map<string | null, { projectName: string | null; count: number }>();
  for (const row of all) {
    countsBySource[row.source] += 1;
    countsByStatus[row.status] += 1;
    // 项目下拉的候选跟着「类型 / 状态」走:默认只看咕咕会话时,❌ 把本机几千条原件的 /tmp 目录列进下拉。
    if ((params.source && row.source !== params.source) || (params.status && row.status !== params.status)) continue;
    const group = groupOf(row);
    const entry = directoryCounts.get(group.key) ?? { projectName: group.projectName, count: 0 };
    entry.count += 1;
    directoryCounts.set(group.key, entry);
  }
  const directories = [...directoryCounts]
    .map(([directory, { projectName, count }]) => ({ directory, projectName, count }))
    // 全部列出(项目下拉可搜索,❌ 只给条数最多的前 N 个 —— 剩下的就再也选不到)。
    .sort((a, b) => b.count - a.count || (a.directory ?? '').localeCompare(b.directory ?? ''));

  const terms = splitQuery(params.query);
  const matching = all.filter(
    (row) =>
      (params.source ? row.source === params.source : true) &&
      (params.status ? row.status === params.status : true) &&
      (params.directory === undefined ? true : groupOf(row).key === params.directory) &&
      (params.since !== undefined ? row.updatedAt >= params.since : true) &&
      matchesTerms(row, terms)
  );

  return {
    matching,
    countsBySource,
    countsByStatus,
    directories,
    local: localPage
      ? {
          discovered: localPage.discovered,
          indexed: localPage.indexed,
          pending: localPage.pending,
          stale: localPage.stale,
        }
      : null,
    groupOf,
  };
}

/** 平铺视图(也是「只看某目录」那一节的读法):筛选 → 排序 → 切页,一会话一行。 */
export async function listSessionHistory(params: SessionHistoryParams = {}): Promise<SessionHistoryPage> {
  const sort = params.sort ?? 'updated';
  const limit = params.limit ?? DEFAULT_LIMIT;
  const offset = params.offset ?? 0;
  const { matching, countsBySource, countsByStatus, directories, local } = await collect(params);
  const sorted = matching.sort(compareBy(sort, (row) => row.title));
  return {
    // 切页在排序**之后**:第 n 页就是全集里排好序的那一截,❌ 先切再排。
    rows: sorted.slice(offset, offset + limit),
    matched: sorted.length,
    countsBySource,
    countsByStatus,
    directories,
    local,
  };
}

/**
 * 目录视图(默认):筛选 → 按目录聚合 → 排序 → 切页,一目录一节,每节随行带回头 `sessionsPerDirectory` 条。
 * 聚合在筛选**之后**:节头的计数就是「这个目录里符合当前筛选的有几条」,节内看到的与数字一致。
 * 没有目录的会话(独立任务 / 读不出 cwd 的原件)拢成 key 为 '' 的一节,展开时用 `directory: null` 取。
 */
export async function listSessionHistoryDirectories(
  params: SessionHistoryDirectoryParams = {}
): Promise<SessionHistoryDirectoryPage> {
  const sort = params.sort ?? 'updated';
  const limit = params.limit ?? DEFAULT_LIMIT;
  const offset = params.offset ?? 0;
  const perDirectory = params.sessionsPerDirectory ?? 0;
  const { matching, countsBySource, countsByStatus, directories, local, groupOf } = await collect(params);

  const buckets = new Map<string | null, SessionHistoryDirectoryRow>();
  for (const row of matching) {
    const group = groupOf(row);
    let bucket = buckets.get(group.key);
    if (!bucket) {
      bucket = {
        key: group.key ?? '',
        directory: group.key,
        projectName: group.projectName,
        sessionCount: 0,
        countsBySource: emptyCounts(SESSION_HISTORY_SOURCES),
        countsByStatus: emptyCounts(SESSION_HISTORY_STATUSES),
        providers: [],
        updatedAt: 0,
        lastPromptAt: null,
        addedAt: null,
        sessions: [],
      };
      buckets.set(group.key, bucket);
    }
    bucket.sessionCount += 1;
    bucket.countsBySource[row.source] += 1;
    bucket.countsByStatus[row.status] += 1;
    bucket.updatedAt = Math.max(bucket.updatedAt, row.updatedAt);
    bucket.lastPromptAt = maxOf(bucket.lastPromptAt, row.lastPromptAt);
    bucket.addedAt = maxOf(bucket.addedAt, row.addedAt);
    if (row.providerId && !bucket.providers.includes(row.providerId)) bucket.providers.push(row.providerId);
    // 先全收,排完再截:头 N 条必须是**排好序**的头 N 条。
    bucket.sessions.push(row);
  }

  const byRow = compareBy(sort, (row: SessionHistoryRow) => row.title);
  const byDirectory = compareBy(sort, (row: SessionHistoryDirectoryRow) => row.directory ?? '');
  const sorted = [...buckets.values()]
    // 「未关联目录」那一节永远排最后:它是个杂物筐,不该因为里面刚好有一条最新的就顶到页首。
    .sort((a, b) => Number(a.directory === null) - Number(b.directory === null) || byDirectory(a, b))
    .slice(offset, offset + limit)
    .map((bucket) => ({ ...bucket, sessions: perDirectory > 0 ? bucket.sessions.sort(byRow).slice(0, perDirectory) : [] }));
  return {
    rows: sorted,
    matched: buckets.size,
    countsBySource,
    countsByStatus,
    directories,
    local,
  };
}
