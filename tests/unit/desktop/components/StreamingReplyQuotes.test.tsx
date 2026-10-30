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
const quote=()=>h.container.querySelector('.gg-chat-reply-preview > [title="跳到被引用的消息"]')
const marker=()=>h.container.querySelector<HTMLElement>('[data-chat-reply-quote]')?.dataset.marker
it('applies the same latest-target rule while the reply is still streaming',async()=>{
 await render([row('question','user-1')],'question')
 expect(marker()).toBe('false');expect(h.container.textContent).toContain('正在回复')
})
it('keeps the older-target mark even after another reply to the same target',async()=>{
 await render([row('old','user-1'),row('new','user-1')],'old')
 expect(quote()).not.toBeNull()
 await render([row('old','user-1'),row('new','user-1'),row('previous','agent','old')],'old')
 expect(marker()).toBe('true')
})
it.each(['group','topic'] as const)('retains the group preview with no redundant adjacent mark in a %s',async kind=>{
 await render([row('question','user-1')],'question',kind)
 expect(marker()).toBe('false')
 expect(quote()).not.toBeNull()
 expect(quote()!.closest('[data-testid="message-bubble-action-target"]')).not.toBeNull()
})
it('a streamed direct reply draws the same one-line quote above the bubble as the persisted one',async()=>{
 await render([row('old','user-1'),row('new','user-1')],'old')
 expect(quote()?.getAttribute('data-testid')).toBe('direct-message-quote')
})
