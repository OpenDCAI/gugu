// @vitest-environment jsdom
import {act} from 'react'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import type {Session} from '@supabase/supabase-js'
import type {ChatChannelList} from '@gugu/core/cloud/chatChannels'
import {createReactHarness} from '../../../support/testHarness'
import {publishRendererSession} from '../../../../apps/desktop/src/lib/sessionPublication'
import {assistantPanelCacheStore} from '../../../../apps/desktop/src/components/assistant/assistant-panel-cache'
import {useChatChannels} from '../../../../apps/desktop/src/components/settings/channels/useChatChannels'
const f=vi.hoisted(()=>({list:vi.fn()}))
vi.mock('@/lib/chatChannels',()=>({rendererChatChannelsClient:()=>({list:f.list})}))
let h:ReturnType<typeof createReactHarness>
beforeEach(()=>{h=createReactHarness()})
const connected={kinds:['wechat'],channels:[{kind:'wechat',accountLabel:'test',agentId:null,isDefault:false,connectedAt:'2026-10-27',health:{state:'running'},lastInboundAt:null,lastOutboundAt:null}],suggestedAgentId:null} as ChatChannelList
const isList=(v:unknown):v is ChatChannelList=>!!v&&typeof v==='object'&&Array.isArray((v as ChatChannelList).channels)
let apply:(value:ChatChannelList)=>void
function Probe({id}:{id:string}){const state=useChatChannels();if(id==='one')apply=state.apply;return <span data-testid={id}>{state.status}|{state.list?.channels.length??0}</span>}
const signIn=(owner:string)=>publishRendererSession('SIGNED_IN',{user:{id:owner},access_token:'fixture'} as Session)
afterEach(()=>{h.cleanup();publishRendererSession('SIGNED_OUT',null)})
it('shows the saved connection on the first frame and retains it when the service is offline',async()=>{
 signIn('wechat-local-owner');const cache=assistantPanelCacheStore();await cache.ready
 cache.accountState('wechat-local-owner','application-connections:wechat',isList).save(connected);await cache.flush()
 const network=Promise.withResolvers<ChatChannelList>();f.list.mockReturnValue(network.promise)
 await h.render(<Probe id="one"/>);expect(h.container.textContent).toBe('ready|1')
 await act(async()=>{network.reject(Error('offline'))})
 expect(h.container.textContent).toBe('ready|1')
})
it('updates every mounted app view after confirmation and clears visible state on an account switch',async()=>{
 signIn('wechat-update-owner');f.list.mockReturnValue(new Promise(()=>{}))
 await h.render(<><Probe id="one"/><Probe id="two"/></>)
 await act(async()=>apply(connected))
 expect([...h.container.querySelectorAll('span')].map(e=>e.textContent)).toEqual(['ready|1','ready|1'])
 await act(async()=>signIn('different-account'))
 expect([...h.container.querySelectorAll('span')].every(e=>e.textContent==='loading|0')).toBe(true)
})
