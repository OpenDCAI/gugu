import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import { Check, FileCode, Folder } from '@/lib/icons'
import { useId, useLayoutEffect, useRef, useState } from 'react';
import { log } from '@renderer/utils/logger';
import { formatBytes } from '@renderer/utils/formatBytes';
import { cn } from '@renderer/utils/utils';
import type { DirectoryEntry } from '@shared/core/fs/fs';
import { normalizePath } from './paths';

// The row height, in one place: it both spaces the rows (the virtualizer lays
// them out from it) and sizes them (each row's inline height is the slot the
// virtualizer hands back). Padding or a border added to a row would still push
// its painted box past that slot and overlap the next row.
const ROW_HEIGHT = 40;
const FALLBACK_PAGE_STEP = 8;

/**
 * Walk from `from` in `step` direction to the first directory entry.
 *
 * The picker exists to choose a directory; files are context, not targets. A
 * repo checkout easily holds hundreds of files and a handful of subdirectories,
 * so visiting files would bury every real choice under dead stops.
 */
function findDirectoryIndex(entries: DirectoryEntry[], from: number, step: number): number {
  for (let index = from; index >= 0 && index < entries.length; index += step) {
    if (entries[index]?.type === 'directory') return index;
  }
  return -1;
}

/** Move `count` directories along, stopping at the end instead of wrapping. */
function stepDirectories(
  entries: DirectoryEntry[],
  from: number,
  step: number,
  count: number
): number {
  let index = from;
  for (let moved = 0; moved < count; moved += 1) {
    const next = findDirectoryIndex(entries, index + step, step);
    if (next < 0) break;
    index = next;
  }
  return index;
}

interface DirectoryListProps {
  /**
   * Must be referentially stable for the lifetime of one listing: the cursor's
   * ownership check below is by array identity, so a derived array rebuilt on
   * every parent render would silently reset the cursor on each keystroke.
   */
  entries: DirectoryEntry[];
  /** Which listing these entries are; a change parks the cursor and scroll at the top. */
  loadedPath: string | null;
  /** The already-chosen project path, if it happens to be in view. */
  chosenPath: string;
  isBusy: boolean;
  error: string | null;
  onOpenDirectory: (entry: DirectoryEntry) => void;
  onNavigateUp: () => void;
  /** False at the filesystem root, where there is no parent to go up to. */
  canNavigateUp: boolean;
}

/**
 * The directory listing: one scrollable listbox, arrow-key cursor, virtualized
 * rows.
 *
 * The scroll container and the virtualizer live in the same component on
 * purpose. A virtualizer only re-reads `getScrollElement()` from its owner's
 * layout effect, so an owner that is *not* the thing being lazily mounted never
 * learns the element appeared — which is how the popover-mounts-a-commit-later
 * bug happened. Mounting them together makes that unreachable rather than
 * worked around.
 */
