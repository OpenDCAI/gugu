import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';

export function diffTheme(dark: boolean) {
  return [EditorView.theme({
    '&': { color: 'var(--foreground)', backgroundColor: 'var(--monaco-bg)', fontSize: '13px' },
    '.cm-scroller': { fontFamily: 'var(--em-font-mono)', lineHeight: '20px', scrollbarWidth: 'thin' },
    '.cm-content': { padding: '8px 0' },
    '.cm-line': { padding: '0 4px' },
    '.cm-gutters': { backgroundColor: 'var(--monaco-gutter)', color: 'var(--monaco-line-number)', border: 'none' },
    '.cm-lineNumbers .cm-gutterElement': { minWidth: '2ch' },
    '.cm-cursor': { borderLeftColor: 'var(--monaco-fg)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--monaco-selection-bg)' },
    '.cm-activeLine': { backgroundColor: 'var(--monaco-line-highlight)' },
    '.cm-merge-a .cm-changedLine, &.cm-merge-a .cm-changedLine, .cm-deletedChunk': { backgroundColor: 'var(--monaco-removed-line-bg)' },
    '.cm-merge-b .cm-changedLine, &.cm-merge-b .cm-changedLine, .cm-inlineChangedLine': { backgroundColor: 'var(--monaco-inserted-line-bg)' },
    '&.cm-merge-a .cm-changedText, .cm-deletedText': { background: 'var(--monaco-removed-text-bg)' },
    '&.cm-merge-b .cm-changedText': { background: 'var(--monaco-inserted-text-bg)' },
    '&.cm-merge-a .cm-changedLineGutter, .cm-deletedLineGutter': { backgroundColor: 'var(--foreground-diff-deleted)' },
    '&.cm-merge-b .cm-changedLineGutter': { backgroundColor: 'var(--foreground-diff-added)' },
    '.cm-inlineChangedLineGutter': { backgroundColor: 'var(--foreground-diff-modified)' },
    '.cm-deletedChunk': { userSelect: 'text' },
    '.cm-panels': { backgroundColor: 'transparent', color: 'var(--monaco-fg)' },
    // Find floats over the text like Monaco's find widget, so the split sides stay aligned while searching.
    '.cm-panels-top': { height: 0, overflow: 'visible', borderBottom: 'none' },
    '.cm-panel.cm-search': {
      position: 'absolute', top: '6px', right: '16px', maxWidth: 'calc(100% - 32px)', padding: '4px 24px 4px 8px',
      backgroundColor: 'var(--monaco-bg)', border: '1px solid var(--border)', borderRadius: '6px', boxShadow: 'var(--shadow-popover)',
      fontFamily: 'inherit', fontSize: '12px',
    },
    '.cm-panel.cm-search label': { fontSize: '12px', color: 'var(--foreground-muted)' },
    '.cm-textfield': { backgroundColor: 'var(--monaco-bg)', color: 'var(--monaco-fg)', border: '1px solid var(--border)', borderRadius: '4px', fontSize: '12px' },
    '.cm-button': { backgroundImage: 'none', backgroundColor: 'transparent', color: 'var(--monaco-fg)', border: '1px solid var(--border)', borderRadius: '4px', fontSize: '12px' },
    '.cm-button:hover': { backgroundColor: 'var(--background-2)' },
    '.cm-mergeSpacer': { background: 'repeating-linear-gradient(-45deg, transparent 0 4px, var(--background-2) 4px 6px)' },
    '.cm-mergeView &.cm-merge-b': { borderLeft: '1px solid var(--border)' },
  }, { dark }), syntaxHighlighting(HighlightStyle.define([
    // Same token roles as the Monaco file editor's vs / vs-dark palette, so a file reads the same in both.
    { tag: [tags.keyword, tags.bool, tags.null], color: 'var(--blue-11)' },
    { tag: [tags.string, tags.regexp], color: 'var(--red-11)' },
    { tag: [tags.number, tags.comment], color: 'var(--green-11)' },
    { tag: [tags.typeName, tags.className], color: 'var(--cyan-11)' },
  ]))];
}
