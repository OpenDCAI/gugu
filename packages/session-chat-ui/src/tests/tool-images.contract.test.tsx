/** @jsxImportSource solid-js */
/**
 * 148 10-14(旁观的活画面,③):工具交回来的图画在工具行头下面,一条缩略图。
 *
 * 判据是行的老规矩 —— 量出来的高 = 画出来的高,而且一张图多大都不改这个数:框是定死的,图在框里 contain。
 * 一个工具一口气回很多大图(148 要的那一格):还是一条、最多四个框、最后一个框说还有几张,❌ 撑开时间线。
 * 点一张 = 交给宿主的看图器,整组图、从这张起。
 */

import { ROW_H } from '@session-chat/components/engine/row-metrics'
import { toolGroupUnitDef } from '@session-chat/components/rows/tools/tool-group/tool-group.def'
import { toolUnitDef } from '@session-chat/components/rows/tools/tool/tool.def'
import {
  TOOL_THUMB_H,
  TOOL_THUMB_MAX,
  TOOL_THUMB_STRIP_H,
  TOOL_THUMB_W
} from '@session-chat/components/rows/tools/tool/tool-images'
import type { ChatCommands } from '@session-chat/commands'
import type { ChatToolCall } from '@session-chat/model'
import type { ItemNode } from '@session-chat/state/flatten'
import { describe, expect, it } from 'vitest'
import { makeContractCtx, renderAndMeasureUnit, type ContractInspector } from './contract'

const WIDTH = 720
const NARROW_WIDTH = 180

/** A real picture of `w`×`h`, the way a tool hands one back: a data URL the browser has to decode. */
function picture(w: number, h: number, colour: string): string {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = colour
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, w / 2, h / 3)
  return canvas.toDataURL('image/png')
}

const four = ['#e33', '#3e3', '#33e', '#ee3'].map((colour) => picture(390, 844, colour))
/** 148's cell: one call, many large pictures. */
const many = Array.from({ length: 12 }, (_, i) => picture(1600, 3200, `hsl(${i * 30} 70% 50%)`))

const tool = (id: string, extra: Partial<ChatToolCall>): ChatToolCall => ({
  kind: 'tool',
  id,
  name: 'MCP',
  status: 'done',
  inputSummary: 'gugu · app_check',
  ...extra
})

const appCheck = tool('contract-tool-images', { images: four, result: 'It loaded without errors.' })
const manyLarge = tool('contract-tool-images-many', { images: many })

/** Boxes, their largest painted size, the "+N" text and the img attributes, read off the live row. */
const readStrip: ContractInspector = (host) => {
  const strip = host.querySelector<HTMLElement>('[data-slot="tool-call-images"]')
  const boxes = Array.from(host.querySelectorAll<HTMLElement>('[data-slot="tool-call-images"] button'))
  const imgs = Array.from(host.querySelectorAll<HTMLImageElement>('[data-slot="tool-call-images"] img'))
  const more = host.querySelector('[data-slot="tool-call-images-more"]')?.textContent ?? ''
  return {
    stripH: strip?.offsetHeight ?? 0,
    boxes: boxes.length,
    maxBoxW: Math.max(0, ...boxes.map((b) => b.getBoundingClientRect().width)),
    maxBoxH: Math.max(0, ...boxes.map((b) => b.getBoundingClientRect().height)),
    more: more ? Number(more.replace('+', '')) : 0,
    lazy: imgs.filter((img) => img.loading === 'lazy' && img.decoding === 'async').length
  }
}

