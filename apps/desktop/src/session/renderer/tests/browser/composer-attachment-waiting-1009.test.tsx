import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ChatComposer } from '@gugu/session-ui/react/components'
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@gugu/session-ui/styles/global'
import '@gugu/session-ui/theme/theme.css'
import '@gugu/session-ui/theme/semantic.css'
import '@gugu/session-ui/styles/base.css'
import '@/styles/tokens.css'
import '@renderer/index.css'

let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => { root?.unmount(); host?.remove(); root = null; host = null })

it.each([400, 900])('keeps waiting beside the attachment and leaves its cancel control usable at %spx', async (width) => {
  host = document.createElement('div')
  host.className = 'gugu-skin'
  host.style.width = `${width}px`
  document.body.appendChild(host)
  root = createRoot(host)
  const changed = vi.fn()
  const render = (attachmentStatus?: string) => root!.render(<SessionLocalizationProvider>
    <ChatComposer attachments={[{ id: 'image', name: 'image.png', kind: 'image', state: 'uploading', progress: 40, cancelable: true, meta: 'Uploading' }]}
      attachmentStatus={attachmentStatus} onAttachmentsChange={changed} onSubmit={() => {}} />
  </SessionLocalizationProvider>)
  render()
  await until('composer mounted', () => !!host!.querySelector('[data-slot="composer-bar"]'))
  const height = host.getBoundingClientRect().height
  render('附件传完就发送…')
  await until('waiting hint mounted', () => !!host!.querySelector('[data-slot="composer-attachment-status"]'))
  const status = host.querySelector<HTMLElement>('[data-slot="composer-attachment-status"]')
  expect(status).not.toBeNull()
  expect(status!.getAttribute('role')).toBe('status')
  expect(status!.closest('[data-slot="composer-attachments"]')).not.toBeNull()
  expect(host.querySelector('[data-slot="composer-notice"]')).toBeNull()
  expect(host.getBoundingClientRect().height).toBeLessThanOrEqual(height + 1)
  expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth)
  const cancel = host.querySelector<HTMLButtonElement>('[data-slot="composer-attachment"] button')!
  expect(cancel.getBoundingClientRect().width).toBeGreaterThan(0)
  cancel.click()
  expect(changed).toHaveBeenCalledExactlyOnceWith([])
  render()
  await until('waiting hint cleared', () => !host!.querySelector('[data-slot="composer-attachment-status"]'))
})


it('keeps screenshot quality on the second line, stops preview propagation and locks it during sending', async () => {
  host = document.createElement('div'); host.className = 'gugu-skin'; host.style.width = '400px'; document.body.appendChild(host); root = createRoot(host);
  const changed = vi.fn(), viewed = vi.fn();
  const render = (locked: boolean) => root!.render(<SessionLocalizationProvider><ChatComposer
    attachments={[{ id: 'image', name: 'screenshot.webp', kind: 'image', imageQuality: 'compressed', previewUrl: 'data:image/webp;base64,', state: 'uploading', progress: 40, cancelable: true, meta: '120 KB / 300 KB · 40%' }]}
    onAttachmentQualityChange={changed} onViewAttachment={viewed} attachmentQualityLocked={locked} onSubmit={() => {}} />
  </SessionLocalizationProvider>);
  render(false);
  await until('quality action mounted', () => [...host!.querySelectorAll('button')].some(button => /Send original|发原图/.test(button.textContent ?? '')));
  const quality = [...host.querySelectorAll('button')].find(button => /Send original|发原图/.test(button.textContent ?? ''))!;
  const name = host.querySelector('[data-slot="composer-attachment"] span span')!;
  expect(quality.getBoundingClientRect().top).toBeGreaterThan(name.getBoundingClientRect().top);
  quality.click();
  quality.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  expect(changed).toHaveBeenCalledWith('image'); expect(viewed).not.toHaveBeenCalled();
  render(true);
  await until('quality action locked', () => quality.disabled);
  quality.click(); expect(changed).toHaveBeenCalledTimes(1);
});
