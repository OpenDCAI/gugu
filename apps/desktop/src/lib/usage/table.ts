// 用量页表格的两条小规则(模型标签颜色与分页页码),纯函数、单测覆盖。

// 模型标签颜色:名字做 FNV-1a 哈希后落到 12 色色板上,同一个名字永远同一种颜色。
const TAG_COLORS = ['#2f7de1', '#16a34a', '#d97706', '#9333ea', '#0891b2', '#dc2626', '#65a30d', '#db2777', '#4f46e5', '#ca8a04', '#0d9488', '#7c3aed']
export function stringToColor(value: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return TAG_COLORS[(hash >>> 0) % TAG_COLORS.length]
}

export const PAGE_SIZES = [10, 20, 30, 40, 50, 100] as const

/** 页码:总页 ≤5 全列;否则首尾恒在,当前页左右各一,中间用省略号。 */
export function pageNumbers(current: number, total: number): (number | 'ellipsis')[] {
  if (total <= 5) return Array.from({ length: total }, (_, i) => i + 1)
  if (current <= 3) return [1, 2, 3, 4, 'ellipsis', total]
  if (current >= total - 2) return [1, 'ellipsis', total - 3, total - 2, total - 1, total]
  return [1, 'ellipsis', current - 1, current, current + 1, 'ellipsis', total]
}
