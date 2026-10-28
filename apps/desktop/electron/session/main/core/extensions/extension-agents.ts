import { agentIdsBySession } from '@main/core/sessionpage/sessionpage-session-agent';
import { readAcpSessionSummaries } from '@main/core/acp/session-summary-reader';
import type { TranscriptTurn } from '@gugu/session-core/acp';
import type { SessionpageSessionSummary, UnreachedMachine } from '@gugu/session-core/session-record/contract';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { log } from '@main/lib/logger';
import { eq } from 'drizzle-orm';
import { sessionModelLabel, sessionPlatformModel } from '@main/core/sessions/platform-model-selection';
import { sessionModelFromDecision } from '@main/core/sessions/session-model-fact';
import { refuseItself } from '@main/core/sessions/utils';
import type {
  ExtensionAgentHistoryPage,
  ExtensionAgentMessage,
  ExtensionAgentView,
} from '@shared/extensions/bridge-protocol';
import { agentViewOf, type ListedSession } from '@shared/extensions/agent-view';
import type { AgentReach } from '@shared/extensions/manifest';
import type { AgentEvent } from '@shared/core/agents/agentEvents';

// What an extension is allowed to see of, and do to, the agents at work.
//
// A door of its own, rather than a reuse of `runSessionAction`: that entry is
// caller-scoped and its caller type is a conversation. An extension is not a
// conversation, and making it borrow one would put a false originator into the
// session graph — the exact modelling gap flagged in behavior tab-extensions
//「agent 的可见与可控」. So this reads and writes the same facts through its own.
//
// ❌ 别往 `ExtensionAgentView` 上加字段:那份视图的边界就是 behavior 里列的那些
//(身份与形态 —— 引擎和它的模型,是 spawnAgent 照它起一条时要传的 —— 是不是这个扩展起的 + 活着的状态)。对话内容是另一档能力,走
// `readAgentHistoryForExtension`,不从清单那条路漏出去。

/** 一个扩展的一档 agent 能力够得着谁:声明的宽窄、它是谁。 */
export interface ExtensionAgentScope {
  scope: AgentReach;
  extensionId: string;
}

/** 一行会话:界面那份会话列表的一行(本机或别的机器),标上它在哪台机器(本机 = null)。 */


const agentIdOf = (session: SessionpageSessionSummary) => (session.agent ? `user:${session.agent.userId}` : null);

/**
 * The one place that decides which agents a scope covers on this computer — the listing, every range check and
 * dispatch to an agent all read it, so「能看见谁」has one answer (两处各算一次,漂了的那次一定是放行的那次)。
 * 行就是界面那份会话列表(`listSessions`:本机库 + 名录,不碰 ACP 运行时)。
 * `own` = 这个 App 自己起的(真源原则 13:位置不决定能力);`all` / `all-machines` = 这台机器上的全部。
 */
async function localSessions(options: ExtensionAgentScope): Promise<ListedSession[]> {
  // 惰性 import:会话列表那一侧连着整条时间线栈,桥的模块图不该为它变重。
  const { listSessions } = await import('@main/core/session-timeline/service');
  return (await listSessions()).sessions
    .filter((session) => options.scope !== 'own' || session.spawnedByExtensionId === options.extensionId)
    .map((session) => ({ session, deviceId: null, deviceLabel: null }));
}

/**
 * 别的机器上的会话(`all-machines`):每台在线机器报的界面那份列表(与「归档连同子会话」同一个来源)。
 * 行上不带 `agent` 的机器是协议 7 之前的老宿主,它的 agent 认不出来 —— 记成没读到,❌ 当成那台机器上没有 agent。
 */
export async function sessionsElsewhere(): Promise<{ rows: ListedSession[]; unreached: UnreachedMachine[] }> {
  const { otherMachines } = await import('@main/core/sessions/session-family');
  const { sessions: listed, unreached } = await otherMachines().sessions(null);
  const old = new Map(listed.filter(({ session }) => session.agent === undefined).map(({ deviceId, label }) => [deviceId, label]));
  for (const [deviceId, label] of old) {
    unreached.push({ deviceId, label, detail: `"${label}" (device:${deviceId}) runs a gugu too old to list its agents; it updates itself when idle` });
  }
  const rows = listed.filter(({ deviceId }) => !old.has(deviceId)).map(({ deviceId, label, session }) => ({ session, deviceId, deviceLabel: label }));
  return { rows, unreached };
}

