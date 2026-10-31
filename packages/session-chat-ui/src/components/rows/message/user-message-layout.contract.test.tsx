/** @jsxImportSource solid-js */
/**
 * Chromium contract for the `base` layout user pill (#4874 「对话视图」).
 *
 * Three things must hold at once, and each is read off the live DOM:
 *   1. measure() === offsetHeight under `base` exactly as under `classic`
 *      (the hug is paint, never layout).
 *   2. The pill sits on the right edge of the row and never enters the gutter.
 *   3. A short message hugs its text; a long one fills what the gutter leaves.
 * `classic` is the positive control: same code path, full-width card.
 */
import { CachesContext } from '@session-chat/components/contexts/CachesContext';
import { CommandsContext } from '@session-chat/components/contexts/CommandsContext';
import { ThemeContext } from '@session-chat/components/contexts/ThemeContext';
import { createChatCaches } from '@session-chat/core/caches';
import { DEFAULT_CONFIG, buildChatTheme } from '@session-chat/core/config';
import type { ChatLayout } from '@session-chat/core/layout/preset';
import type { MeasureCtx, RenderCtx } from '@session-chat/core/define';
import type { ChatMessage } from '@session-chat/model';
import type { ChatCommands } from '@session-chat/commands';
import { render } from 'solid-js/web';
import { describe, expect, it, vi } from 'vitest';
import { messageUnitDef, normalizeMessage } from './message.def';

const WIDTH = 640;
const GUTTER = 72;
const SINGLE: ChatLayout = { preset: 'single', userGutter: 0 };
const DOUBLE: ChatLayout = { preset: 'double', userGutter: GUTTER };

const SHORT: ChatMessage = { kind: 'message', id: 'u-short', role: 'user', text: 'Hello, can you help me?' };
const LONG: ChatMessage = {
  kind: 'message',
  id: 'u-long',
  role: 'user',
  text: 'Can you refactor the authentication module to use JWT tokens instead of session cookies, and add rate limiting middleware for the API endpoints?',
};

const nextPaint = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

type Reading = {
  computed: number;
  /** 整行的高(附件条 + 气泡)—— `measure()` 报的就是这个数。 */
  dom: number;
  /** 只有气泡那一半。夹住长消息的上限只夹它。 */
  cardH: number;
  /** 这一行画出来的附件 chip 数(#5269)。 */
  chips: number;
  /** 画出来的气泡数:只有附件、没有正文时是 0。 */
  cards: number;
  left: number;
  right: number;
  width: number;
  hostRight: number;
  background: string;
  borderWidth: string;
  actionTop: number;
  actionRight: number;
  cardBottom: number;
  actionButtons: number;
  actionOpacity: string;
  focusedActionOpacity: string;
};

async function mountUser(item: ChatMessage, layout: ChatLayout, commands: ChatCommands = {}, focusActions = false): Promise<Reading> {
  const theme = buildChatTheme(DEFAULT_CONFIG, layout);
  const caches = createChatCaches();
  const measureCtx: MeasureCtx = {
    theme,
    width: WIDTH,
    isCollapsed: () => false,
    expanded: () => false,
    caches,
    expandedId: null,
  };
  const renderCtx: RenderCtx = {
    viewState: { isCollapsed: () => false },
    measureCtx: () => measureCtx,
  };
  const computed = messageUnitDef.measure(item, measureCtx, messageUnitDef.vars!);

  const host = document.createElement('div');
  host.style.width = `${WIDTH}px`;
  // ChatRoot stamps this on its root; the harness has no ChatRoot, so the host
  // plays that role for the paint-side selectors.
  host.dataset.chatLayout = layout.preset;
  document.body.appendChild(host);
  const Comp = messageUnitDef.Render;
  const dispose = render(
    () => (
      <ThemeContext.Provider value={() => theme}>
        <CachesContext.Provider value={caches}>
          <CommandsContext.Provider value={() => commands}>
            <Comp data={item} ctx={renderCtx} vars={messageUnitDef.vars!} />
          </CommandsContext.Provider>
        </CachesContext.Provider>
      </ThemeContext.Provider>
    ),
    host
  );
  try {
    await nextPaint();
    const cards = host.querySelectorAll('[data-user-card]').length;
    const card = host.querySelector<HTMLElement>('[data-user-card]') ?? document.createElement('div');
    // ⚠️ `measure()` 报的是**整行**的高:附件条挂在气泡外面,是气泡的兄弟(#5269)。
    // 量气泡只会量到正文那一半 —— 那正是这几条在附件条搬家后红掉的原因。
    const root = host.firstElementChild as HTMLElement;
    const hostRect = host.getBoundingClientRect();
    const rect = card.getBoundingClientRect();
    const cs = getComputedStyle(card);
    const actions = root.querySelector<HTMLElement>('[data-user-message-actions]');
    const actionButton = actions?.querySelector('button');
    if (!actions || !actionButton) throw new Error('user message actions did not mount');
    const actionOpacity = getComputedStyle(actions).opacity;
    const initialHeight = root.offsetHeight;
    if (focusActions) {
      actionButton.focus();
      await vi.waitFor(() => expect(getComputedStyle(actions).opacity).toBe('1'));
      expect(root.offsetHeight, 'revealing actions moved the message row').toBe(initialHeight);
    }
    return {
      computed,
      dom: root.offsetHeight,
      cardH: card.offsetHeight,
      chips: root.querySelectorAll('[data-attachment-chip]').length,
      cards,
      left: rect.left - hostRect.left,
      right: rect.right - hostRect.left,
      width: rect.width,
      hostRight: hostRect.width,
      background: cs.backgroundColor,
      borderWidth: cs.borderTopWidth,
      actionTop: actionButton.getBoundingClientRect().top,
      actionRight: actions.getBoundingClientRect().right - hostRect.left,
      cardBottom: rect.bottom,
      actionButtons: actions.querySelectorAll('button').length,
      actionOpacity,
      focusedActionOpacity: getComputedStyle(actions).opacity,
    };
  } finally {
    dispose();
    host.remove();
    caches.clearAll();
  }
}

