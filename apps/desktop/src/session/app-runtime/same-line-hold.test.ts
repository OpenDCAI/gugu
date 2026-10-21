// @vitest-environment jsdom
import { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { loadPage, until } from './fake-file-service';
import { imeHold, sameLineHold } from './ime-hold';

/**
 * L1 角度三: on the EditContext path a remote update is held only when it lands on the caret's line before the caret —
 * there it still shifts what the IME sees (4/9 compositions broken on the phone, 0/7 with this) — and everything else
 * stays live. Measured on WebView 133 with real fcitx5 taps; these pin the rules down.
 */

const DOC = 'line one\nline two\nline three\n';
const LINE_TWO = DOC.indexOf('line two');
const CARET = LINE_TWO + 'line two'.length;

const height = (h: number) => {
  Object.defineProperty(window, 'innerHeight', { value: h, configurable: true });
  window.dispatchEvent(new Event('resize'));
};

/** Where the text lives: the file's own text, or a field of a JSON file (`f.textAt(path)`: a Y.Text nested in a map). */
type Where = 'file' | 'field';
const textOf = (doc: Y.Doc, where: Where): Y.Text =>
  where === 'file' ? doc.getText('content') : (doc.getMap('root').get('notes') as Y.Text);

/** What SyncLink keeps per file: every binding's inspector is asked (`single` = the first version, one per file). */
function registry(single = false) {
  const inspectors = new Set<(update: Uint8Array) => void>();
  const inspect = (fn: (update: Uint8Array) => void) => {
    if (single) inspectors.clear();
    inspectors.add(fn);
    return () => {
      inspectors.delete(fn);
    };
  };
  return { inspect, show: (update: Uint8Array) => [...inspectors].forEach((fn) => fn(update)), size: () => inspectors.size };
}

/** The binding's view of it: a replica, an editor showing it, the hold, and a collaborator whose edits arrive as updates. */
function setup(options: { editContext?: boolean; focused?: boolean; keyboardUp?: boolean; where?: Where } = {}) {
  const { editContext = true, focused = true, keyboardUp = true, where = 'file' } = options;
  height(800);
  const replica = new Y.Doc();
  if (where === 'field') replica.getMap('root').set('notes', new Y.Text());
  const text = textOf(replica, where);
  text.insert(0, DOC);
  const view = new EditorView({ parent: document.body, doc: DOC });
  if (editContext) Object.defineProperty(view.contentDOM, 'editContext', { value: new EventTarget(), configurable: true });
  Object.defineProperty(view, 'hasFocus', { value: focused, configurable: true });
  const link = { depth: 0, acquired: 0 };
  const hold = imeHold(view, () => {
    link.depth += 1;
    link.acquired += 1;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      link.depth -= 1;
    };
  });
  if (keyboardUp) height(420);
  let inspector: ((update: Uint8Array) => void) | null = null;
  const stop = sameLineHold(view, text, (fn) => {
    inspector = fn;
    return () => {
      inspector = null;
    };
  }, hold);
  view.dispatch({ selection: { anchor: CARET } });
  const remote = new Y.Doc();
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(replica));
  /** The collaborator edits; the update is shown to the inspector (as SyncLink does while nothing is held). */
  const arrives = (edit: (t: Y.Text) => void) => {
    let update: Uint8Array | null = null;
    const capture = (u: Uint8Array) => {
      update = u;
    };
    remote.on('update', capture);
    edit(textOf(remote, where));
    remote.off('update', capture);
    inspector?.(update!);
    return update!;
  };
  /** Not held: it reaches the replica and the editor, the caret carried through it (what the provider and yCollab do). */
  const lands = (update: Uint8Array) => {
    const caret = Y.createRelativePositionFromTypeIndex(text, view.state.selection.main.head);
    Y.applyUpdate(replica, update);
    const head = Y.createAbsolutePositionFromRelativePosition(caret, replica)?.index ?? 0;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text.toString() }, selection: { anchor: head } });
  };
  return { view, text, replica, link, arrives, lands, stop, inspecting: () => inspector !== null };
}

