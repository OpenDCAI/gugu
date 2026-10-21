import { execFileSync } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 治理检查器读的是 git ref 里的内容,不是工作区 —— 那是刻意的,判据必须对着已提交的状态,
// 否则一棵脏工作树就能让门变红或变绿。但从前取内容的写法是**每个文件 fork 一次 `git show`**,
// 而且 ui-state-debt / console-usage / e2e-ordinal-locator 三个检查器各抄了一份同样的
// treeFiles / readBlob / verifyRef / git / repoRoot —— 同一个 bug 三处都在,正因为代码是三份。
// 实测 apps/desktop/src 一棵树 1414 个文件 → 1418 次 git 调用,27.9s 墙钟里 18.9s 花在 sys:
// 时间不在读文件,在建进程。`git cat-file --batch` 一个进程就能顺着 stdin 收全部路径、
// 从 stdout 顺序读回,1418 次 fork 变 1 次。
//
// 列举与读取是两个导出,不是一个:调用方拿到清单后**先按扩展名筛掉不看的文件再读**。
// 合成一步(列举时顺手把整棵树读进一个模块级缓存)看着更省事,实际会读进 console-usage 那
// 两棵树里 253 个二进制文件共 7.9MB(emdash.icns、session-tooling/fixtures/*.db),读完就扔;
// 而且缓存一旦存在就得回答「没命中怎么办」,那个问题的每个答案都是错的 —— 静默回落到
// per-file `git show` 就是把这个 PR 删掉的 fork 风暴又请回来,还不报错。没有缓存就没有这个问题。

function git(args, rootDirectory = process.cwd()) {
  return execFileSync('git', args, {
    cwd: rootDirectory,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 64,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

export function repoRoot() {
  return git(['rev-parse', '--show-toplevel']).trim()
}

export function verifyRef(ref, rootDirectory) {
  if (!ref) throw new Error('missing required git ref')
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      cwd: rootDirectory,
      stdio: ['ignore', 'ignore', 'ignore'],
    })
  } catch {
    throw new Error(`git ref not found: ${ref}`)
  }
}

/** 列出 ref 里 roots 下的全部文件。roots 收单个字符串或数组(console-usage 要扫两棵树)。 */
export function treeFiles(ref, roots, rootDirectory) {
  verifyRef(ref, rootDirectory)
  const files = new Set()
  for (const root of Array.isArray(roots) ? roots : [roots]) {
    let treeType
    try {
      treeType = execFileSync('git', ['cat-file', '-t', `${ref}:${root}`], {
        cwd: rootDirectory,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim()
    } catch {
      throw new Error(`git path not found at ${ref}:${root}`)
    }
    if (treeType !== 'tree') throw new Error(`git path is not a directory at ${ref}:${root}`)
    // -z:路径里可以有换行,`ls-tree` 的默认换行分隔会把这种路径劈成两条。
    for (const file of git(['ls-tree', '-r', '-z', '--name-only', ref, '--', root], rootDirectory).split('\0')) {
      if (file) files.add(file)
    }
  }
  return [...files].sort()
}

/**
 * 一个 `git cat-file --batch` 进程取回 files 的全部内容,返回 file → 文本。
 *
 * 输入用 `-z` 走 NUL 分隔,不是换行:上面 `ls-tree` 特意用 `-z` 收的清单里可以有含换行的路径,
 * 换行分隔会让 git 多吐一个回包,**从那一条起后面每条的 header 与偏移全体错位** ——
 * 于是 A 文件的内容被算成 B 文件的,检查器数错文件、写出一份静默错误的 baseline,不报错。
 * 被它取代的 `git show ref:path` 对此免疫,所以这不是可以省的一步。
 *
 * 回包是 `<oid> <type> <size>\n<contents>\n`,size 是**字节数**,所以只能按字节切片
 * (Buffer.toString 的 start/end 就是字节偏移),❌ 别先转字符串再按字符数切 —— 这棵树里
 * 中文注释到处都是,一个多字节字符就能把后面所有条目带偏。
 * 取不到的对象回 `<input> missing`,越界与非 blob 一并 fail loud,不静默跳过、不静默截断。
 */
export function readTreeBlobs(ref, files, rootDirectory) {
  const blobs = new Map()
  if (files.length === 0) return blobs
  // 清单从**文件**喂给 git,不走 `input:` —— 理由见 .eslintrc.cjs 顶部 @@@spawnsync-input (#3766)。
  // 这里是全仓最吃紧的一处:清单 163KB 起步(console-usage 2352 个文件)、远超 macOS 的管道缓冲,
  // 而且这个调用**没有 timeout**,一旦挂就是干等到整个 job 超时。文件描述符做 stdin 后根本没有
  // 管道,那条路径不存在,也不必把三个同步调用方全改成异步。
  const batchDirectory = mkdtempSync(join(tmpdir(), 'gugu-cat-file-'))
  let batchFd
  let stdout
  let handedOff = false
  try {
    const batchPath = join(batchDirectory, 'batch')
    writeFileSync(batchPath, files.map((file) => `${ref}:${file}\0`).join(''))
    batchFd = openSync(batchPath, 'r')
    stdout = execFileSync('git', ['cat-file', '--batch', '-z'], {
      cwd: rootDirectory,
      maxBuffer: 1024 * 1024 * 1024,
      stdio: [batchFd, 'pipe', 'pipe'],
    })
    handedOff = true
  } finally {
    if (batchFd !== undefined) closeSync(batchFd)
    // 只在成功路径删。失败时 git 的报错是对着这份清单说的,顺手删掉就没法复现 ——
    // mkdtemp 放在 try 外、fd 用 undefined 兜,是为了让这段 finally 覆盖 write/open 的抛出,
    // 不留下「异常发生在 try 之前所以没人清理」的缺口。
    if (handedOff) rmSync(batchDirectory, { recursive: true, force: true })
  }
  let offset = 0
  for (const file of files) {
    const lineEnd = stdout.indexOf(0x0a, offset)
    if (lineEnd < 0) throw new Error(`unable to read ${ref}:${file}: git cat-file output ended early`)
    const header = stdout.toString('utf8', offset, lineEnd)
    if (header.endsWith(' missing')) throw new Error(`unable to read ${ref}:${file}: missing object`)
    const fields = header.split(' ')
    const type = fields[fields.length - 2]
    const size = Number(fields[fields.length - 1])
    if (type !== 'blob' || !Number.isInteger(size) || size < 0) {
      throw new Error(`unable to read ${ref}:${file}: unexpected git cat-file header "${header}"`)
    }
    const start = lineEnd + 1
    // 名字必须是**这一条**:少了这个判断,Buffer.toString 会在缓冲区末尾静默截断,
    // 报错留给下一轮抛出,而那时说的是下一个文件名 —— 排查会被指到无辜的文件上。
    if (start + size > stdout.length) {
      throw new Error(`unable to read ${ref}:${file}: git cat-file output truncated (declared ${size} bytes)`)
    }
    blobs.set(file, stdout.toString('utf8', start, start + size))
    offset = start + size + 1 // 内容之后还有一个 \n
  }
  return blobs
}
