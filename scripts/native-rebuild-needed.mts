#!/usr/bin/env node
// @@@native-rebuild-gate (#6270) — 这次改动需不需要在 PR 上真编一遍原生模块(Electron ABI)。
//
// 实测依据:2026-09-04 → 09-23 的 400 次失败 CI run 里,desktop-build 单独红(web 构建与 policy 都绿)
// 的 12 次**全部**红在 verify-dev-native 的 `normal PTY spawn timed out` / 槽里原生模块加载不了 ——
// 没有一次是 PR 的改动编不过。重编 + 验证只取决于下面这些输入;它们没变,结论就与 dev 上一样。
//
// 用法(CI 里拿 PR 的 base 与 head 比;depth=1 的浅克隆下两点比较会把 base 这侧的新改动也算进来,
// 只会多触发、不会漏触发):
//   node scripts/native-rebuild-needed.mts --base <ref> --head <ref>   → 打印 needed=true|false
//   printf '%s\n' <files...> | node scripts/native-rebuild-needed.mts --stdin
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 改了就必须重编的路径。❌ 别往这里放产品源码:重编与验证碰的只是 node_modules 里那两个包与这些脚本。 */
export const NATIVE_REBUILD_INPUTS: RegExp[] = [
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/, // patchedDependencies、supportedArchitectures
  /^\.npmrc$/,
  /^\.node-version$/,
  /^patches\//,
  /^scripts\/(?:rebuild-native(?:-isolated)?|native-addon-[^/]+|verify-dev-native[^/]*|electron-launch-failure|ci-native-probe|native-rebuild-needed)\.(?:cjs|mjs|mts|js)$/,
  /^\.github\/docker\/linux-appimage\.Dockerfile$/,
  /^\.github\/actions\/(?:setup-ci-slot|setup-desktop-toolchain)\//,
]

/** package.json 里会影响原生模块的字段。只改 scripts / 描述之类不算。 */
export const PACKAGE_JSON_NATIVE_FIELDS: string[] = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'pnpm',
  'engines',
  'packageManager',
]

export function pathNeedsNativeRebuild(file: string): boolean {
  return NATIVE_REBUILD_INPUTS.some((pattern) => pattern.test(file))
}

/** 两份 package.json 文本在上述字段上是否有差别。任一份解析不了就当有差别(宁多编一次)。 */
export function packageJsonNativeFieldsChanged(beforeText: string, afterText: string): boolean {
  try {
    const before = JSON.parse(beforeText)
    const after = JSON.parse(afterText)
    return PACKAGE_JSON_NATIVE_FIELDS.some((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]))
  } catch {
    return true
  }
}

/**
 * files = 变更文件;readPackageJson 给出 base / head 两份文本,
 * 拿不到(比如 --stdin 模式)时 package.json 一改就算需要。
 */
export function nativeRebuildNeeded(
  files: string[],
  { readPackageJson }: { readPackageJson?: () => [string, string] } = {},
): { needed: boolean; reasons: string[] } {
  const reasons = files.filter(pathNeedsNativeRebuild)
  if (files.includes('package.json')) {
    if (!readPackageJson) reasons.push('package.json')
    else {
      const [before, after] = readPackageJson()
      if (packageJsonNativeFieldsChanged(before, after)) reasons.push('package.json(依赖相关字段)')
    }
  }
  return { needed: reasons.length > 0, reasons }
}

function main(argv: string[]): void {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  let files: string[]
  let readPackageJson: (() => [string, string]) | undefined
  if (argv.includes('--stdin')) {
    files = readFileSync(0, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean)
  } else {
    const base = argv[argv.indexOf('--base') + 1]
    const head = argv[argv.indexOf('--head') + 1]
    if (!argv.includes('--base') || !argv.includes('--head') || !base || !head) {
      console.error('usage: native-rebuild-needed.mts --base <ref> --head <ref> | --stdin')
      process.exit(2)
    }
    files = git('diff', '--name-only', base, head).split('\n').filter(Boolean)
    const show = (ref: string): string => {
      try {
        return git('show', `${ref}:package.json`)
      } catch {
        return ''
      }
    }
    readPackageJson = () => [show(base), show(head)]
  }
  const { needed, reasons } = nativeRebuildNeeded(files, { readPackageJson })
  if (needed) console.error(`[native-rebuild-needed] 需要:${reasons.join(', ')}`)
  else console.error(`[native-rebuild-needed] 不需要:${files.length} 个变更文件都不碰原生模块的输入`)
  console.log(`needed=${needed}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2))
