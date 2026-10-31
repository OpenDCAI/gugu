import { EditorState, Text } from '@codemirror/state';
import { getChunks } from '@codemirror/merge';
import { EditorView, runScopeHandlers } from '@codemirror/view';
import * as monaco from 'monaco-editor';
import { afterEach, describe, expect, it } from 'vitest';
import { createDiffController } from '@renderer/lib/codemirror/diff-controller';
import { bindModel } from '@renderer/lib/codemirror/model-binding';
import { modelPosition } from '@renderer/lib/codemirror/model-position';

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.reverse().forEach(dispose => dispose()); cleanups.length = 0; });

function setup(content: string) {
  const model = monaco.editor.createModel(content, 'plaintext');
  cleanups.push(() => model.dispose());
  const view = (readOnly = false) => {
    const parent = document.body.appendChild(document.createElement('div'));
    const editor = new EditorView({ parent, state: EditorState.create({
      doc: Text.of(model.getLinesContent()), extensions: EditorState.readOnly.of(readOnly),
    }) });
    const unbind = bindModel(editor, model, monaco);
    cleanups.push(() => { unbind(); editor.destroy(); parent.remove(); });
    return editor;
  };
  return { model, view };
}

describe('CM diff shares the workspace model', () => {
  it('updates the initiating and other views only after the model change, with one undo stack', async () => {
    const { model, view } = setup('base');
    const source = view();
    const other = view();
    const order: string[] = [];
    // Registered after both view subscriptions: every model event has updated both projections.
    const listener = model.onDidChangeContent(() => order.push(`${model.getValue()}|${source.state.doc}|${other.state.doc}`));
    cleanups.push(() => listener.dispose());
    source.dispatch({ changes: { from: 4, insert: ' one' }, selection: { anchor: 8 } });
    expect(order).toEqual(['base one|base one|base one']);
    expect(source.state.selection.main.head).toBe(8);
    model.pushStackElement();
    // This represents an edit from the still-native ordinary file editor.
    model.pushEditOperations(null, [{ range: new monaco.Range(1, 1, 1, 1), text: 'two ' }], () => null);
    expect(source.state.doc.toString()).toBe('two base one');
    expect(other.state.doc.toString()).toBe('two base one');
    model.pushStackElement();
    await model.undo();
    expect(source.state.doc.toString()).toBe('base one');
    await model.undo();
    expect(source.state.doc.toString()).toBe('base');
    expect(other.state.doc.toString()).toBe('base');
    await model.redo();
    expect(source.state.doc.toString()).toBe('base one');
    expect(other.state.doc.toString()).toBe('base one');
  });

  it('keeps CRLF and UTF-16 coordinates consistent for edits from either engine', () => {
    const { model, view } = setup('一\r\n😀tail\r\nend');
    const source = view();
    source.dispatch({ changes: { from: modelPosition(source.state.doc, { lineNumber: 2, column: 3 }), insert: '中\r\n文' } });
    expect(model.getValue()).toBe('一\r\n😀中\r\n文tail\r\nend');
    model.pushEditOperations(null, [{ range: new monaco.Range(3, 2, 4, 1), text: '!' }], () => null);
    expect(source.state.doc.toString()).toBe('一\n😀中\n文!end');
    expect(modelPosition(source.state.doc, source.state.doc.line(2).from + 2)).toEqual({ lineNumber: 2, column: 3 });
  });

  it('rejects user document changes on a read-only side while accepting model refreshes', () => {
    const { model, view } = setup('old');
    const left = view(true);
    left.dispatch({ changes: { from: 0, to: 3, insert: 'wrong' } });
    expect(model.getValue()).toBe('old');
    expect(left.state.doc.toString()).toBe('old');
    model.setValue('new\r\nref');
    expect(left.state.doc.toString()).toBe('new\nref');
  });
});

describe('CM diff controller', () => {
  for (const style of ['split', 'unified'] as const) {
    it(`${style}: edits round-trip through the model and keep the diff current`, () => {
      const original = monaco.editor.createModel('a\nb\n', 'plaintext', monaco.Uri.parse(`git://cm-${style}/x.txt`));
      const modified = monaco.editor.createModel('a\nb\n', 'plaintext', monaco.Uri.parse(`file:///cm-${style}/x.txt`));
      const parent = document.body.appendChild(document.createElement('div'));
      parent.style.height = '200px';
      let saves = 0;
      const controller = createDiffController({
        parent, monaco, original, modified, style, language: [], dark: false, saved: undefined, save: () => { saves++; },
      });
      cleanups.push(() => { controller.destroy(); parent.remove(); original.dispose(); modified.dispose(); });
      const views = [...parent.querySelectorAll<HTMLElement>('.cm-editor')].map(dom => EditorView.findFromDOM(dom)!);
      const right = views[views.length - 1]!;
      expect(getChunks(right.state)?.chunks.length).toBe(0);

      right.dispatch({ changes: { from: 0, insert: 'X' }, userEvent: 'input.type' });
      expect(modified.getValue()).toBe('Xa\nb\n');
      expect(getChunks(right.state)?.chunks.length).toBe(1);

      modified.pushEditOperations(null, [{ range: new monaco.Range(1, 1, 1, 2), text: '' }], () => null);
      expect(right.state.doc.toString()).toBe('a\nb\n');
      expect(getChunks(right.state)?.chunks.length).toBe(0);

      original.setValue('a\nc\n');
      expect(getChunks(right.state)?.chunks.length).toBe(1);
      if (style === 'split') {
        const left = views[0]!;
        // Read-only, yet still focusable for selection, copy and find (like Monaco's original side).
        expect(left.contentDOM.getAttribute('aria-readonly')).toBe('true');
        expect(left.contentDOM.contentEditable).toBe('true');
        left.dispatch({ changes: { from: 0, insert: 'no' } });
        expect(original.getValue()).toBe('a\nc\n');
        expect(left.state.doc.toString()).toBe('a\nc\n');
      }

      runScopeHandlers(right, new KeyboardEvent('keydown', { key: 's', ctrlKey: true }), 'editor');
      expect(saves).toBe(1);
      expect(controller.snapshot().modified.ranges).toHaveLength(1);
    });
  }
});
