import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'

// @@@fs-module-cache-per-lockfile (#6517) — vitest 的 fsModuleCache 按锁文件分格。
// 缓存里存的是转换后的模块,依赖的 import 已经解析成绝对路径写死在里面
// (`/node_modules/.pnpm/node-pty@1.1.0_patch_hash=…/node_modules/node-pty/lib/index.js`)。锁文件一变,
// 这些路径就可能过时;pnpm 不删旧的 `.pnpm/<包>@<版本>` 目录,旧路径照样加载得到、不报错,只是跑的是旧版本。
// 而 `vi.mock('<包>')` 在运行时按新锁文件解析到新目录,两边 id 对不上,mock 静默落空
// (#6493 删 node-pty 补丁,CI 槽上 3 次红 2 次,都是这个)。
// vitest 自己的失效判断(_metadata.json 里记的锁文件哈希)在 4.1.x 里每隔一次锁文件变更就漏判一次:
// 清缓存时把 metadata 一起删了却不写回,下一次运行看到「没有 metadata」就直接信任缓存
// (上游 vitest-dev/vitest#11193,5.x 才修)。
// ⇒ 不靠它:每份锁文件一格,某一格只有同一份锁文件的运行会读写,不可能读到按别的锁文件转换出来的模块。
//    同目录下的其余条目在起跑时删掉:别的锁文件的格子(每格 ~100MB,不删会在槽里越堆越多)、
//    分格之前平铺的旧缓存、vitest 的 _metadata.json(删了它,vitest 起跑时读不到旧的锁文件哈希,
//    也就不会去清当前这一格)。删不掉不影响正确性(读写只进当前这一格),所以不抛。
export function lockfileScopedModuleCacheDir(root: string): string {
  const parent = path.join(root, 'node_modules', '.experimental-vitest-cache')
  const key = createHash('sha256')
    .update(readFileSync(path.join(root, 'pnpm-lock.yaml')))
    .digest('hex')
    .slice(0, 16)
  let names: string[] = []
  try {
    names = readdirSync(parent)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  for (const name of names) {
    if (name === key) continue
    try {
      rmSync(path.join(parent, name), { recursive: true, force: true })
    } catch {
      // 同一个槽里并发起跑的几个 vitest(session-db 那一步)会同时删同一批条目;谁删掉都一样。
    }
  }
  return path.join(parent, key)
}
