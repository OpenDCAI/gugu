const MATH_DELIMITERS = [
  { open: '\\[', close: '\\]' },
  { open: '\\(', close: '\\)' },
]

function backslashIsEscaped(markdown, index) {
  let precedingBackslashes = 0
  for (let cursor = index - 1; cursor >= 0 && markdown[cursor] === '\\'; cursor -= 1) {
    precedingBackslashes += 1
  }
  return precedingBackslashes % 2 === 1
}

function findUnescaped(markdown, delimiter, from) {
  let index = markdown.indexOf(delimiter, from)
  while (index >= 0) {
    if (!backslashIsEscaped(markdown, index)) return index
    index = markdown.indexOf(delimiter, index + delimiter.length)
  }
  return -1
}

function findExactDollarRun(markdown, runLength, from) {
  let index = markdown.indexOf('$', from)
  while (index >= 0) {
    const candidateLength = countRun(markdown, index, '$')
    if (candidateLength === runLength) return index
    index = markdown.indexOf('$', index + candidateLength)
  }
  return -1
}

function countRun(markdown, index, character) {
  let length = 0
  while (markdown[index + length] === character) length += 1
  return length
}

function advanceMarkdownColumn(column, character) {
  if (character === '\t') return column + (4 - (column % 4))
  return column + 1
}

function markdownColumnAfter(value, initialColumn = 0) {
  let column = initialColumn
  for (const character of value) column = advanceMarkdownColumn(column, character)
  return column
}

function markerRunStartsAt(markdown, index, character) {
  if (markdown[index] !== character || backslashIsEscaped(markdown, index)) return false
  return markdown[index - 1] !== character || backslashIsEscaped(markdown, index - 1)
}

// A fence can only start after a line's indentation/list/quote container prefix.
// Checking that cheap shape before walking inherited containers keeps inline backticks
// in prose from triggering the quadratic container search below.
function couldStartFence(markdown, index) {
  const lineStart = markdown.lastIndexOf('\n', index - 1) + 1
  const prefix = markdown.slice(lineStart, index)
  if (prefix.length === 0 || /^[ \t]*$/.test(prefix)) return true
  return /^[ \t]*(?:(?:>[ \t]?)+|(?:[-+*]|\d{1,9}[.)])[ \t]+)+[ \t]*$/.test(prefix)
}

function lineBefore(markdown, lineStart) {
  if (lineStart === 0) return ''
  const previousEnd = markdown[lineStart - 1] === '\n' ? lineStart - 1 : lineStart
  const previousStart = markdown.lastIndexOf('\n', previousEnd - 1) + 1
  return markdown.slice(previousStart, previousEnd).replace(/\r$/, '')
}

function quoteContentAt(line, quoteDepth) {
  let offset = 0
  while (offset < line.length && offset < 3 && line[offset] === ' ') offset += 1
  for (let depth = 0; depth < quoteDepth; depth += 1) {
    if (line[offset] !== '>') return null
    offset += 1
    if (line[offset] === ' ' || line[offset] === '\t') offset += 1
  }
  return line.slice(offset)
}

