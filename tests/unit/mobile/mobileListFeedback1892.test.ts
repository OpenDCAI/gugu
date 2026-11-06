// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { mobileListDiagnostics } from '../../../apps/desktop/src/mobile/mobileListDiagnostics'
import { collectFeedbackDiagnostics } from '../../../apps/desktop/src/lib/feedback'

const cloud = vi.hoisted(() => ({ from: vi.fn() }))
vi.mock('../../../apps/desktop/src/lib/supabase', () => ({ dataClient: {}, identityDb: cloud }))
vi.mock('../../../apps/desktop/src/lib/publicMedia', () => ({ uploadPublicMedia: vi.fn() }))
vi.mock('../../../apps/desktop/src/lib/log', () => ({ rendererLogger: () => ({ info: vi.fn() }) }))
afterEach(() => { mobileListDiagnostics.reset(); vi.clearAllMocks() })

it('takes a content-free copy through the existing feedback snapshot without sending it', () => {
  mobileListDiagnostics.openRow('private-chat-id')
  const snapshot = collectFeedbackDiagnostics()
  expect(snapshot.mobile_list_diagnostics).toMatchObject({ version: 1, entries: [{ event: 'row-open', row: 1 }] })
  expect(JSON.stringify(snapshot.mobile_list_diagnostics)).not.toContain('private-chat-id')
  expect(cloud.from).not.toHaveBeenCalled()
  mobileListDiagnostics.reset()
  expect(snapshot.mobile_list_diagnostics).toMatchObject({ entries: [{ event: 'row-open', row: 1 }] })
})
