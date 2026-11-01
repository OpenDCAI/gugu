// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import { FileStorageDashboard } from '../../../../apps/desktop/src/components/settings/FileStorageDashboard'

const f = vi.hoisted(() => ({ overview: vi.fn(), mark: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/fileStorage', () => ({ readFileStorageOverview: f.overview, markFileStorage: f.mark }))
vi.mock('react-i18next', async (importOriginal) => ({ ...await importOriginal<object>(), useTranslation: () => ({ t: (key: string, values?: Record<string, unknown>) => values ? `${key} ${JSON.stringify(values)}` : key }) }))

const DAY = 86_400_000
const file = (name: string, days: number, bytes: number, chat = 'g1') =>
  ({ chat_id: chat, expires_at: new Date(Date.now() + days * DAY - 60_000).toISOString(), bytes, class: 'temporary', item_id: name, file_name: name })
const overview = {
  total_bytes: 6 * 1024 * 1024, count: 9, expiring_7d_bytes: 2000,
  classes: { temporary: { bytes: 3 * 1024 * 1024, count: 7 }, image: { bytes: 2 * 1024 * 1024, count: 1 }, kept: { bytes: 1024 * 1024, count: 1 } },
  groups: [{ chat_id: 'g1', name: 'Design', project: false, bytes: 3000, count: 3 }, { chat_id: 'g2', name: 'Alpha', project: false, bytes: 3000, count: 3 }],
  expiring: [file('f.pdf', 1, 600), file('b.zip', 2, 900, 'g2'), file('c.txt', 3, 100), file('d.md', 4, 700), file('e.png', 5, 300), file('a.key', 6, 800), file('g.csv', 7, 200)],
  machines: [{ device_id: 'd1', label: 'Studio Mac', files: 4, bytes: 5000, temporary_copy_bytes: 0 }],
  expiry: { large_file_bytes: 1024 * 1024, idle_seconds: 30 * 86_400 },
}

describe('the 「文件存储与读取」 dashboard (owner 10-28 design): the caller\'s own cloud copies', () => {
  let harness: ReturnType<typeof createReactHarness>
  beforeEach(() => { harness = createReactHarness(); vi.clearAllMocks(); f.overview.mockResolvedValue(overview); f.mark.mockResolvedValue(1) })
  afterEach(() => harness.cleanup())
  const $ = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  const names = () => [...document.querySelectorAll('[data-testid="file-storage-file"] td:first-child')].map((cell) => cell.textContent)
  const ready = async () => {
    await harness.render(createElement(FileStorageDashboard))
    await vi.waitFor(() => expect($('file-storage-usage')).not.toBeNull())
  }

  it('one bar split by class, with each class\'s numbers on the line below it; no charts', async () => {
    await ready()
    // Widths out of 1000 in proportion to bytes (3 : 2 : 1), a 2-unit gap between segments.
    expect([...document.querySelectorAll('[data-testid^="file-storage-bar-"]')].map((bar) => [bar.getAttribute('data-testid'), Math.round(Number(bar.getAttribute('width')))]))
      .toEqual([['file-storage-bar-temporary', 499], ['file-storage-bar-image', 331], ['file-storage-bar-kept', 166]])
    expect($('file-storage-legend-temporary')!.textContent).toContain('3 MB')
    expect($('file-storage-legend-temporary')!.textContent).toContain('"count":7')
    expect($('file-storage-legend-kept')!.textContent).toContain('1 MB')
    expect($('file-storage-total')!.textContent).toBe('6 MB')
    expect(document.querySelector('canvas, svg[data-chart]')).toBeNull()
    expect($('file-storage-machine')!.textContent).toContain('Studio Mac')
    expect($('file-storage-machine')!.textContent).toContain('fileStorage.dashboard.machineHintNone')
  })

  it('states the kept files\' rule beside them, with the threshold and days the deployment sets', async () => {
    const open = async () => {
      const trigger = document.querySelector<HTMLElement>('[data-testid="file-storage-legend-kept"] [aria-label="fileStorage.dashboard.keptRuleLabel"]')!
      await act(async () => { trigger.click() })
      await vi.waitFor(() => expect(document.body.textContent).toContain('fileStorage.dashboard.keptRule'))
    }
    await ready()
    expect(document.querySelectorAll('[aria-label="fileStorage.dashboard.keptRuleLabel"]')).toHaveLength(1)
    await open()
    expect(document.body.textContent).toContain('fileStorage.dashboard.keptRule {"size":"1 MB","days":30}')
    harness.cleanup(); harness = createReactHarness()
    f.overview.mockResolvedValue({ ...overview, expiry: null })
    await ready()
    await open()
    expect(document.body.textContent).toContain('fileStorage.dashboard.keptRuleNoExpiry')
  })

  it('deletes cloud copies only after a second confirmation, of the classes ticked there (temporary by default)', async () => {
    await ready()
    await act(async () => { $('file-storage-clean')!.click() })
    await vi.waitFor(() => expect($('file-storage-clean-confirm')).not.toBeNull())
    expect(f.mark).not.toHaveBeenCalled()
    expect(($('file-storage-clean-temporary') as HTMLInputElement).checked).toBe(true)
    expect(($('file-storage-clean-image') as HTMLInputElement).checked).toBe(false)
    expect($('file-storage-clean-go')!.textContent).toContain('3 MB')
    await act(async () => { $('file-storage-clean-image')!.click() })
    expect($('file-storage-clean-go')!.textContent).toContain('5 MB')
    await act(async () => { $('file-storage-clean-go')!.click() })
    expect(f.mark).toHaveBeenCalledWith([{ class: 'temporary' }, { class: 'image' }], 'release')
    await vi.waitFor(() => expect(f.overview).toHaveBeenCalledTimes(2))
  })

  it('lists the five soonest to expire with a 「还剩 N 天」, shows all on request, and sorts by a column header', async () => {
    await ready()
    expect(names()).toEqual(['f.pdf', 'b.zip', 'c.txt', 'd.md', 'e.png'])
    const first = document.querySelector('[data-testid="file-storage-file"]')!
    expect(first.textContent).toContain('Design')
    expect(first.textContent).toContain('fileStorage.dashboard.daysLeft {"count":1}')
    expect(document.querySelectorAll('[data-testid="file-storage-file"] button')).toHaveLength(0)
    await act(async () => { $('file-storage-show-all')!.click() })
    expect(names()).toHaveLength(7)
    await act(async () => { $('file-storage-sort-size')!.click() })
    expect(names()).toEqual(['c.txt', 'g.csv', 'e.png', 'f.pdf', 'd.md', 'a.key', 'b.zip'])
    await act(async () => { $('file-storage-sort-size')!.click() })
    expect(names()[0]).toBe('b.zip')
    await act(async () => { $('file-storage-sort-group')!.click() })
    expect(names()[0]).toBe('b.zip')
  })
})
