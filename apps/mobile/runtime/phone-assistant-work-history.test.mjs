import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,rm,readFile,symlink} from 'node:fs/promises'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {buildSessionDirectEnvelope} from '../../../packages/core/src/local/agent/deliveryEnvelope.ts'
import {createPhoneAssistantWorkHistory} from './phone-assistant-work-history.mjs'

test('legacy phone admissions and confirmed results upload once as history without redelivery',async()=>{
 const root=await mkdtemp('/tmp/phone-history-'),workId=randomUUID(),messageId=randomUUID(),replyId=randomUUID(),assistantId=randomUUID(),executor=randomUUID(),session=randomUUID(),coordinator=randomUUID()
 const caller={sessionId:coordinator,deviceId:'home',agentUserId:assistantId}
 const directory=join(root,session,'epoch','sessions'),path=join(directory,'record.jsonl')
 await mkdir(directory,{recursive:true})
 await writeFile(path,[{type:'message',message:{role:'assistant',content:[{type:'toolCall',id:'reply-call',name:'session_message',arguments:{to:[`session:${coordinator}`],text:'Original result',work_result:{work_id:workId,status:'completed'}}}]}},{type:'message',timestamp:'2026-10-20T08:02:00Z',message:{role:'toolResult',toolCallId:'reply-call',isError:false,details:{recipients:[{to:`session:${coordinator}`,status:'delivered',message_id:replyId}]}}}].map(row=>JSON.stringify(row)).join('\n'))
 const body=`Original delegation\n\n<gugu_work>\n${JSON.stringify({work_id:workId,coordinator:`session:${coordinator}`,report:'Report results'})}\n</gugu_work>`
 const store={state:{agents:{[executor]:{sessionId:session,agentUserId:executor,displayName:'Old task',caller,contextEpoch:'epoch'}},jobs:{[messageId]:{id:messageId,agentUserId:executor,status:'done',createdAt:'2026-10-20T08:00:00Z',contextEpoch:'epoch',record:{path},sent:['reply-call'],prompt:buildSessionDirectEnvelope({senderSessionId:coordinator,senderTitle:'Assistant',messageId,content:body,at:'2026-10-20T08:00:00Z'}),route:{kind:'session-direct',caller,sourceMessageId:messageId}}}},save:async()=>{}}
 const calls=[]
 const cloud={identity:{rpc:async(name,args)=>{calls.push([name,args]);return name==='assistant_work_history'?{data:null,error:{code:'42501',message:'Work is not available to this account'}}:{data:{event_ids:args.p_events.map(event=>event.message_id)},error:null}}}}
 const warnings=[]
 const deps={root,store,cloud,ownerId:randomUUID(),deviceId:'phone',instanceId:'runtime',isReady:()=>true,authorize:async()=>{},warn:detail=>warnings.push(detail)}
 try{
  const first=createPhoneAssistantWorkHistory(deps);await first.kick();first.close()
  const original=await readFile(path);await rm(path);await symlink('/etc/hosts',path)
  const second=createPhoneAssistantWorkHistory(deps);await second.kick();second.close()
  assert.deepEqual(warnings,[],'a completed imported job must not reopen its JSONL on later host cycles')
  await rm(path);await writeFile(path,original)
  const commits=calls.filter(([name])=>name==='assistant_work_import')
  assert.equal(commits.length,1)
  assert.deepEqual(commits[0][1].p_events.map(event=>event.message_id),[messageId,replyId])
  assert.equal(commits[0][1].p_events[1].kind,'completed')
  assert.equal(commits[0][1].p_events[1].content,'Original result')
  assert.equal(calls.some(([name])=>name.includes('outbox')||name==='assistant_work_commit'),false)
  let grantsChecked=0
  delete store.state.workHistoryImported
  const revoked=createPhoneAssistantWorkHistory({...deps,authorize:async()=>{grantsChecked++;throw Object.assign(new Error('revoked'),{code:'revoked'})}})
  await revoked.kick();revoked.close()
  assert.equal(grantsChecked>0,true)
  assert.equal(calls.filter(([name])=>name==='assistant_work_import').length,1)
  let revokedDuringRead=false
  const changed=createPhoneAssistantWorkHistory({...deps,cloud:{identity:{rpc:async(name,args)=>{if(name==='assistant_work_history')revokedDuringRead=true;return cloud.identity.rpc(name,args)}}},
    authorize:async()=>{if(revokedDuringRead)throw Object.assign(new Error('revoked'),{code:'revoked'})}})
  await changed.kick();changed.close()
  assert.equal(calls.filter(([name])=>name==='assistant_work_import').length,1,'a permission revoked during cloud lookup must prevent upload')
 }finally{await rm(root,{recursive:true,force:true})}
})


test('a failing historical work group cannot starve another group',async()=>{
 const root=await mkdtemp('/tmp/phone-history-groups-'),assistantId=randomUUID(),coordinator=randomUUID(),first=randomUUID(),second=randomUUID(),executor=randomUUID(),session=randomUUID()
 const caller={sessionId:coordinator,deviceId:'home',agentUserId:assistantId}
 const job=workId=>{const id=randomUUID();return {id,agentUserId:executor,status:'done',createdAt:'2026-10-20T08:00:00Z',sent:[],prompt:buildSessionDirectEnvelope({senderSessionId:coordinator,senderTitle:'Assistant',messageId:id,content:`Request\n<gugu_work>\n${JSON.stringify({work_id:workId,coordinator:`session:${coordinator}`,report:'Report results'})}\n</gugu_work>`,at:'2026-10-20T08:00:00Z'}),route:{kind:'session-direct',caller,sourceMessageId:id}}}
 const jobs=[job(first),job(second)],committed=[]
 const store={state:{agents:{[executor]:{sessionId:session,agentUserId:executor,displayName:'Old task',caller}},jobs:Object.fromEntries(jobs.map(row=>[row.id,row]))},save:async()=>{}}
 const cloud={identity:{rpc:async(name,args)=>name==='assistant_work_history'?{data:null,error:args.p_work_id===first?{code:'503',message:'Unavailable'}:{code:'42501',message:'Work is not available to this account'}}:(committed.push(args.p_work_id),{data:{event_ids:args.p_events.map(row=>row.message_id)},error:null})}}
 try{
  const host=createPhoneAssistantWorkHistory({root,store,cloud,deviceId:'phone',instanceId:'runtime',isReady:()=>true,authorize:async()=>{},warn:()=>{}})
  await host.kick();await host.close()
  assert.deepEqual(committed,[second])
 }finally{await rm(root,{recursive:true,force:true})}
})
