import { useEffect, useState } from 'react';
import { ChevronDown, Monitor, Server } from '@/lib/icons';
import { sessionComposerTrayTriggerClassName } from '@renderer/features/sessions/session-composer-styles';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@renderer/lib/ui/dropdown-menu';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { AttachMachine } from './project-folder-card';
import type { ProjectFoldersState } from './project-folders';

const STORAGE_KEY = 'gugu.projectDeviceScope.v1';
export const scopeKey = (deviceId: string | null) => deviceId ?? 'local';
export type SavedScopes = Record<string, string[] | null>;

function readScopes(): SavedScopes {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw).filter(([, value]) => value === null || (Array.isArray(value) && value.length > 0 && value.every((id) => typeof id === 'string'))));
  } catch { return {}; }
}

/** null means all devices, including devices added to this project later. */
export function selectedScope(saved: readonly string[] | null | undefined, available: readonly string[]): string[] {
  const selected = saved ? available.filter((id) => saved.includes(id)) : [...available];
  return selected.length ? selected : [...available];
}

/** `deviceOfMember` 只用来认还没答的那几个本地项目在哪台上;读到的文件夹各带自己的 deviceId。 */
export function foldersInScope(state: ProjectFoldersState, selected: readonly string[], deviceOfMember: (projectId: string) => string | null): ProjectFoldersState {
  const inScope = (deviceId: string | null) => selected.includes(scopeKey(deviceId));
  const found = state.folders?.filter((folder) => inScope(folder.deviceId)) ?? null;
  // 范围里的机器还有没答的、答了的又一个都没有:还不知道 ⇒ 按读取中(null),❌ 报「所选设备不可用」。
  const folders = found?.length === 0 && state.unanswered.some((projectId) => inScope(deviceOfMember(projectId))) ? null : found;
  const chosen = folders?.find((folder) => folder.workspaceId === state.chosen?.workspaceId) ?? folders?.[0] ?? null;
  return { ...state, folders, chosen };
}

/**
 * 记的键是项目的跨设备身份(项目群 chatId;还没绑群 = 那一行的本地项目 id)。从前按「代表那一行」的本地项目 id 记,
 * 代表一换范围就丢了:那份旧记录读一次、挪到新键下、旧键删掉(✅ 人选过的范围不丢)。
 */
export function adoptLegacyScope(saved: SavedScopes, scopeId: string, legacyId: string): SavedScopes | null {
  if (scopeId === legacyId || saved[scopeId] !== undefined || saved[legacyId] === undefined) return null;
  const { [legacyId]: legacy, ...rest } = saved;
  return { ...rest, [scopeId]: legacy };
}

function persist(next: SavedScopes): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* This selection still applies in this window. */ }
}

export function useProjectDeviceScope(scopeId: string, legacyId: string, machines: readonly AttachMachine[]) {
  const [saved, setSaved] = useState(readScopes);
  const adopted = adoptLegacyScope(saved, scopeId, legacyId);
  useEffect(() => {
    if (!adopted) return;
    persist(adopted);
    setSaved(adopted);
  }, [adopted === null, scopeId, legacyId]);
  const available = machines.map((machine) => scopeKey(machine.id));
  const selected = selectedScope((adopted ?? saved)[scopeId], available);
  const save = (ids: string[] | null) => {
    setSaved((current) => {
      const next = { ...current, [scopeId]: ids };
      persist(next);
      return next;
    });
  };
  return { selected, select: save, include: (deviceId: string | null) => {
    const key = scopeKey(deviceId);
    if (!selected.includes(key)) save([...selected, key]);
  } };
}

export function ProjectDeviceScopePicker({ machines, selected, onSelect }: {
  machines: readonly AttachMachine[];
  selected: readonly string[];
  onSelect: (ids: string[] | null) => void;
}) {
  const { translate } = useSessionMessages();
  const names = machines.filter((machine) => selected.includes(scopeKey(machine.id))).map((machine) => machine.label);
  const label = names.length === 1 ? names[0] : translate('projects.folders.deviceCount', { count: names.length });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={sessionComposerTrayTriggerClassName} data-testid="project-device-scope" title={translate('projects.folders.deviceScopeHint', { devices: names.join('、') })}>
        <Monitor className="size-3 shrink-0" />
        <span className="max-w-40 truncate">{label}</span>
        <ChevronDown className="size-3 shrink-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" className="min-w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{translate('projects.folders.deviceScope')}</DropdownMenuLabel>
          {machines.map((machine) => {
            const key = scopeKey(machine.id);
            const checked = selected.includes(key);
            return <DropdownMenuCheckboxItem key={key} checked={checked} closeOnClick={false} disabled={checked && selected.length === 1}
              onCheckedChange={(next) => onSelect(next ? [...selected, key] : selected.filter((id) => id !== key))}>
              {machine.kind === 'server' ? <Server className="size-3.5" /> : <Monitor className="size-3.5" />}
              <span>{machine.label}</span>
              {!machine.online && <small className="ml-auto text-foreground-passive">{translate('projects.folders.offline')}</small>}
            </DropdownMenuCheckboxItem>;
          })}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => onSelect(null)}>{translate('projects.folders.allDevices')}</DropdownMenuItem>
        <p className="max-w-72 px-2 py-2 text-tiny text-foreground-passive">{translate('projects.folders.scopeExecutionHint')}</p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
