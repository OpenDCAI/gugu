/**
 * 取消 Agent 创建时的清理失败,信息天然分成两半,必须走两条路:
 *
 * - **哪一步没做干净** —— `stage` 是我们自己的枚举(`'stop' | 'remove'`),可本地化,
 *   是用户唯一需要知道、也唯一能据此判断严重性的东西;
 * - **为什么失败** —— `error` 是下层抛的 message(例如 `runtime stop timed out after 30000ms`,
 *   英文、带内部超时数),对用户没有可操作性,只进日志。
 *
 * 把这两半拼成一句端给用户(旧写法 `${stage}: ${error}`)正是 #4891 要治的病:
 * 中文界面上出现一个英文枚举值加一句英文内部消息。
 */
export type CleanupStage = 'stop' | 'remove'

const STAGE_KEY: Record<CleanupStage, string> = {
  remove: 'create.cleanupStage.remove',
  stop: 'create.cleanupStage.stop',
}

/**
 * 「哪几步没做干净」的用户文案:去重、保序,按当前语言连接
 * (`Intl.ListFormat` 负责中文的「和」与英文的 `and`,❌ 不把分隔符做成词条)。
 */
export function cleanupStepsText(
  stages: readonly CleanupStage[],
  t: (key: string) => string,
  language: string,
): string {
  const seen: CleanupStage[] = []
  for (const stage of stages) if (!seen.includes(stage)) seen.push(stage)
  const names = seen.map((stage) => t(STAGE_KEY[stage]))
  return new Intl.ListFormat(language, { style: 'long', type: 'conjunction' }).format(names)
}
