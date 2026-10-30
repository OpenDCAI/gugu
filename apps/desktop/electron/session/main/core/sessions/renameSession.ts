import { eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { events } from '@main/lib/events';
import type {
  SessionConfig,
  SessionTitleSource,
} from '@shared/core/sessions/session-config';
import { sessionTitleFromPrompt } from '@shared/core/sessions/session-title';
import { sessionChangedChannel } from '@shared/core/sessions/sessionEvents';
import { MAX_SESSION_TITLE_LENGTH } from '@shared/core/sessions/sessions';
import { sessionEvents } from './session-events';
import { taskAgentName, taskAgentNameLength, MAX_AUTOMATIC_TASK_AGENT_NAME_GRAPHEMES } from '@gugu/core/shared/taskAgentName';

type IdentityRename = (sessionId: string, name: string, source: 'manual' | 'generated') => Promise<boolean | null>;
let renameIdentity: IdentityRename | undefined;

/** The host owns the task → identity binding and the authenticated cloud write. */
export function setTaskIdentityRename(rename: IdentityRename | undefined): void {
  renameIdentity = rename;
}

type TitleRow = {
  title: string;
  provider: string | null;
  config: SessionConfig | null;
};

/** 人或 agent 在咕咕里显式改名(侧栏、手机、页签)。显式命名是最高档:此后自动起的名不再盖它。 */
export async function renameSession(sessionId: string, name: string) {
  name = taskAgentName(name);
  if (renameIdentity && await renameIdentity(sessionId, name, 'manual') !== null) return;
  writeSessionTitle(sessionId, name, 'manual', () => true);
}

/**
 * harness 自己起的会话名(ACP `session_info_update` / `session/list`、宿主持有的控制通道上的改名事件)。
 * 只盖首轮兜底和它自己上一次起的名,❌ 盖显式命名,❌ 盖咕咕已经起好的名(自动名先到先得,#7337);
 * 只是首轮原文的「名」不收。返回这一次是否真的改了标题。
 */
export function applyHarnessTitle(sessionId: string, title: string): boolean {
  return writeSessionTitle(sessionId, title, 'harness', (row, next) => {
    if (row.config?.identityNameManaged) return false;
    const source = titleSourceOf(row);
    return source !== 'manual' && source !== 'generated' && !isFirstPromptEcho(next, row.config?.firstUtterance);
  });
}

/**
 * 咕咕拿首轮找平台模型起的名(#7337)。只盖首轮兜底:harness 已经起过名、或人已经改过名,就不收 ——
 * 自动名先到先得、只起一次。判断与写入在同一个同步事务里,模型回来的那一刻才看,❌ 在发请求时看
 * (请求在路上的几秒里,人可能刚改了名)。返回这一次是否真的改了标题。
 */
export function applyGeneratedTitle(sessionId: string, title: string): boolean | Promise<boolean> {
  title = title.trim();
  if (!title || taskAgentNameLength(title) > MAX_AUTOMATIC_TASK_AGENT_NAME_GRAPHEMES) return false;
  const state = sessionTitleIsFallback(sessionId);
  if (!state.fallback || isFirstPromptEcho(title, state.firstUtterance)) return false;
  if (renameIdentity) return renameIdentity(sessionId, title, 'generated').then((applied) =>
    applied ?? writeSessionTitle(sessionId, title, 'generated', (row) => titleSourceOf(row) === undefined));
  return writeSessionTitle(sessionId, title, 'generated', (row, next) =>
    titleSourceOf(row) === undefined && !isFirstPromptEcho(next, row.config?.firstUtterance)
  );
}

/** Adopt a canonical identity name on its host, without renaming the identity again. */
export function mirrorTaskIdentityName(sessionId: string, name: string, source?: SessionTitleSource): void {
  const written = db.transaction((tx) => {
    const row = tx.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    if (!row) return null;
    const config = row.config ?? { version: '1' as const, type: row.runtime };
    const titleSource = source ?? (config.identityNameManaged && config.agentDisplayName && row.title !== name ? 'manual' : config.titleSource);
    if (row.title === name && config.agentDisplayName === name && config.identityNameManaged && config.titleSource === titleSource) return null;
    tx.update(sessions).set({ title: name, config: { ...config, agentDisplayName: name, identityNameManaged: true, titleSource } })
      .where(eq(sessions.id, sessionId)).run();
    return row;
  });
  if (!written || written.title === name) return;
  sessionEvents._emit('session:renamed', sessionId, written.projectId, name);
  events.emit(sessionChangedChannel, { sessionId, projectId: written.projectId, changes: { title: name, agentDisplayName: name } });
}

/**
 * 这条会话的标题此刻还是不是首轮兜底 —— 咕咕起名前问一句,省掉一次注定落不下的模型调用。
 * 只是省钱的预判:真正的判据在 `applyGeneratedTitle` 落库那一刻。
 */
export function sessionTitleIsFallback(sessionId: string): { fallback: boolean; firstUtterance: string | undefined } {
  const row = db
    .select({ title: sessions.title, provider: sessions.provider, config: sessions.config })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1)
    .get();
  if (!row) return { fallback: false, firstUtterance: undefined };
  return { fallback: titleSourceOf(row) === undefined, firstUtterance: row.config?.firstUtterance };
}

