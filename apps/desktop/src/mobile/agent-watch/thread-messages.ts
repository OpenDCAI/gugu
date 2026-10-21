import type { ThreadMessageLike } from '@assistant-ui/react'
import { catalogCall, toolDisplayName, type ToolImage, type ToolNode, type TranscriptItem, type TranscriptTurn } from '@gugu/session-core/acp/client'
import { pendingTurnHeader, planTurnFoldRuns, turnFoldView, type TurnProcessHeader } from '@gugu/session-chat-ui/turn-fold'
import { splitAttachmentMentions } from '@gugu/session-chat-ui/markdown-attachment-mentions'
import { collectOpenedOutputs, outputsOfRun } from '@gugu/session-chat-ui/opened-outputs'

/**
 * 时间线（`TranscriptTurn[]`）→ assistant-ui 的消息模型（`ThreadMessageLike[]`）。
 *
 * 纯函数、单独一份：转换的失败模式是「少一条 / 顺序乱 / 角色错」，这三样只有在能被反复喂
 * 同一份输入的地方才验得动。写在组件里的话，判据只能是「我盯着屏幕看了一眼」。
 *
 * 映射：
 *   用户消息   → 一条 user 消息（一条 item 一条，❌ 不合并：合并后时间顺序就没法表达了）
 *   agent 文本 → assistant 消息里的 text part
 *   思考       → `thinking` data part,整条原样(桌面那一行要状态、正文、起止,见 thinking-part)
 *   工具调用   → tool-call part，`toolCallId` 用**我们自己的 item id**
 *   问用户的那次调用(有结算的)→ `question` data part,画成那张提问 / 审批卡(TimelineView 的 QuestionDataUI),
 *                就在它发生的位置;❌ 再画一行通用工具行,也 ❌ 收进「N 次工具调用」那一组
 *   一轮的过程 → 单独一条 assistant 消息,metadata 带桌面折叠头那组事实(见 turn-process-message);
 *                哪些条目折进去、头写什么,和桌面同一份判断(`@gugu/session-chat-ui/turn-fold`)
 *   在跑、还没东西 → 同一条过程消息先空着出来,头已经在数秒(`pendingTurnHeader`)
 *   打开给人看的文件 / 网页(成功的 `session_open_in_tab`)→ 那一步照常在过程里,一轮最后另挂 `opened-outputs` data part,
 *                画成桌面同一张附件卡(#7193);哪些算、挂哪一轮、同一份只挂一张,与桌面同一份判断(`opened-outputs`)
 *
 * ⚠️ 工具卡的 `toolCallId` 是 item id(`${turnId}:tool:${toolCallId}`,一条线里唯一),❌ provider 的 toolCallId。
 * 结算按 **provider 的 toolCallId** 记(session-record timeline 的 trackSettlement,桌面也按它配)——
 * 所以找卡认的是 `node.toolCallId`。从前拿 item id 去找,永远找不到,卡只能钉在末尾(10-12 真机)。
 */

export const THINKING_DATA_PART = 'thinking'
/** 问用户的那次工具调用,data 是那个工具节点(卡按 `node.toolCallId` 找结算)。 */
export const QUESTION_DATA_PART = 'question'
/** 一轮交出来的文件 / 网页(#7193),data 见 `OpenedOutputsData`。 */
export const OUTPUTS_DATA_PART = 'opened-outputs'

/** 一轮挂的附件卡:记下它们的那几条调用,手机拿它们去画桌面同一张卡(opened-outputs-part)。 */
export type OpenedOutputsData = { turnId: string; items: TranscriptItem[] }

/**
 * 一张工具交回来的图在手机上的样子:时间线里只有它的字数(`imageRefs`),图本身按 (条目, 第几张) 去机器上取,
 * 取到的写回条目的 `images`(use-timeline-session `loadToolImage`)。这里只带 refs:图本身图格从时间线拿
 * (`toolImagesById`,AgentThread 的 context),❌ 从这一份拿 —— 这一份是 assistant-ui 的,它在 effect 里才换上新消息,
 * 比时间线晚一两次提交;图格读它就会对着一张早已取到的图再要一遍(2026-10-16 mac1 实测 64 张问了 74 次)。
 */
export type ToolImageTile = { itemId: string; index: number; chars: number; alt: string }

