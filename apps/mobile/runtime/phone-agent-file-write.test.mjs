import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import fsPromises, { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openPhoneAgentStore, stableId } from './phone-agent-store.mjs'
import { phoneFileTools, registerArtifact } from './phone-agent-files.mjs'
import { phoneArtifactListTool, phoneTextFileTool } from './phone-agent-file-read.mjs'
import { PHONE_TEXT_OUTPUT_MAX_BYTES, phoneTextWriteTool } from './phone-agent-file-write.mjs'

const calendarProof = { permissions: ['android.permission.READ_CALENDAR'], mediaRefs: [] }
const photoProof = { permissions: ['android.permission.READ_MEDIA_IMAGES'], mediaRefs: [{ kind: 'image', id: '4', version: '4:10:1' }] }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gugu-phone-output-'))
  const ownerId = randomUUID()
  const agent = { ownerId, agentUserId: randomUUID(), sessionId: randomUUID() }
  const store = await openPhoneAgentStore(root, ownerId)
  const job = { id: randomUUID(), agentUserId: agent.agentUserId, usedGroups: ['calendar', 'photos'], permissionRequirements: [calendarProof, photoProof] }
  let revoked = false
  const checked = []
  const authorize = async (groups, artifact) => {
    checked.push({ groups: structuredClone(groups), requirements: structuredClone(artifact.permissionRequirements) })
    if (revoked) throw Object.assign(new Error('权限在保存期间撤销'), { code: 'revoked' })
  }
  const make = (options = {}) => phoneTextWriteTool({ agent, job, store, authorize, registerArtifact, ...options })
  return { root, ownerId, agent, job, store, checked, authorize, make, revoke: () => { revoked = true }, async close() { await store.flush(); await rm(root, { recursive: true, force: true }) } }
}

test('a generated UTF-8 report is registered in the exact owner/Agent/session output root and can be read/listed', async () => {
  const f = await fixture()
  try {
    const tools = phoneFileTools({ agent: f.agent, job: f.job, store: f.store, authorize: f.authorize, cloud: {}, env: {}, emit: () => undefined })
    const writer = tools.find((tool) => tool.name === 'phone_file_write')
    assert.ok(writer)
    const text = '# 手机报告\n中文和🦉都按UTF-8保存。\n'
    const written = await writer.execute('real-report-call', { file_name: '报告.md', text })
    const file = written.details
    assert.equal(file.ok, true)
    assert.equal(file.name, '报告.md')
    assert.equal(file.mime_type, 'text/markdown')
    assert.equal(file.size, Buffer.byteLength(text, 'utf8'))
    assert.equal(file.file_path.startsWith(join(await realpath(f.store.directory), 'outputs', f.agent.agentUserId, f.agent.sessionId) + '/'), true)
    assert.equal(await readFile(file.file_path, 'utf8'), text)
    assert.equal((await stat(file.file_path)).mode & 0o777, 0o600)
    const registered = f.store.state.artifacts[file.artifact_id]
    assert.equal(registered.ownerId, f.ownerId)
    assert.equal(registered.agentUserId, f.agent.agentUserId)
    assert.equal(registered.sessionId, f.agent.sessionId)
    assert.deepEqual(registered.groups, ['calendar', 'photos'])
    assert.deepEqual(registered.permissionRequirements, [calendarProof, photoProof])
    assert.equal(JSON.stringify(written).includes('android.permission'), false)
    const read = await tools.find((tool) => tool.name === 'phone_file_read').execute('read', { file_path: file.file_path })
    assert.equal(read.details.text, text)
    const listed = await tools.find((tool) => tool.name === 'phone_file_list').execute('list', {})
    assert.equal(listed.details.files[0].file_path, file.file_path)
    assert.ok(f.checked.length >= 4)
  } finally { await f.close() }
})

