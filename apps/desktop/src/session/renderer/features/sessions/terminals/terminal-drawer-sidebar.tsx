import { useDraggable } from '@dnd-kit/core';
import { ChevronDown, Pause, Play, Plus, Terminal, X } from '@/lib/icons'
import { observer } from 'mobx-react-lite';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { type LifecycleScriptsStore } from '@renderer/features/sessions/stores/lifecycle-scripts';
import { type TerminalTabViewStore } from '@renderer/features/sessions/terminals/terminal-tab-view-store';
import { TerminalShellOptionLabel } from '@renderer/lib/components/terminal-shell-option-label';
import { Button } from '@renderer/lib/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@renderer/lib/ui/dropdown-menu';
import { MicroLabel } from '@renderer/lib/ui/label';
import { BoundShortcut } from '@renderer/lib/ui/shortcut';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/utils/utils';
import type {
  TerminalShellAvailability,
  TerminalShellId,
} from '@shared/core/terminals/terminal-settings';
import { TERMINAL_DRAWER_DRAG_TYPE, type TerminalDrawerDragData } from './terminal-drag';
import { scriptIcon } from './terminal-tabs';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

import { STATE_LAYERS } from '@renderer/lib/ui/state-layers';

interface TerminalDrawerSidebarProps {
  lifecycleScriptsMgr: LifecycleScriptsStore | null;
  activeScriptId: string | undefined;
  onSelectScript: (id: string) => void;
  onRunScript: (id: string) => void;
  onStopScript: (id: string) => void;
  terminalTabView: TerminalTabViewStore;
  activeTerminalId: string | undefined;
  shellAvailability: TerminalShellAvailability[];
  onShellMenuOpen: () => void;
  onSelectTerminal: (id: string) => void;
  onAddTerminal: (shell?: TerminalShellId) => void;
  onRemoveTerminal: (id: string) => void;
  onRenameTerminal: (id: string, name: string) => void;
  onHoverTerminal?: (id: string) => void;
  className?: string;
}

export const TerminalDrawerSidebar = observer(function TerminalDrawerSidebar({
  lifecycleScriptsMgr,
  activeScriptId,
  onSelectScript,
  onRunScript,
  onStopScript,
  terminalTabView,
  activeTerminalId,
  shellAvailability,
  onShellMenuOpen,
  onSelectTerminal,
  onAddTerminal,
  onRemoveTerminal,
  onRenameTerminal,
  onHoverTerminal,
  className,
}: TerminalDrawerSidebarProps) {
  const { translate } = useSessionMessages();
  const scripts = lifecycleScriptsMgr?.tabs ?? [];
  const terminals = terminalTabView.tabs;


  return (
    <div className={cn('flex flex-col overflow-y-auto text-sm', className)}>
      <Section
        label={translate('task.terminals')}
        action={
          <div className="flex items-center">
            <Tooltip>
              <TooltipTrigger render={
                <button
                  className="flex size-5 items-center justify-center rounded-l text-foreground-muted hover:bg-row-hover active:bg-row-press hover:text-foreground"
                  onClick={() => onAddTerminal()}
                >
                  <Plus className="size-3" />
                </button>
              } />
              <TooltipContent>
                {translate('session.newTerminal')}{' '}
                <BoundShortcut commandId="session.newTerminal" variant="keycaps" />
              </TooltipContent>
            </Tooltip>
            <DropdownMenu onOpenChange={(open) => open && onShellMenuOpen()}>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="size-5 rounded-l-none px-0 text-foreground-muted hover:bg-row-hover hover:text-foreground"
                    aria-label={translate('task.newTerminalWithShell')}
                  />
                }
              >
                <ChevronDown className="size-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                {shellAvailability.map((entry) => (
                  <DropdownMenuItem
                    key={entry.id}
                    disabled={!entry.available}
                    title={entry.reason}
                    onClick={() => onAddTerminal(entry.id)}
                  >
                    <TerminalShellOptionLabel entry={entry} />
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        }
      >
        {terminals.map((terminal) => (
          <SidebarRow
            key={terminal.data.id}
            icon={<Terminal className="size-3" />}
            label={terminal.data.name}
            isActive={activeTerminalId === terminal.data.id}
            dragId={`terminal-drawer-${terminal.data.id}`}
            dragData={{
              type: TERMINAL_DRAWER_DRAG_TYPE,
              terminalId: terminal.data.id,
              label: terminal.data.name,
            }}
            onSelect={() => onSelectTerminal(terminal.data.id)}
            onRename={(name) => onRenameTerminal(terminal.data.id, name)}
            onHover={onHoverTerminal ? () => onHoverTerminal(terminal.data.id) : undefined}
            action={
              <Tooltip>
                <TooltipTrigger render={
                  <button
                    className="ml-1 flex size-5 shrink-0 items-center justify-center rounded-sm text-foreground-muted opacity-0 group-hover:opacity-100 hover:bg-row-hover active:bg-row-press hover:text-foreground"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemoveTerminal(terminal.data.id);
                    }}
                  >
                    <X className="size-3" />
                  </button>
                } />
                <TooltipContent>{translate('task.closeTerminal')}</TooltipContent>
              </Tooltip>
            }
          />
        ))}
      </Section>
      {scripts.length > 0 && lifecycleScriptsMgr && (
        <Section label={translate('task.scripts')}>
          {scripts.map((script) => {
            const isActive = activeScriptId === script.data.id;
            return (
              <SidebarRow
                key={script.data.id}
                icon={scriptIcon(script.data.type)}
                label={script.data.label}
                isActive={isActive}
                onSelect={() => onSelectScript(script.data.id)}
                action={
                  <Tooltip>
                    <TooltipTrigger render={
                      <button
                        className={cn(
                          'ml-1 shrink-0 flex items-center justify-center size-5 rounded-sm hover:bg-row-hover active:bg-row-press text-foreground-muted hover:text-foreground',
                          !isActive && 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
                        )}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (script.isRunning) {
                            onStopScript(script.data.id);
                          } else {
                            onRunScript(script.data.id);
                          }
                        }}
                      >
                        {script.isRunning ? (
                          <Pause className="size-3" />
                        ) : (
                          <Play className="size-3" />
                        )}
                      </button>
                    } />
                    <TooltipContent>{script.isRunning ? 'Stop' : 'Run'}</TooltipContent>
                  </Tooltip>
                }
              />
            );
          })}
        </Section>
      )}
    </div>
  );
});

