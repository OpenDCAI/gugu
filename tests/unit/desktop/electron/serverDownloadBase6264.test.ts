import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SERVER_DOWNLOAD_BASE_DEFAULT, SERVER_DOWNLOAD_BASE_FILE, serverDownloadBase } from '../../../../apps/desktop/electron/server/server-download'

describe('咕咕 server 的下载站(#6264):装时指定的测试站,后台自动升级也用它', () => {
  const dirs: string[] = []
  const home = (content?: string) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gugu-dl-'))
    dirs.push(dir)
    if (content !== undefined) writeFileSync(path.join(dir, SERVER_DOWNLOAD_BASE_FILE), content)
    return dir
  }
  afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))

  it('环境变量优先', () => {
    expect(serverDownloadBase({ GUGU_SERVER_DOWNLOAD_BASE: 'http://a.test/x/', GUGU_SERVER_HOME: home('http://b.test') })).toBe('http://a.test/x')
  })

  it('没有环境变量时读装时记下的下载站', () => {
    expect(serverDownloadBase({ GUGU_SERVER_HOME: home('http://203.0.113.10:30027\n') })).toBe('http://203.0.113.10:30027')
  })

  it('没记、记的不是网址、或不在 server 里 ⇒ 正式站', () => {
    expect(serverDownloadBase({ GUGU_SERVER_HOME: home() })).toBe(SERVER_DOWNLOAD_BASE_DEFAULT)
    expect(serverDownloadBase({ GUGU_SERVER_HOME: home('rm -rf /') })).toBe(SERVER_DOWNLOAD_BASE_DEFAULT)
    expect(serverDownloadBase({})).toBe(SERVER_DOWNLOAD_BASE_DEFAULT)
  })
})