test('same tool call retries are idempotent across concurrent calls and a reopened journal; different content never overwrites', async () => {
  const f = await fixture()
  try {
    const tool = f.make()
    const args = { file_name: 'report.txt', text: 'immutable report content' }
    const [first, concurrent] = await Promise.all([tool.execute('same-call', args), tool.execute('same-call', args)])
    assert.equal(first.details.artifact_id, concurrent.details.artifact_id)
    const reopened = await openPhoneAgentStore(f.root, f.ownerId)
    const afterRestart = await f.make({ store: reopened }).execute('same-call', args)
    assert.equal(afterRestart.details.artifact_id, first.details.artifact_id)
    assert.equal(Object.keys(reopened.state.outputWrites).length, 1)
    assert.equal(Object.keys(reopened.state.artifacts).length, 1)
    assert.equal((await readdir(join(await realpath(f.store.directory), 'outputs', f.agent.agentUserId, f.agent.sessionId))).length, 1)
    await assert.rejects(tool.execute('same-call', { ...args, text: 'silently changed content' }), { code: 'invalid_args' })
    await assert.rejects(tool.execute('same-call', { ...args, file_name: 'renamed.txt' }), { code: 'invalid_args' })
    assert.equal(await readFile(first.details.file_path, 'utf8'), args.text)
  } finally { await f.close() }
})

test('Android denying every hardlink still permits exclusive copy and a same-call EEXIST recovery', async (t) => {
  const f = await fixture()
  const originalCopy = fsPromises.copyFile
  const calls = []
  let hardlinks = 0, conflicts = 0
  const args = { file_name: 'phone-check.md', text: '# Android report\n完整校验后登记。' }
  t.mock.method(fsPromises, 'link', async (source, target) => {
    hardlinks++
    throw Object.assign(new Error(`EACCES: permission denied, link '${source}' -> '${target}'`), { code: 'EACCES' })
  })
  t.mock.method(fsPromises, 'copyFile', async (source, target, flags) => {
    calls.push([source, target, flags])
    assert.equal(flags, constants.COPYFILE_EXCL)
    assert.equal(await readFile(source, 'utf8'), args.text)
    try { return await originalCopy(source, target, flags) } catch (error) { if (error.code === 'EEXIST') conflicts++; throw error }
  })
  syncBuiltinESMExports()
  try {
    const tool = f.make()
    const first = await tool.execute('android-hardlink-denied', args)
    const retried = await tool.execute('android-hardlink-denied', args)
    const directory = join(await realpath(f.store.directory), 'outputs', f.agent.agentUserId, f.agent.sessionId)
    assert.equal(first.details.artifact_id, retried.details.artifact_id)
    assert.equal(await readFile(first.details.file_path, 'utf8'), args.text)
    assert.equal(hardlinks, 0)
    assert.equal(conflicts, 1)
    assert.equal(calls.length, 2)
    for (const [source, target] of calls) {
      assert.equal(source.startsWith(directory + '/.'), true)
      assert.equal(source.endsWith('.incomplete'), true)
      assert.equal(target, first.details.file_path)
    }
    assert.deepEqual(await readdir(directory), [first.details.file_path.slice(directory.length + 1)])
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await f.close() }
})

test('a same-size corrupted copy is retained without registration and is never overwritten on retry', async (t) => {
  const f = await fixture()
  const originalCopy = fsPromises.copyFile
  const args = { file_name: 'corrupt.txt', text: 'complete report' }
  let finalPath, attempts = 0
  t.mock.method(fsPromises, 'copyFile', async (source, target, flags) => {
    assert.equal(flags, constants.COPYFILE_EXCL)
    attempts++; finalPath = target
    await originalCopy(source, target, flags)
    await writeFile(target, 'x'.repeat(Buffer.byteLength(args.text)))
  })
  syncBuiltinESMExports()
  try {
    const tool = f.make()
    await assert.rejects(tool.execute('bad-copy', args), { code: 'file_changed' })
    assert.equal(Object.keys(f.store.state.artifacts).length, 0)
    await assert.rejects(tool.execute('bad-copy', args), { code: 'file_changed' })
    assert.equal(attempts, 2)
    assert.equal(await readFile(finalPath, 'utf8'), 'x'.repeat(Buffer.byteLength(args.text)))
    assert.equal(Object.keys(f.store.state.artifacts).length, 0)
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await f.close() }
})

