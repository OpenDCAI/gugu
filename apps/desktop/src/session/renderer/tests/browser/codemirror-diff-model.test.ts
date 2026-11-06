import { EditorState } from '@codemirror/state';
import { getChunks } from '@codemirror/merge';
import { EditorView, runScopeHandlers } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';
import { createDiffController } from '@renderer/lib/codemirror/diff-controller';
import { bindModel } from '@renderer/lib/codemirror/model-binding';
import { TextModel } from '@renderer/lib/text-model/text-model';
import { isMacHost } from '@shared/host-os';

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.reverse().forEach(dispose => dispose()); cleanups.length = 0; });
const mod = { [isMacHost() ? 'metaKey' : 'ctrlKey']: true };

function setup(content: string) {
  const model = new TextModel('file:///x.txt', 'plaintext', content);
  const view = (readOnly = false) => {
    const parent = document.body.appendChild(document.createElement('div'));
    const editor = new EditorView({ parent, state: EditorState.create({ doc: model.doc, extensions: EditorState.readOnly.of(readOnly) }) });
    const unbind = bindModel(editor, model);
    cleanups.push(() => { unbind(); editor.destroy(); parent.remove(); });
    return editor;
  };
  return { model, view };
}

describe('CM views share the workspace model', () => {
  it('updates the initiating and other views only after the model change, with one undo stack', () => {
    const { model, view } = setup('base');
    const source = view();
    const other = view();
    const order: string[] = [];
    // Registered after both view subscriptions: every model event has updated both projections.
    cleanups.push(model.onDidChange(() => order.push(`${model.getValue()}|${source.state.doc}|${other.state.doc}`)));
    source.dispatch({ selection: { anchor: 4 } });
    source.dispatch({ changes: { from: 4, insert: ' one' }, selection: { anchor: 8 } });
    expect(order).toEqual(['base one|base one|base one']);
    expect(source.state.selection.main.head).toBe(8);
    // An edit typed in the other view (the file editor while the diff is open) lands in the same history.
    other.dispatch({ changes: { from: 0, insert: 'two ' }, selection: { anchor: 4 }, userEvent: 'input.type' });
    expect(source.state.doc.toString()).toBe('two base one');
    expect(model.undo(other)).toBe(true);
    expect(source.state.doc.toString()).toBe('base one');
    // The cursor comes back only in the view that undid.
    expect(other.state.selection.main.head).toBe(0);
    expect(model.undo(source)).toBe(true);
    expect(source.state.doc.toString()).toBe('base');
    expect(other.state.doc.toString()).toBe('base');
    expect(source.state.selection.main.head).toBe(4);
    expect(model.redo(source)).toBe(true);
    expect(other.state.doc.toString()).toBe('base one');
  });

  it('typing a word is one undo step, as it was in the old editor', () => {
    const { model, view } = setup('');
    const editor = view();
    for (const [i, ch] of [...'word'].entries()) editor.dispatch({ changes: { from: i, insert: ch }, selection: { anchor: i + 1 }, userEvent: 'input.type' });
    expect(model.getValue()).toBe('word');
    model.undo(editor);
    expect(model.getValue()).toBe('');
  });

  it('keeps CRLF and UTF-16 coordinates consistent', () => {
    const { model, view } = setup('一\r\n😀tail\r\nend');
    const source = view();
    source.dispatch({ changes: { from: source.state.doc.line(2).from + 2, insert: '中\n文' } });
    expect(model.getValue()).toBe('一\r\n😀中\r\n文tail\r\nend');
    model.edit({ from: source.state.doc.line(3).from + 1, to: source.state.doc.line(4).from, insert: '!' });
    expect(source.state.doc.toString()).toBe('一\n😀中\n文!end');
    expect(model.getValue()).toBe('一\r\n😀中\r\n文!end');
  });

  it('rejects user document changes on a read-only side while accepting model refreshes', () => {
    const { model, view } = setup('old');
    const left = view(true);
    left.dispatch({ changes: { from: 0, to: 3, insert: 'wrong' } });
    expect(model.getValue()).toBe('old');
    expect(left.state.doc.toString()).toBe('old');
    model.setValue('new\r\nref');
    expect(left.state.doc.toString()).toBe('new\nref');
    expect(model.getValue()).toBe('new\r\nref');
  });
});

describe('CM diff controller', () => {
  for (const style of ['split', 'unified'] as const) {
    it(`${style}: edits round-trip through the model and keep the diff current`, () => {
      const original = new TextModel(`git://cm-${style}/x.txt`, 'plaintext', 'a\nb\n');
      const modified = new TextModel(`file:///cm-${style}/x.txt`, 'plaintext', 'a\nb\n');
      const parent = document.body.appendChild(document.createElement('div'));
      parent.style.height = '200px';
      let saves = 0;
      const controller = createDiffController({
        parent, original, modified, style, language: [], dark: false, saved: undefined, save: () => { saves++; },
      });
      cleanups.push(() => { controller.destroy(); parent.remove(); });
      const views = [...parent.querySelectorAll<HTMLElement>('.cm-editor')].map(dom => EditorView.findFromDOM(dom)!);
      const right = views[views.length - 1]!;
      expect(getChunks(right.state)?.chunks.length).toBe(0);

      right.dispatch({ changes: { from: 0, insert: 'X' }, userEvent: 'input.type' });
      expect(modified.getValue()).toBe('Xa\nb\n');
      expect(getChunks(right.state)?.chunks.length).toBe(1);

      runScopeHandlers(right, new KeyboardEvent('keydown', { key: 'z', ...mod }), 'editor');
      expect(right.state.doc.toString()).toBe('a\nb\n');
      expect(getChunks(right.state)?.chunks.length).toBe(0);

      original.setValue('a\nc\n');
      expect(getChunks(right.state)?.chunks.length).toBe(1);
      if (style === 'split') {
        const left = views[0]!;
        // Read-only, yet still focusable for selection, copy and find.
        expect(left.contentDOM.getAttribute('aria-readonly')).toBe('true');
        expect(left.contentDOM.contentEditable).toBe('true');
        left.dispatch({ changes: { from: 0, insert: 'no' } });
        expect(original.getValue()).toBe('a\nc\n');
        expect(left.state.doc.toString()).toBe('a\nc\n');
      }

      runScopeHandlers(right, new KeyboardEvent('keydown', { key: 's', ...mod }), 'editor');
      expect(saves).toBe(1);
      expect(controller.snapshot().modified.ranges).toHaveLength(1);
    });
  }
});
