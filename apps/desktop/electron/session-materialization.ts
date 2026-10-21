import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, readdir, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type {
  DirectorySymlinkOverlay,
  GeneratedArtifact,
  GeneratedSymlink,
  JsonMerge,
  JsonOverlay,
  RetiredArtifact,
  TomlOverlay,
} from '@gugu/session-core/agents/plugins'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import { parseJsoncObject } from '@gugu/session-core/agents/plugins/helpers'

export interface ApplicableSessionMaterialization {
  artifacts?: readonly GeneratedArtifact[]
  configMerges?: readonly JsonMerge[]
  tomlOverlays?: readonly TomlOverlay[]
  jsonOverlays?: readonly JsonOverlay[]
  symlinks?: readonly GeneratedSymlink[]
  directorySymlinkOverlays?: readonly DirectorySymlinkOverlay[]
  retiredArtifacts?: readonly RetiredArtifact[]
}

function within(root: string, candidate: string, label: string): string {
  const normalizedRoot = resolve(root)
  const normalized = resolve(candidate)
  if (normalized !== normalizedRoot && !normalized.startsWith(`${normalizedRoot}${sep}`)) {
    throw new Error(`${label} path escapes '${normalizedRoot}': ${candidate}`)
  }
  return normalized
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function mergeWithoutConflicts(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
  path: string[] = [],
  concatArraysUnder: ReadonlySet<string> = new Set(),
): Record<string, unknown> {
  const merged = { ...base }
  for (const [key, patchValue] of Object.entries(patch)) {
    if (!Object.prototype.hasOwnProperty.call(base, key)) {
      merged[key] = patchValue
      continue
    }
    const baseValue = base[key]
    if (isDeepStrictEqual(baseValue, patchValue)) continue
    if (path.length === 0 && isRecord(baseValue) && isRecord(patchValue)) {
      merged[key] = mergeWithoutConflicts(baseValue, patchValue, [...path, key], concatArraysUnder)
      continue
    }
    if (path.length > 0 && concatArraysUnder.has(path[0]!) && Array.isArray(baseValue) && Array.isArray(patchValue)) {
      merged[key] = [...baseValue, ...patchValue]
      continue
    }
    throw new Error(`JSON merge conflict at ${[...path, key].join('.')}`)
  }
  return merged
}

async function readJsonObject(file: string): Promise<Record<string, unknown>> {
  try {
    const bytes = await readFile(file, 'utf8')
    const parsed: unknown = JSON.parse(bytes)
    if (!isRecord(parsed)) throw new Error('top level must be a JSON object')
    return parsed
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new Error(`Cannot merge JSON file '${file}': ${(error as Error).message}`, { cause: error })
  }
}

/**
 * overlay 的**源**(厂商的系统级配置)只读不写 —— 厂商自己按 JSONC 读它(注释、尾逗号都合法),
 * 这里就用同一种语法读;真坏了照样响亮失败。写出去的是咕咕自己那份副本,用户的源文件一个字节不动。
 */
async function readJsoncSource(file: string): Promise<Record<string, unknown>> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new Error(`Cannot read JSON overlay source '${file}': ${(error as Error).message}`, { cause: error })
  }
  const parsed = parseJsoncObject(text)
  if (!parsed) throw new Error(`Cannot merge JSON overlay source '${file}': not a JSON(C) object`)
  return parsed
}

async function atomicWrite(file: string, content: string, mode: number): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, content, { encoding: 'utf8', mode })
    await rename(temp, file)
    await chmod(file, mode)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

async function applyJsonMerge(cwd: string, merge: JsonMerge): Promise<void> {
  if (merge.kind !== 'json-merge' || merge.conflict !== 'fail') {
    throw new Error(`Unsupported session config merge for '${merge.path}'`)
  }
  const file = within(cwd, resolve(cwd, merge.path), 'Session config')
  const existing = await readJsonObject(file)
  const merged = mergeWithoutConflicts(existing, merge.patch)
  await atomicWrite(file, `${JSON.stringify(merged, null, 2)}\n`, merge.mode)
}

async function readTomlObject(file: string): Promise<Record<string, unknown>> {
  try {
    const parsed = parseToml(await readFile(file, 'utf8'))
    if (!isRecord(parsed)) throw new Error('top level must be a TOML table')
    return parsed
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new Error(`Cannot read TOML config '${file}': ${(error as Error).message}`, { cause: error })
  }
}