test('a partial interrupted final stays unregistered and unchanged after an exclusive-copy conflict', async (t) => {
  const f = await fixture()
  const originalCopy = fsPromises.copyFile
  const args = { file_name: 'partial.txt', text: 'complete report body' }
  let finalPath, interrupted = false
  t.mock.method(fsPromises, 'copyFile', async (source, target, flags) => {
    assert.equal(flags, constants.COPYFILE_EXCL)
    finalPath = target
    if (interrupted) return originalCopy(source, target, flags)
    interrupted = true
    await writeFile(target, 'partial', { flag: 'wx', mode: 0o600 })
    throw Object.assign(new Error('copy interrupted'), { code: 'EINTR' })
  })
  syncBuiltinESMExports()
  try {
    const tool = f.make()
    await assert.rejects(tool.execute('partial-copy', args), { code: 'EINTR' })
    assert.equal(await readFile(finalPath, 'utf8'), 'partial')
    assert.equal(Object.keys(f.store.state.artifacts).length, 0)
    await assert.rejects(tool.execute('partial-copy', args), { code: 'file_changed' })
    assert.equal(await readFile(finalPath, 'utf8'), 'partial')
    assert.equal(Object.keys(f.store.state.artifacts).length, 0)
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await f.close() }
})

test('a completed but interrupted copy can recover registration after restart using the same hash and call ID', async (t) => {
  const f = await fixture()
  const originalCopy = fsPromises.copyFile
  const args = { file_name: 'recover.txt', text: 'complete resumable report' }
  let finalPath, interrupted = false
  t.mock.method(fsPromises, 'copyFile', async (source, target, flags) => {
    assert.equal(flags, constants.COPYFILE_EXCL)
    finalPath = target
    await originalCopy(source, target, flags)
    if (!interrupted) { interrupted = true; throw Object.assign(new Error('copy completion unknown'), { code: 'EINTR' }) }
  })
  syncBuiltinESMExports()
  try {
    await assert.rejects(f.make().execute('complete-copy', args), { code: 'EINTR' })
    assert.equal(Object.keys(f.store.state.artifacts).length, 0)
    assert.equal(await readFile(finalPath, 'utf8'), args.text)
    const reopened = await openPhoneAgentStore(f.root, f.ownerId)
    const recovered = await f.make({ store: reopened }).execute('complete-copy', args)
    assert.equal(recovered.details.file_path, finalPath)
    assert.equal(reopened.state.artifacts[recovered.details.artifact_id].sessionId, f.agent.sessionId)
    assert.equal(Object.keys(reopened.state.artifacts).length, 1)
    assert.equal(Object.keys(reopened.state.outputWrites).length, 1)
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await f.close() }
})

test('revocation during copy prevents registration and delivery of a complete final file', async (t) => {
  const f = await fixture()
  const originalCopy = fsPromises.copyFile
  let finalPath
  t.mock.method(fsPromises, 'copyFile', async (source, target, flags) => {
    assert.equal(flags, constants.COPYFILE_EXCL)
    await originalCopy(source, target, flags)
    finalPath = target; f.revoke()
  })
  syncBuiltinESMExports()
  try {
    const args = { file_name: 'revoked-copy.txt', text: 'private complete report' }
    await assert.rejects(f.make().execute('revoke-copy', args), { code: 'revoked' })
    assert.equal(await readFile(finalPath, 'utf8'), args.text)
    assert.equal(Object.keys(f.store.state.artifacts).length, 0)
    await assert.rejects(f.make().execute('revoke-copy', args), { code: 'revoked' })
    assert.equal(Object.keys(f.store.state.artifacts).length, 0)
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await f.close() }
})

