// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { loadPage, until } from './fake-file-service';

/**
 * `gugu.bind.text` (摩擦单 F59, L7 S12 rerun): the agent used snapshot/applyFrom and still lost letters — B 3, A its own
 * 20 — through three rules an App has to remember (base = what is drawn; no redraw with input pending or while
 * composing; the caret carried as an anchor). The binding keeps them. The file service here is the in-test one; B is
 * the other person typing through it.
 */

type TextFile = { text: string; saved: boolean; close(): void; onChange(handler: (event: { local: boolean }) => void): () => boolean };

const START = '# Notes\nfirst line\nsecond line\n';
const B_TYPES = 'fifteen letters'; // 15
const A_COMPOSES = 'αβγδε'; // 5, through an input method
const A_TYPES = 'fifteen more ok'; // 15

async function page() {
  const loaded = await loadPage<TextFile>('text');
  loaded.service.write('item-1@1', START);
  const file = await loaded.open();
  await until(() => file.text === START);
  return { ...loaded, file };
}

/** A person typing into a textarea: the value changes at the caret, then `input` fires (as a browser does). */
function typeInto(field: HTMLTextAreaElement, text: string) {
  const at = field.selectionStart;
  field.value = field.value.slice(0, at) + text + field.value.slice(field.selectionEnd);
  field.setSelectionRange(at + text.length, at + text.length);
  field.dispatchEvent(new Event('input'));
}

