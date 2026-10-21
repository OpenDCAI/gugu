// @@@5856 agent 数量线那一格的收值规则。单独成文件是因为它是纯函数 ——
// 与组件同文件会让 fast-refresh 失效(react-refresh/only-export-components),
// 也让它没法被判官单独拿来跑。同目录的 groupMemberModels 同形。

/**
 * 收一格数量线草稿:
 *   空串     → null        交回去继承(话题跟来源那条线、群跟产品默认)
 *   整数 ≥1  → 那个数
 *   其余     → undefined   收不下,调用方还原上一个有效值
 *
 * 0 / 负数 / 小数 / 文字都不是「一个数量线」:0 会写出一条永远过线的规则,小数在「> N」上没有意义。
 */
export function parseAgentFloodThresholdDraft(draft: string): number | null | undefined {
  const trimmed = draft.trim()
  if (trimmed === '') return null
  if (!/^\d+$/.test(trimmed)) return undefined
  const parsed = Number.parseInt(trimmed, 10)
  return parsed >= 1 ? parsed : undefined
}
