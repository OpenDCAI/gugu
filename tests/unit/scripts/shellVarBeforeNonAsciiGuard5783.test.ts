import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// #5783 这道闸防的是一个**只在错误路径上显形**的雷:把 `$VAR` 直接顶在一个非 ASCII 字符前面
// (中文标点「」。（，、破折号 —— 都算),macOS 自带的 bash 3.2 在 UTF-8 locale 下会把那个字符的
// 头一个字节吃进变量名,于是:
//
//   $ LANG=en_US.UTF-8 /bin/bash -uc 'w=hi; echo "$w。"'
//   bash: w<?>: unbound variable
//
// 而我们的壳脚本几乎都跑在 `set -euo pipefail` 下 —— 本该打印的那句报错变成了一次崩溃,
// 报错内容(是哪个变量、哪个动作)当场丢失,查的人只看见 exit 1。
//
// 为什么以前没人踩到:实测(2026-09-17)
//   bash 3.2 + LANG=en_US.UTF-8 / zh_CN.UTF-8 → 吞
//   bash 3.2 + LANG=C 或没设 LANG            → 不吞
//   bash 5.2 (Linux)、任意 locale             → 不吞
// CI runner(mac1)的 Runner.Listener 进程没设 LANG,所以 CI 上不发作;人在 macOS 交互 shell 里
// 手动跑同一个脚本就发作。⇒ 典型的「平时零发作、只在极端路径显形」,靠跑一遍测不出来,只能靠门禁。
//
// 修法是加花括号界定:`${VAR}。`。正文里读着别扭的(比如注释),改成加一个空格也行。
// `\p{ASCII}` 而不是 `[^\x00-\x7F]`:后者把控制字符写进了正则字面量,撞 eslint no-control-regex;
// 而且这个写法直说了意图 —— 「$VAR 后面紧跟一个非 ASCII 字符」。
const OFFENDER = /\$[A-Za-z_][A-Za-z0-9_]*[^\p{ASCII}]/u

const repoRoot = path.resolve(import.meta.dirname, '../../..')

function trackedShellSources() {
  const files = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' }).split('\n').filter(Boolean)
  // 壳脚本 + workflow/action(它们的 run: 块就是 bash,同一个坑)。
  return files.filter((f) => /\.(sh|bash)$/.test(f) || (f.startsWith('.github/') && /\.ya?ml$/.test(f)))
}

describe('shell $VAR 顶在非 ASCII 字符前(#5783)', () => {
  // 阳控用**真实例**:这一行在 deploy/newapi/test_dev_mode_gate.sh(现已移出本仓)里真的存在过,
  // 而它所在的脚本正是 `set -uo pipefail`。❌ 别拿自造的 `$a中` 充数 —— 判据长得对、
  // 结论是空的,这种事在 #5019 那道闸上发生过一次。
  it('detects the real line this guard was born from', () => {
    expect(OFFENDER.test('    echo "FAIL $name: 期望退出 $want_status 且含「$want_text」,实际退出 $status:"')).toBe(true)
    expect(OFFENDER.test('    echo "FAIL ${name}: 期望退出 ${want_status} 且含「${want_text}」,实际退出 ${status}:"')).toBe(false)
  })

  it('leaves ASCII neighbours and braced forms alone', () => {
    for (const ok of ['echo "$a/$b"', 'echo "${a}。"', 'echo "$a 。"', 'die "缺 $key"', 'echo "$a"']) {
      expect(OFFENDER.test(ok), ok).toBe(false)
    }
  })

  it('has no occurrence left in any tracked shell script or workflow', () => {
    const hits: string[] = []
    for (const file of trackedShellSources()) {
      const lines = readFileSync(path.join(repoRoot, file), 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (OFFENDER.test(line)) hits.push(`${file}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(hits, `把 $VAR 改成 \${VAR}(或在它后面加个空格):\n${hits.join('\n')}`).toEqual([])
  })
})
