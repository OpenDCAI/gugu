import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { hydrateLoginShellPath, loginShellEnvSnapshot, loginShellProbeArgs } from '../../../../apps/desktop/electron/shellPath'

// #6264 登录 shell 是 csh/tcsh 时也采得到环境(照 VS Code shellEnv.ts:tcsh/csh 走 `-ic`,其余 `-i -l -c`)。
describe('login shell probe args', () => {
  it('csh / tcsh use -ic and a script without the POSIX-only 2> redirect', () => {
    for (const shell of ['/bin/csh', '/usr/bin/tcsh']) {
      const [flag, script] = loginShellProbeArgs(shell)
      expect(flag).toBe('-ic')
      expect(script).not.toContain('2>')
    }
  })

  it('bash / zsh / fish keep -lic', () => {
    for (const shell of ['/bin/bash', '/bin/zsh', '/usr/bin/fish', '/bin/sh']) expect(loginShellProbeArgs(shell)[0]).toBe('-lic')
  })

  const realShell = (path: string) =>
    it.skipIf(!fs.existsSync(path))(`really captures PATH and the whole env from ${path}`, () => {
      const env: NodeJS.ProcessEnv = { ...process.env, SHELL: path, GUGU_PROBE_MARK: 'x-1' }
      const result = hydrateLoginShellPath({
        platform: 'linux',
        env,
        probe: (shell, args, probeEnv) =>
          execFileSync(shell, args, { encoding: 'utf8', timeout: 10_000, env: { ...probeEnv, GUGU_PROBE_MARK: 'x-1' } }),
      })
      expect(result.hydrated).toBe(true)
      expect(loginShellEnvSnapshot()?.GUGU_PROBE_MARK).toBe('x-1')
    })
  realShell('/bin/tcsh')
  realShell('/bin/csh')
  realShell('/usr/bin/fish')
  realShell('/opt/homebrew/bin/fish')
})
