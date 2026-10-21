const U0024 = String.fromCodePoint(0x24)
const BACKTICK = String.fromCodePoint(0x60)
const BACKSLASH = String.fromCodePoint(0x5c)
const TAB = String.fromCodePoint(0x09)
const singleDollar = U0024
const doubleDollar = U0024.repeat(2)
const tripleDollar = U0024.repeat(3)
const quadrupleDollar = U0024.repeat(4)
const rawTex = String.raw`x\neq 0`

const singleOpenDoubleClose = `${singleDollar}${rawTex}${doubleDollar}`
const doubleOpenSingleClose = `${doubleDollar}${rawTex}${singleDollar}`
const validSingle = `${singleDollar}${rawTex}${singleDollar}`
const validDouble = `${doubleDollar}${rawTex}${doubleDollar}`
const validTriple = `${tripleDollar}${rawTex}${tripleDollar}`
const validQuadruple = `${quadrupleDollar}${rawTex}${quadrupleDollar}`
const tripleOpenQuadrupleClose = `${tripleDollar}${rawTex}${quadrupleDollar}`
const singleOpenTripleClose = `${singleDollar}${rawTex}${tripleDollar}`
const flowDoubleOpenTripleClose = `${doubleDollar}\n${rawTex}\n${tripleDollar}`
const flowTripleOpenDoubleClose = `${tripleDollar}\n${rawTex}\n${doubleDollar}`
const flowTripleOpenToEof = `${tripleDollar}\n${rawTex}`
const escapedAndValid = `escaped \\${singleDollar} value; ${singleDollar}x+1${singleDollar}`
const inlineCode = `${BACKTICK}${singleOpenDoubleClose}${BACKTICK}`
const fencedCode = `${BACKTICK.repeat(3)}tex\n${doubleOpenSingleClose}\n${BACKTICK.repeat(3)}`
const escapedBacktick = `\\${BACKTICK}${rawTex}${BACKTICK}`
const tripleBacktick = BACKTICK.repeat(3)
const quadrupleBacktick = BACKTICK.repeat(4)
const invalidBacktickInfoFence = `${tripleBacktick}tex${BACKTICK}bad\n${rawTex}`
const validTildeInfoBacktickFence = `~~~tex${BACKTICK}literal\n${rawTex}\n~~~`
const longerBacktickFence = [
  `${quadrupleBacktick}tex`,
  rawTex,
  tripleBacktick,
  '~~~~',
  BACKTICK.repeat(5),
].join('\n')
const blockquoteFlow = `> ${doubleDollar}\n> ${rawTex}\n> ${doubleDollar}`
const listFlow = `- ${doubleDollar}\n  ${rawTex}\n  ${doubleDollar}`
const unclosedBlockquoteFlow = `> ${doubleDollar}\n> ${rawTex}\noutside prose`
const unclosedListFlow = `- ${doubleDollar}\n  ${rawTex}\noutside prose`
const prosePrefixedUnclosedRun = `ordinary prose ${doubleDollar}\n${rawTex}`
const escapedDollarAdjacentMath = `${BACKSLASH}${singleDollar}${singleDollar}${rawTex}${singleDollar}`
const backslashBeforeExactCloser = `${singleDollar}x${BACKSLASH}${singleDollar} then y${BACKSLASH}neq 0${singleDollar}`
const nonFlowMultilineTextMath = `prefix ${doubleDollar}${rawTex}\ncontinued${doubleDollar} suffix`
const escapedBacktickAdjacentCode = `${BACKSLASH}${BACKTICK}${BACKTICK}${rawTex}${BACKTICK}`
const paragraphNonInterruptingOrderedFlow = `ordinary paragraph\n2. ${doubleDollar}\n   ${rawTex}\n   ${doubleDollar}`
const paragraphInterruptingOrderedFlow = `ordinary paragraph\n1. ${doubleDollar}\n   ${rawTex}\n   ${doubleDollar}`
const blankBoundedOrderedFlow = `ordinary paragraph\n\n2. ${doubleDollar}\n   ${rawTex}\n   ${doubleDollar}`
const listBlankLineFlow = `- ${doubleDollar}\n  ${rawTex}\n\n  y+1\n  ${doubleDollar}`
const nestedBlockquoteFlow = `> > ${doubleDollar}\n> > ${rawTex}\n> > ${doubleDollar}`
const unclosedNestedBlockquoteFlow = `> > ${doubleDollar}\n> > ${rawTex}\n> outside prose`
const listBlockquoteFlow = `- > ${doubleDollar}\n  > ${rawTex}\n  > ${doubleDollar}`
const unclosedListBlockquoteFlow = `- > ${doubleDollar}\n  > ${rawTex}\n${doubleDollar}`
const bareBlankEndsListBlockquoteFlow = `- > ${doubleDollar}\n\n  > ${rawTex}\n  > ${doubleDollar}`
const markedBlankKeepsListBlockquoteFlow = `- > ${doubleDollar}\n  >\n  > ${rawTex}\n  > ${doubleDollar}`
const nestedListFlow = `- 1. ${doubleDollar}\n     ${rawTex}\n     ${doubleDollar}`
const nestedListBlankFlow = `- 1. ${doubleDollar}\n\n     ${rawTex}\n     ${doubleDollar}`
const nestedListFence = `- > ${tripleBacktick}tex\n  > ${rawTex}\n  > ${tripleBacktick}`
const unclosedNestedListFence = `- > ${tripleBacktick}tex\n  > ${rawTex}`
const activeListContinuationFlow = `- item\n\n  ${doubleDollar}\n  ${rawTex}\n  ${doubleDollar}`
const activeListContinuationExit = `- item\n\n  ${doubleDollar}\n  ${rawTex}\noutside prose\n${doubleDollar}`
const quoteListBlankContinuationFlow = `> - item\n>\n>   ${doubleDollar}\n>   ${rawTex}\n>   ${doubleDollar}`
const nestedListQuoteListContinuationFlow = `1. > - item\n   >\n   >   ${doubleDollar}\n   >   ${rawTex}\n   >   ${doubleDollar}`
const quoteListContinuationExit = `> - item\n>\n>   ${doubleDollar}\n>   ${rawTex}\noutside prose\n${doubleDollar}`
const eolBlankListFenceExit = [
  '-',
  `  ${tripleBacktick}text`,
  '  literal',
  `outside ${rawTex}`,
  `  ${tripleBacktick}`,
].join('\n')
const eolBlankOrderedMathExit = [
  '1.',
  `   ${doubleDollar}`,
  `   ${rawTex}`,
  'outside prose',
  doubleDollar,
].join('\n')
const listQuoteContinuationFlow = [
  '- item',
  `  > ${doubleDollar}`,
  `  > ${rawTex}`,
  `  > ${doubleDollar}`,
].join('\n')
const listQuoteContinuationExit = [
  '- item',
  `  > ${doubleDollar}`,
  `  > ${rawTex}`,
  `> ${doubleDollar}`,
].join('\n')
const nestedListQuoteContinuationFlow = [
  '- item',
  '  > 1. nested',
  `  >    ${doubleDollar}`,
  `  >    ${rawTex}`,
  `  >    ${doubleDollar}`,
].join('\n')
const tabStoppedListFlowExit = `- ${TAB}${doubleDollar}\n   ${rawTex}\n   ${doubleDollar}`

