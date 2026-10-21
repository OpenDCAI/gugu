import { open, readFile, readdir, realpath, stat } from 'node:fs/promises'
import { basename, join, sep } from 'node:path'
import type { JsonlSearchResult } from './runtimeInfo'
import { readDeliveryEnvelope } from './deliveryEnvelope'
import { asRecord, clipTitle, scanRootsOf, type TranscriptFrame, type TranscriptScanOptions, type TranscriptSourceSpec } from './transcriptSource'
import { allTranscriptSourceSpecs, requireTranscriptSourceSpec } from './transcriptSources'
import type {
  ImportedTranscript,
  ImportedTranscriptTurn,
  LocalTranscriptSession,
  TranscriptSource
} from '../../shared/types/transcripts'

export interface TranscriptInventoryOptions extends TranscriptScanOptions {
  signal?: AbortSignal
}

// 本机 CLI 会话 transcript 清单 + 完整历史读取 —— **通用层**。
// sessionpage 的独立 session-history import 使用清单/索引；旧 durable provision recovery 使用完整读取。
//
// 这个文件里**没有任何一家引擎的知识**：扫哪个目录、一行 JSON 怎么算一轮、哪些是机器注的伪对话，
// 全部由 `transcriptSources/` 下各家的 spec 声明（契约见 `transcriptSource.ts`）。这里只做那些
// 「换哪一家都一样」的事：目录并发下钻、头部窥读、mtime/size 当缓存钥匙、扫描根围栏、
// 标题/cwd/sessionId 的取值规则、轮次装配、坏文件容错。
//
// ⚠️ 加一家**不该**改这个文件。要是发现非改不可，那说明契约漏了一维 —— 去补契约，
// 别在这里加 `if (source === …)`：那正是这次重构拆掉的东西。

const HEAD_LINES = 80 // 标题/cwd/session_meta 都在文件头部；Codex 的 base_instructions 单行极长，头读上限 1MB 足够
const DIR_CONCURRENCY = 16

async function listFilesByExtension(
  root: string,
  extension: string,
  result: JsonlSearchResult,
  signal?: AbortSignal
): Promise<string[] | null> {
  signal?.throwIfAborted()
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      result.dirs_missing += 1
      return null
    }
    throw error
  }
  signal?.throwIfAborted()
  result.dirs_searched += 1
  const files: string[] = []
  const subdirs: string[] = []
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) subdirs.push(path)
    else if (entry.isFile() && entry.name.endsWith(extension)) files.push(path)
  }
  // 子目录并发下钻：Codex 按 年/月/日 分目录，一台常用机上有几千个日期目录，
  // 串行递归光是 readdir 就要 4 秒——那是导入面板打开慢的大头。实测并发后 ≈0.2-0.5 秒。
  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(DIR_CONCURRENCY, subdirs.length) }, async () => {
      while (cursor < subdirs.length) {
        signal?.throwIfAborted()
        const nested = await listFilesByExtension(subdirs[cursor++], extension, result, signal)
        if (nested) files.push(...nested)
      }
    })
  )
  return files
}

async function readFirstLines(
  path: string,
  count: number,
  signal?: AbortSignal
): Promise<string[]> {
  const chunkSize = 64 * 1024
  const maxBytes = 1024 * 1024
  const buffer = Buffer.alloc(chunkSize)
  let text = ''
  let position = 0
  let handle
  try {
    signal?.throwIfAborted()
    handle = await open(path, 'r')
    while (position < maxBytes && text.split('\n').length <= count) {
      signal?.throwIfAborted()
      const { bytesRead } = await handle.read(buffer, 0, chunkSize, position)
      signal?.throwIfAborted()
      if (bytesRead === 0) break
      position += bytesRead
      text += buffer.subarray(0, bytesRead).toString('utf8')
    }
    return text.split('\n').slice(0, count)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  } finally {
    await handle?.close()
  }
}

// ── 帧 → 会话摘要（通用规则，35 家同一套）───────────────────────────────────────

interface TranscriptDigest {
  providerSessionId: string | null
  cwd: string | null
  title: string | null
  /** 现有的 title 是不是用户亲手写的 —— 引擎拟的标题不许盖掉它。 */
  titleIsUserSet: boolean
  /** 见过至少一轮真对话。没有它的文件列出来也蒸不出记忆。 */
  sawConversation: boolean
}

function newDigest(): TranscriptDigest {
  return { providerSessionId: null, cwd: null, title: null, titleIsUserSet: false, sawConversation: false }
}

