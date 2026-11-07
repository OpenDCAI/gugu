/** Real client DTOs/named RPC arguments against an installed disposable backend.
 * Temporary EXECUTE grants and every fixture row roll back together. */
import { randomUUID } from 'node:crypto'
import { describe,it,expect } from 'vitest'
import { createConnectionClient,type ConnectionCommit } from '@gugu/core/cloud/connections'
import { withContractDatabase } from './database'

type Database = Parameters<Parameters<typeof withContractDatabase>[0]>[0]
const rpc = {
  connection_authority: [],
  connection_snapshot: [['p_device_id','text']],
  connection_resource: [['p_scope_key','text'],['p_resource_key','text']],
  connection_commit: [['p_operation_id','uuid'],['p_scope_key','text'],['p_resource_key','text'],['p_expected_revision','bigint'],['p_operation','text'],
    ['p_data','jsonb'],['p_document','text'],['p_device_id','text'],['p_runtime_instance_id','text'],['p_recreation_id','uuid']],
  connection_recreate_begin: [['p_operation_id','uuid'],['p_scope_key','text'],['p_resource_key','text'],['p_expected_revision','bigint'],
    ['p_device_id','text'],['p_provider_id','text'],['p_expected_head_revision','bigint']],
  connection_commit_batch: [['p_operation_id','uuid'],['p_recreation_id','uuid'],['p_operations','jsonb'],['p_runtime_instance_id','text']],
  connection_pending: [['p_runtime_instance_id','text']],
  connection_admit: [['p_runtime_instance_id','text'],['p_expected_revision','bigint'],['p_operation_id','uuid']],
  connection_ack: [['p_runtime_instance_id','text'],['p_operation_id','uuid'],['p_admission_id','uuid'],['p_error_code','text'],['p_terminal','boolean']],
} as const

function clientAs(db: Database,owner: string) {
  return createConnectionClient(async (name,args) => {
    const parameters = rpc[name as keyof typeof rpc]
    if (!parameters || Object.keys(args).sort().join() !== parameters.map(([key]) => key).sort().join()) throw new Error(`Unexpected connection RPC ${name}`)
    const values = parameters.map(([key,type]) => type === 'jsonb' ? JSON.stringify(args[key]) : args[key])
    await db.query('SAVEPOINT owner_connection_call')
    try {
      await db.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({ sub: owner,role: 'authenticated' })])
      await db.query('SET LOCAL ROLE authenticated')
      const result = await db.query<{ result: unknown }>(`SELECT identity.${name}(${parameters.map(([key,type],index) => `${key} => $${index+1}::${type}`).join(',')}) AS result`,values)
      await db.query('RESET ROLE'); await db.query('RELEASE SAVEPOINT owner_connection_call')
      return { data: result.rows[0]!.result,error: null }
    } catch (cause) {
      await db.query('ROLLBACK TO SAVEPOINT owner_connection_call'); await db.query('RESET ROLE'); await db.query('RELEASE SAVEPOINT owner_connection_call')
      const error = cause as Error & { code?: string }
      return { data: null,error: { message: error.message,code: error.code } }
    }
  },() => owner)
}

async function fixture(body: (value: {
  db: Database; owner: string; other: string; device: string; foreignDevice: string; instance: string
  client: ReturnType<typeof clientAs>; otherClient: ReturnType<typeof clientAs>
  save(account: string): Promise<Awaited<ReturnType<ReturnType<typeof clientAs>['commit']>>>
}) => Promise<void>) {
  await withContractDatabase(async db => {
    await db.query('BEGIN')
    try {
      for (const [name,parameters] of Object.entries(rpc)) {
        const signature = `identity.${name}(${parameters.map(([,type]) => type).join(',')})`
        // Missing application RPCs are a dependency failure, never a skipped test.
        expect((await db.query<{ allowed: boolean }>("SELECT has_function_privilege('authenticated',$1,'EXECUTE') AS allowed",[signature])).rows[0]!.allowed).toBe(name === 'connection_authority')
        if (name !== 'connection_authority') await db.query(`GRANT EXECUTE ON FUNCTION ${signature} TO authenticated`)
      }
      const owner = randomUUID(),other = randomUUID(),device = randomUUID(),foreignDevice = randomUUID(),instance = randomUUID()
      for (const [user,target] of [[owner,device],[other,foreignDevice]]) {
        await db.query(`INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
          VALUES($1,'authenticated','authenticated',$2,'{}','{}',now(),now())`,[user,`${user}@1922.example.invalid`])
        await db.query("INSERT INTO identity.users(id,type,display_name) VALUES($1,'human','1922') ON CONFLICT DO NOTHING",[user])
        await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES($1,$2,'1922','1922','linux')",[target,user])
      }
      await db.query('INSERT INTO identity.runtime_instances(instance_id,device_id,owner_user_id) VALUES($1,$2,$3)',[instance,device,owner])
      const client = clientAs(db,owner),otherClient = clientAs(db,other)
      const save = (account: string) => client.commit({ operationId: randomUUID(),scopeKey: `device:${device}`,resourceKey: JSON.stringify(['github',account]),
        expectedRevision: '0',operation: 'save',data: { providerId: 'github',accountId: account,configured: true },
        document: JSON.stringify({ version: 1,providerId: 'github',accountId: account,login: account }),deviceId: device,runtimeInstanceId: instance })
      await body({ db,owner,other,device,foreignDevice,instance,client,otherClient,save })
    } finally { await db.query('ROLLBACK') }
  })
}

