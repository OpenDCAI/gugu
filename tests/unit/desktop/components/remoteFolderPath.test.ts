import { describe, expect, it } from 'vitest'
import {
  broadRootKind,
  completionCandidates,
  filterEntries,
  newFolderNameProblem,
  splitCompletionDraft,
} from '../../../../apps/desktop/src/components/remoteFolderPath'

describe('remoteFolderPath', () => {
  it('splitCompletionDraft: 拆出「在哪个目录里补全什么」', () => {
    expect(splitCompletionDraft('/srv/da')).toEqual({ dir: '/srv', prefix: 'da' })
    expect(splitCompletionDraft('/srv/')).toEqual({ dir: '/srv', prefix: '' })
    expect(splitCompletionDraft('/sr')).toEqual({ dir: '/', prefix: 'sr' })
    expect(splitCompletionDraft('~/co')).toEqual({ dir: '~', prefix: 'co' })
    expect(splitCompletionDraft('~')).toEqual({ dir: '~', prefix: '' })
    expect(splitCompletionDraft('code')).toBeNull()
    expect(splitCompletionDraft('')).toBeNull()
  })

  it('completionCandidates: 只补能进去的,隐藏项要敲了 . 才出现,完全相等的排第一', () => {
    const entries = [
      { name: 'app', kind: 'dir' as const },
      { name: 'apple', kind: 'dir' as const },
      { name: 'App.md', kind: 'file' as const },
      { name: 'a-link', kind: 'symlink' as const },
      { name: '.apt', kind: 'dir' as const },
    ]
    expect(completionCandidates(entries, 'app').map((e) => e.name)).toEqual(['app', 'apple'])
    expect(completionCandidates(entries, 'a').map((e) => e.name)).toEqual(['a-link', 'app', 'apple'])
    expect(completionCandidates(entries, '.a').map((e) => e.name)).toEqual(['.apt'])
  })

  it('filterEntries: 不分大小写的包含', () => {
    const entries = [{ name: 'Alpha', kind: 'dir' as const }, { name: 'beta', kind: 'file' as const }]
    expect(filterEntries(entries, 'ALP').map((e) => e.name)).toEqual(['Alpha'])
    expect(filterEntries(entries, '  ')).toHaveLength(2)
  })

  it('broadRootKind: 根目录、主目录本身要提醒,子目录不提醒', () => {
    expect(broadRootKind('/', '/home/bob')).toBe('root')
    expect(broadRootKind('/home/bob', '/home/bob')).toBe('home')
    expect(broadRootKind('/home/bob/', '/home/bob')).toBe('home')
    expect(broadRootKind('~', null)).toBe('home')
    expect(broadRootKind('/home/bob/code', '/home/bob')).toBeNull()
    expect(broadRootKind('/home/bob', null)).toBeNull()
  })

  it('newFolderNameProblem', () => {
    expect(newFolderNameProblem(' ')).toBe('empty')
    expect(newFolderNameProblem('..')).toBe('invalid')
    expect(newFolderNameProblem('a/b')).toBe('invalid')
    expect(newFolderNameProblem('新项目')).toBeNull()
  })
})
