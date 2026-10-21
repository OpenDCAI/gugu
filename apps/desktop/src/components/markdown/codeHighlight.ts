// Code highlighting for Streamdown through the transcript's shiki highlighter: one highlighter and one theme
// pair for every markdown surface. Each token carries its light colour plus `--shiki-dark`, so a theme switch
// is pure CSS (markdown.css) and never re-highlights.
import type { CodeHighlighterPlugin } from 'streamdown'
import type { ChatHighlighter, HighlightResult } from '@gugu/session-chat-ui/highlight'

type StreamdownResult = NonNullable<ReturnType<CodeHighlighterPlugin['highlight']>>

let highlighter: ChatHighlighter | null = null
let loading: Promise<ChatHighlighter> | null = null

// The shiki core and grammars stay out of the first chunk until a code block actually renders.
function loadHighlighter(): Promise<ChatHighlighter> {
  loading ??= import('@gugu/session-chat-ui/highlight').then((mod) => {
    highlighter = mod.createDefaultHighlighter()
    return highlighter
  })
  return loading
}

function toStreamdown(result: HighlightResult): StreamdownResult {
  return {
    rootStyle: false,
    tokens: result.lines.map((line) =>
      line.map((token) => ({
        content: token.content,
        color: token.htmlStyle?.['--shiki-light'],
        htmlStyle: token.htmlStyle?.['--shiki-dark'] ? { '--shiki-dark': token.htmlStyle['--shiki-dark'] } : undefined,
      }))
    ),
  }
}

const MAX_CACHED = 200
const cache = new Map<string, StreamdownResult>()
const waiting = new Map<string, ((result: StreamdownResult) => void)[]>()
const queue: (() => void)[] = []
let draining = false

type Deadline = { timeRemaining(): number }
const idle = (fn: (deadline?: Deadline) => void): void => {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout: 1000 })
  else setTimeout(fn, 0)
}

// Tokenizing runs in idle time, a few blocks per slice: opening a chat full of code must not highlight every
// block inside the render that mounts it.
function drain(deadline?: Deadline): void {
  do {
    queue.shift()?.()
  } while (queue.length > 0 && (deadline?.timeRemaining() ?? 0) > 4)
  if (queue.length > 0) idle(drain)
  else draining = false
}

function highlightInIdle(key: string, code: string, language: string, callback: (result: StreamdownResult) => void): void {
  const listeners = waiting.get(key)
  if (listeners) {
    listeners.push(callback)
    return
  }
  const all = [callback]
  waiting.set(key, all)
  void loadHighlighter()
    .then((hl) => hl.load?.(language))
    .then(() => {
      queue.push(() => {
        waiting.delete(key)
        const result = highlighter?.highlight(code, language)
        if (!result) return
        const converted = toStreamdown(result)
        if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value!)
        cache.set(key, converted)
        for (const listener of all) listener(converted)
      })
      if (!draining) {
        draining = true
        idle(drain)
      }
    })
}

/** A block highlighted before renders synchronously; any other renders plain and is coloured once tokenized. */
export const markdownCodeHighlighter: CodeHighlighterPlugin = {
  name: 'shiki',
  type: 'code-highlighter',
  getSupportedLanguages: () => [],
  getThemes: () => ['github-light', 'github-dark'],
  supportsLanguage: () => true,
  highlight({ code, language }, callback) {
    const key = `${language}\u0000${code}`
    const cached = cache.get(key)
    if (cached) return cached
    if (callback) highlightInIdle(key, code, language, callback)
    return null
  },
}