describe('owner connections #1922 client/database contract', () => {
  it('retains nullable not-ready, actual UTF-8 bodies and owner/device isolation without an assistant', async () => fixture(async ({ db,owner,device,foreignDevice,client,otherClient,save }) => {
    expect(await client.authority()).toEqual({ version: 1,mode: 'legacy',epoch: '0',phase: 'stable',acceptingNewOperations: true })
    expect(await client.snapshot()).toEqual({ version: 1,state: 'not-ready',revision: '0',items: null,application: null })
    const saved = await save('first')
    const resource = await client.resource(`device:${device}`,saved.resourceKey)
    expect(resource.item?.publicMetadata?.accountId).toBe('first')
    expect((await otherClient.resource(`device:${device}`,saved.resourceKey)).item).toBeNull()
    await expect(client.snapshot(foreignDevice)).rejects.toMatchObject({ code: '42501' })
    expect((await db.query<{ count: string }>("SELECT count(*) FROM identity.users WHERE owner_user_id=$1 AND type='agent'",[owner])).rows[0]!.count).toBe('0')
  }))
  it('retains original operation identity through pending, admission and idempotent unknown acknowledgement', async () => fixture(async ({ device,instance,client,save }) => {
    const saved = await save('remove')
    const change: ConnectionCommit = { operationId: randomUUID(),scopeKey: `device:${device}`,resourceKey: saved.resourceKey,expectedRevision: saved.revision,operation: 'remove',deviceId: device }
    const removed = await client.commit(change)
    expect(await client.commit(change)).toEqual(removed)
    const pending = await client.pending(instance)
    const operation = pending.changes.find(row => row.operationId === removed.operationId)!
    expect(operation.payload.before).toEqual({ providerId: 'github',accountId: 'remove' })
    expect(operation.requestHash).toMatch(/^[a-f0-9]{64}$/)
    const admission = await client.admit(instance,pending.revision,operation.operationId)
    expect(admission.admitted).toBe(true)
    expect((await client.admit(instance,admission.revision,operation.operationId)).reason).toBe('already-started')
    const unknown = await client.ack(instance,operation.operationId,admission.admissionId!,'CONNECTION_OUTCOME_UNKNOWN',true)
    expect(await client.ack(instance,operation.operationId,admission.admissionId!,'CONNECTION_OUTCOME_UNKNOWN',true)).toEqual(unknown)
    expect((await client.pending(instance)).changes.find(row => row.operationId === operation.operationId)).toMatchObject({ status: 'failed',terminal: true })
  }))
  it('blocks tombstone observations and consumes a provider ticket only for the actual service-resolved account', async () => fixture(async ({ device,instance,client,save }) => {
    const saved = await save('revoked')
    const removed = await client.commit({ operationId: randomUUID(),scopeKey: `device:${device}`,resourceKey: saved.resourceKey,
      expectedRevision: saved.revision,operation: 'remove',deviceId: device })
    const data = { providerId: 'github',accountId: 'revoked',configured: true }
    const document = JSON.stringify({ version: 1,...data })
    await expect(client.commit({ operationId: randomUUID(),scopeKey: `device:${device}`,resourceKey: saved.resourceKey,expectedRevision: removed.revision,
      operation: 'save',data,document,deviceId: device,runtimeInstanceId: instance })).rejects.toMatchObject({ code: 'PT409' })
    const operationId = randomUUID(),head = await client.snapshot(device)
    const intent = await client.recreateBegin({ operationId,scopeKey: `device:${device}`,resourceKey: null,expectedRevision: null,
      deviceId: device,providerId: 'github',expectedHeadRevision: head.revision })
    const complete: ConnectionCommit = { operationId,scopeKey: `device:${device}`,resourceKey: null,expectedRevision: null,operation: 'save',data,
      document: JSON.stringify({ version: 1,providerId: 'github',accountId: 'revoked',login: 'revoked' }),deviceId: device,
      runtimeInstanceId: instance,recreationId: intent.recreationId }
    const receipt = await client.commit(complete)
    expect(receipt.resourceKey).toBe(saved.resourceKey)
    expect(await client.commit(complete)).toEqual(receipt)
    expect((await client.resource(`device:${device}`,saved.resourceKey)).item?.deletedAt).toBeNull()
  }))
  it('submits all imported accounts atomically and returns the same child receipts on a parent retry', async () => fixture(async ({ device,instance,client,save }) => {
    await save('initial')
    const operationId = randomUUID(),head = await client.snapshot(device)
    const intent = await client.recreateBegin({ operationId,scopeKey: `device:${device}`,resourceKey: null,expectedRevision: null,
      deviceId: device,providerId: 'github',expectedHeadRevision: head.revision })
    const operations = ['batch-one','batch-two'].map(accountId => ({ operationId: randomUUID(),data: { providerId: 'github',accountId,configured: true },
      document: JSON.stringify({ version: 1,providerId: 'github',accountId }) }))
    const change = { operationId,recreationId: intent.recreationId,operations,runtimeInstanceId: instance }
    await expect(client.commitBatch({ ...change,operations: operations.map((row,index) => index ? { ...row,document: '{}' } : row) }))
      .rejects.toMatchObject({ code: '22023' })
    expect((await client.resource(`device:${device}`,JSON.stringify(['github','batch-one']))).item).toBeNull()
    const receipt = await client.commitBatch(change)
    expect(receipt.receipts.map(row => row.operationId)).toEqual(operations.map(row => row.operationId))
    expect(await client.commitBatch(change)).toEqual(receipt)
  }))
})