async function applyTomlOverlay(guguHome: string, overlay: TomlOverlay): Promise<void> {
  if (overlay.conflict !== 'fail' && overlay.conflict !== 'gugu-owns') {
    throw new Error(`Unsupported TOML overlay conflict policy for '${overlay.path}'`)
  }
  const file = within(guguHome, overlay.path, 'Session TOML config')
  const existing = await readTomlObject(overlay.sourcePath)
  // `gugu-owns`:补丁赢。只用于「读写咕咕自己那份配置根」(独立 home)——
  // 那些键从头到尾就是咕咕写的,第二次会话把它们改成新值是正常的,不是冲突。
  // ⚠️ `within(guguHome, …)` 这一钳仍在:policy 换了不等于能往用户目录里写。
  const merged = overlay.conflict === 'gugu-owns'
    ? mergeOverwriting(existing, overlay.patch)
    : mergeWithoutConflicts(existing, overlay.patch)
  await atomicWrite(file, stringifyToml(merged), overlay.mode)
}

/**
 * `applyTomlOverlay` 的 JSON 同形。合并语义、落点钳制、冲突策略逐条相同 ——
 * 差别只有解析器与序列化器,所以这里**复用**同两个 merge 函数,❌ 不另写一套。
 *
 * ⚠️ `sourcePath` 缺席是**正常**的(`readJsonObject` 对 ENOENT 返回 `{}`):绝大多数机器上
 *    引擎的系统级配置根本不存在。存在时它必须被读进来 —— 这条通道会把引擎的系统级配置整份
 *    重定向到咕咕的副本,不先读用户那份就等于在这次会话里静默吞掉他的策略。
 */
async function applyJsonOverlay(guguHome: string, overlay: JsonOverlay): Promise<void> {
  if (overlay.conflict !== 'fail' && overlay.conflict !== 'gugu-owns') {
    throw new Error(`Unsupported JSON overlay conflict policy for '${overlay.path}'`)
  }
  const file = within(guguHome, overlay.path, 'Session JSON config')
  const existing = await readJsoncSource(overlay.sourcePath)
  const merged = overlay.conflict === 'gugu-owns'
    ? mergeOverwriting(existing, overlay.patch)
    : mergeWithoutConflicts(existing, overlay.patch, [], new Set(overlay.concatArraysUnder ?? []))
  await atomicWrite(file, `${JSON.stringify(merged, null, 2)}\n`, overlay.mode)
}

/**
 * 深合并,**补丁赢**。表(TOML 的 `[a.b]`)递归合并,其余整格替换 ——
 * ❌ 数组不做逐项合并:`support_efforts = [...]` 这类是一份**完整声明**,
 * 追加只会拼出一份谁也没声明过的清单。
 */
function mergeOverwriting(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...base }
  for (const [key, patchValue] of Object.entries(patch)) {
    const baseValue = merged[key]
    merged[key] = isRecord(baseValue) && isRecord(patchValue)
      ? mergeOverwriting(baseValue, patchValue)
      : patchValue
  }
  return merged
}

async function pathKind(file: string): Promise<'missing' | 'file' | 'directory' | 'symlink'> {
  try {
    const stat = await lstat(file)
    if (stat.isSymbolicLink()) return 'symlink'
    if (stat.isDirectory()) return 'directory'
    return 'file'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw error
  }
}

async function applySymlink(guguHome: string, link: GeneratedSymlink): Promise<void> {
  if (link.ensureSourceDirectory && link.optionalSource) {
    throw new Error(
      `Session symlink '${link.path}' declares both ensureSourceDirectory and optionalSource`,
    )
  }
  let sourceKind = await pathKind(link.sourcePath)
  if (sourceKind === 'missing' && link.ensureSourceDirectory) {
    await mkdir(link.sourcePath, { recursive: true })
    sourceKind = 'directory'
  }
  if (sourceKind === 'missing') {
    if (link.optionalSource) return
    throw new Error(`Session symlink source does not exist: ${link.sourcePath}`)
  }
  const target = within(guguHome, link.path, 'Session symlink')
  const targetKind = await pathKind(target)
  if (targetKind === 'symlink') {
    const current = resolve(dirname(target), await readlink(target))
    if (current === resolve(link.sourcePath)) return
    throw new Error(`Session symlink conflict at '${target}'`)
  }
  if (targetKind !== 'missing') throw new Error(`Session symlink conflict at '${target}'`)
  await mkdir(dirname(target), { recursive: true })
  // Windows junction 不要求 Developer Mode / SeCreateSymbolicLinkPrivilege，普通安装也能挂载扩展 skill。
  const linkType = sourceKind === 'directory'
    ? (process.platform === 'win32' ? 'junction' : 'dir')
    : 'file'
  await symlink(link.sourcePath, target, linkType)
}

