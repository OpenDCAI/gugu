import { eq } from 'drizzle-orm';
import type { SessionLibraryMcpFact } from '@shared/core/sessions/session-config';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import type { SessionExtensionDelivery } from '@shared/core/sessions/sessions';

/**
 * 记下这条会话**起进程那一刻被带上**的那几台 MCP server(spec `mcp-session-toggle`)。
 *
 * ## 为什么这件事必须在会话起来时写,而不是面板打开时算
 *
 * 面板能算出来的只有**意图**(`用户当下的配置 ∖ 关闭集合`),而用户问的是**事实**
 * (「这条正在跑的会话里有哪几台」)。两者在两种情形下会分岔,而分岔的方向都是界面撒谎:
 * · 会话起来**之后**全局装了一台新的 ⇒ 意图说"开着",而进程里没有它;
 * · 会话起来之后**卸载**的那台从全局清单消失 ⇒ 面板整行不见,而它还在这个进程里活着。
 *
 * ⇒ 事实只能在**它成为事实的那一刻**写下来。
 *
 * ## ❌ 不整份覆盖 config
 *
 * 读-改-写,只动这一个键:`config` 那份 JSON 里同住着 permissionMode /
 * firstUtterance 等等,整份覆盖会把它们一起抹掉,而症状要等下一次重开才显形
 * (与 `embedded-boot` 写 `model` 那一处同一条纪律)。
 *
 * ## 失败只 warn,❌ 不抛
 *
 * 它跑在会话**已经起来之后**的持久化路径上。抛出去会把一次成功的启动变成一次失败,
 * 而代价不对称:写丢了只是面板这一次显示回退到意图(下次重开自愈),
 * 抛出去是用户的会话起不来。
 */
export async function setSessionMcpServers(
  sessionId: string,
  names: readonly string[],
  /** #6387 扩展交付进来的程序与技能 —— 同一时刻的另一半事实。缺席 = 这次启动没有注入器。 */
  extensions?: SessionExtensionDelivery
): Promise<boolean> {
  const rows = await db
    .select({ config: sessions.config })
    .from(sessions)
    .where(eq(sessions.id, sessionId));
  const current = rows[0]?.config;
  if (!current || typeof current !== 'object') return false;
  // ⚠️ 补丁走 `Record<string, unknown>` 再展开 —— `config` 那一列是 pty | acp 的**联合**,
  //    直接写成字面量属性会撞 TS2353(这个键只属于 acp 那一支)。
  //    与 `embedded-boot` 写 `model` 那一处同形,理由也同:摊平之后我们已经不知道自己在写什么,
  //    所以只让**补丁**是 Record,底仍然是读回来的那一份。
  const patch: Record<string, unknown> = {
    mcpSessionServers: [...names],
    ...(extensions ? { mcpSessionExtensions: extensions } : {}),
  };
  await db
    .update(sessions)
    .set({ config: { ...current, ...patch } })
    .where(eq(sessions.id, sessionId));
  return true;
}

/**
 * 资源库 → MCP:这一次起进程时资源库那几台的送达事实(哪几台进了能力包、哪几台为什么留在外面)。
 * 每次建能力包(开 / 续开)都记一遍 —— `/mcp` 面板读这一格,❌ 读「勾了」。两条腿都记。
 */
export async function setSessionLibraryMcp(sessionId: string, fact: SessionLibraryMcpFact): Promise<boolean> {
  const rows = await db
    .select({ config: sessions.config })
    .from(sessions)
    .where(eq(sessions.id, sessionId));
  const current = rows[0]?.config;
  if (!current || typeof current !== 'object') return false;
  await db
    .update(sessions)
    .set({ config: { ...current, mcpSessionLibrary: fact } })
    .where(eq(sessions.id, sessionId));
  return true;
}
