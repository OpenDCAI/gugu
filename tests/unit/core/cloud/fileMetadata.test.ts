import { describe, expect, it, vi } from 'vitest'
import { createFileMetadataLoader, FILE_METADATA_BATCH_MAX } from '../../../../packages/core/src/cloud/fileMetadata'
import type { FileContext, FileRef } from '../../../../packages/core/src/shared/fileResolver'

const actor = { accountId: 'owner', actorId: 'owner' }
const context = (id: string, signal?: AbortSignal): FileContext => ({ actor, ref: { message_id: id }, signal })
describe('metadata batching preserves the former attachment batching protection without signing', () => {
  it('coalesces duplicate references, returns reordered rows to their exact readers, and preserves expiry/deletion', async () => {
    const load = vi.fn(async (_: FileContext, refs: FileRef[]) => ({ files: [...refs].reverse().map(ref => ({ ref, status: 'message_id' in ref && ref.message_id === 'expired' ? 'expired' : 'gone' })) }))
    const resolve = createFileMetadataLoader(load)
    const results = await Promise.all([resolve(context('expired')), resolve(context('expired')), resolve(context('hidden'))])
    expect(load).toHaveBeenCalledTimes(1)
    expect(load.mock.calls[0]![1]).toEqual([{ message_id: 'expired' }, { message_id: 'hidden' }])
    expect(results).toEqual([{ ref: { message_id: 'expired' }, status: 'expired' }, { ref: { message_id: 'expired' }, status: 'expired' }, { ref: { message_id: 'hidden' }, status: 'gone' }])
  })
  it('retains the 200-reference bound for a large visible batch', async () => {
    const load = vi.fn(async (_: FileContext, refs: FileRef[]) => ({ files: refs.map(ref => ({ ref, status: 'gone' })) }))
    const resolve = createFileMetadataLoader(load)
    await Promise.all(Array.from({ length: FILE_METADATA_BATCH_MAX + 5 }, (_, i) => resolve(context(String(i)))))
    expect(load.mock.calls.map(call => call[1].length)).toEqual([FILE_METADATA_BATCH_MAX, 5])
  })
  it('isolates accounts, actors and cancellation scopes, including the same reference', async () => {
    const load = vi.fn(async (ctx: FileContext, refs: FileRef[]) => ({ files: refs.map(ref => ({ ref, reader: ctx.actor })) }))
    const resolve = createFileMetadataLoader(load), controller = new AbortController()
    const first = context('same', controller.signal), second = context('same'), agent = { ...second, actor: { ...actor, actorId: 'agent' } }
    const other = { ...second, actor: { accountId: 'other', actorId: 'other' } }
    const aborted = expect(resolve(first)).rejects.toThrow('reader left')
    controller.abort(Error('reader left'))
    const results = await Promise.all([resolve(second), resolve(agent), resolve(other)])
    await aborted
    expect(load).toHaveBeenCalledTimes(3)
    expect(results.map(row => (row as { reader: unknown }).reader)).toEqual([actor, agent.actor, other.actor])
  })
  it('does not cache expiry or deletion: a re-upload or changed ACL is checked again', async () => {
    let status = 'expired'
    const load = vi.fn(async (_: FileContext, refs: FileRef[]) => ({ files: refs.map(ref => ({ ref, status })) }))
    const resolve = createFileMetadataLoader(load)
    expect(await resolve(context('file'))).toMatchObject({ status: 'expired' })
    status = 'ready'
    expect(await resolve(context('file'))).toMatchObject({ status: 'ready' })
    status = 'gone'
    expect(await resolve(context('file'))).toMatchObject({ status: 'gone' })
    expect(load).toHaveBeenCalledTimes(3)
  })
  it.each(['missing', 'duplicate', 'foreign', 'network'])('rejects %s batches for all waiters and permits a fresh retry', async bad => {
    let failing = true
    const load = vi.fn(async (_: FileContext, refs: FileRef[]) => {
      if (failing && bad === 'network') throw Error('unavailable')
      return { files: failing ? bad === 'missing' ? [] : bad === 'duplicate' ? [refs[0], refs[0]].map(ref => ({ ref })) : refs.map(() => ({ ref: { message_id: 'foreign' } })) : refs.map(ref => ({ ref, status: 'gone' })) }
    })
    const resolve = createFileMetadataLoader(load)
    const first = expect(resolve(context('a'))).rejects.toThrow(), second = expect(resolve(context('b'))).rejects.toThrow()
    await Promise.all([first, second]); failing = false
    expect(await resolve(context('a'))).toMatchObject({ status: 'gone' }); expect(load).toHaveBeenCalledTimes(2)
  })
})
