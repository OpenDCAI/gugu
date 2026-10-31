/** @jsxImportSource solid-js */
import { useCommands } from '@session-chat/components/contexts/CommandsContext';
import { useTurnState } from '@session-chat/components/contexts/TurnStateContext';
import { BlockStackView } from '@session-chat/components/primitives/BlockStackView';
import { clipTrackedHeight, isCardAnimating } from '@session-chat/components/primitives/card-clip';
import { GenericFileIcon, IconStop, ImageOffIcon } from '@session-chat/components/primitives/icons';
import type { StackLayout } from '@session-chat/core/compose';
import type { Measured, RenderCtx } from '@session-chat/core/define';
import { layoutBlockStack } from '@session-chat/core/layout/block-stack';
import { blockPlainText } from '@session-chat/core/markdown/plain-text';
import { pxTokens } from '@session-chat/styles/px-tokens';
import { vars as themeVars } from '@session-chat/styles/theme.css';
import { assignInlineVars } from '@vanilla-extract/dynamic';
import { For, Show, createEffect, createMemo, createResource, createSignal, onCleanup, type JSX } from 'solid-js';
import type { ChatAttachment, ChatMessage } from '@session-chat/model';
import {
  attachChipHeight,
  attachChipWidth,
  attachStripHeight,
  effectiveMessageVars,
  type MessageVars,
  userAvailableWidth,
  userInnerWidth,
  userPillWidth,
} from './metrics';
import { isDoubleColumnLayout } from '@session-chat/core/layout/preset';
import { srOnly } from './message.css';
import { useChatTranslator } from '@session-chat/localization';
import { conversationDestinationLayout } from './conversation-destination';
import { ConversationDestination } from './ConversationDestination';
import { UserMessageActions } from './UserMessageActions';
import { CONVERSATION_EXPAND_H, conversationBubbleKey, hasConversationActions } from './conversation-body';
import { UserMessageEditor } from './UserMessageEditor';
import { messageEditorMetrics } from './message-editor-metrics';
import {
  attachChip,
  attachChipName,
  attachChipThumb,
  attachChipTile,
  attachmentStrip,
  userMessageRoot,
  card,
  cardFadeOverlay,
  cardRoot,
  cardVars,
  stopButtonOverlay,
  userCardGroup,
  userMessageExpand,
  userMessageExpandRow,
} from './user-message.css';

