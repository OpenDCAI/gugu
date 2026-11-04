import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { exec, execFile } from '../../../../packages/core/src/local/childProcess'

describe('childProcess: promisified execFile / exec keep Node’s { stdout, stderr } shape', () => {
  it('execFile', async () => {
    const script = 'process.stdout.write("out"); process.stderr.write("err")'
    await expect(promisify(execFile)(process.execPath, ['-e', script])).resolves.toEqual({ stdout: 'out', stderr: 'err' })
  })

  it('exec', async () => {
    await expect(promisify(exec)(`"${process.execPath}" -e "process.stdout.write('out')"`)).resolves.toEqual({ stdout: 'out', stderr: '' })
  })
})
