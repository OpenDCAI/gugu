/**
 * Where a popup portals to.
 *
 * A popup (combobox, dropdown, popover, select, dialog, mention/slash suggestion) must render
 * inside the portal layer of **the surface it was rendered from**. That is a property of the
 * React tree the popup lives in — so it is answered by context, and each host declares its own
 * layer by wrapping its root in `UiPortalContainerProvider`.
 *
 * Default (no provider) = `undefined`, which is Base UI's own `document.body` default. That is
 * the right answer for every host whose `ThemeProvider` runs in `documentElement` mode: the
 * theme class sits on `<html>`, so a popup portaled to the body resolves the same tokens as its
 * trigger. Only a host that scopes its theme to a wrapper (the gugu-embedded 会话页 mount) needs
 * to name a container.
 *
 * @@@4321 这里从前是一个 **window 全局** (`__EMDASH_PORTAL_CONTAINER__`):会话页 bootstrap 写,
 * 本包读。但一个文档里活着**两棵** React 树 —— 咕咕主渲染层(`#root`)和会话页(它自己的挂载元素),
 * 而它们**共用同一份 session-ui**。于是会话页写下的那个值把咕咕主渲染层的弹层也一起吸了过去,
 * 落进那个「常驻挂载、平时隐藏」的会话页 overlay(`visibility:hidden` + `pointer-events:none`
 * + 自成 `z-index:5` 层叠上下文)—— 弹层于是 `aria-expanded=true` 却既看不见也点不到
 * (owner 实测:向导里的运行引擎 combobox,六个 option 尺寸都是真的 220x30,逐个继承到 hidden)。
 * ⇒ 病根不是 z-index、不是零尺寸、也不是裁剪,而是**用一个「谁最后写谁赢」的文档级全局,
 * 去回答一个本来就是「按树分」的问题**。宿主传语义 z-index(`popupZIndex`)治不了它:
 * 那个 z-index 被关在 overlay 自己的层叠上下文里,而 `visibility:hidden` 照样继承下来。
 */
import { createContext, useContext } from 'react';

const UiPortalContainerContext = createContext<HTMLElement | null>(null);

/**
 * Declares the portal layer for everything rendered inside it. Pass the element that carries this
 * surface's theme scope — popups portal into it, so they inherit exactly what their trigger does.
 */
export const UiPortalContainerProvider = UiPortalContainerContext.Provider;

/** `undefined` → Base UI's `<Portal>` falls back to `document.body`. */
export function useUiPortalContainer(): HTMLElement | undefined {
  return useContext(UiPortalContainerContext) ?? undefined;
}

/** For raw `createPortal` call sites, which need a concrete element (never `undefined`). */
export function useUiPortalContainerOrBody(): HTMLElement {
  return useContext(UiPortalContainerContext) ?? document.body;
}
