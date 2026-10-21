import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  McpServerPanel,
  type McpServer as AssistantMcpServer,
} from '@/components/assistant-ui/elements/mcp-server-panel';
import { mono } from '@/components/assistant-ui/elements/surfaces';
import { BookOpen } from '@/lib/icons';
import { cn } from '@/lib/utils';
import { Button } from '@renderer/lib/ui/button';
import { Popover, PopoverContent } from '@renderer/lib/ui/popover';
import { Switch } from '@renderer/lib/ui/switch';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

export interface McpSessionPanelAdapterServer {
  /** Harness configuration key, which is also the stable id sent to reload. */
  name: string;
  /** Whether this server was present in the running session. */
  enabled: boolean;
  /** Built-in product servers are visible but never part of the user toggle set. */
  readOnly?: boolean;
  /** #6387 Set when an installed extension put this program into the session. */
  extension?: { id: string; name: string };
  /**
   * 资源库 → MCP(取会话记下的送达事实):`delivered` = 送进来了;`shadowed` = 这一家自己配的这一台,咕咕列表里也有
   * 同名的、这里用的是它自己的;其余是勾了没送的原因:资源库里已删 / 这条腿收不到 / 只收 http / 和咕咕自己的撞了。
   */
  library?: 'delivered' | 'shadowed' | 'missing' | 'no-channel' | 'no-stdio' | 'collides';
  /** `collides`:撞了咕咕自己的哪一台。 */
  libraryWith?: string;
}

/** #6387 A skill an installed extension put into the session. */
export interface McpSessionPanelAdapterSkill {
  name: string;
  extension: { id: string; name: string };
}

export interface McpSessionPanelAdapterProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anchor?: HTMLElement | null;
  servers: readonly McpSessionPanelAdapterServer[];
  skills: readonly McpSessionPanelAdapterSkill[];
  toggleSupported: boolean;
  harnessName: string;
  granularity: 'per-server' | 'all-or-none';
  onApply: (enabledServerNames: string[]) => void;
}

/** Keeps the popover off the window edges; a longer list scrolls inside it. */
const VIEWPORT_MARGIN = 16;

function initialDraft(servers: readonly McpSessionPanelAdapterServer[]) {
  return Object.fromEntries(servers.filter((server) => !server.readOnly).map((server) => [server.name, server.enabled]));
}

/** 资源库那台撞了咕咕自己的同名一台时,两行同名 —— 行键带上来源。 */
function rowKey(server: McpSessionPanelAdapterServer) {
  return `${server.library ?? server.extension?.id ?? 'session'}:${server.name}`;
}

/**
 * Gugu owns the session-level controls; assistant-ui owns the panel markup.
 * The panel stays a direct registry copy, while this adapter supplies the
 * session draft, disabled explanation, and the existing reload hand-off.
 */
