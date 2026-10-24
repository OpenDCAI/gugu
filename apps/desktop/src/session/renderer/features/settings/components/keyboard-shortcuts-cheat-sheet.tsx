import React, { useState, useMemo } from 'react';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import {
  COMMANDS,
  getEffectiveHotkey,
  type CommandId,
} from '@renderer/lib/hooks/useKeyboardShortcuts';
import { type BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { Shortcut } from '@renderer/lib/ui/shortcut';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { cn } from '@renderer/utils/utils';

// ---------------------------------------------------------------------------
// Types & Constants
// ---------------------------------------------------------------------------

type ShortcutEntry = [CommandId, (typeof COMMANDS)[CommandId]];

const NAV_CATEGORY  = 'Navigation'     as const;
const VIEW_CATEGORY = 'View'           as const;
const SESSION_CATEGORY = 'Task View'      as const;
const TAB_CATEGORY  = 'Tab Navigation' as const;

// ---------------------------------------------------------------------------
// Hotkey → Key ID Parsing
// ---------------------------------------------------------------------------

function parseHotkeyToKeys(hotkey: string): Set<string> {
  const keys = new Set<string>();
  const parts = hotkey.split('+');

  for (const part of parts) {
    switch (part) {
      case 'Mod':
      case 'Meta':
        keys.add('meta');
        break;
      case 'Shift':
        keys.add('shift');
        break;
      case 'Alt':
        keys.add('alt');
        break;
      case 'Control':
        keys.add('control');
        break;
      case 'ArrowUp':
        keys.add('arrowup');
        break;
      case 'ArrowDown':
        keys.add('arrowdown');
        break;
      case 'ArrowLeft':
        keys.add('arrowleft');
        break;
      case 'ArrowRight':
        keys.add('arrowright');
        break;
      case 'Backspace':
        keys.add('backspace');
        break;
      case 'Enter':
        keys.add('enter');
        break;
      case 'Tab':
        keys.add('tab');
        break;
      case 'Escape':
        keys.add('escape');
        break;
      default:
        keys.add(part.toLowerCase());
        break;
    }
  }

  return keys;
}

// ---------------------------------------------------------------------------
// Shortcut Data Helpers
// ---------------------------------------------------------------------------

const CONFIGURABLE_SHORTCUTS: ShortcutEntry[] = (
  Object.entries(COMMANDS) as ShortcutEntry[]
).filter(([, def]) => !def.hideFromSettings);

function getCategoryEntries(cat: string, query: string): ShortcutEntry[] {
  return CONFIGURABLE_SHORTCUTS.filter(([, def]) => {
    if (def.category !== cat) return false;
    if (!query) return true;
    const q = query.toLowerCase();
    return def.label.toLowerCase().includes(q) || def.description.toLowerCase().includes(q);
  });
}

// ---------------------------------------------------------------------------
// Mac Keyboard SVG
// ---------------------------------------------------------------------------

interface KeyDef {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const KEY_H = 40;
const GAP = 2;
const STD_W = 44;

function key(id: string, label: string, x: number, y: number, w: number = STD_W): KeyDef {
  return { id, label, x, y, w, h: KEY_H };
}

function buildRow(
  y: number,
  keys: Array<{ id: string; label: string; w?: number }>
): KeyDef[] {
  const result: KeyDef[] = [];
  let x = 0;
  for (const k of keys) {
    const w = k.w ?? STD_W;
    result.push(key(k.id, k.label, x, y, w));
    x += w + GAP;
  }
  return result;
}

const ROW_1 = buildRow(0, [
  { id: '`', label: '`' },
  { id: '1', label: '1' },
  { id: '2', label: '2' },
  { id: '3', label: '3' },
  { id: '4', label: '4' },
  { id: '5', label: '5' },
  { id: '6', label: '6' },
  { id: '7', label: '7' },
  { id: '8', label: '8' },
  { id: '9', label: '9' },
  { id: '0', label: '0' },
  { id: '-', label: '-' },
  { id: '=', label: '=' },
  { id: 'backspace', label: '⌫', w: 68 },
]);

const ROW_2 = buildRow(46, [
  { id: 'tab', label: 'Tab', w: 60 },
  { id: 'q', label: 'Q' },
  { id: 'w', label: 'W' },
  { id: 'e', label: 'E' },
  { id: 'r', label: 'R' },
  { id: 't', label: 'T' },
  { id: 'y', label: 'Y' },
  { id: 'u', label: 'U' },
  { id: 'i', label: 'I' },
  { id: 'o', label: 'O' },
  { id: 'p', label: 'P' },
  { id: '[', label: '[' },
  { id: ']', label: ']' },
  { id: '\\', label: '\\', w: 52 },
]);

const ROW_3 = buildRow(92, [
  { id: 'capslock', label: 'Caps', w: 70 },
  { id: 'a', label: 'A' },
  { id: 's', label: 'S' },
  { id: 'd', label: 'D' },
  { id: 'f', label: 'F' },
  { id: 'g', label: 'G' },
  { id: 'h', label: 'H' },
  { id: 'j', label: 'J' },
  { id: 'k', label: 'K' },
  { id: 'l', label: 'L' },
  { id: ';', label: ';' },
  { id: "'", label: "'" },
  { id: 'enter', label: 'Enter', w: 88 },
]);

const ROW_4 = buildRow(138, [
  { id: 'shift', label: '⇧', w: 88 },
  { id: 'z', label: 'Z' },
  { id: 'x', label: 'X' },
  { id: 'c', label: 'C' },
  { id: 'v', label: 'V' },
  { id: 'b', label: 'B' },
  { id: 'n', label: 'N' },
  { id: 'm', label: 'M' },
  { id: ',', label: ',' },
  { id: '.', label: '.' },
  { id: '/', label: '/' },
  { id: 'shift-right', label: '⇧', w: 116 },
]);

const ROW_5 = buildRow(184, [
  { id: 'fn', label: 'fn' },
  { id: 'control', label: '⌃' },
  { id: 'alt', label: '⌥' },
  { id: 'meta', label: '⌘', w: 56 },
  { id: 'space', label: '', w: 228 },
  { id: 'meta-right', label: '⌘', w: 56 },
  { id: 'alt-right', label: '⌥' },
  { id: 'arrowleft', label: '←' },
  { id: 'arrowup', label: '↑', w: 44 },
  { id: 'arrowright', label: '→' },
]);

// Arrow up/down share a half-height key area. We handle this specially.
const ARROW_DOWN: KeyDef = (() => {
  const arrowUp = ROW_5.find((k) => k.id === 'arrowup')!;
  return {
    id: 'arrowdown',
    label: '↓',
    x: arrowUp.x,
    y: arrowUp.y + 21,
    w: arrowUp.w,
    h: 19,
  };
})();

// Adjust arrowup to be half-height
const ARROW_UP_ADJUSTED: KeyDef = (() => {
  const arrowUp = ROW_5.find((k) => k.id === 'arrowup')!;
  return { ...arrowUp, h: 19 };
})();

const ALL_KEYS: KeyDef[] = [
  ...ROW_1,
  ...ROW_2,
  ...ROW_3,
  ...ROW_4,
  ...ROW_5.filter((k) => k.id !== 'arrowup'),
  ARROW_UP_ADJUSTED,
  ARROW_DOWN,
];

// For highlighting, "shift-right" should also match "shift", etc.
function keyMatchesHighlight(keyId: string, highlighted: Set<string>): boolean {
  if (highlighted.has(keyId)) return true;
  if (keyId === 'shift-right' && highlighted.has('shift')) return true;
  if (keyId === 'meta-right' && highlighted.has('meta')) return true;
  if (keyId === 'alt-right' && highlighted.has('alt')) return true;
  return false;
}

interface MacKeyboardProps {
  highlightedKeys: Set<string>;
}

const MacKeyboard: React.FC<MacKeyboardProps> = React.memo(({ highlightedKeys }) => {
  const maxX = Math.max(...ALL_KEYS.map((k) => k.x + k.w));
  const maxY = Math.max(...ALL_KEYS.map((k) => k.y + k.h));

  return (
    <svg
      viewBox={`0 0 ${maxX} ${maxY}`}
      className="w-full select-none"
      aria-hidden="true"
    >
      {ALL_KEYS.map((k) => {
        const active = keyMatchesHighlight(k.id, highlightedKeys);
        return (
          <g key={`${k.id}-${k.x}-${k.y}`} data-key={k.id}>
            <rect
              x={k.x}
              y={k.y}
              width={k.w}
              height={k.h}
              rx={6}
              style={{
                fill: active ? 'var(--live)' : 'var(--neutral-3, var(--background-2))',
                stroke: active ? 'var(--live)' : 'var(--neutral-6, var(--border-1))',
                strokeWidth: 1,
                // @@@task-fusion (#2802) — 并入本体后受咕咕动效 token 门约束(ui-state-debt-check):
                // ❌ 魔数时长。⚠️ 不能带 fallback(`var(--dur-fast, 120ms)` 里的数字照样被判债务)。
                transition: 'fill var(--dur-fast), stroke var(--dur-fast)',
                opacity: active ? 0.9 : 1,
              }}
            />
            <text
              x={k.x + k.w / 2}
              y={k.y + k.h / 2}
              textAnchor="middle"
              dominantBaseline="central"
              style={{
                fill: active
                  ? 'var(--neutral-12, var(--foreground))'
                  : 'var(--neutral-11, var(--foreground-muted))',
                fontSize: k.h < 25 ? '9px' : '11px',
                fontFamily: 'system-ui, -apple-system, sans-serif',
                fontWeight: 500,
                transition: 'fill var(--dur-fast)',
                pointerEvents: 'none',
              }}
            >
              {k.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
});

MacKeyboard.displayName = 'MacKeyboard';

// ---------------------------------------------------------------------------
// Shortcut Row
// ---------------------------------------------------------------------------

interface ShortcutRowProps {
  shortcutKey: CommandId;
  label: string;
  hotkey: string;
  isActive: boolean;
  onActivate: (key: CommandId | null) => void;
}

const ShortcutRow: React.FC<ShortcutRowProps> = ({
  shortcutKey,
  label,
  hotkey,
  isActive,
  onActivate,
}) => {
  return (
    <div
      onMouseEnter={() => onActivate(shortcutKey)}
      onMouseLeave={() => onActivate(null)}
      onClick={() => onActivate(isActive ? null : shortcutKey)}
      className={cn(
        'flex cursor-pointer items-center justify-between gap-2 rounded-md px-2 py-1 transition-colors',
        isActive
          ? 'bg-row-selected'
          : 'hover:bg-row-hover'
      )}
    >
      <span className="truncate text-[length:var(--font-body)] text-foreground">{label}</span>
      {/* oxlint-disable-next-line typescript/no-explicit-any */}
      <Shortcut hotkey={hotkey as any} variant="keycaps" />
    </div>
  );
};

// ---------------------------------------------------------------------------
// Category Section (single category, vertical list)
// ---------------------------------------------------------------------------

interface CategorySectionProps {
  /** @@@lookup value — COMMANDS 的 category 是数据键,展示用 categoryLabel。 */
  category: string;
  categoryLabel: string;
  entries: ShortcutEntry[];
  keyboard: Record<string, string | null> | undefined;
  activeShortcut: CommandId | null;
  onActivate: (key: CommandId | null) => void;
}

const CategorySection: React.FC<CategorySectionProps> = ({
  category,
  categoryLabel,
  entries,
  keyboard,
  activeShortcut,
  onActivate,
}) => {
  if (!entries.length) return null;
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5 px-2">
        <span
          data-shortcut-category={category}
          className="text-micro font-semibold uppercase tracking-wider text-foreground-muted"
        >
          {categoryLabel}
        </span>
        <span className="text-micro text-foreground-muted/60">{entries.length}</span>
      </div>
      <div className="flex flex-col gap-0.5">
        {entries.map(([key, def]) => {
          const hotkey = getEffectiveHotkey(key, keyboard);
          if (!hotkey) return null;
          return (
            <ShortcutRow
              key={key}
              shortcutKey={key}
              label={def.label}
              hotkey={hotkey}
              isActive={activeShortcut === key}
              onActivate={onActivate}
            />
          );
        })}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Tab Navigation Section (2-column grid)
// ---------------------------------------------------------------------------

interface TabNavSectionProps {
  entries: ShortcutEntry[];
  keyboard: Record<string, string | null> | undefined;
  activeShortcut: CommandId | null;
  onActivate: (key: CommandId | null) => void;
}

const TabNavSection: React.FC<TabNavSectionProps> = ({
  entries,
  keyboard,
  activeShortcut,
  onActivate,
}) => {
  const { translate } = useSessionMessages();
  if (!entries.length) return null;
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5 px-2">
        <span className="text-micro font-semibold uppercase tracking-wider text-foreground-muted">
          {translate('keyboard.tabNavigation')}
        </span>
        <span className="text-micro text-foreground-muted/60">{entries.length}</span>
      </div>
      <div className="grid grid-cols-2 gap-x-2">
        {entries.map(([key, def]) => {
          const hotkey = getEffectiveHotkey(key, keyboard);
          if (!hotkey) return null;
          return (
            <ShortcutRow
              key={key}
              shortcutKey={key}
              label={def.label}
              hotkey={hotkey}
              isActive={activeShortcut === key}
              onActivate={onActivate}
            />
          );
        })}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export const KeyboardShortcutsCheatSheet: React.FC<BaseModalProps> = ({ onClose }) => {
  const { value: keyboard } = useAppSettingsKey('keyboard');
  const [activeShortcut, setActiveShortcut] = useState<CommandId | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const { translate } = useSessionMessages();

  const highlightedKeys = useMemo(() => {
    if (!activeShortcut) return new Set<string>();
    const hotkey = getEffectiveHotkey(activeShortcut, keyboard);
    if (!hotkey) return new Set<string>();
    return parseHotkeyToKeys(hotkey);
  }, [activeShortcut, keyboard]);

  const navEntries  = useMemo(() => getCategoryEntries(NAV_CATEGORY,  searchQuery), [searchQuery]);
  const viewEntries = useMemo(() => getCategoryEntries(VIEW_CATEGORY, searchQuery), [searchQuery]);
  const sessionEntries = useMemo(() => getCategoryEntries(SESSION_CATEGORY, searchQuery), [searchQuery]);
  const tabEntries  = useMemo(() => getCategoryEntries(TAB_CATEGORY,  searchQuery), [searchQuery]);

  return (
    <div className="flex max-h-[80vh] flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-foreground/10 px-4 py-3">
        <h2 className="shrink-0 text-sm font-semibold">{translate('keyboard.cheatSheetTitle')}</h2>
        <div className="relative flex-1">
          <input
            type="text"
            placeholder={translate('keyboard.cheatSheetSearch')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full rounded-md border border-foreground/10 bg-[var(--em-surface-input)] px-3 py-1.5 text-sm text-foreground placeholder:text-foreground-muted/60 focus:outline-none focus:border-border-1"
          />
        </div>
        <button
          type="button"
          onClick={() => onClose()}
          className="shrink-0 rounded-sm p-1 text-foreground-muted transition-colors hover:text-foreground"
          aria-label={translate('common.close')}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path
              d="M1 1L13 13M1 13L13 1"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      {/* Content: complex grid layout */}
      <div className="overflow-hidden p-4 flex-1 min-h-0">
        <div
          className="grid gap-4"
          style={{
            gridTemplateAreas: '"nav kbd sessions" "nav vtabs sessions"',
            gridTemplateColumns: '1fr 2fr 1fr',
          }}
        >
          {/* Navigation (left, spans 2 rows, independently scrollable) */}
          <div
            style={{ gridArea: 'nav', maxHeight: 'calc(80vh - 130px)', overflowY: 'auto' }}
            className="pr-1"
          >
            <CategorySection
              category={NAV_CATEGORY}
              categoryLabel={translate('keyboard.categoryNavigation')}
              entries={navEntries}
              keyboard={keyboard}
              activeShortcut={activeShortcut}
              onActivate={setActiveShortcut}
            />
          </div>

          {/* Keyboard SVG (center-top, sticky) */}
          <div style={{ gridArea: 'kbd' }} className="sticky top-4 flex flex-col items-start gap-2">
            <p className="text-tiny text-foreground-muted">{translate('keyboard.hoverHint')}</p>
            <MacKeyboard highlightedKeys={highlightedKeys} />
          </div>

          {/* Task View (right, spans 2 rows, independently scrollable) */}
          <div
            style={{ gridArea: 'tasks', maxHeight: 'calc(80vh - 130px)', overflowY: 'auto' }}
            className="pl-1"
          >
            <CategorySection
              category={SESSION_CATEGORY}
              categoryLabel={translate('keyboard.categoryTaskView')}
              entries={sessionEntries}
              keyboard={keyboard}
              activeShortcut={activeShortcut}
              onActivate={setActiveShortcut}
            />
          </div>

          {/* View + Tab Navigation (center-bottom, side by side) */}
          <div style={{ gridArea: 'vtabs' }} className="grid grid-cols-2 gap-x-4 items-start">
            <CategorySection
              category={VIEW_CATEGORY}
              categoryLabel={translate('keyboard.categoryView')}
              entries={viewEntries}
              keyboard={keyboard}
              activeShortcut={activeShortcut}
              onActivate={setActiveShortcut}
            />
            <TabNavSection
              entries={tabEntries}
              keyboard={keyboard}
              activeShortcut={activeShortcut}
              onActivate={setActiveShortcut}
            />
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between border-t border-foreground/10 px-4 py-2">
        <div className="flex items-center gap-3 text-tiny text-foreground-muted">
          <span>
            <kbd className="rounded-sm border border-foreground/10 px-1 font-mono text-micro">↑</kbd>
            <kbd className="ml-0.5 rounded-sm border border-foreground/10 px-1 font-mono text-micro">↓</kbd>
            {` ${translate('keyboard.legendSelect')}`}
          </span>
          <span>
            <kbd className="rounded-sm border border-foreground/10 px-1 font-mono text-micro">Enter</kbd>
            {` ${translate('keyboard.legendPin')}`}
          </span>
          <span>
            <kbd className="rounded-sm border border-foreground/10 px-1 font-mono text-micro">Esc</kbd>
            {` ${translate('keyboard.legendClose')}`}
          </span>
        </div>
        <p className="text-tiny text-foreground-muted">
          {translate('keyboard.customizeHint')}
        </p>
      </div>
    </div>
  );
};
