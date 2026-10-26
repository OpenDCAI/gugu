import { expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareAssistantProfileReview } from '../../../apps/desktop/electron/sessionpage/assistant-profile-review'

it('checks the live index on warm turns and retries until the model saves a verified review', async () => {
  const root = await mkdtemp(join(tmpdir(), 'profile-review-')), index = join(root, 'MEMORY.md')
  const admission = { text: 'hi', accepted: vi.fn(async () => {}) }
  try {
    await writeFile(join(root, 'owner-profile.md'), '姓名：测试\n怎么称呼：不写主人\n')
    expect((await prepareAssistantProfileReview(admission, root)).beforeText).toContain('读owner-profile.md：')
    await writeFile(index, '- [关于你](owner-profile.md) — 事实；profile_rules: 2\n')
    const stale = await readFile(index, 'utf8')
    const first = await prepareAssistantProfileReview(admission, root)
    expect(first.beforeText).toContain('profile_rules:6')
    expect(first.beforeText).toContain('先用message_send按信封回复，再整理，不再发消息')
    expect(first.beforeText!.indexOf('message_send')).toBeLessThan(first.beforeText!.indexOf('owner-profile.md'))
    expect(first.text).toBe('hi')
    expect(first.beforeText).toContain('其余称呼原话、助理规矩全删，勿记忆')
    expect(first.beforeText).toContain('未知省略，禁标题及mtime推测')
    expect(first.beforeText!.length).toBeLessThanOrEqual(250)
    expect(first.beforeText).toContain('<gugu_profile_review>')
    expect(first.accepted).toBe(admission.accepted)
    expect((await prepareAssistantProfileReview(admission, root)).beforeText).toContain('读owner-profile.md：')
    expect(await readFile(index, 'utf8')).toBe(stale)
    await writeFile(index, '- [偏好](feedback.md) profile_rules: 6\n- [关于你](owner-profile.md) profile_rules: 2\n')
    expect((await prepareAssistantProfileReview(admission, root)).beforeText).toContain('读owner-profile.md：')
    await writeFile(index, '- [关于你](owner-profile.md) — 事实；profile_rules: 6\n')
    expect(await prepareAssistantProfileReview(admission, root)).toBe(admission)
    expect(await prepareAssistantProfileReview(admission, root)).toBe(admission)
    await rm(index); await mkdir(index)
    const unavailable = await prepareAssistantProfileReview(admission, root)
    expect(unavailable.beforeText).toContain('未核')
    expect(unavailable.beforeText!.length).toBeLessThanOrEqual(250)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('does not create or request a profile when none exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'profile-absent-'))
  try {
    const admission = { text: 'hi', accepted: async () => {} }
    expect(await prepareAssistantProfileReview(admission, root)).toBe(admission)
    await expect(readFile(join(root, 'owner-profile.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})