/**
 * 标题与它的来历(`config.titleSource`)只在这里一起写。读与写在同一个**同步**事务里:
 * `config` 里同住着别的事实,两次 `await` 读再写会拿过期的 config 盖掉别人刚落的键。
 *
 * 标题变了就同时发两条:主进程内部钩子(搜索索引)与 `sessionChangedChannel`(渲染层的会话 store
 * 只听这一条)。只发前者的话,不是本渲染层自己发起的改名要等 reload 才看得见(#5925)。
 */
function writeSessionTitle(
  sessionId: string,
  rawTitle: string,
  source: SessionTitleSource,
  accept: (row: TitleRow, title: string) => boolean
): boolean {
  const title = source === 'manual' ? rawTitle.trim() : collapse(rawTitle).slice(0, MAX_SESSION_TITLE_LENGTH);
  if (!title) return false;

  const written = db.transaction((tx) => {
    const row = tx
      .select({
        projectId: sessions.projectId,
        title: sessions.title,
        provider: sessions.provider,
        config: sessions.config,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1)
      .get();
    if (!row || !accept(row, title)) return null;
    if (row.title === title && row.config?.titleSource === source) return null;

    // 老会话的 config 可能是 null:那一行记不下来历,由 `titleSourceOf` 按标题形状判。
    tx.update(sessions)
      .set({ title, ...(row.config && { config: { ...row.config, titleSource: source,
        ...(source === 'manual' ? { agentDisplayName: title } : {}) } }) })
      .where(eq(sessions.id, sessionId))
      .run();
    return row;
  });
  if (!written || written.title === title) return false;

  sessionEvents._emit('session:renamed', sessionId, written.projectId, title);
  events.emit(sessionChangedChannel, {
    sessionId,
    projectId: written.projectId,
    changes: { title },
  });
  return true;
}

/**
 * 这一行标题的来历。`titleSource` 出现之前落库的会话没有这一格:标题正好是咕咕自己推出来的兜底
 * 形状才算兜底,别的一律按显式命名 —— 那时 `session_spawn` 的 title、聊天页 agent 的名字、侧栏改过的名、
 * 分叉名都长在同一列里,❌ 升级之后被 harness 起的名盖掉。
 */
function titleSourceOf(row: TitleRow): SessionTitleSource | undefined {
  if (row.config?.identityNameManaged) return row.config.titleSource;
  const recorded = row.config?.titleSource;
  if (recorded) return recorded;
  return isDerivedFallbackTitle(row.title, row.config?.firstUtterance, row.provider) ? undefined : 'manual';
}

/**
 * 咕咕自己推兜底标题的几处,形状逐一对上:composer / 手机新建(`sessionTitleFromPrompt`)、
 * 没有首轮时的引擎计数(`Claude (1)`,`nextDefaultSessionTitle`)、`session_spawn` 没给 title
 * (首轮第一行)、扩展派活没给 title(整句首轮截断)。
 */
function isDerivedFallbackTitle(title: string, firstUtterance: string | undefined, provider: string | null): boolean {
  if (provider && title.toLowerCase().startsWith(`${provider.toLowerCase()} (`) && /\(\d+\)$/.test(title)) return true;
  const prompt = firstUtterance ?? '';
  if (!prompt.trim()) return false;
  const firstLine = prompt.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '';
  return [
    sessionTitleFromPrompt(prompt),
    firstLine.slice(0, MAX_SESSION_TITLE_LENGTH),
    prompt.slice(0, MAX_SESSION_TITLE_LENGTH),
  ].includes(title);
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * harness 报来的「名」其实只是首轮原文 —— 那是兜底档,不是它起的名:Claude 的 ACP 桥起名失败时回退
 * `summary`(= 原样的首轮,最长 256 字)、Copilot 的默认名就是首条消息。收下它只会把咕咕 40 字的兜底
 * 换成一整句提示词。咕咕递进去的首轮可能裹着壳(派活的 `<gugu_delivery …>`),回退出来的是壳 ——
 * 起出来的名不会以标签开头。
 */
function isFirstPromptEcho(title: string, firstUtterance: string | undefined): boolean {
  if (/^<[a-z_][\w-]*[\s>]/i.test(title)) return true;
  const prompt = collapse(firstUtterance ?? '');
  if (!prompt) return false;
  const head = title.replace(/(…|\.\.\.)$/, '').trimEnd();
  // 截断的回声(前缀 ≥ 40 字)与带尾巴的回声(以整句首轮开头,如首条消息后面拼了别的块)都算。
  return head === prompt
    || (head.length >= 40 && prompt.startsWith(head))
    || (prompt.length >= 20 && head.startsWith(prompt));
}