function paragraphContinuesBefore(markdown, lineStart, quoteDepth) {
  const previousContent = quoteContentAt(lineBefore(markdown, lineStart), quoteDepth)
  if (previousContent === null || previousContent.trim().length === 0) return false
  return !/^(?: {0,3}(?:#{1,6}(?:[ \t]+|$)|`{3,}|~{3,}|\$\$|[-*_](?:[ \t]*[-*_]){2,}[ \t]*$)| {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+)/.test(previousContent)
}

function parseContainerPrefix(markdown, lineStart, prefixEnd, options = {}, allowTrailingContent = false) {
  const prefix = markdown.slice(lineStart, prefixEnd).replace(/\r$/, '')
  let offset = 0

  let column = 0
  while (offset < prefix.length && (prefix[offset] === ' ' || prefix[offset] === '\t')) {
    const nextColumn = advanceMarkdownColumn(column, prefix[offset])
    if (nextColumn > 3) break
    column = nextColumn
    offset += 1
  }
  const steps = []
  let leadingQuoteDepth = 0
  let sawList = false

  while (offset < prefix.length) {
    if (prefix[offset] === '>') {
      steps.push({ kind: 'quote' })
      if (!sawList) leadingQuoteDepth += 1
      offset += 1
      column += 1
      if (prefix[offset] === ' ' || prefix[offset] === '\t') {
        column = advanceMarkdownColumn(column, prefix[offset])
        offset += 1
      }
      continue
    }

    const listMatch = prefix.slice(offset).match(/^([-+*]|(\d{1,9})[.)])(?:([ \t]{1,4})|$)/)
    if (!listMatch) break
    const orderedStart = listMatch[2] === undefined ? null : Number(listMatch[2])
    if (
      !options.ignoreParagraphInterruption
      && !sawList
      && orderedStart !== null
      && orderedStart !== 1
      && paragraphContinuesBefore(markdown, lineStart, leadingQuoteDepth)
    ) {
      return null
    }
    const markerStartColumn = steps.length === 0 ? 0 : column
    column += listMatch[1].length
    column = listMatch[3]
      ? markdownColumnAfter(listMatch[3], column)
      : column + 1
    const markerIndent = column - markerStartColumn
    steps.push({ kind: 'list', indent: markerIndent })
    sawList = true
    offset += listMatch[0].length
  }

  if (!allowTrailingContent && offset !== prefix.length) return null
  if (steps.length === 0 && (allowTrailingContent || offset !== prefix.length)) return null
  return { steps, consumed: offset }
}

function lineEndAfter(markdown, lineStart) {
  const lineBreak = markdown.indexOf('\n', lineStart)
  return lineBreak < 0 ? markdown.length : lineBreak
}

// Where the line before the one starting at `lineStart` (> 0) starts. ❌ `lastIndexOf('\n', lineStart - 2)` alone: at
// lineStart 1 that is `lastIndexOf('\n', -1)`, which clamps to 0, finds the very `\n` that ends that line, and answers
// 1 again — text starting with a line break looped forever here (message_send validation hung on it).
function previousLineStart(markdown, lineStart) {
  return lineStart <= 1 ? 0 : markdown.lastIndexOf('\n', lineStart - 2) + 1
}

function inheritedMarkdownContainerAt(markdown, index, options, memo) {
  const currentLineStart = markdown.lastIndexOf('\n', index - 1) + 1
  let candidateLineStart = currentLineStart === 0
    ? -1
    : previousLineStart(markdown, currentLineStart)
  let deepest = null

  while (candidateLineStart >= 0 && candidateLineStart < currentLineStart) {
    const candidateLineEnd = lineEndAfter(markdown, candidateLineStart)
    const parsedCandidate = parseContainerPrefix(
      markdown,
      candidateLineStart,
      candidateLineEnd,
      options,
      true,
    )
    const candidate = parsedCandidate?.steps.length
      ? markdownContainerAt(markdown, candidateLineStart + parsedCandidate.consumed, options, memo)
      : null
    if (candidate?.steps.length && (!deepest || candidate.steps.length > deepest.steps.length)) {
      let lineStart = candidateLineEnd < markdown.length ? candidateLineEnd + 1 : markdown.length
      let ownsRange = true
      while (lineStart < currentLineStart) {
        const lineEnd = lineEndAfter(markdown, lineStart)
        const line = markdown.slice(lineStart, lineEnd).replace(/\r$/, '')
        if (containerContentOffset(line, candidate) < 0) {
          ownsRange = false
          break
        }
        lineStart = lineEnd < markdown.length ? lineEnd + 1 : markdown.length
      }
      const currentLineEnd = lineEndAfter(markdown, currentLineStart)
      const currentLine = markdown.slice(currentLineStart, currentLineEnd).replace(/\r$/, '')
      const contentOffset = containerContentOffset(currentLine, candidate)
      if (ownsRange && contentOffset >= 0 && index - currentLineStart >= contentOffset) {
        deepest = candidate
      }
    }

    if (candidateLineStart === 0) break
    candidateLineStart = previousLineStart(markdown, candidateLineStart)
  }
  return deepest
}

// @@@4254 memoized container resolution — markdownContainerAt/inheritedMarkdownContainerAt recurse into
// every earlier container-prefixed line, and each of those recursions re-walks all of ITS earlier lines.
// Without memoization that is O(2^lines): ~30 list lines before a fence already run for days, which froze
// the renderer thread (whole-app hang, all IPC timed out). Every helper here is a pure function of
// (markdown, index, options), so caching per (index, options) within one tokenize run collapses the
// recursion to each position computed once while preserving the grammar byte-for-byte.
function markdownContainerAt(markdown, index, options = {}, memo = undefined) {
  const memoKey = memo ? `${options.ignoreParagraphInterruption ? 'i' : 'd'}:${index}` : ''
  if (memo?.has(memoKey)) return memo.get(memoKey)
  const result = computeMarkdownContainerAt(markdown, index, options, memo)
  memo?.set(memoKey, result)
  return result
}

function computeMarkdownContainerAt(markdown, index, options, memo) {
  const lineStart = markdown.lastIndexOf('\n', index - 1) + 1
  const direct = parseContainerPrefix(markdown, lineStart, index, options)
  const inherited = inheritedMarkdownContainerAt(markdown, index, options, memo)
  if (inherited) {
    const lineEnd = lineEndAfter(markdown, lineStart)
    const line = markdown.slice(lineStart, lineEnd).replace(/\r$/, '')
    const inheritedOffset = containerContentOffset(line, inherited)
    if (inheritedOffset >= 0 && lineStart + inheritedOffset <= index) {
      const continuation = parseContainerPrefix(
        markdown,
        lineStart + inheritedOffset,
        index,
        options,
      )
      if (continuation) {
        return { steps: [...inherited.steps, ...continuation.steps] }
      }
      const extraIndent = markdown.slice(lineStart + inheritedOffset, index)
      if (markdownColumnAfter(extraIndent) <= 3 && /^[ \t]*$/.test(extraIndent)) return inherited
    }
  }
  return direct
}

function containerContentOffset(line, container) {
  if (line.replace(/\r$/, '').trim().length === 0) {
    return container.steps.some((step) => step.kind === 'quote') ? -1 : 0
  }
  let offset = 0
  let column = 0

  for (let stepIndex = 0; stepIndex < container.steps.length; stepIndex += 1) {
    const step = container.steps[stepIndex]
    if (line.slice(offset).trim().length === 0) {
      return container.steps.slice(stepIndex).some((remaining) => remaining.kind === 'quote') ? -1 : offset
    }
    if (step.kind === 'quote') {
      let leadingSpaces = 0
      while (leadingSpaces < 3 && line[offset] === ' ') {
        offset += 1
        leadingSpaces += 1
        column += 1
      }
      if (line[offset] !== '>') return -1
      offset += 1
      column += 1
      if (line[offset] === ' ' || line[offset] === '\t') {
        column = advanceMarkdownColumn(column, line[offset])
        offset += 1
      }
      continue
    }

    const indentationStart = column
    while (column - indentationStart < step.indent && (line[offset] === ' ' || line[offset] === '\t')) {
      column = advanceMarkdownColumn(column, line[offset])
      offset += 1
    }
    if (column - indentationStart < step.indent) return -1
  }

  return offset
}

function endBeforeLine(markdown, lineStart) {
  let end = lineStart
  if (markdown[end - 1] === '\n') end -= 1
  if (markdown[end - 1] === '\r') end -= 1
  return end
}

function fenceAt(markdown, index, memo) {
  const character = markdown[index]
  if (character !== '`' && character !== '~') return null
  if (!couldStartFence(markdown, index)) return null

  const container = markdownContainerAt(markdown, index, {}, memo)
  if (!container) return null

  const length = countRun(markdown, index, character)
  if (length < 3) return null
  const lineEnd = markdown.indexOf('\n', index + length)
  const end = lineEnd < 0 ? markdown.length : lineEnd
  const info = markdown.slice(index + length, end).replace(/\r$/, '')
  if (character === '`' && info.includes('`')) return null
  return { character, container, length }
}

function findFenceEnd(markdown, openingIndex, fence) {
  let lineStart = markdown.indexOf('\n', openingIndex)
  if (lineStart < 0) return markdown.length
  lineStart += 1

  while (lineStart < markdown.length) {
    const lineEnd = markdown.indexOf('\n', lineStart)
    const end = lineEnd < 0 ? markdown.length : lineEnd
    const line = markdown.slice(lineStart, end)
    const contentOffset = containerContentOffset(line, fence.container)
    if (contentOffset < 0) return endBeforeLine(markdown, lineStart)
    const match = line.slice(contentOffset).match(/^ {0,3}(`+|~+)[ \t]*\r?$/)
    if (match?.[1]?.[0] === fence.character && match[1].length >= fence.length) {
      return lineEnd < 0 ? markdown.length : lineEnd + 1
    }
    lineStart = lineEnd < 0 ? markdown.length : lineEnd + 1
  }

  return markdown.length
}

function findInlineCodeEnd(markdown, openingIndex, markerLength) {
  let cursor = openingIndex + markerLength
  while (cursor < markdown.length) {
    const nextBacktick = markdown.indexOf('`', cursor)
    if (nextBacktick < 0) return -1
    const length = countRun(markdown, nextBacktick, '`')
    if (length === markerLength) return nextBacktick + length
    cursor = nextBacktick + length
  }
  return -1
}

function pushSegment(segments, kind, markdown, start, end) {
  if (end <= start) return
  const raw = markdown.slice(start, end)
  segments.push({ kind, raw })
}

function pushMathSegment(segments, markdown, match) {
  segments.push({
    kind: 'math',
    raw: markdown.slice(match.start, match.end),
    content: match.content ?? markdown.slice(match.contentStart, match.contentEnd),
    open: match.open,
    close: match.close,
    closed: match.closed,
  })
}

function flowDollarMathAt(markdown, index, runLength, memo) {
  if (runLength < 2) return null
  const container = markdownContainerAt(markdown, index, {}, memo)
  if (!container) return null

  const openingLineBreak = markdown.indexOf('\n', index + runLength)
  const openingLineEnd = openingLineBreak < 0 ? markdown.length : openingLineBreak
  const meta = markdown.slice(index + runLength, openingLineEnd).replace(/\r$/, '')
  if (meta.includes('$')) return null

  const contentStart = openingLineBreak < 0 ? markdown.length : openingLineBreak + 1
  const contentLines = []
  let candidateLineStart = contentStart
  while (candidateLineStart < markdown.length) {
    const candidateLineBreak = markdown.indexOf('\n', candidateLineStart)
    const candidateLineEnd = candidateLineBreak < 0 ? markdown.length : candidateLineBreak
    const line = markdown.slice(candidateLineStart, candidateLineEnd).replace(/\r$/, '')
    const contentOffset = containerContentOffset(line, container)
    if (contentOffset < 0) {
      return {
        start: index,
        end: endBeforeLine(markdown, candidateLineStart),
        content: contentLines.join('\n'),
        open: '$'.repeat(runLength),
        close: '',
        closed: false,
      }
    }
    const containerContent = line.slice(contentOffset)
    const closeMatch = containerContent.match(/^ {0,3}(\$+)[ \t]*$/)
    if (closeMatch && closeMatch[1].length >= runLength) {
      const closeStart = candidateLineStart + contentOffset + containerContent.indexOf('$')
      const closeEnd = closeStart + closeMatch[1].length
      return {
        start: index,
        end: closeEnd,
        content: contentLines.join('\n'),
        open: '$'.repeat(runLength),
        close: closeMatch[1],
        closed: true,
      }
    }
    contentLines.push(containerContent)
    candidateLineStart = candidateLineBreak < 0 ? markdown.length : candidateLineBreak + 1
  }

  return {
    start: index,
    end: markdown.length,
    content: contentLines.join('\n'),
    open: '$'.repeat(runLength),
    close: '',
    closed: false,
  }
}

function isFlowDollarCandidate(markdown, index, runLength, memo) {
  if (runLength < 2) return false
  if (!markdownContainerAt(markdown, index, { ignoreParagraphInterruption: true }, memo)) return false
  const lineBreak = markdown.indexOf('\n', index + runLength)
  if (lineBreak < 0) return false
  return !markdown.slice(index + runLength, lineBreak).replace(/\r$/, '').includes('$')
}

const BLANK = /\s/u
const DIGIT = /[0-9]/

/**
 * Single-dollar text math the pandoc way (`tex_math_dollars`), as the renderer reads it (session-shared
 * markdown/pandoc-dollar-math.ts): no blank right after the opening `$`, none right before the closing one, and no
 * digit right after the closing one. Otherwise the opening `$` is prose — "Backpack $29.99、Bike Light $9.99" is
 * two prices, not a formula.
 */
function pandocSingleDollarMath(markdown, open, close) {
  const after = markdown[open + 1]
  if (after === undefined || BLANK.test(after)) return false
  if (BLANK.test(markdown[close - 1])) return false
  // On a later line with only its container prefix (`>`, list indent) before it, the renderer — which reads the
  // paragraph without those prefixes — sees a line break right before the closing `$`.
  const closeLineStart = markdown.lastIndexOf('\n', close - 1) + 1
  if (closeLineStart > open && /^[ \t>]*$/.test(markdown.slice(closeLineStart, close))) return false
  // Text math stays in its paragraph: a blank line (or a quote's empty `>` line) between the dollars ends it.
  if (/\n[ \t>]*\r?\n/.test(markdown.slice(open, close))) return false
  const next = markdown[close + 1]
  return next === undefined || !DIGIT.test(next)
}

function mathAt(markdown, index, memo) {
  if (markdown[index] === '$') {
    if (!markerRunStartsAt(markdown, index, '$')) return null
    const runLength = countRun(markdown, index, '$')
    const flow = flowDollarMathAt(markdown, index, runLength, memo)
    if (flow) return flow
    if (isFlowDollarCandidate(markdown, index, runLength, memo)) return null
    const closeIndex = findExactDollarRun(markdown, runLength, index + runLength)
    if (closeIndex < 0) return null
    if (runLength === 1 && !pandocSingleDollarMath(markdown, index, closeIndex)) return null
    const delimiter = '$'.repeat(runLength)
    return {
      start: index,
      end: closeIndex + runLength,
      contentStart: index + runLength,
      contentEnd: closeIndex,
      open: delimiter,
      close: delimiter,
      closed: true,
    }
  }

  for (const delimiter of MATH_DELIMITERS) {
    if (!markdown.startsWith(delimiter.open, index) || backslashIsEscaped(markdown, index)) continue
    const contentStart = index + delimiter.open.length
    const closeIndex = findUnescaped(markdown, delimiter.close, contentStart)
    if (closeIndex < 0) return null
    return {
      start: index,
      end: closeIndex + delimiter.close.length,
      contentStart,
      contentEnd: closeIndex,
      open: delimiter.open,
      close: delimiter.close,
      closed: true,
    }
  }
  return null
}

/**
 * Tokenizes the markdown boundaries used by the renderer. The validator consumes
 * these same segments so code examples and escaped delimiters cannot drift apart.
 */
export function tokenizeMarkdownMath(markdown) {
  const source = String(markdown ?? '')
  const segments = []
  // Container-resolution memo for this run only (see @@@4254 above): keyed by (options, index),
  // dropped when tokenization finishes so no state leaks across inputs.
  const containerMemo = new Map()
  let cursor = 0
  let plainStart = 0

  while (cursor < source.length) {
    const fence = fenceAt(source, cursor, containerMemo)
    if (fence) {
      pushSegment(segments, 'prose', source, plainStart, cursor)
      const fenceEnd = findFenceEnd(source, cursor, fence)
      pushSegment(segments, 'code', source, cursor, fenceEnd)
      cursor = fenceEnd
      plainStart = cursor
      continue
    }

    if (markerRunStartsAt(source, cursor, '`')) {
      const markerLength = countRun(source, cursor, '`')
      const codeEnd = findInlineCodeEnd(source, cursor, markerLength)
      if (codeEnd >= 0) {
        pushSegment(segments, 'prose', source, plainStart, cursor)
        pushSegment(segments, 'code', source, cursor, codeEnd)
        cursor = codeEnd
        plainStart = cursor
        continue
      }
    }

    const math = mathAt(source, cursor, containerMemo)
    if (math) {
      pushSegment(segments, 'prose', source, plainStart, cursor)
      pushMathSegment(segments, source, math)
      cursor = math.end
      plainStart = cursor
      continue
    }

    cursor += 1
  }

  pushSegment(segments, 'prose', source, plainStart, source.length)
  return segments
}

// What may stand before display math on its line: indentation (≤3 columns, more is an indented code block) and
// container markers — blockquote `>`, list bullets / ordinals — with their spacing.
const LINE_CONTAINER_PREFIX = /^ {0,3}(?:>[ \t]?|(?:[-+*]|\d{1,9}[.)])[ \t]+)*$/

/**
 * Display math written on one line — `$$…$$`, or `\[…\]` — as the whole line, in its block form (#6950).
 * micromark only opens a math block on a `$$` line of its own, so the one-line form parsed as inline math and was set
 * in the text line, where GitHub sets it as a display. The continuation lines repeat the line's container prefix (a
 * list marker's width in spaces, a quote's `>`), so the block stays in the list item / quote the line was in.
 */
function displayMathBlockOnOwnLine(markdown, start, end, content) {
  if (!content.trim()) return null
  const lineStart = markdown.lastIndexOf('\n', start - 1) + 1
  const prefix = markdown.slice(lineStart, start)
  if (!LINE_CONTAINER_PREFIX.test(prefix) || /\t| {4}/.test(prefix)) return null
  const lineBreak = markdown.indexOf('\n', end)
  if (!/^[ \t]*\r?$/.test(markdown.slice(end, lineBreak < 0 ? markdown.length : lineBreak))) return null
  const continuation = prefix.replace(/[-+*]|\d{1,9}[.)]/g, (marker) => ' '.repeat(marker.length))
  return `$$\n${continuation}${content.trim()}\n${continuation}$$`
}

/**
 * `\(…\)` in dollars that still read as math under the pandoc rules (`pandocSingleDollarMath`): what is blank at
 * either edge — spaces, and a line break with the next line's container prefix — moves outside the dollars, so no
 * line is added or lost and a `$$` never lands at a line start (that would open a math block). A digit right after
 * takes two dollars, which stay text math there.
 */
function inlineDollarMath(content, next) {
  // Edges with a line break move outside (lines stay put); edges of only spaces are dropped.
  const lead = /^(?:[ \t]*\r?\n[ \t>]*)*/.exec(content)[0]
  const rest = content.slice(lead.length).replace(/^[ \t]+/, '')
  const edge = /(?:[ \t]*\r?\n[ \t>]*)*[ \t]*$/.exec(rest)[0]
  const core = rest.slice(0, rest.length - edge.length)
  if (!core) return `$${content}$`
  const trail = edge.includes('\n') ? edge : ''
  const dollars = trail === '' && next !== undefined && DIGIT.test(next) ? '$$' : '$'
  return `${lead}${dollars}${core}${dollars}${trail}`
}

export function normalizeLatexMathDelimiters(markdown) {
  return normalizeLatexMathDelimitersWithLines(markdown).text
}

/**
 * The same rewrite, and where each of its lines came from: `lineOf(n)` is the source's line (from 1) of the rewritten
 * text's line n. Only a one-line display set in its block form adds lines — its three are all that one source line.
 */
export function normalizeLatexMathDelimitersWithLines(markdown) {
  const source = String(markdown ?? '')
  const grown = [] // [the rewritten line a block form starts on, the lines it added]
  let offset = 0
  let line = 1
  const text = tokenizeMarkdownMath(source)
    .map((segment) => {
      const start = offset
      offset += segment.raw.length
      let out = segment.raw
      if (segment.kind === 'math' && segment.closed) {
        const block = (segment.open === '$$' || segment.open === '\\[') && !segment.raw.includes('\n')
          ? displayMathBlockOnOwnLine(source, start, offset, segment.content)
          : null
        if (block) grown.push([line, 2])
        else if (segment.open === '\\[') out = `$$${segment.content}$$`
        else if (segment.open === '\\(') out = inlineDollarMath(segment.content, source[offset])
        out = block ?? out
      }
      line += out.split('\n').length - 1
      return out
    })
    .join('')
  const lineOf = (n) => {
    let shift = 0
    for (const [at, added] of grown) {
      if (n <= at) break
      if (n <= at + added) return at - shift
      shift += added
    }
    return n - shift
  }
  return { text, lineOf }
}
