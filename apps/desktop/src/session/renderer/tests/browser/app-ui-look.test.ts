import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cdp, userEvent } from 'vitest/browser';
import tokensCss from '@/styles/tokens.css?raw';
import uiCss from '@/session/app-runtime/ui/ui.css?raw';
import { appPaletteCss } from '@/session/app-runtime/ui/app-palette.mjs';
import { until, untilStable } from '../../../../../../../tests/support/awaitCondition';

/**
 * The look every App page gets (/_gugu/<ver>/ui.css + ui.js, app-runtime/ui), in a real Chromium: the stylesheet as
 * buildAppRuntime writes it (the palette from tokens.css, then ui.css), and ui.js against a fake `window.gugu`.
 * What it proves: the palette follows `context.themeMode`, the elements are drawn, and an App's own CSS wins without
 * `!important` (the whole layer is `@layer gugu`). Control: the parent commit, where a page got only the `--em-*` values
 * computed where its frame sat — no element styles, no components.
 */

// The members come with the chat the page is in (`context.chat.members`), as the host hands them.
type Context = {
  themeMode: 'light' | 'dark';
  locale: string;
  chat: { id: string; name: string; kind: 'group'; members: { id: string; name: string; kind: 'human' | 'agent'; avatar?: string }[] };
};
const FACE = 'data:image/svg+xml;utf8,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"%3E%3Crect width="2" height="2" fill="%23c0aede"/%3E%3C/svg%3E';
let push: ((context: Context) => void) | null = null;
const context: Context = {
  themeMode: 'dark',
  locale: 'zh-CN',
  chat: {
    id: 'chat-1',
    name: '周末',
    kind: 'group',
    members: [
      { id: 'user:lin', name: '林知夏', kind: 'human', avatar: FACE },
      { id: 'user:weekly', name: '周报助手', kind: 'agent', avatar: FACE },
    ],
  },
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
const css = (element: Element, property: string) => getComputedStyle(element).getPropertyValue(property).trim();

beforeAll(async () => {
  const style = document.createElement('style');
  style.textContent = appPaletteCss(tokensCss) + uiCss;
  document.head.prepend(style);
  (window as unknown as { gugu: unknown }).gugu = {
    getContext: async () => context,
    onContextChanged: (handler: (context: Context) => void) => {
      push = handler;
      return () => undefined;
    },
  };
  await import('@/session/app-runtime/ui/ui-entry');
  document.body.innerHTML = `
    <main>
      <h2>周六去哪儿？</h2>
      <button class="primary" id="primary">发起投票</button>
      <button class="danger" id="danger">删除投票</button>
      <button id="plain">取消</button>
      <button aria-label="刷新" id="icon-only"><gugu-icon name="refresh"></gugu-icon></button>
      <ul class="list">
        <li id="member"><gugu-avatar user="user:weekly" name></gugu-avatar></li>
        <li id="stranger"><gugu-avatar user="user:nobody" label="外群的人"></gugu-avatar></li>
      </ul>
      <gugu-time id="time"></gugu-time>
      <gugu-empty icon="checklist" id="empty"><strong>还没有投票</strong></gugu-empty>
    </main>`;
  document.getElementById('time')!.setAttribute('datetime', new Date(Date.now() - 3 * 60_000).toISOString());
  await settle();
});

afterAll(() => {
  document.body.innerHTML = '';
});

/** What a token resolves to as a colour right now, read off an element with no transition (the target a transitioning one must reach). */
const tokenColor = (token: string, property: 'background-color' | 'color' = 'background-color') => {
  const probe = document.createElement('i');
  probe.style.cssText = `position:absolute;transition:none;${property}:var(${token})`;
  document.body.append(probe);
  const value = css(probe, property);
  probe.remove();
  return value;
};

describe('an App page with gugu\'s look', () => {
  it('takes its palette from context.themeMode, and follows it when the host pushes another', async () => {
    expect(document.documentElement.dataset.guguTheme).toBe('dark');
    const primary = document.getElementById('primary')!;
    const darkBackground = css(document.body, 'background-color');
    const darkInk = tokenColor('--em-accent-9');
    expect(css(primary, 'background-color')).toBe(darkInk);
    push!({ ...context, themeMode: 'light' });
    await settle();
    expect(document.documentElement.dataset.guguTheme).toBe('light');
    expect(css(document.body, 'background-color')).not.toBe(darkBackground);
    expect(css(document.documentElement, 'color-scheme')).toBe('light');
    // The primary is ink: it inverts with the theme (never a hue, never session-ui's jade). Its background has a
    // --em-dur-fast transition, so wait until it *reaches* the light ink — a change alone only proves the transition began.
    const lightInk = tokenColor('--em-accent-9');
    expect(lightInk).not.toBe(darkInk);
    await until('primary reaches the light ink', () => css(primary, 'background-color'), (value) => value === lightInk);
    // And back: dark → light → dark lands on the dark ink again.
    push!({ ...context, themeMode: 'dark' });
    await until('primary reaches the dark ink again', () => css(primary, 'background-color'), (value) => value === darkInk);
    push!({ ...context, themeMode: 'light' });
    await until('primary reaches the light ink again', () => css(primary, 'background-color'), (value) => value === lightInk);
  });

  it('labels a danger button white on the red in both themes, like the host\'s ui/Button danger (#7333)', async () => {
    const danger = document.getElementById('danger')!;
    const white = tokenColor('--em-color-white', 'color');
    expect(white).toBe('rgb(255, 255, 255)');
    for (const themeMode of ['dark', 'light'] as const) {
      push!({ ...context, themeMode });
      await until(`the theme is ${themeMode}`, () => document.documentElement.dataset.guguTheme === themeMode);
      // The label colour has a transition: if it were theme-bound (the ink's inverse), its old value would still read
      // white on the first frames after the switch. So wait for it to settle, then compare — a quick match proves nothing.
      await untilStable(`danger label settles in ${themeMode}`, () => css(danger, 'color'));
      expect(css(danger, 'color')).toBe(white);
      expect(css(danger, 'background-color')).toBe(tokenColor('--em-foreground-destructive'));
    }
  });

  it('draws plain HTML in gugu\'s measures: body 14px, controls 32px, the system font (#7333)', () => {
    expect(css(document.body, 'font-size')).toBe('14px');
    // 32 from its padding around one line (the browser's own button layout: an App's text-align still places the label).
    expect(Math.round(document.getElementById('plain')!.getBoundingClientRect().height)).toBe(32);
    expect(css(document.body, 'font-family')).toMatch(/^-apple-system/);
    // A button with only an icon (and its aria-label) is gugu's IconButton: square, no frame.
    expect(css(document.getElementById('icon-only')!, 'width')).toBe('32px');
  });

  // L11 复核 51 补看: the icon in an icon button was 16, not 18 (the plain icon rule came later and won), and beside an
  // input in a .row it sat 2 px low (the row's padding reached the icon button too).
  it('draws an icon button\'s icon at 18 and centred — alone, and beside an input in a .row', () => {
    const centred = (button: Element) => {
      const icon = button.querySelector('gugu-icon')!.getBoundingClientRect();
      const box = button.getBoundingClientRect();
      return { size: Math.round(icon.height), off: Math.abs(icon.top + icon.height / 2 - (box.top + box.height / 2)) };
    };
    const alone = centred(document.getElementById('icon-only')!);
    expect(alone.size).toBe(18);
    expect(alone.off).toBeLessThanOrEqual(1);
    const row = Object.assign(document.createElement('div'), { className: 'row' });
    row.innerHTML = '<input placeholder="Filter"><button aria-label="Search"><gugu-icon name="search"></gugu-icon></button>';
    document.body.append(row);
    const beside = centred(row.querySelector('button')!);
    expect(beside.size).toBe(18);
    expect(beside.off).toBeLessThanOrEqual(1);
    row.remove();
  });

  it('draws the host\'s elements: an icon, a member\'s face (an agent\'s with ⚡), a neutral figure for anyone else', () => {
    expect(document.querySelector('gugu-icon')!.shadowRoot!.querySelector('svg')).not.toBeNull();
    const member = document.querySelector('#member gugu-avatar')!.shadowRoot!;
    expect(member.querySelector('img')!.getAttribute('src')).toBe(FACE);
    expect(member.querySelector('.name')!.textContent).toBe('周报助手');
    expect(member.querySelector('.badge')).not.toBeNull();
    const stranger = document.querySelector('#stranger gugu-avatar')!;
    expect(stranger.shadowRoot!.querySelector('img')).toBeNull();
    expect(stranger.shadowRoot!.querySelector('svg')).not.toBeNull();
    expect(stranger.getAttribute('aria-label')).toBe('外群的人');
    expect(document.getElementById('time')!.shadowRoot!.textContent).toBe('3 分钟前');
    expect(document.getElementById('empty')!.shadowRoot!.querySelector('.icon svg')).not.toBeNull();
  });

  it('loses to the App\'s own CSS, with no !important: the whole look is in @layer gugu', () => {
    const own = document.createElement('style');
    own.textContent = 'button { border-radius: 0; min-height: 50px } body { font-size: 18px }';
    document.head.append(own);
    expect(css(document.getElementById('plain')!, 'border-radius')).toBe('0px');
    expect(css(document.getElementById('plain')!, 'min-height')).toBe('50px');
    expect(css(document.body, 'font-size')).toBe('18px');
    own.remove();
  });

  // A/B 10-05 (#6909's ⋯ menu): its items are full-width buttons with text-align: left, and they came out centred —
  // the layer had made buttons flex. Buttons keep the browser's layout, so an App's text-align still places the label.
  it('keeps the browser\'s button layout: an App\'s text-align: left puts a full-width button\'s label on the left', () => {
    const own = document.createElement('style');
    own.textContent = '#menu-item { width: 300px; text-align: left }';
    document.head.append(own);
    const item = Object.assign(document.createElement('button'), { id: 'menu-item', textContent: 'Rename' });
    document.body.append(item);
    const range = document.createRange();
    range.selectNodeContents(item);
    const text = range.getBoundingClientRect().left - item.getBoundingClientRect().left;
    expect(text).toBeLessThan(20);
    item.remove();
    own.remove();
  });

  // A/B 10-05: the inset was body padding, and the workspace App (body { margin: 0 }, laid out edge to edge) got it
  // inside its own layout. On margin, where the browser's 8px is: an App that resets it keeps its page as it was.
  // L11 复核 51: a canvas narrowed by `max-width: 100%` kept its height — squashed, and a game that maps a click by
  // canvas.width / its box's width (one scale for both axes) hit the wrong row. In a 440-wide page of its own.
  it('narrows a canvas whole: a game mapping clicks by canvas.width hits what it drew', async () => {
    const play = async (pinHeight: boolean) => {
      const frame = document.createElement('iframe');
      frame.style.width = '440px';
      frame.srcdoc = `<!doctype html><style>${appPaletteCss(tokensCss)}${uiCss}</style><body><canvas width="600" height="300"${pinHeight ? ' style="height:300px"' : ''}></canvas></body>`;
      const loaded = new Promise((resolve) => frame.addEventListener('load', resolve, { once: true }));
      document.body.append(frame);
      await loaded;
      const canvas = frame.contentDocument!.querySelector('canvas')!;
      let hit = { x: -1, y: -1 };
      canvas.addEventListener('click', (e) => {
        const box = canvas.getBoundingClientRect();
        const k = canvas.width / box.width;
        hit = { x: (e.clientX - box.left) * k, y: (e.clientY - box.top) * k };
      });
      // The person taps where the target at (450, 225) is drawn on screen.
      const box = canvas.getBoundingClientRect();
      const at = { x: box.left + (450 * box.width) / canvas.width, y: box.top + (225 * box.height) / canvas.height };
      canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: at.x, clientY: at.y }));
      frame.remove();
      return { hit, box: { w: Math.round(box.width), h: Math.round(box.height) } };
    };
    const now = await play(false);
    expect(now.box.w).toBeLessThan(600);
    expect(now.box.h / now.box.w).toBeCloseTo(0.5, 2);
    expect(Math.abs(now.hit.x - 450)).toBeLessThan(2);
    expect(Math.abs(now.hit.y - 225)).toBeLessThan(2);
    // Positive control — the height kept, as before: the same tap lands on another row.
    const before = await play(true);
    expect(Math.abs(before.hit.y - 225)).toBeGreaterThan(50);
  });

  // In a page of its own (this test page has its runner's CSS, which wins over the layer just as an App's does).
  it('gives a bare page gugu\'s edge on body\'s margin; body { margin: 0 } is edge to edge, no padding left over', async () => {
    const edge = async (own: string) => {
      const frame = document.createElement('iframe');
      frame.srcdoc = `<!doctype html><style>${appPaletteCss(tokensCss)}${uiCss}</style><style>${own}</style><body><p>hi</p></body>`;
      const loaded = new Promise((resolve) => frame.addEventListener('load', resolve, { once: true }));
      document.body.append(frame);
      await loaded;
      const style = frame.contentWindow!.getComputedStyle(frame.contentDocument!.body);
      const read = { margin: style.marginLeft, padding: style.paddingLeft };
      frame.remove();
      return read;
    };
    const bare = await edge('');
    expect(Number.parseFloat(bare.margin)).toBeGreaterThan(0);
    expect(bare.padding).toBe('0px');
    expect(await edge('body { margin: 0 }')).toEqual({ margin: '0px', padding: '0px' });
  });
});

