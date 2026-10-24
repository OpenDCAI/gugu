import type { CommandDef, CommandId } from './commands';
import { isMacHost } from './host-os';


/** Only the distinction the defaults actually turn on: macOS puts the primary commands on ⌘. */
export type ShortcutPlatform = 'mac' | 'other';

/**
 * @@@host-os — 只是把唯一那条系统探针(`./host-os`)收窄到这里真正需要的那一档区分。
 * ❌ 别在这里再写一遍 navigator/process 的判断:那正是 2026-09-19 收掉的八处之一。
 */
export function detectShortcutPlatform(): ShortcutPlatform {
  return isMacHost() ? 'mac' : 'other';
}

/**
 * behavior session-page「键盘导航」: the rename / pin / archive keys on a session row.
 *
 * macOS keeps Control, which is what the owner asked for and is free there — ⌘ carries the primary
 * commands. On Windows and Linux Control *is* the primary modifier and all three are already spoken
 * for: Ctrl+R is the Electron default menu's Reload (this app never calls `setApplicationMenu`, and
 * it does ship nsis and AppImage builds), Ctrl+P is this registry's own `openFile`, and Ctrl+X is
 * the platform's Cut. Alt is the spare modifier there, and unlike macOS's Option it does not rewrite
 * `event.key` (⌥R yields '®'), so the letter — the half worth remembering — survives the move.
 */
export function sessionActionDefault(
  letter: 'R' | 'P' | 'X',
  platform: ShortcutPlatform
): string {
  return platform === 'mac' ? `Control+${letter}` : `Alt+${letter}`;
}

export type TabNavigationDirection = 'next' | 'previous';

export const TAB_NAVIGATION_HOTKEYS = {
  next: 'Control+Tab',
  previous: 'Control+Shift+Tab',
} as const;

export interface DomTabNavigationInput {
  type: string;
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

export interface ElectronTabNavigationInput {
  type: string;
  key: string;
  control?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
}

function normalizeShortcutKey(key: string): string {
  return key.toLowerCase();
}

function resolveTabNavigationDirection(input: {
  type: string;
  key: string;
  control: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}): TabNavigationDirection | null {
  if (input.type !== 'keydown' && input.type !== 'keyDown') return null;
  if (normalizeShortcutKey(input.key) !== 'tab') return null;
  if (!input.control || input.alt || input.meta) return null;
  return input.shift ? 'previous' : 'next';
}

export function getDomTabNavigationDirection(
  input: DomTabNavigationInput
): TabNavigationDirection | null {
  return resolveTabNavigationDirection({
    type: input.type,
    key: input.key,
    control: input.ctrlKey,
    shift: input.shiftKey,
    alt: input.altKey,
    meta: input.metaKey,
  });
}

export function getElectronTabNavigationDirection(
  input: ElectronTabNavigationInput
): TabNavigationDirection | null {
  return resolveTabNavigationDirection({
    type: input.type,
    key: input.key,
    control: Boolean(input.control),
    shift: Boolean(input.shift),
    alt: Boolean(input.alt),
    meta: Boolean(input.meta),
  });
}

export function resolveDefaultHotkey(
  def: Pick<CommandDef, 'defaultHotkey'>,
  platform: ShortcutPlatform = detectShortcutPlatform()
): string | undefined {
  return typeof def.defaultHotkey === 'function' ? def.defaultHotkey(platform) : def.defaultHotkey;
}

/**
 * Pairs that deliberately answer to the same chord, with the reason they can never both fire.
 *
 * Runtime knowledge, not test knowledge: the keyboard settings card refuses any binding that
 * collides with another shortcut, so without this list a user who rebinds one of a shared pair can
 * never set it back — the product would contradict the behavior doc that registers the share.
 */
export const INTENTIONALLY_SHARED_CHORDS: ReadonlyArray<{
  readonly keys: readonly [CommandId, CommandId];
  readonly why: string;
}> = [
  {
    keys: ['app.closeModal', 'session.leaveComposer'],
    why: 'Disjoint by modal state: session navigation stands down while a modal is open.',
  },
  {
    keys: ['session.projectHome', 'session.backToList'],
    why: 'Disjoint by focus layer: a keypress is either in the composer or in the nav layer.',
  },
];

/** Whether these two shortcuts are allowed to answer to the same chord. */
export function sharesChordIntentionally(a: string, b: string): boolean {
  return INTENTIONALLY_SHARED_CHORDS.some(
    ({ keys }) => (keys[0] === a && keys[1] === b) || (keys[0] === b && keys[1] === a)
  );
}
