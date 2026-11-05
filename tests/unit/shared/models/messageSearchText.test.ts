import { describe, expect, it } from 'vitest'
import { AGENT_FAILURE_REASONS } from '@gugu/core/shared/agentQuotaReason'
import type { MessageContentType, MessageItem } from '@gugu/core/shared/types/chat'
import { formatAttachmentMetadata, parseAttachmentContent } from '@gugu/core/shared/ui/attachmentModels'
import { projectMessageSearchText } from '@gugu/core/shared/ui/messageSearchText'
import { parseSystemNotice, turnFailureMarker } from '@gugu/core/shared/ui/systemNotice'
import { parseComposerCard, type ComposerCard } from '@gugu/core/shared/ui/taskCardModels'
import { parseVoiceAttachmentContent } from '@gugu/core/shared/ui/voiceAttachmentModels'
import { message } from '../../../support/testHarness'

const mediaFixtures = [
  ['legacy', formatAttachmentMetadata({
    fileName: 'invoice-zebra.pdf', mimeType: 'application/x-metadataonly',
    kind: 'file', url: 'https://example.invalid/urlforbidden999', sizeBytes: 918273645,
    caption: '附件说明 coralcaption\n第二行 multilinecaption',
  })],
  ['canonical', '[附件] nebula.txt (text/plain)\n[Size] 512\n[Kind] file\n[Caption]\n无URL说明 localcaption'],
  ['no-caption', '[附件] vanilla.pdf (application/pdf)\n[Size] 16\n[Kind] file'],
  ['parentheses', '[附件] budget (revised).pdf (application/pdf)\n[Size] 32\n[Kind] file\n[Caption]\n括号说明'],
  ['mime-absent', '[附件] 资料 (定稿).pdf\n[Size] 64\n[Kind] file\n[Caption]\n没有MIME'],
  ['ambiguous-header', '[附件] draft (final)\n[Size] 128\n[Kind] file'],
  ['image', '[附件] aurora.png (image/png)\n[Size] 256\n[Kind] image\n[Caption]\n北极光说明'],
  ['trim', '[附件] \t\u3000 说明书.txt (text/plain)\u00a0\n[Size] 42\n[Kind] file\n[Caption]\n\u3000\t 首尾空白\n第二行 \u00a0'],
] as const

const voiceContent = '[附件] voice-orchid.ogg (audio/ogg)\n[语音] durationMs=12345\n[转写] 语音独词 violettranscript'
const cardBase = { v: 1 as const, deviceId: 'hidden-device', machineLabel: 'hidden-machine' }
const task: ComposerCard = {
  ...cardBase, type: 'task', text: '任务正文 taskcobalt', agentUserId: 'hidden-agent-id',
  agentName: 'hidden-agent-name', sessionId: 'hidden-session', projectId: 'hidden-project',
  agentAvatar: 'https://example.invalid/hidden-avatar',
}
const schedule: ComposerCard = {
  ...cardBase, type: 'schedule', text: '计划正文 schedulejade',
  automationId: 'hidden-automation', scheduleLabel: '每周 scheduleamber',
}
const question: ComposerCard = {
  ...cardBase, type: 'question', text: '问题正文 questionruby', options: ['选择 optioncedar', '选择 optionbirch'],
  ownerUserId: 'hidden-owner', questionId: 'hidden-question', sessionId: 'hidden-session', projectId: 'hidden-project',
}
const types = ['text', 'card', 'system', 'attachment', 'widget'] as const satisfies readonly MessageContentType[]

