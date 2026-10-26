import {createReadStream} from 'node:fs'
import {realpath} from 'node:fs/promises'
import {createInterface} from 'node:readline'
import {join,relative,isAbsolute} from 'node:path'
import {legacyAssistantDispatch,legacyAssistantReports} from '../../../packages/core/src/shared/assistantWorkHistory.ts'
import {stableId} from './phone-agent-store.mjs'

/** Migrate existing admissions in the background. Historical rows are never enqueued for execution. */
export function createPhoneAssistantWorkHistory({root,store,cloud,deviceId,instanceId,isReady,authorize,warn}) {
  let closed=false,flight=null
  const current=()=>!closed && isReady()
  const records=async(agent,job)=>{
    const path=job.record?.path ?? (agent.record?.contextEpoch===job.contextEpoch ? agent.record?.path : null)
    if(!path) return []
    let target,base
    try {target=await realpath(path);base=await realpath(join(root,agent.sessionId,...(job.contextEpoch ? [job.contextEpoch] : []),'sessions'))}
    catch(error){if(error.code==='ENOENT')return [];throw error}
    const part=relative(base,target)
    if(!part || part.startsWith('..') || isAbsolute(part)) throw Object.assign(new Error('record outside phone session'),{code:'HISTORY_PATH_REJECTED'})
    const entries=[],sent=new Set(job.sent??[])
    for await(const line of createInterface({input:createReadStream(target),crlfDelay:Infinity})) {
      if(!current()) break
      let row
      try{row=JSON.parse(line)}catch{continue}
      const message=row?.message
      if(row?.type!=='message' || !message) continue
      if(message.role==='toolResult' && sent.has(message.toolCallId)) entries.push(row)
      else if(message.role==='assistant' && Array.isArray(message.content)) {
        const content=message.content.filter(block=>block?.type==='toolCall' && block.name==='session_message' && sent.has(block.id))
        if(content.length) entries.push({...row,message:{...message,content}})
      }
    }
    return entries
  }
  const run=async()=>{
    if(!current()) return
    const imported=store.state.workHistoryImported??={}
    const groups=new Map()
    for(const job of Object.values(store.state.jobs)) {
      if(!current()) return
      const agent=store.state.agents[job.agentUserId]
      if(!agent) continue
      const work=legacyAssistantDispatch({agent,job,deviceId})
      if(!work) continue
      try {
        const authorizeJob=()=>authorize([...new Set([...(agent.dataProof?.groups??[]),...(job.inputDataProof?.groups??[]),...(job.usedGroups??[])])],{sessionId:agent.sessionId,permissionRequirements:[...(agent.dataProof?.permissionRequirements??[]),...(job.inputDataProof?.permissionRequirements??[]),...(job.permissionRequirements??[])]})
        await authorizeJob()
        const files=callId=>Array.from({length:8},(_,index)=>store.state.sessionFileOutbox?.[stableId('session-file',job.id,callId,index)]?.reference).filter(Boolean)
        const events=[work.event,...legacyAssistantReports(work,job,await records(agent,job),files)].filter(event=>!imported[event.message_id])
        if(!events.length) continue
        const group=groups.get(work.workId)??{work,events:new Map(),authorizations:[]}
        if(group.work.task.coordinator_session_id!==work.task.coordinator_session_id || group.work.task.coordinator_device_id!==work.task.coordinator_device_id) throw new Error('Historical coordinator changed')
        for(const executor of work.task.executors) if(!group.work.task.executors.some(row=>row.session_id===executor.session_id)) group.work.task.executors.push(executor)
        group.authorizations.push(authorizeJob)
        for(const event of events) group.events.set(event.message_id,event)
        groups.set(work.workId,group)
      } catch(error) {warn({code:error.code??'HISTORY_RECORD_UNAVAILABLE'})}
    }
    for(const {work,events,authorizations} of groups.values()) {
      if(!current()) return
      let after='0'
      for(;;) {
        const {data,error}=await cloud.identity.rpc('assistant_work_history',{p_assistant:work.assistantId,p_work_id:work.workId,p_after:after,p_limit:200})
        if(error) {
          if(error.code==='42501' && /Work is not available/.test(error.message)) break
          throw Object.assign(new Error('Historical work lookup failed'),{code:error.code})
        }
        if(!Array.isArray(data?.events)) throw new Error('Invalid historical work read')
        for(const event of data.events) {events.delete(event.message_id);imported[event.message_id]=true}
        if(!data.next_after) break
        if(BigInt(data.next_after)<=BigInt(after)) throw new Error('Historical work cursor did not advance')
        after=data.next_after
      }
      const missing=[...events.values()].sort((a,b)=>Date.parse(a.occurred_at)-Date.parse(b.occurred_at)||a.message_id.localeCompare(b.message_id))
      for(let index=0;index<missing.length;index+=32) {
        if(!current()) return
        const batch=missing.slice(index,index+32)
        for(const check of authorizations) await check()
        if(!current())return
        const {data,error}=await cloud.identity.rpc('assistant_work_import',{p_assistant:work.assistantId,p_runtime_instance_id:instanceId,p_work_id:work.workId,p_task:work.task,p_events:batch})
        if(error) throw Object.assign(new Error('Historical work import failed'),{code:error.code})
        if(!Array.isArray(data?.event_ids) || batch.some(event=>!data.event_ids.includes(event.message_id))) throw new Error('Historical work import receipt is incomplete')
        for(const event of batch) imported[event.message_id]=true
        await store.save()
      }
      if(!missing.length) await store.save()
    }
  }
  return {kick(){
    if(flight) return flight
    flight=run().catch(error=>warn({code:error.code??'HISTORY_IMPORT_FAILED'})).finally(()=>{flight=null})
    return flight
  },close(){closed=true;return flight??Promise.resolve()}}
}
