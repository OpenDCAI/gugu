/** @jsxImportSource solid-js */
import { textFilePatch } from '@gugu/session-core/lib';

import { describe, expect, it, vi } from 'vitest'
import { createChatContext } from '../chat-context'
import { createChatState } from '../state/chat-state'
import { createChatView } from '../chat-view'
import type { TranscriptTurn } from '../model'
import { until } from '../../../../tests/support/awaitCondition'
import { fileChangeSummaryUnitDef } from '../components/rows/file-change-summary/file-change-summary.def'
import type { FileChangeSummaryItem } from '../model'
import { makeContractCtx, renderAndMeasureUnit } from './contract'
const item: FileChangeSummaryItem = {
  kind: 'file-change-summary',
  id: 't:file-changes',
  turnId: 't',
  adds: 5, dels: 0,
  files: Array.from({ length: 5 }, (_, i) => ({
    path: `/workspace/subfolder/${i}/test.txt`,
    adds: 1,
    dels: 0,
    diffs: [
      {
        kind: 'diff',
        id: `d${i}`,
        patches: [textFilePatch(`/workspace/subfolder/${i}/test.txt`, null, 'hello')],

        status: 'done'
      }
    ]
  }))
}
// owner 10-17: Codex 的这张卡只列文件与增删数,改动去右侧看;卡里 ❌ 铺逐行改动(截图里的 `+edited` `+two`)。
const single: FileChangeSummaryItem = { ...item, id: 't1:file-changes', files: item.files.slice(0, 1) }

describe('an Edited row has the output card\'s Open with', () => {
  it.each([240, 800])('its menu button stays inside the row at %ipx, and opens the menu for that file, not the row', async (width) => {
    const onOpenFile = vi.fn()
    const onOutputMenu = vi.fn()
    const reading = await renderAndMeasureUnit(
      fileChangeSummaryUnitDef,
      single,
      makeContractCtx({ width }),
      (host) => {
        const row = host.querySelector<HTMLElement>('[role="button"][title]')!
        const mode = row.querySelector<HTMLElement>('[data-slot="opened-output-mode"]')!
        const inside = mode.getBoundingClientRect().right <= row.getBoundingClientRect().right + 0.5 ? 1 : 0
        mode.click()
        return { inside, menu: onOutputMenu.mock.calls.length, opened: onOpenFile.mock.calls.length }
      },
      { onOpenFile, onOutputMenu, outputOpenMode: () => 'Open with' }
    )
    expect(reading.dom).toBe(reading.computed)
    expect(reading.inspected).toEqual({ inside: 1, menu: 1, opened: 0 })
    expect(onOutputMenu.mock.calls[0]![0].output).toEqual({ kind: 'file', path: single.files[0].path })
  })
})

describe('file change result card geometry', () => {
  it.each([240, 420, 800])(
    'keeps all cells inside %ipx, collapsed and with the file list open; never an inline diff',
    async (width) => {
      for (const mode of ['closed', 'files']) {
        const ctx = makeContractCtx({ width, isCollapsed: (id) => mode === 'files' && id === item.id })
        const reading = await renderAndMeasureUnit(
          fileChangeSummaryUnitDef,
          item,
          ctx,
          (host) => ({
            summaries: host.querySelectorAll('[data-slot="file-change-summary"]').length,
            paths: host.querySelectorAll('[role="button"][title]').length,
            panels: host.querySelectorAll('[role="region"]').length,
            diffText: host.textContent?.includes('+hello') ? 1 : 0
          }),
          { onOpenFile: () => {} }
        )
        expect(reading.dom).toBe(reading.computed)
        expect(reading.spill).toBeLessThanOrEqual(1)
        expect(reading.inspected.summaries).toBe(1)
        expect(reading.inspected.paths).toBe(mode === 'closed' ? 0 : 5)
        expect(reading.inspected.panels, 'the card drew an inline diff panel').toBe(0)
        expect(reading.inspected.diffText, 'the card drew changed lines').toBe(0)
      }
    }
  )

  it.each([240, 800])('a single file shows its one row directly at %ipx: no disclosure, no inline diff', async (width) => {
    const reading = await renderAndMeasureUnit(
      fileChangeSummaryUnitDef,
      single,
      makeContractCtx({ width }),
      (host) => ({
        paths: host.querySelectorAll('[role="button"][title]').length,
        toggles: host.querySelectorAll('[data-collapse-id]').length,
        panels: host.querySelectorAll('[role="region"]').length,
        diffText: host.textContent?.includes('+hello') ? 1 : 0,
        // owner 11-06 方案 A: the whole row is the one button — tile, name, 「已编辑 · +1 −0 · …/两层」, ›; the whole path as its tooltip.
        rowTitle: host.querySelector<HTMLElement>('[role="button"][title]')?.title === '/workspace/subfolder/0/test.txt' ? 1 : 0,
        rowName: host.querySelector('[role="button"][title]')?.textContent?.includes('test.txt') ? 1 : 0,
        rowFolder: host.querySelector('[role="button"][title]')?.textContent?.replace(/\s/g, '').includes('…/subfolder/0') ? 1 : 0,
        rowTile: host.querySelector('[role="button"][title] svg') ? 1 : 0,
        counts: (host.textContent?.match(/\+1/g) ?? []).length
      }),
      { onOpenFile: () => {} }
    )
    expect(reading.dom).toBe(reading.computed)
    expect(reading.spill).toBeLessThanOrEqual(1)
    expect(reading.inspected.paths).toBe(1)
    const { rowTitle, rowName, rowFolder, rowTile, counts } = reading.inspected
    expect({ rowTitle, rowName, rowFolder, rowTile, counts }, 'the row is the whole button: the whole path as its tooltip, the last two folders on it, the counts once').toEqual({ rowTitle: 1, rowName: 1, rowFolder: 1, rowTile: 1, counts: 1 })
    expect(reading.inspected.toggles, 'a one-file card has nothing to expand').toBe(0)
    expect(reading.inspected.panels).toBe(0)
    expect(reading.inspected.diffText).toBe(0)
  })
})

