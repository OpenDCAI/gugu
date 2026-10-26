// @vitest-environment jsdom
import { beforeEach,afterEach,expect,it,vi } from 'vitest'
import { createReactHarness,message,renderWithAppProviders,clickElement } from '../../../support/testHarness'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import type { MemberProfileCardModel } from '../../../../apps/desktop/src/components/MemberProfileCard'
import { MessageList,type MessageListRowProps } from '../../../../apps/desktop/src/components/chat/MessageList'
vi.mock('../../../../apps/desktop/src/hooks/useAgentHarnessIdentity',()=>({useAgentHarnessIdentity:()=> 'codex'}))
let h:ReturnType<typeof createReactHarness>
const noop=()=>{}
const profile=(id:string,type:'human'|'agent'):MemberProfileCardModel=>({id,displayName:type==='human'?'测试用户':'咕咕',avatar:null,email:null,bio:null,type,role:'member',profileScope:'group'})
const msg=(id:string,sender:string,seq:number,reply?:string)=>message({id,chat_id:'dm',sender_user_id:sender,seq,is_mine:sender==='user-1',content:`正文 ${id}`,reply_to_message_id:reply??null,reply_to_sender_user_id:reply?'user-1':null,reply_to_content:reply?'原消息':null})
const quoted=(id:string)=>h.container.querySelector<HTMLElement>(`[data-msg-id="${id}"] [title="跳到被引用的消息"]`)
beforeEach(()=>{h=createReactHarness();vi.stubGlobal('IntersectionObserver',class{observe(){}unobserve(){}disconnect(){}})})
afterEach(()=>{h.cleanup();vi.unstubAllGlobals()})
async function render(messages:MessageItem[],mobile=false,group=false,onShowMessage=vi.fn()){
 const rows=messages.map(message=>({type:'message' as const,message}))
 const rowProps:MessageListRowProps={rows,messages,isFiltering:false,mobile,isAgentChat:!group,isGroupChat:group,memberReadSeqs:{},memberProfiles:{'user-1':profile('user-1','human'),'agent':profile('agent','agent')},onReaction:noop,onQuote:noop,onForward:noop,onDelete:noop,onVisible:noop,onShowMessage,onShowReadReceipt:undefined,highlight:undefined,flashMessageId:undefined,threeParty:undefined,onOpenMemberProfile:undefined,onOpenTopic:undefined,topicAnchors:undefined,onOpenTopicAnchor:undefined,agentFloodNoticeMessageId:undefined,onAgentFloodUndone:undefined,onOpenFile:undefined,onOpenLocalFileLink:undefined,onMentionMember:undefined,selectMode:false,selectedIds:new Set(),onToggleSelect:noop,onEnterSelectMode:undefined}
 await renderWithAppProviders(h,<MessageList rows={rows} rowProps={rowProps}/>)
 return {onShowMessage}
}
it.each([false,true])('hides routine direct replies without changing their reply metadata (mobile=%s)',async mobile=>{
 const messages=[msg('question','user-1',1),msg('answer-1','agent',2,'question'),msg('answer-2','agent',3,'question')]
 const original=JSON.stringify(messages)
 await render(messages,mobile)
 expect(quoted('answer-1')).toBeNull();expect(quoted('answer-2')).toBeNull()
 expect(h.container.textContent).toContain('正文 answer-2')
 expect(JSON.stringify(messages)).toBe(original)
})
it.each([false,true])('shows the first older-target quote and preserves its jump (mobile=%s)',async mobile=>{
 const messages=[msg('old','user-1',1),msg('new','user-1',2),msg('answer-1','agent',3,'old'),msg('answer-2','agent',4,'old')]
 const {onShowMessage}=await render(messages,mobile)
 expect(quoted('answer-1')).not.toBeNull();expect(quoted('answer-2')).toBeNull()
 await clickElement(quoted('answer-1')!)
 expect(onShowMessage).toHaveBeenCalledWith('old')
})
it('keeps repeated quote headers in a group or topic',async()=>{
 await render([msg('question','user-1',1),msg('answer-1','agent',2,'question'),msg('answer-2','agent',3,'question')],false,true)
 expect(quoted('answer-1')).not.toBeNull();expect(quoted('answer-2')).not.toBeNull()
})
