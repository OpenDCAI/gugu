// @vitest-environment jsdom
import { APP_RUNTIME_GLUE_MODULE } from '@shared/extensions/app-runtime-protocol';
import { describe, expect, it, vi } from 'vitest';
import { extensionTemplate } from './extension-templates';

/**
 * F11 The group-json skeleton is code an agent builds on, so it has to run as written: the page it writes, gugu's
 * glue.js (glue-entry.ts) and app.js against a fake `window.gugu` (the file handed over, its status and refusals, the
 * group's members), each one run fresh. glue.js is imported anew for each page; app.js runs as the body of an async
 * function, its one import line taking glue's exports.
 */
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...params: string[]
) => (...args: unknown[]) => Promise<unknown>;

type Listener = (value: never) => void;
function fakeFile(data: Record<string, unknown>) {
  const on: Record<string, Listener[]> = { change: [], status: [], refused: [], presence: [] };
  return {
    file: {
      data,
      toJSON: () => JSON.parse(JSON.stringify(data)),
      transact: (fn: () => void) => fn(),
      onChange: (fn: Listener) => (on.change.push(fn), () => {}),
      onStatus: (fn: Listener) => (on.status.push(fn), () => {}),
      onRefused: (fn: Listener) => (on.refused.push(fn), () => {}),
      presence: { self: { userId: 'user:u-me', name: 'B' }, others: [], onChange: (fn: Listener) => (on.presence.push(fn), () => {}) },
    },
    emit: (kind: string, value: unknown) => on[kind]!.forEach((fn) => fn(value as never)),
  };
}

const MEMBERS = [
  { id: 'user:u-me', name: 'B', kind: 'human' },
  { id: 'user:u-bot', name: 'Helper', kind: 'agent' },
];
// Where the page is, by default: a group's page opened on one of its files (真源原则 13: ctx.chat, ctx.file).
const CHAT = { id: 'chat-1', name: 'G', kind: 'group', groupId: 'chat-1', members: MEMBERS };
const IN_CHAT = { chat: CHAT, file: { chat: 'chat-1', id: 'item-1' } };
const IN_SESSION = { session: { id: 'task-1' } };
let contextChanged: (context: unknown) => void = () => {};
let lastGlue: Record<string, unknown> = {};

async function load(open: () => Promise<unknown>, locale = 'en', context: Record<string, unknown> = IN_CHAT) {
  const { files } = extensionTemplate('group-json', { id: 'dinner-vote', name: 'Dinner vote' });
  const page = new DOMParser().parseFromString(files['main.html']!, 'text/html');
  document.body.innerHTML = page.body.innerHTML;
  delete document.body.dataset.file;
  const gugu = {
    getContext: async () => ({ locale, ...context }),
    onContextChanged: (fn: (context: unknown) => void) => ((contextChanged = fn), () => {}),
    files: { open: vi.fn(open) },
  };
  Object.assign(globalThis, { gugu });
  // As a page imports it: once per page, its top-level await opening the page's file.
  vi.resetModules();
  const glue = { ...(await import('../../../../../src/session/app-runtime/glue-entry')) } as Record<string, unknown>;
  lastGlue = glue;
  const imports = new RegExp(`^import \\{ (.+) \\} from '${APP_RUNTIME_GLUE_MODULE.replaceAll('.', '\\.')}'(?: //.*)?$`, 'm');
  expect(files['app.js']).toMatch(imports);
  return new AsyncFunction('glue', files['app.js']!.replace(imports, 'const { $1 } = glue'))(glue);
}
const status = () => document.getElementById('status')!;