interface SidebarRowProps {
  icon?: ReactNode;
  label: string;
  isActive: boolean;
  onSelect: () => void;
  onRename?: (name: string) => void;
  onHover?: () => void;
  action?: ReactNode;
  dragId?: string;
  dragData?: TerminalDrawerDragData;
}

function SidebarRow({
  icon,
  label,
  isActive,
  onSelect,
  onRename,
  onHover,
  action,
  dragId,
  dragData,
}: SidebarRowProps) {
  const [isEditing, setIsEditing] = useState(false);
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({
    id: dragId ?? `terminal-sidebar-row-${label}`,
    data: dragData,
    disabled: !dragData,
  });

  if (isEditing && onRename) {
    return (
      <div
        className={cn(
          'group flex items-center gap-1.5 px-3 py-1 rounded-md',
          isActive && 'bg-background-2'
        )}
      >
        {icon && <span className="shrink-0 text-foreground-muted">{icon}</span>}
        <InlineRenameInput
          initialValue={label}
          onConfirm={(name) => {
            setIsEditing(false);
            if (name && name !== label) onRename(name);
          }}
          onCancel={() => setIsEditing(false)}
        />
      </div>
    );
  }

  return (
    <div
      ref={setDragRef}
      className={cn(
        'group flex items-center justify-between px-3 py-1.5 cursor-pointer hover:bg-row-hover rounded-md',
        dragData && 'cursor-grab active:cursor-grabbing',
        isActive && `bg-background-2 text-foreground hover:bg-background-2 ${STATE_LAYERS}`,
        isDragging && 'opacity-50'
      )}
      onClick={onSelect}
      onMouseEnter={onHover}
      onDoubleClick={(e) => {
        if (!onRename) return;
        e.stopPropagation();
        setIsEditing(true);
      }}
      {...attributes}
      {...listeners}
    >
      <span
        className={cn(
          'flex items-center gap-1.5 min-w-0 truncate text-foreground-muted',
          isActive && 'text-foreground'
        )}
      >
        {icon && <span className="shrink-0">{icon}</span>}
        <span className="truncate">{label}</span>
      </span>
      {action}
    </div>
  );
}

function InlineRenameInput({
  initialValue,
  onConfirm,
  onCancel,
}: {
  initialValue: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  return (
    <input
      ref={ref}
      className="w-full rounded-sm border border-border bg-transparent px-1 py-0.5 text-sm text-foreground outline-none"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onConfirm(value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onConfirm(value);
        if (e.key === 'Escape') onCancel();
        e.stopPropagation();
      }}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

function Section({
  label,
  action,
  children,
}: {
  label: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between px-4 pt-4">
        <MicroLabel>{label}</MicroLabel>
        {action}
      </div>
      <div className="flex flex-col gap-0.5 p-2">{children}</div>
    </div>
  );
}