export function DirectoryList({
  entries,
  loadedPath,
  chosenPath,
  isBusy,
  error,
  onOpenDirectory,
  onNavigateUp,
  canNavigateUp,
}: DirectoryListProps) {
  const { translate } = useSessionMessages();
  const listboxId = useId();
  const scrollRef = useRef<HTMLDivElement>(null);

  // The cursor is a position *within one listing*, so it is stored together
  // with the listing it belongs to. Read against any other entries array it is
  // meaningless — that mismatch is what #3693 crashed on: a click in a 167-row
  // listing parked the cursor at 67, the 3-row target listing rendered before
  // any effect could reset it, and the rangeExtractor below injected the
  // out-of-range index into the virtualizer.
  const [cursor, setCursor] = useState<{
    entries: DirectoryEntry[];
    loadedPath: string | null;
    index: number;
  }>(() => ({ entries, loadedPath, index: findDirectoryIndex(entries, 0, 1) }));

  // Array identity is the primary discriminator: every load — including
  // back-navigation to a cached directory — swaps in a different array than the
  // one the cursor was parked against. `loadedPath` is the second key for the
  // transitions where identity alone is ambiguous (connection switch/loss,
  // where the listing is cleared and restored around the same arrays).
  const cursorIsCurrent = cursor.entries === entries && cursor.loadedPath === loadedPath;
  // Park the cursor on the first directory of whatever is now listed. Adjusted
  // during render, not in an effect: an effect only runs after the new listing
  // has already been committed once with the stale cursor — one frame where
  // `aria-activedescendant` names the wrong row, or, out of range, the crash
  // above. A render that sees a foreign cursor recomputes it and never commits
  // the stale value.
  const activeIndex = cursorIsCurrent ? cursor.index : findDirectoryIndex(entries, 0, 1);
  if (!cursorIsCurrent) setCursor({ entries, loadedPath, index: activeIndex });

  const setActiveIndex = (index: number) => setCursor({ entries, loadedPath, index });

  // One shallow listing can legitimately hold six figures of entries now that
  // the SSH read is a single round trip (#3188). Rendering a row per entry
  // freezes the renderer, so only the visible window is mounted.
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 6,
    // Keep the cursor row mounted even when it is scrolled far out of view.
    // `aria-activedescendant` names an element by id, so it resolves to nothing
    // once virtualization unmounts that row — and a wheel scroll moves the
    // window without touching the cursor. Arrow keys scroll the cursor back
    // into view, but the mouse can leave it behind.
    rangeExtractor: (range) => {
      const indexes = new Set(defaultRangeExtractor(range));
      // `< range.count` enforces the virtualizer's contract rather than fixing
      // anything here: handed an out-of-range index it does not throw at the
      // injection site but silently emits an `undefined` virtual item, which
      // detonates wherever the rows are consumed. Unreachable while cursor
      // ownership holds, so if it ever fires, scream — a silent skip would
      // demote that regression to a months-lived dangling-aria bug.
      if (activeIndex >= range.count) {
        log.error('[directory-list] cursor outside listing', { activeIndex, count: range.count });
      } else if (activeIndex >= 0) {
        indexes.add(activeIndex);
      }
      return [...indexes].sort((left, right) => left - right);
    },
  });

  // The scroll box is one persistent node across navigations, so without this
  // a new listing inherits the previous one's offset: descend from a folder
  // found near the bottom of a huge directory and the next directory opens
  // scrolled thousands of rows down, with the cursor parked far off-screen.
  // Layout effect, not passive: a passive effect lets one frame of the new
  // listing paint at the stale offset before snapping to the top. Scrolling is
  // imperative DOM work, so unlike the cursor reset above it cannot move into
  // render — hence an effect keyed on values its body does not read.
  useLayoutEffect(() => {
    virtualizer.scrollToOffset(0);
  }, [entries, loadedPath, virtualizer]);

  const activateEntry = (index: number) => {
    // The loading overlay only stops the mouse. Without this guard a keyboard
    // user can still activate a stale row mid-load, which bumps the request id
    // and silently discards the read already in flight — the same
    // 「点了没反应」 the overlay exists to prevent.
    if (isBusy) return;
    const entry = entries[index];
    if (entry?.type !== 'directory') return;
    setActiveIndex(index);
    onOpenDirectory(entry);
  };

  const moveCursor = (nextIndex: number) => {
    if (nextIndex < 0) return;
    // Scroll first and unconditionally: pressing Home while the cursor is
    // already on the first directory is exactly how a user asks to be taken
    // back to it after wheel-scrolling away, and skipping the scroll whenever
    // the index is unchanged makes that keypress do nothing.
    virtualizer.scrollToIndex(nextIndex);
    if (nextIndex !== activeIndex) setActiveIndex(nextIndex);
  };

  // A page is what the list actually shows, not a constant someone picked.
  const pageStep = () => {
    const visibleRows = Math.floor((scrollRef.current?.clientHeight ?? 0) / ROW_HEIGHT);
    return Math.max(1, visibleRows || FALLBACK_PAGE_STEP);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (isBusy) return;
    const from = activeIndex;
    switch (event.key) {
      case 'ArrowDown':
        moveCursor(stepDirectories(entries, from, 1, 1));
        break;
      case 'ArrowUp':
        moveCursor(stepDirectories(entries, from, -1, 1));
        break;
      case 'PageDown':
        moveCursor(stepDirectories(entries, from, 1, pageStep()));
        break;
      case 'PageUp':
        moveCursor(stepDirectories(entries, from, -1, pageStep()));
        break;
      case 'Home':
        moveCursor(findDirectoryIndex(entries, 0, 1));
        break;
      case 'End':
        moveCursor(findDirectoryIndex(entries, entries.length - 1, -1));
        break;
      case 'Enter':
      case 'ArrowRight':
        activateEntry(from);
        break;
      case 'ArrowLeft':
        if (!canNavigateUp) return;
        onNavigateUp();
        break;
      default:
        return;
    }
    // Only reached for keys handled above: otherwise the scroll container would
    // also scroll natively, and Enter would submit the surrounding form.
    event.preventDefault();
  };

  const renderContent = () => {
    if (isBusy && entries.length === 0) return null;

    if (error) {
      return (
        <div className="text-foreground-destructive flex h-full items-center justify-center px-6 text-center text-sm">
          {error}
        </div>
      );
    }

    if (entries.length === 0) {
      return (
        <div className="text-foreground-muted flex h-full items-center justify-center text-sm">
          {translate('projects.remoteDir.empty')}
        </div>
      );
    }

    return (
      // `role="none"` so the options stay owned by the listbox above: this
      // element only exists to give the scroll container something the height
      // of the whole listing to scroll against.
      <div role="none" className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((row) => {
          const entry = entries[row.index];
          if (!entry) return null;
          const isDirectory = entry.type === 'directory';
          const isChosenPath = normalizePath(chosenPath) === normalizePath(entry.path);

          return (
            <div
              key={entry.path}
              id={`${listboxId}-option-${row.index}`}
              role="option"
              // The keyboard cursor. `aria-selected` is what a listbox reader
              // announces as it arrives on an option, so it has to track the
              // cursor; the already-chosen project path is a different idea and
              // gets `aria-current` below.
              aria-selected={row.index === activeIndex}
              aria-current={isChosenPath || undefined}
              // Mid-read every row is refused by `activateEntry`, so saying
              // they are actionable would promise something that does nothing.
              aria-disabled={!isDirectory || isBusy || undefined}
              // The DOM holds one screenful, so position has to be stated.
              aria-setsize={entries.length}
              aria-posinset={row.index + 1}
              onClick={() => activateEntry(row.index)}
              className={cn(
                'absolute top-0 left-0 flex w-full items-center gap-2 px-3 text-left text-sm',
                isDirectory
                  ? 'cursor-pointer font-medium hover:bg-row-hover'
                  : // Files are context. Dimming the whole row instead pushed
                    // the name below readable contrast and read as "broken".
                    'text-foreground-muted cursor-default',
                // The cursor only shows while the list has focus; a highlight
                // on an unfocused list reads as a stale hover.
                row.index === activeIndex && 'group-focus/dirlist:bg-background-2'
              )}
              style={{ height: row.size, transform: `translateY(${row.start}px)` }}
            >
              {isDirectory ? (
                <Folder className="text-foreground-muted h-4 w-4 shrink-0" />
              ) : (
                <FileCode className="text-foreground-muted h-4 w-4 shrink-0" />
              )}
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
              {isChosenPath && <Check className="text-foreground h-4 w-4 shrink-0" />}
              {!isDirectory && (
                <span className="text-foreground-muted text-xs">{formatBytes(entry.size)}</span>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    // The listbox is the scroll box itself, not the tall spacer inside it: it
    // is the element that is always rendered (so `aria-busy` cannot vanish on
    // the empty/error/first-load states) and the only one with a sane size to
    // draw a focus ring around — the spacer is as tall as the whole listing.
    //
    // A single tab stop with arrow-key navigation, not one stop per row:
    // virtualization means far-off rows are not in the DOM at all, so per-row
    // tab stops could never reach them.
    //
    // The ring is its own focus indicator rather than leaning on the cursor-row
    // highlight: a directory holding only files has no cursor at all
    // (activeIndex is -1), and that must not be a state where focus is
    // invisible. `focus:` and not `focus-visible:` so it matches the cursor
    // highlight, which appears on click-focus too — the list is only ever
    // focused deliberately.
    <div
      ref={scrollRef}
      role="listbox"
      aria-label={translate('projects.remoteDir.listLabel')}
      aria-busy={isBusy}
      aria-activedescendant={
        activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined
      }
      tabIndex={0}
      onKeyDown={handleKeyDown}
      // @@@state-ladder-mix 本轮「焦点环全废」清理**刻意跳过这一处**。它不是装饰性焦点环:
      // 叶子目录(只有文件、没有子目录)时 activeIndex = -1、没有任何行被高亮,容器这圈环是
      // 键盘用户唯一的焦点指示(WCAG 2.4.7)。remote-directory-selector-style.test.tsx 里
      // 「should show where focus is even when the directory has no subdirectories」就是守它的。
      // 与 product spec「任何情况都无环」冲突,已上报 owner 裁决,未裁决前保留。
      className="group/dirlist absolute inset-0 overflow-y-auto focus:ring-2 focus:ring-inset focus:ring-border-primary focus:outline-none"
    >
      {renderContent()}
    </div>
  );
}