/**
 * The agents a scope covers here, by the id an App names them with (`user:<uuid>`, F35) → the session behind each: for
 * the verbs that only ask「够得着吗」(no ACP summaries read — a range check must not boot the runtime). A session with no
 * identity yet has nothing to be named by, so it is not among them.
 */
export async function visibleAgentsForExtension(options: ExtensionAgentScope): Promise<Map<string, string>> {
  return new Map((await localSessions(options)).flatMap(({ session }) => {
    const agentId = agentIdOf(session);
    return agentId ? [[agentId, session.conversationId] as const] : [];
  }));
}

/**
 * Every agent this surface may see. `scope` is decided by the caller from what the extension declared — this function
 * does not read permissions, so there is exactly one place where a wider answer can be granted.
 */
export async function listAgentsForExtension(
  options: ExtensionAgentScope
): Promise<{ agents: ExtensionAgentView[]; unreached: UnreachedMachine[] }> {
  const [here, elsewhere, summaries] = await Promise.all([
    localSessions(options),
    options.scope === 'all-machines' ? sessionsElsewhere() : { rows: [], unreached: [] },
    // 运行时读不出来时清单不塌、身份照给、计数为空(behavior:「如实给空」)——但 ❌ 不许静默:那样「运行时挂了」和
    // 「一个活会话都没有」在日志里也长得一样,而这两件事的处置完全不同。
    readAcpSessionSummaries().catch((error: unknown) => {
      log.warn('extension agent listing: ACP runtime summaries unavailable, counters fall back to null', {
        error: error instanceof Error ? error.message : String(error),
      });
      return {} as Record<string, never>;
    }),
  ]);
  const rows = [...here, ...elsewhere.rows];
  const agentOf = new Map(rows.flatMap(({ session }) => {
    const agentId = agentIdOf(session);
    return agentId ? [[session.conversationId, agentId] as const] : [];
  }));
  // Its model as `session_spawn` / `spawnAgent` take it back (`spawn_model_id`): a Gugu model's `platform:<id>`, else
  // the harness's own; null when the session never chose one. 只有本机的行读得到。
  const harnessModels = new Map((await db.select({ id: sessions.id, config: sessions.config }).from(sessions)).map((row) => [row.id, row.config?.model ?? null]));
  // A Gugu model's name as the model menu shows it, kept with the session's decision (read once per session and model).
  const models = new Map(await Promise.all(here.map(async ({ session: { conversationId: id, harness, runtime } }) => {
    const decision = await sessionPlatformModel(id);
    const model = sessionModelFromDecision(decision, harnessModels.get(id) ?? null).spawn_model_id ?? null;
    return [id, { model, modelLabel: await sessionModelLabel(id, decision, harness, runtime) }] as const;
  })));
  const agents = rows.flatMap((row) => {
    const id = row.session.conversationId;
    return agentViewOf(row, agentOf, options.extensionId, row.deviceId === null ? { summary: summaries[id], model: models.get(id)?.model ?? null, modelLabel: models.get(id)?.modelLabel ?? null } : null) ?? [];
  });
  return { agents, unreached: elsewhere.unreached };
}

/**
 * How many turns one read may hand over.
 *
 * A long-running agent's conversation is unbounded; a surface that asked for
 * "everything" would get a payload that has to cross an IPC boundary and then
 * be held in a renderer. So it is capped — and the caller gets a cursor to walk
 * back with. Capping without a cursor would hand back a record that looks
 * complete and is not, which is worse than a short answer.
 */
const HISTORY_PAGE = 100;