export function McpSessionPanelAdapter({
  open,
  onOpenChange,
  anchor,
  servers,
  skills,
  toggleSupported,
  harnessName,
  granularity,
  onApply,
}: McpSessionPanelAdapterProps) {
  const { translate } = useSessionMessages();
  const [draft, setDraft] = useState<Record<string, boolean>>(() => initialDraft(servers));
  const popupRef = useRef<HTMLDivElement | null>(null);
  // State, not a ref: the popup mounts after `open` flips, and the measuring effect has to run
  // again once the element it measures exists.
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  /**
   * Where each server row of the assistant-ui panel actually sits. The switches and notes are laid
   * over those rows, so they are placed from the measured rows — a guessed row height drifts a few
   * pixels per row and, seven rows down, a switch sits beside the wrong server.
   */
  const [rowBoxes, setRowBoxes] = useState<{ top: number; height: number }[]>([]);

  // Keep the composer trigger for ownership/scroll context, but place this controlled popover at
  // the viewport's centre through Base UI's virtual-anchor support. The anchor sits half the
  // popup's own height above the centre and the popup opens below it — ❌ no translate: once the
  // popup was taller than half the window, collision handling moved it and the translate then
  // pushed its top off screen.
  const viewportAnchor = useMemo(
    () => ({
      contextElement: anchor ?? undefined,
      getBoundingClientRect: () => {
        const height = popupRef.current?.offsetHeight ?? 0;
        const x = window.innerWidth / 2;
        const y = Math.max(VIEWPORT_MARGIN, (window.innerHeight - height) / 2);
        return { x, y, top: y, right: x, bottom: y, left: x, width: 0, height: 0 };
      },
    }),
    [anchor]
  );

  useEffect(() => {
    if (open) {
      setDraft(initialDraft(servers));
    }
  }, [open, servers]);

  useLayoutEffect(() => {
    if (!frame) return;
    const measure = () => {
      const panel = frame.querySelector('[data-slot="mcp-server-panel"]');
      if (!panel) return;
      // The panel's first child is its header; every child after it is one server row. Layout
      // offsets, ❌ not getBoundingClientRect: the popup opens with a zoom-in, and a rect read
      // mid-animation is scaled — every row came out a little higher than the one before.
      // (The frame is the rows' offsetParent — it is the positioned element around them.)
      setRowBoxes(
        [...panel.children].slice(1).map((row) => {
          const element = row as HTMLElement;
          return { top: element.offsetTop, height: element.offsetHeight };
        })
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [frame, servers]);

  useEffect(() => {
    if (!open) return;
    // Base UI's default focus walk lands on the first assistant-ui server row. Keep the
    // popover visually neutral on open; row focus remains available after an explicit key/tab move.
    const raf = requestAnimationFrame(() => {
      const content = document.querySelector<HTMLElement>('[data-testid="mcp-session-popover"]');
      content?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(raf);
  }, [open]);

  const panelServers = useMemo<AssistantMcpServer[]>(
    () =>
      servers.map((server) => ({
        id: rowKey(server),
        name: server.name,
        // The session panel intentionally has no transport/tool facts. The
        // registry component still receives its required shape without
        // inventing runtime details that this RPC does not provide.
        transport: '',
        status: server.enabled ? 'connected' : 'failed',
        tools: [],
      })),
    [servers]
  );

  const toggleableServers = servers.filter((server) => !server.readOnly);
  const changed = servers.some(
    (server) => !server.readOnly && (draft[server.name] ?? server.enabled) !== server.enabled
  );
  const groupMode = granularity === 'all-or-none' && toggleableServers.length > 0;
  const groupOn = toggleableServers.some((server) => draft[server.name] ?? server.enabled);
  const disabledReason = toggleSupported
    ? undefined
    : translate('mcpSession.unsupported', { harness: harnessName });
  // 覆盖掉面板自带的 paper 表面(圆角/边框/底色/阴影)(design.md:一层浮层只许有一层抬升 ——
  // PopoverContent 已经是那层表面,这里不该再叠一层卡)。
  const panelClassName =
    "rounded-none border-0 bg-transparent shadow-none dark:bg-transparent pr-12 pt-0 pb-1 [&>div:first-child]:hidden [&>div>button>svg:first-child]:hidden [&>div>button>span:nth-of-type(2)]:hidden [&>div>button>span[aria-hidden]]:hidden [&>div>button>span.sr-only]:hidden [&_.bg-red-500]:border [&_.bg-red-500]:border-foreground/30 [&_.bg-red-500]:bg-transparent";

  const rowNote = (server: McpSessionPanelAdapterServer) => {
    if (server.extension) return translate('mcpSession.fromExtension', { name: server.extension.name });
    if (server.library === 'delivered') return translate('mcpSession.fromLibrary');
    if (server.library === 'missing') return translate('mcpSession.libraryMissing');
    if (server.library === 'shadowed') return translate('mcpSession.libraryShadowed', { harness: harnessName });
    if (server.library === 'no-channel') return translate('mcpSession.libraryNoChannel', { harness: harnessName });
    if (server.library === 'no-stdio') return translate('mcpSession.libraryNoStdio');
    if (server.library === 'collides') return translate('mcpSession.libraryCollides', { name: server.libraryWith ?? '' });
    if (server.readOnly) return translate('mcpSession.builtIn');
    if (!server.enabled) return translate('mcpSession.notInThisTask');
    return null;
  };

  const apply = () => {
    if (!changed || !toggleSupported) return;
    onOpenChange(false);
    onApply(
      toggleableServers
        .filter((server) => draft[server.name] ?? server.enabled)
        .map((server) => server.name)
    );
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverContent
        anchor={viewportAnchor}
        align="center"
        sideOffset={0}
        className="w-[min(384px,92vw)] gap-0 overflow-visible p-0"
        data-testid="mcp-session-popover"
      >
        <div ref={popupRef} className="flex flex-col">
          <div
            ref={setFrame}
            className="relative flex max-h-[calc(100vh-96px)] flex-col overflow-y-auto"
            data-testid="mcp-session-list"
          >
            {/* 原件的抬头是写死的英文「Servers · N of M connected」:整行藏掉,这里按界面语言写一行同样的标题。 */}
            <div className="px-4 pt-3 pb-1">
              <span className="text-[length:var(--font-body)] font-medium">{translate('mcpSession.panelTitle')}</span>
            </div>
            <McpServerPanel
              servers={panelServers}
              className={panelClassName}
              data-testid="mcp-session-panel"
            />

            {/* 行尾说明与开关叠在面板那一行上(面板是 assistant-ui 原件,不改它的标记)。 */}
            {servers.map((server, index) => {
              const box = rowBoxes[index];
              if (!box) return null;
              const note = rowNote(server);
              return (
                <div
                  key={rowKey(server)}
                  className="pointer-events-none absolute inset-x-3 flex items-center justify-end gap-2"
                  style={{ top: box.top, height: box.height }}
                  data-testid={`mcp-session-row-${server.name}`}
                >
                  {note && (
                    <span className="pointer-events-auto max-w-[60%] truncate text-tiny text-foreground-muted" title={note}>
                      {note}
                    </span>
                  )}
                  {!server.readOnly && !groupMode && (
                    <Switch
                      className="pointer-events-auto"
                      checked={draft[server.name] ?? server.enabled}
                      disabled={!toggleSupported}
                      aria-label={server.name}
                      data-testid={`mcp-session-switch-${server.name}`}
                      onCheckedChange={(next) =>
                        setDraft((previous) => ({ ...previous, [server.name]: next }))
                      }
                    />
                  )}
                </div>
              );
            })}

            {groupMode && (
              <div className="absolute right-3 top-3 flex items-center">
                <Switch
                  checked={groupOn}
                  disabled={!toggleSupported}
                  aria-label={translate('mcpSession.groupLabel', { harness: harnessName, count: String(toggleableServers.length) })}
                  data-testid="mcp-session-group-switch"
                  onCheckedChange={(next) =>
                    setDraft((previous) => ({
                      ...previous,
                      ...Object.fromEntries(toggleableServers.map((server) => [server.name, next])),
                    }))
                  }
                />
              </div>
            )}

            {(toggleableServers.length === 0 || disabledReason) && (
              <div className="flex flex-col gap-1 px-4 pb-1 text-xs text-foreground-muted">
                {toggleableServers.length === 0 && (
                  <p data-testid="mcp-session-empty">{translate('mcpSession.empty')}</p>
                )}
                {disabledReason && <p data-testid="mcp-session-unsupported">{disabledReason}</p>}
              </div>
            )}

            {skills.length > 0 && (
              <div className="flex flex-col gap-1 px-3 pt-2" data-testid="mcp-session-skills">
                <div className="flex items-baseline justify-between pb-1 pl-1">
                  <span className="text-[length:var(--font-body)] font-medium">{translate('mcpSession.skillsTitle')}</span>
                  <span className={cn(mono, 'text-foreground/35 tabular-nums')}>{skills.length}</span>
                </div>
                {skills.map((skill) => (
                  <div
                    key={`${skill.extension.id}/${skill.name}`}
                    className="flex h-8 items-center gap-2 pl-2"
                    data-testid={`mcp-session-skill-${skill.name}`}
                  >
                    <BookOpen className="size-3.5 shrink-0 text-foreground/35" />
                    <span className="min-w-0 flex-1 truncate text-[length:var(--font-body)]">{skill.name}</span>
                    <span className="max-w-[60%] shrink-0 truncate text-tiny text-foreground-muted">
                      {translate('mcpSession.fromExtension', { name: skill.extension.name })}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 px-3 pb-2 pt-3">
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              {translate('common.cancel')}
            </Button>
            <Button
              size="sm"
              disabled={!changed || !toggleSupported}
              data-testid="mcp-session-apply"
              onClick={apply}
            >
              {translate('mcpSession.apply')}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