/** 工具卡的 `artifact`(assistant-ui 留给界面、不进模型的那一格):这次调用交回来的图,卡下画成一组缩略图(AgentThread)。 */
export type ToolPartArtifact = { images: ToolImageTile[] }

/** 过程那条 assistant 消息挂的元数据。 */
export type TurnProcessMetadata = { turnProcess: TurnProcessHeader }

/** 每条 assistant 消息写明的状态(见 toThreadMessages 的 flushAssistant)。 */
const SETTLED: NonNullable<ThreadMessageLike['status']> = { type: 'complete', reason: 'unknown' }
/** 一张工具卡在跑时交给它的状态(AgentThread 的 ToolWithSettlement,按 runningToolIds)。 */
export const TOOL_RUNNING = { type: 'running' } as const

/**
 * 一句用户消息。指着附件的 mention 画成气泡上的附件,❌ 把那台机器上的一长串路径摆进气泡;
 * 哪些 mention 算附件,与桌面消息卡同一份判据(`splitAttachmentMentions`)。
 * id 就是记录里那一行的 id —— 附件挂在同一条消息上,翻页钉位认的 id 不变。
 */
export function userMessage(id: string, text: string): ThreadMessageLike {
  const { text: body, attachments } = splitAttachmentMentions(text)
  return {
    role: 'user',
    id,
    content: body ? [{ type: 'text', text: body }] : [],
    ...(attachments.length > 0
      ? {
          attachments: attachments.map(({ name }, index) => ({
            id: `${id}:attachment:${index}`,
            type: 'file',
            name,
            status: { type: 'complete' as const },
            content: [],
          })),
        }
      : {}),
  }
}

function flattenTools(node: ToolNode, out: TranscriptItem[]): void {
  out.push(node)
  for (const child of node.children ?? []) flattenTools(child as ToolNode, out)
}

/**
 * content 是「字符串 或 只读 part 数组」的联合。直接 `['content'][number]` 会把 string 那一支
 * 也带进来,所以先 Extract 出数组那一支,再取元素类型。
 */
type ContentPart = Extract<ThreadMessageLike['content'], readonly unknown[]>[number]

/**
 * 折叠那一行里跟在工具名后面的**一句入参预览**（orca 的 `▸ 工具名 <预览>`）。
 *
 * 取值顺序:
 *   ① provider 自己给的 `inputSummary` —— 它最懂自己那条调用该怎么概括;
 *   ② 没有就从 `rawInput` 里挑一个字段。⚠️ 实测 Claude 的 Bash/Read 这些**都不带**
 *      inputSummary(decode.ts 只在 update 带 inputSummary/input_summary/description 时才填),
 *      只靠 ① 的话这一行永远只有工具名 —— 一屏五张卡长得一模一样,看不出各自动了什么。
 *
 * ❌ 不编内容:显示的是真参数里的一个字段原文,只做去空白与截断。挑不出可读字段就不显示,
 * 让这一行退回「只有名字」,而不是硬凑一段看着像读数的东西。
 */
const PREVIEW_FIELDS = [
  'command',
  'file_path',
  'filePath',
  'path',
  'pattern',
  'query',
  'url',
  'description',
  'prompt',
]
const PREVIEW_MAX = 48

function previewFromRawInput(rawInput: string | undefined): string | null {
  if (!rawInput) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(rawInput)
  } catch {
    // 不是 JSON 就当整串是参数本身(有的 provider 直接给一行命令)。
    return clampPreview(rawInput)
  }
  if (typeof parsed === 'string') return clampPreview(parsed)
  if (!parsed || typeof parsed !== 'object') return null
  const bag = parsed as Record<string, unknown>
  for (const key of PREVIEW_FIELDS) {
    const value = bag[key]
    if (typeof value === 'string' && value.trim()) return clampPreview(value)
  }
  // 首选字段都没有,就挑第一个非空字符串字段 —— 好过什么都不给。
  for (const value of Object.values(bag)) {
    if (typeof value === 'string' && value.trim()) return clampPreview(value)
  }
  return null
}

function clampPreview(text: string): string | null {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (!flat) return null
  return flat.length > PREVIEW_MAX ? `${flat.slice(0, PREVIEW_MAX - 1)}…` : flat
}

