import { join } from 'node:path'
import type { ImportedTranscriptTurn, TranscriptSource, TranscriptContext } from '../../shared/types/transcripts'

// 「导入外部历史」的**引擎侧契约**。
//
// 从前 transcriptInventory.ts 里 claude 与 codex 的差异是靠 `source === 'claude-code' ? … : …`
// 三元表达式分开的：扫哪个目录、一行 JSON 怎么算一轮、哪些记录是机器注的伪对话，全在同一个
// 文件里对半劈。加第三家就得进那个文件再劈一次，而且每劈一次都要重读整份 412 行才知道会不会
// 碰坏另一家。
//
// 现在引擎特有的部分收敛成这一份 spec：**路径 + 分帧 + 伪记录判定**。通用层（目录并发下钻、
// 头部窥读、mtime/size 缓存钥匙、扫描根围栏、标题/cwd/sessionId 的取值规则、轮次装配、坏文件
// 容错）一份，谁也不用抄。
//
// ⚠️ spec 里**只放引擎自己的事实**。凡是「所有家都一样」的判断（例如「文件里一条真对话都没有
// 就不进清单」）都归通用层 —— 放进 spec 等于让 35 家各抄一遍，抄漏一家就是一处静默的行为分叉。

/**
 * 一条 transcript 记录被解析成的**帧**：一行（或一条记录）→ 至多一帧。
 *
 * 返回 `null` = 这条记录与会话内容无关（工具输出、事件、快照…），通用层直接跳过。
 * 空对象 `{}` 与 `null` 对通用层等价，写哪个都行。
 */
export interface TranscriptFrame {
  /** Compact observation from the same source record, never instruction bodies or tool output. */
  context?: Partial<Pick<TranscriptContext, 'loaded' | 'nested' | 'refs'>>
  /**
   * 这条记录属于**子 agent 旁支**，不是用户自己那条会话。
   *
   * ⚠️ 两条读路对它的反应故意不同（沿用既有行为，别「顺手统一」）：
   *  · 清单（`describeTranscript`）：头部只要出现一条 → **整份文件**不进清单。旁支 transcript
   *    整份都是旁支，列出来用户点了也蒸不出自己的记忆。
   *  · 摘录（`readLocalTranscript`）：**逐条**跳过（元信息与轮次都不取），文件其余部分照常导入。
   */
  sidechain?: boolean
  /** 会话 id。**首个非空值胜出**（见下方 `absorbFrame`）。 */
  providerSessionId?: string
  /** 会话运行时所在目录。首个非空值胜出。 */
  cwd?: string
  /**
   * 引擎**显式记录**的标题（例：claude 的 `custom-title` / `ai-title`）。
   * 它永远压过「首条用户消息摘句」这个兜底；同一档内多条时后到者覆盖。
   */
  explicitTitle?: string
  /**
   * 这条标题是**用户亲手写的**，不是引擎自己拟的。
   *
   * 不止 claude 有这个两档结构（`custom-title` 用户改的 / `ai-title` 引擎拟的），所以放进契约
   * 而不是塞进某一家的 spec。语义只有一条：**用户设的压过引擎拟的，与出现顺序无关**。
   *
   * ⚠️ 少了它就只能靠「后到者覆盖」，而两种标题在文件里的先后是不保证的 ——
   * ai-title 恰好排在后面时，用户亲手改的标题会被引擎拟的盖掉，而且悄无声息。
   */
  explicitTitleIsUserSet?: boolean
  /**
   * 真实对话轮次。
   * ⚠️ 机器注入的伪记录（斜杠命令回显、本地命令输出、环境/身份注入块、AGENTS.md 正文…）必须
   * 在 `readFrame` 里就剔掉 —— 它们既不是用户说的话，也可能带着 regex 覆盖不到的隐私内容，
   * 而摘录结果是要上云的。
   */
  turn?: ImportedTranscriptTurn
}

