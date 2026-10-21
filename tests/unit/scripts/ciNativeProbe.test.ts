import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  NATIVE_PROBES,
  discoverAbiFragilePackages,
  dropStaleBuilds,
  probeNativeModules,
} from '../../../scripts/ci-native-probe.mjs'

const repoRoot = path.resolve(__dirname, '../../..')

describe('CI 槽位的原生模块判据(#5713)', () => {
  // 这条测试是本文件存在的理由。判据 2026-09-16 悄悄退化成空转:按包名 require 对
  // better-sqlite3 来说**一个 .node 都不打开**(它的 addon 在 new Database() 里才加载),
  // 于是闸门对着一份 Electron ABI 的二进制报 "native ABI ok",80 秒后同一个 job 里的测试
  // 炸在 NODE_MODULE_VERSION 149 vs 137。
  //
  // ⚠️ 判据必须是「**开了几个 .node**」,❌ 不是「有没有抛错」—— 后者在一棵健康的树上
  //    永远绿,恰恰测不出空转,而空转正是要防的那件事。dlopen 是**尝试**就计数,所以这条
  //    在一棵被污染的树上也照样成立,不会因为开发机上残着 Electron ABI 就假红。
  test.each(Object.keys(NATIVE_PROBES))('exercise %s 时真的打开了它的 addon', (name) => {
    const { attempts } = probeNativeModules({
      repoRoot,
      probes: { [name]: NATIVE_PROBES[name] },
      log: () => {},
    })
    expect(attempts[0].loaded.length).toBeGreaterThan(0)
  })

  test('阴性对照:只 require、不真的用起来,必须判坏而不是判好', () => {
    const lines: string[] = []
    const { bad } = probeNativeModules({
      repoRoot,
      // 这就是 #5713 那个版本的判据,语义一字不差:require 不抛错即算过。
      probes: {
        'better-sqlite3': (require: NodeRequire) => {
          require('better-sqlite3')
        },
      },
      log: (line: string) => lines.push(line),
    })
    expect(bad).toBe(1)
    expect(lines.join('\n')).toMatch(/proved nothing/)
  })

  test('每个会被从源码编译的原生依赖都登记了 exercise', () => {
    // 有人新加一个从源码编的原生依赖却忘了登记,槽里就多出一条没人守的路 ——
    // 和 #5713 同形状,只是换了个包。这条在 PR 时红,而不是等它把发版打红。
    expect(discoverAbiFragilePackages(repoRoot)).toEqual([...Object.keys(NATIVE_PROBES)].sort())
  })

  test('加载失败时判坏,并且只把首行原因带出来', () => {
    const lines: string[] = []
    const { bad } = probeNativeModules({
      repoRoot,
      probes: {
        'fake-native': () => {
          throw new Error('NODE_MODULE_VERSION 149.\n这一行是调用栈,不该进日志')
        },
      },
      log: (line: string) => lines.push(line),
    })
    expect(bad).toBe(1)
    expect(lines[0]).toContain('NODE_MODULE_VERSION 149.')
    expect(lines[0]).not.toContain('不该进日志')
  })

  test('探完把 process.dlopen 原样还回去', () => {
    // 判据为了数 dlopen 会临时换掉它。还不回去的话,同一个 vitest 进程里后面所有加载
    // 原生模块的测试都会挂在一个已经失效的闭包上。
    const before = process.dlopen
    probeNativeModules({
      repoRoot,
      probes: {
        boom: () => {
          throw new Error('boom')
        },
      },
      log: () => {},
    })
    expect(process.dlopen).toBe(before)
  })

  test('清陈旧产物只动登记过的包,旁边的原样留着', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-native-probe-'))
    const seed = (entry: string, name: string) => {
      const pkg = path.join(root, 'node_modules/.pnpm', entry, 'node_modules', name)
      fs.mkdirSync(path.join(pkg, 'build/Release'), { recursive: true })
      fs.writeFileSync(path.join(pkg, 'build/Release/stale.node'), '')
      return path.join(pkg, 'build')
    }
    const target = seed('better-sqlite3@12.11.1', 'better-sqlite3')
    // N-API 的预编译平台包不会漂,清它没有任何好处,只会让下一次安装白重装一遍。
    const bystander = seed('fsevents@2.3.3', 'fsevents')

    dropStaleBuilds({ repoRoot: root, names: ['better-sqlite3'], log: () => {} })

    expect(fs.existsSync(target)).toBe(false)
    expect(fs.existsSync(bystander)).toBe(true)
    fs.rmSync(root, { recursive: true, force: true })
  })
})