export function toolInputPreview(node: ToolNode): string | null {
  if (node.kind === 'tool-group') return null
  if (node.inputSummary?.trim()) return clampPreview(node.inputSummary)
  // catalog_call 的名字已经是它代跑的那个工具(toolDisplayName):预览看那次调用自己的 args,❌ 再写一遍工具名。
  const inner = node.kind === 'mcp-tool-call' ? catalogCall(node.tool, node.rawInput) : null
  return previewFromRawInput(inner ? JSON.stringify(inner.args ?? {}) : node.rawInput)
}

/**
 * 「这条输出在路上被裁过」那一句。文案由调用方给（这一层是纯函数，拿不到 i18n）。
 * ⚠️ 必须画出来：一次看不出来的截断等于给了一个错的读数 —— 人会以为输出到此为止。
 */
/**
 * 远端还没结算的那一轮 = 最后一轮且没有 outcome,在跑、等审批 / 提问都算 —— 同桌面的活动层(#7305:
 * 等审批时它也不挂附件卡)。❌ 拿 `attention === 'running'` 判:等审批时那是 'waiting',这一轮就被当成跑完了。
 */
export function unsettledLastTurnId(turns: readonly TranscriptTurn[]): string | null {
  const last = turns.at(-1)
  return last && !last.outcome ? last.id : null
}

export type ThreadMessageOptions = {
  trimmedNote?: (chars: number) => string
  /** 远端正在跑的那一轮(最后一轮还没结算)。它的最后一段过程是活的:头在数秒、默认摊开,同桌面。 */
  liveTurnId?: string | null
  /** 这条会话的结算(按 provider toolCallId)。有结算的工具调用画成卡(`QUESTION_DATA_PART`)。 */
  settlements?: Readonly<Record<string, unknown>>
}

function withTrimNote(text: string, chars: number, options?: ThreadMessageOptions): string {
  const note = options?.trimmedNote?.(chars)
  return note ? `${text}\n\n${note}` : text
}

function toolPart(node: ToolNode, options?: ThreadMessageOptions): ContentPart {
  const rawOutput = node.kind === 'tool-group' ? null : (node.outputText ?? node.rawOutput ?? null)
  // 传输层裁过多少字（transport-trim；桌面侧恒缺这一格）。
  const trimmed = node.kind === 'tool-group' ? 0 : (node.trimmedChars ?? 0)
  const output = rawOutput !== null && trimmed > 0 ? withTrimNote(rawOutput, trimmed, options) : rawOutput
  const summary = toolInputPreview(node)
  const name = toolDisplayName(node)
  // 交回来的图:传输层只发了每张的类型和字数(不算进 trimmedChars —— 图没丢,取得到),卡下按张去取;取到的在 images 里。
  const refs = node.kind === 'tool-group' ? [] : (node.imageRefs ?? [])
  return {
    type: 'tool-call',
    toolCallId: node.id,
    toolName: name,
    /*
     * 两个入参字段各有各的用处,❌ 不是二选一:
     *   · `argsText` = 「模型交给工具的参数，序列化后供显示」——这正是 `rawInput` 的定义
     *     (tool-calls.ts:127「as ACP reports them in rawInput, serialized for display」),
     *     所以填它不是冒充,是同一件东西。展开卡片时看到的是真参数。
     *     ⚠️ 曾经写死成 `''`,而官方卡片开头就是 `if (!argsText) return null` ——
     *     于是「展开」什么都没有,五张卡长得一模一样。
     *   · `args.summary` = 折叠那一行的入参预览(orca 同款 `▸ 工具名 <预览>`),
     *     取自 provider 的 inputSummary,没有就从 rawInput 里挑一个字段 —— 见 toolInputPreview。
     */
    args: summary ? { summary } : {},
    argsText:
      node.kind === 'tool-group'
        ? ''
        : // 没有输出、却被裁过 ⇒ 裁的是入参那一格，那句话就落在入参上。
          trimmed > 0 && rawOutput === null
          ? withTrimNote(node.rawInput ?? '', trimmed, options)
          : (node.rawInput ?? ''),
    ...(output !== null ? { result: output } : {}),
    ...(node.status === 'error' ? { isError: true } : {}),
    ...(refs.length > 0
      ? {
          artifact: {
            images: refs.map((ref, index) => ({ itemId: node.id, index, chars: ref.chars, alt: `${name} ${index + 1}/${refs.length}` })),
          } satisfies ToolPartArtifact,
        }
      : {}),
  }
}

