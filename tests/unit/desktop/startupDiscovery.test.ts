import { expect, it, vi } from 'vitest'
import { StartupDiscovery } from '../../../apps/desktop/electron/sessionpage/startup-discovery'

it('keeps optional cloud inventory dormant until release, then runs each job only once', async () => {
  const queue = new StartupDiscovery(true)
  const inventory = vi.fn(async () => {})
  const cache = vi.fn(async () => {})
  const jobs = [queue.schedule(inventory), queue.schedule(cache)]
  await Promise.resolve()
  expect(inventory).not.toHaveBeenCalled()
  expect(cache).not.toHaveBeenCalled()
  queue.release()
  queue.release()
  await Promise.all(jobs)
  expect(inventory).toHaveBeenCalledOnce()
  expect(cache).toHaveBeenCalledOnce()
  await queue.schedule(inventory)
  expect(inventory).toHaveBeenCalledTimes(2)
})

it('leaves ordinary hosts immediate and preserves discovery failures', async () => {
  const queue = new StartupDiscovery(false)
  const inventory = vi.fn(async () => { throw new Error('discovery failed') })
  await expect(queue.schedule(inventory)).rejects.toThrow('discovery failed')
  expect(inventory).toHaveBeenCalledOnce()
})
