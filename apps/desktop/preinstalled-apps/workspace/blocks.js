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
  { id: 'divider', label: 'insertDivider', text: '---\n', caret: 4 },
]

export function blockContent(state, cm, from, to) {
  const { doc } = state
  const tree = cm.language.ensureSyntaxTree(state, to, 100)
  if (!tree) throw new Error('Markdown syntax is not ready')
  let top = tree.topNode.firstChild
  while (top && top.to <= from) top = top.nextSibling
  if (top?.from === from && (top.name === 'FencedCode' || top.name === 'CodeBlock')) {
    const content = top.getChild('CodeText')
    return content ? doc.sliceString(content.from, content.to) : ''
  }
  const marks = []
  tree.iterate({ from, to, enter(node) {
    if (node.from < from || node.to > to || !['HeaderMark', 'ListMark', 'QuoteMark', 'TaskMarker'].includes(node.name)) return
    const line = doc.lineAt(node.from)
    // Setext's underline is its own line. Other block marks consume the separating horizontal space only.
    const wholeLine = doc.sliceString(line.from, line.to).trim() === doc.sliceString(node.from, node.to)
    const end = node.to + /^[ \t]*/.exec(doc.sliceString(node.to, line.to))[0].length
    marks.push({ from: wholeLine && line.from > from ? line.from - 1 : node.from, to: end })
  } })
  let result = '', at = from
  for (const mark of marks) {
    result += doc.sliceString(at, mark.from)
    at = mark.to
  }
  return result + doc.sliceString(at, to)
}

export function turnBlock(content, kind) {
  if (kind === 'heading') return `## ${content.replace(/\s*\n\s*/g, ' ')}`
  if (kind === 'list') return content.split('\n').map((line) => `- ${line}`).join('\n')
  if (kind === 'quote') return content.split('\n').map((line) => `> ${line}`).join('\n')
  // A code block may itself contain backticks: its fence must be longer than any run inside it.
  const fence = '`'.repeat(Math.max(3, ...[...content.matchAll(/`+/g)].map(([run]) => run.length + 1)))
  return `${fence}\n${content}\n${fence}`
}

export function swapBlocks(doc, first, second) {
  const left = doc.sliceString(first.from, first.to)
  const gap = doc.sliceString(first.to, second.from)
  const right = doc.sliceString(second.from, second.to)
  return { from: first.from, to: second.to, insert: right + gap + left, movedDown: right.length + gap.length }
}
