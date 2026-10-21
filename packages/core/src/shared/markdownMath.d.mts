export type MarkdownMathSegment =
  | { kind: 'prose' | 'code'; raw: string }
  | { kind: 'math'; raw: string; content: string; open: string; close: string; closed: boolean }

export function tokenizeMarkdownMath(markdown: string): MarkdownMathSegment[]
export function normalizeLatexMathDelimiters(markdown: string): string
export function normalizeLatexMathDelimitersWithLines(markdown: string): { text: string; lineOf: (line: number) => number }