export function UserMessageCard(props: { data: ChatMessage; ctx: RenderCtx; vars: MessageVars; conversation?: boolean; sender?: () => string | null; footerReference?: () => JSX.Element }) {
  const translate = useChatTranslator();
  const commands = useCommands();
  const [textRoot, setTextRoot] = createSignal<HTMLDivElement>();
  const [menuRoot, setMenuRoot] = createSignal<HTMLDivElement>();
  const textMount = createMemo(() => commands().onMessageTextMount);
  const textMessageId = createMemo(() => props.data.id);
  createEffect(() => {
    const root = textRoot(), bubble = menuRoot(), mount = textMount(), itemId = textMessageId();
    if (!props.conversation || !root || !mount) return;
    const cleanup = mount({ root, menuRoot: bubble, itemId, message: () => props.data, sender: () => props.sender?.() ?? null });
    if (cleanup) onCleanup(cleanup);
  });
  const turn = useTurnState();
  const destination = () => props.conversation && props.ctx.measureCtx ? conversationDestinationLayout(props.data, props.ctx.measureCtx(), innerWidth()) : null;

  const mCtx = () => props.ctx.measureCtx?.();
  // Layout-resolved geometry (#4874): `base` narrows padding, drops the border
  // and reserves a left gutter. Same helper as measureMessage so the painted
  // box and the reserved row height come from one set of numbers.
  const layout = () => mCtx()?.theme.layout;
  const vars = () => effectiveMessageVars(props.vars, layout());
  const availableWidth = () => {
    const c = mCtx();
    return c ? userAvailableWidth(c.width, layout()) : 0;
  };

  const isCurrent = () => turn.currentMessageId() === props.data.id;
  /** 这一条就是正在跑的那一轮 —— 卡片高亮用它，与宿主接没接停止回调无关。 */
  const isGenerating = () => isCurrent() && turn.turnStatus() === 'generating';
  /**
   * 停止按钮多一道门：宿主必须真的注入了 `onStop`。
   *
   * 在此之前它只看 `isGenerating()`，而唯一的产品宿主
   * （`acp-chat-panel.tsx` 的 `transcriptCommands`）从来没注入过 `onStop`
   * ⇒ `commands().onStop?.(...)` 在 `?.` 上短路，**这颗按钮按下去什么都不会发生**
   * （#3498 查出来的；与 #3500 是同一个形状）。composer 上那颗停止按钮走的是另一条路、
   * 一直是通的，正好把这颗死按钮掩护成「看起来能停」。
   * ⇒ 现在「没接回调」在结构上等于「不渲染控件」，而不是靠人记得去接。
   */
  const showStop = () => !props.data.guguDelivery && isGenerating() && Boolean(commands().onStop);

  const styleVars = () => ({
    userCardPadX: vars().userCardPadX,
    userCardPadY: vars().userCardPadY,
    cardBorder: vars().cardBorder,
    attachThumb: vars().attachThumb,
    attachGap: vars().attachGap,
    // 卡片的宽高由 metrics 给,css 只是照着画 —— 两处对不上就是测量契约破。
    attachChipH: attachChipHeight(),
    attachChipW: attachChipWidth(availableWidth()),
  });

  const innerWidth = () => (mCtx() ? userInnerWidth(availableWidth(), vars()) : 0);

  const stack = createMemo<Measured<StackLayout> | null>(() => {
    const ctx = mCtx();
    if (!ctx) return null;
    const blocks = props.data.streaming ? ctx.caches.parseBlocksStreaming(props.data.id, props.data.text) : ctx.caches.parseBlocks(props.data.id, props.data.text);
    if (blocks.length === 0) return null;
    const innerCtx = { ...ctx, width: innerWidth() };
    return layoutBlockStack(blocks, innerCtx, { isCollapsed: ctx.isCollapsed });
  });

  /**
   * 卡片自己的高度 —— **不含附件条**(#5269)。附件条挂在卡片外面(见 render),所以夹住长消息
   * 的那个上限只该量正文:附件不该把正文挤进折叠态,也不该被折叠遮住。
   */
  const fullContentH = createMemo(() => {
    const ctx = mCtx();
    const v = vars();
    if (!ctx) return v.collapsedMaxH;
    const innerW = userInnerWidth(availableWidth(), v);
    const blocks = props.data.streaming ? ctx.caches.parseBlocksStreaming(props.data.id, props.data.text) : ctx.caches.parseBlocks(props.data.id, props.data.text);
    // 还在流、一个字没到:先占一行的气泡;收口了还没正文(只有附件)就没有气泡。
    if (blocks.length === 0) return props.data.streaming ? ctx.theme.fonts.body.lineHeight + 2 * v.userCardPadY + 2 * v.cardBorder : 0;
    const innerCtx = { ...ctx, width: innerW };
    const s = layoutBlockStack(blocks, innerCtx, { isCollapsed: ctx.isCollapsed });
    return s.height + 2 * v.userCardPadY + 2 * v.cardBorder;
  });

  /**
   * 附件条的高度 —— 与 measure 调的是同一个函数(`message.def`),❌ 不各算一遍。
   * 它挂在卡片**外面**,所以宽度按卡片外宽算,不吃卡片的内距。
   */
  const attachStripH = createMemo(() =>
    attachStripHeight(props.data.attachments?.length ?? 0, availableWidth(), vars())
  );

  /**
   * Painted width. `classic`: the row width (card spans the column). `base`:
   * hug the widest measured line, capped by the gutter-reduced width.
   * Height is independent of this — see userPillWidth.
   *
   * ⚠️ 从前「有附件就放弃 hug」——那时附件条长在卡片里,得占满内宽才排得开。现在它挂在
   * 卡片外面,卡片又只包正文,于是照常 hug(#5269)。
   */
  const paintedWidth = createMemo(() => {
    const available = availableWidth();
    if (!isDoubleColumnLayout(layout())) return available;
    const s = stack();
    return userPillWidth(available, s ? Math.max(s.width, destination()?.width ?? 0) : null, vars(), layout());
  });

  const isExpanded = () => mCtx()?.expandedId === props.data.id;
  const maxH = () => (isExpanded() ? vars().expandedMaxH : vars().collapsedMaxH);
  const clampedH = () => Math.min(fullContentH(), maxH());
  const isOverflowing = () => fullContentH() > maxH();
  const canCollapse = () => props.conversation && mCtx()?.expanded(conversationBubbleKey(props.data))
    && mCtx()?.latestConversationMessageId !== props.data.id && fullContentH() > vars().collapsedMaxH;

  // Track the animated clip edge during expand/collapse tween so the bottom
  // border and rounded corners are never hidden by the UnitRow overflow clip.
  const cardH = clipTrackedHeight(props.ctx, clampedH);

  const plainText = () => {
    const ctx = mCtx();
    if (!ctx) return props.data.text;
    return ctx.caches.parseBlocks(props.data.id, props.data.text).map(blockPlainText).join('\n\n');
  };
  const edit = () => {
    if (props.data.guguDelivery) return undefined;
    const current = commands().editingMessage;
    return current?.itemId === props.data.id ? current : undefined;
  };
  const editorMetrics = () => {
    const ctx = mCtx();
    return ctx ? messageEditorMetrics(edit()?.text ?? '', ctx) : { height: 120, textHeight: 48 };
  };

  return (
    <div
      data-conversation-body={props.conversation ? props.data.role : undefined}
      class={userMessageRoot}
      style={{
        ...assignInlineVars(cardVars, pxTokens({ ...styleVars(), height: 0 })),
        // `base`:整条右对齐到与气泡同一条边(owner 给的参考是 Kimi 那个形状)。
        ...(isDoubleColumnLayout(layout())
          ? { width: `${availableWidth()}px`, 'margin-left': props.conversation && props.data.role === 'assistant' ? '0' : 'auto' }
          : {}),
      }}
    >
      <Show when={props.data.attachments?.length}>
        {/* 附件**贴在消息上面**,不在气泡里(#5269,owner 2026-09-10 给的参考是 Kimi 那个形状:
            附件卡浮在气泡外、上方,气泡只包文字)——从前它长在卡片里,于是卡片被撑成一大块灰。 */}
        <div
          class={attachmentStrip}
          style={{
            height: `${attachStripH()}px`,
            // `base`:整条右对齐到与气泡同一条边。
            ...(isDoubleColumnLayout(layout()) ? { 'justify-content': props.conversation && props.data.role === 'assistant' ? 'flex-start' : 'flex-end' } : {}),
          }}
        >
          <For each={props.data.attachments}>
            {(att) => <AttachmentChip attachment={att} itemId={props.data.id} />}
          </For>
        </div>
      </Show>
    <Show when={edit()} fallback={<>
    {/* 只有附件、没有正文(长文本自动转成的 pasted-text.txt 就是这样):不画气泡 —— 空气泡是一条整行宽的色带。 */}
    <Show when={!mCtx() || stack() || props.data.streaming}>
    <div
      ref={setMenuRoot}
      data-user-card={props.data.id}
      data-conversation-bubble-key={props.conversation ? conversationBubbleKey(props.data) : undefined}
      data-user-card-expandable={props.conversation && !isExpanded() && isOverflowing() ? 'true' : undefined}
      data-conversation-caret={props.data.conversationCaret ? 'true' : undefined}
      class={`${card({ state: isOverflowing() && !isExpanded() ? 'overflowing' : 'static', current: isGenerating() })} ${cardRoot} ${userCardGroup}`}
      style={{
        ...assignInlineVars(cardVars, pxTokens({ ...styleVars(), height: cardH() + (destination()?.height ?? 0) })),
        // 对话布局里人那一侧的字色由 conversation-message.css 给(跟着气泡底色反色),这里只管 agent 那一侧。
        ...(props.conversation && props.data.role !== 'assistant' ? {} : assignInlineVars({ [themeVars.fgBody]: props.conversation ? themeVars.fg : themeVars.bubbleUserFg, [themeVars.link]: props.conversation ? themeVars.fg : themeVars.bubbleUserFg })),
        // `base` pill: explicit hug width + right alignment. Left as-is in
        // classic so the card keeps spanning the column (no inline width).
        ...(isDoubleColumnLayout(layout())
          ? { width: `${paintedWidth()}px`, 'margin-left': props.conversation && props.data.role === 'assistant' ? '0' : 'auto' }
          : {}),
        // Force overflow:hidden while the UnitRow tween is in flight to avoid
        // a transient scrollbar mid-animation; restore auto only when expanded
        // at rest (so the user can scroll long messages).
        'overflow-y': isCardAnimating(props.ctx) || !isExpanded() ? 'hidden' : 'auto',
        cursor: !isExpanded() && isOverflowing() ? 'pointer' : 'default',
      }}
    >
      <div class={srOnly}>{plainText()}</div>
      <div ref={setTextRoot} data-conversation-text={props.conversation ? props.data.id : undefined}
        style={destination() ? { height: `${Math.max(0, cardH() - 2 * vars().userCardPadY - 2 * vars().cardBorder)}px`, overflow: 'hidden' } : undefined}>
        <Show when={stack()}>{(s) => <BlockStackView node={s()} />}</Show>
      </div>
      <Show when={!isExpanded() && isOverflowing()}>
        <div class={cardFadeOverlay} style={destination() ? { bottom: `${destination()!.height}px` } : undefined} />
      </Show>
      <Show when={destination()}>{target => <ConversationDestination text={target().text} width={target().width} />}</Show>
      <Show when={showStop()}>
        <button
          type="button"
          class={stopButtonOverlay}
          aria-label={translate('transcript.stopGenerating')}
          onClick={(e) => {
            e.stopPropagation();
            commands().onStop?.({ itemId: props.data.id });
          }}
        >
          <IconStop />
        </button>
      </Show>
    </div>
    </Show>
    <Show when={!stack() && !props.data.streaming && Boolean(props.data.attachments?.length) && destination()}>{target =>
      <div data-attachment-destination style={{ display: 'flex', 'justify-content': props.data.role === 'assistant' ? 'flex-start' : 'flex-end' }}>
        <ConversationDestination text={target().text} width={target().width} />
      </div>
    }</Show>
    {/* 对话布局里气泡折着:气泡下面单起一行「展开全文」,再下面才是时间那一行(owner 定稿 0 号图)。点了和点气泡一样展开(ChatRoot 认 `data-expand-user-card`)。 */}
    <Show when={props.conversation && isOverflowing() && !isExpanded()}>
      <div class={userMessageExpandRow} style={{ height: `${CONVERSATION_EXPAND_H}px` }}>
        <button type="button" class={userMessageExpand} data-expand-user-card={props.data.id}
          data-conversation-bubble-key={conversationBubbleKey(props.data)}>{translate('transcript.showFullText')}</button>
      </div>
    </Show>
    <Show when={!props.conversation || hasConversationActions(props.data) || props.footerReference || canCollapse()}>
    <UserMessageActions itemId={props.data.id} text={props.data.text} at={props.data.at}
      reference={props.footerReference}
      collapse={canCollapse() ? { bubbleKey: conversationBubbleKey(props.data), anchorId: props.data.id } : undefined}
      generating={isGenerating()} readOnly={Boolean(props.data.guguDelivery) || (props.conversation && props.data.role === 'assistant')} vars={props.vars} />
    </Show>
    </>}>
      {(editing) => <UserMessageEditor edit={editing()} height={editorMetrics().height} textHeight={editorMetrics().textHeight} />}
    </Show>
    </div>
  );
}


