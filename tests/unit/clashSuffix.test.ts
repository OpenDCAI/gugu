import { describe, expect, it } from 'vitest'
import { clashSuffixes, type ClashMember } from '../../packages/core/src/shared/clashSuffix'

const agent = (id: string, displayName: string, nameSerial: number | null): ClashMember => ({ id, type: 'agent', displayName, nameSerial })

describe('chat member clash suffixes', () => {
  it('uses stored serials for case and whitespace variants, independently of order', () => {
    const members = [agent('a', ' Fix login ', 93), agent('b', 'fix LOGIN', 95), agent('c', 'Deploy', 97)]
    expect(clashSuffixes(members)).toEqual(new Map([['a', '#93'], ['b', '#95']]))
    expect(clashSuffixes(members.toReversed())).toEqual(clashSuffixes(members))
  })

  it('keeps people and unnumbered agents plain while disambiguating a task', () => {
    expect(clashSuffixes([
      agent('task', 'Same', 7), agent('persistent', 'Same', null),
      { id: 'person', type: 'human', displayName: 'Same', nameSerial: null },
    ])).toEqual(new Map([['task', '#7']]))
  })

  it('drops suffixes after rename or departure, and ignores duplicate roster entries', () => {
    expect(clashSuffixes([agent('a', 'Same', 7), agent('b', 'Other', 8)])).toEqual(new Map())
    expect(clashSuffixes([agent('a', 'Same', 7)])).toEqual(new Map())
    expect(clashSuffixes([agent('a', 'Same', 7), agent('a', 'Same', 7)])).toEqual(new Map())
  })

  it('does not look outside its supplied chat or mutate identity names', () => {
    const members = [agent('a', 'Same', 7), agent('b', 'Same', 8)]
    clashSuffixes(members)
    expect(members.map(member => member.displayName)).toEqual(['Same', 'Same'])
    expect(clashSuffixes([members[0], agent('elsewhere', 'Other', 8)])).toEqual(new Map())
  })
})
