import {useEffect,useState} from 'react'
import {useTranslation} from 'react-i18next'
import {useDevicesStore} from '../../store/devicesContext'
import {useCloudComputerWake} from '../../hooks/useWakeCloudComputer'

// FC measured 3.05s from wake to attach. Allow ten times that while the account
// record remains usable, then name the delay instead of spinning indefinitely.
export const ASSISTANT_WORK_LIVE_WAIT_MS=30_000

export function useAssistantWorkRuntime(deviceId:string|null){
 const {devices,phones=[]}=useDevicesStore()
 const device=[...devices,...phones].find(row=>row.device_id===deviceId)??null
 const {issue,dropped}=useCloudComputerWake(device)
 const {t}=useTranslation('assistant'),{t:common}=useTranslation('common')
 const [expired,setExpired]=useState(false)
 useEffect(()=>{
  setExpired(false)
  if(!deviceId)return
  const timer=setTimeout(()=>setExpired(true),ASSISTANT_WORK_LIVE_WAIT_MS)
  return()=>clearTimeout(timer)
 },[deviceId])
 const waking=device?.cloud_computer==='asleep'||device?.cloud_computer==='waking'
 const ready=!!device&&!waking&&(device.is_online||device.is_current_device===true)
 const reason=issue?common(`cloudComputer.reason.${issue.kind}`)
  :dropped?t('tasks.liveDisconnected')
  :expired&&!ready?t('tasks.liveTimedOut')
  :device&&!ready&&!waking?t('tasks.liveDeviceOffline'):null
 return {ready,waking:waking&&!reason,reason}
}
