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

export function sourceBlocks(state, cm) {
  const tree = cm.language.ensureSyntaxTree(state, state.doc.length, 100)
  if (!tree) throw new Error('Markdown syntax is not ready')
  const blocks = []
  for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
    blocks.push({ from: state.doc.lineAt(node.from).from, to: state.doc.lineAt(Math.max(node.from, node.to - 1)).to, name: node.name })
  }
  return blocks
}

export function isFrontmatter(block) {
  return /^frontmatter$/i.test(block.name)
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
    if (closed && last === first + 1) return [{ from, to, insert: '' }]
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
  for (let n = first; n <= last; n++) {
    const line = doc.line(n)
    const end = name === 'CodeBlock' ? line.from + Math.min(4, /^ */.exec(line.text)[0].length) : marks.get(line.from) ?? line.from
    const content = doc.sliceString(end, line.to)
    const prefix = !content.trim() ? '' : kind === 'heading' ? '## ' : kind === 'list' ? '- ' : kind === 'quote' ? '> ' : ''
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