describe('工具交回来的图:量出来的高 = 画出来的高,一张图多大都不改它', () => {
  it.each([
    { label: '四张(app_check 的形状),收着', data: appCheck, ctx: makeContractCtx({ width: WIDTH }) },
    {
      label: '四张,展开(入参与结果在缩略图下面)',
      data: { ...appCheck, request: '{"tool":"app_check","args":{"tab_kind":"op-probe.main"}}' },
      ctx: makeContractCtx({ width: WIDTH, isCollapsed: (id) => id === appCheck.id })
    },
    { label: '一次十二张 1600×3200 的大图', data: manyLarge, ctx: makeContractCtx({ width: WIDTH }) },
    { label: '窄到只放得下一个框', data: appCheck, ctx: makeContractCtx({ width: NARROW_WIDTH }) }
  ])('$label', async ({ label, data, ctx }) => {
    const reading = await renderAndMeasureUnit(toolUnitDef, data, ctx, readStrip)
    expect(reading.dom, `${label}: engine=${reading.computed} DOM=${reading.dom}`).toBe(reading.computed)
    expect(reading.inspected.stripH).toBe(TOOL_THUMB_STRIP_H)
    expect(reading.inspected.maxBoxW).toBeLessThanOrEqual(TOOL_THUMB_W)
    expect(reading.inspected.maxBoxH).toBeLessThanOrEqual(TOOL_THUMB_H)
    expect(reading.inspected.lazy).toBe(reading.inspected.boxes)
    expect(reading.spill, `${label} spills ${reading.spill}px`).toBe(0)
  })

  it('收着的行 = 头 + 一条缩略图,不多一像素;没交图的行(阴控)只有头,没有那一条', async () => {
    const withPictures = await renderAndMeasureUnit(toolUnitDef, appCheck, makeContractCtx({ width: WIDTH }), readStrip)
    expect(withPictures.computed).toBe(ROW_H + TOOL_THUMB_STRIP_H)
    const without = await renderAndMeasureUnit(
      toolUnitDef,
      tool('contract-tool-no-images', { result: 'ok' }),
      makeContractCtx({ width: WIDTH }),
      readStrip
    )
    expect(without.computed).toBe(ROW_H)
    expect(without.dom).toBe(ROW_H)
    expect(without.inspected.boxes).toBe(0)
  })

  it('很多大图:最多四个框,最后一个说还有几张;窄的时候框少,剩下的算进「+N」', async () => {
    const wide = await renderAndMeasureUnit(toolUnitDef, manyLarge, makeContractCtx({ width: WIDTH }), readStrip)
    expect(wide.inspected.boxes).toBe(TOOL_THUMB_MAX)
    expect(wide.inspected.more).toBe(many.length - TOOL_THUMB_MAX)
    const narrow = await renderAndMeasureUnit(toolUnitDef, appCheck, makeContractCtx({ width: NARROW_WIDTH }), readStrip)
    expect(narrow.inspected.boxes).toBe(1)
    expect(narrow.inspected.more).toBe(3)
  })

  it('一组里的子调用交了图:组量出来的高也算上那一条', async () => {
    const group: ItemNode = {
      item: tool('contract-images-group', { name: 'Read', status: 'running' }),
      children: [
        { item: tool('contract-images-group-0', {}), children: [] },
        { item: appCheck, children: [] }
      ]
    }
    const reading = await renderAndMeasureUnit(
      toolGroupUnitDef,
      group,
      makeContractCtx({ width: WIDTH, isCollapsed: (id) => id === 'contract-images-group' }),
      readStrip
    )
    expect(reading.dom).toBe(reading.computed)
    expect(reading.inspected.boxes).toBe(4)
  })
})

describe('点一张缩略图', () => {
  it('交给宿主:整组图(含没摆出来的那些)、从被点的这张起、带着这张缩略图;❌ 顺手开合这一行', async () => {
    const calls: Parameters<NonNullable<ChatCommands['onViewImages']>>[0][] = []
    const commands: ChatCommands = { onViewImages: (arg) => calls.push(arg) }
    let thumb: Element | null = null
    let inToggle = -1
    await renderAndMeasureUnit(
      toolUnitDef,
      { ...manyLarge, result: 'twelve pictures' },
      makeContractCtx({ width: WIDTH }),
      (host) => {
        const boxes = host.querySelectorAll<HTMLButtonElement>('[data-slot="tool-call-images"] button')
        thumb = boxes[3].querySelector('img')
        // 行的开合是 ChatRoot 收点击、认 `closest('[data-collapse-id]')`(ChatRoot.tsx):缩略图得在那一格外面。
        // 阳控:这一行可以开合(有结果),它的头上确实挂着 data-collapse-id。
        inToggle = [...boxes].filter((box) => box.closest('[data-collapse-id]')).length
        if (!host.querySelector('[data-collapse-id]')) inToggle = -1
        boxes[3].click()
        return {}
      },
      commands
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ urls: many, index: 3, itemId: manyLarge.id, source: 'tool-result' })
    expect(calls[0].thumb).toBe(thumb)
    expect(inToggle).toBe(0)
  })
})
