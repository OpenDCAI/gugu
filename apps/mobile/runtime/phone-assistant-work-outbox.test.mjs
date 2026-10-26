import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CloudComputerError } from '../../../packages/core/src/cloud/cloudComputer.ts'
import { createPhoneAssistantWorkOutbox } from './phone-assistant-work-outbox.mjs'
test('a failed phone claim produces one verified owner message through ordinary chat without waking a device',async()=>{
  const posts=new Map();let wakes=0,checks=0
  const query=(data)=>({select(){return this},eq(){return this},is(){return this},not(){return this},abortSignal(){return this},
    then(resolve){resolve({data,error:null})},maybeSingle(){checks++;return Promise.resolve({data:{id:[...posts.keys()][0]},error:null})}})
  const cloud={
    identity:{rpc:async(name)=>name==='assistant_work_outbox_claim'?{data:null,error:{code:'PGRST202',message:'private schema detail'}}:{data:{items:[]},error:null},
      from:()=>query([{agent_user_id:'assistant',device_id:'home',member_key:'assistant',phase:'ready',created_at:'2026-10-26T00:00:00Z'}])},
    chat:{rpc:(name,args)=>({abortSignal:async()=>{
      if(name==='open_dm')return {data:'dm',error:null}
      posts.set(args.p_message_id,args);return {data:[{id:args.p_message_id}],error:null}
    }}),from:()=>query(null)},
  }
  const host=createPhoneAssistantWorkOutbox({cloud,ownerId:'owner',deviceId:'phone',instanceId:'runtime',isReady:()=>true,
    requester:()=>({call:async()=>{throw new Error('must not attach')}}),receive:async()=>{throw new Error('must not deliver')},
    controller:{state:async()=>{wakes++;return {state:'asleep',deviceId:'home'}}}})
  try {await host.kick();await host.kick()} finally {host.close()}
  assert.equal(posts.size,1)
  assert.equal(checks,1)
  assert.equal(wakes,0)
  assert.equal([...posts.values()][0].p_to_user_ids[0],'owner')
  assert.ok(!JSON.stringify([...posts.values()]).includes('private schema'))
})
function fixture({ paused = false, obsolete = false, abandoned = false, controlError = null, target = 'cloud' } = {}) {
  let once = false
  const calls = []
  const event = { assistant_user_id:'assistant',work_id:'work',message_id:'message',kind:'completed',from_session_id:'child',from_device_id:'phone',to_session_id:'home',to_device_id:target,source_available:true,failed_attempts:0,attempts:1,lease_token:'lease',lease_remaining_ms:60000,age_ms:0,lease_until:new Date(Date.now()+60000).toISOString(),platform_received_at:new Date().toISOString(),terminal_version:'1' }
  const rpc = async (name,args) => { calls.push({name,args});return {data:name==='assistant_work_outbox_claim'?{events:once?[]:(once=true,[event])}:name==='assistant_work_notice_wake_claim'?{items:abandoned?[{anchor_message_id:'notice',coordinator_device_id:'cloud',lease_token:'notice-lease',lease_remaining_ms:60000}]:[]}:{},error:null} }
  const state = async () => {if(controlError)throw controlError;return {deviceId:'cloud',state:paused?'asleep':'awake'}}
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

test('restarts cannot bypass the six server-reserved notice wake attempts',async()=>{
  let credits=0,wakes=0
  const notice={anchor_message_id:'notice',coordinator_device_id:'home',lease_token:'lease',lease_remaining_ms:60000}
  const rpc=async(name)=>({data:name==='assistant_work_outbox_claim'?{events:[]}
    :name==='assistant_work_notice_wake_claim'?{items:credits<6?(credits++,[notice]):[]}
    :name==='assistant_work_abandoned'?{events:[{message_id:'notice',kind:'completed',to_device_id:'home'}]}:{},error:null})
  for(let restart=0;restart<10;restart++) {
    const host=createPhoneAssistantWorkOutbox({cloud:{identity:{rpc}},ownerId:'owner',deviceId:'phone',instanceId:`runtime-${restart}`,isReady:()=>true,requester:()=>({call:async()=>({})}),receive:async()=>({status:'pending'}),
      controller:{state:async()=>({state:'asleep',deviceId:'home'}),wake:async()=>{wakes++;throw new Error('network unavailable')}}})
    await host.kick();host.close()
  }
  assert.equal(wakes,6)
})

for(const [status,code] of [[503,'not_open'],[0,'network']]) {
  test(`optional cloud control ${code} does not prevent delivery to a reachable Mac`,async()=>{
    const {host,calls}=fixture({target:'mac',controlError:new CloudComputerError(status,code,'control unavailable')})
    try {
      await host.kick()
      assert.equal(calls.find(c=>c.name==='assistantWork.deliver')?.device,'mac')
      assert.equal(calls.find(c=>c.name==='assistant_work_outbox_settle')?.args.p_stage,'assistant_admitted')
      assert.equal(calls.filter(c=>c.name==='wake').length,0)
    } finally {host.close()}
  })
}
test('cloud authorization errors are not treated as optional discovery failures',async()=>{
  const {host,calls}=fixture({target:'mac',controlError:new CloudComputerError(401,'unauthorized','sign in required')})
  try {
    await host.kick()
    assert.equal(calls.filter(c=>c.name==='assistantWork.deliver').length,0)
    assert.deepEqual(calls.find(c=>c.name==='assistant_work_outbox_settle')?.args.p_receipt,{failure_observed:true})
  } finally {host.close()}
})
