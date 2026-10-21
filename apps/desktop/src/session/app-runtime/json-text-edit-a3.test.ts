// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { applyEdit, buildDoc, readText } from '@gugu/files-core/content';
import { fileOpened, loadPage, until } from './fake-file-service';

/**
 * A3: a JSON file has a text face — `f.text` is what an agent reads (indented two spaces, as the file service shows it) and
 * `f.edit(old, new)` is the file service's own edit on it (`@gugu/files-core`'s `applyEdit`), so an App's tool edits a JSON
 * file exactly as an agent's edit does: the same cases come out the same.
 */

type JsonFile = {
  text: string;
  data: Record<string, unknown>;
  toJSON(): Record<string, unknown>;
  edit(old: string, next: string): void;
};

async function page(access: 'rw' | 'ro' = 'rw') {
  const loaded = await loadPage<JsonFile>('json');
  if (access === 'ro') loaded.host.appFiles.open.mockResolvedValueOnce({ ...fileOpened('json'), access: 'ro' });
  const doc = loaded.service.docOf('item-1@1');
  doc.transact(() => {
    const root = doc.getMap('root');
    root.set('title', 'Q3');
    const prices = new Y.Map<unknown>();
    prices.set('widget', 12);
    prices.set('gadget', 30);
    root.set('prices', prices);
    root.set('notes', new Y.Text('typed together'));
  });
  const file = await loaded.open();
  await until(() => file.toJSON().notes === 'typed together');
  return { file, doc };
}

/** What the file service answers to the same edit on the same text: a code, and the text after. */
function serviceAnswer(text: string, old: string, next: string): { code: string; text: string } {
  const doc = buildDoc('application/json', text);
  const { status, body } = applyEdit(doc, 'application/json', old, next, 1024 * 1024);
  const error = (body as { error?: string }).error;
  const code = status === 200 ? 'ok' : error === 'invalid-json' ? 'invalid' : String(error);
  return { code, text: readText(doc, 'application/json', { pretty: true }) };
}

describe('a JSON file\'s text face (A3)', () => {
  it('f.text is the file as an agent reads it: two-space indented, collaborative text as its letters', async () => {
    const { file, doc } = await page();
    expect(file.text).toBe(readText(doc, 'application/json', { pretty: true }));
    expect(file.text).toContain('\n  "prices": {\n    "widget": 12,');
  });

  it('f.edit(old, new) answers each case as the file service does — and changes nothing unless it answers ok', async () => {
    const { file } = await page();
    // Each case on the text as it is by then (the first one changes it).
    const cases: ((text: string) => [string, string])[] = [
      () => ['"widget": 12', '"widget": 15'], // one place
      () => [': ', ':'], // several places
      () => ['"nope"', '"x"'], // not there
      () => ['"title": "Q3",', '"title": "Q3"'], // would break the JSON
      (text) => [text, '[1, 2]'], // would not be an object
      () => ['"gadget": 30', `"gadget": "${'y'.repeat(1024 * 1024)}"`], // past 1 MiB
    ];
    for (const at of cases) {
      const before = file.text;
      const [old, next] = at(before);
      const want = serviceAnswer(before, old, next);
      let code = 'ok';
      try {
        file.edit(old, next);
      } catch (error) {
        code = (error as { code: string }).code;
      }
      expect(code, `${old.slice(0, 20)} → ${next.slice(0, 20)}`).toBe(want.code);
      expect(JSON.parse(file.text)).toEqual(JSON.parse(code === 'ok' ? want.text : before));
    }
    expect((file.data.prices as Record<string, unknown>).widget).toBe(15);
  });

  it('a read-only handle reads the text and refuses the edit, the file untouched', async () => {
    const { file, doc } = await page('ro');
    const before = readText(doc, 'application/json', { pretty: true });
    expect(file.text).toBe(before);
    expect(() => file.edit('"widget": 12', '"widget": 15')).toThrow(expect.objectContaining({ code: 'read-only' }));
    expect(file.text).toBe(before);
    expect(readText(doc, 'application/json', { pretty: true })).toBe(before);
  });

  it('an edit reaches the file, and text people type in together stays collaborative text', async () => {
    const { file, doc } = await page();
    file.edit('"typed together"', '"typed together, still"');
    const notes = () => doc.getMap('root').get('notes');
    await until(() => String(notes()) === 'typed together, still');
    expect(notes()).toBeInstanceOf(Y.Text);
  });
});
