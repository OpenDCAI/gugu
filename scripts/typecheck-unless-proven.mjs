// @@@typecheck-proven-by-ci (#6426) — 打包链路的类型检查:CI 已经对「这棵树」判过,就不再判第二遍。
//
// 出包的 commit 如果在 origin/dev 或 origin/main 的 first-parent 链上,它就是一次 squash 合并的产物,
// 而合并前那条 PR 的 exact-head CI 已经对同一棵树跑过 `tsgo --noEmit`(`dev`/`main` 的分支保护:
// required check = `Typecheck, lint, and test`,strict=true ⇒ PR head 与 base 同步,squash 出来的树
// 就是 CI 判过的那棵)。这个证明由 workflow 的 channel-gate 用完整历史算出,经
// GUGU_TYPECHECK_PROVEN_SHA 传进构建 job。
//
// 判据绑在 **exact sha** 上:变量不是当前 HEAD、或类型输入被改过 ⇒ 当场红(那是 workflow 接线错了,
// ❌ 静默改跑或静默跳过)。变量不存在(本地、feature 分支 dispatch)⇒ 照跑 tsgo。
import { spawnSync, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const TYPE_INPUTS = ['*.ts', '*.tsx', '*.mts', '*.cts', 'tsconfig*.json']

export function decideTypecheck({ provenSha, head, dirtyTypeInputs }) {
  if (!provenSha) return { run: true, reason: 'no CI proof for this commit (GUGU_TYPECHECK_PROVEN_SHA unset)' }
  if (provenSha !== head) {
    throw new Error(`[typecheck] GUGU_TYPECHECK_PROVEN_SHA=${provenSha} 不是当前 HEAD ${head} —— workflow 把别的 commit 的证明接到了这次构建上`)
  }
  if (dirtyTypeInputs.length > 0) {
    throw new Error(`[typecheck] ${head} 的类型输入在工作区被改过,CI 的证明不覆盖这棵树:\n${dirtyTypeInputs.join('\n')}`)
  }
  return { run: false, reason: `${head} 在 dev/main 的 first-parent 链上,合并前的 PR CI 已对同一棵树跑过 tsgo` }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
  const provenSha = process.env.GUGU_TYPECHECK_PROVEN_SHA || ''
  const decision = decideTypecheck({
    provenSha,
    head: provenSha ? git('rev-parse', 'HEAD') : '',
    dirtyTypeInputs: provenSha ? git('status', '--porcelain', '--untracked-files=no', '--', ...TYPE_INPUTS).split('\n').filter(Boolean) : [],
  })
  console.log(`[typecheck] ${decision.run ? 'running tsgo --noEmit' : 'skipped'}: ${decision.reason}`)
  if (decision.run) {
    const result = spawnSync('tsgo', ['--noEmit'], { stdio: 'inherit', shell: process.platform === 'win32' })
    if (result.error) throw result.error
    process.exitCode = result.status ?? 1
  }
}
