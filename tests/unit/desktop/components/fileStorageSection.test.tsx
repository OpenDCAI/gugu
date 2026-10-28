// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import { DEFAULT_FILE_STORAGE, type FileStorage } from '../../../../packages/core/src/shared/fileStorage'
import { FileStorageSection } from '../../../../apps/desktop/src/components/settings/FileStorageSection'

const f = vi.hoisted(() => ({ stored: {} as Record<string, unknown>, write: vi.fn(), projects: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/fileStorage', () => ({
  readFileStorage: async () => f.stored,
  writeFileStorage: async (_user: string, change: Partial<FileStorage>) => { f.write(change); f.stored = { ...f.stored, ...change }; return f.stored },
}))
vi.mock('../../../../apps/desktop/src/components/settings/FileStorageDashboard', () => ({ FileStorageDashboard: () => null }))
vi.mock('../../../../apps/desktop/src/lib/deviceProjects', () => ({ listMyDeviceProjects: f.projects }))
vi.mock('../../../../apps/desktop/src/store/auth', () => ({ useAuth: () => ({ user: { id: 'owner' } }) }))
vi.mock('../../../../apps/desktop/src/store/devicesContext', () => ({ useDevicesStore: () => ({ devices: [{ device_id: 'mac', label: 'Studio Mac' }] }) }))
vi.mock('react-i18next', async (importOriginal) => ({ ...await importOriginal<object>(), useTranslation: () => ({ t: (key: string) => key }) }))

describe('the one 「文件存储与读取」: other files are one choice', () => {
  let harness: ReturnType<typeof createReactHarness>
  beforeEach(() => {
    harness = createReactHarness(); vi.clearAllMocks(); f.stored = { ...DEFAULT_FILE_STORAGE }
    f.projects.mockResolvedValue({ mac: [{ localProjectId: 'p', chatId: 'group' }] })
  })
  afterEach(() => harness.cleanup())
  const $ = (id: string) => harness.container.querySelector<HTMLSelectElement>(`#${id}`)
  async function choose(id: string, value: string) {
    await act(async () => { const el = $(id)!; el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })) })
  }

  it('keeps files on the machine with their temporary-copy retention, or uploads everything without either retention', async () => {
    await harness.render(createElement(FileStorageSection, { onBack: vi.fn() }))
    await vi.waitFor(() => expect($('settings-file-mode')?.value).toBe('machine'))
    expect($('settings-file-retention')).not.toBeNull()
    expect($('settings-kept-retention')).not.toBeNull()
    // No separate switch can leave files on a machine where nobody else can read them.
    expect(harness.container.querySelector('button[role="switch"]')).toBeNull()

    await choose('settings-file-mode', 'cloud')
    expect(f.write).toHaveBeenLastCalledWith({ proactive_upload: true })
    await vi.waitFor(() => expect($('settings-file-retention')).toBeNull())
    expect(harness.container.textContent).toContain('fileStorage.filesCloudHint')

    await choose('settings-file-mode', 'machine')
    expect(f.write).toHaveBeenLastCalledWith({ proactive_upload: false, temporary_transfer: true })
    await vi.waitFor(() => expect($('settings-file-retention')).not.toBeNull())
  })

  it('one control keeps images and temporary files: it writes both stored keys, and says when they differ', async () => {
    f.stored = { ...DEFAULT_FILE_STORAGE, image_retention: '1d', temporary_retention: '30d' }
    await harness.render(createElement(FileStorageSection, { onBack: vi.fn() }))
    await vi.waitFor(() => expect($('settings-kept-retention')?.value).toBe('1d'))
    expect(harness.container.textContent).toContain('fileStorage.keptDiffer')
    await choose('settings-kept-retention', '30d')
    expect(f.write).toHaveBeenLastCalledWith({ image_retention: '30d', temporary_retention: '30d' })
    await vi.waitFor(() => expect(harness.container.textContent).not.toContain('fileStorage.keptDiffer'))
  })

  it('shows only the ordinary rules to someone with no machine bound to a project', async () => {
    f.projects.mockResolvedValue({ mac: [{ localProjectId: 'p', chatId: null }] })
    await harness.render(createElement(FileStorageSection, { onBack: vi.fn() }))
    await vi.waitFor(() => expect(harness.container.textContent).toContain('fileStorage.noMachine'))
    expect($('settings-file-mode')).toBeNull()
    // Temporary files hold in ordinary groups too: the one retention control is everyone's.
    expect($('settings-kept-retention')).not.toBeNull()
    expect(harness.container.textContent).toContain('fileStorage.ordinary')
  })
})