test('cancellation during copy prevents registration and permits an explicit same-call recovery later', async (t) => {
  const f = await fixture()
  const originalCopy = fsPromises.copyFile
  const controller = new AbortController()
  let finalPath
  t.mock.method(fsPromises, 'copyFile', async (source, target, flags) => {
    assert.equal(flags, constants.COPYFILE_EXCL)
    await originalCopy(source, target, flags)
    finalPath = target; controller.abort(new Error('cancelled during copy'))
  })
  syncBuiltinESMExports()
  try {
    const tool = f.make(), args = { file_name: 'cancel-copy.txt', text: 'complete report awaiting registration' }
    await assert.rejects(tool.execute('cancel-copy', args, controller.signal), /cancelled during copy/)
    assert.equal(Object.keys(f.store.state.artifacts).length, 0)
    assert.equal(await readFile(finalPath, 'utf8'), args.text)
    const recovered = await tool.execute('cancel-copy', args)
    assert.equal(recovered.details.file_path, finalPath)
    assert.equal(Object.keys(f.store.state.artifacts).length, 1)
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await f.close() }
})

test('invalid names, arbitrary paths, binary format claims and oversized/non-UTF8 bodies fail before creating outputs', async () => {
  const f = await fixture()
  try {
    const tool = f.make()
    for (const file_name of ['../report.md', '/tmp/report.md', 'nested/report.md', 'nested\\report.md', '.private', 'C:report.txt', 'name\u0000.txt', ' report.md', 'x'.repeat(121)]) {
      await assert.rejects(tool.execute(`bad-name-${JSON.stringify(file_name)}`, { file_name, text: 'body' }), { code: 'invalid_args' })
    }
    await assert.rejects(tool.execute('caller-path', { file_name: 'report.txt', text: 'body', file_path: '/tmp/outside' }), { code: 'invalid_args' })
    await assert.rejects(tool.execute('pdf', { file_name: 'fake.pdf', text: 'not really a PDF' }), { code: 'unsupported' })
    await assert.rejects(tool.execute('binary', { file_name: 'report.txt', text: 'before\0after' }), { code: 'invalid_args' })
    await assert.rejects(tool.execute('surrogate', { file_name: 'report.txt', text: '\ud800' }), { code: 'invalid_args' })
    await assert.rejects(tool.execute('size', { file_name: 'large.txt', text: 'x'.repeat(PHONE_TEXT_OUTPUT_MAX_BYTES + 1) }), { code: 'too_large' })
    await assert.rejects(readdir(join(f.store.directory, 'outputs')), { code: 'ENOENT' })
    assert.equal(Object.keys(f.store.state.artifacts).length, 0)
  } finally { await f.close() }
})

test('a symlinked output directory or final filename cannot redirect a report or replace an outside file', async () => {
  const f = await fixture()
  try {
    const outside = join(f.root, 'outside')
    await mkdir(outside)
    const outputs = join(await realpath(f.store.directory), 'outputs')
    await symlink(outside, outputs, 'dir')
    await assert.rejects(f.make().execute('directory-link', { file_name: 'report.txt', text: 'private report' }), { code: 'not_granted' })
    assert.deepEqual(await readdir(outside), [])
    await rm(outputs)
    const directory = join(outputs, f.agent.agentUserId, f.agent.sessionId)
    await mkdir(directory, { recursive: true })
    const outsideFile = join(outside, 'original.txt')
    await writeFile(outsideFile, 'outside must stay unchanged')
    const id = stableId('phone-text-output', f.ownerId, f.agent.agentUserId, f.agent.sessionId, f.job.id, 'leaf-link')
    await symlink(outsideFile, join(directory, `${id}-report.txt`))
    await assert.rejects(f.make().execute('leaf-link', { file_name: 'report.txt', text: 'private report' }))
    assert.equal(await readFile(outsideFile, 'utf8'), 'outside must stay unchanged')
    assert.equal(Object.keys(f.store.state.artifacts).length, 0)
  } finally { await f.close() }
})