describe('message search text', () => {
  it.each([
    null, '', '  多行 Unicode Ω\n第二行\t ', '**Markdown** [link](https://example.invalid)\n> quoted text',
    '{"type":"task","text":"still raw text"}', voiceContent,
  ])('preserves text content without interpreting other message formats: %j', (content) => {
    expect(projectMessageSearchText(message({ content }))).toBe(content ?? '')
  })

  it.each(mediaFixtures)('uses the existing media parser for %s', (_name, content) => {
    const row = message({ content_type: 'attachment', content })
    expect(parseVoiceAttachmentContent(content)).toBeNull()
    const parsed = parseAttachmentContent(content, row)
    expect(parsed).not.toBeNull()
    const projected = projectMessageSearchText(row)
    expect(projected).toBe([parsed!.fileName, parsed!.caption].filter(Boolean).join('\n'))
    for (const hidden of ['urlforbidden999', '918273645', 'metadataonly', '[URL]', '[Size]', '[Kind]', '[Caption]']) {
      expect(projected).not.toContain(hidden)
    }
  })

  it.each([
    { file_item_id: 'hidden-item', file_version: 1 },
    { file_blob_id: 'hidden-blob' },
    { file_item_id: null, file_version: null, file_blob_id: null },
  ])('retains attachment semantics for item, message and gone sources: %j', (reference) => {
    const content = mediaFixtures[1][1]
    const row = message({ content_type: 'attachment', content, ...reference })
    expect(parseAttachmentContent(content, row)).not.toBeNull()
    expect(projectMessageSearchText(row)).toBe('nebula.txt\n无URL说明 localcaption')
  })

  it('accepts the media parser numeric boundary instead of inventing a stricter format', () => {
    const content = '[附件] empty-size.txt (text/plain)\n[Size] \n[Kind] file'
    expect(parseAttachmentContent(content)?.sizeBytes).toBe(0)
    expect(projectMessageSearchText(message({ content_type: 'attachment', content }))).toBe('empty-size.txt')
  })

  it('uses voice filename and transcript without protocol, duration or MIME', () => {
    const parsed = parseVoiceAttachmentContent(voiceContent)
    expect(parsed).not.toBeNull()
    expect(parseAttachmentContent(voiceContent)).toBeNull()
    const projected = projectMessageSearchText(message({ content_type: 'attachment', content: voiceContent }))
    expect(projected).toBe(`${parsed!.fileName}\n${parsed!.transcript}`)
    expect(projected).toBe('voice-orchid.ogg\n语音独词 violettranscript')
    for (const hidden of ['12345', 'audio/ogg', '[语音]', '[转写]', '[附件]']) expect(projected).not.toContain(hidden)
  })

  it.each([
    ...['0', '-1', '1.5', 'NaN'].map(value => voiceContent.replace('12345', value)),
    voiceContent.replace('voice-orchid.ogg (audio/ogg)', ''),
    voiceContent.replace('[附件] ', '[file] '),
    voiceContent.replace('[语音] ', '[voice] '),
    voiceContent.replace('[转写] ', '[transcript] '),
    voiceContent.replace('audio/ogg', 'text/plain'),
    voiceContent.replace('audio/ogg', 'Audio/ogg'),
    voiceContent.replace('语音独词 violettranscript', ' \t'),
    `${voiceContent}\nextra line`,
  ])('excludes an invalid voice only after both product parsers reject it: %j', (content) => {
    expect(parseVoiceAttachmentContent(content)).toBeNull()
    expect(parseAttachmentContent(content)).toBeNull()
    expect(projectMessageSearchText(message({ content_type: 'attachment', content }))).toBe('')
  })

  it('falls through to the media parser for a media envelope with audio MIME', () => {
    const content = '[附件] audio-media.ogg (audio/ogg)\n[Size] 512\n[Kind] file\n[Caption]\n媒体说明 fallbackcaption'
    expect(parseVoiceAttachmentContent(content)).toBeNull()
    expect(parseAttachmentContent(content)).not.toBeNull()
    expect(projectMessageSearchText(message({ content_type: 'attachment', content }))).toBe('audio-media.ogg\n媒体说明 fallbackcaption')
  })

  it.each([
    '[附件] hidden-size.pdf (application/pdf)\n[Size] -1\n[Kind] file\n[Caption]\nnotsearchable',
    '[附件] hidden-size.pdf (application/pdf)\n[Size] invalid\n[Kind] file\n[Caption]\nnotsearchable',
    '[附件] hidden-kind.pdf (application/pdf)\n[Size] 1\n[Kind] other\n[Caption]\nnotsearchable',
    '[附件] hidden-url.pdf (application/pdf)\n[URL] \n[Size] 1\n[Kind] file\n[Caption]\nnotsearchable',
    '[附件] hidden-position.pdf (application/pdf)\n[Size] 1\n[Kind] file\nwrongmarker\nnotsearchable',
    '[附件] hidden-empty-caption.pdf (application/pdf)\n[Size] 1\n[Kind] file\n[Caption]\n \t',
    '[附件] hidden-incomplete.pdf (application/pdf)\n[Size] 1',
  ])('excludes malformed attachment raw metadata: %j', (content) => {
    expect(parseVoiceAttachmentContent(content)).toBeNull()
    expect(parseAttachmentContent(content)).toBeNull()
    expect(projectMessageSearchText(message({ content_type: 'attachment', content }))).toBe('')
  })

  it.each([
    [task, '任务正文 taskcobalt'],
    [schedule, '计划正文 schedulejade\n每周 scheduleamber'],
    [question, '问题正文 questionruby\n选择 optioncedar\n选择 optionbirch'],
    [{ ...question, options: [] }, '问题正文 questionruby'],
  ] as const)('projects only the message-owned fields of a %j card', (card, expected) => {
    const content = JSON.stringify({ ...card, unknown: 'hidden-extra' })
    expect(parseComposerCard(content)).not.toBeNull()
    const projected = projectMessageSearchText(message({ content_type: 'card', content }))
    expect(projected).toBe(expected)
    expect(projected).not.toContain('hidden-')
    expect(projected).not.toContain('"text"')
  })

  it.each([
    '{bad JSON', 'null', JSON.stringify({ ...task, v: 2 }), JSON.stringify({ ...task, type: 'unknown' }),
    JSON.stringify({ ...task, agentUserId: '' }), JSON.stringify({ ...task, files: ['invalid'] }),
    JSON.stringify({ ...question, options: 'not-an-array' }),
    JSON.stringify({ ...question, options: [1] }), JSON.stringify({ ...question, options: [''] }),
  ])('retains raw content when the card parser selects the ordinary text presentation: %j', (content) => {
    expect(parseComposerCard(content)).toBeNull()
    expect(projectMessageSearchText(message({ content_type: 'card', content }))).toBe(content)
  })

  it.each([
    { content: '系统正文 systemmaple', client_message_id: null },
    { content: '创建话题 topicwillow', client_message_id: 'topic-opened:hidden-topic-id' },
    { content: '旧名旧姓 joinpoplar 加入群聊', id: 'join-fixture', sender_user_id: null, client_message_id: 'member-joined:join-fixture:member-a,member-b' },
    { content: '消息较多 floodcedar', client_message_id: 'agent-flood:hidden-ledger-id' },
  ])('retains server-owned system body: %j', (overrides) => {
    const row = message({ content_type: 'system', ...overrides })
    expect(parseSystemNotice(row)?.kind).not.toBe('turn-failure')
    expect(projectMessageSearchText(row)).toBe(overrides.content)
  })

  it.each(AGENT_FAILURE_REASONS)('excludes structured failure %s, whether visible or hidden', (reason) => {
    const row = message({ content_type: 'system', content: 'hidden diagnostic text', client_message_id: turnFailureMarker('message-1', reason) })
    expect(parseSystemNotice(row)).toEqual({ kind: 'turn-failure', reason })
    expect(projectMessageSearchText(row)).toBe('')
  })

  it.each([
    { client_message_id: 'turn-failure:different-message:timeout' },
    { client_message_id: 'turn-failure:message-1:unknown-reason' },
    { client_message_id: 'ordinary-marker' },
    { client_message_id: 'turn-failure:message-1:timeout', sender_user_id: null },
  ])('uses the system parser instead of classifying unrecognized or forged markers: %j', (overrides) => {
    const row = message({ content_type: 'system', content: 'ordinary fallback timeout', ...overrides })
    expect(parseSystemNotice(row)).toBeNull()
    expect(projectMessageSearchText(row)).toBe(row.content)
  })

  it.each(['{"text":"hidden-widget","url":"https://example.invalid/hidden"}', 'malformed hidden widget'])('excludes widget payloads: %j', (content) => {
    expect(projectMessageSearchText(message({ content_type: 'widget', content }))).toBe('')
  })

  it.each(types)('handles null, empty and retracted %s messages', (content_type) => {
    for (const content of [null, '']) expect(projectMessageSearchText(message({ content_type, content }))).toBe('')
    const content = content_type === 'attachment' ? voiceContent : content_type === 'card' ? JSON.stringify(task) : 'hidden retracted body'
    expect(projectMessageSearchText(message({ content_type, content, retracted_at: '2026-01-01T00:00:00Z' }))).toBe('')
  })

  it('leaves the original message and unrelated viewer state unchanged', () => {
    const row: MessageItem = message({
      content_type: 'attachment', content: mediaFixtures[1][1], file_item_id: 'item-before', file_version: 3,
      reply_to_content: 'hidden quote preview', reactions: [{ emoji: 'hidden reaction', count: 1, my_reaction: false }],
    })
    const before = structuredClone(row)
    Object.freeze(row)
    expect(projectMessageSearchText(row)).toBe('nebula.txt\n无URL说明 localcaption')
    expect(row).toEqual(before)
  })
})
