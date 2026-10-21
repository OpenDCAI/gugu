import { beforeEach, describe, expect, it, vi } from 'vitest'

// 摩擦单 F66 (主人 10-01): when an App package found in a chat is offered to this device's install without a click
// (updateUnasked.ts) — never while no App here has a publisher; one after another — and the
// host hears when one went in. Whether one goes in, and whose packages are downloaded at all, is the install's own
// answer (attachmentInstallPlan with unasked; phoneApps / main), played here by `answers`.

// A card in a chat, named by its message (#7290).
const card = (name: string) => `msg-${name}`

const state = vi.hoisted(() => ({
  publishers: {} as Record<string, { id: string; name?: string }>,
  asked: [] as { messageId: string; unasked?: boolean }[],
  answers: new Map<string, { installed: boolean; outcome: string; id?: string; name: string; version: string }>(),
  gate: Promise.resolve(),
}))

vi.mock('../../../../apps/desktop/src/lib/log', () => ({ rendererLogger: () => ({ warn: () => undefined }) }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/extensions/installed-extensions-store', () => ({
  installedExtensionsStore: {
    get publishers() {
      return state.publishers
    },
    locale: 'en-US',
    manifestFor: () => undefined,
  },
}))
vi.mock('../../../../apps/desktop/src/components/appSlot/appsHere', () => ({
  appsHere: {
    async installAttachment(args: { messageId: string; unasked?: boolean }) {
      state.asked.push(args)
      await state.gate
      return { success: true, data: state.answers.get(args.messageId) ?? { installed: false, outcome: 'held' } }
    },
  },
}))

async function load() {
  vi.resetModules()
  return import('../../../../apps/desktop/src/components/appSlot/updateUnasked')
}

beforeEach(() => {
  state.publishers = {}
  state.asked = []
  state.answers.clear()
  state.gate = Promise.resolve()
})

describe('updateUnasked: an App update found in a chat', () => {
  it('no App here has a publisher: nothing is asked (nothing could be an update of it)', async () => {
    const { updateUnasked } = await load()
    expect(await updateUnasked({ messageId: card('vote-2') })).toBe(false)
    expect(state.asked).toEqual([])
  })

  it('asks the install, unasked; the host hears only what went in', async () => {
    const { onUpdatedUnasked, updateUnasked } = await load()
    state.publishers = { vote: { id: '0a000000-0000-4000-8000-00000000000a', name: 'Alice' } }
    const heard: unknown[] = []
    onUpdatedUnasked((updated) => heard.push(updated))
    state.answers.set(card('vote-2'), { installed: true, outcome: 'confirmed', id: 'vote', name: 'Vote', version: '0.2.0' })
    expect(await updateUnasked({ messageId: card('vote-2') })).toBe(true)
    expect(state.asked).toEqual([{ messageId: card('vote-2'), unasked: true }])
    expect(heard).toEqual([{ name: 'Vote', version: '0.2.0' }])
    // Held (it asks for more, or someone else sent it): not in, nothing said — the group's bar asks the person instead.
    expect(await updateUnasked({ messageId: card('vote-3') })).toBe(false)
    expect(heard).toHaveLength(1)
  })

  it('one package asked about at a time: the next waits until the one before is answered', async () => {
    const { updateUnasked } = await load()
    state.publishers = { vote: { id: '0a000000-0000-4000-8000-00000000000a' } }
    let release = () => undefined as void
    state.gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = updateUnasked({ messageId: card('vote-2') })
    const next = updateUnasked({ messageId: card('vote-3') })
    await vi.waitFor(() => expect(state.asked.map((args) => args.messageId)).toEqual([card('vote-2')]))
    release()
    await Promise.all([first, next])
    expect(state.asked.map((args) => args.messageId)).toEqual([card('vote-2'), card('vote-3')])
  })
})
