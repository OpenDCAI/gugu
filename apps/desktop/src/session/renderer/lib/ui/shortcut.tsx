import { detectPlatform, parseHotkey, type Hotkey } from '@tanstack/react-hotkeys';
import { ArrowBigUp } from '@/lib/icons'
import { useMemo } from 'react';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import {
  getEffectiveHotkey,
  type CommandId,
} from '@renderer/lib/hooks/useKeyboardShortcuts';
import { cn } from '@renderer/utils/utils';
import { Kbd } from './kbd';
import {
  describeShortcut,
  formatShortcutKey,
  getShortcutKeyOpticalAlignClass,
  getShortcutKeys,
} from './shortcut-format';

const PLATFORM = detectPlatform();

type ShortcutVariant = 'text' | 'badge' | 'keycaps';

const KEYCAP_KBD_BASE_CLASS =
  'h-5 min-w-5 shrink-0 rounded-sm px-1 text-tiny font-medium leading-none text-current';

// @@@keycap-is-printed (Refs #6106) — Kbd 在 kit 里是「Keyboard keys as printed caps」:
// **印刷**,不是模拟一颗会按下去的物理键。
//   · 原来这里有四条 `shadow-[inset_0_±1px_0_rgba(255,255,255,0.05|0.1)]`,用写死的白色高光
//     捏立体感。白色不随主题走 ⇒ 同一枚键帽在明暗两套里是两种观感,而 design.md 既拒绝
//     ornamental shadows、也拒绝写死 `#fff`/`rgba(255,255,255,…)`。全部删掉。
//   · 原来还按**四个宿主**各写一套皮肤,其中 combobox-trigger 与 dropdown-menu-item 两套与
//     基础态逐字相同 —— 那是复制不是变体。宿主只分两种:普通面,和**反相面**(墨底的主按钮 /
//     tooltip)。反相面上墨线画在墨底上等于看不见,所以只有这一格需要把线翻过去。
//   · 底色不再覆写:Kbd 自己就是 bg-background-2,tooltip 那一格它也自带。
const KEYCAP_KBD_CLASS = cn(
  KEYCAP_KBD_BASE_CLASS,
  'border border-border/60',
  'in-data-[variant=default]:border-primary-button-foreground/22 in-data-[variant=default]:bg-primary-button-foreground/16',
  'in-data-[slot=tooltip-content]:border-background/20'
);

interface ShortcutProps {
  hotkey: Hotkey | null | undefined;
  className?: string;
  variant?: ShortcutVariant;
}

function ShortcutKey({ keyName }: { keyName: string }) {
  if (keyName === 'Shift' && PLATFORM === 'mac') {
    return <ArrowBigUp aria-hidden="true" className="size-[11px]" strokeWidth={2.25} />;
  }

  return (
    <span
      aria-hidden="true"
      className={cn('inline-block', getShortcutKeyOpticalAlignClass(keyName))}
    >
      {formatShortcutKey(keyName, PLATFORM)}
    </span>
  );
}

/** Display a shortcut when the hotkey string is already resolved. */
function Shortcut({ hotkey, className, variant = 'text' }: ShortcutProps) {
  const parsed = useMemo(() => {
    if (!hotkey) return null;
    return parseHotkey(hotkey, PLATFORM);
  }, [hotkey]);

  if (!parsed) return null;

  const keys = getShortcutKeys(parsed, PLATFORM);

  return (
    <span
      data-slot="shortcut"
      role="img"
      aria-label={describeShortcut(parsed, PLATFORM)}
      className={cn(
        variant === 'text' &&
          'inline-flex shrink-0 items-center justify-center gap-0 rounded-sm px-1.5 py-1 text-xs leading-none text-foreground-muted in-data-[slot=tooltip-content]:text-background',
        variant === 'badge' &&
          'inline-flex shrink-0 items-center justify-center gap-0 rounded-sm bg-background-secondary px-1.5 py-1 text-xs leading-none text-foreground/60 in-data-[slot=tooltip-content]:bg-background/20 in-data-[slot=tooltip-content]:py-0.5 in-data-[slot=tooltip-content]:text-background dark:in-data-[slot=tooltip-content]:bg-background/10',
        variant === 'keycaps' &&
          'inline-flex shrink-0 items-center gap-0.5 text-foreground-muted in-data-[slot=button]:text-current in-data-[slot=combobox-trigger]:text-current in-data-[slot=tooltip-content]:text-background',
        className
      )}
    >
      {keys.map((key, index) =>
        variant === 'keycaps' ? (
          <Kbd key={`${key}-${index}`} aria-hidden="true" className={KEYCAP_KBD_CLASS}>
            <ShortcutKey keyName={key} />
          </Kbd>
        ) : (
          <ShortcutKey key={`${key}-${index}`} keyName={key} />
        )
      )}
    </span>
  );
}

interface BoundShortcutProps {
  commandId: CommandId;
  className?: string;
  variant?: ShortcutVariant;
}

/** Display a shortcut directly from an app shortcut settings key. */
function BoundShortcut({ commandId, className, variant }: BoundShortcutProps) {
  const { value: keyboard } = useAppSettingsKey('keyboard');
  const hotkey = getEffectiveHotkey(commandId, keyboard);

  return <Shortcut hotkey={hotkey} className={className} variant={variant} />;
}

export { BoundShortcut, Shortcut, type ShortcutVariant };
