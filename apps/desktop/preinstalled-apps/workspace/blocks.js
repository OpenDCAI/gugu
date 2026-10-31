// Commands edit the existing CodeMirror document. Preview spans and the editor's own syntax tree locate content;
// this module keeps no document state, parser, collaboration layer or undo history of its own.
export const INSERT_BLOCKS = [
  { id: 'table', label: 'insertTable', text: '|  |  |  |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |', caret: 2 },
  { id: 'image', label: 'insertImage' },
  { id: 'file', label: 'insertFile' },
  { id: 'heading', label: 'insertHeading', text: '## ', caret: 3 },
  { id: 'list', label: 'insertList', text: '- ', caret: 2 },
  { id: 'todo', label: 'insertTodo', text: '- [ ] ', caret: 6 },
  { id: 'quote', label: 'insertQuote', text: '> ', caret: 2 },
  { id: 'code', label: 'insertCode', text: '```\n\n```', caret: 4 },
  { id: 'divider', label: 'insertDivider', text: '***', caret: 3 },
]

export function sourceBlocks(state, cm, upto = state.doc.length) {
  const tree = cm.language.ensureSyntaxTree(state, upto, 100)
  if (!tree) throw new Error('Markdown syntax is not ready')
  const blocks = []
  for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
    blocks.push({ from: state.doc.lineAt(node.from).from, to: state.doc.lineAt(Math.max(node.from, node.to - 1)).to, name: node.name })
    if (node.from > upto) break
  }
  return blocks
}

export function previewBlock(state, cm, span) {
  if (!span || span[0] < 1 || span[1] < span[0] || span[1] > state.doc.lines) return null
  const from = state.doc.line(span[0]).from, to = state.doc.line(span[1]).to
  return sourceBlocks(state, cm, to).find((block) => block.from === from && block.to === to && !isFrontmatter(block)) ?? null
}

export function isFrontmatter(block) {
  return /^frontmatter$/i.test(block.name)
}

function separateList(doc, text, previous, next) {
  const markers = [previous, next].filter((block) => block?.name === 'BulletList').map((block) => doc.lineAt(block.from).text.trimStart()[0])
  const marker = ['-', '*', '+'].find((value) => !markers.includes(value))
  return marker + text.slice(1)
}

export function listInsertion(state, cm, block, kind, text) {
  if (block.name === 'BulletList') {
    const tree = cm.language.ensureSyntaxTree(state, block.to, 100)
    if (!tree) throw new Error('Markdown syntax is not ready')
    let list = tree.resolveInner(block.from, 1)
    while (list.parent && list.parent.parent) list = list.parent
    const item = list.lastChild, line = state.doc.lineAt(item.from)
    let marker = null, task = false
    tree.iterate({ from: item.from, to: line.to, enter(node) {
      if (node.name === 'ListMark') marker = { from: node.from, to: node.to }
      if (node.name === 'TaskMarker') task = true
    } })
    if (marker && task === (kind === 'todo')) {
      const prefix = state.doc.sliceString(line.from, marker.to)
      return { text: prefix + text.slice(1), prefix: '\n', offset: prefix.length - 1 }
    }
  }
  return { text: separateList(state.doc, text, block.line ? block.above : block, block.below), prefix: '\n\n', offset: 0 }
}

// Only syntax marks change. The original content characters remain in Y.Text, including other people's edits.
export function turnBlockChanges(state, cm, block, kind) {
  const { doc } = state
  const { from, to, name } = block
  const tree = cm.language.ensureSyntaxTree(state, to, 100)
  if (!tree) throw new Error('Markdown syntax is not ready')
  if (kind === 'code' && (name === 'FencedCode' || name === 'CodeBlock')) return []
  const marks = new Map()
  let underline = null
  tree.iterate({ from, to, enter(node) {
    if (node.from < from || node.to > to || !['HeaderMark', 'ListMark', 'QuoteMark', 'TaskMarker'].includes(node.name)) return
    const line = doc.lineAt(node.from)
    if (node.name === 'HeaderMark' && line.from > from && doc.sliceString(line.from, line.to).trim() === doc.sliceString(node.from, node.to)) {
      underline = line
      return
    }
    const end = node.to + /^[ \t]*/.exec(doc.sliceString(node.to, line.to))[0].length
    marks.set(line.from, Math.max(marks.get(line.from) ?? line.from, end))
  } })
  let first = doc.lineAt(from).number, last = doc.lineAt(to).number
  const changes = []
  if (name === 'FencedCode') {
    const open = doc.line(first), close = doc.line(last)
    // An unclosed fence has no closing delimiter to remove.
    let node = tree.resolveInner(from, 1)
    while (node.parent && node.parent.parent) node = node.parent
    const fences = node.getChildren('CodeMark')
    const closed = fences.length > 1 && doc.lineAt(fences.at(-1).from).number === last
    if (first === last || (closed && last === first + 1)) return [{ from, to, insert: kind === 'heading' ? '## ' : kind === 'list' ? '- ' : '> ' }]
    changes.push({ from: open.from, to: Math.min(doc.length, open.to + 1), insert: '' })
    first++
    if (closed) {
      changes.push({ from: close.from - 1, to: close.to, insert: '' })
      last--
    }
  }
  if (underline) {
    changes.push({ from: underline.from - 1, to: underline.to, insert: '' })
    last--
  }
  const fence = '`'.repeat(Math.max(3, ...[...doc.sliceString(from, to).matchAll(/`+/g)].map(([run]) => run.length + 1)))
  const emptyCode = (name === 'FencedCode' || name === 'CodeBlock') && !doc.sliceString(doc.line(first).from, doc.line(last).to).trim()
  for (let n = first; n <= last; n++) {
    const line = doc.line(n)
    const end = name === 'CodeBlock' ? line.from + Math.min(4, /^ */.exec(line.text)[0].length) : marks.get(line.from) ?? line.from
    const content = doc.sliceString(end, line.to)
    if (kind === 'heading' && n > first) {
      changes.push({ from: line.from - 1, to: end, insert: ' ' })
      continue
    }
    const prefix = kind === 'heading' ? '## ' : !content.trim() && !(emptyCode && n === first) ? '' : kind === 'list' ? '- ' : kind === 'quote' ? '> ' : ''
    const insert = (kind === 'code' && n === first ? `${fence}\n` : '') + prefix
    if (end !== line.from || insert) changes.push({ from: line.from, to: end, insert })
    if (kind === 'code' && n === last) changes.push({ from: line.to, insert: `\n${fence}` })
  }
  return changes.sort((a, b) => a.from - b.from)
}

export function moveBlock(doc, block, neighbor, down) {
  const text = doc.sliceString(block.from, block.to)
  const gap = down ? doc.sliceString(block.to, neighbor.from) : doc.sliceString(neighbor.to, block.from)
  return down
    ? { changes: [{ from: block.from, to: neighbor.from, insert: '' }, { from: neighbor.to, insert: gap + text }], head: neighbor.to - (neighbor.from - block.from) + gap.length }
    : { changes: [{ from: neighbor.from, insert: text + gap }, { from: neighbor.to, to: block.to, insert: '' }], head: neighbor.from }
}