/**
 * 咕咕读回这一家历史用的**存法**。词表与 session-core 的
 * `SessionCoexistence.history` 的 channel 对齐 —— 插件那边声明 `history: { kind: 'native',
 * channel: C }`，这边就必须有一份 `channel === C` 的 spec，两侧由
 * `tests/unit/core/local/transcriptSources.test.ts` 对账。
 *
 * ⚠️ 今天只有 `'jsonl'` 一种。`'sqlite'` / `'server'` 不是「填个字面量就行」：
 *  · sqlite 要多一条**发现**路径（找 .db 文件而不是按后缀枚举）、一条**读取**路径（开库查表
 *    而不是按行 JSON.parse），还要定驱动（仓里已有 `better-sqlite3`，但它在根 package.json 里
 *    是按 **electron** 编译的，node 侧另装一份见 vitest.config.ts 的 `dbAlias`）——那是一次
 *    独立决策，不该顺手塞进本契约。
 *  · `'server'` 按 #3889 的口径**不该出现在这里**：云端历史咕咕管不到人家的云。
 * 之所以写成 discriminated union 而不是让 spec 带一个可选 channel 字段：将来加 sqlite 成员时，
 * 通用层每一处 switch 会**编译期**红，而不是运行时静默走到 jsonl 分支上去。
 */
export type TranscriptStorageChannel = 'jsonl'

/** 按行 JSON 的会话文件（claude / codex 以及绝大多数 CLI harness 的存法）。 */
export interface JsonlTranscriptSourceSpec {
  readonly channel: 'jsonl'
  readonly id: TranscriptSource
  /** 会话文件后缀（含点）。清单枚举与 sessionId 兜底（取 basename）都用它。 */
  readonly fileExtension: string
  /**
   * 会话文件在原生配置根下的子目录。配置根不归 spec 管：插件声明、宿主经 `nativeHomes` 递进来，候选全扫。
   *
   * ⚠️ 扫描根也是**安全边界**：`readLocalTranscript` 只允许读落在这些根之内的路径。渲染层递上来的
   * 路径不受信任，围栏松一寸，导入面板就变成任意文件读取器（走 IPC 的那种）。
   */
  readonly recordsDir: string
  /**
   * 一行解析出的 JSON 对象 → 一帧。**纯函数**，不碰磁盘、不看上下文（通用层不保证顺序之外的
   * 任何东西）。解析不出 JSON 的行通用层已经滤掉，这里拿到的一定是对象。
   */
  readFrame(entry: Record<string, unknown>, view?: 'context'): TranscriptFrame | null
}

export type TranscriptSourceSpec = JsonlTranscriptSourceSpec

/** 扫描要用到的、core 自己不知道的那一维：每一家原生配置根的候选（宿主按插件的 `nativeHome` 算出）。 */
export interface TranscriptScanOptions {
  nativeHomes: Readonly<Record<TranscriptSource, readonly string[]>>
}

/** 这一家要扫的全部根。候选由宿主给，spec 只补子目录。 */
export function scanRootsOf(spec: TranscriptSourceSpec, options: TranscriptScanOptions): string[] {
  return options.nativeHomes[spec.id].map((root) => join(root, spec.recordsDir))
}

// ── spec 作者共用的小工具（都是纯函数，放这里免得 35 份 spec 各抄一份）─────────────

/** 标题上限：清单一行放得下，又不至于把整段开场白搬进列表。 */
export const TITLE_MAX_CHARS = 120

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/**
 * 判「这段文本算不算有内容」，并原样保留可见字符间的排版。
 * 折叠空白只用于**判空**（全是空格/换行的段落等于没说话），返回的仍是原文 trim 后的样子。
 */
export function cleanText(text: string): string | null {
  const cleaned = text.replace(/\s+/g, ' ').trim()
  return cleaned.length > 0 ? text.trim() : null
}

export function clipTitle(text: string): string {
  const single = text.replace(/\s+/g, ' ').trim()
  return single.length > TITLE_MAX_CHARS ? `${single.slice(0, TITLE_MAX_CHARS)}…` : single
}

/** 记录自带的时间戳；没有或解析不出来时返回 null（不猜、不用 mtime 顶替）。 */
export function entryTimestamp(entry: Record<string, unknown>): string | null {
  const value = entry.timestamp
  if (typeof value !== 'string' || !value || Number.isNaN(Date.parse(value))) return null
  return value
}

/** 取字符串字段；空串按「没有」处理。 */
export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