/**
 * What each agent said last as its turn stopped, as its harness's Stop hook handed it over (`last_assistant_message`) —
 * until its next prompt starts (#7126, 148 10-13). Claude Code writes its transcript asynchronously: the record "may not
 * yet include the current turn's most recent messages when a hook fires … use `last_assistant_message` on Stop" (its
 * hooks docs). A claude in a terminal stops — its status goes idle, the radar reads — before its answer is in its record.
 * In main's memory only: after a restart the record caught up long ago.
 */
const lastWords = new Map<string, { text: string; at: number }>();

/** The hook bus (embedded-boot): a turn of an agent's own started or stopped. A subagent's are not its. */
export function heardAgentEvent(event: AgentEvent): void {
  if (event.payload.origin === 'subagent') return;
  if (event.type === 'start') lastWords.delete(event.sessionId);
  if (event.type !== 'stop') return;
  const text = event.payload.lastAssistantMessage?.trim();
  if (text) lastWords.set(event.sessionId, { text, at: event.timestamp });
  else lastWords.delete(event.sessionId);
}

/**
 * The newest page, its newest prompt still without words after it in the record: the words this agent's Stop hook said
 * for it, as its answer. Once the record has them, the record's are the answer — never both. Only a stop whose hook
 * arrived after the prompt began is its answer (`AgentEvent.timestamp` is the hook's arrival, hook-server.ts).
 */
function withLastWords(sessionId: string, turns: readonly TranscriptTurn[], messages: ExtensionAgentMessage[]): ExtensionAgentMessage[] {
  const said = lastWords.get(sessionId);
  let prompt = messages.length - 1;
  while (prompt >= 0 && messages[prompt]!.sender !== 'user') prompt--;
  if (!said || prompt < 0 || messages.slice(prompt + 1).some((message) => message.sender === 'assistant')) return messages;
  const turn = turns.find((candidate) => candidate.id === messages[prompt]!.turnId)!;
  // Whose words: a stop that reached gugu after this prompt began (both on this machine's clock — the hook's arrival,
  // the record's start). A prompt with no time is not filled: better unread once than another round's words.
  if (turn.startedAt === undefined || said.at < turn.startedAt) return messages;
  return [...messages, { ...messages[prompt]!, messageId: `${turn.id}:stop`, sender: 'assistant', text: said.text }];
}

/** A refusal an App branches on by its `code` (bridge-protocol.ts `bridgeFailure`); the message is for its author. */
const refused = (code: 'not-found' | 'invalid' | 'unavailable' | 'failed', message: string) => Object.assign(new Error(message), { code });

/**
 * 措辞与「这个 agent 不存在」一致:一个不可见的 agent 存不存在,本身就是这个扩展无权知道的事。❌ 别用「无权限」把存在性
 * 泄露出去。码也一样是 `not-found`,和 messageAgent 够不着时同一个口径(extension-send.ts)。
 */
const notVisible = (agentId: string) => refused('not-found', `No agent "${agentId}" is visible to this App`);

/**
 * One page of an agent's conversation.
 *
 * **先读它自己那家 harness 落在盘上的记录**(claude / codex / opencode,session-timeline `recordHistoryPage`):会话页和
 * 手机读的就是这一份,所以终端里的 agent、此刻没打开的面板 agent,都和开着的一样读得到(#7126:雷达「做完了」的提醒里,
 * 终端 agent 一律没有最后一句;面板 agent 空闲约 10 分钟被回收后也只剩「not open」)。读记录是只读的:开一个读头,
 * 不起引擎。
 *
 * 记录读不了(这一家的记录咕咕不解码,或会话还没真正开出来)时,开着的面板 agent 退回问运行时 —— 它内存里那份就是它的
 * 对话。❌ 别为了读而 `startSession`:那会让一个只声明了 `agents:history` 的 App 有能力**开引擎**,读能力就地变成控制
 * 能力,而用户在安装那一刻同意的是「读」。问运行时会顺带把 **ACP 运行时宿主进程**初始化起来 —— 那是咕咕自己的进程,
 * 不是任何引擎,和「起一个 agent」是两回事。
 *
 * 两条都读不到就响亮地拒绝(`unavailable`),❌ 回空数组:那和「这个 agent 确实没说过话」一模一样,调用方会把「读不到」
 * 读成「没内容」。❌ 别读 sqlite 的 `messages` 表:那张表在这棵树上一个写入方都没有,从它读出来的永远是空。
 *
 * ⚠️ 分页按**轮次**、过滤按**条目**,所以一页可以是空的而 `nextCursor` 不为 null —— 那一百轮里全是思考与工具调用,一句话
 * 没说。判据只能看 `nextCursor`:它为 null 才是到头了。❌ 别为了让空页消失就在这里循环翻页。
 *
 * `visibleAgents` is what this extension may see under its declared scope, computed by the caller from the same listing
 * this file already produces. An agent outside it is refused rather than read: otherwise `agents:history` would quietly
 * reach further than the declared scope, and「默认最小」would be decorative on the one capability where it matters most.
 */
