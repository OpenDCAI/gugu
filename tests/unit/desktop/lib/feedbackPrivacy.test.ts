import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ upload: vi.fn(), remove: vi.fn(), from: vi.fn(), insert: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({
  dataClient: { storage: { from: mocks.from } },
  identityDb: { from: () => ({ insert: mocks.insert }) },
}))
import { submitFeedbackWithScreenshots } from '../../../../apps/desktop/src/lib/feedback'
import { FEEDBACK_SCREENSHOT_BUCKET } from '../../../../apps/desktop/src/lib/feedbackMedia'

const input = { userId: 'test-owner', content: ' test feedback ', module: 'other' as const,
  appVersion: 'test', platform: 'test', diagnostics: {}, screenshots: [new File(['image'], 'a.png', { type: 'image/png' })] }
beforeEach(() => {
  vi.resetAllMocks()
  mocks.from.mockReturnValue({ upload: mocks.upload, remove: mocks.remove })
  mocks.upload.mockResolvedValue({ error: null }); mocks.remove.mockResolvedValue({ error: null }); mocks.insert.mockResolvedValue({ error: null })
})
describe('private feedback submission', () => {
  it('uploads privately and saves only object references', async () => {
    await submitFeedbackWithScreenshots(input)
    expect(mocks.from).toHaveBeenCalledWith(FEEDBACK_SCREENSHOT_BUCKET)
    const path = mocks.upload.mock.calls[0][0]
    expect(path).toMatch(/^test-owner\/.+-a.png$/)
    expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({ screenshot_paths: [path], content: 'test feedback' }))
    expect(mocks.insert.mock.calls[0][0]).not.toHaveProperty('screenshot_urls')
    expect(mocks.remove).not.toHaveBeenCalled()
  })
  it('cleans already uploaded objects when a later upload fails and does not save a partial row', async () => {
    mocks.upload.mockResolvedValueOnce({ error: null }).mockResolvedValueOnce({ error: { message: 'upload failed' } })
    await expect(submitFeedbackWithScreenshots({ ...input, screenshots: [...input.screenshots, ...input.screenshots] })).rejects.toThrow('upload failed')
    expect(mocks.remove).toHaveBeenCalledWith([mocks.upload.mock.calls[0][0]])
    expect(mocks.insert).not.toHaveBeenCalled()
  })
  it('cleans this submission when row insertion fails and reports that failure', async () => {
    mocks.insert.mockResolvedValue({ error: { message: 'row failed' } })
    await expect(submitFeedbackWithScreenshots(input)).rejects.toThrow('row failed')
    expect(mocks.remove).toHaveBeenCalledWith([mocks.upload.mock.calls[0][0]])
  })
})
