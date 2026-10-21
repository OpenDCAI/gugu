import os from 'node:os'
import { describe, expect, it } from 'vitest'
import { cachedFixtureExecutable } from '../../../support/cachedFixtureExecutable'
import { assertOpencodeExecutable } from '@/../electron/sessionpage/opencode-serve-attach-transport'

/**
 * #6183 —— serve/attach 适配器由 opencode 与 mimocode 共用,它起 serve 之前的版本探针走唯一属主
 * `resolveSessionRuntimeCompatible`,判据必须是**这台 serve 替哪一家跑**的 `tui` 声明。
 *
 * 真机实撞:探针曾写死 opencode ⇒ mimocode 0.1.13 被拿去对 opencode 的 1.18.23 下限,
 * mimocode 的终端腿一条都起不来。这里用同一份只报 `0.1.13` 的假引擎,两家各判一次:
 * mimocode 过(它自己的下限是 0.1.13),opencode 红(阳控:同一份二进制在另一家的声明下必须不过)。
 */
const FAKE_SRC = '#!/bin/sh\necho 0.1.13\n'

describe('#6183 serve 版本探针按这台 serve 所属的那一家判', () => {
  it('mimocode 的 serve 按 mimocode 自己的 tui 下限判', async () => {
    const bin = cachedFixtureExecutable('fake-mimo-version-6183', FAKE_SRC)
    await expect(assertOpencodeExecutable('mimocode', bin, { PATH: '/usr/bin:/bin' }, os.tmpdir()))
      .resolves.toBeUndefined()
  })

  it('阳控:同一份 0.1.13 当成 opencode 判必须红', async () => {
    const bin = cachedFixtureExecutable('fake-mimo-version-6183', FAKE_SRC)
    await expect(assertOpencodeExecutable('opencode', bin, { PATH: '/usr/bin:/bin' }, os.tmpdir()))
      .rejects.toThrow(/opencode tui requires harness runtime 1\.18\.23 or newer; found 0\.1\.13/)
  })
})