/**
 * 把一帧并进摘要。三条取值规则是**产品口径**，不是实现细节，所以放在通用层：
 *  · sessionId / cwd —— 首个非空值胜出（会话的身份由它的头部确立）；
 *  · 显式标题 —— 引擎自己记的标题永远压过摘句；同一档内后到者覆盖（用户最后一次改的名字为准），
 *    但**用户设的那一档压过引擎拟的那一档**，与先后无关；
 *  · 兜底标题 —— 首条**用户**轮次的摘句；助手的话不当标题。
 */
function absorbFrame(digest: TranscriptDigest, frame: TranscriptFrame): void {
  if (!digest.providerSessionId && frame.providerSessionId) digest.providerSessionId = frame.providerSessionId
  if (!digest.cwd && frame.cwd) digest.cwd = frame.cwd
  if (frame.explicitTitle) {
    // 用户亲手写的标题压过引擎拟的，**与出现顺序无关**（见 TranscriptFrame.explicitTitleIsUserSet）。
    // ❌ 别退回成无条件覆盖：claude 的 ai-title 常排在 custom-title 之后，那样用户改的会被盖掉。
    if (frame.explicitTitleIsUserSet || !digest.titleIsUserSet) {
      digest.title = frame.explicitTitle
      if (frame.explicitTitleIsUserSet) digest.titleIsUserSet = true
    }
  }
  if (frame.turn) {
    digest.sawConversation = true
    if (!digest.title && frame.turn.role === 'user') digest.title = clipTitle(frame.turn.content)
  }
}

/** 投递进来的那一轮只取正文:信封是写给 agent 的现场事实,摘句标题、预览与导入要的是这一轮说了什么。 */
function readFrame(spec: TranscriptSourceSpec, entry: Record<string, unknown>): TranscriptFrame | null {
  const frame = spec.readFrame(entry)
  const delivery = frame?.turn?.role === 'user' ? readDeliveryEnvelope(frame.turn.content) : null
  return delivery ? { ...frame, turn: { ...frame!.turn!, content: delivery.body } } : frame
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    return asRecord(JSON.parse(trimmed))
  } catch {
    return null
  }
}

// ── 清单 ─────────────────────────────────────────────────────────────────────

/**
 * 只枚举本机会话文件（不读内容）。列清单与增量索引共用同一份扫描口径，
 * 免得两处各扫各的、对「有哪些会话」给出不同答案。
 */
export async function listLocalTranscriptFiles(
  options: TranscriptInventoryOptions
): Promise<Array<{ source: TranscriptSource; path: string }>> {
  // 诊断口径：缺根目录记 dirs_missing（工具没装是常态，非错误）。
  const scan: JsonlSearchResult = { dirs_searched: 0, dirs_missing: 0, files_scanned: 0 }
  const jobs: Array<{ source: TranscriptSource; path: string }> = []
  for (const spec of allTranscriptSourceSpecs()) {
    // 去重按**家**分开：同一家的多个根可能指向同一个目录（claude 的 CLAUDE_CONFIG_DIR 设成
    // ~/.claude 时就是），列两遍会让面板出现重复行。跨家不去重 —— 两家共用一个根是另一回事，
    // 悄悄吞掉一家只会让人以为「它没有历史」。
    const seen = new Set<string>()
    for (const root of scanRootsOf(spec, options)) {
      options.signal?.throwIfAborted()
      const files = await listFilesByExtension(root, spec.fileExtension, scan, options.signal)
      for (const path of files ?? []) {
        if (seen.has(path)) continue
        seen.add(path)
        jobs.push({ source: spec.id, path })
      }
    }
  }
  return jobs
}

/**
 * 读单个 transcript 的头部，产出清单行。返回 null = 该文件不该出现在清单里
 * （旁支 transcript / 头部没有真对话）。
 */