export function toThreadMessages(
  turns: readonly TranscriptTurn[],
  options?: ThreadMessageOptions,
): ThreadMessageLike[] {
  const messages: ThreadMessageLike[] = []
  // 桌面把正在跑的那一轮单独当一层折(活动层),已结算的轮是另一层 —— 两层之间不合并。
  const liveIndex = turns.findIndex((turn) => turn.id === options?.liveTurnId)
  const tiers = liveIndex < 0
    ? [{ turns, live: false }]
    : [{ turns: turns.slice(0, liveIndex), live: false }, { turns: turns.slice(liveIndex), live: true }]

  for (const tier of tiers) {
    // 打开给人看的东西记下来,挂在一轮最后;轮本身照常折(与桌面 flattenTier 同一步)。
    // 还在跑的那一轮一张不挂(#7305,与桌面同一条判据,见 collectOpenedOutputs)。
    const opened = collectOpenedOutputs(tier.turns, { live: tier.live })
    const { folds, runs, absorbed } = planTurnFoldRuns(tier.turns, undefined, true)
    tier.turns.forEach((turn, index) => {
      // 被前一轮的折叠吸收了:它的条目已经排进那一轮的过程与收尾里。
      if (absorbed[index]) return
      const assistantParts: ContentPart[] = []
      // id 只取轮内位置:往前补进更早的轮时,已画出的每条消息必须还是同一个 id(外部 store 只加不删)。
      const turnStart = messages.length

      const flushAssistant = (metadata?: TurnProcessMetadata): void => {
        if (assistantParts.length === 0) return
        messages.push({
          role: 'assistant',
          id: `${turn.id}:assistant:${messages.length - turnStart}`,
          content: [...assistantParts],
          /*
           * 状态写明,❌ 交给官方去推。没出结果的工具卡,官方拿的是**消息**的状态(@assistant-ui/core
           * toMessagePartStatus),而这条线程的 isRunning 只算「这台手机正在发」(AgentThread)⇒ 推出来是
           * requires-action / tool-calls:卡片自己摊开、图标是感叹号,还画出「允许 / 拒绝」。那是给「客户端自己交
           * 工具结果」的,不连任何审批(设计同事 10-05 真机:一条跑着的 Bash 被当成在等批准);真审批是 SettlementCard。
           * ❌ 写成 running 去换转圈:一条消息里跑完的和在跑的混在一起,没输出的那张也会跟着转 —— 运行态按卡给(runningToolIds)。
           */
          status: SETTLED,
          ...(metadata ? { metadata: { custom: metadata } } : {}),
        })
        assistantParts.length = 0
      }

      const emit = (items: readonly TranscriptItem[]): void => {
        for (const item of items) {
          if (item.kind === 'message' && item.role === 'user') {
            // 用户这一句要排在它之后的 agent 内容之前 —— 先把攒着的 agent 部分收口。
            flushAssistant()
            messages.push(userMessage(item.id, item.text))
            continue
          }
          if (item.kind === 'message') {
            if (item.text) assistantParts.push({ type: 'text', text: item.text })
            continue
          }
          if (item.kind === THINKING_DATA_PART) {
            assistantParts.push({ type: 'data', name: THINKING_DATA_PART, data: item })
            continue
          }
          const flat: TranscriptItem[] = []
          flattenTools(item as ToolNode, flat)
          for (const node of flat) {
            const tool = node as ToolNode
            assistantParts.push(
              'toolCallId' in tool && options?.settlements?.[tool.toolCallId]
                ? { type: 'data', name: QUESTION_DATA_PART, data: tool }
                : toolPart(tool, options),
            )
          }
        }
      }

      const fold = folds[index]
      if (!fold) {
        emit(turn.items)
        // 一轮开始了、还什么都没有:先画这一轮的时间头(同桌面,判断在 turn-fold),❌ 让消息下面空着等首字。
        // 没有内容的一条过程消息,id 与思考 / 工具到了之后那一条相同 —— 它们落进同一个头,头不换。
        const pending = pendingTurnHeader(turn, tier.live)
        if (pending) {
          messages.push({
            role: 'assistant',
            id: `${turn.id}:assistant:${messages.length - turnStart}`,
            content: [],
            status: SETTLED,
            metadata: { custom: { turnProcess: pending } satisfies TurnProcessMetadata },
          })
        }
      } else {
        const view = turnFoldView(turn, fold, runs.get(index), tier.live)
        emit(view.leading as readonly TranscriptItem[])
        for (const segment of view.segments) {
          if (segment.header) {
            // 这一段过程单独成一条消息,折叠头挂在它上面;画不出东西就没有这条,也就没有头。
            flushAssistant()
            emit(segment.process as readonly TranscriptItem[])
            flushAssistant({ turnProcess: segment.header })
          } else {
            emit(segment.process as readonly TranscriptItem[])
          }
          emit(segment.tail as readonly TranscriptItem[])
        }
      }
      // 这一轮交出来的东西挂在最后那条回复下面(同一条消息里,在它的正文之后)。
      const outputs = outputsOfRun(opened, index, absorbed)
      if (outputs.length > 0) {
        assistantParts.push({
          type: 'data',
          name: OUTPUTS_DATA_PART,
          data: { turnId: turn.id, items: outputs.map(({ item }) => item as TranscriptItem) } satisfies OpenedOutputsData,
        })
      }
      flushAssistant()
    })
  }

  return messages
}

