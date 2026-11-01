import { count, eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { sessions, sessionTurns } from '@main/db/schema';

/**
 * 云端 `agent.create` 不带首句建出来的常驻 agent,从前行上记的首轮就是这一句占位(新建会话必须带首轮,
 * 见 build-session-row)—— 它不是任何人说过的话,❌ 拿它当首轮重来。现在这类会话的来源是 `resident`,
 * 不记首轮(#7199);这句只为认出存量行。
 */
export const RESIDENT_AGENT_FIRST_UTTERANCE = 'preset team member runtime';

/**
 * #7223 建来常驻、一句还没聊过的 agent:咕咕这边**没有已提交回合、也没有首轮**(没有首轮载荷,
 * 首轮要么没记、要么是上面那句占位)。引擎侧找不到它的原生会话时,它缺的只是一次还没发生的启动 ——
 * 同一个引擎新开即可,真正的新开在 runtime 那次启动里做(`freshIfProviderSessionMissing`)。
 *
 * 形状:适配器建会话时就发了原生会话 id,而 Claude Code 要真聊过一轮才写下那份记录;机器睡了又醒,
 * 按 id 找回时得到 `Resource not found` —— 从前这条会话从此每次唤醒都失败,私聊永远没人回。
 *
 * 不认的两种,照旧如实报 missing:
 * - 有已提交回合(`session_turns`,#5381)= 聊过。
 * - 记着真首轮的 = 首轮没跑完的会话,spec session-resume 说照**那句**重来,由界面的「重来」走 restartSession;
 *   这里 ❌ 不替它重放 —— 存下来的那句没有当时的投递信封,原样重发会把回复送错地方。
 *
 * ⚠️ 盲区:#5381 之前聊过、之后没重开过(或从编程模式切过来)的会话同样没有回合行;若它恰好也没有真首轮,
 * 会被认成这一种。runtime 新开时照旧画「往上的内容它没有」那条界,如实告知,❌ 静默换掉。
 */
export async function isResidentNeverRun(sessionId: string): Promise<boolean> {
  const [[row], [turns]] = await Promise.all([
    db.select({ config: sessions.config }).from(sessions).where(eq(sessions.id, sessionId)).limit(1),
    db.select({ n: count() }).from(sessionTurns).where(eq(sessionTurns.sessionId, sessionId)),
  ]);
  const config = row?.config;
  if (!config) return false;
  if ((turns?.n ?? 0) > 0) return false;
  if (config.type === 'acp' && config.initialQueue?.some((prompt) => prompt.text.trim() || prompt.files?.length)) return false;
  if (config.initialPrompt?.trim()) return false;
  const said = config.firstUtterance?.trim();
  return !said || said === RESIDENT_AGENT_FIRST_UTTERANCE;
}