export async function readAgentHistoryForExtension(options: {
  agentId: string;
  visibleAgents: ReadonlyMap<string, string>;
  before?: number;
}): Promise<ExtensionAgentHistoryPage> {
  const sessionId = options.visibleAgents.get(options.agentId);
  if (!sessionId) throw notVisible(options.agentId);
  const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
  if (!row) throw notVisible(options.agentId);

  const { recordHistoryPage } = await import('@main/core/session-timeline/service');
  const record = await recordHistoryPage({
    conversationId: sessionId,
    limit: HISTORY_PAGE,
    ...(options.before === undefined ? {} : { beforeSeq: options.before }),
  });
  // 记录不在这台机器上(record_not_found)与「没有自己的记录」同论:往下问运行时。读得到却读不动是本机故障,如实报。
  if (!record.ok) {
    if (record.error.code !== 'record_not_found') throw refused('failed', `Could not read that agent's conversation: ${record.error.message}`);
  } else if (record.value === 'no-such-turn') {
    throw refused('invalid', 'before is not a turn of that agent\'s conversation: pass back a page\'s nextCursor');
  } else if (record.value !== 'no-record') {
    const { turns, hasOlder } = record.value;
    const messages = messagesOf(turns);
    // 最新一页的「最后一句」:记录还没追上时用它停下那一刻 hook 给的那句(claude 在终端里先停、后写)。往前翻的页不补。
    return {
      messages: options.before === undefined ? withLastWords(sessionId, turns, messages) : messages,
      nextCursor: hasOlder && turns.length > 0 ? turns[0]!.seq : null,
    };
  }

  // 一条会话出现在 sessions.list 里 ⇔ 运行时有它的活 cell(start/sync 时 upsert,removeRecord/进程关闭时 delete)。
  if (row.runtime === 'acp' && (await readAcpSessionSummaries())[sessionId]) {
    const { getAcpRuntimeClient } = await import('@main/core/acp/controller');
    const result = await (await getAcpRuntimeClient()).getHistory({
      sessionId,
      limit: HISTORY_PAGE,
      ...(options.before === undefined ? {} : { before: options.before }),
    });
    if (!result.success) throw refused('failed', `Could not read that agent's session: ${JSON.stringify(result)}`);
    return { messages: messagesOf(result.data.turns), nextCursor: result.data.nextCursor };
  }
  throw refused(
    'unavailable',
    row.runtime === 'acp'
      ? 'that agent is not open, and gugu cannot read the record its engine keeps — open it in gugu first'
      : 'gugu cannot read that agent\'s conversation: its engine keeps no record gugu reads (claude, codex and opencode do)'
  );
}