it('settles once below the reply, lists the files without their changed lines, and opens the exact path beside', async () => {
  const context = createChatContext({ locale: () => 'en-US' })
  const state = createChatState(context)
  const host = document.createElement('div')
  host.style.cssText = 'width:720px;height:520px;'
  document.body.append(host)
  const onOpenFile = vi.fn()
  const view = createChatView({ context, state, parent: host, commands: { onOpenFile } })
  const turn = {
    id: 't',
    seq: 1,
    initiator: 'user',
    items: [
      { kind: 'message', id: 'u', seq: 0, role: 'user', text: 'Edit two files' },
      ...item.files.slice(0, 2).flatMap((f) => f.diffs),
      { kind: 'message', id: 'a', seq: 3, role: 'assistant', text: 'Files updated.' }
    ]
  } as TranscriptTurn
  const summary = () => host.querySelector<HTMLElement>('[data-slot="file-change-summary"]')
  try {
    state.transcript.activeTurn.set(turn)
    await until('active reply mounts', () => host.textContent?.includes('Files updated.') === true)
    expect(summary()).toBeNull()
    state.transcript.history.seed([{ ...turn, outcome: { kind: 'done' } }])
    await until('result card mounts after settlement', () => !!summary())
    expect(host.querySelectorAll('[data-slot="file-change-summary"]')).toHaveLength(1)
    summary()!.querySelector<HTMLButtonElement>('[data-collapse-id="t:file-changes"]')!.click()
    await until('the file list opens', () => summary()!.querySelectorAll('[role="button"][title]').length === 2)
    expect(summary()!.textContent, 'the card spread the changed lines inline').not.toContain('+hello')
    expect(summary()!.querySelectorAll('[role="region"]')).toHaveLength(0)
    // Every control the card offers (every button but a file path, which opens beside), pressed in turn: none may
    // spread the changed lines inline. The old card hid them one press deeper, behind 「查看变更」 — reading only the
    // opened list never saw them.
    const pressed = new Set<string>()
    for (let round = 0; round < 8; round++) {
      const control = [...summary()!.querySelectorAll<HTMLButtonElement>('button:not([title])')]
        .find((button) => !pressed.has(button.textContent ?? ''))
      if (!control) break
      const label = control.textContent ?? ''
      pressed.add(label)
      control.click()
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      expect(summary()!.textContent, `pressing "${label}" spread the changed lines inline`).not.toContain('+hello')
      expect(summary()!.querySelectorAll('[role="region"]')).toHaveLength(0)
    }
    expect(pressed.size, 'no control was pressed: the sweep proved nothing').toBeGreaterThan(0)
    if (summary()!.querySelectorAll('[role="button"][title]').length === 0) {
      summary()!.querySelector<HTMLButtonElement>('[data-collapse-id="t:file-changes"]')!.click()
      await until('the file list reopens', () => summary()!.querySelectorAll('[role="button"][title]').length === 2)
    }
    summary()!.querySelector<HTMLButtonElement>('[role="button"][title]')!.click()
    expect(onOpenFile).toHaveBeenCalledExactlyOnceWith({
      path: item.files[0].path,
      itemId: 'd0',
      source: 'diff'
    })
  } finally {
    view.dispose()
    host.remove()
  }
})
