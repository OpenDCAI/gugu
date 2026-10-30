// @vitest-environment jsdom
import { beforeEach,afterEach,expect,it,vi } from 'vitest'
import { createReactHarness,message,renderWithAppProviders,clickElement } from '../../../support/testHarness'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import type { MemberProfileCardModel } from '../../../../apps/desktop/src/components/MemberProfileCard'
import { MessageList,type MessageListRowProps } from '../../../../apps/desktop/src/components/chat/MessageList'
import { quoteSummary } from '../../../../apps/desktop/src/components/chat/quoteSummary'
import { serializeComposerCard } from '@gugu/core/shared/ui/taskCardModels'
vi.mock('../../../../apps/desktop/src/hooks/useAgentHarnessIdentity',()=>({useAgentHarnessIdentity:()=> 'codex'}))
let h:ReturnType<typeof createReactHarness>
const noop=()=>{}
const profile=(id:string,type:'human'|'agent'):MemberProfileCardModel=>({id,displayName:type==='human'?'测试用户':'咕咕',avatar:null,email:null,bio:null,type,role:'member',profileScope:'group'})
const msg=(id:string,sender:string,seq:number,reply?:string)=>message({id,chat_id:'dm',sender_user_id:sender,seq,is_mine:sender==='user-1',content:`正文 ${id}`,reply_to_message_id:reply??null,reply_to_sender_user_id:reply?'user-1':null,reply_to_content:reply?'原消息':null})
const quoted=(id:string)=>h.container.querySelector<HTMLElement>(`[data-msg-id="${id}"] .gg-chat-reply-preview > [title="跳到被引用的消息"]`)
const marker=(id:string)=>h.container.querySelector<HTMLElement>(`[data-msg-id="${id}"] [data-chat-reply-quote]`)?.dataset.marker
const inBubble=(id:string)=>!!quoted(id)?.closest('[data-testid="message-bubble-action-target"]')
beforeEach(()=>{h=createReactHarness();vi.stubGlobal('IntersectionObserver',class{observe(){}unobserve(){}disconnect(){}})})
afterEach(()=>{h.cleanup();vi.unstubAllGlobals()})
async function render(messages:MessageItem[],mobile=false,group=false,onShowMessage=vi.fn()){
 const rows=messages.map(message=>({type:'message' as const,message}))
 const rowProps:MessageListRowProps={rows,messages,isFiltering:false,mobile,isAgentChat:!group,isGroupChat:group,memberReadSeqs:{},queuedIds:new Set(),memberProfiles:{'user-1':profile('user-1','human'),'agent':profile('agent','agent')},onReaction:noop,onQuote:noop,onForward:noop,onDelete:noop,onVisible:noop,onShowMessage,onShowReadReceipt:undefined,highlight:undefined,flashMessageId:undefined,threeParty:undefined,onOpenMemberProfile:undefined,onOpenTopic:undefined,topicAnchors:undefined,onOpenTopicAnchor:undefined,agentFloodNoticeMessageId:undefined,onAgentFloodUndone:undefined,onOpenFile:undefined,onOpenLocalFileLink:undefined,onMentionMember:undefined,selectMode:false,selectedIds:new Set(),onToggleSelect:noop,onEnterSelectMode:undefined}
 await renderWithAppProviders(h,<MessageList rows={rows} rowProps={rowProps}/>)
 return {onShowMessage}
}
it.each([false,true])('retains explicit direct quotes for disclosure without changing reply metadata (mobile=%s)',async mobile=>{
 const messages=[msg('question','user-1',1),msg('answer-1','agent',2,'question'),msg('answer-2','agent',3,'question')]
 const original=JSON.stringify(messages)
 await render(messages,mobile)
 expect(marker('answer-1')).toBe('false');expect(marker('answer-2')).toBe('true')
 expect(quoted('answer-1')).not.toBeNull();expect(quoted('answer-2')).not.toBeNull()
 expect(h.container.textContent).toContain('正文 answer-2')
 expect(JSON.stringify(messages)).toBe(original)
})
it.each([false,true])('keeps a jump mark on each older-target reply (mobile=%s)',async mobile=>{
 const messages=[msg('old','user-1',1),msg('new','user-1',2),msg('answer-1','agent',3,'old'),msg('answer-2','agent',4,'old')]
 const {onShowMessage}=await render(messages,mobile)
 expect(marker('answer-1')).toBe('true');expect(marker('answer-2')).toBe('true')
 await clickElement(quoted('answer-1')!)
 expect(onShowMessage).toHaveBeenCalledWith('old')
})
it('uses actual adjacency for group jump marks too',async()=>{
 await render([msg('question','user-1',1),msg('answer-1','agent',2,'question'),msg('answer-2','agent',3,'question')],false,true)
 expect(marker('answer-1')).toBe('false');expect(marker('answer-2')).toBe('true')
})
it.each([false,true])('retains the direct preview above the bubble: sender · summary (mobile=%s)',async mobile=>{
 await render([msg('old','user-1',1),msg('new','user-1',2),msg('answer','agent',3,'old')],mobile)
 expect(quoted('answer')?.dataset.testid).toBe('direct-message-quote')
 expect([...quoted('answer')!.querySelectorAll(':scope > span')].map(span=>span.textContent)).toEqual(['测试用户 ·','原消息'])
 expect(inBubble('answer')).toBe(false)
})
it('the group quote keeps its in-bubble two-line style',async()=>{
 await render([msg('question','user-1',1),msg('answer','agent',2,'question')],false,true)
 expect(quoted('answer')?.dataset.testid).toBeUndefined()
 expect(inBubble('answer')).toBe(true)
})
it('the direct quote summary is cut to 24 characters on one line',()=>{
 expect(quoteSummary('一二三四五六七八九十一二三四五六七八九十一二三四')).toBe('一二三四五六七八九十一二三四五六七八九十一二三四')
 expect(quoteSummary('一二三四五六七八九十一二三四五六七八九十一二三四五')).toBe('一二三四五六七八九十一二三四五六七八九十一二三四…')
 expect(quoteSummary('  第一行\n\n 第二行 ')).toBe('第一行 第二行')
 expect(quoteSummary(`${'一'.repeat(23)}👨‍👩‍👧尾巴`)).toBe(`${'一'.repeat(23)}👨‍👩‍👧…`)
})
for(const group of [false,true]) it.each([false,true])(`shows an incoming selected excerpt exactly once and retains its source jump (group=${group}, mobile=%s)`,async mobile=>{
 const source={...msg('old','user-1',1),content:'Alpha original paragraph. Beta chosen.'}
 const reply={...msg('answer','agent',3,'old'),content:'> [测试用户]: Beta chosen.\nPlease explain.',reply_to_content:source.content}
 const {onShowMessage}=await render([source,msg('new','user-1',2),reply],mobile,group)
 expect(inBubble('answer')).toBe(group)
 expect(quoted('answer')?.textContent).toContain('Beta chosen.')
 expect(quoted('answer')?.textContent).not.toContain('Alpha original')
 const row=h.container.querySelector('[data-msg-id="answer"]')!
 expect(row.textContent?.match(/Beta chosen\./g)).toHaveLength(1)
 await clickElement(quoted('answer')!)
 expect(onShowMessage).toHaveBeenCalledWith('old')
})
it.each([false,true])('retains a selected excerpt for disclosure without a redundant adjacent mark (mobile=%s)',async mobile=>{
 const source={...msg('latest','user-1',1),content:'Alpha original paragraph. Beta chosen.'}
 const reply={...msg('answer','agent',2,'latest'),content:'> [测试用户]: Beta chosen.\nPlease explain.',reply_to_content:source.content}
 await render([source,reply],mobile)
 expect(quoted('answer')?.textContent).toContain('Beta chosen.')
 expect(marker('answer')).toBe('false')
})
it('retains old inline quotes without a structural reply ID',async()=>{
 await render([{...msg('legacy','user-1',1),content:'> [Ada]: Legacy quoted text\nLegacy answer.'}])
 expect(h.container.textContent).toContain('Legacy quoted text')
 expect(h.container.textContent).toContain('Legacy answer.')
 expect(quoted('legacy')).toBeNull()
})
it.each([false,true])('keeps reply text visible for an ambiguous older quote beginning with > (mobile=%s)',async mobile=>{
 const reply={...msg('answer','agent',3,'old'),content:'> [测试用户]: Beta\n> Answer',reply_to_content:'Alpha Beta'}
 await render([msg('old','user-1',1),msg('new','user-1',2),reply],mobile)
 const body=h.container.querySelector('[data-msg-id="answer"] [data-testid="message-bubble-action-target"] .gg-md')
 expect(body?.textContent).toContain('Answer')
})
for(const group of [false,true]) it.each([false,true])(`keeps the task-card quote header for an ordinary card reply (group=${group}, mobile=%s)`,async mobile=>{
 const content=serializeComposerCard({v:1,type:'task',text:'Original task',agentUserId:'agent',agentName:'Ada',sessionId:'s',projectId:'p',deviceId:'d',machineLabel:'Mac'})
 const source={...msg('old','user-1',1),content_type:'card' as const,content}
 const reply={...msg('answer','agent',3,'old'),content:'看看',reply_to_content:content}
 await render([source,msg('new','user-1',2),reply],mobile,group)
 expect(inBubble('answer')).toBe(group)
 expect(quoted('answer')?.textContent).toContain('新任务')
 expect(quoted('answer')?.textContent).toContain('Original task')
})
