import { useMemo, useState } from 'react';
import type { BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { mono } from '@renderer/lib/ui/assistant-ui/surfaces';
import { Button } from '@renderer/lib/ui/button';
import { ConfirmButton } from '@renderer/lib/ui/confirm-button';
import { DialogContentArea, DialogFooter, DialogHeader, DialogTitle } from '@renderer/lib/ui/dialog';
import { Field, FieldGroup, FieldLabel } from '@renderer/lib/ui/field';
import { InfoTooltip } from '@renderer/lib/ui/info-tooltip';
import { Textarea } from '@renderer/lib/ui/textarea';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { cn } from '@renderer/utils/utils';
import { libraryMcpConflict, parseLibraryMcpJson, type LibraryMcpParseResult, type LibraryMcpServer } from '@shared/mcp-library';

type McpServerModalArgs = {
  /** 编辑这一台;不给 = 添加(一次可以粘几台)。 */
  initial?: LibraryMcpServer;
  /** 列表里已有的那几台(添加时同名的不收;名字只差标点、同一个 URL 的也不收)。 */
  existing: readonly Pick<LibraryMcpServer, 'name' | 'url'>[];
  /** 各家自己配了同名的那几台:名字 → 哪几家(只提示,不拦,owner 10-18)。 */
  harnessNames: Readonly<Record<string, readonly string[]>>;
};

type Props = BaseModalProps<LibraryMcpParseResult['servers']> & McpServerModalArgs;

/** 编辑时预填的那一段:与粘进来的同一种写法,`{ 名字: {...} }`。 */
function jsonOf(server: LibraryMcpServer): string {
  const { name, transport: _transport, enabledByDefault: _default, check: _check, ...rest } = server;
  return JSON.stringify({ mcpServers: { [name]: rest } }, null, 2);
}

/**
 * 添加 / 编辑一台 MCP server:粘 JSON(照 AionUi,❌ 逐格表单)。认 `{ "mcpServers": {...} }`、裸的 `{ 名字: {...} }`、
 * 数组三种写法;有 `command` 是 stdio,有 `url` 是 http。编辑时名字不能改 —— 任务按名字记带了哪几台。
 */
export function McpServerModal({ initial, existing, harnessNames, onSuccess, onClose }: Props) {
  const { translate } = useSessionMessages();
  const [text, setText] = useState(() => (initial ? jsonOf(initial) : ''));
  const parsed = useMemo(() => (text.trim() ? parseLibraryMcpJson(text) : null), [text]);
  const taken = new Set(existing.map((server) => server.name));
  const servers = parsed?.servers ?? [];
  const renamed = initial && servers.length > 0 && (servers.length !== 1 || servers[0]!.name !== initial.name);
  const clash = initial ? [] : servers.filter((server) => taken.has(server.name)).map((server) => server.name);
  // 和列表里别的那几台(编辑时不算它自己)、以及这一段里排在前面的那几台比。
  const others = existing.filter((server) => server.name !== initial?.name);
  const conflicts = servers.flatMap((server, index) => {
    const conflict = libraryMcpConflict(server, [...others, ...servers.slice(0, index)]);
    return conflict ? [{ name: server.name, conflict }] : [];
  });
  const canSave = servers.length > 0 && parsed?.problems.length === 0 && !renamed && clash.length === 0 && conflicts.length === 0;

  const problemText = (problem: LibraryMcpParseResult['problems'][number]) =>
    translate(`mcpLibrary.problem.${problem.code}`, { name: problem.name, headers: problem.detail ?? '' });

  return (
    <>
      <DialogHeader>
        <DialogTitle>{initial ? translate('mcpLibrary.edit', { name: initial.name }) : translate('mcpLibrary.addTitle')}</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="gap-3 pt-0">
        <FieldGroup>
          <Field>
            <span className="inline-flex items-center gap-1">
              <FieldLabel>{translate('mcpLibrary.jsonLabel')}</FieldLabel>
              <InfoTooltip label={translate('mcpLibrary.jsonFormats')} content={translate('mcpLibrary.jsonHint')} />
            </span>
            <Textarea
              data-autofocus
              data-slot="mcp-server-json"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={'{\n  "mcpServers": {\n    "context7": { "command": "npx", "args": ["-y", "@upstash/context7-mcp"] }\n  }\n}'}
              className={cn(mono, 'max-h-[50dvh] min-h-56 resize-y overflow-y-auto px-3 py-2 leading-relaxed')}
            />
          </Field>
        </FieldGroup>
        <div data-slot="mcp-server-json-problems" className="flex flex-col gap-1 text-xs">
          {parsed?.problems.map((problem) => (
            <span key={`${problem.name}:${problem.code}`} className="text-foreground-destructive">{problemText(problem)}</span>
          ))}
          {renamed && <span className="text-foreground-destructive">{translate('mcpLibrary.nameLocked', { name: initial.name })}</span>}
          {clash.length > 0 && <span className="text-foreground-destructive">{translate('mcpLibrary.clash', { names: clash.join(', ') })}</span>}
          {conflicts.map(({ name, conflict }) => (
            <span key={`conflict:${name}`} className="text-foreground-destructive">
              {translate(`mcpLibrary.conflict.${conflict.code}`, { name, with: 'with' in conflict ? conflict.with : '' })}
            </span>
          ))}
          {servers
            .filter((server) => harnessNames[server.name]?.length)
            .map((server) => (
              <span key={`same:${server.name}`} className="text-foreground-muted">
                {translate('mcpLibrary.sameAsAgent', { name: server.name, agent: harnessNames[server.name]!.join(', ') })}
              </span>
            ))}
        </div>
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          {translate('common.cancel')}
        </Button>
        <ConfirmButton onClick={() => canSave && onSuccess(servers)} disabled={!canSave}>
          {translate('mcpLibrary.save')}
        </ConfirmButton>
      </DialogFooter>
    </>
  );
}