/**
 * 时间线里每个交回了图的工具条目(带 `imageRefs` 的,工具组里的子调用也算)手里有哪几张(取到写回的 `images`,还没取到
 * 的是空的),按 item id。图格读这一份,同 RunningTools:和时间线同一次提交,❌ 晚一拍(见 `ToolImageTile`)。
 * 不在这里的条目已经离开了时间线:它的卡还会在屏上多留一两次提交(assistant-ui 那一份),图格 ❌ 替它要图。
 */
/**
 * 时间线里每一次工具调用,按条目 id(= 工具卡 part 的 `toolCallId`)。手机把连着的思考 + 工具调用收成一组时,
 * 头上那句「思考了 2 次、跑了 3 条命令」按它们原本是哪一类来数(与桌面 `tool-run` 同一份判断)。
 * 展开的方式与 toThreadMessages 相同(`flattenTools`),所以每张卡都找得到自己的条目。
 */
export function toolItemsById(turns: readonly TranscriptTurn[]): ReadonlyMap<string, TranscriptItem> {
  const byId = new Map<string, TranscriptItem>()
  for (const turn of turns) {
    for (const item of turn.items) {
      if (item.kind === 'message' || item.kind === THINKING_DATA_PART) continue
      const flat: TranscriptItem[] = []
      flattenTools(item as ToolNode, flat)
      for (const node of flat) byId.set(node.id, node)
    }
  }
  return byId
}

export function toolImagesById(turns: readonly TranscriptTurn[]): ReadonlyMap<string, readonly (ToolImage | null | undefined)[]> {
  const byId = new Map<string, readonly (ToolImage | null | undefined)[]>()
  for (const turn of turns) {
    for (const item of turn.items) {
      if (item.kind === 'message' || item.kind === THINKING_DATA_PART) continue
      const flat: TranscriptItem[] = []
      flattenTools(item as ToolNode, flat)
      for (const node of flat as ToolNode[]) {
        if (node.kind !== 'tool-group' && (node.imageRefs?.length || node.images?.length)) byId.set(node.id, node.images ?? [])
      }
    }
  }
  return byId
}

/**
 * 时间线里还在跑的工具(item id,即卡片的 toolCallId)。运行态是**数据里就有的**(ToolStatus),按卡交给
 * 工具卡:官方只读消息的状态,一条消息里跑完的和在跑的分不开(见 flushAssistant)。
 * ❌ 不拿「有没有输出」去猜:输出为空的工具是存在的,猜出来的会一直转下去。
 */
export function runningToolIds(turns: readonly TranscriptTurn[]): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const turn of turns) {
    for (const item of turn.items) {
      if (item.kind === 'message' || item.kind === THINKING_DATA_PART) continue
      const flat: TranscriptItem[] = []
      flattenTools(item as ToolNode, flat)
      for (const node of flat) if ((node as ToolNode).status === 'running') ids.add(node.id)
    }
  }
  return ids
}