describe('group-json template: the skeleton runs as written', () => {
  // F75 (S19): glue's $ was getElementById; the agent wrote $('#board'), got null, and six installs failed the check.
  it('$ and $$ are document.querySelector / querySelectorAll, as agents write them', async () => {
    await load(async () => fakeFile({}).file);
    const { $, $$ } = lastGlue as { $: (selector: string) => Element | null; $$: (selector: string) => Element[] };
    expect($('#shared')).toBe(document.getElementById('shared'));
    expect($('shared'), 'an id without # is a tag name, as with querySelector').toBe(null);
    expect($$('main section').map((element) => element.id)).toEqual(['shared', 'controls']);
  });

  // 摩擦单 F64(S6):agent 把群里谁都能改的标题直接拼进 innerHTML —— 脚本在 CSP 下跑不起来,HTML 却能被注入(伪造一个按钮)。
  // glue 的 html`…` 默认转义每个 ${…};骨架就用它画,安全的写法是最顺手的写法。
  it('F64: what someone typed goes in as text — a <b> or a <button> in the data is shown, not drawn', async () => {
    const { file } = fakeFile({ question: 'Friday? <button id="fake">Pay</button> <b>now</b>', votes: {} });
    await load(async () => file);
    const shared = document.getElementById('shared')!;
    expect(shared.querySelector('#fake'), 'no button made from the data').toBeNull();
    expect(shared.querySelector('pre b')).toBeNull();
    expect(shared.textContent).toContain('<button id=\\"fake\\">Pay</button> <b>now</b>');
    const { html } = lastGlue as { html: (strings: TemplateStringsArray, ...values: unknown[]) => { markup: string } };
    const name = '<img src=x onerror=alert(1)>';
    expect(html`<li>${name}</li>`.markup).toBe('<li>&#60;img src=x onerror=alert(1)&#62;</li>');
    // Markup made with html`…` nests as markup, alone or in an array.
    expect(html`<ul>${[html`<li>${'a&b'}</li>`, html`<li>${'c'}</li>`]}</ul>`.markup).toBe('<ul><li>a&#38;b</li><li>c</li></ul>');
  });

  // 摩擦单 F113 (S23 re-run, 10-01): the board App wrote html`<ul>${cards.map((c) => html`<li>…`).join('')}</ul>`; the
  // joined string went in as text, and every card showed as its own source. Joining is the mistake, so it throws there,
  // with the fix in its message — the check reads it, and nothing is drawn wrong in the meantime.
  it('F113: html`…` joined into a string throws, saying how to put it in, instead of showing its source', async () => {
    await load(async () => fakeFile({}).file);
    const { html, render } = lastGlue as { html: (strings: TemplateStringsArray, ...values: unknown[]) => unknown; render: (el: Element, markup: unknown) => void };
    const rows = ['Buy milk', 'Call A'].map((card) => html`<li>${card}</li>`);
    const list = document.createElement('ul');
    let thrown: unknown;
    try {
      render(list, html`${rows.join('')}`);
    } catch (error) {
      thrown = error;
    }
    expect(list.textContent, 'the cards are not shown as their source').toBe('');
    expect(String(thrown)).toContain('put it in as it is, an array of them too');
    expect(() => `<ul>${rows[0]}</ul>`, 'added to a string').toThrow('never joined');

    render(list, html`${rows}`);
    expect([...list.children].map((li) => li.textContent)).toEqual(['Buy milk', 'Call A']);
  });

  it('opens the handed file, draws it, and redraws on every change', async () => {
    const { file, emit } = fakeFile({ question: 'Friday?', votes: {} });
    await load(async () => file);
    expect(document.getElementById('shared')!.textContent).toContain('"question": "Friday?"');
    // F42: "me" is the server-stamped self.name — the skeleton never asks the person for it.
    expect(document.querySelector('#shared p')!.textContent).toBe('Me: B');
    (file.data.votes as Record<string, number>)['u-me'] = 1;
    emit('change', { local: true });
    expect(document.getElementById('shared')!.textContent).toContain('"u-me": 1');
    expect(status().textContent).toBe('');
    // An empty status line stays in the accessibility tree (a live region hidden and shown again is missed by some readers).
    expect(status().hidden).toBe(false);
  });

  // 摩擦单 F34(L7-l,S13 问卷):A 提交后 23 ms,B 填了一半的名字、勾选、备注全被清空 —— render 把整张表单重建了。
  // 骨架分两块:onChange 只重画 #shared;#controls 里人正在填的东西只画一次,别人改文件时原地不动。
  it("someone else's change redraws the shared view, and what this person is typing stays", async () => {
    const { file, emit } = fakeFile({ answers: {} });
    await load(async () => file);
    // What an agent's setup() puts in #controls, half filled in by this person.
    const name = Object.assign(document.createElement('input'), { value: 'B, half-typed' });
    const agree = Object.assign(document.createElement('input'), { type: 'checkbox', checked: true });
    document.getElementById('controls')!.append(name, agree);
    name.focus();

    (file.data.answers as Record<string, string>)['u-a'] = 'A submitted';
    emit('change', { local: false });
    emit('presence', undefined);

    expect(document.getElementById('shared')!.textContent).toContain('"u-a": "A submitted"');
    expect(document.getElementById('controls')!.contains(name)).toBe(true);
    expect(name.value).toBe('B, half-typed');
    expect(agree.checked).toBe(true);
    expect(document.activeElement).toBe(name);
  });

  // L11 review R1: a draft of two boxes, as the skeleton's setup() writes it — the second being filled in when someone
  // else changes the file. In #controls both keep what this person typed; in render()'s area only the focused one would
  // (the test below pins that), so the first would be cleared — F34 back again.
  it('two draft boxes in #controls: filling in the second while the file changes, the first keeps its value', async () => {
    const { file, emit } = fakeFile({ answers: {} });
    await load(async () => file);
    const [first, second] = [document.createElement('input'), document.createElement('input')];
    document.getElementById('controls')!.append(first, second);
    first.value = 'first, typed';
    second.focus();
    second.value = 'second, half-typed';

    (file.data.answers as Record<string, string>)['u-a'] = 'A submitted';
    emit('change', { local: false });

    expect(document.getElementById('shared')!.textContent).toContain('"u-a": "A submitted"');
    expect(first.value).toBe('first, typed');
    expect(second.value).toBe('second, half-typed');
    expect(document.activeElement).toBe(second);
  });

  it('says offline and gone; a refused change is the runtime\'s to say, not the page\'s (A6)', async () => {
    const { file, emit } = fakeFile({});
    await load(async () => file, 'zh-CN');
    emit('status', 'offline');
    expect(status().textContent).not.toBe('');
    expect(status().textContent).toContain('离线');
    emit('status', 'gone');
    expect(status().getAttribute('role'), "an error is said as one: role=alert, which the host's look draws").toBe('alert');
    emit('status', 'online');
    expect(status().textContent).toBe('');
    emit('refused', { reason: 'too-large' });
    expect(status().textContent).toBe('');
  });

  // 摩擦单 F101 (L5, 2 of 3 with Codex): app.js drew its page as one body.innerHTML, #status went with it, and the first
  // status glue.js said threw "Cannot set properties of null (setting 'hidden')" — the check refused the install.
  it('the App redraws the whole body: the status line is made again and says offline and gone', async () => {
    const { file, emit } = fakeFile({});
    await load(async () => file);
    document.body.innerHTML = '<div id="board"><p>my own page</p></div>';
    emit('status', 'offline');
    expect(status().textContent).toContain('Offline');
    expect(status().textContent).not.toBe('');
    expect(document.body.firstElementChild).toBe(status());
    expect(document.getElementById('board')!.textContent).toBe('my own page');
    emit('status', 'gone');
    expect(status().getAttribute('role'), "an error is said as one: role=alert, which the host's look draws").toBe('alert');
    // F92 on a page with no #app: still out of reach (the parent set inert on #app only, and there is none).
    expect(document.body.inert).toBe(true);
    document.body.replaceChildren();
    emit('status', 'offline');
    expect(status().textContent).toContain('Offline');
    expect(document.querySelectorAll('#status')).toHaveLength(1);
  });

  // 摩擦单 F92 (S23): after `rm TODO.md` the old board still looked usable and a drag did nothing, and in a task it said
  // "you left its group".
  it('gone: what is shown is dimmed and out of reach, and said as where the page is; back online, usable again', async () => {
    const app = () => document.body;
    const inSession = fakeFile({});
    await load(async () => inSession.file, 'zh-CN', { ...IN_SESSION, file: { session: 'task-1', id: 'TODO.md' } });
    inSession.emit('status', 'gone');
    expect(status().textContent).toContain('在磁盘上被删了');
    expect(status().textContent).not.toContain('群');
    expect(app().inert).toBe(true);
    expect(document.body.dataset.file).toBe('gone');
    // A task's file put back on the disk comes back online.
    inSession.emit('status', 'online');
    expect(app().inert).toBe(false);
    expect(document.body.dataset.file).toBe('online');
    expect(status().textContent).toBe('');

    const inGroup = fakeFile({});
    await load(async () => inGroup.file);
    inGroup.emit('status', 'gone');
    expect(status().textContent).toBe('This file is gone: it was deleted, or you left its chat.');
    expect(app().inert).toBe(true);
  });

  // 摩擦单 F95 (S23): the agent moved its claim to the task's TODO.md, and the page still said "Open a .todo-kanban.json
  // file" — a suffix glue.js had made from the id. What it names now is what the manifest claims, where the page is.
  it('opened with no file (not-found): names what the manifest claims here, as the manifest says it now', async () => {
    const unasked = vi.fn(async () => ({}));
    const manifest = { contributes: { tabs: extensionTemplate('group-json', { id: 'dinner-vote', name: 'Dinner vote' }).tabs } };
    const fetch = vi.fn(async (url: string) => ({ json: async () => (url === 'manifest.json' ? manifest : {}) }));
    vi.stubGlobal('fetch', fetch);
    try {
      await expect(load(unasked, 'en', { chat: CHAT })).rejects.toMatchObject({ code: 'not-found' });
      expect(status().textContent).toBe("No file is open here: click a .dinner-vote.json file in the chat's folder to open it with this App.");

      // The agent re-claims: TODO.md in a task. Nothing in glue.js changes, and the page says the new claim.
      manifest.contributes.tabs = [{ name: 'main', title: 'Board', entry: 'main.html', opensFiles: { session: ['TODO.md', '.todo.md'] } }];
      await expect(load(unasked, 'zh-CN', IN_SESSION)).rejects.toMatchObject({ code: 'not-found' });
      expect(status().textContent).toBe('这个页面没有打开文件：在文件列表里点 TODO.md 或一个 .todo.md 文件，用这个 App 打开。');

      // What it claims nowhere here, or a manifest it cannot read, is not made up.
      await expect(load(unasked, 'en', { chat: CHAT })).rejects.toMatchObject({ code: 'not-found' });
      expect(status().textContent).toBe('No file is open here.');
      fetch.mockRejectedValueOnce(new Error('offline'));
      await expect(load(unasked, 'en', IN_SESSION)).rejects.toMatchObject({ code: 'not-found' });
      expect(status().textContent).toBe('No file is open here.');
      expect(unasked).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // 摩擦单 F104 (L7-u, S20): B had typed "12" (for 129) into SKU-00001's price when A changed another row; the App redrew
  // the table with innerHTML, B's input went, and its half value was written as a change (26 ms later it was in the file).
  const table = async (prices: Record<string, number>) => {
    const { file } = fakeFile({ prices });
    await load(async () => file);
    const { render, html } = lastGlue as unknown as {
      render: (el: Element, markup: unknown) => void;
      html: (strings: TemplateStringsArray, ...values: unknown[]) => unknown;
    };
    const shared = document.getElementById('shared')!;
    const draw = () =>
      render(shared, html`<table>${Object.entries(prices).map(([sku, price]) => html`<tr data-key="${sku}"><td>${sku}</td><td><input value="${price}"></td></tr>`)}</table>`);
    // As the App wrote it: a price goes into the file on change.
    shared.addEventListener('change', (event) => {
      const input = event.target as HTMLInputElement;
      prices[input.closest('tr')!.dataset.key!] = Number(input.value);
    });
    draw();
    const input = (sku: string) => shared.querySelector<HTMLInputElement>(`tr[data-key="${sku}"] input`)!;
    const keys = () => [...shared.querySelectorAll('tr')].map((row) => row.dataset.key);
    return { draw, input, keys, shared, render };
  };

  it('render(el, html`…`): the input someone is typing in stays theirs through a redraw, and the rest is updated', async () => {
    const prices = { 'SKU-00001': 100, 'SKU-00002': 200 };
    const { draw, input } = await table(prices);
    const b = input('SKU-00001');
    b.focus();
    b.value = '12';
    b.dispatchEvent(new Event('input', { bubbles: true }));

    prices['SKU-00002'] = 250; // A, another row
    draw();
    expect(input('SKU-00001')).toBe(b);
    expect(document.activeElement).toBe(b);
    expect(b.value).toBe('12');
    expect(prices['SKU-00001']).toBe(100); // the half value is not a change
    expect(input('SKU-00002').value).toBe('250');

    b.value = '129';
    b.dispatchEvent(new Event('change', { bubbles: true })); // B is done
    expect(prices['SKU-00001']).toBe(129);
    draw();
    expect(b.value).toBe('129');
    b.blur();
    prices['SKU-00001'] = 130; // someone else, once B has left it
    draw();
    expect(b.value).toBe('130');
  });

  it('render: rows move around the one in use, one gone from the data waits until it is left; a string goes in as text', async () => {
    const prices: Record<string, number> = { a: 1, b: 2, c: 3 };
    const { draw, input, keys, shared, render } = await table(prices);
    const b = input('b');
    b.focus();
    b.value = '20';
    const reordered = { c: 3, b: 2, a: 1 };
    for (const key of Object.keys(prices)) delete prices[key];
    Object.assign(prices, reordered);
    draw();
    expect(keys()).toEqual(['c', 'b', 'a']);
    expect(document.activeElement).toBe(b);
    delete prices.b;
    draw();
    // Still there, still focused, its value B's; the others in order around it.
    expect(keys().filter((key) => key !== 'b')).toEqual(['c', 'a']);
    expect(input('b')).toBe(b);
    expect(document.activeElement).toBe(b);
    expect(b.value).toBe('20');
    b.blur();
    draw();
    expect(keys()).toEqual(['c', 'a']);
    render(shared, '<b>not markup</b>');
    expect(shared.querySelector('b')).toBeNull();
    expect(shared.textContent).toBe('<b>not markup</b>');
  });

  // 抽卡台 0.3.0 (10-10): a step clicked with a real mouse has the focus, and its redraw — class, aria-pressed, label —
  // was skipped with the input's; a script's .click() gives no focus, so only the mouse showed it.
  it('render: a focused button is redrawn — only the control being typed in is kept', async () => {
    const { shared, render } = await table({});
    const html = lastGlue.html as (strings: TemplateStringsArray, ...values: unknown[]) => unknown;
    const step = (on: boolean) => html`<button data-key="s1" class="${on ? 'step on' : 'step'}" aria-pressed="${String(on)}">${on ? 'Step 1 ✓' : 'Step 1'}</button>`;
    render(shared, step(false));
    const button = shared.querySelector('button')!;
    button.focus();
    render(shared, step(true));
    expect(shared.querySelector('button')).toBe(button);
    expect(document.activeElement).toBe(button);
    expect(button.className).toBe('step on');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.textContent).toBe('Step 1 ✓');
  });

  // Review 153: after a real click on 「选这张」 the card kept 「选这张」 and lost 「批注」 — the focused button was neither
  // taken out nor redrawn. Keyed, it goes; keyless, the same <button> becomes the new one.
  it('render: a focused button the markup no longer has is taken out, or redrawn as the button in its place', async () => {
    const { shared, render } = await table({});
    const html = lastGlue.html as (strings: TemplateStringsArray, ...values: unknown[]) => unknown;
    const card = (picked: boolean) =>
      html`<div data-key="c1">${picked ? html`<button data-key="note">批注</button>` : html`<button data-key="pick">选这张</button><button data-key="note">批注</button>`}</div>`;
    render(shared, card(false));
    shared.querySelector<HTMLButtonElement>('[data-key="pick"]')!.focus();
    render(shared, card(true));
    expect([...shared.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['批注']);

    const keyless = (picked: boolean) => html`<p>${picked ? html`<button>批注</button>` : html`<button>选这张</button>`}</p>`;
    render(shared, keyless(false));
    shared.querySelector('button')!.focus();
    render(shared, keyless(true));
    expect([...shared.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['批注']);
  });

  // Review 154: a vote cast from the keyboard re-sorts the list; the voter's row is put in order by moving the others
  // around it — moved itself, its button would drop the focus to the page.
  it('render: rows re-sorted around the one whose button has the focus — it keeps the focus', async () => {
    const { shared, render } = await table({});
    const html = lastGlue.html as (strings: TemplateStringsArray, ...values: unknown[]) => unknown;
    const rows = (order: string[]) => html`<ul>${order.map((k) => html`<li data-key="${k}"><button id="b${k}">${k}</button></li>`)}</ul>`;
    const order = () => [...shared.querySelectorAll('li')].map((li) => li.dataset.key);
    render(shared, rows(['A', 'B', 'C']));
    const a = shared.querySelector<HTMLButtonElement>('#bA')!;
    a.focus();
    render(shared, rows(['C', 'A', 'B']));
    expect(order()).toEqual(['C', 'A', 'B']);
    expect(document.activeElement).toBe(a);
    render(shared, rows(['B', 'C', 'A']));
    expect(order()).toEqual(['B', 'C', 'A']);
    expect(document.activeElement).toBe(a);
  });

  // Review 154: a checkbox clicked has the focus too, and is not typed in — its checked and class follow the file.
  it('render: a focused checkbox follows the markup', async () => {
    const { shared, render } = await table({});
    const html = lastGlue.html as (strings: TemplateStringsArray, ...values: unknown[]) => unknown;
    const box = (on: boolean) => (on ? html`<input type="checkbox" data-key="done" class="on" checked>` : html`<input type="checkbox" data-key="done" class="off">`);
    render(shared, box(false));
    const checkbox = shared.querySelector<HTMLInputElement>('input')!;
    checkbox.focus();
    checkbox.checked = true; // ticked by the person (no change event: this table's handler is for its price inputs)
    render(shared, box(true));
    expect(checkbox.className).toBe('on');
    expect(checkbox.checked).toBe(true);
    render(shared, box(false)); // someone else unticks it
    expect(document.activeElement).toBe(checkbox);
    expect(checkbox.className).toBe('off');
    expect(checkbox.checked).toBe(false);
  });

  // Smell audit A8 / R1: why setup() keeps a person's own boxes (a draft, a gugu.bind.text box) out of render()'s area.
  // A box whose value is not its markup's is, when nobody is in it, given the markup's value on the next redraw — here
  // written empty; the one someone is in is left alone.
  it('render: a box whose value is not in its markup (a draft, a bind.text box) is written with the markup value when nobody is in it', async () => {
    const { shared, render } = await table({});
    const markup = () => (lastGlue.html as (strings: TemplateStringsArray, ...values: unknown[]) => unknown)`<input id="title">`;
    render(shared, markup());
    const box = shared.querySelector<HTMLInputElement>('#title')!;
    box.value = 'typed by others, through bind.text';
    render(shared, markup());
    expect(box.value).toBe('');
    box.focus();
    box.value = 'mine, being typed';
    render(shared, markup());
    expect(box.value).toBe('mine, being typed');
  });

  // L4's review: rows were matched by searching the old rows for each new one — sorted S20's catalogue, 2000 × 1000
  // key lookups on one redraw. Counted, not timed: a few lookups a row now, whatever the order.
  it('render: 2000 rows sorted the other way redraw with each old row looked at a few times, not once per row', async () => {
    const prices: Record<string, number> = Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`SKU-${i}`, i]));
    const { draw, input, keys } = await table(prices);
    const first = input('SKU-0');
    const sorted = Object.entries(prices).reverse();
    for (const key of Object.keys(prices)) delete prices[key];
    Object.assign(prices, Object.fromEntries(sorted), { 'SKU-1999': -1 });
    const getAttribute = vi.spyOn(Element.prototype, 'getAttribute');
    try {
      draw();
      expect(getAttribute.mock.calls.length).toBeLessThan(2000 * 20);
    } finally {
      getAttribute.mockRestore();
    }
    expect(input('SKU-0')).toBe(first);
    expect(keys()[0]).toBe('SKU-1999');
    expect(input('SKU-1999').value).toBe('-1');
  });

  // 摩擦单 F49(L6 S8 r2):ctx.chat.members 已经有三个人,agent 却在数据里另建了 members 表 —— 骨架从没把人引到那儿。
  it('who is in the group comes from the context, and follows it — nothing about them goes into the file', async () => {
    const { file } = fakeFile({ votes: {} });
    await load(async () => file);
    // Each one a row with their <gugu-avatar> (the host draws the face and name: ui.js, not loaded here).
    const here = () => [...document.querySelectorAll('#shared ul.list > li gugu-avatar[name]')].map((element) => element.getAttribute('user'));
    expect(here()).toEqual(['user:u-me', 'user:u-bot']);
    contextChanged({ locale: 'en', chat: { ...CHAT, members: [...MEMBERS, { id: 'user:u-c', name: 'C', kind: 'human' }] } });
    expect(here()).toEqual(['user:u-me', 'user:u-bot', 'user:u-c']);
    expect(file.toJSON()).toEqual({ votes: {} });
  });
});

// F55 (S1: the first request wrote ~4.4k tokens, app.js ~1k) What the agent writes is its part only.
describe('group-json template: app.js is the agent\'s part, gugu\'s glue.js the fixed part', () => {
  // App作用域 10-05: an app.js importing ./glue.js from a bundle without it was a blank page; #6914's copies kept
  // reading taskId. The host serves it: nothing of it in the bundle to be missing or to fall behind.
  it('opening the file, the status line and its words are gugu\'s glue.js, not in the bundle; app.js imports what it uses', () => {
    const { files, tabs } = extensionTemplate('group-json', { id: 'dinner-vote', name: 'Dinner vote' });
    expect(tabs).toEqual([{ name: 'main', title: 'Dinner vote', entry: 'main.html', opensFiles: { chat: ['.dinner-vote.json'] } }]);
    expect(Object.keys(files).sort()).toEqual(['app.js', 'main.html', 'style.css']);
    expect(files['app.js']).toContain(`import { f, me, myName, $, $$, html, render } from '${APP_RUNTIME_GLUE_MODULE}'`);
    expect(files['app.js']).not.toContain('gugu.files.open(');
    expect(files['app.js']).not.toMatch(/onStatus|onRefused|离线/);
    expect(files['app.js']!.split('\n').length).toBeLessThanOrEqual(45);
  });

  // L6 S7: the App sent each event to every agent of the group, and owner and non-owner did the same work twice.
  it('send is shown to one agent, the one the event concerns — never all agents of the group', () => {
    const { files } = extensionTemplate('group-json', { id: 'board', name: 'Board' });
    expect(files['app.js']).toContain("gugu.send(card.owner, 'Card \"…\" is yours', { refs: [{ file: f.entry }] })");
    expect(files['app.js']).toContain('never every agent');
    expect(files['app.js']).not.toMatch(/kind === 'agent'\)\.forEach|for \(const \w+ of members/);
  });
});