export async function describeTranscript(
  source: TranscriptSource,
  path: string,
  options: { signal?: AbortSignal } = {}
): Promise<LocalTranscriptSession | null> {
  const spec = requireTranscriptSourceSpec(source)
  // 单个文件被删/EACCES/EIO → 跳过该文件，不让一个坏文件毁掉整份清单（840 个文件里
  // 一个权限坏的备份不该让导入功能全机不可用）。
  let info
  let lines: string[]
  try {
    options.signal?.throwIfAborted()
    const result = await Promise.all([
      stat(path),
      readFirstLines(path, HEAD_LINES, options.signal),
    ])
    options.signal?.throwIfAborted()
    info = result[0]
    lines = result[1]
  } catch {
    options.signal?.throwIfAborted()
    return null
  }
  const digest = newDigest()
  for (const line of lines) {
    const entry = parseJsonLine(line)
    if (!entry) continue
    const frame = readFrame(spec, entry)
    if (!frame) continue
    if (frame.sidechain) return null // 子 agent 旁支 transcript，整份都不是用户会话
    absorbFrame(digest, frame)
  }
  // 头部完全没有真对话（纯命令记录/快照文件）→ 不进清单，免得选了也蒸不出内容、提交才失败。
  // 显式标题算数：引擎给过名字的会话，正文可能全在头部之后。
  if (!digest.sawConversation && !digest.title) return null
  return {
    source,
    providerSessionId: digest.providerSessionId ?? basename(path, spec.fileExtension),
    title: digest.title ?? '（无标题会话）',
    cwd: digest.cwd,
    filePath: path,
    updatedAt: info.mtimeMs,
    sizeBytes: info.size
  }
}

/**
 * 读取完整源 transcript，并把真实用户/助手消息解析为标准轮次。工具输出、思考和产品注入块
 * 不会伪装成对话消息，也不进入返回值——被导入的「记忆」只有对话轮次。原始字节只在本进程用于
 * 解析、不带出返回值：原始文件只由 provision-owned history import RPC 消费，故无需回传。
 * 路径必须落在清单扫描根内。
 */
export async function readLocalTranscript(
  filePath: string,
  source: TranscriptSource,
  options: TranscriptInventoryOptions
): Promise<ImportedTranscript> {
  const spec = requireTranscriptSourceSpec(source)
  await assertPathInScanRoots(filePath, spec, options)
  options.signal?.throwIfAborted()
  const bytes = await readFile(filePath, { signal: options.signal })
  options.signal?.throwIfAborted()
  const lines = bytes.toString('utf8').split('\n')
  const turns: ImportedTranscriptTurn[] = []
  const digest = newDigest()
  for (const line of lines) {
    options.signal?.throwIfAborted()
    const entry = parseJsonLine(line)
    if (!entry) continue
    const frame = readFrame(spec, entry)
    if (!frame) continue
    // 摘录这一路对旁支是**逐条**跳过：混编文件里用户自己那几轮照样导得进来。
    if (frame.sidechain) continue
    absorbFrame(digest, frame)
    if (frame.turn) turns.push(frame.turn)
  }
  if (turns.length === 0) {
    throw new Error(`transcript 中没有可导入的用户/助手对话：${filePath}`)
  }
  return {
    source,
    providerSessionId: digest.providerSessionId ?? basename(filePath, spec.fileExtension),
    title: digest.title ?? '（无标题会话）',
    cwd: digest.cwd,
    fileName: basename(filePath),
    turns
  }
}

/**
 * 路径围栏：只准读落在这一家 `scanRootsOf` 之内的文件。
 *
 * ⚠️ **两侧都要 realpath，不是只 resolve。** `resolve()` 只做字符串层面的规范化，**不解符号链接** ——
 * 扫描根里放一条指向根外的链接（`~/.claude/projects/x.jsonl -> /etc/shadow`），
 * `resolve` 判定通过，随后的 `readFile` 却会跟着链接走出去。而这条路的输入来自**渲染层经 IPC
 * 递进来的不受信路径**，围栏松一寸，导入面板就是个任意文件读取器。
 *
 * 只解一侧同样不行：macOS 上 `/var` → `/private/var`，只解目标不解根会让**每一次**判定都成越界。
 *
 * 根不存在（用户没装这一家）时跳过该根而不是抛错 —— 那不是越界，是没有这个目录。
 * 目标不存在时 realpath 抛，这正确：读一个不存在的文件本来就该失败。
 */
async function assertPathInScanRoots(
  filePath: string,
  spec: TranscriptSourceSpec,
  options: TranscriptScanOptions
): Promise<void> {
  let realFile: string
  try {
    realFile = await realpath(filePath)
  } catch {
    throw new Error(`transcript 路径不存在或不可读：${filePath}`)
  }
  for (const root of scanRootsOf(spec, options)) {
    let realRoot: string
    try {
      realRoot = await realpath(root)
    } catch {
      continue
    }
    if (realFile === realRoot || realFile.startsWith(realRoot + sep)) return
  }
  throw new Error(`transcript 路径不在允许的扫描目录内：${filePath}`)
}
