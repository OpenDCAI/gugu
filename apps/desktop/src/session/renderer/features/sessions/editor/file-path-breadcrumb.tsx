import { ChevronRight, CornerLeftUp, Folder } from '@/lib/icons'
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator';
import { useEffect, useRef, useState } from 'react';
import { useSessionViewContext, useWorkspaceSurface } from '@renderer/features/sessions/session-view-context';
import { workspaceBackend } from '@renderer/features/sessions/workspace-backend/workspace-backend';
import { FileIcon } from '@renderer/lib/editor/file-icon';
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/lib/ui/popover';
import { cn } from '@renderer/utils/utils';
import type { DirectoryEntry } from '@shared/core/fs/fs';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

// @@@sessionpage layout — absolute-path breadcrumb for file tabs (product spec 文件 tab):
// every segment is clickable and drops down a listing of that directory, so siblings are one click
// away. Directories drill in within the same popover; files open through the same editor path as
// the file tree.

function pathSegments(path: string): string[] {
  return path.replace(/\\/g, '/').split('/').filter(Boolean);
}

function parentDir(path: string): string | null {
  const segments = pathSegments(path);
  if (segments.length <= 1) return null;
  return `/${segments.slice(0, -1).join('/')}`;
}

export function FilePathBreadcrumb({ path }: { path: string }) {
  const segments = pathSegments(path);
  const folders = segments.slice(0, -1);
  const fileName = segments.at(-1) ?? path;
  const scrollRef = useRef<HTMLDivElement>(null);

  // Long paths overflow left; keep the folders' tail (the file's own folder) in view.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [path]);

  // #6950: a narrow pane keeps the file's name. It sits outside the folders' scroll strip and never gives up its own
  // width (capped at the bar, then an ellipsis); the folders give way first, down to nothing. Before, the name was the
  // strip's last item, and the bar's buttons left the whole strip 16px at the default 320px pane: one letter showed.
  return (
    <div className="flex min-w-0 flex-1 items-center whitespace-nowrap" title={path}>
      {folders.length > 0 && (
        <div
          ref={scrollRef}
          className="flex min-w-0 [scrollbar-width:none] items-center overflow-x-auto [&::-webkit-scrollbar]:hidden"
        >
          {folders.map((segment, index) => {
            const dirPath = `/${segments.slice(0, index + 1).join('/')}`;
            return (
              <span key={dirPath} className="flex shrink-0 items-center">
                <BreadcrumbSegment label={segment} dirPath={dirPath} />
                <ChevronRight className="mx-0.5 size-3 shrink-0 text-foreground-passive/60" />
              </span>
            );
          })}
        </div>
      )}
      <span className="max-w-full shrink-0 truncate px-1 text-xs text-foreground">{fileName}</span>
    </div>
  );
}

function BreadcrumbSegment({ label, dirPath }: { label: string; dirPath: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className="rounded-sm px-1 py-0.5 text-xs text-foreground-passive hover:bg-row-hover hover:text-foreground"
        tabIndex={0}
        role="button"
        onMouseDown={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen(!open);
          }
        }}
      >
        {label}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 gap-0 p-1">
        {open && <BreadcrumbDirListing initialDir={dirPath} onNavigate={() => setOpen(false)} />}
      </PopoverContent>
    </Popover>
  );
}

function BreadcrumbDirListing({
  initialDir,
  onNavigate,
}: {
  initialDir: string;
  onNavigate: () => void;
}) {
  const { translate } = useSessionMessages();
  const { projectId } = useSessionViewContext();
  const surface = useWorkspaceSurface();
  const [dir, setDir] = useState(initialDir);
  const [entries, setEntries] = useState<DirectoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    setError(null);
    void (async () => {
      const result = await workspaceBackend(projectId).browseDirectory(surface.workspaceId, dir);
      if (cancelled) return;
      if (result.success) setEntries(result.data);
      else setError(result.error.message);
    })();
    return () => {
      cancelled = true;
    };
  }, [dir, projectId, surface.workspaceId]);

  const parent = parentDir(dir);
  const rowClass =
    'flex w-full cursor-default items-center gap-2 rounded-sm px-2 py-1 text-left text-xs text-foreground outline-hidden select-none hover:bg-row-hover';

  return (
    <div className="flex max-h-72 flex-col overflow-y-auto">
      {parent && (
        <button type="button" className={rowClass} onClick={() => setDir(parent)}>
          <CornerLeftUp className="size-3.5 shrink-0 text-foreground-passive" />
          {/* ❌ 不进翻译目录：".." 是路径里的上级目录记号，不是文案。 */}
          <span className="truncate text-foreground-passive">..</span>
        </button>
      )}
      {error && <div className="px-2 py-1.5 text-xs text-foreground-destructive">{error}</div>}
      {!error && entries === null && (
        <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-foreground-passive">
          <LoadingIndicator size="inline" /> {translate('task.loading')}
        </div>
      )}
      {!error && entries?.length === 0 && (
        <div className="px-2 py-1.5 text-xs text-foreground-passive">{translate('task.emptyDirectory')}</div>
      )}
      {entries?.map((entry) => (
        <button
          key={entry.path}
          type="button"
          className={cn(rowClass, entry.type === 'directory' && 'font-medium')}
          onClick={() => {
            if (entry.type === 'directory') {
              setDir(entry.path);
              return;
            }
            onNavigate();
            surface.openFile(entry.path);
          }}
        >
          {entry.type === 'directory' ? (
            <Folder className="size-3.5 shrink-0 text-foreground-passive" />
          ) : (
            <span className="flex size-3.5 shrink-0 items-center justify-center [&>svg]:h-3 [&>svg]:w-3">
              <FileIcon filename={entry.name} />
            </span>
          )}
          <span className="truncate">{entry.name}</span>
        </button>
      ))}
    </div>
  );
}
