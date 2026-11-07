// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { AttachmentsError } from '@gugu/core/cloud/attachmentsApi'
import { i18n, setLocalePreference } from '../../../../apps/desktop/src/i18n'
import { chatSendFailureNotice } from '../../../../apps/desktop/src/components/chat/chatSendFailureNotice'

afterEach(() => setLocalePreference('zh-CN'))

function notice(files: File[], error: unknown = new Error('HTTP 503 /Users/private sk-secret\nraw stack')) {
  return chatSendFailureNotice(files, error, i18n.getFixedT(null, 'messaging'))
}

describe('attachment failure notices', () => {
  it.each([
    ['IMG_123.png', '', '图片'],
    ['clip.mp4', 'video/mp4', '视频'],
    ['voice.mp3', 'audio/mpeg', '音频'],
    ['report.pdf', 'application/pdf', '文件'],
  ])('names the localized type and filename for %s', (name, type, kind) => {
    setLocalePreference('zh-CN')
    expect(notice([new File(['data'], name, { type })])).toEqual({ tier: 'error', title: `${kind} ${name} 没发出去：发送未完成，请稍后重新发送` })
  })

  it('groups a batch into one notice with all filenames behind a native expansion', () => {
    setLocalePreference('zh-CN')
    const files = ['first.txt', 'second.txt', 'third.txt'].map(name => new File(['data'], name))
    const result = notice(files)
    expect(result.title).toBe('3 个文件没发出去：发送未完成，请稍后重新发送')
    const description = document.createElement('div')
    description.innerHTML = renderToStaticMarkup(<>{result.description}</>)
    expect(description.querySelector('details')?.open).toBe(false)
    expect(description.querySelector('summary')?.textContent).toBe('查看这 3 个未发出的文件')
    expect([...description.querySelectorAll('li')].map(item => item.textContent)).toEqual(files.map(file => `文件 ${file.name}`))
    expect(description.textContent).not.toMatch(/HTTP|private|secret|raw stack/)
  })

  it('keeps repeated filenames and escapes filename markup', () => {
    setLocalePreference('zh-CN')
    const file = new File(['data'], '<img onerror=alert(1)>.png')
    const result = notice([file, file])
    const markup = renderToStaticMarkup(<>{result.description}</>)
    expect(markup).toContain('&lt;img')
    expect(markup).not.toContain('<img')
    expect(markup.match(/<li>/g)).toHaveLength(2)
  })

  it.each([401, 403, 413, 429, 503])('translates a recognized status without displaying diagnostics (%s)', status => {
    setLocalePreference('zh-CN')
    const result = notice([new File(['data'], 'notes.txt')], new AttachmentsError('upload', status, 'failed', 'raw diagnostic'))
    expect(result.title).toContain('文件 notes.txt 没发出去：')
    expect(result.title).not.toMatch(/raw diagnostic|attachments|HTTP|failureReason/)
  })

  it('localizes single and batch notices in English', () => {
    setLocalePreference('en-US')
    const image = new File(['data'], 'IMG_123.png', { type: 'image/png' })
    expect(notice([image]).title).toBe('Image IMG_123.png was not sent: The send did not finish. Try sending it again later.')
    const result = notice([image, new File(['data'], 'report.pdf')])
    expect(result.title).toBe('2 files were not sent: The send did not finish. Try sending it again later.')
    expect(renderToStaticMarkup(<>{result.description}</>)).toContain('Show the 2 unsent files')
  })
})
