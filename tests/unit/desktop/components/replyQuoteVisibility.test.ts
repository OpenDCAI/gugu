import { expect,it } from 'vitest'
import { message } from '../../../support/testHarness'
import { visibleReplyQuoteIds } from '../../../../apps/desktop/src/components/chat/replyQuoteVisibility'

const row=(id:string,sender:string|null,reply:string|null=null)=>message({id,sender_user_id:sender,reply_to_message_id:reply})
it('does not hide an older target after a newer message from that participant',()=>{
 expect([...visibleReplyQuoteIds([row('old','owner'),row('new','owner'),row('answer','agent','old')])]).toEqual(['answer'])
 expect([...visibleReplyQuoteIds([row('old','owner'),row('new','owner'),row('answer','agent','new')])]).toEqual([])
})
it('only collapses a consecutive run to the same target',()=>{
 const rows=[row('old','owner'),row('new','owner'),row('a','agent','old'),row('b','agent','old'),row('c','agent'),row('d','agent','old')]
 expect([...visibleReplyQuoteIds(rows)]).toEqual(['a','d'])
})
it('a new message from the other participant ends the repeated-reply run',()=>{
 expect([...visibleReplyQuoteIds([row('old','owner'),row('new','owner'),row('a','agent','old'),row('latest','owner'),row('b','agent','old')])]).toEqual(['a','b'])
})
it('keeps an unknown history target and replies to the same sender',()=>{
 expect([...visibleReplyQuoteIds([row('a','agent','not-loaded'),row('b','agent','a')])]).toEqual(['a','b'])
})
it('does not infer adjacency for anonymized authors',()=>{
 expect([...visibleReplyQuoteIds([row('question','owner'),row('answer',null,'question'),row('again',null,'question')])]).toEqual(['answer','again'])
})
it('system messages and retracted messages do not replace the latest visible message or first quote',()=>{
 const system={...row('system','owner'),content_type:'system' as const},removed={...row('removed','owner'),retracted_at:'2026-10-27'}
 expect([...visibleReplyQuoteIds([row('question','owner'),system,removed,row('answer','agent','question')])]).toEqual([])
 expect([...visibleReplyQuoteIds([row('old','owner'),row('new','owner'),{...row('a','agent','old'),retracted_at:'2026-10-27'},row('b','agent','old')])]).toEqual(['b'])
})
it('preserves all quotes in rooms and incomplete search results',()=>{
 expect([...visibleReplyQuoteIds([row('a','owner'),row('b','agent','a'),row('c','agent','a')],true)]).toEqual(['b','c'])
})
