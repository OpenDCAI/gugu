import { useEffect, useRef } from 'react';
import { dismissNotice, notify, type Notice } from '@/lib/notices';
import { log } from '@renderer/utils/logger';

export type SessionInputNotice = Pick<Notice, 'title' | 'description' | 'tier' | 'action'> & {
  /** Diagnostic only: never forwarded to NoticeHost. */
  diagnostic?: unknown;
  /** A concrete creation result can be more precise than a cached catalog warning. */
  priority?: number;
  inheritAction?: boolean;
};

/** Lifetime bookkeeping for the existing outlet, shared by composers reading the same resource. */
export function createSessionInputNotices(outlet: {
  notify: (notice: Notice) => unknown;
  dismiss: (key: string) => void;
  diagnostic: (key: string, reason: unknown) => void;
}) {
  type Entry = { owners: Map<symbol, SessionInputNotice | null>; diagnostics: Map<symbol, string>; closed: boolean; shown?: string };
  const entries = new Map<string, Entry>();
  function entry(key: string): Entry {
    let value = entries.get(key);
    if (!value) { value = { owners: new Map(), diagnostics: new Map(), closed: false }; entries.set(key, value); }
    return value;
  }
  function presentation(value: Entry) {
    const active = [...value.owners.values()].filter((spec): spec is SessionInputNotice => !!spec)
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || Number(!!b.action) - Number(!!a.action));
    const spec = active[0];
    const action = spec?.action ?? (spec?.inheritAction === false ? undefined : active.find(item => item.action)?.action);
    return { spec, action };
  }
  function show(key: string, value: Entry): void {
    const { spec, action } = presentation(value);
    if (!spec || value.closed) return;
    const signature = JSON.stringify([spec.title, spec.description, spec.tier, action?.label]);
    if (value.shown === signature) return;
    value.shown = signature;
    outlet.notify({
      key, title: spec.title, description: spec.description, tier: spec.tier ?? 'error',
      action: action && { label: action.label, onClick: () => presentation(value).action?.onClick() },
      ongoing: true,
      onDismiss: () => { value.closed = true; value.shown = undefined; },
    });
  }
  return {
    attach(key: string, owner: symbol) {
      entry(key).owners.set(owner, null);
      return () => {
        const value = entries.get(key);
        value?.owners.delete(owner);
        value?.diagnostics.delete(owner);
        if (value && ![...value.owners.values()].some(Boolean)) {
          outlet.dismiss(key);
          value.shown = undefined;
          // Unmounting is not recovery. Keep a dismissal across navigation/StrictMode.
        } else if (value) show(key, value);
      };
    },
    update(key: string, owner: symbol, spec: SessionInputNotice | null | undefined) {
      if (spec === undefined) return; // A refresh in flight does not prove recovery.
      const value = entry(key);
      value.owners.set(owner, spec);
      if (!spec && ![...value.owners.values()].some(Boolean)) {
        outlet.dismiss(key);
        entries.delete(key);
        return;
      }
      if (spec) {
        const diagnostic = JSON.stringify(spec.diagnostic);
        if (diagnostic !== undefined && diagnostic !== value.diagnostics.get(owner)) {
          value.diagnostics.set(owner, diagnostic);
          outlet.diagnostic(key, spec.diagnostic);
        }
      }
      show(key, value);
    },
  };
}

const notices = createSessionInputNotices({
  notify, dismiss: dismissNotice,
  diagnostic: (key, reason) => log.error('Session input failure', { key, reason }),
});

/** null = verified recovery; undefined = still reading; unmount only hides the notice. */
export function useSessionInputNotice(key: string, spec: SessionInputNotice | null | undefined): void {
  const owner = useRef(Symbol('session-input-notice'));
  useEffect(() => notices.attach(key, owner.current), [key]);
  useEffect(() => { notices.update(key, owner.current, spec); });
}
