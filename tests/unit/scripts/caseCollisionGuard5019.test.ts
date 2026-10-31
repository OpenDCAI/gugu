import { describe, expect, it } from 'vitest'

// @ts-expect-error -- 守卫脚本是 .mjs,没有类型声明;这里只吃它导出的那个纯函数。
import { findCaseCollisions } from '../../../scripts/checks/check-case-collisions.mjs'

// #5019 这道闸防的是:两条只差大小写的路径在 Linux 上是两个文件、在 mac/Windows 上是同一个,
// 于是开发机四门全绿而 CI 判红。
//
// 阳控拿**真实例**喂:第一版实现按「整条路径折叠大小写」比,对真正撞过的那一对(差在 .ts / .tsx)
// 返回 0 —— 判据长得对、跑得过、结论是空的。所以阳控必须是那一对本身,不能是我另造的一对。

const REAL_COLLISION = [
  'apps/desktop/src/components/contacts/contactsDeviceSections.ts',
  'apps/desktop/src/components/contacts/ContactsDeviceSections.tsx',
]

describe('findCaseCollisions(#5019 大小写撞名闸)', () => {
  it.each([
    {
      label: 'real source collision across .ts/.tsx',
      paths: [...REAL_COLLISION, 'apps/desktop/src/components/contacts/ContactsIndex.tsx'],
      kind: 'ambiguous-import',
      expectedPaths: [...REAL_COLLISION].sort(),
    },
    {
      label: 'same file with case-only path difference',
      paths: ['src/Foo.ts', 'src/foo.ts', 'src/bar.ts'],
      kind: 'same-file',
      expectedPaths: ['src/Foo.ts', 'src/foo.ts'],
    },
  ])('$label is reported once', ({ paths, kind, expectedPaths }) => {
    const hits = findCaseCollisions(paths)
    expect(hits).toHaveLength(1)
    expect(hits[0]!.kind).toBe(kind)
    expect(hits[0]!.paths).toEqual(expectedPaths)
  })

  it.each([
    { label: 'non-source file', paths: ['docs/Logo.png', 'docs/logo.png'] },
    { label: 'directory case difference', paths: ['src/Contacts/a.ts', 'src/contacts/a.ts'] },
  ])('$label collisions are detected', ({ paths }) => {
    expect(findCaseCollisions(paths)).toHaveLength(1)
  })

  it('阴控:同名不同目录 / 同名不同扩展名但大小写一致 / 折叠后不相同 → 一条都不捞', () => {
    // thing.ts 与 thing.tsx 大小写完全一致,不是「靠大小写撑着」的那一类,❌ 不许误伤。
    expect(findCaseCollisions([
      'a/index.ts',
      'b/index.ts',
      'src/thing.ts',
      'src/thing.tsx',
      'src/Thing2.ts',
      'src/thing3.ts',
      'docs/logo.png',
    ])).toEqual([])
  })

  it('一处问题只报一条:整条路径就撞的那对不再按 ambiguous-import 重复报', () => {
    const hits = findCaseCollisions(['src/Foo.ts', 'src/foo.ts'])
    expect(hits.map((hit: { kind: string }) => hit.kind)).toEqual(['same-file'])
  })
})
