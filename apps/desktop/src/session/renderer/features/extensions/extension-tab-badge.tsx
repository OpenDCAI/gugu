import { observer } from 'mobx-react-lite';

/**
 * The extension's unread/count mark on its own tab.
 *
 * A count renders as a number and anything else as a plain dot: an extension
 * that wants to say「有新东西」should not have to invent a number, and a long
 * string in a tab chip would push the title out. Zero renders nothing — an
 * extension counting down to zero means "nothing to see", not "show me a 0".
 */
export const ExtensionTabBadge = observer(function ExtensionTabBadge({
  badge,
}: {
  badge: number | string | null;
}) {
  if (badge === null) return null;
  if (typeof badge === 'number') {
    if (!Number.isFinite(badge) || badge <= 0) return null;
    const shown = badge > 99 ? '99+' : String(Math.floor(badge));
    return (
      <span className="min-w-4 rounded-full bg-foreground px-1 text-center text-micro leading-4 font-medium text-background">
        {shown}
      </span>
    );
  }
  if (badge.trim().length === 0) return null;
  return <div className="size-2 rounded-full bg-foreground" title={badge} />;
});
