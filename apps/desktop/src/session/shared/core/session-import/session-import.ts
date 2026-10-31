// @@@sessionpage 导入本机已有会话 (spec session-page-import)。
// 用户在别处（Claude Code / Codex 命令行）已经聊过的会话，从会话页选进来继续聊。
// 导入的不是一份历史副本 —— conversation 绑定 provider 自己的 session id，
// 下次启动直接 resume 原会话，上下文是 provider 那边的原件。

/**
 * 本机可导入的 agent 引擎。值与 gugu core 的 `TRANSCRIPT_SOURCE_IDS` 一一对应
 * （packages/core/src/shared/types/transcripts.ts）。
 *
 * ⚠️ 这里是**手抄**：会话页这棵树按结构对接、不跨包 import core，所以 core 那边接通了新引擎、
 * 这里没跟上时 tsc 一个字都不会说 —— 表现是「索引里数得到、面板上筛不出来」。
 * 三张表（本 union + 下面的 PROVIDER / LABEL）由
 * `tests/unit/core/local/transcriptSources.test.ts` 与 core 双向对账。
 */
export type LocalSessionEngine = 'claude-code' | 'codex';

/** 会话清单里的一行。 */
export type LocalSessionRow = {
  engine: LocalSessionEngine;
  /** provider 自己的会话 id —— 恢复会话靠它。 */
  providerSessionId: string;
  title: string;
  /** 原会话运行时所在的文件夹；读不出时为 null。 */
  cwd: string | null;
  filePath: string;
  /** transcript 文件 mtime（epoch ms）。 */
  updatedAt: number;
  sizeBytes: number;
};

export type ListLocalSessionsParams = {
  cwd?: string;
  filePath?: string;
  offset?: number;
  /** 只看某个引擎的会话。 */
  engine?: LocalSessionEngine;
  /** 关键词：匹配标题与文件夹，空格分词全部命中。 */
  query?: string;
  limit?: number;
  /**
   * 'cached' = 只用上次索引结果，毫秒级返回（面板打开的第一帧）；
   * 'fresh'（默认）= 对账磁盘，并顺带索引一批还没读过的会话。
   */
  mode?: 'cached' | 'fresh';
  /** 本轮花在索引新会话上的时间上限（ms）。 */
  hydrateBudgetMs?: number;
};

export type ListLocalSessionsResult = {
  rows: LocalSessionRow[];
  /** 命中筛选的总条数（在已索引的会话里）。 */
  matched: number;
  /** 本机发现的会话文件总数。 */
  discovered: number;
  /** 已索引（因而可被搜索到）的文件数。 */
  indexed: number;
  /** 还没索引的文件数；>0 表示继续调用会搜出更多。 */
  pending: number;
  /** 各引擎已索引出多少条可导入会话。索引没走完时会一轮轮变大。 */
  countsByEngine: Record<LocalSessionEngine, number>;
  /** true = 这页来自缓存、没对过盘。 */
  stale: boolean;
};

export type LocalSessionTurn = {
  role: 'user' | 'assistant';
  content: string;
  /** provider transcript 里的原始时间；没有或非法时为 null。 */
  createdAt: string | null;
};

export type PreviewLocalSessionParams = {
  filePath: string;
  engine: LocalSessionEngine;
};

/** 导入前的确认信息：真读了文件，条数与内容都是原件里的。 */
export type LocalSessionPreview = {
  providerSessionId: string;
  title: string;
  cwd: string | null;
  /** 真实对话轮次数（工具调用/思考不计）。 */
  turnCount: number;
  /** 开头几轮，用来确认「是这条会话」。 */
  head: LocalSessionTurn[];
  /** 最后几轮，用来确认「聊到哪了」。 */
  tail: LocalSessionTurn[];
};

export type ImportLocalSessionParams = {
  engine: LocalSessionEngine;
  providerSessionId: string;
  filePath: string;
  title: string;
  cwd: string | null;
  /**
   * 接进来之后在哪种展示里接着聊。缺席 = 'code'(终端里 resume 原会话,本机与 SSH 装上的机器)。
   * #6264 只经远程隧道连着的机器没有终端 → 'general':聊天腿用 ACP `session/load` 续同一个
   * provider 会话 id(claude-agent-acp 与 codex-acp 都声明了 loadSession),历史照样接上。
   */
  sessionView?: 'code' | 'general';
};

export type ImportLocalSessionResult = {
  projectId: string;
  sessionId: string;
  /** 会话将要运行的目录 —— 就是原会话的工作目录（非 git 目录也照原样用）。 */
  workingDirectory: string;
  /** true = 这条会话之前已经导入过，这次直接打开原来那个，不重复建。 */
  alreadyImported: boolean;
};

/** 引擎 → 会话页 provider id。两边的命名不同，映射只此一处。 */
export const LOCAL_SESSION_ENGINE_PROVIDER: Record<LocalSessionEngine, string> = {
  'claude-code': 'claude',
  codex: 'codex',
};

export const LOCAL_SESSION_ENGINE_LABEL: Record<LocalSessionEngine, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
};
