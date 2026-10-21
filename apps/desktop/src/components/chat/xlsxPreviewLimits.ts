/**
 * 超大工作表的「先看前面一部分」(#7191,owner 2026-10-15:「超过 25 万个单元格的表格,明确提示表格太大,
 * 超出的部分显示不全,建议 Office 软件打开就好了,这样可以预览」)。
 *
 * ⚠️ 为什么要自己截:`@silurus/ooxml` 0.88 一张表超过 250,000 个单元格就整张拒绝
 * (`ooxml-resource-limit`,`configurable:false`,本机实测 `cells 250001 > 250000` —— 它数到上限 +1 就停,
 * 报不出真实总数),而且它是**切到那张表才读**(大表在第二张时,打开文件不报错,切过去才抛)。
 * ⇒ 只能在交给它之前把每张表扫一遍,超了的只留前面放得下的整行。截过的必须在界面上明说(见 XlsxPreview),
 * ❌ 静默截断。
 */

/** 留 1 万格余量:库的计数口径(比如带样式的空格子)与这里数 `<c>` 不保证逐个相同。 */
export const XLSX_PREVIEW_MAX_CELLS = 240_000

// 生成器有的会给元素带命名空间前缀(`<x:row>`、`<x:c>`),一并认。`<c` 后面必须紧跟空白、`>` 或 `/`,
// 否则 `<cols>`、`<cfRule>` 这类也会被当成格子。
const ROW_OR_CELL = /<(?:[A-Za-z_][\w.-]*:)?(row|c)(?=[\s>/])/g
const SHEET_DATA_OPEN = /<(?:[A-Za-z_][\w.-]*:)?sheetData[\s>/]/
const SHEET_DATA_CLOSE = /<\/(?:[A-Za-z_][\w.-]*:)?sheetData>/
const DIMENSION = /<(?:[A-Za-z_][\w.-]*:)?dimension\b[^>]*\/>/

export interface SheetTruncation {
  xml: string
  truncated: boolean
  /** 保留下来的行数(只在 truncated 时有意义)。 */
  keptRows: number
}

function sheetDataRange(xml: string): { start: number; end: number } | null {
  const open = SHEET_DATA_OPEN.exec(xml)
  if (!open) return null
  const close = SHEET_DATA_CLOSE.exec(xml.slice(open.index))
  // 自闭合的 `<sheetData/>` 没有格子;没有闭合标签的残缺文件交给库自己报错。
  if (!close) return null
  return { start: open.index, end: open.index + close.index }
}

/** 工作表 XML 里 `<sheetData>` 中的格子数。 */
export function countSheetCells(xml: string): number {
  const range = sheetDataRange(xml)
  if (!range) return 0
  const body = xml.slice(range.start, range.end)
  let cells = 0
  for (const match of body.matchAll(ROW_OR_CELL)) if (match[1] === 'c') cells += 1
  return cells
}

/**
 * 超过 `maxCells` 时,只留前面整行加起来不超过它的那些行;没超就原样返回。
 * 截的位置总在某个 `<row` 的开头,所以留下来的都是完整的行。
 */
export function truncateSheetXml(xml: string, maxCells: number = XLSX_PREVIEW_MAX_CELLS): SheetTruncation {
  const range = sheetDataRange(xml)
  if (!range) return { xml, truncated: false, keptRows: 0 }
  const body = xml.slice(range.start, range.end)
  let cells = 0
  let rows = 0
  let currentRowStart = -1
  for (const match of body.matchAll(ROW_OR_CELL)) {
    if (match[1] === 'row') {
      currentRowStart = match.index
      rows += 1
      continue
    }
    cells += 1
    if (cells > maxCells && currentRowStart >= 0) {
      const cut = range.start + currentRowStart
      // 原来的 `<dimension>` 写的是整张表的范围,截完就不对了 —— 去掉它(它是可选元素),让库按实际的行算。
      const head = xml.slice(0, cut).replace(DIMENSION, '')
      return { xml: head + xml.slice(range.end), truncated: true, keptRows: rows - 1 }
    }
  }
  return { xml, truncated: false, keptRows: rows }
}