/**
 * #7333 The interaction states of the App primitives, read off the real thing: a real mouse over it (`:hover`), a real Tab
 * onto it (`:focus-visible`), a real Space held down on it (`:active`), a real click (focus, no ring), and `disabled`.
 * Each reading waits for its transition to settle (untilStable) before it is compared: a quick match on the first frames
 * after a change can be the old value still showing.
 */
describe('the App primitives\' interaction states, like the host\'s (#7333)', () => {
  type Reading = { color: string; background: string; opacity: number; outline: string; outlineColor: string; outlineWidth: string; outlineOffset: string };
  const reading = (element: Element, pseudo?: string): Reading => {
    const style = getComputedStyle(element, pseudo);
    return {
      color: style.color,
      background: style.backgroundColor,
      opacity: Number(style.opacity),
      outline: style.outlineStyle,
      outlineColor: style.outlineColor,
      outlineWidth: style.outlineWidth,
      outlineOffset: style.outlineOffset,
    };
  };
  const settled = async (label: string, element: Element) => {
    await untilStable(`${label} settles`, () => reading(element));
    return reading(element);
  };
  const byId = (id: string) => document.getElementById(id)!;
  // The mouse goes to the page heading: nothing under test stays hovered.
  const away = () => userEvent.hover(document.querySelector('h2')!);
  /** Focus by the keyboard: Tab from a button placed just before it. Checked: the element really is :focus-visible. */
  const tabOnto = async (element: HTMLElement) => {
    const start = Object.assign(document.createElement('button'), { textContent: 'start' });
    (element.closest('label') ?? element).before(start);
    start.focus();
    await userEvent.tab();
    start.remove();
    expect(document.activeElement, 'Tab did not land on the element').toBe(element);
    expect(element.matches(':focus-visible'), 'a keyboard focus that is not :focus-visible proves nothing').toBe(true);
  };
  const blur = () => (document.activeElement as HTMLElement | null)?.blur();
  const ring = () => ({ outline: 'solid', outlineColor: tokenColor('--em-focus-ring', 'color'), outlineWidth: '2px', outlineOffset: '2px' });
  const transparent = 'rgba(0, 0, 0, 0)';
  const setTheme = async (themeMode: 'dark' | 'light') => {
    push!({ ...context, themeMode });
    await until(`the theme is ${themeMode}`, () => document.documentElement.dataset.guguTheme === themeMode);
  };

  const image = (element: Element) => getComputedStyle(element).backgroundImage;
  type Cdp = { send: (method: string, params: object) => Promise<unknown> };
  /** Where the element's centre is on the top page (this test runs in a frame, maybe scaled): CDP takes page coordinates. */
  const onPage = (element: Element) => {
    const box = element.getBoundingClientRect();
    let x = box.left + box.width / 2;
    let y = box.top + box.height / 2;
    for (let frameWindow: Window = window; frameWindow.frameElement; frameWindow = frameWindow.parent) {
      const frame = frameWindow.frameElement as HTMLElement;
      const outer = frame.getBoundingClientRect();
      const scale = outer.width / frame.offsetWidth;
      x = outer.left + (frame.clientLeft + x) * scale;
      y = outer.top + (frame.clientTop + y) * scale;
    }
    return { x, y };
  };
  /** Hold the left mouse button down on the element (userEvent has no press-and-hold; Space only presses buttons and checkboxes). */
  const mouseDownOn = async (element: Element) => {
    const at = onPage(element);
    const session = cdp() as unknown as Cdp;
    await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at, button: 'none', buttons: 0 });
    await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at, button: 'left', buttons: 1, clickCount: 1 });
    return () => session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at, button: 'left', buttons: 0, clickCount: 1 });
  };

  let fixture: HTMLElement;
  beforeAll(() => {
    fixture = document.createElement('section');
    fixture.innerHTML = `
      <button aria-label="Send" class="primary" id="icon-primary"><gugu-icon name="refresh"></gugu-icon></button>
      <button aria-label="Delete" class="danger" id="icon-danger"><gugu-icon name="refresh"></gugu-icon></button>
      <button aria-label="Refresh" id="icon-plain"><gugu-icon name="refresh"></gugu-icon></button>
      <button aria-label="Refresh" id="icon-plain-off" disabled><gugu-icon name="refresh"></gugu-icon></button>
      <button aria-label="Send" class="primary" id="icon-primary-off" disabled><gugu-icon name="refresh"></gugu-icon></button>
      <button aria-label="Bold" aria-pressed="true" id="icon-pressed"><gugu-icon name="refresh"></gugu-icon></button>
      <button aria-label="More" aria-expanded="true" id="icon-expanded"><gugu-icon name="refresh"></gugu-icon></button>
      <button aria-label="Bold" aria-pressed="true" id="icon-pressed-off" disabled><gugu-icon name="refresh"></gugu-icon></button>
      <button aria-label="More" aria-expanded="true" id="icon-expanded-off" disabled><gugu-icon name="refresh"></gugu-icon></button>
      <label><input type="checkbox" role="switch" id="switch"> Notify</label>
      <label><input type="checkbox" role="switch" id="switch-off" disabled> Locked</label>
      <div role="tablist"><button role="tab" aria-selected="true" id="tab-on">Open</button><button role="tab" aria-selected="false" id="tab-off">Done</button></div>
      <input id="field" placeholder="Name">
      <div class="list">
        <button id="row-selected" aria-selected="true">Inbox</button>
        <button id="row">Archive</button>
        <button id="row-off" disabled>Trash</button>
        <label id="row-label-off"><input type="checkbox" disabled> Locked</label>
        <div role="option" tabindex="0" aria-disabled="true" id="row-option-off">Spam</div>
        <a href="#nowhere" aria-disabled="true" id="row-link-off">Drafts</a>
        <div role="option" tabindex="0" aria-selected="true" aria-disabled="true" id="row-selected-off">Starred</div>
      </div>`;
    document.querySelector('main')!.append(fixture);
    // The mouse released on the disabled link would follow it.
    byId('row-link-off').addEventListener('click', (event) => event.preventDefault());
  });
  afterAll(() => fixture.remove());

  // The bug: the plain icon button's hover colour (muted) outranked .primary / .danger's own label colour inside the
  // layer, so hovering the solid icon button painted grey on ink. The label stays put; only opacity answers the hover.
  for (const themeMode of ['dark', 'light'] as const) {
    it(`keeps a solid icon button's label through hover, focus and press — ${themeMode}`, async () => {
      await setTheme(themeMode);
      for (const [id, label, fill] of [
        ['icon-primary', '--em-accent-contrast', '--em-accent-9'],
        ['icon-danger', '--em-color-white', '--em-foreground-destructive'],
      ] as const) {
        const button = byId(id);
        const ink = { color: tokenColor(label, 'color'), background: tokenColor(fill) };
        await away();
        blur();
        expect(await settled(`${id} at rest`, button)).toMatchObject({ ...ink, opacity: 1, outline: 'none' });
        await userEvent.hover(button);
        expect(await settled(`${id} hovered`, button)).toMatchObject({ ...ink, opacity: 0.88 });
        await away();
        await tabOnto(button);
        expect(await settled(`${id} keyboard-focused`, button)).toMatchObject({ ...ink, opacity: 1, ...ring() });
        await userEvent.keyboard('{Space>}');
        expect(button.matches(':active'), 'the held Space did not press the button').toBe(true);
        expect(await settled(`${id} pressed`, button)).toMatchObject({ ...ink, opacity: 0.78 });
        await userEvent.keyboard('{/Space}');
        blur();
      }
      const off = byId('icon-primary-off');
      expect(await settled('disabled solid icon button', off)).toMatchObject({ color: tokenColor('--em-accent-contrast', 'color'), opacity: 0.58 });
      await userEvent.hover(off);
      expect(await settled('disabled solid icon button hovered', off)).toMatchObject({ opacity: 0.58 });
      await away();
    });
  }

  it('moves a plain icon button through faint → muted on hover, --press when pressed, a ring (not a hover fill) on keyboard focus', async () => {
    await setTheme('dark');
    const button = byId('icon-plain');
    await away();
    blur();
    expect(await settled('plain icon at rest', button)).toMatchObject({ color: tokenColor('--em-foreground-passive', 'color'), background: transparent, outline: 'none' });
    await userEvent.hover(button);
    expect(await settled('plain icon hovered', button)).toMatchObject({ color: tokenColor('--em-foreground-muted', 'color'), background: tokenColor('--em-hover') });
    await away();
    await tabOnto(button);
    expect(await settled('plain icon keyboard-focused', button)).toMatchObject({ color: tokenColor('--em-foreground-passive', 'color'), background: transparent, ...ring() });
    await userEvent.keyboard('{Space>}');
    expect(await settled('plain icon pressed', button)).toMatchObject({ background: tokenColor('--em-press') });
    await userEvent.keyboard('{/Space}');
    blur();
    // A click focuses it too, but leaves no ring.
    await userEvent.click(button);
    await away();
    expect(document.activeElement).toBe(button);
    expect(button.matches(':focus-visible'), 'a click that reports :focus-visible cannot show the mouse case').toBe(false);
    expect(await settled('plain icon clicked', button)).toMatchObject({ outline: 'none' });
    blur();
    // Disabled = the host's .gg-ghost:disabled: .4, faint, no fill — and no hover.
    const off = byId('icon-plain-off');
    await userEvent.hover(off);
    expect(await settled('plain icon disabled, hovered', off)).toMatchObject({ opacity: 0.4, color: tokenColor('--em-foreground-passive', 'color'), background: transparent });
    await away();
  });

  // An icon button that is on (aria-pressed / aria-expanded = true) is the host's .gg-ghost[data-on]: a muted fill and the
  // fg label, which a hover or a press keeps — the overlay is laid on top. Disabled clears the fill and the overlay.
  for (const [id, attribute] of [['icon-pressed', 'aria-pressed'], ['icon-expanded', 'aria-expanded']] as const) {
    it(`keeps an icon button that is on (${attribute}) fg on its muted fill, with hover and press laid on top`, async () => {
      await setTheme('dark');
      const button = byId(id);
      const on = { color: tokenColor('--em-foreground', 'color'), background: tokenColor('--em-background-3') };
      await away();
      blur();
      expect(await settled(`${id} at rest`, button)).toMatchObject(on);
      expect(image(button)).toBe('none');
      await userEvent.hover(button);
      expect(await settled(`${id} hovered`, button), 'hovering an icon button that is on turned its label').toMatchObject(on);
      expect(image(button), 'hovering it laid no --hover overlay').toContain(tokenColor('--em-hover'));
      await away();
      await tabOnto(button);
      await userEvent.keyboard('{Space>}');
      expect(button.matches(':active'), 'the held Space did not press the button').toBe(true);
      expect(await settled(`${id} pressed`, button)).toMatchObject(on);
      expect(image(button), 'pressing it laid no --press overlay').toContain(tokenColor('--em-press'));
      await userEvent.keyboard('{/Space}');
      blur();
      const off = byId(`${id}-off`);
      await userEvent.hover(off);
      expect(await settled(`${id} disabled, hovered`, off)).toMatchObject({ opacity: 0.4, color: tokenColor('--em-foreground-passive', 'color'), background: transparent });
      expect(image(off), 'a disabled icon button kept an overlay').toBe('none');
      await away();
    });
  }

  it('draws a switch as the host\'s: 32×20, a 14 thumb, a filled track with a hairline off, ink on; .88 / .78 / ring / .5', async () => {
    await setTheme('dark');
    const control = byId('switch') as HTMLInputElement;
    const box = control.getBoundingClientRect();
    expect({ width: Math.round(box.width), height: Math.round(box.height) }).toEqual({ width: 32, height: 20 });
    const thumb = () => {
      const style = getComputedStyle(control, '::before');
      return { width: style.width, height: style.height, background: style.backgroundColor, transform: style.transform };
    };
    await away();
    blur();
    expect(await settled('switch off', control)).toMatchObject({ background: tokenColor('--em-background-3'), opacity: 1, outline: 'none' });
    expect(getComputedStyle(control).boxShadow, 'the off track lost its hairline').toMatch(/inset/);
    expect(thumb()).toMatchObject({ width: '14px', height: '14px', background: tokenColor('--em-foreground-muted') });
    await userEvent.hover(control);
    expect(await settled('switch hovered', control)).toMatchObject({ opacity: 0.88 });
    await away();
    await tabOnto(control);
    expect(await settled('switch keyboard-focused', control)).toMatchObject({ opacity: 1, ...ring() });
    await userEvent.keyboard('{Space>}');
    expect(control.matches(':active'), 'the held Space did not press the switch').toBe(true);
    expect(await settled('switch pressed', control)).toMatchObject({ opacity: 0.78 });
    await userEvent.keyboard('{/Space}');
    expect(control.checked, 'Space did not turn the switch on').toBe(true);
    expect(await settled('switch on', control)).toMatchObject({ background: tokenColor('--em-accent-9') });
    expect(getComputedStyle(control).boxShadow).toBe('none');
    await untilStable('the thumb settles on the right', thumb);
    expect(thumb()).toMatchObject({ background: tokenColor('--em-accent-contrast'), transform: 'matrix(1, 0, 0, 1, 12, 0)' });
    control.checked = false;
    blur();
    expect(await settled('switch disabled', byId('switch-off'))).toMatchObject({ opacity: 0.5 });
  });

  it('draws tabs as the host\'s pill: radius 8, the selected one a neutral fill; hover, press and a ring on the others', async () => {
    await setTheme('dark');
    const selected = byId('tab-on');
    const other = byId('tab-off');
    await away();
    blur();
    expect(getComputedStyle(selected).borderRadius).toBe('8px');
    expect(await settled('selected tab', selected)).toMatchObject({ background: tokenColor('--em-background-3'), color: tokenColor('--em-foreground', 'color') });
    expect(await settled('other tab at rest', other)).toMatchObject({ background: transparent, color: tokenColor('--em-foreground-muted', 'color') });
    await userEvent.hover(other);
    expect(await settled('other tab hovered', other)).toMatchObject({ background: tokenColor('--em-hover'), color: tokenColor('--em-foreground', 'color') });
    await away();
    await tabOnto(other);
    expect(await settled('other tab keyboard-focused', other)).toMatchObject({ background: transparent, color: tokenColor('--em-foreground-muted', 'color'), ...ring() });
    await userEvent.keyboard('{Space>}');
    expect(await settled('other tab pressed', other)).toMatchObject({ background: tokenColor('--em-press') });
    await userEvent.keyboard('{/Space}');
    blur();
  });

  it('marks a text field\'s focus by its ink border, never a ring — by keyboard or by click', async () => {
    await setTheme('dark');
    const field = byId('field') as HTMLInputElement;
    await tabOnto(field);
    expect(await settled('field keyboard-focused', field)).toMatchObject({ outline: 'none' });
    const ink = tokenColor('--em-accent-9');
    await until('the focused field\'s border reaches the ink', () => getComputedStyle(field).borderColor, (value) => value === ink);
    blur();
    await userEvent.click(field);
    expect(field.matches(':focus-visible'), 'Chromium reports a clicked text field as :focus-visible — the case the exclusion is for').toBe(true);
    expect(await settled('field clicked', field)).toMatchObject({ outline: 'none' });
    blur();
    await away();
  });

  // A selected row keeps its fill under hover and press, the overlay laid on top (the host's .gg-row). A disabled row answers
  // neither, in the way each kind of row says disabled: a button :disabled, a role item / link / [tabindex] row
  // aria-disabled, a label the input it wraps.
  it('lays a list row\'s hover and press over its selected fill, and leaves every kind of disabled row still', async () => {
    await setTheme('dark');
    const selected = byId('row-selected');
    const selectedFill = tokenColor('--em-selected');
    await away();
    blur();
    expect(await settled('selected row at rest', selected)).toMatchObject({ background: selectedFill });
    expect(image(selected)).toBe('none');
    await userEvent.hover(selected);
    expect(await settled('selected row hovered', selected)).toMatchObject({ background: selectedFill });
    expect(image(selected), 'hovering a selected row laid no --hover overlay').toContain(tokenColor('--em-hover'));
    await away();
    await tabOnto(selected);
    await userEvent.keyboard('{Space>}');
    expect(selected.matches(':active'), 'the held Space did not press the row').toBe(true);
    expect(await settled('selected row pressed', selected)).toMatchObject({ background: selectedFill });
    expect(image(selected), 'pressing a selected row laid no --press overlay').toContain(tokenColor('--em-press'));
    await userEvent.keyboard('{/Space}');
    blur();
    const row = byId('row');
    await userEvent.hover(row);
    expect(await settled('row hovered', row)).toMatchObject({ background: tokenColor('--em-hover') });
    const release = await mouseDownOn(row);
    expect(row.matches(':active'), 'the mouse held down through CDP did not press the row').toBe(true);
    expect(await settled('row pressed', row)).toMatchObject({ background: tokenColor('--em-press') });
    await release();
    // Hovered, then held down: each disabled row stays as it was. The browser never presses a disabled button at all, so
    // that one is read under hover only.
    for (const [id, rest] of [
      ['row-off', transparent],
      ['row-label-off', transparent],
      ['row-option-off', transparent],
      ['row-link-off', transparent],
      ['row-selected-off', selectedFill],
    ] as const) {
      const element = byId(id);
      await userEvent.hover(element);
      expect(await settled(`${id} hovered`, element), `${id} answered the hover`).toMatchObject({ background: rest });
      expect(image(element), `${id} laid an overlay under hover`).toBe('none');
      if (id === 'row-off') continue;
      const up = await mouseDownOn(element);
      expect(element.matches(':active'), `the mouse held down did not reach ${id}`).toBe(true);
      expect(await settled(`${id} held down`, element), `${id} answered the press`).toMatchObject({ background: rest });
      expect(image(element), `${id} laid an overlay under press`).toBe('none');
      await up();
    }
    await away();
  });

  // #7333 母版补页 05: the semantic dialog takes the host's dialog role (16 corners, the dialog shadow); a card stays the
  // surface 12 and flat. The App's own CSS still restyles the dialog.
  it('draws a dialog in the host\'s dialog role, in both themes; a card stays 12 and flat; the App can restyle it', async () => {
    const shadowOf = (token: string) => {
      const probe = document.createElement('i');
      probe.style.cssText = `position:absolute;box-shadow:var(${token})`;
      document.body.append(probe);
      const value = css(probe, 'box-shadow');
      probe.remove();
      return value;
    };
    const dialog = document.createElement('dialog');
    dialog.innerHTML = '<p>删除这条投票?</p><form method="dialog" class="row"><button>取消</button><button class="danger">删除</button></form>';
    const card = Object.assign(document.createElement('div'), { className: 'card', textContent: '投票' });
    document.body.append(dialog, card);
    dialog.showModal();
    try {
      for (const themeMode of ['dark', 'light'] as const) {
        await setTheme(themeMode);
        const dialogShadow = shadowOf('--em-shadow-dialog');
        expect(dialogShadow, 'the dialog shadow is the lift: this reading cannot tell them apart').not.toBe(shadowOf('--em-shadow-lift'));
        expect({ radius: css(dialog, 'border-radius'), shadow: css(dialog, 'box-shadow') }).toEqual({ radius: '16px', shadow: dialogShadow });
        expect({ radius: css(card, 'border-radius'), shadow: css(card, 'box-shadow') }).toEqual({ radius: '12px', shadow: 'none' });
      }
      const own = document.createElement('style');
      own.textContent = 'dialog { border-radius: 4px; box-shadow: none }';
      document.head.append(own);
      expect({ radius: css(dialog, 'border-radius'), shadow: css(dialog, 'box-shadow') }).toEqual({ radius: '4px', shadow: 'none' });
      own.remove();
    } finally {
      dialog.close();
      dialog.remove();
      card.remove();
    }
  });

  it('still loses every state to the App\'s own CSS, whatever its specificity inside the layer', async () => {
    await setTheme('dark');
    const own = document.createElement('style');
    own.textContent = 'button { opacity: 1 } button:focus-visible { outline: 3px dashed rgb(255, 0, 0) } [role=\'tab\'] { border-radius: 0 } input[role=switch] { width: 40px }';
    document.head.append(own);
    const primary = byId('icon-primary');
    await userEvent.hover(primary);
    // The layer's hover is (0,3,0); the App's `button` is (0,0,1) — and wins, because it is not in the layer.
    expect(await settled('primary hovered under the App\'s CSS', primary)).toMatchObject({ opacity: 1 });
    await away();
    await tabOnto(primary);
    expect(await settled('primary focused under the App\'s CSS', primary)).toMatchObject({ outline: 'dashed', outlineColor: 'rgb(255, 0, 0)', outlineWidth: '3px' });
    blur();
    expect(getComputedStyle(byId('tab-on')).borderRadius).toBe('0px');
    expect(Math.round(byId('switch').getBoundingClientRect().width)).toBe(40);
    own.remove();
  });
});