describe('user message × layout preset contract (#4874)', () => {
  it('keyboard focus reveals the same action row without changing its height', async () => {
    const r = await mountUser(SHORT, DOUBLE, {}, true);
    expect(r.computed).toBe(r.dom);
    expect(r.actionOpacity).toBe(matchMedia('(hover: none)').matches ? '1' : '0');
    expect(r.focusedActionOpacity).toBe('1');
  });

  it.each([SINGLE, DOUBLE])('message actions sit below the bubble without breaking its measured height ($preset)', async (layout) => {
    const r = await mountUser(SHORT, layout, { canRevertMessage: () => true, onEditMessage: () => {} });
    expect(r.computed).toBe(r.dom);
    expect(r.actionButtons).toBe(2);
    expect(r.actionTop - r.cardBottom).toBe(4);
    expect(Math.abs(r.actionRight - r.right)).toBeLessThanOrEqual(0.5);
  });

  it('classic (positive control): full-width card, measure === offsetHeight', async () => {
    const r = await mountUser(SHORT, SINGLE);
    expect(r.computed).toBe(r.dom);
    expect(r.left).toBe(0);
    expect(r.width).toBe(WIDTH);
    expect(r.borderWidth).toBe('1px');
  });

  it('base: short message hugs its text on the right edge, outside the gutter', async () => {
    const r = await mountUser(SHORT, DOUBLE);
    expect(r.computed).toBe(r.dom);
    // Right-aligned: the pill's right edge is the row's right edge.
    expect(Math.abs(r.right - r.hostRight)).toBeLessThanOrEqual(0.5);
    // Hugging: strictly narrower than what the gutter leaves.
    expect(r.width).toBeLessThan(WIDTH - GUTTER);
    // Never enters the gutter.
    expect(r.left).toBeGreaterThanOrEqual(GUTTER);
    // Borderless pill.
    expect(r.borderWidth).toBe('0px');
  });

  // A wrapped paragraph hugs its *widest line*, which ends wherever the last
  // word that still fit ended — a few px short of the inner width. So「fills」
  // is bounded by one word (≤ 10% here), never asserted as an exact width.
  it('base: long message fills what the gutter leaves, up to one word of slack', async () => {
    const r = await mountUser(LONG, DOUBLE);
    expect(r.computed).toBe(r.dom);
    const available = WIDTH - GUTTER;
    expect(r.width).toBeLessThanOrEqual(available + 0.5);
    expect(r.width).toBeGreaterThan(available * 0.9);
    expect(r.left).toBeGreaterThanOrEqual(GUTTER - 0.5);
    expect(Math.abs(r.right - r.hostRight)).toBeLessThanOrEqual(0.5);
  });

  it('base with a zero gutter (narrow viewport) may use the whole row', async () => {
    const r = await mountUser(LONG, { preset: 'double', userGutter: 0 });
    expect(r.computed).toBe(r.dom);
    expect(r.width).toBeLessThanOrEqual(WIDTH + 0.5);
    expect(r.width).toBeGreaterThan(WIDTH * 0.9);
    // Wider than the gutter would have allowed: the gutter really is gone.
    expect(r.width).toBeGreaterThan(WIDTH - GUTTER + 0.5);
  });

  it('mutation control: the base row height is not the classic row height', async () => {
    // Same text, different padding — if `effectiveMessageVars` were ignored on
    // either side of the contract, this pair would collapse to equal numbers
    // while the two measure === offsetHeight checks above stayed green.
    const classic = await mountUser(LONG, SINGLE);
    const base = await mountUser(LONG, DOUBLE);
    expect(base.dom).not.toBe(classic.dom);
  });
});

