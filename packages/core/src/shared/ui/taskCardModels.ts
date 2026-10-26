/**
 * The cards a person's composer drops into a chat (gugu-dev#181「派任务」): a `content_type='card'` message whose
 * content is one of these JSON shapes. The card is the person's own message — it names no recipient and wakes nobody
 * (the cloud delivery trigger skips cards); the agent it hands the words to gets them from the host as its first turn.
 *
 * Who took the task — the agent's name, its type and its look — is a snapshot taken when the card is posted. Everyone
 * who sees the card draws it from these, never from what they can look up about that agent: archiving the session
 * removes the agent from the group, and a colleague may not see an agent that is still waiting to be let in, yet the
 * card still has to say who took the task.
 */
export interface TaskCard {
  v: 1
  type: 'task'
  /** The person's words, verbatim. */
  text: string
  agentUserId: string
  agentName: string
  /** The agent's type (`claude-code`, `codex`, …): its engine mark. Cards posted before it was kept have none. */
  agentType?: string
  /** The agent's avatar (an image, or its look); none = drawn from its id. */
  agentAvatar?: string | null
  sessionId: string
  /** The session's project on that machine (a local id: it opens the session there, nowhere else). */
  projectId: string
  /** The machine the session runs on; another owned machine resolves it through the task directory. */
  deviceId: string
  machineLabel: string
}

/** 「已安排」: a scheduled task, set up once; its runs do not post a card each. */
export interface ScheduleCard {
  v: 1
  type: 'schedule'
  text: string
  automationId: string
  /** What the person picked, as shown to them (「每天 9:00」). */
  scheduleLabel: string
  deviceId: string
  machineLabel: string
}

/**
 * 「需要你」(gugu-dev#181 ⑨): a question an agent asks its owner, posted by the agent into the group the turn came from,
 * quoting the message it answers. Whether it is still waiting, and what was answered, is read from the session's
 * settlement — never from this message, which nobody edits after it is sent.
 */
export interface QuestionCard {
  v: 1
  type: 'question'
  /** The question, verbatim. */
  text: string
  /** The choices, when one pick answers it (one question, single choice); otherwise empty and it is answered in the session. */
  options: string[]
  /** The person asked (the agent's owner): only their reply answers it. */
  ownerUserId: string
  /** The settlement's item id in that session. */
  questionId: string
  sessionId: string
  /** The session's project on that machine (it opens the session there). */
  projectId: string
  deviceId: string
  machineLabel: string
}

export type ComposerCard = TaskCard | ScheduleCard | QuestionCard

const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0

/** The card in a `content_type='card'` message, or null when it is a card of some other shape. */
export function parseComposerCard(content: string | null | undefined): ComposerCard | null {
  if (!content) return null
  let raw: unknown
  try { raw = JSON.parse(content) } catch { return null }
  if (!raw || typeof raw !== 'object') return null
  const card = raw as Record<string, unknown>
  if (card.v !== 1 || !isText(card.text) || !isText(card.deviceId) || typeof card.machineLabel !== 'string') return null
  if (card.type === 'task' && isText(card.agentUserId) && isText(card.agentName) && isText(card.sessionId) && isText(card.projectId)) {
    return card as unknown as TaskCard
  }
  if (card.type === 'schedule' && isText(card.automationId) && isText(card.scheduleLabel)) {
    return card as unknown as ScheduleCard
  }
  if (card.type === 'question' && Array.isArray(card.options) && card.options.every(isText) && isText(card.ownerUserId)
    && isText(card.questionId) && isText(card.sessionId) && isText(card.projectId)) {
    return card as unknown as QuestionCard
  }
  return null
}

/**
 * `v`, `type` and `text` always lead: the cloud cuts a message to its first 100 characters for list previews and
 * notifications, and that cut of a card still reads as the person's words (`composerCardPreview`).
 */
export function serializeComposerCard(card: ComposerCard): string {
  const { v, type, text, ...rest } = card
  return JSON.stringify({ v, type, text, ...rest })
}

// Whole escapes only: a cut that lands inside one (`\`, `\u12`) ends the words just before it.
const PREVIEW_HEAD = /^\{"v":1,"type":"(task|schedule|question)","text":"((?:[^"\\]|\\u[0-9a-fA-F]{4}|\\[^u])*)/

/** A card's words from a cut-down preview of it (see `serializeComposerCard`), or null when it is not one. */
export function composerCardPreview(preview: string | null | undefined): { type: ComposerCard['type']; text: string } | null {
  const head = preview ? PREVIEW_HEAD.exec(preview) : null
  if (!head) return null
  let text: string
  try { text = JSON.parse(`"${head[2]}"`) as string } catch { return null }
  return { type: head[1] as ComposerCard['type'], text }
}