export type DollarRunBoundaryFixture = {
  name: string
  markdown: string
  expectedSegments: Array<Record<string, boolean | string>>
  rendererNodes: Array<'code' | 'inlineCode' | 'inlineMath' | 'math'>
  validator: 'allow' | 'reject'
  /** What normalizeLatexMathDelimiters hands the renderer when it is not the input itself (#6950: a one-line display). */
  normalized?: string
}

export const dollarRunBoundaryFixtures: DollarRunBoundaryFixture[] = [
  {
    name: 'single opener does not consume a double closing run',
    markdown: singleOpenDoubleClose,
    expectedSegments: [{ kind: 'prose', raw: singleOpenDoubleClose }],
    rendererNodes: [],
    validator: 'reject',
  },
  {
    name: 'double opener does not consume a single closing run',
    markdown: doubleOpenSingleClose,
    expectedSegments: [{ kind: 'prose', raw: doubleOpenSingleClose }],
    rendererNodes: [],
    validator: 'reject',
  },
  {
    name: 'single opener closes on an exact single run',
    markdown: validSingle,
    expectedSegments: [{
      kind: 'math',
      raw: validSingle,
      content: rawTex,
      open: singleDollar,
      close: singleDollar,
      closed: true,
    }],
    rendererNodes: ['inlineMath'],
    validator: 'allow',
  },
  {
    name: 'double opener closes on an exact double run',
    markdown: validDouble,
    expectedSegments: [{
      kind: 'math',
      raw: validDouble,
      content: rawTex,
      open: doubleDollar,
      close: doubleDollar,
      closed: true,
    }],
    rendererNodes: ['inlineMath'],
    validator: 'allow',
    // the whole line is the math: it renders as a display block (#6950)
    normalized: `${doubleDollar}\n${rawTex}\n${doubleDollar}`,
  },
  {
    name: 'triple opener closes on an exact triple run',
    markdown: validTriple,
    expectedSegments: [{
      kind: 'math',
      raw: validTriple,
      content: rawTex,
      open: tripleDollar,
      close: tripleDollar,
      closed: true,
    }],
    rendererNodes: ['inlineMath'],
    validator: 'allow',
  },
  {
    name: 'quadruple opener closes on an exact quadruple run',
    markdown: validQuadruple,
    expectedSegments: [{
      kind: 'math',
      raw: validQuadruple,
      content: rawTex,
      open: quadrupleDollar,
      close: quadrupleDollar,
      closed: true,
    }],
    rendererNodes: ['inlineMath'],
    validator: 'allow',
  },
  {
    name: 'triple text opener does not consume a quadruple closing run',
    markdown: tripleOpenQuadrupleClose,
    expectedSegments: [{ kind: 'prose', raw: tripleOpenQuadrupleClose }],
    rendererNodes: [],
    validator: 'reject',
  },
  {
    name: 'single text opener does not consume an adjacent triple closing run',
    markdown: singleOpenTripleClose,
    expectedSegments: [{ kind: 'prose', raw: singleOpenTripleClose }],
    rendererNodes: [],
    validator: 'reject',
  },
  {
    name: 'flow closer may be longer than its double opener',
    markdown: flowDoubleOpenTripleClose,
    expectedSegments: [{
      kind: 'math',
      raw: flowDoubleOpenTripleClose,
      content: rawTex,
      open: doubleDollar,
      close: tripleDollar,
      closed: true,
    }],
    rendererNodes: ['math'],
    validator: 'allow',
  },
  {
    name: 'shorter flow fence remains content in an unclosed math segment',
    markdown: flowTripleOpenDoubleClose,
    expectedSegments: [{
      kind: 'math',
      raw: flowTripleOpenDoubleClose,
      content: `${rawTex}\n${doubleDollar}`,
      open: tripleDollar,
      close: '',
      closed: false,
    }],
    rendererNodes: ['math'],
    validator: 'reject',
  },
  {
    name: 'flow opener without a closer retains explicit unclosed metadata to EOF',
    markdown: flowTripleOpenToEof,
    expectedSegments: [{
      kind: 'math',
      raw: flowTripleOpenToEof,
      content: rawTex,
      open: tripleDollar,
      close: '',
      closed: false,
    }],
    rendererNodes: ['math'],
    validator: 'reject',
  },
  {
    name: 'escaped dollars remain prose beside valid math',
    markdown: escapedAndValid,
    expectedSegments: [
      { kind: 'prose', raw: `escaped \\${singleDollar} value; ` },
      {
        kind: 'math',
        raw: `${singleDollar}x+1${singleDollar}`,
        content: 'x+1',
        open: singleDollar,
        close: singleDollar,
        closed: true,
      },
    ],
    rendererNodes: ['inlineMath'],
    validator: 'allow',
  },
  {
    name: 'inline code preserves mismatched dollar runs',
    markdown: inlineCode,
    expectedSegments: [{ kind: 'code', raw: inlineCode }],
    rendererNodes: ['inlineCode'],
    validator: 'allow',
  },
  {
    name: 'fenced code preserves mismatched dollar runs',
    markdown: fencedCode,
    expectedSegments: [{ kind: 'code', raw: fencedCode }],
    rendererNodes: ['code'],
    validator: 'allow',
  },
  {
    name: 'escaped backtick cannot open a code exemption',
    markdown: escapedBacktick,
    expectedSegments: [{ kind: 'prose', raw: escapedBacktick }],
    rendererNodes: [],
    validator: 'reject',
  },
  {
    name: 'an escaped dollar owns only itself before adjacent inline math',
    markdown: escapedDollarAdjacentMath,
    expectedSegments: [
      { kind: 'prose', raw: `${BACKSLASH}${singleDollar}` },
      {
        kind: 'math',
        raw: `${singleDollar}${rawTex}${singleDollar}`,
        content: rawTex,
        open: singleDollar,
        close: singleDollar,
        closed: true,
      },
    ],
    rendererNodes: ['inlineMath'],
    validator: 'allow',
  },
  {
    name: 'an exact text closer remains a closer when preceded by backslash inside math',
    markdown: backslashBeforeExactCloser,
    expectedSegments: [
      {
        kind: 'math',
        raw: `${singleDollar}x${BACKSLASH}${singleDollar}`,
        content: `x${BACKSLASH}`,
        open: singleDollar,
        close: singleDollar,
        closed: true,
      },
      { kind: 'prose', raw: ` then y${BACKSLASH}neq 0${singleDollar}` },
    ],
    rendererNodes: ['inlineMath'],
    validator: 'reject',
  },
  {
    name: 'a non-flow-position double run keeps renderer-valid multiline text math',
    markdown: nonFlowMultilineTextMath,
    expectedSegments: [
      { kind: 'prose', raw: 'prefix ' },
      {
        kind: 'math',
        raw: `${doubleDollar}${rawTex}\ncontinued${doubleDollar}`,
        content: `${rawTex}\ncontinued`,
        open: doubleDollar,
        close: doubleDollar,
        closed: true,
      },
      { kind: 'prose', raw: ' suffix' },
    ],
    rendererNodes: ['inlineMath'],
    validator: 'allow',
  },
  {
    name: 'an escaped backtick owns only itself before adjacent inline code',
    markdown: escapedBacktickAdjacentCode,
    expectedSegments: [
      { kind: 'prose', raw: `${BACKSLASH}${BACKTICK}` },
      { kind: 'code', raw: `${BACKTICK}${rawTex}${BACKTICK}` },
    ],
    rendererNodes: ['inlineCode'],
    validator: 'allow',
  },
]

