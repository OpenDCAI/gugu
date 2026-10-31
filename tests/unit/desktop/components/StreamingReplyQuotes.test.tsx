// @vitest-environment jsdom
import { afterEach,beforeEach,expect,it,vi } from 'vitest'
import { createReactHarness,renderWithAppProviders,chat,message } from '../../../support/testHarness'
import { AssistantStreamingReply } from '../../../../apps/desktop/src/components/assistant/AssistantStreamingReply'
import type { MessageItem } from '@gugu/core/shared/types/chat'
vi.mock('../../../../apps/desktop/src/hooks/useAgentHarnessIdentity',()=>({useAgentHarnessIdentity:()=> 'codex'}))
let h:ReturnType<typeof createReactHarness>
const row=(id:string,sender:string,reply:string|null=null)=>message({id,chat_id:'dm',sender_user_id:sender,content:`消息 ${id}`,reply_to_message_id:reply})
beforeEach(()=>{h=createReactHarness()})
afterEach(()=>h.cleanup())
async function render(messages:MessageItem[],target:string,kind:'ai'|'group'|'topic'='ai'){await renderWithAppProviders(h,<AssistantStreamingReply activity={{phase:'draft',id:'draft',text:'正在回复',replyToMessageId:target}}/>,{chat:{activeChat:chat({id:'dm',kind,peer_user_id:'agent'}),messages}})}
const quote=()=>h.container.querySelector('.gg-chat-reply-preview')
const marker=()=>h.container.querySelector<HTMLElement>('[data-chat-reply-quote]')?.dataset.marker
it('keeps an explicit tool-reply target while the reply is still streaming',async()=>{
 await render([row('question','user-1')],'question')
 expect(marker()).toBe('true');expect(h.container.textContent).toContain('正在回复')
})
it('keeps the older-target mark even after another reply to the same target',async()=>{
 await render([row('old','user-1'),row('new','user-1')],'old')
 expect(quote()).toBeNull()
 await render([row('old','user-1'),row('new','user-1'),row('previous','agent','old')],'old')
 expect(marker()).toBe('true')
})
it.each(['group','topic'] as const)('keeps only the explicit group mark at rest in a %s',async kind=>{
 await render([row('question','user-1')],'question',kind)
 expect(marker()).toBe('true')
 expect(quote()).toBeNull()
 expect(h.container.textContent).not.toContain('消息 question')
})
it('a streamed direct tool reply does not expose its source text at rest',async()=>{
 await render([row('old','user-1'),row('new','user-1')],'old')
 expect(quote()).toBeNull();expect(marker()).toBe('true')
})
