// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { loadPage, until } from './fake-file-service';
import { mapProxy, mergeValue } from './json-proxy';

/**
 * 摩擦单 F8 (+ F43b): collaborative text inside a JSON file. Declared when it is created — `gugu.text(s)`, which is
 * `{ $text: s }`, the form the file service builds a Y.Text from (an agent writes the same). Read back it is a plain
 * string; `f.textAt(path)` is a text handle on it (the verbs of a text file, bindable). A string assigned to it is merged
 * in as a splice, so writing `data.body = input.value` never quietly ends the collaboration.
 */

type JsonFile = {
  data: Record<string, unknown>;
  toJSON(): Record<string, unknown>;
  textAt(path: (string | number)[]): TextField;
  close(): void;
};
type TextField = {
  text: string;
  status: string;
  insert(index: number, text: string): void;
  onChange(handler: (event: { local: boolean; delta?: unknown }) => void): () => boolean;
};

/** Replicas that sync by hand, each with the App's view of the data (`f.data`). */
function replicas(count: number, seed: (root: Y.Map<unknown>) => void) {
  const hub = new Y.Doc();
  hub.transact(() => seed(hub.getMap('root')));
  const docs = Array.from({ length: count }, (_, i) => {
    const doc = new Y.Doc();
    doc.clientID = i + 1;
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(hub));
    return doc;
  });
  const sync = () => {
    for (let round = 0; round < 2; round += 1) {
      for (const doc of docs) {
        Y.applyUpdate(hub, Y.encodeStateAsUpdate(doc, Y.encodeStateVector(hub)));
        Y.applyUpdate(doc, Y.encodeStateAsUpdate(hub, Y.encodeStateVector(doc)));
      }
    }
  };
  const data = (doc: Y.Doc) => mapProxy(doc.getMap('root'), () => true);
  return { hub, docs, sync, data };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('collaborative text in a JSON file (摩擦单 F8)', () => {
  it('{ $text } is stored as collaborative text and read back as a plain string', () => {
    const { docs, data } = replicas(1, () => undefined);
    data(docs[0]!).notes = { $text: 'hi' };
    expect(docs[0]!.getMap('root').get('notes')).toBeInstanceOf(Y.Text);
    expect(data(docs[0]!).notes).toBe('hi');
    expect(docs[0]!.getMap('root').toJSON()).toEqual({ notes: 'hi' });
    // An object that merely has a $text among other keys is an ordinary object.
    data(docs[0]!).other = { $text: 'x', more: 1 };
    expect(docs[0]!.getMap('root').get('other')).toBeInstanceOf(Y.Map);
  });

  it('a string assigned to it is merged in by splice: two people typing in the second half keep their letters while a third rewrites the start', () => {
    const run = (assign: (doc: Y.Doc, next: string) => void) => {
      const { docs, sync, data } = replicas(3, (root) => root.set('body', new Y.Text('hello wide world')));
      const [a, b, c] = docs as [Y.Doc, Y.Doc, Y.Doc];
      const text = (doc: Y.Doc) => doc.getMap('root').get('body') as Y.Text;
      text(a).insert('hello wide world'.length, ' again'); // A, at the end
      text(b).insert('hello wide '.length, 'big '); // B, in the second half
      const current = data(c).body as string; // C read it, and writes back a new start
      assign(c, `HELLO${current.slice(5)}`);
      sync();
      return (a.getMap('root').get('body') as Y.Text | string).toString();
    };
    expect(run((doc, next) => (mapProxy(doc.getMap('root'), () => true).body = next))).toBe('HELLO wide big world again');
    // Control: a plain replacement of the value (what it would be without the rule) loses both.
    expect(run((doc, next) => doc.getMap('root').set('body', next))).toBe('HELLO wide world');
  });

  it('F43b, negative control: the same field created as text by two at once — one of them is lost (a value: last writer wins)', () => {
    const { docs, sync } = replicas(2, () => undefined);
    const [a, b] = docs as [Y.Doc, Y.Doc];
    a.getMap('root').set('notes', new Y.Text('A typed this'));
    b.getMap('root').set('notes', new Y.Text('B typed this'));
    sync();
    expect([(a.getMap('root').get('notes') as Y.Text).toString()]).not.toEqual(expect.arrayContaining(['A typed thisB typed this']));
    expect(['A typed this', 'B typed this']).toContain((a.getMap('root').get('notes') as Y.Text).toString());
    // Declared with its entry (keyed by id), as the guide says: nothing collides, both stay.
    const second = replicas(2, (root) => root.set('slides', new Y.Map()));
    const [c, d] = second.docs as [Y.Doc, Y.Doc];
    (second.data(c).slides as Record<string, unknown>)['id-c'] = { body: { $text: 'C typed' } };
    (second.data(d).slides as Record<string, unknown>)['id-d'] = { body: { $text: 'D typed' } };
    second.sync();
    const slides = c.getMap('root').get('slides') as Y.Map<Y.Map<Y.Text>>;
    expect(slides.get('id-c')?.get('body')?.toString()).toBe('C typed');
    expect(slides.get('id-d')?.get('body')?.toString()).toBe('D typed');
  });

  it('a whole value written back (a replay after compaction) keeps the text inside it collaborative', () => {
    const doc = new Y.Doc();
    const root = doc.getMap('root');
    const slide = new Y.Map<unknown>();
    slide.set('body', new Y.Text('old'));
    root.set('slide', slide);
    mergeValue(root, 'slide', { body: 'new', title: 'T' });
    expect((root.get('slide') as Y.Map<unknown>).get('body')).toBeInstanceOf(Y.Text);
    expect(root.toJSON()).toEqual({ slide: { body: 'new', title: 'T' } });
  });
});

