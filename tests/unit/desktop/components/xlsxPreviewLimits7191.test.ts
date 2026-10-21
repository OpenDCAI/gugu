import { describe, expect, it } from 'vitest'
import { countSheetCells, truncateSheetXml } from '@/components/chat/xlsxPreviewLimits'

function sheet(rows: number, cols: number, opts: { prefix?: string; dimension?: boolean } = {}): string {
  const p = opts.prefix ? `${opts.prefix}:` : ''
  const body: string[] = []
  for (let r = 1; r <= rows; r += 1) {
    const cells: string[] = []
    for (let c = 0; c < cols; c += 1) cells.push(`<${p}c r="${String.fromCharCode(65 + c)}${r}" t="n"><${p}v>${r * c}</${p}v></${p}c>`)
    body.push(`<${p}row r="${r}">${cells.join('')}</${p}row>`)
  }
  const dimension = opts.dimension === false ? '' : `<${p}dimension ref="A1:${String.fromCharCode(64 + cols)}${rows}"/>`
  return `<?xml version="1.0"?><${p}worksheet>${dimension}<${p}cols><${p}col min="1" max="2" width="9"/></${p}cols>`
    + `<${p}sheetData>${body.join('')}</${p}sheetData><${p}mergeCells count="0"/></${p}worksheet>`
}

describe('#7191 超大工作表只留前面放得下的整行', () => {
  it('没超过上限:原样返回,不改一个字节', () => {
    const xml = sheet(10, 3)
    const out = truncateSheetXml(xml, 30)
    expect(out.truncated).toBe(false)
    expect(out.xml).toBe(xml)
  })

  it('超过上限:留下的格子数不超过上限,且都是完整的行', () => {
    const xml = sheet(10, 3) // 30 格
    const out = truncateSheetXml(xml, 10) // 最多 3 整行(9 格),第 4 行会越线
    expect(out.truncated).toBe(true)
    expect(out.keptRows).toBe(3)
    expect(countSheetCells(out.xml)).toBe(9)
    expect(out.xml).toContain('<row r="3">')
    expect(out.xml).not.toContain('<row r="4">')
    // 截完 sheetData 之后的部分原样保留,文件仍然闭合
    expect(out.xml).toMatch(/<\/sheetData><mergeCells count="0"\/><\/worksheet>$/)
  })

  it('截过的表去掉原来的 dimension(它写的还是整张表的范围)', () => {
    const out = truncateSheetXml(sheet(10, 3), 10)
    expect(out.xml).not.toContain('<dimension')
  })

  it('<cols>/<col> 不被当成格子', () => {
    expect(countSheetCells(sheet(2, 2))).toBe(4)
  })

  it('带命名空间前缀的写法(<x:row>/<x:c>)同样数、同样截', () => {
    const xml = sheet(10, 3, { prefix: 'x' })
    expect(countSheetCells(xml)).toBe(30)
    const out = truncateSheetXml(xml, 10)
    expect(out.truncated).toBe(true)
    expect(countSheetCells(out.xml)).toBe(9)
    expect(out.xml).not.toContain('<x:dimension')
  })

  it('自闭合的空行也算一行,不影响截断位置', () => {
    const xml = '<worksheet><sheetData><row r="1"/><row r="2"><c r="A2"/><c r="B2"/></row><row r="3"><c r="A3"/></row></sheetData></worksheet>'
    const out = truncateSheetXml(xml, 2)
    expect(out.truncated).toBe(true)
    expect(out.keptRows).toBe(2)
    expect(out.xml).toBe('<worksheet><sheetData><row r="1"/><row r="2"><c r="A2"/><c r="B2"/></row></sheetData></worksheet>')
  })

  it('没有 sheetData(或自闭合)的表:不截', () => {
    expect(truncateSheetXml('<worksheet><sheetData/></worksheet>', 1).truncated).toBe(false)
    expect(countSheetCells('<worksheet></worksheet>')).toBe(0)
  })
})
