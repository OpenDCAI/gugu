import { AlertTriangle, CheckCircle2, Globe, Info, Pencil, Refresh, Terminal, Trash2, XCircle } from '@/lib/icons';
import React from 'react';
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator';
import { field, mono } from '@renderer/lib/ui/assistant-ui/surfaces';
import { Button } from '@renderer/lib/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/lib/ui/popover';
import { Switch } from '@renderer/lib/ui/switch';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { cn } from '@renderer/utils/utils';
import type { LibraryMcpCheck, LibraryMcpServer } from '@shared/mcp-library';

type RowServer = Omit<LibraryMcpServer, 'enabledByDefault' | 'check'>;

/** 命令行或 URL,给人看:stdio 拼回一行,http 去掉查询串(可能带凭据)。 */
function targetOf(server: RowServer): string {
  if (server.transport === 'http') {
    try {
      const url = new URL(server.url ?? '');
      return url.origin + url.pathname;
    } catch {
      return server.url ?? '';
    }
  }
  return [server.command ?? '', ...(server.args ?? [])].map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(' ');
}

/**
 * 状态图标 + 弹层(照 AionUi:检测中 / 通过 / 失败 / 需要登录 / 未检测),❌ 身份图标。
 * 弹层写明这是手动检测的读数;各家自己的那几台再加一句:是咕咕照那份配置起的。
 */
function CheckStatus({ check, checking, harnessName }: { check?: LibraryMcpCheck; checking: boolean; harnessName?: string }) {
  const { translate } = useSessionMessages();
  const status = checking ? 'checking' : check?.status ?? 'unchecked';
  const icon = {
    checking: <LoadingIndicator size="inline" className="text-foreground-muted" />,
    ok: <CheckCircle2 className="size-4 text-foreground-success" />,
    failed: <XCircle className="size-4 text-foreground-destructive" />,
    'needs-login': <AlertTriangle className="size-4 text-foreground-warning" />,
    unchecked: <Info className="size-4 text-foreground-passive" />,
  }[status];
  const label = translate(`mcpLibrary.status.${status === 'needs-login' ? 'needsLogin' : status}`);
  return (
    <Popover>
      <PopoverTrigger
        data-slot="mcp-check-status"
        data-status={status}
        aria-label={label}
        className="flex size-8 shrink-0 items-center justify-center rounded-md hover:bg-background-2"
      >
        {icon}
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-80 flex-col gap-3 p-4">
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium">{label}</span>
          {check && (
            <span className="text-xs text-foreground-muted">
              {translate('mcpLibrary.statusAt', { time: new Date(check.at).toLocaleString() })}
            </span>
          )}
        </div>
        {check?.failure && (
          <div data-slot="mcp-check-failure" className="flex flex-col gap-1">
            <p className="text-xs text-foreground">
              {translate(`mcpLibrary.failure.${check.failure.kind}`, {
                command: check.failure.command ?? '',
                code: String(check.failure.code ?? ''),
                status: String(check.failure.status ?? ''),
              })}
            </p>
            {check.failure.said && (
              // @@@raw server stderr — server 自己在 stderr 上说的最后一行,它自己的话,原样给人看。
              <p className={cn(mono, 'break-words text-xs text-foreground-muted')}>{check.failure.said}</p>
            )}
          </div>
        )}
        {check?.status === 'needs-login' && <p className="text-xs text-foreground-muted">{translate('mcpLibrary.needsLoginNote')}</p>}
        {check?.status === 'ok' && (
          <div data-slot="mcp-check-tools" className="flex max-h-56 flex-col gap-2 overflow-y-auto">
            <span className="text-xs text-foreground-muted">{translate('mcpLibrary.tools', { count: String(check.tools.length) })}</span>
            {check.tools.map((tool) => (
              <div key={tool.name} className="flex flex-col">
                {/* @@@raw tool name — server 报回来的工具名与说明,原样显示。 */}
                <span className={cn(mono, 'text-xs text-foreground')}>{tool.name}</span>
                {tool.description && <span className="line-clamp-2 text-xs text-foreground-muted">{tool.description}</span>}
              </div>
            ))}
          </div>
        )}
        <p className="text-xs text-foreground-passive">
          {harnessName ? translate('mcpLibrary.harnessNote', { agent: harnessName }) : translate('mcpLibrary.manualNote')}
        </p>
      </PopoverContent>
    </Popover>
  );
}

/**
 * 资源库 → MCP 的一行。咕咕自己的那几台:默认启用开关、检测、编辑、删除;各家自己的(`harnessName`):只读,
 * 只能检测 —— 由那一家自己加载,咕咕不改、不删、不关。
 */
export function McpLibraryRow({
  server,
  check,
  checking,
  disabled,
  harnessName,
  enabledByDefault,
  onCheck,
  onToggleDefault,
  onEdit,
  onDelete,
}: {
  server: RowServer;
  check?: LibraryMcpCheck;
  checking: boolean;
  disabled: boolean;
  harnessName?: string;
  enabledByDefault?: boolean;
  onCheck: () => void;
  onToggleDefault?: (enabled: boolean) => void;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const { translate } = useSessionMessages();
  const target = targetOf(server);
  const defaultSwitchId = React.useId();
  return (
    <div
      data-slot="mcp-library-server"
      data-server-id={server.name}
      data-source={harnessName ? 'harness' : 'gugu'}
      className="group flex min-h-12 items-center gap-3 px-3 py-2"
    >
      <div className="flex min-w-0 flex-1 flex-col">
        {/* @@@raw server identity — 名字与命令行来自用户自己写的配置,原样显示。 */}
        <span data-slot="mcp-server-name" className="truncate text-sm text-foreground">{server.name}</span>
        <span className={cn(mono, 'truncate text-foreground-muted')} title={target}>{target}</span>
      </div>
      <span className={cn(field, mono, 'inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-foreground-muted')}>
        {server.transport === 'http' ? <Globe className="size-3" /> : <Terminal className="size-3" />}
        {server.transport}
      </span>
      {!harnessName && (
        <div className="flex shrink-0 items-center gap-1 opacity-100 sm:opacity-0 sm:transition-opacity sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
          <Button variant="ghost" size="icon-xs" onClick={onEdit} disabled={disabled} aria-label={translate('mcpLibrary.edit', { name: server.name })}>
            <Pencil />
          </Button>
          <Button variant="ghost" size="icon-xs" onClick={onDelete} disabled={disabled} aria-label={translate('mcpLibrary.delete', { name: server.name })}>
            <Trash2 />
          </Button>
        </div>
      )}
      <Button variant="ghost" size="icon-xs" onClick={onCheck} disabled={checking} aria-label={translate('mcpLibrary.check')} data-slot="mcp-check-run">
        <Refresh />
      </Button>
      <CheckStatus check={check} checking={checking} harnessName={harnessName} />
      {/* 新任务带不带这一台,只由这个开关决定 —— 所以它的意思写在明面上,❌ 只放在悬停里。 */}
      {!harnessName && (
        <span className="inline-flex shrink-0 items-center gap-2">
          <label htmlFor={defaultSwitchId} className="text-xs text-foreground-muted">{translate('mcpLibrary.enabledByDefault')}</label>
          <Switch
            id={defaultSwitchId}
            size="sm"
            checked={!!enabledByDefault}
            onCheckedChange={(checked) => onToggleDefault?.(checked)}
            disabled={disabled}
            aria-label={translate('mcpLibrary.enabledByDefault')}
          />
        </span>
      )}
    </div>
  );
}