export const markdownStructureBoundaryFixtures: DollarRunBoundaryFixture[] = [
  {
    name: 'list continuation composes a nested quote flow container',
    markdown: listQuoteContinuationFlow,
    expectedSegments: [
      { kind: 'prose', raw: '- item\n  > ' },
      {
        kind: 'math',
        raw: `${doubleDollar}\n  > ${rawTex}\n  > ${doubleDollar}`,
        content: rawTex,
        open: doubleDollar,
        close: doubleDollar,
        closed: true,
      },
    ],
    rendererNodes: ['math'],
    validator: 'allow',
  },
  {
    name: 'root quote cannot close math after a list to quote container exit',
    markdown: listQuoteContinuationExit,
    expectedSegments: [
      { kind: 'prose', raw: '- item\n  > ' },
      {
        kind: 'math',
        raw: `${doubleDollar}\n  > ${rawTex}`,
        content: rawTex,
        open: doubleDollar,
        close: '',
        closed: false,
      },
      { kind: 'prose', raw: '\n> ' },
      {
        kind: 'math',
        raw: doubleDollar,
        content: '',
        open: doubleDollar,
        close: '',
        closed: false,
      },
    ],
    rendererNodes: ['math', 'math'],
    validator: 'reject',
  },
  {
    name: 'list quote continuation retains its nested ordered list frame',
    markdown: nestedListQuoteContinuationFlow,
    expectedSegments: [
      { kind: 'prose', raw: '- item\n  > 1. nested\n  >    ' },
      {
        kind: 'math',
        raw: `${doubleDollar}\n  >    ${rawTex}\n  >    ${doubleDollar}`,
        content: rawTex,
        open: doubleDollar,
        close: doubleDollar,
        closed: true,
      },
    ],
    rendererNodes: ['math'],
    validator: 'allow',
  },
  {
    name: 'backtick fence info containing a backtick remains prose',
    markdown: invalidBacktickInfoFence,
    expectedSegments: [{ kind: 'prose', raw: invalidBacktickInfoFence }],
    rendererNodes: [],
    validator: 'reject',
  },
  {
    name: 'tilde fence info may contain a backtick',
    markdown: validTildeInfoBacktickFence,
    expectedSegments: [{ kind: 'code', raw: validTildeInfoBacktickFence }],
    rendererNodes: ['code'],
    validator: 'allow',
  },
  {
    name: 'code fence closes only on the same character with sufficient length',
    markdown: longerBacktickFence,
    expectedSegments: [{ kind: 'code', raw: longerBacktickFence }],
    rendererNodes: ['code'],
    validator: 'allow',
  },
  {
    name: 'blockquote container owns one closed flow math segment',
    markdown: blockquoteFlow,
    expectedSegments: [
      { kind: 'prose', raw: '> ' },
      {
        kind: 'math',
        raw: `${doubleDollar}\n> ${rawTex}\n> ${doubleDollar}`,
        content: rawTex,
        open: doubleDollar,
        close: doubleDollar,
        closed: true,
      },
    ],
    rendererNodes: ['math'],
    validator: 'allow',
  },
  {
    name: 'list container owns one closed flow math segment',
    markdown: listFlow,
    expectedSegments: [
      { kind: 'prose', raw: '- ' },
      {
        kind: 'math',
        raw: `${doubleDollar}\n  ${rawTex}\n  ${doubleDollar}`,
        content: rawTex,
        open: doubleDollar,
        close: doubleDollar,
        closed: true,
      },
    ],
    rendererNodes: ['math'],
    validator: 'allow',
  },
  {
    name: 'unclosed blockquote flow math stops at the container boundary',
    markdown: unclosedBlockquoteFlow,
    expectedSegments: [
      { kind: 'prose', raw: '> ' },
      {
        kind: 'math',
        raw: `${doubleDollar}\n> ${rawTex}`,
        content: rawTex,
        open: doubleDollar,
        close: '',
        closed: false,
      },
      { kind: 'prose', raw: '\noutside prose' },
    ],
    rendererNodes: ['math'],
    validator: 'reject',
  },
  {
    name: 'unclosed list flow math stops at the container boundary',
    markdown: unclosedListFlow,
    expectedSegments: [
      { kind: 'prose', raw: '- ' },
      {
        kind: 'math',
        raw: `${doubleDollar}\n  ${rawTex}`,
        content: rawTex,
        open: doubleDollar,
        close: '',
        closed: false,
      },
      { kind: 'prose', raw: '\noutside prose' },
    ],
    rendererNodes: ['math'],
    validator: 'reject',
  },
  {
    name: 'ordinary prose before a dollar run is not a flow container prefix',
    markdown: prosePrefixedUnclosedRun,
    expectedSegments: [{ kind: 'prose', raw: prosePrefixedUnclosedRun }],
    rendererNodes: [],
    validator: 'reject',
  },
  {
    name: 'ordered list start other than one cannot interrupt a paragraph',
    markdown: paragraphNonInterruptingOrderedFlow,
    expectedSegments: [
      { kind: 'prose', raw: `ordinary paragraph\n2. ${doubleDollar}\n   ${rawTex}\n   ` },
      {
        kind: 'math',
        raw: doubleDollar,
        content: '',
        open: doubleDollar,
        close: '',
        closed: false,
      },
    ],
    rendererNodes: ['math'],
    validator: 'reject',
  },
  {
    name: 'ordered list start one may interrupt a paragraph with flow math',
    markdown: paragraphInterruptingOrderedFlow,
    expectedSegments: [
      { kind: 'prose', raw: 'ordinary paragraph\n1. ' },
      {
        kind: 'math',
        raw: `${doubleDollar}\n   ${rawTex}\n   ${doubleDollar}`,
        content: rawTex,
        open: doubleDollar,
        close: doubleDollar,
        closed: true,
      },
    ],
    rendererNodes: ['math'],
    validator: 'allow',
  },
  {
    name: 'blank boundary permits an ordered list with a non-one start',
    markdown: blankBoundedOrderedFlow,
    expectedSegments: [
      { kind: 'prose', raw: 'ordinary paragraph\n\n2. ' },
      {
        kind: 'math',
        raw: `${doubleDollar}\n   ${rawTex}\n   ${doubleDollar}`,
        content: rawTex,
        open: doubleDollar,
        close: doubleDollar,
        closed: true,
      },
    ],
    rendererNodes: ['math'],
    validator: 'allow',
  },
  {
    name: 'a blank line inside a list item retains its flow math container',
    markdown: listBlankLineFlow,
    expectedSegments: [
      { kind: 'prose', raw: '- ' },
      {
        kind: 'math',
        raw: `${doubleDollar}\n  ${rawTex}\n\n  y+1\n  ${doubleDollar}`,
        content: `${rawTex}\n\ny+1`,
        open: doubleDollar,
        close: doubleDollar,
        closed: true,
      },
    ],
    rendererNodes: ['math'],
    validator: 'allow',
  },
  {
    name: 'nested blockquote depth retains one closed flow math segment',
    markdown: nestedBlockquoteFlow,
    expectedSegments: [
      { kind: 'prose', raw: '> > ' },
      {
        kind: 'math',
        raw: `${doubleDollar}\n> > ${rawTex}\n> > ${doubleDollar}`,
        content: rawTex,
        open: doubleDollar,
        close: doubleDollar,
        closed: true,
      },
    ],
    rendererNodes: ['math'],
    validator: 'allow',
  },
  {
    name: 'unclosed nested blockquote math stops when quote depth decreases',
    markdown: unclosedNestedBlockquoteFlow,
    expectedSegments: [
      { kind: 'prose', raw: '> > ' },
      {
        kind: 'math',
        raw: `${doubleDollar}\n> > ${rawTex}`,
        content: rawTex,
        open: doubleDollar,
        close: '',
        closed: false,
      },
      { kind: 'prose', raw: '\n> outside prose' },
    ],
    rendererNodes: ['math'],
    validator: 'reject',
  },
  {
    name: 'list then blockquote owns one closed flow math segment',
    markdown: listBlockquoteFlow,
    expectedSegments: [
      { kind: 'prose', raw: '- > ' },
      {
        kind: 'math',
        raw: `${doubleDollar}\n  > ${rawTex}\n  > ${doubleDollar}`,
        content: rawTex,
        open: doubleDollar,
        close: doubleDollar,
        closed: true,
      },
    ],
    rendererNodes: ['math'],
    validator: 'allow',
  },
  {
    name: 'unclosed list then blockquote math stops before a top-level dollar run',
    markdown: unclosedListBlockquoteFlow,
    expectedSegments: [
      { kind: 'prose', raw: '- > ' },
      {
        kind: 'math',
        raw: `${doubleDollar}\n  > ${rawTex}`,
        content: rawTex,
        open: doubleDollar,
        close: '',
        closed: false,
      },
      { kind: 'prose', raw: '\n' },
      {
        kind: 'math',
        raw: doubleDollar,
        content: '',
        open: doubleDollar,
        close: '',
        closed: false,
      },
    ],
    rendererNodes: ['math', 'math'],
    validator: 'reject',
  },
  {
    name: 'nested list indentation owns one closed flow math segment',
    markdown: nestedListFlow,
    expectedSegments: [
      { kind: 'prose', raw: '- 1. ' },
      {
        kind: 'math',
        raw: `${doubleDollar}\n     ${rawTex}\n     ${doubleDollar}`,
        content: rawTex,
        open: doubleDollar,
        close: doubleDollar,
        closed: true,
      },
    ],
    rendererNodes: ['math'],
    validator: 'allow',
  },
  {
    name: 'a bare blank keeps its list item but ends the nested blockquote math',
    markdown: bareBlankEndsListBlockquoteFlow,
    expectedSegments: [
      { kind: 'prose', raw: '- > ' },
      {
        kind: 'math',
        raw: doubleDollar,
        content: '',
        open: doubleDollar,
        close: '',
        closed: false,
      },
      { kind: 'prose', raw: `\n\n  > ${rawTex}\n  > ` },
      {
        kind: 'math',
        raw: doubleDollar,
        content: '',
        open: doubleDollar,
        close: '',
        closed: false,
      },
    ],
    rendererNodes: ['math', 'math'],
    validator: 'reject',
  },
  {
    name: 'a blockquote-marked blank remains inside list then blockquote math',
    markdown: markedBlankKeepsListBlockquoteFlow,
    expectedSegments: [
      { kind: 'prose', raw: '- > ' },
      {
        kind: 'math',
        raw: `${doubleDollar}\n  >\n  > ${rawTex}\n  > ${doubleDollar}`,
        content: `\n${rawTex}`,
        open: doubleDollar,
        close: doubleDollar,
        closed: true,
      },
    ],
    rendererNodes: ['math'],
    validator: 'allow',
  },
  {
    name: 'a bare blank remains inside nested list flow math',
    markdown: nestedListBlankFlow,
    expectedSegments: [
      { kind: 'prose', raw: '- 1. ' },
      {
        kind: 'math',
        raw: `${doubleDollar}\n\n     ${rawTex}\n     ${doubleDollar}`,
        content: `\n${rawTex}`,
        open: doubleDollar,
        close: doubleDollar,
        closed: true,
      },
    ],
    rendererNodes: ['math'],
    validator: 'allow',
  },
  {
    name: 'a fence inside list then blockquote remains code',
    markdown: nestedListFence,
    expectedSegments: [
      { kind: 'prose', raw: '- > ' },
      { kind: 'code', raw: nestedListFence.slice(4) },
    ],
    rendererNodes: ['code'],
    validator: 'allow',
  },
  {
    name: 'an unclosed fence inside list then blockquote owns code to EOF',
    markdown: unclosedNestedListFence,
    expectedSegments: [
      { kind: 'prose', raw: '- > ' },
      { kind: 'code', raw: unclosedNestedListFence.slice(4) },
    ],
    rendererNodes: ['code'],
    validator: 'allow',
  },
  {
    name: 'a flow opener on an active list continuation inherits list ownership',
    markdown: activeListContinuationFlow,
    expectedSegments: [
      { kind: 'prose', raw: '- item\n\n  ' },
      {
        kind: 'math',
        raw: `${doubleDollar}\n  ${rawTex}\n  ${doubleDollar}`,
        content: rawTex,
        open: doubleDollar,
        close: doubleDollar,
        closed: true,
      },
    ],
    rendererNodes: ['math'],
    validator: 'allow',
  },
  {
    name: 'an active list continuation exits unclosed before an outer dollar fence',
    markdown: activeListContinuationExit,
    expectedSegments: [
      { kind: 'prose', raw: '- item\n\n  ' },
      {
        kind: 'math',
        raw: `${doubleDollar}\n  ${rawTex}`,
        content: rawTex,
        open: doubleDollar,
        close: '',
        closed: false,
      },
      { kind: 'prose', raw: '\noutside prose\n' },
      {
        kind: 'math',
        raw: doubleDollar,
        content: '',
        open: doubleDollar,
        close: '',
        closed: false,
      },
    ],
    rendererNodes: ['math', 'math'],
    validator: 'reject',
  },
  {
    name: 'a quote then list marked blank retains the active list for a flow opener',
    markdown: quoteListBlankContinuationFlow,
    expectedSegments: [
      { kind: 'prose', raw: '> - item\n>\n>   ' },
      {
        kind: 'math',
        raw: `${doubleDollar}\n>   ${rawTex}\n>   ${doubleDollar}`,
        content: rawTex,
        open: doubleDollar,
        close: doubleDollar,
        closed: true,
      },
    ],
    rendererNodes: ['math'],
    validator: 'allow',
  },
  {
    name: 'nested list quote list ordering survives a marked blank continuation',
    markdown: nestedListQuoteListContinuationFlow,
    expectedSegments: [
      { kind: 'prose', raw: '1. > - item\n   >\n   >   ' },
      {
        kind: 'math',
        raw: `${doubleDollar}\n   >   ${rawTex}\n   >   ${doubleDollar}`,
        content: rawTex,
        open: doubleDollar,
        close: doubleDollar,
        closed: true,
      },
    ],
    rendererNodes: ['math'],
    validator: 'allow',
  },
  {
    name: 'a quote then list continuation exits unclosed before outer prose and math',
    markdown: quoteListContinuationExit,
    expectedSegments: [
      { kind: 'prose', raw: '> - item\n>\n>   ' },
      {
        kind: 'math',
        raw: `${doubleDollar}\n>   ${rawTex}`,
        content: rawTex,
        open: doubleDollar,
        close: '',
        closed: false,
      },
      { kind: 'prose', raw: '\noutside prose\n' },
      {
        kind: 'math',
        raw: doubleDollar,
        content: '',
        open: doubleDollar,
        close: '',
        closed: false,
      },
    ],
    rendererNodes: ['math', 'math'],
    validator: 'reject',
  },
  {
    name: 'a tab-expanded list indent cannot claim three-column outer TeX as closed flow math',
    markdown: tabStoppedListFlowExit,
    expectedSegments: [
      { kind: 'prose', raw: `- ${TAB}` },
      {
        kind: 'math',
        raw: doubleDollar,
        content: '',
        open: doubleDollar,
        close: '',
        closed: false,
      },
      { kind: 'prose', raw: `\n   ${rawTex}\n   ` },
      {
        kind: 'math',
        raw: doubleDollar,
        content: '',
        open: doubleDollar,
        close: '',
        closed: false,
      },
    ],
    rendererNodes: ['math', 'math'],
    validator: 'reject',
  },
  {
    name: 'an EOL-only blank list item owns its indented fence only to the container exit',
    markdown: eolBlankListFenceExit,
    expectedSegments: [
      { kind: 'prose', raw: '-\n  ' },
      { kind: 'code', raw: `${tripleBacktick}text\n  literal` },
      { kind: 'prose', raw: `\noutside ${rawTex}\n  ` },
      { kind: 'code', raw: tripleBacktick },
    ],
    rendererNodes: ['code', 'code'],
    validator: 'reject',
  },
  {
    name: 'an EOL-only ordered item ends unclosed math before outer prose and math',
    markdown: eolBlankOrderedMathExit,
    expectedSegments: [
      { kind: 'prose', raw: '1.\n   ' },
      {
        kind: 'math',
        raw: `${doubleDollar}\n   ${rawTex}`,
        content: rawTex,
        open: doubleDollar,
        close: '',
        closed: false,
      },
      { kind: 'prose', raw: '\noutside prose\n' },
      {
        kind: 'math',
        raw: doubleDollar,
        content: '',
        open: doubleDollar,
        close: '',
        closed: false,
      },
    ],
    rendererNodes: ['math', 'math'],
    validator: 'reject',
  },
]
