// 第二个带按钮的文件。它存在的唯一理由:让 per-file ≠ global。
//
// 只有 Sample.tsx 一个文件时,perFile['Sample.tsx'] 恒等于全局计数,
// 于是「按文件聚合」这一层根本没有被独立守住 —— 断言它跟断言全局是同一件事。
// 而债务排期用的正是 per-file 排名,这一层错了,排期就全错。
// 函数调用型类名工厂:解析器要跟进函数体,不能停在「看不懂就算没有背景」。
const rowFactory = (selected = false) =>
  cn(styleTable.rowBase, selected && styleTable.rowSelected)

const styleTable = {
  rowBase: 'rounded-md hover:bg-[var(--hover)] active:bg-[var(--press)]',
  rowSelected: 'bg-[var(--selected)]',
}

declare function cn(...parts: unknown[]): string
declare function elsewhereFactory(x: boolean): string

export function Other() {
  return (
    <div>
      <button className="rounded-lg hover:bg-[var(--hover)]">only-hover-1</button>
      <button className="rounded-lg hover:bg-[var(--hover)]">only-hover-2</button>
      <button className="gg-ghost">adopted</button>
      {/* 工厂能跟进 → 读到 hover+active */}
      <button className={rowFactory(true)}>factory</button>
      {/* 工厂在别处、回查不到 → 必须进 unresolved,❌ 不能静默算成「无反馈」 */}
      <button className={elsewhereFactory(true)}>opaque</button>
      {/* 样式在 .css 里:类名串里没有任何 hover:/active: 工具类,但它并非「无反馈」 */}
      <button className="legacy-hover-only">css-hover</button>
      <button className="legacy-full">css-full</button>
      {/* 样式写在同文件的内联 <style> 里 —— CSS 的第二个住处 */}
      <button className="inline-styled">inline-css</button>
      <style>{`
        .inline-styled:hover { background: var(--hover); }
        .inline-styled:active { background: var(--press); }
      `}</style>
    </div>
  )
}
