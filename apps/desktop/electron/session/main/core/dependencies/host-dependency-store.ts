import type {
  CustomTarget,
  DependencyId,
  HostDependencySelection,
  InstallRecord,
} from '@gugu/session-core/deps/runtime';
import { INSTALL_METHODS } from '@gugu/session-core/deps';
import { Emitter } from '@gugu/session-shared';
import { normalizeSelection } from '@gugu/session-core/deps/runtime';
import { KV } from '@main/db/kv';
import { log } from '@main/lib/logger';

const LOCAL_HOST_ID = 'local';

/**
 * Persistence for host-scoped installation selections. Owned entirely by the
 * desktop app; the shared HostDependencyManager only reads selections through
 * its injected `getSelection` option.
 *
 * Stores InstallOverride | null (null = auto). Legacy {usedId,path?,cli?} values
 * are normalized on read via normalizeSelection.
 */
export interface IHostDependencyStore {
  getSelection(hostId: string, depId: DependencyId): Promise<HostDependencySelection | null>;
  setSelection(
    hostId: string,
    depId: DependencyId,
    selection: HostDependencySelection
  ): Promise<void>;
}

/**
 * Persistence for what the app remembers about installs it performed itself — the method and,
 * when explicitly pinned, the npm registry an install command used. Neither is reliably present
 * on disk after a vendor installer or global npm install completes.
 *
 * Lives in the app's KV, keyed `<hostId>:<depId>` (only `local` exists since SSH remote was removed, #6264).
 */
export interface IInstallRecordStore {
  getInstallRecord(hostId: string, depId: DependencyId): Promise<InstallRecord | null>;
  setInstallRecord(
    hostId: string,
    depId: DependencyId,
    record: InstallRecord | null
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// Local store (KV table)
// ---------------------------------------------------------------------------

type LocalHostDepKV = {
  selections: Record<string, unknown>;
  /** Install records for every host, keyed `<hostId>:<depId>`. */
  installRecords: Record<string, unknown>;
  /** 每台机器每一家上一次指定的自定义路径,keyed `<hostId>:<depId>`。 */
  customs: Record<string, unknown>;
};

function installRecordKey(hostId: string, depId: DependencyId): string {
  return `${hostId}:${depId}`;
}

/** Accepts only a fully-formed record; anything else reads as "no record". */
function parseInstallRecord(raw: unknown): InstallRecord | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj['realpath'] !== 'string') return null;
  const method = obj['method'];
  const registry = obj['registry'];
  const validMethod =
    typeof method === 'string' && (INSTALL_METHODS as readonly string[]).includes(method);
  if (!validMethod && typeof registry !== 'string') return null;
  const version = obj['version'];
  if (version !== null && typeof version !== 'string') return null;
  return {
    ...(validMethod ? { method: method as InstallRecord['method'] } : {}),
    ...(typeof registry === 'string' ? { registry } : {}),
    realpath: obj['realpath'],
    version,
  };
}

class LocalHostDependencyStore implements IHostDependencyStore {
  private readonly kv = new KV<LocalHostDepKV>('host-dep');

  async getSelection(hostId: string, depId: DependencyId): Promise<HostDependencySelection | null> {
    if (hostId !== LOCAL_HOST_ID) return null;
    const all = await this.kv.get('selections');
    const raw = all?.[depId];
    // normalizeSelection handles both new discriminated-union and legacy {usedId,path?,cli?} format
    return normalizeSelection(raw);
  }

  async setSelection(
    hostId: string,
    depId: DependencyId,
    selection: HostDependencySelection
  ): Promise<void> {
    if (hostId !== LOCAL_HOST_ID) return;
    const all = (await this.kv.get('selections')) ?? {};
    if (selection === null) {
      // null = auto: remove the entry rather than storing {kind:'auto'}
      delete all[depId];
    } else {
      all[depId] = selection;
    }
    await this.kv.set('selections', all);
  }
}

// ---------------------------------------------------------------------------
// Combined store
// ---------------------------------------------------------------------------