/** B types one letter at a time on the second line, each reaching A's replica before the next. */
async function bTypes(service: Awaited<ReturnType<typeof page>>['service'], file: TextFile, letters: string, done: string) {
  for (const letter of letters) {
    const at = service.text('item-1@1').indexOf(' line\n', service.text('item-1@1').indexOf('second'));
    service.insertAt('item-1@1', at, letter);
    const expect = service.text('item-1@1');
    await until(() => file.text === expect || file.text.includes(done));
  }
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('gugu.bind.text on a <textarea> (one line)', () => {
  it('L7 S12: A composes and types while B types on another line — B 15/15, A 20/20, and A’s caret stays at A’s letters', async () => {
    const { service, file, bindText } = await page();
    const field = document.createElement('textarea');
    document.body.append(field);
    const unbind = bindText(field, file);
    expect(field.value).toBe(START);
    field.focus();
    const lineEnd = START.indexOf('\n', START.indexOf('first'));
    field.setSelectionRange(lineEnd, lineEnd);

    // A composes 5 letters; B's letters arrive meanwhile — never drawn into the middle of a composition.
    field.dispatchEvent(new Event('compositionstart'));
    for (const letter of A_COMPOSES) typeInto(field, letter);
    await bTypes(service, file, B_TYPES.slice(0, 7), B_TYPES.slice(0, 7));
    expect(field.value).not.toContain(B_TYPES.slice(0, 7));
    field.dispatchEvent(new Event('compositionend'));
    expect(field.value).toContain(B_TYPES.slice(0, 7));

    // Then A types 15 more, one key at a time, with B's letters landing between them.
    const rest = B_TYPES.slice(7);
    for (let i = 0; i < A_TYPES.length; i += 1) {
      typeInto(field, A_TYPES[i]!);
      if (i < rest.length) await bTypes(service, file, rest[i]!, B_TYPES.slice(0, 8 + i));
    }
    await until(() => service.text('item-1@1') === file.text && file.saved);
    const final = service.text('item-1@1');
    expect(final).toBe(`# Notes\nfirst line${A_COMPOSES}${A_TYPES}\nsecond${B_TYPES} line\n`);
    expect(field.value).toBe(final);
    // A's caret is where A stopped typing: after A's 20 letters, whatever B put elsewhere.
    expect(field.selectionStart).toBe(final.indexOf(A_TYPES) + A_TYPES.length);
    unbind();
  });

  it('control — what the L7 App did: redraw on every remote change, commit after a 90 ms pause by diffing against f.text', async () => {
    const { service, file } = await page();
    const field = document.createElement('textarea');
    document.body.append(field);
    field.value = file.text;
    field.focus();
    const lineEnd = START.indexOf('\n', START.indexOf('first'));
    field.setSelectionRange(lineEnd, lineEnd);
    const handle = file as TextFile & { insert(i: number, s: string): void; delete(i: number, n: number): void };
    let pending: ReturnType<typeof setTimeout> | null = null;
    const commitByDiff = () => {
      pending = null;
      const now = handle.text;
      const next = field.value;
      let start = 0;
      while (start < now.length && start < next.length && now[start] === next[start]) start += 1;
      let endNow = now.length;
      let endNext = next.length;
      while (endNow > start && endNext > start && now[endNow - 1] === next[endNext - 1]) {
        endNow -= 1;
        endNext -= 1;
      }
      if (endNow > start) handle.delete(start, endNow - start);
      if (endNext > start) handle.insert(start, next.slice(start, endNext));
    };
    field.addEventListener('input', () => {
      if (pending) clearTimeout(pending);
      pending = setTimeout(commitByDiff, 90);
    });
    file.onChange(({ local }) => {
      if (!local) field.value = handle.text; // the whole page redrawn, A's uncommitted letters with it
    });
    for (let i = 0; i < A_TYPES.length; i += 1) {
      typeInto(field, A_TYPES[i]!);
      if (i < B_TYPES.length) await bTypes(service, file, B_TYPES[i]!, B_TYPES.slice(0, i + 1));
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    const final = service.text('item-1@1');
    const aKept = [...A_TYPES].filter((_, i) => final.includes(A_TYPES.slice(0, i + 1))).length;
    const bKept = final.includes(B_TYPES) ? B_TYPES.length : 0;
    // As L7 saw it: letters lost.
    expect(aKept + bKept).toBeLessThan(A_TYPES.length + B_TYPES.length);
  });

  it('a change before the caret moves it along; a remote change with nothing typed keeps the caret on its letter', async () => {
    const { service, file, bindText } = await page();
    const field = document.createElement('textarea');
    document.body.append(field);
    bindText(field, file);
    field.focus();
    const at = START.indexOf('line', START.indexOf('second'));
    field.setSelectionRange(at, at);
    service.insertAt('item-1@1', 0, '>> ');
    await until(() => field.value.startsWith('>> '));
    expect(field.selectionStart).toBe(at + 3);
    // Control: a change after the caret leaves it where it is.
    service.insertAt('item-1@1', service.text('item-1@1').length, 'tail');
    await until(() => field.value.endsWith('tail'));
    expect(field.selectionStart).toBe(at + 3);
  });
});

describe('gugu.bind.text on a view the App draws', () => {
  it('a contenteditable whose serialization round-trips: typed text goes in, others’ comes out', async () => {
    const { service, file, bindText } = await page();
    const element = document.createElement('div');
    element.contentEditable = 'true';
    document.body.append(element);
    const view = {
      element,
      read: () => element.textContent ?? '',
      render: (text: string) => {
        element.textContent = text;
      },
      selection: () => null,
    };
    bindText(view, file);
    expect(element.textContent).toBe(START);
    element.textContent = `${START}typed`;
    element.dispatchEvent(new Event('input'));
    await until(() => service.text('item-1@1').endsWith('typed'));
    service.insertAt('item-1@1', 0, 'B ');
    await until(() => (element.textContent ?? '').startsWith('B '));
    expect(element.textContent).toBe(`B ${START}typed`);
  });

  it('a view that does not give back what it was given is told so, once (it would rewrite others’ formatting)', async () => {
    const { host, file, bindText } = await page();
    const element = document.createElement('div');
    document.body.append(element);
    let shown = '';
    const view = {
      element,
      read: () => shown.replace(/\*/g, '_'),
      render: (text: string) => {
        shown = text;
      },
      selection: () => null,
    };
    const handle = file as TextFile & { insert(i: number, s: string): void };
    handle.insert(0, '*x* ');
    bindText(view, file);
    handle.insert(0, '*y* ');
    // What such a view does to others' text is exactly what it is told about: `*x*` comes back `_x_`.
    await until(() => shown.includes('y') && handle.text.includes('_x_'));
    const said = host.reportError.mock.calls.filter(([message]) => String(message).includes('round-trip'));
    expect(said).toHaveLength(1);
  });

  it('says what it takes', async () => {
    const { file, bindText } = await page();
    expect(() => bindText({}, file)).toThrow(expect.objectContaining({ code: 'invalid' }));
    expect(() => bindText(document.createElement('textarea'), {})).toThrow(expect.objectContaining({ code: 'invalid' }));
  });
});
