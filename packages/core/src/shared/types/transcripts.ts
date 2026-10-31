// 本机 CLI 会话 transcript 的清单条目。
// 由 sessionpage host source 的增量索引产出；旧 durable recovery 只通过已持久化来源引用读取，
// web/capacitor 无本机文件，不实现即无入口。

/**
 * 咕咕**已经接通读回**的本机会话来源。
 *
 * ⚠️ 这张表的含义是「咕咕读得回来」，不是「这家有本地历史」——后者是厂商侧事实，归 #3889 的
 * 官方证据矩阵。往这里加一个 id，等于承诺同一趟把下面这几处一起接上，少一处就是「列得出、
 * 用不了」：
 *   ① `local/agent/transcriptSources/` 里加一份 spec，并登记进该目录的 `index.ts`
 *      （registry 的类型是 `Record<TranscriptSource, …>`，漏登记 tsc 直接红）
 *   ② `apps/desktop/src/session/shared/core/session-import/session-import.ts` 的
 *      `LOCAL_SESSION_ENGINE_PROVIDER`（引擎 → 会话页 provider id）与 `LOCAL_SESSION_ENGINE_LABEL`
 *   ③ `apps/desktop/src/session/shared/core/session-history/session-history.ts` 的
 *      `SESSION_HISTORY_SOURCES`（会话历史面板的来源筛选；它从 ② 的 LABEL 派生，不另抄）
 * ②③ 在另一棵依赖树里、按结构对接不跨包 import，所以 tsc 照不出漏项 ——
 * 由 `tests/unit/core/local/transcriptSources.test.ts` 的对账用例守着。
 */
export const TRANSCRIPT_SOURCE_IDS = ['claude-code', 'codex'] as const

export type TranscriptSource = (typeof TRANSCRIPT_SOURCE_IDS)[number]

export interface ImportedTranscriptTurn {
  role: 'user' | 'assistant'
  content: string
  /** Provider transcript 中的原始时间；没有或非法时为 null。 */
  createdAt: string | null
}

/**
 * 标准 history import 的完整结果。source 只决定本机 parser；创建时继承规划已退役，结果只供旧 durable recovery
 * 或 sessionpage 独立导入的物化边界。
 * turns 是供标准 chat.messages 物化的真实对话轮次——被导入的「记忆」就是它，工具输出/截图/思考
 * 在解析阶段已丢弃。原始 JSONL 不再作为字段带出：导入不上传原始文件（`chat-media` 桶有 10 MB
 * file_size_limit，导入会话的原始 JSONL——≈99% 是工具日志内嵌的 base64 截图——常远超，上传即被
 * Supabase Storage 以 “The object exceeded the maximum allowed size” 拒绝；且原件本就在本机磁盘，
 * 云端副本不可渲染/搜索又与本地重复）。fileName 仅作来源标注。
 */
export interface ImportedTranscript {
  source: TranscriptSource
  providerSessionId: string
  title: string
  cwd: string | null
  fileName: string
  turns: ImportedTranscriptTurn[]
}

export interface LocalTranscriptSession {
  source: TranscriptSource
  providerSessionId: string
  /** 人可读标题：Claude 的 custom-title / 首条用户消息摘句；Codex 的首条真实用户输入。 */
  title: string
  /** 会话运行时所处的文件夹（transcript 内记录的 cwd）；读不出时为 null。 */
  cwd: string | null
  filePath: string
  /** 文件 mtime（epoch ms）——列表按此倒序（最近更新在前）。 */
  updatedAt: number
  sizeBytes: number
}

/** Observed context metadata only. Instruction bodies, tool outputs and thinking never leave the parser. */
export interface TranscriptContext {
  source: TranscriptSource
  providerSessionId: string
  title: string
  cwd: string | null
  fileName: string
  loaded: Array<{
    path: string | null
    kind: 'instruction-file' | 'rendered-total' | 'base-instructions'
    scope: string | null
    chars: number
    truncated: boolean
    at: string | null
  }>
  nested: Array<{ path: string; at: string | null }>
  refs: string[]
}