describe('an assignment writes into what is there — one rule with the file service’s applyJson (统筹 04:04 / 04:06)', () => {
  it('an object over a map merges by key: the spread idiom keeps what another added meanwhile', () => {
    const run = (assign: (doc: Y.Doc) => void) => {
      const { docs, sync, data } = replicas(2, (root) => {
        const slides = new Y.Map<unknown>();
        slides.set('s1', 'one');
        root.set('slides', slides);
      });
      const [a, b] = docs as [Y.Doc, Y.Doc];
      (data(b).slides as Record<string, unknown>).s2 = 'two'; // B adds, A has not seen it yet
      assign(a);
      sync();
      return (a.getMap('root').get('slides') as Y.Map<unknown>).toJSON();
    };
    expect(run((a) => (mapProxy(a.getMap('root'), () => true).slides = { ...(mapProxy(a.getMap('root'), () => true).slides as object), s3: 'three' }))).toEqual({
      s1: 'one',
      s2: 'two',
      s3: 'three',
    });
    // Control: the whole map replaced (what an assignment did before) loses B's entry.
    const replaced = run((a) => {
      const whole = new Y.Map<unknown>();
      whole.set('s1', 'one');
      whole.set('s3', 'three');
      a.getMap('root').set('slides', whole);
    });
    expect(replaced).not.toHaveProperty('s2');
  });

  it('= {} clears the keys it could see; one added meanwhile stays (add wins)', () => {
    const { docs, sync, data } = replicas(2, (root) => {
      const votes = new Y.Map<unknown>();
      votes.set('alice', 1);
      root.set('votes', votes);
    });
    const [a, b] = docs as [Y.Doc, Y.Doc];
    (data(b).votes as Record<string, unknown>).bob = 2;
    data(a).votes = {};
    sync();
    expect((a.getMap('root').get('votes') as Y.Map<unknown>).toJSON()).toEqual({ bob: 2 });
  });

  it('merged, the maps and collaborative text inside keep who they are — an array too, element by element', () => {
    const { docs, data } = replicas(1, (root) => {
      const slide = (title: string) => {
        const map = new Y.Map<unknown>();
        map.set('title', title);
        map.set('body', new Y.Text(`${title} body`));
        return map;
      };
      const list = new Y.Array<unknown>();
      list.push([slide('one'), slide('two'), slide('three')]);
      root.set('list', list);
    });
    const doc = docs[0]!;
    const list = () => doc.getMap('root').get('list') as Y.Array<Y.Map<unknown>>;
    const before = list().toArray().map((slide) => [slide, slide.get('body')]);
    const view = data(doc);
    view.list = (view.list as { title: string; body: string }[]).map((slide) => (slide.title === 'two' ? { ...slide, title: 'TWO' } : slide));
    const after = list().toArray().map((slide) => [slide, slide.get('body')]);
    expect(after).toEqual(before); // the same Y.Map and Y.Text objects, in place
    expect(list().get(1).get('title')).toBe('TWO');
    expect(list().get(1).get('body')).toBeInstanceOf(Y.Text);
  });

  it('$text: over existing text it merges in (the same text); over a plain string it makes collaborative text', () => {
    const { docs, data } = replicas(1, (root) => {
      root.set('body', new Y.Text('hello'));
      root.set('title', 'plain');
    });
    const doc = docs[0]!;
    const body = doc.getMap('root').get('body');
    data(doc).body = { $text: 'hello!' };
    expect(doc.getMap('root').get('body')).toBe(body);
    expect(String(body)).toBe('hello!');
    data(doc).title = { $text: 'plain' };
    expect(doc.getMap('root').get('title')).toBeInstanceOf(Y.Text);
  });

  it('the same value again is not written (it would claim the key for nothing)', () => {
    const { docs, data } = replicas(1, (root) => root.set('n', 5));
    const doc = docs[0]!;
    let updates = 0;
    doc.on('update', () => (updates += 1));
    data(doc).n = 5;
    expect(updates).toBe(0);
    data(doc).n = 6;
    expect(updates).toBe(1);
  });
});

