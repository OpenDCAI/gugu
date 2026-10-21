import { describe, expect, it } from 'vitest'
import { installedHereLine, refusedLine } from '../../../../apps/desktop/src/components/extensionBundle/installedHere'

/**
 * 10-17 (群文件夹图标车道,mac1): a card said 「更新到 0.1.2」 over the market's office 0.1.1 and the install refused it,
 * the reason only in the log. What is here is said in one wording, for the card and the group's panel alike: which kind
 * of App by where it came from (E-05) — never all of them called the market's.
 */
describe('what is installed here, as the person reads it (E-05)', () => {
  const origins = ['market', 'preinstalled', 'folder', undefined] as const

  it('says the version, and a different line for each origin', () => {
    const lines = origins.map((origin) => installedHereLine(origin, '0.1.1'))
    for (const line of lines) expect(line).toContain('0.1.1')
    expect(new Set(lines).size).toBe(origins.length)
  })

  it('names the machine when it is another one', () => {
    expect(installedHereLine('market', '0.1.1', 'Studio')).toContain('Studio')
    expect(installedHereLine('market', '0.1.1')).not.toContain('Studio')
  })

  it('a refusal: that line, then that a package from a chat cannot replace it', () => {
    const answer = { installed: false, outcome: 'refused', id: 'office', name: 'Office', version: '0.1.2', reason: 'cannot replace it (engine word)', from: 'market', installedVersion: '0.1.1' } as const
    const line = refusedLine(answer)
    expect(line.startsWith(installedHereLine('market', '0.1.1'))).toBe(true)
    expect(line.length).toBeGreaterThan(installedHereLine('market', '0.1.1').length)
    // The install's own word is for agents and logs, not shown.
    expect(line).not.toContain('engine word')
  })
})
