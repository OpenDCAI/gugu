// @vitest-environment jsdom
import {afterEach,expect,it} from 'vitest'
import {readAssistantTaskChat,rememberAssistantTaskChat,showAssistantTaskChat} from '../../../../apps/desktop/src/lib/assistantTaskChat'
const task=(workId?:string)=>({workId,assistantId:'assistant',taskAgentId:'reused-agent',task:{deviceId:'device',sessionId:'session'},assistants:[{deviceId:'home',sessionId:'home-session'}]})
afterEach(()=>showAssistantTaskChat(null))
it('does not guess a work from insertion order when an old agent link has several works',()=>{
 const first=task('first'),second=task('second')
 rememberAssistantTaskChat('ambiguous-owner',first);rememberAssistantTaskChat('ambiguous-owner',second)
 expect(readAssistantTaskChat('ambiguous-owner','reused-agent')).toBeNull()
 showAssistantTaskChat({ownerId:'ambiguous-owner',request:first,name:'Task'})
 expect(readAssistantTaskChat('ambiguous-owner','reused-agent')).toBe(first)
})
it('keeps the original unscoped endpoint for a legacy link even after remembering a new work',()=>{
 const legacy=task();rememberAssistantTaskChat('legacy-owner',legacy);rememberAssistantTaskChat('legacy-owner',task('new'))
 expect(readAssistantTaskChat('legacy-owner','reused-agent')).toBe(legacy)
 expect(readAssistantTaskChat('other-owner','reused-agent')).toBeNull()
})