test('a changed existing output is never overwritten on retry', async () => {
  const f = await fixture()
  try {
    const tool = f.make(), args = { file_name: 'report.txt', text: 'original' }
    const created = await tool.execute('changed-output', args)
    await writeFile(created.details.file_path, 'tampered')
    await assert.rejects(tool.execute('changed-output', args), { code: 'file_changed' })
    assert.equal(await readFile(created.details.file_path, 'utf8'), 'tampered')
  } finally { await f.close() }
})

test('revocation before writing or after artifact registration never returns the report, and its saved proofs still protect reads/listing', async () => {
  const f = await fixture()
  try {
    const tool = f.make({ registerArtifact: async (input) => { const registered = await registerArtifact(input); f.revoke(); return registered } })
    await assert.rejects(tool.execute('revoked-after-registration', { file_name: 'private.md', text: 'calendar and photo derived report' }), { code: 'revoked' })
    const saved = Object.values(f.store.state.artifacts)[0]
    assert.deepEqual(saved.permissionRequirements, [calendarProof, photoProof])
    assert.deepEqual(saved.groups, ['calendar', 'photos'])
    await assert.rejects(phoneTextFileTool({ agent: f.agent, job: f.job, store: f.store, authorize: f.authorize }).execute('read-revoked', { file_path: saved.file_path }), { code: 'revoked' })
    await assert.rejects(phoneArtifactListTool({ agent: f.agent, job: f.job, store: f.store, authorize: f.authorize }).execute('list-revoked', {}), { code: 'revoked' })
    await assert.rejects(f.make().execute('denied-at-start', { file_name: 'second.md', text: 'blocked' }), { code: 'revoked' })
    assert.equal(Object.keys(f.store.state.artifacts).length, 1)
  } finally { await f.close() }
})

test('a cancelled write or a failed durable claim cannot create a registered or partial final artifact', async () => {
  const f = await fixture()
  try {
    const controller = new AbortController(); controller.abort(new Error('cancelled before write'))
    await assert.rejects(f.make().execute('aborted', { file_name: 'report.md', text: 'body' }, controller.signal), /cancelled before write/)
    const failedStore = { ...f.store, save: async () => { throw new Error('journal unavailable') } }
    await assert.rejects(f.make({ store: failedStore }).execute('not-durable', { file_name: 'report.md', text: 'body' }), /journal unavailable/)
    await assert.rejects(readdir(join(f.store.directory, 'outputs')), { code: 'ENOENT' })
    assert.equal(Object.keys(f.store.state.artifacts).length, 0)
  } finally { await f.close() }
})

test('another Agent/session gets a separate output, while wrong owner/job scope is rejected', async () => {
  const f = await fixture()
  try {
    const args = { file_name: 'same-name.txt', text: 'one body' }
    const first = await f.make().execute('scope', args)
    const secondAgent = { ...f.agent, agentUserId: randomUUID(), sessionId: randomUUID() }
    const secondJob = { ...f.job, id: randomUUID(), agentUserId: secondAgent.agentUserId }
    const second = await f.make({ agent: secondAgent, job: secondJob }).execute('scope', args)
    assert.notEqual(second.details.file_path, first.details.file_path)
    assert.notEqual(second.details.artifact_id, first.details.artifact_id)
    await assert.rejects(f.make({ agent: { ...f.agent, ownerId: randomUUID() } }).execute('wrong-owner', args), { code: 'not_granted' })
    await assert.rejects(f.make({ job: { ...f.job, agentUserId: randomUUID() } }).execute('wrong-agent', args), { code: 'not_granted' })
    assert.equal(Object.keys(f.store.state.artifacts).length, 2)
  } finally { await f.close() }
})
