import { LayoutGrid } from '@/lib/icons';
import { cn } from '@renderer/utils/utils';

/**
 * An extension's own mark, or the generic one when it shipped none.
 *
 * `src` is a data URL main produced by re-encoding the declared file, so this
 * `<img>` draws pixels gugu wrote — the extension's bytes never reach the
 * privileged renderer. A decode that failed upstream arrives as no icon at all
 * rather than a broken image. Pure: it takes the URL, it does not read the
 * store, so the entry builders (which stay off the app-state graph) can use it.
 */
export function ExtensionMark({
  iconDataUrl,
  className,
}: {
  iconDataUrl: string | null | undefined;
  className?: string;
}) {
  return (
    <span
      className={cn('inline-flex size-3.5 shrink-0 items-center justify-center', className)}
      aria-hidden
    >
      {iconDataUrl ? (
        <img src={iconDataUrl} alt="" className="size-3.5 rounded-sm object-contain" />
      ) : (
        <LayoutGrid className="size-3.5" />
      )}
    </span>
  );
}
