// 本包只保留 composer / prompt-editor / viewer 这些复合组件真正拼装用得上的原语,外加 Storybook
// 演示主题本身要用的 Box / Surface / typography。alert·sheet·switch·tabs·toggle·select 这类通用控件
// 的唯一实现在渲染层的 shadcn(base-vega) 目录 —— ❌ 别在这里再长一份 vanilla-extract 孪生体。
// ── Single-component primitives (named exports) ───────────────────────────────
export { Box } from './box';
export { Button, type ButtonProps } from './button';
export { Input, type InputProps } from './input';
export { Textarea, type TextareaProps } from './textarea';
export { ScrollContainer, type ScrollContainerProps } from './scroll-container';
export { Surface, useSurfaceLevel, type SurfaceProps } from './surface/surface';
export { Text, type TextProps } from './typography/Text';
export { Heading, type HeadingProps } from './typography/Heading';
export { textVariants, type TextVariantProps } from './typography/typography.variants';

// ── Multi-part namespace consts ───────────────────────────────────────────────
export { Dialog, type DialogSize } from './dialog';
export { Popover } from './popover';
export { DropdownMenu } from './dropdown-menu';
export { Combobox, useComboboxAnchor } from './combobox/combobox';
export { InputGroup, type InputGroupAddonAlign } from './input-group';

// ── Non-namespaced compound helpers (remain as named exports) ─────────────────
export {
  ComboboxPopup,
  ComboboxPopupDismiss,
  type ComboboxPopupItem,
  type ComboboxPopupHandle,
} from './combobox/combobox-popup';
export {
  useHoverCard,
  HoverCard,
  isEventInsideInteractiveLayer,
  type HoverCardController,
  type HoverCardRowProps,
  type HoverCardProps,
} from './hover-card';
export {
  SplitButton,
  type SplitButtonProps,
  type SplitButtonOption,
  type SplitButtonOptionTone,
} from './split-button';

// ── Theme / provider ──────────────────────────────────────────────────────────
export {
  ThemeProvider,
  useTheme,
  usePortalThemeClass,
  THEME_MANIFEST,
  type ThemeId,
  type ThemeProviderProps,
} from './theme-provider';

// ── Utility / recipe re-exports ───────────────────────────────────────────────
// 弹层落在哪一层浮层容器,由宿主按树声明(默认 = Base UI 的 document.body)。见 lib/portal-container。
export { UiPortalContainerProvider, useUiPortalContainer } from '../lib/portal-container';
export { resolveFileIconClass } from '@gugu/session-chat-ui/file-icons';
export { controlVariants, type ControlVariantProps } from '@session-ui/styles/recipes/control';
export { inputVariants, type InputVariantProps } from '@session-ui/styles/recipes/input';