/**
 * 正文里指着附件的 mention 要显示成附件条上的一枚 chip,而不是一枚裸的文字 pill(#5269)。
 *
 * 判据有两层,缺一不可:
 *   ① **画出来了** —— 卡片里真有一枚 chip(首轮附件只能以「正文里一条绝对路径」送达,
 *      从前那条路上一张图都画不出来);
 *   ② **测得准** —— measure() === offsetHeight。附件条会长高这张卡,行高是离屏算出来的,
 *      算漏了整个虚拟化列表就会错位。
 *
 * ⚠️ 第四条从前是反向对照「非图片不许摘」。owner 2026-09-10 推翻了它:同一条消息里图是
 * 缩略图、文件是正文末尾一枚裸 pill,两件附件长成两个样子。现在两种都进附件条,反向对照
 * 换成**相对路径**的 mention —— 那才是「正文里提到的文件」,摘走就等于凭空造出一件附件。
 */
describe('附件 mention → 附件条 (#5269)', () => {
  const IMAGE_MENTION: ChatMessage = {
    kind: 'message',
    id: 'u-img',
    role: 'user',
    text: 'hello，这张图有什么\n@[image.png](/Users/me/Library/task-attachments/t1/abc-image.png)',
  };
  const FILE_MENTION: ChatMessage = {
    kind: 'message',
    id: 'u-file',
    role: 'user',
    text: '看下 @[notes.md](/Users/me/notes.md) 这份',
  };
  const WORKSPACE_MENTION: ChatMessage = {
    kind: 'message',
    id: 'u-rel',
    role: 'user',
    text: '看下 @[server.ts](src/server.ts) 这个文件',
  };

  it('画成一枚 chip,而且 measure === offsetHeight', async () => {
    const item = normalizeMessage(IMAGE_MENTION);
    expect(item.attachments?.map((a) => a.name)).toEqual(['image.png']);
    // 正文里那枚 pill 不再出现 —— 图已经画在上面了。
    expect(item.text).toBe('hello，这张图有什么');
    const r = await mountUser(item, DOUBLE);
    expect(r.computed).toBe(r.dom);
    expect(r.chips).toBe(1);
  });

  it('阳控:同一条消息去掉那张图之后,卡片明显变矮 —— 说明附件条真的占了高度', async () => {
    const withImage = await mountUser(normalizeMessage(IMAGE_MENTION), DOUBLE);
    const withoutImage = await mountUser(
      { kind: 'message', id: 'u-img-plain', role: 'user', text: 'hello，这张图有什么' },
      DOUBLE
    );
    expect(withImage.dom).toBeGreaterThan(withoutImage.dom);
    expect(withoutImage.chips).toBe(0);
  });

  it('同一张图既有上传的附件又有正文引用时,只画一张(刚发出去的那一轮就是这样)', async () => {
    const item = normalizeMessage({
      ...IMAGE_MENTION,
      id: 'u-img-live',
      attachments: [{ id: 'acp-1', name: 'image.png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }],
    });
    expect(item.attachments?.length).toBe(1);
    expect(item.text).toBe('hello，这张图有什么');
    const r = await mountUser(item, DOUBLE);
    expect(r.computed).toBe(r.dom);
    expect(r.chips).toBe(1);
  });

  it('非图片的文件 mention 也进附件条,画成同一枚 chip', async () => {
    const item = normalizeMessage(FILE_MENTION);
    expect(item.attachments?.map((a) => [a.name, a.kind])).toEqual([['notes.md', 'file']]);
    expect(item.text).toBe('看下 这份');
    const r = await mountUser(item, DOUBLE);
    expect(r.computed).toBe(r.dom);
    expect(r.chips).toBe(1);
  });

  it('只有附件、没有正文(长文本自动转成的 pasted-text.txt):只画附件,不画空气泡;measure === offsetHeight', async () => {
    const item = normalizeMessage({
      kind: 'message',
      id: 'u-pasted',
      role: 'user',
      text: '@[pasted-text.txt](/Users/me/Library/task-attachments/t1/abc-pasted-text.txt)',
    });
    expect(item.text).toBe('');
    for (const layout of [DOUBLE, SINGLE]) {
      const r = await mountUser(item, layout);
      expect(r.chips).toBe(1);
      expect(r.cards, 'an empty bubble is drawn: a full-width colored bar under the chip').toBe(0);
      expect(r.computed).toBe(r.dom);
    }
    // 阳控:有正文时气泡照画。
    expect((await mountUser(normalizeMessage(FILE_MENTION), DOUBLE)).cards).toBe(1);
  });

  it('❌ 相对路径的 mention 不摘 —— 那是正文里提到的文件,不是这条消息的附件', async () => {
    // 阴控:判据若退回「见 mention 就摘」,agent 惯写的 `@[src/a.ts](src/a.ts)` 会变成
    // 一件凭空出现的附件,而正文里那句话缺一块。
    const item = normalizeMessage(WORKSPACE_MENTION);
    expect(item.attachments ?? []).toEqual([]);
    expect(item.text).toBe(WORKSPACE_MENTION.text);
    const r = await mountUser(item, DOUBLE);
    expect(r.computed).toBe(r.dom);
    expect(r.chips).toBe(0);
  });
});
