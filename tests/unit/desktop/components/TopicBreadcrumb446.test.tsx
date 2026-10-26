// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { serializeComposerCard } from '@gugu/core/shared/ui/taskCardModels'
vi.mock('react-i18next', async (original) => ({ ...await original<typeof import('react-i18next')>(), useTranslation: () => ({ t: (_key: string, args?: { preview: string }) => `Source: ${args?.preview ?? ''}` }) }))
const { TopicBreadcrumb } = await import('../../../../apps/desktop/src/components/chat/TopicBreadcrumb')
const card = serializeComposerCard({ v: 1, type: 'task', text: 'Read the README', agentUserId: 'agent', agentName: 'Claude', sessionId: 'session', projectId: 'project', deviceId: 'machine', machineLabel: 'Mac' })
describe('task topic source preview', () => {
  it('shows the task text instead of the card JSON on the desktop breadcrumb', () => {
    const html = renderToStaticMarkup(createElement(TopicBreadcrumb, { topicName: 'Renamed topic', sourceMessagePreview: card }))
    expect(html).toContain('Source: Read the README')
    expect(html).not.toContain('agentUserId')
  })
  it('does not repeat the task text if it is already the topic name', () => {
    const html = renderToStaticMarkup(createElement(TopicBreadcrumb, { topicName: 'Read the README', sourceMessagePreview: card }))
    expect(html).not.toContain('topic-breadcrumb-source-preview')
  })
})
