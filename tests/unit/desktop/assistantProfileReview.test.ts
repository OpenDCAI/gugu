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
    expect((await prepareAssistantProfileReview(admission, root)).beforeText).toContain('先读owner-profile.md再整理')
    await writeFile(index, '- [关于你](owner-profile.md) — 事实；profile_rules: 2\n')
    const stale = await readFile(index, 'utf8')
    const first = await prepareAssistantProfileReview(admission, root)
    expect(first.beforeText).toContain('profile_rules:5')
    expect(first.text).toBe('hi')
    expect(first.beforeText).toContain('称呼规矩仅留提示词，不入任何记忆')
    expect(first.beforeText).toContain('勿据mtime猜作息，未知省略')
    expect(first.beforeText!.length).toBeLessThanOrEqual(250)
    expect(first.beforeText).toContain('<gugu_profile_review>')
    expect(first.accepted).toBe(admission.accepted)
    expect((await prepareAssistantProfileReview(admission, root)).beforeText).toContain('先读owner-profile.md再整理')
    expect(await readFile(index, 'utf8')).toBe(stale)
    await writeFile(index, '- [偏好](feedback.md) profile_rules: 5\n- [关于你](owner-profile.md) profile_rules: 2\n')
    expect((await prepareAssistantProfileReview(admission, root)).beforeText).toContain('先读owner-profile.md再整理')
    await writeFile(index, '- [关于你](owner-profile.md) — 事实；profile_rules: 5\n')
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
