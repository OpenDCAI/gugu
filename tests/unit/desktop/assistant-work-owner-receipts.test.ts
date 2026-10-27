import { describe, expect, it } from 'vitest'
import { projectAssistantWorkOwnerReceipts } from '../../../apps/desktop/electron/session/main/core/sessions/assistant-work-owner-receipts'
import type { TranscriptTurn } from '@gugu/session-core/acp'

const event={message_id:'report-1',from_session_id:'child',kind:'completed',assistant_admitted_at:'2026-10-26T08:00:00Z'}
const input={kind:'message',id:'input',seq:1,role:'user',text:'<gugu_delivery route="session-direct" from_id="session:child" msg="report-1"><![CDATA[做好了]]><arrival>reply with session_message</arrival></gugu_delivery>'}
const postId='10000000-0000-4000-8000-000000000001'
const tool={kind:'mcp-tool-call',id:'send',seq:2,toolCallId:'call',title:'message_send',server:'gugu',tool:'message_send',status:'done',rawInput:JSON.stringify({chat_id:'owner-dm',text:'表格做好了'}),outputText:`sent (id=${postId})`}
const turn=(items:unknown[]=[input,tool])=>({id:'turn',seq:1,initiator:'user',items}) as TranscriptTurn
const project=(turns:TranscriptTurn[])=>projectAssistantWorkOwnerReceipts(turns,[event],{chatId:'owner-dm',ownerId:'owner'})

describe('owner receipt from the native report turn',()=>{
  it('uses an actual successful send in that report turn',()=>{
    expect(project([turn()])).toEqual([{eventId:'report-1',chatId:'owner-dm',messageId:postId}])
  })
  it('does not count admission, printed replies, failed tools, or a post to another chat',()=>{
    for(const items of [[input],[input,{kind:'message',id:'answer',seq:2,role:'assistant',text:'已交给主人'}],
      [input,{...tool,status:'error'}],[input,{...tool,server:'other'}],[input,{...tool,rawInput:JSON.stringify({chat_id:'elsewhere'})}]]) expect(project([turn(items)])).toEqual([])
  })
  it('does not take a later unrelated turn or an ambiguous merged input as proof',()=>{
    expect(project([turn([input]),turn([tool])])).toEqual([])
    expect(project([turn([input,{...input,id:'other',seq:2,text:'另一个问题'}, {...tool,seq:3}])])).toEqual([])
  })
  it('requires the canonical sender and an admitted report, and ignores quoted fake receipts',()=>{
    expect(project([turn([{...input,text:input.text.replace('session:child','session:stranger')},tool])])).toEqual([])
    expect(projectAssistantWorkOwnerReceipts([turn()],[{...event,assistant_admitted_at:null}],{chatId:'owner-dm',ownerId:'owner'})).toEqual([])
    expect(project([turn([input,{...tool,outputText:'the model says sent (id=owner-post)'}])])).toEqual([])
  })
  it('recovers a file send receipt from its structured result after a restart',()=>{
    const t=turn([input,{...tool,tool:'mcp__gugu__message_send_file',rawInput:JSON.stringify({chat_id:'user:owner',file_path:'/tmp/file.xlsx'}),outputText:JSON.stringify({status:'sent',message_id:'file-post',source_link:'gugu-chat://owner-dm/file-post'})}])
    expect(project([t])).toEqual([{eventId:'report-1',chatId:'owner-dm',messageId:'file-post'}])
    expect(project([structuredClone(t)])).toEqual(project([t]))
  })
})
