import { readDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';
import type { SessionRuntime } from '../sessions/sessions';
import {
  LOCAL_SESSION_ENGINE_LABEL,
  type LocalSessionEngine,
  type LocalSessionRow,
} from '../session-import/session-import';

// spec session-page「会话历史」(#6083):一个面板列出**所有**会话,不管它是谁生的 ——
// 咕咕自己的(活跃 / 已归档)与本机引擎磁盘上还没导入的。页面按目录分节(设计同事 2026-09-23 给的参照:
// 「直接 copy 这套会话历史」—— 目录 = 一节,节内两行一条),我们自己多两样:按 session id 搜、节头上
// 这个目录里出现过的 agent 图标。筛、排、聚合全部在主进程做(`list-session-history.ts`),渲染层只按
// 给定顺序画:本机索引是分轮的,渲染侧对着半截索引排序会给出错的「最早 / 最晚」。

/**
 * 来源维度。`'gugu'` 是咕咕自己的会话;其余是本机引擎,**从 `LOCAL_SESSION_ENGINE_LABEL` 派生**
 * (它与 core 的 `TRANSCRIPT_SOURCE_IDS` 由 `tests/unit/core/local/transcriptSources.test.ts` 双向对账),
 * 接通新引擎时这里自动多一档,❌ 别在面板里第四次手抄引擎清单。
 */
export type SessionHistorySource = 'gugu' | LocalSessionEngine;

export const SESSION_HISTORY_SOURCES: readonly SessionHistorySource[] = [
  'gugu',
  ...(Object.keys(LOCAL_SESSION_ENGINE_LABEL) as LocalSessionEngine[]),
];

/** 状态维度:活跃(在会话列表里)/ 已归档 / 未导入(只在引擎磁盘上)。 */
export type SessionHistoryStatus = 'active' | 'archived' | 'not-imported';

export const SESSION_HISTORY_STATUSES: readonly SessionHistoryStatus[] = [
  'active',
  'archived',
  'not-imported',
];

/**
 * 排序键。时间类倒序、字母正序;没有那个时间的行(本机行没有「加入时间」)排在最后。
 * 目录按同一组键排:时间取目录里最近的那条,字母按目录路径;节内的会话也按它排。
 */
export type SessionHistorySort = 'updated' | 'lastPrompt' | 'title' | 'added';

export const SESSION_HISTORY_SORTS: readonly SessionHistorySort[] = [
  'updated',
  'lastPrompt',
  'title',
  'added',
];

export type SessionHistoryParams = {
  source?: SessionHistorySource;
  status?: SessionHistoryStatus;
  /**
   * 只看这个目录(与行的 `directory` 逐字相等)。`null` = 只看**没有**目录的会话
   * (独立任务、读不出 cwd 的原件)—— 它们在目录视图里拢成一节。
   */
  directory?: string | null;
  /** 只看这个时刻(epoch ms)之后更新过的。 */
  since?: number;
  /** 关键词:匹配标题、目录、项目名、session id / conversation id,空格分词全部命中。 */
  query?: string;
  sort?: SessionHistorySort;
  /** 分页:跳过排好序之后的前 offset 行(与 limit 一起构成一页)。 */
  offset?: number;
  limit?: number;
  /** 本机索引的读法,语义同 `ListLocalSessionsParams.mode`。 */
  mode?: 'cached' | 'fresh';
  hydrateBudgetMs?: number;
};

/**
 * 目录视图的参数:与会话列表同一套筛选(筛选先作用到会话,再按目录聚合),只是没有「只看某目录」;
 * 多一个「每节带回最近几条会话」—— 分节默认全展开,一次 RPC 把每节的头 N 条一起带回,❌ 每节各拉一次。
 */
export type SessionHistoryDirectoryParams = Omit<SessionHistoryParams, 'directory'> & {
  /** 每个目录随行带回的会话条数(按 sort 排好的头几条);省略或 0 = 不带。 */
  sessionsPerDirectory?: number;
};

/**
 * 「咕咕独立任务」那一节的 key。独立任务(没有项目的任务)跑在咕咕自己的 `task-home` 目录里 —— 每个咕咕实例
 * (每个 userData)各有一个,本机引擎原件里凡是 cwd 落在某个 `task-home` 下的,都是咕咕独立任务留下的。
 * 它们按目录分会碎成一个实例一节(mac1 2026-09-24:上千节里大半是 `…-profile/task-home`),所以与咕咕
 * 自己的独立任务一起拢成这一节(owner 2026-09-24 拍板)。不是路径(没有 `/` 开头、没有盘符),与真目录不会撞。
 */
export const SESSION_HOME_SECTION_KEY = 'gugu:task-home';

/** 这个目录是不是(或在)某个咕咕实例的 `task-home` 里。 */
export function isSessionHomeDirectory(directory: string): boolean {
  return /(^|[\\/])task-home([\\/]|$)/.test(directory);
}

export type SessionHistoryGuguRef = {
  projectId: string;
  sessionId: string;
  runtime: SessionRuntime;
};

export type SessionHistoryRow = {
  /** 稳定的行身份:咕咕行按 conversation id,本机行按文件路径(同一 session id 可能出现在两个文件里)。 */
  key: string;
  source: SessionHistorySource;
  status: SessionHistoryStatus;
  title: string;
  /** provider 的 session id:咕咕行 = `sessions.provider_session_id`(没绑的为 null);本机行 = 原件里的 session id。可搜。 */
  providerSessionId: string | null;
  /** 跑这条会话的 agent(会话页 provider id,给 AgentIcon 用):咕咕行 = `sessions.provider`;本机行按引擎映射。 */
  providerId: string | null;
  /** 会话运行的目录:咕咕行 = 工作区路径(没有就是项目路径);本机行 = transcript 记的 cwd。 */
  directory: string | null;
  /** 咕咕行所属项目的名字;独立任务(隐藏的 task-home 项目)与本机行为 null。 */
  projectName: string | null;
  /** epoch ms。咕咕行 = `updated_at`;本机行 = transcript 文件 mtime。 */
  updatedAt: number;
  /**
   * 最近一次提问(epoch ms)。咕咕行 = `last_interacted_at`;本机 transcript 没有单独的提问时间,
   * 取文件更新时间 —— 这是**明写的近似**,不是兜底。
   */
  lastPromptAt: number | null;
  /** 加入咕咕的时间(epoch ms);还没导入的本机行没有,为 null。 */
  addedAt: number | null;
  archivedAt: number | null;
  /** 挂在它下面的后代条数(与 session-descendants 同一条父会话边;fork 不算)。 */
  childCount: number;
  /** 它挂在哪条会话下面;根会话为 null。 */
  parentTitle: string | null;
  /** 咕咕行:打开 / 恢复要的坐标。 */
  gugu?: SessionHistoryGuguRef;
  /** 本机行:导入管道要的原件信息。 */
  local?: LocalSessionRow;
};

export type SessionHistoryPage = {
  rows: SessionHistoryRow[];
  /** 命中筛选的总条数(可能多于 rows —— rows 按 limit 截过)。 */
  matched: number;
  /** 各来源 / 各状态各有多少条(不受筛选影响,给筛选菜单当计数)。 */
  countsBySource: Record<SessionHistorySource, number>;
  countsByStatus: Record<SessionHistoryStatus, number>;
  /** 出现过的目录及条数,按条数倒序 —— 目录下拉的候选;`directory: null` 那条是「没有目录」的会话。 */
  directories: Array<{ directory: string | null; projectName: string | null; count: number }>;
  /** 本机索引进度;宿主没接本机来源(web)时为 null,此时只有咕咕自己的会话。 */
  local: { discovered: number; indexed: number; pending: number; stale: boolean } | null;
};

/** 目录视图的一节 = 一个目录(筛选之后)里的会话聚合 + 头几条会话。 */
export type SessionHistoryDirectoryRow = {
  /** 稳定身份:目录路径;没有目录的那一节为 ''。 */
  key: string;
  directory: string | null;
  /** 目录所属的咕咕项目名:目录就是项目路径、或在项目路径之下(最长前缀优先);都不是为 null。 */
  projectName: string | null;
  sessionCount: number;
  countsBySource: Record<SessionHistorySource, number>;
  countsByStatus: Record<SessionHistoryStatus, number>;
  /** 这个目录里出现过的 agent(provider id,按首次出现排)—— 节头上画成一排图标。 */
  providers: string[];
  /** 目录里最近那条的时间(epoch ms);没有那种时间的目录(全是未导入 ⇒ 没有加入时间)为 null。 */
  updatedAt: number;
  lastPromptAt: number | null;
  addedAt: number | null;
  /** 按 sort 排好的头 `sessionsPerDirectory` 条;没要就是空数组。 */
  sessions: SessionHistoryRow[];
};

/**
 * 列表里显示的标题。整份投递信封取正文(读方与投递卡同一个)。
 *
 * 读不出、却以标签开头的,只为库里**已存**的截断标题存在:导入曾把首轮原文截进标题,截断的信封头读不出来。
 * 新数据的兜底标题在 transcriptInventory 已经取正文,不走这里。剥掉标签与 CDATA 包装、压空白;
 * 剥完为空(只截到了信封头)返回 '',渲染层显示「无标题会话」。
 */
export function displaySessionTitle(raw: string): string {
  const delivery = readDeliveryEnvelope(raw);
  if (delivery) return delivery.body.replace(/\s+/g, ' ').trim();
  // 正文里恰好有 `<` 的普通标题原样留着。
  if (!/^\s*<[a-z_][\w-]*[\s>]/i.test(raw)) return raw.trim();
  return raw
    .replace(/<!\[CDATA\[|\]\]>/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/<[^>]*$/, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export type SessionHistoryDirectoryPage = {
  rows: SessionHistoryDirectoryRow[];
  /** 命中筛选的目录总数(rows 按 limit 截过)。 */
  matched: number;
  countsBySource: Record<SessionHistorySource, number>;
  countsByStatus: Record<SessionHistoryStatus, number>;
  directories: SessionHistoryPage['directories'];
  local: SessionHistoryPage['local'];
};