/**
 * 一枚附件卡 —— **图片和文件同一件外壳**(#5269),差别只在图块里装什么:图片铺缩略图,
 * 文件放字形。owner:「按我预想不同附件,用同一个附件 ui 组件,视觉差异不会太大」。
 *
 * 名字在图块**下方、方框之外**;这一处与上游的出入(以及为什么)写在 `metrics.ts`。
 *
 * 点开也是同一个回调,宿主按 kind 分岔(图 → 看图、文件 → 用它该用的方式打开)。
 */
function AttachmentChip(props: { attachment: ChatAttachment; itemId: string }) {
  const commands = useCommands();
  const translate = useChatTranslator();
  const isImage = () => props.attachment.kind !== 'file';
  const [resolvedDataUrl] = createResource(
    () => (!isImage() || props.attachment.dataUrl ? null : props.attachment.id),
    async () => commands().resolveAttachment?.(props.attachment) ?? null
  );
  const dataUrl = () => props.attachment.dataUrl ?? resolvedDataUrl() ?? undefined;

  return (
    <button
      type="button"
      data-attachment-chip
      data-kind={isImage() ? 'image' : 'file'}
      class={attachChip}
      // 名字长了会截断,全名放这儿。
      title={props.attachment.name}
      // 附件名是原始数据(用户自己的文件名),只被这句话包住,❌ 不进 catalog。
      aria-label={translate(
        isImage() ? 'transcript.viewImage' : 'transcript.viewAttachment',
        { name: props.attachment.name }
      )}
      onClick={(e) => {
        e.stopPropagation();
        if (props.attachment.href) { commands().onOpenLink?.(props.attachment.href); return; }
        commands().onViewAttachment?.({
          attachment: { ...props.attachment, ...(dataUrl() ? { dataUrl: dataUrl() } : {}) },
          itemId: props.itemId,
          source: 'user-message',
          thumb: e.currentTarget.querySelector('img') ?? undefined,
        });
      }}
    >
      <span class={attachChipTile}>
        <Show
          when={isImage() && dataUrl()}
          fallback={
            /* 图片读不回来时给「图裂了」那个字形,❌ 不要跟文件用同一个 —— 那会把
               「这张图没读到」说成「这是个文件」。 */
            <Show when={isImage()} fallback={<GenericFileIcon />}>
              <ImageOffIcon />
            </Show>
          }
        >
          {(src) => <img src={src()} alt="" class={attachChipThumb} />}
        </Show>
      </span>
      <span class={attachChipName}>{props.attachment.name}</span>
    </button>
  );
}

export { userInnerWidth };
export type { MessageVars };