class HostDependencyStore implements IHostDependencyStore, IInstallRecordStore {
  private readonly local = new LocalHostDependencyStore();
  private readonly kv = new KV<LocalHostDepKV>('host-dep');

  /**
   * 账本改了(#6101)。
   *
   * 读这本账的不止主进程:worker 进程拿的是一份由主进程推过去的副本,而**副本只有在被推的
   * 那一刻才是新的**。⇒ 属主每写一笔就在这里说一声,订阅者据此把副本换掉并重探 ——
   * ❌ 不靠各处自己定时轮询:轮询窗口里报出去的就是旧账算出来的读数。
   */
  readonly onChanged = new Emitter<{ hostId: string; depId: DependencyId }>();

  getSelection(hostId: string, depId: DependencyId): Promise<HostDependencySelection | null> {
    return this.local.getSelection(hostId, depId);
  }

  async setSelection(
    hostId: string,
    depId: DependencyId,
    selection: HostDependencySelection
  ): Promise<void> {
    await this.local.setSelection(hostId, depId, selection);
    // 指定了自定义路径就记下来 —— 之后切到别的来源,它仍留在「自定义路径」那一行里(owner 2026-09-22)。
    if (
      (selection?.kind === 'path' && selection.path) ||
      (selection?.kind === 'cli' && selection.command)
    ) {
      const customs = (await this.kv.get('customs')) ?? {};
      customs[installRecordKey(hostId, depId)] =
        selection.kind === 'path'
          ? { kind: 'path', path: selection.path }
          : { kind: 'cli', command: selection.command };
      await this.kv.set('customs', customs);
    }
    // 账本的每一笔都落一行(#6101)。`warn` 是因为会话页这半边默认只落 warn 及以上
    // (见 `HostDependencyManager.logReading`);而「用户换了哪一份 / 咕咕记下了哪一份」正是
    // 事后要回答的那件事 —— 它本身罕见,不构成噪音。❌ 不打路径以外的用户数据。
    log.warn('[HostDependencyStore] selection changed', {
      scope: 'host-dependency',
      host: hostId,
      id: depId,
      selection: selection === null ? 'auto' : selection.kind,
      registry: selection?.registry ?? null,
    });
    this.onChanged.emit({ hostId, depId });
  }

  async getLastCustom(hostId: string, depId: DependencyId): Promise<CustomTarget | null> {
    const all = await this.kv.get('customs');
    const raw = all?.[installRecordKey(hostId, depId)] as Record<string, unknown> | undefined;
    if (raw?.['kind'] === 'path' && typeof raw['path'] === 'string' && raw['path']) {
      return { kind: 'path', path: raw['path'] };
    }
    if (raw?.['kind'] === 'cli' && typeof raw['command'] === 'string' && raw['command']) {
      return { kind: 'cli', command: raw['command'] };
    }
    return null;
  }

  async getInstallRecord(hostId: string, depId: DependencyId): Promise<InstallRecord | null> {
    const all = await this.kv.get('installRecords');
    return parseInstallRecord(all?.[installRecordKey(hostId, depId)]);
  }

  async setInstallRecord(
    hostId: string,
    depId: DependencyId,
    record: InstallRecord | null
  ): Promise<void> {
    const all = (await this.kv.get('installRecords')) ?? {};
    const key = installRecordKey(hostId, depId);
    if (record === null) {
      if (!(key in all)) return;
      delete all[key];
    } else {
      all[key] = record;
    }
    await this.kv.set('installRecords', all);
    log.warn('[HostDependencyStore] install record written', {
      scope: 'host-dependency',
      host: hostId,
      id: depId,
      record: record === null ? 'cleared' : 'written',
      method: record?.method ?? null,
      registry: record?.registry ?? null,
      realpath: record?.realpath ?? null,
      version: record?.version ?? null,
    });
    this.onChanged.emit({ hostId, depId });
  }
}

export const hostDependencyStore = new HostDependencyStore();
