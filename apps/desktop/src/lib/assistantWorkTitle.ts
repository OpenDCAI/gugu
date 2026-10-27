import type {AssistantWorkTask} from '@gugu/core/cloud/assistantWork'
import type {Device} from '@gugu/core/shared/types/chat'
type TitlesDevice=Pick<Device,'device_id'|'session_digest'>
const digest=(device:TitlesDevice)=>Array.isArray(device.session_digest)?device.session_digest.filter(row=>
  row&&typeof row.conversationId==='string'&&typeof row.title==='string'):[]

/** Heartbeat status changes do not reread the ledger; new title evidence does. */
export function assistantWorkTitleSignature(owner:string,cachedOwner:string|null,devices:readonly TitlesDevice[]):string {
  return cachedOwner===owner?JSON.stringify(devices.map(device=>[device.device_id,
    digest(device).map(row=>[row.conversationId,row.title]).sort()]).sort()):''
}

/** Display-only recovery for old placeholder rows; never rewrite a work or event. */
export function withAssistantWorkTitle(work:AssistantWorkTask,owner:string|null,cachedOwner:string|null,
  devices:readonly TitlesDevice[]):AssistantWorkTask {
  if(work.title!=='任务'||!owner||work.owner_user_id!==owner||cachedOwner!==owner)return work
  const titles=work.executors.map(executor=>{
    const device=devices.find(device=>device.device_id===executor.device_id)
    const matches=device?digest(device).filter(row=>row.conversationId===executor.session_id):[]
    return matches.length===1?matches[0]!.title.trim():''
  })
  if(!titles.length||titles.some(title=>!title)||new Set(titles).size!==1)return work
  return {...work,title:titles[0]!}
}
