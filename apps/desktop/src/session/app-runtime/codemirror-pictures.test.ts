// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fileOpened, loadPage, until } from './fake-file-service';

/**
 * A picture pasted or dropped into a bound editor of a chat's markdown file is saved first, a file in the document's
 * folder (the page's `files.upload`), then named where it was put: `![name](gugu-file://<id>)`. Text pastes as text.
 */

type TextFile = { text: string; close(): void };

beforeAll(() => {
  // jsdom lays nothing out: the editor's measuring reads empty rects.
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
});

afterEach(() => {
  document.body.replaceChildren();
});

/** A paste as the browser hands it to the editor: jsdom has no DataTransfer. */
function paste(target: Element, files: File[], types = files.length > 0 ? ['Files'] : ['text/plain']): Event {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { files, types, getData: () => '' } });
  target.dispatchEvent(event);
  return event;
}

async function bound(path?: string) {
  const { open, host } = await loadPage<TextFile>('text');
  const opened = fileOpened('text');
  if (path) (host.appFiles.open as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ...opened, entry: { ...opened.entry, path } });
  const { codemirror: cm, bindCodemirror } = await import('./codemirror-entry');
  const file = await open();
  const view = new cm.EditorView({ parent: document.body, extensions: [cm.minimalSetup, cm.markdown()] });
  const verbs = {
    upload: vi.fn(async (_place: unknown, files: File[]) => files.map((f, i) => ({ id: `0b6d3a52-5a3e-4b70-9f0e-1d2c3b4a5f6${i}`, name: f.name }))),
    reportError: vi.fn(async (_message: string) => undefined),
  };
  const unbind = bindCodemirror(view, file, verbs);
  return { view, verbs, unbind, file };
}

describe('bind.codemirror: a pasted picture becomes a file of the folder, named in the text', () => {
  it("is uploaded into the document's folder and its link is put where it was pasted, past what was typed meanwhile", async () => {
    const { view, verbs, unbind } = await bound('docs/notes.md');
    view.dispatch({ changes: { from: 0, insert: 'see: ' }, selection: { anchor: 5 } });
    const shot = new File(['png'], 'shot [1].png', { type: 'image/png' });
    paste(view.contentDOM, [shot]);
    view.dispatch({ changes: { from: 0, insert: '> ' } });
    await until(() => view.state.doc.toString().includes('gugu-file://'));
    expect(verbs.upload).toHaveBeenCalledExactlyOnceWith({ chat: 'chat-1', folder: 'docs' }, [shot]);
    expect(view.state.doc.toString()).toBe('> see: ![shot \\[1\\].png](gugu-file://0b6d3a52-5a3e-4b70-9f0e-1d2c3b4a5f60)');
    unbind();
  });

  it('a file at the top goes to the top; text, or a picture with text, is not taken; a failed upload is reported', async () => {
    const { view, verbs, unbind } = await bound();
    paste(view.contentDOM, []);
    paste(view.contentDOM, [new File(['png'], 'a.png', { type: 'image/png' })], ['Files', 'text/plain']);
    paste(view.contentDOM, [new File(['%PDF'], 'a.pdf', { type: 'application/pdf' })]);
    expect(verbs.upload).not.toHaveBeenCalled();
    verbs.upload.mockRejectedValueOnce(new Error('too-large'));
    paste(view.contentDOM, [new File(['png'], 'b.png', { type: 'image/png' })]);
    await until(() => verbs.reportError.mock.calls.length === 1);
    expect(verbs.upload.mock.calls[0]![0]).toEqual({ chat: 'chat-1' });
    expect(verbs.reportError).toHaveBeenCalledWith('too-large');
    expect(view.state.doc.toString()).not.toContain('gugu-file://');
    unbind();
  });
});