/** The turns' messages, as an App sees them. */
function messagesOf(turns: readonly TranscriptTurn[]): ExtensionAgentMessage[] {
  const messages: ExtensionAgentMessage[] = [];
  for (const turn of turns) {
    for (const item of turn.items) {
      // 只给「说过的话」。思考过程与工具调用是另一类东西,形状也随实现而变——
      // 把它们塞进同一个数组,等于让每个扩展绑死在一个会变的内部模型上。
      if (item.kind !== 'message') continue;
      messages.push({
        messageId: item.id,
        sender: item.role,
        text: item.text,
        turnId: turn.id,
        seq: turn.seq,
        // 运行时给的是 epoch 毫秒,公开面统一成 ISO——`updatedAt` 已经是 ISO,
        // 同一张表上两种时间格式是坑。这一道换算无损且无时区歧义(与 `updatedAt`
        // 那边「解析一段已存文本」不是一回事,所以那边原样透传、这边转)。
        // 缺席即「不知道」,❌ 不拿当下时间冒充:重放出来的轮次没有真时钟。
        startedAt: turn.startedAt === undefined ? null : new Date(turn.startedAt).toISOString(),
      });
    }
  }
  return messages;
}

/**
 * Stop one agent.
 *
 * Built on the same two primitives the host's own stop uses, rather than on
 * `runSessionAction`: that entry resolves a *caller conversation* first, and an
 * extension has none. Borrowing one would put a false originator into the
 * session graph — the modelling gap behavior tab-extensions names.
 *
 * ❌ 这里没有第二道闸:谨慎发生在安装那一刻。有的只是范围——看不见的 agent 停不了。
 */
export async function stopAgentForExtension(options: {
  agentId: string;
  visibleAgents: ReadonlyMap<string, string>;
  /** The session of the agent that works the page (owner 10-14): it cannot stop itself, as with session_stop. */
  bySession?: string;
}): Promise<void> {
  const sessionId = options.visibleAgents.get(options.agentId);
  if (!sessionId) throw notVisible(options.agentId);
  refuseItself('stop', sessionId, options.bySession);
  const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
  if (!row) throw notVisible(options.agentId);

  if (row.runtime === 'acp') {
    const { getAcpRuntimeClient } = await import('@main/core/acp/controller');
    const result = await (await getAcpRuntimeClient()).stopSession({ sessionId: row.id });
    if (!result.success) throw new Error(`Could not stop that agent: ${JSON.stringify(result)}`);
    return;
  }
  const { resolveSession } = await import('@main/core/projects/utils');
  const session = resolveSession(row.projectId, row.id);
  if (!session) throw new Error('that agent\'s session workspace is not mounted');
  await session.sessions.stopSession(row.id);
}

/**
 * `gugu.dispatch(prompt, { to: { new: true }, spawn: { title, harness, model, transport, project, chat } })`: a new agent — a session of its own —
 * started as the person starts one, through the one spawn core `session_spawn` uses (`spawnSessionForApp`): where and on
 * what the call names, else what the person's new-session box would pick; never from the session a page sits in (真源原则 13).
 *
 * Its first turn wears the App's envelope (来自「扩展名」): the agent reads it came from this App, ❌ 当成人当面敲的.
 * The row records `spawnedByExtensionId`, so「谁起的」is answerable later — after the App is gone too — and it is what
 * keeps the agent in this App's `own` scope. Answered by the agent's identity, the id every agent verb takes, once its
 * session has started (that is when the roster has it). `bySession`: the session of the agent that works the page.
 */
export async function spawnAgentForExtension(options: {
  extensionId: string;
  extensionName: string;
  bySession?: string;
  prompt: string;
  title?: string;
  harness?: string;
  model?: string;
  transport?: 'acp' | 'pty';
  project?: string;
  chat?: string;
  device?: string;
}): Promise<{ agentId: string }> {
  const { buildExtensionEnvelope, formatDeliveryTimestamp } = await import('@gugu/core/local/agent/deliveryEnvelope');
  const { spawnSessionForApp } = await import('@main/core/sessions/session-orchestration');
  const row = await spawnSessionForApp({
    ...options,
    envelope: (messageId, content) =>
      buildExtensionEnvelope({
        extensionId: options.extensionId,
        extensionName: options.extensionName,
        messageId,
        content,
        at: formatDeliveryTimestamp(new Date().toISOString()),
      }),
  });
  if ('agentId' in row) return row;
  const appId = (await agentIdsBySession(process.env)).get(row.id);
  if (!appId) throw new Error('the agent was started but has no identity yet; listAgents lists it once it has one');
  return { agentId: appId };
}
