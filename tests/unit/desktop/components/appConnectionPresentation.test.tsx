// @vitest-environment jsdom
import {act,createElement} from 'react'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {createReactHarness} from '../../../support/testHarness'
import '../../../../apps/desktop/src/i18n/registerAssistantCatalog'
import {AppConnectionHero} from '../../../../apps/desktop/src/components/assistant/AppConnectionHero'
import {CliInstallProgress,type CliDownloadProgress} from '../../../../apps/desktop/src/session/renderer/features/integrations/CliInstallProgress'
let h:ReturnType<typeof createReactHarness>
beforeEach(()=>{h=createReactHarness()})
afterEach(()=>{h.cleanup();vi.useRealTimers()})
it('keeps the same detail slots while the action metadata is loading',async()=>{
 await h.render(createElement(AppConnectionHero,{description:'管理文档',loading:true,label:'连接',onConnect:vi.fn()}))
 expect(h.container.querySelector('[aria-busy="true"]')).not.toBeNull()
 expect(h.container.textContent).not.toContain('正在读取')
 expect(h.container.querySelector('button')).toBeNull()
 expect(h.container.querySelector('[data-testid="app-connection-action-pending"]')).not.toBeNull()
 await h.render(createElement(AppConnectionHero,{description:'管理文档',label:'连接',onConnect:vi.fn()}))
 expect(h.container.querySelector('.ta-app-connection-icon')).not.toBeNull()
 expect(h.container.querySelector('.ta-app-connection-action button')?.textContent).toBe('连接')
})
it('never presents an unreadable progress sample as complete or a zero MB ratio',async()=>{
 vi.useFakeTimers()
 const read=vi.fn<()=>Promise<CliDownloadProgress>>().mockResolvedValueOnce({phase:'download',receivedBytes:1048576,totalBytes:2097152} as CliDownloadProgress).mockRejectedValue(Error('unavailable'))
 await h.render(createElement(CliInstallProgress,{read,idle:createElement('p',null,'preparing')}))
 expect(h.container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('50')
 await act(async()=>{await vi.advanceTimersByTimeAsync(750)})
 // 读不到就不知道还在不在下:退回调用方的「正在准备连接」,❌ 留着旧比例或说在下载。
 expect(h.container.querySelector('[role="progressbar"]')).toBeNull()
 expect(h.container.querySelector('progress')).toBeNull()
 expect(h.container.textContent).toBe('preparing')
})
it('shows no download bar or wording when the tool is already installed or preinstalled',async()=>{
 await h.render(createElement(CliInstallProgress,{read:async()=>null,idle:createElement('p',null,'preparing')}))
 expect(h.container.querySelector('[role="progressbar"]')).toBeNull()
 expect(h.container.textContent).toBe('preparing')
 await h.render(createElement(CliInstallProgress,{read:async()=>null}))
 expect(h.container.textContent).toBe('')
})
it('uses indeterminate kit progress for unknown or tiny download totals',async()=>{
 for (const totalBytes of [null,0,5]) {
  await h.render(createElement(CliInstallProgress,{read:async()=>({phase:'download',receivedBytes:0,totalBytes} as CliDownloadProgress)}))
  expect(h.container.querySelector('[role="progressbar"]')?.hasAttribute('aria-valuenow')).toBe(false)
  expect(h.container.textContent).not.toContain('0.0')
 }
})