async function applyDirectorySymlinkOverlay(
  guguHome: string,
  overlay: DirectorySymlinkOverlay,
): Promise<void> {
  if (overlay.conflict !== 'fail') {
    throw new Error(`Unsupported directory overlay conflict policy for '${overlay.path}'`)
  }
  const sourceKind = await pathKind(overlay.sourcePath)
  if (sourceKind === 'missing') {
    if (overlay.optionalSource) return
    throw new Error(`Directory overlay source does not exist: ${overlay.sourcePath}`)
  }
  if (sourceKind !== 'directory') {
    throw new Error(`Directory overlay source is not a directory: ${overlay.sourcePath}`)
  }
  const target = within(guguHome, overlay.path, 'Session directory overlay')
  await mkdir(target, { recursive: true })
  const suffixes = overlay.includeSuffixes
  for (const entry of await readdir(overlay.sourcePath)) {
    if (suffixes && !suffixes.some((suffix) => entry.endsWith(suffix))) continue
    await applySymlink(guguHome, {
      sourcePath: resolve(overlay.sourcePath, entry),
      path: resolve(target, entry),
      optionalSource: false,
    })
  }
}

/**
 * 回收 Gugu 历史上写下的工件,按**逐字节**匹配:盘上内容与声明的 `content` 深等才删,不等就
 * 原样留着 —— 那是用户自己的文件,不是我们的残留。Gugu 不再写这个文件,只认自己那份字节把它
 * 捡回来,认不出就不碰。#4895:清 OpenCode 通知插件残留。
 */
async function retireArtifacts(
  cwd: string,
  guguHome: string,
  retired: readonly RetiredArtifact[],
): Promise<void> {
  for (const artifact of retired) {
    if (!isAbsolute(artifact.path)) {
      throw new Error(`Retired artifact path must be absolute: ${artifact.path}`)
    }
    const root = artifact.target === 'workspace' ? cwd : guguHome
    const file = within(
      root,
      artifact.path,
      artifact.target === 'workspace' ? 'Retired workspace artifact' : 'Retired artifact',
    )
    let bytes: string
    try {
      bytes = await readFile(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (bytes !== artifact.content) continue
    await rm(file)
  }
}

export async function applySessionMaterialization(input: {
  cwd: string
  guguHome: string
  materialization: ApplicableSessionMaterialization
}): Promise<void> {
  const cwd = resolve(input.cwd)
  if (!input.guguHome.trim()) throw new Error('Session materialization requires an explicit GUGU_HOME')
  const guguHome = resolve(input.guguHome)
  for (const overlay of input.materialization.tomlOverlays ?? []) {
    await applyTomlOverlay(guguHome, overlay)
  }
  for (const overlay of input.materialization.jsonOverlays ?? []) {
    await applyJsonOverlay(guguHome, overlay)
  }
  for (const link of input.materialization.symlinks ?? []) {
    await applySymlink(guguHome, link)
  }
  for (const overlay of input.materialization.directorySymlinkOverlays ?? []) {
    await applyDirectorySymlinkOverlay(guguHome, overlay)
  }
  for (const artifact of input.materialization.artifacts ?? []) {
    if (!isAbsolute(artifact.path)) {
      throw new Error(`Session artifact path must be absolute: ${artifact.path}`)
    }
    const root = artifact.target === 'workspace' ? cwd : guguHome
    const file = within(root, artifact.path, artifact.target === 'workspace'
      ? 'Session workspace artifact'
      : 'Session artifact')
    await atomicWrite(file, artifact.content, artifact.mode)
  }
  await retireArtifacts(cwd, guguHome, input.materialization.retiredArtifacts ?? [])
  for (const merge of input.materialization.configMerges ?? []) {
    await applyJsonMerge(cwd, merge)
  }
}
