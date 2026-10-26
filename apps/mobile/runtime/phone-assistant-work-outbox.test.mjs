import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPhoneAssistantWorkOutbox } from './phone-assistant-work-outbox.mjs'
function fixture({ paused = false, obsolete = false, abandoned = false } = {}) {
  let once = false
  const calls = []
  const event = { assistant_user_id:'assistant',work_id:'work',message_id:'message',kind:'completed',from_session_id:'child',from_device_id:'phone',to_session_id:'home',to_device_id:'cloud',source_available:true,failed_attempts:0,attempts:1,lease_token:'lease',lease_remaining_ms:60000,age_ms:0,lease_until:new Date(Date.now()+60000).toISOString(),platform_received_at:new Date().toISOString(),terminal_version:'1' }
  const rpc = async (name,args) => { calls.push({name,args});return {data:name==='assistant_work_outbox_claim'?{events:once?[]:(once=true,[event])}:name==='assistant_work_notice_wake_claim'?{items:abandoned?[{anchor_message_id:'notice',coordinator_device_id:'cloud',lease_token:'notice-lease',lease_remaining_ms:60000}]:[]}:{},error:null} }
  const state = async () => ({deviceId:'cloud',state:paused?'asleep':'awake'})
  const wake = async () => {calls.push({name:'wake'});paused=false}
  const call = async (device,type,ref) => { calls.push({name:type,device,ref});return obsolete?{error:{code:'unknown_method',message:'old'}}:{result:{status:'admitted',messageId:'message'}} }
  const host = createPhoneAssistantWorkOutbox({cloud:{identity:{rpc}},ownerId:'owner',deviceId:'phone',instanceId:'runtime',isReady:()=>true,requester:()=>({call}),receive:async()=>{throw new Error('Not local')},controller:{state,wake}})
  return {host,calls}
}
test('paused control state wakes the cloud before delivering the same stable message',async()=>{
  const {host,calls}=fixture({paused:true})
  try {
    await host.kick()
    assert.ok(calls.findIndex(c=>c.name==='wake')<calls.findIndex(c=>c.name==='assistantWork.deliver'))
    assert.deepEqual(calls.find(c=>c.name==='assistantWork.deliver').ref,{assistant_id:'assistant',work_id:'work',message_id:'message'})
    assert.equal(calls.find(c=>c.name==='assistant_work_outbox_settle').args.p_stage,'assistant_admitted')
  } finally {host.close()}
})
test('an obsolete receiver is retried from the same cloud event without an unsafe fallback',async()=>{
  const {host,calls}=fixture({obsolete:true})
  try {
    await host.kick()
    assert.equal(calls.filter(c=>c.name==='assistantWork.deliver').length,1)
    assert.equal(calls.find(c=>c.name==='assistant_work_outbox_settle').args.p_error_code,'DELIVERY_HOST_OUTDATED')
  } finally {host.close()}
})

test('an abandoned delivery resumes the coordinator so its separate failure notice can be posted',async()=>{
  const {host,calls}=fixture({abandoned:true})
  try {await host.kick();assert.equal(calls.filter(c=>c.name==='assistantWork.reconcile').length,1)} finally {host.close()}
})