describe('sameLineHold: only the caret’s line before the caret is held (EditContext path)', () => {
  beforeEach(() => {
    (globalThis as { __guguIme?: unknown }).__guguIme = undefined;
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('an insert at the start of the caret’s line is held', () => {
    const { link, arrives } = setup();
    arrives((t) => t.insert(LINE_TWO, '7'));
    expect(link.depth).toBe(1);
  });

  it('an insert right at the caret, and a delete before it on the same line, are held', () => {
    const at = setup();
    at.arrives((t) => t.insert(CARET, '7'));
    expect(at.link.depth).toBe(1);
    document.body.innerHTML = '';
    const del = setup();
    del.arrives((t) => t.delete(LINE_TWO + 1, 2));
    expect(del.link.depth).toBe(1);
  });

  it('control: an insert at the end of the line above, a new line above, and one after the caret are not held', () => {
    const { link, arrives, lands } = setup();
    lands(arrives((t) => t.insert(LINE_TWO - 1, '7')));
    lands(arrives((t) => t.insert(0, 'new line\n')));
    lands(arrives((t) => t.insert(t.toString().indexOf('line three'), '7')));
    expect(link.acquired).toBe(0);
  });

  it('positions follow what already landed: after a line was added above, the caret’s line is still found', () => {
    const { link, arrives, lands, view } = setup();
    lands(arrives((t) => t.insert(0, 'first\nsecond\n')));
    expect(view.state.doc.lineAt(view.state.selection.main.head).text).toBe('line two');
    expect(link.acquired).toBe(0);
    arrives((t) => t.insert(t.toString().indexOf('line two'), '7'));
    expect(link.depth).toBe(1);
  });

  it('control: not focused, or the keyboard down, holds nothing even on the caret’s line', () => {
    const blurred = setup({ focused: false });
    blurred.arrives((t) => t.insert(LINE_TWO, '7'));
    expect(blurred.link.acquired).toBe(0);
    document.body.innerHTML = '';
    const down = setup({ keyboardUp: false });
    down.arrives((t) => t.insert(LINE_TWO, '7'));
    expect(down.link.acquired).toBe(0);
  });

  it('DOM path (WebView 113, no EditContext): nothing is inspected — the keyboard-session hold (方案 B) covers it', () => {
    const { link, arrives, inspecting } = setup({ editContext: false });
    expect(inspecting()).toBe(false);
    arrives((t) => t.insert(LINE_TWO, '7'));
    expect(link.acquired).toBe(0);
  });

  it('a field of a JSON file (`f.textAt(path)`, a Y.Text nested in a map) is guarded too', () => {
    const { link, arrives, replica, text } = setup({ where: 'field' });
    // Control: the field is not a top-level type — looked up among those (the first version), nothing was found and nothing guarded.
    expect([...replica.share.values()].some((type) => (type as unknown) === text)).toBe(false);
    arrives((t) => t.insert(LINE_TWO, '7'));
    expect(link.depth).toBe(1);
  });

  it('two editors on one file each guard their own caret (control: one inspector per file — the first editor is not asked)', () => {
    const LINE_THREE_END = DOC.indexOf('line three') + 'line three'.length;
    for (const single of [false, true]) {
      document.body.innerHTML = '';
      height(800);
      const replica = new Y.Doc();
      const text = replica.getText('content');
      text.insert(0, DOC);
      const files = registry(single);
      const bound = (caret: number) => {
        const view = new EditorView({ parent: document.body, doc: DOC });
        Object.defineProperty(view.contentDOM, 'editContext', { value: new EventTarget(), configurable: true });
        Object.defineProperty(view, 'hasFocus', { value: true, configurable: true });
        const link = { depth: 0, acquired: 0 };
        const hold = imeHold(view, () => {
          link.depth += 1;
          link.acquired += 1;
          return () => {
            link.depth -= 1;
          };
        });
        sameLineHold(view, text, files.inspect, hold);
        view.dispatch({ selection: { anchor: caret } });
        return link;
      };
      const first = bound(CARET);
      const second = bound(LINE_THREE_END);
      height(420);
      const remote = new Y.Doc();
      Y.applyUpdate(remote, Y.encodeStateAsUpdate(replica));
      let update: Uint8Array | null = null;
      remote.on('update', (u: Uint8Array) => {
        update = u;
      });
      remote.getText('content').insert(LINE_TWO, '7');
      files.show(update!);
      if (single) {
        expect(first.acquired).toBe(0);
      } else {
        expect(files.size()).toBe(2);
        expect(first.depth).toBe(1);
        expect(second.acquired).toBe(0);
      }
    }
  });

  it('unbinding stops inspecting', () => {
    const { stop, inspecting } = setup();
    expect(inspecting()).toBe(true);
    stop();
    expect(inspecting()).toBe(false);
  });
});

type TextFile = { text: string; close(): void };

describe('SyncLink.inspect: a hold started by the inspector keeps the order of what comes in', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  async function opened() {
    const loaded = await loadPage<TextFile>('text');
    loaded.service.write('item-1@1', 'start\n');
    const file = await loaded.open();
    await until(() => file.text === 'start\n');
    const inner = loaded.internals.get(file)!.internalsForBinding();
    const doc = loaded.internals.get(file)!.doc;
    return { ...loaded, file, inner, doc };
  }

  it('the inspected update is the first one held; the ones after it wait behind it and land in order on release', async () => {
    const { service, file, inner, doc } = await opened();
    let seen = 0;
    let release: (() => void) | null = null;
    inner.inspectRemote(() => {
      seen += 1;
      release ??= inner.holdRemote();
    });
    for (const letter of 'abc') service.write('item-1@1', letter);
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Held from the first one on: none of the three reached the replica, and the inspector was not asked again while held.
    expect(file.text).toBe('start\n');
    expect(seen).toBe(1);
    release!();
    await until(() => file.text === 'start\nabc');
    expect(doc.store.pendingStructs).toBeNull();
  });

  it('every inspector of the file is asked, and one of them holding is enough', async () => {
    const { service, file, inner } = await opened();
    const seen = [0, 0];
    let release: (() => void) | null = null;
    inner.inspectRemote(() => {
      seen[0] += 1;
    });
    inner.inspectRemote(() => {
      seen[1] += 1;
      release ??= inner.holdRemote();
    });
    service.write('item-1@1', 'a');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(seen).toEqual([1, 1]);
    expect(file.text).toBe('start\n');
    release!();
    await until(() => file.text === 'start\na');
  });

  it('an inspector that throws is dropped and reported; the update still reaches the replica', async () => {
    const { service, file, inner, host } = await opened();
    let asked = 0;
    inner.inspectRemote(() => {
      asked += 1;
      throw new Error('boom');
    });
    for (const letter of 'abc') service.write('item-1@1', letter);
    await until(() => file.text === 'start\nabc');
    expect(asked).toBe(1);
    expect(host.reportError).toHaveBeenCalledWith(expect.stringContaining('the same-line hold stopped (boom)'));
  });

  it('control: an inspector that does not hold sees every update, and each lands at once', async () => {
    const { service, file, inner } = await opened();
    let seen = 0;
    inner.inspectRemote(() => {
      seen += 1;
    });
    for (const letter of 'abc') service.write('item-1@1', letter);
    await until(() => file.text === 'start\nabc');
    expect(seen).toBe(3);
  });
});