describe('f.textAt(path) on an open JSON file', () => {
  async function page() {
    const loaded = await loadPage<JsonFile>('json');
    const doc = loaded.service.docOf('item-1@1');
    doc.transact(() => {
      const slide = new Y.Map<unknown>();
      slide.set('title', 'Intro');
      slide.set('body', new Y.Text('hello'));
      const slides = new Y.Map<unknown>();
      slides.set('s1', slide);
      doc.getMap('root').set('slides', slides);
    });
    const file = await loaded.open();
    await until(() => JSON.stringify(file.toJSON()).includes('hello'));
    const serverBody = () => ((doc.getMap('root').get('slides') as Y.Map<Y.Map<unknown>>).get('s1')!.get('body') as Y.Text);
    return { ...loaded, file, serverBody };
  }

  it('a text handle: its letters edited in place, others’ letters heard as a delta', async () => {
    const { file, serverBody } = await page();
    const body = file.textAt(['slides', 's1', 'body']);
    expect(body.text).toBe('hello');
    const heard: unknown[] = [];
    body.onChange((event) => heard.push(event));
    body.insert(5, ' world');
    await until(() => serverBody().toString() === 'hello world');
    serverBody().insert(0, '>> ');
    await until(() => body.text === '>> hello world');
    expect(heard).toContainEqual({ local: false, delta: [{ insert: '>> ' }] });
    expect((file.data.slides as Record<string, { body: string }>).s1!.body).toBe('>> hello world');
  });

  it('says what it takes: a plain string is not collaborative text (make it so when creating it); a missing field; a bad path', async () => {
    const { file } = await page();
    expect(() => file.textAt(['slides', 's1', 'title'])).toThrow(expect.objectContaining({ code: 'invalid', message: expect.stringContaining('gugu.text') }));
    expect(() => file.textAt(['slides', 'nope', 'body'])).toThrow(expect.objectContaining({ code: 'invalid' }));
    expect(() => file.textAt('slides.s1.body' as never)).toThrow(expect.objectContaining({ code: 'invalid' }));
  });

  it('the field replaced by another value: the handle reads gone and says so once', async () => {
    const { file } = await page();
    const body = file.textAt(['slides', 's1', 'body']);
    const heard: unknown[] = [];
    body.onChange((event) => heard.push(event));
    (file.data.slides as Record<string, Record<string, unknown>>).s1!.body = 42;
    expect(body.status).toBe('gone');
    expect(heard).toEqual([{ local: true }]);
  });

  it('bind.text on it: typing goes into the field, the others’ letters come out', async () => {
    const { file, serverBody, bindText } = await page();
    const field = document.createElement('textarea');
    document.body.append(field);
    bindText(field, file.textAt(['slides', 's1', 'body']));
    expect(field.value).toBe('hello');
    field.focus();
    field.setSelectionRange(5, 5);
    field.value = 'hello!';
    field.setSelectionRange(6, 6);
    field.dispatchEvent(new Event('input'));
    await until(() => serverBody().toString() === 'hello!');
    serverBody().insert(0, 'B: ');
    await until(() => field.value === 'B: hello!');
    expect(field.selectionStart).toBe(9);
  });
});
