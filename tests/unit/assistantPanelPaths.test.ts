import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assistantPanelPath } from '../../apps/desktop/electron/sessionpage/assistant-panel-paths'

const directories: string[] = []
async function home() {
  const path = await realpath(await mkdtemp(join(tmpdir(),'gugu-panel-path-')))
  directories.push(path)
  return path
}
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path,{ recursive: true,force: true }))) })

describe('assistant panel filesystem containment', () => {
  it('creates only parents inside the host-selected resource root', async () => {
    const base = await home(), root = join(base,'memory')
    const path = await assistantPanelPath(root,'nested/note.md',{ home: base,createParents: true })
    await writeFile(path,'saved')
    expect(await readFile(join(root,'nested','note.md'),'utf8')).toBe('saved')
  })

  it.each(['../escape','/escape','a/../../escape','a\\..\\escape','C:/escape','%2e%2e/escape','./note','a//note','note\nother'])('rejects path %j before creating anything', async path => {
    const base = await home()
    await expect(assistantPanelPath(join(base,'memory'),path,{ home: base,createParents: true })).rejects.toThrow('PANEL_PATH_INVALID')
  })

  it('rejects a symlink escape even when later path components do not yet exist', async () => {
    const base = await home(), outside = await home(), root = join(base,'memory')
    await mkdir(root)
    await symlink(outside,join(root,'redirect'))
    await expect(assistantPanelPath(root,'redirect/missing/note.md',{ home: base,createParents: true })).rejects.toThrow('PANEL_PATH_OUTSIDE_HOME')
  })

  it('rejects a replaced root and paths redirected elsewhere in the same home', async () => {
    const base = await home(), outside = await home(), root = join(base,'memory')
    await symlink(outside,root)
    await expect(assistantPanelPath(root,'note.md',{ home: base,createParents: true })).rejects.toThrow('PANEL_PATH_OUTSIDE_HOME')
    await rm(root)
    await mkdir(root); await mkdir(join(base,'private'))
    await symlink(join(base,'private'),join(root,'redirect'))
    await expect(assistantPanelPath(root,'redirect/note.md',{ home: base,createParents: true })).rejects.toThrow('PANEL_PATH_OUTSIDE_HOME')
  })
})
